// Kundendienst Montageberichte – unterschriebene Berichte der Monteure fürs Büro.
// Im Apps-Script-Projekt als eigene Datei anlegen (ohne die letzte module.exports-Zeile).
//
// Die Service-Mappe schickt jeden unterschriebenen Bericht (PDF) mit mb_hoch hierher: Er landet in Google Drive
// im Ordner „Kundendienst Montageberichte/<Monteur>“ und bekommt eine Zeile im Blatt „Montageberichte“
// (Monteur, Berichtsdatum, Kalenderwoche, Auftragsnummer, Art …).
// Das Büro-Programm „Kundendienst Montageberichte“ (app: 'montageberichte') liest Monteure, Kalenderwochen
// und Berichte und holt die PDFs ab. Berechtigt sind nur freigeschaltete Rechner, deren Zeile im Blatt
// „Nutzer Montageberichte“ in „Berechtigt (ja)“ ein „ja“ hat (Admins immer).

const MB_BLATT = 'Montageberichte';
const MB_HEAD = ['Eingang', 'Monteur', 'E-Mail', 'Berichtsdatum', 'Jahr', 'KW', 'Auftragsnummer', 'Art', 'Seriennummer', 'Dateiname', 'Datei-ID', 'Prüfsumme'];
const MB_NUTZER = 'Nutzer Montageberichte';
const MB_ARTEN = { montage: 'Montagebericht', uvv: 'UVV Bericht', dguv: 'DGUV V3 Bericht' };

function mbBlatt(ss) {
  const s = sheet(ss || SpreadsheetApp.getActiveSpreadsheet(), MB_BLATT, MB_HEAD);
  if (s.getLastColumn() < MB_HEAD.length) s.getRange(1, 1, 1, MB_HEAD.length).setValues([MB_HEAD]).setFontWeight('bold');
  return s;
}

function mbOrdner(name) {
  const root = DriveApp.getRootFolder(), it = root.getFoldersByName('Kundendienst Montageberichte');
  const haupt = it.hasNext() ? it.next() : root.createFolder('Kundendienst Montageberichte');
  const n = String(name || 'Unbekannt').replace(/[\\/:*?"<>|]/g, ' ').trim() || 'Unbekannt';
  const sub = haupt.getFoldersByName(n);
  return sub.hasNext() ? sub.next() : haupt.createFolder(n);
}

// Kalenderwoche nach ISO 8601 (Woche mit dem ersten Donnerstag ist KW 1)
function mbKw(dt) {
  const d = new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
  const tag = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - tag);
  const jahr = d.getUTCFullYear();
  const kw = Math.ceil(((d - Date.UTC(jahr, 0, 1)) / 86400000 + 1) / 7);
  return { jahr: jahr, kw: kw };
}

function mbDatum(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    // Berichtsdatum nur glauben, wenn es plausibel ist (nicht in der Zukunft, nicht älter als 1 Jahr)
    if (!isNaN(d) && d.getTime() < Date.now() + 2 * 86400000 && d.getTime() > Date.now() - 366 * 86400000) return d;
  }
  const h = new Date();
  return new Date(h.getFullYear(), h.getMonth(), h.getDate());
}

// Vom Monteur (Service-Mappe, mit KEY): einen unterschriebenen Bericht ablegen
function mbHoch(d) {
  const mail = clean(d.email, 150).toLowerCase(), name = clean(d.name, 100);
  if (ADMIN_MAILS.indexOf(mail) < 0 && !mail.endsWith('@' + DOMAIN)) throw new Error('Nicht berechtigt.');
  if (!name) throw new Error('Name fehlt.');
  const b64 = String(d.b64 || '').replace(/\s/g, '');
  if (b64.length < 200 || b64.length > 40000000) throw new Error('Keine gültige PDF.');
  const bytes = Utilities.base64Decode(b64);
  if (String.fromCharCode.apply(null, bytes.slice(0, 4).map(function (b) { return b & 255; })) !== '%PDF') throw new Error('Keine PDF-Datei.');
  const sha = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
    .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
  const s = mbBlatt();
  const art = MB_ARTEN[d.art] ? d.art : 'montage';
  const datum = mbDatum(d.datum), w = mbKw(datum);
  const nr = clean(d.nr, 40), ser = clean(d.serie, 60);
  let datei = clean(d.datei, 150).replace(/[\\/:*?"<>|]/g, '_') || 'Bericht.pdf';
  if (!/\.pdf$/i.test(datei)) datei += '.pdf';
  const last = s.getLastRow(), v = last >= 2 ? s.getRange(2, 1, last - 1, MB_HEAD.length).getValues() : [];
  let zeile = 0;
  for (let i = v.length - 1; i >= 0; i--) {
    if (v[i][11] === sha) return 'schon da';   // genau dieser Bericht wurde schon geschickt
    // derselbe Bericht noch einmal unterschrieben (gleicher Monteur, Dateiname, Auftrag, Art): ersetzen
    if (!zeile && String(v[i][2]).toLowerCase() === mail && String(v[i][9]) === datei && String(v[i][6]) === nr && String(v[i][7]) === art) zeile = i + 2;
  }
  const f = mbOrdner(name).createFile(Utilities.newBlob(bytes, 'application/pdf', datei));
  const neu = [new Date(), name, mail, datum, w.jahr, w.kw, "'" + nr, art, "'" + ser, datei, f.getId(), sha];
  if (zeile) {
    try { DriveApp.getFileById(String(v[zeile - 2][10])).setTrashed(true); } catch (x) { }
    s.getRange(zeile, 1, 1, MB_HEAD.length).setValues([neu]);
    return 'ersetzt';
  }
  s.appendRow(neu);
  return 'gespeichert';
}

// Büro-Programm: angemeldeter und berechtigter Rechner?
function mbNutzer(ss, d) {
  const users = sheet(ss, MB_NUTZER, ['Name', 'E-Mail', 'Rechner-ID', 'Version', 'Erste Anmeldung', 'Zuletzt aktiv',
    'Freigeschaltet', 'Gesperrt (ja)', 'Starts', 'Gespeichert', 'Gedruckt', 'Per E-Mail', 'Berechtigt (ja)']);
  if (users.getLastColumn() < 13) users.getRange(1, 13).setValue('Berechtigt (ja)').setFontWeight('bold');
  const id = clean(d.id, 64), mail = clean(d.email, 150).toLowerCase();
  const row = id ? findRow(users, id) : -1;
  if (row < 0) throw new Error('Bitte neu anmelden.');
  const r = users.getRange(row, 1, 1, 13).getValues()[0];
  if (String(r[1]).toLowerCase() !== mail || String(r[6]).toLowerCase() !== 'ja') throw new Error('Bitte neu anmelden.');
  if (String(r[7]).trim().toLowerCase() === 'ja') throw new Error('Dein Zugang wurde gesperrt.');
  if (ADMIN_MAILS.indexOf(mail) < 0 && String(r[12]).trim().toLowerCase() !== 'ja')
    throw new Error('Du bist noch nicht für die Montageberichte freigegeben. Bitte beim Admin melden (Blatt „Nutzer Montageberichte“, Spalte „Berechtigt (ja)“).');
  return mail;
}

function mbZeilen() {
  const s = mbBlatt(), last = s.getLastRow();
  return last < 2 ? [] : s.getRange(2, 1, last - 1, MB_HEAD.length).getValues();
}

function montageberichteAnfrage(d) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  mbNutzer(ss, d);
  const ev = String(d.event || '');
  const tz = Session.getScriptTimeZone() || 'Europe/Berlin';
  if (ev === 'mb_monteure') {
    // je Monteur (E-Mail) der neueste Name und alle Kalenderwochen mit Anzahl Berichten
    const m = {};
    mbZeilen().forEach(function (r) {
      const mail = String(r[2]).toLowerCase(); if (!mail) return;
      const x = m[mail] || (m[mail] = { email: mail, name: '', kws: {} , zuletzt: 0 });
      const t = r[0] instanceof Date ? r[0].getTime() : 0;
      if (t >= x.zuletzt) { x.zuletzt = t; x.name = String(r[1]); }
      const k = r[4] + '-' + ('0' + r[5]).slice(-2);
      x.kws[k] = (x.kws[k] || 0) + 1;
    });
    const liste = Object.keys(m).map(function (k) {
      const x = m[k];
      return { email: x.email, name: x.name, zuletzt: x.zuletzt,
        kws: Object.keys(x.kws).sort().reverse().map(function (s) { const p = s.split('-'); return { jahr: +p[0], kw: +p[1], anzahl: x.kws[s] }; }) };
    }).sort(function (a, b) { return a.name.localeCompare(b.name, 'de'); });
    return { ok: true, monteure: liste };
  }
  if (ev === 'mb_liste') {
    const mail = clean(d.monteur, 150).toLowerCase(), jahr = Number(d.jahr), kw = Number(d.kw);
    const out = [];
    mbZeilen().forEach(function (r) {
      if (String(r[2]).toLowerCase() !== mail || Number(r[4]) !== jahr || Number(r[5]) !== kw) return;
      out.push({ id: String(r[10]), nr: String(r[6]), art: String(r[7]), serie: String(r[8]), datei: String(r[9]),
        datum: r[3] instanceof Date ? Utilities.formatDate(r[3], tz, 'yyyy-MM-dd') : String(r[3]),
        eingang: r[0] instanceof Date ? r[0].getTime() : 0 });
    });
    return { ok: true, berichte: out };
  }
  if (ev === 'mb_datei') {
    const id = String(d.datei || '');
    if (!/^[\w\-]{10,100}$/.test(id)) return { ok: false, error: 'Ungültige Datei.' };
    if (!mbZeilen().some(function (r) { return String(r[10]) === id; })) return { ok: false, error: 'Bericht nicht gefunden.' };
    return { ok: true, b64: Utilities.base64Encode(DriveApp.getFileById(id).getBlob().getBytes()) };
  }
  return { ok: false, error: 'Unbekannte Anfrage.' };
}

if (typeof module !== 'undefined') module.exports = { mbKw, mbDatum };
