// ---------------- QR-Code (für „Typenschild per Handy“ in den Allgemeinen Vorlagen) ----------------
// Kleiner QR-Code-Erzeuger (Byte-Modus, Fehlerkorrektur M, Version 1–20) nach dem Verfahren von ISO/IEC 18004.
// qrBmpBase64(text) liefert ein 1-Bit-BMP-Bild (Base64), das Excel direkt anzeigen kann.

var QR_ECC_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26];
var QR_BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16];

function qrRawModules(ver) {
  var r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    var n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
function qrDataCodewords(ver) { return Math.floor(qrRawModules(ver) / 8) - QR_ECC_M[ver] * QR_BLOCKS_M[ver]; }
function qrMul(x, y) {
  var z = 0;
  for (var i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; }
  return z & 0xFF;
}
function qrDivisor(deg) {
  var r = [], root = 1, i, j;
  for (i = 0; i < deg - 1; i++) r.push(0);
  r.push(1);
  for (i = 0; i < deg; i++) {
    for (j = 0; j < r.length; j++) { r[j] = qrMul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
    root = qrMul(root, 0x02);
  }
  return r;
}
function qrRemainder(data, div) {
  var r = div.map(function () { return 0; });
  data.forEach(function (b) {
    var f = b ^ r.shift(); r.push(0);
    div.forEach(function (c, i) { r[i] ^= qrMul(c, f); });
  });
  return r;
}
function qrAlignPos(ver, size) {
  if (ver === 1) return [];
  var n = Math.floor(ver / 7) + 2, step = (ver === 32) ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2, res = [6];
  for (var pos = size - 7; res.length < n; pos -= step) res.splice(1, 0, pos);
  return res;
}

function qrMatrix(text) {
  var bytes = Utilities.newBlob(String(text)).getBytes().map(function (b) { return b & 0xFF; });
  var ver;
  for (ver = 1; ver <= 20; ver++) {
    var need = 4 + (ver < 10 ? 8 : 16) + bytes.length * 8;
    if (need <= qrDataCodewords(ver) * 8) break;
  }
  if (ver > 20) throw new Error('Text zu lang für den QR-Code.');
  // Bits: Modus Byte, Länge, Daten, Ende, auffüllen
  var bits = [], cap = qrDataCodewords(ver) * 8;
  var put = function (v, n) { for (var i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(4, 4); put(bytes.length, ver < 10 ? 8 : 16);
  bytes.forEach(function (b) { put(b, 8); });
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - bits.length % 8) % 8);
  for (var pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) put(pad, 8);
  var data = [];
  for (var i = 0; i < bits.length; i += 8) { var v = 0; for (var k = 0; k < 8; k++) v = (v << 1) | bits[i + k]; data.push(v); }

  // Fehlerkorrektur und Verschränkung
  var nb = QR_BLOCKS_M[ver], ecl = QR_ECC_M[ver], raw = Math.floor(qrRawModules(ver) / 8);
  var nShort = nb - raw % nb, shortLen = Math.floor(raw / nb), div = qrDivisor(ecl), blocks = [], pos = 0;
  for (i = 0; i < nb; i++) {
    var dat = data.slice(pos, pos + shortLen - ecl + (i < nShort ? 0 : 1));
    pos += dat.length;
    var ecc = qrRemainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  var all = [];
  for (i = 0; i < blocks[0].length; i++)
    for (var j = 0; j < blocks.length; j++)
      if (i !== shortLen - ecl || j >= nShort) all.push(blocks[j][i]);

  // Matrix aufbauen
  var size = ver * 4 + 17, m = [], fn = [];
  for (i = 0; i < size; i++) { m.push([]); fn.push([]); for (j = 0; j < size; j++) { m[i].push(false); fn[i].push(false); } }
  var set = function (x, y, dark) { m[y][x] = dark; fn[y][x] = true; };
  for (i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  var finder = function (x, y) {
    for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
      var d = Math.max(Math.abs(dx), Math.abs(dy)), xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < size && yy >= 0 && yy < size) set(xx, yy, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  var ap = qrAlignPos(ver, size), na = ap.length;
  for (i = 0; i < na; i++) for (j = 0; j < na; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
    for (var ay = -2; ay <= 2; ay++) for (var ax = -2; ax <= 2; ax++) set(ap[i] + ax, ap[j] + ay, Math.max(Math.abs(ax), Math.abs(ay)) !== 1);
  }
  var mask = 0;
  var format = function () {
    var d = (0 << 3) | mask, rem = d;   // M = 00
    for (var q = 0; q < 10; q++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var b = ((d << 10) | rem) ^ 0x5412, bit = function (n) { return ((b >>> n) & 1) !== 0; };
    for (q = 0; q <= 5; q++) set(8, q, bit(q));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (q = 9; q < 15; q++) set(14 - q, 8, bit(q));
    for (q = 0; q < 8; q++) set(size - 1 - q, 8, bit(q));
    for (q = 8; q < 15; q++) set(8, size - 15 + q, bit(q));
    set(8, size - 8, true);
  };
  format();
  if (ver >= 7) {
    var rem = ver;
    for (i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    var vb = (ver << 12) | rem;
    for (i = 0; i < 18; i++) {
      var bit = ((vb >>> i) & 1) !== 0, a = size - 11 + i % 3, b2 = Math.floor(i / 3);
      set(a, b2, bit); set(b2, a, bit);
    }
  }
  // Daten im Zickzack eintragen
  var bi = 0;
  for (var right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (var vert = 0; vert < size; vert++) for (j = 0; j < 2; j++) {
      var x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
      if (!fn[y][x] && bi < all.length * 8) { m[y][x] = ((all[bi >>> 3] >>> (7 - (bi & 7))) & 1) !== 0; bi++; }
    }
  }
  // Maske 0: (x + y) gerade -> umkehren
  for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (!fn[y][x] && (x + y) % 2 === 0) m[y][x] = !m[y][x];
  return m;
}

// 1-Bit-BMP mit Ruhezone (4 Module) und `px` Pixeln pro Modul
function qrBmpBase64(text, px) {
  px = px || 6;
  var m = qrMatrix(text), n = m.length, q = 4, w = (n + 2 * q) * px;
  var rowBytes = Math.ceil(w / 32) * 4, img = rowBytes * w, off = 62, total = off + img;
  var b = [];
  var u16 = function (v) { b.push(v & 255, (v >>> 8) & 255); }, u32 = function (v) { u16(v & 0xFFFF); u16(v >>> 16); };
  b.push(0x42, 0x4D); u32(total); u32(0); u32(off);
  u32(40); u32(w); u32(w); u16(1); u16(1); u32(0); u32(img); u32(2835); u32(2835); u32(2); u32(2);
  b.push(0, 0, 0, 0, 255, 255, 255, 0);   // Farbe 0 = schwarz, 1 = weiß
  for (var row = w - 1; row >= 0; row--) {   // BMP: unterste Zeile zuerst
    var my = Math.floor(row / px) - q, line = [];
    for (var k = 0; k < rowBytes; k++) line.push(0);
    for (var col = 0; col < w; col++) {
      var mx = Math.floor(col / px) - q;
      var dark = my >= 0 && my < n && mx >= 0 && mx < n && m[my][mx];
      if (!dark) line[col >> 3] |= 0x80 >> (col & 7);
    }
    for (k = 0; k < rowBytes; k++) b.push(line[k]);
  }
  return Utilities.base64Encode(b.map(function (v) { return v > 127 ? v - 256 : v; }));
}

if (typeof module !== 'undefined') module.exports = { qrMatrix: qrMatrix, qrBmpBase64: qrBmpBase64 };
