// Child case: кнопка «+ Child case» и форма на плашке Case ERP panel (salesforce-case-info-panel.js).
// Форма: Record Type (по умолчанию Case Mgmt), Job (номер джобы, подставляется из кейса), Subject.
// Create → background (SF_CREATE_CHILD_CASE) создаёт Case с ParentId открытого кейса через Salesforce API;
// остальные поля — значения по умолчанию формы New Case этого Record Type.
// Своего места на странице у скрипта нет: плашка зовёт XT.childCase.buttonHtml() и attach().
// Форма — постоянный элемент, плашка его не перерисовывает: введённый текст и фокус не теряются.
(function () {
  'use strict';
  const XT = (globalThis.XT = globalThis.XT || {});

  const SCRIPT_ID = 'sf-child-case';
  const CASE_PATH_RE = /^\/lightning\/r\/Case\/([A-Za-z0-9]{15,18})\/view\/?$/;
  const script = XT.registry.getScript(SCRIPT_ID);
  const { escapeHtml, JOB_ID_RE } = XT.dom;

  let enabled = false;
  let open = false;
  let openCaseId = null;
  let saving = false;
  let meta = null;          // { recordTypes: [{ id, name }], hasJobField }
  let metaLoading = null;   // Promise

  // ---------------- Форма ----------------
  const INPUT = 'box-sizing:border-box;height:26px;padding:0 6px;border:1px solid #c9c9c9;border-radius:4px;'
    + 'font:inherit;color:#181818;background:#fff;min-width:0';
  const BTN = 'height:26px;padding:0 12px;border-radius:4px;font:inherit;font-weight:600;cursor:pointer';
  // Мама-медведица и медвежонок (два 🐻 разного размера, малыш прижат к маме)
  const EMOJI_FONT = 'font-family:"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
  const BEARS = `<span aria-hidden="true" style="display:inline-flex;align-items:flex-end;${EMOJI_FONT}">`
    + '<span style="font-size:16px;line-height:1">🐻</span>'
    + '<span style="font-size:10px;line-height:1;margin-left:-2px">🐻</span></span>';

  // Столбец справа от содержимого плашки (плашка — flex-строка)
  const form = document.createElement('div');
  form.style.cssText = 'flex:none;width:380px;margin-left:12px;padding:2px 0 2px 12px;border-left:1px solid #e5e5e5';
  form.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
      ${BEARS}<b>New child case</b><span style="color:#706e6b">of this case</span>
    </div>
    <div style="display:grid;grid-template-columns:auto minmax(0,1fr) auto 96px;gap:5px 8px;align-items:center">
      <label style="color:#706e6b">Record type</label>
      <select data-f="rt" style="${INPUT}"></select>
      <label style="color:#706e6b">Job</label>
      <input data-f="job" placeholder="J03…" spellcheck="false" style="${INPUT};text-transform:uppercase">
      <label style="color:#706e6b">Subject</label>
      <input data-f="subject" maxlength="255" style="${INPUT};grid-column:2/-1;width:100%">
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap">
      <button type="button" data-f="create" style="${BTN};border:1px solid #0176d3;background:#0176d3;color:#fff">Create</button>
      <button type="button" data-f="cancel" style="${BTN};border:1px solid #c9c9c9;background:#fff;color:#0176d3">Cancel</button>
      <span data-f="status" style="min-width:0;white-space:normal"></span>
    </div>`;
  const $ = (name) => form.querySelector(`[data-f="${name}"]`);
  const rtSelect = $('rt');
  const jobInput = $('job');
  const subjectInput = $('subject');
  const createBtn = $('create');
  const statusEl = $('status');

  function setStatus(html, color = '#706e6b') {
    statusEl.style.color = color;
    statusEl.innerHTML = html;
  }

  function fillRecordTypes() {
    if (!meta) {
      rtSelect.innerHTML = `<option>${escapeHtml(script.defaultRecordType)}</option>`;
      rtSelect.disabled = true;
      return;
    }
    const wanted = (script.defaultRecordType || '').toLowerCase();
    rtSelect.innerHTML = meta.recordTypes.map((r) =>
      `<option value="${escapeHtml(r.id)}"${r.name.toLowerCase() === wanted ? ' selected' : ''}>${escapeHtml(r.name)}</option>`).join('');
    rtSelect.disabled = saving;
  }

  // Subject предзаполнен номером джобы. Пока его не правили, он следует за полем Job.
  let autoSubject = '';
  const subjectFor = (jobId) => (jobId ? `${jobId} ` : '');
  function prefillSubject(jobId) {
    autoSubject = subjectFor(jobId);
    subjectInput.value = autoSubject;
  }

  // После создания Create заблокирован, пока не изменят Job или Subject: Enter второй раз не создаст дубль
  let justCreated = false;

  function updateControls() {
    const ready = !!meta && !saving && !justCreated;
    createBtn.disabled = !ready;
    createBtn.style.opacity = ready ? '1' : '.6';
    [jobInput, subjectInput].forEach((el) => { el.disabled = saving; });
    rtSelect.disabled = !meta || saving;
  }

  const NO_ACCESS_RE = /No Salesforce API access/i;
  let needsAccess = false;

  function loadMeta() {
    if (meta || metaLoading) return;
    setStatus('Loading record types…');
    metaLoading = XT.sendToBackground({ type: 'SF_CHILD_CASE_META' })
      .then((m) => {
        meta = m;
        needsAccess = false;
        fillRecordTypes();
        setStatus(m.hasJobField ? '' : '⚠ Job field not found on Case: the job will not be linked', '#8e030f');
      })
      .catch((err) => {
        needsAccess = NO_ACCESS_RE.test(err.message);
        // Первый раз: доступ к Salesforce API ещё не выдан — кнопка открывает окно, где Chrome его спросит
        if (needsAccess) {
          setStatus('Child case needs Salesforce API access (once). '
            + `<button type="button" data-f="grant" style="${BTN};height:22px;padding:0 8px;border:1px solid #0176d3;`
            + 'background:#fff;color:#0176d3">Grant Salesforce access</button>', '#514f4d');
        } else {
          setStatus(`⚠ ${escapeHtml(err.message)}`, '#8e030f');
        }
      })
      .finally(() => { metaLoading = null; updateControls(); });
  }

  async function create() {
    if (!meta || saving || justCreated || !openCaseId) return;
    const subject = subjectInput.value.trim();
    const jobId = jobInput.value.trim().toUpperCase();
    if (!subject) { setStatus('Enter a subject', '#8e030f'); subjectInput.focus(); return; }
    if (jobId && !new RegExp(`^${JOB_ID_RE.source}$`, 'i').test(jobId)) {
      setStatus(`Not a job number: ${escapeHtml(jobId)}`, '#8e030f');
      jobInput.focus();
      return;
    }
    saving = true;
    updateControls();
    setStatus('Creating…');
    try {
      const c = await XT.sendToBackground({
        type: 'SF_CREATE_CHILD_CASE',
        input: { parentId: openCaseId, recordTypeId: rtSelect.value, jobId, subject },
      });
      justCreated = true;
      setStatus(`✓ Created <a href="/lightning/r/Case/${escapeHtml(c.id)}/view" style="color:#0176d3;font-weight:700">`
        + `${escapeHtml(c.caseNumber || c.id)}</a> · ${escapeHtml(c.recordType)}`
        + `${c.owner ? ` · Owner: <b>${escapeHtml(c.owner)}</b>` : ''}`, '#2e844a');
    } catch (err) {
      setStatus(`⚠ ${escapeHtml(err.message)}`, '#8e030f');
    } finally {
      saving = false;
      updateControls();
    }
  }

  function close() {
    open = false;
    openCaseId = null;
    form.remove();
  }

  createBtn.addEventListener('click', create);
  jobInput.addEventListener('input', () => {
    if (subjectInput.value === autoSubject) prefillSubject(jobInput.value.trim().toUpperCase());
  });
  // Любая правка после создания — это уже новый кейс: Create снова доступен
  [jobInput, subjectInput].forEach((el) => el.addEventListener('input', () => {
    if (!justCreated) return;
    justCreated = false;
    updateControls();
  }));
  $('cancel').addEventListener('click', () => { close(); notify(); });
  // Клавиши в полях не должны доходить до горячих клавиш Salesforce; Enter — создать, Esc — закрыть
  ['keydown', 'keyup', 'keypress'].forEach((type) => form.addEventListener(type, (event) => {
    event.stopPropagation();
    if (type !== 'keydown') return;
    if (event.key === 'Enter' && event.target.tagName === 'INPUT') { event.preventDefault(); create(); }
    if (event.key === 'Escape') { close(); notify(); }
  }));
  // Клики формы не должны доходить до обработчика плашки
  form.addEventListener('click', (event) => {
    event.stopPropagation();
    if (event.target.closest('[data-f="grant"]')) {
      XT.sendToBackground({ type: 'OPEN_SF_GRANT' })
        .catch((err) => setStatus(`⚠ ${escapeHtml(err.message)}`, '#8e030f'));
    }
  });
  // Окно доступа закрылось — страница снова в фокусе: пробуем ещё раз
  window.addEventListener('focus', () => { if (open && needsAccess && !meta) loadMeta(); });

  const notify = () => { if (typeof XT.childCase.onChange === 'function') XT.childCase.onChange(); };

  // ---------------- Для плашки ----------------
  XT.childCase = {
    onChange: null,   // плашка: перерисовать себя

    caseIdFromPath: () => { const m = location.pathname.match(CASE_PATH_RE); return m ? m[1] : null; },

    // Столбец с кнопкой справа на плашке (data-act="child" ловит обработчик плашки).
    // Иконка — мама-медведица и медвежонок: родительский кейс и child case.
    buttonHtml() {
      if (!enabled) return '';
      return `<div style="flex:none;display:flex;align-items:center;padding-left:12px;border-left:1px solid #e5e5e5">
        <span data-act="child" role="button" title="${open ? 'Close the form' : 'Create a child case of this case in Salesforce'}"
          style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border:1px solid ${open ? '#0176d3' : '#c9c9c9'};
            border-radius:4px;cursor:pointer;color:#0176d3;font-weight:600;white-space:nowrap;user-select:none;
            background:${open ? '#eef4ff' : '#fff'}">${BEARS}${open ? 'Close' : 'Child case'}</span></div>`;
    },

    toggle(caseId, jobId) {
      if (!enabled || !caseId) return;
      if (open && openCaseId === caseId) { close(); return; }
      open = true;
      openCaseId = caseId;
      justCreated = false;
      jobInput.value = jobId || '';
      prefillSubject(jobId || '');
      setStatus('');
      fillRecordTypes();
      updateControls();
      loadMeta();
      // Курсор — в конец темы, после номера джобы
      setTimeout(() => {
        subjectInput.focus();
        subjectInput.setSelectionRange(subjectInput.value.length, subjectInput.value.length);
      }, 0);
    },

    // Форма — справа от содержимого плашки; другой кейс — форма закрывается. true — форма показана
    attach(container, caseId) {
      if (!open || !enabled) { form.remove(); return false; }
      if (caseId !== openCaseId) { close(); return false; }
      if (form.parentElement !== container) container.appendChild(form);
      return true;
    },
  };

  XT.settings.watch(SCRIPT_ID, (on) => {
    enabled = on;
    if (!on) close();
    notify();
  });
})();
