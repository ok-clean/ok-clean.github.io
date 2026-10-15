// 메인 화면 동작: 견적 계산기, 시공 사례, 셀프 검수표, 계절 달력
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
const phoneDigits = (C.phone || "").replace(/[^0-9+]/g, "");

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
  $("qKakao").textContent = C.kakao ? (r ? "이 견적으로 카톡 문의" : "카톡으로 사진 보내기") : (r ? "이 견적으로 문자 문의" : "문자로 사진 보내기");
  const body = encodeURIComponent(summary());
  $("qSms").href = `sms:${phoneDigits}${/iPhone|iPad|iPod/.test(navigator.userAgent) ? "&" : "?"}body=${body}`;
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
  if(C.kakao){
    await copy(summary());
    toast("문의 내용을 복사했어요. 카톡 대화창에 붙여넣기만 하면 돼요.");
    setTimeout(() => window.open(C.kakao, "_blank", "noopener"), 600);
  } else location.href = $("qSms").href;
};
drawForm();

// ── 서비스 분류 칩 ──
document.querySelectorAll("#services .cats .chip").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll("#services .cats .chip").forEach(x => x.setAttribute("aria-pressed", x === b));
  document.querySelectorAll("#svcList li").forEach(li => li.hidden = !!b.dataset.cat && li.dataset.cat !== b.dataset.cat);
}));

// ── 시공 사례 (블로그 후기 자동 연동: update.py 가 cases.json 으로 정리) ──
let CASES = [], caseF = "";
function drawCases(){
  const list = CASES.filter(x => !caseF || x.svc === caseF);
  const used = [...new Set(CASES.map(x => x.svc).filter(Boolean))];
  $("caseChips").innerHTML = used.length > 1 ? `<button class="chip" data-f="" aria-pressed="${!caseF}">전체</button>` + used.map(id => { const s = SV.find(x => x.id === id); return s ? `<button class="chip" data-f="${esc(id)}" aria-pressed="${caseF === id}">${esc(s.name)}</button>` : ""; }).join("") : "";
  $("caseList").innerHTML = list.slice(0, 12).map(x => {
    const s = SV.find(v => v.id === x.svc);
    return `<a class="case" href="${esc(x.link)}" target="_blank" rel="noopener">${x.img ? `<img class="ph" src="${esc(x.img)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="ph"></div>`}
      <div class="tx"><div class="tg">${esc([x.region, s && s.name].filter(Boolean).join(" "))}</div><div class="tt">${esc(x.title)}</div></div></a>`;
  }).join("");
}
$("caseChips").addEventListener("click", e => { const b = e.target.closest("[data-f]"); if(!b) return; caseF = b.dataset.f; drawCases(); });
fetch("cases.json?t=" + Date.now(), {cache: "no-store"}).then(r => r.ok ? r.json() : {cases: []}).catch(() => ({cases: []})).then(d => {
  CASES = (d.cases || []).filter(x => x.link && x.title);
  if(CASES.length) drawCases();
  else if(C.sample || !C.blog) $("caseList").outerHTML = `<div class="hint">${C.blog ? "블로그 후기를 불러오는 중이에요. 1시간 안에 자동으로 채워져요." : "config.json 의 blog 에 네이버 블로그 아이디를 넣으면, 블로그에 올린 시공 후기가 여기에 자동으로 모여요."}</div>`;
  else $("cases").hidden = true;
});

// ── 셀프 검수표 ──
const CK = store.get("check", {}) || {};
const allItems = C.checklist.flatMap(a => a.items.map(it => a.area + "|" + it));
$("ckList").innerHTML = C.checklist.map(a => `<div class="ck-area"><h3>${esc(a.area)}</h3>${a.items.map(it => { const k = a.area + "|" + it; return `<label><input type="checkbox" data-k="${esc(k)}"${CK[k] ? " checked" : ""}><span>${esc(it)}</span></label>`; }).join("")}</div>`).join("");
function ckDraw(){
  const n = allItems.filter(k => CK[k]).length;
  $("ckCount").textContent = `${n}/${allItems.length}`;
  $("ckMeter").style.width = (n * 100 / allItems.length) + "%";
}
$("ckList").addEventListener("change", e => { const k = e.target.dataset.k; if(!k) return; if(e.target.checked) CK[k] = 1; else delete CK[k]; store.set("check", CK); ckDraw(); });
$("ckReset").onclick = () => { if(!confirm("체크한 내용을 모두 지울까요?")) return; Object.keys(CK).forEach(k => delete CK[k]); store.set("check", CK); document.querySelectorAll("#ckList input").forEach(i => i.checked = false); ckDraw(); };
$("ckSend").onclick = async () => {
  const left = allItems.filter(k => !CK[k]).map(k => "- " + k.replace("|", ": "));
  if(!left.length){ toast("모든 항목을 확인했어요."); return; }
  const text = `[${C.name} 검수 요청]\n확인이 더 필요한 곳 ${left.length}곳:\n${left.join("\n")}\n사진도 함께 보내드릴게요.`;
  await copy(text);
  if(C.kakao){ toast("확인할 곳 목록을 복사했어요. 카톡에 붙여넣어 주세요."); setTimeout(() => window.open(C.kakao, "_blank", "noopener"), 600); }
  else location.href = `sms:${phoneDigits}${/iPhone|iPad|iPod/.test(navigator.userAgent) ? "&" : "?"}body=${encodeURIComponent(text)}`;
};
ckDraw();

// ── 계절 달력 ──
const nowM = new Date(Date.now() + 9*3600e3).getUTCMonth() + 1;
$("months").innerHTML = C.seasons.map(x => `<div class="mo${x.m === nowM ? " now" : ""}"><b>${x.m}월</b>${x.ids.map(id => { const s = SV.find(v => v.id === id); return s ? `<span>${esc(s.name)}</span>` : ""; }).join("")}</div>`).join("");
const nowEl = document.querySelector(".mo.now");
if(nowEl) $("months").scrollLeft = Math.max(0, nowEl.offsetLeft - 20);
