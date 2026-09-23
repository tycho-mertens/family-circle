import argparse
import hashlib
import io
import json
import pathlib
import tarfile
import tempfile
import unittest
import zipfile
from unittest.mock import patch

import prepare


def digest(data):
    return hashlib.sha256(data).hexdigest()


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch.object(prepare, 'ROOT', self.root))
        for directory in ('.bin', 'data', 'public'):
            (self.root / directory).mkdir()

    def test_download_verifies_before_promoting_and_cleans_partial_file(self):
        target = self.root / 'download'
        with patch.object(prepare.urllib.request, 'urlopen', return_value=io.BytesIO(b'bad')):
            with self.assertRaises(SystemExit):
                prepare.download('https://example.test/asset', target, digest(b'good'), 'test')
        self.assertFalse(target.exists())
        self.assertFalse(target.with_suffix('.part').exists())
        with patch.object(prepare.urllib.request, 'urlopen', return_value=io.BytesIO(b'good')):
            prepare.download('https://example.test/asset', target, digest(b'good'), 'test')
        with patch.object(prepare.urllib.request, 'urlopen') as fetch:
            prepare.download('https://example.test/asset', target, digest(b'good'), 'test')
            fetch.assert_not_called()

    def test_cli_mismatch_preserves_existing_binary(self):
        archive = self.root / '.bin/pmtiles.tar.gz'
        binary = self.root / '.bin/pmtiles'
        binary.write_bytes(b'previous')
        with tarfile.open(archive, 'w:gz') as bundle:
            member = tarfile.TarInfo('pmtiles')
            member.size = 3
            bundle.addfile(member, io.BytesIO(b'new'))
        archive_hash = prepare.file_hash(archive)
        with self.assertRaises(SystemExit):
            prepare.fetch_pmtiles_cli(archive_hash, digest(b'wrong'), 'x86_64')
        self.assertEqual(binary.read_bytes(), b'previous')
        self.assertFalse(binary.with_suffix('.candidate').exists())
        self.assertEqual(prepare.fetch_pmtiles_cli(archive_hash, digest(b'new'), 'x86_64'), binary)
        self.assertEqual(binary.read_bytes(), b'new')
        self.assertEqual(binary.stat().st_mode & 0o777, 0o755)

    def test_assets_only_extract_allowed_paths_and_verify_existing_files(self):
        archive = self.root / '.bin/assets.zip'
        with zipfile.ZipFile(archive, 'w') as bundle:
            bundle.writestr('root/fonts/font.pbf', b'font')
            bundle.writestr('root/sprites/light.json', b'{}')
            bundle.writestr('root/fonts/../../escape', b'bad')
            bundle.writestr('root/other/file', b'bad')
        with patch.object(prepare, 'ASSETS_SHA256', prepare.file_hash(archive)):
            prepare.fetch_assets()
            prepare.fetch_assets()
            self.assertFalse((self.root / 'escape').exists())
            self.assertFalse((self.root / 'public/other').exists())
            (self.root / 'public/fonts/font.pbf').write_bytes(b'changed')
            with self.assertRaises(SystemExit):
                prepare.fetch_assets()

    def test_map_mismatch_is_not_promoted_or_recorded(self):
        world = self.root / 'data/world.pmtiles'
        coverage = self.root / 'public/coverage.json'
        args = argparse.Namespace(full=False, planet='test-source')

        def extract(command, check):
            pathlib.Path(command[3]).write_bytes(b'wrong')

        with patch.object(prepare.subprocess, 'run', side_effect=extract):
            with self.assertRaises(SystemExit):
                prepare.build_map(world, coverage, args, pathlib.Path('/pmtiles'), digest(b'expected'))
        self.assertFalse(world.exists())
        self.assertFalse(coverage.exists())
        self.assertEqual(list(world.parent.iterdir()), [])

    def test_development_map_is_extracted_verified_and_recorded(self):
        world = self.root / 'data/world.pmtiles'
        coverage = self.root / 'public/coverage.json'
        binary = self.root / '.bin/pmtiles'
        args = argparse.Namespace(full=False, planet='test-source')

        def extract(command, check):
            self.assertEqual(command, [str(binary), 'extract', 'test-source',
                                      str(world.with_name('world.candidate.pmtiles')), '--maxzoom=6'])
            self.assertTrue(check)
            pathlib.Path(command[3]).write_bytes(b'map')

        with patch.object(prepare.subprocess, 'run', side_effect=extract):
            prepare.build_map(world, coverage, args, binary, digest(b'map'))
        self.assertEqual(world.read_bytes(), b'map')
        self.assertEqual(json.loads(coverage.read_text()), {
            'development': True, 'maxzoom': 6, 'source': 'test-source', 'sha256': digest(b'map'),
        })

    def test_full_map_download_is_verified_and_recorded(self):
        world = self.root / 'data/world.pmtiles'
        coverage = self.root / 'public/coverage.json'
        args = argparse.Namespace(full=True, planet='https://example.test/map')
        with patch.object(prepare.urllib.request, 'urlopen', return_value=io.BytesIO(b'map')):
            prepare.build_map(world, coverage, args, None, digest(b'map'))
        self.assertEqual(world.read_bytes(), b'map')
        self.assertEqual(json.loads(coverage.read_text()), {
            'development': False, 'maxzoom': 15, 'source': args.planet, 'sha256': digest(b'map'),
        })

    def test_existing_map_records_verified_digest_without_rebuilding(self):
        world = self.root / 'data/world.pmtiles'
        coverage = self.root / 'public/coverage.json'
        world.write_bytes(b'map')
        coverage.write_text(json.dumps({'development': True, 'source': 'test-source'}))
        args = argparse.Namespace(full=False, planet='test-source')
        prepare.reuse_existing_map(world, coverage, args, digest(b'map'))
        self.assertEqual(json.loads(coverage.read_text())['sha256'], digest(b'map'))
        args.full = True
        with self.assertRaises(SystemExit):
            prepare.reuse_existing_map(world, coverage, args, digest(b'map'))
