//go:build windows

package main

import (
	"encoding/binary"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"unsafe"
)

// startupInfo wie STARTUPINFOW – mit den Feldern für die vererbten C-Dateinummern.
type startupInfo struct {
	Cb            uint32
	Reserved      *uint16
	Desktop       *uint16
	Title         *uint16
	X             uint32
	Y             uint32
	XSize         uint32
	YSize         uint32
	XCountChars   uint32
	YCountChars   uint32
	FillAttribute uint32
	Flags         uint32
	ShowWindow    uint16
	CbReserved2   uint16
	LpReserved2   *byte
	StdInput      syscall.Handle
	StdOutput     syscall.Handle
	StdErr        syscall.Handle
}

var procCreateProcessW = syscall.NewLazyDLL("kernel32.dll").NewProc("CreateProcessW")

func hgBrowserPfad() string { return findBrowser() }
func hgURL(u string) string { return u }

type procWarten struct{ p *os.Process }

func (p procWarten) Kill() error                     { return p.p.Kill() }
func (p procWarten) Wait() (*os.ProcessState, error) { return p.p.Wait() }

// hgProzessStarten startet den Browser mit zwei vererbten Pipes als C-Dateinummern 3 und 4
// (übliches lpReserved2-Verfahren der C-Laufzeit, so liest Chromium --remote-debugging-pipe).
func hgProzessStarten(exe string, args []string) (io.Reader, io.WriteCloser, hgProzess, error) {
	sa := &syscall.SecurityAttributes{InheritHandle: 1}
	sa.Length = uint32(unsafe.Sizeof(*sa))
	var kindLiest, wirSchreiben, wirLesen, kindSchreibt syscall.Handle
	if err := syscall.CreatePipe(&kindLiest, &wirSchreiben, sa, 0); err != nil {
		return nil, nil, nil, err
	}
	if err := syscall.CreatePipe(&wirLesen, &kindSchreibt, sa, 0); err != nil {
		syscall.CloseHandle(kindLiest)
		syscall.CloseHandle(wirSchreiben)
		return nil, nil, nil, err
	}
	// Unsere Enden nicht vererben
	_ = syscall.SetHandleInformation(wirSchreiben, syscall.HANDLE_FLAG_INHERIT, 0)
	_ = syscall.SetHandleInformation(wirLesen, syscall.HANDLE_FLAG_INHERIT, 0)

	const n = 5
	hs := int(unsafe.Sizeof(uintptr(0)))
	buf := make([]byte, 4+n+n*hs)
	binary.LittleEndian.PutUint32(buf, n)
	ungueltig := ^uintptr(0)
	handles := []uintptr{ungueltig, ungueltig, ungueltig, uintptr(kindLiest), uintptr(kindSchreibt)}
	for i := 0; i < n; i++ {
		if i >= 3 {
			buf[4+i] = 0x01 | 0x08 // FOPEN | FPIPE
		}
		off := 4 + n + i*hs
		if hs == 8 {
			binary.LittleEndian.PutUint64(buf[off:], uint64(handles[i]))
		} else {
			binary.LittleEndian.PutUint32(buf[off:], uint32(handles[i]))
		}
	}
	si := &startupInfo{CbReserved2: uint16(len(buf)), LpReserved2: &buf[0]}
	si.Cb = uint32(unsafe.Sizeof(*si))
	teile := []string{syscall.EscapeArg(exe)}
	for _, a := range args {
		teile = append(teile, syscall.EscapeArg(a))
	}
	exe16, _ := syscall.UTF16PtrFromString(exe)
	cmd16, _ := syscall.UTF16PtrFromString(strings.Join(teile, " "))
	var pi syscall.ProcessInformation
	const createNoWindow = 0x08000000
	r1, _, e1 := procCreateProcessW.Call(uintptr(unsafe.Pointer(exe16)), uintptr(unsafe.Pointer(cmd16)), 0, 0, 1,
		createNoWindow|syscall.CREATE_UNICODE_ENVIRONMENT, 0, 0, uintptr(unsafe.Pointer(si)), uintptr(unsafe.Pointer(&pi)))
	var err error
	if r1 == 0 {
		err = e1
	}
	syscall.CloseHandle(kindLiest)
	syscall.CloseHandle(kindSchreibt)
	if err != nil {
		syscall.CloseHandle(wirSchreiben)
		syscall.CloseHandle(wirLesen)
		return nil, nil, nil, err
	}
	syscall.CloseHandle(pi.Thread)
	p, err := os.FindProcess(int(pi.ProcessId))
	syscall.CloseHandle(pi.Process)
	if err != nil {
		return nil, nil, nil, err
	}
	return os.NewFile(uintptr(wirLesen), "cdp-lesen"), os.NewFile(uintptr(wirSchreiben), "cdp-schreiben"), procWarten{p}, nil
}

func hgSichtbarStarten(exe string, args []string) (hgProzess, error) {
	c := exec.Command(exe, args...)
	if err := c.Start(); err != nil {
		return nil, err
	}
	return procWarten{c.Process}, nil
}
