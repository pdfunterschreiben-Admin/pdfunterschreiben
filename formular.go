//go:build windows

package main

import (
	"bytes"
	"errors"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Formulare: Die Service-Mappe füllt im Hintergrund das passende Blatt der bekannten Excel-Vorlage
// „Allgemeine Vorlagen“ aus (Excel, Makros aus) und speichert es als Excel-Datei und/oder PDF.
// So sieht das Ergebnis genau aus wie bisher.

//go:embed vorlagen/Allgemeine-Vorlagen.xlsm
var vorlagenEingebaut []byte

const vorlagenURL = "https://raw.githubusercontent.com/pdfunterschreiben-Admin/pdfunterschreiben/main/vorlagen/Allgemeine-Vorlagen.xlsm"

// neueste Vorlage: einmal am Tag von GitHub holen, sonst die zuletzt geholte bzw. die eingebaute
func vorlagenDatei() []byte {
	p := filepath.Join(dataDir(), "Allgemeine-Vorlagen.xlsm")
	if st, err := os.Stat(p); err == nil && time.Since(st.ModTime()) < 24*time.Hour {
		if b, err := os.ReadFile(p); err == nil && len(b) > 10000 {
			return b
		}
	}
	c := &http.Client{Timeout: 20 * time.Second}
	if resp, err := c.Get(vorlagenURL); err == nil {
		defer resp.Body.Close()
		if b, err := io.ReadAll(io.LimitReader(resp.Body, 30<<20)); err == nil && resp.StatusCode == 200 && len(b) > 10000 && bytes.HasPrefix(b, []byte("PK")) {
			_ = os.WriteFile(p, b, 0o644)
			return b
		}
	}
	if b, err := os.ReadFile(p); err == nil && len(b) > 10000 {
		return b
	}
	return vorlagenEingebaut
}

const formularScript = `$ErrorActionPreference = 'Stop'
$cfg = Get-Content -LiteralPath $env:PU_CFG -Raw -Encoding UTF8 | ConvertFrom-Json
$xl = $null
try {
  $xl = New-Object -ComObject Excel.Application
  $xl.Visible = $false
  $xl.DisplayAlerts = $false
  $xl.EnableEvents = $false
  try { $xl.AutomationSecurity = 3 } catch {}
  $wb = $xl.Workbooks.Open($env:PU_IN, 0, $false)
  try {
    if ($cfg.blatt) { $ws = $wb.Worksheets.Item([string]$cfg.blatt) } else { $ws = $wb.Worksheets.Item(1) }
    # zusätzliche Tabellenzeilen: letzte Zeile der Tabelle samt Format kopieren und darunter einfügen
    $nach = [int]$cfg.nach; $anzahl = [int]$cfg.anzahl
    if ($nach -gt 0 -and $anzahl -gt 0) {
      $pa = [string]$ws.PageSetup.PrintArea
      for ($i = 1; $i -le $anzahl; $i++) {
        [void]$ws.Rows($nach).Copy()
        [void]$ws.Rows($nach + $i).Insert(-4121)
      }
      try { $xl.CutCopyMode = 0 } catch {}
      [void]$ws.Range($ws.Rows($nach + 1), $ws.Rows($nach + $anzahl)).ClearContents()
      if ($pa -match '^(.*\$)(\d+)$' -and [int]$matches[2] -ge $nach) { $ws.PageSetup.PrintArea = $matches[1] + ([int]$matches[2] + $anzahl) }
    }
    foreach ($p in $cfg.werte.PSObject.Properties) {
      $c = $ws.Range($p.Name)
      $v = [string]$p.Value
      if ($v -match '^\d{4}-\d{2}-\d{2}$') { $c.Value2 = [double]([datetime]::ParseExact($v, 'yyyy-MM-dd', $null)).ToOADate() }
      else { $c.NumberFormat = '@'; $c.Value2 = $v }   # genau so, wie es eingetippt wurde
    }
    foreach ($p in $cfg.kreuze.PSObject.Properties) {
      try { $ws.CheckBoxes([string]$p.Name).Value = $(if ($p.Value) { 1 } else { -4146 }) } catch {}
    }
    $ws.Activate()
    $ws.Range('A1').Select()
    # Vorlagen aus dem Drive-Ordner: genau eine Seite (Breite und Höhe)
    if ($cfg.einseite) {
      $ps = $ws.PageSetup
      try { $ps.PrintArea = $ws.UsedRange.Address() } catch {}
      $ps.Zoom = $false
      $ps.FitToPagesWide = 1
      $ps.FitToPagesTall = 1
      try { $ps.CenterHorizontally = $true } catch {}
    }
    # Knöpfe der Excel-Vorlage (Typenschild einlesen, Ersatzteile einfügen …) aus allen Registern entfernen
    foreach ($s in @($wb.Worksheets)) {
      foreach ($sh in @($s.Shapes)) {
        $typ = -1; try { $typ = $sh.FormControlType } catch {}
        if ($typ -eq 0 -or $sh.Name -like 'TS_QR*') { $sh.Delete() }
      }
    }
    $ws.Activate()
    $ws.Range('A1').Select()
    if ($cfg.pdf) { $ws.ExportAsFixedFormat(0, $env:PU_PDF) }
    if ($cfg.drucken) { [void]$ws.PrintOut() }
    # Excel: die ganze Allgemeine Vorlage mit allen Registern (ohne Makros und Knöpfe), nur dieses Formular ausgefüllt
    if ($cfg.xlsx) { $wb.SaveAs($env:PU_XLSX, 51) }
  } finally { $wb.Close($false) }
} finally {
  if ($xl) { $xl.Quit(); [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl) }
}`

var zelleRe = regexp.MustCompile(`^[A-Z]{1,3}[0-9]{1,4}$`)

func (a *app) handleFormular(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	fehler := func(msg string) { writeJSON(w, map[string]any{"ok": false, "error": msg}) }
	var req struct {
		Blatt  string            `json:"blatt"`
		Werte  map[string]string `json:"werte"`
		Kreuze map[string]bool   `json:"kreuze"`
		XLSX   bool              `json:"xlsx"`
		PDF    bool              `json:"pdf"`
		Drucken bool             `json:"drucken"` // direkt auf dem Standarddrucker ausgeben
		Nach   int               `json:"nach"`   // zusätzliche Tabellenzeilen unter dieser Zeile einfügen
		Anzahl int               `json:"anzahl"`
		Quelle string            `json:"quelle"` // Vorlage aus dem Drive-Ordner statt der Allgemeinen Vorlagen
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&req); err != nil {
		fehler("Ungültige Anfrage.")
		return
	}
	if !req.XLSX && !req.PDF && !req.Drucken {
		fehler("Bitte Excel und/oder PDF auswählen.")
		return
	}
	for k := range req.Werte {
		if !zelleRe.MatchString(k) {
			fehler("Ungültige Zelle: " + k)
			return
		}
	}
	dir, err := os.MkdirTemp("", "servicemappe-")
	if err != nil {
		fehler("Temporärer Ordner nicht verfügbar.")
		return
	}
	defer os.RemoveAll(dir)
	vorlage, endung := vorlagenDatei(), "xlsm"
	if req.Quelle != "" {
		e, d, err := registerDatei(req.Quelle)
		if err != nil {
			fehler(err.Error())
			return
		}
		vorlage, endung = d, e
	}
	in := filepath.Join(dir, "vorlage."+endung)
	if err := os.WriteFile(in, vorlage, 0o600); err != nil {
		fehler("Die Vorlage konnte nicht bereitgelegt werden.")
		return
	}
	cfg, _ := json.Marshal(map[string]any{"blatt": req.Blatt, "nach": req.Nach, "anzahl": min(req.Anzahl, 200), "einseite": req.Quelle != "", "drucken": req.Drucken, "werte": req.Werte, "kreuze": req.Kreuze, "xlsx": req.XLSX, "pdf": req.PDF})
	cfgPath := filepath.Join(dir, "auftrag.json")
	_ = os.WriteFile(cfgPath, cfg, 0o600)
	xlsx, pdf := filepath.Join(dir, "formular.xlsx"), filepath.Join(dir, "formular.pdf")

	cmd := hidden("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", formularScript)
	cmd.Env = append(os.Environ(), "PU_IN="+in, "PU_CFG="+cfgPath, "PU_XLSX="+xlsx, "PU_PDF="+pdf)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	runErr := runWithTimeout(cmd, 2*time.Minute)
	res := map[string]any{"ok": true}
	if req.XLSX {
		if b, err := os.ReadFile(xlsx); err == nil && len(b) > 0 {
			res["xlsx"] = base64.StdEncoding.EncodeToString(b)
		}
	}
	if req.PDF {
		if b, err := os.ReadFile(pdf); err == nil && len(b) > 0 {
			res["pdf"] = base64.StdEncoding.EncodeToString(b)
		}
	}
	if (req.XLSX && res["xlsx"] == nil) || (req.PDF && res["pdf"] == nil) {
		s := out.String()
		msg := "Excel konnte das Formular nicht erstellen."
		switch {
		case strings.Contains(s, "80040154") || strings.Contains(strings.ToLower(s), "class not registered") || strings.Contains(s, "Klasse nicht registriert"):
			msg = "Dafür muss Microsoft Excel auf diesem Computer installiert sein."
		case runErr != nil && strings.Contains(runErr.Error(), "Zeit"):
			msg = "Excel hat zu lange gebraucht. Ist vielleicht ein Excel-Fenster mit einer Rückfrage offen?"
		}
		if t := strings.TrimSpace(s); t != "" {
			if len(t) > 400 {
				t = t[:400]
			}
			msg += "\n\n" + t
		}
		fehler(msg)
		return
	}
	writeJSON(w, res)
}

// Anfrage an den Anmeldeserver, Antwort als Text („OK\n…“ bzw. „FEHLER\n…“)
func serverText(payload map[string]any, timeout time.Duration) (string, error) {
	b, _ := json.Marshal(payload)
	c := &http.Client{Timeout: timeout}
	resp, err := c.Post(ReportURL, "application/json", bytes.NewReader(b))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 20<<20))
	return string(body), err
}

func angemeldeterNutzer() *reportUser {
	var s struct {
		User *reportUser `json:"user"`
	}
	if b, err := os.ReadFile(settingsPath()); err == nil {
		_ = json.Unmarshal(b, &s)
	}
	return s.User
}

// Typenschild-Foto lesen (Google-Texterkennung + Auswertung auf dem Server)
func (a *app) handleFormularTypenschild(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	img, err := io.ReadAll(io.LimitReader(r.Body, 15<<20))
	if err != nil || len(img) < 100 {
		writeJSON(w, map[string]any{"ok": false, "error": "Kein Foto."})
		return
	}
	if ReportURL == "" {
		writeJSON(w, map[string]any{"ok": false, "error": "Kein Server eingerichtet."})
		return
	}
	t, err := serverText(map[string]any{"key": ReportKey, "event": "typenschild",
		"b64": base64.StdEncoding.EncodeToString(img), "mime": http.DetectContentType(img)}, 90*time.Second)
	if err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": "Keine Verbindung zum Server."})
		return
	}
	t = strings.ReplaceAll(t, "\r", "")
	if !strings.HasPrefix(t, "OK\n") {
		writeJSON(w, map[string]any{"ok": false, "error": strings.TrimSpace(strings.TrimPrefix(t, "FEHLER\n"))})
		return
	}
	werte := map[string]string{}
	for _, z := range strings.Split(t[3:], "\n") {
		if z == "#ROH" {
			break
		}
		if i := strings.Index(z, "="); i > 0 && !strings.HasPrefix(z, "#") {
			if v := strings.TrimSpace(z[i+1:]); v != "" {
				werte[z[:i]] = v
			}
		}
	}
	writeJSON(w, map[string]any{"ok": true, "werte": werte})
}

// gemeinsame Geräteliste (dieselbe wie in den Allgemeinen Vorlagen)
func (a *app) handleFormularGeraete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Event   string     `json:"event"`
		Seit    int64      `json:"seit"`
		Geraete [][]string `json:"geraete"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil || (req.Event != "g_holen" && req.Event != "g_speichern") {
		writeJSON(w, map[string]any{"ok": false, "error": "Ungültige Anfrage."})
		return
	}
	u := angemeldeterNutzer()
	if u == nil || u.Email == "" || ReportURL == "" {
		writeJSON(w, map[string]any{"ok": false, "error": "Bitte zuerst im Programm anmelden."})
		return
	}
	t, err := serverText(map[string]any{"key": ReportKey, "event": req.Event, "seit": req.Seit, "geraete": req.Geraete,
		"name": u.Name, "email": u.Email, "version": Version}, 60*time.Second)
	if err != nil {
		writeJSON(w, map[string]any{"ok": false, "offline": true, "error": "Keine Verbindung zum Server."})
		return
	}
	t = strings.ReplaceAll(t, "\r", "")
	if !strings.HasPrefix(t, "OK\n") {
		writeJSON(w, map[string]any{"ok": false, "error": strings.TrimSpace(strings.TrimPrefix(t, "FEHLER\n"))})
		return
	}
	writeJSON(w, map[string]any{"ok": true, "text": t[3:]})
}

// Neue Register aus dem Drive-Ordner (wie in den Allgemeinen Vorlagen): Liste und „In Excel öffnen“
func (a *app) handleFormularRegister(w http.ResponseWriter, r *http.Request) {
	if ReportURL == "" {
		writeJSON(w, map[string]any{"ok": false, "error": "Kein Server eingerichtet."})
		return
	}
	if r.Method == http.MethodGet {
		t, err := serverText(map[string]any{"key": ReportKey, "event": "register_liste"}, 30*time.Second)
		if err != nil {
			writeJSON(w, map[string]any{"ok": false, "offline": true, "error": "Keine Verbindung zum Server."})
			return
		}
		t = strings.ReplaceAll(t, "\r", "")
		if !strings.HasPrefix(t, "OK\n") {
			writeJSON(w, map[string]any{"ok": false, "error": strings.TrimSpace(strings.TrimPrefix(t, "FEHLER\n"))})
			return
		}
		var liste []map[string]string
		for _, z := range strings.Split(t[3:], "\n") {
			f := strings.SplitN(z, "|", 3)
			if len(f) == 3 && f[0] != "" {
				liste = append(liste, map[string]string{"id": f[0], "stand": f[1], "name": strings.TrimSpace(f[2])})
			}
		}
		writeJSON(w, map[string]any{"ok": true, "register": liste})
		return
	}
	var req struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<12)).Decode(&req); err != nil || !regexp.MustCompile(`^[A-Za-z0-9_\-]{10,80}$`).MatchString(req.ID) {
		writeJSON(w, map[string]any{"ok": false, "error": "Ungültige Anfrage."})
		return
	}
	ext, data, err := registerDatei(req.ID)
	if err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	name := regexp.MustCompile(`[\\/:*?"<>|]`).ReplaceAllString(strings.TrimSpace(req.Name), " ")
	if name == "" {
		name = "Vorlage"
	}
	ordner := filepath.Join(os.Getenv("USERPROFILE"), "Documents", "Formulare")
	_ = os.MkdirAll(ordner, 0o755)
	pfad := filepath.Join(ordner, name+" "+time.Now().Format("2006-01-02 15-04")+"."+ext)
	if err := os.WriteFile(pfad, data, 0o644); err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": "Die Datei konnte nicht gespeichert werden."})
		return
	}
	_ = hidden("rundll32.exe", "url.dll,FileProtocolHandler", pfad).Start()
	writeJSON(w, map[string]any{"ok": true, "pfad": pfad})
}

// Datei einer Vorlage aus dem Drive-Ordner holen (Endung, Inhalt)
func registerDatei(id string) (string, []byte, error) {
	if !regexp.MustCompile(`^[A-Za-z0-9_\-]{10,80}$`).MatchString(id) {
		return "", nil, errors.New("Ungültige Vorlage.")
	}
	t, err := serverText(map[string]any{"key": ReportKey, "event": "register_holen", "id": id}, 60*time.Second)
	if err != nil {
		return "", nil, errors.New("Keine Verbindung zum Server.")
	}
	t = strings.ReplaceAll(t, "\r", "")
	if !strings.HasPrefix(t, "OK\n") {
		return "", nil, errors.New(strings.TrimSpace(strings.TrimPrefix(t, "FEHLER\n")))
	}
	teile := strings.SplitN(t[3:], "\n", 2)
	ext := strings.ToLower(strings.TrimSpace(teile[0]))
	if len(teile) < 2 || (ext != "xlsx" && ext != "xlsm" && ext != "xls") {
		return "", nil, errors.New("Die Vorlage kam nicht richtig an.")
	}
	data, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(teile[1], "\n", ""))
	if err != nil || len(data) == 0 {
		return "", nil, errors.New("Die Vorlage kam nicht richtig an.")
	}
	return ext, data, nil
}

// Sicherung der Formulareingaben: Bei jeder Änderung schickt das Fenster alle
// Eingaben hierher. Stürzt Fenster oder Programm ab, sind sie beim nächsten Öffnen wieder da.
func (a *app) handleFormularSicherung(w http.ResponseWriter, r *http.Request) {
	p := filepath.Join(dataDir(), "formulare-sicherung.json")
	if r.Method == http.MethodPost {
		b, err := io.ReadAll(io.LimitReader(r.Body, 20<<20))
		if err != nil || !json.Valid(b) {
			http.Error(w, "ungültig", http.StatusBadRequest)
			return
		}
		if alt, err := os.ReadFile(p); err == nil && len(alt) > 2 {
			_ = os.WriteFile(p+".bak", alt, 0o644)
		}
		tmp := p + ".tmp"
		if err := os.WriteFile(tmp, b, 0o644); err == nil {
			_ = os.Rename(tmp, p)
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	b, err := os.ReadFile(p)
	if err != nil || !json.Valid(b) {
		b, err = os.ReadFile(p + ".bak")
		if err != nil || !json.Valid(b) {
			b = []byte("{}")
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(b)
}
