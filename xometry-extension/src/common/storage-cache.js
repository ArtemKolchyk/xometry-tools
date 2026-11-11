// Кеш поверх chrome.storage.local с копией в памяти (Map).
// get() синхронный, как GM_getValue: им пользуются при рендере. Перед первым get дождаться cache.ready.
// Записи вида { time, ... }; записи старше PRUNE_AFTER_MS удаляются при загрузке.
(function () {
  'use strict';
  const XT = (globalThis.XT = globalThis.XT || {});
  const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

  async function keysByPrefix(prefix) {
    const items = await chrome.storage.local.get(null);
    return Object.keys(items).filter((k) => k.startsWith(prefix));
  }

  XT.storage = {
    keysByPrefix,
    async clearByPrefix(prefix) {
      const keys = await keysByPrefix(prefix);
      if (keys.length) await chrome.storage.local.remove(keys);
    },
  };

  // Все кеши страницы создаются при загрузке скриптов, почти одновременно: читаем storage.local
  // один раз на всех, а не по полному чтению на каждый кеш. Чтение старше SHARED_READ_MS не переиспользуем.
  const SHARED_READ_MS = 2000;
  let sharedRead = null;
  let sharedReadTime = 0;
  function readAll() {
    if (!sharedRead || Date.now() - sharedReadTime > SHARED_READ_MS) {
      sharedRead = chrome.storage.local.get(null);
      sharedReadTime = Date.now();
    }
    return sharedRead;
  }

  XT.createCache = function (prefix) {
    const memory = new Map();

    const ready = readAll().then((items) => {
      const stale = [];
      Object.entries(items).forEach(([key, value]) => {
        if (!key.startsWith(prefix)) return;
        if (value && Date.now() - value.time > PRUNE_AFTER_MS) stale.push(key);
        else memory.set(key.slice(prefix.length), value);
      });
      if (stale.length) return chrome.storage.local.remove(stale);
    }).catch((e) => console.warn('[XT] cache load failed', e));

    // Изменения из других вкладок и из popup (Clear cache)
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      Object.entries(changes).forEach(([key, { newValue }]) => {
        if (!key.startsWith(prefix)) return;
        const id = key.slice(prefix.length);
        if (newValue === undefined) memory.delete(id); else memory.set(id, newValue);
      });
    });

    return {
      ready,
      get: (id) => (memory.has(id) ? memory.get(id) : null),
      set(id, value) {
        memory.set(id, value);
        chrome.storage.local.set({ [prefix + id]: value }).catch((e) => console.warn('[XT] cache write failed', e));
      },
      async clear() {
        memory.clear();
        await XT.storage.clearByPrefix(prefix);
      },
    };
  };
})();
