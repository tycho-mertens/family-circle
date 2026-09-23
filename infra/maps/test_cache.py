import threading
import unittest
from unittest.mock import Mock, patch

import serve


class TileCacheTests(unittest.TestCase):
    def setUp(self):
        self.clock = self.enterContext(patch.object(serve.time, 'monotonic', return_value=0))
        self.cache = serve.TileCache(max_bytes=6, ttl=10)

    def test_reads_refresh_lru_order_but_not_expiration(self):
        self.cache.put('a', b'aaa', 'gzip', 0)
        self.cache.put('b', b'bbb', None, 0)
        self.assertEqual(self.cache.get('a'), (b'aaa', 'gzip'))
        self.cache.put('c', b'ccc', None, 0)
        self.assertIsNone(self.cache.get('b'))
        self.clock.return_value = 10
        self.assertIsNone(self.cache.get('a'))
        self.assertIsNone(self.cache.get('c'))

    def test_replacement_and_expiration_release_bytes(self):
        self.cache.put('a', b'aaaaaa', None, 0)
        self.cache.put('a', b'a', None, 0)
        self.cache.put('b', b'bbbbb', None, 5)
        self.assertEqual(self.cache.get('a'), (b'a', None))
        self.clock.return_value = 10
        self.assertIsNone(self.cache.get('a'))
        self.cache.put('c', b'c', None, 10)
        self.assertEqual(self.cache.get('b'), (b'bbbbb', None))
        self.assertEqual(self.cache.get('c'), (b'c', None))

    def test_tile_larger_than_budget_is_not_retained(self):
        self.cache.put('a', b'too big', None, 0)
        self.assertIsNone(self.cache.get('a'))


class FetchTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(serve, 'cache', serve.TileCache()))
        self.enterContext(patch.object(serve, 'workers', threading.BoundedSemaphore(1)))

    def test_local_request_uses_loopback_without_credentials(self):
        with patch.object(serve, 'PROVIDER', 'local'):
            request = serve.tile_request((3, 2, 1))
        self.assertEqual(request.full_url, 'http://127.0.0.1:8091/world/3/2/1.mvt')
        self.assertEqual(request.headers, {})

    def test_failed_or_oversized_fetch_releases_worker_and_is_not_cached(self):
        response = Mock(headers={'Content-Encoding': 'gzip'})
        response.read.return_value = b'x' * (serve.MAX_TILE_BYTES + 1)
        context = Mock()
        context.__enter__ = Mock(return_value=response)
        context.__exit__ = Mock(return_value=False)
        with patch.object(serve.opener, 'open', side_effect=[OSError('offline'), context]):
            for error in (OSError, RuntimeError):
                with self.assertRaises(error):
                    serve.fetch_tile((0, 0, 0))
                self.assertIsNone(serve.cache.get((0, 0, 0)))
                self.assertTrue(serve.workers.acquire(blocking=False))
                serve.workers.release()

    def test_redirects_are_not_followed(self):
        self.assertIsNone(serve.NoRedirect().redirect_request(
            None, None, 302, 'redirect', {}, 'https://other.example/'))
