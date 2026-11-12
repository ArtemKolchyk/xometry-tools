// История кейсов Salesforce (CaseHistory) для Case timeline на карточках ERP sidebar.
// Запрос в Salesforce API делает background (нужны опциональные разрешения, см. registry.js).
(function () {
  'use strict';
  const XT = (globalThis.XT = globalThis.XT || {});

  const USER_ID_RE = /^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;   // владелец-человек; очереди начинаются с 00G
  const PENDING_RE = /^pending$/i;

  // records одного кейса, по возрастанию времени → { taken, pending, lastPending }
  //   taken:        первая смена владельца на человека { time, owner, by }
  //   pending:      первый переход в Pending после taken { time, by }
  //   lastPending:  время последнего перехода в Pending (Queue summary), null — ещё не было
  function summarizeCase(records) {
    const pendingRows = records.filter((r) => r.field === 'Status' && PENDING_RE.test(r.newValue || ''));
    const lastPending = pendingRows.length ? Date.parse(pendingRows[pendingRows.length - 1].time) : null;
    const takenRow = records.find((r) => r.field !== 'Status' && USER_ID_RE.test(r.newValue || ''));
    let taken = null;
    if (takenRow) {
      // Смена владельца пишется двумя строками: с ID и с именем, в одно и то же время
      const nameRow = records.find((r) => r.field === takenRow.field && r.time === takenRow.time
        && r.newValue && !USER_ID_RE.test(r.newValue));
      taken = { time: Date.parse(takenRow.time), owner: nameRow ? nameRow.newValue : '', by: takenRow.by || '' };
    }
    const pendingRow = records.find((r) => r.field === 'Status' && PENDING_RE.test(r.newValue || '')
      && (!taken || Date.parse(r.time) >= taken.time));
    const pending = pendingRow ? { time: Date.parse(pendingRow.time), by: pendingRow.by || '' } : null;
    return { taken, pending, lastPending };
  }

  // ID кейса строки таблицы: ключ строки, data-recordid или ссылка на запись (/lightning/r/Case/500…/view)
  const CASE_ID_RE = /^500[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
  const CASE_ID_IN_TEXT_RE = /\b(500[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?)\b/;
  function rowCaseId(tr, key) {
    if (CASE_ID_RE.test(key || '')) return key;
    for (const node of XT.dom.deepQueryAll('[data-recordid], a[href]', tr)) {
      const value = node.getAttribute('data-recordid') || node.getAttribute('href') || '';
      const m = value.match(CASE_ID_IN_TEXT_RE);
      if (m) return m[1];
    }
    return null;
  }

  // 3m, 2h 15m, 1d 4h
  function formatDuration(ms) {
    const min = Math.max(0, Math.round(ms / 60000));
    if (min < 60) return `${min}m`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h}h${min % 60 ? ` ${min % 60}m` : ''}`;
    return `${Math.floor(h / 24)}d${h % 24 ? ` ${h % 24}h` : ''}`;
  }

  const formatTime = (time) => new Date(time).toLocaleString(undefined,
    { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  XT.caseHistory = {
    isCaseId: (id) => CASE_ID_RE.test(id || ''),
    rowCaseId,
    BATCH: 100,   // кейсов в одном запросе (background принимает до 200)

    // caseIds → { caseId: { taken, pending } }
    async fetch(caseIds) {
      const records = await XT.sendToBackground({ type: 'SF_CASE_HISTORY', caseIds });
      const byCase = {};
      caseIds.forEach((id) => { byCase[id] = []; });
      records.forEach((r) => {
        // API может вернуть 18-символьный ID, а в таблице — 15-символьный (или наоборот)
        const id = caseIds.find((c) => c.slice(0, 15) === r.caseId.slice(0, 15));
        if (id) byCase[id].push(r);
      });
      return Object.fromEntries(Object.entries(byCase).map(([id, list]) => [id, summarizeCase(list)]));
    },

    formatDuration,
    formatTime,
  };
})();
