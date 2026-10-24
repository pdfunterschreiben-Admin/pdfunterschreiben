//go:build windows

package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	qrcode "github.com/skip2/go-qrcode"
)

// Fotos vom Handy: Das Programm holt beim Anmeldeserver einen Einmal-Link, zeigt ihn als QR-Code und
// holt die vom Handy hochgeladenen Original-Fotos (mit Aufnahmezeit) dort wieder ab.
func (a *app) handleFotos(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Event string   `json:"event"`
		Token string   `json:"token"`
		ID    string   `json:"id"`
		Ack   []string `json:"ack"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<14)).Decode(&req); err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": "Ungültige Anfrage."})
		return
	}
	if len(req.Ack) > 100 {
		req.Ack = req.Ack[:100]
	}
	switch req.Event {
	case "fotostart", "fotoliste", "fotoholen", "fotoende":
	default:
		writeJSON(w, map[string]any{"ok": false, "error": "Unbekannte Anfrage."})
		return
	}
	if ReportURL == "" || !strings.HasPrefix(ReportURL, "https://script.google.com/") {
		writeJSON(w, map[string]any{"ok": false, "error": "Kein Server eingerichtet."})
		return
	}
	var s struct {
		User *reportUser `json:"user"`
	}
	if b, err := os.ReadFile(settingsPath()); err == nil {
		_ = json.Unmarshal(b, &s)
	}
	if s.User == nil || s.User.Email == "" {
		writeJSON(w, map[string]any{"ok": false, "error": "Bitte zuerst im Programm anmelden."})
		return
	}
	payload, _ := json.Marshal(map[string]any{
		"key": ReportKey, "event": req.Event, "token": req.Token, "id": req.ID, "ack": req.Ack,
		"email": s.User.Email, "version": Version,
	})
	c := &http.Client{Timeout: 90 * time.Second}
	resp, err := c.Post(ReportURL, "application/json", bytes.NewReader(payload))
	if err != nil {
		writeJSON(w, map[string]any{"ok": false, "offline": true, "error": "Keine Verbindung zum Server."})
		return
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 80<<20))
	if err != nil || !json.Valid(body) {
		writeJSON(w, map[string]any{"ok": false, "error": "Der Server hat nicht richtig geantwortet."})
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(body)
}

// QR-Code als PNG – nur für Links des Anmeldeservers
func (a *app) handleFotosQR(w http.ResponseWriter, r *http.Request) {
	u := r.URL.Query().Get("u")
	if !(strings.HasPrefix(u, "https://script.google.com/") || strings.HasPrefix(u, "https://pdfunterschreiben-admin.github.io/")) || len(u) > 500 {
		http.Error(w, "Ungültiger Link", http.StatusBadRequest)
		return
	}
	png, err := qrcode.Encode(u, qrcode.Medium, 360)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(png)
}
