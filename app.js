// 메인 화면 동작: 견적 계산기, 시공 사례, 계절 달력
const C = JSON.parse(document.getElementById("cfg").textContent);
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const store = {
  get(k, d){ try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch(e){ return d; } },
  set(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch(e){ return false; } }
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
// 메모리에만 있는 회원정보와 마지막 기기 저장 결과를 구분합니다.
let memberSaved = !!MEMBER;
const memberStorageWarning = "최근 회원정보를 이 기기에 저장하지 못했어요. 새로고침하거나 창을 닫으면 쿠폰 정보가 사라질 수 있어요. 쿠폰번호를 확인한 뒤 카톡으로 가입을 완료해 주세요.";
// 명시된 추천 링크는 현재 방문에서 우선하며, 잘못된 링크에 이전 코드를 대체하지 않습니다.
const refParams = new URLSearchParams(location.search).getAll("ref");
const validRef = code => typeof code === "string" && /^OK-[A-Z0-9]{6}$/.test(code);
const ownRef = code => !!MEMBER && typeof MEMBER.code === "string" && MEMBER.code.toUpperCase() === code;
const refQ = refParams.length === 1 ? refParams[0].toUpperCase() : "";
const storedRef = store.get("ref", "");
let REF = "", refNotice = "";
// 오래된 코드가 다음 화면에 잘못 복원되지 않도록 최선을 다해 지웁니다.
const clearStoredRef = () => { try { localStorage.removeItem("ref"); return localStorage.getItem("ref") === null; } catch(_) { return false; } };
if(refParams.length){
  if(validRef(refQ) && !ownRef(refQ)){
    REF = refQ;
    const saved = store.set("ref", REF);
    const readable = store.get("ref", "") === REF;
    if(!readable){
      // 저장에 실패한 경우에만 옛 값을 지웁니다. 읽기만 실패했다면 방금 쓴 값을 보존합니다.
      const cleared = !saved && clearStoredRef();
      refNotice = "추천인 코드를 이 기기에 저장했는지 확인하지 못했어요. 다른 페이지로 이동하면 코드가 사라질 수 있어요. 초대 링크를 다시 열어 주세요.";
      if((!saved && !cleared) || saved) refNotice += " 다른 페이지에서 이전 코드나 다른 코드가 나타날 수도 있어요.";
    }
  } else {
    refNotice = refParams.length === 1 && validRef(refQ) && ownRef(refQ)
      ? "본인의 추천인 코드는 적용할 수 없어요."
      : "추천인 코드를 확인할 수 없어요. 초대 링크를 다시 확인해 주세요.";
    refNotice += " 다른 페이지에서는 기기에 저장된 이전 코드가 다시 나타날 수 있어요.";
  }
} else if(validRef(storedRef) && !ownRef(storedRef)) REF = storedRef;

// ── 견적 계산기 ──
const SV = C.services;
const Q = store.get("quote", {}) || {};
const serviceParams = new URLSearchParams(location.search).getAll("svc");
let urlSvc = null, serviceLinkIssue = "";
if(serviceParams.length){
  let consumed = false;
  try {
    const cleanURL = new URL(location.href);
    cleanURL.searchParams.delete("svc");
    history.replaceState(history.state, "", cleanURL.href);
    consumed = true;
  } catch(_) {} // 주소를 정리할 수 없으면 링크로 자동 선택하지 않습니다.
  if(consumed && serviceParams.length === 1 && SV.some(s => s.id === serviceParams[0])) urlSvc = serviceParams[0];
  else serviceLinkIssue = consumed ? "청소 서비스를 확인하고 선택해 주세요." : "링크의 청소 서비스를 자동 선택하지 못했어요. 원하는 서비스를 확인해 주세요.";
}
let cur = { svc: urlSvc && SV.some(s => s.id === urlSvc) ? urlSvc : (Q.svc && SV.some(s => s.id === Q.svc) ? Q.svc : SV[0].id), v: 0, t: null, qty: null, opts: [] };
if(cur.svc === Q.svc){ cur.v = Q.v || 0; cur.t = Q.t ?? null; cur.qty = Q.qty === "" ? "" : Q.qty == null || !Number.isFinite(Number(Q.qty)) ? null : Math.min(999, Math.max(1, Math.trunc(Number(Q.qty)))); cur.opts = Q.opts || []; }
const svc = () => SV.find(s => s.id === cur.svc);

if(refNotice){
  const note = document.createElement("p");
  note.id = "qRefNote";
  note.className = "hint";
  note.setAttribute("role", "status");
  note.textContent = refNotice;
  $("qSvc").insertAdjacentElement("afterend", note);
}
$("qSvc").innerHTML = C.categories.map(cat => `<optgroup label="${esc(cat.name)}">${SV.filter(s => s.cat === cat.id).map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("")}</optgroup>`).join("");
if(serviceLinkIssue){
  const note = document.createElement("p");
  note.id = "qSvcLinkNote";
  note.className = "hint";
  note.setAttribute("role", "status");
  note.textContent = serviceLinkIssue;
  $("qSvc").insertAdjacentElement("afterend", note);
  $("qSvc").setAttribute("aria-describedby", note.id);
  $("qSvc").addEventListener("change", () => { note.remove(); $("qSvc").removeAttribute("aria-describedby"); }, {once:true});
}
// 지역 페이지의 선택은 최초 진입에만 적용하고 사용자가 이후 변경한 값을 존중합니다.
const areaParams = new URLSearchParams(location.search).getAll("area");
if(areaParams.length){
  let consumed = false;
  try {
    const cleanURL = new URL(location.href);
    cleanURL.searchParams.delete("area");
    history.replaceState(history.state, "", cleanURL.href);
    consumed = true;
  } catch(_) {} // 주소를 정리할 수 없을 때에는 자동 선택하지 않습니다.
  const region = areaParams.length === 1 ? areaParams[0] : "";
  const isKnownRegion = (C.regions || []).includes(region);
  const isSelectable = Array.from($("qArea").options).some(option => option.value === region && region !== "");
  if(consumed && isKnownRegion && isSelectable) $("qArea").value = region;
  else {
    $("qArea").value = "";
    const note = document.createElement("p");
    note.id = "qAreaLinkNote";
    note.className = "hint";
    note.setAttribute("role", "status");
    note.textContent = consumed && isKnownRegion ? "세부 지역을 선택해 주세요." : "지역을 선택해 주세요.";
    $("qArea").insertAdjacentElement("afterend", note);
    $("qArea").setAttribute("aria-describedby", note.id);
    $("qArea").addEventListener("change", () => { note.remove(); $("qArea").removeAttribute("aria-describedby"); }, {once:true});
  }
} else if(Q.area) $("qArea").value = Q.area;
const today = new Date(); $("qDate").min = new Date(today.getTime() + 9*3600e3).toISOString().slice(0, 10);
if(Q.date && Q.date >= $("qDate").min) $("qDate").value = Q.date;

// 가격 방식: tiers(집 크기별 정액, 입주청소) / variants(종류 × 수량) / quote(현장 견적)
// 금액에 hi 가 없으면 '~부터' 금액, quote:true 는 현장 견적 항목
const priceText = (lo, hi) => hi == null ? `${won(lo)}원~` : lo === hi ? `${won(lo)}원` : `${won(lo)}~${won(hi)}원`;
const optText = (o, s) => o.quote ? "현장 견적" : "+" + (o.hi == null ? won(o.lo) + "~" : `${won(o.lo)}~${won(o.hi)}`) + (o.perUnit ? "/" + s.unit : "");
const isQuote = s => s.quote || (!(s.tiers || []).length && !(s.variants || []).length);
function drawForm(){
  const s = svc();
  $("qSvc").value = s.id;
  const quote = isQuote(s), tiered = !!(s.tiers || []).length;
  const vars = tiered ? s.kinds || [] : s.variants || [];
  if(cur.v >= vars.length) cur.v = 0;
  if(tiered && (cur.t == null || cur.t >= s.tiers.length)) cur.t = s.tierDefault ?? 0;
  $("qVarF").hidden = quote || vars.length < 2;
  $("qVar").innerHTML = vars.map((v, i) => `<button type="button" data-v="${i}" aria-pressed="${i === cur.v}">${esc(v.name)}</button>`).join("");
  $("qTierF").hidden = !tiered;
  if(tiered) $("qTier").innerHTML = s.tiers.map((t, i) => `<button type="button" data-t="${i}" aria-pressed="${i === cur.t}"><b>${esc(t.name)}</b><span>${esc(t.size || "")}${t.crew ? ` · ${t.crew}명` : ""}</span><em>${t.quote ? "현장 견적" : won(t.price) + "원" + (vars[cur.v] && vars[cur.v].open ? "~" : "")}</em></button>`).join("");
  const v = vars[cur.v];
  $("qQtyF").hidden = quote || tiered || !!(v && v.quote);
  $("qOptF").hidden = quote || !(s.options || []).length;
  if(!quote && !tiered){
    if(cur.qty == null) cur.qty = s.qtyDefault || 1;
    $("qQty").value = cur.qty;
    $("qQtyL").textContent = s.qtyLabel || "수량";
    $("qUnit").textContent = s.unit;
  }
  if(!quote) $("qOpt").innerHTML = (s.options || []).map((o, i) => `<label><input type="checkbox" data-o="${i}"${cur.opts.includes(i) ? " checked" : ""}><span>${esc(o.name)}</span><small>${optText(o, s)}</small></label>`).join("");
  calc();
}
// 사용자가 비운 수량은 초기 기본값과 구별합니다. 현장 견적에는 수량이 필요하지 않습니다.
function missingQty(){
  const s = svc(), v = (s.variants || [])[cur.v] || {};
  return !isQuote(s) && !(s.tiers || []).length && !v.quote && cur.qty === "";
}
function estimate(){
  const s = svc();
  if(missingQty()) return null;
  if(isQuote(s)) return null;
  const tiered = !!(s.tiers || []).length;
  const opts = cur.opts.map(i => (s.options || [])[i]).filter(Boolean);
  let lo, hi, v, q = 1, t = null;
  if(tiered){
    v = (s.kinds || [])[cur.v] || {}; t = s.tiers[cur.t] || s.tiers[0];
    if(t.quote) return null;
    lo = t.price; hi = v.open ? null : t.price;
  } else {
    v = s.variants[cur.v] || s.variants[0];
    if(v.quote) return null;
    q = Math.max(1, +cur.qty || 1);
    lo = v.lo * q; hi = v.hi == null ? null : v.hi * q;
  }
  opts.filter(o => !o.quote).forEach(o => {
    const m = o.perUnit ? q : 1;
    lo += o.lo * m; hi = (hi == null || o.hi == null) ? null : hi + o.hi * m;
  });
  if(s.min){ lo = Math.max(lo, s.min); if(hi != null) hi = Math.max(hi, s.min); }
  return {lo, hi, v, q, t, onSite: opts.filter(o => o.quote).map(o => o.name)};
}
function summary(){
  const s = svc(), r = estimate();
  const lines = [`[${C.name} 견적 문의]`, `서비스: ${s.name}`];
  const os = cur.opts.map(i => (s.options || [])[i]).filter(Boolean).map(o => o.name);
  if(r){
    lines.push(r.t ? `내용: ${r.v.name || ""} / ${r.t.name} (${r.t.size}, ${r.t.crew}명)` : `내용: ${s.variants.length > 1 ? r.v.name + " / " : ""}${r.q}${s.unit}`);
    if(os.length) lines.push(`추가: ${os.join(", ")}`);
    lines.push(`예상 금액: ${priceText(r.lo, r.hi)} (사이트 계산${r.onSite.length ? ", " + r.onSite.join("·") + " 별도" : ""})`);
    if(s.min && r.lo === s.min && cur.opts.some(i => (s.options || [])[i] && !(s.options || [])[i].quote)){
      lines.push(`계산 안내: 할인 전 기본 금액과 금액이 표시된 옵션을 합산한 뒤 최소 금액 ${won(s.min)}원을 적용해요.`);
    }
  } else {
    const t = (s.tiers || [])[cur.t], v = ((s.tiers || []).length ? s.kinds : s.variants || [])[cur.v];
    if(!isQuote(s)) lines.push(`내용: ${[v && v.name, t && t.name].filter(Boolean).join(" / ")}`);
    if(os.length) lines.push(`추가: ${os.join(", ")}`);
    lines.push("현장 사진을 보내드릴게요. 견적 부탁드려요.");
  }
  if($("qArea").value) lines.push(`지역: ${$("qArea").value}`);
  if($("qDate").value) lines.push(`희망 날짜: ${$("qDate").value}`);
  if(MEMBER && M) lines.push(`회원 쿠폰: ${MEMBER.code} (${won(M.coupon)}원 할인 + 무료 서비스: ${MEMBER.free})`);
  else if(REF) lines.push(`추천인 코드: ${REF}`);
  lines.push("상세 주소·현장 사진은 대화로 보내드릴게요.");
  return lines.join("\n");
}
// 고른 날짜가 주말이면 할증 가능성 안내 (평일이 더 저렴하고 일정 잡기도 쉬움)
function weekendNote(){
  const v = $("qDate").value; if(!v) return "";
  const d = new Date(v + "T00:00:00").getDay();
  return (d === 0 || d === 6) ? " 주말은 할증이 붙을 수 있어요. 평일이면 더 저렴해요." : "";
}
function calc(){
  const s = svc(), r = estimate(), needsQty = missingQty();
  let qtyNote = $("qQtyNote");
  if(needsQty && !qtyNote){
    qtyNote = document.createElement("p"); qtyNote.id = "qQtyNote";
    qtyNote.className = "hint"; qtyNote.setAttribute("role", "status");
    qtyNote.textContent = "1부터 999까지 수량을 입력해 주세요.";
    $("qQtyF").appendChild(qtyNote);
    $("qQty").setAttribute("aria-invalid", "true");
    $("qQty").setAttribute("aria-describedby", qtyNote.id);
  } else if(!needsQty && qtyNote){
    qtyNote.remove(); $("qQty").removeAttribute("aria-invalid"); $("qQty").removeAttribute("aria-describedby");
  }
  if(needsQty){
    $("qK").textContent = "예상 금액";
    $("qV").textContent = "수량 입력";
    $("qN").textContent = "수량을 입력하면 예상 금액을 확인할 수 있어요.";
  } else if(r){
    const p = priceText(r.lo, r.hi);
    $("qK").textContent = r.t ? `예상 금액 · 작업 인원 ${r.t.crew}명` : "예상 금액";
    $("qV").innerHTML = `${esc(p.replace(/원(~?)$/, ""))}<small>원${r.hi == null ? "~" : ""}</small>`;
    const base = r.v && r.v.note ? r.v.note : s.priceNote || "오염 정도와 구조에 따라 현장에서 달라질 수 있어요.";
    const hasPricedOptions = (s.options || []).some(o => !o.quote);
    const minNote = s.min && r.lo === s.min
      ? ` 할인 전 예상 금액은 기본 금액${hasPricedOptions ? "과 금액이 표시된 추가 옵션을 합산한 뒤" : "에"} 최소 금액 ${won(s.min)}원${s.minNote ? "(" + s.minNote + ")" : ""}을 적용해 계산해요.${hasPricedOptions ? " 합산 결과에 따라 옵션을 선택해도 표시 금액이 그대로일 수 있어요." : ""}`
      : "";
    $("qN").textContent = base + (r.onSite.length ? ` ${r.onSite.join("·")}은 별도 현장 견적이에요.` : "") + minNote + weekendNote();
  } else {
    $("qK").textContent = "현장 견적";
    $("qV").innerHTML = `사진 보고<small> 안내</small>`;
    $("qN").textContent = "작업량 차이가 커서 현장 사진을 보고 금액을 알려드려요." + weekendNote();
  }
  $("qKakao").textContent = r || needsQty ? "이 견적으로 카톡 문의" : "카톡으로 사진 보내고 견적 받기";
  if(M){
    const box = $("qMem"); box.hidden = false;
    if(MEMBER) box.innerHTML = needsQty ? `🎟 수량을 입력하면 회원 쿠폰 적용 금액을 확인할 수 있어요.` : r ? `🎟 회원 쿠폰 적용 시 <b>${priceText(Math.max(0, r.lo - M.coupon), r.hi == null ? null : Math.max(0, r.hi - M.coupon))}</b> + ${esc(MEMBER.free)} 무료` : `🎟 회원 쿠폰 ${won(M.coupon)}원 할인 + ${esc(MEMBER.free)} 무료가 적용돼요`;
    else box.innerHTML = `<button type="button" class="mem-join" data-join>🎟 회원가입하면 여기서 <b>${won(M.coupon)}원 더 할인</b> + 무료 서비스 →</button>`;
  }
  const saved = store.set("quote", {svc: cur.svc, v: cur.v, t: cur.t, qty: cur.qty, opts: cur.opts, area: $("qArea").value, date: $("qDate").value});
  let warning = $("qStorageNote");
  if(!saved && !warning){
    warning = document.createElement("p");
    warning.id = "qStorageNote";
    warning.className = "hint";
    warning.setAttribute("role", "status");
    warning.textContent = "이 기기에 견적이 저장되지 않아 새로고침하면 선택이 바뀔 수 있어요.";
    $("qSvc").insertAdjacentElement("afterend", warning);
  } else if(saved && warning) warning.remove();
}
$("qSvc").addEventListener("change", e => { cur = {svc: e.target.value, v: 0, t: null, qty: null, opts: []}; drawForm(); });
function selectChoice(b, attr){
  const active = document.activeElement;
  const focusChoice = [["qVar", "v"], ["qTier", "t"], ["qOpt", "o"], ["qMem", "join"]]
    .find(([id, key]) => $(id).contains(active) && active.matches(`[data-${key}]`));
  const focusGroup = focusChoice ? $(focusChoice[0]) : null;
  const focusAttr = focusChoice ? focusChoice[1] : null;
  const focusIndex = focusChoice ? active.dataset[focusAttr] : null;
  const index = +b.dataset[attr];
  cur[attr] = index;
  drawForm();
  // 다시 그려진 기존 선택 요소로 포커스를 돌려 키보드 탐색 위치를 유지합니다.
  // 선택 그룹 밖에 포커스가 있었다면 다른 요소에서 포커스를 빼앗지 않습니다.
  if(focusIndex !== null){
    const replacement = focusGroup.querySelector(`[data-${focusAttr}="${focusIndex}"]`);
    if(replacement && !replacement.disabled && replacement.getClientRects().length) replacement.focus({preventScroll:true});
  }
}
$("qTier").addEventListener("click", e => { const b = e.target.closest("[data-t]"); if(!b) return; selectChoice(b, "t"); });
$("qVar").addEventListener("click", e => { const b = e.target.closest("[data-v]"); if(!b) return; selectChoice(b, "v"); });
$("qQty").addEventListener("input", e => { cur.qty = e.target.value === "" ? "" : Math.min(999, Math.max(1, parseInt(e.target.value, 10) || 1)); if(e.target.value !== "") e.target.value = cur.qty; calc(); });
$("qQty").addEventListener("change", e => { e.target.value = cur.qty; });
$("qMinus").onclick = () => { cur.qty = Math.max(1, (+cur.qty || 1) - 1); $("qQty").value = cur.qty; calc(); };
$("qPlus").onclick = () => { cur.qty = Math.min(999, (+cur.qty || 0) + 1); $("qQty").value = cur.qty; calc(); };
$("qOpt").addEventListener("change", e => { const i = +e.target.dataset.o; cur.opts = e.target.checked ? [...new Set([...cur.opts, i])] : cur.opts.filter(x => x !== i); calc(); });
$("qArea").addEventListener("change", calc);
$("qDate").addEventListener("change", () => {
  const input = $("qDate");
  input.min = new Date(Date.now() + 9*3600e3).toISOString().slice(0, 10);
  if(input.value && input.value < input.min){ input.value = ""; toast("지난 날짜는 선택할 수 없어요. 희망 날짜를 다시 선택해 주세요."); }
  calc();
});
function validateQuoteDateBeforeSend(){
  if(missingQty()){
    toast("수량을 입력한 뒤 문의해 주세요."); $("qQty").focus(); return false;
  }
  const input = $("qDate");
  input.min = new Date(Date.now() + 9*3600e3).toISOString().slice(0, 10);
  if(input.value && input.value < input.min){
    input.value = ""; calc(); toast("지난 날짜가 지워졌어요. 희망 날짜를 다시 확인해 주세요."); input.focus(); return false;
  }
  return true;
}
window.goSms = u => { location.href = u; };
// 문자로 견적 보내기: 견적 내용이 미리 적힌 문자 창을 엶 (아이폰은 &body=, 안드로이드는 ?body=)
if($("qSms")) $("qSms").onclick = async () => {
  if(!validateQuoteDateBeforeSend()) return;
  const num = (C.sms || "").replace(/[^0-9]/g, ""), body = encodeURIComponent(summary());
  const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const MOBILE = IOS || /Android/i.test(navigator.userAgent);
  if(!MOBILE){   // PC에서는 문자 앱이 없어서 번호와 내용을 안내
    const copied = await copy(summary());
    toast(copied ? `문의 내용을 복사했어요. 휴대폰에서 ${C.sms} 로 문자 보내주세요.` : `복사하지 못했어요. 견적 내용을 확인해 ${C.sms} 로 문자 보내주세요.`);
    return;
  }
  window.goSms(`sms:${num}${IOS ? "&" : "?"}body=${body}`);
};
$("qCopy").onclick = async () => { if(!validateQuoteDateBeforeSend()) return; if(await copy(summary())) toast("문의 내용을 복사했어요. 원하는 곳에 붙여넣어 주세요."); else toast("복사하지 못했어요. 견적 내용을 직접 확인해 주세요."); };
$("qKakao").onclick = async () => {
  if(!validateQuoteDateBeforeSend()) return;
  if(C.kakao) return kakaoSend("카톡으로 견적 문의", summary());
  const copied = await copy(summary());
  toast(copied ? "문의 내용을 복사했어요. 전화로 연결할게요." : "복사하지 못했어요. 견적 내용을 확인해 전화로 문의해 주세요."); setTimeout(() => location.href = "tel:" + phoneDigits, 600);
};
drawForm();

// ── 서비스 분류 칩 ──
document.querySelectorAll("#services .cats .chip").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll("#services .cats .chip").forEach(x => x.setAttribute("aria-pressed", x === b));
  document.querySelectorAll("#svcList li").forEach(li => li.hidden = !!b.dataset.cat && li.dataset.cat !== b.dataset.cat);
}));

// ── 시공 사례 (블로그 후기 자동 연동: update.py 가 cases.json 으로 정리) ──
let CASES = [], caseF = "", caseN = 8;
// 수집된 데이터의 링크는 절대 http(s) 주소만 허용합니다.
function safeCaseLink(value){
  if(typeof value !== "string" || !/^https?:\/\//i.test(value) || /[\s\x00-\x1f\x7f\u0085\\]/u.test(value)) return false;
  const authority = value.match(/^https?:\/\/([^/?#]*)/i)?.[1] || "";
  if(authority.includes("%") || authority.includes("@")) return false;
  try {
    const url = new URL(value);
    const host = url.hostname;
    const domain = /^[a-z0-9.-]+$/i.test(host) && !host.replace(/\.$/, "").split(".").some(part => !part || part.length > 63);
    const ipv6 = /^\[[0-9a-f:.]+\]$/i.test(host);
    const rawHost = authority.replace(/:\d*$/, "").replace(/\.$/, "");
    if(/^\d+\.\d+\.\d+\.\d+$/.test(host) && host !== rawHost) return false;
    if(!rawHost.startsWith("[") && /(?:^|\.)\d+$/.test(rawHost)) {
      if(!/^\d+\.\d+\.\d+\.\d+$/.test(rawHost) || host !== rawHost) return false;
    }
    return (url.protocol === "http:" || url.protocol === "https:") && (domain || ipv6) && !url.username && !url.password;
  } catch(_) { return false; }
}
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
fetch("cases.json?t=" + Date.now(), {cache: "no-store"}).then(r => {
  if(!r.ok) throw new Error("cases unavailable");
  return r.json();
}).then(d => {
  if(!d || !Array.isArray(d.cases)) throw new Error("invalid cases");
  const fields = ["title", "link", "date", "img", "region", "svc", "kind"];
  if(d.cases.some(x => !x || typeof x !== "object" || Array.isArray(x) || fields.some(k => x[k] != null && typeof x[k] !== "string"))) throw new Error("invalid case item");
  const ex = (C.excludeWords || []).map(w => w.replace(/\s/g, ""));
  const all = (d.cases || []).filter(x => safeCaseLink(x.link) && x.title && !ex.some(w => x.title.replace(/\s/g, "").includes(w))).sort((p, q) => (q.date || "").localeCompare(p.date || ""));
  CASES = all.filter(x => (x.kind || "case") === "case");
  const tips = all.filter(x => x.kind === "tip").slice(0, 6);
  if(tips.length){
    $("tipList").innerHTML = tips.map(x => `<li><a href="${esc(x.link)}" target="_blank" rel="noopener"><span>${esc(x.title)}</span><small>${esc((x.date || "").slice(0, 10).replace(/-/g, "."))}</small></a></li>`).join("");
    $("tips").hidden = false;
  }
  if(CASES.length) drawCases();
  else if(C.sample || !BLOGS.length) $("caseList").outerHTML = `<div class="hint">${BLOGS.length ? "블로그 후기를 불러오는 중이에요. 1시간 안에 자동으로 채워져요." : "config.json 의 blog 에 네이버 블로그 아이디를 넣으면, 블로그에 올린 시공 후기가 여기에 자동으로 모여요."}</div>`;
  else $("cases").hidden = true;
}).catch(() => {
  // 조회 실패와 실제 빈 목록을 구분해 방문자가 다른 확인 경로를 알 수 있게 합니다.
  $("cases").hidden = false;
  $("caseChips").replaceChildren();
  const box = document.createElement("div");
  box.className = "hint";
  box.setAttribute("role", "status");
  box.style.gridColumn = "1 / -1";
  const message = document.createElement("p");
  message.textContent = "시공 사례를 불러오지 못했어요. 잠시 후 다시 확인해 주세요.";
  box.append(message);
  const blogIds = [...new Set(BLOGS.filter(id => typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id)))];
  blogIds.forEach((id, i) => {
    const link = document.createElement("a");
    link.href = "https://blog.naver.com/" + encodeURIComponent(id);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = blogIds.length > 1 ? `블로그 ${i + 1}에서 확인하기` : "블로그에서 확인하기";
    link.style.display = "block";
    box.append(link);
  });
  $("caseList").replaceChildren(box);
});

// ── 계절 달력 ──
const nowM = new Date(Date.now() + 9*3600e3).getUTCMonth() + 1;
$("months").innerHTML = C.seasons.map(x => `<div class="mo${x.m === nowM ? " now" : ""}"><b>${x.m}월</b>${x.ids.map(id => { const s = SV.find(v => v.id === id); return s ? `<span>${esc(s.name)}</span>` : ""; }).join("")}</div>`).join("");
const nowEl = document.querySelector(".mo.now");
if(nowEl) $("months").scrollLeft = Math.max(0, nowEl.offsetLeft - 20);


// ── 회원가입 (팝업) ──
// 연동 URL이 설정된 경우 관리자 대장으로도 가입 정보를 전송합니다. 카톡 확인 방식은 유지합니다.
function joinDone(){
  const d = $("joinDone"), m = MEMBER;
  $("joinForm").hidden = true; d.hidden = false;
  d.innerHTML = `<p class="done-k">가입을 환영해요, ${esc(m.name)}님</p>
    <div class="coupon"><span>회원 쿠폰</span><b>${won(M.coupon)}원 할인</b><em>+ ${esc(m.free)} 무료</em><code>${esc(m.code)}</code></div>
    <p class="note">${esc(M.couponTerms)}</p>
    <p class="err" role="status" id="jStorageNote"${memberSaved ? " hidden" : ""}>${esc(memberStorageWarning)}</p>
    <p class="step-k"><b>마지막 단계</b> · 아래 버튼으로 가입 내용을 카톡에 보내 주시면 쿠폰이 등록돼요.</p>
    <button class="btn glove" type="button" id="jKakao">카톡으로 가입 완료하기</button>
    ${M.referral ? `<button class="btn line small" type="button" data-invite>친구 초대하고 ${won(M.referral.point)}P 받기</button>` : ""}
    <button class="link member-clear" type="button" id="jClearDevice">이 기기의 회원정보 지우기</button>
    <button class="link" type="button" data-close>나중에 보낼게요</button>`;
  let memberKakaoAttempt = 0;
  $("jKakao").onclick = async () => {
    const text = `[${C.name} 회원가입]\n이름: ${m.name}\n연락처: ${m.phone}\n지역: ${m.area || "-"}\n무료 서비스: ${m.free}\n쿠폰번호: ${m.code}${m.ref ? `\n추천인 코드: ${m.ref}` : ""}\n이벤트 소식: ${m.ad ? "받음" : "안 받음"}`;
    const button = $("jKakao"), join = $("join");
    const session = typeof window.modalSession === "function" ? window.modalSession(join) : null;
    if(!session || typeof window.clearHiddenMemberSheet !== "function"){
      toast("회원정보와 쿠폰번호를 먼저 확인한 뒤 페이지를 새로고침해 주세요."); return;
    }
    MEMBER.sent = true; memberSaved = store.set("member", MEMBER);
    $("jStorageNote").hidden = memberSaved;
    const attempt = ++memberKakaoAttempt;
    const isCurrent = () => MEMBER === m && button.isConnected && !join.hidden && window.modalSession(join) === session && attempt === memberKakaoAttempt;
    kakaoSend("카톡으로 가입 완료하기", text, memberSaved ? "" : memberStorageWarning, {isCurrent, memberData:true});
  };
  $("jClearDevice").onclick = () => {
    const msg = "이 사이트가 이 브라우저에 저장한 회원정보와 쿠폰번호가 지워져요. 다른 탭은 먼저 닫아 주세요. 클립보드에 복사된 내용, 관리자에게 전송 중이거나 접수된 정보와 카톡 대화는 지워지지 않아요. 계속할까요?";
    if(!window.confirm(msg)) return;
    try {
      localStorage.removeItem("member");
      if(localStorage.getItem("member") !== null) throw new Error("Member data remains");
    } catch(e) { toast("기기 정보 삭제에 실패했어요. 브라우저 설정을 확인해 주세요."); return; }
    MEMBER = null; memberSaved = false;
    if(typeof window.clearHiddenMemberSheet === "function") window.clearHiddenMemberSheet();
    else {
      // 예전 공통 스크립트가 남긴 회원 안내는 제목과 내용으로 확인한 경우만 지웁니다.
      const sheet = $("sheet"), title = $("sheetT"), body = $("sheetB"), pre = body?.querySelector(".send-pre");
      if(sheet?.hidden && title?.textContent === "카톡으로 가입 완료하기" && pre?.textContent.startsWith(`[${C.name} 회원가입]\n`)){
        body.replaceChildren(); title.textContent = "";
      }
    }
    d.replaceChildren(); d.hidden = true;
    $("jName").value = ""; $("jPhone").value = ""; $("jArea").value = "";
    $("jAgree").checked = false; $("jAd").checked = false; $("jErr").textContent = "";
    $("joinForm").hidden = false;
    calc(); $("jName").focus();
    toast("이 기기의 회원정보를 지웠어요. 관리자에게 접수된 정보는 별도 문의해 주세요.");
  };
}
// 친구 초대: 내 쿠폰번호가 들어간 링크를 공유 (친구가 가입하면 카톡 가입 메시지에 추천인 코드가 함께 와요)
async function invite(){
  if(!MEMBER){ openJoin(); return; }
  const url = (C.siteUrl || location.origin).replace(/\/$/, "") + "/?ref=" + MEMBER.code;
  const text = `${C.name} 회원가입하면 ${won(M.coupon)}원 할인 쿠폰 + 무료 서비스 1가지를 바로 줘요. 내 초대 링크로 가입해 봐요!`;
  if(navigator.share && !/KAKAOTALK|NAVER|Instagram|FBAN|FBAV|Line\//i.test(navigator.userAgent)){
    try { await navigator.share({title: C.name, text, url}); return; } catch(e){ if(e && e.name === "AbortError") return; }
  }
  if(await copy(text + "\n" + url)) toast("초대 링크를 복사했어요. 친구에게 카톡으로 붙여넣어 보내세요.");
}
let joinOpened = false;
function openJoin(){
  if(!M) return;
  joinOpened = true;
  if(MEMBER) joinDone(); else {
    $("joinForm").hidden = false; $("joinDone").hidden = true;
    const rb = $("jRef");
    if(rb){
      rb.hidden = !REF && !refNotice;
      rb.textContent = [REF ? `친구 초대로 오셨네요! 추천인 코드 ${REF}가 가입 요청에 함께 담겨요.` : "", refNotice].filter(Boolean).join(" ");
    }
  }
  openModal("join");
}
if(M){
  document.addEventListener("click", e => {
    if(e.target.closest("[data-join]")){ e.preventDefault(); openJoin(); }
    if(e.target.closest("[data-later]")){ store.set("joinLater", Date.now()); closeModal($("join")); }
    if(e.target.closest("[data-invite]")){ e.preventDefault(); invite(); }
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
              ad: $("jAgree").checked && $("jAd").checked, code, ref: REF && REF !== code ? REF : "", joined: new Date().toISOString().slice(0, 10)};
    memberSaved = store.set("member", MEMBER);
    // Firebase가 설정되어 있으면 회원 가입 요청을 비공개 Firestore에 전송합니다.
    // 실패 시 카카오톡 가입 확인 절차를 그대로 안내합니다.
    if(C.firebase && C.firebase.apiKey && C.firebase.projectId){
      const submittedMember = MEMBER;
      import('./member-sync.js').then(mod => mod.submitMember(C.firebase, submittedMember))
        .then(() => { if(MEMBER === submittedMember) toast('회원정보 접수 요청이 완료됐어요. 카톡으로 가입을 확인해 주세요.'); })
        .catch(err => { console.warn('회원 접수 실패', err); if(MEMBER === submittedMember) toast('자동 접수가 되지 않았어요. 카톡으로 가입을 완료해 주세요.'); });
    }
    // 관리자 대장 연결이 설정된 경우 가입 정보를 접수합니다.
    // Google Apps Script 웹앱은 교차 출처 응답을 브라우저에서 검증할 수 없으므로
    // 전송 성공을 단정하지 않고 카카오톡 확인 절차를 그대로 유지합니다.
    if(C.memberBackendUrl && /^https:\/\/script\.google\.com\/macros\/s\//.test(C.memberBackendUrl)){
      try {
        const payload = {kind:"join", name:MEMBER.name,phone:MEMBER.phone,area:MEMBER.area,
          free:MEMBER.free,ad:MEMBER.ad,code:MEMBER.code,ref:MEMBER.ref,joined:MEMBER.joined,
          couponAmount:M.coupon,source:"ok-clean.github.io"};
        const form = document.createElement("form");
        form.method="POST"; form.action=C.memberBackendUrl; form.target="okclean_member_sink";
        form.style.display="none";
        const input=document.createElement("input"); input.type="hidden";input.name="payload";
        input.value=JSON.stringify(payload);form.appendChild(input);
        let frame=document.getElementById("okclean_member_sink");
        if(!frame){frame=document.createElement("iframe");frame.name="okclean_member_sink";
          frame.id="okclean_member_sink";frame.hidden=true;document.body.appendChild(frame);}
        document.body.appendChild(form);form.submit();setTimeout(()=>form.remove(),1500);
      }catch(err){console.warn("회원 대장 접수 요청 실패",err);}
    }
    joinDone(); calc();
  };
  // 처음 방문한 사람에게 한 번 띄우기 (가입했거나 '다음에'를 누른 뒤 7일 동안은 안 띄움)
  const later = store.get("joinLater", 0);
  if(!MEMBER && Date.now() - later > 7 * 864e5 && !/src=app/.test(location.search)){
    // 최초 대기 시간은 유지하고, 둘러보거나 입력하는 동안에는 방해하지 않습니다.
    let busy = 0, waitingForVisibility = false;
    const markBusy = () => { busy = Date.now(); };
    const activityEvents = ["pointerdown", "keydown", "click", "input", "change", "focusin", "wheel", "touchmove"];
    activityEvents.forEach(type => document.addEventListener(type, markBusy, {passive: true}));
    window.addEventListener("scroll", markBusy, {passive: true});
    const cleanup = () => {
      activityEvents.forEach(type => document.removeEventListener(type, markBusy));
      window.removeEventListener("scroll", markBusy);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    const onVisibility = () => {
      if(!document.hidden){
        markBusy();
        if(waitingForVisibility){
          waitingForVisibility = false;
          setTimeout(tryPop, 15000);
        }
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    const tryPop = () => {
      if(joinOpened || MEMBER || store.get("member", null) || Date.now() - store.get("joinLater", 0) <= 7 * 864e5){ cleanup(); return; }
      if(document.hidden){ waitingForVisibility = true; return; }
      const remaining = 15000 - (Date.now() - busy);
      if(remaining > 0){ setTimeout(tryPop, remaining); return; }
      cleanup();
      if(document.querySelector(".modal:not([hidden])")) return;
      store.set("joinLater", Date.now());
      openJoin();
    };
    setTimeout(tryPop, REF ? 4000 : 25000);   // 초대 링크로 온 사람에게는 빨리 보여줌
  }
  calc();
}
