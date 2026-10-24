package main

// PowerPoint-Dateien schreiben und Hintergründe in vorhandenen Dateien tauschen.
//
// Als Grundgerüst dient die leere Standardvorlage von python-pptx (assets/vorlage.pptx, MIT-Lizenz) –
// eine von PowerPoint geprüfte, gültige Datei. Neue Folien nutzen das Layout „Leer“.

import (
	"archive/zip"
	"bytes"
	_ "embed"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

//go:embed assets/vorlage.pptx
var templatePptx []byte

const emuPerPt = 12700

type Model struct {
	Width       float64        `json:"width"`
	Height      float64        `json:"height"`
	Slides      []Slide        `json:"slides"`
	Backgrounds map[string]*Bg `json:"backgrounds"` // nur für vorhandene PowerPoint-Dateien
}

type Slide struct {
	Bg    *Bg         `json:"bg"`
	Pics  []Pic       `json:"pics"`
	Texts []TextShape `json:"texts"`
}

type Bg struct {
	Type  string `json:"type"`  // color | image
	Color string `json:"color"` // RRGGBB
	File  string `json:"file"`  // Name des mitgeschickten Bildes
}

type Pic struct {
	File string  `json:"file"`
	Name string  `json:"name"`
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	W    float64 `json:"w"`
	H    float64 `json:"h"`
}

type TextShape struct {
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
	W     float64 `json:"w"`
	H     float64 `json:"h"`
	Align string  `json:"align"`
	Paras []Para  `json:"paras"`
}

type Para struct {
	MarL    float64 `json:"marL"`
	Indent  float64 `json:"indent"`
	Spacing float64 `json:"spacing"`
	Runs    []Run   `json:"runs"`
}

type Run struct {
	T     string  `json:"t"`
	Font  string  `json:"font"`
	Size  float64 `json:"size"`
	B     bool    `json:"b"`
	I     bool    `json:"i"`
	Color string  `json:"color"`
}

func emu(pt float64) int64 { return int64(math.Round(pt * emuPerPt)) }

func clampI(v, lo, hi int64) int64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

var hexColor = regexp.MustCompile(`^[0-9A-Fa-f]{6}$`)

func cleanColor(c string) string {
	c = strings.TrimPrefix(strings.TrimSpace(c), "#")
	if !hexColor.MatchString(c) {
		return "FFFFFF"
	}
	return strings.ToUpper(c)
}

func esc(s string) string {
	var b bytes.Buffer
	for _, r := range s {
		// Steuerzeichen außer Tabulator sind in XML nicht erlaubt
		if r < 0x20 && r != '\t' {
			continue
		}
		if r == 0xFFFE || r == 0xFFFF {
			continue
		}
		b.WriteRune(r)
	}
	var out bytes.Buffer
	_ = xml.EscapeText(&out, b.Bytes())
	// EscapeText macht aus dem Tabulator „&#x9;“ – PowerPoint erwartet das Zeichen selbst
	return strings.ReplaceAll(out.String(), "&#x9;", "\t")
}

func imgExt(name string, data []byte) string {
	if bytes.HasPrefix(data, []byte("\x89PNG")) {
		return "png"
	}
	if bytes.HasPrefix(data, []byte{0xFF, 0xD8}) {
		return "jpeg"
	}
	switch strings.ToLower(path.Ext(name)) {
	case ".png":
		return "png"
	}
	return "jpeg"
}

// ---------------------------------------------------------------------------- Zip-Hilfen

type zipPart struct {
	name string
	data []byte
}

func readZip(b []byte) ([]zipPart, error) {
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		return nil, errors.New("Die Datei ist keine gültige PowerPoint-Datei (.pptx).")
	}
	var parts []zipPart
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		d, err := io.ReadAll(io.LimitReader(rc, 1<<30))
		rc.Close()
		if err != nil {
			return nil, err
		}
		parts = append(parts, zipPart{f.Name, d})
	}
	return parts, nil
}

func writeZip(parts []zipPart) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	now := time.Now()
	// [Content_Types].xml muss als erstes stehen
	sort.SliceStable(parts, func(i, j int) bool {
		return parts[i].name == "[Content_Types].xml" && parts[j].name != "[Content_Types].xml"
	})
	for _, p := range parts {
		// Immer „Deflate“: gespeicherte (Store) Einträge mit nachgestellter Größenangabe
		// lehnen manche Programme ab.
		w, err := zw.CreateHeader(&zip.FileHeader{Name: p.name, Method: zip.Deflate, Modified: now})
		if err != nil {
			return nil, err
		}
		if _, err := w.Write(p.data); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func getPart(parts []zipPart, name string) ([]byte, int) {
	for i, p := range parts {
		if p.name == name {
			return p.data, i
		}
	}
	return nil, -1
}

func ensureDefault(ct, ext, typ string) string {
	if strings.Contains(strings.ToLower(ct), `extension="`+ext+`"`) {
		return ct
	}
	return strings.Replace(ct, "</Types>", `<Default Extension="`+ext+`" ContentType="`+typ+`"/></Types>`, 1)
}

// ---------------------------------------------------------------------------- Hintergrund

func bgXML(bg *Bg, rid string) string {
	if bg != nil && bg.Type == "image" && rid != "" {
		return `<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="` + rid + `"/><a:srcRect/>` +
			`<a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`
	}
	col := "FFFFFF"
	if bg != nil && bg.Type == "color" {
		col = cleanColor(bg.Color)
	}
	return `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="` + col + `"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
}

// ---------------------------------------------------------------------------- Neue Präsentation

type relList struct {
	items []string
	n     int
}

func (r *relList) add(typ, target string) string {
	r.n++
	id := fmt.Sprintf("rId%d", r.n)
	r.items = append(r.items, `<Relationship Id="`+id+`" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/`+typ+`" Target="`+target+`"/>`)
	return id
}

func (r *relList) xml() string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` + "\n" +
		`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` + strings.Join(r.items, "") + `</Relationships>`
}

const slideHead = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` + "\n" +
	`<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`

func BuildPptx(m *Model, files map[string][]byte) ([]byte, error) {
	if len(m.Slides) == 0 {
		return nil, errors.New("Keine Folien vorhanden.")
	}
	if m.Width < 72 || m.Height < 72 || m.Width > 4000 || m.Height > 4000 {
		return nil, errors.New("Ungültige Foliengröße.")
	}
	parts, err := readZip(templatePptx)
	if err != nil {
		return nil, err
	}
	cx, cy := clampI(emu(m.Width), 914400, 51206400), clampI(emu(m.Height), 914400, 51206400)

	ct, ctIdx := getPart(parts, "[Content_Types].xml")
	pres, presIdx := getPart(parts, "ppt/presentation.xml")
	prels, prelsIdx := getPart(parts, "ppt/_rels/presentation.xml.rels")
	if ctIdx < 0 || presIdx < 0 || prelsIdx < 0 {
		return nil, errors.New("Vorlage beschädigt.")
	}
	ctS := ensureDefault(ensureDefault(string(ct), "png", "image/png"), "jpeg", "image/jpeg")
	presS := regexp.MustCompile(`<p:sldSz [^>]*/>`).ReplaceAllString(string(pres), fmt.Sprintf(`<p:sldSz cx="%d" cy="%d"/>`, cx, cy))
	prelsS := string(prels)

	var sldIds, overrides, presRels strings.Builder
	media := 0
	addMedia := func(name string) (string, error) {
		data, ok := files[name]
		if !ok || len(data) == 0 {
			return "", fmt.Errorf("Bild %q fehlt.", name)
		}
		media++
		fn := fmt.Sprintf("image%d.%s", media, imgExt(name, data))
		parts = append(parts, zipPart{"ppt/media/" + fn, data})
		return "../media/" + fn, nil
	}

	for i, s := range m.Slides {
		n := i + 1
		rels := &relList{}
		rels.add("slideLayout", "../slideLayouts/slideLayout7.xml")
		var sb strings.Builder
		sb.WriteString(slideHead)
		sb.WriteString(`<p:cSld>`)
		bgRid := ""
		if s.Bg != nil && s.Bg.Type == "image" {
			t, err := addMedia(s.Bg.File)
			if err != nil {
				return nil, err
			}
			bgRid = rels.add("image", t)
		}
		sb.WriteString(bgXML(s.Bg, bgRid))
		sb.WriteString(`<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>`)
		id := 1
		for _, p := range s.Pics {
			t, err := addMedia(p.File)
			if err != nil {
				return nil, err
			}
			rid := rels.add("image", t)
			id++
			name := p.Name
			if name == "" {
				name = "Grafik"
			}
			fmt.Fprintf(&sb, `<p:pic><p:nvPicPr><p:cNvPr id="%d" name="%s"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>`+
				`<p:blipFill><a:blip r:embed="%s"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>`+
				`<p:spPr><a:xfrm><a:off x="%d" y="%d"/><a:ext cx="%d" cy="%d"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`,
				id, esc(name), rid, emu(p.X), emu(p.Y), max(emu(p.W), 1), max(emu(p.H), 1))
		}
		for _, t := range s.Texts {
			id++
			writeTextShape(&sb, id, t)
		}
		sb.WriteString(`</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`)

		parts = append(parts,
			zipPart{fmt.Sprintf("ppt/slides/slide%d.xml", n), []byte(sb.String())},
			zipPart{fmt.Sprintf("ppt/slides/_rels/slide%d.xml.rels", n), []byte(rels.xml())})
		rid := fmt.Sprintf("rIdS%d", n)
		fmt.Fprintf(&sldIds, `<p:sldId id="%d" r:id="%s"/>`, 255+n, rid)
		fmt.Fprintf(&overrides, `<Override PartName="/ppt/slides/slide%d.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`, n)
		fmt.Fprintf(&presRels, `<Relationship Id="%s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide%d.xml"/>`, rid, n)
	}

	presS = strings.Replace(presS, "</p:sldMasterIdLst>", "</p:sldMasterIdLst><p:sldIdLst>"+sldIds.String()+"</p:sldIdLst>", 1)
	prelsS = strings.Replace(prelsS, "</Relationships>", presRels.String()+"</Relationships>", 1)
	ctS = strings.Replace(ctS, "</Types>", overrides.String()+"</Types>", 1)
	parts[ctIdx].data = []byte(ctS)
	parts[presIdx].data = []byte(presS)
	parts[prelsIdx].data = []byte(prelsS)
	return writeZip(parts)
}

func writeTextShape(sb *strings.Builder, id int, t TextShape) {
	algn := map[string]string{"center": "ctr", "right": "r"}[t.Align]
	if algn == "" {
		algn = "l"
	}
	fmt.Fprintf(sb, `<p:sp><p:nvSpPr><p:cNvPr id="%d" name="Textfeld %d"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`+
		`<p:spPr><a:xfrm><a:off x="%d" y="%d"/><a:ext cx="%d" cy="%d"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>`+
		`<p:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="t"><a:noAutofit/></a:bodyPr><a:lstStyle/>`,
		id, id-1, emu(t.X), emu(t.Y), max(emu(t.W), 12700), max(emu(t.H), 12700))
	for _, p := range t.Paras {
		sb.WriteString(`<a:p><a:pPr`)
		if algn == "l" {
			if p.MarL > 0.1 {
				fmt.Fprintf(sb, ` marL="%d"`, clampI(emu(p.MarL), 0, 51206400))
			}
			if math.Abs(p.Indent) > 0.1 {
				fmt.Fprintf(sb, ` indent="%d"`, clampI(emu(p.Indent), -51206400, 51206400))
			}
		}
		fmt.Fprintf(sb, ` algn="%s">`, algn)
		if p.Spacing > 0 {
			fmt.Fprintf(sb, `<a:lnSpc><a:spcPts val="%d"/></a:lnSpc>`, clampI(int64(math.Round(p.Spacing*100)), 0, 158400))
		}
		sb.WriteString(`<a:spcBef><a:spcPts val="0"/></a:spcBef><a:spcAft><a:spcPts val="0"/></a:spcAft><a:buNone/></a:pPr>`)
		var size int64 = 1800
		for _, r := range p.Runs {
			size = clampI(int64(math.Round(r.Size*100)), 100, 400000)
			b, i := "0", "0"
			if r.B {
				b = "1"
			}
			if r.I {
				i = "1"
			}
			font := esc(r.Font)
			if font == "" {
				font = "Calibri"
			}
			fmt.Fprintf(sb, `<a:r><a:rPr lang="de-DE" sz="%d" b="%s" i="%s" dirty="0"><a:solidFill><a:srgbClr val="%s"/></a:solidFill>`+
				`<a:latin typeface="%s"/><a:cs typeface="%s"/></a:rPr><a:t>%s</a:t></a:r>`, size, b, i, cleanColor(r.Color), font, font, esc(r.T))
		}
		fmt.Fprintf(sb, `<a:endParaRPr lang="de-DE" sz="%d" dirty="0"/></a:p>`, size)
	}
	sb.WriteString(`</p:txBody></p:sp>`)
}

// ---------------------------------------------------------------------------- Vorhandene Datei

type presInfo struct {
	cx, cy int64
	slides []string // Pfade der Folien in Reihenfolge, z. B. ppt/slides/slide3.xml
}

var (
	reSldSz = regexp.MustCompile(`<p:sldSz[^>]*\scx="(\d+)"[^>]*\scy="(\d+)"`)
	reSldId = regexp.MustCompile(`<p:sldId\s[^>]*?r:id="([^"]+)"`)
	reRel   = regexp.MustCompile(`<Relationship\s[^>]*>`)
	reAttr  = regexp.MustCompile(`(\w+)="([^"]*)"`)
)

func relMap(x string) map[string]string {
	m := map[string]string{}
	for _, tag := range reRel.FindAllString(x, -1) {
		var id, target string
		for _, a := range reAttr.FindAllStringSubmatch(tag, -1) {
			switch a[1] {
			case "Id":
				id = a[2]
			case "Target":
				target = a[2]
			}
		}
		if id != "" {
			m[id] = target
		}
	}
	return m
}

func readPresInfo(parts []zipPart) (*presInfo, error) {
	pres, _ := getPart(parts, "ppt/presentation.xml")
	rels, _ := getPart(parts, "ppt/_rels/presentation.xml.rels")
	if pres == nil || rels == nil {
		return nil, errors.New("Die Datei ist keine gültige PowerPoint-Präsentation.")
	}
	pi := &presInfo{cx: 9144000, cy: 6858000}
	if m := reSldSz.FindStringSubmatch(string(pres)); m != nil {
		pi.cx, _ = strconv.ParseInt(m[1], 10, 64)
		pi.cy, _ = strconv.ParseInt(m[2], 10, 64)
	}
	rm := relMap(string(rels))
	for _, m := range reSldId.FindAllStringSubmatch(string(pres), -1) {
		t := rm[m[1]]
		if t == "" {
			continue
		}
		if strings.HasPrefix(t, "/") {
			t = strings.TrimPrefix(t, "/")
		} else {
			t = path.Clean(path.Join("ppt", t))
		}
		pi.slides = append(pi.slides, t)
	}
	return pi, nil
}

func PptxInfo(b []byte) (int, float64, float64, error) {
	parts, err := readZip(b)
	if err != nil {
		return 0, 0, 0, err
	}
	pi, err := readPresInfo(parts)
	if err != nil {
		return 0, 0, 0, err
	}
	return len(pi.slides), float64(pi.cx) / emuPerPt, float64(pi.cy) / emuPerPt, nil
}

var (
	reBg   = regexp.MustCompile(`(?s)<p:bg>.*?</p:bg>|<p:bg/>`)
	reCSld = regexp.MustCompile(`<p:cSld(\s[^>]*)?>`)
)

// RecolorPptx setzt für die angegebenen Folien (Schlüssel = Folienindex ab 0) einen neuen Hintergrund.
func RecolorPptx(src []byte, bgs map[string]*Bg, files map[string][]byte) ([]byte, error) {
	parts, err := readZip(src)
	if err != nil {
		return nil, err
	}
	pi, err := readPresInfo(parts)
	if err != nil {
		return nil, err
	}
	ct, ctIdx := getPart(parts, "[Content_Types].xml")
	if ctIdx < 0 {
		return nil, errors.New("Die Datei ist keine gültige PowerPoint-Präsentation.")
	}
	ctS := string(ct)
	used := map[string]bool{}
	for _, p := range parts {
		used[p.name] = true
	}
	media := 0
	for key, bg := range bgs {
		idx, err := strconv.Atoi(key)
		if err != nil || idx < 0 || idx >= len(pi.slides) || bg == nil {
			continue
		}
		sp := pi.slides[idx]
		sx, si := getPart(parts, sp)
		if si < 0 {
			continue
		}
		relPath := path.Join(path.Dir(sp), "_rels", path.Base(sp)+".rels")
		rx, ri := getPart(parts, relPath)
		rid := ""
		if bg.Type == "image" {
			data, ok := files[bg.File]
			if !ok {
				return nil, fmt.Errorf("Bild %q fehlt.", bg.File)
			}
			ext := imgExt(bg.File, data)
			var name string
			for {
				media++
				name = fmt.Sprintf("ppt/media/hintergrund%d.%s", media, ext)
				if !used[name] {
					break
				}
			}
			used[name] = true
			parts = append(parts, zipPart{name, data})
			ctS = ensureDefault(ctS, ext, "image/"+ext)
			relsS := string(rx)
			if ri < 0 {
				relsS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` + "\n" + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`
			}
			existing := relMap(relsS)
			for n := 1; ; n++ {
				rid = fmt.Sprintf("rIdHg%d", n)
				if _, ok := existing[rid]; !ok {
					break
				}
			}
			relsS = strings.Replace(relsS, "</Relationships>", `<Relationship Id="`+rid+`" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/`+path.Base(name)+`"/></Relationships>`, 1)
			if ri < 0 {
				parts = append(parts, zipPart{relPath, []byte(relsS)})
			} else {
				parts[ri].data = []byte(relsS)
			}
		}
		x := reBg.ReplaceAllString(string(sx), "")
		if rid != "" && !strings.Contains(x, "xmlns:r=") {
			x = strings.Replace(x, "<p:sld ", `<p:sld xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" `, 1)
		}
		loc := reCSld.FindStringIndex(x)
		if loc == nil {
			continue
		}
		x = x[:loc[1]] + bgXML(bg, rid) + x[loc[1]:]
		parts[si].data = []byte(x)
	}
	parts[ctIdx].data = []byte(ctS)
	return writeZip(parts)
}
