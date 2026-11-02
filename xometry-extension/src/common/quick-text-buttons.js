// Кнопки скрипта «Case quick text»: [{ id, label, text, bg, color, slot }] в порядке показа.
// Хранятся в chrome.storage.sync по одной записи на кнопку (лимит 8 КБ на запись) + список id для порядка.
(function () {
  'use strict';
  const XT = (globalThis.XT = globalThis.XT || {});
  const INDEX_KEY = 'xt:quickText:index';
  const ITEM_PREFIX = 'xt:quickText:btn:';
  const LEGACY_KEY = 'xt:options:sf-case-quick-text';   // v0.2.0: два фиксированных текста
  const COLOR_RE = /^#[0-9a-f]{6}$/i;

  // Готовые пары «заливка + текст»
  const PRESETS = [
    { bg: '#2e844a', color: '#ffffff' },
    { bg: '#fcc003', color: '#181818' },
    { bg: '#ba0517', color: '#ffffff' },
    { bg: '#0176d3', color: '#ffffff' },
    { bg: '#fe9339', color: '#181818' },
    { bg: '#7526e3', color: '#ffffff' },
    { bg: '#0b827c', color: '#ffffff' },
    { bg: '#d4f5dc', color: '#194e31' },
    { bg: '#fff3a3', color: '#5c4300' },
    { bg: '#ffd0d0', color: '#8e030f' },
    { bg: '#e5e5e5', color: '#181818' },
    { bg: '#ffffff', color: '#0176d3' },
  ];

  // Места на странице кейса, куда можно поставить кнопку (поиск мест — в salesforce-case-quick-text.js)
  const SLOTS = [
    { id: 'actions', name: 'Under action buttons' },
    { id: 'header', name: 'Case header' },
    { id: 'tabs', name: 'Under Collapse! tabs' },
    { id: 'email', name: 'Above email editor' },
  ];
  const DEFAULT_SLOT = 'tabs';

  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // Цвета попадают в CSS, поэтому всё, что не #rrggbb, заменяем на первый пресет
  function normalize(b) {
    return {
      id: String((b && b.id) || newId()),
      label: String((b && b.label) || ''),
      text: String((b && b.text) || ''),
      bg: COLOR_RE.test(b && b.bg) ? b.bg : PRESETS[0].bg,
      color: COLOR_RE.test(b && b.color) ? b.color : PRESETS[0].color,
      slot: SLOTS.some((s) => s.id === (b && b.slot)) ? b.slot : DEFAULT_SLOT,
    };
  }

  // Пока пользователь ничего не сохранял: две кнопки из v0.2.0 с его старыми текстами
  function defaults(items) {
    const legacy = items[LEGACY_KEY] || {};
    return [
      { label: 'VQC pass', text: legacy.passText || 'VQC pass', bg: '#2e844a', color: '#ffffff' },
      { label: 'PASS after corrections', text: legacy.correctionsText || 'PASS after corrections', bg: '#fcc003', color: '#181818' },
    ].map(normalize);
  }

  function fromItems(items) {
    if (!Array.isArray(items[INDEX_KEY])) return defaults(items);
    return items[INDEX_KEY].map((id) => items[ITEM_PREFIX + id]).filter(Boolean).map(normalize);
  }

  const isOwnKey = (key) => key === INDEX_KEY || key.startsWith(ITEM_PREFIX);

  XT.quickTextButtons = {
    PRESETS,
    SLOTS,
    DEFAULT_SLOT,
    newId,

    async get() {
      return fromItems(await chrome.storage.sync.get(null));
    },

    async set(list) {
      const buttons = list.map(normalize);
      const items = { [INDEX_KEY]: buttons.map((b) => b.id) };
      buttons.forEach((b) => { items[ITEM_PREFIX + b.id] = b; });
      const stale = Object.keys(await chrome.storage.sync.get(null))
        .filter((key) => key.startsWith(ITEM_PREFIX) && !(key in items));
      await chrome.storage.sync.set(items);
      if (stale.length) await chrome.storage.sync.remove(stale);
    },

    // cb(buttons) вызывается сразу и при каждом изменении
    watch(cb) {
      XT.quickTextButtons.get().then(cb);
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && Object.keys(changes).some(isOwnKey)) XT.quickTextButtons.get().then(cb);
      });
    },
  };
})();
