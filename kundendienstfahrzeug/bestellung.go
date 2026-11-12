package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Bestellliste per E-Mail ans Lager: Excel-Mappe bauen und eine neue Nachricht (Outlook) mit
// Empfänger, Betreff, Text und Anhang öffnen. Abgeschickt wird sie vom Nutzer selbst.

var mailRx = regexp.MustCompile(`^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$`)
var dateiRx = regexp.MustCompile(`[<>:"/\\|?*\x00-\x1f]`)

type bestellReq struct {
	An       string      `json:"an"`
	Betreff  string      `json:"betreff"`
	Text     string      `json:"text"`
	Datei    string      `json:"datei"`
	Blaetter []xlBlatt   `json:"blaetter"`
	Info     [][2]string `json:"info"`
}

func versandDir() string {
	base := filepath.Join(dataDir(), "Versand")
	if entries, err := os.ReadDir(base); err == nil {
		for _, e := range entries {
			if info, err := e.Info(); err == nil && time.Since(info.ModTime()) > 14*24*time.Hour {
				_ = os.RemoveAll(filepath.Join(base, e.Name()))
			}
		}
	}
	d := filepath.Join(base, time.Now().Format("2006-01-02_150405"))
	_ = os.MkdirAll(d, 0o755)
	return d
}

func (a *app) handleBestellung(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	var req bestellReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<20)).Decode(&req); err != nil || len(req.Blaetter) == 0 {
		writeJSON(w, map[string]any{"ok": false, "error": "Keine Teile zum Bestellen."})
		return
	}
	var an []string
	for _, x := range strings.FieldsFunc(req.An, func(c rune) bool { return c == ';' || c == ',' || c == ' ' }) {
		if mailRx.MatchString(x) {
			an = append(an, x)
		}
	}
	if len(req.Info) > 8 {
		req.Info = req.Info[:8]
	}
	b, err := baueXLSX(req.Blaetter, req.Info)
	if err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	name := strings.TrimSpace(dateiRx.ReplaceAllString(req.Datei, "_"))
	if !strings.HasSuffix(strings.ToLower(name), ".xlsx") {
		name = "Ersatzteilbestellung.xlsx"
	}
	p := filepath.Join(versandDir(), name)
	if err := os.WriteFile(p, b, 0o644); err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": "Die Excel-Datei konnte nicht gespeichert werden."})
		return
	}
	via, err := mailOeffnen(strings.Join(an, "; "), req.Betreff, req.Text, p)
	if err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": err.Error(), "datei": p})
		return
	}
	writeJSON(w, map[string]any{"ok": true, "via": via, "datei": p})
}
