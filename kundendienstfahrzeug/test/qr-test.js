// Prüft QR-/Strichcode-Scan im Dialog „Neues Teil“: Live-Kamera (simuliert) und Foto.
//   node test/qr-test.js http://127.0.0.1:PORT/ http://127.0.0.1:8765/ ordner-mit-qr-bildern
//   (Ordner: cam0.y4m = QR „7601465-002“, cam1.y4m = QR „BT7601465-002“, foto-gross.jpg, qr2.png = Link ohne Nummer)
'use strict';
const { chromium } = require('playwright');
const path = require('path'), assert = require('assert');
const [app, mock, dir] = process.argv.slice(2);
let schritt = 0; const ok = t => console.log(`✓ ${++schritt}. ${t}`);

async function anmelden(page) {
  await page.goto(app);
  // Das Programm merkt sich die Anmeldung – beim zweiten Browser ist sie schon da
  await page.waitForSelector('#regDlg[open], #syncChip.ok');
  if (await page.$('#syncChip.ok')) return;
  await page.fill('#regName', 'Max Muster');
  await page.click('#regOk');
  await page.waitForSelector('#codeDlg[open]');
  const mails = await (await fetch(mock + '__mails')).json();
  await page.fill('#codeInput', /: (\d{6})$/.exec(mails[mails.length - 1].subject)[1]);
  await page.click('#codeOk');
  await page.waitForSelector('#syncChip.ok');
  await page.waitForSelector('#fzDlg[open]');
  await page.fill('#fzKzIn', 'OL-SG 123');
  await page.click('#fzOk');
  await page.waitForSelector('#fzDlg[open]', { state: 'detached' });
}

async function neueSeite(cam) {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=' + path.join(dir, cam)] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'de-DE' });
  await ctx.grantPermissions(['camera'], { origin: app.replace(/\/$/, '') });
  const page = await ctx.newPage();
  const fehler = []; page.on('pageerror', e => fehler.push(String(e))); page.on('console', m => { if (m.type() === 'error') fehler.push(m.text()); });
  return { browser, page, fehler };
}

(async () => {
  // 1. Live-Kamera mit QR „7601465-002“ (ohne BT) – bleibt wie gelesen
  let { browser, page, fehler } = await neueSeite('cam0.y4m');
  await anmelden(page);
  await page.click('#neuBtn');
  await page.click('#fQr');
  await page.waitForSelector('#qrDlg[open]');
  await page.waitForFunction(() => document.querySelector('#fNr').value === '7601465-002', null, { timeout: 20000 });
  await page.waitForSelector('#qrDlg[open]', { state: 'detached', timeout: 5000 });
  assert.strictEqual(await page.evaluate(() => !!document.querySelector('#qrVideo').srcObject), false, 'Kamera muss danach aus sein');
  ok('Live-Scan: Nummer 7601465-002 eingetragen, Kamera wieder aus');

  // 2. Tippen mit BT davor behält den Bindestrich
  await page.fill('#fNr', 'bt 7601465-002'); await page.press('#fNr', 'Tab');
  assert.strictEqual(await page.inputValue('#fNr'), 'BT7601465-002');
  ok('BT7601465-002 bleibt mit Bindestrich');

  // 3. Foto: kleiner schräger QR in großem Bild
  await page.fill('#fNr', ''); await page.setInputFiles('#fFoto', path.join(dir, 'foto-gross.jpg'));
  await page.waitForFunction(() => document.querySelector('#fNr').value === 'BT7601465-002', null, { timeout: 20000 });
  ok('Foto mit kleinem schrägem QR-Code gelesen');

  // 4. Foto mit QR ohne Teilenummer (nur ein Link) → Texterkennung übernimmt
  await page.fill('#fNr', ''); await page.setInputFiles('#fFoto', path.join(dir, 'qr2.png'));
  await page.waitForFunction(() => document.querySelector('#fNr').value === '67405-T1000-71', null, { timeout: 20000 });
  ok('QR ohne Teilenummer: Texterkennung wie bisher');
  assert.deepStrictEqual(fehler, [], 'Konsolenfehler: ' + fehler.join(' | '));
  await browser.close();

  // 5. Live-Kamera mit QR „BT7601465-002“
  ({ browser, page, fehler } = await neueSeite('cam1.y4m'));
  await anmelden(page);
  await page.click('#neuBtn'); await page.click('#fQr');
  await page.waitForFunction(() => document.querySelector('#fNr').value === 'BT7601465-002', null, { timeout: 20000 });
  ok('Live-Scan: BT7601465-002 eingetragen');

  // 6. Kamera öffnen und wieder abbrechen schaltet die Kamera aus
  await page.fill('#fNr', ''); await page.click('#fQr'); await page.waitForSelector('#qrDlg[open]');
  await page.click('#qrDlg button.ghost');
  await page.waitForSelector('#qrDlg[open]', { state: 'detached' });
  const stand = async () => page.evaluate(() => ({ video: !!document.querySelector('#qrVideo').srcObject, dialog: document.querySelector('#qrDlg').open, nr: document.querySelector('#fNr').value }));
  const aus = await page.waitForFunction(() => !document.querySelector('#qrVideo').srcObject, null, { timeout: 4000 }).then(() => true, () => false);
  assert(aus, 'Kamera noch an: ' + JSON.stringify(await stand()));
  ok('Abbrechen schaltet die Kamera aus');
  assert.deepStrictEqual(fehler, [], 'Konsolenfehler: ' + fehler.join(' | '));
  await browser.close();
  console.log(`${schritt} Schritte bestanden.`);
})().catch(e => { console.error('FEHLER:', e.message || e); process.exit(1); });
