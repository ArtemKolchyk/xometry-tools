// Partner rating: личная оценка партнёров 🔴 🟡 🟢.
// Отметка — правый клик по имени (ссылке на контакт) или по выделенному тексту → «Partner rating» → цвет.
// Меню создаёт background (service-worker.js) и присылает сюда XT_RATE; что именно кликнули, знает только страница,
// поэтому последний правый клик запоминаем здесь.
// Подсветка — через CSS Custom Highlight API, как в Text highlighter: DOM Salesforce не меняется.
//   • ссылка на запись с оценённым ID — подсвечивается её текст целиком;
//   • текст вне ссылок на записи, совпадающий с именем целиком (без учёта регистра), — тоже.
// Подстроки не подсвечиваются: «My Nguyen» не зацепит «Tommy Nguyen».

(function () {
  'use strict';

  const SCRIPT_ID = 'partner-rating';
  const SCAN_MS = 1500;
  const NAME_PREFIX = 'xt-pr-';
  const PRIORITY = 1000;   // выше правил Text highlighter
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION']);
  const store = XT.partnerRating;
  const RATING_IDS = Object.keys(store.RATINGS);

  // ---------------- Правый клик → оценка ----------------
  let lastTarget = null;   // { anchor, time } последнего contextmenu

  window.addEventListener('contextmenu', (e) => {
    const anchor = e.composedPath().find((n) => n instanceof Element && n.tagName === 'A' && n.href);
    lastTarget = { anchor: anchor || null, time: Date.now() };
  }, true);

  function toast(text) {
    const box = document.createElement('div');
    box.textContent = text;
    Object.assign(box.style, {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483647,
      padding: '8px 12px', borderRadius: '6px', background: '#181818', color: '#fff',
      font: '13px/1.4 Arial, sans-serif', boxShadow: '0 4px 14px rgba(0,0,0,.25)', pointerEvents: 'none',
    });
    document.body.append(box);
    setTimeout(() => box.remove(), 2500);
  }

  async function handleRate(msg) {
    const fresh = lastTarget && Date.now() - lastTarget.time < 60000 ? lastTarget : null;
    const anchor = fresh && fresh.anchor;
    const id = store.recordIdFromUrl(msg.linkUrl) || (anchor && store.recordIdFromUrl(anchor.href));
    const name = store.cleanName(msg.selectionText) || (anchor && store.cleanName(anchor.textContent)) || '';

    if (!id && !name) { toast('Partner rating: right-click a name or select it first'); return; }

    if (msg.rating === 'remove') {
      const n = await store.remove({ id, name });
      toast(n ? `${name || 'Partner'}: rating removed` : `${name || 'Partner'}: had no rating`);
      return;
    }
    if (!store.RATINGS[msg.rating]) return;
    const entry = await store.rate({ id, name, rating: msg.rating });
    toast(`${store.RATINGS[msg.rating].emoji} ${entry.name || 'Partner'}${id ? '' : ' (by name)'}`);
  }

  // Отметка работает и при выключенной подсветке: это явное действие пользователя
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'XT_RATE') return false;
    handleRate(msg).then(
      () => sendResponse({ ok: true }),
      (e) => { toast(`Partner rating: ${e.message}`); sendResponse({ ok: false }); },
    );
    return true;
  });

  // ---------------- Подсветка ----------------
  let byId = new Map();     // id → rating
  let byName = new Map();   // имя в нижнем регистре → rating (из всех записей)

  const sheet = new CSSStyleSheet();
  sheet.replaceSync(RATING_IDS.map((r) => {
    const s = store.RATINGS[r];
    return `::highlight(${NAME_PREFIX}${r}) { background-color: ${s.bg}; color: ${s.color}; `
      + `text-decoration: underline 2px ${s.line}; }`;
  }).join('\n'));
  const styledRoots = new WeakSet();

  function adoptSheet(root) {
    if (styledRoots.has(root)) return;
    try { root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]; } catch (e) { /* не вышло — не повторяем */ }
    styledRoots.add(root);
  }

  function collectTextNodes(root, out) {
    adoptSheet(root instanceof ShadowRoot ? root : document);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && SKIP_TAGS.has(n.tagName)
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === Node.TEXT_NODE) { if (n.data.trim()) out.push(n); }
      else if (n.shadowRoot) collectTextNodes(n.shadowRoot, out);
    }
  }

  function clearHighlights() {
    RATING_IDS.forEach((r) => CSS.highlights.delete(NAME_PREFIX + r));
  }

  function ratingFor(node) {
    const anchor = node.parentElement && node.parentElement.closest('a[href]');
    const id = anchor && store.recordIdFromUrl(anchor.getAttribute('href'));
    // Ссылка на запись решает по ID: тёзка с другим ID не подсвечивается
    if (id) return byId.get(id) || null;
    return byName.get(store.cleanName(node.data).toLowerCase()) || null;
  }

  function scan() {
    clearHighlights();
    if ((!byId.size && !byName.size) || !document.body) return;

    const highlights = Object.fromEntries(RATING_IDS.map((r) => [r, new Highlight()]));
    const nodes = [];
    collectTextNodes(document.body, nodes);
    nodes.forEach((node) => {
      const rating = ratingFor(node);
      if (!rating) return;
      const data = node.data;
      highlights[rating].add(new StaticRange({
        startContainer: node, startOffset: data.length - data.trimStart().length,
        endContainer: node, endOffset: data.trimEnd().length,
      }));
    });
    RATING_IDS.forEach((r) => {
      highlights[r].priority = PRIORITY;
      CSS.highlights.set(NAME_PREFIX + r, highlights[r]);
    });
  }

  // ---------------- Запуск / остановка ----------------
  const supported = !!(window.CSS && CSS.highlights && window.Highlight);
  if (!supported) console.warn('[Partner rating] CSS Custom Highlight API is not supported in this browser');

  let running = false;
  let scanTimer = null;

  function start() {
    if (running || !supported) return;
    running = true;
    adoptSheet(document);
    scanTimer = setInterval(scan, SCAN_MS);
    scan();
  }

  function stop() {
    if (!running) return;
    running = false;
    clearInterval(scanTimer);
    clearHighlights();
  }

  store.watch((map) => {
    byId = new Map();
    byName = new Map();
    Object.entries(map).forEach(([key, e]) => {
      if (key.startsWith('id:')) byId.set(key.slice(3), e.rating);
      if (e.name) byName.set(e.name.toLowerCase(), e.rating);
    });
    if (running) scan();
  });

  XT.settings.watch(SCRIPT_ID, (on) => (on ? start() : stop()));
})();
