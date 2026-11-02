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

// ---------------- Сайты ----------------
function renderSites() {
  els.sites.replaceChildren(...registry.sites.map((site) => {
    const btn = el('button', { type: 'button', className: `site${site.general || site.settings ? ' divided' : ''}` }, [el('span', { className: 'name', textContent: site.name })]);
    btn.setAttribute('aria-current', String(site.id === selectedSiteId));
    if (site.id === currentSiteId) btn.append(el('span', { className: 'here', title: 'Current tab' }));
    if (site.stub) btn.append(el('span', { className: 'badge', textContent: 'soon' }));
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

function renderScripts() {
  const site = registry.sites.find((s) => s.id === selectedSiteId);
  els.siteName.textContent = site.name;
  els.siteHost.textContent = site.host;

  if (site.settings) {
    els.scripts.replaceChildren(...renderSettingsPage(prefs, refreshState));
    return;
  }

  els.scripts.replaceChildren(...registry.scriptsForSite(site.id).map((script) => {
    const head = el('div', { className: 'script-head' }, [el('span', { className: 'name', textContent: script.name })]);
    if (script.stub) head.append(el('span', { className: 'badge', textContent: 'soon' }));
    head.append(renderSwitch(script));

    const card = el('div', { className: `script${script.stub ? ' stub' : ''}` }, [
      head,
      el('p', { textContent: script.description }),
    ]);

    if (script.editor === 'highlight-rules') card.append(renderHighlightEditor());
    if (script.editor === 'auto-refresh') card.append(renderAutoRefreshEditor(script.id));
    if (script.editor === 'quick-text') card.append(renderQuickTextEditor());

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
  await refreshState();
}

init().catch((e) => showMessage(e.message, true));
