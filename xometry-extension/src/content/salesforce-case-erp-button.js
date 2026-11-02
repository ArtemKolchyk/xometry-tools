// Salesforce Case record: open its ERP job in a new tab.
(function () {
  'use strict';

  const SCRIPT_ID = 'sf-case-erp-button';
  const CASE_PATH_RE = /^\/lightning\/r\/Case\/[^/]+\/view\/?$/;
  const JOB_ID_RE = /\bJ[0-9A-Z]{6,10}\b/;
  const BUTTON_ID = 'xt-open-case-job-in-erp';
  const { deepQueryAll, deepText, parentAcrossShadow } = XT.dom;

  function getJobId() {
    const subjectLabels = deepQueryAll('.slds-form-element__label, [data-label="Subject"]')
      .filter((element) => deepText(element).trim().replace(/:$/, '') === 'Subject');

    for (const label of subjectLabels) {
      let candidate = label;
      for (let depth = 0; candidate && depth < 4; depth++, candidate = parentAcrossShadow(candidate)) {
        const match = deepText(candidate).match(JOB_ID_RE);
        if (match) return match[0];
      }
    }

    const matches = new Set((document.body.innerText.match(/\bJ[0-9A-Z]{6,10}\b/g) || []));
    return matches.size === 1 ? [...matches][0] : null;
  }

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
      border: '1px solid #c9c9c9',
      borderRadius: '16px 4px 4px 16px',
      background: '#fff',
      color: '#0176d3',
      font: '600 13px Arial, sans-serif',
      whiteSpace: 'nowrap',
      cursor: 'pointer',
      zIndex: '10',
    });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const jobId = button.dataset.jobId;
      if (jobId) XT.openTab(XT.erp.jobPageUrl(jobId))
        .catch((error) => console.warn('[Case ERP button]', error.message));
    });
    return button;
  }

  const button = createButton();
  let running = false;
  let timer = null;

  function syncButton() {
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
  }

  function stop() {
    if (!running) return;
    running = false;
    clearInterval(timer);
    button.remove();
  }

  XT.settings.watch(SCRIPT_ID, (enabled) => (enabled ? start() : stop()));
})();