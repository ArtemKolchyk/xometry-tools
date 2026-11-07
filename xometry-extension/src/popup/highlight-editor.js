// Редактор правил скрипта «Text highlighter»: галочка, название, цвета, удаление; тексты через запятую;
// где работает (сайт или часть адреса); «+ Add rule».
// Изменения сохраняются сразу (текст — с задержкой), вкладки подхватывают их через storage.onChanged.
// Нативный выбор цвета есть только во вкладке (options page): в popup системный диалог закрывает popup.
'use strict';

function renderHighlightEditor() {
  const store = XT.highlightRules;
  const inTab = document.body.classList.contains('in-tab');
  const list = el('div', { className: 'hl-list' });
  const addBtn = el('button', { type: 'button', className: 'btn', textContent: '+ Add rule' });
  const box = el('div', { className: 'hl-editor' }, [list, addBtn]);

  let rules = [];
  let saveTimer = 0;
  let openPalette = null;

  // У chrome.storage.sync лимит 120 записей в минуту, поэтому частые изменения склеиваются в одну запись
  function save(delay = 300) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, delay);
  }

  function flush() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = 0;
    store.set(rules).catch((e) => showMessage(e.message, true));
  }

  function paint(chip, rule) {
    chip.style.background = rule.bg;
    chip.style.color = rule.color;
  }

  function closePalette() {
    if (openPalette) { openPalette.remove(); openPalette = null; }
  }

  function renderPalette(rule, chip) {
    const pick = (bg, color, delay) => { rule.bg = bg; rule.color = color; paint(chip, rule); save(delay); };

    const grid = el('div', { className: 'hl-presets' }, store.PRESETS.map((p) => {
      const b = el('button', { type: 'button', className: 'hl-chip', textContent: 'Aa', title: `${p.bg} / ${p.color}` });
      paint(b, p);
      b.addEventListener('click', () => { pick(p.bg, p.color); closePalette(); });
      return b;
    }));
    const palette = el('div', { className: 'hl-palette' }, [grid]);

    if (inTab) {
      const bg = el('input', { type: 'color', value: rule.bg, title: 'Fill' });
      const fg = el('input', { type: 'color', value: rule.color, title: 'Text' });
      // 'input' летит непрерывно, пока тянут ползунок: превью сразу, запись — после паузы или по закрытию picker
      bg.addEventListener('input', () => pick(bg.value, rule.color, 1000));
      fg.addEventListener('input', () => pick(rule.bg, fg.value, 1000));
      bg.addEventListener('change', () => pick(bg.value, rule.color, 0));
      fg.addEventListener('change', () => pick(rule.bg, fg.value, 0));
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

  // Сайты, на которых работает подсветка (общий скрипт): все не-заглушечные, кроме служебных
  const siteOptions = [
    [store.SITE_ALL, 'All sites'],
    ...XT.registry.sites.filter((s) => !s.stub && !s.general && !s.settings && !s.page).map((s) => [s.id, s.name]),
    [store.SITE_CUSTOM, 'Custom (part of URL)…'],
  ];

  function renderRow(rule) {
    const check = el('input', { type: 'checkbox', checked: rule.enabled, title: 'Enable rule' });
    const name = el('input', { type: 'text', value: rule.name, placeholder: 'Name (notes)', className: 'hl-text hl-name' });
    const chip = el('button', { type: 'button', className: 'hl-chip', textContent: 'Aa', title: 'Colors' });
    const del = el('button', { type: 'button', className: 'hl-del', textContent: '✕', title: 'Delete rule' });
    const head = el('div', { className: 'hl-head' }, [check, name, chip, del]);
    const text = el('input', {
      type: 'text', value: rule.text, className: 'hl-text hl-texts',
      placeholder: 'Text to highlight, several: comma-separated',
      title: 'Several texts with the same colors: separate them with commas',
    });
    const site = el('select', { className: 'ar-select' }, siteOptions.map(([value, label]) =>
      el('option', { value, textContent: label, selected: rule.site === value })));
    // Сайт из старой версии или удалённый из реестра — показываем как «All sites», пока не выберут другой
    if (!siteOptions.some(([value]) => value === rule.site)) site.value = store.SITE_ALL;
    const url = el('input', {
      type: 'text', value: rule.url, className: 'hl-text hl-url',
      placeholder: 'e.g. xometry5836.lightning.force.com or /lightning/r/Case/',
    });
    const where = el('div', { className: 'hl-where' }, ['Where', site]);
    const row = el('div', { className: `hl-row${rule.enabled ? '' : ' off'}` }, [head, text, where, url]);
    paint(chip, rule);
    const syncUrl = () => { url.hidden = site.value !== store.SITE_CUSTOM; };
    syncUrl();

    check.addEventListener('change', () => { rule.enabled = check.checked; row.classList.toggle('off', !rule.enabled); save(); });
    name.addEventListener('input', () => { rule.name = name.value; save(400); });
    text.addEventListener('input', () => { rule.text = text.value; save(400); });
    site.addEventListener('change', () => {
      rule.site = site.value;
      syncUrl();
      save();
      if (!url.hidden) url.focus();
    });
    url.addEventListener('input', () => { rule.url = url.value; save(400); });
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = openPalette && openPalette.parentNode === head;
      closePalette();
      if (!wasOpen) { openPalette = renderPalette(rule, chip); head.append(openPalette); }
    });
    del.addEventListener('click', () => { rules = rules.filter((r) => r !== rule); save(); render(); });
    return row;
  }

  function render() {
    closePalette();
    list.replaceChildren(...rules.map(renderRow));
    if (!rules.length) list.append(el('p', { className: 'muted', textContent: 'No rules yet.' }));
  }

  addBtn.addEventListener('click', () => {
    const preset = store.PRESETS[rules.length % store.PRESETS.length];
    rules.push({ name: '', text: '', site: store.SITE_ALL, url: '', bg: preset.bg, color: preset.color, enabled: true });
    save();
    render();
    list.querySelector('.hl-row:last-child .hl-texts').focus();
  });
  document.addEventListener('click', closePalette);
  window.addEventListener('pagehide', flush);   // popup закрыли раньше, чем сработал таймер

  store.get().then((loaded) => { rules = loaded; render(); });
  return box;
}
