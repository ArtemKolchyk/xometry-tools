// Background service worker: запросы в ERP с cookies пользователя и открытие вкладок.
// Принимает только URL из разрешённых доменов, чтобы не быть прокси для произвольных запросов.
'use strict';

const ERP_API_ORIGINS = ['https://api.xometry.com/', 'https://www.xometry.com/api/'];
const OPEN_TAB_ORIGINS = ['https://www.xometry.com/'];
const AUTH_KEY = 'xt:erpAuth';   // последний известный статус входа в ERP, показывается в popup
const TIMEOUT_MS = 60000;   // по некоторым джобам ERP отвечает дольше 20 с

let lastAuth = null;

function setAuth(ok, message = '') {
  // Пишем только при смене статуса или раз в минуту, чтобы не дёргать storage на каждый запрос
  if (lastAuth && lastAuth.ok === ok && Date.now() - lastAuth.time < 60000) return;
  lastAuth = { ok, message, time: Date.now() };
  chrome.storage.local.set({ [AUTH_KEY]: lastAuth });
}

async function erpGet(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let r;
  try {
    r = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Request timed out' : 'Network error');
  } finally {
    clearTimeout(timer);
  }

  if (r.status === 401 || r.status === 403 || /login|signin|sso/i.test(r.url || '')) {
    const message = 'Not authorized in ERP: log in to ERP in this browser';
    setAuth(false, message);
    throw new Error(message);
  }
  if (r.status !== 200) throw new Error(`ERP responded with ${r.status}`);
  setAuth(true);

  const text = await r.text();
  try { return JSON.parse(text); }
  catch (e) { throw new Error('ERP did not return JSON'); }
}

// ---------------- Salesforce API: история кейсов (Case timeline, админский скрипт) ----------------
// С домена lightning.force.com API по cookies не работает, поэтому берём сессию (cookie sid) с
// <org>.my.salesforce.com и шлём её как Bearer. Нужны опциональные разрешения cookies и
// *.my.salesforce.com: без них chrome.cookies нет и запрос сразу падает с понятной ошибкой.
const SF_LIGHTNING_HOST_RE = /^([a-z0-9-]+(?:\.sandbox)?)\.lightning\.force\.com$/i;
const SF_CASE_ID_RE = /^500[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
const SF_API_VERSION = 'v60.0';
const SF_MAX_CASES = 200;

async function sfCaseHistory(pageUrl, caseIds) {
  const m = SF_LIGHTNING_HOST_RE.exec(new URL(pageUrl).hostname);
  if (!m) throw new Error('Not a Salesforce Lightning page');
  const ids = (Array.isArray(caseIds) ? caseIds : []).filter((id) => SF_CASE_ID_RE.test(id)).slice(0, SF_MAX_CASES);
  if (!ids.length) return [];

  const apiOrigin = `https://${m[1]}.my.salesforce.com`;
  const noAccess = 'No Salesforce API access: grant it in the popup (SF queue → Case timeline)';
  if (!chrome.cookies) throw new Error(noAccess);
  const sid = await chrome.cookies.get({ url: apiOrigin, name: 'sid' }).catch(() => null);
  if (!sid) throw new Error(`${noAccess}, or log in to Salesforce again`);

  const soql = 'SELECT CaseId, Field, NewValue, CreatedDate, CreatedBy.Name FROM CaseHistory '
    + `WHERE CaseId IN (${ids.map((id) => `'${id}'`).join(',')}) AND Field IN ('Owner', 'ownerAssignment', 'Status') `
    + 'ORDER BY CreatedDate ASC';
  let url = `${apiOrigin}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  const records = [];
  while (url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let r;
    try {
      r = await fetch(url, {
        headers: { Authorization: `Bearer ${sid.value}`, Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'Salesforce API timed out' : 'Network error');
    } finally {
      clearTimeout(timer);
    }
    if (r.status === 401) throw new Error('Salesforce session expired: reload the Salesforce tab');
    if (!r.ok) {
      const body = await r.json().catch(() => null);
      throw new Error(`Salesforce API: ${(Array.isArray(body) && body[0] && body[0].message) || r.status}`);
    }
    const data = await r.json();
    data.records.forEach((rec) => records.push({
      caseId: rec.CaseId,
      field: rec.Field,
      newValue: rec.NewValue == null ? '' : String(rec.NewValue),
      time: rec.CreatedDate,
      by: (rec.CreatedBy && rec.CreatedBy.Name) || '',
    }));
    url = data.nextRecordsUrl ? apiOrigin + data.nextRecordsUrl : null;
  }
  return records;
}

// ---------------- Partner rating: пункт контекстного меню ----------------
// Меню переживает перезапуск браузера, поэтому создаётся при установке/обновлении расширения.
// Что именно кликнули (ссылка, её текст), знает только страница — отправляем туда XT_RATE.
const RATE_MENU = [
  { id: 'red', title: '🔴 Red' },
  { id: 'yellow', title: '🟡 Yellow' },
  { id: 'green', title: '🟢 Green' },
  { id: 'remove', title: 'Remove rating' },
];
const RATE_PREFIX = 'xt-rate:';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    const common = { contexts: ['link', 'selection'], documentUrlPatterns: ['https://*.lightning.force.com/*'] };
    chrome.contextMenus.create({ ...common, id: 'xt-rate', title: 'Partner rating' });
    RATE_MENU.forEach((item, i) => {
      if (item.id === 'remove') {
        chrome.contextMenus.create({ ...common, id: `xt-rate-sep${i}`, parentId: 'xt-rate', type: 'separator' });
      }
      chrome.contextMenus.create({ ...common, id: RATE_PREFIX + item.id, parentId: 'xt-rate', title: item.title });
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !String(info.menuItemId).startsWith(RATE_PREFIX)) return;
  chrome.tabs.sendMessage(tab.id, {
    type: 'XT_RATE',
    rating: String(info.menuItemId).slice(RATE_PREFIX.length),
    linkUrl: info.linkUrl || '',
    selectionText: info.selectionText || '',
  }, { frameId: info.frameId || 0 }).catch(() => {
    // На вкладке нет content script (открыта до установки расширения) — тихо, страницу надо перезагрузить
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Хост берём из вкладки-отправителя, а не из сообщения
  if (msg && msg.type === 'SF_CASE_HISTORY' && sender.url) {
    sfCaseHistory(sender.url, msg.caseIds).then(
      (data) => sendResponse({ ok: true, data }),
      (err) => sendResponse({ ok: false, error: err.message }),
    );
    return true;
  }

  if (!msg || typeof msg.url !== 'string') return false;

  if (msg.type === 'ERP_GET') {
    if (!ERP_API_ORIGINS.some((o) => msg.url.startsWith(o))) {
      sendResponse({ ok: false, error: 'URL is not allowed' });
      return false;
    }
    erpGet(msg.url).then(
      (data) => sendResponse({ ok: true, data }),
      (err) => sendResponse({ ok: false, error: err.message }),
    );
    return true;   // ответ асинхронный
  }

  if (msg.type === 'OPEN_TAB') {
    if (!OPEN_TAB_ORIGINS.some((o) => msg.url.startsWith(o))) {
      sendResponse({ ok: false, error: 'URL is not allowed' });
      return false;
    }
    const props = { url: msg.url, active: true };
    if (sender.tab) { props.index = sender.tab.index + 1; props.openerTabId = sender.tab.id; }
    chrome.tabs.create(props).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: err.message }),
    );
    return true;
  }

  return false;
});
