// Salesforce Case Queue: ERP sidebar
// Перенос userscripts/salesforce-erp-sidebar.user.js (v0.4). DOM-логика и summarize не менялись;
// GM_* заменены на XT.* из src/common, запуск обёрнут в start()/stop() для переключателя в popup.

(function () {
  'use strict';

  const SCRIPT_ID = 'sf-erp-sidebar';

  // ======================= НАСТРОЙКИ =======================
  const CACHE_TTL_MIN = 30;      // через сколько минут данные считаются устаревшими
  const MAX_CONCURRENT = 2;      // сколько запросов в ERP одновременно
  const CARD_WIDTH = 260;        // ширина карточки, px
  const JOB_ID_RE = /\bJ[0-9A-Z]{6,10}\b/;
  const LIST_PATH = '/lightning/o/Case/list';
  const ITAR_HEADER_RE = /ITAR/i;   // колонка с галочкой (Primary ITAR Field)
  const SUBJECT_HEADER_RE = /^Subject$/i;
  // ==========================================================

  const CACHE_PREFIX = XT.registry.getScript(SCRIPT_ID).cachePrefix; // 'erpjob2:'
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
    return cache.clear();
  }

  // ---------------- Разбор ответа ERP ----------------
  // Из большого JSON оставляем только то, что показываем (это и кладём в кеш).
  // Основной формат: ответ /fulfillment/jobs/{jobId} с массивом lineItems.
  function summarize(data) {
    const lineItems = Array.isArray(data && data.lineItems) ? data.lineItems : [];

    // Одна запись на каждый уникальный part ID
    const byPart = new Map();
    lineItems.forEach((li) => {
      const partId = li.customerPartId || (li.partView && li.partView.partNameDisplay) || li.jobLineItemId || '?';
      const code = li.inspectionId || '';
      const display = (li.requirementsDisplay || li.requirements_display || [])
        .find((r) => r.label === 'Inspection');
      const inspection = display ? display.value : (code || 'Unknown');
      if (!byPart.has(partId)) {
        byPart.set(partId, {
          partId,
          inspection,
          isStd: code === 'std' || /^standard inspection$/i.test(inspection),
        });
      }
    });
    const parts = [...byPart.values()];

    return {
      partCount: parts.length,
      allStd: parts.length > 0 && parts.every((p) => p.isStd),
      jobStatus: (data && data.status) || '',
      partner: (data && data.partnerCompanyName) || '',
      parts,
    };
  }

  // ---------------- Запросы в ERP (очередь) ----------------
  const queue = [];
  const inFlight = new Set();
  let active = 0;

  function enqueue(jobId, force = false) {
    if (inFlight.has(jobId) || queue.includes(jobId)) return;
    if (!force && isFresh(cacheGet(jobId))) return;
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
        .then((summary) => { cacheSet(jobId, summary); state.delete(jobId); })
        .catch((err) => { state.set(jobId, { status: 'error', message: err.message }); })
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
          jobId: match ? match[0] : null,
          itar: isCheckedCell(itarCell),
        });
      });
    });

    rows = found;
    rows.filter((r) => r.jobId && !r.itar).forEach((r) => enqueue(r.jobId));
    renderAll();
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
      if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
      renderAll();
    });

    card.append(main, toggle);
    layer.append(card, details);
    c = { card, main, toggle, details };
    cards.set(key, c);
    return c;
  }

  // Содержимое раскрывающейся панели. Новые блоки информации добавлять сюда.
  function renderDetails(s) {
    const rowsHtml = s.parts.map((p) => `
      <tr>
        <td style="padding:2px 12px 2px 0;font-weight:600">${escapeHtml(p.partId)}</td>
        <td style="padding:2px 0;color:${p.isStd ? COLORS.std.border : COLORS.nonstd.text}">${escapeHtml(p.inspection)}</td>
      </tr>`).join('');
    return `
      <table style="border-collapse:collapse;width:100%">
        <thead><tr>
          <th style="text-align:left;padding:0 12px 4px 0;color:#706e6b;font-weight:400">Part ID</th>
          <th style="text-align:left;padding:0 0 4px;color:#706e6b;font-weight:400">Inspection</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>`;
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
      html = `⚠ ${row.jobId}: error`;
      title = st.message;
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

    Object.assign(card.style, { background: color.bg, borderLeftColor: color.border, color: color.text });
    setHtml(main, html);
    main.title = title;
    main.onclick = (e) => {
      if (e.shiftKey) { state.delete(row.jobId); enqueue(row.jobId, true); renderAll(); }
      else XT.openTab(XT.erp.jobPageUrl(row.jobId)).catch((err) => console.warn('[ERP sidebar]', err.message));
    };

    const isOpen = expanded.has(row.key) && summary;
    toggle.style.display = summary ? '' : 'none';
    toggle.textContent = isOpen ? '▴ Less' : '▾ More';
    details.dataset.open = isOpen ? '1' : '';
    if (isOpen) setHtml(details, renderDetails(summary));
  }

  function renderAll() {
    const keep = new Set();
    rows.forEach((row) => {
      if (!row.jobId || row.itar) return;
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
          display: 'block', top: `${r.bottom - 1}px`, left: `${left}px`, width: `${width}px`,
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
      rows.filter((r) => r.jobId && !r.itar).forEach((r) => { state.delete(r.jobId); enqueue(r.jobId, true); });
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
    scanTimer = setInterval(scanTables, 1500);
    scanTables();
    rafId = requestAnimationFrame(positionCards);
  }

  function stop() {
    if (!running) return;
    running = false;
    clearInterval(scanTimer);
    cancelAnimationFrame(rafId);
    queue.length = 0;
    rows = [];
    renderAll();   // rows пуст → все карточки удаляются
    layer.remove();
  }

  // Ждём загрузки кеша, чтобы первый рендер не запросил заново всё, что уже есть
  cache.ready.then(() => XT.settings.watch(SCRIPT_ID, (on) => (on ? start() : stop())));
})();
