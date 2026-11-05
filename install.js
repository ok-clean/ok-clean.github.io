// Installation is offered only after the browser supplies a usable prompt.
// Browser acknowledgement is not proof that a home-screen icon was launched.
(function () {
  'use strict';
  const script = document.currentScript;
  if (!script || window.OKCleanInstall) return;
  const root = new URL('.', script.src);
  const isAdmin = script.dataset.app === 'admin';
  const app = isAdmin ? 'admin' : 'customer';
  const appName = isAdmin ? '오케이청소 관리자' : '오케이청소';
  const appUrl = new URL(isAdmin ? 'admin/' : 'app/', root);
  const ua = navigator.userAgent || '';
  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isInApp = /KAKAOTALK|NAVER|Instagram|FBAN|FBAV|Line\/|; wv\)/i.test(ua);
  const isChromeLike = /Chrome\/\d+/i.test(ua) && !/SamsungBrowser|EdgA|OPR/i.test(ua);
  const isSamsungBrowser = /SamsungBrowser/i.test(ua);
  const current = new URL(location.href);
  const returned = current.searchParams.get('install') === '1';
  const failedHandoff = returned && current.searchParams.get('install_fallback') === '1';
  const displayMode = window.matchMedia('(display-mode: standalone)');
  // An old customer app with scope '/' can contain the administrator page.
  // Display mode never identifies which app is installed.
  const inAppWindow = () => displayMode.matches || navigator.standalone === true;
  const needsBrowser = () => isAndroid && (inAppWindow() || isInApp || (!isChromeLike && !isSamsungBrowser));
  const handoffKey = `okclean.install-handoff.v1.${app}`;
  let handoffAttempted = returned;
  try { handoffAttempted = handoffAttempted || sessionStorage.getItem(handoffKey) === '1'; } catch (_) {}
  if (returned) { try { sessionStorage.setItem(handoffKey, '1'); } catch (_) {} }
  const escape = value => String(value).replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
  const continuation = new URL(appUrl);
  continuation.searchParams.set('install', '1');
  if (!isAdmin && current.searchParams.has('ref')) continuation.searchParams.set('ref', current.searchParams.get('ref').slice(0, 160));
  const fallback = new URL(continuation);
  fallback.searchParams.set('install_fallback', '1');
  const chromeIntent = `intent://${continuation.host}${continuation.pathname}${continuation.search}#Intent;scheme=${continuation.protocol.slice(0, -1)};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(fallback.href)};end`;
  const chromeLink = () => `<a class="ok-install-browser-link" href="${escape(chromeIntent)}" data-install-action="chrome">Chrome에서 열기</a>`;
  let pending = null;
  let promptEventObserved = false;
  let activePrompt = null;
  let requested = false;
  let browserInstallEventReceived = false;
  let observationElapsed = false;
  let workerFailed = false;
  let notice = '';
  let panel = null;
  let returnFocus = null;
  let renderedContent = null;

  function state() {
    if (activePrompt) return 'prompting';
    if (pending) return 'ready';
    if (browserInstallEventReceived) return 'installed-browser';
    if (requested) return 'requested';
    if (isIOS) return 'ios-manual';
    if (!promptEventObserved && (failedHandoff || (needsBrowser() && handoffAttempted))) return 'handoff-blocked';
    if (!promptEventObserved && needsBrowser()) return 'handoff';
    return observationElapsed || workerFailed || notice ? 'unavailable' : 'checking';
  }

  const labels = {
    checking: '설치 준비', unavailable: '설치 상태', ready: isAdmin ? '관리자 앱 설치' : '앱 설치',
    prompting: '설치창 열림', requested: '설치 요청됨', 'installed-browser': '설치 알림',
    'ios-manual': '홈 화면 추가', handoff: 'Chrome에서 열기', 'handoff-blocked': '설치 상태'
  };

  function refreshButtons() {
    const next = state();
    document.querySelectorAll('[data-install]').forEach(original => {
      let button = original;
      const tag = next === 'handoff' ? 'A' : 'BUTTON';
      // A browser handoff is a real link followed from the user's own click.
      if (button.tagName !== tag) {
        const replacement = document.createElement(tag.toLowerCase());
        for (const attribute of button.attributes) {
          if (!['href', 'type', 'disabled'].includes(attribute.name)) replacement.setAttribute(attribute.name, attribute.value);
        }
        replacement.append(...button.childNodes);
        const focused = document.activeElement === button;
        if (returnFocus === button) returnFocus = replacement;
        button.replaceWith(replacement);
        button = replacement;
        if (focused) button.focus({preventScroll: true});
      }
      button.hidden = false;
      button.dataset.installState = next;
      button.setAttribute('aria-controls', 'okInstallPanel');
      button.setAttribute('aria-expanded', String(!!panel && !panel.hidden));
      button.removeAttribute('aria-haspopup');
      if (tag === 'A') {
        button.href = chromeIntent;
        button.classList.add('ok-install-handoff');
      } else {
        button.type = 'button';
        button.disabled = next === 'prompting';
        button.classList.remove('ok-install-handoff');
      }
      const label = button.querySelector('[data-install-label], span') || button;
      label.textContent = labels[next];
    });
  }

  function render() {
    if (!panel) return;
    const next = state();
    let title, description, content = '';
    if (next === 'ready') {
      title = '설치 준비가 됐어요';
      description = `${labels.ready} 버튼을 누르면 휴대폰 설치창이 열려요.`;
    } else if (next === 'prompting') {
      title = '휴대폰 설치창을 확인해 주세요';
      description = '브라우저가 연 설치창에서 설치 또는 취소를 선택할 수 있어요.';
    } else if (next === 'requested') {
      title = '설치를 요청했어요';
      description = '휴대폰에서 설치를 처리하고 있어요. 아직 설치 완료 알림을 받지 못했어요.';
    } else if (next === 'installed-browser') {
      title = '설치 완료 알림을 받았어요';
      description = `홈 화면의 ${appName} 아이콘으로 열어 주세요. 아이콘 생성과 실행 여부는 이 페이지에서 확인할 수 없어요.`;
    } else if (next === 'ios-manual') {
      title = '홈 화면에 추가';
      description = inAppWindow() || isInApp ? 'Safari에서 이 페이지를 연 뒤 아래 순서로 추가해 주세요.' : 'Safari의 공유 메뉴에서 추가할 수 있어요.';
      content = '<ol class="ok-install-steps"><li><b>공유</b> 누르기</li><li><b>홈 화면에 추가 → 추가</b></li></ol><p class="ok-install-hint">‘웹 앱으로 열기’가 보이면 켜 주세요.</p>';
      if (inAppWindow() || isInApp) content += '<details class="ok-install-details"><summary>Safari에서 열 주소</summary><button type="button" data-install-action="copy" class="ok-install-secondary">주소 복사</button><label class="ok-install-url-wrap" hidden>페이지 주소<input data-install-url readonly type="text" spellcheck="false"></label></details>';
    } else if (next === 'handoff-blocked') {
      title = '이 화면에서는 설치창을 열 수 없어요';
      description = failedHandoff ? 'Chrome으로 전환되지 않았어요. 같은 브라우저 열기를 반복하지 않습니다.' : '브라우저 열기를 이미 요청했어요. 앱 화면으로 돌아왔다면 이 화면에서는 별도 설치를 진행할 수 없어요.';
    } else if (next === 'handoff') {
      title = '브라우저에서 설치할 수 있어요';
      description = 'Chrome에서 열기 버튼으로 이동할 수 있어요. 설치 준비 여부는 열린 브라우저에서 확인합니다.';
    } else if (next === 'checking') {
      title = '설치 준비를 확인하고 있어요';
      description = `설치창을 열 수 있게 되면 버튼이 ‘${labels.ready}’로 바뀌어요.`;
    } else {
      title = '지금은 설치창을 열 수 없어요';
      description = '이 화면에서 설치 가능 여부를 확인하지 못했어요. 이미 설치됐는지 또는 브라우저 제한 때문인지는 단정할 수 없어요.';
      // Chrome Custom Tabs can look identical to Chrome. Offer an optional,
      // single handoff only when the user explicitly asks for installation status.
      if (isAndroid && !handoffAttempted) content = `<details class="ok-install-details"><summary>다른 앱 안에서 보고 있나요?</summary>${chromeLink()}</details>`;
    }
    panel.dataset.installState = next;
    panel.querySelector('#ok-install-title').textContent = title;
    panel.querySelector('#ok-install-description').textContent = description;
    // Do not replace focused content on a routine refresh if nothing changed.
    const target = panel.querySelector('.ok-install-content');
    if (renderedContent !== content) { target.innerHTML = content; renderedContent = content; }
    const status = panel.querySelector('#ok-install-status');
    status.textContent = notice;
    status.hidden = !notice;
    panel.querySelector('.ok-install-page-hint').textContent = isAdmin ? '설치 없이도 아래에서 관리자 로그인을 할 수 있어요.' : '설치 없이도 이 페이지를 계속 사용할 수 있어요.';
  }

  function refresh() { refreshButtons(); render(); }

  function hidePanel() {
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    refreshButtons();
    if (returnFocus && returnFocus.isConnected) returnFocus.focus({preventScroll: true});
  }

  function showPanel(trigger, focus = true) {
    if (!panel) return;
    if (trigger && trigger.isConnected) returnFocus = trigger;
    render();
    panel.hidden = false;
    refreshButtons();
    if (focus) panel.focus({preventScroll: true});
  }

  function finishPrompt(request, choice, failed) {
    if (activePrompt !== request) return; // Ignore a stale result after appinstalled or timeout.
    clearTimeout(request.timer);
    activePrompt = null;
    if (failed) notice = '설치창을 열지 못했어요. 다시 준비되면 설치 버튼이 나타납니다.';
    else if (choice && choice.outcome === 'accepted') {
      requested = !pending;
      notice = '';
    } else if (choice && choice.outcome === 'dismissed') {
      notice = '설치를 취소했어요. 다시 설치할 수 있게 되면 버튼이 바뀝니다.';
    } else {
      notice = '설치 결과를 확인하지 못했어요. 페이지는 계속 사용할 수 있어요.';
    }
    // A newer event may arrive while the previous prompt is settling. It must
    // remain usable, regardless of the old prompt's cancellation or failure.
    if (pending) notice = '';
    refresh();
    showPanel(request.trigger, false);
  }

  function install(trigger) {
    if (activePrompt) return;
    if (!pending) { showPanel(trigger); return; }
    const event = pending;
    pending = null; // BeforeInstallPromptEvent is single-use, even when it fails.
    requested = false;
    notice = '';
    const request = {trigger, timer: null};
    activePrompt = request;
    hidePanel();
    refresh();
    let result;
    try {
      result = event.prompt(); // Keep this in the original click; no await or timer before it.
    } catch (_) {
      finishPrompt(request, null, true);
      return;
    }
    // An abandoned/pending browser promise must not disable the page's control forever.
    if (activePrompt === request) request.timer = setTimeout(() => finishPrompt(request, null, false), 45000);
    Promise.resolve(result).then(choice => {
      if (choice && typeof choice.outcome === 'string') return choice;
      return event.userChoice;
    }).then(choice => finishPrompt(request, choice, false), () => finishPrompt(request, null, true));
  }

  function recordHandoff() {
    handoffAttempted = true;
    try { sessionStorage.setItem(handoffKey, '1'); } catch (_) {}
    // Keep the clicked anchor in place until its native default action has run.
    setTimeout(refresh, 0);
  }

  async function copyAddress() {
    let copied = false;
    try { await navigator.clipboard.writeText(appUrl.href); copied = true; } catch (_) {}
    if (!panel || panel.hidden) return;
    const field = panel.querySelector('[data-install-url]');
    if (copied) {
      notice = '주소를 복사했어요. Safari에서 열어 주세요.';
      const status = panel.querySelector('#ok-install-status');
      status.textContent = notice;
      status.hidden = false;
    } else if (field) {
      field.closest('label').hidden = false;
      field.value = appUrl.href;
      field.focus();
      field.select();
    }
  }

  window.addEventListener('beforeinstallprompt', event => {
    if (typeof event.prompt !== 'function') return;
    event.preventDefault();
    pending = event;
    promptEventObserved = true;
    requested = false;
    browserInstallEventReceived = false;
    notice = '';
    refresh(); // No automatic prompt or helper: a fresh user click is required.
  });
  window.addEventListener('appinstalled', () => {
    if (activePrompt) clearTimeout(activePrompt.timer);
    activePrompt = null;
    pending = null;
    requested = false;
    browserInstallEventReceived = true;
    notice = '';
    refresh();
    // Event received for this page is kept only in this document, never shared
    // with the other app or persisted as proof of an icon's existence/launch.
  });
  const modeChanged = () => refresh();
  if (displayMode.addEventListener) displayMode.addEventListener('change', modeChanged);
  else if (displayMode.addListener) displayMode.addListener(modeChanged);

  function init() {
    panel = document.createElement('section');
    panel.id = 'okInstallPanel';
    panel.className = 'ok-install-panel';
    panel.hidden = true;
    panel.tabIndex = -1;
    panel.setAttribute('aria-labelledby', 'ok-install-title');
    panel.innerHTML = `<div class="ok-install-top"><img class="ok-install-icon" src="${escape(new URL(isAdmin ? 'admin/icon-192.png' : 'icon-192.png', root).href)}" width="44" height="44" alt=""><div class="ok-install-brand"><span class="ok-install-badge">${isAdmin ? '관리자용' : '고객용'}</span><strong>${escape(appName)}</strong></div><button type="button" class="ok-install-close" data-install-action="close" aria-label="설치 상태 닫기">×</button></div><h2 id="ok-install-title"></h2><p id="ok-install-description"></p><div class="ok-install-content"></div><p id="ok-install-status" class="ok-install-status" role="status" aria-live="polite" hidden></p><p class="ok-install-page-hint"></p>`;
    const header = document.querySelector('[data-install]')?.closest('header');
    if (header) header.after(panel);
    else (document.querySelector('main') || document.body).prepend(panel);
    panel.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); hidePanel(); }
    });
    document.addEventListener('click', event => {
      const action = event.target.closest('[data-install-action]');
      if (action && panel.contains(action)) {
        if (action.dataset.installAction === 'chrome') {
          if (handoffAttempted) event.preventDefault();
          else recordHandoff();
          return; // Follow the real intent link from this click, without auto-redirection.
        }
        event.preventDefault();
        if (action.dataset.installAction === 'close') hidePanel();
        if (action.dataset.installAction === 'copy') copyAddress();
        return;
      }
      const button = event.target.closest('[data-install]');
      if (!button) return;
      if (state() === 'handoff' && button.tagName === 'A') { recordHandoff(); return; }
      event.preventDefault();
      install(button);
    });
    if (returned) {
      current.searchParams.delete('install');
      current.searchParams.delete('install_fallback');
      try { history.replaceState(history.state, '', current.href); } catch (_) {}
      // A return marker never proves browser identity or authorizes another handoff.
    }
    refresh();
  }

  function registerWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      navigator.serviceWorker.register(new URL('sw.js', root).href, {scope: root.pathname, updateViaCache: 'none'}).catch(() => { workerFailed = true; refresh(); });
    } catch (_) { workerFailed = true; refresh(); }
  }
  window.OKCleanInstall = Object.freeze({
    app,
    openHelp: () => showPanel(document.querySelector('[data-install]')),
    getState: () => ({state: state(), app, hasPrompt: !!pending, promptEventObserved, browserInstallEventReceived, deviceIconVerified: false})
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once: true});
  else init();
  // Registration does not depend on unrelated images, fonts, or login module loads.
  registerWorker();
  // This timer changes only the status text; it never diagnoses installation,
  // prompts automatically, or stops accepting a later genuine browser event.
  setTimeout(() => { observationElapsed = true; refresh(); }, 8000);
})();
