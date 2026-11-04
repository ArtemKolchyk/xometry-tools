// Редактор скрипта «Partner rating»: поиск, список (цвет, имя, заметка, удаление), добавление по имени,
// экспорт/импорт в JSON. Рейтинг лежит в chrome.storage.local — экспорт служит бэкапом:
// при удалении расширения local-хранилище стирается.
'use strict';

function renderPartnerRatingEditor() {
  const store = XT.partnerRating;
  const FILE_TYPE = 'xometry-tools-partner-rating';

  const search = el('input', { type: 'search', className: 'hl-text pr-search', placeholder: 'Search name or note' });
  const summary = el('div', { className: 'muted pr-summary' });
  const list = el('div', { className: 'pr-list' });

  const newName = el('input', { type: 'text', className: 'hl-text', placeholder: 'Add by name (plain-text match)' });
  const addBtn = el('button', { type: 'button', className: 'btn', textContent: '+ Add' });
  const exportBtn = el('button', { type: 'button', className: 'btn', textContent: 'Export…' });
  // Системный диалог выбора файла закрывает popup, поэтому импорт — только во вкладке (options page)
  const inTab = document.body.classList.contains('in-tab');
  const importBtn = el('button', { type: 'button', className: 'btn', textContent: inTab ? 'Import…' : 'Import… (opens in a tab)' });
  const fileInput = el('input', { type: 'file', accept: '.json,application/json', hidden: true });

  const box = el('div', { className: 'hl-editor pr-editor' }, [
    search, summary, list,
    el('div', { className: 'pr-add' }, [newName, addBtn]),
    el('div', { className: 'script-actions' }, [exportBtn, importBtn, fileInput]),
  ]);

  let map = {};
  let saveTimer = 0;

  function save(delay = 0) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, delay);
  }

  function flush() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = 0;
    store.set(map).catch((e) => showMessage(e.message, true));
  }

  function renderDots(entry, row) {
    const dots = el('div', { className: 'pr-dots' }, Object.entries(store.RATINGS).map(([id, r]) => {
      const b = el('button', { type: 'button', className: `pr-dot pr-${id}`, title: r.label });
      b.setAttribute('aria-pressed', String(entry.rating === id));
      b.addEventListener('click', () => {
        entry.rating = id;
        entry.updated = Date.now();
        dots.querySelectorAll('.pr-dot').forEach((d) => d.setAttribute('aria-pressed', String(d === b)));
        row.dataset.rating = id;
        save();
        renderSummary();
      });
      return b;
    }));
    return dots;
  }

  function renderRow(key, entry) {
    const row = el('div', { className: 'pr-row' });
    row.dataset.rating = entry.rating;
    const name = el('input', {
      type: 'text', value: entry.name, placeholder: '(no name)', className: 'hl-text pr-name',
      title: key.startsWith('id:') ? `Salesforce record ${key.slice(3)}` : 'Matched by name only',
    });
    const kind = el('span', {
      className: 'pr-kind', textContent: key.startsWith('id:') ? 'ID' : 'name',
      title: key.startsWith('id:') ? 'Matched by the contact link (exact)' : 'Matched by exact plain text',
    });
    const del = el('button', { type: 'button', className: 'hl-del', textContent: '✕', title: 'Remove rating' });
    const note = el('input', { type: 'text', value: entry.note, placeholder: 'Note: why', className: 'hl-text pr-note' });

    name.addEventListener('input', () => { entry.name = store.cleanName(name.value); save(400); });
    note.addEventListener('input', () => { entry.note = note.value; save(400); });
    del.addEventListener('click', () => { delete map[key]; save(); render(); });

    row.append(el('div', { className: 'hl-head' }, [renderDots(entry, row), name, kind, del]), note);
    return row;
  }

  function renderSummary() {
    const entries = Object.values(map);
    summary.textContent = entries.length
      ? Object.entries(store.RATINGS)
        .map(([id, r]) => `${r.emoji} ${entries.filter((e) => e.rating === id).length}`).join('   ')
      : '';
  }

  function render() {
    const q = search.value.trim().toLowerCase();
    const rows = Object.entries(map)
      .filter(([, e]) => !q || e.name.toLowerCase().includes(q) || e.note.toLowerCase().includes(q))
      .sort(([, a], [, b]) => a.name.localeCompare(b.name));
    list.replaceChildren(...rows.map(([k, e]) => renderRow(k, e)));
    if (!rows.length) {
      list.append(el('p', {
        className: 'muted',
        textContent: Object.keys(map).length ? 'Nothing found.' : 'No ratings yet. Right-click a contact name in Salesforce → Partner rating.',
      }));
    }
    renderSummary();
  }

  function add() {
    const name = store.cleanName(newName.value);
    if (!name) { newName.focus(); return; }
    const key = store.nameKey(name);
    if (!map[key]) map[key] = { name, rating: 'yellow', note: '', updated: Date.now() };
    newName.value = '';
    search.value = '';
    save();
    render();
  }

  async function exportRatings() {
    flush();
    const file = {
      type: FILE_TYPE,
      version: chrome.runtime.getManifest().version,
      exportedAt: new Date().toISOString(),
      ratings: map,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
    const a = el('a', { href: url, download: `partner-rating-${file.exportedAt.slice(0, 10)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showMessage(`Exported ${Object.keys(map).length} ratings`);
  }

  // Импорт добавляет к текущему рейтингу; при совпадении остаётся более свежая запись
  async function importRatings(file) {
    const data = JSON.parse(await file.text());
    if (!data || data.type !== FILE_TYPE) throw new Error('Not a partner rating file');
    const incoming = store.normalize(data.ratings);
    let n = 0;
    Object.entries(incoming).forEach(([k, e]) => {
      if (!map[k] || e.updated >= map[k].updated) { map[k] = e; n++; }
    });
    save();
    render();
    showMessage(`Imported ${n} of ${Object.keys(incoming).length} ratings`);
  }

  search.addEventListener('input', render);
  addBtn.addEventListener('click', add);
  newName.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  exportBtn.addEventListener('click', () => exportRatings().catch((e) => showMessage(e.message, true)));
  importBtn.addEventListener('click', () => (inTab ? fileInput.click() : chrome.runtime.openOptionsPage()));
  fileInput.addEventListener('change', () => {
    const [file] = fileInput.files;
    fileInput.value = '';
    if (file) importRatings(file).catch((e) => showMessage(e.message, true));
  });
  window.addEventListener('pagehide', flush);

  // Отметки из контекстного меню, пока открыта вкладка настроек; не перерисовываем посреди набора текста
  store.watch((loaded) => {
    if (saveTimer || box.contains(document.activeElement) && document.activeElement !== search) return;
    map = loaded;
    render();
  });
  return box;
}
