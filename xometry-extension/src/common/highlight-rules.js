// Правила подсветки текста (скрипт «Text highlighter»): [{ name, text, site, url, bg, color, enabled }].
// text — один или несколько текстов через запятую; name — заметка для себя, на странице не используется.
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

  // Где работает правило: все сайты, один сайт из реестра, одна страница Salesforce (PAGES) или своя часть адреса (url)
  const SITE_ALL = 'all';
  const SITE_CUSTOM = 'custom';

  // Сайт «SF queue» — это весь *.lightning.force.com, включая открытые кейсы. Для правил, которые нужны
  // только в очереди или только в кейсе, — отдельные страницы (Salesforce — SPA, адрес проверяется на каждом скане)
  const PAGES = [
    { id: 'sf-case-list', name: 'SF: case lists (queue) only', re: /^https:\/\/[^/]+\.lightning\.force\.com\/lightning\/o\/Case\/list/i },
    { id: 'sf-case-record', name: 'SF: open Case only', re: /^https:\/\/[^/]+\.lightning\.force\.com\/lightning\/r\/Case\/[^/]+\/view/i },
  ];

  // Цвета попадают в CSS, поэтому всё, что не #rrggbb, заменяем на первый пресет
  function normalize(list) {
    return (Array.isArray(list) ? list : []).map((r) => ({
      name: String((r && r.name) || ''),
      text: String((r && r.text) || ''),
      site: String((r && r.site) || SITE_ALL),
      url: String((r && r.url) || ''),
      bg: COLOR_RE.test(r && r.bg) ? r.bg : PRESETS[0].bg,
      color: COLOR_RE.test(r && r.color) ? r.color : PRESETS[0].color,
      enabled: !(r && r.enabled === false),
    }));
  }

  // Несколько текстов в одном правиле — через запятую
  function splitTexts(text) {
    return String(text).split(',').map((t) => t.trim()).filter(Boolean);
  }

  function appliesTo(rule, href) {
    if (rule.site === SITE_ALL) return true;
    if (rule.site === SITE_CUSTOM) {
      const part = rule.url.trim().toLowerCase();
      return !part || href.toLowerCase().includes(part);
    }
    const page = PAGES.find((p) => p.id === rule.site);
    if (page) return page.re.test(href);
    const site = XT.registry && XT.registry.sites.find((s) => s.id === rule.site);
    return !!site && site.matches.some((m) => XT.registry.matchPatternRe(m).test(href));
  }

  XT.highlightRules = {
    PRESETS,
    SITE_ALL,
    SITE_CUSTOM,
    PAGES,
    splitTexts,
    appliesTo,

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
