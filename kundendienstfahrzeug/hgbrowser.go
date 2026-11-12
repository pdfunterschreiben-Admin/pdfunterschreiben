package main

// Bezeichnung aus T-Doc ganz im Hintergrund: Das Programm startet ein eigenes, unsichtbares Edge
// (headless, eigenes Profil unter %LOCALAPPDATA%\Kundendienstfahrzeug\T-Doc) und steuert es über eine
// Pipe (DevTools-Protokoll, --remote-debugging-pipe – kein Netzwerk-Anschluss, den andere Nutzer auf
// demselben Server erreichen könnten). Für die Toyota-Anmeldung öffnet es dasselbe Profil einmal
// sichtbar; danach bleibt die Anmeldung im Profil gespeichert.

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type hgProzess interface {
	Kill() error
	Wait() (*os.ProcessState, error)
}

type hgBrowser struct {
	w       io.WriteCloser
	proc    hgProzess
	mu      sync.Mutex
	id      int
	warten  map[int]chan cdpAntwort
	sitzung string
	tot     chan struct{}
}

type cdpAntwort struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Message string `json:"message"`
	} `json:"error"`
}

var (
	hgMu        sync.Mutex // eine Abfrage nach der anderen
	hg          *hgBrowser
	hgLetzte    time.Time
	hgAnmeldung hgProzess // sichtbares Fenster zur Toyota-Anmeldung
	hgAnmeldMu  sync.Mutex
)

func hgProfil() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = dataDir()
	}
	return filepath.Join(base, AppName, "T-Doc")
}

// hgVerfuegbar: Gibt es einen Browser für die Hintergrundabfrage?
func hgVerfuegbar() bool {
	hgAnmeldMu.Lock()
	defekt := hgDefekt
	hgAnmeldMu.Unlock()
	return defekt == "" && hgBrowserPfad() != ""
}

// hgDefekt: Grund, falls das unsichtbare Edge auf diesem Rechner nicht startet – dann läuft es für den
// Rest der Sitzung wieder über den sichtbaren Browser (Erweiterung/Lesezeichen).
var hgDefekt string

func hgAusfall(err error) hgErgebnis {
	nativLog("Unsichtbares Edge startet nicht: %v", err)
	hgAnmeldMu.Lock()
	hgDefekt = fmt.Sprint(err)
	hgAnmeldMu.Unlock()
	return hgErgebnis{Error: "T-Doc im Hintergrund ging nicht: " + err.Error(), Defekt: true}
}

func hgStarten() (*hgBrowser, error) {
	exe := hgBrowserPfad()
	if exe == "" {
		return nil, errors.New("Kein Edge gefunden.")
	}
	_ = os.MkdirAll(hgProfil(), 0o755)
	r, w, p, err := hgProzessStarten(exe, []string{
		"--headless=new", "--remote-debugging-pipe",
		"--user-data-dir=" + hgProfil(),
		"--no-first-run", "--no-default-browser-check", "--disable-extensions",
		"--disable-popup-blocking", "--disable-features=Translate",
		"--window-size=1280,900", "about:blank",
	})
	if err != nil {
		return nil, err
	}
	b := &hgBrowser{w: w, proc: p, warten: map[int]chan cdpAntwort{}, tot: make(chan struct{})}
	go b.lesen(r)
	go func() { _, _ = p.Wait(); b.beenden() }()
	return b, nil
}

func (b *hgBrowser) lesen(r io.Reader) {
	br := bufio.NewReaderSize(r, 1<<20)
	for {
		zeile, err := br.ReadBytes(0)
		if err != nil {
			b.beenden()
			return
		}
		var m struct {
			ID int `json:"id"`
			cdpAntwort
		}
		if json.Unmarshal(zeile[:len(zeile)-1], &m) != nil || m.ID == 0 {
			continue // Ereignisse brauchen wir nicht
		}
		b.mu.Lock()
		c := b.warten[m.ID]
		delete(b.warten, m.ID)
		b.mu.Unlock()
		if c != nil {
			c <- m.cdpAntwort
		}
	}
}

func (b *hgBrowser) beenden() {
	b.mu.Lock()
	defer b.mu.Unlock()
	select {
	case <-b.tot:
	default:
		close(b.tot)
		_ = b.w.Close()
	}
}

func (b *hgBrowser) laeuft() bool {
	select {
	case <-b.tot:
		return false
	default:
		return true
	}
}

// rufen schickt einen Befehl (mit Sitzung = an den Tab) und wartet auf die Antwort.
func (b *hgBrowser) rufen(methode string, params any, mitSitzung bool, dauer time.Duration, ergebnis any) error {
	b.mu.Lock()
	b.id++
	id := b.id
	c := make(chan cdpAntwort, 1)
	b.warten[id] = c
	m := map[string]any{"id": id, "method": methode, "params": params}
	if mitSitzung {
		m["sessionId"] = b.sitzung
	}
	daten, _ := json.Marshal(m)
	_, err := b.w.Write(append(daten, 0))
	b.mu.Unlock()
	if err != nil {
		return errors.New("Hintergrund-Browser nicht erreichbar.")
	}
	select {
	case a := <-c:
		if a.Error != nil {
			return errors.New(a.Error.Message)
		}
		if ergebnis != nil {
			return json.Unmarshal(a.Result, ergebnis)
		}
		return nil
	case <-b.tot:
		return errors.New("Hintergrund-Browser wurde beendet.")
	case <-time.After(dauer):
		b.mu.Lock()
		delete(b.warten, id)
		b.mu.Unlock()
		return errors.New("Zeitüberschreitung (" + methode + ")")
	}
}

// vorbereiten hängt sich an den Tab und tarnt „HeadlessChrome“ (manche Anmeldeseiten mögen das nicht).
func (b *hgBrowser) vorbereiten() error {
	var t struct {
		TargetInfos []struct {
			TargetID string `json:"targetId"`
			Type     string `json:"type"`
		} `json:"targetInfos"`
	}
	ziel := ""
	for i := 0; i < 50 && ziel == ""; i++ {
		if err := b.rufen("Target.getTargets", map[string]any{}, false, 5*time.Second, &t); err != nil {
			return err
		}
		for _, x := range t.TargetInfos {
			if x.Type == "page" {
				ziel = x.TargetID
				break
			}
		}
		if ziel == "" {
			time.Sleep(100 * time.Millisecond)
		}
	}
	if ziel == "" {
		var neu struct {
			TargetID string `json:"targetId"`
		}
		if err := b.rufen("Target.createTarget", map[string]any{"url": "about:blank"}, false, 10*time.Second, &neu); err != nil {
			return err
		}
		ziel = neu.TargetID
	}
	var s struct {
		SessionID string `json:"sessionId"`
	}
	if err := b.rufen("Target.attachToTarget", map[string]any{"targetId": ziel, "flatten": true}, false, 10*time.Second, &s); err != nil {
		return err
	}
	b.sitzung = s.SessionID
	var v struct {
		UserAgent string `json:"userAgent"`
	}
	if b.rufen("Browser.getVersion", map[string]any{}, false, 5*time.Second, &v) == nil && v.UserAgent != "" {
		ua := strings.Replace(v.UserAgent, "HeadlessChrome", "Chrome", 1)
		_ = b.rufen("Network.setUserAgentOverride", map[string]any{"userAgent": ua, "acceptLanguage": "de-DE,de"}, true, 5*time.Second, nil)
	}
	return nil
}

type hgErgebnis struct {
	Name     string `json:"name"`
	Error    string `json:"error"`
	Anmelden bool   `json:"-"`
	Defekt   bool   `json:"-"`
}

// hgSuchen holt die Bezeichnung zu einer Nummer (url = T-Doc-Suche) – blockiert bis zu ~60 s.
func hgSuchen(nr, url string) hgErgebnis {
	hgMu.Lock()
	defer hgMu.Unlock()
	if hgAnmeldungOffen() {
		return hgErgebnis{Error: "Das Toyota-Anmeldefenster ist noch offen – dort anmelden und das Fenster schließen.", Anmelden: true}
	}
	for versuch := 0; versuch < 2; versuch++ {
		if hg == nil || !hg.laeuft() {
			b, err := hgStarten()
			if err != nil {
				return hgAusfall(err)
			}
			if err := b.vorbereiten(); err != nil {
				if os.Getenv("KDF_BROWSER_LOG") != "" {
					fmt.Fprintln(os.Stderr, "vorbereiten:", err)
				}
				_ = b.proc.Kill()
				if versuch == 0 {
					continue
				}
				return hgAusfall(err)
			}
			hg = b
		}
		e, ok := hg.suche(nr, hgURL(url))
		hgLetzte = time.Now()
		if ok || hg.laeuft() {
			return e
		}
	}
	return hgErgebnis{Error: "T-Doc im Hintergrund ging nicht."}
}

func (b *hgBrowser) suche(nr, url string) (hgErgebnis, bool) {
	if err := b.rufen("Page.navigate", map[string]any{"url": url}, true, 30*time.Second, nil); err != nil {
		return hgErgebnis{Error: "T-Doc lädt nicht: " + err.Error()}, false
	}
	leser, _ := erweiterungFS.ReadFile("chrome/reader.js")
	nrJSON, _ := json.Marshal(nr)
	ausdruck := string(leser) + "\n;readToyotaPart(" + string(nrJSON) + ", 8000)"
	start := time.Now()
	letzter := hgErgebnis{Error: "T-Doc hat keine Bezeichnung zu dieser Nummer gefunden."}
	loginSeit := time.Time{}
	for time.Since(start) < 55*time.Second && b.laeuft() {
		var r struct {
			Result struct {
				Value json.RawMessage `json:"value"`
			} `json:"result"`
			ExceptionDetails *struct {
				Text string `json:"text"`
			} `json:"exceptionDetails"`
		}
		err := b.rufen("Runtime.evaluate", map[string]any{"expression": ausdruck, "awaitPromise": true, "returnByValue": true}, true, 20*time.Second, &r)
		if err != nil || r.ExceptionDetails != nil || len(r.Result.Value) == 0 {
			time.Sleep(700 * time.Millisecond) // Seite lädt noch / Weiterleitung zur Anmeldung
			continue
		}
		var e hgErgebnis
		_ = json.Unmarshal(r.Result.Value, &e)
		if e.Name != "" {
			return e, true
		}
		if strings.Contains(strings.ToLower(e.Error), "anmelden") {
			// Anmeldung läuft evtl. gerade still im Hintergrund – kurz Geduld, sonst Anmeldung nötig
			if loginSeit.IsZero() {
				loginSeit = time.Now()
			}
			if time.Since(loginSeit) > 15*time.Second {
				return hgErgebnis{Error: "Einmal bei Toyota anmelden – danach geht es im Hintergrund.", Anmelden: true}, true
			}
			time.Sleep(time.Second)
			continue
		}
		if e.Error != "" {
			letzter = e
			if strings.Contains(e.Error, "mehrere") {
				return e, true
			}
		}
	}
	return letzter, true
}

// hgAufraeumen beendet den Hintergrund-Browser nach 10 Minuten ohne Abfrage.
func hgAufraeumen() {
	for range time.Tick(time.Minute) {
		if hgMu.TryLock() {
			if hg != nil && time.Since(hgLetzte) > 10*time.Minute {
				_ = hg.rufen("Browser.close", map[string]any{}, false, 3*time.Second, nil)
				time.Sleep(time.Second)
				_ = hg.proc.Kill()
				hg = nil
			}
			hgMu.Unlock()
		}
	}
}

func hgAnmeldungOffen() bool {
	hgAnmeldMu.Lock()
	defer hgAnmeldMu.Unlock()
	return hgAnmeldung != nil
}

// hgAnmelden öffnet das Profil sichtbar mit T-Doc, damit man sich einmal bei Toyota anmeldet.
func hgAnmelden() error {
	if hgAnmeldungOffen() {
		return nil
	}
	hgMu.Lock()
	if hg != nil { // Profil darf nur von einem Browser benutzt werden
		_ = hg.rufen("Browser.close", map[string]any{}, false, 3*time.Second, nil)
		time.Sleep(500 * time.Millisecond)
		_ = hg.proc.Kill()
		hg = nil
	}
	hgMu.Unlock()
	exe := hgBrowserPfad()
	if exe == "" {
		return errors.New("Kein Edge gefunden.")
	}
	p, err := hgSichtbarStarten(exe, []string{
		"--user-data-dir=" + hgProfil(), "--no-first-run", "--no-default-browser-check",
		"--disable-extensions", "--window-size=1100,850", hgURL("https://tdoc.toyota-forklifts.eu/"),
	})
	if err != nil {
		return err
	}
	hgAnmeldMu.Lock()
	hgAnmeldung = p
	hgAnmeldMu.Unlock()
	go func() {
		_, _ = p.Wait()
		hgAnmeldMu.Lock()
		hgAnmeldung = nil
		hgAnmeldMu.Unlock()
	}()
	return nil
}

// /api/tdoc/anmelden: POST öffnet das Anmeldefenster, GET sagt, ob es noch offen ist.
func (a *app) handleTdocAnmelden(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		if err := hgAnmelden(); err != nil {
			writeJSON(w, map[string]any{"ok": false, "error": fmt.Sprint(err)})
			return
		}
	}
	writeJSON(w, map[string]any{"ok": true, "offen": hgAnmeldungOffen()})
}
