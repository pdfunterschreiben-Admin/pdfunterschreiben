// Schickt das Ergebnis an das Programm auf diesem Rechner (nur 127.0.0.1) und schließt den T-Doc-Tab.
chrome.runtime.onMessage.addListener(function (m, sender) {
  var t = /^(\d{4,5})_([0-9a-f]{32})$/.exec(String(m && m.kdf || ''));
  if (!t || !sender.tab || !/^https:\/\/tdoc\.toyota-forklifts\.eu\//.test(sender.url || '')) return;
  fetch('http://127.0.0.1:' + t[1] + '/api/tdoc/ergebnis', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: t[2], nr: String(m.nr || '').slice(0, 40), name: String(m.name || '').slice(0, 250), error: String(m.error || '').slice(0, 300), version: chrome.runtime.getManifest().version })
  }).then(function (r) {
    if (r.ok && m.name) chrome.tabs.remove(sender.tab.id);
  }).catch(function () {});
});
