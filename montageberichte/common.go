// Kundendienst Montageberichte – fürs Büro: die unterschriebenen Berichte der Monteure (aus der
// Service-Mappe) je Monteur und Kalenderwoche, zu einer PDF je Auftrag zusammengefügt
// (erst Montagebericht, dann UVV-Bericht, dann DGUV-V3-Bericht).
// Gleicher Aufbau wie die Service-Mappe: eine einzige exe für Setup, Programm und Updates.
package main

import (
	"os"
	"path/filepath"
	"strings"
)

// Werden beim Bauen per -ldflags gesetzt.
var (
	Version   = "0.0.0-dev"
	RepoOwner = ""
	RepoName  = "pdfunterschreiben"
)

const (
	AppName     = "Kundendienst Montageberichte" // Installations- und Datenordner (nicht ändern)
	DisplayName = "Kundendienst Montageberichte"
	AppID       = "KundendienstMontageberichte"
	ExeName     = "Kundendienst Montageberichte.exe"
	Publisher   = "Service-Mappe"
	SetupName   = "Kundendienst-Montageberichte-Setup.exe"

	// Die Releases liegen im selben Repository wie die Service-Mappe, aber unter eigenen Namen,
	// damit sich die Programme nicht gegenseitig Updates anbieten.
	StableTag = "montageberichte-stabil"
	TestTag   = "montageberichte-adminkanal"
)

// Port wird beim Start je Windows-Benutzer festgelegt (siehe instance.go).
var Port = 54713

func installDir() string {
	return filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", AppName)
}
func installedExe() string { return filepath.Join(installDir(), ExeName) }
func dataDir() string {
	base := os.Getenv("APPDATA")
	if base == "" {
		base, _ = os.UserConfigDir()
	}
	d := filepath.Join(base, AppName)
	_ = os.MkdirAll(d, 0o755)
	return d
}

// Nur der Anmeldeserver (Google Apps Script) ist erlaubt. Zum Testen unter Linux/macOS darf
// dev_other.go einen lokalen Prüfserver eintragen.
var serverPrefix = "https://script.google.com/"

func serverOK() bool { return ReportURL != "" && strings.HasPrefix(ReportURL, serverPrefix) }
