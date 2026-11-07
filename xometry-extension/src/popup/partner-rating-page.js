// Страница «Partner rating» (partner-rating.html): весь список таблицей — сортировка по клику на заголовок,
// фильтр по цвету, поиск, правка цвета/имени/заметки прямо в строке, добавление по имени, экспорт и импорт.
// Открывается из popup кнопкой «Manage all».
'use strict';

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const store = XT.partnerRating;
const RATING_ORDER = { red: 0, yellow: 1, green: 2 };

const els = {
  chips: document.getElementById('chips'),
  search: document.getElementById('search'),
  rows: document.getElementById('rows'),
  empty: document.getElementById('empty'),
  newName: document.getElementById('new-name'),
  add: document.getElementById('add'),
  export: document.getElementById('export'),
  import: document.getElementById('import'),
  file: document.getElementById('file'),
  message: document.getElementById('message'),
  heads: [...document.querySelectorAll('th[data-sort]')],
};

const state = { filter: 'all', sort: 'updated', desc: true };
let map = {};

function showMessage(text, isError = false) {
  els.message.textContent = text;
  els.message.style.color = isError ? 'var(--bad)' : '';
}

const saver = prUi.saver((e) => showMessage(e.message, true));
const chips = prUi.filterChips(state, () => render());
els.chips.replaceWith(chips);

const SORTERS = {
  rating: ([, a], [, b]) => RATING_ORDER[a.rating] - RATING_ORDER[b.rating],
  name: ([, a], [, b]) => a.name.localeCompare(b.name),
  note: ([, a], [, b]) => a.note.localeCompare(b.note),
  kind: ([ka], [kb]) => Number(prUi.isById(kb)) - Number(prUi.isById(ka)),
  updated: ([, a], [, b]) => a.updated - b.updated,
};

function renderRow(key, entry) {
  const name = el('input', { type: 'text', value: entry.name, placeholder: '(no name)', className: 'hl-text pr-name' });
  const note = el('input', { type: 'text', value: entry.note, placeholder: 'Note: why', className: 'hl-text' });
  const date = el('td', { className: 'pr-col-date muted', textContent: prUi.formatDate(entry.updated) });
  const del = el('button', { type: 'button', className: 'hl-del', textContent: '✕', title: 'Remove rating' });
  const tr = el('tr');
  tr.dataset.rating = entry.rating;

  name.addEventListener('input', () => {
    entry.name = store.cleanName(name.value);
    saver.patch(key, { name: entry.name }, 400);
  });
  note.addEventListener('input', () => { entry.note = note.value; saver.patch(key, { note: note.value }, 400); });
  del.addEventListener('click', () => {
    if (!confirm(`Remove the rating of ${entry.name || 'this partner'}?`)) return;
    delete map[key];
    saver.patch(key, null);
    render();
  });

  tr.append(
    el('td', { className: 'pr-col-rating' }, [prUi.dots(entry.rating, (id) => {
      entry.rating = id;
      entry.updated = Date.now();
      tr.dataset.rating = id;
      date.textContent = prUi.formatDate(entry.updated);
      saver.patch(key, { rating: id, updated: entry.updated });
      chips.update(map);
    })]),
    el('td', {}, [name]),
    el('td', {}, [note]),
    el('td', {
      className: 'pr-col-kind muted',
      textContent: prUi.isById(key) ? 'Link' : 'Text',
      title: prUi.isById(key) ? `Salesforce record ${key.slice(3)}: the contact link, exact` : 'Plain text equal to the name',
    }),
    date,
    el('td', { className: 'pr-col-del' }, [del]),
  );
  return tr;
}

function render() {
  chips.update(map);
  els.heads.forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === state.sort);
    th.dataset.dir = th.dataset.sort === state.sort ? (state.desc ? '↓' : '↑') : '';
  });

  const q = els.search.value.trim().toLowerCase();
  const sorter = SORTERS[state.sort];
  const rows = Object.entries(map)
    .filter(([, e]) => prUi.matches(e, q, state.filter))
    .sort((a, b) => (state.desc ? -1 : 1) * sorter(a, b) || prUi.byRecent(a, b));

  els.rows.replaceChildren(...rows.map(([k, e]) => renderRow(k, e)));
  const total = Object.keys(map).length;
  els.empty.hidden = rows.length > 0;
  els.empty.textContent = total ? 'Nothing found.' : 'No ratings yet. Right-click a contact name in Salesforce → Partner rating.';
  document.title = `Partner rating (${total}) · Xometry Tools`;
}

els.heads.forEach((th) => th.addEventListener('click', () => {
  const key = th.dataset.sort;
  if (state.sort === key) state.desc = !state.desc;
  else { state.sort = key; state.desc = key === 'updated'; }   // дата — новые сверху, остальное — по возрастанию
  render();
}));

els.search.addEventListener('input', render);

function add() {
  const name = store.cleanName(els.newName.value);
  if (!name) { els.newName.focus(); return; }
  const key = store.nameKey(name);
  if (!map[key]) {
    map[key] = { name, rating: 'yellow', note: '', updated: Date.now() };
    saver.patch(key, map[key]);
  }
  els.newName.value = '';
  els.search.value = '';
  state.filter = 'all';
  render();
  showMessage(`${name} added as 🟡 — change the color in the list`);
}

els.add.addEventListener('click', add);
els.newName.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

els.export.addEventListener('click', async () => {
  await saver.flush();
  showMessage(`Exported ${prUi.exportFile(await store.get())} ratings`);
});

// Импорт добавляет к текущему рейтингу; при совпадении остаётся более свежая запись
els.import.addEventListener('click', () => els.file.click());
els.file.addEventListener('change', async () => {
  const [file] = els.file.files;
  els.file.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || data.type !== PR_FILE_TYPE) throw new Error('not a partner rating file');
    const incoming = store.normalize(data.ratings);
    await saver.flush();
    let n = 0;
    await store.apply((current) => {
      Object.entries(incoming).forEach(([k, e]) => {
        if (!current[k] || e.updated >= current[k].updated) { current[k] = e; n++; }
      });
    });
    showMessage(`Imported ${n} of ${Object.keys(incoming).length} ratings`);
  } catch (e) {
    showMessage(`Import: ${e.message}`, true);
  }
});

// Изменения из контекстного меню или из popup; не перерисовываем посреди набора текста в таблице
store.watch((loaded) => {
  map = loaded;
  const editing = document.activeElement && document.activeElement.closest && document.activeElement.closest('.pr-table input');
  if (!saver.busy && !editing) render();
});
