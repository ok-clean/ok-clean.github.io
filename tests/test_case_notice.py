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
import update
import build


class NoticeClassificationTest(unittest.TestCase):
    def setUp(self):
        self.config = {
            'blog': ['blog_a', 'blog_b'],
            'services': [{'id': 'washer', 'name': '세탁기 청소', 'keywords': ['세탁기청소']}],
            'excludeWords': [], 'tipWords': ['방법'], 'tipTopics': [], 'regions': [],
        }
        self.entries = [
            {'title': '오케이청소 필독 공지 | 서비스 안내·시공 사례', 'link': 'https://example.test/notice', 'kind': 'case', 'svc': '', 'blog': 'blog_a'},
            {'title': '춘천 공지천 세탁기 청소 후기', 'link': 'https://example.test/river', 'kind': 'case', 'svc': 'washer', 'blog': 'blog_a'},
            {'title': '춘천 시공지역 세탁기 청소 후기', 'link': 'https://example.test/area', 'kind': 'case', 'svc': 'washer', 'blog': 'blog_b'},
            {'title': '춘천 세탁기 청소 5단계', 'link': 'https://example.test/steps', 'kind': 'case', 'svc': 'washer', 'blog': 'blog_a'},
            {'title': '전문가가 알려주는 세탁기 청소', 'link': 'https://example.test/explain', 'kind': 'case', 'svc': 'washer', 'blog': 'blog_b'},
        ]

    def test_notice_boundaries_and_existing_heuristics(self):
        for title in ['[공지] 청소 서비스 안내', '오케이청소 필독 공지 | 시공 사례', '청소 공지사항: 운영 안내']:
            with self.subTest(title=title):
                self.assertEqual(update.judge(self.config, title, '')[0], 'notice')
        for item in self.entries[1:]:
            with self.subTest(title=item['title']):
                self.assertEqual(update.judge(self.config, item['title'], '')[0], 'case')
        self.assertEqual(update.judge(self.config, '세탁기 청소 방법', '')[0], 'tip')
        self.assertEqual(update.judge(self.config, '관계없는 일상', '')[0], None)

    def test_same_link_becomes_notice_without_collecting_new_notice(self):
        rss = '''<rss><channel>
        <item><title>[공지] unrelated personal news</title><link>https://example.test/new-notice</link></item>
        <item><title>[공지] service notice</title><link>https://example.test/steps</link></item>
        <item><title>춘천 세탁기 청소 후기</title><link>https://example.test/new-report</link></item>
        </channel></rss>'''.encode('utf8')
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'cases.json'
            path.write_text(json.dumps({'cases': self.entries}, ensure_ascii=False), encoding='utf8')
            def fetch_blog(blog):
                if blog == 'blog_a':
                    return rss
                raise OSError('simulated failure')
            with patch.object(update, 'OUT', path), patch.object(update.build, 'load', return_value=self.config), patch.object(update.build, 'run'), patch.object(update, 'fetch_rss', side_effect=fetch_blog), contextlib.redirect_stdout(io.StringIO()):
                update.main()
                first = {x['link']: x for x in json.loads(path.read_text('utf8'))['cases']}
                self.assertNotIn('https://example.test/new-notice', first)
                self.assertIn('https://example.test/new-report', first)
                self.assertEqual(first['https://example.test/steps'], {**self.entries[3], 'kind': 'notice'})
                self.assertTrue(all(x['link'] in first for x in self.entries))
                # 다른 블로그만 응답하더라도 기록은 다시 사례로 되돌리지 않습니다.
                def fetch_other_blog(blog):
                    if blog == 'blog_b':
                        return b'<rss><channel/></rss>'
                    raise OSError('simulated failure')
                with patch.object(update, 'fetch_rss', side_effect=fetch_other_blog):
                    update.main()
                second = {x['link']: x for x in json.loads(path.read_text('utf8'))['cases']}
                self.assertEqual(second['https://example.test/steps'], {**self.entries[3], 'kind': 'notice'})

    def test_notice_stays_hidden_on_generated_pages_and_count(self):
        c = {'name': '가상 업체', 'siteUrl': 'https://example.test', 'phone': '',
             'regions': ['춘천'], 'categories': [{'id': 'care', 'name': '청소'}],
             'promises': [{'t': '안내', 'd': '가상 안내'}],
             'services': [{'id': 'washer', 'cat': 'care', 'name': '세탁기 청소',
                           'summary': '가상 청소', 'includes': [], 'quote': True}]}
        notice = {'title': '가상 보존 공지', 'link': 'https://example.test/notice',
                  'svc': 'washer', 'region': '춘천', 'kind': 'notice'}
        case = {'title': '가상 작업 후기', 'link': 'https://example.test/case',
                'svc': 'washer', 'region': '춘천', 'kind': 'case'}
        for html in [build.area_page(c, '춘천', [notice, case]), build.service_page(c, c['services'][0], [notice, case])]:
            self.assertNotIn('가상 보존 공지', html)
            self.assertIn('가상 작업 후기', html)
        self.assertIn('1건', build.promises_section(c, [notice, case]))

    def test_partial_and_total_rss_failure_keep_original_records(self):
        original = {'updated': 'old', 'cases': self.entries}
        for success in [True, False]:
            with self.subTest(partial_success=success), tempfile.TemporaryDirectory() as temp:
                path = Path(temp) / 'cases.json'
                original_text = json.dumps(original, ensure_ascii=False)
                path.write_text(original_text, encoding='utf8')
                def read_blog(_config, blog):
                    if success and blog == 'blog_a':
                        return []
                    raise OSError('simulated failure')
                with patch.object(update, 'OUT', path), patch.object(update.build, 'load', return_value=self.config), patch.object(update.build, 'run'), patch.object(update, 'read_blog', side_effect=read_blog), contextlib.redirect_stdout(io.StringIO()):
                    update.main()
                if not success:
                    self.assertEqual(path.read_text('utf8'), original_text)
                    continue
                result = json.loads(path.read_text('utf8'))['cases']
                self.assertEqual({x['link'] for x in result}, {x['link'] for x in self.entries})
                by_link = {x['link']: x for x in result}
                self.assertEqual(by_link['https://example.test/notice']['kind'], 'notice')
                self.assertTrue(all(by_link[x['link']]['kind'] == 'case' for x in self.entries[1:]))


if __name__ == '__main__':
    unittest.main(verbosity=2)
