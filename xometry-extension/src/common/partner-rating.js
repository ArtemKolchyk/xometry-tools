// Личный рейтинг партнёров (скрипт «Partner rating»): { [key]: { name, rating, note, updated } }.
// key — 'id:<15 символов ID записи Salesforce>' (из ссылки на контакт) или 'name:<имя в нижнем регистре>',
// если отметили простой текст без ссылки. ID надёжнее имени: нет тёзок, не ломается при правке имени.
// Хранится в chrome.storage.local: рейтинг личный, не синхронизируется и не попадает в общий экспорт настроек.
(function () {
  'use strict';
  const XT = (globalThis.XT = globalThis.XT || {});
  const KEY = 'xt:partnerRating';

  // Стиль на странице: бледная заливка + толстое подчёркивание, чтобы не путать
  // с жёлтой «Response Received» и зелёной «Quality Control Queue» в очереди
  const RATINGS = {
    red: { label: 'Red', emoji: '🔴', bg: '#ffe0e0', color: '#8e030f', line: '#ba0517' },
    yellow: { label: 'Yellow', emoji: '🟡', bg: '#fff6c7', color: '#5c4300', line: '#dd7a01' },
    green: { label: 'Green', emoji: '🟢', bg: '#ddf6e3', color: '#194e31', line: '#2e844a' },
  };

  // /lightning/r/003XXXXXXXXXXXX/view, /lightning/r/Contact/003XXXXXXXXXXXXXXX/view
  const RECORD_RE = /\/lightning\/r\/(?:[A-Za-z0-9_]+\/)?([A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?)(?:\/|$|\?)/;

  function recordIdFromUrl(url) {
    const m = RECORD_RE.exec(String(url || ''));
    return m ? m[1].slice(0, 15) : null;   // 18-символьный и 15-символьный ID — одна запись
  }

  const cleanName = (name) => String(name || '').replace(/\s+/g, ' ').trim();
  const nameKey = (name) => 'name:' + cleanName(name).toLowerCase();
  const idKey = (id) => 'id:' + id;

  function normalize(map) {
    const out = {};
    if (!map || typeof map !== 'object') return out;
    Object.entries(map).forEach(([key, e]) => {
      if (!e || !RATINGS[e.rating] || !/^(id|name):./.test(key)) return;
      out[key] = {
        name: cleanName(e.name),
        rating: e.rating,
        note: String(e.note || ''),
        updated: Number(e.updated) || 0,
      };
    });
    return out;
  }

  async function get() {
    const items = await chrome.storage.local.get(KEY);
    return normalize(items[KEY]);
  }

  function set(map) {
    return chrome.storage.local.set({ [KEY]: normalize(map) });
  }

  XT.partnerRating = {
    RATINGS,
    recordIdFromUrl,
    cleanName,
    nameKey,
    idKey,
    normalize,
    get,
    set,

    // Поставить оценку: по ID записи, если он есть, иначе по имени. Заметка сохраняется.
    async rate({ id, name, rating }) {
      const map = await get();
      const key = id ? idKey(id) : nameKey(name);
      const prev = map[key];
      map[key] = {
        name: cleanName(name) || (prev && prev.name) || '',
        rating,
        note: prev ? prev.note : '',
        updated: Date.now(),
      };
      await set(map);
      return map[key];
    },

    // Снять оценку: запись с этим ID, а без ID — записи с этим именем. Возвращает, сколько снято.
    async remove({ id, name }) {
      const map = await get();
      const keys = id && map[idKey(id)]
        ? [idKey(id)]
        : Object.keys(map).filter((k) => map[k].name.toLowerCase() === cleanName(name).toLowerCase());
      keys.forEach((k) => delete map[k]);
      if (keys.length) await set(map);
      return keys.length;
    },

    // cb(map) вызывается сразу и при каждом изменении
    watch(cb) {
      get().then(cb);
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[KEY]) cb(normalize(changes[KEY].newValue));
      });
    },
  };
})();
