// Kundendienstfahrzeug (früher „Wagenlager“) – Ersatzteile im Servicewagen. Gleicher Aufbau wie die Service-Mappe:
// eine einzige exe für Setup, Programm und Updates.
//
// Wird die exe von irgendwo gestartet (z. B. aus dem Download-Ordner), arbeitet sie als Setup
// und installiert sich nach %LOCALAPPDATA%\Programs\Kundendienstfahrzeug. Aus dem Installationsordner
// gestartet, öffnet sie die Oberfläche in einem eigenen Edge-Fenster und prüft auf GitHub nach Updates.
// Der Bestand liegt auf dem Anmeldeserver der Service-Mappe (Google-Tabelle) – je Arbeits-E-Mail
// getrennt – und lässt sich so auch auf dem Handy (Handy-Seite) sehen und ändern.
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
	AppName     = "Kundendienstfahrzeug" // Installations- und Datenordner (nicht ändern)
	DisplayName = "Kundendienstfahrzeug"
	AppID       = "Kundendienstfahrzeug"
	ExeName     = "Kundendienstfahrzeug.exe"
	Publisher   = "Service-Mappe"
	SetupName   = "Kundendienstfahrzeug-Setup.exe"

	// Die Releases liegen im selben Repository wie die Service-Mappe, aber unter eigenen Namen,
	// damit sich die Programme nicht gegenseitig Updates anbieten.
	StableTag = "kundendienstfahrzeug-stabil"
	TestTag   = "kundendienstfahrzeug-adminkanal"

	// Handy-Seite (GitHub Pages aus dem Ordner docs/ des Repositorys)
	HandyURL = "https://pdfunterschreiben-admin.github.io/pdfunterschreiben/kundendienstfahrzeug/"
)

// Port wird beim Start je Windows-Benutzer festgelegt (siehe instance.go).
var Port = 53813

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
