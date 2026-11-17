# Regeln für dieses Repository (Service-Mappe, Kundendienstfahrzeug, Admin-App, Server)

## Server (Apps Script „PDF Unterschreiben Anmeldung“, Konto pdfunterschreiben@gmail.com) – WICHTIG
Mehrere Chats/Sitzungen ändern denselben Server. Am 17.11.2026 hat ein Einspielen aus einer veralteten Kopie den
kompletten Montageberichte-Server, die Admin-Schalter und weitere Funktionen gelöscht (Version 63). Deshalb:

- Die Live-Datei (eine einzige Datei `Code.gs` im Projekt) besteht aus, in dieser Reihenfolge:
  `admin/Code.gs` + `admin/Typenschild.js` + `admin/QrCode.js` + `admin/Vorlagen.js` + `admin/Kundendienstfahrzeug.js`
  + `server/Montageberichte.js` aus **pdfunterschreiben-Admin/kundendienst-montageberichte**
  (jeweils ohne die letzte `module.exports`-Zeile; in `admin/Code.gs` steht statt KEY ein Platzhalter).
- **Nie die ganze Live-Datei ersetzen.** Immer nur den geänderten Abschnitt im Editor austauschen
  (Monaco: `monaco.editor.getModels()[0]`, gezielt per Ankertext, jeder Anker genau einmal vorhanden).
- **Vor jedem Einspielen** den Live-Stand lesen und prüfen, dass er die eigenen Ankertexte enthält und nichts
  Fremdes fehlt (z. B. `function mbHoch`, `function kdKrypto`, `function adminFarbe`, `wlSollPruefen`).
- Nach dem Speichern: Bereitstellen → Bereitstellungen verwalten → Bearbeiten → Version „Neue Version“ → Beschreibung → Bereitstellen.
- Danach die eigene Änderung **und** einige fremde Anfragen testen (z. B. `mb_pubkey` mit KEY → `OK\n…`).
- Änderungen, die nur live gemacht werden, sofort auch hier ins Repository übernehmen, sonst gehen sie beim nächsten Einspielen verloren.
- Alte Versionen: Projektverlauf im Editor (links „Projektverlauf“), dort steht der vollständige Code jeder Version.

## Verschlüsselung (seit Service-Mappe 1.20.57–1.20.59)
- Fotos/Kunden-Unterschrift vom Handy: `fotokrypto.go` + Handy-Seite (Repository service-mappe/service-mappe.github.io, `handy/index.html`), Format „SMV1“.
- Montageberichte an den Kundendienst: `mbkrypto.go` (öffentlicher Schlüssel des Büros, Format „SMB1“) – Gegenstück im Büro-Programm `schluessel.go`.
- Kundendaten: `kundenkrypto.go` (Format „SKD1“, Geräteschlüssel + automatische Weitergabe, Server `kdKrypto`).
- Formate nicht ändern, ohne alle Gegenstücke mitzuziehen.
