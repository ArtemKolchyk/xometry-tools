# Xometry Tools — Privacy Policy

_Last updated: 2026-11-05_

Xometry Tools is a browser extension for members of the Xometry VQC team. It adds helper tools to
Salesforce (`*.lightning.force.com`) and Xometry QC Center.

## What data the extension handles

- **ERP data.** To show job, partner and customer details next to Salesforce records, the extension
  requests them from Xometry ERP APIs (`api.xometry.com`, `www.xometry.com/api`) using the user's
  existing ERP login session. This data may include company names, contact names and email addresses.
  It is only displayed to the user and kept in a short-lived local cache (`chrome.storage.local`).
- **User settings.** On/off switches, highlight rules, quick-text buttons and similar preferences are
  stored in `chrome.storage.sync`, so Chrome may sync them between the user's own browsers.
- **Partner ratings.** Ratings and notes the user adds are stored only locally (`chrome.storage.local`).

## What the extension does not do

- It does not send any data to the developer or to any third party. The only network requests go to
  Xometry ERP APIs, which the user is already authorized to access.
- It does not use analytics, tracking, advertising or remote code.
- It does not sell or transfer user data, and does not use it for any purpose other than the
  features described above.

## Removing data

Uninstalling the extension deletes all locally stored data. Settings can also be exported or cleared
from the extension's Settings page.

## Contact

Questions: open an issue at https://github.com/ArtemKolchyk/xometry-tools
