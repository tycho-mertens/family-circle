import http.server
import threading
import unittest
import urllib.error
import urllib.request
from contextlib import contextmanager
from unittest.mock import Mock, patch

import prepare
import serve


class FakeUpstreamResponse:
    """Just enough of urllib's response contract for the tile-cache tests."""

    headers = {}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def read(self, limit):
        return b'basemap-tile'


@contextmanager
def running_gateway():
    """Run the production handler on a throwaway port for one test.

    Keeping shutdown here matters: a failed assertion should not leave a server
    thread behind and make the next test look flaky.
    """
    server = serve.LimitedThreadingHTTPServer(('127.0.0.1', 0), serve.Server)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(serve, 'cache', serve.TileCache()))
        self.enterContext(patch.object(serve, 'PROVIDER', 'hosted'))
        self.enterContext(patch.object(serve, 'KEY', 'test-server-secret'))
        self.enterContext(patch.object(serve, 'tile_process', None))

    def test_rejects_arbitrary_paths_and_invalid_coordinates(self):
        for path in ['/tiles/world/16/0/0.mvt', '/tiles/world/0/1/0.mvt',
                     '/tiles/https://evil.test', '/tiles/world/1/0/0.mvt?key=x',
                     '/tiles/world/../.env']:
            self.assertIsNone(serve.tile_coordinates(path))
        self.assertEqual(serve.tile_coordinates('/tiles/world/15/18296/10766.mvt'),
                         (15, 18296, 10766))

    def test_key_is_only_in_fixed_upstream_request_and_cache_reuses_tile(self):
        with patch.object(serve.opener, 'open', return_value=FakeUpstreamResponse()) as upstream:
            self.assertEqual(serve.fetch_tile((1, 0, 0)), serve.fetch_tile((1, 0, 0)))
            self.assertEqual(upstream.call_count, 1)
            self.assertEqual(upstream.call_args.args[0].full_url,
                             'https://api.protomaps.com/tiles/v4/1/0/0.mvt?key=test-server-secret')

    def test_upstream_error_never_exposes_secret(self):
        with running_gateway() as server:
            with patch.object(serve, 'fetch_tile',
                              side_effect=RuntimeError('https://upstream/?key=test-server-secret')):
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    urllib.request.urlopen(f'http://127.0.0.1:{server.server_port}/tiles/world/0/0/0.mvt')
                self.assertEqual(caught.exception.code, 502)
                self.assertEqual(caught.exception.read(), b'Map temporarily unavailable')
                caught.exception.close()


class HealthTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(serve, 'PROVIDER', 'hosted'))
        self.enterContext(patch.object(serve, 'KEY', 'test-server-secret'))
        self.enterContext(patch.object(serve, 'tile_process', None))

    def test_healthz_answers_without_going_upstream(self):
        with running_gateway() as server:
            with patch.object(serve, 'fetch_tile', side_effect=AssertionError('upstream fetch')) as upstream:
                with urllib.request.urlopen(f'http://127.0.0.1:{server.server_port}/healthz') as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.read(), b'ok')
            upstream.assert_not_called()

    def test_hosted_without_a_key_is_not_ready(self):
        serve.KEY = ''
        self.assertEqual(serve.readiness(), (False, 'no api key'))

    def test_local_reports_a_dead_tile_process(self):
        serve.PROVIDER = 'local'
        serve.tile_process = Mock(**{'poll.return_value': 1})
        self.assertEqual(serve.readiness(), (False, 'tile process exited'))
        serve.tile_process = Mock(**{'poll.return_value': None})
        self.assertEqual(serve.readiness(), (True, 'ok'))


class ConnectionCapTests(unittest.TestCase):
    def test_failed_thread_start_returns_connection_slot(self):
        with patch.object(serve, 'MAX_CONNECTIONS', 1):
            server = serve.LimitedThreadingHTTPServer(('127.0.0.1', 0), serve.Server)
        with server:
            with patch.object(http.server.ThreadingHTTPServer, 'process_request',
                              side_effect=RuntimeError('cannot start thread')):
                with self.assertRaises(RuntimeError):
                    server.process_request(Mock(), ('127.0.0.1', 1))
            with patch.object(http.server.ThreadingHTTPServer, 'process_request') as parent:
                server.process_request(Mock(), ('127.0.0.1', 2))
                parent.assert_called_once()

    def test_connections_past_the_cap_are_closed_and_slots_are_returned(self):
        with patch.object(serve, 'MAX_CONNECTIONS', 1):
            server = serve.LimitedThreadingHTTPServer(('127.0.0.1', 0), serve.Server)
        try:
            with patch.object(http.server.ThreadingHTTPServer, 'process_request') as parent:
                first, second = Mock(), Mock()
                server.process_request(first, ('127.0.0.1', 1))
                self.assertEqual(parent.call_count, 1)
                # The only slot is taken, so this one is dropped rather than
                # given a thread.
                server.process_request(second, ('127.0.0.1', 2))
                self.assertEqual(parent.call_count, 1)
                second.close.assert_called_once()
            with patch.object(http.server.ThreadingHTTPServer, 'process_request_thread'):
                server.process_request_thread(first, ('127.0.0.1', 1))
            with patch.object(http.server.ThreadingHTTPServer, 'process_request') as parent:
                server.process_request(Mock(), ('127.0.0.1', 3))
                self.assertEqual(parent.call_count, 1)
        finally:
            server.server_close()


class ChecksumTests(unittest.TestCase):
    def test_pinned_architecture_needs_no_overrides(self):
        archive, binary = prepare.pmtiles_checksums('x86_64')
        self.assertNotEqual(archive, binary)

    def test_unpinned_architecture_requires_both_digests(self):
        for archive, binary in [(None, None), ('a' * 64, None), (None, 'b' * 64)]:
            with self.assertRaises(SystemExit):
                prepare.pmtiles_checksums('arm64', archive, binary)
        self.assertEqual(prepare.pmtiles_checksums('arm64', 'a' * 64, 'b' * 64),
                         ('a' * 64, 'b' * 64))

    def test_one_digest_cannot_stand_in_for_both(self):
        # The archive and the binary inside it cannot share a digest, so this
        # used to be an unsatisfiable configuration rather than an error.
        with self.assertRaises(SystemExit):
            prepare.pmtiles_checksums('arm64', 'a' * 64, 'a' * 64)

    def test_architecture_detection(self):
        self.assertEqual(prepare.host_architecture('aarch64'), 'arm64')
        self.assertEqual(prepare.host_architecture('arm64'), 'arm64')
        self.assertEqual(prepare.host_architecture('x86_64'), 'x86_64')


if __name__ == '__main__':
    unittest.main()
