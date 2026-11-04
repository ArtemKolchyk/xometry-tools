// Auto refresh (общий скрипт): перезагружает страницу раз в intervalMin минут.
// pauseWhenActive: если пользователь недавно кликал мышью или нажимал клавиши В ЭТОЙ вкладке,
// ждём idleSec секунд тишины. Движение мыши, колесо и прокрутка активностью не считаются.
// Всегда (независимо от pauseWhenActive) не перезагружаем, если:
//   • в поле с фокусом есть набранный текст;
//   • фокус внутри iframe, который нельзя прочитать;
//   • на странице открыт редактор (contenteditable) с текстом — например, письмо в Salesforce,
//     даже если фокус уже ушёл из него.
// Редактор письма в Salesforce (CKEditor) живёт в iframe: content script туда не загружается,
// поэтому слушатели клавиш вешаем на доступные (same-origin) iframe сами, а проверки заходят внутрь них.

(function () {
  'use strict';

  const SCRIPT_ID = 'auto-refresh';
  const TICK_MS = 5000;
  const ACTIVITY_EVENTS = ['pointerdown', 'mousedown', 'keydown'];
  const LISTEN = { capture: true, passive: true };

  let opts = null;
  let lastActivity = Date.now();
  let dueAt = 0;
  let tickTimer = null;

  const onActivity = (e) => { if (e.isTrusted) lastActivity = Date.now(); };
  const listened = new WeakSet();   // окна, на которые уже повешены слушатели

  function listen(win) {
    if (!win || listened.has(win)) return;
    try {
      ACTIVITY_EVENTS.forEach((type) => win.addEventListener(type, onActivity, LISTEN));
    } catch (e) { /* cross-origin */ }
    listened.add(win);
  }

  listen(window);

  // Документ iframe, если он same-origin; иначе null
  function frameDoc(frame) {
    try { return frame.contentDocument || null; } catch (e) { return null; }
  }

  // Обход документа: обычные элементы, shadow roots и доступные iframe
  function walk(root, visit) {
    const walker = (root.ownerDocument || document).createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let n = root.nodeType === Node.ELEMENT_NODE ? root : walker.nextNode();
    while (n) {
      if (visit(n) === false) return false;
      if (n.shadowRoot && walk(n.shadowRoot, visit) === false) return false;
      if (n.tagName === 'IFRAME' || n.tagName === 'FRAME') {
        const doc = frameDoc(n);
        if (doc && doc.documentElement && walk(doc.documentElement, visit) === false) return false;
      }
      n = walker.nextNode();
    }
    return true;
  }

  // Слушатели клавиш/кликов во всех доступных iframe (их создают и пересоздают на лету)
  function listenFrames() {
    if (!document.body) return;
    walk(document.body, (n) => {
      if (n.tagName === 'IFRAME' || n.tagName === 'FRAME') {
        const doc = frameDoc(n);
        if (doc) listen(doc.defaultView);
      }
    });
  }

  const hasText = (s) => String(s || '').replace(/​/g, '').trim() !== '';

  function isEditableWithText(a) {
    if (a.isContentEditable) return hasText(a.textContent);
    if (a.tagName === 'TEXTAREA') return !a.readOnly && !a.disabled && hasText(a.value);
    if (a.tagName === 'INPUT') {
      const textTypes = ['text', 'search', 'email', 'number', 'tel', 'url', ''];
      return textTypes.includes(a.type) && !a.readOnly && !a.disabled && hasText(a.value);
    }
    return false;
  }

  // Фокус в поле с текстом — с учётом shadow DOM и iframe.
  // Фокус в iframe, внутрь которого не заглянуть, считаем «пользователь что-то пишет».
  function focusedFieldHasText() {
    let a = document.activeElement;
    for (;;) {
      if (!a) return false;
      if (a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
      if (a.tagName === 'IFRAME' || a.tagName === 'FRAME') {
        const doc = frameDoc(a);
        if (!doc) return true;
        if (doc.designMode === 'on' && doc.body && hasText(doc.body.textContent)) return true;
        a = doc.activeElement;
        continue;
      }
      return isEditableWithText(a);
    }
  }

  function isVisible(n) {
    return !!(n.offsetWidth || n.offsetHeight || n.getClientRects().length);
  }

  // Открытый редактор с текстом где угодно на странице (письмо, пост, комментарий)
  function hasOpenDraft() {
    if (!document.body) return false;
    let found = false;
    walk(document.body, (n) => {
      const isEditorRoot = n.isContentEditable && !(n.parentElement && n.parentElement.isContentEditable);
      if (isEditorRoot && isVisible(n) && hasText(n.textContent)) { found = true; return false; }
      if (n.tagName === 'TEXTAREA' && !n.readOnly && !n.disabled && isVisible(n) && hasText(n.value)) {
        found = true;
        return false;
      }
      return true;
    });
    return found;
  }

  function tick() {
    listenFrames();
    const now = Date.now();
    if (now < dueAt) return;
    if (opts.pauseWhenActive && now - lastActivity < opts.idleSec * 1000) return;
    if (focusedFieldHasText() || hasOpenDraft()) return;
    location.reload();
  }

  function schedule() {
    dueAt = Date.now() + Math.max(1, Number(opts.intervalMin) || 1) * 60 * 1000;
  }

  // ---------------- Запуск / остановка (переключатель в popup) ----------------
  function start() {
    if (tickTimer) return;
    schedule();
    tickTimer = setInterval(tick, TICK_MS);
  }

  function stop() {
    clearInterval(tickTimer);
    tickTimer = null;
  }

  XT.options.watch(SCRIPT_ID, (o) => {
    const first = !opts;
    opts = o;
    if (!first && tickTimer) schedule();   // новый интервал — отсчёт заново
    if (first) XT.settings.watch(SCRIPT_ID, (on) => (on ? start() : stop()));
  });
})();
