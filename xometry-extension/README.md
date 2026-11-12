# Xometry Tools

Chrome extension (Manifest V3) that bundles Xometry helper scripts. Scripts are grouped by site
in the popup and can be turned on/off individually.

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this `xometry-extension` folder
3. Reload already open Salesforce tabs
4. Be logged in to ERP (www.xometry.com/erp) in the same browser profile

## Publish to Chrome Web Store

1. Bump `version` in `manifest.json` (and `package.json`)
2. `powershell -ExecutionPolicy Bypass -File pack.ps1` → `dist/xometry-tools-<version>.zip`
3. Upload the zip in the Developer Dashboard. Listing texts and permission justifications: `STORE.md`,
   privacy policy: `PRIVACY.md`

## Structure

- `manifest.json`
- `src/common/` — plain scripts (MV3 content scripts can't use ES `import`); each adds to `globalThis.XT`
  - `registry.js` — sites and scripts list; the popup is built from it
  - `settings.js` — on/off switches (`chrome.storage.sync`), extension-wide prefs `XT.prefs` (Pause all, ITAR user)
    and popup → content script actions. `XT.settings.watch` already honors Pause all
  - `storage-cache.js` — `chrome.storage.local` cache with an in-memory `Map` (synchronous `get`);
    all caches of a page share one read of `chrome.storage.local`
  - `erp-client.js` — ERP API for content scripts (via background): URLs, `getJson`, `graphql`, `openTab`, and shared
    loaders `partnerStats(vendor)` and `jobOrderInfo(jobId)` (GraphQL PartnerJob → GetOrderDetails: notes, customer,
    CM, staff notes, partner). `{ fresh: true }` skips the background's 1-minute response cache
  - `text-scan.js` — one shared walk over the page text for Text highlighter and Partner rating; re-walks only
    after DOM changes (MutationObserver, also on shadow roots) or every 10 s
  - `highlight-rules.js` — rules of the Text highlighter (`chrome.storage.sync`) and color presets.
    A rule has a name (notes), comma-separated texts and a place: all sites, one registry site or part of a URL.
    Custom URLs work only where the highlighter is loaded (`content_scripts` in `manifest.json`)
  - `quick-text-buttons.js` — buttons of Case quick text (`chrome.storage.sync`), color presets and page slots
  - `sf-dom.js` — Salesforce DOM helpers: shadow-DOM search, the Launch VQC cell and the job ID of a Case
    (both remembered for 400 ms, since several scripts ask on every tick), `escapeHtml`, case list table helpers
    (`headerLabels`, `isCheckedCell`, `rowCells`)
- `src/background/service-worker.js` — ERP requests with `credentials: 'include'` (identical requests in flight are
  merged, answers kept 1 min in memory), GraphQL with a fixed list of operations, opening tabs, ERP login status (REST only)
- `src/rules/erp-graphql-origin.json` — `declarativeNetRequest` rule: sets `Origin`/`Referer` to www.xometry.com
  on POSTs to the ERP GraphQL endpoint, which rejects the extension origin with 403
- `src/content/salesforce-queue-summary.js` — Queue summary bar in the case list header (between the list title and
  the buttons): total / ITAR / non-ITAR and cases by status, counted from the table on the page (columns found by
  their header, no ERP requests). If the list has more cases than loaded, shows "N of M". Overdue: more than
  N hours (set on the bar) since Date/Time Opened or since the last Pending — the latter reads CaseHistory via
  the Salesforce API (same optional access as Case timeline, `XT.caseHistory`; re-read every 5 min or when the
  row's status changes).
- `src/content/salesforce-case-info-panel.js` — Case ERP panel under the Case header: customer, partner with jobs completed,
  CM, internal notes, staff notes (collapsed), ▲! for watchlist names, Partner Shipping Block (the job's
  `virtualInspection`: true = the partner cannot ship). The state is always shown; switching needs the separate
  `sf-case-shipping-block` script (off by default), asks to confirm and re-reads ERP afterwards. The background
  refuses the `UpdateVirtualInspection` mutation unless that script is on (and Pause all is off)
- Timers of page scripts skip work in background tabs (`document.hidden`) and catch up on `visibilitychange`
- `npm run check` (`check.js`) — `node --check` on every `src/**/*.js`
- `src/content/salesforce-erp-sidebar.js` — port of `userscripts/salesforce-erp-sidebar.user.js`
- `src/content/salesforce-case-erp-button.js` — opens the job from an open Salesforce Case in ERP
- `src/content/salesforce-case-cc-check.js` — holds Send in a Case email when the case's Additional VQC Email
  (if it differs from Web Email) is not among the recipients; dialog: add to CC & send / send without it / cancel.
  Field values are read from the visible Details tab and remembered per case. If the address does not become a CC pill,
  nothing is sent: it is copied to the clipboard for a manual paste
- `src/content/salesforce-case-quick-text.js` — user-defined buttons on a Case that insert a text at the cursor.
  Each button sits in a slot tied to a page landmark (`MOUNTS`); «Arrange on page» lets you drag buttons between slots
  - `src/common/quick-text-buttons.js` — the buttons `[{ id, label, text, bg, color }]` in `chrome.storage.sync`,
    one item per button (8 KB per-item limit) + an index of ids for the order
  - `src/popup/quick-text-editor.js` — editor: label, colors, text, drag to reorder, delete, «+ Add button»
- `src/content/partner-rating.js` — personal 🔴 🟡 🟢 rating of partners. Right-click a contact link or selected
  text → **Partner rating** (menu: `contextMenus` in `service-worker.js`, which sends `XT_RATE` to the tab).
  Highlights the whole link text by Salesforce record ID, or plain text equal to the name (no substrings)
  - `src/common/partner-rating.js` — storage in `chrome.storage.local` (personal, not synced, not in the settings backup):
    `{ 'id:<15-char id>' | 'name:<lowercase name>': { name, rating, note, updated } }`
    Editors save per-key patches via `XT.partnerRating.apply` so a right-click mark made meanwhile is not overwritten
  - `src/popup/partner-rating-editor.js` — compact popup view: color filter chips, search, recent 8 (or up to 30 matches),
    one line per partner, click to expand and edit; «Manage all» opens the full page
  - `src/popup/partner-rating.html` + `partner-rating-page.js` — full list as a sortable table, inline edit,
    add by name, export/import
  - `src/popup/partner-rating-ui.js` — shared bits: filter chips, color dots, per-key saver, export file
- Partners / Customers (popup pages at the bottom of the menu, `page: 'watchlist'` in the registry):
  user lists `[{ text, note, color }]` in `chrome.storage.sync` (`xt:watchlist:partners|customers`, in the backup).
  ERP sidebar cards whose partner company (or customer company / contact / email) contains an entry's text get a ▲! sign
  - `src/common/watchlist.js` — storage and matching (case and punctuation ignored); `src/popup/watchlist-editor.js` — editor
- Admin mode (`XT.prefs.adminMode`): scripts or sites with `admin: true` are hidden in the popup and not started.
  Unlock: 5 clicks on the version in the popup footer + password (SHA-256 in `popup.js`); turn off in Settings
- Case timeline (admin, `src/common/sf-case-history.js`): on ERP sidebar cards — when the case was first taken by a person,
  when it went to Pending, time spent vs. the norm (7 min per part + 3 min, rounded up to 10). Reads `CaseHistory`
  via the Salesforce REST API with the `sid` cookie of `<org>.my.salesforce.com` (optional `cookies` +
  `*.my.salesforce.com` permissions, requested from the popup)
- `src/content/qcc-quick-verdict.js` — QC Center: Accept All / Reject All in the Submit Verdict dialog;
  port of `userscripts/QCC - Accept or Reject.txt`
- `src/content/text-highlighter.js` — general script: highlights text via the CSS Custom Highlight API (no DOM changes)
- `src/content/auto-refresh.js` — general script: reloads the page on a timer. Activity = clicks and key presses
  in the tab (not mouse movement/scroll). Never reloads while a focused field or any visible editor (contenteditable,
  textarea) has text — also inside same-origin iframes (the Salesforce email editor is an iframe). Per-script settings live in `XT.options` (defaults: `options` in the registry)
- `src/popup/` — popup (also used as the options page); `highlight-editor.js` — rules editor;
  `settings-page.js` — the Settings page: Pause all, ITAR user, ERP and cache, backup (export/import), storage, about

## General scripts

Scripts of the `general` site run on every supported (non-stub) site. Their files are listed in
**each** site's `content_scripts` block in `manifest.json` — not on `<all_urls>`, to keep permissions narrow.
Exception: Auto refresh is not loaded on QC Center (not needed there yet).
- `icons/`

## Adding a script

1. Add an entry to `scripts` (and to `sites` if it's a new site) in `src/common/registry.js`
2. Add a `content_scripts` block in `manifest.json`: the `src/common/*.js` files it needs + the script
3. In the script, wrap startup in `start()`/`stop()` and call
   `XT.settings.watch(SCRIPT_ID, (on) => (on ? start() : stop()))`
4. If it calls new domains, add them to `host_permissions` (only to the background-called APIs)

## Notes

- The original Tampermonkey scripts in `../userscripts/` are kept untouched.
- Content-script match patterns don't need to be in `host_permissions`.
