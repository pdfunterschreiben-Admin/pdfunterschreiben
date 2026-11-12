//go:build windows

package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
	"unsafe"
)

// Wie in der Service-Mappe: 1. klassisches Outlook (COM)  2. Standard-Mailprogramm über MAPI
// 3. Ordner mit der Datei im Explorer zeigen.
const outlookScript = `$ErrorActionPreference = 'Stop'
function Get-Ol { try { [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application') } catch { $null } }
$o = Get-Ol
if (-not $o -and (Get-Process outlook -ErrorAction SilentlyContinue)) { try { $o = New-Object -ComObject Outlook.Application } catch { $o = $null } }
if (-not $o) {
  Start-Process 'outlook.exe'
  for ($i = 0; $i -lt 80 -and -not $o; $i++) { Start-Sleep -Milliseconds 500; $o = Get-Ol }
  if (-not $o) { $o = New-Object -ComObject Outlook.Application }
  Start-Sleep -Seconds 3
}
$m = $o.CreateItem(0)
$m.Subject = $env:PU_SUBJ
if ($env:PU_TO) { $m.To = $env:PU_TO }
[void]$m.Attachments.Add($env:PU_FILE)
$m.Display($false)
# Text vor die Signatur setzen
try { $m.HTMLBody = $env:PU_HTML + $m.HTMLBody } catch { $m.Body = $env:PU_TEXT + "` + "`" + `r` + "`" + `n" + $m.Body }
try { $m.GetInspector.Activate() } catch {}`

func htmlText(t string) string {
	var b bytes.Buffer
	b.WriteString(`<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt">`)
	for _, z := range bytes.Split([]byte(t), []byte("\n")) {
		var e bytes.Buffer
		for _, c := range string(z) {
			switch c {
			case '<':
				e.WriteString("&lt;")
			case '>':
				e.WriteString("&gt;")
			case '&':
				e.WriteString("&amp;")
			default:
				e.WriteRune(c)
			}
		}
		b.WriteString(e.String() + "<br>")
	}
	b.WriteString("</div>")
	return b.String()
}

func mailOeffnen(an, betreff, text, datei string) (string, error) {
	cmd := hidden("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", outlookScript)
	cmd.Env = append(os.Environ(), "PU_SUBJ="+betreff, "PU_TO="+an, "PU_FILE="+datei, "PU_TEXT="+text, "PU_HTML="+htmlText(text))
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := runWithTimeout(cmd, 60*time.Second); err == nil {
		return "outlook", nil
	}
	ergebnis := make(chan error, 1)
	go func() { ergebnis <- mapiSendMail(betreff, an, text, datei) }()
	select {
	case err := <-ergebnis:
		if err == nil {
			return "mapi", nil
		}
	case <-time.After(4 * time.Second):
		return "mapi", nil // Fenster ist offen und wartet auf den Nutzer
	}
	_ = hidden("explorer.exe", "/select,", datei).Start()
	return "explorer", nil
}

type mapiFileDescW struct {
	Reserved uint32
	Flags    uint32
	Position uint32
	PathName *uint16
	FileName *uint16
	FileType uintptr
}

type mapiMessageW struct {
	Reserved       uint32
	Subject        *uint16
	NoteText       *uint16
	MessageType    *uint16
	DateReceived   *uint16
	ConversationID *uint16
	Flags          uint32
	Originator     uintptr
	RecipCount     uint32
	Recips         uintptr
	FileCount      uint32
	Files          *mapiFileDescW
}

type mapiRecipDescW struct {
	Reserved   uint32
	RecipClass uint32
	Name       *uint16
	Address    *uint16
	EIDSize    uint32
	EntryID    uintptr
}

func mapiSendMail(subject, to, text, path string) error {
	dll := syscall.NewLazyDLL("mapi32.dll")
	proc := dll.NewProc("MAPISendMailW")
	if err := proc.Find(); err != nil {
		return err
	}
	pp, _ := syscall.UTF16PtrFromString(path)
	fn, _ := syscall.UTF16PtrFromString(filepath.Base(path))
	files := []mapiFileDescW{{Position: 0xFFFFFFFF, PathName: pp, FileName: fn}}
	subj, _ := syscall.UTF16PtrFromString(subject)
	body, _ := syscall.UTF16PtrFromString(text)
	msg := mapiMessageW{Subject: subj, NoteText: body, FileCount: 1, Files: &files[0]}
	var recip mapiRecipDescW
	if to != "" {
		name, _ := syscall.UTF16PtrFromString(to)
		addr, _ := syscall.UTF16PtrFromString("SMTP:" + to)
		recip = mapiRecipDescW{RecipClass: 1, Name: name, Address: addr}
		msg.RecipCount, msg.Recips = 1, uintptr(unsafe.Pointer(&recip))
	}
	const mapiLogonUI, mapiDialog = 0x1, 0x8
	r, _, _ := proc.Call(0, 0, uintptr(unsafe.Pointer(&msg)), mapiLogonUI|mapiDialog, 0)
	if r != 0 && r != 1 {
		return fmt.Errorf("MAPI-Fehler %d", r)
	}
	return nil
}
