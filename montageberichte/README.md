# Kundendienst Montageberichte

Büro-Programm (Windows): zeigt die unterschriebenen Berichte der Monteure aus der Service-Mappe –
je Monteur und Kalenderwoche – und fügt sie je Auftragsnummer zu einer PDF zusammen:
erst Montagebericht, dann UVV-Bericht, dann DGUV-V3-Bericht.

Ablage: `Dokumente\Kundendienst Montageberichte\<Monteur>\<Jahr> KW <nn>\<Auftragsnummer>.pdf`

## Wie die Berichte ankommen
Die Service-Mappe (ab 1.20.51) schickt jeden unterschriebenen Bericht beim Speichern, Drucken oder
Mailen mit `mb_hoch` an den Anmeldeserver. Der legt die PDF in Google Drive unter
„Kundendienst Montageberichte/<Monteur>“ ab und schreibt eine Zeile ins Blatt „Montageberichte“.
Die Kalenderwoche richtet sich nach dem Datum im Bericht (ISO-Woche).

## Wer darf das Programm benutzen?
Anmeldung wie bei den anderen Programmen. Zusätzlich muss im Blatt „Nutzer Montageberichte“ in der
Spalte „Berechtigt (ja)“ ein `ja` stehen (Admins dürfen immer).

## Server
`admin/Montageberichte.js` gehört ins Apps-Script-Projekt (ohne die letzte `module.exports`-Zeile),
das Routing steht in `admin/Code.gs` (`mb_hoch`, `app: 'montageberichte'`).

## Versionen
`TESTVERSION` höher als `VERSION` → Testversion im Vorab-Release `montageberichte-adminkanal`.
`VERSION` neu → `montageberichte-vX.Y.Z` und `montageberichte-stabil`.
