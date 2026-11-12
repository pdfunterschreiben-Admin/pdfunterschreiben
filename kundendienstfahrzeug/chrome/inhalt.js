// Läuft auf T-Doc. Nur wenn das Programm „Kundendienstfahrzeug“ die Seite geöffnet hat (Parameter
// kdf=<Port>_<Schlüssel> in der Adresse), wird die Bezeichnung der gesuchten Nummer gelesen und über
// die Erweiterung an das Programm auf diesem Rechner geschickt. Sonst passiert nichts.
(function () {
  var p = new URLSearchParams(location.search), kdf = p.get('kdf') || '', nr = p.get('partNumber') || '';
  var K = 'kdfAuftrag';
  try {
    if (/^\d{4,5}_[0-9a-f]{32}$/.test(kdf) && nr) sessionStorage.setItem(K, JSON.stringify({ kdf: kdf, nr: nr, t: Date.now() }));
  } catch (e) {}
  var a = null;
  try { a = JSON.parse(sessionStorage.getItem(K) || 'null'); } catch (e) {}
  if (!a || Date.now() - a.t > 10 * 60 * 1000) return;
  function los() {
    readToyotaPart(a.nr, 45000).then(function (r) {
      // Nicht angemeldet: Auftrag behalten – nach der Anmeldung lädt T-Doc neu und es geht weiter
      if (r && r.error && /anmelden/i.test(r.error)) return;
      try { sessionStorage.removeItem(K); } catch (e) {}
      chrome.runtime.sendMessage({ kdf: a.kdf, nr: a.nr, name: r && r.name || '', error: r && r.error || '' });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', los); else los();
})();
