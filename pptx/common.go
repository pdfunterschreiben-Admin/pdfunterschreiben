// PDF zu PowerPoint – gleicher Aufbau wie „PDF Unterschreiben & Dokumentation“:
// eine einzige exe für Setup, Programm und Updates.
//
// Wird die exe von irgendwo gestartet (z. B. aus dem Download-Ordner), arbeitet sie als Setup
// und installiert sich nach %LOCALAPPDATA%\Programs\PDF zu PowerPoint. Aus dem Installationsordner
// gestartet, öffnet sie die Oberfläche in einem eigenen Edge-Fenster und prüft auf GitHub nach Updates.
package main

import (
	"os"
	"path/filepath"
)

// Werden beim Bauen per -ldflags gesetzt.
var (
	Version   = "0.0.0-dev"
	RepoOwner = ""
	RepoName  = "pdfunterschreiben"
)

const (
	AppName     = "PDF zu PowerPoint" // Installations- und Datenordner (nicht ändern)
	DisplayName = "PDF zu PowerPoint"
	AppID       = "PDFzuPowerPoint"
	ExeName     = "PDF zu PowerPoint.exe"
	Publisher   = DisplayName
	SetupName   = "PDF-zu-PowerPoint-Setup.exe"

	// Die Releases liegen im selben Repository wie PDF Unterschreiben, aber unter eigenen Namen,
	// damit sich die beiden Programme nicht gegenseitig Updates anbieten.
	StableTag = "pptx-stabil"
	TestTag   = "pptx-adminkanal"
)

// Port wird beim Start je Windows-Benutzer festgelegt (siehe instance.go).
var Port = 51213

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
