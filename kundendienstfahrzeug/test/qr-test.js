// Prüft die Handy-Kopplung: PC zeigt QR-Code, das Handy (nachgebaut) fotografiert die Teilenummer, sie erscheint am PC.
//   node test/qr-test.js http://127.0.0.1:PORT/ http://127.0.0.1:8765/ ordner-mit-qr-bildern
//   (Ordner: foto-gross.jpg = QR „BT7601465-002“, qr2.png = Link ohne Nummer)
'use strict';
const { chromium } = require('playwright');
const path = require('path'), assert = require('assert');
const [app, mock, dir] = process.argv.slice(2);
const handySeite = 'file://' + path.join(__dirname, '..', '..', 'docs', 'kundendienstfahrzeug', 'index.html');
let schritt = 0; const ok = t => console.log(`✓ ${++schritt}. ${t}`);

async function anmelden(page) {
  await page.goto(app);
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

(async () => {
  const browser = await chromium.launch();
  const pc = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'de-DE' })).newPage();
  const fehler = []; pc.on('pageerror', e => fehler.push(String(e))); pc.on('console', m => { if (m.type() === 'error') fehler.push(m.text()); });
  await anmelden(pc);
  const user = (await (await fetch(app + 'api/settings')).json()).user;
  assert(user && user.id && user.email, 'Nutzer fehlt');

  // Handy nachbauen: gleiche Anmeldung, Serveranfragen an die Nachbildung umleiten
  const hctx = await browser.newContext({ viewport: { width: 390, height: 800 }, locale: 'de-DE' });
  await hctx.route('https://script.google.com/**', async route => {
    const r = await fetch(mock, { method: 'POST', body: route.request().postData() });
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: await r.text() });
  });
  const handy = await hctx.newPage();
  handy.on('pageerror', e => fehler.push('Handy: ' + e));
  const handyStart = async url => {
    await handy.goto(handySeite); // gleicher Ursprung für localStorage
    await handy.evaluate(u => localStorage.setItem('wl_nutzer', JSON.stringify({ id: u.id, name: u.name || 'Max Muster', email: u.email, verified: true })), user);
    await handy.goto(url);
  };

  // 1. PC: Dialog „Neues Teil“ → „Handy“ zeigt QR-Code mit Link
  await pc.click('#neuBtn'); await pc.click('#fHandy');
  await pc.waitForSelector('#handyKDlg[open]');
  const url = await pc.evaluate(() => document.querySelector('#hkCanvas').dataset.url);
  assert(/^https:\/\/.+\?koppeln=[a-f0-9]{20}$/.test(url), 'Link: ' + url);
  ok('PC zeigt QR-Code mit Kopplungs-Link');

  // 2. Handy öffnet den Link → Foto-Blatt, Foto mit QR → Nummer kommt am PC an
  await handyStart(handySeite + '?koppeln=' + url.split('=')[1]);
  await handy.waitForSelector('#koppelBlatt:not([hidden])');
  await handy.setInputFiles('#koppelIn', path.join(dir, 'foto-gross.jpg'));
  await handy.waitForFunction(() => /angekommen/.test(document.querySelector('#koppelInfo').textContent), null, { timeout: 20000 });
  ok('Handy fotografiert: „Nummer ist am PC angekommen“');
  await pc.waitForFunction(() => document.querySelector('#fNr').value === 'BT7601465-002', null, { timeout: 15000 });
  await pc.waitForSelector('#handyKDlg[open]', { state: 'detached', timeout: 5000 });
  ok('PC trägt BT7601465-002 ein und schließt den QR-Dialog');

  // 3. Abbrechen beendet die Abfrage; zweite Kopplung hat ein neues Kennzeichen (Token)
  await pc.fill('#fNr', ''); await pc.click('#fHandy'); await pc.waitForSelector('#handyKDlg[open]');
  const url2 = await pc.evaluate(() => document.querySelector('#hkCanvas').dataset.url);
  assert.notStrictEqual(url2, url);
  await pc.click('#handyKDlg button.ghost'); await pc.waitForSelector('#handyKDlg[open]', { state: 'detached' });
  ok('Abbrechen schließt den Dialog, neuer Token pro Kopplung');
  assert.deepStrictEqual(fehler, [], 'Konsolenfehler: ' + fehler.join(' | '));
  await browser.close();
  console.log(`${schritt} Schritte bestanden.`);
})().catch(e => { console.error('FEHLER:', e.message || e); process.exit(1); });
