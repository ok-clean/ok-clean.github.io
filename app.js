// 메인 화면 동작: 견적 계산기, 시공 사례, 계절 달력
const C = JSON.parse(document.getElementById("cfg").textContent);
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const store = {
  get(k, d){ try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch(e){ return d; } },
  set(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} }
};
function toast(msg){
  let t = document.querySelector(".toast");
  if(!t){ t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("on");
  clearTimeout(toast.tm); toast.tm = setTimeout(() => t.classList.remove("on"), 2600);
}
async function copy(text){
  try { await navigator.clipboard.writeText(text); return true; }
  catch(e){
    const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch(_) {}
    ta.remove(); return ok;
  }
}
const won = x => { x = Math.round(x / 1000) * 1000; return x >= 10000 ? (+(x / 10000).toFixed(1)) + "만" : x.toLocaleString("ko-KR"); };
const BLOGS = [].concat(C.blog || []).filter(Boolean);
const phoneDigits = (C.phone || "").replace(/[^0-9+]/g, "");
const M = C.member || null;
let MEMBER = store.get("member", null);

// ── 견적 계산기 ──
const SV = C.services;
const Q = store.get("quote", {}) || {};
const urlSvc = new URLSearchParams(location.search).get("svc");
let cur = { svc: urlSvc && SV.some(s => s.id === urlSvc) ? urlSvc : (Q.svc && SV.some(s => s.id === Q.svc) ? Q.svc : SV[0].id), v: 0, qty: null, opts: [] };
if(cur.svc === Q.svc){ cur.v = Q.v || 0; cur.qty = Q.qty || null; cur.opts = Q.opts || []; }
const svc = () => SV.find(s => s.id === cur.svc);

$("qSvc").innerHTML = C.categories.map(cat => `<optgroup label="${esc(cat.name)}">${SV.filter(s => s.cat === cat.id).map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("")}</optgroup>`).join("");
if(Q.area) $("qArea").value = Q.area;
if(Q.date) $("qDate").value = Q.date;
const today = new Date(); $("qDate").min = new Date(today.getTime() + 9*3600e3).toISOString().slice(0, 10);

function drawForm(){
  const s = svc();
  $("qSvc").value = s.id;
  const quote = s.quote || !s.variants || !s.variants.length;
  $("qVarF").hidden = quote || s.variants.length < 2;
  $("qQtyF").hidden = quote;
  $("qOptF").hidden = quote || !(s.options || []).length;
  if(!quote){
    if(cur.v >= s.variants.length) cur.v = 0;
    $("qVar").innerHTML = s.variants.map((v, i) => `<button type="button" data-v="${i}" aria-pressed="${i === cur.v}">${esc(v.name)}</button>`).join("");
    if(!cur.qty) cur.qty = s.qtyDefault || 1;
    $("qQty").value = cur.qty;
    $("qQtyL").textContent = s.qtyLabel || "수량";
    $("qUnit").textContent = s.unit;
    $("qOpt").innerHTML = (s.options || []).map((o, i) => `<label><input type="checkbox" data-o="${i}"${cur.opts.includes(i) ? " checked" : ""}><span>${esc(o.name)}</span><small>+${won(o.lo)}~${won(o.hi)}${o.perUnit ? "/" + esc(s.unit) : ""}</small></label>`).join("");
  }
  calc();
}
function estimate(){
  const s = svc();
  if(s.quote || !s.variants || !s.variants.length) return null;
  const v = s.variants[cur.v] || s.variants[0], q = Math.max(1, +cur.qty || 1);
  let lo = v.lo * q, hi = v.hi * q;
  cur.opts.forEach(i => { const o = (s.options || [])[i]; if(o){ lo += o.perUnit ? o.lo * q : o.lo; hi += o.perUnit ? o.hi * q : o.hi; } });
  if(s.min){ lo = Math.max(lo, s.min); hi = Math.max(hi, s.min); }
  return {lo, hi, v, q};
}
function summary(){
  const s = svc(), r = estimate();
  const lines = [`[${C.name} 견적 문의]`, `서비스: ${s.name}`];
  if(r){
    lines.push(`내용: ${s.variants.length > 1 ? r.v.name + " / " : ""}${r.q}${s.unit}`);
    const os = cur.opts.map(i => (s.options || [])[i]).filter(Boolean).map(o => o.name);
    if(os.length) lines.push(`추가: ${os.join(", ")}`);
    lines.push(`예상 금액: ${won(r.lo)}~${won(r.hi)}원 (사이트 계산)`);
  } else lines.push("현장 사진을 보내드릴게요.");
  if($("qArea").value) lines.push(`지역: ${$("qArea").value}`);
  if($("qDate").value) lines.push(`희망 날짜: ${$("qDate").value}`);
  if(MEMBER && M) lines.push(`회원 쿠폰: ${MEMBER.code} (${won(M.coupon)}원 할인 + 무료 서비스: ${MEMBER.free})`);
  lines.push("상세 주소·현장 사진은 대화로 보내드릴게요.");
  return lines.join("\n");
}
function calc(){
  const s = svc(), r = estimate();
  if(r){
    $("qK").textContent = "예상 금액";
    $("qV").innerHTML = `${won(r.lo)}~${won(r.hi)}<small>원</small>`;
    $("qN").textContent = "오염 정도와 구조에 따라 현장에서 달라질 수 있어요." + (s.min && r.lo === s.min ? ` 최소 금액 ${won(s.min)}원이 적용됐어요.` : "");
  } else {
    $("qK").textContent = "현장 견적";
    $("qV").innerHTML = `사진 보고<small> 안내</small>`;
    $("qN").textContent = "작업량 차이가 커서 현장 사진을 보고 금액을 알려드려요.";
  }
  $("qKakao").textContent = r ? "이 견적으로 카톡 문의" : "카톡으로 사진 보내고 견적 받기";
  if(M){
    const box = $("qMem"); box.hidden = false;
    if(MEMBER) box.innerHTML = r ? `🎟 회원 쿠폰 적용 시 <b>${won(Math.max(0, r.lo - M.coupon))}~${won(Math.max(0, r.hi - M.coupon))}원</b> + ${esc(MEMBER.free)} 무료` : `🎟 회원 쿠폰 ${won(M.coupon)}원 할인 + ${esc(MEMBER.free)} 무료가 적용돼요`;
    else box.innerHTML = `<button type="button" class="mem-join" data-join>🎟 회원가입하면 여기서 <b>${won(M.coupon)}원 더 할인</b> + 무료 서비스 →</button>`;
  }
  store.set("quote", {svc: cur.svc, v: cur.v, qty: cur.qty, opts: cur.opts, area: $("qArea").value, date: $("qDate").value});
}
$("qSvc").addEventListener("change", e => { cur = {svc: e.target.value, v: 0, qty: null, opts: []}; drawForm(); });
$("qVar").addEventListener("click", e => { const b = e.target.closest("[data-v]"); if(!b) return; cur.v = +b.dataset.v; drawForm(); });
$("qQty").addEventListener("input", e => { cur.qty = Math.min(999, Math.max(1, parseInt(e.target.value, 10) || 1)); calc(); });
$("qMinus").onclick = () => { cur.qty = Math.max(1, (+cur.qty || 1) - 1); $("qQty").value = cur.qty; calc(); };
$("qPlus").onclick = () => { cur.qty = Math.min(999, (+cur.qty || 0) + 1); $("qQty").value = cur.qty; calc(); };
$("qOpt").addEventListener("change", e => { const i = +e.target.dataset.o; cur.opts = e.target.checked ? [...new Set([...cur.opts, i])] : cur.opts.filter(x => x !== i); calc(); });
$("qArea").addEventListener("change", calc);
$("qDate").addEventListener("change", calc);
$("qCopy").onclick = async () => { if(await copy(summary())) toast("문의 내용을 복사했어요. 원하는 곳에 붙여넣어 주세요."); };
$("qKakao").onclick = async () => {
  await copy(summary());
  if(C.kakao){
    toast("문의 내용을 복사했어요. 카톡 대화창에 붙여넣기만 하면 돼요.");
    setTimeout(() => window.open(C.kakao, "_blank", "noopener"), 600);
  } else { toast("문의 내용을 복사했어요. 전화로 연결할게요."); setTimeout(() => location.href = "tel:" + phoneDigits, 600); }
};
drawForm();

// ── 서비스 분류 칩 ──
document.querySelectorAll("#services .cats .chip").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll("#services .cats .chip").forEach(x => x.setAttribute("aria-pressed", x === b));
  document.querySelectorAll("#svcList li").forEach(li => li.hidden = !!b.dataset.cat && li.dataset.cat !== b.dataset.cat);
}));

// ── 시공 사례 (블로그 후기 자동 연동: update.py 가 cases.json 으로 정리) ──
let CASES = [], caseF = "", caseN = 8;
// 네이버 블로그 사진: 외부 사이트에서도 잘 열리는 서버(mblogthumb-phinf)의 큰 사진을 먼저 쓰고, 안 되면 원래 썸네일로
function naverImgs(src){
  if(!/pstatic\.net/.test(src)) return [src, src];
  const base = src.replace(/\?.*$/, "");
  return [base.replace("://blogthumb.pstatic.net", "://mblogthumb-phinf.pstatic.net").replace("://postfiles.pstatic.net", "://mblogthumb-phinf.pstatic.net") + "?type=w800", base + "?type=s3"];
}
document.addEventListener("error", e => {
  const im = e.target;
  if(!(im instanceof HTMLImageElement) || !im.classList.contains("ph")) return;
  if(!im.dataset.f && im.dataset.alt){ im.dataset.f = "1"; im.src = im.dataset.alt; }
  else { const d = document.createElement("div"); d.className = "ph"; im.replaceWith(d); }
}, true);
function drawCases(){
  const list = CASES.filter(x => !caseF || x.svc === caseF);
  const used = [...new Set(CASES.map(x => x.svc).filter(Boolean))];
  $("caseChips").innerHTML = used.length > 1 ? `<button class="chip" data-f="" aria-pressed="${!caseF}">전체</button>` + used.map(id => { const s = SV.find(x => x.id === id); return s ? `<button class="chip" data-f="${esc(id)}" aria-pressed="${caseF === id}">${esc(s.name)}</button>` : ""; }).join("") : "";
  $("caseList").innerHTML = list.slice(0, caseN).map(x => {
    const s = SV.find(v => v.id === x.svc);
    return `<a class="case" href="${esc(x.link)}" target="_blank" rel="noopener">${x.img ? (() => { const [big, alt] = naverImgs(x.img); return `<img class="ph" src="${esc(big)}" data-alt="${esc(alt)}" alt="" loading="lazy" referrerpolicy="no-referrer">`; })() : `<div class="ph"></div>`}
      <div class="tx"><div class="tg">${esc([x.region, s && s.name].filter(Boolean).join(" "))}</div><div class="tt">${esc(x.title)}</div></div></a>`;
  }).join("") + (list.length > caseN ? `<button class="btn line small" id="caseMore" type="button" style="grid-column:1/-1">시공 사례 더 보기 (${list.length - caseN}건)</button>` : "");
}
$("caseList").addEventListener("click", e => { if(e.target.id === "caseMore"){ caseN += 8; drawCases(); } });
$("caseChips").addEventListener("click", e => { const b = e.target.closest("[data-f]"); if(!b) return; caseF = b.dataset.f; caseN = 8; drawCases(); });
fetch("cases.json?t=" + Date.now(), {cache: "no-store"}).then(r => r.ok ? r.json() : {cases: []}).catch(() => ({cases: []})).then(d => {
  const ex = (C.excludeWords || []).map(w => w.replace(/\s/g, ""));
  CASES = (d.cases || []).filter(x => x.link && x.title && !ex.some(w => x.title.replace(/\s/g, "").includes(w))).sort((p, q) => (q.date || "").localeCompare(p.date || ""));
  if(CASES.length) drawCases();
  else if(C.sample || !BLOGS.length) $("caseList").outerHTML = `<div class="hint">${BLOGS.length ? "블로그 후기를 불러오는 중이에요. 1시간 안에 자동으로 채워져요." : "config.json 의 blog 에 네이버 블로그 아이디를 넣으면, 블로그에 올린 시공 후기가 여기에 자동으로 모여요."}</div>`;
  else $("cases").hidden = true;
});

// ── 계절 달력 ──
const nowM = new Date(Date.now() + 9*3600e3).getUTCMonth() + 1;
$("months").innerHTML = C.seasons.map(x => `<div class="mo${x.m === nowM ? " now" : ""}"><b>${x.m}월</b>${x.ids.map(id => { const s = SV.find(v => v.id === id); return s ? `<span>${esc(s.name)}</span>` : ""; }).join("")}</div>`).join("");
const nowEl = document.querySelector(".mo.now");
if(nowEl) $("months").scrollLeft = Math.max(0, nowEl.offsetLeft - 20);


// ── 회원가입 (팝업) ──
// 이 사이트에는 서버가 없어서, 가입 정보는 이 기기에 저장하고 고객이 카톡으로 보내면 업체가 회원으로 등록해요.
function joinDone(){
  const d = $("joinDone"), m = MEMBER;
  $("joinForm").hidden = true; d.hidden = false;
  d.innerHTML = `<p class="done-k">가입을 환영해요, ${esc(m.name)}님</p>
    <div class="coupon"><span>회원 쿠폰</span><b>${won(M.coupon)}원 할인</b><em>+ ${esc(m.free)} 무료</em><code>${esc(m.code)}</code></div>
    <p class="note">${esc(M.couponTerms)}</p>
    <p class="step-k"><b>마지막 단계</b> · 아래 버튼으로 가입 내용을 카톡에 보내 주시면 쿠폰이 등록돼요.</p>
    <button class="btn glove" type="button" id="jKakao">카톡으로 가입 완료하기</button>
    <button class="link" type="button" data-close>나중에 보낼게요</button>`;
  $("jKakao").onclick = async () => {
    const text = `[${C.name} 회원가입]\n이름: ${m.name}\n연락처: ${m.phone}\n지역: ${m.area || "-"}\n무료 서비스: ${m.free}\n쿠폰번호: ${m.code}\n이벤트 소식: ${m.ad ? "받음" : "안 받음"}`;
    await copy(text);
    toast("가입 내용을 복사했어요. 카톡 대화창에 붙여넣기만 하면 돼요.");
    MEMBER.sent = true; store.set("member", MEMBER);
    setTimeout(() => window.open(C.kakao, "_blank", "noopener"), 600);
  };
}
function openJoin(){
  if(!M) return;
  if(MEMBER) joinDone(); else { $("joinForm").hidden = false; $("joinDone").hidden = true; }
  openModal("join");
}
if(M){
  document.addEventListener("click", e => {
    if(e.target.closest("[data-join]")){ e.preventDefault(); openJoin(); }
    if(e.target.closest("[data-later]")){ store.set("joinLater", Date.now()); closeModal($("join")); }
  });
  $("jPhone").addEventListener("input", e => {
    const d = e.target.value.replace(/\D/g, "").slice(0, 11);
    e.target.value = d.length < 4 ? d : d.length < 8 ? `${d.slice(0, 3)}-${d.slice(3)}` : `${d.slice(0, 3)}-${d.slice(3, d.length - 4)}-${d.slice(-4)}`;
  });
  $("jSubmit").onclick = () => {
    const name = $("jName").value.trim(), phone = $("jPhone").value.trim();
    const err = msg => { $("jErr").textContent = msg; };
    if(!name) return err("이름을 적어 주세요.");
    if(!/^01[016789]-?\d{3,4}-?\d{4}$/.test(phone)) return err("휴대폰 번호를 정확히 적어 주세요. 예: 010-1234-5678");
    if(!$("jAgree").checked) return err("개인정보 수집·이용에 동의해 주세요.");
    const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const code = "OK-" + Array.from({length: 6}, () => abc[Math.floor(Math.random() * abc.length)]).join("");
    MEMBER = {name, phone, area: $("jArea").value, free: (document.querySelector('input[name="jFree"]:checked') || {}).value || M.freeServices[0],
              ad: $("jAgree").checked && $("jAd").checked, code, joined: new Date().toISOString().slice(0, 10)};
    store.set("member", MEMBER);
    joinDone(); calc();
  };
  // 처음 방문한 사람에게 한 번 띄우기 (가입했거나 '다음에'를 누른 뒤 7일 동안은 안 띄움)
  const later = store.get("joinLater", 0);
  if(!MEMBER && Date.now() - later > 7 * 864e5 && !/src=app/.test(location.search)){
    let shown = false;
    const pop = () => { if(shown || document.querySelector(".modal:not([hidden])")) return; shown = true; store.set("joinLater", Date.now()); openJoin(); };
    setTimeout(pop, 12000);
    window.addEventListener("scroll", function onS(){ if(window.scrollY > document.body.scrollHeight * 0.35){ pop(); window.removeEventListener("scroll", onS); } }, {passive: true});
  }
  calc();
}
