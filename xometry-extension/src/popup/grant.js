// Окно выдачи доступа к Salesforce API (открывает background по кнопке в форме Child case).
// chrome.permissions.request работает только по клику на странице расширения — поэтому отдельное окно.
'use strict';

const SF_ACCESS = { permissions: ['cookies'], origins: ['https://*.my.salesforce.com/*'] };
const btn = document.getElementById('grant');
const status = document.getElementById('status');

function done() {
  btn.disabled = true;
  status.className = 'ok';
  status.textContent = 'Access granted. This window will close — go back to the case.';
  setTimeout(() => window.close(), 1200);
}

chrome.permissions.contains(SF_ACCESS).then((has) => { if (has) done(); });

btn.addEventListener('click', () => {
  chrome.permissions.request(SF_ACCESS)
    .then((ok) => {
      if (ok) { done(); return; }
      status.className = 'bad';
      status.textContent = 'Not granted. Child case cannot create cases without it.';
    })
    .catch((e) => { status.className = 'bad'; status.textContent = e.message; });
});
