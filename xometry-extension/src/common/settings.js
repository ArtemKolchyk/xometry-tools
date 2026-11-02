// Переключатели скриптов (chrome.storage.sync — едут вместе с профилем Chrome)
// и команды из popup в content scripts (замена GM_registerMenuCommand).
(function () {
  'use strict';
  const XT = (globalThis.XT = globalThis.XT || {});
  const KEY = 'xt:enabled';

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

    // cb(enabled) вызывается сразу с текущим значением и потом при каждом изменении
    watch(scriptId, cb) {
      let current = null;
      const apply = (all) => {
        if (all[scriptId] !== current) { current = all[scriptId]; cb(current); }
      };
      XT.settings.getAll().then(apply);
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes[KEY]) apply(withDefaults(changes[KEY].newValue || {}));
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
