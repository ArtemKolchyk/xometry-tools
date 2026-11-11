// Списки Partners и Customers: пользователь сам отмечает партнёров и клиентов, с которыми работа идёт иначе.
// Карточки ERP sidebar с совпадением получают значок ▲! цвета записи, заметка — в подсказке и в More.
// Хранится в chrome.storage.sync (едет с профилем Chrome, попадает в Export/Import), ключ на каждый список:
// у sync лимит ~8 KB на ключ, поэтому списки не складываются в один.
(function () {
  'use strict';
  const XT = (globalThis.XT = globalThis.XT || {});

  const KINDS = {
    partners: { label: 'Partners', one: 'Partner', hint: 'Compared with the partner company on the ERP card' },
    customers: { label: 'Customers', one: 'Customer', hint: 'Compared with the customer company, contact name and email' },
  };
  const COLORS = {
    red: { label: 'Red', value: '#ba0517' },
    orange: { label: 'Orange', value: '#dd7a01' },
    purple: { label: 'Purple', value: '#9050e9' },
    blue: { label: 'Blue', value: '#0176d3' },
  };
  const MIN_MATCH_LEN = 3;   // короче — совпадало бы почти со всем
  const storageKey = (kind) => `xt:watchlist:${kind}`;

  // Регистр и пунктуация не важны: «ACME, Inc.» == «acme inc»
  const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}@]+/gu, ' ').trim();

  function clean(list) {
    return (Array.isArray(list) ? list : [])
      .filter((e) => e && typeof e === 'object')
      .map((e) => ({ text: String(e.text || ''), note: String(e.note || ''), color: COLORS[e.color] ? e.color : 'red' }));
  }

  async function get(kind) {
    const key = storageKey(kind);
    const items = await chrome.storage.sync.get(key);
    return clean(items[key]);
  }

  XT.watchlist = {
    KINDS,
    COLORS,
    get,
    set: (kind, list) => chrome.storage.sync.set({ [storageKey(kind)]: clean(list) }),

    // cb({ partners, customers }) сразу и при каждом изменении
    watch(cb) {
      const lists = {};
      Promise.all(Object.keys(KINDS).map(async (k) => { lists[k] = await get(k); })).then(() => cb({ ...lists }));
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        let changed = false;
        Object.keys(KINDS).forEach((k) => {
          if (changes[storageKey(k)]) { lists[k] = clean(changes[storageKey(k)].newValue); changed = true; }
        });
        if (changed) cb({ ...lists });
      });
    },

    // Записи списка, текст которых входит в одно из values (компания, имя, email)
    match(list, values) {
      const hay = values.map(norm).filter(Boolean);
      if (!hay.length) return [];
      return list.filter((e) => {
        const n = norm(e.text);
        return n.length >= MIN_MATCH_LEN && hay.some((h) => h.includes(n));
      });
    },

    colorValue: (color) => (COLORS[color] || COLORS.red).value,

    // Значок ▲! цвета color (SVG-разметка), общий для ERP sidebar и плашки кейса
    signSvg: (color) => '<svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true">'
      + `<path d="M8 1 L15.2 13.2 H0.8 Z" fill="${color}" stroke="${color}" stroke-width="1.2" stroke-linejoin="round"/>`
      + '<rect x="7.15" y="4.6" width="1.7" height="4.9" rx=".85" fill="#fff"/><circle cx="8" cy="11.2" r="1" fill="#fff"/>'
      + '</svg>',
  };
})();
