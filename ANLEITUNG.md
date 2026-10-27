# Gewürzregal – Android-App

Alles läuft über GitHub, wie bei deinen anderen Programmen: GitHub baut die APK, veröffentlicht sie als Release, und die App meldet sich selbst, wenn es eine neue Version gibt. Die gemeinsame Liste liegt als Datei in einem **privaten** GitHub-Repository.

---

## 1. Zwei Repositories anlegen (einmalig)

1. **`gewuerzregal`** – Sichtbarkeit **Public**. Hier kommt der App-Code rein, hier liegen die Updates.
2. **`gewuerzregal-daten`** – Sichtbarkeit **Private**, leer lassen. Hier speichert die App die Liste (`vorrat.json`, legt sie selbst an).

In `www/config.js` beide Namen eintragen, z. B. `"meinkonto/gewuerzregal"` und `"meinkonto/gewuerzregal-daten"`.

## 2. Zugangsschlüssel für die Daten (einmalig)

GitHub → Profilbild → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
- Name: `Gewürzregal`, Ablauf: **No expiration** (oder 1 Jahr, dann jährlich erneuern)
- Repository access: **Only select repositories → `gewuerzregal-daten`**
- Permissions → Repository permissions → **Contents: Read and write**
- Token kopieren (beginnt mit `github_pat_…`)

Der Token darf nur diese eine Datenliste lesen und schreiben, sonst nichts.

## 3. Code hochladen + Secrets

1. Alle Dateien aus diesem Ordner in `gewuerzregal` hochladen (Ordner `.github` und `scripts` mit).
2. `gewuerzregal` → **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Inhalt |
|---|---|
| `APP_USER` | Benutzername für die App, z. B. `regal` |
| `APP_PASSWORD` | Passwort für die App |
| `DATA_TOKEN` | der Token aus Schritt 2 |
| `KEYSTORE_PASSWORD` | aus `SECRETS_LESEN.txt` |
| `KEYSTORE_BASE64` | kompletter Inhalt von `KEYSTORE_BASE64.txt` |

Der Token wird beim Bauen mit Benutzer + Passwort **verschlüsselt** in die App gelegt. Ohne den richtigen Zugang kommt niemand an die Liste – auch nicht, wer die APK hat.

## 4. App bauen

`gewuerzregal` → **Actions → App bauen und veröffentlichen → Run workflow** → Version `1.0.0`.
Nach ca. 5–8 Minuten liegt unter **Releases** die Datei `Gewuerzregal.apk`.

## 5. Auf die Handys

`https://github.com/pdfunterschreiben-Admin/gewuerzregal/releases/latest` am Handy öffnen → `Gewuerzregal.apk` laden → installieren („Unbekannte Quellen“ einmal erlauben) → mit Benutzer + Passwort anmelden.

## 6. Updates

Code ändern → **Run workflow** mit höherer Nummer (z. B. `1.0.1`). Jede App zeigt beim Öffnen **„Neue Version verfügbar – Jetzt installieren“**. Liste und Login bleiben erhalten.

**Passwort ändern:** Secret `APP_PASSWORD` ändern und neue Version bauen. Wer die alte Version noch hat, kommt weiter rein, bis du zusätzlich den Token in GitHub löschst und einen neuen als `DATA_TOKEN` hinterlegst.

---

## Was die App kann

- **Live-Scanner** für EAN-Strichcodes, Code 128 und GS1-DataMatrix/QR.
- **Produktname** automatisch aus der freien Datenbank *Open Food Facts*. Unbekannte Produkte einmal von Hand eintragen, danach kennt die App sie für alle.
- **Stückzahl** mit −/+ in der Liste. Ändern mehrere Handys gleichzeitig, wird zusammengeführt, nichts geht verloren.
- **MHD**: aus GS1-2D-Codes automatisch, sonst Datumsfeld. Gelb = läuft in ≤ 30 Tagen ab, rot = abgelaufen. Filter „Läuft bald ab“ und „Aufgebraucht“.
- **Offline**: Änderungen werden gespeichert und übertragen, sobald wieder Internet da ist. Die Liste aktualisiert sich alle 20 Sekunden und beim Öffnen.

## Wichtig

`release.keystore`, `KEYSTORE_BASE64.txt` und `SECRETS_LESEN.txt` sicher aufbewahren und **nicht hochladen**. Ohne diese Signatur lassen sich Updates nicht über die bestehende App installieren.
