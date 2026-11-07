// Popup: слева сайты из реестра, справа скрипты выбранного сайта с переключателями и кнопками действий.
// Та же страница открывается как options page (во вкладке).
'use strict';

const { registry, settings } = XT;
const ERP_LOGIN_URL = 'https://www.xometry.com/erp';
const AUTH_KEY = 'xt:erpAuth';

const els = {
  sites: document.getElementById('sites'),
  siteName: document.getElementById('site-name'),
  siteHost: document.getElementById('site-host'),
  scripts: document.getElementById('scripts'),
  erpStatus: document.getElementById('erp-status'),
  version: document.getElementById('version'),
  message: document.getElementById('message'),
};

let enabled = {};
let prefs = {};             // общие настройки со страницы Settings (XT.prefs)
let currentSiteId = null;   // сайт активной вкладки
let selectedSiteId = null;

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function matchPatternToRegExp(pattern) {
  const escaped = pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.*')}$`);
}

function siteForUrl(url) {
  if (!url) return null;
  const site = registry.sites.find((s) => !s.general && s.matches.some((p) => matchPatternToRegExp(p).test(url)));
  return site ? site.id : null;
}

function showMessage(text, isError = false) {
  els.message.textContent = text;
  els.message.className = isError ? 'error' : '';
}

function minutesAgo(time) {
  const min = Math.round((Date.now() - time) / 60000);
  return min < 1 ? 'just now' : `${min} min ago`;
}

// ---------------- Статус входа в ERP (по последнему запросу из background) ----------------
async function renderErpStatus() {
  const { [AUTH_KEY]: auth } = await chrome.storage.local.get(AUTH_KEY);
  const s = els.erpStatus;
  s.className = 'erp-status';
  s.replaceChildren();
  if (!auth) {
    s.append('ERP: no requests yet');
  } else if (auth.ok) {
    s.classList.add('ok');
    s.append('ERP: connected');
    s.title = `Last successful request ${minutesAgo(auth.time)}`;
  } else {
    s.classList.add('bad');
    const link = el('a', { textContent: 'Log in' });
    link.addEventListener('click', () => chrome.tabs.create({ url: ERP_LOGIN_URL }));
    s.append('ERP: not logged in · ', link);
    s.title = auth.message;
  }
}

// ---------------- Админский режим ----------------
const visibleScripts = (siteId) =>
  registry.scriptsForSite(siteId).filter((s) => registry.scriptAvailable(s, prefs.adminMode));

// Сайт скрыт, если он админский или все его скрипты админские
function siteVisible(site) {
  if (!registry.siteAvailable(site, prefs.adminMode)) return false;
  return site.settings || site.page || !registry.scriptsForSite(site.id).length || visibleScripts(site.id).length > 0;
}

// Бейдж в админском режиме: видно, что обычные пользователи этого не увидят
const adminBadge = () => el('span', { className: 'badge admin', textContent: 'admin', title: 'Visible in admin mode only' });

// SHA-256 пароля админского режима. Сменить пароль (PowerShell):
// $b=[Text.Encoding]::UTF8.GetBytes('новый-пароль'); -join ([Security.Cryptography.SHA256]::Create().ComputeHash($b) | % { $_.ToString('x2') })
const ADMIN_PASSWORD_SHA256 = '5132f9cee186d2784dbc54c9d967c97c9484227b62b408e76a97fb1cbd52fb89';
const UNLOCK_CLICKS = 5;

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 5 быстрых кликов по версии в футере → поле пароля на месте сообщения
function setupAdminUnlock() {
  let clicks = 0;
  let timer = null;
  els.version.addEventListener('click', () => {
    if (prefs.adminMode) return;
    clicks += 1;
    clearTimeout(timer);
    timer = setTimeout(() => { clicks = 0; }, 1500);
    if (clicks < UNLOCK_CLICKS) return;
    clicks = 0;

    const input = el('input', { type: 'password', className: 'admin-password', placeholder: 'Admin password' });
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') showMessage('');
      if (e.key !== 'Enter') return;
      if (await sha256Hex(input.value) !== ADMIN_PASSWORD_SHA256) {
        showMessage('Wrong password', true);
        return;
      }
      await XT.prefs.set({ adminMode: true });
      showMessage('Admin mode on');
      refreshState();
    });
    els.message.className = '';
    els.message.replaceChildren(input);
    input.focus();
  });
}

// ---------------- Сайты ----------------
function renderSites() {
  const visible = registry.sites.filter(siteVisible);
  const firstPage = visible.find((s) => s.page);
  els.sites.replaceChildren(...visible.map((site) => {
    const cls = `site${site.general || site.settings ? ' divided' : ''}${site === firstPage ? ' divided-top' : ''}`;
    const btn = el('button', { type: 'button', className: cls }, [el('span', { className: 'name', textContent: site.name })]);
    btn.setAttribute('aria-current', String(site.id === selectedSiteId));
    if (site.id === currentSiteId) btn.append(el('span', { className: 'here', title: 'Current tab' }));
    if (site.stub) btn.append(el('span', { className: 'badge', textContent: 'soon' }));
    if (site.admin) btn.append(adminBadge());
    btn.addEventListener('click', () => { selectedSiteId = site.id; renderSites(); renderScripts(); });
    return btn;
  }));
}

// ---------------- Скрипты выбранного сайта ----------------
function renderSwitch(script) {
  const input = el('input', { type: 'checkbox', checked: !!enabled[script.id], disabled: !!script.stub });
  input.setAttribute('role', 'switch');
  input.setAttribute('aria-label', `Enable ${script.name}`);
  input.addEventListener('change', async () => {
    enabled[script.id] = input.checked;
    await settings.set(script.id, input.checked);
    showMessage(`${script.name} ${input.checked ? 'enabled' : 'disabled'}`);
    renderScripts();
  });
  return el('label', { className: 'switch' }, [input, el('span', { className: 'track' })]);
}

// Опциональные разрешения скрипта (script.permissions): статус и кнопка запроса
function renderPermissions(script) {
  const box = el('div', { className: 'script-actions' });
  const label = script.permissionsLabel || 'Extra access';
  chrome.permissions.contains(script.permissions).then((granted) => {
    if (granted) {
      box.append(el('span', { className: 'muted', textContent: `${label}: granted` }));
      return;
    }
    const btn = el('button', { type: 'button', className: 'btn', textContent: `Grant ${label.toLowerCase()}` });
    btn.addEventListener('click', () => chrome.permissions.request(script.permissions)
      .then((ok) => {
        showMessage(ok ? `${label} granted: reload Salesforce tabs` : `${label} not granted`, !ok);
        renderScripts();
      })
      .catch((e) => showMessage(e.message, true)));
    box.append(btn);
  }).catch((e) => showMessage(e.message, true));
  return box;
}

function renderScripts() {
  const site = registry.sites.find((s) => s.id === selectedSiteId);
  els.siteName.textContent = site.name;
  els.siteHost.textContent = site.host;

  if (site.settings) {
    els.scripts.replaceChildren(...renderSettingsPage(prefs, refreshState));
    return;
  }
  if (site.page === 'watchlist') {
    els.scripts.replaceChildren(...renderWatchlistPage(site.kind));
    return;
  }

  els.scripts.replaceChildren(...visibleScripts(site.id).map((script) => {
    const head = el('div', { className: 'script-head' }, [el('span', { className: 'name', textContent: script.name })]);
    if (script.stub) head.append(el('span', { className: 'badge', textContent: 'soon' }));
    if (script.admin && !site.admin) head.append(adminBadge());
    head.append(renderSwitch(script));

    const card = el('div', { className: `script${script.stub ? ' stub' : ''}` }, [
      head,
      el('p', { textContent: script.description }),
    ]);

    if (script.editor === 'highlight-rules') card.append(renderHighlightEditor());
    if (script.editor === 'auto-refresh') card.append(renderAutoRefreshEditor(script.id));
    if (script.editor === 'quick-text') card.append(renderQuickTextEditor());
    if (script.editor === 'partner-rating') card.append(renderPartnerRatingEditor());
    if (script.permissions) card.append(renderPermissions(script));

    if (script.actions && script.actions.length) {
      const actions = el('div', { className: 'script-actions' });
      script.actions.forEach((action) => {
        const btn = el('button', { type: 'button', className: 'btn', textContent: action.label });
        btn.disabled = !enabled[script.id] || prefs.paused;
        btn.addEventListener('click', () => runAction(site, script, action).catch((e) => showMessage(e.message, true)));
        actions.append(btn);
      });
      card.append(actions);
    }
    return card;
  }));

  if (prefs.paused) {
    const resume = el('a', { textContent: 'Resume' });
    resume.addEventListener('click', async () => {
      await XT.prefs.set({ paused: false });
      showMessage('Scripts resumed');
      refreshState();
    });
    els.scripts.prepend(el('div', { className: 'banner' }, ['All scripts are paused in Settings · ', resume]));
  }
}

// После изменений на странице Settings: перечитать состояние и перерисовать
async function refreshState() {
  [enabled, prefs] = await Promise.all([settings.getAll(), XT.prefs.get()]);
  // Выбранный сайт мог стать скрытым (вышли из админского режима)
  if (!siteVisible(registry.getSite(selectedSiteId))) selectedSiteId = registry.sites[0].id;
  document.body.classList.toggle('admin-mode', !!prefs.adminMode);
  renderSites();
  renderScripts();
  renderErpStatus();
}

// ---------------- Действия ----------------
// Сообщение во все открытые вкладки сайта; возвращает, сколько вкладок ответило.
// Фильтр tabs.query({ url }) без permission "tabs" ненадёжен, поэтому шлём во все вкладки:
// отвечает только content script нужного скрипта, остальные вкладки отклоняют сообщение.
async function broadcast(site, message) {
  const tabs = (await chrome.tabs.query({}))
    .filter((t) => !t.url || site.matches.some((p) => matchPatternToRegExp(p).test(t.url)));
  const results = await Promise.allSettled(tabs.map((t) => chrome.tabs.sendMessage(t.id, message)));
  return results.filter((r) => r.status === 'fulfilled').length;
}

async function runAction(site, script, action) {
  const message = { type: 'XT_ACTION', scriptId: script.id, action: action.id };
  const n = await broadcast(site, message);
  if (n) showMessage(`${action.label}: sent to ${n} tab${n === 1 ? '' : 's'}`);
  else showMessage(`No ${site.name} tab responded: reload the Salesforce tab and try again`, true);
}

// ---------------- Старт ----------------
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && tab.url.startsWith(chrome.runtime.getURL(''))) document.body.classList.add('in-tab');

  currentSiteId = siteForUrl(tab && tab.url);
  selectedSiteId = currentSiteId || registry.sites[0].id;
  els.version.textContent = `v${chrome.runtime.getManifest().version}`;
  setupAdminUnlock();
  await refreshState();
}

init().catch((e) => showMessage(e.message, true));
