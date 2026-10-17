"""네이버 블로그 시공 후기를 cases.json 으로 모으고, 사이트 페이지를 다시 만드는 스크립트

- config.json 의 blog 에 적은 네이버 블로그(여러 개 가능)를 모두 읽어 최근 글부터 정렬
- 블로그 RSS 는 최근 글만 주므로, 한 번 모은 사례는 계속 쌓아 둠
- 제목·카테고리에 서비스 키워드(입주청소, 에어컨청소 등)가 있는 글만 시공 사례로 모음
- 교육·창업 홍보 글(excludeWords)은 시공 사례에서 뺌
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


def classify(c, title, cat, desc):
    text = norm(title + " " + cat)
    for s in c["services"]:
        if any(norm(k) in text for k in s.get("keywords", []) + [s["name"]]):
            return s["id"]
    body = norm(re.sub(r"<[^>]+>", " ", desc or ""))[:400]
    for s in c["services"]:
        if any(norm(k) in body for k in s.get("keywords", [])):
            return s["id"]
    return ""


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
        svc = classify(c, title, cat, desc)
        if not (title and link and svc) or is_edu(c, title, cat):
            continue
        try:
            date = parsedate_to_datetime(it.findtext("pubDate")).astimezone(KST).strftime("%Y-%m-%d %H:%M")
        except Exception:
            date = ""
        out.append({"title": title, "link": link, "date": date, "img": first_img(desc), "svc": svc,
                    "region": region_of(c, title, cat, desc), "blog": blog_id})
    return out


def main():
    c = build.load()
    blogs = blogs_of(c)
    if blogs:
        old = json.loads(OUT.read_text("utf-8")).get("cases", []) if OUT.exists() else []
        # 블로그 RSS 는 최근 글만 주므로, 예전에 모은 사례는 지우지 않고 계속 쌓아 둠
        box = {x["link"]: x for x in old if x.get("link") and not is_edu(c, x.get("title", ""), "")}
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
