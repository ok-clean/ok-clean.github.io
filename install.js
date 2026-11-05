// 고객용·관리자용 공통 설치 안내. 설치창과 외부 브라우저 이동은 사용자 클릭으로만 실행합니다.
(function () {
  'use strict';
  const script = document.currentScript;
  if (!script || window.OKCleanInstall) return;
  const root = new URL('.', script.src);
  const isAdmin = script.dataset.app === 'admin';
  const appName = isAdmin ? '오케이청소 관리자' : '오케이청소';
  const appUrl = new URL(isAdmin ? 'admin/' : 'app/', root);
  const ua = navigator.userAgent || '';
  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isInApp = /KAKAOTALK|NAVER|Instagram|FBAN|FBAV|Line\/|; wv\)/i.test(ua);
  // Chrome Custom Tabs can have the same UA as Chrome. Keep an optional browser
  // handoff even when showing menu guidance; do not require reopening Chrome.
  const isChromeLike = /Chrome\/\d+/i.test(ua) && !/SamsungBrowser|EdgA|OPR/i.test(ua);
  const isSamsungBrowser = /SamsungBrowser/i.test(ua);
  const current = new URL(location.href);
  const returned = current.searchParams.get('install') === '1';
  const failedHandoff = returned && current.searchParams.get('install_fallback') === '1';
  const displayMode = window.matchMedia('(display-mode: standalone)');
  // Display mode identifies an app window, not which PWA owns it. In particular,
  // an old customer app with scope '/' can open the administrator page inside it.
  const inAppWindow = () => displayMode.matches || navigator.standalone === true;
  const escape = value => String(value).replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
  let pending = null;
  let prompting = false;
  let requested = false;
  let notice = '';
  let dialog = null;
  let dialogActive = false;
  let returnFocus = null;
  let oldOverflow = '';

  // Canonical paths keep the customer and administrator apps separate. Retain referral attribution only.
  const continuation = new URL(appUrl);
  continuation.searchParams.set('install', '1');
  if (!isAdmin && current.searchParams.has('ref')) continuation.searchParams.set('ref', current.searchParams.get('ref').slice(0, 160));
  const fallback = new URL(continuation);
  fallback.searchParams.set('install_fallback', '1');
  const chromeIntent = `intent://${continuation.host}${continuation.pathname}${continuation.search}#Intent;scheme=${continuation.protocol.slice(0, -1)};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(fallback.href)};end`;

  const chromeIcon = '<svg class="ok-install-chrome" viewBox="0 0 24 24" aria-hidden="true"><path fill="#ea4335" d="M12 2a10 10 0 0 1 8.66 5H12a5 5 0 0 0-4.33 7.5L3.34 7A10 10 0 0 1 12 2Z"/><path fill="#fbbc05" d="M20.66 7a10 10 0 0 1-8.66 15l4.33-7.5A5 5 0 0 0 12 7Z"/><path fill="#34a853" d="M12 22A10 10 0 0 1 3.34 7l4.33 7.5a5 5 0 0 0 8.66 0Z"/><circle cx="12" cy="12" r="4.5" fill="#4285f4" stroke="white"/></svg>';
  const shareIcon = '<svg class="ok-install-inline-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 9H5v12h14V9h-3M12 15V2m-4 4 4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const steps = rows => `<ol class="ok-install-steps">${rows.map(row => `<li>${row}</li>`).join('')}</ol>`;
  const copyButton = primary => `<button type="button" class="ok-install-${primary ? 'primary' : 'secondary'}" data-install-action="copy"${primary ? ' data-install-primary' : ''}>주소 복사${primary ? '하기' : ''}</button>`;
  const chromeButton = primary => `<a class="ok-install-${primary ? 'primary' : 'secondary'}" href="${escape(chromeIntent)}" data-install-action="chrome"${primary ? ' data-install-primary' : ''}>${chromeIcon}${primary ? 'Chrome에서 계속' : 'Chrome에서 열기'}</a>`;
  const closeButton = () => '<button type="button" class="ok-install-primary" data-install-action="close" data-install-primary>안내 닫기</button>';
  const manualHelp = () => `<details class="ok-install-details"><summary>설치창이 나오지 않나요?</summary><p>Chrome 주소창에 아래 복사한 주소를 직접 넣어 주세요. 메뉴 <b>⋮</b>에서 <b>설치 및 바로가기 만들기</b> 또는 <b>홈 화면에 추가</b>를 선택하세요.</p><p>이미 설치했다면 홈 화면의 <b>${escape(appName)}</b> 아이콘을 눌러 주세요.</p></details>`;
  const browserFallback = () => `<details class="ok-install-details"><summary>설치 메뉴가 보이지 않나요?</summary><p>다른 앱 안에서 열었다면 Chrome에서 다시 열어 주세요.</p>${chromeButton(false)}${copyButton(false)}</details>`;

  function refreshButtons() {
    document.querySelectorAll('[data-install]').forEach(button => {
      button.hidden = false;
      button.disabled = prompting;
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-controls', 'okInstallDialog');
      button.setAttribute('aria-expanded', String(dialogActive));
      const label = button.querySelector('[data-install-label], span') || button;
      label.textContent = requested ? '설치 확인' : '앱 설치';
    });
  }

  function setStatus(text) {
    const status = dialog && dialog.querySelector('#ok-install-status');
    if (status) {
      status.textContent = text;
      status.hidden = !text;
    }
  }

  function render() {
    if (!dialog) return;
    let title, description, content;
    if (requested) {
      title = '설치를 시작했어요';
      description = `잠시 후 홈 화면에서 ${appName} 아이콘을 확인하세요.`;
      content = '<div class="ok-install-success" aria-hidden="true">✓</div><button type="button" class="ok-install-primary" data-install-action="close" data-install-primary>확인</button>';
    } else if (pending) {
      title = '홈 화면에 앱을 추가해요';
      description = '아래 버튼을 누른 뒤, 휴대폰 설치창에서 설치를 눌러 주세요.';
      content = `<button type="button" class="ok-install-primary" data-install-action="install" data-install-primary>앱 설치</button><p class="ok-install-hint">${isAdmin ? '설치 후에도 관리자 로그인이 필요해요.' : '다음부터 아이콘을 눌러 바로 견적을 볼 수 있어요.'}</p>`;
    } else if (failedHandoff) {
      title = 'Chrome을 열지 못했어요';
      description = '주소를 복사해 Chrome 주소창에 붙여넣어 주세요.';
      content = `${copyButton(true)}<p class="ok-install-hint">Chrome이 열리면 앱 설치를 눌러 주세요.</p>`;
    } else if (isIOS) {
      title = '홈 화면에 추가해요';
      description = inAppWindow() ? '주소를 복사해 Safari에서 연 뒤 추가해 주세요.' : isInApp ? '먼저 브라우저 메뉴에서 Safari로 열기를 선택해 주세요.' : '공유 메뉴에서 두 단계로 추가할 수 있어요.';
      content = `${steps([`${shareIcon}<b>공유</b> 버튼 누르기`, '<b>홈 화면에 추가 → 추가</b>'])}<p class="ok-install-hint">‘웹 앱으로 열기’가 보이면 켜 주세요.</p>${copyButton(false)}`;
    } else if (isAndroid && (inAppWindow() || isInApp || (!returned && !isChromeLike && !isSamsungBrowser))) {
      title = inAppWindow() ? `${isAdmin ? '관리자' : '고객용'} 앱 설치를 계속해요` : 'Chrome에서 이어서 설치해요';
      description = inAppWindow() ? '앱 안에서 열린 화면이에요. Chrome에서 설치를 진행해 주세요.' : 'Chrome이 열리면 앱 설치를 눌러 주세요.';
      const hint = inAppWindow() && returned ? '다시 앱이 열리면 주소를 복사해 <b>Chrome 주소창에 직접</b> 넣어 주세요.' : '선택창이 나오면 <b>Chrome</b>을 선택하세요.';
      content = `${chromeButton(true)}<p class="ok-install-hint">${hint}</p>${manualHelp()}${copyButton(false)}`;
    } else if (isAndroid) {
      title = isSamsungBrowser ? '브라우저의 ☰ 메뉴를 눌러 주세요' : '화면 맨 위 ⋮를 눌러 주세요';
      description = isSamsungBrowser ? '삼성 브라우저 메뉴에서 아래 순서로 진행해 주세요.' : '주소창 오른쪽 끝에 있는 Chrome 메뉴예요.';
      const menuItem = isSamsungBrowser ? '<b>홈 화면에 추가</b><small>또는 앱 설치</small>' : '<b>설치 및 바로가기 만들기</b><small>또는 홈 화면에 추가</small>';
      content = `${steps([menuItem, '<b>설치</b> 선택<small>설치 항목이 없으면 바로가기 만들기</small>'])}${closeButton()}${browserFallback()}`;
    } else {
      title = '브라우저에서 앱을 추가해요';
      description = '주소창의 설치 아이콘이나 브라우저 메뉴를 확인해 주세요.';
      content = `${steps(['<b>앱 설치</b> 선택하기', '<b>설치</b> 누르기'])}${copyButton(false)}`;
    }
    const active = document.activeElement;
    const hadContentFocus = dialog.querySelector('.ok-install-content').contains(active);
    const oldAction = dialog.contains(active) && active.dataset ? active.dataset.installAction : null;
    dialog.querySelector('#ok-install-title').textContent = title;
    dialog.querySelector('#ok-install-description').textContent = description;
    dialog.querySelector('.ok-install-content').innerHTML = content;
    dialog.querySelector('.ok-install-url-wrap').hidden = true;
    setStatus(notice);
    if (dialogActive && hadContentFocus) {
      const next = (oldAction && dialog.querySelector(`[data-install-action="${oldAction}"]`)) || dialog.querySelector('[data-install-primary]') || dialog.querySelector('.ok-install-close');
      if (next) next.focus({preventScroll: true});
    }
  }

  function finishClose() {
    if (!dialogActive) return;
    dialogActive = false;
    document.body.style.overflow = oldOverflow;
    refreshButtons();
    if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus({preventScroll: true});
  }

  function close() {
    if (!dialogActive) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    finishClose();
  }

  function show(trigger) {
    if (!dialog) return;
    if (dialogActive) {
      render();
      return;
    }
    if (typeof window.closeModal === 'function') document.querySelectorAll('.modal:not([hidden])').forEach(window.closeModal);
    returnFocus = trigger && trigger.isConnected ? trigger : document.activeElement;
    render();
    oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogActive = true;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    refreshButtons();
    const focus = dialog.querySelector('[data-install-primary]') || dialog.querySelector('.ok-install-close');
    focus.focus({preventScroll: true});
  }

  function install(trigger) {
    if (prompting) return;
    if (!pending || requested) {
      show(trigger);
      return;
    }
    const event = pending;
    const origin = dialogActive ? returnFocus : trigger;
    pending = null; // A BeforeInstallPromptEvent may be consumed only once.
    prompting = true;
    notice = '';
    close();
    refreshButtons();
    let result;
    try {
      result = event.prompt(); // Must remain in the original click, before any await or timer.
    } catch (_) {
      prompting = false;
      notice = '설치창을 열지 못했어요. 아래 방법으로 진행해 주세요.';
      refreshButtons();
      show(origin);
      return;
    }
    Promise.resolve(result).then(() => event.userChoice).then(choice => {
      if (choice && choice.outcome === 'accepted') {
        requested = true;
        notice = '';
      } else {
        notice = '설치를 취소했어요. 원할 때 다시 설치할 수 있어요.';
      }
    }).catch(() => {
      notice = '설치창을 열지 못했어요. 아래 방법으로 진행해 주세요.';
    }).finally(() => {
      prompting = false;
      refreshButtons();
      show(origin);
    });
  }

  async function copyAddress() {
    const origin = document.activeElement;
    let copied = false;
    try {
      await navigator.clipboard.writeText(continuation.href);
      copied = true;
    } catch (_) {
      const field = document.createElement('textarea');
      field.value = continuation.href;
      field.setAttribute('readonly', '');
      field.style.cssText = 'position:fixed;left:0;top:0;opacity:0;pointer-events:none';
      dialog.appendChild(field);
      field.select();
      try { copied = document.execCommand('copy'); } catch (_) {}
      field.remove();
    }
    if (!dialogActive) return;
    if (copied) {
      setStatus(`주소를 복사했어요. ${isIOS ? '브라우저' : 'Chrome'} 주소창에 붙여넣어 주세요.`);
      if (origin && origin.isConnected) origin.focus({preventScroll: true});
    } else {
      dialog.querySelector('.ok-install-url-wrap').hidden = false;
      const field = dialog.querySelector('[data-install-url]');
      field.value = continuation.href;
      field.focus();
      field.select();
      setStatus('아래 주소를 길게 눌러 복사해 주세요.');
    }
  }

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    pending = event;
    requested = false;
    refreshButtons();
    if (dialogActive) render();
  });
  window.addEventListener('appinstalled', () => {
    requested = true;
    pending = null;
    notice = '';
    refreshButtons();
    if (dialogActive) render();
  });
  const modeChanged = () => { refreshButtons(); if (dialogActive) render(); };
  if (displayMode.addEventListener) displayMode.addEventListener('change', modeChanged);
  else if (displayMode.addListener) displayMode.addListener(modeChanged);

  function init() {
    dialog = document.createElement('dialog');
    dialog.id = 'okInstallDialog';
    dialog.className = 'ok-install-dialog';
    dialog.setAttribute('aria-labelledby', 'ok-install-title');
    dialog.setAttribute('aria-describedby', 'ok-install-description');
    dialog.setAttribute('aria-modal', 'true');
    dialog.innerHTML = `<div class="ok-install-top"><img class="ok-install-icon" src="${escape(new URL('icon-192.png', root).href)}" width="48" height="48" alt=""><div class="ok-install-brand"><span class="ok-install-badge">${isAdmin ? '관리자용' : '고객용'}</span><strong>${escape(appName)}</strong></div><button class="ok-install-close" type="button" data-install-action="close" aria-label="설치 안내 닫기">×</button></div><h2 id="ok-install-title"></h2><p id="ok-install-description"></p><div class="ok-install-content"></div><p id="ok-install-status" class="ok-install-status" role="status" aria-live="polite" hidden></p><label class="ok-install-url-wrap" hidden>설치할 주소<input data-install-url readonly type="text" aria-label="설치할 주소" spellcheck="false"></label>`;
    document.body.appendChild(dialog);
    // A queued close event from a consumed prompt must not close a freshly reopened helper.
    dialog.addEventListener('close', () => { if (!dialog.open) finishClose(); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('click', event => {
      const action = event.target.closest('[data-install-action]');
      if (action) {
        if (action.dataset.installAction === 'chrome') {
          setStatus('선택창이 나오면 Chrome을 선택하세요. 열리지 않으면 주소 복사를 이용해 주세요.');
          return; // Follow the intent anchor directly from the user's click.
        }
        event.preventDefault();
        if (action.dataset.installAction === 'close') close();
        if (action.dataset.installAction === 'install') install(action);
        if (action.dataset.installAction === 'copy') copyAddress();
      } else if (event.target === dialog) {
        const rect = dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
      }
    });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key !== 'Tab') return;
      const items = [...dialog.querySelectorAll('a[href],button:not([disabled]),input,summary')].filter(node => node.getClientRects().length > 0);
      if (!items.length) return;
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1].focus(); }
      else if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0].focus(); }
    });
    document.addEventListener('click', event => {
      const button = event.target.closest('[data-install]');
      if (!button) return;
      event.preventDefault();
      install(button);
    });
    refreshButtons();
    if (returned) {
      current.searchParams.delete('install');
      current.searchParams.delete('install_fallback');
      try { history.replaceState(history.state, '', current.href); } catch (_) {}
      show(); // A return marker does not prove that the app window was escaped.
    }
  }

  // Both apps use the existing root worker; identity stays in their separate manifests.
  function registerWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      navigator.serviceWorker.register(new URL('sw.js', root).href, {scope: root.pathname, updateViaCache: 'none'}).catch(() => {});
    } catch (_) { /* Installation guidance remains usable when registration is unavailable. */ }
  }
  window.OKCleanInstall = Object.freeze({openHelp: () => show(), app: isAdmin ? 'admin' : 'customer'});
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once: true});
  else init();
  if (document.readyState === 'complete') registerWorker();
  else window.addEventListener('load', registerWorker, {once: true});
})();
