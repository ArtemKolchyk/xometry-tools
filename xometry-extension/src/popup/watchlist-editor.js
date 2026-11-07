// Страницы Partners и Customers в popup: записи «цвет · имя или компания · заметка».
// Изменения сохраняются сразу (текст — с задержкой), вкладки подхватывают их через storage.onChanged.
'use strict';

function renderWatchlistPage(kind) {
  const store = XT.watchlist;
  const info = store.KINDS[kind];
  const colorIds = Object.keys(store.COLORS);
  const list = el('div', { className: 'hl-list' });
  const addBtn = el('button', { type: 'button', className: 'btn', textContent: `+ Add ${info.one.toLowerCase()}` });

  let entries = [];
  let saveTimer = 0;

  // У chrome.storage.sync лимит записей в минуту: частые изменения склеиваются в одну запись
  function save(delay = 300) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, delay);
  }
  function flush() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = 0;
    store.set(kind, entries).catch((e) => showMessage(
      /QUOTA/i.test(e.message) ? `${info.label}: list is too long for synced storage, shorten notes` : e.message, true));
  }

  function renderRow(entry) {
    // Клик по кружку — следующий цвет
    const dot = el('button', { type: 'button', className: 'wl-dot' });
    const paintDot = () => {
      dot.style.background = store.colorValue(entry.color);
      dot.title = `Color: ${store.COLORS[entry.color].label} (click to change)`;
    };
    paintDot();
    const text = el('input', {
      type: 'text', value: entry.text, className: 'hl-text hl-name',
      placeholder: kind === 'partners' ? 'Partner company' : 'Company, contact name or email',
    });
    const note = el('input', { type: 'text', value: entry.note, className: 'hl-text wl-note', placeholder: 'Note: what to do differently' });
    const del = el('button', { type: 'button', className: 'hl-del', textContent: '✕', title: 'Delete' });

    dot.addEventListener('click', () => {
      entry.color = colorIds[(colorIds.indexOf(entry.color) + 1) % colorIds.length];
      paintDot();
      save();
    });
    text.addEventListener('input', () => { entry.text = text.value; save(400); });
    note.addEventListener('input', () => { entry.note = note.value; save(400); });
    del.addEventListener('click', () => { entries = entries.filter((e) => e !== entry); save(0); render(); });

    return el('div', { className: 'hl-row' }, [el('div', { className: 'hl-head' }, [dot, text, del]), note]);
  }

  function render() {
    list.replaceChildren(...entries.map(renderRow));
    if (!entries.length) list.append(el('p', { className: 'muted', textContent: `No ${info.label.toLowerCase()} yet.` }));
  }

  addBtn.addEventListener('click', () => {
    entries.push({ text: '', note: '', color: 'red' });
    save();
    render();
    list.querySelector('.hl-row:last-child .hl-name').focus();
  });
  window.addEventListener('pagehide', flush);   // popup закрыли раньше, чем сработал таймер

  store.get(kind).then((loaded) => { entries = loaded; render(); });

  return [el('div', { className: 'script' }, [
    el('p', { textContent: `ERP sidebar cards get a ▲! sign in the entry's color; `
      + `the note shows on hover and in More. ${info.hint}, ignoring case and punctuation: `
      + '"Acme" also matches "ACME, Inc.".' }),
    el('div', { className: 'hl-editor wl-editor' }, [list, addBtn]),
  ])];
}
