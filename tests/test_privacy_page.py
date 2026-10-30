import copy
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import build


def section(page, number):
    start = page.index(f"<h2>{number}.")
    try:
        end = page.index(f"<h2>{number + 1}.", start)
    except ValueError:
        end = page.index("</div>", start)
    return page[start:end]


class PrivacyPageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = build.load()

    def config(self):
        c = copy.deepcopy(self.base)
        c["firebase"] = {}
        c["memberBackendUrl"] = ""
        return c

    def test_paused_signup_and_customer_initiated_consultation_are_described(self):
        text = section(build.privacy_page(self.config()), 2)
        self.assertIn("이 화면에서 신규 회원가입 접수를 중지합니다", text)
        self.assertNotIn("Cloud Firestore", text)
        self.assertNotIn("Apps Script", text)
        self.assertIn("클립보드", text)

    def test_configured_firebase_does_not_claim_signup_is_active(self):
        c = self.config()
        c["firebase"] = {"apiKey": "test-only-identifier", "projectId": "test-project"}
        page = build.privacy_page(c)
        text = section(page, 2)
        self.assertIn("이 화면에서 신규 회원가입 접수를 중지합니다", text)
        self.assertNotIn("전송하려고 합니다", text)
        self.assertNotIn("test-only-identifier", page)
        c["firebase"]["apiKey"] = ""
        self.assertIn("신규 회원가입 접수를 중지합니다", section(build.privacy_page(c), 2))

    def test_configured_script_does_not_claim_signup_is_active(self):
        c = self.config()
        c["memberBackendUrl"] = "https://script.google.com/macros/s/example/exec"
        text = section(build.privacy_page(c), 2)
        self.assertIn("신규 회원가입 접수를 중지합니다", text)
        self.assertNotIn("전송하려고 합니다", text)
        c["memberBackendUrl"] = "https://script.google.com.evil.invalid/macros/s/example"
        self.assertNotIn("Apps Script", section(build.privacy_page(c), 2))

    def test_both_configured_backends_remain_paused(self):
        c = self.config()
        c["firebase"] = {"apiKey": "test-only-identifier", "projectId": "test-project"}
        c["memberBackendUrl"] = "https://script.google.com/macros/s/example/exec"
        text = section(build.privacy_page(c), 2)
        self.assertIn("신규 회원가입 접수를 중지합니다", text)
        self.assertNotIn("전송하려고 합니다", text)

    def test_device_delete_notice_distinguishes_server_data(self):
        c = self.config()
        text = section(build.privacy_page(c), 2)
        self.assertIn("이 기기에 저장된 회원정보 직접 지우기", text)
        self.assertIn("클립보드, 카카오톡 대화", text)
        self.assertIn("이미 접수된 서버 정보는 이 기능으로 삭제되지 않습니다", text)
        c["member"] = None
        c["firebase"] = {"apiKey": "test-only-identifier", "projectId": "test-project"}
        text = section(build.privacy_page(c), 2)
        self.assertNotIn("이 기기에 저장된 회원정보 직접 지우기", text)
        self.assertNotIn("Cloud Firestore", text)

    def test_analytics_disabled_even_when_configured_and_referrer_suppressed(self):
        c = self.config()
        c["analytics"] = {"ga": "synthetic-ga", "naver": "synthetic-naver"}
        self.assertEqual(build.analytics(c), "")
        page = build.privacy_page(c)
        self.assertNotIn("googletagmanager.com", page)
        self.assertNotIn("wcs.pstatic.net", page)
        self.assertIn('<meta name="referrer" content="no-referrer">', page)

    def test_faq_screen_and_structured_data_share_paused_status(self):
        c = self.config()
        c["faq"] = [{"q": "회원 쿠폰은 어떻게 쓰나요?", "a": "지금 회원가입하면 쿠폰을 발급합니다."}]
        html = build.index_page(c)
        self.assertIn("신규 회원가입은 개인정보 처리 절차 확인을 위해 일시 중지", html)
        self.assertEqual(build.current_faq(c)[0]["a"], "신규 회원가입은 개인정보 처리 절차 확인을 위해 일시 중지 중이에요. 회원 혜택에 관해서는 전화나 카카오톡으로 문의해 주세요.")
        self.assertIn("지금 회원가입하면 쿠폰", c["faq"][0]["a"])

    def test_published_notice_matches_generator_and_configuration(self):
        generated = build.privacy_page(self.base)
        saved = (ROOT / "privacy.html").read_text("utf-8")
        self.assertEqual(section(generated, 2), section(saved, 2))
        self.assertEqual(section(generated, 4), section(saved, 4))

    def test_unconfirmed_retention_does_not_promise_automatic_deletion(self):
        generated = build.privacy_page(self.base)
        text = section(generated, 3)
        self.assertIn("보관 기간 및 파기 절차는 확인 중", text)
        self.assertIn("자동 삭제가 이루어진다고 안내할 수 없", text)
        self.assertNotIn("2년", text)
        self.assertEqual(text, section((ROOT / "privacy.html").read_text("utf-8"), 3))

    def test_analytics_pause_and_unknown_external_processing_are_described(self):
        generated = build.privacy_page(self.base)
        self.assertIn("방문 통계 스크립트의 자동 수집은 일시 중지", generated)
        self.assertNotIn("익명으로 수집될 수", generated)
        self.assertIn("외부 처리·제공 현황은 확인 중", section(generated, 4))
        self.assertNotIn("이용자의 동의 없이 개인정보를 외부에 판매하거나", generated)


if __name__ == "__main__":
    unittest.main(verbosity=2)

