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

    def test_no_backend_is_described_without_false_remote_claim(self):
        text = section(build.privacy_page(self.config()), 2)
        self.assertIn("자동 전송은 설정되어 있지 않습니다", text)
        self.assertNotIn("Cloud Firestore", text)
        self.assertNotIn("Apps Script", text)
        self.assertIn("클립보드", text)

    def test_firebase_is_shown_only_when_both_settings_are_present(self):
        c = self.config()
        c["firebase"] = {"apiKey": "test-only-identifier", "projectId": "test-project"}
        page = build.privacy_page(c)
        text = section(page, 2)
        self.assertIn("Firebase의 Cloud Firestore로 전송하려고 합니다", text)
        self.assertNotIn("자동 전송은 설정되어 있지 않습니다", text)
        self.assertNotIn("test-only-identifier", page)
        c["firebase"]["apiKey"] = ""
        self.assertNotIn("Cloud Firestore", section(build.privacy_page(c), 2))

    def test_script_notice_follows_the_same_url_prefix_as_the_client(self):
        c = self.config()
        c["memberBackendUrl"] = "https://script.google.com/macros/s/example/exec"
        text = section(build.privacy_page(c), 2)
        self.assertIn("Google Apps Script 연동 주소", text)
        self.assertNotIn("Cloud Firestore", text)
        c["memberBackendUrl"] = "https://script.google.com.evil.invalid/macros/s/example"
        self.assertNotIn("Apps Script", section(build.privacy_page(c), 2))

    def test_both_configured_backends_are_mentioned(self):
        c = self.config()
        c["firebase"] = {"apiKey": "test-only-identifier", "projectId": "test-project"}
        c["memberBackendUrl"] = "https://script.google.com/macros/s/example/exec"
        text = section(build.privacy_page(c), 2)
        self.assertIn("Cloud Firestore", text)
        self.assertIn("Google Apps Script 연동 주소", text)

    def test_device_delete_notice_distinguishes_server_data(self):
        c = self.config()
        text = section(build.privacy_page(c), 2)
        self.assertIn("이 기기의 회원정보 지우기", text)
        self.assertIn("클립보드, 카카오톡 대화", text)
        self.assertIn("이미 접수된 정보는 이 기능으로 삭제되지 않습니다", text)
        c["member"] = None
        c["firebase"] = {"apiKey": "test-only-identifier", "projectId": "test-project"}
        text = section(build.privacy_page(c), 2)
        self.assertNotIn("이 기기의 회원정보 지우기", text)
        self.assertNotIn("Cloud Firestore", text)

    def test_published_notice_matches_generator_and_configuration(self):
        generated = build.privacy_page(self.base)
        saved = (ROOT / "privacy.html").read_text("utf-8")
        self.assertEqual(section(generated, 2), section(saved, 2))
        self.assertEqual(section(generated, 4), section(saved, 4))


if __name__ == "__main__":
    unittest.main(verbosity=2)
