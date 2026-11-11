// Общий модуль ERP API для content scripts.
// Сами запросы выполняет background service worker: из content script на api.xometry.com был бы CORS.
(function () {
  'use strict';
  const XT = (globalThis.XT = globalThis.XT || {});

  function send(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const err = chrome.runtime.lastError;
          if (err) { reject(new Error(err.message)); return; }
          if (!response || !response.ok) {
            reject(new Error((response && response.error) || 'Background request failed'));
            return;
          }
          resolve(response.data);
        });
      } catch (e) {
        // После обновления/перезагрузки расширения старый content script теряет связь с background
        reject(new Error('Extension was updated: reload the page'));
      }
    });
  }

  // Сообщение в background с ответом { ok, data | error }; используется и другими модулями
  XT.sendToBackground = send;

  XT.erp = {
    jobApiUrl: (jobId) => `https://api.xometry.com/fulfillment/admin/jobs/${jobId}`,
    jobPageUrl: (jobId) => `https://www.xometry.com/erp/jobs/${jobId}`,
    // vendor — поле acceptedVendor из ответа по джобе (не partnerId)
    vendorStatsUrl: (vendor) => `https://api.xometry.com/v2/jobs/metadata?completed=true&vendor=${encodeURIComponent(vendor)}`,
    partnerPageUrl: (partnerId) => `https://staff.xometry.com/partners/${encodeURIComponent(partnerId)}`,
    // GET с cookies пользователя; резолвится распарсенным JSON.
    // Одинаковые запросы background склеивает и минуту отдаёт из памяти; fresh: true — всегда новый запрос.
    getJson: (url, { fresh = false } = {}) => send({ type: 'ERP_GET', url, fresh }),
    // GraphQL ERP: только операции из списка в service worker (PartnerJob, GetOrderDetails); резолвится data
    graphql: (operation, id, { fresh = false } = {}) => send({ type: 'ERP_GRAPHQL', operation, id, fresh }),
  };

  // Сколько jobs партнёр выполнил: { completedJobs }. vendor — acceptedVendor джобы.
  XT.erp.partnerStats = (vendor, opts) => XT.erp.getJson(XT.erp.vendorStatsUrl(vendor), opts)
    .then((d) => ({ completedJobs: d && d.total_completed_jobs }));

  // Всё о джобе и её заказе (первом — у всех заказов одной джобы один CM) двумя GraphQL-запросами:
  // internal notes, vendor, заказчик, CM, staff notes заказа, партнёр этой джобы.
  // Общая для плашки кейса и панели More в ERP sidebar.
  XT.erp.jobOrderInfo = async (jobId, opts) => {
    const pj = (await XT.erp.graphql('PartnerJob', jobId, opts)).partnerJob;
    if (!pj) throw new Error(`${jobId} not found in ERP`);
    const orderIds = [...new Set((pj.lineItems || []).map((li) => li.xometryOrderId).filter(Boolean))];
    const info = {
      notes: String(pj.internalNotes || '').trim(),
      vendor: pj.acceptedVendor || '',
      orderId: orderIds[0] || '',
      hasOrder: false,
      cm: '', company: '', contact: '', email: '', partnerName: '', partnerId: '',
      staffNotes: [],   // [{ text, createdAt, author }]
    };
    if (!info.orderId) return info;

    // Заказ не загрузился — заметки джобы всё равно отдаём, ошибка в orderError
    let o;
    try { o = (await XT.erp.graphql('GetOrderDetails', info.orderId, opts)).getOrder; }
    catch (e) { info.orderError = e.message; return info; }
    if (!o) return info;
    const jobs = (o.lineItems || []).flatMap((li) => (li.outsourcing && li.outsourcing.jobs) || []);
    const mine = jobs.find((j) => j.jobId === jobId) || {};
    const c = o.customer || {};
    return Object.assign(info, {
      hasOrder: true,
      cm: (o.orderAssignment && o.orderAssignment.caseManagerName) || '',
      company: c.companyName || '',
      contact: c.customerName || '',
      email: c.customerEmail || '',
      partnerName: mine.partnerName || '',
      partnerId: mine.partnerId || '',
      staffNotes: (o.orderNotes || []).map((n) => ({
        text: String(n.text || '').trim(),
        createdAt: n.createdAt || '',
        author: (n.staffUser && n.staffUser.name) || '',
      })).filter((n) => n.text),
    });
  };

  // Если расширение перезагрузили, а вкладку нет — открываем вкладку из самой страницы
  XT.openTab = (url) => send({ type: 'OPEN_TAB', url }).catch((error) => {
    if (chrome.runtime && chrome.runtime.id) throw error;
    window.open(url, '_blank', 'noopener');
  });
})();
