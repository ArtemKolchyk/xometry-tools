// Child case: кнопка «Child case» и форма на плашке Case ERP panel (salesforce-case-info-panel.js).
// Форма: Record Type (по умолчанию Case Mgmt), Job (номер джобы, подставляется из кейса), Subject,
// и пост в новый child case (Chatter, видимость Xometry Only) — почти готовый текст по шаблону:
//   Hi @CM,
//   <информация для CM>
//
//   Please reply in the parent case <номер> when I can continue VQC.
//   Thanks
// и пост в родительский кейс: «Sent child case to CM @CM» (обе галочки включены по умолчанию).
// CM — из плашки (ERP), @CM становится настоящим упоминанием, если в Salesforce ровно один активный
// пользователь с таким именем. Create → background (SF_CREATE_CHILD_CASE): создаёт Case (владелец — создатель),
// затем публикует посты. Пост не вышел — кейс остаётся, форма говорит почему, текст остаётся в поле.
// Своего места на странице у скрипта нет: плашка зовёт XT.childCase.buttonHtml(), attach() и suggestCm().
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
  let parentNumber = '';    // номер открытого (родительского) кейса — для текста поста

  // ---------------- Форма ----------------
  const INPUT = 'box-sizing:border-box;height:26px;padding:0 6px;border:1px solid #c9c9c9;border-radius:4px;'
    + 'font:inherit;color:#181818;background:#fff;min-width:0';
  const BTN = 'height:26px;padding:0 12px;border-radius:4px;font:inherit;font-weight:600;cursor:pointer';
  const MUTED = 'color:#706e6b';
  // Мама-медведица и медвежонок (два 🐻 разного размера, малыш прижат к маме)
  const EMOJI_FONT = 'font-family:"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
  const BEARS = `<span aria-hidden="true" style="display:inline-flex;align-items:flex-end;${EMOJI_FONT}">`
    + '<span style="font-size:16px;line-height:1">🐻</span>'
    + '<span style="font-size:10px;line-height:1;margin-left:-2px">🐻</span></span>';

  // Столбец справа от содержимого плашки (плашка — flex-строка)
  const form = document.createElement('div');
  form.style.cssText = 'flex:none;width:440px;margin-left:12px;padding:2px 0 2px 12px;border-left:1px solid #e5e5e5';
  form.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
      ${BEARS}<b>New child case</b><span style="${MUTED}">of this case</span>
    </div>
    <div style="display:grid;grid-template-columns:auto minmax(0,1fr) auto 96px;gap:5px 8px;align-items:center">
      <label style="${MUTED}">Record type</label>
      <select data-f="rt" style="${INPUT}"></select>
      <label style="${MUTED}">Job</label>
      <input data-f="job" placeholder="J03…" spellcheck="false" style="${INPUT};text-transform:uppercase">
      <label style="${MUTED}">Subject</label>
      <input data-f="subject" maxlength="255" style="${INPUT};grid-column:2/-1;width:100%">
    </div>
    <div style="margin-top:8px;padding-top:6px;border-top:1px dashed #e5e5e5">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
        <input type="checkbox" data-f="post-on" checked style="margin:0;cursor:pointer">
        <b>Post to the child case</b><span style="${MUTED}">· Xometry Only</span>
      </label>
      <div data-f="post-box" style="margin-top:5px">
        <div style="display:grid;grid-template-columns:auto 170px minmax(0,1fr);gap:5px 8px;align-items:center">
          <label style="${MUTED}" title="Case Manager: @mentioned in the post">CM</label>
          <input data-f="cm" maxlength="80" spellcheck="false" placeholder="Name for @mention" style="${INPUT}">
          <span data-f="cmhint" style="min-width:0;font-size:11px;line-height:13px;white-space:normal"></span>
        </div>
        <textarea data-f="post" rows="6" maxlength="5000" spellcheck="true"
          style="${INPUT};height:auto;width:100%;margin-top:5px;padding:5px 6px;line-height:1.4;resize:vertical"></textarea>
      </div>
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;margin-top:6px">
        <input type="checkbox" data-f="parent-on" checked style="margin:0;cursor:pointer">
        <b>Post to the parent case</b><span style="${MUTED}">· Xometry Only</span>
      </label>
      <input data-f="parent-post" maxlength="1000" spellcheck="true" style="${INPUT};width:100%;margin-top:5px">
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
  const postOn = $('post-on');
  const postBox = $('post-box');
  const cmInput = $('cm');
  const cmHint = $('cmhint');
  const postInput = $('post');
  const parentOn = $('parent-on');
  const parentInput = $('parent-post');
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

  // ---------------- Пост ----------------
  // Шаблон: вторая строка — для информации CM (туда ставится курсор)
  const greeting = (cm) => (cm ? `Hi @${cm},` : 'Hi,');
  const postTemplate = (cm) => `${greeting(cm)}\n\n\nPlease reply in the parent case ${parentNumber || '[parent case]'} `
    + 'when I can continue VQC.\nThanks';

  // Пост в родительский кейс — одна строка
  const parentTemplate = (cm) => `Sent child case to CM${cm ? ` @${cm}` : ''}`;

  // Пока текст не правили, он следует за CM и номером кейса. Правили — меняем только @старый CM на @нового.
  let autoPost = '';
  let autoParent = '';
  let lastCm = '';
  function refreshPost() {
    const cm = cmInput.value.trim();
    if (postInput.value === autoPost) {
      autoPost = postTemplate(cm);
      postInput.value = autoPost;
    } else if (cm !== lastCm) {
      const from = greeting(lastCm);
      if (postInput.value.startsWith(from)) postInput.value = greeting(cm) + postInput.value.slice(from.length);
    }
    if (parentInput.value === autoParent) {
      autoParent = parentTemplate(cm);
      parentInput.value = autoParent;
    } else if (cm !== lastCm && lastCm && parentInput.value.includes(`@${lastCm}`)) {
      parentInput.value = parentInput.value.replace(`@${lastCm}`, cm ? `@${cm}` : '').trim();
    }
    lastCm = cm;
  }

  // Курсор — в строку для информации CM, если текст ещё шаблонный
  postInput.addEventListener('focus', () => setTimeout(() => {
    if (postInput.value !== autoPost) return;
    const pos = postInput.value.indexOf('\n') + 1;
    postInput.setSelectionRange(pos, pos);
  }, 0));

  // CM — из плашки (ERP: caseManagerName); пока поле не правили, следует за плашкой.
  // Проверка: в Salesforce ровно один активный пользователь с таким именем — тогда @CM будет упоминанием.
  let autoCm = '';
  let infoToken = 0;
  let cmTimer = null;
  const cleanCm = (cm) => { const v = String(cm || '').trim(); return v === '—' || v === '-' ? '' : v; };

  function setCmHint(text, color = '#706e6b') {
    cmHint.style.color = color;
    cmHint.textContent = text;
  }

  // Номер родительского кейса и проверка CM — одним запросом
  function loadInfo() {
    clearTimeout(cmTimer);
    if (!meta || !openCaseId) return;
    const name = cmInput.value.trim();
    const token = ++infoToken;
    setCmHint(name ? 'Checking in Salesforce…' : 'No CM: the post will start with "Hi,"');
    XT.sendToBackground({ type: 'SF_CHILD_CASE_INFO', parentId: openCaseId, cmName: name })
      .then((r) => {
        if (token !== infoToken) return;
        if (r.parentNumber && r.parentNumber !== parentNumber) {
          // Номер кейса пришёл: шаблон с ним (если текст не правили) или замена заглушки в тексте
          const untouched = postInput.value === autoPost;
          parentNumber = r.parentNumber;
          if (untouched) {
            autoPost = postTemplate(cmInput.value.trim());
            postInput.value = autoPost;
          } else {
            postInput.value = postInput.value.replace('[parent case]', parentNumber);
          }
        }
        if (!name) return;
        if (r.cm.found) setCmHint('✓ Will be @mentioned', '#2e844a');
        else setCmHint(r.cm.many ? '⚠ Several users with this name: plain text, no @mention'
          : '⚠ Not found in Salesforce: plain text, no @mention', '#a96404');
      })
      .catch((err) => { if (token === infoToken) setCmHint(`⚠ ${err.message}`, '#8e030f'); });
  }

  function setCm(cm) {
    autoCm = cleanCm(cm);
    cmInput.value = autoCm;
    refreshPost();
    loadInfo();
  }

  // Поле CM нужно, пока включён хотя бы один пост; текст каждого поста — пока включён он
  function syncPostBox() {
    postBox.style.display = postOn.checked || parentOn.checked ? '' : 'none';
    postInput.style.display = postOn.checked ? '' : 'none';
    parentInput.style.display = parentOn.checked ? '' : 'none';
  }

  // После создания Create заблокирован, пока что-нибудь не изменят: Enter второй раз не создаст дубль
  let justCreated = false;

  function updateControls() {
    const ready = !!meta && !saving && !justCreated;
    createBtn.disabled = !ready;
    createBtn.style.opacity = ready ? '1' : '.6';
    [jobInput, subjectInput, postOn, cmInput, postInput, parentOn, parentInput].forEach((el) => { el.disabled = saving; });
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
        loadInfo();
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
    const postText = postInput.value.trim();
    if (!subject) { setStatus('Enter a subject', '#8e030f'); subjectInput.focus(); return; }
    if (jobId && !new RegExp(`^${JOB_ID_RE.source}$`, 'i').test(jobId)) {
      setStatus(`Not a job number: ${escapeHtml(jobId)}`, '#8e030f');
      jobInput.focus();
      return;
    }
    const parentText = parentInput.value.trim();
    if (postOn.checked && !postText) { setStatus('Enter the post text or untick the post', '#8e030f'); postInput.focus(); return; }
    if (parentOn.checked && !parentText) {
      setStatus('Enter the parent case post or untick it', '#8e030f');
      parentInput.focus();
      return;
    }
    const cmName = cmInput.value.trim();
    saving = true;
    updateControls();
    setStatus('Creating…');
    try {
      const c = await XT.sendToBackground({
        type: 'SF_CREATE_CHILD_CASE',
        input: {
          parentId: openCaseId, recordTypeId: rtSelect.value, jobId, subject,
          post: postOn.checked ? { text: postText, cmName } : null,
          parentPost: parentOn.checked ? { text: parentText, cmName } : null,
        },
      });
      justCreated = true;
      let html = `✓ Created <a href="/lightning/r/Case/${escapeHtml(c.id)}/view" style="color:#0176d3;font-weight:700">`
        + `${escapeHtml(c.caseNumber || c.id)}</a> · ${escapeHtml(c.recordType)}`
        + `${c.owner ? ` · Owner: <b>${escapeHtml(c.owner)}</b>` : ''}`;
      // Итог по каждому посту: опубликован (с предупреждением про @) или нет — текст остаётся в поле
      const postLine = (p, where) => {
        if (!p) return '';
        if (p.ok) {
          return `<br>💬 Posted to the ${where} case`
            + `${p.warning ? ` <span style="color:#a96404">· ⚠ ${escapeHtml(p.warning)}</span>` : ''}`;
        }
        return `<br><span style="color:#8e030f">⚠ Not posted to the ${where} case: ${escapeHtml(p.error)}. `
          + 'The text is still in the form: copy it to the feed.</span>';
      };
      html += postLine(c.post, 'child') + postLine(c.parentPost, 'parent');
      // Пост в открытом кейсе появится в его ленте после обновления страницы
      if (c.parentPost && c.parentPost.ok) html += ` <span style="${MUTED}">(refresh to see it in the feed)</span>`;
      setStatus(html, '#2e844a');
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
  postOn.addEventListener('change', syncPostBox);
  parentOn.addEventListener('change', syncPostBox);
  // CM правят руками: текст поста — сразу, проверка в Salesforce — когда перестали печатать
  cmInput.addEventListener('input', () => {
    refreshPost();
    clearTimeout(cmTimer);
    setCmHint('');
    cmTimer = setTimeout(loadInfo, 600);
  });
  // Любая правка после создания — это уже новый кейс: Create снова доступен
  [jobInput, subjectInput, postOn, cmInput, postInput, parentOn, parentInput].forEach((el) => el.addEventListener(
    el.type === 'checkbox' ? 'change' : 'input', () => {
      if (!justCreated) return;
      justCreated = false;
      updateControls();
    }));
  $('cancel').addEventListener('click', () => { close(); notify(); });
  // Клавиши в полях не должны доходить до горячих клавиш Salesforce; Enter в строке — создать, Esc — закрыть.
  // В тексте поста Enter — новая строка.
  ['keydown', 'keyup', 'keypress'].forEach((type) => form.addEventListener(type, (event) => {
    event.stopPropagation();
    if (type !== 'keydown') return;
    if (event.key === 'Enter' && event.target.tagName === 'INPUT' && event.target.type !== 'checkbox') {
      event.preventDefault();
      create();
    }
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

    toggle(caseId, jobId, cm) {
      if (!enabled || !caseId) return;
      if (open && openCaseId === caseId) { close(); return; }
      open = true;
      openCaseId = caseId;
      justCreated = false;
      parentNumber = '';
      jobInput.value = jobId || '';
      prefillSubject(jobId || '');
      postOn.checked = true;
      parentOn.checked = true;
      syncPostBox();
      // Новые шаблоны постов: сбрасываем «нетронутость», иначе остался бы текст прошлого кейса
      autoPost = '';
      postInput.value = '';
      autoParent = '';
      parentInput.value = '';
      lastCm = '';
      setCm(cm);
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

    // CM из плашки догрузился (или изменился после ↻), а поле не правили — подставляем
    suggestCm(cm) {
      const next = cleanCm(cm);
      if (!open || next === autoCm || cmInput.value !== autoCm) return;
      setCm(next);
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
