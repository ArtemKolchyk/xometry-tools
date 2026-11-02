// Auto refresh (общий скрипт): перезагружает страницу раз в intervalMin минут.
// pauseWhenActive: если пользователь недавно двигал мышью / печатал / прокручивал, ждём idleSec секунд тишины.
// Всегда: не перезагружаем, пока в поле с фокусом есть набранный текст.

(function () {
  'use strict';

  const SCRIPT_ID = 'auto-refresh';
  const TICK_MS = 5000;
  const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'wheel', 'scroll', 'touchstart'];

  let opts = null;
  let lastActivity = Date.now();
  let dueAt = 0;
  let tickTimer = null;

  // capture на window ловит события и из глубины страницы
  ACTIVITY_EVENTS.forEach((type) =>
    addEventListener(type, () => { lastActivity = Date.now(); }, { capture: true, passive: true }));

  // Элемент с фокусом, с учётом shadow DOM
  function deepActiveElement() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function hasUnsavedInput() {
    const a = deepActiveElement();
    if (!a) return false;
    if (a.isContentEditable) return a.textContent.trim() !== '';
    if (a.tagName === 'TEXTAREA') return !a.readOnly && a.value.trim() !== '';
    if (a.tagName === 'INPUT') {
      const textTypes = ['text', 'search', 'email', 'number', 'tel', 'url', ''];
      return textTypes.includes(a.type) && !a.readOnly && a.value.trim() !== '';
    }
    return false;
  }

  function tick() {
    const now = Date.now();
    if (now < dueAt) return;
    if (opts.pauseWhenActive && now - lastActivity < opts.idleSec * 1000) return;
    if (hasUnsavedInput()) return;
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
