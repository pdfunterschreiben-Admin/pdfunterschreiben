//go:build !windows

// Nur zum Testen auf Linux/macOS: startet den Server ohne Setup und Windows-Funktionen.
// Mit KDF_DEV=1 läuft er weiter, auch wenn kein Fenster verbunden ist.
package main

import (
	"fmt"
	"os"
	"os/exec"
)

func main() {
	// Prüfserver (z. B. die Apps-Script-Nachbildung in test/) statt Google
	if u := os.Getenv("KDF_TEST_SERVER"); u != "" {
		ReportURL, ReportKey, serverPrefix = u, os.Getenv("KDF_TEST_KEY"), "http://127.0.0.1:"
	}
	runApp(false)
}

func platformStart(relaunch bool) {}
func registerUninstall()          {}
func info(text string)            { fmt.Println("INFO:", text) }
func fail(text string)            { fmt.Println("FEHLER:", text) }
func openExternal(u string)       { fmt.Println("ÖFFNEN:", u) }
func openWindow(url string)       { fmt.Println("PROGRAMM BEREIT:", url) }

func detached(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	return cmd.Start()
}

func windowsOCR(img []byte) (string, error) {
	// Zum Testen: KDF_OCR_TEXT liefert einen festen Text
	if t := os.Getenv("KDF_OCR_TEXT"); t != "" {
		return t, nil
	}
	return "", fmt.Errorf("Texterkennung gibt es nur unter Windows.")
}
