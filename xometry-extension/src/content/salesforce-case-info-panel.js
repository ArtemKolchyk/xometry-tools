// Salesforce Case record: плашка с данными из ERP под шапкой кейса (Highlight).
// Заказчик, партнёр (и сколько jobs он выполнил), CM, internal notes джобы, staff notes заказа (свёрнуто).
// ▲! — совпадения со списками Partners / Customers (src/common/watchlist.js), как на карточках ERP sidebar.
// Данные: GraphQL PartnerJob (заметки, номер заказа, vendor) → GetOrderDetails (CM, заказчик, staff notes,
// имя партнёра) → статистика партнёра (кеш общий с ERP sidebar).
(function () {
  'use strict';

  const SCRIPT_ID = 'sf-case-info-panel';
  const CASE_PATH_RE = /^\/lightning\/r\/Case\/[^/]+\/view\/?$/;
  const PANEL_ID = 'xt-case-info-panel';
  const TICK_MS = 1200;
  const DATA_TTL_MS = 5 * 60 * 1000;        // заметки меняются: при возврате к кейсу через 5 мин перечитываем
  const ERROR_RETRY_MS = 60 * 1000;
  const PARTNER_TTL_MS = 12 * 60 * 60 * 1000;   // как в ERP sidebar
  const { parentAcrossShadow } = XT.dom;

  // Статистика партнёра: тот же кеш, что у ERP sidebar ({ time, completedJobs } по acceptedVendor)
  const partnerCache = XT.createCache(XT.registry.getScript('sf-erp-sidebar').partnerCachePrefix);

  const escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const formatDate = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  };

  // ---------------- Данные ----------------
  // jobId -> { time, loading, error, job, order, partner }
  const data = new Map();
  let watch = { partners: [], customers: [] };

  async function load(jobId, force = false) {
    const prev = data.get(jobId);
    if (prev && prev.loading) return;
    // После ошибки сами повторяем не чаще раза в минуту (кнопка ↻ — сразу)
    if (!force && prev && Date.now() - prev.time < (prev.error ? ERROR_RETRY_MS : DATA_TTL_MS)) return;

    const entry = { time: Date.now(), loading: true, error: null, job: null, order: null, partner: null };
    data.set(jobId, entry);
    render();
    try {
      const pj = (await XT.erp.graphql('PartnerJob', jobId)).partnerJob;
      if (!pj) throw new Error(`${jobId} not found in ERP`);
      const orderIds = [...new Set((pj.lineItems || []).map((li) => li.xometryOrderId).filter(Boolean))];
      entry.job = {
        notes: String(pj.internalNotes || '').trim(),
        vendor: pj.acceptedVendor || '',
        orderId: orderIds[0] || '',
      };
      loadPartnerStats(entry.job.vendor, force);
      render();

      if (entry.job.orderId) {
        // CM у всех заказов одной джобы один и тот же — берём первый заказ
        const o = (await XT.erp.graphql('GetOrderDetails', entry.job.orderId)).getOrder;
        if (o) {
          const jobs = (o.lineItems || []).flatMap((li) => (li.outsourcing && li.outsourcing.jobs) || []);
          const mine = jobs.find((j) => j.jobId === jobId) || {};
          const c = o.customer || {};
          entry.order = {
            cm: (o.orderAssignment && o.orderAssignment.caseManagerName) || '',
            company: c.companyName || '',
            contact: c.customerName || '',
            email: c.customerEmail || '',
            partnerName: mine.partnerName || '',
            partnerId: mine.partnerId || '',
            staffNotes: (o.orderNotes || []).map((n) => ({
              text: String(n.text || '').trim(),
              date: formatDate(n.createdAt),
              author: (n.staffUser && n.staffUser.name) || '',
            })).filter((n) => n.text),
          };
        }
      }
    } catch (err) {
      entry.error = err.message;
    } finally {
      entry.loading = false;
      entry.time = Date.now();
      render();
    }
  }

  const partnerState = new Map();   // vendor -> { loading } | { error }
  function loadPartnerStats(vendor, force) {
    if (!vendor || partnerState.has(vendor) && partnerState.get(vendor).loading) return;
    const cached = partnerCache.get(vendor);
    if (!force && cached && Date.now() - cached.time < PARTNER_TTL_MS) return;
    partnerState.set(vendor, { loading: true });
    XT.erp.getJson(XT.erp.vendorStatsUrl(vendor))
      .then((d) => { partnerCache.set(vendor, { time: Date.now(), completedJobs: d && d.total_completed_jobs }); partnerState.delete(vendor); })
      .catch((err) => partnerState.set(vendor, { error: err.message }))
      .finally(render);
  }

  function partnerJobsText(vendor) {
    if (!vendor) return '';
    const st = partnerState.get(vendor);
    const cached = partnerCache.get(vendor);
    if (cached && cached.completedJobs != null) return `${cached.completedJobs} jobs`;
    if (st && st.error) return '⚠ jobs';
    if (st && st.loading) return '… jobs';
    return '';
  }

  // ---------------- Разметка ----------------
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  Object.assign(panel.style, {
    boxSizing: 'border-box',
    position: 'relative',
    margin: '8px 0 0',
    // По ширине содержимого; длинные заметки не растягивают плашку шире 900 px
    width: 'fit-content',
    maxWidth: 'min(100%, 900px)',
    padding: '4px 10px',
    background: '#fff',
    border: '1px solid #dddbda',
    borderRadius: '6px',
    boxShadow: '0 2px 4px rgba(0,0,0,.08)',
    color: '#181818',
    font: '12px/1.4 "Salesforce Sans", Arial, sans-serif',
    textAlign: 'left',
    overflow: 'hidden',
  });

  let currentJobId = null;
  let notesOpen = false;
  let staffOpen = false;
  let lastHtml = '';

  const LABEL = 'color:#706e6b;flex:none;width:62px';
  const ROW = 'display:flex;gap:6px;align-items:baseline;min-width:0';
  const ELLIPSIS = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0';
  const MUTED = 'color:#706e6b';
  const LINK = 'color:#0176d3;text-decoration:none';

  const watchLine = (kind, e) => `${XT.watchlist.KINDS[kind].one}: ${e.text}${e.note ? ` — ${e.note}` : ''}`;
  function signs(kind, values) {
    const matches = XT.watchlist.match(watch[kind], values);
    if (!matches.length) return '';
    const title = matches.map((e) => watchLine(kind, e)).join('\n');
    return `<span style="display:inline-flex;flex:none;align-self:center" title="${escapeHtml(title)}">`
      + `${XT.watchlist.signSvg(XT.watchlist.colorValue(matches[0].color))}</span>`;
  }

  function html(jobId, e) {
    const loading = e && e.loading;
    const job = e && e.job;
    const order = e && e.order;
    const wait = `<span style="${MUTED}">${loading ? 'Loading…' : '—'}</span>`;

    // Staff notes заказа: строка под Notes, по клику — список
    const staffNotes = (order && order.staffNotes) || [];
    const staffToggle = staffNotes.length
      ? `<span data-act="staff" style="cursor:pointer;color:#0176d3;user-select:none;flex:none">${staffOpen ? '▾' : '▸'} Staff notes (${staffNotes.length})</span>`
      : `<span style="${MUTED};flex:none">${order ? 'No staff notes' : (loading ? 'Loading…' : '—')}</span>`;

    const head = `
      <div style="${ROW};margin-bottom:1px">
        <span style="${MUTED};${ELLIPSIS};flex:0 1 auto;margin-right:10px">ERP ·
          <a href="${escapeHtml(XT.erp.jobPageUrl(jobId))}" target="_blank" rel="noopener" style="${LINK}">${escapeHtml(jobId)}</a>
          ${job && job.orderId ? `· Order ${escapeHtml(job.orderId)}` : ''}
          ${order ? `· CM <b style="color:#181818">${escapeHtml(order.cm || '—')}</b>` : ''}</span>
        <button type="button" data-act="refresh" title="Reload from ERP"
          style="border:0;background:none;padding:0 2px;cursor:pointer;color:#0176d3;font-size:14px;line-height:1;flex:none">${loading ? '…' : '↻'}</button>
      </div>`;

    if (e && e.error && !job) {
      return `${head}<div style="color:#8e030f;white-space:normal">⚠ ${escapeHtml(e.error)}</div>`;
    }

    // Заказчик: компания (контакт и email — в подсказке), без компании — контакт
    let customer = wait;
    let customerSign = '';
    if (order) {
      const main = order.company || order.contact || '—';
      const extra = order.company && order.contact ? ` · ${order.contact}` : '';
      const tip = [order.company, order.contact, order.email].filter(Boolean).join('\n');
      customer = `<span style="${ELLIPSIS}" title="${escapeHtml(tip)}"><b>${escapeHtml(main)}</b>`
        + `<span style="${MUTED}">${escapeHtml(extra)}</span></span>`;
      customerSign = signs('customers', [order.company, order.contact, order.email]);
    }

    let partner = wait;
    let partnerSign = '';
    if (order && order.partnerName) {
      const jobs = partnerJobsText(job && job.vendor);
      const name = order.partnerId
        ? `<a href="${escapeHtml(XT.erp.partnerPageUrl(order.partnerId))}" target="_blank" rel="noopener" style="${LINK};font-weight:700">${escapeHtml(order.partnerName)}</a>`
        : `<b>${escapeHtml(order.partnerName)}</b>`;
      partner = `<span style="${ELLIPSIS}" title="${escapeHtml(order.partnerName)}">${name}`
        + `${jobs ? `<span style="${MUTED}"> · ${escapeHtml(jobs)}</span>` : ''}</span>`;
      partnerSign = signs('partners', [order.partnerName]);
    } else if (order) {
      partner = `<span style="${MUTED}">No partner</span>`;
    }

    // Internal notes: одна строка, по клику — целиком
    let notes = wait;
    if (job) {
      notes = job.notes
        ? `<div data-act="notes" title="${notesOpen ? 'Click to collapse' : 'Click to expand'}" style="cursor:pointer;white-space:pre-wrap;word-break:break-word;min-width:0;${
          notesOpen ? 'max-height:260px;overflow:auto' : 'display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;overflow:hidden'
        }">${escapeHtml(job.notes)}</div>`
        : `<span style="${MUTED}">No internal notes</span>`;
    }

    const staffList = staffOpen && staffNotes.length ? `
      <div style="margin-top:4px;max-height:260px;overflow:auto;border-top:1px solid #e5e5e5">
        ${staffNotes.map((n) => `
          <div style="padding:4px 0;border-bottom:1px solid #f3f3f3">
            <div style="${MUTED};font-size:11px">${escapeHtml([n.author, n.date].filter(Boolean).join(' · '))}</div>
            <div style="white-space:pre-wrap;word-break:break-word">${escapeHtml(n.text)}</div>
          </div>`).join('')}
      </div>` : '';

    const warn = e && e.error ? `<div style="color:#8e030f">⚠ ${escapeHtml(e.error)}</div>` : '';

    // Partner Shipping Block — пока заглушка: состояние из ERP не читаем и не меняем.
    // Серый, без «On/Off», чтобы не выдавать себя за настоящее состояние джобы.
    const shippingBlock = `
      <div title="Coming soon: block / unblock partner shipping right from Salesforce"
        style="flex:none;display:flex;flex-direction:column;justify-content:center;gap:4px;padding-left:12px;border-left:1px solid #e5e5e5;cursor:not-allowed;user-select:none">
        <span style="${MUTED};font-size:11px">Partner Shipping Block</span>
        <span style="display:inline-flex;align-items:center;gap:6px;opacity:.6">
          <span style="position:relative;display:inline-block;width:30px;height:16px;border-radius:8px;background:#c9c9c9">
            <span style="position:absolute;top:2px;right:2px;width:12px;height:12px;border-radius:50%;background:#fff"></span>
          </span>
          <span style="${MUTED}">Soon</span>
        </span>
      </div>`;

    // CM — в верхней строке, после номера заказа; справа — Partner Shipping Block
    return `<div style="display:flex;gap:12px;align-items:stretch">
      <div style="min-width:0;flex:1 1 auto">${head}
      <div style="${ROW}"><span style="${LABEL}">Customer</span>${customerSign}${customer}</div>
      <div style="${ROW}"><span style="${LABEL}">Partner</span>${partnerSign}${partner}</div>
      <div style="${ROW};align-items:flex-start"><span style="${LABEL}">Notes</span>${notes}</div>
      <div style="${ROW}"><span style="${LABEL}"></span>${staffToggle}</div>
      ${staffList}${warn}</div>
      ${shippingBlock}
    </div>`;
  }

  function render() {
    if (!currentJobId) return;
    const next = html(currentJobId, data.get(currentJobId));
    if (next === lastHtml) return;   // не перерисовываем зря: иначе сбрасывается прокрутка и подсказки
    lastHtml = next;
    panel.innerHTML = next;
  }

  panel.addEventListener('click', (event) => {
    const target = event.target.closest('[data-act]');
    if (!target) return;
    event.stopPropagation();
    const act = target.dataset.act;
    if (act === 'refresh' && currentJobId) load(currentJobId, true);
    if (act === 'notes') notesOpen = !notesOpen;
    if (act === 'staff') staffOpen = !staffOpen;
    render();
  });

  // ---------------- Место на странице ----------------
  // Шапка кейса (Highlight) — ближайший к кнопкам предок с классом slds-page-header
  function findHeader(from) {
    let cur = from;
    for (let depth = 0; cur && depth < 25; depth++, cur = parentAcrossShadow(cur)) {
      if (cur.classList && cur.classList.contains('slds-page-header')) return cur;
    }
    return null;
  }

  // Под шапкой, в общем потоке: в самой шапке между полями и кнопками плашка не помещается
  function place() {
    const cell = XT.dom.launchVqcCell();
    const header = cell && findHeader(cell);
    if (!header || !header.parentElement) { panel.remove(); return false; }
    if (panel.previousSibling !== header || panel.parentElement !== header.parentElement) {
      header.parentElement.insertBefore(panel, header.nextSibling);
    }
    return true;
  }

  // ---------------- Цикл ----------------
  let running = false;
  let timer = null;

  function sync() {
    if (!CASE_PATH_RE.test(location.pathname)) { panel.remove(); currentJobId = null; return; }
    const jobId = XT.dom.caseJobId();
    if (!jobId) { panel.remove(); currentJobId = null; return; }
    if (jobId !== currentJobId) {
      currentJobId = jobId;
      notesOpen = false;
      staffOpen = false;
      lastHtml = '';
    }
    if (!place()) return;
    load(jobId);
    render();
  }

  function start() {
    if (running) return;
    running = true;
    partnerCache.ready.then(sync);
    timer = setInterval(sync, TICK_MS);
  }

  function stop() {
    if (!running) return;
    running = false;
    clearInterval(timer);
    panel.remove();
    currentJobId = null;
    lastHtml = '';
  }

  XT.watchlist.watch((lists) => { watch = lists; lastHtml = ''; render(); });
  XT.settings.watch(SCRIPT_ID, (enabled) => (enabled ? start() : stop()));
})();
