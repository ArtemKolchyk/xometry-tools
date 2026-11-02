# Xometry Tools

Chrome extension (Manifest V3) that bundles Xometry helper scripts. Scripts are grouped by site
in the popup and can be turned on/off individually.

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this `xometry-extension` folder
3. Reload already open Salesforce tabs
4. Be logged in to ERP (www.xometry.com/erp) in the same browser profile

## Structure

- `manifest.json`
- `src/common/` — plain scripts (MV3 content scripts can't use ES `import`); each adds to `globalThis.XT`
  - `registry.js` — sites and scripts list; the popup is built from it
  - `settings.js` — on/off switches (`chrome.storage.sync`), extension-wide prefs `XT.prefs` (Pause all, ITAR user)
    and popup → content script actions. `XT.settings.watch` already honors Pause all
  - `storage-cache.js` — `chrome.storage.local` cache with an in-memory `Map` (synchronous `get`)
  - `erp-client.js` — ERP API for content scripts: URLs, `getJson`, `openTab` (via background)
  - `highlight-rules.js` — rules of the Text highlighter (`chrome.storage.sync`) and color presets.
    A rule has a name (notes), comma-separated texts and a place: all sites, one registry site or part of a URL.
    Custom URLs work only where the highlighter is loaded (`content_scripts` in `manifest.json`)
  - `quick-text-buttons.js` — buttons of Case quick text (`chrome.storage.sync`), color presets and page slots
  - `sf-dom.js` — Salesforce DOM helpers: shadow-DOM search, the Launch VQC cell on a Case
- `src/background/service-worker.js` — ERP requests with `credentials: 'include'`, opening tabs, ERP login status
- `src/content/salesforce-erp-sidebar.js` — port of `userscripts/salesforce-erp-sidebar.user.js`
- `src/content/salesforce-case-erp-button.js` — opens the job from an open Salesforce Case in ERP
- `src/content/salesforce-case-quick-text.js` — user-defined buttons on a Case that insert a text at the cursor.
  Each button sits in a slot tied to a page landmark (`MOUNTS`); «Arrange on page» lets you drag buttons between slots
  - `src/common/quick-text-buttons.js` — the buttons `[{ id, label, text, bg, color }]` in `chrome.storage.sync`,
    one item per button (8 KB per-item limit) + an index of ids for the order
  - `src/popup/quick-text-editor.js` — editor: label, colors, text, drag to reorder, delete, «+ Add button»
- `src/content/qcc-quick-verdict.js` — QC Center: Accept All / Reject All in the Submit Verdict dialog;
  port of `userscripts/QCC - Accept or Reject.txt`
- `src/content/text-highlighter.js` — general script: highlights text via the CSS Custom Highlight API (no DOM changes)
- `src/content/auto-refresh.js` — general script: reloads the page on a timer, waits while the user is active
  or a focused field has unsaved text. Per-script settings live in `XT.options` (defaults: `options` in the registry)
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
