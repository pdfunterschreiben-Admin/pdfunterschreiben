package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Excel-Export (Bestand + Fehlende Ersatzteile) und -Import, ohne dass Excel installiert sein muss.

type xlZeile struct {
	Nr    string `json:"nr"`
	Name  string `json:"name"`
	Ort   string `json:"ort"`
	Menge int    `json:"menge"`
}

type xlBlatt struct {
	Titel  string    `json:"titel"`
	Art    string    `json:"art"` // "bestand" | "fehlt"
	Zeilen []xlZeile `json:"zeilen"`
}

func xmlText(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

func spalte(i int) string { return string(rune('A' + i)) }

// textZelle: als Text (inlineStr), damit Excel aus 0012345 oder =… nichts anderes macht.
func textZelle(ref, s string, stil int) string {
	return fmt.Sprintf(`<c r="%s" t="inlineStr" s="%d"><is><t xml:space="preserve">%s</t></is></c>`, ref, stil, xmlText(s))
}

func blattXML(bl xlBlatt, info [][2]string) string {
	kopf := []string{"Ersatzteilnummer", "Bezeichnung", "Stückzahl", "Lagerort"}
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`)
	b.WriteString(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`)
	// Oben Kennzeichen, Fahrer, Stand – darunter eine Leerzeile und die Tabelle
	k := 1
	if len(info) > 0 {
		k = len(info) + 2
	}
	b.WriteString(fmt.Sprintf(`<sheetViews><sheetView workbookViewId="0"><pane ySplit="%d" topLeftCell="A%d" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`, k, k+1))
	b.WriteString(`<cols><col min="1" max="1" width="24" customWidth="1"/><col min="2" max="2" width="44" customWidth="1"/><col min="3" max="3" width="12" customWidth="1"/><col min="4" max="4" width="28" customWidth="1"/></cols>`)
	b.WriteString(`<sheetData>`)
	for i, x := range info {
		r := strconv.Itoa(i + 1)
		b.WriteString(`<row r="` + r + `">` + textZelle("A"+r, x[0], 3) + textZelle("B"+r, x[1], 4) + `</row>`)
	}
	kr := strconv.Itoa(k)
	b.WriteString(`<row r="` + kr + `">`)
	for i, h := range kopf {
		b.WriteString(textZelle(spalte(i)+kr, h, 1))
	}
	b.WriteString(`</row>`)
	for i, z := range bl.Zeilen {
		r := strconv.Itoa(i + k + 1)
		b.WriteString(`<row r="` + r + `">`)
		b.WriteString(textZelle("A"+r, z.Nr, 0))
		b.WriteString(textZelle("B"+r, z.Name, 0))
		b.WriteString(fmt.Sprintf(`<c r="C%s" s="2"><v>%d</v></c>`, r, z.Menge))
		b.WriteString(textZelle("D"+r, z.Ort, 0))
		b.WriteString(`</row>`)
	}
	b.WriteString(`</sheetData>`)
	b.WriteString(fmt.Sprintf(`<autoFilter ref="A%d:D%d"/>`, k, len(bl.Zeilen)+k))
	b.WriteString(`<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>`)
	b.WriteString(`<pageSetup orientation="portrait" paperSize="9" fitToWidth="1" fitToHeight="0"/>`)
	b.WriteString(`</worksheet>`)
	return b.String()
}

const xlStyles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><sz val="11"/><color rgb="FF5B6880"/><name val="Calibri"/></font><font><b/><sz val="13"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1D3FB8"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5"><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="49" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Standard" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`

func baueXLSX(blaetter []xlBlatt, info [][2]string) ([]byte, error) {
	if len(blaetter) == 0 {
		return nil, errors.New("Keine Daten.")
	}
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	add := func(name, inhalt string) error {
		w, err := z.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: time.Now()})
		if err != nil {
			return err
		}
		_, err = io.WriteString(w, inhalt)
		return err
	}
	var ct, rels, sheets strings.Builder
	for i := range blaetter {
		n := i + 1
		ct.WriteString(fmt.Sprintf(`<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`, n))
		rels.WriteString(fmt.Sprintf(`<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet%d.xml"/>`, n, n))
		titel := strings.NewReplacer("/", "-", "\\", "-", "?", "", "*", "", "[", "(", "]", ")", ":", "-").Replace(blaetter[i].Titel)
		if len([]rune(titel)) > 31 {
			titel = string([]rune(titel)[:31])
		}
		sheets.WriteString(fmt.Sprintf(`<sheet name="%s" sheetId="%d" r:id="rId%d"/>`, xmlText(titel), n, n))
	}
	ns := len(blaetter) + 1
	files := [][2]string{
		{"[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` + ct.String() + `</Types>`},
		{"_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`},
		{"xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` + sheets.String() + `</sheets></workbook>`},
		{"xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` + rels.String() + fmt.Sprintf(`<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`, ns) + `</Relationships>`},
		{"xl/styles.xml", xlStyles},
	}
	for _, f := range files {
		if err := add(f[0], f[1]); err != nil {
			return nil, err
		}
	}
	for i, bl := range blaetter {
		if err := add(fmt.Sprintf("xl/worksheets/sheet%d.xml", i+1), blattXML(bl, info)); err != nil {
			return nil, err
		}
	}
	if err := z.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func (a *app) handleExcelExport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Blaetter []xlBlatt   `json:"blaetter"`
		Info     [][2]string `json:"info"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 32<<20)).Decode(&req); err != nil {
		http.Error(w, "Ungültige Daten.", http.StatusBadRequest)
		return
	}
	if len(req.Info) > 6 {
		req.Info = req.Info[:6]
	}
	b, err := baueXLSX(req.Blaetter, req.Info)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(b)
}

/* ---------------- Import ---------------- */

type xlZelle struct {
	R  string `xml:"r,attr"`
	T  string `xml:"t,attr"`
	V  string `xml:"v"`
	IS struct {
		T []string `xml:"t"`
		R []struct {
			T string `xml:"t"`
		} `xml:"r"`
	} `xml:"is"`
}
type xlRow struct {
	C []xlZelle `xml:"c"`
}
type xlSheetData struct {
	Rows []xlRow `xml:"sheetData>row"`
}

var reRef = regexp.MustCompile(`^([A-Z]+)(\d+)$`)

func spaltenIndex(ref string) int {
	m := reRef.FindStringSubmatch(ref)
	if m == nil {
		return -1
	}
	n := 0
	for _, c := range m[1] {
		n = n*26 + int(c-'A'+1)
	}
	return n - 1
}

func leseZip(z *zip.Reader, name string) ([]byte, error) {
	for _, f := range z.File {
		if strings.EqualFold(f.Name, name) {
			rc, err := f.Open()
			if err != nil {
				return nil, err
			}
			defer rc.Close()
			return io.ReadAll(io.LimitReader(rc, 64<<20))
		}
	}
	return nil, errors.New("fehlt: " + name)
}

// leseXLSX liefert je Tabellenblatt (in Reihenfolge) Name und Zellen als Text.
func leseXLSX(b []byte) ([]string, [][][]string, error) {
	z, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		return nil, nil, errors.New("Die Datei ist keine Excel-Arbeitsmappe (.xlsx).")
	}
	var shared []string
	if sb, err := leseZip(z, "xl/sharedStrings.xml"); err == nil {
		var sst struct {
			SI []struct {
				T string `xml:"t"`
				R []struct {
					T string `xml:"t"`
				} `xml:"r"`
			} `xml:"si"`
		}
		_ = xml.Unmarshal(sb, &sst)
		for _, si := range sst.SI {
			t := si.T
			for _, r := range si.R {
				t += r.T
			}
			shared = append(shared, t)
		}
	}
	wb, err := leseZip(z, "xl/workbook.xml")
	if err != nil {
		return nil, nil, errors.New("Die Excel-Datei ist unvollständig.")
	}
	var wbx struct {
		Sheets []struct {
			Name string `xml:"name,attr"`
			RID  string `xml:"http://schemas.openxmlformats.org/officeDocument/2006/relationships id,attr"`
		} `xml:"sheets>sheet"`
	}
	_ = xml.Unmarshal(wb, &wbx)
	ziele := map[string]string{}
	if rb, err := leseZip(z, "xl/_rels/workbook.xml.rels"); err == nil {
		var rx struct {
			R []struct {
				ID     string `xml:"Id,attr"`
				Target string `xml:"Target,attr"`
			} `xml:"Relationship"`
		}
		_ = xml.Unmarshal(rb, &rx)
		for _, r := range rx.R {
			t := strings.TrimPrefix(r.Target, "/")
			if !strings.HasPrefix(t, "xl/") {
				t = path.Join("xl", t)
			}
			ziele[r.ID] = t
		}
	}
	var namen []string
	var daten [][][]string
	for i, s := range wbx.Sheets {
		ziel := ziele[s.RID]
		if ziel == "" {
			ziel = fmt.Sprintf("xl/worksheets/sheet%d.xml", i+1)
		}
		sb, err := leseZip(z, ziel)
		if err != nil {
			continue
		}
		var sd xlSheetData
		if xml.Unmarshal(sb, &sd) != nil {
			continue
		}
		var tab [][]string
		for _, row := range sd.Rows {
			var zeile []string
			for k, c := range row.C {
				idx := spaltenIndex(c.R)
				if idx < 0 {
					idx = k
				}
				if idx > 50 {
					continue
				}
				for len(zeile) <= idx {
					zeile = append(zeile, "")
				}
				var t string
				switch c.T {
				case "s":
					if n, err := strconv.Atoi(strings.TrimSpace(c.V)); err == nil && n >= 0 && n < len(shared) {
						t = shared[n]
					}
				case "inlineStr":
					t = strings.Join(c.IS.T, "")
					for _, r := range c.IS.R {
						t += r.T
					}
				default:
					t = c.V
				}
				zeile[idx] = strings.TrimSpace(t)
			}
			tab = append(tab, zeile)
		}
		namen = append(namen, s.Name)
		daten = append(daten, tab)
	}
	if len(namen) == 0 {
		return nil, nil, errors.New("In der Excel-Datei wurde kein Tabellenblatt gefunden.")
	}
	return namen, daten, nil
}

func norm(s string) string {
	s = strings.ToLower(s)
	return strings.NewReplacer(" ", "", "-", "", ".", "", "_", "", "ü", "ue", "ä", "ae", "ö", "oe").Replace(s)
}

// spaltenFinden sucht in den ersten Zeilen die Überschriften Teilenummer, Bezeichnung, Menge, Lagerort.
func spaltenFinden(tab [][]string) (kopf, nr, name, menge, ort int) {
	kopf, nr, name, menge, ort = -1, -1, -1, -1, -1
	for i := 0; i < len(tab) && i < 15; i++ {
		n, b, m, o := -1, -1, -1, -1
		for j, c := range tab[i] {
			x := norm(c)
			switch {
			case n < 0 && (strings.Contains(x, "ersatzteilnummer") || strings.Contains(x, "teilenummer") || strings.Contains(x, "teilenr") || x == "artikelnummer" || x == "partnumber" || x == "nummer" || x == "nr"):
				n = j
			case b < 0 && (strings.Contains(x, "bezeichnung") || strings.Contains(x, "beschreibung") || x == "name" || strings.Contains(x, "ersatzteilname") || x == "description" || x == "artikel"):
				b = j
			case m < 0 && (strings.Contains(x, "stueck") || strings.Contains(x, "menge") || strings.Contains(x, "anzahl") || x == "stk" || x == "quantity"):
				m = j
			case o < 0 && (strings.Contains(x, "lagerort") || x == "ort" || strings.Contains(x, "fach") || strings.Contains(x, "platz")):
				o = j
			}
		}
		if n >= 0 {
			return i, n, b, m, o
		}
	}
	return
}

func (a *app) handleExcelImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, 50<<20))
	if err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": "Die Datei konnte nicht gelesen werden."})
		return
	}
	namen, daten, err := leseXLSX(b)
	if err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	var out []xlBlatt
	for i, tab := range daten {
		kopf, cn, cb, cm, co := spaltenFinden(tab)
		if kopf < 0 {
			continue
		}
		art := "bestand"
		if x := norm(namen[i]); strings.Contains(x, "fehl") || strings.Contains(x, "bestell") {
			art = "fehlt"
		}
		bl := xlBlatt{Titel: namen[i], Art: art}
		get := func(z []string, j int) string {
			if j < 0 || j >= len(z) {
				return ""
			}
			return z[j]
		}
		for _, z := range tab[kopf+1:] {
			nr := teileNr(get(z, cn))
			if nr == "" {
				continue
			}
			menge := 1
			if s := strings.ReplaceAll(get(z, cm), ",", "."); s != "" {
				if f, err := strconv.ParseFloat(s, 64); err == nil && f >= 0 && f <= 999999 {
					menge = int(f + 0.5)
				} else {
					menge = 0
				}
			}
			bl.Zeilen = append(bl.Zeilen, xlZeile{Nr: nr, Name: get(z, cb), Ort: get(z, co), Menge: menge})
		}
		if len(bl.Zeilen) > 0 {
			out = append(out, bl)
		}
	}
	if len(out) == 0 {
		writeJSON(w, map[string]any{"ok": false, "error": "Keine Ersatzteile gefunden. Die Tabelle braucht eine Spalte „Ersatzteilnummer“ (oder „Teilenummer“)."})
		return
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Art < out[j].Art })
	writeJSON(w, map[string]any{"ok": true, "blaetter": out})
}
