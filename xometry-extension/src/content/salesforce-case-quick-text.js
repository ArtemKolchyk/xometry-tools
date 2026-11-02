// Salesforce Case record: user-defined buttons (XT.quickTextButtons) that insert a text where the cursor is.
// Each button lives in a slot (a place tied to a page landmark); in arrange mode buttons are dragged between slots.
(function () {
  'use strict';

  const SCRIPT_ID = 'sf-case-quick-text';
  const CASE_PATH_RE = /^\/lightning\/r\/Case\/[^/]+\/view\/?$/;
  const TAB_LABEL = 'Collapse!';
  const ERP_BUTTON_ID = 'xt-open-case-job-in-erp';
  const store = XT.quickTextButtons;
  const { deepQueryAll, deepText, parentAcrossShadow, isVisible } = XT.dom;

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

  // ---------------- Места (слоты) ----------------
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

  function placeAfter(box, ref) {
    if (ref.nextSibling !== box) ref.parentNode.insertBefore(box, ref.nextSibling);
    return true;
  }

  function placeBefore(box, ref) {
    if (box.nextSibling !== ref) ref.parentNode.insertBefore(box, ref);
    return true;
  }

  // Ставят контейнер слота на страницу; false — ориентира на странице нет
  const MOUNTS = {
    // Под ячейкой Launch VQC, правее кнопки Open in ERP
    actions(box) {
      const cell = XT.dom.launchVqcCell();
      if (!cell) return false;
      const erp = cell.querySelector(`#${ERP_BUTTON_ID}`);
      box.style.left = erp ? `${erp.offsetWidth + 8}px` : '0';
      if (box.parentNode !== cell) cell.appendChild(box);
      return true;
    },
    // Под заголовком с номером кейса
    header(box) {
      const title = deepQueryAll('h1').filter(isVisible).find((h) => /\b\d{6,}\b/.test(deepText(h)));
      return title ? placeAfter(box, title) : false;
    },
    tabs(box) {
      const tabList = findTabList();
      return tabList ? placeAfter(box, tabList) : false;
    },
    email(box) {
      const editor = deepQueryAll('.tox-tinymce').find(isVisible);
      return editor ? placeBefore(box, editor) : false;
    },
  };

  const SLOT_STYLE = {
    actions: { position: 'absolute', top: '100%', marginTop: '8px', flexWrap: 'nowrap', zIndex: '10' },
    header: { margin: '6px 0 0' },
    tabs: { margin: '12px 0 4px' },
    email: { margin: '0 0 8px' },
  };

  function createBox(slot) {
    const box = document.createElement('div');
    box.dataset.xtQtSlot = slot.id;
    Object.assign(box.style, {
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', boxSizing: 'border-box',
    }, SLOT_STYLE[slot.id]);
    // Подпись пустого места в режиме расстановки; всегда последний ребёнок
    box.hint = document.createElement('span');
    box.hint.textContent = slot.name;
    Object.assign(box.hint.style, {
      display: 'none', padding: '0 10px', color: '#0176d3', font: 'italic 12px Arial, sans-serif', whiteSpace: 'nowrap',
    });
    box.append(box.hint);
    return box;
  }

  const boxes = {};
  store.SLOTS.forEach((slot) => { boxes[slot.id] = createBox(slot); });
  const buttonsIn = (box) => [...box.children].filter((child) => child.spec);

  // ---------------- Кнопки ----------------
  let buttons = [];
  let target = null;
  let arranging = false;

  function flash(button, text) {
    const label = button.textContent;
    button.textContent = text;
    setTimeout(() => { button.textContent = label; }, 1500);
  }

  function createButton(spec) {
    const button = document.createElement('button');
    button.type = 'button';
    button.spec = spec;
    button.textContent = spec.label;
    Object.assign(button.style, {
      boxSizing: 'border-box',
      height: '32px',
      padding: '0 14px',
      border: '1px solid rgba(0, 0, 0, .15)',
      borderRadius: '16px',
      background: spec.bg,
      color: spec.color,
      font: '600 13px Arial, sans-serif',
      whiteSpace: 'nowrap',
      cursor: 'pointer',
    });
    button.addEventListener('pointerdown', (event) => {
      if (!arranging || event.button !== 0) return;
      event.preventDefault();
      startDrag(button);
    });
    // На mousedown фокус ещё в поле: запоминаем его и не даём кнопке забрать фокус
    button.addEventListener('mousedown', (event) => {
      if (arranging) return;
      target = activeEditable();
      event.preventDefault();
    });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (arranging) return;
      const field = target && target.isConnected ? target : activeEditable();
      target = null;
      if (!field) { flash(button, 'Click in a text field first'); return; }
      if (spec.text) insertText(field, spec.text);
    });
    return button;
  }

  // Кнопки без надписи пропускаем: это строка, которую ещё заполняют в popup
  function renderButtons(list) {
    buttons = list;
    Object.values(boxes).forEach((box) => buttonsIn(box).forEach((b) => b.remove()));
    list.filter((b) => b.label.trim()).forEach((spec) => {
      const box = boxes[spec.slot];
      box.insertBefore(createButton(spec), box.hint);
    });
    refreshBoxes();
  }

  // ---------------- Режим расстановки ----------------
  const ARRANGE_STYLE = {
    outline: '2px dashed #0176d3', outlineOffset: '3px', borderRadius: '18px',
    minHeight: '32px', minWidth: '160px', background: 'rgba(1, 118, 211, .06)',
  };

  function refreshBoxes() {
    Object.values(boxes).forEach((box) => {
      const own = buttonsIn(box);
      box.hint.style.display = arranging && !own.length ? '' : 'none';
      Object.keys(ARRANGE_STYLE).forEach((key) => { box.style[key] = arranging ? ARRANGE_STYLE[key] : ''; });
      own.forEach((b) => {
        b.style.cursor = arranging ? 'grab' : 'pointer';
        b.style.touchAction = arranging ? 'none' : '';
      });
    });
  }

  function createBar() {
    const bar = document.createElement('div');
    Object.assign(bar.style, {
      position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)', zIndex: '100000',
      display: 'flex', alignItems: 'center', gap: '12px', padding: '6px 6px 6px 16px',
      borderRadius: '20px', background: '#032d60', color: '#fff', font: '13px Arial, sans-serif',
      boxShadow: '0 4px 14px rgba(0, 0, 0, .25)',
    });
    const done = document.createElement('button');
    done.type = 'button';
    done.textContent = 'Done';
    Object.assign(done.style, {
      height: '28px', padding: '0 14px', border: '0', borderRadius: '14px',
      background: '#fff', color: '#032d60', font: '600 13px Arial, sans-serif', cursor: 'pointer',
    });
    done.addEventListener('click', () => setArranging(false));
    bar.append('Drag the quick text buttons to a highlighted place', done);
    return bar;
  }

  const bar = createBar();

  function setArranging(on) {
    arranging = on && running;
    if (arranging) document.body.append(bar);
    else bar.remove();
    refreshBoxes();
    syncSlots();
  }

  // ---------------- Перетаскивание ----------------
  let dragged = null;

  function boxAt(x, y) {
    return Object.values(boxes).find((box) => {
      if (!box.isConnected) return false;
      const r = box.getBoundingClientRect();
      return x >= r.left - 16 && x <= r.right + 16 && y >= r.top - 16 && y <= r.bottom + 16;
    });
  }

  function isBefore(event, element) {
    const r = element.getBoundingClientRect();
    return event.clientY < r.top || (event.clientY <= r.bottom && event.clientX < r.left + r.width / 2);
  }

  function startDrag(button) {
    dragged = button;
    button.style.opacity = '.6';
    document.addEventListener('pointermove', onDragMove, true);
    document.addEventListener('pointerup', endDrag, true);
  }

  function onDragMove(event) {
    const box = boxAt(event.clientX, event.clientY);
    if (!box) return;
    const before = buttonsIn(box).find((b) => b !== dragged && isBefore(event, b)) || box.hint;
    if (dragged.parentNode !== box || dragged.nextSibling !== before) {
      box.insertBefore(dragged, before);
      refreshBoxes();
    }
  }

  // Новый порядок — как кнопки стоят в слотах; кнопки без надписи (их нет на странице) остаются в конце
  function endDrag() {
    document.removeEventListener('pointermove', onDragMove, true);
    document.removeEventListener('pointerup', endDrag, true);
    dragged.style.opacity = '';
    dragged = null;
    const placed = store.SLOTS.flatMap(({ id }) => buttonsIn(boxes[id]).map((b) => ({ ...b.spec, slot: id })));
    const placedIds = new Set(placed.map((b) => b.id));
    store.set([...placed, ...buttons.filter((b) => !placedIds.has(b.id))])
      .catch((error) => console.warn('[Case quick text]', error.message));
  }

  // ---------------- Жизненный цикл ----------------
  let running = false;
  let timer = null;

  function syncSlots() {
    const onCase = running && CASE_PATH_RE.test(location.pathname);
    store.SLOTS.forEach(({ id }) => {
      const box = boxes[id];
      const wanted = onCase && (arranging || buttonsIn(box).length > 0);
      if (!wanted || !MOUNTS[id](box)) box.remove();
    });
  }

  function start() {
    if (running) return;
    running = true;
    syncSlots();
    timer = setInterval(syncSlots, 1200);
  }

  function stop() {
    if (!running) return;
    running = false;
    clearInterval(timer);
    setArranging(false);
  }

  document.addEventListener('keydown', (event) => {
    if (arranging && event.key === 'Escape') setArranging(false);
  });

  store.watch((list) => { renderButtons(list); syncSlots(); });
  XT.onAction(SCRIPT_ID, (action) => { if (action === 'arrange') setArranging(true); });
  XT.settings.watch(SCRIPT_ID, (enabled) => (enabled ? start() : stop()));
})();
