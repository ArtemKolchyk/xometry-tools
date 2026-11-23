// Salesforce Case queue: статистика сотрудников (админский скрипт, только в XT.prefs.adminMode).
// Таблица в шапке списка кейсов, справа от Queue summary (без неё — сразу после заголовка списка).
// Строка на сотрудника (registry: employees) + строка Team. Столбцы:
//   Cases      — кейсы VQC (тема «VQC - J…»), где сотрудник отправил хотя бы одно письмо за период;
//   Parts      — сумма деталей (line items ERP) по job этих кейсов, каждая job один раз;
//   Avg / part — Σ(взят → Pending) / Σ деталей по кейсам, которые взял сам сотрудник
//                (первый цикл кейса, как у Case timeline);
//   Emails     — письма со статусом Sent, автор — сотрудник (не черновики, не входящие, не автописьма).
// Периоды:
//   Shift      — текущая (или последняя) смена каждого сотрудника: его письма за последние 30 часов без перерыва
//                дольше 6 часов, считая от последнего. Часовые пояса и графики не нужны, ночная смена не режется;
//                столбец Shift — первое и последнее письмо смены (время этого компьютера);
//   7 days     — последние 7 суток;
//   This month — с начала текущего месяца (полночь 1-го числа по времени этого компьютера).
// Письма — Salesforce API (background, SF_STAFF_EMAILS, один запрос на всех), история — XT.caseHistory, детали — ERP.
(function () {
  'use strict';

  const SCRIPT_ID = 'sf-staff-stats';
  const LIST_PATH = '/lightning/o/Case/list';
  const BAR_ID = 'xt-staff-stats';
  const SUMMARY_BAR_ID = 'xt-queue-summary';
  const SCAN_MS = 1500;
  const REFRESH_MS = 60 * 60000;    // письма перечитываем раз в час (и по ↻, и при смене периода)
  const ERROR_RETRY_MS = 60000;
  const ERP_CONCURRENT = 2;         // запросов в ERP одновременно (за месяц — сотни jobs, грузятся один раз)
  const KEEP_MS = 45 * 86400000;    // завершённые кейсы и детали jobs не меняются: храним дольше самого длинного периода
  const SHIFT_LOOKBACK_MS = 30 * 3600000;   // где искать смену
  const SHIFT_GAP_MS = 6 * 3600000;         // перерыв между письмами длиннее — это уже другая смена
  const GAP = 12;                   // от плашки Queue summary
  const EDGE_GAP = 24;              // от заголовка списка и от кнопок
  const MIN_WIDTH = 300;
  const VQC_SUBJECT_RE = /^\s*VQC\b/i;
  const JOB_IN_SUBJECT_RE = /\bJ(?=[0-9A-Z]*\d)[0-9A-Z]{6,10}\b/i;
  const COUNT_RE = /(\d[\d,.\s]*)(\+)?\s*items?\b/i;
  // 'day' — смена (ключ прежний, чтобы сохранённый выбор не сбился)
  const PERIODS = [['day', 'Shift'], ['week', '7 days'], ['month', 'This month']];
  const { deepQueryAll, deepText, isVisible, escapeHtml, headerLabels } = XT.dom;

  const script = XT.registry.getScript(SCRIPT_ID);
  const EMPLOYEES = [...new Set(script.employees.map((n) => n.trim()).filter(Boolean))];
  const histCache = XT.createCache(script.histCachePrefix, { maxAgeMs: KEEP_MS });
  const partsCache = XT.createCache(script.partsCachePrefix, { maxAgeMs: KEEP_MS });
  // Детали, которые уже загрузил ERP sidebar, берём из его кеша без запроса
  const sidebarCache = XT.createCache(XT.registry.getScript('sf-erp-sidebar').cachePrefix);

  let opts = { ...script.options };

  // ---------------- Данные ----------------
  // data — письма всех сотрудников за выбранный период:
  //   { period, time, all: Map caseId → jobId|null,
  //     byEmp: Map name → { emails, cases: Map caseId → jobId|null, shift: { start, end } | null } }
  let data = null;
  let loading = false;
  let loadError = '';
  let runId = 0;                     // новый запуск отменяет догрузку старого
  let lastAttempt = 0;               // время последнего запроса писем
  const histMem = new Map();         // caseId → { taken, pending } незавершённых кейсов (только в памяти)
  let histError = '';
  let histLoading = false;
  const partErrors = new Map();      // jobId → сообщение; повтор — по ↻
  let partsLoading = 0;              // сколько jobs ещё в очереди ERP

  const histOf = (caseId) => histCache.get(caseId) || histMem.get(caseId) || null;
  function partsOf(jobId) {
    const own = partsCache.get(jobId);
    if (own) return own.parts;
    const side = sidebarCache.get(jobId);
    return side && side.summary && typeof side.summary.partCount === 'number' ? side.summary.partCount : null;
  }

  function periodStart(period) {
    const now = new Date();
    if (period === 'month') return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    if (period === 'week') return now.getTime() - 7 * 86400000;
    return now.getTime() - SHIFT_LOOKBACK_MS;
  }

  async function refresh() {
    const id = ++runId;
    const period = opts.period;
    lastAttempt = Date.now();
    loading = true;
    loadError = '';
    histError = '';
    histMem.clear();
    partErrors.clear();
    tick();
    try {
      const emails = await XT.sendToBackground({ type: 'SF_STAFF_EMAILS', userNames: EMPLOYEES, sinceMs: periodStart(period) });
      if (id !== runId) return;
      // Письма по сотрудникам (по возрастанию времени — так сортирует запрос)
      const lists = new Map(EMPLOYEES.map((n) => [n.toLowerCase(), []]));
      const jobOf = new Map();   // caseId → jobId|null
      emails.forEach((e) => {
        const list = lists.get(e.by.trim().toLowerCase());
        if (!list || !VQC_SUBJECT_RE.test(e.caseSubject)) return;
        if (!jobOf.has(e.caseId)) {
          const m = e.caseSubject.match(JOB_IN_SUBJECT_RE);
          jobOf.set(e.caseId, m ? m[0].toUpperCase() : null);
        }
        list.push({ caseId: e.caseId, time: Date.parse(e.time) });
      });

      const byEmp = new Map();
      const all = new Map();
      lists.forEach((list, name) => {
        let shift = null;
        if (period === 'day' && list.length) {
          // Смена — хвост писем без перерыва дольше SHIFT_GAP_MS
          let i = list.length - 1;
          while (i > 0 && list[i].time - list[i - 1].time <= SHIFT_GAP_MS) i--;
          list = list.slice(i);
          shift = { start: list[0].time, end: list[list.length - 1].time };
        }
        const cases = new Map();
        list.forEach((e) => { cases.set(e.caseId, jobOf.get(e.caseId)); all.set(e.caseId, jobOf.get(e.caseId)); });
        byEmp.set(name, { emails: list.length, cases, shift });
      });
      data = { period, time: Date.now(), byEmp, all };
    } catch (err) {
      if (id === runId) loadError = err.message;
    } finally {
      if (id === runId) loading = false;
    }
    if (id !== runId || !data || data.period !== period) { tick(); return; }
    tick();
    await Promise.all([loadHistory(id), loadParts(id)]);
  }

  // История кейсов: только тех, что ещё не в кеше. Завершённый первый цикл (взят и ушёл в Pending)
  // больше не меняется — в постоянный кеш; остальные — в память до следующего обновления.
  async function loadHistory(id) {
    const ids = [...data.all.keys()].filter((c) => !histCache.get(c));
    histLoading = ids.length > 0;
    for (let i = 0; i < ids.length && id === runId && running; i += XT.caseHistory.BATCH) {
      const batch = ids.slice(i, i + XT.caseHistory.BATCH);
      try {
        const byCase = await XT.caseHistory.fetch(batch);
        batch.forEach((c) => {
          const h = byCase[c] || {};
          const entry = { time: Date.now(), taken: h.taken || null, pending: h.pending || null };
          if (entry.taken && entry.pending) histCache.set(c, entry); else histMem.set(c, entry);
        });
      } catch (err) {
        histError = err.message;
        break;
      }
      scheduleTick();
    }
    if (id === runId) { histLoading = false; scheduleTick(); }
  }

  // Детали jobs из ERP: по одной записи на job, без повтора тех, что упали (до ↻)
  async function loadParts(id) {
    const jobs = [...new Set([...data.all.values()].filter(Boolean))]
      .filter((j) => partsOf(j) === null && !partErrors.has(j));
    let next = 0;
    partsLoading = jobs.length;
    const worker = async () => {
      while (next < jobs.length && id === runId && running) {
        const jobId = jobs[next++];
        try {
          const d = await XT.erp.getJson(XT.erp.jobApiUrl(jobId));
          const parts = Array.isArray(d && d.lineItems) ? d.lineItems.length : 0;
          partsCache.set(jobId, { time: Date.now(), parts });
        } catch (err) {
          partErrors.set(jobId, err.message);
        }
        if (id === runId) partsLoading--;
        scheduleTick();
      }
    };
    await Promise.all(Array.from({ length: ERP_CONCURRENT }, worker));
    if (id === runId) { partsLoading = 0; scheduleTick(); }
  }

  // ---------------- Подсчёт ----------------
  // cases: Map caseId → jobId; owners: Set имён (lowercase), чьи взятые кейсы идут во время на деталь
  function compute(cases, emails, owners) {
    const jobs = new Map();   // jobId → parts|null
    const r = {
      cases: cases.size, emails, parts: 0, jobs: 0, noJob: 0, partsMissing: 0,
      timed: 0, timedMs: 0, timedParts: 0, perPart: [], notMine: 0, notPending: 0, noHistory: 0,
    };
    cases.forEach((jobId, caseId) => {
      const parts = jobId ? partsOf(jobId) : null;
      if (!jobId) r.noJob++;
      else jobs.set(jobId, parts);

      const h = histOf(caseId);
      if (!h) { r.noHistory++; return; }
      const owner = h.taken ? (h.taken.owner || h.taken.by || '').trim().toLowerCase() : '';
      if (!owners.has(owner)) { r.notMine++; return; }
      if (!h.pending) { r.notPending++; return; }
      if (!parts) return;   // деталей ещё нет (или 0) — время на деталь не посчитать
      const spent = h.pending.time - h.taken.time;
      r.timed++;
      r.timedMs += spent;
      r.timedParts += parts;
      r.perPart.push(spent / parts);
    });
    jobs.forEach((parts) => {
      if (parts === null) r.partsMissing++;
      else { r.parts += parts; r.jobs++; }
    });
    return r;
  }

  // Время этого компьютера, всегда 24 часа и день.месяц — не зависит от языка браузера (без AM/PM)
  const pad2 = (n) => String(n).padStart(2, '0');
  const hm = (t) => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  const dm = (t) => { const d = new Date(t); return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`; };

  // 45s, 6m 30s, 1h 05m
  function formatPerPart(ms) {
    const sec = Math.max(0, Math.round(ms / 1000));
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m${sec % 60 ? ` ${String(sec % 60).padStart(2, '0')}s` : ''}`;
    return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
  }

  function median(list) {
    if (!list.length) return 0;
    const s = [...list].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // ---------------- Плашка ----------------
  const bar = document.createElement('div');
  bar.id = BAR_ID;
  bar.setAttribute('data-xt-header-bar', '');   // Queue summary не считает её заголовком/кнопками при раскладке
  Object.assign(bar.style, { position: 'absolute', zIndex: '5' });

  const S = `#${BAR_ID}`;
  const STYLE = `<style>
    ${S}{box-sizing:border-box;overflow:hidden;white-space:nowrap;padding:5px 12px 6px;
      background:#fff;border:1px solid #d8dde6;border-radius:8px;
      box-shadow:0 1px 2px rgba(24,24,24,.06),0 3px 8px rgba(24,24,24,.1);
      font:12px/15px "Salesforce Sans",-apple-system,"Segoe UI",Arial,sans-serif;color:#181818}
    ${S} .xt-cap{display:flex;align-items:center;gap:6px;margin-bottom:3px;
      font-size:10.5px;line-height:13px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#0e7c6b}
    ${S} .xt-cap>span:first-child::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;
      background:#0e7c6b;margin:0 6px 1px 0;vertical-align:middle}
    ${S} .xt-cap .xt-sp{flex:1}
    ${S} table{border-collapse:collapse;width:100%}
    ${S} th{font-size:10.5px;font-weight:600;color:#706e6b;text-align:right;padding:1px 0 2px 16px;
      border-bottom:1px solid #e5e8ee}
    ${S} th:first-child,${S} td:first-child{text-align:left;padding-left:0}
    ${S} td{padding:2px 0 2px 16px;text-align:right;font-weight:700;font-variant-numeric:tabular-nums}
    ${S} td:first-child{font-weight:400}
    ${S} td:first-child a{color:#181818;text-decoration:none}
    ${S} td:first-child a:hover{color:#0176d3;text-decoration:underline}
    ${S} tbody tr+tr td{border-top:1px solid #f3f3f3}
    ${S} tfoot td{border-top:1px solid #d8dde6;background:#f5fbfa}
    ${S} td.xt-zero{color:#b0adab;font-weight:600}
    ${S} .xt-note{color:#706e6b;white-space:normal;max-width:260px}
    ${S} .xt-ctl{box-sizing:border-box;height:21px;margin:0;padding:0 2px 0 5px;border:1px solid #c9c9c9;border-radius:4px;
      background:#fff;color:#181818;font-family:inherit;font-size:12px;font-weight:600;line-height:normal;
      text-transform:none;letter-spacing:0;cursor:pointer}
    ${S} .xt-ctl:focus{outline:none;border-color:#0176d3;box-shadow:0 0 0 1px #0176d3}
    ${S} .xt-btn{padding:0 5px;font-size:12px;min-width:22px}
  </style>`;

  const cell = (value, { title = '', zero = false } = {}) =>
    `<td${zero ? ' class="xt-zero"' : ''}${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(value)}</td>`;

  // Отчёт Salesforce «VQC Cases with emails sent Today» с фильтром по владельцу кейса
  const reportUrl = (name) => `/lightning/r/Report/${script.reportId}/view?reportFilters=${
    encodeURIComponent(JSON.stringify([{ operator: 'equals', value: name, column: 'OWNER' }]))}`;

  // Ячейка Shift: первое–последнее письмо смены; закончившаяся смена (перерыв уже дольше SHIFT_GAP_MS) — бледнее
  function shiftCell(shift) {
    if (!shift) return cell('—', { zero: true, title: 'No emails in the last 30 hours' });
    const over = Date.now() - shift.end > SHIFT_GAP_MS;
    const day = new Date(shift.start).toDateString() !== new Date().toDateString() ? `${dm(shift.start)} ` : '';
    return cell(`${day}${hm(shift.start)}–${hm(shift.end)}`, {
      zero: over,
      title: `First and last email of the ${over ? 'last (finished)' : 'current'} shift, your local time.\n`
        + 'A shift = emails with no break longer than 6 hours.',
    });
  }

  // Строка таблицы: имя (ссылка на отчёт или подпись), в режиме Shift — время смены, + 4 числа
  function row(nameHtml, name, r, shiftHtml = '') {
    const busy = histLoading || partsLoading;
    const casesTitle = `Cases with a VQC subject where ${name} sent an email in the period.`
      + `\nUnique jobs: ${r.jobs + r.partsMissing}${r.noJob ? `, ${r.noJob} case(s) without a job number in the subject` : ''}`;

    const partsNotes = [
      partsLoading && r.partsMissing && `${r.partsMissing} job(s) loading from ERP…`,
      !partsLoading && r.partsMissing && `${r.partsMissing} job(s) failed in ERP${partErrors.size
        ? `: ${[...partErrors.values()][0]}` : ''} (↻ to retry)`,
    ].filter(Boolean);
    const partsMark = partsLoading && r.partsMissing ? '…' : (r.partsMissing ? '*' : '');
    const partsTitle = `Line items in ERP, each job counted once: ${r.parts} part(s) in ${r.jobs} job(s)`
      + (partsNotes.length ? `\nNot counted: ${partsNotes.join(', ')}` : '');

    let avg;
    let avgTitle = 'Taken → Pending (first cycle of the case, as Case timeline) divided by its parts.'
      + `\nOnly cases taken by ${name}.`;
    if (r.timed) {
      avg = formatPerPart(r.timedMs / r.timedParts) + (busy ? '…' : '');
      avgTitle += `\nTimed ${r.timed} of ${r.cases} case(s), ${r.timedParts} part(s).`
        + `\nMedian per part: ${formatPerPart(median(r.perPart))}`;
    } else {
      avg = busy && r.cases ? '…' : '—';
    }
    const skipped = [
      r.notMine && `${r.notMine} taken by someone else`,
      r.notPending && `${r.notPending} not in Pending yet`,
      r.noHistory && !histLoading && `${r.noHistory} without history`,
      histError && `history error: ${histError}`,
    ].filter(Boolean);
    if (skipped.length) avgTitle += `\nNot timed: ${skipped.join(', ')}`;

    return `<tr><td>${nameHtml}</td>${shiftHtml}`
      + cell(String(r.cases), { title: casesTitle, zero: !r.cases })
      + cell(String(r.parts) + partsMark, { title: partsTitle, zero: !r.parts })
      + cell(avg, { title: avgTitle, zero: !r.timed })
      + cell(String(r.emails), {
        title: `Emails with status Sent created by ${name} in VQC cases (no drafts, no incoming)`, zero: !r.emails,
      })
      + '</tr>';
  }

  function render() {
    const current = data && data.period === opts.period;
    const updated = current
      ? `Updated ${hm(data.time)}. ` : '';
    const cap = '<div class="xt-cap"><span>Staff stats</span><span class="xt-sp"></span>'
      + '<select data-xt="period" class="xt-ctl" title="Shift: each employee\'s current or last shift (emails with no '
      + `break longer than 6 hours). 7 days: the last 7 days. This month: since the 1st of the month">${
        PERIODS.map(([v, label]) => `<option value="${v}"${opts.period === v ? ' selected' : ''}>${label}</option>`).join('')}</select>`
      + `<button data-xt="refresh" class="xt-ctl xt-btn" title="${escapeHtml(updated + (loadError ? `Last refresh failed: ${loadError}. ` : ''))}`
      + 'Refresh (also retries failed ERP jobs)">↻</button>'
      + `<button data-xt="collapse" class="xt-ctl xt-btn" title="${opts.collapsed ? 'Show all employees' : 'Show only the Team row'}">`
      + `${opts.collapsed ? '▾' : '▴'}</button></div>`;

    if (!current) {
      const note = loading ? 'Loading…'
        : /No Salesforce API access/.test(loadError) ? 'No Salesforce API access: grant it in the popup'
        : `⚠ ${loadError || 'No data'}`;
      return `${STYLE}${cap}<div class="xt-note" title="${escapeHtml(loadError)}">${escapeHtml(note)}</div>`;
    }

    const shiftMode = data.period === 'day';
    const head = `<thead><tr><th>Employee</th>${shiftMode ? '<th>Shift</th>' : ''}`
      + '<th>Cases</th><th>Parts</th><th>Avg / part</th><th>Emails</th></tr></thead>';
    const body = opts.collapsed ? '' : EMPLOYEES.map((name) => {
      const emp = data.byEmp.get(name.toLowerCase());
      const link = `<a href="${escapeHtml(reportUrl(name))}" target="_blank" rel="noopener" `
        + `title="Salesforce report: ${escapeHtml(name)}'s VQC cases with emails sent today (by case owner)">${escapeHtml(name)}</a>`;
      return row(link, name, compute(emp.cases, emp.emails, new Set([name.toLowerCase()])),
        shiftMode ? shiftCell(emp.shift) : '');
    }).join('');
    // Team: кейс, где писали двое, считается один раз; время — по кейсам, взятым любым из сотрудников
    const totalEmails = [...data.byEmp.values()].reduce((a, e) => a + e.emails, 0);
    const team = EMPLOYEES.length > 1 || opts.collapsed
      ? `<tfoot>${row('<b>Team</b>', 'the team', compute(data.all, totalEmails,
        new Set(EMPLOYEES.map((n) => n.toLowerCase()))), shiftMode ? '<td></td>' : '')}</tfoot>` : '';
    return `${STYLE}${cap}<table>${head}<tbody>${body}</tbody>${team}</table>`;
  }

  // ---------------- Управление ----------------
  function saveOption(patch) {
    opts = { ...opts, ...patch };
    XT.options.get(SCRIPT_ID).then((o) => XT.options.set(SCRIPT_ID, { ...o, ...patch }));
  }

  bar.addEventListener('change', (event) => {
    const t = event.target;
    if (t.dataset.xt === 'period' && PERIODS.some(([v]) => v === t.value)) {
      saveOption({ period: t.value });
      refresh();
    }
    t.blur();
  });
  bar.addEventListener('click', (event) => {
    const action = event.target.dataset && event.target.dataset.xt;
    if (action === 'refresh') refresh();
    else if (action === 'collapse') { saveOption({ collapsed: !opts.collapsed }); tick(); }
  });
  // Клавиши в списке плашки не должны доходить до горячих клавиш Salesforce
  ['keydown', 'keyup', 'keypress'].forEach((type) => bar.addEventListener(type, (event) => {
    if (event.target.matches && event.target.matches('.xt-ctl')) event.stopPropagation();
  }));

  const editing = () => {
    const a = document.activeElement;
    return !!a && bar.contains(a) && a.matches('select.xt-ctl');
  };

  // ---------------- Место в шапке ----------------
  function findTable() {
    return deepQueryAll('table').filter(isVisible)
      .find((table) => headerLabels(table).some((l) => /^Subject$/i.test(l.trim()))) || null;
  }

  function findHeader() {
    return deepQueryAll('.slds-page-header').filter(isVisible)
      .find((el) => COUNT_RE.test(deepText(el))) || null;
  }

  // Плашки расширения (наша и Queue summary) — не заголовок и не кнопки
  const inHeaderBar = (node) => {
    const el = node.nodeType === 1 ? node : node.parentElement;
    return !!(el && el.closest('[data-xt-header-bar]'));
  };

  // Как у Queue summary: всё левее середины шапки — заголовок списка, правее — кнопки и поиск
  function freeSpace(header) {
    const hr = header.getBoundingClientRect();
    const mid = hr.left + hr.width / 2;
    let left = hr.left;
    let right = hr.right;
    const take = (r) => {
      if (!r.width || !r.height) return;
      if (r.left < mid) left = Math.max(left, r.right);
      else right = Math.min(right, r.left);
    };
    const walker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim() || inHeaderBar(node)) continue;
      range.selectNodeContents(node);
      take(range.getBoundingClientRect());
    }
    header.querySelectorAll('button, input, svg, img, a, lightning-icon, lightning-button-icon').forEach((el) => {
      if (!inHeaderBar(el)) take(el.getBoundingClientRect());
    });
    return { left: left - hr.left + EDGE_GAP, right: right - hr.left - EDGE_GAP };
  }

  // По горизонтали — справа от Queue summary. По вертикали — по центру шапки, а если таблица выше шапки
  // (6–7 сотрудников) — от верха шапки вниз, поверх первых строк списка (▴ сворачивает до строки Team).
  function place(header) {
    if (getComputedStyle(header).position === 'static') header.style.position = 'relative';
    if (bar.parentElement !== header) header.appendChild(bar);
    const space = freeSpace(header);
    const summary = header.querySelector(`#${SUMMARY_BAR_ID}`);
    let left = space.left;
    if (summary && summary.style.display !== 'none' && summary.offsetWidth) {
      left = summary.offsetLeft + summary.offsetWidth + GAP;
    }
    const width = space.right - left;
    if (width < MIN_WIDTH) { bar.style.display = 'none'; return; }
    bar.style.display = 'block';
    bar.style.left = `${Math.round(left)}px`;
    bar.style.maxWidth = `${Math.round(width)}px`;
    const fits = bar.offsetHeight <= header.clientHeight - 8;
    bar.style.top = fits ? '50%' : '4px';
    bar.style.transform = fits ? 'translateY(-50%)' : 'none';
  }

  let lastHtml = '';
  function tick() {
    if (!running || document.hidden) return;
    if (!location.pathname.startsWith(LIST_PATH)) { bar.remove(); return; }
    const header = findTable() && findHeader();
    if (!header) { bar.remove(); return; }
    // Первый показ, плановое обновление; после ошибки (нет доступа, сессия) — повтор через минуту
    if (!loading && Date.now() - lastAttempt > (loadError ? ERROR_RETRY_MS : REFRESH_MS)) refresh();
    const html = render();
    if (html !== lastHtml && !editing()) { bar.innerHTML = html; lastHtml = html; }
    place(header);
  }

  // Догрузка ERP / истории идёт пачками: перерисовываем не чаще раза в 300 мс
  let tickTimer = null;
  function scheduleTick() {
    if (tickTimer) return;
    tickTimer = setTimeout(() => { tickTimer = null; tick(); }, 300);
  }

  // ---------------- Запуск ----------------
  let running = false;
  let timer = null;

  async function start() {
    if (running) return;
    running = true;
    await Promise.all([histCache.ready, partsCache.ready, sidebarCache.ready]);
    if (!running) return;
    tick();
    timer = setInterval(tick, SCAN_MS);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('resize', tick);
  }

  function stop() {
    if (!running) return;
    running = false;
    runId++;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', tick);
    window.removeEventListener('resize', tick);
    bar.remove();
    lastHtml = '';
    data = null;
    loading = false;
    loadError = '';
    lastAttempt = 0;
  }

  // Период и свёрнутость: сохранённые значения и выбор из других вкладок
  XT.options.watch(SCRIPT_ID, (o) => {
    const period = PERIODS.some(([v]) => v === o.period) ? o.period : 'day';
    const changed = period !== opts.period;
    opts = { ...o, period, collapsed: !!o.collapsed };
    if (running && changed && lastAttempt) refresh();
    else if (running) tick();
  });

  XT.settings.watch(SCRIPT_ID, (enabled) => (enabled ? start() : stop()));
})();
