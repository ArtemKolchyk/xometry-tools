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

  XT.erp = {
    jobApiUrl: (jobId) => `https://api.xometry.com/fulfillment/admin/jobs/${jobId}`,
    jobPageUrl: (jobId) => `https://www.xometry.com/erp/jobs/${jobId}`,
    // vendor — поле acceptedVendor из ответа по джобе (не partnerId)
    vendorStatsUrl: (vendor) => `https://api.xometry.com/v2/jobs/metadata?completed=true&vendor=${encodeURIComponent(vendor)}`,
    jobPlanUrl: (jobId) => `https://www.xometry.com/api/job-plan/?jobId=${encodeURIComponent(jobId)}`,
    userUrl: (userId) => `https://api.xometry.com/v2/users/${encodeURIComponent(userId)}?embed_company=true`,
    partnerPageUrl: (partnerId) => `https://staff.xometry.com/partners/${encodeURIComponent(partnerId)}`,
    // GET с cookies пользователя; резолвится распарсенным JSON
    getJson: (url) => send({ type: 'ERP_GET', url }),
  };

  // Если расширение перезагрузили, а вкладку нет — открываем вкладку из самой страницы
  XT.openTab = (url) => send({ type: 'OPEN_TAB', url }).catch((error) => {
    if (chrome.runtime && chrome.runtime.id) throw error;
    window.open(url, '_blank', 'noopener');
  });
})();
