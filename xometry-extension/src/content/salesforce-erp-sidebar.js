// Salesforce Case Queue: ERP sidebar
// Перенос userscripts/salesforce-erp-sidebar.user.js (v0.4). DOM-логика и summarize не менялись;
// GM_* заменены на XT.* из src/common, запуск обёрнут в start()/stop() для переключателя в popup.

(function () {
  'use strict';

  const SCRIPT_ID = 'sf-erp-sidebar';

  // ======================= НАСТРОЙКИ =======================
  const CACHE_TTL_MIN = 30;      // через сколько минут данные считаются устаревшими
  const MAX_CONCURRENT = 2;      // сколько запросов в ERP одновременно
  const RETRY_DELAYS_MS = [3000, 10000];   // повторы при временных сбоях (таймаут, сеть, 5xx, 429)
  const CARD_WIDTH = 260;        // ширина карточки, px
  const DETAILS_WIDTH = 480;     // ширина панели More; выступает влево от карточки поверх таблицы
  // Регистр в теме кейса бывает любой (J03b164A); цифра обязательна, чтобы не ловить слова вроде "January"
  const JOB_ID_RE = /\bJ(?=[0-9A-Z]*\d)[0-9A-Z]{6,10}\b/i;
  const LIST_PATH = '/lightning/o/Case/list';
  const ITAR_HEADER_RE = /ITAR/i;   // колонка с галочкой (Primary ITAR Field)
  const SUBJECT_HEADER_RE = /^Subject$/i;
  // ==========================================================

  const CACHE_PREFIX = XT.registry.getScript(SCRIPT_ID).cachePrefix; // 'erpjob6:'
  const PARTNER_CACHE_PREFIX = XT.registry.getScript(SCRIPT_ID).partnerCachePrefix;
  const CUSTOMER_CACHE_PREFIX = XT.registry.getScript(SCRIPT_ID).customerCachePrefix;
  const EXTRA_TTL_MIN = 12 * 60;   // партнёр и клиент меняются медленно
  const COLORS = {
    std: { bg: '#e3f5e8', border: '#2e844a', text: '#194e31' },
    nonstd: { bg: '#fff6d6', border: '#dd9e00', text: '#5c4300' },
    neutral: { bg: '#f3f3f3', border: '#c9c9c9', text: '#444' },
    error: { bg: '#fdeceb', border: '#ba0517', text: '#8e030f' },
  };

  // ---------------- Утилиты DOM (с учётом shadow DOM) ----------------
  function deepQueryAll(selector, root = document) {
    const found = [];
    const walk = (node) => {
      node.querySelectorAll(selector).forEach((el) => found.push(el));
      node.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) walk(el.shadowRoot); });
    };
    walk(root);
    return found;
  }

  function deepText(node) {
    const parts = [];
    const walk = (n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        const t = n.textContent.trim();
        if (t) parts.push(t);
        return;
      }
      if (n.shadowRoot) n.shadowRoot.childNodes.forEach(walk);
      n.childNodes.forEach(walk);
    };
    walk(node);
    return parts.join(' ');
  }

  function parentAcrossShadow(el) {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode();
    return root && root.host ? root.host : null;
  }

  function isVisible(el) {
    return el && el.isConnected && el.getClientRects().length > 0;
  }

  function findScroller(el) {
    let cur = parentAcrossShadow(el);
    while (cur && cur !== document.body) {
      const oy = getComputedStyle(cur).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && cur.scrollHeight > cur.clientHeight) return cur;
      cur = parentAcrossShadow(cur);
    }
    return null;
  }

  // ---------------- Кеш ----------------
  // chrome.storage.local + копия в памяти: cacheGet остаётся синхронным
  const cache = XT.createCache(CACHE_PREFIX);

  function cacheGet(jobId) {
    return cache.get(jobId);
  }
  function cacheSet(jobId, summary) {
    cache.set(jobId, { time: Date.now(), summary });
  }
  function isFresh(entry) {
    return entry && Date.now() - entry.time < CACHE_TTL_MIN * 60 * 1000;
  }
  function clearCache() {
    return Promise.all([cache.clear(), partnerInfo.clear(), customerInfo.clear()]);
  }

  // ---------------- Доп. данные для панели More (партнёр, клиент) ----------------
  // Запрашиваются только при открытии панели, отдельно от очереди джобов.
  // fetcher(key) резолвится объектом с данными; он кладётся в кеш вместе с time.
  function lazyInfo(prefix, fetcher) {
    const store = XT.createCache(prefix);
    const state = new Map();   // key -> { status:'loading'|'error', message }
    return {
      ready: store.ready,
      load(key, force = false) {
        if (!key) return;
        const entry = store.get(key);
        if (!force && (state.has(key) || (entry && Date.now() - entry.time < EXTRA_TTL_MIN * 60 * 1000))) return;
        state.set(key, { status: 'loading' });
        fetcher(key)
          .then((data) => { store.set(key, { time: Date.now(), ...data }); state.delete(key); })
          .catch((err) => state.set(key, { status: 'error', message: err.message }))
          .finally(renderAll);
      },
      // Данные из кеша, либо { error } / { loading: true }
      get(key) {
        const entry = store.get(key);
        if (entry) return entry;
        const st = state.get(key);
        return st && st.status === 'error' ? { error: st.message } : { loading: true };
      },
      forget(key) { state.delete(key); },
      clear() { state.clear(); return store.clear(); },
    };
  }

  // vendor (acceptedVendor) -> { completedJobs }
  const partnerInfo = lazyInfo(PARTNER_CACHE_PREFIX, (vendor) =>
    XT.erp.getJson(XT.erp.vendorStatsUrl(vendor))
      .then((d) => ({ completedJobs: d && d.total_completed_jobs })));

  // jobId -> { company, contact, email }. ID клиента — начало orderId (E0954-15001 -> E0954).
  // orderId берём из ответа по джобе, а если там нет — из job-plan.
  const customerInfo = lazyInfo(CUSTOMER_CACHE_PREFIX, async (jobId) => {
    const entry = cacheGet(jobId);
    let orderId = entry && entry.summary.orderId;
    if (!orderId) {
      const plan = await XT.erp.getJson(XT.erp.jobPlanUrl(jobId));
      orderId = plan && plan.data && plan.data.orderId;
    }
    const userId = orderId && String(orderId).split('-')[0];
    if (!userId) throw new Error('No order ID for this job');
    const u = (await XT.erp.getJson(XT.erp.userUrl(userId))) || {};
    return {
      company: u.company_name || (u.company && u.company.name) || '',
      contact: [u.first_name, u.last_name].filter(Boolean).join(' '),
      email: u.email_address || '',
    };
  });

  // Текст значения: данные, «Loading…» или ошибка
  function infoText(info, value) {
    if (info.error) return `⚠ ${info.error}`;
    if (info.loading) return 'Loading…';
    return value == null || value === '' ? '—' : String(value);
  }

  // ---------------- Разбор ответа ERP ----------------
  // Из большого JSON оставляем только то, что показываем (это и кладём в кеш).
  // Основной формат: ответ /fulfillment/jobs/{jobId} с массивом lineItems.
  function summarize(data) {
    const lineItems = Array.isArray(data && data.lineItems) ? data.lineItems : [];

    // Одна запись на каждый line item: один и тот же part ID может стоять в нескольких
    // строках с разной инспекцией, поэтому по part ID не схлопываем
    const parts = lineItems.map((li) => {
      const partId = li.customerPartId || (li.partView && li.partView.partNameDisplay) || li.jobLineItemId || '?';
      const code = li.inspectionId || '';
      const values = (li.requirementsDisplay || li.requirements_display || [])
        .filter((r) => r.label === 'Inspection' && r.value)
        .map((r) => r.value);
      const inspection = values.length ? values.join(', ') : (code || 'Unknown');
      return {
        partId,
        inspection,
        isStd: values.length
          ? values.every((v) => /^standard inspection$/i.test(v))
          : code === 'std',
      };
    });

    return {
      partCount: parts.length,
      allStd: parts.length > 0 && parts.every((p) => p.isStd),
      jobStatus: (data && data.status) || '',
      partner: (data && data.partnerCompanyName) || '',
      partnerId: (data && data.partnerId) || '',
      vendor: (data && data.acceptedVendor) || '',
      // Есть ли orderId в этом ответе, не проверено; если нет, клиент найдётся через job-plan
      orderId: (data && (data.orderId || (Array.isArray(data.orderIds) && data.orderIds[0]))) || '',
      parts,
    };
  }

  // ---------------- Запросы в ERP (очередь) ----------------
  const queue = [];
  const inFlight = new Set();
  const retries = new Map();   // jobId -> сколько повторов уже сделано
  let active = 0;

  // Не повторяем то, что само не пройдёт: нет входа в ERP, 404, перезагрузка расширения
  function isPermanent(err) {
    return /Not authorized|responded with 4(?!29)\d\d|not allowed|reload the page/i.test(err.message);
  }

  function onFetchError(jobId, err) {
    const n = retries.get(jobId) || 0;
    if (isPermanent(err) || n >= RETRY_DELAYS_MS.length) {
      retries.delete(jobId);
      state.set(jobId, { status: 'error', message: err.message });
      return;
    }
    retries.set(jobId, n + 1);
    console.warn(`[ERP sidebar] ${jobId}: ${err.message}, retry ${n + 1}`);
    setTimeout(() => { if (running) enqueue(jobId, true); }, RETRY_DELAYS_MS[n]);
  }

  function enqueue(jobId, force = false) {
    if (inFlight.has(jobId) || queue.includes(jobId)) return;
    // state есть, пока джоба в работе, ждёт повтора или упала: такие перезапрашиваем только явно
    if (!force && (isFresh(cacheGet(jobId)) || state.has(jobId))) return;
    queue.push(jobId);
    pump();
  }

  function pump() {
    while (active < MAX_CONCURRENT && queue.length) {
      const jobId = queue.shift();
      active++;
      inFlight.add(jobId);
      state.set(jobId, { status: 'loading' });
      fetchJob(jobId)
        .then((summary) => { cacheSet(jobId, summary); state.delete(jobId); retries.delete(jobId); })
        .catch((err) => onFetchError(jobId, err))
        .finally(() => { active--; inFlight.delete(jobId); renderAll(); pump(); });
    }
  }

  // Запрос идёт через background (общий модуль src/common/erp-client.js)
  function fetchJob(jobId) {
    return XT.erp.getJson(XT.erp.jobApiUrl(jobId)).then(summarize);
  }

  // ---------------- Чтение таблицы кейсов ----------------
  const state = new Map();     // jobId -> {status:'loading'|'error', message}
  let rows = [];               // [{key, tr, jobId, itar, table, scroller}]
  let loggedSample = false;

  function headerLabels(table) {
    const ths = table.querySelectorAll('thead tr > *');
    return [...ths].map((th) => th.getAttribute('aria-label') || th.getAttribute('title') || deepText(th));
  }

  function isCheckedCell(cell) {
    if (!cell) return false;
    const checkedMarkers = deepQueryAll(
      'svg[data-key="check"], [icon-name="utility:check"], input[type="checkbox"]:checked, ' +
      'img[alt="Checked"], img[alt="True"], [title="True"], [title="Checked"]', cell);
    return checkedMarkers.length > 0;
  }

  function scanTables() {
    if (!location.pathname.startsWith(LIST_PATH)) { rows = []; return; }

    const found = [];
    deepQueryAll('table').filter(isVisible).forEach((table) => {
      const labels = headerLabels(table);
      const subjectIdx = labels.findIndex((l) => SUBJECT_HEADER_RE.test(l.trim()));
      if (subjectIdx < 0) return;
      const itarIdx = labels.findIndex((l) => ITAR_HEADER_RE.test(l));
      const scroller = findScroller(table);

      table.querySelectorAll('tbody tr').forEach((tr) => {
        const cells = tr.querySelectorAll(':scope > th, :scope > td');
        const subjectCell = cells[subjectIdx];
        if (!subjectCell) return;
        const itarCell = itarIdx >= 0 ? cells[itarIdx] : null;

        if (!loggedSample && itarCell) {
          console.log('[ERP sidebar] ITAR cell sample:', itarCell.outerHTML);
          loggedSample = true;
        }

        const match = deepText(subjectCell).match(JOB_ID_RE);
        found.push({
          key: tr.getAttribute('data-row-key-value') || deepText(subjectCell),
          tr,
          table,
          scroller,
          jobId: match ? match[0].toUpperCase() : null,
          itar: isCheckedCell(itarCell),
        });
      });
    });

    rows = found;
    rows.filter(showsCard).forEach((r) => enqueue(r.jobId));
    renderAll();
  }

  // ITAR-кейсы (галочка Primary ITAR Field) — только если в Settings включён ITAR user
  let itarUser = false;
  function showsCard(row) {
    return row.jobId && (itarUser || !row.itar);
  }

  // ---------------- Карточки ----------------
  // Слой добавляется в страницу в start()
  const layer = document.createElement('div');
  Object.assign(layer.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: 50 });

  const FONT = '12px "Salesforce Sans", Arial, sans-serif';
  const cards = new Map();      // row key -> { card, main, toggle, details }
  const expanded = new Set();   // row keys с открытыми деталями

  function escapeHtml(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function getCard(key) {
    let c = cards.get(key);
    if (c) return c;

    const card = document.createElement('div');
    Object.assign(card.style, {
      position: 'fixed', pointerEvents: 'auto', boxSizing: 'border-box',
      display: 'flex', alignItems: 'center', gap: '6px', padding: '0 4px 0 8px',
      borderLeft: '4px solid', borderRadius: '4px', font: FONT, whiteSpace: 'nowrap',
    });

    const main = document.createElement('div');
    Object.assign(main.style, {
      flex: '1', display: 'flex', gap: '8px', alignItems: 'center',
      overflow: 'hidden', cursor: 'pointer',
    });

    const toggle = document.createElement('button');
    toggle.type = 'button';
    Object.assign(toggle.style, {
      border: '1px solid currentColor', background: 'transparent', color: 'inherit',
      borderRadius: '3px', padding: '0 6px', height: '20px', cursor: 'pointer', font: FONT,
    });

    // Панель с подробностями: появляется под карточкой
    const details = document.createElement('div');
    Object.assign(details.style, {
      position: 'fixed', pointerEvents: 'auto', boxSizing: 'border-box', display: 'none',
      background: '#fff', color: '#181818', border: '1px solid #c9c9c9', borderRadius: '4px',
      boxShadow: '0 2px 8px rgba(0,0,0,.2)', padding: '8px 10px', font: FONT,
      maxHeight: '300px', overflowY: 'auto', zIndex: 1,
    });

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      // Открыта может быть только одна панель
      const wasOpen = expanded.has(key);
      expanded.clear();
      if (!wasOpen) expanded.add(key);
      renderAll();
    });

    card.append(main, toggle);
    layer.append(card, details);
    c = { card, main, toggle, details };
    cards.set(key, c);
    return c;
  }

  // Содержимое раскрывающейся панели. Новые блоки информации добавлять сюда.
  function renderDetails(s, jobId) {
    const rowsHtml = s.parts.map((p) => `
      <tr>
        <td style="padding:2px 12px 2px 0;font-weight:600">${escapeHtml(p.partId)}</td>
        <td style="padding:2px 0;color:${p.isStd ? COLORS.std.border : COLORS.nonstd.text}">${escapeHtml(p.inspection)}</td>
      </tr>`).join('');
    const label = (t) => `<div style="color:#706e6b">${t}</div>`;
    const partnerHtml = `
      <div style="flex:1;min-width:0">
        ${label('Partner')}
        <div style="font-weight:600">${s.partnerId
          ? `<a href="${XT.erp.partnerPageUrl(s.partnerId)}" target="_blank" rel="noopener">${escapeHtml(s.partner || s.partnerId)}</a>`
          : escapeHtml(s.partner || '—')}</div>
        <div style="margin-top:2px"><span style="color:#706e6b">Jobs completed:</span>
          <b>${escapeHtml(s.vendor ? infoText(partnerInfo.get(s.vendor), partnerInfo.get(s.vendor).completedJobs) : '—')}</b></div>
      </div>`;
    const cu = customerInfo.get(jobId);
    const customerHtml = `
      <div style="flex:1;min-width:0;padding-left:12px;border-left:1px solid #e5e5e5">
        ${label('Customer')}
        ${cu.loading || cu.error
          ? `<div>${escapeHtml(infoText(cu))}</div>`
          : `<div style="font-weight:600">${escapeHtml(infoText(cu, cu.company))}</div>
        <div style="margin-top:2px">${escapeHtml(infoText(cu, cu.contact))}</div>
        <div style="margin-top:2px;overflow-wrap:anywhere">${cu.email
          ? `<a href="mailto:${encodeURIComponent(cu.email)}">${escapeHtml(cu.email)}</a>` : '—'}</div>`}
      </div>`;
    return `
      <div style="display:flex;gap:12px;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #e5e5e5;white-space:normal">
        ${partnerHtml}${customerHtml}
      </div>` + `
      <table style="border-collapse:collapse;width:100%">
        <thead><tr>
          <th style="text-align:left;padding:0 12px 4px 0;color:#706e6b;font-weight:400">Part ID</th>
          <th style="text-align:left;padding:0 0 4px;color:#706e6b;font-weight:400">Inspection</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>`;
  }

  // Клик в любом месте экрана закрывает панель. Ловим на capture: Salesforce может
  // гасить всплытие у своих элементов. Клики по кнопке More/Less и внутри панели не трогаем.
  function onDocClick(e) {
    if (!expanded.size) return;
    const path = e.composedPath();
    for (const c of cards.values()) {
      if (path.includes(c.toggle) || path.includes(c.details)) return;
    }
    expanded.clear();
    renderAll();
  }

  function setHtml(el, html) {
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
  }

  function renderCard(row) {
    const { card, main, toggle, details } = getCard(row.key);
    const entry = cacheGet(row.jobId);
    const st = state.get(row.jobId);
    let color = COLORS.neutral;
    let html;
    let title = '';
    let summary = null;

    if (st && st.status === 'error') {
      color = COLORS.error;
      html = `⚠ ${row.jobId}: ${escapeHtml(st.message)}`;
      title = `${st.message}\nShift+click: retry`;
    } else if (entry) {
      summary = entry.summary;
      color = summary.allStd ? COLORS.std : COLORS.nonstd;
      const n = summary.partCount;
      html = `<b>${summary.allStd ? 'Standard' : 'Non-std'}</b><span>${n} part ID${n === 1 ? '' : 's'}</span>`;
      if (st && st.status === 'loading') html += '<span style="opacity:.6">↻</span>';
      const ageMin = Math.round((Date.now() - entry.time) / 60000);
      title = [summary.partner, summary.jobStatus && `Job status: ${summary.jobStatus}`]
        .filter(Boolean).join('\n')
        + `\n\nERP data: ${ageMin} min ago\nClick: open in ERP · Shift+click: refresh`;
    } else {
      html = 'Loading from ERP…';
      title = row.jobId;
    }
    if (row.itar) html = '<b style="padding:0 4px;border:1px solid currentColor;border-radius:3px">ITAR</b>' + html;

    Object.assign(card.style, { background: color.bg, borderLeftColor: color.border, color: color.text });
    setHtml(main, html);
    main.title = title;
    main.onclick = (e) => {
      if (e.shiftKey) {
        state.delete(row.jobId);
        enqueue(row.jobId, true);
        // Упавшие запросы по партнёру и клиенту тоже повторятся при следующем открытии More
        if (summary && summary.vendor) partnerInfo.forget(summary.vendor);
        customerInfo.forget(row.jobId);
        renderAll();
      }
      else XT.openTab(XT.erp.jobPageUrl(row.jobId)).catch((err) => console.warn('[ERP sidebar]', err.message));
    };

    const isOpen = expanded.has(row.key) && summary;
    toggle.style.display = summary ? '' : 'none';
    toggle.textContent = isOpen ? '▴ Less' : '▾ More';
    details.dataset.open = isOpen ? '1' : '';
    if (isOpen) {
      partnerInfo.load(summary.vendor);
      customerInfo.load(row.jobId);
      setHtml(details, renderDetails(summary, row.jobId));
    }
  }

  function renderAll() {
    const keep = new Set();
    rows.forEach((row) => {
      if (!showsCard(row)) return;
      keep.add(row.key);
      renderCard(row);
    });
    for (const [key, c] of cards) {
      if (!keep.has(key)) { c.card.remove(); c.details.remove(); cards.delete(key); expanded.delete(key); }
    }
  }

  // Позиции карточек обновляем каждый кадр, чтобы они ехали вместе с прокруткой
  function positionCards() {
    rows.forEach((row) => {
      const c = cards.get(row.key);
      if (!c) return;
      const { card, details } = c;
      const hide = () => { card.style.display = 'none'; details.style.display = 'none'; };
      if (!row.tr.isConnected) { hide(); return; }

      const r = row.tr.getBoundingClientRect();
      const tableRect = row.table.getBoundingClientRect();
      const thead = row.table.querySelector('thead');
      const clipTop = Math.max(row.scroller ? row.scroller.getBoundingClientRect().top : 0,
        thead ? thead.getBoundingClientRect().bottom : 0);
      const clipBottom = Math.min(row.scroller ? row.scroller.getBoundingClientRect().bottom : innerHeight, innerHeight);

      let left = tableRect.right + 8;
      if (row.scroller) {
        const sr = row.scroller.getBoundingClientRect();
        if (sr.right < innerWidth - 120) left = Math.max(left, sr.right + 8);
      }
      const width = Math.min(CARD_WIDTH, innerWidth - left - 12);

      if (!r.height || r.top < clipTop - 2 || r.bottom > clipBottom + 2 || width < 120) {
        hide();
        return;
      }
      Object.assign(card.style, {
        display: 'flex', top: `${r.top + 2}px`, left: `${left}px`,
        width: `${width}px`, height: `${r.height - 4}px`,
      });
      if (details.dataset.open) {
        Object.assign(details.style, {
          // Правый край панели совпадает с правым краем карточки
          display: 'block', top: `${r.bottom - 1}px`, width: `${Math.max(width, DETAILS_WIDTH)}px`,
          left: `${Math.max(8, left + width - Math.max(width, DETAILS_WIDTH))}px`,
        });
      } else {
        details.style.display = 'none';
      }
    });
    layer.style.display = location.pathname.startsWith(LIST_PATH) ? '' : 'none';
    rafId = requestAnimationFrame(positionCards);
  }

  // ---------------- Команды из popup (бывшее меню Tampermonkey) ----------------
  XT.onAction(SCRIPT_ID, (action) => {
    if (!running) return;
    if (action === 'refresh-all') {
      rows.filter(showsCard).forEach((r) => { state.delete(r.jobId); enqueue(r.jobId, true); });
    }
    if (action === 'clear-cache') clearCache().then(scanTables);
  });

  // ---------------- Запуск / остановка (переключатель в popup) ----------------
  let running = false;
  let scanTimer = null;
  let rafId = 0;

  function start() {
    if (running) return;
    running = true;
    document.body.appendChild(layer);
    document.addEventListener('click', onDocClick, true);
    scanTimer = setInterval(scanTables, 1500);
    scanTables();
    rafId = requestAnimationFrame(positionCards);
  }

  function stop() {
    if (!running) return;
    running = false;
    document.removeEventListener('click', onDocClick, true);
    clearInterval(scanTimer);
    cancelAnimationFrame(rafId);
    queue.length = 0;
    rows = [];
    renderAll();   // rows пуст → все карточки удаляются
    layer.remove();
  }

  XT.prefs.watch((prefs) => {
    if (prefs.itarUser === itarUser) return;
    itarUser = prefs.itarUser;
    if (running) scanTables();   // включили — запросит ITAR-кейсы, выключили — renderAll уберёт их карточки
  });

  // Ждём загрузки кеша, чтобы первый рендер не запросил заново всё, что уже есть
  Promise.all([cache.ready, partnerInfo.ready, customerInfo.ready]).then(() => XT.settings.watch(SCRIPT_ID, (on) => (on ? start() : stop())));
})();
