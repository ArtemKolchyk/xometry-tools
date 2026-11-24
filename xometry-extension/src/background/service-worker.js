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
// admin: true — ещё и админский режим должен быть включён (скрипты с admin: true в registry.js).
async function scriptEnabled(scriptId, { admin = false } = {}) {
  const items = await chrome.storage.sync.get(['xt:enabled', 'xt:prefs']);
  const prefs = items['xt:prefs'] || {};
  if (admin && !prefs.adminMode) return false;
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

// Сессия API org-а вкладки-отправителя (pageUrl): { apiOrigin, token }
async function sfSession(pageUrl) {
  const m = SF_LIGHTNING_HOST_RE.exec(new URL(pageUrl).hostname);
  if (!m) throw new Error('Not a Salesforce Lightning page');
  const apiOrigin = `https://${m[1]}.my.salesforce.com`;
  const noAccess = 'No Salesforce API access: grant it in the popup (SF queue → Salesforce API access)';
  if (!chrome.cookies) throw new Error(noAccess);
  const sid = await chrome.cookies.get({ url: apiOrigin, name: 'sid' }).catch(() => null);
  if (!sid) throw new Error(`${noAccess}, or log in to Salesforce again`);
  return { apiOrigin, token: sid.value };
}

// Запрос к REST API: path — от /services/data/vXX (или полный путь /services/…); body — объект (JSON)
async function sfFetch(session, path, { method = 'GET', body, headers = {} } = {}) {
  const url = session.apiOrigin + (path.startsWith('/services/') ? path : `/services/data/${SF_API_VERSION}${path}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let r;
  try {
    r = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${session.token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Salesforce API timed out' : 'Network error');
  } finally {
    clearTimeout(timer);
  }
  if (r.status === 401) throw new Error('Salesforce session expired: reload the Salesforce tab');
  if (!r.ok) {
    const err = await r.json().catch(() => null);
    const first = Array.isArray(err) && err[0];
    const fields = first && Array.isArray(first.fields) && first.fields.length ? ` (${first.fields.join(', ')})` : '';
    throw new Error(`Salesforce API: ${(first && first.message) || r.status}${fields}`);
  }
  return r.status === 204 ? null : r.json();
}

// SOQL-запрос со всеми страницами ответа (Salesforce отдаёт до 2000 строк за раз и nextRecordsUrl)
async function sfQuery(session, soql) {
  let path = `/query?q=${encodeURIComponent(soql)}`;
  const records = [];
  while (path) {
    const data = await sfFetch(session, path);
    records.push(...data.records);
    path = data.nextRecordsUrl || null;
  }
  return records;
}

const sfQueryAll = async (pageUrl, soql) => sfQuery(await sfSession(pageUrl), soql);

// Строка для SOQL в одинарных кавычках
const soqlString = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function sfCaseHistory(pageUrl, caseIds) {
  const ids = (Array.isArray(caseIds) ? caseIds : []).filter((id) => SF_CASE_ID_RE.test(id)).slice(0, SF_MAX_CASES);
  if (!ids.length) return [];
  const soql = 'SELECT CaseId, Field, NewValue, CreatedDate, CreatedBy.Name FROM CaseHistory '
    + `WHERE CaseId IN (${ids.map((id) => `'${id}'`).join(',')}) AND Field IN ('Owner', 'ownerAssignment', 'Status') `
    + 'ORDER BY CreatedDate ASC';
  return (await sfQueryAll(pageUrl, soql)).map((rec) => ({
    caseId: rec.CaseId,
    field: rec.Field,
    newValue: rec.NewValue == null ? '' : String(rec.NewValue),
    time: rec.CreatedDate,
    by: (rec.CreatedBy && rec.CreatedBy.Name) || '',
  }));
}

// ---------------- Salesforce API: письма сотрудников (Staff stats, админский скрипт) ----------------
// Отправленные (Status '3' = Sent, не черновики и не входящие) письма из кейсов, автор — один из сотрудников,
// начиная с sinceMs (начало периода считает страница: месяц — по её часовому поясу); один запрос на всех.
// Только при включённом скрипте и админском режиме.
const STAFF_STATS_SCRIPT = 'sf-staff-stats';
const STAFF_MAX_DAYS = 32;   // самый длинный период — с начала месяца
const STAFF_MAX_USERS = 20;

async function sfStaffEmails(pageUrl, userNames, sinceMs) {
  if (!(await scriptEnabled(STAFF_STATS_SCRIPT, { admin: true }))) {
    throw new Error('Staff stats: turn on admin mode and the script in the popup');
  }
  if (typeof sinceMs !== 'number' || !(sinceMs < Date.now()) || Date.now() - sinceMs > STAFF_MAX_DAYS * 86400000) {
    throw new Error('Bad period');
  }
  const names = (Array.isArray(userNames) ? userNames : [])
    .map((n) => (typeof n === 'string' ? n.trim() : ''))
    .filter((n) => n && n.length <= 80)
    .slice(0, STAFF_MAX_USERS);
  if (!names.length) throw new Error('No employees');

  const since = new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const soql = 'SELECT ParentId, Parent.Subject, MessageDate, CreatedBy.Name FROM EmailMessage '
    + `WHERE CreatedBy.Name IN (${names.map((n) => `'${soqlString(n)}'`).join(',')}) `
    + `AND Incoming = false AND Status = '3' AND ParentId != null AND MessageDate >= ${since} `
    + 'ORDER BY MessageDate ASC';
  return (await sfQueryAll(pageUrl, soql))
    .filter((rec) => SF_CASE_ID_RE.test(rec.ParentId || ''))
    .map((rec) => ({
      caseId: rec.ParentId,
      caseSubject: (rec.Parent && rec.Parent.Subject) || '',
      by: (rec.CreatedBy && rec.CreatedBy.Name) || '',
      time: rec.MessageDate,
    }));
}

// ---------------- Salesforce API: child case (Case ERP panel, скрипт sf-child-case) ----------------
// Создаёт Case с ParentId открытого кейса: Record Type, Job (lookup по номеру джобы), Subject.
// Остальные поля — значения по умолчанию формы New Case этого Record Type (Status, Priority, Case Origin…),
// их отдаёт UI API. Владелец — создатель; если в форме указан Owner — после постов он меняется на него. Запись — только при включённом скрипте (доступен всем, не только в админском режиме).
const CHILD_CASE_SCRIPT = 'sf-child-case';
const CHILD_CASE_ADMIN_ONLY = false;   // как admin у скрипта в registry.js
const SF_JOB_LABEL_RE = /^job$/i;     // подпись lookup-поля Job на Case
const CASE_META_TTL_MS = 10 * 60000;
let caseMetaCache = null;             // { origin, time, promise }

// Record Types кейса, доступные пользователю, и lookup-поле Job: { recordTypes: [{ id, name }], jobField, jobObject }
function sfCaseMeta(session) {
  const c = caseMetaCache;
  if (c && c.origin === session.apiOrigin && Date.now() - c.time < CASE_META_TTL_MS) return c.promise;
  const promise = sfFetch(session, '/sobjects/Case/describe').then((d) => {
    const job = d.fields.find((f) => f.type === 'reference' && f.createable && SF_JOB_LABEL_RE.test(String(f.label).trim()));
    return {
      recordTypes: d.recordTypeInfos.filter((r) => r.available && !r.master).map((r) => ({ id: r.recordTypeId, name: r.name })),
      jobField: job ? job.name : null,
      jobObject: job && job.referenceTo && /^\w+$/.test(job.referenceTo[0] || '') ? job.referenceTo[0] : null,
    };
  });
  caseMetaCache = { origin: session.apiOrigin, time: Date.now(), promise };
  promise.catch(() => { if (caseMetaCache && caseMetaCache.promise === promise) caseMetaCache = null; });
  return promise;
}

async function childCaseAllowed() {
  if (!(await scriptEnabled(CHILD_CASE_SCRIPT, { admin: CHILD_CASE_ADMIN_ONLY }))) {
    throw new Error('Turn on "Child case" in the extension popup first');
  }
}

async function sfChildCaseMeta(pageUrl) {
  await childCaseAllowed();
  const meta = await sfCaseMeta(await sfSession(pageUrl));
  return { recordTypes: meta.recordTypes, hasJobField: !!meta.jobField };
}

// Значения по умолчанию формы New Case для Record Type (как в окне создания); без них — пусто
async function sfCreateDefaults(session, recordTypeId) {
  try {
    const d = await sfFetch(session, `/ui-api/record-defaults/create/Case?recordTypeId=${recordTypeId}`);
    const info = d.objectInfos && d.objectInfos.Case && d.objectInfos.Case.fields;
    const fields = {};
    Object.entries((d.record && d.record.fields) || {}).forEach(([name, f]) => {
      const fi = info && info[name];
      // Только простые значения (picklist, текст, галочки); lookup-и вроде Owner не трогаем
      if (f && f.value != null && typeof f.value !== 'object' && fi && fi.createable && !fi.reference) fields[name] = f.value;
    });
    return fields;
  } catch (e) {
    console.warn('[XT] record defaults failed', e);
    return {};
  }
}

// Активные пользователи Salesforce с таким именем (не больше 2: важно только «ровно один»)
const sfActiveUsers = (session, name) =>
  sfQuery(session, `SELECT Id, Name FROM User WHERE Name = '${soqlString(name)}' AND IsActive = true LIMIT 2`);

const MAX_MENTIONS = 10;   // людей в форме; Chatter допускает до 25 упоминаний в посте

// Список имён из формы: строки, без пустых и повторов, не длиннее 80 символов
function cleanUserNames(list) {
  const names = (Array.isArray(list) ? list : []).map((v) => String(v || '').trim()).filter(Boolean);
  if (names.some((n) => n.length > 80)) throw new Error('Name is too long');
  return [...new Set(names)].slice(0, MAX_MENTIONS);
}

// Имена → { name: { found, many, id } } (id — только если пользователь ровно один)
async function sfResolveUsers(session, names) {
  const entries = await Promise.all(names.map(async (name) => {
    const users = await sfActiveUsers(session, name);
    return [name, { found: users.length === 1, many: users.length > 1, id: users.length === 1 ? users[0].Id : null }];
  }));
  return Object.fromEntries(entries);
}

// Для формы до создания: номер родительского кейса (в текст поста) и кого из людей можно @упомянуть
async function sfChildCaseInfo(pageUrl, parentId, names) {
  await childCaseAllowed();
  if (!SF_CASE_ID_RE.test(String(parentId || ''))) throw new Error('Parent case not found');
  const list = cleanUserNames(names);
  const session = await sfSession(pageUrl);
  const [parent] = await sfQuery(session, `SELECT CaseNumber FROM Case WHERE Id = '${parentId}'`);
  const resolved = await sfResolveUsers(session, list);
  // В страницу — без Id пользователей: ей нужно только «найден / нет»
  const users = Object.fromEntries(Object.entries(resolved).map(([n, u]) => [n, { found: u.found, many: u.many }]));
  return { parentNumber: (parent && parent.CaseNumber) || '', users };
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Текст поста → сегменты Chatter: абзац на строку; каждое «@Имя» из mentions ([{ name, id }]) — упоминание.
// Длинные имена — первыми, чтобы «@Ann Lee» не перехватило «@Ann».
function chatterSegments(text, mentions) {
  const byName = new Map(mentions.map((m) => [m.name.toLowerCase(), m.id]));
  const re = mentions.length
    ? new RegExp(mentions.map((m) => `@${escapeRegExp(m.name)}`).sort((a, b) => b.length - a.length).join('|'), 'gi')
    : null;
  const segments = [];
  text.replace(/\r/g, '').split('\n').forEach((line) => {
    segments.push({ type: 'MarkupBegin', markupType: 'Paragraph' });
    let last = 0;
    if (re) {
      re.lastIndex = 0;
      for (let m = re.exec(line); m; m = re.exec(line)) {
        if (m.index > last) segments.push({ type: 'Text', text: line.slice(last, m.index) });
        segments.push({ type: 'Mention', id: byName.get(m[0].slice(1).toLowerCase()) });
        last = m.index + m[0].length;
      }
    }
    const rest = line.slice(last);
    // Пустой абзац Chatter выбрасывает — пустую строку держит неразрывный пробел
    if (rest || !line) segments.push({ type: 'Text', text: rest || ' ' });
    segments.push({ type: 'MarkupEnd', markupType: 'Paragraph' });
  });
  return segments;
}

// Пост в ленту кейса, видимость Xometry Only (InternalUsers). resolved — результат sfResolveUsers.
// Предупреждение — только про «@Имя» в тексте, которое не стало упоминанием. → { ok, warning } | { ok: false, error }
async function sfPostToCase(session, caseId, post, resolved) {
  try {
    const text = String(post.text || '').trim().slice(0, 5000);
    if (!text) return { ok: false, error: 'empty text' };
    const mentions = Object.entries(resolved).filter(([, u]) => u.id).map(([name, u]) => ({ name, id: u.id }));
    const lower = text.toLowerCase();
    const warning = Object.entries(resolved)
      .filter(([name, u]) => !u.id && lower.includes(`@${name.toLowerCase()}`))
      .map(([name, u]) => `@${name} ${u.many ? 'matches several Salesforce users' : 'not found in Salesforce'}: no @mention`)
      .join('; ');
    const segments = chatterSegments(text, mentions);
    await sfFetch(session, '/chatter/feed-elements', {
      method: 'POST',
      body: {
        feedElementType: 'FeedItem',
        subjectId: caseId,
        visibility: 'InternalUsers',
        body: { messageSegments: segments },
      },
    });
    return { ok: true, warning };
  } catch (e) {
    return { ok: false, error: e.message.replace(/^Salesforce API: /, '') };
  }
}

async function sfCreateChildCase(pageUrl, input) {
  await childCaseAllowed();
  const parentId = String(input && input.parentId || '');
  const subject = String(input && input.subject || '').trim();
  const jobId = String(input && input.jobId || '').trim().toUpperCase();
  if (!SF_CASE_ID_RE.test(parentId)) throw new Error('Parent case not found');
  if (!subject || subject.length > 255) throw new Error('Subject is required (up to 255 characters)');
  if (jobId && !JOB_ID_RE.test(jobId)) throw new Error(`Not a job number: ${jobId}`);

  const session = await sfSession(pageUrl);
  const meta = await sfCaseMeta(session);
  const rt = meta.recordTypes.find((r) => r.id === input.recordTypeId);
  if (!rt) throw new Error('Record type is not available');

  const fields = await sfCreateDefaults(session, rt.id);
  Object.assign(fields, { RecordTypeId: rt.id, ParentId: parentId, Subject: subject });
  if (jobId) {
    if (!meta.jobField || !meta.jobObject) throw new Error('Job field not found on Case');
    const rows = await sfQuery(session, `SELECT Id FROM ${meta.jobObject} WHERE Name = '${soqlString(jobId)}' LIMIT 2`);
    if (!rows.length) throw new Error(`Job ${jobId} not found in Salesforce`);
    if (rows.length > 1) throw new Error(`More than one Salesforce job named ${jobId}`);
    fields[meta.jobField] = rows[0].Id;
  }

  // Новый владелец — проверяем ДО создания: ошибочное имя не должно оставить полусделанный кейс
  const [ownerName] = cleanUserNames([input.ownerName]);
  let newOwner = null;
  if (ownerName) {
    const users = await sfActiveUsers(session, ownerName);
    if (users.length !== 1) {
      throw new Error(`Owner ${ownerName}: ${users.length ? 'several Salesforce users with this name' : 'not found in Salesforce'}`);
    }
    newOwner = { id: users[0].Id, name: users[0].Name };
  }

  // Сначала владелец — тот, кто создаёт (как в форме New Case): правила назначения не запускаем, чтобы они его не сменили
  const created = await sfFetch(session, '/sobjects/Case', {
    method: 'POST', body: fields, headers: { 'Sforce-Auto-Assign': 'FALSE' },
  });

  // Посты — в созданный кейс и (отметка «отправлено CM») в родительский; не вышли — кейс всё равно остаётся
  // (ошибка — в ответе, не исключением)
  // Люди для @упоминаний — один раз на оба поста; не нашли — посты всё равно уходят, имена обычным текстом
  let resolved = {};
  if (input.post || input.parentPost) {
    resolved = await sfResolveUsers(session, cleanUserNames(input.mentions)).catch(() => ({}));
  }
  const post = input.post ? await sfPostToCase(session, created.id, input.post, resolved) : null;
  const parentPost = input.parentPost ? await sfPostToCase(session, parentId, input.parentPost, resolved) : null;

  // Номер и владелец — пока кейс ещё наш: после передачи другому создатель может потерять к нему доступ
  const [row] = await sfQuery(session, `SELECT CaseNumber, Owner.Name FROM Case WHERE Id = '${created.id}'`).catch(() => []);
  let owner = (row && row.Owner && row.Owner.Name) || '';

  // Смена владельца — последней, после постов (по той же причине). Не вышло — кейс и посты остаются
  let ownerChange = null;
  if (newOwner) {
    try {
      await sfFetch(session, `/sobjects/Case/${created.id}`, {
        method: 'PATCH', body: { OwnerId: newOwner.id }, headers: { 'Sforce-Auto-Assign': 'FALSE' },
      });
      ownerChange = { ok: true };
      owner = newOwner.name;
    } catch (e) {
      ownerChange = { ok: false, error: e.message.replace(/^Salesforce API: /, '') };
    }
  }

  return {
    id: created.id,
    caseNumber: (row && row.CaseNumber) || '',
    owner,
    recordType: rt.name,
    post,
    parentPost,
    ownerChange,
  };
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

  if (msg && msg.type === 'SF_STAFF_EMAILS' && sender.url) {
    sfStaffEmails(sender.url, msg.userNames, msg.sinceMs).then(
      (data) => sendResponse({ ok: true, data }),
      (err) => sendResponse({ ok: false, error: err.message }),
    );
    return true;
  }

  // Окно выдачи доступа к Salesforce API (форма Child case): запросить разрешение можно только по клику
  // на странице расширения, из content script нельзя
  if (msg && msg.type === 'OPEN_SF_GRANT') {
    chrome.windows.create({ url: chrome.runtime.getURL('src/popup/grant.html'), type: 'popup', width: 440, height: 260 })
      .then(() => sendResponse({ ok: true }), (err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg && /^SF_(CHILD_CASE_META|CHILD_CASE_INFO|CREATE_CHILD_CASE)$/.test(msg.type) && sender.url) {
    const run = msg.type === 'SF_CHILD_CASE_META' ? sfChildCaseMeta(sender.url)
      : msg.type === 'SF_CHILD_CASE_INFO' ? sfChildCaseInfo(sender.url, msg.parentId, msg.names)
      : sfCreateChildCase(sender.url, msg.input);
    run.then(
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
