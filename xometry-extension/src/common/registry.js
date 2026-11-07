// Реестр сайтов и скриптов. По нему строится popup и берутся значения по умолчанию.
// Новый скрипт = запись здесь + блок content_scripts в manifest.json.
// stub: true — заглушка: видна в popup, но не включается.
// general: true — общие скрипты: работают на всех (не заглушечных) сайтах из списка.
// settings: true — не сайт, а страница общих настроек расширения (src/popup/settings-page.js).
// admin: true (у скрипта или у сайта целиком) — только в админском режиме (XT.prefs.adminMode):
//   без него скрипт скрыт в popup и не запускается, даже если его переключатель включён.
(function () {
  'use strict';
  const XT = (globalThis.XT = globalThis.XT || {});

  const sites = [
    {
      id: 'settings',
      name: 'Settings',
      host: 'Whole extension',
      settings: true,
      matches: [],
    },
    {
      id: 'general',
      name: 'General',
      host: 'All supported sites',
      general: true,
      matches: [],   // заполняется ниже из остальных сайтов
    },
    {
      id: 'sf-queue',
      name: 'SF queue',
      host: '*.lightning.force.com',
      matches: ['https://*.lightning.force.com/*'],
    },
    {
      id: 'qcc',
      name: 'QC Center',
      host: '*.xometry.com/qc-center-app',
      matches: ['https://*.xometry.com/qc-center-app/*'],
    },
    {
      id: 'erp',
      name: 'ERP',
      host: 'www.xometry.com/erp',
      matches: ['https://www.xometry.com/erp/*'],
      stub: true,
    },
    // page — не сайт, а страница popup (списки Partners / Customers, src/popup/watchlist-editor.js); внизу меню
    {
      id: 'partners',
      name: 'Partners',
      host: 'Marked on ERP sidebar cards',
      page: 'watchlist',
      kind: 'partners',
      matches: [],
    },
    {
      id: 'customers',
      name: 'Customers',
      host: 'Marked on ERP sidebar cards',
      page: 'watchlist',
      kind: 'customers',
      matches: [],
    },
  ];

  sites.find((s) => s.general).matches = sites
    .filter((s) => !s.general && !s.stub)
    .flatMap((s) => s.matches);

  const scripts = [
    {
      id: 'text-highlighter',
      site: 'general',
      name: 'Text highlighter',
      description: 'Highlight names and phrases with your own colors. Several texts per rule: separate with commas. '
        + 'On overlap the upper rule wins.',
      editor: 'highlight-rules',
    },
    {
      id: 'auto-refresh',
      site: 'general',
      name: 'Auto refresh',
      description: 'Reloads the page on a timer. Mouse movement and scrolling are ignored: only clicks and key presses '
        + 'count as activity. Never reloads while a field or an open editor (e.g. an email) has text.',
      defaultEnabled: false,
      editor: 'auto-refresh',
      options: { intervalMin: 5, pauseWhenActive: true, idleSec: 60 },
    },
    {
      id: 'sf-erp-sidebar',
      site: 'sf-queue',
      name: 'ERP sidebar',
      description: 'ERP info cards next to each case in the queue: inspection type, part IDs. ITAR cases: see Settings.',
      cachePrefix: 'erpjob6:',
      partnerCachePrefix: 'erpvendor1:',   // статистика партнёра (Jobs completed) по acceptedVendor
      customerCachePrefix: 'erpcustomer1:',   // клиент джобы: компания, контакт, email
      actions: [
        { id: 'refresh-all', label: 'Refresh all' },
      ],
    },
    {
      id: 'sf-case-timeline',
      site: 'sf-queue',
      name: 'Case timeline',
      description: 'On ERP sidebar cards: when a colleague took the case (first owner change to a person), when it went '
        + 'to Pending, and the time in between. ⏳ — still in work. Works together with the ERP sidebar.',
      admin: true,
      defaultEnabled: false,
      cachePrefix: 'sfhist1:',
      // Опциональные разрешения: запрашиваются кнопкой в popup, у обычных пользователей их нет
      permissions: { permissions: ['cookies'], origins: ['https://*.my.salesforce.com/*'] },
      permissionsLabel: 'Salesforce API access',
    },
    {
      id: 'sf-case-erp-button',
      site: 'sf-queue',
      name: 'Open case job in ERP',
      description: 'Adds an ERP button to Salesforce Case records when a job number is present.',
    },
    {
      id: 'sf-case-cc-check',
      site: 'sf-queue',
      name: 'Additional VQC Email check',
      description: 'On Send from a Case: if the Additional VQC Email (when it differs from Web Email) is not among '
        + 'the recipients, asks to add it to CC or send without it.',
    },
    {
      id: 'sf-case-quick-text',
      site: 'sf-queue',
      name: 'Case quick text',
      description: 'Your own buttons on a Case: each inserts its text where the cursor is. Drag ⠿ to reorder.',
      editor: 'quick-text',
      actions: [
        { id: 'arrange', label: 'Arrange on page' },
      ],
    },
    {
      id: 'partner-rating',
      site: 'sf-queue',
      name: 'Partner rating',
      description: 'Your personal 🔴 🟡 🟢 rating of partners. Right-click a contact name (or selected text) → '
        + 'Partner rating. Stored only in this browser: use Export for a backup.',
      editor: 'partner-rating',
    },
    {
      id: 'sf-placeholder',
      site: 'sf-queue',
      name: 'More Salesforce tools',
      description: 'Placeholder for upcoming Salesforce scripts.',
      stub: true,
    },
    {
      id: 'qcc-quick-verdict',
      site: 'qcc',
      name: 'Quick verdict',
      description: 'Accept All / Reject All buttons in the Submit Verdict dialog: fill status, reason and quantities.',
    },
    {
      id: 'erp-placeholder',
      site: 'erp',
      name: 'ERP job helpers',
      description: 'Placeholder for upcoming ERP page scripts.',
      stub: true,
    },
  ];

  const getSite = (id) => sites.find((s) => s.id === id);
  const isAdminScript = (script) => !!(script.admin || (getSite(script.site) || {}).admin);

  XT.registry = {
    sites,
    scripts,
    getSite,
    getScript: (id) => scripts.find((s) => s.id === id),
    scriptsForSite: (siteId) => scripts.filter((s) => s.site === siteId),
    isAdminScript,
    // Доступен ли скрипт / сайт при текущем режиме
    scriptAvailable: (script, adminMode) => adminMode || !isAdminScript(script),
    siteAvailable: (site, adminMode) => adminMode || !site.admin,
  };
})();
