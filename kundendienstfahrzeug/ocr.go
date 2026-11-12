package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

// Teilenummer vom Foto lesen: zuerst Google über den Anmeldeserver (liest Etiketten deutlich
// genauer), sonst die Windows-Texterkennung auf dem Rechner.

func googleOCR(img []byte) (string, error) {
	if !serverOK() {
		return "", errors.New("kein Server")
	}
	if len(img) < 100 || len(img) > 10<<20 {
		return "", errors.New("Foto zu groß")
	}
	u := angemeldet()
	if u == nil {
		return "", errors.New("nicht angemeldet")
	}
	payload, _ := json.Marshal(map[string]any{
		"key": ReportKey, "event": "ocr", "id": u.ID, "email": u.Email, "version": Version,
		"b64": base64.StdEncoding.EncodeToString(img), "mime": http.DetectContentType(img),
	})
	c := &http.Client{Timeout: 60 * time.Second}
	resp, err := c.Post(ReportURL, "application/json", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var res struct {
		OK    bool   `json:"ok"`
		Text  string `json:"text"`
		Error string `json:"error"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&res); err != nil {
		return "", errors.New("keine gültige Antwort")
	}
	if !res.OK {
		return "", errors.New(res.Error)
	}
	t := strings.ReplaceAll(res.Text, "\r", "")
	t = strings.TrimLeft(strings.TrimPrefix(strings.TrimSpace(t), "\uFEFF"), "_\n ")
	return t, nil
}

func (a *app) handleOCR(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Bild string `json:"bild"` // JPEG als Base64
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 30<<20)).Decode(&req); err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": "Kein Foto."})
		return
	}
	img, err := base64.StdEncoding.DecodeString(req.Bild)
	if err != nil || len(img) < 100 {
		writeJSON(w, map[string]any{"ok": false, "error": "Kein gültiges Foto."})
		return
	}
	if t, err := googleOCR(img); err == nil && strings.TrimSpace(t) != "" {
		writeJSON(w, map[string]any{"ok": true, "text": t, "engine": "google"})
		return
	}
	t, err := windowsOCR(img)
	if err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, map[string]any{"ok": true, "text": t, "engine": "windows"})
}
