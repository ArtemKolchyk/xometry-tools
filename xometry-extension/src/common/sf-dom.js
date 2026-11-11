// Поиск элементов на страницах Salesforce Lightning: обход shadow DOM и общие ориентиры страницы кейса.
(function () {
  'use strict';
  const XT = (globalThis.XT = globalThis.XT || {});

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
    const walk = (current) => {
      if (current.nodeType === Node.TEXT_NODE) {
        const text = current.textContent.trim();
        if (text) parts.push(text);
        return;
      }
      if (current.shadowRoot) current.shadowRoot.childNodes.forEach(walk);
      current.childNodes.forEach(walk);
    };
    walk(node);
    return parts.join(' ');
  }

  function parentAcrossShadow(element) {
    if (element.parentElement) return element.parentElement;
    const root = element.getRootNode();
    return root && root.host ? root.host : null;
  }

  function isVisible(element) {
    return element && element.isConnected && element.getClientRects().length > 0;
  }

  function findLaunchVqcAction() {
    const actions = deepQueryAll('lightning-button, button, a, [role="button"]')
      .filter(isVisible);
    const labelOf = (element) => [
      deepText(element),
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const isLaunchVqc = (element) => /(^|\s)Launch VQC($|\s)/i.test(labelOf(element));

    return actions.find((element) => element.tagName.toLowerCase() === 'lightning-button' && isLaunchVqc(element))
      || actions.find(isLaunchVqc);
  }

  // Ячейка группы кнопок (li) с Launch VQC, готовая к абсолютному позиционированию детей под ней
  function launchVqcCell() {
    const launchAction = findLaunchVqcAction();
    if (!launchAction) return null;
    let cell = launchAction;
    for (let depth = 0; cell && depth < 8; depth++, cell = parentAcrossShadow(cell)) {
      if (cell.tagName === 'LI') break;
    }
    cell = cell || launchAction;
    if (getComputedStyle(cell).position === 'static') cell.style.position = 'relative';
    return cell;
  }

  // Номер джобы открытого кейса: из поля Subject, иначе единственный номер на странице.
  // Регистр в теме кейса бывает любой (J03b164A); цифра обязательна, чтобы не ловить слова вроде "January"
  const JOB_ID_RE = /\bJ(?=[0-9A-Z]*\d)[0-9A-Z]{6,10}\b/i;
  function caseJobId() {
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

  XT.dom = { deepQueryAll, deepText, parentAcrossShadow, isVisible, launchVqcCell, findLaunchVqcAction, caseJobId };
})();
