// Verbindung zum Programm „Kundendienstfahrzeug“ auf diesem Rechner.
//
// 1. Im Hintergrund (bevorzugt): Das Programm ist über „Native Messaging“ verbunden und schickt
//    Aufträge. T-Doc wird dann in einem minimierten Fenster geöffnet, die Bezeichnung gelesen und
//    das Fenster wieder geschlossen – man sieht davon nichts.
// 2. Sichtbarer Tab (Notlösung): Das Programm hat T-Doc selbst geöffnet; das Ergebnis geht per
//    HTTP an 127.0.0.1 zurück und der Tab wird geschlossen.

const HOST = 'de.kundendienstfahrzeug.tdoc';
let port = null;
const fenster = {}; // Auftrag (Schlüssel) → Fenster-ID

function verbinden() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST);
    port.onMessage.addListener(auftrag);
    port.onDisconnect.addListener(() => { port = null; setTimeout(verbinden, 20000); });
  } catch (e) { port = null; }
}
chrome.runtime.onStartup.addListener(verbinden);
chrome.runtime.onInstalled.addListener(verbinden);
verbinden();

async function auftrag(m) {
  if (!m || m.typ !== 'tdoc' || !/^https:\/\/tdoc\.toyota-forklifts\.eu\//.test(String(m.url || '')) || !/^[0-9a-f]{32}$/.test(String(m.token || ''))) return;
  try {
    const w = await chrome.windows.create({ url: m.url, state: 'minimized', focused: false });
    fenster[m.token] = w.id;
    // Sicherheitsnetz: nach 90 Sekunden aufräumen
    setTimeout(() => { if (fenster[m.token]) { chrome.windows.remove(fenster[m.token]).catch(() => {}); delete fenster[m.token]; } }, 90000);
  } catch (e) {
    if (port) port.postMessage({ token: m.token, error: 'T-Doc konnte im Hintergrund nicht geöffnet werden.' });
  }
}

chrome.runtime.onMessage.addListener(function (m, sender) {
  const t = /^(\d{4,5})_([0-9a-f]{32})$/.exec(String(m && m.kdf || ''));
  if (!t || !sender.tab || !/^https:\/\/tdoc\.toyota-forklifts\.eu\//.test(sender.url || '')) return;
  const tok = t[2], erg = { token: tok, nr: String(m.nr || '').slice(0, 40), name: String(m.name || '').slice(0, 250), error: String(m.error || '').slice(0, 300), version: chrome.runtime.getManifest().version };
  // Hintergrund-Auftrag
  if (fenster[tok] !== undefined) {
    if (m.anmelden) { // nicht bei Toyota angemeldet: Fenster zeigen, damit man sich anmelden kann
      chrome.windows.update(fenster[tok], { state: 'normal', focused: true }).catch(() => {});
      return;
    }
    if (port) port.postMessage(erg);
    chrome.windows.remove(fenster[tok]).catch(() => {});
    delete fenster[tok];
    return;
  }
  if (m.anmelden) return;
  // sichtbarer Tab, vom Programm geöffnet
  fetch('http://127.0.0.1:' + t[1] + '/api/tdoc/ergebnis', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(erg)
  }).then(r => { if (r.ok && m.name) chrome.tabs.remove(sender.tab.id); }).catch(() => {});
});

// Notweg (keine Hintergrund-Verbindung): den vom Programm geöffneten T-Doc-Tab sofort in ein
// minimiertes Fenster schieben, damit er möglichst nicht stört.
chrome.tabs.onCreated.addListener(tab => verschieben(tab));
chrome.tabs.onUpdated.addListener((id, info, tab) => { if (info.url) verschieben(tab); });
const verschoben = new Set();
function verschieben(tab) {
  const u = String(tab.pendingUrl || tab.url || '');
  if (!/^https:\/\/tdoc\.toyota-forklifts\.eu\/.*[?&]kdf=\d{4,5}_[0-9a-f]{32}/.test(u) || verschoben.has(tab.id)) return;
  if (Object.values(fenster).includes(tab.windowId)) return; // schon unser Hintergrundfenster
  verschoben.add(tab.id);
  chrome.windows.create({ tabId: tab.id, state: 'minimized', focused: false }).catch(() => {});
}
