// 모든 페이지 공통: 공유하기, 휴대폰 앱(홈 화면) 설치, 팝업 창
(function(){
  const S = window.SITE || {};
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
  const UA = navigator.userAgent;
  const IS_IOS = /iPhone|iPad|iPod/.test(UA) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const IN_APP = /KAKAOTALK|NAVER|Instagram|FBAN|FBAV|Line\//i.test(UA);
  const STANDALONE = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

  // 좁은 화면에서 키보드 초점이 메뉴 밖에 걸리면 메뉴만 수평으로 움직입니다.
  const mainNav = document.querySelector('.top nav');
  if(mainNav) mainNav.addEventListener('focusin', e => {
    const link = e.target.closest('a');
    if(!link || !mainNav.contains(link) || mainNav.scrollWidth <= mainNav.clientWidth) return;
    const navRect = mainNav.getBoundingClientRect(), linkRect = link.getBoundingClientRect();
    const left = navRect.left + mainNav.clientLeft + 6;
    const right = navRect.left + mainNav.clientLeft + mainNav.clientWidth - 6;
    if(linkRect.left < left) mainNav.scrollLeft += linkRect.left - left;
    else if(linkRect.right > right) mainNav.scrollLeft += linkRect.right - right;
  });

  // ── 토스트·복사 ──
  window.toast = function(msg){
    let t = document.querySelector(".toast");
    if(!t){ t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("on");
    clearTimeout(window.toast.tm); window.toast.tm = setTimeout(() => t.classList.remove("on"), 2600);
  };
  window.copyText = async function(text, shouldFallback = () => true){
    try { await navigator.clipboard.writeText(text); return true; }
    catch(e){
      // 창이 교체되었거나 더 최근 재시도가 끝났다면 오래된 내용을 다시 복사하지 않습니다.
      if(!shouldFallback()) return false;
      const previous = document.activeElement;
      const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand("copy"); } catch(_) {}
      const hadFocus = document.activeElement === ta;
      ta.remove();
      if(hadFocus && previous && previous !== document.body && previous.isConnected && !previous.disabled && previous.getClientRects().length && getComputedStyle(previous).visibility !== "hidden" && typeof previous.focus === "function") previous.focus({preventScroll:true});
      return ok;
    }
  };

  // ── 팝업 창 열고 닫기 ──
  const modalOpeners = new WeakMap();
  const modalSessions = new WeakMap();
  window.modalSession = m => modalSessions.get(m);
  let sheetHasMemberData = false;
  window.openModal = function(id, opener = document.activeElement){
    const m = $(id); if(!m || !m.hidden) return;
    modalOpeners.set(m, opener);
    modalSessions.set(m, {});
    m.hidden = false; document.body.classList.add("modal-open");
    const candidates = m.querySelectorAll('input:not([type="hidden"]), select, textarea, button:not(.x), a[href]');
    const first = [...candidates].find(el => !el.disabled && el.getClientRects().length) || m.querySelector("button.x");
    if(first) setTimeout(() => { if(!m.hidden && first.isConnected && first.getClientRects().length) first.focus(); }, 50);
  };
  window.closeModal = function(m){
    if(!m || m.hidden) return;
    m.hidden = true;
    if(!document.querySelector(".modal:not([hidden])")) document.body.classList.remove("modal-open");
    const opener = modalOpeners.get(m);
    modalOpeners.delete(m);
    modalSessions.delete(m);
    if(opener && opener.isConnected && opener.getClientRects().length && typeof opener.focus === "function") opener.focus();
  };
  function sheet(title, html, opener){ document.querySelectorAll(".modal:not([hidden])").forEach(window.closeModal); sheetHasMemberData = false; $("sheetT").textContent = title; $("sheetB").innerHTML = html; window.openModal("sheet", opener || document.activeElement); }
  // 로컬 회원 삭제 시 닫힌 회원 안내의 본문만 제거합니다. 다른 안내창은 보존합니다.
  window.clearHiddenMemberSheet = () => {
    if(sheetHasMemberData && $("sheet").hidden){
      $("sheetB").replaceChildren(); $("sheetT").textContent = ""; sheetHasMemberData = false;
    }
  };

  // ── 카톡으로 보내기: 오픈채팅은 글을 미리 넣어 열 수 없어서(카카오 정책), 자동 복사 + 붙여넣기 안내 ──
  window.kakaoSend = async function(title, text, notice = "", options = {}){
    const isCurrent = options.isCurrent || (() => true);
    const active = document.activeElement, activeModal = active && active.closest(".modal:not([hidden])");
    const opener = activeModal ? (modalOpeners.get(activeModal) || active) : active;
    const ok = await window.copyText(text, isCurrent);
    // 회원정보가 삭제되었거나 가입창이 바뀌었으면 이전 안내를 열지 않습니다.
    if(!isCurrent()) return;
    sheet(title, `${notice ? `<p class="err" role="status">${esc(notice)}</p>` : ""}<p class="${ok ? "send-ok" : "err"}" data-copy-status role="status">${ok ? "✓ 아래 내용을 복사해 두었어요" : "자동 복사하지 못했어요. 아래 내용을 선택해 복사해 주세요. 휴대폰에서는 길게 눌러 복사할 수 있어요."}</p>
      <pre class="send-pre">${esc(text)}</pre>
      <ol class="send-steps"><li>아래 <b>카톡 열기</b>를 누르세요.</li><li>대화 입력칸을 <b>길게 눌러 '붙여넣기'</b> 하세요.</li><li><b>전송</b>하면 끝! 현장 사진도 함께 보내주시면 더 정확해요.</li></ol>
      <a class="btn glove" href="${esc(S.kakao)}" target="_blank" rel="noopener" data-close>카톡 열기</a>
      ${ok ? "" : `<button class="btn line small" type="button" data-copy-again style="width:100%;margin-top:8px">다시 복사하기</button>`}`, opener);
    sheetHasMemberData = options.memberData === true;
    const again = $("sheet").querySelector("[data-copy-again]");
    const status = $("sheet").querySelector("[data-copy-status]");
    let retry = 0;
    if(again) again.onclick = async () => {
      const attempt = ++retry, focused = document.activeElement === again;
      const copied = await window.copyText(text, () => attempt === retry && again.isConnected && !$("sheet").hidden);
      // 기다리는 사이 창을 닫거나 새 창을 연 경우, 이전 결과를 표시하지 않습니다.
      if(attempt !== retry || !again.isConnected || $("sheet").hidden) return;
      status.className = copied ? "send-ok" : "err";
      status.textContent = copied ? "✓ 아래 내용을 복사했어요." : "복사하지 못했어요. 아래 내용을 선택해 복사해 주세요. 휴대폰에서는 길게 눌러 복사할 수 있어요.";
      // 임시 복사 칸이 포커스를 잃게 한 경우에만 기존 버튼으로 되돌립니다.
      if(focused && document.activeElement === document.body) again.focus({preventScroll:true});
    };
  };
  document.addEventListener("click", e => {
    if(e.target.closest("[data-close]") || e.target.classList.contains("modal")) window.closeModal(e.target.closest(".modal"));
  });
  document.addEventListener("keydown", e => {
    const dialogs = [...document.querySelectorAll(".modal:not([hidden])")];
    if(e.key === "Escape"){ dialogs.forEach(window.closeModal); return; }
    if(e.key !== "Tab" || !dialogs.length) return;
    const modal = dialogs[dialogs.length - 1];
    const items = [...modal.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length && getComputedStyle(el).visibility !== "hidden");
    if(!items.length){ e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1], current = document.activeElement;
    if(!modal.contains(current)){ e.preventDefault(); (e.shiftKey ? last : first).focus(); }
    else if(e.shiftKey && current === first){ e.preventDefault(); last.focus(); }
    else if(!e.shiftKey && current === last){ e.preventDefault(); first.focus(); }
  });

  // ── 공유하기 ──
  const shareUrl = () => {
    let myCode = ""; try { myCode = (JSON.parse(localStorage.getItem("member") || "null") || {}).code || ""; } catch(e){}
    return (S.url || location.origin).replace(/\/$/, "") + (myCode ? "/?ref=" + myCode : "/?src=share");
  };
  const shareText = `${S.name} · ${S.tagline}\n평수만 넣으면 청소 견적이 바로 나와요.`;
  async function share(){
    const url = shareUrl();
    if(navigator.share && !IN_APP){
      try { await navigator.share({title: S.name, text: shareText, url}); return; }
      catch(e){ if(e && e.name === "AbortError") return; }
    }
    const u = encodeURIComponent(url), t = encodeURIComponent(shareText);
    sheet("친구에게 공유하기", `<div class="share-grid">
      <button type="button" data-copy-link><span class="ic">🔗</span>링크 복사</button>
      <a href="https://band.us/plugin/share?body=${encodeURIComponent(shareText + "\n" + url)}&route=${encodeURIComponent(location.host)}" target="_blank" rel="noopener"><span class="ic">B</span>밴드</a>
      <a href="https://www.facebook.com/sharer/sharer.php?u=${u}" target="_blank" rel="noopener"><span class="ic">f</span>페이스북</a>
      <a href="https://twitter.com/intent/tweet?text=${t}&url=${u}" target="_blank" rel="noopener"><span class="ic">X</span>X</a>
    </div><p class="hint">카카오톡은 링크를 복사한 뒤 대화방에 붙여넣으면 로고와 함께 미리보기가 떠요.</p>`);
  }
  document.addEventListener("click", async e => {
    if(e.target.closest("[data-share]")) share();
    if(e.target.closest("[data-copy-link]")){ if(await window.copyText(shareText + "\n" + shareUrl())){ window.closeModal($("sheet")); window.toast("링크를 복사했어요. 카톡이나 문자에 붙여넣어 주세요."); } }
  });

  // ── 휴대폰 앱(홈 화면) 설치 ──
  // 카톡·네이버 같은 앱 안의 브라우저에서는 설치가 안 돼서, 크롬(아이폰은 사파리)으로 자동으로 옮긴 뒤 설치 창을 띄움
  const IS_ANDROID = /Android/i.test(UA), IS_KAKAO = /KAKAOTALK/i.test(UA);
  const WANT = new URLSearchParams(location.search).get("install") === "1";
  let deferred = null;
  const showInstall = on => document.querySelectorAll("[data-install]").forEach(b => b.hidden = !on);
  if(!STANDALONE) showInstall(true);
  const installUrl = () => { const u = new URL(location.href); u.searchParams.set("install", "1"); u.hash = ""; return u.toString(); };
  function openOutside(){
    const url = installUrl();
    if(IS_KAKAO){ location.href = "kakaotalk://web/openExternal?url=" + encodeURIComponent(url); return true; }   // 카톡: 기본 브라우저로 열기
    if(IS_ANDROID){                                                                                                // 그 외 안드로이드 앱: 크롬으로 열기
      const u = new URL(url);
      location.href = `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url)};end`;
      return true;
    }
    return false;
  }
  function readySheet(){
    sheet("앱 설치 준비가 끝났어요", `<p class="lead-s">아래 버튼을 누르고 <b>설치</b>를 누르면 홈 화면에 <b>${esc(S.name)}</b> 아이콘이 생겨요.</p><button class="btn glove" type="button" data-install-now style="width:100%">지금 설치하기</button>`);
  }
  async function promptNow(){
    if(!deferred) return false;
    window.closeModal($("sheet"));
    deferred.prompt(); const r = await deferred.userChoice; deferred = null;
    if(r.outcome === "accepted") showInstall(false);
    return true;
  }
  window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault(); deferred = e; showInstall(true);
    if(WANT && !STANDALONE) readySheet();   // 카톡에서 넘어온 경우: 바로 설치 버튼 보여주기
  });
  window.addEventListener("appinstalled", () => { deferred = null; showInstall(false); window.toast("홈 화면에 앱을 추가했어요."); });
  const IOS_STEPS = `<ol class="steps-mini"><li>화면 아래(또는 위) <b>공유 버튼(□↑)</b>을 누르세요.</li><li>목록을 내려 <b>홈 화면에 추가</b>를 누르세요.</li><li>오른쪽 위 <b>추가</b>를 누르면 홈 화면에 아이콘이 생겨요.</li></ol>`;
  async function install(){
    if(await promptNow()) return;
    if(IN_APP && openOutside()){
      sheet("브라우저로 옮기는 중이에요", `<p class="lead-s">크롬(또는 기본 브라우저)이 열리면 새 화면에서 <b>지금 설치하기</b>를 누르면 끝나요.</p><p class="hint">화면이 안 바뀌면 오른쪽 위 <b>⋮ 메뉴 → 다른 브라우저로 열기</b>를 눌러 주세요.</p>`);
      return;
    }
    let steps;
    if(IN_APP) steps = `<ol class="steps-mini"><li>오른쪽 위(또는 아래) <b>⋯ 메뉴</b>를 누르세요.</li><li><b>Safari로 열기</b>를 고르세요.</li></ol>${IOS_STEPS}`;
    else if(IS_IOS) steps = IOS_STEPS;
    else steps = `<ol class="steps-mini"><li>브라우저 오른쪽 위 <b>⋮ 메뉴</b>를 누르세요.</li><li><b>홈 화면에 추가</b> 또는 <b>앱 설치</b>를 누르세요.</li><li><b>설치</b>를 누르면 홈 화면에 아이콘이 생겨요.</li></ol><p class="hint">설치 창이 바로 안 뜨면 몇 초 뒤 다시 눌러 주세요.</p>`;
    sheet("휴대폰에 앱으로 설치하기", `<p class="lead-s">홈 화면에 <b>${esc(S.name)}</b> 아이콘이 생겨서, 다음부터 한 번에 견적을 볼 수 있어요.</p>${steps}`);
  }
  // 넘어온 뒤 아이폰 사파리면 방법 안내를 바로 띄움 (아이폰은 버튼 한 번 설치가 애플 정책상 안 됨)
  if(WANT && !STANDALONE && IS_IOS && !IN_APP) window.addEventListener("load", () => setTimeout(install, 600));
  // 안드로이드에서 설치 창이 준비 안 된 경우 대비: 잠시 뒤 안내
  if(WANT && !STANDALONE && !IS_IOS && !IN_APP) setTimeout(() => { if(!deferred && $("sheet").hidden) install(); }, 3500);
  document.addEventListener("click", e => { if(e.target.closest("[data-install-now]")) promptNow(); });
  document.addEventListener("click", e => { if(e.target.closest("[data-install]")) install(); });

  if("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register((S.root || "") + "sw.js").catch(() => {}));
})();
