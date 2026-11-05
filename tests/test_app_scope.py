import contextlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import build


class Page(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.tags = []
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))


class CustomerAppScopeTest(unittest.TestCase):
    def test_administrator_icons_are_distinct_local_png_assets(self):
        admin = json.loads((ROOT / 'admin/manifest.webmanifest').read_text('utf-8'))
        self.assertEqual(admin['name'], '오케이청소 관리자')
        self.assertEqual(admin['id'], '/admin/')
        for icon in admin['icons']:
            path = ROOT / 'admin' / icon['src']
            data = path.read_bytes()
            self.assertEqual(data[:8], b'\x89PNG\r\n\x1a\n')
            width, height = int.from_bytes(data[16:20], 'big'), int.from_bytes(data[20:24], 'big')
            self.assertEqual(icon['sizes'], f'{width}x{height}')
            self.assertIn('maskable', icon['purpose'])
            self.assertNotEqual(data, (ROOT / 'icon-192.png').read_bytes())
        html = Page((ROOT / 'admin/index.html').read_text('utf-8'))
        self.assertIn(('link', {'rel': 'apple-touch-icon', 'href': 'apple-touch-icon.png'}), html.tags)

    def test_app_scopes_do_not_overlap_and_customer_identity_is_preserved(self):
        customer = json.loads((ROOT / 'manifest.webmanifest').read_text('utf-8'))
        admin = json.loads((ROOT / 'admin/manifest.webmanifest').read_text('utf-8'))
        self.assertEqual(customer['id'], '/')
        self.assertEqual(admin['id'], '/admin/')
        scopes = []
        for manifest, manifest_url in ((customer, 'https://ok-clean.github.io/manifest.webmanifest'),
                                       (admin, 'https://ok-clean.github.io/admin/manifest.webmanifest')):
            scope = urlsplit(urljoin(manifest_url, manifest['scope'])).path
            start = urlsplit(urljoin(manifest_url, manifest['start_url'])).path
            self.assertTrue(scope.endswith('/'))
            self.assertTrue(start.startswith(scope), 'An app must launch inside its own scope')
            self.assertTrue((ROOT / start.lstrip('/') / 'index.html').is_file())
            scopes.append(scope)
        self.assertFalse(scopes[0].startswith(scopes[1]), 'Customer scope must not contain administrator scope')
        self.assertFalse(scopes[1].startswith(scopes[0]), 'Administrator scope must not contain customer scope')

    def test_app_entry_keeps_home_features_and_resolves_public_links(self):
        home = Page((ROOT / 'index.html').read_text('utf-8'))
        app = Page((ROOT / 'app/index.html').read_text('utf-8'))
        self.assertEqual(Counter(attrs['id'] for _, attrs in app.tags if 'id' in attrs),
                         Counter(attrs['id'] for _, attrs in home.tags if 'id' in attrs))
        self.assertEqual([attrs['href'] for tag, attrs in app.tags if tag == 'link' and attrs.get('rel') == 'canonical'],
                         ['https://ok-clean.github.io/'])
        self.assertFalse(any(tag == 'base' for tag, _ in app.tags), 'A base URL could move fragment navigation out of the app')
        self.assertFalse(any(tag == 'meta' and attrs.get('http-equiv', '').lower() == 'refresh' for tag, attrs in app.tags))
        current = 'https://ok-clean.github.io/app/?ref=OK-AAAAAA'
        fragments = set()
        for tag, attrs in app.tags:
            for key in ('href', 'src'):
                raw = attrs.get(key)
                if not raw:
                    continue
                resolved = urlsplit(urljoin(current, raw))
                if raw.startswith('#'):
                    self.assertEqual(resolved.path, '/app/')
                    self.assertEqual(resolved.query, 'ref=OK-AAAAAA')
                    fragments.add(resolved.fragment)
                if resolved.scheme not in ('http', 'https') or resolved.netloc != 'ok-clean.github.io':
                    continue
                local = ROOT / unquote(resolved.path).lstrip('/')
                if resolved.path.endswith('/'):
                    local = local / 'index.html'
                self.assertTrue(local.is_file(), f'App entry has an unresolved public URL: {raw}')
        self.assertTrue({'quote', 'services', 'cases', 'member', 'faq'}.issubset(fragments))
        scripts = [urlsplit(urljoin(current, attrs['src'])).path for tag, attrs in app.tags
                   if tag == 'script' and 'src' in attrs]
        self.assertIn('/app.js', scripts)
        self.assertIn('/install.js', scripts)

    def test_regular_regeneration_preserves_app_entry_and_new_scope(self):
        with tempfile.TemporaryDirectory() as dirname:
            temp = Path(dirname)
            for name in ('config.json', 'cases.json'):
                shutil.copyfile(ROOT / name, temp / name)
            with patch.object(build, 'ROOT', temp), contextlib.redirect_stdout(io.StringIO()):
                build.run()
                self.assertEqual((temp / 'index.html').read_bytes(), (ROOT / 'index.html').read_bytes())
                self.assertEqual((temp / 'app/index.html').read_bytes(), (ROOT / 'app/index.html').read_bytes())
                manifest = json.loads((temp / 'manifest.webmanifest').read_text('utf-8'))
                self.assertEqual(manifest['id'], '/')
                self.assertEqual(manifest['scope'], '/app/')
                self.assertEqual(manifest['start_url'], '/app/?src=app')
                config = json.loads((temp / 'config.json').read_text('utf-8'))
                config['tagline'] = '자동 갱신 검증용 설명'
                (temp / 'config.json').write_text(json.dumps(config, ensure_ascii=False), 'utf-8')
                build.run()
                for name in ('index.html', 'app/index.html'):
                    self.assertIn('자동 갱신 검증용 설명', (temp / name).read_text('utf-8'))


if __name__ == '__main__':
    unittest.main()
