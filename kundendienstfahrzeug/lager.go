package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	neturl "net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Bestand und Fehlteile liegen auf dem Anmeldeserver (Google-Tabelle, Blatt „Kundendienstfahrzeug“), je
// Arbeits-E-Mail getrennt. Das Programm reicht die Anfragen nur weiter und setzt Rechner-ID und
// E-Mail aus der eigenen Anmeldung ein – nie aus der Anfrage der Seite. Die letzte Antwort wird
// zwischengespeichert, damit der Bestand auch ohne Internet angezeigt werden kann.

var lagerEvents = map[string]bool{
	"wl_liste": true, "wl_speichern": true, "wl_menge": true, "wl_loeschen": true,
	"wl_umbuchen": true, "wl_import": true, "wl_katalog": true, "wl_fahrzeug": true,
	"wl_nachbestellen": true, "wl_bestellt": true,
}

func cachePath() string { return filepath.Join(dataDir(), "bestand.json") }

func angemeldet() *reportUser {
	var s struct {
		User *struct {
			reportUser
			Verified bool `json:"verified"`
		} `json:"user"`
	}
	if b, err := os.ReadFile(settingsPath()); err == nil {
		_ = json.Unmarshal(b, &s)
	}
	if s.User == nil || s.User.ID == "" || s.User.Email == "" {
		return nil
	}
	u := s.User.reportUser
	return &u
}

func (a *app) handleLager(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	var req map[string]any
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(&req); err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": "Ungültige Anfrage."})
		return
	}
	ev, _ := req["event"].(string)
	if !lagerEvents[ev] {
		writeJSON(w, map[string]any{"ok": false, "error": "Unbekannte Anfrage."})
		return
	}
	u := angemeldet()
	if u == nil {
		writeJSON(w, map[string]any{"ok": false, "error": "Bitte zuerst anmelden."})
		return
	}
	offline := func(msg string) {
		res := map[string]any{"ok": false, "offline": true, "error": msg}
		if ev == "wl_liste" {
			if b, err := os.ReadFile(cachePath()); err == nil && json.Valid(b) {
				var c map[string]any
				if json.Unmarshal(b, &c) == nil && c["email"] == u.Email {
					c["ok"], c["offline"], c["error"] = true, true, msg
					delete(c, "email")
					writeJSON(w, c)
					return
				}
			}
		}
		writeJSON(w, res)
	}
	if !serverOK() {
		offline("Kein Server eingestellt (Entwicklerversion).")
		return
	}
	req["key"], req["app"], req["id"], req["name"], req["email"], req["version"] = ReportKey, "wagenlager", u.ID, u.Name, u.Email, Version
	payload, _ := json.Marshal(req)
	c := &http.Client{Timeout: 45 * time.Second}
	resp, err := c.Post(ReportURL, "application/json", bytes.NewReader(payload))
	if err != nil {
		offline("Keine Verbindung zum Server – angezeigt wird der zuletzt geladene Stand.")
		return
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	var res map[string]any
	if json.Unmarshal(b, &res) != nil {
		offline("Der Server antwortet gerade nicht – angezeigt wird der zuletzt geladene Stand.")
		return
	}
	// Vollständige Liste zwischenspeichern (nur eigene Daten, nur dieser Windows-Benutzer)
	if ok, _ := res["ok"].(bool); ok {
		if _, has := res["teile"]; has {
			c := map[string]any{"email": u.Email, "stand": res["stand"], "teile": res["teile"], "katalog": res["katalog"], "fahrzeug": res["fahrzeug"], "zeit": time.Now().Format(time.RFC3339)}
			// Katalog kommt nur mit, wenn er sich geändert hat – sonst den zwischengespeicherten behalten
			if res["katalog"] == nil {
				if ob, err := os.ReadFile(cachePath()); err == nil {
					var alt map[string]any
					if json.Unmarshal(ob, &alt) == nil && alt["email"] == u.Email {
						c["katalog"], c["kstand"] = alt["katalog"], alt["kstand"]
					}
				}
			} else {
				c["kstand"] = res["kstand"]
			}
			if cb, err := json.Marshal(c); err == nil {
				tmp := cachePath() + ".tmp"
				if os.WriteFile(tmp, cb, 0o600) == nil {
					_ = os.Remove(cachePath())
					_ = os.Rename(tmp, cachePath())
				}
			}
		}
	}
	writeJSON(w, res)
}

/* ---------------- Teilenummern ---------------- */

var (
	reBT     = regexp.MustCompile(`^BT\d{7}$`)
	reBTKurz = regexp.MustCompile(`^\d{7}$`)
	reToyota = regexp.MustCompile(`^(\d{5})([A-Z0-9]{5})(\d{2})$`)
	reLeer   = regexp.MustCompile(`[\s-]`)
)

// teileNr bringt Toyota- (12345-ABCDE-12) und BT-Nummern (BT1234567) in eine einheitliche Form.
func teileNr(v string) string {
	c := reLeer.ReplaceAllString(strings.ToUpper(strings.TrimSpace(v)), "")
	switch {
	case reBT.MatchString(c):
		return c
	}
	if m := reToyota.FindStringSubmatch(c); m != nil {
		return m[1] + "-" + m[2] + "-" + m[3]
	}
	return strings.ToUpper(strings.TrimSpace(v))
}

// tdocURL: Suchadresse in Toyota T-Doc für eine Teilenummer ("" = keine gültige Nummer).
func tdocURL(nr string) string {
	n := teileNr(nr)
	bt := reBT.MatchString(n) || reBTKurz.MatchString(n)
	if !bt && !regexp.MustCompile(`^\d{5}-[A-Z0-9]{5}-\d{2}$`).MatchString(n) {
		return ""
	}
	q := neturl.Values{}
	if bt {
		q.Set("partNumber", strings.TrimPrefix(n, "BT"))
		q.Set("truckType", "warehouseTrucks")
		q.Set("flag", "Standard,Special")
	} else {
		q.Set("partNumber", strings.ReplaceAll(n, "-", ""))
		q.Set("truckType", "counterBalanceTrucks")
	}
	q.Set("reset", "false")
	q.Set("source", "partsSearch")
	return "https://tdoc.toyota-forklifts.eu/?" + q.Encode()
}
