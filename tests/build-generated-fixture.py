"""Build a disposable site with synthetic settings using the production update entrypoint."""
import importlib
import json
import shutil
import socket
import sys
import tempfile
import urllib.request
from pathlib import Path

source = Path(__file__).resolve().parent.parent
root = Path(tempfile.mkdtemp(prefix='okclean-generated-', dir='/tmp'))
for name in ('build.py', 'update.py', 'app.js', 'site.js', 'style.css', 'sw.js'):
    shutil.copy2(source / name, root / name)

config = {
    'name': '가상 청소 업체', 'tagline': '테스트 전용', 'siteUrl': 'https://example.test',
    'phone': '010-0000-0000', 'sms': '010-0000-0000', 'kakao': 'https://example.test/chat',
    'blog': ['fixture_blog'], 'business': {'company':'가상 업체','owner':'가상','number':'000-00-00000','address':'가상 주소','email':'fake@example.test'},
    'firebase': {'apiKey':'fake-test-identifier','projectId':'fake-test-project'}, 'memberBackendUrl':'',
    'regions':['춘천','강원도','수도권'], 'areaChoices':['춘천','원주','홍천','인제','수도권'],
    'categories':[{'id':'home','name':'주거 공간'},{'id':'care','name':'가전'}],
    'services':[
      {'id':'move-in','cat':'home','name':'입주·이사 청소','summary':'가상 항목','includes':['가상 범위'],'unit':'집',
       'kinds':[{'name':'신축'},{'name':'구축','open':True}], 'tiers':[{'name':'원룸','size':'소형','price':150000,'crew':1},{'name':'투룸','size':'중형','price':300000,'crew':2},{'name':'아파트','size':'대형','price':450000,'crew':3}], 'tierDefault':1,
       'options':[{'name':'가상 옵션','lo':30000,'hi':50000}]},
      {'id':'regular','cat':'home','name':'거주·정기 청소','summary':'가상 항목','includes':['가상 범위'],'unit':'평','qtyLabel':'평수','qtyDefault':25,'min':150000,
       'variants':[{'name':'1회','lo':10000,'hi':13000},{'name':'정기','lo':8000,'hi':10000}], 'options':[{'name':'가상 옵션','lo':30000,'hi':40000}]},
      {'id':'aircon','cat':'care','name':'에어컨 청소','summary':'가상 항목','includes':['가상 범위'],'unit':'대','qtyDefault':1,'variants':[{'name':'기본','lo':100000}]},
      {'id':'office','cat':'home','name':'상가 청소','summary':'가상 항목','includes':['가상 범위'],'unit':'평','qtyDefault':30,'variants':[{'name':'기본','lo':10000}]},
      {'id':'washer','cat':'care','name':'세탁기 청소','summary':'가상 항목','includes':['가상 범위'],'unit':'대','qtyDefault':1,'variants':[{'name':'기본','lo':100000}]},
      {'id':'special-home','cat':'home','name':'특수 청소','summary':'가상 항목','includes':['가상 범위'],'unit':'현장','quote':True}
    ],
    'member':{'coupon':10000,'couponTerms':'테스트 전용','freeServices':['가상 서비스'],'grades':[], 'referral':{'point':5000,'text':'가상 혜택'}},
    'seasons':[], 'faq':[{'q':'가상 질문','a':'가상 답변'}], 'analytics':{},
}
(root / 'config.json').write_text(json.dumps(config,ensure_ascii=False),encoding='utf8')
# 새 저장소의 기존 사례를 읽지 않습니다. 네트워크는 반드시 금지하고 모의 RSS만 공급합니다.
(root / 'cases.json').write_text('{"cases": []}',encoding='utf8')
sys.path.insert(0, str(root))
update = importlib.import_module('update')
rss = b'''<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><item><title>fixture cleaning case</title><link>https://example.test/case/1</link><description>fixture</description></item></channel></rss>'''
# update 분류에 쓰이는 제목은 한글 서비스 이름과 일치하도록 합니다.
rss = rss.replace(b'fixture cleaning case', '춘천 입주·이사 청소 시공'.encode('utf8'))
def deny_network(*args, **kwargs):
    raise AssertionError('external network access is forbidden')
urllib.request.urlopen = deny_network
socket.socket.connect = deny_network
socket.create_connection = deny_network
called = []
def fake_fetch(blog_id):
    assert blog_id == 'fixture_blog'
    called.append(blog_id)
    return rss
update.fetch_rss = fake_fetch
update.main()
assert called == ['fixture_blog'], 'production update RSS path was not exercised'
assert json.loads((root / 'cases.json').read_text(encoding='utf8'))['cases'][0]['link'] == 'https://example.test/case/1'
assert (root / 'index.html').exists() and (root / 'services/aircon.html').exists()
Path('/tmp/okclean-generated-root.txt').write_text(str(root),encoding='utf8')
print('Synthetic deployment fixture generated successfully')
