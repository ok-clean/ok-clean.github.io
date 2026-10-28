import unittest
import build
import update

class CaseClassificationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = build.load()

    def test_notice_is_not_a_case(self):
        self.assertIsNone(update.judge(self.config, '오케이청소 필독 공지 | 서비스 안내·시공 사례', '')[0])

    def test_informational_titles_are_tips(self):
        for title in ('현업자가 알려주는 통돌이 세탁기 청소 5단계', '춘천 김장 전 주방 대청소, 고춧가루 얼룩 지우는 법'):
            with self.subTest(title=title):
                self.assertEqual(update.judge(self.config, title, '')[0], 'tip')

    def test_explicit_work_reports_stay_cases(self):
        for title in ('춘천·화천 카펫청소, 춘천문화예술회관 객석 후기', '춘천 계단 청소 5단계 작업 후기'):
            with self.subTest(title=title):
                self.assertEqual(update.judge(self.config, title, '')[0], 'case')

if __name__ == '__main__':
    unittest.main()
