// Реестр сайтов и скриптов. По нему строится popup и берутся значения по умолчанию.
// Новый скрипт = запись здесь + блок content_scripts в manifest.json.
// stub: true — заглушка: видна в popup, но не включается.
// general: true — общие скрипты: работают на всех (не заглушечных) сайтах из списка.
// settings: true — не сайт, а страница общих настроек расширения (src/popup/settings-page.js).
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
      description: 'Reloads the page on a timer. Never reloads while a focused field has unsaved text.',
      defaultEnabled: false,
      editor: 'auto-refresh',
      options: { intervalMin: 5, pauseWhenActive: true, idleSec: 60 },
    },
    {
      id: 'sf-erp-sidebar',
      site: 'sf-queue',
      name: 'ERP sidebar',
      description: 'ERP info cards next to each case in the queue: inspection type, part IDs. ITAR cases: see Settings.',
      cachePrefix: 'erpjob2:',
      actions: [
        { id: 'refresh-all', label: 'Refresh all' },
      ],
    },
    {
      id: 'sf-case-erp-button',
      site: 'sf-queue',
      name: 'Open case job in ERP',
      description: 'Adds an ERP button to Salesforce Case records when a job number is present.',
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

  XT.registry = {
    sites,
    scripts,
    getScript: (id) => scripts.find((s) => s.id === id),
    scriptsForSite: (siteId) => scripts.filter((s) => s.site === siteId),
  };
})();
