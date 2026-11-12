//go:build windows

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Windows-Texterkennung (Windows.Media.Ocr, eingebaut in Windows 10/11) – wie in der Service-Mappe.
// Wird nur benutzt, wenn die genauere Google-Texterkennung über den Server nicht klappt.
const ocrScript = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + "`" + `1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); [void]$task.Wait(-1); $task.Result }
[void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US')) }
if (-not $engine) { throw 'Keine Texterkennung in Windows verfügbar.' }
$out = @()
foreach ($p in ($env:PU_OCR -split '\|')) {
  if (-not $p) { continue }
  try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($p)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
    $out += ,(@($res.Lines | ForEach-Object { $_.Text }) -join "` + "`" + `n")
    $stream.Dispose()
  } catch { $out += ,'' }
}
ConvertTo-Json -InputObject @($out) -Compress
`

func windowsOCR(img []byte) (string, error) {
	dir, err := os.MkdirTemp("", "wl-ocr-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	p := filepath.Join(dir, "foto.jpg")
	if err := os.WriteFile(p, img, 0o600); err != nil {
		return "", err
	}
	cmd := hidden("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ocrScript)
	cmd.Env = append(os.Environ(), "PU_OCR="+p)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := runWithTimeout(cmd, 40*time.Second); err != nil {
		return "", fmt.Errorf("Texterkennung nicht möglich: %s", strings.TrimSpace(errb.String()+" "+err.Error()))
	}
	s := out.String()
	if i := strings.Index(s, "["); i >= 0 {
		s = s[i:]
	}
	var texts []string
	if json.Unmarshal([]byte(strings.TrimSpace(s)), &texts) != nil || len(texts) == 0 {
		return "", fmt.Errorf("Texterkennung lieferte keine Antwort.")
	}
	return texts[0], nil
}

func runWithTimeout(cmd interface {
	Start() error
	Wait() error
}, d time.Duration) error {
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-time.After(d):
		return fmt.Errorf("Zeitüberschreitung")
	}
}
