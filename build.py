"""config.json(업체 정보) 하나로 사이트의 모든 페이지를 만드는 스크립트

만드는 것: index.html, services/서비스.html, area/지역.html, privacy.html, sitemap.xml, robots.txt
GitHub Actions 가 1시간마다 update.py 를 돌리고, update.py 가 끝에 이 스크립트를 부름.
"""
import html
import json
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).parent
KST = timezone(timedelta(hours=9))
FONT = '<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">'
LOGO = ('<svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true"><rect x="1" y="1" width="28" height="28" rx="8" fill="var(--water)"/>'
        '<path d="M8 17c2.5 0 3.5-1.5 4.5-4s2-4 4.5-4M13 21c3 0 5-1.5 6-4.5" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round"/>'
        '<circle cx="21.5" cy="9" r="1.8" fill="var(--glove)"/></svg>')
e = lambda s: html.escape(str(s if s is not None else ""), quote=True)


def load():
    return json.loads((ROOT / "config.json").read_text("utf-8"))


def won(x):
    x = int(round(x / 1000.0) * 1000)
    if x >= 10000:
        m = x / 10000
        return (f"{m:.1f}".rstrip("0").rstrip(".")) + "만"
    return f"{x:,}"


def amount(lo, hi=None, per=""):
    """금액 문구: hi 가 없으면 '~부터' 금액"""
    if hi is None:
        return f"{per}{won(lo)}원~"
    return f"{per}{won(lo)}원" if lo == hi else f"{per}{won(lo)}~{won(hi)}원"


def price_from(s):
    """서비스 목록에 보여줄 '최저 기준 금액' 문구"""
    tiers = [t for t in s.get("tiers", []) if not t.get("quote")]
    if tiers:
        t = min(tiers, key=lambda x: x["price"])
        return f"{t['name']} {won(t['price'])}원~", "집 크기별 정액"
    vs = [v for v in s.get("variants", []) if not v.get("quote")]
    if s.get("quote") or not vs:
        return "현장 견적", "사진 확인 후 안내"
    lo = min(v["lo"] for v in vs)
    if s["unit"] == "평":
        return f"평당 {won(lo)}원~", (f"최소 {won(s['min'])}원" if s.get("min") else "")
    return f"{s['unit']}당 {won(lo)}원~", ""


def price_rows(s):
    """서비스 상세 페이지의 가격표"""
    rows = ""
    if s.get("tiers"):
        kinds = s.get("kinds", [])
        rows += "".join(f"<tr><td>{e(t['name'])}<small>{e(t.get('size', ''))}{' · 작업 인원 ' + str(t['crew']) + '명' if t.get('crew') else ''}</small></td>"
                        f"<td>{'현장 견적' if t.get('quote') else won(t['price']) + '원'}</td></tr>" for t in s["tiers"])
        rows += "".join(f"<tr><td colspan=\"2\" class=\"kn\"><b>{e(k['name'])}</b> · {e(k.get('note', ''))}</td></tr>" for k in kinds if k.get("note"))
    else:
        for v in s.get("variants", []):
            val = "현장 견적" if v.get("quote") else amount(v["lo"], v.get("hi"), f"{s['unit']}당 ")
            rows += f"<tr><td>{e(v['name'])}</td><td>{val}</td></tr>"
    for o in s.get("options", []):
        val = "현장 견적" if o.get("quote") else amount(o["lo"], o.get("hi")) + (f" ({s['unit']}당)" if o.get("perUnit") else "")
        rows += f"<tr><td>+ {e(o['name'])}</td><td>{val}</td></tr>"
    if s.get("min"):
        rows += f"<tr><td>최소 금액{('<small>' + e(s['minNote']) + '</small>') if s.get('minNote') else ''}</td><td>{won(s['min'])}원</td></tr>"
    return rows


def blog_list(c):
    v = c.get("blog") or []
    return [x for x in ([v] if isinstance(v, str) else v) if str(x).strip()]


def area_file(r):
    return "area/" + urllib.parse.quote(r) + ".html"


def tel(c):
    return "tel:" + "".join(ch for ch in c.get("phone", "") if ch.isdigit() or ch == "+")


def head(c, title, desc, path, depth=0, ld=None):
    up = "../" * depth
    url = c.get("siteUrl", "").rstrip("/") + "/" + path
    return f"""<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>{e(title)}</title>
<meta name="description" content="{e(desc)}">
<link rel="canonical" href="{e(url)}">
<meta property="og:type" content="website"><meta property="og:title" content="{e(title)}"><meta property="og:description" content="{e(desc)}"><meta property="og:url" content="{e(url)}">
<meta name="theme-color" content="#0B3FA6">
<link rel="icon" href="{up}icon-192.png" type="image/png">
<link rel="apple-touch-icon" href="{up}apple-touch-icon.png">
<link rel="manifest" href="{up}manifest.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="{e(c["name"])}">
<meta property="og:image" content="{e(c.get("siteUrl","").rstrip("/") + "/og.jpg")}"><meta property="og:site_name" content="{e(c["name"])}">
{FONT}
<link rel="stylesheet" href="{up}style.css">
{ld_tags(ld)}{analytics(c)}
</head><body>
{'<div class="sample">샘플 화면이에요 · config.json 에 업체 정보를 넣고 sample 을 false 로 바꾸면 이 줄이 사라져요</div>' if c.get("sample") else ''}
<div class="wrap"><header class="top">
<a class="brand" href="{up}index.html"><img src="{up}icon-192.png" alt="" width="38" height="38" class="logo"><b>{e(c["name"])}</b></a>
<nav aria-label="주요 메뉴"><a href="{up}index.html#quote">견적 계산</a><a href="{up}index.html#services">서비스</a><a href="{up}index.html#cases">시공 사례</a><a href="{up}index.html#member">회원 혜택</a><a href="{up}index.html#faq">자주 묻는 질문</a></nav>
<div class="tools">
<button class="tool" type="button" data-share aria-label="공유하기"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>공유</span></button>
<button class="tool app" type="button" data-install hidden><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="6" y="2.5" width="12" height="19" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v7M9 11l3 3 3-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>앱 설치</span></button>
{f'<a class="call" href="{tel(c)}">{e(c["phone"])}</a>' if c.get("phone") else ''}
</div>
</header></div>"""


def ld_tags(ld):
    """검색엔진용 구조화 데이터(JSON-LD): 구글·네이버가 업체 정보·FAQ를 이해하게 도움"""
    if not ld:
        return ""
    return "".join('<script type="application/ld+json">' + json.dumps(x, ensure_ascii=False).replace("</", "<\\/") + "</script>" for x in ld)


def analytics(c):
    # Pause configured analytics while membership privacy is being reviewed.
    # Keep the implementation below for a separately reviewed reactivation.
    ANALYTICS_PAUSED = True
    if ANALYTICS_PAUSED:
        return ""
    a = c.get("analytics") or {}
    out = ""
    if a.get("ga"):
        g = e(a["ga"])
        out += (f'<script async src="https://www.googletagmanager.com/gtag/js?id={g}"></script>'
                f"<script>window.dataLayer=window.dataLayer||[];function gtag(){{dataLayer.push(arguments)}}gtag('js',new Date());gtag('config','{g}');</script>")
    if a.get("naver"):
        out += (f'<script src="https://wcs.pstatic.net/wcslog.js"></script>'
                f'<script>if(!wcs_add)var wcs_add={{}};wcs_add["wa"]="{e(a["naver"])}";if(window.wcs)wcs_do();</script>')
    return out


def biz_ld(c):
    b = c.get("business") or {}
    base = c.get("siteUrl", "").rstrip("/")
    d = {"@context": "https://schema.org", "@type": "HomeAndConstructionBusiness", "name": c["name"], "url": base + "/",
         "image": base + "/logo.png", "logo": base + "/logo.png", "telephone": c.get("phone", ""),
         "description": f"{', '.join(c.get('regions', []))} 입주청소·거주청소·사무실·준공 청소, 에어컨·세탁기 분해세척",
         "areaServed": c.get("regions", []), "priceRange": "₩₩"}
    if b.get("address"):
        d["address"] = {"@type": "PostalAddress", "streetAddress": b["address"], "addressLocality": "춘천시", "addressRegion": "강원특별자치도", "addressCountry": "KR"}
    same = [f"https://blog.naver.com/{x}" for x in blog_list(c)] + ([c["naverPlace"]] if c.get("naverPlace") else [])
    if same:
        d["sameAs"] = same
    return d


def foot(c, depth=0):
    up = "../" * depth
    b = c.get("business") or {}
    parts = [f"상호 {e(b['company'])}" if b.get("company") else "", f"대표 {e(b['owner'])}" if b.get("owner") else "",
             f"사업자등록번호 {e(b['number'])}" if b.get("number") else "", e(b.get("address", "")),
             f"전화 {e(c['phone'])}" if c.get("phone") else "", e(b.get("email", ""))]
    biz = " · ".join(p for p in parts if p)
    areas = " ".join(f'<a href="{up}{area_file(r)}">{e(r)} 청소</a>' for r in c.get("regions", []))
    kakao = c.get("kakao", "")
    dock_main = (f'<a class="btn glove" href="{e(kakao)}" target="_blank" rel="noopener">카톡으로 상담하기</a>' if kakao
                 else f'<a class="btn glove" href="{up}index.html#quote">견적 계산하기</a>')
    rc = c.get("recruit") or {}
    recruit = (f'<section class="recruit"><div class="wrap"><div><b>{e(rc.get("title", ""))}</b><p>{e(rc.get("text", ""))}</p></div>'
               f'<a class="btn line" href="{e(kakao)}" target="_blank" rel="noopener">{e(rc.get("button", "카톡으로 문의"))}</a></div></section>') if rc and kakao else ""
    return recruit + f"""<footer><div class="wrap">
<div class="foot-tools"><button class="btn line small" type="button" data-share>🔗 이 사이트 공유하기</button><button class="btn line small" type="button" data-install hidden>📲 휴대폰에 앱으로 설치</button></div>
<nav aria-label="지역">{areas}</nav>
<div class="biz"><b>{e(c['name'])}</b>{(' · ' + e(c['hours'])) if c.get('hours') else ''}<br>{biz}</div>
<nav><a href="{up}privacy.html">개인정보처리방침</a>{f'<a href="{e(c["naverPlace"])}" target="_blank" rel="noopener">네이버 플레이스</a>' if c.get("naverPlace") else ''}{''.join(f'<a href="https://blog.naver.com/{e(x)}" target="_blank" rel="noopener">블로그{i + 1 if len(blog_list(c)) > 1 else ""}</a>' for i, x in enumerate(blog_list(c)))}</nav>
<div>© {datetime.now(KST).year} {e(c['name'])}</div>
</div></footer>
<div class="dock"><div class="in">
<a class="btn line" href="{tel(c)}">전화하기</a>{dock_main}
</div></div>
<div class="modal" id="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetT" hidden><div class="modal-box"><button class="x" type="button" data-close aria-label="닫기">×</button><h2 id="sheetT"></h2><div id="sheetB"></div></div></div>
<script>window.SITE={{name:{json.dumps(c["name"], ensure_ascii=False)},url:{json.dumps(c.get("siteUrl", ""))},kakao:{json.dumps(c.get("kakao", ""))},tagline:{json.dumps(c.get("tagline", ""), ensure_ascii=False)},root:{json.dumps(up)}}};</script>
<script src="{up}site.js"></script>"""


def services_html(c, depth=0):
    up = "../" * depth
    cats = c["categories"]
    rows = []
    for s in c["services"]:
        a, b = price_from(s)
        rows.append(f'<li data-cat="{e(s["cat"])}"><a class="row" href="{up}services/{e(s["id"])}.html">'
                    f'<span class="nm">{e(s["name"])}</span><span class="sm">{e(s["summary"])}</span>'
                    f'<span class="pr">{e(a)}<small>{e(b)}</small></span></a></li>')
    chips = '<button class="chip" data-cat="" aria-pressed="true">전체</button>' + "".join(
        f'<button class="chip" data-cat="{e(x["id"])}" aria-pressed="false">{e(x["name"])}</button>' for x in cats)
    return f'<div class="cats" role="group" aria-label="분류">{chips}</div><ul class="svc" id="svcList">{"".join(rows)}</ul>'


def current_faq(c):
    # Keep displayed FAQ and structured data consistent while new membership
    # is suspended; preserve the original text in the configuration.
    return [{**f, "a": "신규 회원가입은 개인정보 처리 절차 확인을 위해 일시 중지 중이에요. 회원 혜택에 관해서는 전화나 카카오톡으로 문의해 주세요."}
            if "회원" in f.get("q", "") or "가입" in f.get("q", "") else f
            for f in c.get("faq", [])]


def faq_html(c):
    return "".join(f'<details><summary>{e(f["q"])}</summary><p>{e(f["a"])}</p></details>' for f in current_faq(c))


def won_text(x):
    return f"{won(x)}원"


def member_badge(c):
    m = c.get("member")
    if not m:
        return ""
    return ('<button class="member-badge" type="button" data-join><b>회원가입 일시 중지</b>'
            '<span>회원 혜택 안내 보기</span></button>')


def member_section(c):
    m = c.get("member")
    if not m:
        return ""
    frees = "".join(f"<li>{e(x)}</li>" for x in m.get("freeServices", []))
    ref = m.get("referral")
    grades = "".join(f'<tr><td><b>{e(g["name"])}</b></td><td>{e(g["rule"])}</td><td>{e(g["perk"])}</td></tr>' for g in m.get("grades", []))
    return f"""<section class="s" id="member"><div class="wrap">
  <h2>회원 혜택</h2>
  <p class="d">회원 혜택을 안내해 드려요. 신규 회원가입은 개인정보 처리 절차 확인을 위해 일시 중지 중이에요.</p>
  <div class="perks">
    <div class="perk"><span class="pk">가입 즉시</span><b>{won_text(m["coupon"])} 할인 쿠폰</b><p>{e(m.get("couponTerms", ""))}</p></div>
    <div class="perk"><span class="pk">가입 즉시</span><b>무료 서비스 1가지</b><ul>{frees}</ul></div>
    <div class="perk"><span class="pk">후기 선물</span><b>{e(m.get("reviewGift", ""))}</b><p>{e(m.get("reviewTerms", ""))}</p>{f'<a class="btn line small" href="{e(c["naverPlace"])}" target="_blank" rel="noopener">네이버 플레이스에 리뷰 남기기</a>' if c.get("naverPlace") else ''}</div>
    {f'<div class="perk"><span class="pk">친구 초대</span><b>{won(ref["point"]).replace("만", "만")}P 적립</b><p>{e(ref.get("text", ""))}</p><button class="btn line small" type="button" data-invite>친구 초대 일시 중지</button></div>' if ref else ''}
  </div>
  <h3 class="sub">등급과 포인트</h3>
  <div class="tbl-wrap"><table class="grade"><thead><tr><th>등급</th><th>조건</th><th>혜택</th></tr></thead><tbody>{grades}</tbody></table></div>
  <p class="note">{e(m.get("pointTerms", ""))}</p>
  <button class="btn glove" type="button" data-join>회원가입 일시 중지 안내</button>
</div></section>"""


def join_modal(c):
    m = c.get("member")
    if not m:
        return ""
    frees = "".join(f'<label class="radio"><input type="radio" name="jFree" value="{e(x)}"{" checked" if i == 0 else ""}><span>{e(x)}</span></label>'
                    for i, x in enumerate(m.get("freeServices", [])))
    regions = "".join(f"<option>{e(r)}</option>" for r in c.get("areaChoices", c.get("regions", [])))
    return f"""<div class="modal" id="join" role="dialog" aria-modal="true" aria-labelledby="joinT" hidden><div class="modal-box">
<button class="x" type="button" data-close aria-label="닫기">×</button>
<div id="joinForm" hidden inert>
  <p class="eyebrow-less">{e(c["name"])} 회원가입</p>
  <h2 id="joinT">지금 가입하면 <em>{won_text(m["coupon"])} 할인</em> + 무료 서비스</h2>
  <p class="ref-b" id="jRef" hidden></p>
  <div class="field"><label for="jName">이름</label><input id="jName" type="text" autocomplete="name" maxlength="20" placeholder="홍길동"></div>
  <div class="field"><label for="jPhone">연락처</label><input id="jPhone" type="tel" inputmode="tel" autocomplete="tel" maxlength="13" placeholder="010-0000-0000"></div>
  <div class="field"><label for="jArea">지역</label><select id="jArea"><option value="">선택</option>{regions}<option>그 외 지역</option></select></div>
  <div class="field"><span class="lab">무료로 받을 서비스 1가지</span>{frees}</div>
  <label class="agree"><input type="checkbox" id="jAgree"><span><b>(필수)</b> 개인정보 수집·이용 동의 · 이름·연락처·지역(추천인 코드)을 회원 관리, 쿠폰·포인트 지급, 예약 상담에만 쓰고 탈퇴 요청 시 지체 없이 파기해요. <a href="privacy.html" target="_blank">자세히</a></span></label>
  <label class="agree"><input type="checkbox" id="jAd"><span>(선택) 할인·이벤트 소식 받기</span></label>
  <p class="err" id="jErr" role="alert"></p>
  <button class="btn glove" type="button" id="jSubmit">가입하고 쿠폰 받기</button>
  <button class="link" type="button" data-later>다음에 할게요</button>
</div>
<div id="joinDone" hidden></div>
</div></div>"""


def diff_html(c):
    """시공 사례 위 '이렇게 달라요' 비교표"""
    d = c.get("diff")
    if not d:
        return ""
    rows = "".join(f'<tr><th scope="row">{e(r["k"])}</th><td>{e(r["a"])}</td><td><b>{e(r["b"])}</b></td></tr>' for r in d["rows"])
    return (f'<div class="diff"><h3>{e(d["title"])}</h3><div class="tbl-wrap"><table>'
            f'<thead><tr><th></th><th>보통 청소</th><th>{e(c["name"])}</th></tr></thead><tbody>{rows}</tbody></table></div></div>')


def promises_section(c, cases):
    ps = c.get("promises") or []
    if not ps:
        return ""
    n = sum(1 for x in cases if x.get("kind", "case") == "case" and safe_case_link(x.get("link")))
    stat = f'<div class="stat"><b>{n}건</b><span>블로그에 공개한 시공 기록</span></div>' if n else ""
    items = "".join(f'<li><b>{e(x["t"])}</b><span>{e(x["d"])}</span></li>' for x in ps)
    return f"""<section class="s trust" id="promise"><div class="wrap">
  <h2>{e(c['name'])}의 약속</h2>
  <p class="d">처음 맡기는 업체라 걱정되시죠. 이렇게 일해요.</p>
  <div class="trust-in">{stat}<ul class="promise">{items}</ul></div>
</div></section>"""


def premium_html(c):
    premium = c.get("premiumCare") or {}
    if not premium:
        return ""
    rows = "".join(f'<tr><th scope="row">{e(x["name"])}</th><td>{x["price"]:,}원~</td></tr>' for x in premium.get("tiers", []))
    return f"""<section class="s" id="premium"><div class="wrap">
      <h2>{e(premium.get('title', '프리미엄 케어'))}</h2>
      <p class="d">{e(premium.get('description', ''))}</p>
      <div class="box"><table class="ptable"><thead><tr><th>공간 기준</th><th>예상 시작 가격</th></tr></thead><tbody>{rows}</tbody></table>
      <p class="d-s">별도 서비스 안내 가격이며, 예약 전 사진 상담으로 확정합니다.</p>
      <a class="btn glove" href="#quote">상담용 견적 문의하기</a></div>
    </div></section>"""


def index_page(c, cases=()):
    regions = c.get("regions", [])
    rg = "·".join(regions[:2]) if regions else ""
    title = f"{c['name']} | {rg} 입주청소·에어컨 청소 견적" if rg else f"{c['name']} | 청소 견적"
    desc = f"{', '.join(regions)} 입주청소, 거주청소, 사무실·준공 청소, 에어컨·세탁기 분해세척. 평수만 넣으면 예상 견적을 바로 볼 수 있어요."
    cfg = json.dumps(c, ensure_ascii=False).replace("</", "<\\/")
    faq_ld = {"@context": "https://schema.org", "@type": "FAQPage",
              "mainEntity": [{"@type": "Question", "name": f["q"], "acceptedAnswer": {"@type": "Answer", "text": f["a"]}} for f in current_faq(c)]}
    return head(c, title, desc, "", 0, [biz_ld(c), faq_ld]) + f"""
<main>
<section class="hero"><div class="wrap hero-in">
  <div>
    <h1>{e(rg + ' 청소, ' if rg else '')}평수만 넣으면 바로 견적이 나와요</h1>
    <p class="lead">{e(c.get('tagline', ''))}. 계산한 견적 그대로 카톡으로 문의하면 돼요.</p>
    {f'<p class="sani-badge">🛡 {e(c["sanitize"]["badge"])}</p>' if c.get("sanitize") else ''}
    <div class="areas">{''.join(f'<span>{e(r)}</span>' for r in regions)}</div>
    {member_badge(c)}
    <img class="hero-logo" src="logo.png" alt="{e(c['name'])} 로고" width="240" height="240">
  </div>
  <div class="calc" id="quote">
    <h2>예상 견적 계산</h2>
    <div class="field"><label for="qSvc">어떤 청소가 필요하세요?</label><select id="qSvc"></select></div>
    <div class="field" id="qVarF"><span class="lab">종류</span><div class="seg" id="qVar" role="group" aria-label="종류"></div></div>
    <div class="field" id="qTierF" hidden><span class="lab">집 크기</span><div class="tiers-pick" id="qTier" role="group" aria-label="집 크기"></div></div>
    <div class="field" id="qQtyF"><label for="qQty" id="qQtyL">평수</label>
      <div class="qty"><button type="button" id="qMinus" aria-label="줄이기">−</button><input id="qQty" type="number" inputmode="numeric" min="1" max="999"><span class="u" id="qUnit">평</span><button type="button" id="qPlus" aria-label="늘리기">+</button></div></div>
    <div class="price" id="qPrice" aria-live="polite"><div class="k" id="qK">예상 금액</div><div class="v" id="qV">-</div><div class="n" id="qN"></div><div class="mem" id="qMem" hidden></div></div>
    <div class="field" id="qOptF"><span class="lab">추가 옵션</span><div class="opts" id="qOpt"></div></div>
    <div class="two">
      <div class="field"><label for="qArea">지역</label><select id="qArea"><option value="">선택</option>{''.join(f'<option>{e(r)}</option>' for r in c.get('areaChoices', regions))}<option>그 외 지역</option></select></div>
      <div class="field"><label for="qDate">희망 날짜</label><input id="qDate" type="date"></div>
    </div>
    <div class="ask">
      <button class="btn glove" id="qKakao" type="button">이 견적으로 카톡 문의</button>
      {'<button class="btn line" id="qSms" type="button">문자로 견적 보내기</button>' if c.get("sms") else ''}
      <button class="link" id="qCopy" type="button">문의 내용만 복사하기</button>
    </div>
  </div>
</div></section>

{promises_section(c, cases)}

<section class="s" id="services"><div class="wrap">
  <h2>하는 일</h2>
  <p class="d">주거부터 상가, 준공 현장, 가전 분해세척까지 맡아요. 항목을 누르면 작업 범위와 가격 기준을 볼 수 있어요.</p>
  {f'<p class="note">{e(c["priceNote"])}</p>' if c.get("priceNote") else ''}
  {services_html(c)}
  {premium_html(c)}
</div></section>

<section class="s" id="cases"><div class="wrap">
  <h2>시공 사례</h2>
  <p class="d">실제 작업한 현장 기록이에요. 블로그에 올린 후기가 자동으로 모여요.</p>
  {diff_html(c)}
  <div id="caseChips" class="cats"></div>
  <div id="caseList" class="cases"></div>
</div></section>

<section class="s" id="tips" hidden><div class="wrap">
  <h2>청소 꿀팁</h2>
  <p class="d">집에서 바로 써먹을 수 있는 청소 정보를 블로그에 정리해 두었어요.</p>
  <ul class="tips" id="tipList"></ul>
</div></section>

{member_section(c)}

<section class="s" id="season"><div class="wrap">
  <h2>달마다 많이 찾는 청소</h2>
  <p class="d">에어컨은 여름 전, 입주청소는 이사철에 예약이 몰려요. 원하는 날짜가 있다면 미리 잡아두세요.</p>
  <div class="months" id="months"></div>
</div></section>

<section class="s"><div class="wrap">
  <h2>진행 순서</h2>
  <p class="d">문의부터 마무리까지 네 단계예요.</p>
  <ol class="steps">
    <li><b>견적 계산·문의</b><span>위 계산기로 예상 금액을 보고 카톡으로 보내주세요.</span></li>
    <li><b>사진 확인·일정 확정</b><span>현장 사진을 보고 최종 금액과 날짜를 정해요.</span></li>
    <li><b>방문 작업</b><span>약속한 날 방문해 작업 범위대로 진행해요.</span></li>
    <li><b>함께 확인</b><span>작업이 끝나면 함께 둘러보고, 아쉬운 곳은 바로 말씀해 주세요.</span></li>
  </ol>
</div></section>

<section class="s faq" id="faq"><div class="wrap">
  <h2>자주 묻는 질문</h2>
  {faq_html(c)}
</div></section>
</main>
{foot(c)}
<script id="cfg" type="application/json">{cfg}</script>
{join_modal(c)}
<script src="app.js"></script>
</body></html>
"""


def safe_case_link(value):
    """수집한 사례 링크는 사용자 정보가 없는 절대 http(s) URL만 허용한다."""
    import re
    if not isinstance(value, str) or not re.match(r"^https?://", value, re.I):
        return False
    if any(ch.isspace() or ord(ch) < 32 or ord(ch) in (127, 0xFEFF) or ch == "\\" for ch in value):
        return False
    authority = re.match(r"^https?://([^/?#]*)", value, re.I).group(1)
    if "%" in authority:
        return False
    try:
        parts = urllib.parse.urlsplit(value)
        if parts.scheme.lower() not in ("http", "https") or not parts.hostname or parts.username is not None or parts.password is not None:
            return False
        _ = parts.port  # 잘못된 포트는 ValueError
        if ":" in parts.hostname:
            import ipaddress
            ipaddress.IPv6Address(parts.hostname)
        else:
            ascii_host = parts.hostname.encode("idna").decode("ascii")
            if not re.fullmatch(r"[a-z0-9.-]+", ascii_host, re.I):
                return False
            if re.fullmatch(r"(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+))*", ascii_host.rstrip("."), re.I) and "x" in ascii_host.lower():
                return False
            if re.search(r"(?:^|\.)\d+$", ascii_host.rstrip(".")):
                import ipaddress
                if parts.hostname.rstrip(".").lower() != ascii_host.rstrip(".").lower():
                    return False
                ipaddress.IPv4Address(ascii_host.rstrip("."))
        return True
    except (ValueError, UnicodeError):
        return False


def service_page(c, s, cases=()):
    a, b = price_from(s)
    regions = c.get("regions", [])
    rg = "·".join(regions[:3])
    title = f"{rg} {s['name']} | {c['name']}" if rg else f"{s['name']} | {c['name']}"
    desc = f"{s['summary']}. 작업 범위: {', '.join(s['includes'])}. {a}"
    rows = "" if s.get("quote") else price_rows(s)
    same = [x for x in c["services"] if x["cat"] == s["cat"] and x["id"] != s["id"]]
    rooms = "".join(f'<div class="room"><b>{e(r["name"])}</b><ul>{"".join(f"<li>{e(i)}</li>" for i in r["items"])}</ul></div>' for r in s.get("rooms", []))
    excl = "".join(f"<li>{e(x)}</li>" for x in s.get("excludes", []))
    mine = [x for x in cases if x.get("svc") == s["id"] and x.get("kind", "case") == "case" and safe_case_link(x.get("link"))][:4]
    kakao = c.get("kakao", "")
    base = c.get("siteUrl", "").rstrip("/")
    ld = {"@context": "https://schema.org", "@type": "Service", "name": s["name"], "description": s["summary"], "serviceType": s["name"],
          "areaServed": regions, "url": f"{base}/services/{s['id']}.html",
          "provider": {"@type": "HomeAndConstructionBusiness", "name": c["name"], "telephone": c.get("phone", ""), "url": base + "/"}}
    prices = [t["price"] for t in s.get("tiers", []) if not t.get("quote")] or [v["lo"] for v in s.get("variants", []) if not v.get("quote")]
    if not s.get("quote") and prices:
        ld["offers"] = {"@type": "AggregateOffer", "priceCurrency": "KRW", "lowPrice": min(prices)}
    return head(c, title, desc, f"services/{s['id']}.html", 1, [ld]) + f"""
<main class="wrap page">
<div class="crumb"><a href="../index.html">홈</a> › <a href="../index.html#services">서비스</a></div>
<h1>{e(s['name'])}</h1>
<p class="lead" style="color:var(--muted);font-size:17px;margin:0">{e(s['summary'])}</p>
<div class="box"><h2>작업 범위</h2>{f'<p class="sani-line">🛡 <b>{e(c["sanitize"]["badge"])}</b> · {e(c["sanitize"]["text"])}</p>' if c.get("sanitize") else ''}<ul>{''.join(f'<li>{e(i)}</li>' for i in s['includes'])}</ul>{f'<div class="rooms">{rooms}</div>' if rooms else ''}</div>
{f'<div class="box"><h2>기본 범위에 없는 것</h2><p class="d-s">아래는 기본 금액에 들어가지 않아요. 필요하시면 상담 때 말씀해 주세요. 추가 비용은 작업 전에 먼저 안내해 드려요.</p><ul class="excl">{excl}</ul></div>' if excl else ''}
<div class="box"><h2>가격 기준</h2>{f'<table class="ptable">{rows}</table><p style="font-size:13.5px;color:var(--muted);margin:10px 0 0">{e(s.get("priceNote") or "오염 정도와 구조에 따라 현장에서 달라질 수 있어요.")} 최종 금액은 사진을 보고 확정해요.</p>' if rows else f'<p style="margin:0">현장 상태에 따라 작업량 차이가 커서, 사진을 보고 견적을 안내해 드려요. {e(s.get("priceNote", ""))}</p>'}</div>
<div class="cta2"><a class="btn glove" href="../index.html?svc={e(s['id'])}#quote">{'내 견적 계산하기' if not s.get('quote') else '사진 보내고 견적 받기'}</a>{f'<a class="btn line" href="{e(kakao)}" target="_blank" rel="noopener">카톡으로 바로 문의</a>' if kakao else ''}</div>
{f'<div class="box"><h2>최근 {e(s["name"])} 사례</h2><div class="cases">{"".join(case_card(x) for x in mine)}</div></div>' if mine else ''}
{f'<div class="box"><h2>서비스 지역</h2><div class="links">' + ''.join(f'<a href="../{area_file(r)}">{e(r)} {e(s["name"])}</a>' for r in regions) + '</div></div>' if regions else ''}
{f'<div class="box"><h2>같이 많이 찾는 청소</h2><div class="links">' + ''.join(f'<a href="{e(x["id"])}.html">{e(x["name"])}</a>' for x in same) + '</div></div>' if same else ''}
</main>
{foot(c, 1)}
</body></html>
"""


def naver_imgs(src):
    """네이버 블로그 사진 주소 → (큰 사진 주소, 실패 시 쓸 주소)"""
    import re as _re
    if "pstatic.net" not in src:
        return src, src
    base = _re.sub(r"\?.*$", "", src)
    big = base.replace("://blogthumb.pstatic.net", "://mblogthumb-phinf.pstatic.net").replace("://postfiles.pstatic.net", "://mblogthumb-phinf.pstatic.net") + "?type=w800"
    return big, base + "?type=s3"


IMG_ERR = "if(!this.dataset.f){this.dataset.f=1;this.src=this.dataset.alt}else{this.replaceWith(Object.assign(document.createElement('div'),{className:'ph'}))}"


def case_card(x):
    big, alt = naver_imgs(x.get("img") or "")
    img = (f'<img class="ph" src="{e(big)}" data-alt="{e(alt)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="{IMG_ERR}">' if x.get("img")
           else '<div class="ph"></div>')
    return (f'<a class="case" href="{e(x["link"])}" target="_blank" rel="noopener">{img}'
            f'<div class="tx"><div class="tt">{e(x["title"])}</div></div></a>')


def area_page(c, r, cases):
    title = f"{r} 입주청소·에어컨 청소 | {c['name']}"
    desc = f"{r} 지역 입주청소, 거주청소, 사무실·준공 청소, 에어컨·세탁기 분해세척을 {c['name']}에서 맡아요. 평수만 넣으면 예상 견적을 볼 수 있어요."
    mine = [x for x in cases if x.get("region") == r and x.get("kind", "case") == "case" and safe_case_link(x.get("link"))][:8]
    case_html = "".join(case_card(x) for x in mine)
    return head(c, title, desc, area_file(r), 1) + f"""
<main class="wrap page">
<div class="crumb"><a href="../index.html">홈</a> › 지역</div>
<h1>{e(r)} 청소, {e(c['name'])}이 맡아요</h1>
<p class="lead" style="color:var(--muted);font-size:17px;margin:0">{e(r)} 어디든 방문해요. 서비스를 고르면 작업 범위와 가격 기준을 볼 수 있어요.</p>
<div class="box">{services_html(c, 1)}</div>
<a class="btn glove" href="../index.html?area={e(urllib.parse.quote(r, safe=''))}#quote">{e(r)} 견적 계산하기</a>
{f'<div class="box"><h2>{e(r)} 시공 사례</h2><div class="cases">{case_html}</div></div>' if case_html else ''}
<div class="box"><h2>다른 지역</h2><div class="links">{''.join(f'<a href="{urllib.parse.quote(x)}.html">{e(x)}</a>' for x in c.get('regions', []) if x != r)}</div></div>
</main>
{foot(c, 1)}
<script>document.querySelectorAll('.cats .chip').forEach(b=>b.onclick=()=>{{document.querySelectorAll('.cats .chip').forEach(x=>x.setAttribute('aria-pressed',x===b));document.querySelectorAll('#svcList li').forEach(li=>li.hidden=b.dataset.cat&&li.dataset.cat!==b.dataset.cat);}});</script>
</body></html>
"""


def privacy_page(c):
    b = c.get("business") or {}
    who = b.get("company") or c["name"]
    delete_notice = ""
    if c.get("member"):
        delete_notice = "<p>회원가입 일시중지 안내 화면의 '이 기기에 저장된 회원정보 직접 지우기'를 통해 이 브라우저의 회원정보와 쿠폰번호를 직접 지울 수 있습니다. 클립보드, 카카오톡 대화와 이미 접수된 서버 정보는 이 기능으로 삭제되지 않습니다.</p>\n"
    return head(c, f"개인정보처리방침 | {c['name']}", "개인정보처리방침", "privacy.html") + f"""
<main class="wrap page">
<h1>개인정보처리방침</h1>
<p role="note" data-privacy-draft><b>개정 검토안 · 시행 전</b><br>무응답 상담 30일 임시 종결과 일반 상담정보 종료 후 90일 보유 원칙은 운영자 승인 완료입니다. 실제 파기 절차·법적 보존 대상·외부 처리 현황과 시행일은 미확정이므로 실제 게시·운영 배포용 최종 처리방침으로 승인되지 않았습니다.</p>
<p data-privacy-effective-date><b>제안 시행일: 2026-11-01 · 실제 시행일: 미확정</b><br>필수 고지와 실제 운영 조건을 확인하기 전에는 이 개정안을 시행 중인 방침으로 적용하지 않습니다. 제안일 도래만으로 시행·자동 삭제·배포가 시작되지 않습니다.</p>
<div class="box">
<h2>1. 수집하는 항목과 목적</h2>
<p>{e(who)}(이하 '업체')의 운영자 확인 기준 실제 고객 회원가입은 없습니다. 회원 기능의 입력 항목은 이름, 연락처, 지역, 선택한 무료 서비스, 추천인 코드, 이벤트 수신 동의 여부이며, 현재 홈페이지의 신규 회원가입 접수는 일시 중지 중입니다. 실제 고객 회원자료가 보관 중인 것으로 안내하지 않습니다.</p>
<p>청소 견적 상담, 서비스 문의, 상담 후 연락 및 일정 협의를 위해 상담에 필요한 <b>이름, 연락처, 청소 장소, 현장 사진, 기타 요청사항, 청소 희망일</b>을 선택적으로 처리할 수 있습니다. 모든 상담에서 모든 항목을 받는 것은 아닙니다.</p>
<h2>2. 수집 방법</h2>
<p>이전에 가입한 회원정보와 쿠폰번호가 이 브라우저에 남아 있을 수 있습니다. 견적 계산기에 입력한 내용도 이 브라우저에 저장될 수 있습니다. 이 화면에서 신규 회원가입 접수를 중지합니다. 현재 홈페이지에서는 신규 예약 접수 기능을 제공하지 않으며, 전화·카카오톡 상담은 가능합니다. 이전에 열린 화면과 이미 접수된 정보는 별도 확인이 필요합니다. 기존 회원정보의 조회·수정 기능도 일시 중지 중입니다.</p>
<p>상담은 전화·문자·카카오톡 오픈채팅을 통해 이루어질 수 있습니다. 상담 관련 정보는 카카오톡 대화와 전화·문자 내역에 남을 수 있으며, 다른 보관 장소와 백업 이용 여부는 확인이 필요합니다.</p>
<p>운영자 확인 기준 상담자료는 운영자 본인만 열람하며, 현장 사진은 휴대폰 갤러리·PC에 별도로 저장합니다. 업무폰에는 지문·비밀번호 잠금을 사용합니다. 이는 확인된 접근 보호조치이며 PC의 보호 설정이나 모든 저장소의 접근 제한까지 검증했다는 뜻은 아닙니다.</p>
<p>견적 내용은 상담을 위해 이용자가 직접 클립보드나 카카오톡 등으로 공유할 수 있습니다. 브라우저 자동완성, 클립보드, 카카오톡 대화와 이미 접수된 정보는 서로 별도로 관리됩니다. 기존 정보의 열람·수정·삭제는 아래 연락처로 요청해 주세요.</p>
{delete_notice}<h2>3. 보관 기간과 파기</h2>
<p>운영자 확인 기준 실제 고객 회원가입과 실제 청소 계약·결제는 없습니다. 따라서 실제 고객 회원자료나 청소 계약·결제 자료를 현재 보존 중인 것으로 안내하지 않습니다. 이 확인을 모든 상담·시험 자료·기기 사본·다른 저장소의 부재로 확대하지 않습니다. 자동 삭제가 이루어진다고 안내할 수 없으며, 정보의 보관·삭제에 관한 문의는 아래 연락처로 해 주세요.</p>
<p><b>승인된 정책 원칙 · 실제 시행 전</b>: 일반 상담정보는 재견적, 일정 재협의, 상담 후속 대응을 목적으로 상담 종료 후 90일 보유하는 원칙을 운영자가 승인했습니다. 법적 보존 의무와 실제 삭제 가능 범위 등 시행 조건은 확인이 필요하며, 원칙 승인만으로 현재 시행 중인 보유·파기 정책으로 안내하지 않습니다.</p>
<p><b>90일은 법정 의무기간이 아닙니다.</b> 30일·90일은 사업자 운영 기준입니다. 이 원칙 승인은 필요한 처리 근거 확인을 대체하거나 기존 정보의 보유기간 연장 근거가 되지 않습니다. 기존 회원정보, 법적 보존 의무가 적용되는 계약·결제·분쟁 자료, 실제 보관 위치나 처리 목적이 확인되지 않은 자료에는 90일 기준을 일괄 적용하지 않습니다. 시행 전 필요한 항목과 적법한 처리 근거를 확인해야 합니다.</p>
<p>고객이 종료 의사를 밝히거나 견적 안내 및 일정 협의가 완료되어 추가 연락이 필요하지 않으면 상담을 종료할 수 있습니다. 무응답 상담은 마지막 회신 요청 후 30일이 지나면 임시 종결하고, 재문의가 발생하면 새로운 상담으로 관리합니다. 최종 연락일·마지막 회신 요청일과 실제 상담 종료일은 구분해 기록하며, 재문의만으로 기존 자료의 보유기간을 자동 연장하지 않습니다. 이 종료 기준도 승인된 원칙이며 실제 시행은 앞서 안내한 운영 조건 확인 후 확정합니다.</p>
<p>계약·결제·분쟁 관련 보존 자료는 일반 상담자료와 구분하여 적용 법령과 필요한 항목·기간을 확인합니다. 상담이 계약으로 전환됐다는 이유만으로 현장 사진이나 대화 전체를 같은 기간 보관하는 것으로 정하지 않습니다. 삭제 요청은 90일 경과를 기다리는 절차가 아니며, 요청 시 보존 의무와 삭제 가능한 범위를 별도로 검토합니다.</p>
<p>시행 후 보유기간이 만료되면 사업자가 통제할 수 있는 자료를 적법한 절차에 따라 파기하는 원칙입니다. 카카오톡·문자·사진 등 관리 가능한 자료와 상대방·서비스 제공자가 별도로 보유하는 사본을 구분합니다. 현재 실제 업무폰·PC, 연결 기기·휴지통·클라우드 백업과 복원 가능성에 대한 실기기 파기 시험은 미완료입니다. 이 개정은 실제 고객정보 삭제나 자동 삭제 기능 활성화를 포함하지 않습니다.</p>
<p>파기 절차는 본인 확인과 법적 보존 대상 검토 후 사업자가 관리하는 각 보관 위치에서 복구가 어렵도록 삭제 가능한 방법과 범위를 확인하는 방식으로 준비 중입니다. 카카오톡 대화·문자·전화 기록과 별도로 저장한 사진, 다른 기기 및 백업은 각각 보관 위치와 삭제 가능 범위를 확인해야 합니다. 다른 사람의 사본이나 서비스 제공자의 보관분까지 삭제 완료되었다고 보장하지 않습니다.</p>
<p>실제 고객 회원가입이 없다는 확인과 기기에 남아 있을 수 있는 시험 입력값은 구분합니다. 별도 자료가 확인되는 경우 그 목적·보존 의무·파기 기준을 확인하며 일반 상담정보 90일을 일괄 적용하지 않습니다. 이번 개정으로 기존 회원정보를 임의 삭제하거나 자동 삭제하지 않습니다. 미확정 상태 자체가 무기한 보관의 근거는 아니며, 열람·정정·삭제 등 요청은 아래 담당자가 접수합니다.</p>
<p>현재 확인된 삭제 방법은 휴대폰에서 수동 삭제하는 방식입니다. PC 저장 사진·휴지통·연결 기기·백업의 삭제 범위와 복원 가능성은 미확인입니다. 휴대폰에서 삭제했다는 사실만으로 다른 사본까지 삭제되거나 복구 불가능한 파기가 완료된 것으로 안내하지 않습니다.</p>
<p><b>파기 운영 절차안 · 실행 전 확정 필요</b>: 담당자가 보관 위치별 대상과 사본을 목록화하고, 목적 달성 여부·보존 의무·삭제 권한을 확인한 뒤 승인된 대상만 처리합니다. 법령에 따라 보존하는 자료는 해당 근거·항목·기간을 기록하고 일반 상담자료와 분리하여 관리하는 절차를 확정해야 합니다.</p>
<ul>
<li><b>문자·전화 내역</b>: 업체가 관리하는 단말·연동 기기와 앱의 내역, 첨부파일, 휴지통을 각각 확인합니다. 승인 후 삭제·휴지통 비우기 및 동기화 사본 확인이 가능한지 합성 자료로 시험합니다. 통신사 보관분은 업체 단말 삭제와 별개입니다.</li>
<li><b>카카오톡 오픈채팅</b>: 업체 계정의 대화·첨부파일·다운로드 사본과 연결 기기를 구분합니다. 대화방 나가기만으로 모든 사본이 파기됐다고 판단하지 않으며, 해당 서비스에서 지원하는 삭제 범위와 제한을 확인합니다. 상대방 사본·서비스 제공자 보관분의 삭제를 보장하지 않습니다.</li>
<li><b>현장 사진·전자파일</b>: 사진첩·다운로드·문서·동기화 저장소·휴지통의 사본을 구분합니다. 단순 파일 삭제만으로 복구 불가능한 파기를 완료했다고 판단하지 않습니다. 저장매체에 맞는 복구·재생 방지 삭제 기능을 합성 자료로 검증하고, 지원하지 않으면 적합한 파기 방법을 확정하기 전 완료 처리하지 않습니다.</li>
<li><b>백업</b>: 사용 여부·보관 위치·접근권한·보존 주기와 개별 삭제 가능 여부를 먼저 확인합니다. 개별 삭제가 불가능한 경우 접근 제한, 확정된 만료·덮어쓰기 일정, 복원 시 삭제 대상 재반영 절차를 검토하되 이를 즉시 파기 완료로 표시하지 않습니다. 타인 정보가 포함된 백업을 임의로 일괄 삭제하지 않습니다.</li>
</ul>
<p>실행 후에는 대상의 보관 위치·처리일·처리 방법·담당자·잔존 사본 및 제한 사유를 필요한 최소 범위로 기록하고 재확인하는 절차를 확정해야 합니다. 위 절차는 도입 전 검토안이며, 현재 실행·삭제 완료 또는 복구 불가능성을 보증하는 안내가 아닙니다.</p>
<h2>4. 제3자 제공</h2>
<p>기존에 접수된 정보의 외부 처리·제3자 제공·처리 위탁 및 국외 이전 해당 여부는 확인 중입니다. 카카오 오픈채팅을 통해 이용자가 직접 공유한 내용은 해당 서비스에서도 처리될 수 있습니다.</p>
<p>제3자 제공과 처리 위탁은 실제 정보 흐름, 처리 목적 및 계약상 역할에 따라 구분해야 합니다. 카카오톡·문자 서비스를 이용한다는 사실만으로 모두 위탁이거나 제3자 제공이 없다고 판단하지 않습니다. 다른 서버·외부 저장 서비스의 운영 여부도 미확정입니다. 해당하는 경우 수령자·수탁자, 목적·업무, 항목·기간 등 필수 고지와 국외 이전 여부를 실제 확인한 후 기재해야 합니다. 단순히 '확인 중'이라고 기재한 상태는 필수 고지 완료가 아닙니다.</p>
<p>홈페이지의 카카오 상담은 오픈채팅 링크로 이동한 뒤 이용자가 상담 내용을 선택하여 보내는 방식입니다. 카카오는 메시지 전송 등 자체 서비스 운영을 위해 정보를 처리하며 <a href="https://www.kakao.com/policy/privacy" target="_blank" rel="noopener">카카오 개인정보 처리방침</a>이 적용됩니다. 카카오 자체 처리와 업체가 보관·이용하는 상담자료는 구분됩니다. 카카오의 자체 위탁·국외 이전 안내를 그대로 업체의 위탁·이전 현황으로 간주하지 않습니다.</p>
<h2>5. 이용자의 권리</h2>
<p>정보주체와 법정대리인은 아래 담당 연락처로 개인정보 열람·정정·삭제·처리정지·동의 철회 및 이벤트 수신 거부를 요청할 수 있습니다. 대리인을 통한 요청은 대리권 확인이 필요할 수 있습니다. 홈페이지 회원 조회·수정이 중지된 동안에도 전화로 요청을 접수합니다.</p>
<p>담당자는 요청 내용과 본인·대리인 여부를 필요한 최소 범위로 확인하고, 적용 법령에 따른 처리 결과를 안내합니다. 법령상 보존 의무 등으로 요청을 제한해야 하는 경우에는 그 사유와 가능한 처리 범위를 안내해야 합니다. 이 절차안은 모든 자료의 즉시 삭제를 약속하지 않습니다.</p>
<p>정정·삭제 요구에 대해서는 지체 없이 조사·조치하고, 개인정보 보호법 시행령 제43조에 따라 요구받은 날부터 10일 이내에 조치 사실 또는 삭제 제한 사실·이유·이의제기방법을 통지하는 절차를 준비합니다. 접수일·요청 범위·확인 결과·처리 및 통지 결과를 최소한으로 기록하며, 본인 확인이 끝나지 않았거나 삭제에 실패한 대상을 완료로 안내하지 않습니다.</p>
<h2>6. 문의</h2>
<p>개인정보 문의 및 열람·정정·삭제 요청 접수처: 오케이청소 개인정보 담당자 · <a href="tel:0339114457">033-911-4457</a></p>
<p>담당 부서: 오케이청소 개인정보 담당자. 위 번호로 열람·정정·삭제 요청을 실제 접수·처리할 수 있음을 운영자가 확인했습니다.</p>
<p>{e(who)} · 대표 {e(b.get('owner', ''))} · {e(c.get('phone', ''))} {e(b.get('email', ''))}</p>
<p style="color:var(--muted);font-size:14px">현재 사이트 방문 통계 스크립트의 자동 수집은 일시 중지 중입니다.</p>
</div>
</main>
{foot(c)}
</body></html>
"""


def write(path, text):
    p = ROOT / path
    p.parent.mkdir(parents=True, exist_ok=True)
    if not p.exists() or p.read_text("utf-8") != text:
        p.write_text(text, "utf-8")
        return True
    return False


def run():
    c = load()
    cases = []
    if (ROOT / "cases.json").exists():
        try:
            cases = json.loads((ROOT / "cases.json").read_text("utf-8")).get("cases", [])
        except ValueError:
            cases = []
    changed = []
    files = {"index.html": index_page(c, cases), "privacy.html": privacy_page(c)}
    for s in c["services"]:
        files[f"services/{s['id']}.html"] = service_page(c, s, cases)
    for r in c.get("regions", []):
        files[f"area/{r}.html"] = area_page(c, r, cases)
    files["manifest.webmanifest"] = json.dumps({
        "name": c["name"], "short_name": c["name"], "description": c.get("tagline", ""), "lang": "ko",
        "id": "./", "start_url": "./?src=app", "scope": "./", "display": "standalone", "background_color": "#F4F7FC", "theme_color": "#0B3FA6",
        "icons": [{"src": "icon-192.png", "sizes": "192x192", "type": "image/png"},
                  {"src": "logo.png", "sizes": "512x512", "type": "image/png", "purpose": "any"}]}, ensure_ascii=False, indent=1)
    base = c.get("siteUrl", "").rstrip("/") + "/"
    urls = [""] + [f"services/{s['id']}.html" for s in c["services"]] + [area_file(r) for r in c.get("regions", [])]
    files["sitemap.xml"] = ('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
                            + "".join(f"<url><loc>{e(base + u)}</loc></url>\n" for u in urls) + "</urlset>\n")
    files["robots.txt"] = f"User-agent: *\nAllow: /\nSitemap: {base}sitemap.xml\n"
    for path, text in files.items():
        if write(path, text):
            changed.append(path)
    # 설정에서 지운 지역 페이지는 정리
    keep = {f"{r}.html" for r in c.get("regions", [])}
    for f in (ROOT / "area").glob("*.html"):
        if f.name not in keep:
            f.unlink()
            changed.append(f"area/{f.name} (삭제)")
    keep_s = {f"{s['id']}.html" for s in c["services"]}
    for f in (ROOT / "services").glob("*.html"):
        if f.name not in keep_s:
            f.unlink()
            changed.append(f"services/{f.name} (삭제)")
    if (ROOT / "favicon.svg").exists():
        (ROOT / "favicon.svg").unlink()
    print("페이지 생성:", ", ".join(changed) if changed else "변경 없음")


if __name__ == "__main__":
    run()
