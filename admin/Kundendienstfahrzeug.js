// Kundendienstfahrzeug (früher „Wagenlager“) – Ersatzteile im Servicewagen (Bestand und fehlende
// Teile) sowie Kennzeichen und Fahrer, je Arbeits-E-Mail getrennt.
// Wird wie Typenschild.js, QrCode.js und Vorlagen.js unten an Code.gs angehängt (ohne die letzte
// module.exports-Zeile).
//
// Anfragen kommen vom Windows-Programm „Kundendienstfahrzeug“ (über /api/lager, mit KEY) und von der
// Handy-Seite (GitHub Pages, ohne KEY). Berechtigt ist eine Anfrage nur mit einer Rechner-ID, die im
// Blatt „Nutzer Kundendienstfahrzeug“ zu genau dieser E-Mail gehört, freigeschaltet und nicht gesperrt ist –
// die ID ist zufällig, geheim und wird nur nach dem Freischaltcode aus der E-Mail gültig.
//
// Blätter:
//   „Kundendienstfahrzeug“          – alle Teile aller Nutzer (eine Zeile je Teil)
//   „Kundendienstfahrzeug Katalog“  – Teilenummer → Bezeichnung, für alle gemeinsam (füllt sich beim Speichern)
//   „Kundendienstfahrzeuge“         – je Nutzer Kennzeichen und Fahrer

const WL_BLATT = 'Kundendienstfahrzeug';
const WL_HEAD = ['ID', 'E-Mail', 'Liste', 'Teilenummer', 'Bezeichnung', 'Lagerort', 'Stückzahl', 'Version', 'Geändert', 'Geändert über'];
const WL_KATALOG = 'Kundendienstfahrzeug Katalog';
const WL_FAHRZEUGE = 'Kundendienstfahrzeuge';
const WL_FAHRZEUG_HEAD = ['E-Mail', 'Kennzeichen', 'Fahrer', 'Geändert', 'Geändert über'];
const WL_KATALOG_HEAD = ['Teilenummer', 'Bezeichnung', 'Von', 'Geändert'];
const WL_LISTEN = { bestand: 'Bestand', fehlt: 'Fehlt' };
const WL_MAX = 999999;

// Toyota- (12345-ABCDE-12) und BT-Nummern (BT1234567) einheitlich schreiben – wie im Programm.
function wlNr(v) {
  const roh = String(v == null ? '' : v).trim().toUpperCase().slice(0, 150);
  const c = roh.replace(/[\s-]/g, '');
  if (/^BT\d{7}$/.test(c)) return c;
  if (/^\d{7}$/.test(c)) return 'BT' + c;
  const m = c.match(/^(\d{5})([A-Z0-9]{5})(\d{2})$/);
  return m ? m[1] + '-' + m[2] + '-' + m[3] : roh;
}
const wlKey = nr => wlNr(nr).replace(/[\s-]/g, '');
function wlText(v, max) { return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max); }
// Zellen als Text ablegen, damit Google aus 0012345 oder =… nichts anderes macht
const wlZelle = s => (s === '' ? '' : "'" + s);

function wlNutzer(ss, d) {
  const users = sheet(ss, 'Nutzer Kundendienstfahrzeug', ['Name', 'E-Mail', 'Rechner-ID', 'Version', 'Erste Anmeldung', 'Zuletzt aktiv',
    'Freigeschaltet', 'Gesperrt (ja)', 'Starts', 'Gespeichert', 'Gedruckt', 'Per E-Mail']);
  const id = clean(d.id, 64), mail = clean(d.email, 150).toLowerCase();
  const row = id ? findRow(users, id) : -1;
  if (row < 0) throw new Error('Bitte neu anmelden.');
  const r = users.getRange(row, 1, 1, 12).getValues()[0];
  if (String(r[1]).toLowerCase() !== mail || String(r[6]).toLowerCase() !== 'ja') throw new Error('Bitte neu anmelden.');
  if (String(r[7]).trim().toLowerCase() === 'ja') throw new Error('Dein Zugang zum Kundendienstfahrzeug wurde gesperrt.');
  return mail;
}

function wlLaden(ss) {
  const s = sheet(ss, WL_BLATT, WL_HEAD);
  const last = s.getLastRow();
  const rows = last < 2 ? [] : s.getRange(2, 1, last - 1, WL_HEAD.length).getValues();
  return { s: s, rows: rows.filter(r => r[0] !== '') };
}

// Schreibt alle Zeilen zurück (die Datenmenge ist klein, so bleiben Löschen und Umbuchen einfach).
function wlSchreiben(t) {
  const s = t.s, alt = Math.max(0, s.getLastRow() - 1);
  const werte = t.rows.map(r => [r[0], r[1], r[2], wlZelle(String(r[3])), wlZelle(String(r[4])), wlZelle(String(r[5])), Number(r[6]) || 0, Number(r[7]) || 1, r[8], r[9]]);
  if (werte.length) s.getRange(2, 1, werte.length, WL_HEAD.length).setValues(werte);
  if (alt > werte.length) s.getRange(werte.length + 2, 1, alt - werte.length, WL_HEAD.length).clearContent();
}

function wlTeil(r) {
  return { id: String(r[0]), liste: r[2] === WL_LISTEN.fehlt ? 'fehlt' : 'bestand', nr: String(r[3]), name: String(r[4]),
    ort: String(r[5]), menge: Number(r[6]) || 0, v: Number(r[7]) || 1, zeit: r[8] instanceof Date ? r[8].toISOString() : String(r[8] || '') };
}

function wlStand(mail, neu) {
  const p = PropertiesService.getScriptProperties(), k = 'wls_' + mail;
  if (neu) { const v = Date.now() + '-' + Math.random().toString(36).slice(2, 7); p.setProperty(k, v); return v; }
  return p.getProperty(k) || '0';
}
function wlKatalogStand(neu) {
  const p = PropertiesService.getScriptProperties();
  if (neu) { const v = Date.now() + '-' + Math.random().toString(36).slice(2, 7); p.setProperty('wlk', v); return v; }
  return p.getProperty('wlk') || '0';
}

function wlKatalogLaden(ss) {
  const s = sheet(ss, WL_KATALOG, WL_KATALOG_HEAD);
  const last = s.getLastRow();
  return { s: s, rows: last < 2 ? [] : s.getRange(2, 1, last - 1, WL_KATALOG_HEAD.length).getValues() };
}

// Bezeichnungen merken (für alle): neue Nummern anhängen, vorhandene nur überschreiben, wenn überschreiben = true
function wlKatalogMerken(ss, eintraege, mail, ueberschreiben) {
  const k = wlKatalogLaden(ss), idx = {};
  k.rows.forEach((r, i) => { idx[wlKey(r[0])] = i; });
  let neu = 0;
  const jetzt = new Date();
  for (const e of eintraege) {
    const nr = wlNr(e.nr), name = wlText(e.name, 250);
    if (!nr || !name || nr.length < 4) continue;
    const i = idx[wlKey(nr)];
    if (i === undefined) { k.rows.push([nr, name, mail, jetzt]); idx[wlKey(nr)] = k.rows.length - 1; neu++; }
    else if (ueberschreiben && String(k.rows[i][1]) !== name) { k.rows[i] = [nr, name, mail, jetzt]; neu++; }
  }
  if (!neu) return false;
  k.s.getRange(2, 1, k.rows.length, WL_KATALOG_HEAD.length).setValues(k.rows.map(r => [wlZelle(String(r[0])), wlZelle(String(r[1])), r[2], r[3]]));
  wlKatalogStand(true);
  return true;
}

// Kennzeichen wie auf dem Schild: Großbuchstaben, einfache Leerzeichen/Bindestriche (z. B. „OL-SG 123“)
function wlKennzeichen(v) { return wlText(v, 20).toUpperCase().replace(/\s+/g, ' ').replace(/\s*-\s*/g, '-'); }

function wlFahrzeugLaden(ss, mail) {
  const s = sheet(ss, WL_FAHRZEUGE, WL_FAHRZEUG_HEAD), last = s.getLastRow();
  const rows = last < 2 ? [] : s.getRange(2, 1, last - 1, WL_FAHRZEUG_HEAD.length).getValues();
  const i = rows.findIndex(r => String(r[0]).toLowerCase() === mail);
  return { s: s, row: i < 0 ? -1 : i + 2, kennzeichen: i < 0 ? '' : String(rows[i][1]), fahrer: i < 0 ? '' : String(rows[i][2]) };
}

function wlAntwort(ss, mail, t, d, extra) {
  const o = Object.assign({ ok: true }, extra || {});
  o.stand = wlStand(mail);
  const fz = wlFahrzeugLaden(ss, mail);
  o.fahrzeug = { kennzeichen: fz.kennzeichen, fahrer: fz.fahrer };
  o.teile = t.rows.filter(r => String(r[1]).toLowerCase() === mail).map(wlTeil);
  const ks = wlKatalogStand();
  if (String(d.kstand || '') !== ks) {
    o.kstand = ks;
    o.katalog = wlKatalogLaden(ss).rows.filter(r => r[0] !== '').map(r => ({ nr: String(r[0]), name: String(r[1]) }));
  }
  return o;
}

function wagenlagerAnfrage(d) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const mail = wlNutzer(ss, d);
  const ev = String(d.event || '');
  const ueber = d.quelle === 'handy' ? 'Handy' : 'PC';

  if (ev === 'wl_liste') {
    const st = wlStand(mail);
    if (String(d.stand || '') === st && String(d.kstand || '') === wlKatalogStand()) return { ok: true, unveraendert: true, stand: st };
    return wlAntwort(ss, mail, wlLaden(ss), d);
  }

  // Kennzeichen und Fahrer des eigenen Kundendienstfahrzeugs
  if (ev === 'wl_fahrzeug') {
    const kz = wlKennzeichen(d.kennzeichen), fahrer = wlText(d.fahrer, 100);
    if (kz.replace(/[\s-]/g, '').length < 3) return { ok: false, error: 'Bitte das Kennzeichen eintragen (z. B. OL-SG 123).' };
    if (fahrer.split(' ').filter(Boolean).length < 2) return { ok: false, error: 'Bitte Vor- und Nachnamen des Fahrers eintragen.' };
    const fz = wlFahrzeugLaden(ss, mail), werte = [[mail, wlZelle(kz), wlZelle(fahrer), new Date(), ueber]];
    if (fz.row > 0) fz.s.getRange(fz.row, 1, 1, WL_FAHRZEUG_HEAD.length).setValues(werte);
    else fz.s.appendRow(werte[0]);
    wlStand(mail, true);
    return wlAntwort(ss, mail, wlLaden(ss), d, { gespeichert: true });
  }

  if (ev === 'wl_katalog') {
    const e = Array.isArray(d.eintraege) ? d.eintraege.slice(0, 500) : [];
    wlKatalogMerken(ss, e, mail, true);
    return wlAntwort(ss, mail, wlLaden(ss), d);
  }

  const t = wlLaden(ss), jetzt = new Date();
  const meine = i => String(t.rows[i][1]).toLowerCase() === mail;
  const finde = id => t.rows.findIndex((r, i) => String(r[0]) === String(id) && meine(i));
  const gleich = (liste, nr, ort, ohne) => t.rows.findIndex((r, i) => meine(i) && r[2] === liste && wlKey(r[3]) === wlKey(nr) &&
    String(r[5]).trim().toLowerCase() === String(ort).trim().toLowerCase() && String(r[0]) !== String(ohne || ''));
  const fertig = (extra) => { wlSchreiben(t); wlStand(mail, true); return wlAntwort(ss, mail, t, d, extra); };

  if (ev === 'wl_speichern') {
    const x = d.teil || {};
    const liste = WL_LISTEN[x.liste] || WL_LISTEN.bestand;
    const nr = wlNr(x.nr), name = wlText(x.name, 250), ort = wlText(x.ort, 150), menge = Number(x.menge);
    if (!nr || nr.length < 3) return { ok: false, error: 'Bitte eine Teilenummer eintragen.' };
    if (!name) return { ok: false, error: 'Bitte eine Bezeichnung eintragen.' };
    if (!Number.isInteger(menge) || menge < 0 || menge > WL_MAX) return { ok: false, error: 'Die Stückzahl muss eine ganze Zahl von 0 bis 999999 sein.' };
    const doppelt = gleich(liste, nr, ort, x.id);
    if (doppelt >= 0) return { ok: false, vorhanden: String(t.rows[doppelt][0]), error: 'Diese Teilenummer gibt es an diesem Lagerort schon. Bitte den vorhandenen Eintrag ändern.' };
    if (x.id) {
      const i = finde(x.id);
      if (i < 0) return { ok: false, error: 'Der Eintrag wurde inzwischen gelöscht.' };
      if (Number(x.v) && Number(t.rows[i][7]) !== Number(x.v)) return { ok: false, konflikt: true, error: 'Der Eintrag wurde inzwischen auf einem anderen Gerät geändert. Bitte neu öffnen.' };
      t.rows[i] = [t.rows[i][0], mail, liste, nr, name, ort, menge, (Number(t.rows[i][7]) || 1) + 1, jetzt, ueber];
    } else {
      t.rows.push([Utilities.getUuid(), mail, liste, nr, name, ort, menge, 1, jetzt, ueber]);
    }
    wlKatalogMerken(ss, [{ nr: nr, name: name }], mail, false);
    return fertig({ gespeichert: true });
  }

  if (ev === 'wl_menge') {
    const i = finde(d.teilId), delta = Number(d.delta);
    if (i < 0) return { ok: false, error: 'Der Eintrag wurde inzwischen gelöscht.' };
    if (!Number.isInteger(delta) || !delta || Math.abs(delta) > WL_MAX) return { ok: false, error: 'Ungültige Menge.' };
    const neu = (Number(t.rows[i][6]) || 0) + delta;
    if (neu < 0) return { ok: false, error: 'Es sind nur noch ' + (Number(t.rows[i][6]) || 0) + ' Stück da.' };
    if (neu > WL_MAX) return { ok: false, error: 'Zu viele Teile.' };
    t.rows[i][6] = neu; t.rows[i][7] = (Number(t.rows[i][7]) || 1) + 1; t.rows[i][8] = jetzt; t.rows[i][9] = ueber;
    return fertig({ menge: neu });
  }

  if (ev === 'wl_loeschen') {
    const i = finde(d.teilId);
    if (i < 0) return wlAntwort(ss, mail, t, d); // schon weg
    if (Number(d.v) && Number(t.rows[i][7]) !== Number(d.v)) return { ok: false, konflikt: true, error: 'Der Eintrag wurde inzwischen geändert. Bitte prüfen und nochmal löschen.' };
    t.rows.splice(i, 1);
    return fertig({ geloescht: true });
  }

  // Fehlteil ist eingetroffen → ins Lager (zum vorhandenen Eintrag mit gleicher Nummer und gleichem
  // Lagerort dazuzählen, sonst als neuer Lagerbestand). Umgekehrt (Bestand → Fehlt) genauso.
  if (ev === 'wl_umbuchen') {
    const i = finde(d.teilId);
    if (i < 0) return { ok: false, error: 'Der Eintrag wurde inzwischen gelöscht.' };
    const r = t.rows[i], ziel = r[2] === WL_LISTEN.fehlt ? WL_LISTEN.bestand : WL_LISTEN.fehlt;
    const ort = d.ort != null ? wlText(d.ort, 150) : String(r[5]);
    const menge = Number(r[6]) || 0;
    const j = gleich(ziel, r[3], ort);
    if (j >= 0) {
      t.rows[j][6] = Math.min(WL_MAX, (Number(t.rows[j][6]) || 0) + menge);
      t.rows[j][7] = (Number(t.rows[j][7]) || 1) + 1; t.rows[j][8] = jetzt; t.rows[j][9] = ueber;
      t.rows.splice(i, 1);
    } else {
      t.rows[i] = [r[0], mail, ziel, r[3], r[4], ort, menge, (Number(r[7]) || 1) + 1, jetzt, ueber];
    }
    return fertig({ umgebucht: true });
  }

  // Excel-Import: gleiche Nummer + Lagerort → Stückzahl übernehmen (oder dazuzählen), sonst neu
  if (ev === 'wl_import') {
    const liste = Array.isArray(d.teile) ? d.teile.slice(0, 3000) : [];
    const plus = d.modus === 'dazu';
    let neu = 0, geaendert = 0;
    const kat = [];
    for (const x of liste) {
      const l = WL_LISTEN[x.liste] || WL_LISTEN.bestand;
      const nr = wlNr(x.nr), name = wlText(x.name, 250), ort = wlText(x.ort, 150);
      let menge = Math.round(Number(x.menge));
      if (!nr || nr.length < 3) continue;
      if (!Number.isFinite(menge) || menge < 0) menge = 0;
      menge = Math.min(WL_MAX, menge);
      const j = gleich(l, nr, ort);
      if (j >= 0) {
        t.rows[j][6] = Math.min(WL_MAX, plus ? (Number(t.rows[j][6]) || 0) + menge : menge);
        if (name && !String(t.rows[j][4])) t.rows[j][4] = name;
        t.rows[j][7] = (Number(t.rows[j][7]) || 1) + 1; t.rows[j][8] = jetzt; t.rows[j][9] = 'Excel';
        geaendert++;
      } else {
        t.rows.push([Utilities.getUuid(), mail, l, nr, name, ort, menge, 1, jetzt, 'Excel']);
        neu++;
      }
      if (name) kat.push({ nr: nr, name: name });
    }
    wlKatalogMerken(ss, kat, mail, false);
    return fertig({ neu: neu, geaendert: geaendert });
  }

  return { ok: false, error: 'Unbekannte Anfrage.' };
}

if (typeof module !== 'undefined') module.exports = { wlNr, wagenlagerAnfrage };
