package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// /api/mb: Monteure, Berichte einer Kalenderwoche und einzelne PDFs vom Server holen.
// Wer angemeldet ist, kommt aus den gespeicherten Einstellungen, nicht aus der Anfrage.
func (a *app) handleMb(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	var in struct {
		Event   string `json:"event"`
		Monteur string `json:"monteur"`
		Jahr    int    `json:"jahr"`
		Kw      int    `json:"kw"`
		Datei   string `json:"datei"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&in)
	switch in.Event {
	case "mb_monteure", "mb_liste", "mb_datei":
	default:
		writeJSON(w, map[string]any{"ok": false, "error": "Unbekannte Anfrage."})
		return
	}
	if !serverOK() {
		writeJSON(w, map[string]any{"ok": false, "error": "Kein Server eingestellt."})
		return
	}
	var s struct {
		User *reportUser `json:"user"`
	}
	if b, err := os.ReadFile(settingsPath()); err == nil {
		_ = json.Unmarshal(b, &s)
	}
	if s.User == nil || s.User.ID == "" {
		writeJSON(w, map[string]any{"ok": false, "error": "Nicht angemeldet."})
		return
	}
	payload, _ := json.Marshal(map[string]any{
		"key": ReportKey, "app": "montageberichte", "id": s.User.ID, "name": s.User.Name, "email": s.User.Email,
		"event": in.Event, "monteur": in.Monteur, "jahr": in.Jahr, "kw": in.Kw, "datei": in.Datei, "version": Version,
	})
	c := &http.Client{Timeout: 90 * time.Second}
	resp, err := c.Post(ReportURL, "application/json", bytes.NewReader(payload))
	if err != nil {
		writeJSON(w, map[string]any{"ok": false, "offline": true, "error": "Keine Verbindung zum Server. Bitte Internetverbindung prüfen."})
		return
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 60<<20))
	if !json.Valid(b) {
		writeJSON(w, map[string]any{"ok": false, "offline": true, "error": "Keine gültige Antwort vom Server."})
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(b)
}

// Ablage: Dokumente\Kundendienst Montageberichte\<Monteur>\<Jahr> KW <nn>\<Auftrag>.pdf
func ablageOrdner() string {
	home, _ := os.UserHomeDir()
	if p := os.Getenv("USERPROFILE"); p != "" {
		home = p
	}
	return filepath.Join(home, "Documents", "Kundendienst Montageberichte")
}

var unerlaubt = regexp.MustCompile(`[\\/:*?"<>|\x00-\x1f]+`)

func sauber(s string) string {
	s = strings.TrimSpace(unerlaubt.ReplaceAllString(s, " "))
	s = strings.Trim(s, ". ")
	if len(s) > 100 {
		s = s[:100]
	}
	return s
}

func kwOrdner(monteur string, jahr, kw int) (string, error) {
	m := sauber(monteur)
	if m == "" || jahr < 2000 || jahr > 2100 || kw < 1 || kw > 53 {
		return "", fmt.Errorf("ungültige Angaben")
	}
	return filepath.Join(ablageOrdner(), m, fmt.Sprintf("%d KW %02d", jahr, kw)), nil
}

// POST: zusammengefügte PDF eines Auftrags in den Ordner der Kalenderwoche schreiben
func (a *app) handleAblage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	var in struct {
		Monteur string `json:"monteur"`
		Jahr    int    `json:"jahr"`
		Kw      int    `json:"kw"`
		Datei   string `json:"datei"`
		B64     string `json:"b64"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 200<<20)).Decode(&in); err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": "Ungültige Anfrage."})
		return
	}
	dir, err := kwOrdner(in.Monteur, in.Jahr, in.Kw)
	name := sauber(strings.TrimSuffix(in.Datei, ".pdf"))
	data, err2 := base64.StdEncoding.DecodeString(in.B64)
	if err != nil || name == "" || err2 != nil || !bytes.HasPrefix(data, []byte("%PDF")) {
		writeJSON(w, map[string]any{"ok": false, "error": "Ungültige Angaben."})
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": "Ordner konnte nicht angelegt werden: " + err.Error()})
		return
	}
	ziel := filepath.Join(dir, name+".pdf")
	tmp := ziel + ".neu"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": "Speichern fehlgeschlagen: " + err.Error()})
		return
	}
	if err := os.Rename(tmp, ziel); err != nil {
		_ = os.Remove(tmp)
		writeJSON(w, map[string]any{"ok": false, "error": "Die Datei ist wohl gerade geöffnet: " + name + ".pdf"})
		return
	}
	writeJSON(w, map[string]any{"ok": true, "pfad": ziel})
}

// POST: Ordner (Monteur / Kalenderwoche) oder eine Datei darin im Explorer zeigen bzw. öffnen
func (a *app) handleAblageZeigen(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	var in struct {
		Monteur string `json:"monteur"`
		Jahr    int    `json:"jahr"`
		Kw      int    `json:"kw"`
		Datei   string `json:"datei"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&in)
	p := ablageOrdner()
	if in.Monteur != "" {
		p = filepath.Join(p, sauber(in.Monteur))
		if in.Jahr != 0 {
			d, err := kwOrdner(in.Monteur, in.Jahr, in.Kw)
			if err != nil {
				writeJSON(w, map[string]any{"ok": false, "error": "Ungültige Angaben."})
				return
			}
			p = d
			if n := sauber(strings.TrimSuffix(in.Datei, ".pdf")); n != "" {
				p = filepath.Join(d, n+".pdf")
			}
		}
	}
	_ = os.MkdirAll(ablageOrdner(), 0o755)
	if _, err := os.Stat(p); err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": "Noch nicht abgelegt."})
		return
	}
	if strings.HasSuffix(p, ".pdf") {
		openExternal(p)
	} else {
		ordnerZeigen(p)
	}
	writeJSON(w, map[string]any{"ok": true})
}

// pdf-lib (zum Zusammenfügen der PDFs) wird beim ersten Mal aus dem Netz geholt und zwischengespeichert.
const pdfLibVersion = "1.17.1"

var pdfLibMirrors = []string{
	"https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/" + pdfLibVersion + "/pdf-lib.min.js",
	"https://cdn.jsdelivr.net/npm/pdf-lib@" + pdfLibVersion + "/dist/pdf-lib.min.js",
	"https://unpkg.com/pdf-lib@" + pdfLibVersion + "/dist/pdf-lib.min.js",
}

func (a *app) handlePdfLib(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	cache := filepath.Join(os.Getenv("LOCALAPPDATA"), AppName, "lib", "pdf-lib-"+pdfLibVersion+".min.js")
	if b, err := os.ReadFile(cache); err == nil && len(b) > 100000 {
		w.Write(b)
		return
	}
	c := &http.Client{Timeout: 30 * time.Second}
	for _, u := range pdfLibMirrors {
		resp, err := c.Get(u)
		if err != nil {
			continue
		}
		b, err := io.ReadAll(io.LimitReader(resp.Body, 5<<20))
		resp.Body.Close()
		if err != nil || resp.StatusCode != 200 || len(b) < 100000 {
			continue
		}
		_ = os.MkdirAll(filepath.Dir(cache), 0o755)
		_ = os.WriteFile(cache, b, 0o644)
		w.Write(b)
		return
	}
	w.WriteHeader(http.StatusServiceUnavailable)
	fmt.Fprint(w, `window.PDFLIB_FEHLT = true;`)
}
