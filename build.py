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


def price_from(s):
    """서비스 목록에 보여줄 '최저 기준 금액' 문구"""
    if s.get("quote") or not s.get("variants"):
        return "현장 견적", "사진 확인 후 안내"
    lo = min(v["lo"] for v in s["variants"])
    if s["unit"] == "평":
        return f"평당 {won(lo)}원~", (f"최소 {won(s['min'])}원" if s.get("min") else "")
    return f"{s['unit']}당 {won(lo)}원~", ""


def area_file(r):
    return "area/" + urllib.parse.quote(r) + ".html"


def tel(c):
    return "tel:" + "".join(ch for ch in c.get("phone", "") if ch.isdigit() or ch == "+")


def head(c, title, desc, path, depth=0):
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
<meta property="og:image" content="{e(c.get("siteUrl","").rstrip("/") + "/og.jpg")}"><meta property="og:site_name" content="{e(c["name"])}">
{FONT}
<link rel="stylesheet" href="{up}style.css">
</head><body>
{'<div class="sample">샘플 화면이에요 · config.json 에 업체 정보를 넣고 sample 을 false 로 바꾸면 이 줄이 사라져요</div>' if c.get("sample") else ''}
<div class="wrap"><header class="top">
<a class="brand" href="{up}index.html"><img src="{up}icon-192.png" alt="" width="38" height="38" class="logo"><b>{e(c["name"])}</b></a>
<nav aria-label="주요 메뉴"><a href="{up}index.html#quote">견적 계산</a><a href="{up}index.html#services">서비스</a><a href="{up}index.html#cases">시공 사례</a><a href="{up}index.html#faq">자주 묻는 질문</a></nav>
{f'<a class="call" href="{tel(c)}">{e(c["phone"])}</a>' if c.get("phone") else ''}
</header></div>"""


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
    return f"""<footer><div class="wrap">
<nav aria-label="지역">{areas}</nav>
<div class="biz"><b>{e(c['name'])}</b>{(' · ' + e(c['hours'])) if c.get('hours') else ''}<br>{biz}</div>
<nav><a href="{up}privacy.html">개인정보처리방침</a>{f'<a href="https://blog.naver.com/{e(c["blog"])}" target="_blank" rel="noopener">블로그</a>' if c.get("blog") else ''}</nav>
<div>© {datetime.now(KST).year} {e(c['name'])}</div>
</div></footer>
<div class="dock"><div class="in">
<a class="btn line" href="{tel(c)}">전화하기</a>{dock_main}
</div></div>"""


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


def index_page(c):
    regions = c.get("regions", [])
    rg = "·".join(regions[:2]) if regions else ""
    title = f"{c['name']} | {rg} 입주청소·에어컨 청소 견적" if rg else f"{c['name']} | 청소 견적"
    desc = f"{', '.join(regions)} 입주청소, 거주청소, 사무실·준공 청소, 에어컨·세탁기 분해세척. 평수만 넣으면 예상 견적을 바로 볼 수 있어요."
    cfg = json.dumps(c, ensure_ascii=False).replace("</", "<\\/")
    return head(c, title, desc, "") + f"""
<main>
<section class="hero"><div class="wrap hero-in">
  <div>
    <h1>{e(rg + ' 청소, ' if rg else '')}평수만 넣으면 바로 견적이 나와요</h1>
    <p class="lead">{e(c.get('tagline', ''))}. 계산한 견적 그대로 카톡이나 문자로 문의하면 돼요.</p>
    <div class="areas">{''.join(f'<span>{e(r)}</span>' for r in regions)}</div>
    <img class="hero-logo" src="logo.png" alt="{e(c['name'])} 로고" width="240" height="240">
  </div>
  <div class="calc" id="quote">
    <h2>예상 견적 계산</h2>
    <div class="field"><label for="qSvc">어떤 청소가 필요하세요?</label><select id="qSvc"></select></div>
    <div class="field" id="qVarF"><span class="lab">종류</span><div class="seg" id="qVar" role="group" aria-label="종류"></div></div>
    <div class="field" id="qQtyF"><label for="qQty" id="qQtyL">평수</label>
      <div class="qty"><button type="button" id="qMinus" aria-label="줄이기">−</button><input id="qQty" type="number" inputmode="numeric" min="1" max="999"><span class="u" id="qUnit">평</span><button type="button" id="qPlus" aria-label="늘리기">+</button></div></div>
    <div class="price" id="qPrice" aria-live="polite"><div class="k" id="qK">예상 금액</div><div class="v" id="qV">-</div><div class="n" id="qN"></div></div>
    <div class="field" id="qOptF"><span class="lab">추가 옵션</span><div class="opts" id="qOpt"></div></div>
    <div class="two">
      <div class="field"><label for="qArea">지역</label><select id="qArea"><option value="">선택</option>{''.join(f'<option>{e(r)}</option>' for r in regions)}<option>그 외 지역</option></select></div>
      <div class="field"><label for="qDate">희망 날짜</label><input id="qDate" type="date"></div>
    </div>
    <div class="ask">
      <button class="btn glove" id="qKakao" type="button">이 견적으로 카톡 문의</button>
      <div class="row2"><a class="btn line small" id="qSms" href="#">문자로 보내기</a><button class="btn line small" id="qCopy" type="button">내용 복사</button></div>
    </div>
  </div>
</div></section>

<section class="s" id="services"><div class="wrap">
  <h2>하는 일</h2>
  <p class="d">주거부터 상가, 준공 현장, 가전 분해세척까지 맡아요. 항목을 누르면 작업 범위와 가격 기준을 볼 수 있어요.</p>
  {services_html(c)}
</div></section>

<section class="s" id="cases"><div class="wrap">
  <h2>시공 사례</h2>
  <p class="d">실제 작업한 현장의 전후 사진이에요. 블로그에 올라온 후기가 자동으로 모여요.</p>
  <div id="caseChips" class="cats"></div>
  <div id="caseList" class="cases"></div>
</div></section>

<section class="s" id="season"><div class="wrap">
  <h2>달마다 많이 찾는 청소</h2>
  <p class="d">에어컨은 여름 전, 입주청소는 이사철에 예약이 몰려요. 원하는 날짜가 있다면 미리 잡아두세요.</p>
  <div class="months" id="months"></div>
</div></section>

<section class="s"><div class="wrap">
  <h2>진행 순서</h2>
  <p class="d">문의부터 마무리까지 네 단계예요.</p>
  <ol class="steps">
    <li><b>견적 계산·문의</b><span>위 계산기로 예상 금액을 보고 카톡이나 문자로 보내주세요.</span></li>
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
<script src="app.js"></script>
</body></html>
"""


def service_page(c, s):
    a, b = price_from(s)
    regions = c.get("regions", [])
    rg = "·".join(regions[:3])
    title = f"{rg} {s['name']} | {c['name']}" if rg else f"{s['name']} | {c['name']}"
    desc = f"{s['summary']}. 작업 범위: {', '.join(s['includes'])}. {a}"
    rows = ""
    if not s.get("quote"):
        rows = "".join(f"<tr><td>{e(v['name'])}</td><td>{s['unit']}당 {won(v['lo'])}~{won(v['hi'])}원</td></tr>" for v in s["variants"])
        rows += "".join(f"<tr><td>+ {e(o['name'])}</td><td>{won(o['lo'])}~{won(o['hi'])}원{' (' + s['unit'] + '당)' if o.get('perUnit') else ''}</td></tr>" for o in s.get("options", []))
        if s.get("min"):
            rows += f"<tr><td>최소 금액</td><td>{won(s['min'])}원</td></tr>"
    same = [x for x in c["services"] if x["cat"] == s["cat"] and x["id"] != s["id"]]
    return head(c, title, desc, f"services/{s['id']}.html", 1) + f"""
<main class="wrap page">
<div class="crumb"><a href="../index.html">홈</a> › <a href="../index.html#services">서비스</a></div>
<h1>{e(s['name'])}</h1>
<p class="lead" style="color:var(--muted);font-size:17px;margin:0">{e(s['summary'])}</p>
<div class="box"><h2>작업 범위</h2><ul>{''.join(f'<li>{e(i)}</li>' for i in s['includes'])}</ul></div>
<div class="box"><h2>가격 기준</h2>{f'<table class="ptable">{rows}</table><p style="font-size:13.5px;color:var(--muted);margin:10px 0 0">오염 정도와 구조에 따라 현장에서 달라질 수 있어요.</p>' if rows else '<p style="margin:0">현장 상태에 따라 작업량 차이가 커서, 사진을 보고 견적을 안내해 드려요.</p>'}</div>
<a class="btn glove" href="../index.html?svc={e(s['id'])}#quote">{'내 견적 계산하기' if not s.get('quote') else '사진 보내고 견적 받기'}</a>
{f'<div class="box"><h2>서비스 지역</h2><div class="links">' + ''.join(f'<a href="../{area_file(r)}">{e(r)} {e(s["name"])}</a>' for r in regions) + '</div></div>' if regions else ''}
{f'<div class="box"><h2>같이 많이 찾는 청소</h2><div class="links">' + ''.join(f'<a href="{e(x["id"])}.html">{e(x["name"])}</a>' for x in same) + '</div></div>' if same else ''}
</main>
{foot(c, 1)}
</body></html>
"""


def case_card(x):
    img = (f'<img class="ph" src="{e(x["img"])}" alt="" loading="lazy" referrerpolicy="no-referrer">' if x.get("img")
           else '<div class="ph"></div>')
    return (f'<a class="case" href="{e(x["link"])}" target="_blank" rel="noopener">{img}'
            f'<div class="tx"><div class="tt">{e(x["title"])}</div></div></a>')


def area_page(c, r, cases):
    title = f"{r} 입주청소·에어컨 청소 | {c['name']}"
    desc = f"{r} 지역 입주청소, 거주청소, 사무실·준공 청소, 에어컨·세탁기 분해세척을 {c['name']}에서 맡아요. 평수만 넣으면 예상 견적을 볼 수 있어요."
    mine = [x for x in cases if x.get("region") == r][:8]
    case_html = "".join(case_card(x) for x in mine)
    return head(c, title, desc, area_file(r), 1) + f"""
<main class="wrap page">
<div class="crumb"><a href="../index.html">홈</a> › 지역</div>
<h1>{e(r)} 청소, {e(c['name'])}이 맡아요</h1>
<p class="lead" style="color:var(--muted);font-size:17px;margin:0">{e(r)} 어디든 방문해요. 서비스를 고르면 작업 범위와 가격 기준을 볼 수 있어요.</p>
<div class="box">{services_html(c, 1)}</div>
<a class="btn glove" href="../index.html#quote">{e(r)} 견적 계산하기</a>
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
    return head(c, f"개인정보처리방침 | {c['name']}", "개인정보처리방침", "privacy.html") + f"""
<main class="wrap page">
<h1>개인정보처리방침</h1>
<div class="box">
<p>{e(who)}(이하 '업체')는 이 사이트에서 회원가입이나 입력 양식을 통해 개인정보를 수집하지 않아요.</p>
<p>견적 계산기에 입력한 내용은 이용자의 기기(브라우저)에만 저장되고 업체 서버로 전송되지 않아요. 이용자가 직접 카카오톡·문자·전화로 보낸 문의 내용은 상담과 작업 진행에만 쓰고, 상담이 끝나면 지체 없이 파기해요.</p>
<p>사이트 이용 통계를 위해 방문 기록(접속 기기, 방문 페이지 등)이 익명으로 수집될 수 있어요.</p>
<p>문의: {e(c.get('phone', ''))} {e(b.get('email', ''))}</p>
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
    files = {"index.html": index_page(c), "privacy.html": privacy_page(c)}
    for s in c["services"]:
        files[f"services/{s['id']}.html"] = service_page(c, s)
    for r in c.get("regions", []):
        files[f"area/{r}.html"] = area_page(c, r, cases)
    base = c.get("siteUrl", "").rstrip("/") + "/"
    today = datetime.now(KST).strftime("%Y-%m-%d")
    urls = [""] + [f"services/{s['id']}.html" for s in c["services"]] + [area_file(r) for r in c.get("regions", [])]
    files["sitemap.xml"] = ('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
                            + "".join(f"<url><loc>{e(base + u)}</loc><lastmod>{today}</lastmod></url>\n" for u in urls) + "</urlset>\n")
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
