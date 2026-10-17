// 모든 페이지 공통: 공유하기, 휴대폰 앱(홈 화면) 설치, 팝업 창
(function(){
  const S = window.SITE || {};
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
  const UA = navigator.userAgent;
  const IS_IOS = /iPhone|iPad|iPod/.test(UA) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const IN_APP = /KAKAOTALK|NAVER|Instagram|FBAN|FBAV|Line\//i.test(UA);
  const STANDALONE = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

  // ── 토스트·복사 ──
  window.toast = function(msg){
    let t = document.querySelector(".toast");
    if(!t){ t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("on");
    clearTimeout(window.toast.tm); window.toast.tm = setTimeout(() => t.classList.remove("on"), 2600);
  };
  window.copyText = async function(text){
    try { await navigator.clipboard.writeText(text); return true; }
    catch(e){
      const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand("copy"); } catch(_) {}
      ta.remove(); return ok;
    }
  };

  // ── 팝업 창 열고 닫기 ──
  window.openModal = function(id){ const m = $(id); if(!m) return; m.hidden = false; document.body.classList.add("modal-open"); const f = m.querySelector("input,button:not(.x)"); if(f) setTimeout(() => f.focus(), 50); };
  window.closeModal = function(m){ if(!m) return; m.hidden = true; if(!document.querySelector(".modal:not([hidden])")) document.body.classList.remove("modal-open"); };
  function sheet(title, html){ document.querySelectorAll(".modal:not([hidden])").forEach(window.closeModal); $("sheetT").textContent = title; $("sheetB").innerHTML = html; window.openModal("sheet"); }

  // ── 카톡으로 보내기: 오픈채팅은 글을 미리 넣어 열 수 없어서(카카오 정책), 자동 복사 + 붙여넣기 안내 ──
  window.kakaoSend = async function(title, text){
    const ok = await window.copyText(text);
    sheet(title, `<p class="send-ok">${ok ? "✓ 아래 내용을 복사해 두었어요" : "아래 내용을 길게 눌러 복사해 주세요"}</p>
      <pre class="send-pre">${esc(text)}</pre>
      <ol class="send-steps"><li>아래 <b>카톡 열기</b>를 누르세요.</li><li>대화 입력칸을 <b>길게 눌러 '붙여넣기'</b> 하세요.</li><li><b>전송</b>하면 끝! 현장 사진도 함께 보내주시면 더 정확해요.</li></ol>
      <a class="btn glove" href="${esc(S.kakao)}" target="_blank" rel="noopener" data-close>카톡 열기</a>
      ${ok ? "" : `<button class="btn line small" type="button" data-copy-again style="width:100%;margin-top:8px">다시 복사하기</button>`}`);
    const again = document.querySelector("[data-copy-again]");
    if(again) again.onclick = async () => { if(await window.copyText(text)) window.toast("복사했어요."); };
  };
  document.addEventListener("click", e => {
    if(e.target.closest("[data-close]") || e.target.classList.contains("modal")) window.closeModal(e.target.closest(".modal"));
  });
  document.addEventListener("keydown", e => { if(e.key === "Escape") document.querySelectorAll(".modal:not([hidden])").forEach(window.closeModal); });

  // ── 공유하기 ──
  let myCode = ""; try { myCode = (JSON.parse(localStorage.getItem("member") || "null") || {}).code || ""; } catch(e){}
  const shareUrl = (S.url || location.origin).replace(/\/$/, "") + (myCode ? "/?ref=" + myCode : "/?src=share");   // 회원이면 내 초대 링크로 공유
  const shareText = `${S.name} · ${S.tagline}\n평수만 넣으면 청소 견적이 바로 나와요.`;
  async function share(){
    if(navigator.share && !IN_APP){
      try { await navigator.share({title: S.name, text: shareText, url: shareUrl}); return; }
      catch(e){ if(e && e.name === "AbortError") return; }
    }
    const u = encodeURIComponent(shareUrl), t = encodeURIComponent(shareText);
    sheet("친구에게 공유하기", `<div class="share-grid">
      <button type="button" data-copy-link><span class="ic">🔗</span>링크 복사</button>
      <a href="https://band.us/plugin/share?body=${encodeURIComponent(shareText + "\n" + shareUrl)}&route=${encodeURIComponent(location.host)}" target="_blank" rel="noopener"><span class="ic">B</span>밴드</a>
      <a href="https://www.facebook.com/sharer/sharer.php?u=${u}" target="_blank" rel="noopener"><span class="ic">f</span>페이스북</a>
      <a href="https://twitter.com/intent/tweet?text=${t}&url=${u}" target="_blank" rel="noopener"><span class="ic">X</span>X</a>
    </div><p class="hint">카카오톡은 링크를 복사한 뒤 대화방에 붙여넣으면 로고와 함께 미리보기가 떠요.</p>`);
  }
  document.addEventListener("click", async e => {
    if(e.target.closest("[data-share]")) share();
    if(e.target.closest("[data-copy-link]")){ if(await window.copyText(shareText + "\n" + shareUrl)){ window.closeModal($("sheet")); window.toast("링크를 복사했어요. 카톡이나 문자에 붙여넣어 주세요."); } }
  });

  // ── 휴대폰 앱(홈 화면) 설치 ──
  let deferred = null;
  const showInstall = on => document.querySelectorAll("[data-install]").forEach(b => b.hidden = !on);
  if(!STANDALONE) showInstall(true);          // 설치 안 된 상태면 버튼 표시 (방법은 기기마다 다르게 안내)
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferred = e; showInstall(true); });
  window.addEventListener("appinstalled", () => { deferred = null; showInstall(false); window.toast("홈 화면에 앱을 추가했어요."); });
  async function install(){
    if(deferred){ deferred.prompt(); const r = await deferred.userChoice; deferred = null; if(r.outcome === "accepted") showInstall(false); return; }
    let steps;
    if(IN_APP) steps = `<ol class="steps-mini"><li>오른쪽 위(또는 아래) <b>⋮ 메뉴</b>를 누르세요.</li><li><b>다른 브라우저로 열기</b>(Safari·Chrome)를 고르세요.</li><li>열린 화면에서 다시 <b>앱 설치</b>를 누르면 돼요.</li></ol><p class="hint">카카오톡·네이버 앱 안에서는 바로 설치가 안 돼요.</p>`;
    else if(IS_IOS) steps = `<ol class="steps-mini"><li>화면 아래 <b>공유 버튼(□↑)</b>을 누르세요.</li><li>목록을 내려 <b>홈 화면에 추가</b>를 누르세요.</li><li>오른쪽 위 <b>추가</b>를 누르면 홈 화면에 아이콘이 생겨요.</li></ol>`;
    else steps = `<ol class="steps-mini"><li>Chrome 오른쪽 위 <b>⋮ 메뉴</b>를 누르세요.</li><li><b>홈 화면에 추가</b> 또는 <b>앱 설치</b>를 누르세요.</li><li><b>설치</b>를 누르면 홈 화면에 아이콘이 생겨요.</li></ol>`;
    sheet("휴대폰에 앱으로 설치하기", `<p class="lead-s">홈 화면에 <b>${esc(S.name)}</b> 아이콘이 생겨서, 다음부터 한 번에 견적을 볼 수 있어요.</p>${steps}`);
  }
  document.addEventListener("click", e => { if(e.target.closest("[data-install]")) install(); });

  if("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register((S.root || "") + "sw.js").catch(() => {}));
})();
