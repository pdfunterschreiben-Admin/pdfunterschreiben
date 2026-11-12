// Prüft den Kundendienstfahrzeug-Teil des Servers (admin/Kundendienstfahrzeug.js + Anbindung in Code.gs) mit der Nachbildung.
//   node test/server-test.js
'use strict';
const assert = require('assert');
const { machUmgebung } = require('./server-nachbildung');

const u = machUmgebung();
const KEY = 'testschluessel';
let ok = 0;
const pruefe = (name, f) => { f(); ok++; console.log('✓ ' + name); };

const pc = { key: KEY, app: 'wagenlager', id: 'pc-1', name: 'Max Muster', email: 'm.muster@schlueter-gabelstapler.de', version: '1.0.0' };
const handy = { app: 'wagenlager', quelle: 'handy', id: 'handy-1', name: 'Max Muster', email: 'm.muster@schlueter-gabelstapler.de', version: 'handy-1' };
const fremd = { key: KEY, app: 'wagenlager', id: 'pc-2', name: 'Eva Anders', email: 'e.anders@schlueter-gabelstapler.de', version: '1.0.0' };
const code = () => /: (\d{6})$/.exec(u.mails[u.mails.length - 1].subject)[1];
const anmelden = w => {
  let r = u.post({ ...w, event: 'register' });
  assert(r.ok && r.sent, JSON.stringify(r));
  r = u.post({ ...w, event: 'verify', code: code() });
  assert(r.ok && r.verified, JSON.stringify(r));
};

pruefe('ohne Anmeldung kein Zugriff', () => {
  const r = u.post({ ...pc, event: 'wl_liste' });
  assert(!r.ok && /anmelden/.test(r.error));
});
pruefe('Anmeldung PC mit Code (eigenes Blatt „Nutzer Kundendienstfahrzeug“)', () => {
  anmelden(pc);
  assert(u.sheets['Nutzer Kundendienstfahrzeug'] && !u.sheets['Nutzer']);
  assert(/Kundendienstfahrzeug/.test(u.mails[0].subject));
});
pruefe('Handy-Anmeldung ohne KEY, andere Adressen abgelehnt', () => {
  anmelden(handy);
  const r = u.post({ ...handy, email: 'x@gmail.com', id: 'h9', event: 'register' });
  assert(!r.ok && /Nur E-Mail-Adressen/.test(r.error));
  const r2 = u.post({ ...handy, app: 'pptx', event: 'register' });
  assert(!r2.ok && /Nicht berechtigt/.test(r2.error)); // ohne KEY nur fürs Kundendienstfahrzeug
});
let st;
pruefe('leerer Bestand + Speichern mit Nummernformat', () => {
  let r = u.post({ ...pc, event: 'wl_liste' });
  assert(r.ok && Array.isArray(r.teile) && r.teile.length === 0);
  r = u.post({ ...pc, event: 'wl_speichern', teil: { liste: 'bestand', nr: '67405t100071', name: 'Filter-Teilgruppe', ort: 'Fach A', menge: 3 } });
  assert(r.ok && r.teile.length === 1 && r.teile[0].nr === '67405-T1000-71' && r.teile[0].menge === 3, JSON.stringify(r));
  r = u.post({ ...pc, event: 'wl_speichern', teil: { liste: 'bestand', nr: '7643266', name: 'Rad', ort: '', menge: 0 } });
  assert(r.teile.find(t => t.nr === 'BT7643266'));
  st = r.stand;
  assert(r.katalog.find(k => k.nr === 'BT7643266' && k.name === 'Rad'));
});
pruefe('doppelt am selben Ort abgelehnt, anderer Ort erlaubt', () => {
  let r = u.post({ ...pc, event: 'wl_speichern', teil: { liste: 'bestand', nr: '67405-T1000-71', name: 'X', ort: 'fach a', menge: 1 } });
  assert(!r.ok && r.vorhanden);
  r = u.post({ ...pc, event: 'wl_speichern', teil: { liste: 'bestand', nr: '67405-T1000-71', name: 'Filter-Teilgruppe', ort: 'Fach B', menge: 1 } });
  assert(r.ok && r.teile.length === 3);
});
pruefe('Stand unverändert → kurze Antwort', () => {
  let r = u.post({ ...pc, event: 'wl_liste' });
  const s = r.stand, ks = r.kstand;
  r = u.post({ ...handy, event: 'wl_liste', stand: s, kstand: ks });
  assert(r.ok && r.unveraendert && !r.teile, JSON.stringify(r));
});
pruefe('Menge ändern (Handy), nicht unter 0', () => {
  let r = u.post({ ...pc, event: 'wl_liste' });
  const f = r.teile.find(t => t.ort === 'Fach A');
  r = u.post({ ...handy, event: 'wl_menge', teilId: f.id, delta: -2 });
  assert(r.ok && r.teile.find(t => t.id === f.id).menge === 1);
  r = u.post({ ...handy, event: 'wl_menge', teilId: f.id, delta: -5 });
  assert(!r.ok && /nur noch 1/.test(r.error));
  assert.strictEqual(u.sheets['Kundendienstfahrzeug'].rows.find(x => x[0] === f.id)[9], 'Handy');
});
pruefe('Versionskonflikt beim Bearbeiten', () => {
  let r = u.post({ ...pc, event: 'wl_liste' });
  const f = r.teile.find(t => t.ort === 'Fach A');
  r = u.post({ ...pc, event: 'wl_speichern', teil: { ...f, v: f.v - 1, menge: 9 } });
  assert(!r.ok && r.konflikt);
  r = u.post({ ...pc, event: 'wl_speichern', teil: { ...f, menge: 9 } });
  assert(r.ok && r.teile.find(t => t.id === f.id).menge === 9);
});
pruefe('fremde Daten sind getrennt und nicht änderbar', () => {
  anmelden(fremd);
  let r = u.post({ ...fremd, event: 'wl_liste' });
  assert(r.ok && r.teile.length === 0);
  const meins = u.post({ ...pc, event: 'wl_liste' }).teile[0];
  r = u.post({ ...fremd, event: 'wl_menge', teilId: meins.id, delta: 1 });
  assert(!r.ok);
  r = u.post({ ...fremd, event: 'wl_loeschen', teilId: meins.id, v: meins.v });
  assert(r.ok && u.post({ ...pc, event: 'wl_liste' }).teile.find(t => t.id === meins.id));
  // falsche ID für die eigene Adresse
  r = u.post({ ...pc, id: 'erfunden', event: 'wl_liste' });
  assert(!r.ok && /anmelden/.test(r.error));
  // Katalog ist gemeinsam
  r = u.post({ ...fremd, event: 'wl_liste' });
  assert(r.katalog.find(k => k.nr === '67405-T1000-71'));
});
pruefe('Fehlteil → eingetroffen → zum Bestand dazugezählt', () => {
  let r = u.post({ ...pc, event: 'wl_speichern', teil: { liste: 'fehlt', nr: '67405-T1000-71', name: 'Filter-Teilgruppe', ort: 'Fach A', menge: 2 } });
  const f = r.teile.find(t => t.liste === 'fehlt');
  const vorher = r.teile.find(t => t.liste === 'bestand' && t.ort === 'Fach A').menge;
  r = u.post({ ...pc, event: 'wl_umbuchen', teilId: f.id });
  assert(r.ok && !r.teile.find(t => t.liste === 'fehlt'));
  assert.strictEqual(r.teile.find(t => t.liste === 'bestand' && t.ort === 'Fach A').menge, vorher + 2);
  // ohne passenden Eintrag: wandert als neuer Bestand
  r = u.post({ ...pc, event: 'wl_speichern', teil: { liste: 'fehlt', nr: 'BT1112223', name: 'Kette', ort: '', menge: 1 } });
  r = u.post({ ...pc, event: 'wl_umbuchen', teilId: r.teile.find(t => t.liste === 'fehlt').id });
  assert(r.teile.find(t => t.nr === 'BT1112223' && t.liste === 'bestand'));
});
pruefe('Import: ersetzen und dazuzählen', () => {
  let r = u.post({ ...pc, event: 'wl_import', modus: 'ersetzen', teile: [
    { liste: 'bestand', nr: '67405-T1000-71', name: '', ort: 'Fach A', menge: 4 },
    { liste: 'fehlt', nr: '12345ABCDE12', name: 'Sensor', ort: '', menge: 1 },
    { liste: 'bestand', nr: '0012345', name: 'Führende Null', ort: 'Kiste', menge: 1 },
  ] });
  assert(r.ok && r.neu === 2 && r.geaendert === 1, JSON.stringify(r));
  assert.strictEqual(r.teile.find(t => t.ort === 'Fach A' && t.liste === 'bestand').menge, 4);
  assert(r.teile.find(t => t.nr === '12345-ABCDE-12' && t.liste === 'fehlt'));
  assert(r.teile.find(t => t.nr === 'BT0012345'));
  r = u.post({ ...pc, event: 'wl_import', modus: 'dazu', teile: [{ liste: 'bestand', nr: '67405-T1000-71', name: '', ort: 'Fach A', menge: 1 }] });
  assert.strictEqual(r.teile.find(t => t.ort === 'Fach A' && t.liste === 'bestand').menge, 5);
});
pruefe('Formeln werden nicht ausgeführt', () => {
  const r = u.post({ ...pc, event: 'wl_speichern', teil: { liste: 'bestand', nr: 'ABC-1', name: '=HYPERLINK("x")', ort: '+1', menge: 1 } });
  assert(r.ok);
  const t = r.teile.find(x => x.nr === 'ABC-1');
  assert.strictEqual(t.name, '=HYPERLINK("x")'); // Text, so wie eingegeben
});
pruefe('Löschen und gesperrt', () => {
  let r = u.post({ ...pc, event: 'wl_liste' });
  const t = r.teile.find(x => x.nr === 'ABC-1');
  r = u.post({ ...pc, event: 'wl_loeschen', teilId: t.id, v: t.v });
  assert(r.ok && !r.teile.find(x => x.id === t.id));
  const users = u.sheets['Nutzer Kundendienstfahrzeug'];
  const row = users.rows.findIndex(x => x[2] === 'pc-1');
  users.rows[row][7] = 'ja';
  r = u.post({ ...pc, event: 'wl_liste' });
  assert(!r.ok && /gesperrt/.test(r.error));
  users.rows[row][7] = '';
});
pruefe('Kennzeichen und Fahrer', () => {
  let r = u.post({ ...pc, event: 'wl_liste' });
  assert.deepStrictEqual(r.fahrzeug, { kennzeichen: '', fahrer: '' });
  r = u.post({ ...pc, event: 'wl_fahrzeug', kennzeichen: 'ol - sg  123', fahrer: 'Max' });
  assert(!r.ok && /Fahrers/.test(r.error));
  r = u.post({ ...pc, event: 'wl_fahrzeug', kennzeichen: 'ol - sg  123', fahrer: 'Max Muster' });
  assert(r.ok && r.fahrzeug.kennzeichen === 'OL-SG 123' && r.fahrzeug.fahrer === 'Max Muster', JSON.stringify(r.fahrzeug));
  const s1 = r.stand;
  r = u.post({ ...handy, event: 'wl_fahrzeug', kennzeichen: 'OL-SG 124', fahrer: 'Max Muster' });
  assert(r.ok && r.stand !== s1 && u.sheets['Kundendienstfahrzeuge'].rows.length === 2);
  r = u.post({ ...fremd, event: 'wl_liste' });
  assert.strictEqual(r.fahrzeug.kennzeichen, '');
});
pruefe('Service-Mappe-Anmeldung bleibt unberührt', () => {
  const r = u.post({ key: KEY, id: 'sm-1', name: 'Max Muster', email: 'm.muster@schlueter-gabelstapler.de', event: 'register', version: '1.20.14' });
  assert(r.ok && r.sent && u.sheets['Nutzer'] && /Service-Mappe/.test(u.mails[u.mails.length - 1].subject));
});
console.log(`\n${ok} Prüfungen bestanden.`);
