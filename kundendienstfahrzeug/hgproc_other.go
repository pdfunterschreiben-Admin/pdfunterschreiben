//go:build !windows

package main

import (
	"io"
	"os"
	"os/exec"
	"strings"
)

// Zum Testen auf Linux: KDF_BROWSER = Pfad zu Chromium, KDF_TDOC_BASIS ersetzt die T-Doc-Adresse.
func hgBrowserPfad() string { return os.Getenv("KDF_BROWSER") }

func hgURL(u string) string {
	if b := os.Getenv("KDF_TDOC_BASIS"); b != "" {
		return strings.Replace(u, "https://tdoc.toyota-forklifts.eu/", b, 1)
	}
	return u
}

type procWarten struct{ c *exec.Cmd }

func (p procWarten) Kill() error                     { return p.c.Process.Kill() }
func (p procWarten) Wait() (*os.ProcessState, error) { err := p.c.Wait(); return p.c.ProcessState, err }

func hgProzessStarten(exe string, args []string) (io.Reader, io.WriteCloser, hgProzess, error) {
	// Kind liest Befehle auf fd 3 und schreibt Antworten auf fd 4
	kindLiest, wirSchreiben, err := os.Pipe()
	if err != nil {
		return nil, nil, nil, err
	}
	wirLesen, kindSchreibt, err := os.Pipe()
	if err != nil {
		return nil, nil, nil, err
	}
	if os.Geteuid() == 0 {
		args = append([]string{"--no-sandbox"}, args...) // Testumgebung läuft als root
	}
	c := exec.Command(exe, args...)
	c.ExtraFiles = []*os.File{kindLiest, kindSchreibt}
	if os.Getenv("KDF_BROWSER_LOG") != "" {
		c.Stderr = os.Stderr
	}
	if err := c.Start(); err != nil {
		return nil, nil, nil, err
	}
	kindLiest.Close()
	kindSchreibt.Close()
	return wirLesen, wirSchreiben, procWarten{c}, nil
}

func hgSichtbarStarten(exe string, args []string) (hgProzess, error) {
	if os.Getenv("KDF_ANMELDUNG_ECHO") != "" { // Test: kein Fenster, nur kurz "offen"
		c := exec.Command("sleep", "2")
		return procWarten{c}, c.Start()
	}
	c := exec.Command(exe, args...)
	return procWarten{c}, c.Start()
}
