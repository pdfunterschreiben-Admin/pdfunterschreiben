# PDF zu PowerPoint

Wandelt eine Präsentation, die als PDF vorliegt, in eine PowerPoint-Datei (.pptx) um – mit bearbeitbarem Text. Der Hintergrund einzelner oder aller Folien lässt sich per Klick austauschen (Farbe, eigenes Bild, Weiß oder Original). Vorhandene .pptx-Dateien können ebenfalls geöffnet werden, um nur den Hintergrund zu ändern.

Aufgebaut wie „PDF Unterschreiben & Dokumentation“: eine einzige exe für Setup, Programm und Updates, Oberfläche im eigenen Edge-Fenster, Anmeldung mit Freischaltcode, Updates über GitHub mit Testkanal.

## Installieren

1. Unter **Releases** das Release **„PDF zu PowerPoint (aktuelle Version …)“** öffnen und `PDF-zu-PowerPoint-Setup.exe` herunterladen.
2. Doppelklick. Falls Windows „Der Computer wurde durch Windows geschützt“ anzeigt: **Weitere Informationen → Trotzdem ausführen**.
3. Mit **Ja** bestätigen. Keine Administratorrechte nötig.

Danach liegt „PDF zu PowerPoint“ auf dem Desktop und im Startmenü.

## So funktioniert die Umwandlung

Jede PDF-Seite wird in drei Ebenen zerlegt (PDFium als WebAssembly, läuft komplett auf dem Rechner):

- **Hintergrund** – alles, was fast die ganze Seite bedeckt und unter dem Text liegt → echter Folienhintergrund in PowerPoint
- **Grafik** – Logos, Balken, Formen, Bilder → ein transparentes Bild auf der Folie
- **Text** – bearbeitbare Textfelder (Schrift, Größe, Farbe, Aufzählungen, Zeilenabstand); wahlweise als Bild

## Neue Version veröffentlichen

Zwei Kanäle, eigene Release-Namen (stören PDF Unterschreiben nicht):

1. **Testen:** In `pptx/TESTVERSION` eine höhere Nummer eintragen als in `pptx/VERSION` und nach `main` pushen. Jeder weitere Push in `pptx/` baut eine neue Testversion (`1.1.0-test.N`) ins Vorab-Release `pptx-adminkanal`. Die bekommen nur Admins mit eingeschaltetem „Testkanal“.
2. **Freigeben:** In `pptx/VERSION` dieselbe Nummer eintragen und pushen. Dann landet die Version im Release `pptx-stabil` (dort suchen alle Programme nach Updates) und als Archiv in `pptx-vX.Y.Z`.

Die erste Zeile der Commit-Nachricht erscheint in Testversionen als Update-Hinweis.

## Anmeldung

Gleicher Anmeldeserver wie PDF Unterschreiben (`admin/Code.gs`). Das Programm schickt `app: "pptx"` mit; die Nutzer landen im Blatt **„Nutzer PDF zu PowerPoint“** der Google-Tabelle (Sperren dort in der Spalte „Gesperrt (ja)“).

## Lokal testen (Linux/macOS)

```
cd pptx
# PDFium-WASM nach web/lib/ legen (siehe .github/workflows/pptx-release.yml)
PPTX_DEV=1 go run .
```

Die leere Grundvorlage `assets/vorlage.pptx` stammt aus python-pptx (MIT-Lizenz).
