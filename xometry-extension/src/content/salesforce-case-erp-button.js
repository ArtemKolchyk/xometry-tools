// Salesforce Case record: open its ERP job in a new tab.
(function () {
  'use strict';

  const SCRIPT_ID = 'sf-case-erp-button';
  const CASE_PATH_RE = /^\/lightning\/r\/Case\/[^/]+\/view\/?$/;
  // Регистр в теме кейса бывает любой (J03b164A); цифра обязательна, чтобы не ловить слова вроде "January"
  const JOB_ID_RE = /\bJ(?=[0-9A-Z]*\d)[0-9A-Z]{6,10}\b/i;
  const BUTTON_ID = 'xt-open-case-job-in-erp';
  const { deepQueryAll, deepText, parentAcrossShadow } = XT.dom;

  function getJobId() {
    const subjectLabels = deepQueryAll('.slds-form-element__label, [data-label="Subject"]')
      .filter((element) => deepText(element).trim().replace(/:$/, '') === 'Subject');

    for (const label of subjectLabels) {
      let candidate = label;
      for (let depth = 0; candidate && depth < 4; depth++, candidate = parentAcrossShadow(candidate)) {
        const match = deepText(candidate).match(JOB_ID_RE);
        if (match) return match[0].toUpperCase();
      }
    }

    const all = document.body.innerText.match(new RegExp(JOB_ID_RE.source, 'gi')) || [];
    const matches = new Set(all.map((id) => id.toUpperCase()));
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