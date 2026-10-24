//go:build !windows

// Nur zum Testen auf Linux/macOS: startet den Server ohne Setup und Windows-Funktionen.
// Mit PPTX_DEV=1 läuft er weiter, auch wenn kein Fenster verbunden ist.
package main

import (
	"fmt"
	"os"
	"os/exec"
)

func main() { runApp(false) }

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
