import json
import unittest
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import build

class LinkParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []
    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            self.links.append(dict(attrs).get('href', ''))

class RegionPagesTest(unittest.TestCase):
    def test_area_pages_and_special_characters_are_encoded(self):
        config = json.loads((ROOT / 'config.json').read_text('utf8'))
        cases = json.loads((ROOT / 'cases.json').read_text('utf8')).get('cases', [])
        for region in config['regions'] + ['테스트?&"\'# 지역']:
            with self.subTest(region=region):
                generated = build.area_page(config, region, cases)
                parser = LinkParser()
                parser.feed(generated)
                urls = [u for u in parser.links if u.startswith('../index.html?area=')]
                self.assertEqual(len(urls), 1)
                parsed = urlparse(urls[0])
                self.assertEqual(parse_qs(parsed.query), {'area': [region]})
                self.assertEqual(parsed.fragment, 'quote')
                if region in config['regions']:
                    existing = (ROOT / 'area' / (region + '.html')).read_text('utf8')
                    p2 = LinkParser(); p2.feed(existing)
                    self.assertIn(urls[0], p2.links)

if __name__ == '__main__':
    unittest.main(verbosity=2)
