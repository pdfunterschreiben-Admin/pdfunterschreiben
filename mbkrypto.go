//go:build windows

package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/binary"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"io"
	"strings"
	"sync"
	"time"
)

// Montageberichte verschlüsselt an den Kundendienst: Die PDF wird mit dem öffentlichen Schlüssel des Büros
// verschlüsselt, bevor sie zum Server (Google) geht. Öffnen kann sie nur das Programm „Kundendienst
// Montageberichte“ mit dem geheimen Schlüssel. Format (wie dort in schluessel.go):
// "SMB1" | 2 Byte Länge | RSA-OAEP-SHA256(AES-Schlüssel) | 12 Byte Nonce | AES-256-GCM(PDF)

var (
	mbPubMu    sync.Mutex
	mbPub      *rsa.PublicKey
	mbPubLeer  bool // Server hat (noch) keinen Schlüssel
	mbPubZeit  time.Time
	mbPubLaden = func() (string, error) { // austauschbar für Tests
		t, err := serverText(map[string]any{"key": ReportKey, "event": "mb_pubkey"}, 30*time.Second)
		if err != nil {
			return "", err
		}
		if !strings.HasPrefix(t, "OK\n") {
			return "", errors.New(strings.TrimPrefix(t, "FEHLER\n"))
		}
		return strings.TrimPrefix(t, "OK\n"), nil
	}
)

// öffentlicher Schlüssel des Büros (30 Minuten zwischengespeichert); nil ohne Fehler = noch keiner eingerichtet
func mbOeffentlich() (*rsa.PublicKey, error) {
	mbPubMu.Lock()
	defer mbPubMu.Unlock()
	if time.Since(mbPubZeit) < 30*time.Minute && (mbPub != nil || mbPubLeer) {
		return mbPub, nil
	}
	t, err := mbPubLaden()
	if err != nil {
		return nil, err
	}
	mbPubZeit = time.Now()
	t = strings.TrimSpace(t)
	if t == "" {
		mbPub, mbPubLeer = nil, true
		return nil, nil
	}
	blk, _ := pem.Decode([]byte(t))
	if blk == nil {
		return nil, errors.New("ungültiger Schlüssel vom Server")
	}
	k, err := x509.ParsePKIXPublicKey(blk.Bytes)
	if err != nil {
		return nil, err
	}
	rk, ok := k.(*rsa.PublicKey)
	if !ok || rk.N.BitLen() < 2048 {
		return nil, errors.New("ungültiger Schlüssel vom Server")
	}
	mbPub, mbPubLeer = rk, false
	return rk, nil
}

// PDF verschlüsseln; liefert die verschlüsselten Daten und die Prüfsumme (SHA-256) der PDF
func mbVerschluesseln(pub *rsa.PublicKey, pdf []byte) ([]byte, string, error) {
	aesKey := make([]byte, 32)
	nonce := make([]byte, 12)
	if _, err := io.ReadFull(rand.Reader, aesKey); err != nil {
		return nil, "", err
	}
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, "", err
	}
	wrapped, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, pub, aesKey, nil)
	if err != nil {
		return nil, "", err
	}
	blk, _ := aes.NewCipher(aesKey)
	gcm, _ := cipher.NewGCM(blk)
	out := append([]byte("SMB1"), 0, 0)
	binary.BigEndian.PutUint16(out[4:6], uint16(len(wrapped)))
	out = append(append(out, wrapped...), nonce...)
	out = gcm.Seal(out, nonce, pdf, nil)
	h := sha256.Sum256(pdf)
	return out, hex.EncodeToString(h[:]), nil
}
