"""네이버 블로그 시공 후기를 cases.json 으로 모으고, 사이트 페이지를 다시 만드는 스크립트

- config.json 의 blog 에 적은 네이버 블로그(여러 개 가능)를 모두 읽어 최근 글부터 정렬
- 블로그 RSS 는 최근 글만 주므로, 한 번 모은 사례는 계속 쌓아 둠
- 제목·카테고리에 서비스 키워드(입주청소, 에어컨청소 등)나 '청소'가 있는 글만 시공 사례로 모음
- '방법·차이·vs·가격' 같은 정보 글(tipWords)은 '청소 꿀팁'(kind=tip)으로 따로 모음
- 교육·창업 홍보 글(excludeWords)과 청소와 관계없는 일상 글은 뺌
- 제목 끝의 다른 상호(titleStrip)는 지워서 보여줌
- 실패해도 기존 cases.json 을 그대로 둠
"""
import html
import json
import re
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import build

ROOT = Path(__file__).parent
OUT = ROOT / "cases.json"
KST = timezone(timedelta(hours=9))


def fetch_rss(blog_id):
    req = urllib.request.Request(f"https://rss.blog.naver.com/{blog_id}.xml", headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def first_img(desc):
    m = re.search(r'<img[^>]+src="([^"]+)"', desc or "")
    if not m:
        return ""
    return html.unescape(m.group(1))   # 원래 주소 그대로 저장 (화면에서 크기·서버를 골라 씀)


def norm(s):
    return re.sub(r"\s+", "", s or "")


def svc_by_title(c, title, cat):
    text = norm(title + " " + cat)
    for s in c["services"]:
        if any(norm(k) in text for k in s.get("keywords", []) + [s["name"]]):
            return s["id"]
    return ""


def svc_by_body(c, desc):
    body = norm(re.sub(r"<[^>]+>", " ", desc or ""))[:400]
    for s in c["services"]:
        if any(norm(k) in body for k in s.get("keywords", [])):
            return s["id"]
    return ""


def judge(c, title, cat, desc="", old_svc=""):
    """글 하나를 (종류, 서비스)로 판정. 종류: 'case'(시공 사례) / 'tip'(청소 꿀팁) / None(안 보여줌)"""
    if is_edu(c, title, cat):
        return None, ""
    t = norm(title)
    # 공지 글은 개별 시공 사례에서 제외합니다.
    if "공지" in t:
        return None, ""
    svc = svc_by_title(c, title, cat)
    topic = svc or "청소" in t or any(norm(w) in t for w in c.get("tipTopics", []))
    if not topic:
        return None, ""                       # 영화·여행·일상 글
    # 설명형 제목은 후기 표시가 없다면 정보 글로 분류합니다.
    info_title = ("알려주는" in t or bool(re.search(r"[가-힣]+는법", t)) or bool(re.search(r"\d+단계", t)))
    if info_title and not any(mark in t for mark in ("후기", "시공사례", "작업사례")):
        return "tip", svc
    if any(norm(w).lower() in t.lower() for w in c.get("tipWords", [])):
        return "tip", svc
    if not (svc or "청소" in t):
        return None, ""
    return "case", svc or svc_by_body(c, desc)


def clean_title(c, title):
    """제목 끝에 붙은 다른 상호만 지움 (문장 중간은 그대로)"""
    title = re.sub(r"\s+", " ", title).strip()
    for w in c.get("titleStrip", []):
        t = title.rstrip(" -~·|,")
        if t.endswith(w):
            title = t[: -len(w)]
    return title.strip(" -~·|,")


def region_of(c, title, cat, desc):
    text = title + " " + cat + " " + re.sub(r"<[^>]+>", " ", desc or "")[:400]
    for r in c.get("regions", []):
        if r in text:
            return r
    for r, names in (c.get("regionAlias") or {}).items():   # 원주 → 강원도, 서울 → 수도권
        if any(n in text for n in names):
            return r
    return ""


def is_edu(c, title, cat):
    """교육·창업 홍보 글은 시공 사례에서 뺌 (config.json 의 excludeWords)"""
    text = norm(title + " " + cat)
    return any(norm(w) in text for w in c.get("excludeWords", []))


def blogs_of(c):
    b = c.get("blog") or []
    if isinstance(b, str):
        b = [b]
    return [str(x).strip() for x in b if str(x).strip()]


def read_blog(c, blog_id):
    root = ET.fromstring(fetch_rss(blog_id))
    out = []
    for it in root.iter("item"):
        title = html.unescape((it.findtext("title") or "").strip())
        link = (it.findtext("link") or "").strip().split("?")[0]
        cat = html.unescape(it.findtext("category") or "")
        desc = it.findtext("description") or ""
        kind, svc = judge(c, title, cat, desc)
        if not (title and link and kind):
            continue
        try:
            date = parsedate_to_datetime(it.findtext("pubDate")).astimezone(KST).strftime("%Y-%m-%d %H:%M")
        except Exception:
            date = ""
        out.append({"title": clean_title(c, title), "link": link, "date": date, "img": first_img(desc), "svc": svc,
                    "kind": kind, "region": region_of(c, title, cat, desc), "blog": blog_id})
    return out


def main():
    c = build.load()
    blogs = blogs_of(c)
    if blogs:
        old = json.loads(OUT.read_text("utf-8")).get("cases", []) if OUT.exists() else []
        # 블로그 RSS 는 최근 글만 주므로, 예전에 모은 사례는 지우지 않고 계속 쌓아 둠
        box = {}
        for x in old:                          # 예전에 모은 글도 지금 규칙으로 다시 판정
            if not x.get("link"):
                continue
            kind, svc = judge(c, x.get("title", ""), "", "", x.get("svc", ""))
            if kind:
                box[x["link"]] = {**x, "title": clean_title(c, x["title"]), "kind": kind, "svc": svc}
        ok = 0
        for b in blogs:
            try:
                got = read_blog(c, b)
                for x in got:
                    box[x["link"]] = x
                ok += 1
                print(f"블로그 {b}: 시공 사례 {len(got)}건 확인")
            except Exception as err:
                print(f"블로그 {b} 읽기 실패(기존 사례 유지):", repr(err))
        # 설정에서 뺀 블로그의 글은 정리
        cases = [x for x in box.values() if not x.get("blog") or x["blog"] in blogs]
        cases.sort(key=lambda x: x.get("date") or "", reverse=True)   # 최근 글부터
        if ok and cases != old:
            OUT.write_text(json.dumps({"updated": datetime.now(KST).isoformat(timespec="seconds"), "cases": cases},
                                      ensure_ascii=False, indent=1), "utf-8")
            print(f"cases.json 갱신: 시공 사례 {len(cases)}건")
        else:
            print("시공 사례 변경 없음")
    else:
        print("config.json 에 blog 아이디가 없어 시공 사례 연동을 건너뜁니다.")
    build.run()


if __name__ == "__main__":
    main()
