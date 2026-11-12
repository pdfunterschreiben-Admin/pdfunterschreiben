// Klickt die Oberfläche durch (Programm im Testbetrieb + Server-Nachbildung) und macht Bildschirmfotos.
//   node test/oberflaeche-test.js http://127.0.0.1:PORT/ http://127.0.0.1:8765/ ausgabe-ordner
'use strict';
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path'), assert = require('assert');
const [app, mock, out = '.'] = process.argv.slice(2);

(async () => {
  const browser = globalThis.__b = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true, locale: 'de-DE' });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.replace(/\/$/, '') });
  const page = await ctx.newPage();
  const fehler = [];
  page.on('pageerror', e => fehler.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') fehler.push(m.text()); });
  const shot = n => page.screenshot({ path: path.join(out, n + '.png') });
  let schritt = 0;
  const ok = t => console.log(`✓ ${++schritt}. ${t}`);

  await page.goto(app);
  await page.waitForSelector('#regDlg[open]');
  await shot('01-anmeldung');
  await page.fill('#regName', 'Max Muster');
  assert.strictEqual(await page.inputValue('#regMail'), 'm.muster');
  await page.click('#regOk');
  await page.waitForSelector('#codeDlg[open]');
  const mails = await (await fetch(mock + '__mails')).json();
  const code = /: (\d{6})$/.exec(mails[mails.length - 1].subject)[1];
  await page.fill('#codeInput', code);
  await page.click('#codeOk');
  await page.waitForSelector('#syncChip.ok');
  ok('Anmeldung mit Freischaltcode');
  // Kennzeichen und Fahrer werden beim ersten Start abgefragt
  await page.waitForSelector('#fzDlg[open]');
  assert.strictEqual(await page.inputValue('#fzFahrerIn'), 'Max Muster');
  await page.fill('#fzKzIn', 'ol - sg 123');
  assert.strictEqual(await page.textContent('#fzVorschau'), 'OL-SG 123');
  await shot('02a-fahrzeug');
  await page.click('#fzOk');
  await page.waitForSelector('#fzDlg[open]', { state: 'detached' });
  assert.strictEqual(await page.textContent('#fzKz'), 'OL-SG 123');
  assert.strictEqual(await page.title(), 'Kundendienstfahrzeug OL-SG 123');
  ok('Kennzeichen und Fahrer gespeichert');
  await shot('02-leer');

  // Teil anlegen, Nummer wird formatiert
  await page.click('#neuBtn');
  await page.fill('#fNr', '67405t100071');
  await page.press('#fNr', 'Tab');
  assert.strictEqual(await page.inputValue('#fNr'), '67405-T1000-71');
  await page.fill('#fName', 'Filter-Teilgruppe');
  await page.fill('#fOrt', 'Fach A');
  await page.fill('#fMenge', '3');
  await page.click('#teilOk');
  await page.waitForSelector('#teilDlg[open]', { state: 'detached' });
  await page.waitForSelector('tr[data-id]');
  ok('Teil gespeichert, Nummer formatiert');

  const neu = async (nr, name, ort, menge, liste) => {
    await page.click('#neuBtn'); await page.waitForTimeout(120);
    if (liste === 'fehlt') await page.click('#tlFehlt');
    await page.fill('#fNr', nr); await page.press('#fNr', 'Tab');
    if (name) await page.fill('#fName', name);
    await page.fill('#fOrt', ort); await page.fill('#fMenge', String(menge));
    await page.click('#teilOk'); await page.waitForSelector('#teilDlg[open]', { state: 'detached' });
  };
  await neu('7643266', 'Rad (Lenkrad, Polyurethan)', 'Regal hinten', 2);
  await neu('BT0012345', 'Kohlebürsten-Satz', 'Kiste 2', 0);
  await neu('12345ABCDE12', 'Sensor Hubhöhe', 'Fach B', 1);
  await neu('04151-2003071', 'Ölfilter', 'Fach A', 6);
  await page.click('#tabBestand');
  assert.strictEqual(await page.locator('#rows tr').count(), 5);
  ok('mehrere Teile erfasst');

  // Katalog: Bezeichnung kommt automatisch
  await page.click('#neuBtn');
  await page.fill('#fNr', 'bt7643266'); await page.press('#fNr', 'Tab');
  assert.strictEqual(await page.inputValue('#fName'), 'Rad (Lenkrad, Polyurethan)');
  assert(await page.isVisible('#trefferBox'));
  await shot('03-dialog-treffer');
  await page.click('#teilAbbr');
  ok('Bezeichnung aus Katalog + Hinweis auf vorhandenen Eintrag');

  // Foto → Teilenummer
  await page.click('#neuBtn');
  const bild = path.join(out, 'etikett.png');
  if (!fs.existsSync(bild)) fs.writeFileSync(bild, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  await page.setInputFiles('#fFoto', bild);
  await page.waitForSelector('#cands button.gut');
  assert.strictEqual(await page.inputValue('#fNr'), '67405-T1000-71');
  assert.strictEqual(await page.inputValue('#fName'), 'Filter-Teilgruppe');
  await shot('04-foto');
  await page.click('#teilAbbr');
  ok('Teilenummer vom Foto erkannt (O→0 korrigiert), Bezeichnung ergänzt');

  // T-Doc: Bezeichnung kommt über das Lesezeichen (Zwischenablage) automatisch
  await page.click('#neuBtn'); await page.waitForTimeout(120);
  await page.fill('#fNr', '67405T1001071'.slice(0, 12)); await page.press('#fNr', 'Tab');
  await page.fill('#fNr', '11111ABCDE22'); await page.press('#fNr', 'Tab');
  await page.click('#fTdoc');
  await page.evaluate(() => navigator.clipboard.writeText('TDOC-ERSATZTEILE\r\n1\t11111-ABCDE-22\tLAGER, RADNABE\t'));
  await page.waitForFunction(() => document.querySelector('#fName').value === 'LAGER, RADNABE', null, { timeout: 5000 });
  await page.click('#teilAbbr');
  ok('Bezeichnung aus T-Doc automatisch eingetragen');

  // Menge −/+ zusammengefasst
  const zeile = page.locator('tr', { hasText: 'Filter-Teilgruppe' });
  await zeile.locator('[data-a=minus]').click();
  await zeile.locator('[data-a=minus]').click();
  await zeile.locator('[data-a=plus]').click();
  assert.strictEqual(await zeile.locator('output').textContent(), '2');
  await page.waitForTimeout(1500);
  const blatt = await (await fetch(mock + '__blatt')).json();
  assert.strictEqual(blatt.find(r => r[4] === 'Filter-Teilgruppe')[6], 2);
  ok('Entnahme/Nachfüllen mit einer Serveranfrage gespeichert');

  // aufgebraucht → Nachbestellen
  const rad = page.locator('tr', { hasText: 'Rad (Lenkrad' });
  await rad.locator('[data-a=minus]').click(); await rad.locator('[data-a=minus]').click();
  await page.waitForSelector('#toastBtn:not([hidden])', { timeout: 5000 });
  assert.strictEqual(await page.textContent('#toastBtn'), 'Nachbestellen');
  await page.click('#toastBtn');
  await page.waitForSelector('#teilDlg[open]');
  assert.strictEqual(await page.getAttribute('#tlFehlt', 'aria-selected'), 'true');
  await page.click('#teilOk'); await page.waitForSelector('#teilDlg[open]', { state: 'detached' });
  ok('aufgebraucht → nachbestellt');

  // Sensor ebenfalls auf die Fehlliste
  await neu('BT9876543', 'Hydraulikschlauch 1/4"', '', 2, 'fehlt');
  assert.strictEqual(await page.getAttribute('#tabFehlt', 'aria-selected'), 'true');
  await shot('05-fehlteile');
  // eingetroffen
  await page.locator('tr', { hasText: 'Rad (Lenkrad' }).locator('[data-a=da]').click();
  await page.waitForFunction(() => !document.querySelector('#rows').textContent.includes('Rad (Lenkrad'));
  ok('Fehlteil eingetroffen → Bestand');

  // T-Doc-Zwischenablage
  await page.evaluate(() => navigator.clipboard.writeText('TDOC-ERSATZTEILE\n2\t67405-T1000-71\tFILTER-TEILGRUPPE\t\n1\t0815099001\tDichtung\tHinten'));
  await page.click('#tdocBtn');
  await page.waitForSelector('#importDlg[open]');
  assert.strictEqual(await page.locator('#importRows tr').count(), 2);
  await shot('06-tdoc');
  await page.click('#importOk');
  await page.waitForSelector('#importDlg[open]', { state: 'detached' });
  assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), 'TDOC-EINGEFUEGT');
  ok('Teile aus T-Doc übernommen');

  // Ersatzteilliste aus der Service-Mappe
  await page.click('#tabBestand');
  await page.click('#etBtn');
  await page.waitForSelector('#etDlg[open]');
  await page.fill('#etSuche', 'akkusäure');
  await page.locator('#etListe tr[data-k="402560"] input').fill('2');
  await page.fill('#etSuche', '');
  await shot('06a-ersatzteilliste');
  await page.click('#etOk');
  await page.waitForSelector('#importDlg[open]');
  assert.strictEqual(await page.inputValue('#importZiel'), 'bestand');
  await page.fill('#importOrt', 'Regal hinten');
  await page.click('#importOk');
  await page.waitForSelector('#importDlg[open]', { state: 'detached' });
  await page.waitForSelector('#rows tr:has-text("Akkusäure")');
  ok('Artikel aus der Ersatzteilliste in den Bestand übernommen');
  // Bezeichnung aus der Liste bei Eingabe der Nummer
  await page.click('#neuBtn'); await page.waitForTimeout(120);
  await page.fill('#fNr', '130921'); await page.press('#fNr', 'Tab');
  assert(/Automatikgetriebeöl/.test(await page.inputValue('#fName')));
  await page.click('#teilAbbr');
  ok('Bezeichnung aus der Ersatzteilliste vorgeschlagen');

  // Suche + Sortierung
  await page.click('#tabBestand');
  await page.fill('#such', '04151');
  assert.strictEqual(await page.locator('#rows tr').count(), 1);
  await page.fill('#such', '');
  await page.selectOption('#ortFilter', 'Fach A');
  assert.strictEqual(await page.locator('#rows tr').count(), 2);
  await page.selectOption('#ortFilter', '');
  ok('Suche nach Nummer ohne Bindestriche, Lagerort-Filter');
  await shot('07-bestand');

  // Excel-Export über das Programm, danach Import derselben Datei
  const xr = await page.evaluate(async () => {
    const r = await fetch('/api/excel/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blaetter: [{ titel: 'Bestand', art: 'bestand', zeilen: [{ nr: 'BT0012345', name: '=1+1', ort: 'A', menge: 2 }] }, { titel: 'Fehlende Ersatzteile', art: 'fehlt', zeilen: [{ nr: '12345-ABCDE-12', name: 'Sensor', ort: '', menge: 1 }] }] }) });
    const b = await r.blob();
    const imp = await (await fetch('/api/excel/import', { method: 'POST', body: b })).json();
    return imp;
  });
  assert(xr.ok && xr.blaetter.length === 2 && xr.blaetter[0].zeilen[0].nr === 'BT0012345' && xr.blaetter[0].zeilen[0].name === '=1+1' && xr.blaetter[1].art === 'fehlt', JSON.stringify(xr));
  ok('Excel-Export und -Import (führende Nullen, Text bleibt Text)');

  // Dialog Löschen + Rückgängig
  await page.locator('tr', { hasText: 'Kohlebürsten' }).locator('td.nr button').click();
  await page.click('#teilDel');
  await page.locator('dialog[open]').last().locator('.primary').click();
  await page.waitForSelector('#toastBtn:not([hidden])');
  assert.strictEqual(await page.textContent('#toastBtn'), 'Rückgängig');
  await page.click('#toastBtn');
  await page.waitForSelector('tr:has-text("Kohlebürsten")');
  ok('Löschen mit Rückgängig');

  // Änderung „vom Handy“ erscheint nach Abgleich
  const liste = await (await fetch(mock, { method: 'POST', body: JSON.stringify({ app: 'wagenlager', quelle: 'handy', event: 'wl_liste', ...(await page.evaluate(async () => (await (await fetch('/api/settings')).json()).user)) }) })).json();
  const oel = liste.teile.find(t => t.name === 'Ölfilter');
  await fetch(mock, { method: 'POST', body: JSON.stringify({ app: 'wagenlager', quelle: 'handy', event: 'wl_menge', teilId: oel.id, delta: -4, ...(await page.evaluate(async () => (await (await fetch('/api/settings')).json()).user)) }) });
  await page.click('#syncBtn');
  await page.waitForFunction(() => [...document.querySelectorAll('tr')].some(t => t.textContent.includes('Ölfilter') && t.querySelector('output').textContent === '2'));
  ok('Änderung vom Handy übernommen');

  await page.click('#helpBtn'); await page.waitForSelector('#helpDlg[open]'); await shot('08-anleitung'); await page.keyboard.press('Escape');

  // Dunkles Design + schmales Fenster
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('09-dunkel');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 900, height: 900 });
  await shot('10-schmal');

  assert.deepStrictEqual(fehler, []);
  console.log(`\n${schritt} Schritte bestanden, keine Fehler in der Konsole.`);
  await browser.close();
})().catch(async e => { console.error('FEHLER:', e); try{ const p = (await globalThis.__b.contexts()[0].pages())[0]; await p.screenshot({path: path.join(out, 'fehler.png')}); console.error('TOAST:', await p.textContent('#toast')); }catch(x){} process.exit(1); });
