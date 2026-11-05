import contextlib
import io
import json
import shutil
import sys
import tempfile
import unittest
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import build

NS = {'s': 'http://www.sitemaps.org/schemas/sitemap/0.9'}


class CanonicalParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'link' and attrs.get('rel') == 'canonical':
            self.urls.append(attrs.get('href'))


class SitemapTest(unittest.TestCase):
    def test_generation_preserves_urls_and_matches_canonical_without_fake_dates(self):
        saved = (ROOT / 'sitemap.xml').read_text('utf-8')
        source = ET.fromstring(saved)
        urls = [node.text for node in source.findall('s:url/s:loc', NS)]
        self.assertEqual(len(urls), len(set(urls)))
        self.assertEqual(source.findall('.//s:lastmod', NS), [])
        config = json.loads((ROOT / 'config.json').read_text('utf-8'))
        base = config['siteUrl'].rstrip('/') + '/'
        expected = [base] + [base + f"services/{service['id']}.html" for service in config['services']]
        # 지역 페이지의 한글 경로는 UTF-8 percent-encoding으로 sitemap에 기록한다.
        expected += [base + 'area/' + urllib.parse.quote(region) + '.html' for region in config.get('regions', [])]
        self.assertEqual(urls, expected)

        class ClockDayOne(datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 10, 1, tzinfo=tz)

        class ClockDayTwo(datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 10, 2, tzinfo=tz)

        with tempfile.TemporaryDirectory() as dirname:
            tmp = Path(dirname)
            for filename in ('config.json', 'cases.json'):
                shutil.copyfile(ROOT / filename, tmp / filename)
            with patch.object(build, 'ROOT', tmp), contextlib.redirect_stdout(io.StringIO()):
                with patch.object(build, 'datetime', ClockDayOne):
                    build.run()
                first = (tmp / 'sitemap.xml').read_text('utf-8')
                with patch.object(build, 'datetime', ClockDayTwo):
                    build.run()
                self.assertEqual(first, (tmp / 'sitemap.xml').read_text('utf-8'))
            self.assertEqual(first, saved)
            for url in urls:
                self.assertTrue(url.startswith(base))
                relative = urllib.parse.unquote(url[len(base):]) or 'index.html'
                page = tmp / relative
                self.assertTrue(page.is_file(), url)
                parser = CanonicalParser()
                parser.feed(page.read_text('utf-8'))
                self.assertEqual(parser.urls, [url])


if __name__ == '__main__':
    unittest.main(verbosity=2)
