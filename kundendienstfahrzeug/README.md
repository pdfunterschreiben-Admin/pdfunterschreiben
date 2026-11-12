# Kundendienstfahrzeug (früher „Wagenlager“)

Ersatzteile im Kundendienstfahrzeug, dazu **Kennzeichen** und **Fahrer**: **Fahrzeugbestand** (was im Wagen liegt, mit Lagerort und Stückzahl) und **Fehlende Ersatzteile** (was nachbestellt werden muss).

Aufgebaut wie die Service-Mappe und „PDF zu PowerPoint“: eine einzige exe für Setup, Programm und Updates, Oberfläche im eigenen Edge-Fenster, Anmeldung mit Name + Arbeits-E-Mail und Freischaltcode, Updates über GitHub mit Testkanal. Ersetzt das frühere Wagenlager (Windows-Forms-Version mit ChatGPT-Konto) – das Setup entfernt es (Ordner, Verknüpfungen, Eintrag unter „Apps & Features“).

## Wo liegt der Bestand?

Auf dem Anmeldeserver der Service-Mappe (Apps Script, `admin/Kundendienstfahrzeug.js`; intern weiter `app: "wagenlager"`) in der Google-Tabelle:

- Blatt **„Kundendienstfahrzeug“** – alle Teile, je Arbeits-E-Mail getrennt
- Blatt **„Kundendienstfahrzeuge“** – je Nutzer Kennzeichen und Fahrer
- Blatt **„Kundendienstfahrzeug Katalog“** – Teilenummer → Bezeichnung, für alle gemeinsam (füllt sich beim Speichern)
- Blatt **„Nutzer Kundendienstfahrzeug“** – wer das Programm/die Handy-Seite nutzt, Sperren in „Gesperrt (ja)“

Das Programm speichert den zuletzt geladenen Stand zusätzlich lokal (`%APPDATA%\Kundendienstfahrzeug\bestand.json`), damit er ohne Internet angezeigt werden kann.

## Handy

`docs/kundendienstfahrzeug/index.html` (GitHub Pages: https://pdfunterschreiben-admin.github.io/pdfunterschreiben/kundendienstfahrzeug/). Anmeldung mit derselben Arbeits-E-Mail und Code; Bestand ansehen, −/＋, Teile anlegen, „Eingetroffen“. Das Programm zeigt dafür einen QR-Code.

## Funktionen

- Teilenummern werden vereinheitlicht: Toyota `12345-ABCDE-12`, BT `BT1234567` (auch nur 7 Ziffern)
- Bezeichnung kommt automatisch aus dem gemeinsamen Katalog
- Teilenummer vom Foto (Google-Texterkennung über den Server, sonst Windows-Texterkennung)
- T-Doc: Nummer in T-Doc öffnen; gesammelte Teile über das Lesezeichen „T-Doc → Excel“ der Service-Mappe einfügen
- −/＋ in der Liste (mehrere Klicks = eine Änderung), aufgebraucht → „Nachbestellen“, Fehlteil → „✓ Eingetroffen“
- Kennzeichen und Fahrer (oben im Programm und auf dem Handy, wird beim ersten Start abgefragt)
- Excel-Export (Bestand + Fehlende Ersatzteile, oben Kennzeichen/Fahrer/Stand) und -Import (auch die Excel-Datei des früheren Wagenlagers)

## Neue Version veröffentlichen

1. **Testen:** In `kundendienstfahrzeug/TESTVERSION` eine höhere Nummer als in `kundendienstfahrzeug/VERSION` eintragen und pushen → Vorab-Release `kundendienstfahrzeug-adminkanal`, nur für den Admin mit eingeschaltetem Testkanal.
2. **Freigeben:** In `kundendienstfahrzeug/VERSION` dieselbe Nummer eintragen und pushen → Releases `kundendienstfahrzeug-vX.Y.Z` und `kundendienstfahrzeug-stabil` (dort suchen alle Programme nach Updates). Download-Link für Kollegen: `https://github.com/pdfunterschreiben-Admin/pdfunterschreiben/releases/download/kundendienstfahrzeug-stabil/Kundendienstfahrzeug-Setup.exe`

## Server einspielen (einmalig)

Im Apps-Script-Projekt „PDF Unterschreiben Anmeldung“: `admin/Code.gs` ersetzen (KEY wie bisher eintragen) und `admin/Kundendienstfahrzeug.js` als weitere Datei anlegen (ohne die letzte `module.exports`-Zeile). Dann **Bereitstellen → Bereitstellungen verwalten → Bearbeiten → Neue Version** (gleiche Adresse bleibt).

## Lokal testen (Linux/macOS)

```
cd kundendienstfahrzeug
node test/server-test.js                         # Server-Logik (Nachbildung von Google)
node test/server-nachbildung.js 8765 &           # Nachbildung als Server
KDF_DEV=1 KDF_TEST_SERVER=http://127.0.0.1:8765/ KDF_TEST_KEY=testschluessel go run .
node test/oberflaeche-test.js http://127.0.0.1:PORT/ http://127.0.0.1:8765/ /tmp   # braucht Playwright
```

## Ersatzteilliste

`web/ersatzteilliste.json` ist dieselbe Liste wie im Reparaturauftrag der Service-Mappe (Außendienst & Werkstatt, Batteriedienst). Beim Bauen kopiert der Workflow immer den aktuellen Stand aus `web/ersatzteilliste.json` des Repositorys. Die Bezeichnungen daraus werden auch beim Eintippen einer Nummer vorgeschlagen.
