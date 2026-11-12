package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// Hintergrund-Verbindung zur Browser-Erweiterung („Native Messaging“): Chrome/Edge startet die exe
// mit der Herkunft der Erweiterung als Argument. Diese Hilfsinstanz holt sich Aufträge vom
// laufenden Programm desselben Windows-Benutzers und reicht sie an die Erweiterung weiter; die
// Ergebnisse gehen auf demselben Weg zurück.

const NativeName = "de.kundendienstfahrzeug.tdoc"
const ErweiterungID = "bodlpndgckkgkniceadgmobnnkkmfgmm"

var (
	nativAuftraege = make(chan map[string]string, 8)
	nativMu        sync.Mutex
	nativZuletzt   time.Time // letzte Abfrage der Hilfsinstanz
)

func nativVerbunden() bool {
	nativMu.Lock()
	defer nativMu.Unlock()
	return time.Since(nativZuletzt) < 40*time.Second
}

// handleTdocNaechster: lange Abfrage der Hilfsinstanz (bis 25 s), liefert den nächsten Auftrag.
func (a *app) handleTdocNaechster(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-KDF-Owner") != ownerToken() {
		http.Error(w, "nein", http.StatusForbidden)
		return
	}
	nativMu.Lock()
	nativZuletzt = time.Now()
	nativMu.Unlock()
	select {
	case j := <-nativAuftraege:
		writeJSON(w, j)
	case <-time.After(25 * time.Second):
		w.WriteHeader(http.StatusNoContent)
	case <-r.Context().Done():
	}
	nativMu.Lock()
	nativZuletzt = time.Now()
	nativMu.Unlock()
}

func nativLesen(r io.Reader) ([]byte, error) {
	var n uint32
	if err := binary.Read(r, binary.LittleEndian, &n); err != nil {
		return nil, err
	}
	if n > 1<<20 {
		return nil, fmt.Errorf("zu groß")
	}
	b := make([]byte, n)
	_, err := io.ReadFull(r, b)
	return b, err
}

var stdoutMu sync.Mutex

func nativSchreiben(v any) error {
	b, _ := json.Marshal(v)
	stdoutMu.Lock()
	defer stdoutMu.Unlock()
	if err := binary.Write(os.Stdout, binary.LittleEndian, uint32(len(b))); err != nil {
		return err
	}
	_, err := os.Stdout.Write(b)
	return err
}

// nativHost läuft, solange der Browser die Verbindung offen hält.
func nativHost() {
	c := &http.Client{Timeout: 35 * time.Second}
	ende := make(chan struct{})
	ctx, abbrechen := context.WithCancel(context.Background())
	defer abbrechen()
	go func() { <-ende; abbrechen() }()
	// Ergebnisse der Erweiterung → Programm
	go func() {
		in := bufio.NewReader(os.Stdin)
		for {
			b, err := nativLesen(in)
			if err != nil {
				close(ende)
				return
			}
			if p := ownPort(); p != 0 {
				if resp, err := c.Post(fmt.Sprintf("http://127.0.0.1:%d/api/tdoc/ergebnis", p), "application/json", bytes.NewReader(b)); err == nil {
					resp.Body.Close()
				}
			}
		}
	}()
	// Aufträge vom Programm → Erweiterung
	for {
		select {
		case <-ende:
			return
		default:
		}
		p := ownPort()
		if p == 0 {
			select {
			case <-ende:
				return
			case <-time.After(3 * time.Second):
			}
			continue
		}
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/api/tdoc/naechster", p), nil)
		req.Header.Set("X-KDF-Owner", ownerToken())
		resp, err := c.Do(req)
		if err != nil {
			time.Sleep(2 * time.Second)
			continue
		}
		var j map[string]string
		if resp.StatusCode == 200 && json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&j) == nil {
			if nativSchreiben(j) != nil {
				resp.Body.Close()
				return
			}
		}
		resp.Body.Close()
	}
}

func istNativAufruf(args []string) bool {
	for _, a := range args {
		if strings.HasPrefix(a, "chrome-extension://") || strings.HasPrefix(a, "extension://") {
			return true
		}
	}
	return false
}

func nativManifest(exe string) []byte {
	b, _ := json.MarshalIndent(map[string]any{
		"name":            NativeName,
		"description":     "Kundendienstfahrzeug – Bezeichnungen aus T-Doc im Hintergrund",
		"path":            exe,
		"type":            "stdio",
		"allowed_origins": []string{"chrome-extension://" + ErweiterungID + "/"},
	}, "", "  ")
	return b
}
