// Text highlighter (общий скрипт): подсвечивает текст по правилам из popup.
// Использует CSS Custom Highlight API: DOM страницы не меняется, поэтому компоненты Salesforce не ломаются.
// Совпадение — подстрока без учёта регистра внутри одного текстового узла.
// В правиле может быть несколько текстов через запятую и ограничение по сайту (XT.highlightRules.appliesTo).

(function () {
  'use strict';

  const SCRIPT_ID = 'text-highlighter';
  const SCAN_MS = 1500;          // как часто перескан (таблицы в Salesforce перерисовываются сами)
  const NAME_PREFIX = 'xt-hl-';
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION']);

  if (!(window.CSS && CSS.highlights && window.Highlight)) {
    console.warn('[Text highlighter] CSS Custom Highlight API is not supported in this browser');
    return;
  }

  let rules = [];          // только включённые правила с непустым текстом; needles — тексты в нижнем регистре
  let usedNames = 0;       // сколько highlight-ов зарегистрировано в CSS.highlights

  // Стили ::highlight() не проходят через границу shadow DOM — добавляем таблицу в каждый shadow root
  const sheet = new CSSStyleSheet();
  const styledRoots = new WeakSet();

  function adoptSheet(root) {
    if (styledRoots.has(root)) return;
    try {
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      styledRoots.add(root);
    } catch (e) {
      styledRoots.add(root);   // не получилось — не пытаемся снова на каждом скане
    }
  }

  function updateStyles() {
    sheet.replaceSync(rules.map((r, i) =>
      `::highlight(${NAME_PREFIX}${i}) { background-color: ${r.bg}; color: ${r.color}; }`).join('\n'));
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
    for (let i = 0; i < usedNames; i++) CSS.highlights.delete(NAME_PREFIX + i);
    usedNames = 0;
  }

  function scan() {
    clearHighlights();
    if (!rules.length || !document.body) return;

    // Salesforce — SPA: адрес меняется без перезагрузки, поэтому сайт правила проверяем на каждом скане
    const href = location.href;
    const active = rules.map((r) => XT.highlightRules.appliesTo(r, href));
    if (!active.some(Boolean)) return;

    const nodes = [];
    collectTextNodes(document.body, nodes);
    const highlights = rules.map(() => new Highlight());

    nodes.forEach((node) => {
      const hay = node.data.toLowerCase();
      rules.forEach((rule, i) => {
        if (!active[i]) return;
        rule.needles.forEach((needle) => {
          let from = 0;
          let idx;
          while ((idx = hay.indexOf(needle, from)) !== -1) {
            highlights[i].add(new StaticRange({
              startContainer: node, startOffset: idx,
              endContainer: node, endOffset: idx + needle.length,
            }));
            from = idx + needle.length;
          }
        });
      });
    });

    highlights.forEach((h, i) => {
      h.priority = rules.length - i;   // верхнее правило важнее
      CSS.highlights.set(NAME_PREFIX + i, h);
    });
    usedNames = highlights.length;
  }

  // ---------------- Запуск / остановка (переключатель в popup) ----------------
  let running = false;
  let scanTimer = null;

  function start() {
    if (running) return;
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

  XT.highlightRules.watch((list) => {
    rules = list
      .map((r) => ({ ...r, needles: XT.highlightRules.splitTexts(r.text).map((t) => t.toLowerCase()) }))
      .filter((r) => r.enabled && r.needles.length);
    updateStyles();
    if (running) scan();
  });

  XT.settings.watch(SCRIPT_ID, (on) => (on ? start() : stop()));
})();
