import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import build
import update


class ArchiveTest(unittest.TestCase):
    def setUp(self):
        self.config = {
            'name': '가상 업체', 'siteUrl': 'https://example.test', 'phone': '',
            'blog': ['blog_a', 'blog_b'], 'regions': ['춘천'],
            'categories': [{'id': 'care', 'name': '청소'}],
            'services': [{'id': 'washer', 'cat': 'care', 'name': '세탁기 청소',
                          'keywords': ['세탁기청소'], 'summary': '가상 청소',
                          'includes': [], 'quote': True}],
            'promises': [{'t': '안내', 'd': '가상 안내'}],
            'excludeWords': ['교육'], 'tipWords': ['방법'], 'tipTopics': [],
        }
        def record(name, title, **kwargs):
            return {'link': 'https://example.test/' + name, 'title': title,
                    'svc': 'washer', 'region': '춘천', 'kind': 'case', 'blog': 'blog_a', **kwargs}
        self.old = [
            record('change', '세탁기 청소 후기'),
            record('restore', '지난 청소 교육', kind='archived'),
            record('notice', '[공지] 가상 공지', kind='notice'),
            record('blank', '세탁기 청소 후기'),
            record('old-excluded', '세탁기 청소 교육', blog='blog_b'),
            record('no-blog', '세탁기 청소 교육', blog=''),
            record('removed', '세탁기 청소 교육', blog='removed_blog'),
            {'title': '링크 없는 항목', 'kind': 'case'},
            record('other-case', '세탁기 청소 후기', blog='blog_b'),
            record('other-archive', '세탁기 청소 교육', kind='archived', blog='blog_b'),
            record('other-notice', '[공지] 가상 공지', kind='notice', blog='blog_b'),
            record('other-reclassified', '세탁기 청소 교육', blog='blog_b'),
            record('other-case-notice', '세탁기 청소 후기', blog='blog_b'),
        ]

    def test_rss_exclusion_and_restore_with_partial_failure(self):
        rss = '''<rss><channel>
          <item><title>세탁기 청소 교육</title><link>https://example.test/change</link></item>
          <item><title>세탁기 청소 교육</title><link>https://example.test/new-excluded</link></item>
          <item><title>춘천 세탁기 청소 후기</title><link>https://example.test/restore</link></item>
          <item><title>세탁기 청소 교육</title><link>https://example.test/notice</link></item>
          <item><title></title><link>https://example.test/blank</link></item>
          <item><title>세탁기 청소 교육</title><link>https://example.test/other-case</link></item>
          <item><title>춘천 세탁기 청소 후기</title><link>https://example.test/other-archive</link></item>
          <item><title>춘천 세탁기 청소 후기</title><link>https://example.test/other-notice</link></item>
          <item><title>춘천 세탁기 청소 후기</title><link>https://example.test/other-reclassified</link></item>
          <item><title>[공지] 서비스 안내</title><link>https://example.test/other-case-notice</link></item>
        </channel></rss>'''.encode('utf8')
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'cases.json'
            path.write_text(json.dumps({'cases': self.old}, ensure_ascii=False), encoding='utf8')
            def fetch_blog(blog):
                if blog == 'blog_a':
                    return rss
                raise OSError('simulated failure')
            with patch.object(update, 'OUT', path), patch.object(update.build, 'load', return_value=self.config), patch.object(update.build, 'run'), patch.object(update, 'fetch_rss', side_effect=fetch_blog), contextlib.redirect_stdout(io.StringIO()):
                update.main()
                first = {x['link']: x for x in json.loads(path.read_text('utf8'))['cases']}
                self.assertEqual(first['https://example.test/change'], {**self.old[0], 'kind': 'archived'})
                self.assertEqual(first['https://example.test/restore']['kind'], 'case')
                self.assertEqual(first['https://example.test/notice'], self.old[2])
                self.assertEqual(first['https://example.test/blank']['kind'], 'case')
                self.assertEqual(first['https://example.test/old-excluded'], {**self.old[4], 'kind': 'archived'})
                self.assertEqual(first['https://example.test/no-blog'], {**self.old[5], 'kind': 'archived'})
                self.assertNotIn('https://example.test/new-excluded', first)
                self.assertNotIn('https://example.test/removed', first)
                self.assertEqual(first['https://example.test/other-case']['kind'], 'case')
                self.assertEqual(first['https://example.test/other-archive'], self.old[9])
                self.assertEqual(first['https://example.test/other-notice'], self.old[10])
                self.assertEqual(first['https://example.test/other-reclassified'], {**self.old[11], 'kind': 'archived'})
                self.assertEqual(first['https://example.test/other-case-notice']['kind'], 'case')
                self.assertEqual(len(first), 11)

                # 다른 블로그만 성공해도 보관 상태를 유지합니다.
                with patch.object(update, 'fetch_rss', side_effect=lambda blog: b'<rss><channel/></rss>' if blog == 'blog_b' else (_ for _ in ()).throw(OSError('simulated failure'))):
                    update.main()
                second = {x['link']: x for x in json.loads(path.read_text('utf8'))['cases']}
                self.assertEqual(second['https://example.test/change']['kind'], 'archived')
                self.assertEqual(second['https://example.test/notice']['kind'], 'notice')
                self.assertEqual(second['https://example.test/restore']['kind'], 'case')

                # 정상 후기 RSS가 다시 확인되면 보관 상태에서 복구됩니다.
                recovered = b'<rss><channel><item><title>\xec\x84\xb8\xed\x83\x81\xea\xb8\xb0 \xec\xb2\xad\xec\x86\x8c \xed\x9b\x84\xea\xb8\xb0</title><link>https://example.test/change</link></item></channel></rss>'
                with patch.object(update, 'fetch_rss', side_effect=lambda blog: recovered if blog == 'blog_a' else (_ for _ in ()).throw(OSError('simulated failure'))):
                    update.main()
                third = {x['link']: x for x in json.loads(path.read_text('utf8'))['cases']}
                self.assertEqual(third['https://example.test/change']['kind'], 'case')

    def test_total_failure_and_no_blogs_do_not_change_file(self):
        original = json.dumps({'cases': self.old}, ensure_ascii=False)
        for config, failure in [(self.config, True), ({**self.config, 'blog': []}, False)]:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temp:
                path = Path(temp) / 'cases.json'
                path.write_text(original, encoding='utf8')
                with patch.object(update, 'OUT', path), patch.object(update.build, 'load', return_value=config), patch.object(update.build, 'run'), patch.object(update, 'fetch_rss', side_effect=OSError('simulated failure')), contextlib.redirect_stdout(io.StringIO()):
                    update.main()
                self.assertEqual(path.read_text('utf8'), original)

    def test_archived_hidden_from_generated_pages_and_count(self):
        hidden = {'title': '가상 보관 글', 'link': 'https://example.test/archive', 'svc': 'washer', 'region': '춘천', 'kind': 'archived'}
        active = {'title': '가상 후기', 'link': 'https://example.test/case', 'svc': 'washer', 'region': '춘천', 'kind': 'case'}
        for text in [build.area_page(self.config, '춘천', [hidden, active]), build.service_page(self.config, self.config['services'][0], [hidden, active])]:
            self.assertNotIn('가상 보관 글', text)
            self.assertIn('가상 후기', text)
        self.assertIn('1건', build.promises_section(self.config, [hidden, active]))


if __name__ == '__main__':
    unittest.main(verbosity=2)
