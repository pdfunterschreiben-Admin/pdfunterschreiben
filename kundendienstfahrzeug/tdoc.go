package main

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Bezeichnung automatisch aus T-Doc: Das Programm öffnet die Ersatzteilsuche im Standardbrowser
// (dort ist man bei Toyota angemeldet) mit einem einmaligen Schlüssel in der Adresse. Die
// Chrome-/Edge-Erweiterung „Kundendienstfahrzeug – T-Doc“ liest auf genau dieser Seite die
// Bezeichnung, schickt sie an 127.0.0.1 zurück und schließt den Tab wieder.

//go:embed chrome
var erweiterungFS embed.FS

type tdocAuftrag struct {
	nr      string
	start   time.Time
	fertig  bool
	name    string
	fehler  string
	version string
}

var (
	tdocMu             sync.Mutex
	tdocAuftraege      = map[string]*tdocAuftrag{}
	erweiterungGesehen string // Version der Erweiterung, sobald sie sich einmal gemeldet hat
)

func zufall() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (a *app) handleTdocStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Nr string `json:"nr"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req)
	u := tdocURL(req.Nr)
	if u == "" {
		writeJSON(w, map[string]any{"ok": false, "error": "Für T-Doc bitte eine Toyota- (12345-ABCDE-12) oder BT-Nummer eintragen."})
		return
	}
	tok := zufall()
	tdocMu.Lock()
	for k, v := range tdocAuftraege { // alte Aufträge wegräumen
		if time.Since(v.start) > 15*time.Minute {
			delete(tdocAuftraege, k)
		}
	}
	tdocAuftraege[tok] = &tdocAuftrag{nr: teileNr(req.Nr), start: time.Now()}
	gesehen := erweiterungGesehen
	tdocMu.Unlock()
	openExternal(u + "&kdf=" + fmt.Sprintf("%d_%s", Port, tok))
	writeJSON(w, map[string]any{"ok": true, "token": tok, "erweiterung": gesehen})
}

func (a *app) handleTdocStatus(w http.ResponseWriter, r *http.Request) {
	tok := r.URL.Query().Get("token")
	tdocMu.Lock()
	t := tdocAuftraege[tok]
	var res map[string]any
	if t == nil {
		res = map[string]any{"ok": false, "error": "Unbekannte Abfrage."}
	} else {
		res = map[string]any{"ok": true, "fertig": t.fertig, "name": t.name, "error": t.fehler, "sekunden": int(time.Since(t.start).Seconds()), "erweiterung": erweiterungGesehen}
	}
	tdocMu.Unlock()
	writeJSON(w, res)
}

// handleTdocErgebnis nimmt das Ergebnis der Erweiterung entgegen (Herkunft chrome-extension://…,
// darum außerhalb der normalen Prüfung – berechtigt nur mit dem einmaligen Schlüssel).
func (a *app) handleTdocErgebnis(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Token, Nr, Name, Error, Version string
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 8192)).Decode(&req); err != nil {
		http.Error(w, "ungültig", http.StatusBadRequest)
		return
	}
	tdocMu.Lock()
	defer tdocMu.Unlock()
	t := tdocAuftraege[req.Token]
	if t == nil || t.fertig {
		http.Error(w, "unbekannt", http.StatusForbidden)
		return
	}
	t.fertig, t.name, t.fehler, t.version = true, strings.TrimSpace(req.Name), strings.TrimSpace(req.Error), req.Version
	erweiterungGesehen = req.Version
	if erweiterungGesehen == "" {
		erweiterungGesehen = "?"
	}
	w.WriteHeader(http.StatusNoContent)
}

func erweiterungOrdner() string { return filepath.Join(dataDir(), "T-Doc-Erweiterung") }

// handleTdocErweiterung legt die Erweiterung als Ordner ab (zum Laden über „Entpackte Erweiterung laden“)
// und öffnet ihn im Explorer.
func (a *app) handleTdocErweiterung(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	ziel := erweiterungOrdner()
	sub, _ := fs.Sub(erweiterungFS, "chrome")
	err := fs.WalkDir(sub, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := fs.ReadFile(sub, p)
		if err != nil {
			return err
		}
		out := filepath.Join(ziel, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			return err
		}
		return os.WriteFile(out, b, 0o644)
	})
	if err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": "Der Ordner konnte nicht angelegt werden: " + err.Error()})
		return
	}
	ordnerZeigen(ziel)
	writeJSON(w, map[string]any{"ok": true, "ordner": ziel})
}
