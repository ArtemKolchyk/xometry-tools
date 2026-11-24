// Child case: кнопка «Child case» и форма на плашке Case ERP panel (salesforce-case-info-panel.js).
// Форма: Record Type (по умолчанию Case Mgmt), Job (номер джобы, подставляется из кейса), Subject,
// и пост в новый child case (Chatter, видимость Xometry Only) — почти готовый текст по шаблону:
//   Hi @CM,
//   <информация для CM>
//
//   Please reply in the parent case <номер> when I can continue VQC.
//   Thanks
// и пост в родительский кейс: «Sent child case to CM @CM» (обе галочки включены по умолчанию).
// Owner (галочка включена): после создания и постов владелец меняется на этого человека — по умолчанию CM,
// имя можно заменить; ошибочное имя (не ровно один активный пользователь) не даёт создать кейс.
// Люди для @упоминаний: CM (из плашки, ERP) и сколько угодно ещё — «+ Add person» (до 10). Все — в приветствии
// шаблона; в обоих постах любое «@Имя» из списка становится настоящим упоминанием, если в Salesforce ровно один
// активный пользователь с таким именем. Create → background (SF_CREATE_CHILD_CASE): создаёт Case (владелец — создатель),
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
      <label style="display:flex;align-items:center;gap:5px;cursor:pointer;${MUTED}"
        title="After the case is created (and the posts are published), its owner is changed to this person">
        <input type="checkbox" data-f="owner-on" checked style="margin:0;cursor:pointer">Owner</label>
      <input data-f="owner" maxlength="80" spellcheck="false" placeholder="Name of the new owner" style="${INPUT}">
      <span data-f="ownerhint" style="grid-column:3/-1;min-width:0;font-size:11px;line-height:13px;white-space:normal"></span>
    </div>
    <div style="margin-top:8px;padding-top:6px;border-top:1px dashed #e5e5e5">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
        <input type="checkbox" data-f="post-on" checked style="margin:0;cursor:pointer">
        <b>Post to the child case</b><span style="${MUTED}">· Xometry Only</span>
      </label>
      <div data-f="post-box" style="margin-top:5px">
        <div data-f="people" style="display:grid;grid-template-columns:auto 170px minmax(0,1fr) 16px;gap:5px 8px;align-items:center"></div>
        <span data-f="add-person" role="button" title="Add one more person to @mention"
          style="display:inline-block;margin-top:4px;color:#0176d3;cursor:pointer;user-select:none">+ Add person</span>
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
  const ownerOn = $('owner-on');
  const ownerInput = $('owner');
  const ownerHint = $('ownerhint');
  const postOn = $('post-on');
  const postBox = $('post-box');
  const peopleBox = $('people');
  const addPersonBtn = $('add-person');
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

  // ---------------- Кого упомянуть ----------------
  // Первая строка — CM (из плашки, без ×), «+ Add person» добавляет ещё строку (с ×).
  // Строка: подпись, имя, подсказка проверки (✓ / ⚠), кнопка удаления. display:contents — ячейки в общей сетке.
  const MAX_PEOPLE = 10;
  const people = [];   // [{ row, input, hint }]
  function addPerson(value = '', { isCm = false } = {}) {
    const row = document.createElement('div');
    row.style.display = 'contents';
    row.innerHTML = `
      <label style="${MUTED}" title="${isCm ? 'Case Manager' : 'One more person'}: @mentioned in the posts">${isCm ? 'CM' : '@'}</label>
      <input maxlength="80" spellcheck="false" placeholder="Name for @mention" style="${INPUT}">
      <span style="min-width:0;font-size:11px;line-height:13px;white-space:normal"></span>
      ${isCm ? '<span></span>' : '<span data-remove role="button" title="Remove" style="cursor:pointer;color:#706e6b;font-size:15px;line-height:1;user-select:none">×</span>'}`;
    const p = { row, input: row.querySelector('input'), hint: row.querySelector('span') };
    p.input.value = value;
    peopleBox.appendChild(row);
    people.push(p);
    addPersonBtn.style.display = people.length >= MAX_PEOPLE ? 'none' : '';
    return p;
  }
  function removePerson(p) {
    p.row.remove();
    people.splice(people.indexOf(p), 1);
    addPersonBtn.style.display = '';
    onPeopleChange();
  }
  const cmPerson = addPerson('', { isCm: true });
  const cmInput = cmPerson.input;
  // Все непустые имена, без повторов (первое — CM, если указан)
  const allNames = () => [...new Set(people.map((p) => p.input.value.trim()).filter(Boolean))];

  // ---------------- Пост ----------------
  // Шаблон: вторая строка — для информации CM (туда ставится курсор)
  const greeting = (names) => (names.length ? `Hi ${names.map((n) => `@${n}`).join(', ')},` : 'Hi,');
  const postTemplate = (names) => `${greeting(names)}\n\n\nPlease reply in the parent case ${parentNumber || '[parent case]'} `
    + 'when I can continue VQC.\nThanks';

  // Пост в родительский кейс — одна строка, упоминает только CM (других можно вписать: @Имя из списка — тоже упоминание)
  const parentTemplate = (cm) => `Sent child case to CM${cm ? ` @${cm}` : ''}`;

  // Пока текст не правили, он следует за списком людей и номером кейса.
  // Правили — меняем только приветствие (первая строка) и @старый CM в родительском посте.
  let autoPost = '';
  let autoParent = '';
  let lastNames = [];
  let lastCm = '';
  function refreshPost() {
    const names = allNames();
    const cm = cmInput.value.trim();
    if (postInput.value === autoPost) {
      autoPost = postTemplate(names);
      postInput.value = autoPost;
    } else if (names.join('|') !== lastNames.join('|')) {
      const from = greeting(lastNames);
      if (postInput.value.startsWith(from)) postInput.value = greeting(names) + postInput.value.slice(from.length);
    }
    if (parentInput.value === autoParent) {
      autoParent = parentTemplate(cm);
      parentInput.value = autoParent;
    } else if (cm !== lastCm && lastCm && parentInput.value.includes(`@${lastCm}`)) {
      parentInput.value = parentInput.value.replace(`@${lastCm}`, cm ? `@${cm}` : '').trim();
    }
    lastNames = names;
    lastCm = cm;
  }

  // Курсор — в строку для информации CM, если текст ещё шаблонный
  postInput.addEventListener('focus', () => setTimeout(() => {
    if (postInput.value !== autoPost) return;
    const pos = postInput.value.indexOf('\n') + 1;
    postInput.setSelectionRange(pos, pos);
  }, 0));

  // CM — из плашки (ERP: caseManagerName); пока поле не правили, следует за плашкой.
  // Проверка каждого имени: в Salesforce ровно один активный пользователь с таким именем — тогда @Имя будет упоминанием.
  let autoCm = '';
  let infoToken = 0;
  let peopleTimer = null;
  const cleanCm = (cm) => { const v = String(cm || '').trim(); return v === '—' || v === '-' ? '' : v; };

  function setHint(p, text, color = '#706e6b') {
    p.hint.style.color = color;
    p.hint.textContent = text;
  }

  // ---------------- Новый владелец ----------------
  // По умолчанию — CM; пока поле не правили, следует за CM. Пусто — кейс остаётся у создателя.
  // ownerCheck — результат проверки имени: { name, found, many } | null (ещё не проверяли)
  let autoOwner = '';
  let ownerCheck = null;
  const ownerName = () => (ownerOn.checked ? ownerInput.value.trim() : '');

  function setOwnerHint(text, color = '#706e6b') {
    ownerHint.style.color = color;
    ownerHint.textContent = text;
  }

  function showOwnerHint() {
    const name = ownerInput.value.trim();
    if (!ownerOn.checked) { setOwnerHint('The case stays with you'); return; }
    if (!name) { setOwnerHint('Empty: the case stays with you'); return; }
    if (!ownerCheck || ownerCheck.name !== name) { setOwnerHint(meta ? 'Checking…' : ''); return; }
    if (ownerCheck.found) setOwnerHint('✓ Will be the owner', '#2e844a');
    else setOwnerHint(ownerCheck.many ? '⚠ Several users with this name: write the full name or untick'
      : '⚠ Not found in Salesforce: fix the name or untick', '#8e030f');
  }

  function refreshOwner() {
    const cm = cmInput.value.trim();
    if (ownerInput.value === autoOwner) ownerInput.value = cm;
    autoOwner = cm;
    showOwnerHint();
  }

  // Номер родительского кейса и проверка всех имён (люди для @ и новый владелец) — одним запросом
  function loadInfo() {
    clearTimeout(peopleTimer);
    if (!meta || !openCaseId) return;
    const owner = ownerName();
    const names = [...new Set([...allNames(), owner].filter(Boolean))];
    const token = ++infoToken;
    people.forEach((p) => setHint(p, p.input.value.trim() ? 'Checking…'
      : p === cmPerson ? 'No CM: the post will start with "Hi,"' : ''));
    showOwnerHint();
    XT.sendToBackground({ type: 'SF_CHILD_CASE_INFO', parentId: openCaseId, names })
      .then((r) => {
        if (token !== infoToken) return;
        if (r.parentNumber && r.parentNumber !== parentNumber) {
          // Номер кейса пришёл: шаблон с ним (если текст не правили) или замена заглушки в тексте
          const untouched = postInput.value === autoPost;
          parentNumber = r.parentNumber;
          if (untouched) {
            autoPost = postTemplate(allNames());
            postInput.value = autoPost;
          } else {
            postInput.value = postInput.value.replace('[parent case]', parentNumber);
          }
        }
        people.forEach((p) => {
          const u = r.users[p.input.value.trim()];
          if (!u) return;
          if (u.found) setHint(p, '✓ Will be @mentioned', '#2e844a');
          else setHint(p, u.many ? '⚠ Several users with this name: no @mention'
            : '⚠ Not found in Salesforce: no @mention', '#a96404');
        });
        if (owner && r.users[owner]) ownerCheck = { name: owner, ...r.users[owner] };
        showOwnerHint();
      })
      .catch((err) => {
        if (token !== infoToken) return;
        people.forEach((p) => p.input.value.trim() && setHint(p, `⚠ ${err.message}`, '#8e030f'));
        if (owner) setOwnerHint(`⚠ ${err.message}`, '#8e030f');
      });
  }

  // Имена правят: текст постов и владелец — сразу, проверка в Salesforce — когда перестали печатать
  function onPeopleChange() {
    refreshPost();
    refreshOwner();
    clearTimeout(peopleTimer);
    people.forEach((p) => setHint(p, ''));
    peopleTimer = setTimeout(loadInfo, 600);
  }

  function onOwnerChange() {
    ownerInput.disabled = saving || !ownerOn.checked;
    showOwnerHint();
    clearTimeout(peopleTimer);
    peopleTimer = setTimeout(loadInfo, 600);
  }

  function setCm(cm) {
    autoCm = cleanCm(cm);
    cmInput.value = autoCm;
    refreshPost();
    refreshOwner();
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
    [jobInput, subjectInput, ownerOn, postOn, postInput, parentOn, parentInput, ...people.map((p) => p.input)]
      .forEach((el) => { el.disabled = saving; });
    ownerInput.disabled = saving || !ownerOn.checked;
    addPersonBtn.style.pointerEvents = saving ? 'none' : '';
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
    // Ошибочное имя владельца — не создаём (background проверит ещё раз, даже если проверка тут не успела)
    const owner = ownerName();
    if (owner && ownerCheck && ownerCheck.name === owner && !ownerCheck.found) {
      setStatus('Fix the owner name or untick Owner', '#8e030f');
      ownerInput.focus();
      return;
    }
    saving = true;
    updateControls();
    setStatus('Creating…');
    try {
      const c = await XT.sendToBackground({
        type: 'SF_CREATE_CHILD_CASE',
        input: {
          parentId: openCaseId, recordTypeId: rtSelect.value, jobId, subject,
          ownerName: owner,
          // Люди для @упоминаний — общие для обоих постов: в тексте упоминанием становится каждое «@Имя» из списка
          mentions: allNames(),
          post: postOn.checked ? { text: postText } : null,
          parentPost: parentOn.checked ? { text: parentText } : null,
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
      // Кейс и посты есть, а владелец не сменился — кейс остаётся у создателя
      if (c.ownerChange && !c.ownerChange.ok) {
        html += `<br><span style="color:#8e030f">⚠ Owner not changed: ${escapeHtml(c.ownerChange.error)}. `
          + 'The case stays with you: change the owner in Salesforce.</span>';
      }
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
  // Имена правят руками (строки добавляются — слушаем весь список)
  peopleBox.addEventListener('input', onPeopleChange);
  ownerInput.addEventListener('input', onOwnerChange);
  ownerOn.addEventListener('change', onOwnerChange);
  peopleBox.addEventListener('click', (event) => {
    const x = event.target.closest('[data-remove]');
    const p = x && people.find((q) => q.row.contains(x));
    if (p && !saving) removePerson(p);
  });
  addPersonBtn.addEventListener('click', () => {
    if (saving || people.length >= MAX_PEOPLE) return;
    addPerson().input.focus();
  });
  // Любая правка после создания — это уже новый кейс: Create снова доступен
  const unlock = () => {
    if (!justCreated) return;
    justCreated = false;
    updateControls();
  };
  [jobInput, subjectInput, ownerOn, ownerInput, postOn, postInput, parentOn, parentInput, peopleBox].forEach((el) => el.addEventListener(
    el.type === 'checkbox' ? 'change' : 'input', unlock));
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
      lastNames = [];
      // Новый кейс — снова только CM: добавленные люди прошлого кейса убираем
      people.slice(1).forEach((p) => { p.row.remove(); });
      people.length = 1;
      addPersonBtn.style.display = '';
      // Владелец: снова по умолчанию — CM (setCm подставит)
      ownerOn.checked = true;
      ownerInput.value = '';
      autoOwner = '';
      ownerCheck = null;
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
