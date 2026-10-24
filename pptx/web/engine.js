/* PDF zu PowerPoint – Umwandlungs-Kern (läuft im Programmfenster, nutzt PDFium als WebAssembly)
 *
 * Jede PDF-Seite wird in drei Ebenen zerlegt:
 *   1. Hintergrund – seitenfüllende Bilder/Flächen unter dem Text → echter Folienhintergrund
 *   2. Grafik      – Logos, Formen, Linien, Bilder (transparentes Bild)
 *   3. Text        – bearbeitbare Textfelder (oder im Bild-Modus als transparentes Bild)
 *
 * Die Datei läuft auch unter Node (für Tests): module.exports = PdfEngine.
 */
(function (root) {
  "use strict";

  const BG_COVERAGE = 0.85;   // ab diesem Flächenanteil gilt ein Objekt als Hintergrund
  const HIDE = 200000;        // Objekte zum Ausblenden aus dem Sichtbereich schieben
  const T_TEXT = 1, T_PATH = 2, T_IMAGE = 3, T_SHADING = 4, T_FORM = 5;
  const INVISIBLE = 3;        // Textdarstellungsmodus „unsichtbar“ (z. B. OCR-Ebene von Scans)
  const FLAG_REVERSE_BYTE_ORDER = 0x10;

  class PdfEngine {
    constructor(M) {
      this.M = M;
      M._FPDF_InitLibrary();
      this.tmp = M._malloc(512);
      this.name = M._malloc(512);
    }

    // ---------------------------------------------------------------- Speicherhilfen
    f32(i) { return this.M.HEAPF32[(this.tmp >> 2) + i]; }
    f64(i) { return this.M.HEAPF64[(this.tmp >> 3) + i]; }
    u32(i) { return this.M.HEAPU32[(this.tmp >> 2) + i]; }

    // ---------------------------------------------------------------- Dokument
    open(bytes) {
      const M = this.M;
      const ptr = M._malloc(bytes.length);
      M.HEAPU8.set(bytes, ptr);
      const doc = M._FPDF_LoadMemDocument(ptr, bytes.length, 0);
      if (!doc) {
        const e = M._FPDF_GetLastError();
        M._free(ptr);
        throw new Error(e === 4 ? "Die PDF ist mit einem Passwort geschützt."
          : "Die Datei ist keine gültige PDF oder beschädigt.");
      }
      return { doc, ptr, pages: M._FPDF_GetPageCount(doc) };
    }

    close(h) {
      if (!h || !h.doc) return;
      this.M._FPDF_CloseDocument(h.doc);
      this.M._free(h.ptr);
      h.doc = 0;
    }

    _geometry(page) {
      const M = this.M, t = this.tmp;
      let ok = M._FPDFPage_GetCropBox(page, t, t + 4, t + 8, t + 12);
      if (!ok) ok = M._FPDFPage_GetMediaBox(page, t, t + 4, t + 8, t + 12);
      let l, b, r, top;
      if (ok) { l = this.f32(0); b = this.f32(1); r = this.f32(2); top = this.f32(3); }
      else { l = 0; b = 0; r = M._FPDF_GetPageWidthF(page); top = M._FPDF_GetPageHeightF(page); }
      if (r < l) [l, r] = [r, l];
      if (top < b) [b, top] = [top, b];
      return { l, b, r, t: top, w: r - l, h: top - b, rot: M._FPDFPage_GetRotation(page) };
    }

    // Alle Seitenobjekte in Zeichenreihenfolge (auch in Formularen verschachtelte)
    _walk(page, cb) {
      const M = this.M;
      let idx = 0;
      const visit = (obj, mats) => {
        const type = M._FPDFPageObj_GetType(obj);
        cb(obj, type, mats, idx++);
        if (type === T_FORM) {
          const t = this.tmp;
          let m = [1, 0, 0, 1, 0, 0];
          if (M._FPDFPageObj_GetMatrix(obj, t)) m = [0, 1, 2, 3, 4, 5].map(i => this.f32(i));
          const n = M._FPDFFormObj_CountObjects(obj);
          for (let j = 0; j < n; j++) {
            const child = M._FPDFFormObj_GetObject(obj, j);
            if (child) visit(child, mats.concat([m]));
          }
        }
      };
      const n = M._FPDFPage_CountObjects(page);
      for (let i = 0; i < n; i++) {
        const o = M._FPDFPage_GetObject(page, i);
        if (o) visit(o, []);
      }
    }

    _classify(page, g) {
      const M = this.M, t = this.tmp;
      const area = Math.max(g.w * g.h, 1);
      const entries = [];
      let firstText = -1;
      this._walk(page, (obj, type, mats, i) => {
        let l = g.l, b = g.b, r = g.r, tp = g.t;
        if (M._FPDFPageObj_GetBounds(obj, t, t + 4, t + 8, t + 12)) {
          l = this.f32(0); b = this.f32(1); r = this.f32(2); tp = this.f32(3);
        }
        let pts = [[l, b], [l, tp], [r, b], [r, tp]];
        for (let k = mats.length - 1; k >= 0; k--) {
          const [a, bb, c, d, e, f] = mats[k];
          pts = pts.map(([x, y]) => [a * x + c * y + e, bb * x + d * y + f]);
        }
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        const x0 = Math.min(...xs) - g.l, x1 = Math.max(...xs) - g.l;
        const top = g.t - Math.max(...ys), bottom = g.t - Math.min(...ys);
        if (type === T_TEXT && firstText < 0) firstText = i;
        const ix = Math.max(Math.min(x1, g.w) - Math.max(x0, 0), 0);
        const iy = Math.max(Math.min(bottom, g.h) - Math.max(top, 0), 0);
        entries.push({ type, cover: ix * iy / area, bg: false });
      });
      const limit = firstText < 0 ? entries.length : firstText;
      for (let i = 0; i < limit; i++) {
        const e = entries[i];
        if ((e.type === T_IMAGE || e.type === T_PATH || e.type === T_SHADING) && e.cover >= BG_COVERAGE) e.bg = true;
      }
      return entries;
    }

    // Seite neu laden, alle Objekte außer keep(i) ausblenden und rendern (RGBA)
    _renderLayer(h, idx, scale, keep, transparent) {
      const M = this.M;
      const page = M._FPDF_LoadPage(h.doc, idx);
      try {
        if (keep) {
          this._walk(page, (obj, type, mats, i) => {
            if (type !== T_FORM && !keep(i)) M._FPDFPageObj_Transform(obj, 1, 0, 0, 1, HIDE, HIDE);
          });
        }
        const w = Math.max(1, Math.round(M._FPDF_GetPageWidthF(page) * scale));
        const hh = Math.max(1, Math.round(M._FPDF_GetPageHeightF(page) * scale));
        const bmp = M._FPDFBitmap_Create(w, hh, 1);
        if (!bmp) throw new Error("Zu wenig Speicher für diese Seite.");
        M._FPDFBitmap_FillRect(bmp, 0, 0, w, hh, transparent ? 0x00FFFFFF : 0xFFFFFFFF);
        M._FPDF_RenderPageBitmap(bmp, page, 0, 0, w, hh, 0, FLAG_REVERSE_BYTE_ORDER);
        const buf = M._FPDFBitmap_GetBuffer(bmp), stride = M._FPDFBitmap_GetStride(bmp);
        const out = new Uint8ClampedArray(w * hh * 4);
        const heap = M.HEAPU8;
        for (let y = 0; y < hh; y++) out.set(heap.subarray(buf + y * stride, buf + y * stride + w * 4), y * w * 4);
        M._FPDFBitmap_Destroy(bmp);
        return { w, h: hh, data: out };
      } finally {
        M._FPDF_ClosePage(page);
      }
    }

    // ---------------------------------------------------------------- Text
    _fontName(ptr, len) {
      if (len <= 1) return "";
      let s = "";
      const heap = this.M.HEAPU8;
      for (let i = 0; i < Math.min(len - 1, 500); i++) s += String.fromCharCode(heap[ptr + i]);
      return s;
    }

    _extractWords(page, g) {
      const M = this.M, t = this.tmp;
      const tp = M._FPDFText_LoadPage(page);
      if (!tp) return [];
      const words = [];
      let cur = null;
      const flush = () => { if (cur && cur.text.trim()) words.push(cur); cur = null; };
      try {
        const n = M._FPDFText_CountChars(tp);
        let lastObj = 0, lastInvisible = false;
        for (let i = 0; i < n; i++) {
          const u = M._FPDFText_GetUnicode(tp, i);
          if (M._FPDFText_IsGenerated(tp, i) || u === 32 || u === 9 || u === 10 || u === 13 || u === 0xA0 || u === 0 || u === 0xFFFE || u === 2) {
            flush();
            continue;
          }
          const obj = M._FPDFText_GetTextObject(tp, i);
          if (obj !== lastObj) {
            lastObj = obj;
            lastInvisible = !!obj && M._FPDFTextObj_GetTextRenderMode(obj) === INVISIBLE;
          }
          if (lastInvisible) { flush(); continue; }

          let ch = String.fromCodePoint(u);
          if (u >= 0xF000 && u <= 0xF0FF) ch = "•";                // Symbol-/Wingdings-Aufzählungszeichen
          if (u === 0xAD) continue;                                  // weiches Trennzeichen

          M._FPDFText_GetCharOrigin(tp, i, t, t + 8);
          const ox = this.f64(0), oy = this.f64(1);
          let x0 = ox, x1 = ox;
          if (M._FPDFText_GetCharBox(tp, i, t, t + 8, t + 16, t + 24)) {
            const l = this.f64(0), r = this.f64(1);
            if (r > l) { x0 = l; x1 = r; }
          }
          const size = M._FPDFText_GetFontSize(tp, i) || 12;
          const len = M._FPDFText_GetFontInfo(tp, i, this.name, 500, t);
          const flags = len ? M.HEAP32[t >> 2] : 0;
          const raw = this._fontName(this.name, len);
          const weight = M._FPDFText_GetFontWeight(tp, i);
          let color = [0, 0, 0];
          if (M._FPDFText_GetFillColor(tp, i, t, t + 4, t + 8, t + 12)) color = [this.u32(0), this.u32(1), this.u32(2)];
          const f = fontInfo(raw);
          const bold = f.bold || weight >= 600 || !!(flags & 0x40000);
          const italic = f.italic || !!(flags & 0x40);
          const font = ch === "•" ? "Arial" : f.family;

          const X0 = x0 - g.l, X1 = x1 - g.l, base = g.t - oy;
          const style = font + "|" + Math.round(size * 2) + "|" + bold + "|" + italic + "|" + color.join(",");
          if (cur && (cur.style !== style || Math.abs(cur.base - base) > 0.3 * size ||
                      X0 - cur.x1 > 0.25 * size || X0 < cur.x1 - size)) flush();
          if (!cur) {
            cur = { text: "", x0: X0, x1: X1, base, size, font, bold, italic, color, style };
          }
          cur.text += ch;
          cur.x0 = Math.min(cur.x0, X0);
          cur.x1 = Math.max(cur.x1, X1);
        }
        flush();
      } finally {
        M._FPDFText_ClosePage(tp);
      }
      return words.map(w => ({
        text: w.text, x0: w.x0, x1: w.x1, size: w.size,
        top: w.base - 0.8 * w.size, bottom: w.base + 0.2 * w.size,
        font: w.font, bold: w.bold, italic: w.italic, color: w.color,
      }));
    }

    // ---------------------------------------------------------------- Seite zerlegen
    analyzePage(h, idx, dpi = 200) {
      const M = this.M;
      const scale = dpi / 72;
      const page = M._FPDF_LoadPage(h.doc, idx);
      if (!page) throw new Error(`Seite ${idx + 1} konnte nicht gelesen werden.`);
      let g, entries, words = [];
      try {
        g = this._geometry(page);
        entries = this._classify(page, g);
        if (g.rot === 0) words = this._extractWords(page, g);
      } finally {
        M._FPDF_ClosePage(page);
      }
      const res = { index: idx, width: g.w, height: g.h, bg: null, gfx: null, text: null, blocks: [] };

      // Gedrehte Seiten: als ein Bild übernehmen (Hintergrund = ganze Seite)
      if (g.rot !== 0) {
        const img = this._renderLayer(h, idx, scale, null, false);
        res.width = img.w / scale; res.height = img.h / scale;
        res.bg = img;
        return res;
      }

      const isBg = entries.map(e => e.bg);
      const isText = entries.map(e => e.type === T_TEXT);

      if (isBg.some(Boolean)) res.bg = this._renderLayer(h, idx, scale, i => isBg[i], false);

      if (entries.some((e, i) => !isBg[i] && !isText[i] && e.type !== T_FORM)) {
        const img = this._renderLayer(h, idx, scale, i => !isBg[i] && !isText[i], true);
        const box = alphaBox(img);
        if (box) {
          const c = crop(img, box);
          c.box = [box[0] / scale, box[1] / scale, (box[2] - box[0]) / scale, (box[3] - box[1]) / scale];
          res.gfx = c;
        }
      }

      if (isText.some(Boolean)) {
        const img = this._renderLayer(h, idx, scale, i => isText[i], true);
        if (alphaBox(img)) res.text = img;
        res.blocks = groupBlocks(words);
      }
      return res;
    }
  }

  // ------------------------------------------------------------------ Hilfsfunktionen
  function alphaBox(img) {
    const { w, h, data } = img;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      for (let x = 0; x < w; x++) {
        if (data[row + x * 4 + 3] > 2) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          y1 = y;
        }
      }
    }
    return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
  }

  function crop(img, [x0, y0, x1, y1]) {
    const w = x1 - x0, h = y1 - y0;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const s = ((y0 + y) * img.w + x0) * 4;
      out.set(img.data.subarray(s, s + w * 4), y * w * 4);
    }
    return { w, h, data: out };
  }

  const FONT_MAP = {
    arialmt: "Arial", arial: "Arial", helvetica: "Arial", helveticaneue: "Arial",
    liberationsans: "Arial", arimo: "Arial",
    timesnewromanpsmt: "Times New Roman", timesnewroman: "Times New Roman", times: "Times New Roman",
    timesroman: "Times New Roman", liberationserif: "Times New Roman", tinos: "Times New Roman",
    couriernewpsmt: "Courier New", courier: "Courier New", couriernew: "Courier New",
    liberationmono: "Courier New", cousine: "Courier New",
    carlito: "Calibri", caladea: "Cambria", symbolmt: "Symbol", wingdings: "Wingdings",
  };

  function fontInfo(name) {
    name = name || "";
    if (name.includes("+")) name = name.split("+").slice(1).join("+");
    const low = name.toLowerCase();
    const bold = /bold|black|heavy|semibold|demi/.test(low);
    const italic = /italic|oblique/.test(low);
    let family = name.split(/[-,]/)[0];
    const key = family.toLowerCase().replace(/\s/g, "");
    if (FONT_MAP[key]) return { family: FONT_MAP[key], bold, italic };
    family = family.replace(/(PSMT|MT|PS)$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
    for (const suf of [" Bold", " Italic", " Regular"]) if (family.endsWith(suf)) family = family.slice(0, -suf.length);
    return { family: family || "Calibri", bold, italic };
  }

  // Wörter → Zeilen → Absätze (gleiche Logik wie in der getesteten Desktop-Version)
  function groupBlocks(words) {
    words.sort((a, b) => Math.round(a.bottom) - Math.round(b.bottom) || a.x0 - b.x0);
    const lines = [];
    for (const w of words) {
      let target = null;
      for (let k = lines.length - 1; k >= Math.max(0, lines.length - 30); k--) {
        const ln = lines[k];
        const tol = 0.35 * Math.max(ln.size, w.size);
        const gap = w.x0 - ln.x1;
        if (Math.abs(ln.bottom - w.bottom) <= tol && gap >= -0.5 * w.size && gap <= 2.0 * Math.max(ln.size, w.size)) {
          target = ln; break;
        }
      }
      if (!target) {
        target = { x0: w.x0, x1: w.x1, top: w.top, bottom: w.bottom, size: w.size, words: [], runs: [], textX: null };
        lines.push(target);
      }
      target.words.push(w);
      target.x0 = Math.min(target.x0, w.x0); target.x1 = Math.max(target.x1, w.x1);
      target.top = Math.min(target.top, w.top); target.bottom = Math.max(target.bottom, w.bottom);
      target.size = Math.max(target.size, w.size);
    }

    for (const ln of lines) {
      const ws = ln.words.slice().sort((a, b) => a.x0 - b.x0);
      let prev = null;
      for (const w of ws) {
        let sep = "";
        if (prev && w.x0 - prev.x1 > 0.12 * w.size) sep = " ";
        if (prev && ln.runs.length === 1 && ln.runs[0].text === "•") {
          ln.textX = w.x0;
          if (w.x0 - prev.x1 > 0.45 * w.size) sep = "\t";
        }
        const style = [w.font, Math.round(w.size * 10) / 10, w.bold, w.italic, w.color.join(",")].join("|");
        const last = ln.runs[ln.runs.length - 1];
        if (last && last.style === style) last.text += sep + w.text;
        else {
          if (sep && last) last.text += sep;
          ln.runs.push({ text: w.text, font: w.font, size: w.size, bold: w.bold, italic: w.italic, color: w.color, style });
        }
        prev = w;
      }
      ln.baseline = ln.bottom - 0.2 * ln.size;
      ln.center = (ln.x0 + ln.x1) / 2;
    }

    lines.sort((a, b) => a.top - b.top || a.x0 - b.x0);
    const blocks = [];
    for (const ln of lines) {
      let placed = false;
      for (let k = blocks.length - 1; k >= Math.max(0, blocks.length - 15); k--) {
        const blk = blocks[k];
        const last = blk.lines[blk.lines.length - 1];
        const ratio = ln.size / Math.max(last.size, 0.1);
        const step = ln.baseline - last.baseline;
        if (ratio < 0.8 || ratio > 1.25) continue;
        if (!(step > 0.6 * last.size && step <= 1.9 * last.size)) continue;
        const tol = 0.6 * last.size;
        const left = Math.abs(ln.x0 - last.x0) <= tol || Math.abs(ln.x0 - blk.lines[0].x0) <= tol ||
          blk.lines.some(l => l.textX !== null && Math.abs(ln.x0 - l.textX) <= tol);
        const cent = Math.abs(ln.center - last.center) <= tol;
        const right = Math.abs(ln.x1 - last.x1) <= tol;
        if (!(left || cent || right)) continue;
        const mode = blk.lines.length > 1 ? blk.align : (left ? "left" : cent ? "center" : "right");
        if ((mode === "left" && !left) || (mode === "center" && !cent) || (mode === "right" && !right)) continue;
        blk.align = mode;
        blk.lines.push(ln);
        placed = true;
        break;
      }
      if (!placed) blocks.push({ lines: [ln], align: "left" });
    }
    return blocks.map(blockToShape);
  }

  // Textblock → Textfeld (Position, Einzüge, Zeilenabstand) in pt
  function blockToShape(blk) {
    const first = blk.lines[0];
    const size = first.size;
    const x0 = Math.min(...blk.lines.map(l => l.x0));
    const x1 = Math.max(...blk.lines.map(l => l.x1));
    const width = x1 - x0;
    const extra = width * 0.15 + size;          // Puffer für abweichende Schriftbreiten
    let left, boxW;
    if (blk.align === "center") { left = x0 - extra / 2; boxW = width + extra; }
    else if (blk.align === "right") { left = x0 - extra; boxW = width + extra; }
    else { left = x0; boxW = width + extra; }
    let spacing = size * 1.2;
    if (blk.lines.length > 1) {
      let s = 0;
      for (let i = 1; i < blk.lines.length; i++) s += blk.lines[i].baseline - blk.lines[i - 1].baseline;
      spacing = s / (blk.lines.length - 1);
    }
    const top = first.baseline - 0.8 * spacing;
    const paras = blk.lines.map(ln => {
      let marL = 0, indent = 0;
      if (blk.align === "left") {
        if (ln.textX !== null) { marL = ln.textX - left; indent = ln.x0 - ln.textX; }
        else if (ln.x0 - left > 0.5) marL = ln.x0 - left;
      }
      return {
        marL, indent, spacing,
        runs: ln.runs.map(r => ({ t: r.text, font: r.font, size: Math.round(r.size * 2) / 2, b: r.bold, i: r.italic,
          color: r.color.map(v => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, "0")).join("").toUpperCase() })),
      };
    });
    return { x: left, y: top, w: boxW, h: spacing * blk.lines.length, align: blk.align, paras };
  }

  PdfEngine.fontInfo = fontInfo;
  PdfEngine.groupBlocks = groupBlocks;

  if (typeof module !== "undefined" && module.exports) module.exports = PdfEngine;
  else root.PdfEngine = PdfEngine;
})(typeof self !== "undefined" ? self : this);
