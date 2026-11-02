// Настройки скрипта «Case quick text»: какой текст вставляет каждая кнопка.
'use strict';

function renderQuickTextEditor(scriptId) {
  const FIELDS = [['passText', 'VQC pass'], ['correctionsText', 'PASS after corrections']];

  const inputs = {};
  const box = el('div', { className: 'ar-editor' }, FIELDS.map(([key, label]) => {
    inputs[key] = el('textarea', { className: 'qt-text', rows: 3 });
    return el('label', { className: 'qt-row' }, [label, inputs[key]]);
  }));

  let opts = null;
  let saveTimer = 0;

  // У chrome.storage.sync лимит 120 записей в минуту, поэтому изменения склеиваются
  function save(delay = 600) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, delay);
  }

  function flush() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = 0;
    XT.options.set(scriptId, opts)
      .then(() => showMessage('Quick text saved'))
      .catch((e) => showMessage(e.message, true));
  }

  FIELDS.forEach(([key]) => {
    inputs[key].addEventListener('input', () => { opts[key] = inputs[key].value; save(); });
  });
  window.addEventListener('pagehide', flush);

  XT.options.get(scriptId).then((o) => {
    opts = o;
    FIELDS.forEach(([key]) => { inputs[key].value = o[key]; });
  });

  return box;
}
