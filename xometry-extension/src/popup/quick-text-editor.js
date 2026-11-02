// Редактор кнопок скрипта «Case quick text»: надпись, цвета, место на странице, текст вставки,
// перетаскивание, удаление, «+ Add button».
// Изменения сохраняются сразу (текст — с задержкой), вкладки подхватывают их через storage.onChanged.
// Нативный выбор цвета есть только во вкладке (options page): в popup системный диалог закрывает popup.
'use strict';

function renderQuickTextEditor() {
  const store = XT.quickTextButtons;
  const inTab = document.body.classList.contains('in-tab');
  const list = el('div', { className: 'qt-list' });
  const addBtn = el('button', { type: 'button', className: 'btn', textContent: '+ Add button' });
  const box = el('div', { className: 'hl-editor' }, [list, addBtn]);

  let buttons = [];
  let saveTimer = 0;
  let openPalette = null;
  let dragged = null;

  // У chrome.storage.sync лимит 120 записей в минуту, поэтому частые изменения склеиваются в одну запись
  function save(delay = 300) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, delay);
  }

  function flush() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = 0;
    store.set(buttons)
      .then(() => showMessage('Quick text buttons saved'))
      .catch((e) => showMessage(e.message, true));
  }

  function paint(chip, button) {
    chip.textContent = button.label || 'Aa';
    chip.style.background = button.bg;
    chip.style.color = button.color;
  }

  function closePalette() {
    if (openPalette) { openPalette.remove(); openPalette = null; }
  }

  function renderPalette(button, chip) {
    const pick = (bg, color, delay) => { button.bg = bg; button.color = color; paint(chip, button); save(delay); };

    const grid = el('div', { className: 'hl-presets' }, store.PRESETS.map((p) => {
      const b = el('button', { type: 'button', className: 'hl-chip', textContent: 'Aa', title: `${p.bg} / ${p.color}` });
      b.style.background = p.bg;
      b.style.color = p.color;
      b.addEventListener('click', () => { pick(p.bg, p.color); closePalette(); });
      return b;
    }));
    const palette = el('div', { className: 'hl-palette' }, [grid]);

    if (inTab) {
      const bg = el('input', { type: 'color', value: button.bg, title: 'Fill' });
      const fg = el('input', { type: 'color', value: button.color, title: 'Text' });
      // 'input' летит непрерывно, пока тянут ползунок: превью сразу, запись — после паузы или по закрытию picker
      bg.addEventListener('input', () => pick(bg.value, button.color, 1000));
      fg.addEventListener('input', () => pick(button.bg, fg.value, 1000));
      bg.addEventListener('change', () => pick(bg.value, button.color, 0));
      fg.addEventListener('change', () => pick(button.bg, fg.value, 0));
      palette.append(el('div', { className: 'hl-custom' }, [
        el('label', {}, [bg, ' Fill']), el('label', {}, [fg, ' Text']),
      ]));
    } else {
      const more = el('a', { textContent: 'More colors…', className: 'hl-more' });
      more.addEventListener('click', () => chrome.runtime.openOptionsPage());
      palette.append(more);
    }
    palette.addEventListener('click', (e) => e.stopPropagation());
    return palette;
  }

  function renderRow(button) {
    const handle = el('span', { className: 'qt-handle', textContent: '⠿', title: 'Drag to reorder' });
    const label = el('input', { type: 'text', value: button.label, placeholder: 'Button label', className: 'hl-text' });
    const chip = el('button', { type: 'button', className: 'qt-chip', title: 'Colors' });
    const del = el('button', { type: 'button', className: 'hl-del', textContent: '✕', title: 'Delete button' });
    const text = el('textarea', { className: 'qt-text', rows: 2, placeholder: 'Text to insert', value: button.text });
    const place = el('select', { className: 'ar-select', title: 'Where the button is on the Case page' },
      store.SLOTS.map((s) => el('option', { value: s.id, textContent: s.name })));
    place.value = button.slot;
    const head = el('div', { className: 'qt-head' }, [handle, label, chip, del]);
    const row = el('div', { className: 'qt-row' }, [head, el('label', { className: 'qt-place' }, ['Place ', place]), text]);
    row.button = button;
    paint(chip, button);

    label.addEventListener('input', () => { button.label = label.value; paint(chip, button); save(400); });
    text.addEventListener('input', () => { button.text = text.value; save(600); });
    place.addEventListener('change', () => { button.slot = place.value; save(0); });
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = openPalette && openPalette.parentNode === head;
      closePalette();
      if (!wasOpen) { openPalette = renderPalette(button, chip); head.append(openPalette); }
    });
    del.addEventListener('click', () => { buttons = buttons.filter((b) => b !== button); save(); render(); });

    // Тянуть можно только за ручку, чтобы в полях работало выделение текста мышью
    handle.addEventListener('mousedown', () => { row.draggable = true; });
    handle.addEventListener('mouseup', () => { row.draggable = false; });
    row.addEventListener('dragstart', (e) => {
      closePalette();
      dragged = row;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragover', (e) => {
      if (!dragged || dragged === row) return;
      e.preventDefault();
      const rect = row.getBoundingClientRect();
      list.insertBefore(dragged, e.clientY > rect.top + rect.height / 2 ? row.nextSibling : row);
    });
    row.addEventListener('dragend', () => {
      row.draggable = false;
      row.classList.remove('dragging');
      dragged = null;
      buttons = [...list.children].map((r) => r.button).filter(Boolean);
      save(0);
    });
    return row;
  }

  function render() {
    closePalette();
    list.replaceChildren(...buttons.map(renderRow));
    if (!buttons.length) list.append(el('p', { className: 'muted', textContent: 'No buttons yet.' }));
  }

  addBtn.addEventListener('click', () => {
    const preset = store.PRESETS[buttons.length % store.PRESETS.length];
    buttons.push({ id: store.newId(), label: '', text: '', bg: preset.bg, color: preset.color, slot: store.DEFAULT_SLOT });
    save();
    render();
    list.querySelector('.qt-row:last-child .hl-text').focus();
  });
  document.addEventListener('click', closePalette);
  window.addEventListener('pagehide', flush);   // popup закрыли раньше, чем сработал таймер

  store.get().then((loaded) => { buttons = loaded; render(); });
  return box;
}
