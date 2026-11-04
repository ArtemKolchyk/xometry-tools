// Настройки скрипта «Auto refresh»: интервал в минутах, пауза при активности и сколько ждать тишины.
'use strict';

function renderAutoRefreshEditor(scriptId) {
  const IDLE_CHOICES = [[30, '30 sec'], [60, '1 min'], [120, '2 min'], [300, '5 min']];

  const interval = el('input', { type: 'number', min: 1, max: 1440, step: 1, className: 'ar-num' });
  const pause = el('input', { type: 'checkbox' });
  const idle = el('select', { className: 'ar-select' },
    IDLE_CHOICES.map(([v, label]) => el('option', { value: String(v), textContent: label })));

  const box = el('div', { className: 'ar-editor' }, [
    el('label', { className: 'ar-row' }, ['Every ', interval, ' min']),
    el('label', { className: 'ar-row' }, [pause, ' Pause after my clicks or key presses in the tab']),
    el('label', { className: 'ar-row ar-sub' }, ['Resume after ', idle, ' without clicks or keys']),
  ]);

  let opts = null;
  let saveTimer = 0;

  // У chrome.storage.sync лимит 120 записей в минуту, поэтому изменения склеиваются
  function save(delay = 300) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, delay);
  }

  function flush() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = 0;
    XT.options.set(scriptId, opts)
      .then(() => showMessage('Auto refresh settings saved'))
      .catch((e) => showMessage(e.message, true));
  }

  function syncSub() {
    idle.disabled = !pause.checked;
    box.querySelector('.ar-sub').classList.toggle('off', !pause.checked);
  }

  interval.addEventListener('input', () => {
    const n = Math.round(Number(interval.value));
    if (!(n >= 1 && n <= 1440)) return;   // пока поле пустое или вне диапазона — не сохраняем
    opts.intervalMin = n;
    save(600);
  });
  interval.addEventListener('change', () => { interval.value = opts.intervalMin; });
  pause.addEventListener('change', () => { opts.pauseWhenActive = pause.checked; syncSub(); save(); });
  idle.addEventListener('change', () => { opts.idleSec = Number(idle.value); save(); });
  window.addEventListener('pagehide', flush);

  XT.options.get(scriptId).then((o) => {
    opts = o;
    interval.value = o.intervalMin;
    pause.checked = o.pauseWhenActive;
    idle.value = String(o.idleSec);
    syncSub();
  });

  return box;
}
