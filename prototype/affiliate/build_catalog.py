"""검토용 추천관. 승인 없는 상품/가격/링크를 출력하지 않는다. 네트워크 호출 없음."""
import json
from datetime import datetime, timezone
from html import escape
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).parent

def https_url(value):
    u = urlsplit(value)
    if u.scheme != 'https' or not u.hostname or u.username or u.password:
        raise ValueError('상품 URL은 인증정보 없는 HTTPS여야 합니다')
    return escape(value, quote=True)

def render(data, now=None):
    cards = []
    if data['enabled']:
        if not data.get('approvalReference') or not data.get('disclosure', '').strip():
            raise ValueError('제휴 승인 근거와 경제적 이해관계 고지가 필요합니다')
        for p in data['products']:
            if not p.get('approved') or p.get('status') != 'available':
                continue
            if p['category'] not in data['categories']:
                raise ValueError('등록되지 않은 카테고리')
            deadline = datetime.fromisoformat(p['validUntil'])
            if deadline.tzinfo is None:
                raise ValueError('유효기간에 시간대가 필요합니다')
            if deadline <= (now or datetime.now(timezone.utc)):
                continue
            href = https_url(p['affiliateUrl'])
            image = f'<img src="{https_url(p["imageUrl"])}" alt="" loading="lazy">' if p.get('imageUrl') else ''
            # 가격은 실시간 API 연결 전까지 고정 표시하지 않습니다.
            cards.append(f'<article>{image}<h2>{escape(p["name"])}</h2><p>{escape(p["description"])}</p><p>가격·재고·배송 조건은 판매처에서 확인하세요.</p><a rel="sponsored noopener noreferrer" target="_blank" href="{href}">판매처에서 확인</a></article>')
    content = ''.join(cards) or '<p role="status">추천 상품을 준비하고 있습니다. 현재 구매 가능한 제휴 상품은 등록되지 않았습니다.</p>'
    disclosure = f'<p>{escape(data["disclosure"])}</p>' if cards else ''
    categories = ' · '.join(escape(x) for x in data['categories'])
    return f'''<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>청소용품 추천관 검토안 | 오케이청소</title><style>body{{font:16px/1.7 sans-serif;margin:0;color:#172b42;background:#f4f7fc}}main{{max-width:960px;margin:auto;padding:24px;overflow-wrap:anywhere}}.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:20px}}article{{background:white;padding:20px;border-radius:12px}}img{{max-width:100%;height:auto}}a{{color:#0645ad;display:inline-block;padding:12px}}</style><main><p>운영 미반영 · 추천관 검토안</p><h1>청소용품 추천관</h1><p>{categories}</p>{disclosure}<section class="grid">{content}</section><nav aria-label="추천관 이동"><a href="../navigation-preview/index.html">검토용 홈페이지로 돌아가기</a><a href="../../index.html#quote">전문 청소 무료 견적 확인</a></nav><p>판매·결제·고객정보 입력은 이 페이지에서 받지 않습니다.</p></main></html>'''

if __name__ == '__main__':
    (ROOT / 'index.html').write_text(render(json.loads((ROOT / 'catalog.json').read_text())), encoding='utf-8')
