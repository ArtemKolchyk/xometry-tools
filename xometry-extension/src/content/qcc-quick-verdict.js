// QC Center: Accept All / Reject All buttons that fill the Submit Verdict dialog.
// Port of userscripts/QCC - Accept or Reject.txt (Tampermonkey v1.3).
(function () {
  'use strict';

  const SCRIPT_ID = 'qcc-quick-verdict';
  const TAG = '[QCC quick verdict]';
  const BAR_CLASS = 'xt-qcc-quick-bar';

  // ---------- helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => !!el && el.getClientRects().length > 0;

  async function waitFor(fn, timeout = 3000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const r = fn();
      if (r) return r;
      await sleep(25);
    }
    return null;
  }

  // Ищем <label> поля формы по началу текста ("Inspection status", "Qty Rejected" ...)
  function findLabel(root, text) {
    const want = text.toLowerCase();
    return [...root.querySelectorAll('label')].find((l) =>
      norm(l.textContent).replace(/^\*\s*/, '').toLowerCase().startsWith(want)
    );
  }

  function getField(root, text) {
    const label = findLabel(root, text);
    return label ? label.closest('.ant-form-item') : null;
  }

  // Ввод текста в React-контролируемый input.
  // Content script живёт в изолированном мире и не видит value-трекер React на элементе,
  // поэтому нативный setter + input/change работают так же, как в Tampermonkey.
  function typeInto(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setInput(field, value) {
    const input = field && field.querySelector('input:not([type="checkbox"])');
    if (!input) {
      console.warn(TAG, 'не найден input в поле', field);
      return;
    }
    typeInto(input, value);
    input.blur();
  }

  function optionLabel(o) {
    return norm(o.getAttribute('title') || o.textContent).toUpperCase();
  }

  // Выпадающий список, принадлежащий именно этому полю
  function dropdownsOf(field) {
    const inp = field.querySelector('input');
    const listId = inp && (inp.getAttribute('aria-controls') || inp.getAttribute('aria-owns'));
    const list = listId && document.getElementById(listId);
    const own = list && list.closest('.ant-select-dropdown');
    if (own) return [own];
    return [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')].filter(visible);
  }

  function findOption(field, want) {
    const opts = dropdownsOf(field)
      .flatMap((d) => [...d.querySelectorAll('.ant-select-item-option')])
      .filter(visible);
    return opts.find((o) => optionLabel(o) === want) || opts.find((o) => optionLabel(o).startsWith(want));
  }

  // Выбор значения в Ant Design Select
  async function selectOption(field, text, { multiple = false } = {}) {
    if (!field) throw new Error('не найдено поле для значения "' + text + '"');

    // В мультиселекте повторный клик снимет выбор — проверяем, нет ли уже тега
    if (multiple) {
      const tags = [...field.querySelectorAll('.ant-select-selection-item')].map((t) => norm(t.textContent));
      if (tags.includes(text)) return;
    }

    const opener = field.querySelector('.ant-select-selector') || field.querySelector('.ant-select');
    opener.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await sleep(125);

    const want = text.toUpperCase();
    let option = await waitFor(() => findOption(field, want), 1000);

    // Длинный список рисуется частично — вводим текст в поиск, чтобы нужный пункт появился
    if (!option) {
      const search = field.querySelector('input.ant-select-selection-search-input') || field.querySelector('input');
      if (search) {
        typeInto(search, text);
        option = await waitFor(() => findOption(field, want), 2000);
      }
    }
    if (!option) throw new Error('не найден вариант "' + text + '" в списке');

    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    option.click();
    await sleep(75);

    if (multiple) {
      const inp = field.querySelector('input');
      if (inp) {
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        inp.blur();
      }
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    }
    await sleep(125);
  }

  // Количество из заказа: "Order / Job Qty  56 / 56" → берём Job Qty
  function getOrderQty() {
    const label = [...document.querySelectorAll('body *')].find(
      (el) => el.children.length === 0 && norm(el.textContent) === 'Order / Job Qty'
    );
    if (label) {
      const valueEl = label.nextElementSibling || (label.parentElement && label.parentElement.nextElementSibling);
      const nums = norm(valueEl && valueEl.textContent).match(/\d+/g);
      if (nums && nums.length) return Number(nums[nums.length - 1]);
    }
    const manual = prompt('Не удалось найти количество в заказе. Введите вручную:');
    return manual ? Number(manual) : null;
  }

  // ---------- заполнение ----------
  async function fill(modal, mode) {
    try {
      const qty = getOrderQty();
      if (qty == null || isNaN(qty)) return;

      await selectOption(getField(modal, 'Inspection status'), mode === 'accept' ? 'ACCEPT' : 'REJECT');
      await sleep(150);

      if (mode === 'reject') {
        // Поля Reason и Party at Fault появляются после выбора REJECT
        const reason = await waitFor(() => getField(modal, 'Reason'));
        await selectOption(reason, 'Other', { multiple: true });
        await selectOption(await waitFor(() => getField(modal, 'Party at Fault')), 'Partner');
      }

      await sleep(50);
      setInput(getField(modal, 'Qty Rejected'), mode === 'accept' ? 0 : qty);
      setInput(getField(modal, 'Qty Accepted'), mode === 'accept' ? qty : 0);
    } catch (e) {
      console.error(TAG, e);
      alert('Автозаполнение не удалось: ' + e.message);
    }
  }

  // ---------- штамп на Xometry CofC ----------
  // В списке Validation Items у документа «Xometry Certificate of Conformance…» есть [data-testid=certificate-stamp-button]:
  // со штампом это меню с текстом «Stamped COC», без штампа — круглая кнопка-иконка без текста.
  // «Partner to Xometry CoC» — другой документ, его не проверяем.
  const COC_NAME_RE = /^Xometry Certificate of Conformance/i;
  const STAMPED_RE = /stamped\s*coc/i;

  // { state: 'stamped' | 'missing' | 'none', names: [непроштампованные] }; одинаковые документы считаются один раз,
  // при нескольких CofC достаточно, чтобы был проштампован хотя бы один
  function cocStatus() {
    const docs = new Map();   // имя → проштампован
    document.querySelectorAll('.ant-collapse-header').forEach((header) => {
      const identity = header.querySelector('[class*="documentSummaryIdentity"]');
      const name = norm((identity || header).textContent);
      if (!COC_NAME_RE.test(name)) return;
      const stamp = header.querySelector('[data-testid="certificate-stamp-button"]');
      const stamped = !!stamp && STAMPED_RE.test(stamp.textContent);
      docs.set(name, docs.get(name) || stamped);
    });
    if (!docs.size) return { state: 'none', names: [] };
    if ([...docs.values()].some(Boolean)) return { state: 'stamped', names: [] };
    return { state: 'missing', names: [...docs.keys()] };
  }

  const STATUS_VIEW = {
    stamped: { text: '✓ Xometry CofC is stamped', color: '#237804', bg: '#f6ffed', border: '#b7eb8f' },
    missing: { text: '⚠ Xometry CofC is not stamped', color: '#a8071a', bg: '#fff1f0', border: '#ffa39e' },
    none: { text: 'No Xometry CofC on the page: stamp not checked', color: '#595959', bg: '#fafafa', border: '#d9d9d9' },
  };

  // Меняем DOM, только если что-то изменилось: иначе MutationObserver крутился бы по кругу
  function updateStatus(bar) {
    const box = bar.querySelector(`.${BAR_CLASS}-status`);
    if (!box) return;
    const s = cocStatus();
    const view = STATUS_VIEW[s.state];
    const title = s.names.length ? `Not stamped: ${s.names.join(', ')}` : '';
    if (box.dataset.state === s.state && box.title === title) return;
    box.dataset.state = s.state;
    box.textContent = view.text;
    box.title = title;
    Object.assign(box.style, { color: view.color, background: view.bg, borderColor: view.border });
  }

  // Что выбрано в поле Inspection status диалога: 'ACCEPT', 'REJECT' или ''
  function selectedStatus(modal) {
    const field = getField(modal, 'Inspection status');
    const item = field && field.querySelector('.ant-select-selection-item');
    return item ? norm(item.getAttribute('title') || item.textContent).toUpperCase() : '';
  }

  // Submit в диалоге с ACCEPT при непроштампованном CofC: сначала подтверждение.
  // Ловим на capture у window — раньше обработчиков React; «Submit anyway» повторяет клик в обход проверки.
  let bypass = false;
  function onSubmitClick(event) {
    if (bypass) return;
    const button = event.composedPath().find((el) => el.tagName === 'BUTTON');
    if (!button || !/^submit\b/i.test(norm(button.textContent))) return;
    const modal = button.closest('.ant-modal-content, .ant-modal, [role="dialog"]');
    if (!modal || !modal.querySelector(`.${BAR_CLASS}`)) return;   // только диалог вердикта
    if (selectedStatus(modal) !== 'ACCEPT') return;
    if (cocStatus().state !== 'missing') return;

    event.preventDefault();
    event.stopImmediatePropagation();
    if (!window.confirm('The Xometry Certificate of Conformance is not stamped.\n\nSubmit the ACCEPT verdict anyway?')) return;
    bypass = true;
    try { button.click(); } finally { bypass = false; }
  }

  // ---------- кнопки ----------
  function makeButton(text, color, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    Object.assign(b.style, {
      flex: '1',
      padding: '6px 12px',
      border: 'none',
      borderRadius: '4px',
      background: color,
      color: '#fff',
      fontWeight: '600',
      cursor: 'pointer',
    });
    b.addEventListener('click', onClick);
    return b;
  }

  function inject() {
    const labels = new Set([
      ...document.querySelectorAll('label[for="qcInspectionInput_status"]'),
      ...document.querySelectorAll('label[for$="_status"]'),
    ]);
    for (const label of labels) {
      if (!visible(label)) continue;
      const formItem = label.closest('.ant-form-item');
      if (!formItem) continue;
      if (formItem.previousElementSibling && formItem.previousElementSibling.classList.contains(BAR_CLASS)) continue;

      const modal = label.closest('.ant-modal-content, .ant-modal, [role="dialog"]') || label.closest('form') || document;

      const bar = document.createElement('div');
      bar.className = BAR_CLASS;
      Object.assign(bar.style, { marginBottom: '12px' });
      const row = document.createElement('div');
      Object.assign(row.style, { display: 'flex', gap: '8px' });
      row.append(
        makeButton('Accept All', '#52c41a', () => fill(modal, 'accept')),
        makeButton('Reject All', '#ff4d4f', () => fill(modal, 'reject'))
      );
      // Штамп на Xometry CofC (см. cocStatus)
      const status = document.createElement('div');
      status.className = `${BAR_CLASS}-status`;
      Object.assign(status.style, {
        marginTop: '8px', padding: '4px 10px', border: '1px solid', borderRadius: '4px',
        fontSize: '13px', fontWeight: '600',
      });
      bar.append(row, status);
      formItem.parentElement.insertBefore(bar, formItem);
    }
    document.querySelectorAll(`.${BAR_CLASS}`).forEach(updateStatus);
  }

  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      inject();
    }, 150);
  });

  function start() {
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('click', onSubmitClick, true);
    inject();
  }

  function stop() {
    observer.disconnect();
    window.removeEventListener('click', onSubmitClick, true);
    document.querySelectorAll(`.${BAR_CLASS}`).forEach((bar) => bar.remove());
  }

  XT.settings.watch(SCRIPT_ID, (enabled) => (enabled ? start() : stop()));
})();
