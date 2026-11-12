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

// GET (или POST с init) в ERP с cookies пользователя; резолвится распарсенным JSON.
// trackAuth: ответ влияет на статус входа в popup. Только REST: GraphQL-шлюз отвечает 403 и по другим
// причинам (Origin), а «not logged in» при работающем REST сбивает с толку.
async function erpFetch(url, init = {}, { trackAuth = true } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let r;
  try {
    r = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      ...init,
      headers: { Accept: 'application/json', ...(init.headers || {}) },
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Request timed out' : 'Network error');
  } finally {
    clearTimeout(timer);
  }

  if (r.status === 401 || r.status === 403 || /login|signin|sso/i.test(r.url || '')) {
    // Для разбора отказов: что именно ответил сервер (видно в консоли service worker)
    r.clone().text().then((t) => console.warn(`[XT] ${init.method || 'GET'} ${url} → ${r.status} ${r.url}\n${t.slice(0, 1000)}`), () => {});
    const message = `Not authorized in ERP (${r.status}): log in to ERP in this browser`;
    if (trackAuth) setAuth(false, message);
    throw new Error(message);
  }
  if (r.status !== 200) throw new Error(`ERP responded with ${r.status}`);
  if (trackAuth) setAuth(true);

  const text = await r.text();
  try { return JSON.parse(text); }
  catch (e) { throw new Error('ERP did not return JSON'); }
}

// ---------------- Общий кеш ответов ERP ----------------
// Одни и те же данные просят несколько скриптов и вкладок сразу (ERP sidebar и плашка кейса, 2–3 вкладки SF).
// Одинаковый запрос, который уже идёт, не отправляется второй раз: все ждут один ответ.
// Готовый ответ живёт MEMO_TTL_MS; fresh: true (кнопки ↻, Shift+click) — всегда новый запрос.
// Кеш в памяти service worker: Chrome выгружает его через ~30 с простоя, и кеш просто начинается заново.
const MEMO_TTL_MS = 60 * 1000;
const MEMO_MAX = 300;
const memo = new Map();   // key -> { time, promise }

function memoized(key, fresh, fn) {
  const hit = memo.get(key);
  if (!fresh && hit && Date.now() - hit.time < MEMO_TTL_MS) return hit.promise;
  const promise = fn();
  memo.set(key, { time: Date.now(), promise });
  promise.catch(() => { if (memo.get(key) && memo.get(key).promise === promise) memo.delete(key); });
  if (memo.size > MEMO_MAX) {
    for (const [k, v] of memo) if (Date.now() - v.time >= MEMO_TTL_MS) memo.delete(k);
  }
  return promise;
}

const erpGet = (url, fresh) => memoized(`GET ${url}`, fresh, () => erpFetch(url));

// ---------------- ERP GraphQL (плашка на странице кейса) ----------------
// Страница передаёт только имя операции, ID и (для записи) значение; сами query живут здесь,
// чтобы расширение не стало прокси для произвольных GraphQL-запросов.
const ERP_GRAPHQL_URL = 'https://www.xometry.com/graphql/federation/employee';
const JOB_ID_RE = /^J[0-9A-Z]{6,10}$/;
const ERP_GRAPHQL_OPS = {
  // id — номер джобы (J03E8EE8). virtualInspection — это тумблер Partner Shipping Block (true = отправка заблокирована)
  PartnerJob: {
    idRe: JOB_ID_RE,
    query: 'query PartnerJob($id: String!) { partnerJob(id: $id) { id acceptedVendor internalNotes virtualInspection '
      + 'lineItems { xometryOrderId } } }',
  },
  // Запись: тумблер Partner Shipping Block. value — новое значение (boolean). Не кешируется;
  // после записи кеш PartnerJob этой джобы сбрасывается, чтобы следующее чтение было свежим.
  UpdateVirtualInspection: {
    idRe: JOB_ID_RE,
    mutation: true,
    requiresScript: 'sf-case-shipping-block',   // запись разрешена, только если этот скрипт включён в popup
    invalidates: (id) => [`GQL PartnerJob ${id}`],
    variables: (id, value) => {
      if (typeof value !== 'boolean') throw new Error('Bad value');
      return { input: { jobId: id, virtualInspection: value } };
    },
    query: 'mutation UpdateVirtualInspection($input: UpdateVirtualInspectionInput!) { '
      + 'updateVirtualInspection(input: $input) { virtualInspection } }',
  },
  // id — номер заказа (6C3EE-1500C)
  GetOrderDetails: {
    idRe: /^[0-9A-Z]{4,8}-[0-9A-Z]{4,8}$/,
    query: 'query GetOrderDetails($id: ID!) { getOrder(id: $id) { id '
      + 'orderAssignment { caseManagerName } '
      + 'customer { customerName customerEmail companyName } '
      + 'orderNotes { text createdAt staffUser { name } } '
      + 'lineItems { outsourcing { jobs { jobId partnerId partnerName } } } } }',
  },
};

function erpGraphql(operation, id, fresh, value) {
  const op = ERP_GRAPHQL_OPS[operation];
  if (!op) return Promise.reject(new Error('Operation is not allowed'));
  if (typeof id !== 'string' || !op.idRe.test(id)) return Promise.reject(new Error('Bad ID'));
  let variables;
  try { variables = op.variables ? op.variables(id, value) : { id }; }
  catch (e) { return Promise.reject(e); }

  const run = async () => {
    const body = await erpFetch(`${ERP_GRAPHQL_URL}?op=${operation}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationName: operation, query: op.query, variables }),
    }, { trackAuth: false });
    // Для записи ошибка — любая ошибка GraphQL, даже если data пришла (частичный успех не считаем успехом)
    if (body && Array.isArray(body.errors) && body.errors.length && (op.mutation || !body.data)) {
      throw new Error(`ERP: ${body.errors[0].message || 'GraphQL error'}`);
    }
    return (body && body.data) || {};
  };

  if (!op.mutation) return memoized(`GQL ${operation} ${id}`, fresh, run);
  return scriptEnabled(op.requiresScript).then((on) => {
    if (!on) throw new Error('Turn on the script in the extension popup first');
    return run().finally(() => op.invalidates(id).forEach((key) => memo.delete(key)));
  });
}

// Включён ли скрипт: тот же ключ, что у XT.settings (src/common/settings.js); пауза всех скриптов тоже учитывается.
// Скрипты записи выключены по умолчанию, поэтому «нет записи» = выключен.
async function scriptEnabled(scriptId) {
  const items = await chrome.storage.sync.get(['xt:enabled', 'xt:prefs']);
  const prefs = items['xt:prefs'] || {};
  return !prefs.paused && !!(items['xt:enabled'] || {})[scriptId];
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
  const noAccess = 'No Salesforce API access: grant it in the popup (SF queue → Salesforce API access)';
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

// Кеши прежних форматов: их уже никто не читает, а значит и не чистит по сроку — удаляем при обновлении
const LEGACY_CACHE_PREFIXES = ['erpcustomer1:'];

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(null).then((items) => {
    const stale = Object.keys(items).filter((k) => LEGACY_CACHE_PREFIXES.some((p) => k.startsWith(p)));
    if (stale.length) return chrome.storage.local.remove(stale);
  }).catch(() => {});

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

  if (msg && msg.type === 'ERP_GRAPHQL') {
    erpGraphql(msg.operation, msg.id, !!msg.fresh, msg.value).then(
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
    erpGet(msg.url, !!msg.fresh).then(
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
