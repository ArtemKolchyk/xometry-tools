// Страница Settings в popup: Pause all, ITAR user, ERP и кеш, резервная копия, место в storage, о расширении.
// Использует общие функции popup.js (el, showMessage, broadcast, minutesAgo, ERP_LOGIN_URL, AUTH_KEY).
'use strict';

const GITHUB_URL = 'https://github.com/ArtemKolchyk/xometry-tools';
const EXPORT_APP = 'xometry-tools';

// Разделы chrome.storage.sync: по ним работают экспорт/импорт и разбивка места.
// xt:prefs (Pause all, ITAR user) не экспортируется: это личные настройки, а не то, чем делятся с коллегами.
const SYNC_SECTIONS = [
  { id: 'switches', name: 'Script switches', match: (k) => k === 'xt:enabled' },
  { id: 'options', name: 'Script options', match: (k) => k.startsWith('xt:options:') },
  { id: 'highlight', name: 'Highlight rules', match: (k) => k === 'xt:highlightRules' },
  { id: 'quickText', name: 'Quick text buttons', match: (k) => k.startsWith('xt:quickText:') },
  { id: 'watchlist', name: 'Partners and customers', match: (k) => k.startsWith('xt:watchlist:') },
];

const CHANGELOG = [
  ['0.7.2', 'Case ERP panel: real Partner Shipping Block state; switch it right from the Case with the new '
    + '"Shipping block toggle" (off by default, asks to confirm). Text highlighter: rules can be limited to case lists '
    + '(queue) or to an open Case.'],
  ['0.7.1', 'Faster: less work on Salesforce pages (nothing runs in background tabs, highlights recalculate only '
    + 'when the page changes), repeated ERP requests are merged. ERP sidebar More shows the CM.'],
  ['0.7.0', 'Case ERP panel: under the Case header — customer, partner with jobs completed, CM, internal notes '
    + 'of the job and staff notes of the order; ▲! for names from your Partners / Customers lists.'],
  ['0.6.0', 'Partners and Customers: your own lists with notes (bottom of the menu); matching ERP sidebar cards '
    + 'get a ▲! sign, the note shows on hover and in More. Additional VQC Email check: on Send from a Case, '
    + 'asks to add the Additional VQC Email to CC.'],
  ['0.5.1', 'Partner rating: compact popup (color filters, search, recent), full list on its own page '
    + '(Manage all): sortable table, inline edit, import.'],
  ['0.5.0', 'Partner rating: your own 🔴 🟡 🟢 marks via right-click on a contact name. '
    + 'Auto refresh: only clicks and key presses count as activity; never reloads while you write an email.'],
  ['0.4.0', 'Settings: pause all, ITAR user, ERP and cache, backup, storage usage, about. '
    + 'Highlighter: rule names, several texts per rule, per-site rules.'],
  ['0.3.0', 'Own quick text buttons with page places and arrange mode; QC Center quick verdict.'],
  ['0.2.0', 'ERP sidebar, Open in ERP button, text highlighter, auto refresh.'],
];

function settingsCard(title, description, children = [], headExtra = []) {
  const head = el('div', { className: 'script-head' }, [el('span', { className: 'name', textContent: title }), ...headExtra]);
  return el('div', { className: 'script' }, [head, el('p', { textContent: description }), ...children]);
}

function settingsButton(label, onClick) {
  const b = el('button', { type: 'button', className: 'btn', textContent: label });
  b.addEventListener('click', () => Promise.resolve(onClick()).catch((e) => showMessage(e.message, true)));
  return b;
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

// ---------------- Pause all / ITAR user ----------------
function prefCard(prefs, key, title, description, onChange) {
  const input = el('input', { type: 'checkbox', checked: !!prefs[key] });
  input.setAttribute('role', 'switch');
  input.setAttribute('aria-label', title);
  input.addEventListener('change', async () => {
    await XT.prefs.set({ [key]: input.checked });
    showMessage(`${title}: ${input.checked ? 'on' : 'off'}`);
    onChange();
  });
  return settingsCard(title, description, [], [el('label', { className: 'switch' }, [input, el('span', { className: 'track' })])]);
}

// ---------------- ERP ----------------
function erpCard() {
  const cachePrefix = XT.registry.getScript('sf-erp-sidebar').cachePrefix;
  const status = el('div', { className: 'set-status' });
  const count = el('span', { className: 'muted' });

  async function refresh() {
    const { [AUTH_KEY]: auth } = await chrome.storage.local.get(AUTH_KEY);
    status.className = `set-status${auth ? (auth.ok ? ' ok' : ' bad') : ''}`;
    status.textContent = !auth ? 'No ERP requests yet'
      : auth.ok ? `Connected · last successful request ${minutesAgo(auth.time)}`
      : `Not logged in · ${auth.message}`;
    const n = (await XT.storage.keysByPrefix(cachePrefix)).length;
    count.textContent = `Cache: ${n} job${n === 1 ? '' : 's'}`;
  }

  // Чистим storage сами, чтобы кеш очищался и без открытых вкладок; вкладки после этого пересканируют таблицу
  async function clearCache() {
    await XT.storage.clearByPrefix(cachePrefix);
    await XT.storage.clearByPrefix(XT.registry.getScript('sf-erp-sidebar').partnerCachePrefix);
    await XT.storage.clearByPrefix(XT.registry.getScript('sf-erp-sidebar').customerCachePrefix);
    await XT.storage.clearByPrefix(XT.registry.getScript('sf-case-timeline').cachePrefix);
    const sfSite = XT.registry.sites.find((s) => s.id === 'sf-queue');
    await broadcast(sfSite, { type: 'XT_ACTION', scriptId: 'sf-erp-sidebar', action: 'clear-cache' });
    showMessage('ERP cache cleared');
    refresh();
  }

  refresh();
  return settingsCard('ERP', 'Login status and the ERP sidebar cache (job data, kept up to 7 days).', [
    status,
    el('div', { className: 'script-actions' }, [
      settingsButton('Log in to ERP', () => chrome.tabs.create({ url: ERP_LOGIN_URL })),
      settingsButton('Clear cache', clearCache),
      count,
    ]),
  ]);
}

// ---------------- Backup ----------------
async function exportSettings() {
  const items = await chrome.storage.sync.get(null);
  const data = Object.fromEntries(Object.entries(items).filter(([k]) => SYNC_SECTIONS.some((s) => s.match(k))));
  const file = {
    app: EXPORT_APP,
    version: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    data,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
  const a = el('a', { href: url, download: `xometry-tools-settings-${file.exportedAt.slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showMessage('Settings exported');
}

function renderImport(box, file, onChange) {
  if (!file || file.app !== EXPORT_APP || !file.data || typeof file.data !== 'object') {
    throw new Error('this is not a Xometry Tools settings file');
  }
  const keys = Object.keys(file.data);
  const present = SYNC_SECTIONS.filter((s) => keys.some(s.match));
  if (!present.length) throw new Error('the file has no settings');

  const checks = present.map((section) => ({ section, input: el('input', { type: 'checkbox', checked: true }) }));

  async function apply() {
    const chosen = checks.filter((c) => c.input.checked).map((c) => c.section);
    if (!chosen.length) return;
    if (!confirm(`Replace your ${chosen.map((s) => s.name.toLowerCase()).join(', ')} with the ones from the file?`)) return;
    const inChosen = (k) => chosen.some((s) => s.match(k));
    const incoming = Object.fromEntries(keys.filter(inChosen).map((k) => [k, file.data[k]]));
    // Сначала запись, потом удаление лишнего: если упрёмся в квоту, текущие настройки не потеряются
    await chrome.storage.sync.set(incoming);
    const stale = Object.keys(await chrome.storage.sync.get(null)).filter((k) => inChosen(k) && !(k in incoming));
    if (stale.length) await chrome.storage.sync.remove(stale);
    box.replaceChildren();
    showMessage('Settings imported');
    onChange();
  }

  const when = file.exportedAt ? new Date(file.exportedAt).toLocaleString() : 'unknown date';
  box.replaceChildren(
    el('p', { textContent: `File from v${file.version || '?'}, ${when}. What to import:` }),
    ...checks.map(({ section, input }) => el('label', { className: 'ar-row' }, [input, ` ${section.name}`])),
    el('div', { className: 'script-actions' }, [
      settingsButton('Import selected', apply),
      settingsButton('Cancel', () => box.replaceChildren()),
    ]),
  );
}

function backupCard(onChange) {
  // Системный диалог выбора файла закрывает popup, поэтому импорт — только во вкладке (options page)
  const inTab = document.body.classList.contains('in-tab');
  const fileInput = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
  const importBox = el('div', { className: 'set-import' });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try {
      renderImport(importBox, JSON.parse(await file.text()), onChange);
    } catch (e) {
      showMessage(`Import: ${e.message}`, true);
    }
  });

  return settingsCard('Backup',
    'Save all settings to a file, or load them from a file — yours or a colleague\'s. Pause all, ITAR user '
      + 'and your partner rating are not included (the rating has its own Export: SF queue → Partner rating).', [
      el('div', { className: 'script-actions' }, [
        settingsButton('Export…', exportSettings),
        settingsButton(inTab ? 'Import…' : 'Import… (opens in a tab)', () => (inTab ? fileInput.click() : chrome.runtime.openOptionsPage())),
        fileInput,
      ]),
      importBox,
    ]);
}

// ---------------- Storage ----------------
function storageCard() {
  const fill = el('div', { className: 'usage-fill' });
  const summary = el('div', { className: 'set-status' });
  const lines = el('ul', { className: 'usage-lines' });

  (async () => {
    const quota = chrome.storage.sync.QUOTA_BYTES || 102400;
    const keys = Object.keys(await chrome.storage.sync.get(null));
    const total = await chrome.storage.sync.getBytesInUse(null);
    const pct = Math.min(100, (total / quota) * 100);
    fill.style.width = `${pct}%`;
    fill.classList.toggle('warn', pct > 80);
    summary.textContent = `Synced settings: ${kb(total)} of ${kb(quota)} (${Math.round(pct)}%)`;

    const sections = await Promise.all(SYNC_SECTIONS.map(async (s) => {
      const own = keys.filter(s.match);
      return [s.name, own.length ? await chrome.storage.sync.getBytesInUse(own) : 0];
    }));
    const local = await chrome.storage.local.getBytesInUse(null);
    lines.replaceChildren(
      ...sections.map(([name, bytes]) => el('li', {}, [el('span', { textContent: name }), el('span', { textContent: kb(bytes) })])),
      el('li', {}, [el('span', { textContent: 'ERP cache and partner rating (this computer only)' }), el('span', { textContent: kb(local) })]),
    );
  })().catch((e) => showMessage(e.message, true));

  return settingsCard('Storage',
    'Synced settings follow your Chrome profile and share a 100 KB limit. Long quick text templates use most of it.', [
      summary,
      el('div', { className: 'usage-track' }, [fill]),
      lines,
    ]);
}

// ---------------- About ----------------
const ABOUT_TEXT = 'Helper tools for the Xometry VQC team in Salesforce and QC Center. '
  + 'Pick a site on the left to see its scripts; each one can be turned on or off.';

// Короткие подсказки: то, что не видно из интерфейса
const QUICK_TIPS = [
  ['ERP sidebar', 'stay logged in to ERP in this browser, or the cards stay empty.'],
  ['Partner rating', 'right-click a contact name → Partner rating. Kept only on this computer: export it now and then.'],
  ['Partners / Customers', 'add a company with a note: its ERP sidebar cards get a ▲! sign; "Acme" also matches "ACME, Inc.".'],
  ['Text highlighter', 'several texts per rule, comma-separated; the upper rule wins on overlap.'],
  ['Case quick text', 'Arrange on page lets you drag buttons to other places on a Case.'],
  ['Auto refresh', 'waits after your clicks and key presses; never reloads while a field or an email has text.'],
  ['After an update', 'reload open Salesforce and QC Center tabs.'],
];

function aboutCard() {
  const version = chrome.runtime.getManifest().version;
  return settingsCard('About', ABOUT_TEXT, [
    el('p', { className: 'about-sub', textContent: 'Quick tips' }),
    el('ul', { className: 'changelog' }, QUICK_TIPS.map(([name, text]) => el('li', {}, [el('b', { textContent: name }), ` — ${text}`]))),
    el('p', { className: 'about-sub', textContent: 'What\'s new' }),
    el('ul', { className: 'changelog' }, CHANGELOG.map(([v, text]) => el('li', {}, [el('b', { textContent: `v${v}` }), ` — ${text}`]))),
    el('p', { className: 'muted', textContent: `Xometry Tools v${version} · © 2026 by Artem Kolchyk. All rights reserved` }),
    el('div', { className: 'script-actions' }, [
      settingsButton('GitHub repository', () => chrome.tabs.create({ url: GITHUB_URL })),
    ]),
  ]);
}

// onChange — popup перечитывает состояние и перерисовывается
function renderSettingsPage(prefs, onChange) {
  return [
    prefCard(prefs, 'paused', 'Pause all scripts',
      'Temporarily turns off every script on all sites. Your per-script switches are kept.', onChange),
    prefCard(prefs, 'itarUser', 'ITAR user',
      'Off: ERP sidebar skips ITAR cases (Primary ITAR Field checked). Turn on only if you are authorized to work with ITAR data.', onChange),
    // Видна только в админском режиме; после выключения карточка пропадает
    ...(prefs.adminMode ? [prefCard(prefs, 'adminMode', 'Admin mode',
      'Shows and runs scripts marked admin. Turn off to see the extension as a regular user does.', onChange)] : []),
    erpCard(),
    backupCard(onChange),
    storageCard(),
    aboutCard(),
  ];
}
