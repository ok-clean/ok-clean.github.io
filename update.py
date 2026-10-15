"""네이버 블로그 시공 후기를 cases.json 으로 모으고, 사이트 페이지를 다시 만드는 스크립트

- config.json 의 blog 에 네이버 블로그 아이디가 있을 때만 블로그를 읽음
- 제목·카테고리에 서비스 키워드(입주청소, 에어컨청소 등)가 있는 글만 시공 사례로 모음
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
    src = html.unescape(m.group(1))
    # 네이버 썸네일은 type 파라미터로 크기 조절
    return re.sub(r"\?type=\w+", "", src) + "?type=w580" if "pstatic.net" in src else src


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
    return ""


def main():
    c = build.load()
    blog = str(c.get("blog") or "").strip()
    if blog:
        try:
            root = ET.fromstring(fetch_rss(blog))
            cases = []
            for it in root.iter("item"):
                title = html.unescape((it.findtext("title") or "").strip())
                link = (it.findtext("link") or "").strip().split("?")[0]
                cat = html.unescape(it.findtext("category") or "")
                desc = it.findtext("description") or ""
                svc = classify(c, title, cat, desc)
                if not (title and link and svc):
                    continue
                try:
                    date = parsedate_to_datetime(it.findtext("pubDate")).astimezone(KST).strftime("%Y-%m-%d")
                except Exception:
                    date = ""
                cases.append({"title": title, "link": link, "date": date, "img": first_img(desc), "svc": svc,
                              "region": region_of(c, title, cat, desc)})
            old = json.loads(OUT.read_text("utf-8")).get("cases") if OUT.exists() else None
            if cases != old:
                OUT.write_text(json.dumps({"updated": datetime.now(KST).isoformat(timespec="seconds"), "cases": cases},
                                          ensure_ascii=False, indent=1), "utf-8")
                print(f"cases.json 갱신: 시공 사례 {len(cases)}건")
            else:
                print("시공 사례 변경 없음")
        except Exception as err:
            print("블로그 읽기 실패(기존 사례 유지):", repr(err))
    else:
        print("config.json 에 blog 아이디가 없어 시공 사례 연동을 건너뜁니다.")
    build.run()


if __name__ == "__main__":
    main()
