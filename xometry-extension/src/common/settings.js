// Переключатели скриптов (chrome.storage.sync — едут вместе с профилем Chrome)
// и команды из popup в content scripts (замена GM_registerMenuCommand).
(function () {
  'use strict';
  const XT = (globalThis.XT = globalThis.XT || {});
  const KEY = 'xt:enabled';
  const PREFS_KEY = 'xt:prefs';

  // Общие настройки расширения (страница Settings в popup)
  const PREF_DEFAULTS = {
    paused: false,     // Pause all: все скрипты выключены, их переключатели не трогаются
    itarUser: false,   // ERP sidebar показывает карточки и для ITAR-кейсов
    adminMode: false,  // доступны скрипты с admin: true (см. registry.js)
  };
  const prefsWithDefaults = (saved) => ({ ...PREF_DEFAULTS, ...(saved || {}) });

  XT.prefs = {
    async get() {
      const items = await chrome.storage.sync.get(PREFS_KEY);
      return prefsWithDefaults(items[PREFS_KEY]);
    },

    async set(patch) {
      const current = await XT.prefs.get();
      await chrome.storage.sync.set({ [PREFS_KEY]: { ...current, ...patch } });
    },

    // cb(prefs) вызывается сразу и при каждом изменении
    watch(cb) {
      XT.prefs.get().then(cb);
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes[PREFS_KEY]) cb(prefsWithDefaults(changes[PREFS_KEY].newValue));
      });
    },
  };

  function withDefaults(saved) {
    const result = {};
    XT.registry.scripts.forEach((s) => {
      result[s.id] = !s.stub && (s.id in saved ? !!saved[s.id] : s.defaultEnabled !== false);
    });
    return result;
  }

  XT.settings = {
    async getAll() {
      const items = await chrome.storage.sync.get(KEY);
      return withDefaults(items[KEY] || {});
    },

    async set(scriptId, enabled) {
      const items = await chrome.storage.sync.get(KEY);
      const saved = items[KEY] || {};
      saved[scriptId] = enabled;
      await chrome.storage.sync.set({ [KEY]: saved });
    },

    // cb(enabled) вызывается сразу с текущим значением и потом при каждом изменении.
    // Учитывает Pause all и админский режим: скрипт получает false, хотя его переключатель включён.
    watch(scriptId, cb) {
      const script = XT.registry.getScript(scriptId);
      let current = null;
      let all = null;
      let prefs = null;
      const apply = () => {
        if (all === null || prefs === null) return;
        const on = all[scriptId] && !prefs.paused && XT.registry.scriptAvailable(script, prefs.adminMode);
        if (on !== current) { current = on; cb(on); }
      };
      XT.settings.getAll().then((value) => { all = value; apply(); });
      XT.prefs.watch((value) => { prefs = value; apply(); });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes[KEY]) { all = withDefaults(changes[KEY].newValue || {}); apply(); }
      });
    },
  };

  // Настройки скрипта (значения по умолчанию — поле options в registry), ключ xt:options:<scriptId>
  const optionsKey = (scriptId) => `xt:options:${scriptId}`;
  const optionsWithDefaults = (scriptId, saved) =>
    ({ ...(XT.registry.getScript(scriptId).options || {}), ...(saved || {}) });

  XT.options = {
    async get(scriptId) {
      const key = optionsKey(scriptId);
      const items = await chrome.storage.sync.get(key);
      return optionsWithDefaults(scriptId, items[key]);
    },

    set(scriptId, options) {
      return chrome.storage.sync.set({ [optionsKey(scriptId)]: options });
    },

    // cb(options) вызывается сразу и при каждом изменении
    watch(scriptId, cb) {
      const key = optionsKey(scriptId);
      XT.options.get(scriptId).then(cb);
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes[key]) cb(optionsWithDefaults(scriptId, changes[key].newValue));
      });
    },
  };

  // Кнопки действий скрипта в popup → сообщение { type: 'XT_ACTION', scriptId, action } во вкладку
  XT.onAction = function (scriptId, handler) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || msg.type !== 'XT_ACTION' || msg.scriptId !== scriptId) return false;
      handler(msg.action);
      sendResponse({ ok: true });
      return false;
    });
  };
})();
