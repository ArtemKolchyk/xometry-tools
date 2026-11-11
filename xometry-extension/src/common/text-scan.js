// Общий обход текста страницы для Text highlighter и Partner rating.
// Раньше каждый скрипт сам обходил весь DOM (с shadow DOM) каждые 1,5 с. Теперь:
//   • snapshot() собирает текстовые узлы один раз на «версию» DOM — оба скрипта получают один и тот же список;
//   • версия меняется, только когда DOM изменился (MutationObserver на документе и на каждом найденном
//     shadow root — изменения внутри shadow root до наблюдателя документа не доходят);
//   • на всякий случай версия меняется и раз в FULL_RESCAN_MS: CSS-подсветка мутаций не создаёт,
//     а что-то наблюдатель может пропустить (например, shadow root, появившийся внутри уже обойдённого).
(function () {
  'use strict';
  const XT = (globalThis.XT = globalThis.XT || {});

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION']);
  const FULL_RESCAN_MS = 10000;
  const OBSERVE = { childList: true, subtree: true, characterData: true };

  let version = 1;
  let lastBump = Date.now();
  let cache = null;   // { version, nodes, roots }

  const observer = new MutationObserver(() => { version++; lastBump = Date.now(); });
  const observed = new WeakSet();
  function observe(root) {
    if (observed.has(root)) return;
    observed.add(root);
    observer.observe(root, OBSERVE);
  }

  function walk(root, nodes, roots) {
    roots.push(root);
    observe(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && SKIP_TAGS.has(n.tagName)
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === Node.TEXT_NODE) { if (n.data.trim()) nodes.push(n); }
      else if (n.shadowRoot) walk(n.shadowRoot, nodes, roots);
    }
  }

  function currentVersion() {
    if (Date.now() - lastBump > FULL_RESCAN_MS) { version++; lastBump = Date.now(); }
    return version;
  }

  XT.textScan = {
    // Номер текущей версии DOM: если не изменился, пересчитывать подсветку не нужно
    version: currentVersion,

    // { version, nodes: текстовые узлы с текстом, roots: document.body и все shadow root }.
    // Узлы и roots общие для всех скриптов: не менять.
    snapshot() {
      const v = currentVersion();
      if (!cache || cache.version !== v) {
        const nodes = [];
        const roots = [];
        if (document.body) walk(document.body, nodes, roots);
        cache = { version: v, nodes, roots };
      }
      return cache;
    },
  };
})();
