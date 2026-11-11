// Salesforce Case record: open its ERP job in a new tab.
(function () {
  'use strict';

  const SCRIPT_ID = 'sf-case-erp-button';
  const CASE_PATH_RE = /^\/lightning\/r\/Case\/[^/]+\/view\/?$/;
  const BUTTON_ID = 'xt-open-case-job-in-erp';
  const getJobId = XT.dom.caseJobId;

  function createButton() {
    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = 'Open in ERP';
    button.setAttribute('aria-label', 'Open this case job in ERP');
    Object.assign(button.style, {
      position: 'absolute',
      top: '100%',
      left: '0',
      marginTop: '8px',
      boxSizing: 'border-box',
      height: '32px',
      padding: '0 12px',
      border: '1px solid #0176d3',
      borderRadius: '16px 4px 4px 16px',
      background: '#0176d3',
      color: '#fff',
      font: '600 13px Arial, sans-serif',
      whiteSpace: 'nowrap',
      cursor: 'pointer',
      zIndex: '10',
    });
    // Hover как у брендовых кнопок Salesforce
    button.addEventListener('mouseenter', () => { button.style.background = '#014486'; button.style.borderColor = '#014486'; });
    button.addEventListener('mouseleave', () => { button.style.background = '#0176d3'; button.style.borderColor = '#0176d3'; });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      // Открываем прямо со страницы: клик пользователя разрешает window.open, background не нужен
      const jobId = button.dataset.jobId;
      if (jobId) window.open(XT.erp.jobPageUrl(jobId), '_blank', 'noopener');
    });
    return button;
  }

  const button = createButton();
  let running = false;
  let timer = null;

  function syncButton() {
    if (document.hidden) return;   // фоновая вкладка; при возврате — visibilitychange
    if (!CASE_PATH_RE.test(location.pathname)) {
      button.remove();
      return;
    }

    const jobId = getJobId();
    if (!jobId) {
      button.remove();
      return;
    }
    button.dataset.jobId = jobId;
    button.title = `Open ${jobId} in ERP`;

    // Под ячейкой Launch VQC
    const anchor = XT.dom.launchVqcCell();
    if (!anchor) {
      button.remove();
      return;
    }
    if (button.parentElement !== anchor) anchor.appendChild(button);
  }

  function start() {
    if (running) return;
    running = true;
    syncButton();
    timer = setInterval(syncButton, 1200);
    document.addEventListener('visibilitychange', syncButton);
  }

  function stop() {
    if (!running) return;
    running = false;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', syncButton);
    button.remove();
  }

  XT.settings.watch(SCRIPT_ID, (enabled) => (enabled ? start() : stop()));
})();