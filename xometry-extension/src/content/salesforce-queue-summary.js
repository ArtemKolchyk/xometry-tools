// Salesforce Case queue: summary bar in the list header (between the list title and the New / Change buttons).
// Counts come from the table on the page, no ERP requests:
//   Cases  — total, ITAR (Primary ITAR Field checked), non-ITAR;
//   Status — New, Pending, Response Received, Inspection In Progress, Management Review (+ Other, if any);
//   Overdue — more than N hours (set on the bar) since Date/Time Opened or since the last Pending (case history
//             via Salesforce API), oldest case; checkbox colors those rows.
(function () {
  'use strict';

  const SCRIPT_ID = 'sf-queue-summary';
  const LIST_PATH = '/lightning/o/Case/list';
  const BAR_ID = 'xt-queue-summary';
  const SCAN_MS = 1500;
  const MIN_WIDTH = 220;   // уже — не помещается: прячем, а не налезаем на заголовок и кнопки
  const GAP = 24;          // отступ от заголовка списка и от кнопок
  const { deepQueryAll, deepText, isVisible, escapeHtml, headerLabels, isCheckedCell, rowCells } = XT.dom;

  const SUBJECT_HEADER_RE = /^Subject$/i;
  const STATUS_HEADER_RE = /^Status$/i;
  const ITAR_HEADER_RE = /ITAR/i;
  const OPENED_HEADER_RE = /^Date\/Time Opened$/i;
  // Просрочен: прошло больше opts.overdueHours календарных часов. Отсчёт (opts.overdueFrom):
  //   'opened'  — от Date/Time Opened (колонка таблицы);
  //   'pending' — от последнего перехода в Pending (история кейса из Salesforce API, нужен доступ — см. registry).
  const MAX_HOURS = 720;
  const FROM_CHOICES = [['opened', 'total in queue'], ['pending', 'from last Pending']];
  const HIST_TTL_MS = 5 * 60000;   // историю кейсов перечитываем раз в 5 мин (и сразу, если сменился статус)
  const HIGHLIGHT_BG = '#ff9e9e';   // фон строк просроченных кейсов при включённой галочке
  const COUNT_RE = /(\d[\d,.\s]*)(\+)?\s*items?\b/i;   // «34 items • Sorted by…», «50+ items»

  // В ячейке, кроме статуса, бывает скрытый текст Salesforce (кнопка «Edit Status» и т.п.),
  // поэтому ищем название статуса внутри текста, а не сравниваем целиком.
  // label — подпись на плашке: «Res. Received», а не «Response Received», чтобы её не красил Text highlighter.
  const STATUSES = [
    { key: 'new', label: 'New', re: /\bnew\b/i },
    { key: 'pending', label: 'Pending', re: /\bpending\b/i },
    { key: 'response', label: 'Res. Received', title: 'Response Received', re: /\bresponse\s+rec(ei|ie)ved\b/i },
    { key: 'inspection', label: 'Inspection In Progress', re: /\binspection\s+in\s+progress\b/i },
    { key: 'management', label: 'Management Review', re: /\bmanagement\s+review\b/i },
  ];

  // Порядок проверки: самые длинные названия первыми, «New» — последним (короткое слово)
  const MATCH_ORDER = ['inspection', 'management', 'response', 'pending', 'new'].map((k) => STATUSES.find((s) => s.key === k));

  // Видимый текст ячейки: без скрытых подписей для экранных дикторов и без кнопок
  const HIDDEN_SEL = '.slds-assistive-text, .assistiveText, button, [role="button"]';
  function cellText(cell) {
    const copy = cell.cloneNode(true);
    copy.querySelectorAll(HIDDEN_SEL).forEach((el) => el.remove());
    const text = copy.textContent.replace(/\s+/g, ' ').trim();
    return text || deepText(cell).replace(/\s+/g, ' ').trim();
  }

  // ---------------- Поиск на странице ----------------
  // Таблица кейсов видимого списка (в консоли SF соседние вкладки остаются в DOM скрытыми)
  function findTable() {
    return deepQueryAll('table').filter(isVisible)
      .find((table) => headerLabels(table).some((l) => SUBJECT_HEADER_RE.test(l.trim()))) || null;
  }

  // Шапка списка над таблицей: видимый .slds-page-header с текстом «N items»
  function findHeader() {
    return deepQueryAll('.slds-page-header').filter(isVisible)
      .find((el) => COUNT_RE.test(deepText(el))) || null;
  }

  function readTotal(header) {
    const m = deepText(header).match(COUNT_RE);
    if (!m) return null;
    return { value: parseInt(m[1].replace(/[^\d]/g, ''), 10), more: !!m[2] };
  }

  // ---------------- Дата открытия кейса ----------------
  // Формат зависит от языка Salesforce у пользователя: «28.10.2026, 06:07», «10/28/2026, 6:07 AM»,
  // «28/10/2026 06:07», «2026-10-28 06:07». Через «/» — месяц первым (US), если первое число не больше 12.
  const DATE_RE = /(\d{1,4})([./-])(\d{1,2})\2(\d{1,4})[,\s]+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP]\.?\s?M\.?)?/i;
  function parseDate(text) {
    const m = text.match(DATE_RE);
    if (!m) return null;
    const [, a, sep, b, c, hh, mm, ampm] = m;
    let year; let month; let day;
    if (a.length === 4) { year = +a; month = +b; day = +c; } else {
      year = c.length === 2 ? 2000 + +c : +c;
      if (sep === '/' && +a <= 12) { month = +a; day = +b; } else { day = +a; month = +b; }
    }
    let hour = +hh;
    if (ampm) {
      const pm = /p/i.test(ampm);
      if (hour === 12) hour = pm ? 12 : 0; else if (pm) hour += 12;
    }
    const time = new Date(year, month - 1, day, hour, +mm).getTime();
    return Number.isNaN(time) ? null : time;
  }

  const formatAge = (ms) => {
    const hours = Math.floor(ms / 3600000);
    return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h`;
  };

  // ---------------- Настройки (на плашке, в заголовке столбца Overdue) ----------------
  let opts = { ...XT.registry.getScript(SCRIPT_ID).options };
  const overdueMs = () => opts.overdueHours * 3600000;
  const fromPending = () => opts.overdueFrom === 'pending';

  // ---------------- Последний Pending: история кейсов ----------------
  // caseId -> { time, status, lastPending }. status — статус в таблице на момент запроса: сменился
  // (например, кейс снова ушёл в Pending) — историю перечитываем сразу, иначе раз в HIST_TTL_MS.
  const history = new Map();
  const histState = new Map();   // caseId -> { status: 'loading' | 'error', message, time }

  const histFresh = (h, status) => h && h.status === status && Date.now() - h.time < HIST_TTL_MS;
  // Ошибка (нет доступа, сессия истекла) — повтор через минуту: доступ могли выдать в popup
  const ERROR_RETRY_MS = 60000;
  const busy = (st) => st && (st.status === 'loading' || Date.now() - st.time < ERROR_RETRY_MS);

  // wanted: Map caseId -> текущий статус в таблице
  function loadHistory(wanted) {
    const ids = [...wanted.keys()]
      .filter((id) => !busy(histState.get(id)) && !histFresh(history.get(id), wanted.get(id)));
    for (let i = 0; i < ids.length; i += XT.caseHistory.BATCH) {
      const batch = ids.slice(i, i + XT.caseHistory.BATCH);
      batch.forEach((id) => histState.set(id, { status: 'loading' }));
      XT.caseHistory.fetch(batch)
        .then((byCase) => batch.forEach((id) => {
          history.set(id, { time: Date.now(), status: wanted.get(id), lastPending: byCase[id].lastPending });
          histState.delete(id);
        }))
        .catch((err) => batch.forEach((id) =>
          histState.set(id, { status: 'error', message: err.message, time: Date.now() })))
        .finally(() => { if (running) tick(); });
    }
  }

  // ---------------- Подсчёт ----------------
  function count(table) {
    const labels = headerLabels(table);
    const statusIdx = labels.findIndex((l) => STATUS_HEADER_RE.test(l.trim()));
    const itarIdx = labels.findIndex((l) => ITAR_HEADER_RE.test(l));
    const openedIdx = labels.findIndex((l) => OPENED_HEADER_RE.test(l.trim()));
    const now = Date.now();
    const pendingMode = fromPending();

    const result = {
      rows: 0, itar: 0, hasItar: itarIdx >= 0, hasStatus: statusIdx >= 0, status: {}, other: {},
      // Overdue: undated — нет даты; notStarted — ещё не было Pending; loading / error — история не готова
      canCount: pendingMode || openedIdx >= 0, overdue: [], oldest: 0,
      undated: 0, notStarted: 0, loading: 0, error: '',
    };
    STATUSES.forEach((s) => { result.status[s.key] = 0; });
    const wanted = new Map();   // caseId -> статус в таблице (для режима Pending)

    table.querySelectorAll('tbody tr').forEach((tr) => {
      const cells = rowCells(tr);
      if (!cells.length) return;
      result.rows++;
      if (itarIdx >= 0 && isCheckedCell(cells[itarIdx])) result.itar++;

      let statusKey = null;
      const statusText = statusIdx >= 0 && cells[statusIdx] ? cellText(cells[statusIdx]) : '';
      if (statusText) {
        const known = MATCH_ORDER.find((s) => s.re.test(statusText));
        if (known) { statusKey = known.key; result.status[known.key]++; }
        else result.other[statusText] = (result.other[statusText] || 0) + 1;
      }

      const opened = openedIdx >= 0 && cells[openedIdx] ? parseDate(cellText(cells[openedIdx])) : null;
      let start = null;
      if (!pendingMode) {
        if (openedIdx < 0) return;
        if (opened === null) { result.undated++; return; }
        start = opened;
      } else {
        const caseId = XT.caseHistory.rowCaseId(tr, tr.getAttribute('data-row-key-value'));
        if (!caseId) { result.undated++; return; }
        wanted.set(caseId, statusText);
        const h = history.get(caseId);
        const st = histState.get(caseId);
        if (h && h.lastPending) start = h.lastPending;
        else if (h && statusKey === 'pending') {
          // Кейс создан сразу в Pending: перехода в истории нет — считаем от открытия
          if (opened === null) { result.undated++; return; }
          start = opened;
        } else if (h) { result.notStarted++; return; }
        else if (st && st.status === 'error') { result.error = st.message; return; }
        else { result.loading++; return; }
      }
      const age = now - start;
      if (age > overdueMs()) result.overdue.push(tr);
      result.oldest = Math.max(result.oldest, age);
    });

    if (pendingMode && wanted.size) loadHistory(wanted);
    return result;
  }

  // ---------------- Плашка ----------------
  const bar = document.createElement('div');
  bar.id = BAR_ID;
  Object.assign(bar.style, {
    position: 'absolute', top: '50%', transform: 'translateY(-50%)', zIndex: '5',
  });

  // Столбцы, в каждом строки «название — число» друг под другом. Числа одним цветом, нули — бледнее.
  // У столбца свой акцент: точка и цвет заголовка (Overdue краснеет, только когда есть просроченные).
  // Шапка списка невысокая (~5 строк), поэтому Other (если есть) — в строке заголовка столбца Status.
  const S = `#${BAR_ID}`;
  const STYLE = `<style>
    ${S}{box-sizing:border-box;display:flex;align-items:stretch;overflow:hidden;white-space:nowrap;
      background:#fff;border:1px solid #d8dde6;border-radius:8px;
      box-shadow:0 1px 2px rgba(24,24,24,.06),0 3px 8px rgba(24,24,24,.06);
      font:12px/15px "Salesforce Sans",-apple-system,"Segoe UI",Arial,sans-serif;color:#181818}
    ${S} .xt-col{--accent:#706e6b;padding:5px 16px 6px;display:grid;grid-template-columns:auto auto;
      column-gap:20px;align-content:start}
    ${S} .xt-col+.xt-col{border-left:1px solid #e5e8ee}
    ${S} .xt-cases{--accent:#0b5cab;background:#f6f9fd}
    ${S} .xt-status{--accent:#5a1ba9}
    ${S} .xt-overdue.xt-alert{--accent:#ba0517;background:#fff5f5}
    ${S} .xt-cap{grid-column:1/-1;display:flex;justify-content:space-between;align-items:center;gap:12px;
      font-size:10.5px;line-height:13px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;
      color:var(--accent);margin-bottom:1px}
    ${S} .xt-cap>span:first-child::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;
      background:var(--accent);margin:0 6px 1px 0;vertical-align:middle}
    ${S} .xt-l{color:#514f4d}
    ${S} .xt-v{font-weight:700;text-align:right;font-variant-numeric:tabular-nums}
    ${S} .xt-v.xt-zero{color:#b0adab;font-weight:600}
    ${S} .xt-total{font-size:13px}
    ${S} .xt-other{cursor:help;text-transform:none;letter-spacing:0;font-weight:600;color:#706e6b}
    ${S} .xt-note{grid-column:1/-1;color:#706e6b}
    ${S} .xt-check{grid-column:1/-1;display:flex;align-items:center;gap:6px;margin-top:2px;cursor:pointer;color:#514f4d}
    ${S} .xt-check input{margin:0;cursor:pointer;accent-color:#ba0517}
    ${S} .xt-ctl{box-sizing:border-box;height:21px;margin:0;padding:0 4px;border:1px solid #c9c9c9;border-radius:4px;
      background:#fff;color:#181818;font-family:inherit;font-size:12px;font-weight:600;line-height:normal;
      text-transform:none;letter-spacing:0;vertical-align:middle;cursor:pointer}
    ${S} select.xt-ctl{padding:0 2px 0 5px}
    ${S} .xt-ctl:focus{outline:none;border-color:#0176d3;box-shadow:0 0 0 1px #0176d3}
    ${S} .xt-hours{width:50px;margin:0 3px;cursor:text;text-align:right}
    ${S} .xt-overdue .xt-cap{margin-bottom:3px}
  </style>`;
  const line = (label, value, { title, zero, cls = '' } = {}) =>
    `<span class="xt-l"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}</span>`
    + `<span class="xt-v${zero ? ' xt-zero' : ''}${cls ? ` ${cls}` : ''}">${escapeHtml(value)}</span>`;
  const caption = (text, right = '', title = '') =>
    `<div class="xt-cap"${title ? ` title="${escapeHtml(title)}"` : ''}><span>${text}</span>${right}</div>`;

  function render(c, total) {
    const partial = total && (total.more || total.value > c.rows);
    const totalValue = partial ? `${c.rows} of ${total.value}${total.more ? '+' : ''}` : String(c.rows);
    const totalTitle = partial
      ? `Counted ${c.rows} loaded rows of ${total.value}${total.more ? '+' : ''}: scroll the list to load the rest`
      : `${c.rows} cases in this list`;

    const nz = (n, opts = {}) => ({ ...opts, zero: !n });   // нули — бледнее
    let cases = caption('Cases') + line('Total', totalValue, { title: totalTitle, cls: 'xt-total' });
    cases += c.hasItar
      ? line('ITAR', String(c.itar), nz(c.itar)) + line('non-ITAR', String(c.rows - c.itar), nz(c.rows - c.itar))
      : '<span class="xt-note" title="Add the Primary ITAR Field column to the list view">ITAR column not in view</span>';

    let statuses;
    if (!c.hasStatus) {
      statuses = caption('Status') + '<span class="xt-note">Status column not in view</span>';
    } else {
      const other = Object.entries(c.other);
      let otherHtml = '';
      if (other.length) {
        const sum = other.reduce((a, [, n]) => a + n, 0);
        const title = other.map(([name, n]) => `${name}: ${n}`).join('\n');
        otherHtml = `<span class="xt-other" title="${escapeHtml(title)}">Other ${sum}</span>`;
      }
      statuses = caption('Status', otherHtml)
        + STATUSES.map((s) => line(s.label, String(c.status[s.key]), nz(c.status[s.key], { title: s.title }))).join('');
    }

    // Настройки прямо в заголовке столбца: часы и от чего считать
    const hours = opts.overdueHours;
    const pendingMode = fromPending();
    const fromSelect = '<select data-xt="from" class="xt-ctl" title="Total in queue: since the case appeared in the '
      + 'VQC queue (Date/Time Opened). From last Pending: since its last Pending status (case history, needs '
      + 'Salesforce API access)">'
      + FROM_CHOICES.map(([v, label]) => `<option value="${v}"${opts.overdueFrom === v ? ' selected' : ''}>${label}</option>`).join('')
      + '</select>';
    let overdue = caption(
      `Overdue &gt; <input data-xt="hours" class="xt-ctl xt-hours" type="number" min="1" max="${MAX_HOURS}" step="1" `
        + `value="${hours}" title="Overdue after this many hours (1–${MAX_HOURS}); Enter to apply">hours`,
      fromSelect,
      pendingMode
        ? `More than ${hours} hours since the case last went to Pending (case history)`
        : `More than ${hours} hours since Date/Time Opened`);
    const counted = c.overdue.length || c.oldest;
    if (!c.canCount) {
      overdue += '<span class="xt-note" title="Add the Date/Time Opened column to the list view">'
        + 'Date/Time Opened column not in view</span>';
    } else if (c.error && !counted) {
      overdue += `<span class="xt-note" title="${escapeHtml(c.error)}">No Salesforce API access:<br>`
        + 'grant it in the popup</span>';
    } else {
      // Что не попало в подсчёт — в подсказке, чтобы плашка не стала выше шапки
      const skipped = [
        c.notStarted && `${c.notStarted} not in Pending yet`,
        c.undated && `${c.undated} without a date`,
        c.loading && `${c.loading} loading case history…`,
        c.error && `history error: ${c.error}`,
      ].filter(Boolean);
      const value = c.loading && !counted ? '…' : String(c.overdue.length);
      overdue += line('Overdue', value + (skipped.length ? '*' : ''),
        nz(c.overdue.length, { title: skipped.length ? `Not counted: ${skipped.join(', ')}` : '' }))
        + line('Oldest', c.oldest ? formatAge(c.oldest) : '—', { zero: !c.oldest });
      overdue += '<label class="xt-check" title="Color the rows of overdue cases in the list">'
        + `<input type="checkbox" data-xt="highlight"${highlightOn ? ' checked' : ''}>Highlight rows</label>`;
    }

    return STYLE
      + `<div class="xt-col xt-cases">${cases}</div>`
      + `<div class="xt-col xt-status">${statuses}</div>`
      + `<div class="xt-col xt-overdue${c.overdue.length ? ' xt-alert' : ''}">${overdue}</div>`;
  }

  // ---------------- Выделение просроченных строк ----------------
  // Красим ячейки, а не tr: у ячеек Salesforce свой фон, он перекрыл бы фон строки
  let highlightOn = false;
  let painted = new Set();   // ячейки, которые сейчас покрашены
  function paint(rows) {
    const want = new Set();
    if (highlightOn) rows.forEach((tr) => rowCells(tr).forEach((cell) => want.add(cell)));
    painted.forEach((cell) => { if (!want.has(cell)) cell.style.removeProperty('background-color'); });
    want.forEach((cell) => { if (!painted.has(cell)) cell.style.setProperty('background-color', HIGHLIGHT_BG, 'important'); });
    painted = want;
  }

  // Галочка, часы и «от чего считать» запоминаются (xt:options:sf-queue-summary) и действуют во всех вкладках
  function saveOption(patch) {
    opts = { ...opts, ...patch };
    XT.options.get(SCRIPT_ID).then((o) => XT.options.set(SCRIPT_ID, { ...o, ...patch }));
    tick();
  }

  bar.addEventListener('change', (event) => {
    const t = event.target;
    if (t.dataset.xt === 'highlight') {
      highlightOn = t.checked;
      saveOption({ highlightOverdue: highlightOn });
    } else if (t.dataset.xt === 'from') {
      saveOption({ overdueFrom: t.value });
      t.blur();
    } else if (t.dataset.xt === 'hours') {
      const n = Math.round(Number(t.value));
      if (n >= 1 && n <= MAX_HOURS) saveOption({ overdueHours: n });
      else t.value = opts.overdueHours;   // пустое или вне диапазона — возвращаем прежнее
    }
  });

  // Клавиши в полях плашки не должны доходить до горячих клавиш Salesforce
  ['keydown', 'keyup', 'keypress'].forEach((type) => bar.addEventListener(type, (event) => {
    if (!event.target.matches || !event.target.matches('.xt-ctl')) return;
    event.stopPropagation();
    if (type === 'keydown' && event.key === 'Enter') event.target.blur();   // blur → change → сохранить
    if (type === 'keydown' && event.key === 'Escape' && event.target.dataset.xt === 'hours') {
      event.target.value = opts.overdueHours;   // отмена ввода
      event.target.blur();
    }
  }));

  // Пока пользователь в поле часов или в списке — не перерисовываем плашку (иначе пропадёт фокус и ввод)
  const editing = () => {
    const a = document.activeElement;
    return !!a && bar.contains(a) && a.matches('.xt-ctl');
  };

  // ---------------- Место в шапке ----------------
  // Шапка списка — сетка на всю ширину, поэтому меряем не блоки, а их содержимое: текст (через Range)
  // и кнопки/иконки. Всё, что левее середины шапки, — заголовок списка, правее — кнопки и поиск.
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
      if (!node.textContent.trim() || bar.contains(node)) continue;
      range.selectNodeContents(node);
      take(range.getBoundingClientRect());
    }
    header.querySelectorAll('button, input, svg, img, a, lightning-icon, lightning-button-icon').forEach((el) => {
      if (!bar.contains(el)) take(el.getBoundingClientRect());
    });
    return { offset: left - hr.left + GAP, width: right - left - 2 * GAP };
  }

  let lastHtml = '';
  function place(header) {
    if (getComputedStyle(header).position === 'static') header.style.position = 'relative';
    if (bar.parentElement !== header) header.appendChild(bar);
    const space = freeSpace(header);
    if (space.width < MIN_WIDTH) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    bar.style.left = `${Math.round(space.offset)}px`;
    bar.style.maxWidth = `${Math.round(space.width)}px`;
  }

  function tick() {
    if (document.hidden) return;   // фоновая вкладка; при возврате — visibilitychange
    if (!location.pathname.startsWith(LIST_PATH)) { bar.remove(); paint([]); return; }
    const table = findTable();
    const header = table && findHeader();
    if (!header) { bar.remove(); paint([]); return; }

    const counts = count(table);
    paint(counts.overdue);
    const html = render(counts, readTotal(header));
    if (html !== lastHtml && !editing()) { bar.innerHTML = html; lastHtml = html; }
    place(header);
  }

  // ---------------- Запуск ----------------
  let running = false;
  let timer = null;

  function start() {
    if (running) return;
    running = true;
    tick();
    timer = setInterval(tick, SCAN_MS);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('resize', tick);
  }

  function stop() {
    if (!running) return;
    running = false;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', tick);
    window.removeEventListener('resize', tick);
    bar.remove();
    paint([]);
    lastHtml = '';
  }

  // Настройки из popup и галочка Highlight rows: сохранённые значения и изменения из других вкладок
  XT.options.watch(SCRIPT_ID, (o) => {
    const hours = Math.round(Number(o.overdueHours));
    opts = { ...o, overdueHours: hours >= 1 ? hours : 48, overdueFrom: o.overdueFrom === 'pending' ? 'pending' : 'opened' };
    highlightOn = !!o.highlightOverdue;
    if (running) tick();
  });

  XT.settings.watch(SCRIPT_ID, (enabled) => (enabled ? start() : stop()));
})();
