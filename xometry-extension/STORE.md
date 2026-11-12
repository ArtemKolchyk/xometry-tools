# Chrome Web Store — данные для публикации

Сборка: `powershell -ExecutionPolicy Bypass -File pack.ps1` → `dist/xometry-tools-<version>.zip`.
Перед каждой загрузкой поднимать `version` в `manifest.json` (магазин не примет ту же или меньшую версию).

## Store listing

**Name:** Xometry Tools (из manifest)

**Summary** (из manifest, ≤132 символов):
Helper tools for the Xometry VQC team in Salesforce and QC Center: ERP cards, highlights, partner rating, quick text and more.

**Description:**
```
Internal helper tools for the Xometry VQC team. Requires access to Xometry ERP.

Salesforce:
• ERP sidebar — job, partner and customer details next to Salesforce records
• Open in ERP — opens the job of the current Case in ERP
• Quick text — your own buttons that insert prepared text into a Case
• Partner rating — personal red / yellow / green marks for partners (right-click menu)
• Partners and Customers — your own lists with notes; matching ERP cards get a warning sign
• Additional VQC Email check — reminds to add the case's Additional VQC Email to CC before sending
• Text highlighter — highlights words and phrases you choose
• Auto refresh — reloads the page on a timer, never while you are typing

QC Center:
• Accept All / Reject All in the Submit Verdict dialog
• Text highlighter

Every tool can be turned on or off in the popup. Settings can be exported and imported.
The extension talks only to Xometry ERP using your existing login; no data is sent anywhere else.
```

**Category:** Workflow & Planning (или Developer Tools)
**Language:** English

**Графика** (обязательно):
- Иконка 128×128 — `icons/icon128.png` (уже есть)
- Минимум 1 скриншот 1280×800 или 640×400 (PNG/JPEG). Замазать имена клиентов, email, номера джобов
- Small promo tile 440×280 — обязателен для публичных/unlisted

## Privacy practices

**Single purpose:**
```
Adds productivity tools for the Xometry VQC team to Salesforce and Xometry QC Center: showing related ERP job data, quick text insertion, text highlighting and verdict shortcuts.
```

**Permission justifications:**
- `storage`: `Stores the user's settings (enabled tools, highlight rules, quick-text buttons), personal partner ratings and a short-lived cache of ERP responses.`
- `contextMenus`: `Adds a "Partner rating" item to the right-click menu on Salesforce pages so the user can mark a partner link or selected name.`
- `declarativeNetRequestWithHostAccess`: `Sets the Origin and Referer headers to www.xometry.com on the extension's own requests to the Xometry ERP GraphQL endpoint, which rejects requests with an extension origin. The requests read job and order data and, only when the user turns on the "Shipping block toggle" tool and confirms each change, switch the job's Partner Shipping Block. One static rule, no other requests are changed.`
- Host permissions (`api.xometry.com`, `www.xometry.com/api`, `www.xometry.com/graphql`): `The background service worker requests job, partner and customer data from Xometry ERP APIs with the user's own ERP session, to show it next to Salesforce records.`
- Optional `cookies` + optional host `*.my.salesforce.com` (не запрашиваются при установке; кнопкой в popup — для админского Case timeline и для Queue summary в режиме «from last Pending»): `Optional, requested only when the user grants it in the popup (Case timeline, or Queue summary counting from the last Pending status): reads the user's own Salesforce session to load case history (owner and status changes) from the Salesforce API and show it on Salesforce case lists.`
- Content scripts (`*.lightning.force.com`, `*.xometry.com/qc-center-app`): `The tools run only on Salesforce Lightning and Xometry QC Center pages, where they add buttons, a sidebar and highlights.`

**Remote code:** No, I am not using remote code.

**Data usage** — отметить:
- Personally identifiable information (имена/email клиентов из ERP отображаются на странице)
- Website content

И все три подтверждения:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:**
https://github.com/ArtemKolchyk/xometry-tools/blob/main/xometry-extension/PRIVACY.md
(репозиторий должен быть публичным, иначе нужен другой хостинг)
