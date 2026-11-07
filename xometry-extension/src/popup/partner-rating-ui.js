// Общие части интерфейса Partner rating для popup (partner-rating-editor.js) и страницы со всем списком
// (partner-rating-page.js): фильтр, кнопки-фильтры по цвету, точки выбора цвета, отложенное сохранение, экспорт.
// Нужна глобальная el(tag, props, children) — она есть и в popup.js, и в partner-rating-page.js.
'use strict';

const PR_FILE_TYPE = 'xometry-tools-partner-rating';
const PR_PAGE_URL = 'src/popup/partner-rating.html';

const prUi = {
  // Подходит ли запись под поиск и фильтр по цвету ('all' | 'red' | 'yellow' | 'green')
  matches(entry, q, filter) {
    if (filter !== 'all' && entry.rating !== filter) return false;
    return !q || entry.name.toLowerCase().includes(q) || entry.note.toLowerCase().includes(q);
  },

  byRecent: ([, a], [, b]) => b.updated - a.updated,

  formatDate(t) {
    return t ? new Date(t).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  },

  isById: (key) => key.startsWith('id:'),

  openPage() {
    chrome.tabs.create({ url: chrome.runtime.getURL(PR_PAGE_URL) });
  },

  // Кнопки «All 112 · 🔴 12 · 🟡 30 · 🟢 70»; state.filter меняется по клику, потом onChange()
  filterChips(state, onChange) {
    const box = el('div', { className: 'pr-chips' });
    box.update = (map) => {
      const entries = Object.values(map);
      const chip = (id, label) => {
        const b = el('button', { type: 'button', className: `pr-chip pr-chip-${id}`, textContent: label });
        b.setAttribute('aria-pressed', String(state.filter === id));
        b.addEventListener('click', () => { state.filter = state.filter === id && id !== 'all' ? 'all' : id; onChange(); });
        return b;
      };
      box.replaceChildren(
        chip('all', `All ${entries.length}`),
        ...Object.entries(XT.partnerRating.RATINGS).map(([id, r]) =>
          chip(id, `${r.emoji} ${entries.filter((e) => e.rating === id).length}`)),
      );
    };
    return box;
  },

  // Три точки выбора цвета; onPick(id)
  dots(current, onPick) {
    const box = el('div', { className: 'pr-dots' });
    Object.entries(XT.partnerRating.RATINGS).forEach(([id, r]) => {
      const b = el('button', { type: 'button', className: `pr-dot pr-${id}`, title: r.label });
      b.setAttribute('aria-pressed', String(current === id));
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        box.querySelectorAll('.pr-dot').forEach((d) => d.setAttribute('aria-pressed', String(d === b)));
        onPick(id);
      });
      box.append(b);
    });
    return box;
  },

  // Отложенное сохранение изменений по ключам: patch(key, fields) или patch(key, null) — удалить.
  // При записи изменения накладываются на свежий рейтинг из storage (XT.partnerRating.apply).
  saver(onError) {
    const pending = new Map();
    let timer = 0;
    const flush = () => {
      clearTimeout(timer);
      timer = 0;
      if (!pending.size) return Promise.resolve();
      const changes = [...pending];
      pending.clear();
      return XT.partnerRating.apply((map) => {
        changes.forEach(([key, fields]) => {
          if (fields === null) delete map[key];
          else map[key] = { ...(map[key] || { name: '', rating: 'yellow', note: '' }), ...fields };
        });
      }).catch(onError);
    };
    window.addEventListener('pagehide', flush);
    return {
      patch(key, fields, delay = 0) {
        pending.set(key, fields === null ? null : { ...(pending.get(key) || {}), ...fields });
        clearTimeout(timer);
        timer = setTimeout(flush, delay);
      },
      flush,
      get busy() { return pending.size > 0; },
    };
  },

  exportFile(map) {
    const file = {
      type: PR_FILE_TYPE,
      version: chrome.runtime.getManifest().version,
      exportedAt: new Date().toISOString(),
      ratings: map,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
    const a = el('a', { href: url, download: `partner-rating-${file.exportedAt.slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return Object.keys(map).length;
  },
};
