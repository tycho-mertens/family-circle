#!/usr/bin/env python3
"""Same-origin maps gateway: styles, glyphs, sprites and tiles.

Hosted mode attaches the Protomaps API key here, so it never reaches a client.
Local mode proxies a go-pmtiles process on loopback instead.
"""
import collections
import functools
import http.server
import json
import os
import pathlib
import re
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent

# .env lives outside public/ and is excluded from the image, so in Docker this
# loop finds nothing and the values come from compose's env_file instead.
_env = ROOT / '.env'
for line in _env.read_text().splitlines() if _env.exists() else []:
    name, sep, value = line.partition('=')
    if sep and name in ('MAP_PROVIDER', 'PROTOMAPS_API_KEY', 'PROTOMAPS_ORIGIN',
                        'MAP_PORT', 'MAP_MAX_CONNECTIONS'):
        os.environ.setdefault(name, value.strip())

PROVIDER = os.environ.get('MAP_PROVIDER', 'local')
KEY = os.environ.get('PROTOMAPS_API_KEY', '')
ORIGIN = os.environ.get('PROTOMAPS_ORIGIN', 'http://localhost:8090')
TILE = re.compile(r'^/tiles/world/(\d{1,2})/(\d{1,5})/(\d{1,5})\.mvt$')

MAX_CACHE_BYTES = 64 * 1024 * 1024
MAX_TILE_BYTES = 2 * 1024 * 1024
CACHE_TTL_SECONDS = 3600
MAX_CONNECTIONS = max(1, min(int(os.environ.get('MAP_MAX_CONNECTIONS', '128')), 1024))

cache = collections.OrderedDict()
cache_bytes = 0
lock = threading.Lock()
workers = threading.BoundedSemaphore(8)
tile_process = None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    # Following a redirect would hand the API key to whatever host it names.
    def redirect_request(self, *args, **kwargs):
        return None


opener = urllib.request.build_opener(NoRedirect())


def tile_coordinates(path):
    """Parse /tiles/world/z/x/y.mvt. None for anything we will not fetch."""
    match = TILE.fullmatch(path)
    if not match:
        return None
    z, x, y = map(int, match.groups())
    if z > 15 or not (0 <= x < 2 ** z) or not (0 <= y < 2 ** z):
        return None
    return z, x, y


def fetch_tile(coords):
    """One tile, from the LRU cache when it is still warm."""
    global cache_bytes
    now = time.monotonic()
    with lock:
        cached = cache.get(coords)
        if cached and now - cached[0] < CACHE_TTL_SECONDS:
            cache.move_to_end(coords)
            return cached[1], cached[2]
    # Bound how many misses go upstream together.
    if not workers.acquire(timeout=15):
        raise RuntimeError('busy')
    try:
        z, x, y = coords
        if PROVIDER == 'hosted':
            query = urllib.parse.urlencode({'key': KEY})
            url = f'https://api.protomaps.com/tiles/v4/{z}/{x}/{y}.mvt?{query}'
            headers = {'Origin': ORIGIN, 'User-Agent': 'FamilyCircleMaps/1.0'}
        else:
            url = f'http://127.0.0.1:8091/world/{z}/{x}/{y}.mvt'
            headers = {}
        request = urllib.request.Request(url, headers=headers)
        with opener.open(request, timeout=15) as response:
            data = response.read(MAX_TILE_BYTES + 1)
            if len(data) > MAX_TILE_BYTES:
                raise RuntimeError('oversized tile')
            encoding = response.headers.get('Content-Encoding')
        with lock:
            previous = cache.pop(coords, None)
            if previous:
                cache_bytes -= len(previous[1])
            cache[coords] = (now, data, encoding)
            cache_bytes += len(data)
            while cache_bytes > MAX_CACHE_BYTES:
                _, evicted = cache.popitem(last=False)
                cache_bytes -= len(evicted[1])
        return data, encoding
    finally:
        workers.release()


def readiness():
    """Whether this gateway can serve, and why not if it cannot.

    Local checks only. Fetching a tile here would tie container health to the
    upstream API and spend quota on every probe. In local mode a tile process
    that was never started reads as ready; only main() starts one.
    """
    if PROVIDER not in ('hosted', 'local'):
        return False, 'bad provider'
    if PROVIDER == 'hosted':
        return (True, 'ok') if KEY else (False, 'no api key')
    if tile_process is not None and tile_process.poll() is not None:
        return False, 'tile process exited'
    return True, 'ok'


class Server(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass  # tile paths reveal which areas someone is looking at

    def send_bytes(self, data, content_type, status=200, encoding=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control',
                         'public, max-age=3600' if status == 200 else 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if encoding:
            self.send_header('Content-Encoding', encoding)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/coverage.json' and PROVIDER == 'hosted':
            body = json.dumps({'development': False, 'maxzoom': 15,
                               'provider': 'hosted'}).encode()
            self.send_bytes(body, 'application/json')
            return
        if self.path == '/healthz':
            ready, detail = readiness()
            self.send_bytes(detail.encode(), 'text/plain', 200 if ready else 503)
            return
        if self.path.startswith('/tiles/'):
            coords = tile_coordinates(self.path)
            if coords is None:
                self.send_bytes(b'Invalid tile', 'text/plain', 400)
                return
            try:
                data, encoding = fetch_tile(coords)
            except Exception:
                # The upstream URL carries the key and its error bodies quote it
                # back, so none of this exception reaches the client.
                self.send_bytes(b'Map temporarily unavailable', 'text/plain', 502)
                return
            self.send_bytes(data, 'application/vnd.mapbox-vector-tile',
                            encoding=encoding)
            return
        super().do_GET()


class LimitedThreadingHTTPServer(http.server.ThreadingHTTPServer):
    """ThreadingHTTPServer with a ceiling on live connections.

    The stock class spawns one thread per connection and never stops, so slow
    clients alone can exhaust the container. Over the cap we close and let the
    proxy retry.
    """

    def __init__(self, *args, **kwargs):
        self.connections = threading.BoundedSemaphore(MAX_CONNECTIONS)
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):
        if not self.connections.acquire(blocking=False):
            request.close()
            return
        super().process_request(request, client_address)

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.connections.release()


def main():
    global tile_process
    if PROVIDER not in ('hosted', 'local'):
        raise SystemExit('MAP_PROVIDER must be hosted or local')
    if PROVIDER == 'hosted' and not KEY:
        raise SystemExit('Configure PROTOMAPS_API_KEY on the server')
    if PROVIDER == 'local':
        tile_process = subprocess.Popen(
            [str(ROOT / '.bin/pmtiles'), 'serve', str(ROOT / 'data'),
             '--port=8091', '--interface=127.0.0.1', '--quiet'],
            stdout=subprocess.DEVNULL)
    try:
        handler = functools.partial(Server, directory=str(ROOT / 'public'))
        port = int(os.environ.get('MAP_PORT', '8090'))
        server = LimitedThreadingHTTPServer(('0.0.0.0', port), handler)
        print(f'Maps gateway listening on {server.server_port} ({PROVIDER})',
              flush=True)
        server.serve_forever()
    finally:
        if tile_process:
            tile_process.terminate()
            tile_process.wait()


if __name__ == '__main__':
    main()
