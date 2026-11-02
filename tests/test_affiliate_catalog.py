import importlib.util
import json
import unittest
from datetime import datetime, timezone
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('catalog', ROOT / 'prototype/affiliate/build_catalog.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class CatalogTests(unittest.TestCase):
    def data(self):
        return {'enabled': True, 'approvalReference': 'synthetic-test-only', 'disclosure': '제휴 수수료 안내', 'categories': ['도구'], 'products': [{'approved': True, 'status': 'available', 'category': '도구', 'validUntil': '2099-01-01T00:00:00+09:00', 'affiliateUrl': 'https://example.test/item', 'name': '<script>x</script>', 'description': '가상 시험자료'}]}
    def test_disabled_has_no_product_links(self):
        d=self.data();d['enabled']=False
        self.assertNotIn('https://example.test', m.render(d))
    def test_missing_approval_rejected(self):
        d=self.data();d['approvalReference']=''
        with self.assertRaises(ValueError):m.render(d)
    def test_unapproved_soldout_expired_hidden(self):
        for field,value in [('approved',False),('status','soldout'),('validUntil','2000-01-01T00:00:00+09:00')]:
            d=self.data();d['products'][0][field]=value
            self.assertNotIn('https://example.test',m.render(d))
    def test_links_escape_disclosure_and_no_fixed_price(self):
        html=m.render(self.data());self.assertIn('sponsored noopener noreferrer',html);self.assertIn('제휴 수수료 안내',html);self.assertNotIn('<script>',html);self.assertIn('판매처에서 확인',html)
    def test_bad_url_rejected(self):
        for url in ['javascript:alert(1)','http://example.test','https://user:pass@example.test']:
            d=self.data();d['products'][0]['affiliateUrl']=url
            with self.assertRaises(ValueError):m.render(d)
    def test_checked_in_catalog_disabled_and_generated_matches(self):
        d=json.loads((ROOT/'prototype/affiliate/catalog.json').read_text());self.assertFalse(d['enabled']);self.assertEqual(d['products'],[])
        self.assertEqual((ROOT/'prototype/affiliate/index.html').read_text(),m.render(d))

if __name__=='__main__':unittest.main()
