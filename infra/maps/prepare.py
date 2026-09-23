#!/usr/bin/env python3
"""Download the map gateway's assets, checking each against a pinned SHA-256.

Nothing is made executable, promoted into data/, or written under public/
before its digest matches. A mismatch aborts and leaves the current setup
alone.
"""
import argparse
import hashlib
import json
import pathlib
import platform
import shutil
import subprocess
import tarfile
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent
DEFAULT_PLANET = 'https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/protomaps/openstreetmap/v4.pmtiles'
PMTILES_VERSION = '1.31.2'
ASSETS_COMMIT = '028c18f713baecad011301ff7a69acc39bcc2ae7'
ASSETS_SHA256 = 'e942a417d94a12596842a20b53d6b785cbf6d47f2545e458538191ba6d74b305'

# Pin the release archive and its executable together for each architecture.
PMTILES_CHECKSUMS = {
    'x86_64': (
        '3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f',
        'a7e9ae10184d109c83f456ccdf6df4f3e2a64ba6cf69d9ed0f9f1840305055c1',
    ),
}
DEFAULT_DEVELOPMENT_MAP_SHA256 = '7806c66387c4046739302ee23ea408edf5a3a6f2cc428122968c107266cef18b'


def host_architecture(machine=None):
    machine = machine or platform.machine()
    return 'arm64' if machine in ('aarch64', 'arm64') else 'x86_64'


def pmtiles_checksums(arch, archive_override=None, binary_override=None):
    """The (archive, binary) digests to require for `arch`.

    The overrides let an unpinned architecture be prepared. Both are required:
    one digest cannot satisfy both checks, and accepting it for both would
    silently drop one of them.
    """
    archive, binary = PMTILES_CHECKSUMS.get(arch, (archive_override, binary_override))
    if not archive or not binary:
        raise SystemExit(
            f'No pinned go-pmtiles checksums for {arch}. Pass both '
            f'--pmtiles-archive-sha256 and --pmtiles-binary-sha256, taken from '
            f'the official v{PMTILES_VERSION} release for this architecture.')
    if archive == binary:
        raise SystemExit(
            'The go-pmtiles archive and binary digests are the same value. The '
            'binary is a file inside the archive; their digests differ.')
    return archive, binary


def file_hash(target):
    with pathlib.Path(target).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def verify(target, expected, label):
    actual = file_hash(target)
    if actual != expected.lower():
        raise SystemExit(f'{label} SHA-256 mismatch: expected {expected}, got {actual}. Refusing to use it.')


def download(url, target, expected, label):
    """Fetch `url` to `target` unless it is already there, then verify it.

    The download lands on a .part file and only takes the real name once its
    digest matches, so an interrupted fetch never looks like a usable artifact.
    """
    target = pathlib.Path(target)
    if not target.exists():
        partial = target.with_suffix(target.suffix + '.part')
        partial.unlink(missing_ok=True)
        print('Downloading', url, flush=True)
        try:
            with urllib.request.urlopen(url, timeout=120) as source, partial.open('wb') as destination:
                shutil.copyfileobj(source, destination)
            verify(partial, expected, label)
            partial.replace(target)
        finally:
            partial.unlink(missing_ok=True)
    verify(target, expected, label)
    print(target, target.stat().st_size, 'bytes; sha256', expected, flush=True)


def fetch_pmtiles_cli(archive_hash, binary_hash, arch):
    archive = ROOT / '.bin/pmtiles.tar.gz'
    binary = ROOT / '.bin/pmtiles'
    url = (f'https://github.com/protomaps/go-pmtiles/releases/download/'
           f'v{PMTILES_VERSION}/go-pmtiles_{PMTILES_VERSION}_Linux_{arch}.tar.gz')
    download(url, archive, archive_hash, 'go-pmtiles archive')
    if not binary.exists() or file_hash(binary) != binary_hash:
        with tarfile.open(archive) as bundle:
            member = next((item for item in bundle.getmembers()
                           if pathlib.PurePosixPath(item.name).name == 'pmtiles' and item.isfile()), None)
            if member is None or member.size > 128 * 1024 * 1024:
                raise SystemExit('Invalid go-pmtiles archive member.')
            candidate = binary.with_suffix('.candidate')
            try:
                with bundle.extractfile(member) as source, candidate.open('wb') as destination:
                    shutil.copyfileobj(source, destination)
                verify(candidate, binary_hash, 'go-pmtiles binary')
                candidate.chmod(0o755)
                candidate.replace(binary)
            finally:
                candidate.unlink(missing_ok=True)
    verify(binary, binary_hash, 'go-pmtiles binary')
    return binary


def fetch_assets():
    """Unpack fonts and sprites from the pinned assets commit into public/.

    Only those two directories are taken, and '..' components are skipped, so a
    crafted archive cannot write outside public/.
    """
    download(f'https://codeload.github.com/protomaps/basemaps-assets/zip/{ASSETS_COMMIT}',
             ROOT / '.bin/assets.zip', ASSETS_SHA256, 'basemap assets')
    with zipfile.ZipFile(ROOT / '.bin/assets.zip') as bundle:
        for member in bundle.infolist():
            parts = pathlib.PurePosixPath(member.filename).parts[1:]
            if not parts or parts[0] not in ('fonts', 'sprites') or '..' in parts or member.is_dir():
                continue
            target = (ROOT / 'public').joinpath(*parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                # Verify existing public files against the downloaded archive too.
                with bundle.open(member) as source, target.open('rb') as destination:
                    if source.read() != destination.read():
                        raise SystemExit(f'Existing map asset {target} does not match the verified assets archive.')
            else:
                with bundle.open(member) as source, target.open('wb') as destination:
                    shutil.copyfileobj(source, destination)
    (ROOT / 'public/assets-version.txt').write_text(ASSETS_COMMIT + '\n')


def resolve_map_hash(args):
    expected = args.map_sha256
    if not expected and not args.full and args.planet == DEFAULT_PLANET:
        expected = DEFAULT_DEVELOPMENT_MAP_SHA256
    if not expected:
        raise SystemExit('Pass --map-sha256 from the authoritative map release before accepting this map asset.')
    if len(expected) != 64 or any(char not in '0123456789abcdefABCDEF' for char in expected):
        raise SystemExit('--map-sha256 must be a SHA-256 hex digest.')
    return expected.lower()


def reuse_existing_map(world, coverage, args, expected_map_hash):
    """Accept an already-prepared archive, or explain why it cannot be."""
    if not coverage.exists():
        raise SystemExit('Existing archive has no coverage metadata. Inspect it before generating styles.')
    previous = json.loads(coverage.read_text())
    if previous.get('development') == args.full or previous.get('source') != args.planet:
        raise SystemExit('Existing archive was built from a different source or coverage. '
                         'Move data/world.pmtiles aside first, then rerun preparation.')
    verify(world, expected_map_hash, 'existing map asset')
    recorded = previous.get('sha256')
    if recorded is None:
        # Older coverage.json files omit the digest. Record the verified archive
        # digest without rebuilding unchanged tiles.
        previous['sha256'] = expected_map_hash
        coverage.write_text(json.dumps(previous))
        print('Recorded verified sha256 in existing coverage metadata.', flush=True)
    elif recorded != expected_map_hash:
        raise SystemExit(f'Coverage metadata records sha256 {recorded}, but this run expects '
                         f'{expected_map_hash}. Resolve which map is intended before serving it.')


def build_map(world, coverage, args, binary, expected_map_hash):
    temporary = world.with_name('world.candidate.pmtiles')
    temporary.unlink(missing_ok=True)
    try:
        if args.full:
            download(args.planet, temporary, expected_map_hash, 'map asset')
        else:
            subprocess.run([str(binary), 'extract', args.planet, str(temporary), '--maxzoom=6'], check=True)
            verify(temporary, expected_map_hash, 'generated development map asset')
        temporary.replace(world)
    finally:
        temporary.unlink(missing_ok=True)
    coverage.write_text(json.dumps({'development': not args.full,
                                    'maxzoom': 15 if args.full else 6,
                                    'source': args.planet,
                                    'sha256': expected_map_hash}))


def parse_args(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--planet', default=DEFAULT_PLANET)
    parser.add_argument('--full', action='store_true')
    parser.add_argument('--hosted', action='store_true',
                        help='Prepare for MAP_PROVIDER=hosted: fonts and sprites only, no local map archive')
    parser.add_argument('--map-sha256', help='SHA-256 of the resulting world.pmtiles; required for --full or a custom source')
    parser.add_argument('--pmtiles-archive-sha256', help='SHA-256 of the go-pmtiles release tarball for an unpinned architecture')
    parser.add_argument('--pmtiles-binary-sha256', help='SHA-256 of the pmtiles executable inside that tarball')
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    for name in ['.bin', 'data', 'public']:
        (ROOT / name).mkdir(exist_ok=True)

    arch = host_architecture()
    archive_hash, binary_hash = pmtiles_checksums(
        arch, args.pmtiles_archive_sha256, args.pmtiles_binary_sha256)
    # Fetched even for --hosted, because the image COPYs this binary in.
    binary = fetch_pmtiles_cli(archive_hash, binary_hash, arch)
    fetch_assets()

    if args.hosted:
        print('Ready for hosted tiles. Generate styles with MAP_MAX_ZOOM=15 before serving.', flush=True)
        return

    expected_map_hash = resolve_map_hash(args)
    world = ROOT / 'data/world.pmtiles'
    coverage = ROOT / 'public/coverage.json'
    if world.exists():
        reuse_existing_map(world, coverage, args, expected_map_hash)
    else:
        build_map(world, coverage, args, binary, expected_map_hash)
    print(f'Ready. Generate styles with MAP_MAX_ZOOM={"15" if args.full else "6"} before serving.', flush=True)


if __name__ == '__main__':
    main()
