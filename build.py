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


def faq_html(c):
    return "".join(f'<details><summary>{e(f["q"])}</summary><p>{e(f["a"])}</p></details>' for f in c.get("faq", []))


def won_text(x):
    return f"{won(x)}원"


def member_badge(c):
    m = c.get("member")
    if not m:
        return ""
    return (f'<button class="member-badge" type="button" data-join><b>회원가입하면 {won_text(m["coupon"])} 할인</b>'
            f'<span>+ 무료 서비스 1가지 · 30초 가입</span></button>')


def member_section(c):
    m = c.get("member")
    if not m:
        return ""
    frees = "".join(f"<li>{e(x)}</li>" for x in m.get("freeServices", []))
    ref = m.get("referral")
    grades = "".join(f'<tr><td><b>{e(g["name"])}</b></td><td>{e(g["rule"])}</td><td>{e(g["perk"])}</td></tr>' for g in m.get("grades", []))
    return f"""<section class="s" id="member"><div class="wrap">
  <h2>회원 혜택</h2>
  <p class="d">가입하는 순간 쓸 수 있는 쿠폰부터, 이용할수록 쌓이는 포인트까지 준비했어요.</p>
  <div class="perks">
    <div class="perk"><span class="pk">가입 즉시</span><b>{won_text(m["coupon"])} 할인 쿠폰</b><p>{e(m.get("couponTerms", ""))}</p></div>
    <div class="perk"><span class="pk">가입 즉시</span><b>무료 서비스 1가지</b><ul>{frees}</ul></div>
    <div class="perk"><span class="pk">후기 선물</span><b>{e(m.get("reviewGift", ""))}</b><p>{e(m.get("reviewTerms", ""))}</p>{f'<a class="btn line small" href="{e(c["naverPlace"])}" target="_blank" rel="noopener">네이버 플레이스에 리뷰 남기기</a>' if c.get("naverPlace") else ''}</div>
    {f'<div class="perk"><span class="pk">친구 초대</span><b>{won(ref["point"]).replace("만", "만")}P 적립</b><p>{e(ref.get("text", ""))}</p><button class="btn line small" type="button" data-invite>내 초대 링크 보내기</button></div>' if ref else ''}
  </div>
  <h3 class="sub">등급과 포인트</h3>
  <div class="tbl-wrap"><table class="grade"><thead><tr><th>등급</th><th>조건</th><th>혜택</th></tr></thead><tbody>{grades}</tbody></table></div>
  <p class="note">{e(m.get("pointTerms", ""))}</p>
  <button class="btn glove" type="button" data-join>회원가입하고 쿠폰 받기</button>
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
<div id="joinForm">
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
              "mainEntity": [{"@type": "Question", "name": f["q"], "acceptedAnswer": {"@type": "Answer", "text": f["a"]}} for f in c.get("faq", [])]}
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
    member_enabled = bool(c.get("member"))
    firebase = c.get("firebase")
    firebase_used = member_enabled and isinstance(firebase, dict) and bool(firebase.get("apiKey") and firebase.get("projectId"))
    backend = c.get("memberBackendUrl")
    script_used = member_enabled and isinstance(backend, str) and backend.startswith("https://script.google.com/macros/s/")
    remote_notice = ""
    if firebase_used:
        remote_notice += "<p>회원가입 버튼을 누르면 가입 정보를 Google Firebase의 Cloud Firestore로 전송하려고 합니다. 연결 오류 등으로 전송되지 않을 수도 있습니다.</p>\n"
    if script_used:
        remote_notice += "<p>설정된 Google Apps Script 연동 주소로도 가입 정보를 전송하려고 합니다. 전송 성공 여부는 카카오톡 상담으로 확인해 주세요.</p>\n"
    if not firebase_used and not script_used:
        remote_notice = "<p>회원가입 정보의 자동 전송은 설정되어 있지 않습니다.</p>\n"
    delete_notice = ""
    if member_enabled:
        delete_notice = "<p>회원가입 완료 화면의 '이 기기의 회원정보 지우기'에서 확인을 거쳐 이 브라우저에 저장된 회원정보와 쿠폰번호를 지울 수 있습니다. 다른 열린 탭은 먼저 닫아 주세요. 브라우저 자동완성, 클립보드, 카카오톡 대화와 관리자에게 전송 중이거나 이미 접수된 정보는 이 기능으로 삭제되지 않습니다. 서버에 접수된 정보의 삭제는 아래 연락처로 요청해 주세요.</p>\n"
    return head(c, f"개인정보처리방침 | {c['name']}", "개인정보처리방침", "privacy.html") + f"""
<main class="wrap page">
<h1>개인정보처리방침</h1>
<div class="box">
<h2>1. 수집하는 항목과 목적</h2>
<p>{e(who)}(이하 '업체')는 회원가입 시 <b>이름, 연락처, 지역, 선택한 무료 서비스, 추천인 코드(초대 링크로 가입한 경우), 이벤트 수신 동의 여부</b>를 받아요. 회원 관리, 쿠폰·포인트 지급, 예약 상담과 작업 진행에만 써요.</p>
<h2>2. 수집 방법</h2>
<p>가입 정보와 쿠폰번호는 이 브라우저에 저장될 수 있습니다. 견적 계산기에 입력한 내용도 이 브라우저에 저장될 수 있습니다.</p>
{remote_notice}<p>카카오톡 가입 버튼을 누르면 가입 내용이 클립보드에 복사될 수 있으며, 이용자가 직접 붙여넣어 전송할 수 있습니다. 견적 내용도 이용자가 상담을 위해 직접 공유할 수 있습니다.</p>
{delete_notice}<h2>3. 보관 기간과 파기</h2>
<p>회원 정보는 탈퇴 요청 시 또는 마지막 이용 후 2년이 지나면 지체 없이 파기해요. 관리자 대장에 저장된 회원정보도 동일한 기준으로 삭제합니다. 법령에 따라 보관해야 하는 거래 기록은 정해진 기간 동안 보관해요.</p>
<h2>4. 제3자 제공</h2>
<p>이용자의 동의 없이 개인정보를 외부에 판매하거나 제3자에게 제공하지 않아요. 연동 설정에 따라 Google 서비스를 저장·처리 수단으로 이용할 수 있습니다.</p>
<h2>5. 이용자의 권리</h2>
<p>언제든지 개인정보 열람·수정·삭제와 이벤트 수신 거부를 요청할 수 있어요. 아래 연락처로 말씀해 주세요.</p>
<h2>6. 문의</h2>
<p>{e(who)} · 대표 {e(b.get('owner', ''))} · {e(c.get('phone', ''))} {e(b.get('email', ''))}</p>
<p style="color:var(--muted);font-size:14px">사이트 이용 통계를 위해 방문 기록(접속 기기, 방문 페이지 등)이 익명으로 수집될 수 있어요.</p>
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
