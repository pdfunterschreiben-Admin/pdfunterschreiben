//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
)

func main() {
	args := os.Args[1:]
	has := func(f string) bool {
		for _, a := range args {
			if a == f {
				return true
			}
		}
		return false
	}

	if has("--uninstall") {
		uninstall()
		return
	}

	self, _ := os.Executable()
	self, _ = filepath.Abs(self)
	if !strings.EqualFold(filepath.Clean(self), filepath.Clean(installedExe())) && !has("--portable") {
		runSetup(self)
		return
	}

	runApp(has("--relaunch"))
}

// platformStart: Symbol schreiben (für Verknüpfungen und „Apps & Features“).
func platformStart(relaunch bool) {
	cleanupOld()
	_ = os.WriteFile(iconPath(), appIcon, 0o644)
	if relaunch {
		registerUninstall() // neue Versionsnummer in „Apps & Features“
	}
}
