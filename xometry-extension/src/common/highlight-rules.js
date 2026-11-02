// Правила подсветки текста (скрипт «Text highlighter»): [{ text, bg, color, enabled }].
// Хранятся в chrome.storage.sync — едут вместе с профилем Chrome.
(function () {
  'use strict';
  const XT = (globalThis.XT = globalThis.XT || {});
  const KEY = 'xt:highlightRules';
  const COLOR_RE = /^#[0-9a-f]{6}$/i;

  // Готовые пары «заливка + текст»
  const PRESETS = [
    { bg: '#fff3a3', color: '#5c4300' },
    { bg: '#ffd8b0', color: '#7a3a00' },
    { bg: '#ffd0d0', color: '#8e030f' },
    { bg: '#ffd6ec', color: '#7a0f4b' },
    { bg: '#e5d9ff', color: '#3f1d8a' },
    { bg: '#cfe6ff', color: '#0b3d91' },
    { bg: '#c9f2ee', color: '#0b4f4a' },
    { bg: '#d4f5dc', color: '#194e31' },
    { bg: '#e5e5e5', color: '#262626' },
    { bg: '#ffe14d', color: '#000000' },
    { bg: '#ba0517', color: '#ffffff' },
    { bg: '#0176d3', color: '#ffffff' },
  ];

  // Цвета попадают в CSS, поэтому всё, что не #rrggbb, заменяем на первый пресет
  function normalize(list) {
    return (Array.isArray(list) ? list : []).map((r) => ({
      text: String((r && r.text) || ''),
      bg: COLOR_RE.test(r && r.bg) ? r.bg : PRESETS[0].bg,
      color: COLOR_RE.test(r && r.color) ? r.color : PRESETS[0].color,
      enabled: !(r && r.enabled === false),
    }));
  }

  XT.highlightRules = {
    PRESETS,

    async get() {
      const items = await chrome.storage.sync.get(KEY);
      return normalize(items[KEY]);
    },

    set(list) {
      return chrome.storage.sync.set({ [KEY]: normalize(list) });
    },

    // cb(rules) вызывается сразу и при каждом изменении
    watch(cb) {
      XT.highlightRules.get().then(cb);
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes[KEY]) cb(normalize(changes[KEY].newValue));
      });
    },
  };
})();
