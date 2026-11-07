// Редактор Partner rating в popup — компактный: кнопки-фильтры по цвету, поиск и короткий список
// (без поиска — последние отмеченные). Одна строка на партнёра; клик раскрывает её для правки.
// Полный список, добавление по имени и импорт — на отдельной странице (partner-rating.html, «Manage all»).
'use strict';

function renderPartnerRatingEditor() {
  const store = XT.partnerRating;
  const RECENT = 8;    // без поиска и фильтра
  const MAX_ROWS = 30; // с поиском или фильтром

  const state = { filter: 'all', open: null };   // open — ключ раскрытой строки
  const saver = prUi.saver((e) => showMessage(e.message, true));

  const chips = prUi.filterChips(state, () => render());
  const search = el('input', { type: 'search', className: 'hl-text pr-search', placeholder: 'Search name or note' });
  const caption = el('div', { className: 'muted pr-caption' });
  const list = el('div', { className: 'pr-list' });
  const manage = el('button', { type: 'button', className: 'btn', textContent: 'Manage all →' });
  const exportBtn = el('button', { type: 'button', className: 'btn', textContent: 'Export…' });

  const box = el('div', { className: 'hl-editor pr-editor' }, [
    chips, search, caption, list,
    el('div', { className: 'script-actions' }, [manage, exportBtn]),
  ]);

  let map = {};

  function renderDetails(key, entry) {
    const name = el('input', { type: 'text', value: entry.name, placeholder: '(no name)', className: 'hl-text pr-name' });
    const note = el('input', { type: 'text', value: entry.note, placeholder: 'Note: why', className: 'hl-text' });
    const del = el('button', { type: 'button', className: 'btn pr-remove', textContent: 'Remove' });
    const kind = el('span', {
      className: 'pr-kind',
      textContent: prUi.isById(key) ? `Matched by contact link · ${prUi.formatDate(entry.updated)}`
        : `Matched by exact text · ${prUi.formatDate(entry.updated)}`,
    });

    name.addEventListener('input', () => {
      entry.name = store.cleanName(name.value);
      saver.patch(key, { name: entry.name }, 400);
    });
    note.addEventListener('input', () => { entry.note = note.value; saver.patch(key, { note: note.value }, 400); });
    del.addEventListener('click', () => {
      delete map[key];
      state.open = null;
      saver.patch(key, null);
      render();
    });

    const details = el('div', { className: 'pr-details' }, [
      el('div', { className: 'hl-head' }, [
        prUi.dots(entry.rating, (id) => {
          entry.rating = id;
          entry.updated = Date.now();
          saver.patch(key, { rating: id, updated: entry.updated });
          render();
        }),
        name,
      ]),
      note,
      el('div', { className: 'pr-details-foot' }, [kind, del]),
    ]);
    details.addEventListener('click', (e) => e.stopPropagation());
    return details;
  }

  function renderRow(key, entry) {
    const row = el('div', { className: `pr-row${state.open === key ? ' open' : ''}` }, [
      el('div', { className: 'pr-line' }, [
        el('span', { className: `pr-mark pr-${entry.rating}` }),
        el('span', { className: 'pr-line-name', textContent: entry.name || '(no name)' }),
        el('span', { className: 'pr-line-note', textContent: entry.note }),
      ]),
    ]);
    row.title = entry.note ? `${entry.name}\n${entry.note}` : entry.name;
    row.addEventListener('click', () => { state.open = state.open === key ? null : key; render(); });
    if (state.open === key) row.append(renderDetails(key, entry));
    return row;
  }

  function render() {
    chips.update(map);
    const q = search.value.trim().toLowerCase();
    const filtered = q || state.filter !== 'all';
    const all = Object.entries(map)
      .filter(([, e]) => prUi.matches(e, q, state.filter))
      .sort(prUi.byRecent);
    const shown = all.slice(0, filtered ? MAX_ROWS : RECENT);

    const total = Object.keys(map).length;
    manage.textContent = `Manage all (${total}) →`;
    caption.textContent = !total ? ''
      : !filtered ? 'Recently rated'
      : all.length > shown.length ? `${shown.length} of ${all.length} found — see all in Manage all`
      : `${all.length} found`;

    list.replaceChildren(...shown.map(([k, e]) => renderRow(k, e)));
    if (!shown.length) {
      list.append(el('p', {
        className: 'muted',
        textContent: total ? 'Nothing found.' : 'No ratings yet. Right-click a contact name in Salesforce → Partner rating.',
      }));
    }
  }

  search.addEventListener('input', () => { state.open = null; render(); });
  manage.addEventListener('click', () => { saver.flush(); prUi.openPage(); });
  exportBtn.addEventListener('click', async () => {
    await saver.flush();
    showMessage(`Exported ${prUi.exportFile(await store.get())} ratings`);
  });

  // Изменения из контекстного меню или со страницы Manage all; не перерисовываем посреди набора текста
  store.watch((loaded) => {
    map = loaded;
    const editing = document.activeElement && document.activeElement.closest && document.activeElement.closest('.pr-details input');
    if (!saver.busy && !editing) render();
  });
  return box;
}
