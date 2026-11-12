// Nachbildung des Apps-Script-Servers zum Testen: lädt admin/Code.gs + admin/Kundendienstfahrzeug.js mit
// nachgebauten Google-Diensten (Tabelle, Eigenschaften, Sperre, E-Mail) und bedient doPost über HTTP.
//   node test/server-nachbildung.js 8765        → Server auf 127.0.0.1:8765
//   GET /__mails liefert die verschickten Freischaltcodes (nur in der Nachbildung).
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http'), crypto = require('crypto');

function machSheet(name) {
  const rows = [];
  const s = {
    name, rows,
    getName: () => name,
    appendRow: r => { rows.push(r.map(v => (typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v))); },
    getLastRow: () => rows.length,
    getLastColumn: () => rows.reduce((m, r) => Math.max(m, r.length), 0),
    setFrozenRows() {},
    deleteRows: (start, n) => { rows.splice(start - 1, n); },
    deleteRow: r => { rows.splice(r - 1, 1); },
    getRange(r, c, nr = 1, nc = 1) {
      const cell = (i, j) => { const row = rows[r - 1 + i]; const v = row ? row[c - 1 + j] : undefined; return v === undefined ? '' : v; };
      const set = (i, j, v) => { while (rows.length < r + i) rows.push([]); const row = rows[r - 1 + i]; while (row.length < c + j) row.push(''); row[c - 1 + j] = v; };
      const leer = v => (typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v);
      return {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cell(i, j))),
        getValue: () => cell(0, 0),
        setValues: vals => { if (vals.length !== nr || vals[0].length !== nc) throw new Error('setValues: Größe passt nicht'); vals.forEach((row, i) => row.forEach((v, j) => set(i, j, leer(v)))); },
        setValue: v => set(0, 0, leer(v)),
        clearContent: () => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) set(i, j, ''); },
        setFontWeight() { return this; },
      };
    },
  };
  return s;
}

function machUmgebung() {
  const sheets = {};
  const props = {};
  const mails = [];
  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = machSheet(n)),
    getSheets: () => Object.values(sheets),
  };
  const ctx = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); }, deleteProperty: k => { delete props[k]; }, getProperties: () => ({ ...props }) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    MailApp: { sendEmail: m => mails.push(m), getRemainingDailyQuota: () => 100 },
    Utilities: { getUuid: () => crypto.randomUUID(), formatDate: d => d.toISOString().slice(0, 10), newBlob: s => ({ getBytes: () => Array.from(Buffer.from(String(s))) }), base64Encode: b => Buffer.from(b).toString('base64') },
    ContentService: { MimeType: { JSON: 'json', TEXT: 'text' }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
  };
  vm.createContext(ctx);
  const admin = path.join(__dirname, '..', '..', 'admin');
  const ohneExport = f => fs.readFileSync(path.join(admin, f), 'utf8').replace(/^if \(typeof module.*$/m, '');
  let code = fs.readFileSync(path.join(admin, 'Code.gs'), 'utf8').replace("const KEY = 'HIER_SCHLUESSEL_EINTRAGEN';", "const KEY = 'testschluessel';");
  for (const f of ['Typenschild.js', 'QrCode.js', 'Vorlagen.js', 'Kundendienstfahrzeug.js']) code += '\n' + ohneExport(f);
  vm.runInContext(code + '\n;this.doPost = doPost;', ctx, { filename: 'Code.gs+Module' });
  // Texterkennung nachbilden (Google gibt es hier nicht)
  if (process.env.KDF_OCR_TEXT) vm.runInContext('googleOcr = function () { return ' + JSON.stringify(process.env.KDF_OCR_TEXT) + '; };', ctx);
  const post = d => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(d) } }).text);
  return { post, sheets, props, mails, ctx };
}

module.exports = { machUmgebung };

if (require.main === module) {
  const port = Number(process.argv[2] || 8765);
  const u = machUmgebung();
  http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/__mails') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(u.mails)); }
    if (req.method === 'GET' && req.url === '/__blatt') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(u.sheets['Kundendienstfahrzeug'] ? u.sheets['Kundendienstfahrzeug'].rows : [])); }
    let b = '';
    req.on('data', c => (b += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      try { res.end(JSON.stringify(u.post(JSON.parse(b)))); } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e && e.stack || e) })); }
    });
  }).listen(port, '127.0.0.1', () => console.log('Nachbildung läuft auf http://127.0.0.1:' + port + '/'));
}
