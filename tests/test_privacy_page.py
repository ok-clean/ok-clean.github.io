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
        self.assertIn("실제 고객 회원가입과 실제 청소 계약·결제는 없습니다", text)
        self.assertIn("자동 삭제가 이루어진다고 안내할 수 없", text)
        self.assertNotIn("2년", text)
        self.assertEqual(text, section((ROOT / "privacy.html").read_text("utf-8"), 3))

    def test_analytics_pause_and_unknown_external_processing_are_described(self):
        generated = build.privacy_page(self.base)
        self.assertIn("방문 통계 스크립트의 자동 수집은 일시 중지", generated)
        self.assertNotIn("익명으로 수집될 수", generated)
        self.assertIn("외부 처리·제3자 제공·처리 위탁 및 국외 이전 해당 여부는 확인 중", section(generated, 4))
        self.assertNotIn("이용자의 동의 없이 개인정보를 외부에 판매하거나", generated)


    def test_consultation_discloses_actual_optional_fields_and_purposes(self):
        page = build.privacy_page(self.base)
        text = section(page, 1)
        for value in ("이름", "연락처", "청소 장소", "현장 사진", "기타 요청사항", "청소 희망일",
                      "청소 견적 상담", "서비스 문의", "상담 후 연락", "일정 협의",
                      "선택적으로 처리", "모든 상담에서 모든 항목을 받는 것은 아닙니다"):
            self.assertIn(value, text)
        self.assertEqual(text, section((ROOT / "privacy.html").read_text("utf-8"), 1))

    def test_consultation_channels_and_inactive_membership_management(self):
        text = section(build.privacy_page(self.base), 2)
        for value in ("전화·문자·카카오톡 오픈채팅", "카카오톡 대화와 전화·문자 내역",
                      "다른 보관 장소와 백업 이용 여부는 확인이 필요",
                      "기존 회원정보의 조회·수정 기능도 일시 중지",
                      "신규 회원가입 접수를 중지", "신규 예약 접수 기능을 제공하지 않"):
            self.assertIn(value, text)

    def test_consultation_retention_and_contact_are_truthful(self):
        page = build.privacy_page(self.base)
        retention = section(page, 3)
        for value in ("상담 종료 후 90일 보유하는 원칙을 운영자가 승인", "법적 보존 의무와 실제 삭제 가능 범위",
                      "재견적, 일정 재협의, 상담 후속 대응", "실제 시행 전"):
            self.assertIn(value, retention)
        self.assertIn("마지막 회신 요청 후 30일이 지나면 임시 종결", retention)
        self.assertIn("재문의가 발생하면 새로운 상담으로 관리", retention)
        self.assertIn("최종 연락일·마지막 회신 요청일과 실제 상담 종료일은 구분", retention)
        self.assertIn("90일 기준을 일괄 적용하지 않습니다", retention)
        for excluded in ("기존 회원정보", "계약·결제·분쟁 자료", "실제 보관 위치나 처리 목적이 확인되지 않은 자료"):
            self.assertIn(excluded, retention)
        self.assertNotIn("90일 보유를 원칙으로 검토", retention)
        self.assertIn("실기기 파기 시험은 미완료", retention)
        self.assertIn("다른 사람의 사본이나 서비스 제공자의 보관분까지 삭제 완료되었다고 보장하지 않습니다", retention)
        self.assertIn("처리 위탁 및 국외 이전 해당 여부는 확인 중", section(page, 4))
        contact = section(page, 6)
        for value in ("오케이청소 개인정보 담당자", "033-911-4457", "tel:0339114457",
                      "열람·정정·삭제 요청 접수처"):
            self.assertIn(value, contact)
        saved = (ROOT / "privacy.html").read_text("utf-8")
        for number in (3, 4, 6):
            self.assertEqual(section(page, number), section(saved, number))

    def test_draft_cannot_be_mistaken_for_effective_policy(self):
        page = build.privacy_page(self.base)
        self.assertIn('data-privacy-draft', page)
        self.assertIn('개정 검토안 · 시행 전', page)
        self.assertIn('원칙은 운영자 승인 완료', page)
        self.assertIn('제안 시행일: 2026-11-01 · 실제 시행일: 미확정', page)
        self.assertIn('제안일 도래만으로 시행·자동 삭제·배포가 시작되지 않습니다', page)
        self.assertIn('실제 게시·운영 배포용 최종 처리방침으로 승인되지 않았습니다', page)
        retention = section(page, 3)
        self.assertIn('90일은 법정 의무기간이 아닙니다', retention)
        self.assertIn('기존 정보의 보유기간 연장 근거가 되지 않습니다', retention)
        self.assertIn('임의 삭제하거나 자동 삭제하지 않습니다', retention)
        self.assertIn('무기한 보관의 근거는 아니', retention)
        self.assertEqual(page, (ROOT / 'privacy.html').read_text('utf-8'))

    def test_deletion_proposal_separates_media_and_completion_limits(self):
        retention = section(build.privacy_page(self.base), 3)
        for expected in ('파기 운영 절차안 · 실행 전 확정 필요', '문자·전화 내역',
                         '카카오톡 오픈채팅', '현장 사진·전자파일', '백업',
                         '합성 자료로 시험', '복구·재생 방지', '복원 시 삭제 대상 재반영',
                         '즉시 파기 완료로 표시하지 않습니다', '처리일·처리 방법·담당자',
                         '해당 근거·항목·기간'):
            self.assertIn(expected, retention)

    def test_external_roles_require_evidence_and_rights_have_a_working_contact(self):
        page = build.privacy_page(self.base)
        external = section(page, 4)
        self.assertIn('실제 정보 흐름, 처리 목적 및 계약상 역할', external)
        self.assertIn('외부 저장 서비스의 운영 여부도 미확정', external)
        self.assertIn('필수 고지 완료가 아닙니다', external)
        rights = section(page, 5)
        for expected in ('법정대리인', '처리정지·동의 철회', '전화로 요청을 접수', '최소 범위', '그 사유'):
            self.assertIn(expected, rights)
        contact = section(page, 6)
        self.assertIn('실제 접수·처리할 수 있음을 운영자가 확인', contact)
        self.assertIn('href="tel:0339114457"', contact)

    def test_operator_confirmed_facts_do_not_overstate_deletion_or_storage_scope(self):
        page = build.privacy_page(self.base)
        for fact in ('실제 고객 회원가입은 없습니다', '상담자료는 운영자 본인만 열람',
                     '휴대폰 갤러리·PC에 별도로 저장', '지문·비밀번호 잠금',
                     '실제 고객 회원가입과 실제 청소 계약·결제는 없습니다',
                     '현재 확인된 삭제 방법은 휴대폰에서 수동 삭제',
                     'PC 저장 사진·휴지통·연결 기기·백업의 삭제 범위와 복원 가능성은 미확인'):
            self.assertIn(fact, page)
        self.assertIn('모든 상담·시험 자료·기기 사본·다른 저장소의 부재로 확대하지 않습니다', page)
        self.assertIn('다른 사본까지 삭제되거나 복구 불가능한 파기가 완료된 것으로 안내하지 않습니다', page)
        self.assertEqual(page, (ROOT / 'privacy.html').read_text('utf-8'))


if __name__ == "__main__":
    unittest.main(verbosity=2)

