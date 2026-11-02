// Salesforce Case record: buttons that insert a preset text where the cursor is.
(function () {
  'use strict';

  const SCRIPT_ID = 'sf-case-quick-text';
  const CASE_PATH_RE = /^\/lightning\/r\/Case\/[^/]+\/view\/?$/;
  const PANEL_ID = 'xt-case-quick-text';
  const TAB_LABEL = 'Collapse!';

  const BUTTONS = [
    { key: 'passText', label: 'VQC pass', background: '#2e844a', color: '#fff', border: '#2e844a' },
    { key: 'correctionsText', label: 'PASS after corrections', background: '#fcc003', color: '#181818', border: '#e4a201' },
  ];

  function deepQueryAll(selector, root = document) {
    const found = [];
    const walk = (node) => {
      node.querySelectorAll(selector).forEach((el) => found.push(el));
      node.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) walk(el.shadowRoot); });
    };
    walk(root);
    return found;
  }

  function parentAcrossShadow(element) {
    if (element.parentElement) return element.parentElement;
    const root = element.getRootNode();
    return root && root.host ? root.host : null;
  }

  function isVisible(element) {
    return element && element.isConnected && element.getClientRects().length > 0;
  }

  // Поле, где сейчас курсор: заходим в shadow root и в iframe редактора письма (TinyMCE)
  function activeEditable() {
    let element = document.activeElement;
    for (let depth = 0; element && depth < 10; depth++) {
      if (element.shadowRoot && element.shadowRoot.activeElement) {
        element = element.shadowRoot.activeElement;
      } else if (element.tagName === 'IFRAME') {
        try { element = element.contentDocument && element.contentDocument.activeElement; } catch (e) { return null; }
      } else {
        break;
      }
    }
    if (!element) return null;
    if (element.isContentEditable || element.tagName === 'TEXTAREA') return element;
    if (element.tagName === 'INPUT' && /^(text|search|email|url|tel)$/.test(element.type)) return element;
    return null;
  }

  function insertText(target, text) {
    target.focus();
    // execCommand сохраняет undo и шлёт input, на который реагируют LWC и TinyMCE
    if (target.ownerDocument.execCommand('insertText', false, text)) return;
    if (typeof target.setRangeText === 'function') {
      target.setRangeText(text, target.selectionStart, target.selectionEnd, 'end');
      target.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }
  }

  let options = {};
  let target = null;

  function flash(button, text) {
    const label = button.textContent;
    button.textContent = text;
    setTimeout(() => { button.textContent = label; }, 1500);
  }

  function createButton(spec) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = spec.label;
    Object.assign(button.style, {
      boxSizing: 'border-box',
      height: '32px',
      padding: '0 14px',
      border: `1px solid ${spec.border}`,
      borderRadius: '16px',
      background: spec.background,
      color: spec.color,
      font: '600 13px Arial, sans-serif',
      whiteSpace: 'nowrap',
      cursor: 'pointer',
    });
    // На mousedown фокус ещё в поле: запоминаем его и не даём кнопке забрать фокус
    button.addEventListener('mousedown', (event) => {
      target = activeEditable();
      event.preventDefault();
    });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const text = options[spec.key];
      const field = target && target.isConnected ? target : activeEditable();
      target = null;
      if (!field) { flash(button, 'Click in a text field first'); return; }
      if (text) insertText(field, text);
    });
    return button;
  }

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    Object.assign(panel.style, { display: 'flex', flexWrap: 'wrap', gap: '8px', margin: '12px 0 4px' });
    panel.append(...BUTTONS.map(createButton));
    return panel;
  }

  // Список вкладок (role=tablist), в котором есть вкладка «Collapse!»
  function findTabList() {
    const tab = deepQueryAll('[role="tab"]')
      .filter(isVisible)
      .find((element) => element.textContent.trim() === TAB_LABEL);
    let element = tab;
    for (let depth = 0; element && depth < 6; depth++, element = parentAcrossShadow(element)) {
      if (element.getAttribute && element.getAttribute('role') === 'tablist') return element;
    }
    return null;
  }

  const panel = createPanel();
  let running = false;
  let timer = null;

  function syncPanel() {
    const tabList = CASE_PATH_RE.test(location.pathname) && findTabList();
    if (!tabList || !tabList.parentNode) {
      panel.remove();
      return;
    }
    if (tabList.nextSibling !== panel) tabList.parentNode.insertBefore(panel, tabList.nextSibling);
  }

  function start() {
    if (running) return;
    running = true;
    syncPanel();
    timer = setInterval(syncPanel, 1200);
  }

  function stop() {
    if (!running) return;
    running = false;
    clearInterval(timer);
    panel.remove();
  }

  XT.options.watch(SCRIPT_ID, (value) => { options = value; });
  XT.settings.watch(SCRIPT_ID, (enabled) => (enabled ? start() : stop()));
})();
