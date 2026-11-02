import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import build


class CaseLinksTest(unittest.TestCase):
    def test_url_fixtures(self):
        for item in json.loads((ROOT / 'tests/case-link-fixtures.json').read_text('utf8')):
            with self.subTest(url=item['url']):
                self.assertEqual(build.safe_case_link(item['url']), item['valid'])

    def test_real_entries_remain_eligible(self):
        entries = json.loads((ROOT / 'cases.json').read_text('utf8'))['cases']
        self.assertTrue(entries)
        self.assertTrue(all(build.safe_case_link(x.get('link')) for x in entries))

    def test_generated_pages_filter_before_limit_and_hide_empty_sections(self):
        config = json.loads((ROOT / 'config.json').read_text('utf8'))
        service = config['services'][0]
        region = config['regions'][0]
        invalid = {'title':'불량 링크', 'link':'javascript:alert(1)', 'svc':service['id'], 'region':region, 'kind':'case'}
        safe = [dict(invalid, title=f'안전 사례 {i}', link=f'https://example.test/{i}') for i in range(10)]
        sample = [invalid] + safe
        service_html = build.service_page(config, service, sample)
        region_html = build.area_page(config, region, sample)
        self.assertNotIn('불량 링크', service_html)
        self.assertNotIn('불량 링크', region_html)
        self.assertEqual(service_html.count('class="case"'), 4)
        self.assertEqual(region_html.count('class="case"'), 8)
        self.assertIn('안전 사례 3', service_html)
        self.assertIn('안전 사례 7', region_html)
        self.assertNotIn('class="case"', build.area_page(config, region, [invalid]))
        self.assertNotIn('최근 ' + service['name'] + ' 사례', build.service_page(config, service, [invalid]))
        if config.get('promises'):
            self.assertIn('10건', build.promises_section(config, sample))
            self.assertNotIn('11건', build.promises_section(config, sample))


if __name__ == '__main__':
    unittest.main(verbosity=2)
