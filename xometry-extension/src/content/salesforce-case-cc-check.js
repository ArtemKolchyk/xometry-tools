// Salesforce Case: before an email is sent, checks that the case's Additional VQC Email is among the recipients.
// If it is missing (and differs from Web Email), Send is held and a dialog offers: add to CC & send / send without it.
(function () {
  'use strict';

  const SCRIPT_ID = 'sf-case-cc-check';
  const CASE_PATH_RE = /^\/lightning\/r\/Case\/([^/]+)\/view\/?$/;
  const ADDITIONAL_LABEL = 'Additional VQC Email';
  const WEB_LABEL = 'Web Email';
  const EMAIL_RE = /[A-Z0-9._%+'-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
  const { deepQueryAll, deepText, parentAcrossShadow, isVisible } = XT.dom;

  const emailsIn = (text) => [...new Set((String(text).match(EMAIL_RE) || []).map((e) => e.toLowerCase()))];
  const caseId = () => (location.pathname.match(CASE_PATH_RE) || [])[1] || null;

  // ---------------- Поля кейса ----------------
  // null — поля нет на экране (другая вкладка кейса); [] — поле есть, но пустое
  function readField(label) {
    const labelEl = deepQueryAll('.slds-form-element__label')
      .filter(isVisible)
      .find((el) => deepText(el).replace(/\s+/g, ' ').replace(/:$/, '').trim() === label);
    if (!labelEl) return null;
    // Поднимаемся до обёртки поля, а не до строки: в строке рядом стоит соседнее поле
    let field = labelEl;
    for (let depth = 0; field && depth < 6; depth++) {
      const parent = parentAcrossShadow(field);
      if (!parent) break;
      field = parent;
      if (field.tagName === 'RECORDS-RECORD-LAYOUT-ITEM'
        || (field.classList && field.classList.contains('slds-form-element'))) break;
    }
    return emailsIn(deepText(field));
  }

  // Последние прочитанные значения по кейсу: если Details сейчас скрыт, берём их
  const known = new Map();

  function caseEmails() {
    const id = caseId();
    if (!id) return null;
    const additional = readField(ADDITIONAL_LABEL);
    if (additional !== null) {
      known.set(id, { additional, web: readField(WEB_LABEL) || [] });
    }
    return known.get(id) || null;
  }

  // ---------------- Форма письма ----------------
  // Ближайший общий предок кнопки Send и редактора письма (TinyMCE)
  function composerOf(sendButton) {
    const editors = deepQueryAll('.tox-tinymce').filter(isVisible);
    if (!editors.length) return null;
    const editorAncestors = new Set();
    editors.forEach((editor) => {
      for (let el = editor; el; el = parentAcrossShadow(el)) editorAncestors.add(el);
    });
    for (let el = sendButton; el; el = parentAcrossShadow(el)) {
      if (editorAncestors.has(el)) return el === document.body || el === document.documentElement ? null : el;
    }
    return null;
  }

  // Адреса в форме: плашки (текст) и то, что набрано в полях, но ещё не стало плашкой.
  // Тело письма в iframe, deepText в него не заходит.
  function recipientsOf(composer, { pillsOnly = false } = {}) {
    let text = deepText(composer);
    if (!pillsOnly) text += ' ' + deepQueryAll('input', composer).map((i) => i.value).join(' ');
    return new Set(emailsIn(text));
  }

  const labelOf = (el) => [deepText(el), el.getAttribute('aria-label'), el.getAttribute('title')]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

  function findCcInput(composer) {
    const labels = deepQueryAll('label', composer).filter((el) => isVisible(el) && /^cc$/i.test(deepText(el).trim()));
    for (const label of labels) {
      const root = label.getRootNode();
      if (label.htmlFor && root.getElementById) {
        const input = root.getElementById(label.htmlFor);
        if (input && input.tagName === 'INPUT' && isVisible(input)) return input;
      }
      let el = label;
      for (let depth = 0; el && depth < 4; depth++) {
        el = parentAcrossShadow(el);
        if (!el) break;
        const input = deepQueryAll('input', el).find(isVisible);
        if (input) return input;
      }
    }
    return null;
  }

  function openCcRow(composer) {
    const toggle = deepQueryAll('a, button, [role="button"]', composer)
      .filter(isVisible)
      .find((el) => /^cc$/i.test(labelOf(el)));
    if (toggle) toggle.click();
    return !!toggle;
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function typeInto(input, text) {
    input.focus();
    input.select();
    // execCommand даёт настоящий input-ивент; если не сработал — через сеттер value
    if (!document.execCommand('insertText', false, text)) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }
    const enter = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, composed: true };
    input.dispatchEvent(new KeyboardEvent('keydown', enter));
    input.dispatchEvent(new KeyboardEvent('keyup', enter));
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    input.blur();
  }

  // true — все адреса стали плашками; false — что-то не получилось, отправлять нельзя
  async function addToCc(composer, emails) {
    let input = findCcInput(composer);
    if (!input && openCcRow(composer)) {
      for (let i = 0; i < 10 && !input; i++) { await wait(150); input = findCcInput(composer); }
    }
    if (!input) return false;
    for (const email of emails) {
      typeInto(input, email);
      await wait(400);
      input = findCcInput(composer) || input;
    }
    await wait(300);
    const pills = recipientsOf(composer, { pillsOnly: true });
    return emails.every((email) => pills.has(email));
  }

  // ---------------- Диалог и подсказки ----------------
  function makeButton(text, primary) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    Object.assign(button.style, {
      height: '32px', padding: '0 14px', borderRadius: '4px', cursor: 'pointer',
      font: '600 13px Arial, sans-serif', whiteSpace: 'nowrap',
      border: primary ? '1px solid #0176d3' : '1px solid #c9c9c9',
      background: primary ? '#0176d3' : '#fff',
      color: primary ? '#fff' : '#0176d3',
    });
    return button;
  }

  // resolve('add' | 'send' | 'cancel')
  function askUser(missing) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      Object.assign(overlay.style, {
        position: 'fixed', inset: '0', zIndex: '100000', background: 'rgba(8, 7, 7, .45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      });
      const box = document.createElement('div');
      Object.assign(box.style, {
        width: 'min(460px, calc(100vw - 32px))', boxSizing: 'border-box', padding: '20px 24px',
        borderRadius: '8px', background: '#fff', color: '#181818', font: '14px Arial, sans-serif',
        boxShadow: '0 8px 30px rgba(0, 0, 0, .3)',
      });
      const title = document.createElement('div');
      title.textContent = missing.length > 1 ? 'Additional VQC Emails are not in the recipients'
        : 'Additional VQC Email is not in the recipients';
      Object.assign(title.style, { font: '600 16px Arial, sans-serif', marginBottom: '10px' });
      const list = document.createElement('div');
      list.textContent = missing.join(', ');
      Object.assign(list.style, { color: '#0176d3', fontWeight: '600', marginBottom: '18px', wordBreak: 'break-all' });
      const actions = document.createElement('div');
      Object.assign(actions.style, { display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'flex-end' });

      const add = makeButton('Add to CC & send', true);
      const send = makeButton('Send without it');
      const cancel = makeButton('Cancel');
      actions.append(cancel, send, add);
      box.append(title, list, actions);
      overlay.append(box);

      const close = (answer) => {
        overlay.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve(answer);
      };
      const onKey = (event) => {
        if (event.key === 'Escape') { event.stopPropagation(); close('cancel'); }
      };
      add.addEventListener('click', () => close('add'));
      send.addEventListener('click', () => close('send'));
      cancel.addEventListener('click', () => close('cancel'));
      overlay.addEventListener('click', (event) => { if (event.target === overlay) close('cancel'); });
      document.addEventListener('keydown', onKey, true);
      document.body.append(overlay);
      add.focus();
    });
  }

  function toast(text) {
    const note = document.createElement('div');
    note.textContent = text;
    Object.assign(note.style, {
      position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)', zIndex: '100000',
      maxWidth: 'calc(100vw - 32px)', boxSizing: 'border-box', padding: '10px 16px', borderRadius: '6px',
      background: '#032d60', color: '#fff', font: '13px Arial, sans-serif', boxShadow: '0 4px 14px rgba(0, 0, 0, .25)',
    });
    document.body.append(note);
    setTimeout(() => note.remove(), 8000);
  }

  // ---------------- Перехват Send ----------------
  let running = false;
  let bypass = false;
  let busy = false;

  function resend(button) {
    bypass = true;
    try { button.click(); } finally { bypass = false; }
  }

  async function onClick(event) {
    if (!running || bypass || !caseId()) return;
    const sendButton = event.composedPath()
      .find((el) => el.tagName === 'BUTTON' && el.textContent.trim() === 'Send');
    if (!sendButton) return;
    const composer = composerOf(sendButton);
    if (!composer) return;
    const emails = caseEmails();
    if (!emails) return;   // поля не видно и раньше не встречали: проверить нечем

    const present = recipientsOf(composer);
    const web = new Set(emails.web);
    const missing = emails.additional.filter((email) => !web.has(email) && !present.has(email));
    if (!missing.length) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    if (busy) return;
    busy = true;
    try {
      const answer = await askUser(missing);
      if (answer === 'send') resend(sendButton);
      if (answer === 'add') {
        if (await addToCc(composer, missing)) {
          resend(sendButton);
        } else {
          try { await navigator.clipboard.writeText(missing.join(', ')); } catch (e) { /* без буфера тоже ок */ }
          toast(`Could not add to CC automatically. Copied: ${missing.join(', ')} — paste into CC and press Send.`);
          console.warn('[CC check] CC field not found or the address did not become a pill');
        }
      }
    } finally {
      busy = false;
    }
  }

  window.addEventListener('click', onClick, true);

  let timer = null;

  function start() {
    if (running) return;
    running = true;
    caseEmails();
    timer = setInterval(caseEmails, 2000);   // запоминаем поля, пока открыт Details
  }

  function stop() {
    if (!running) return;
    running = false;
    clearInterval(timer);
  }

  XT.settings.watch(SCRIPT_ID, (enabled) => (enabled ? start() : stop()));
})();
