package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"
)

// Ende-zu-Ende-Verschlüsselung für Fotos, Kunden-Unterschrift und Vorschaubilder vom/zum Handy.
//
// Bei „fotostart“ erzeugt das Programm einen zufälligen Schlüssel (AES-256) und hängt ihn hinter „#k=“ an den
// Link im QR-Code. Der Teil hinter „#“ wird vom Handy-Browser nie an einen Server geschickt – weder an
// GitHub (Handy-Seite) noch an Google. Das Handy verschlüsselt Fotos und Unterschrift vor dem Hochladen,
// das Programm verschlüsselt die Vorschaubilder; im Google Drive liegt nur unlesbarer Inhalt.
//
// Format: "SMV1" | 12 Byte Nonce | AES-GCM( 4 Byte Länge (big endian) | JSON-Kopf | Daten )
// Unverschlüsselte Dateien (alte Handy-Seite, alte Programme) werden unverändert durchgereicht.

var fotoMagie = []byte("SMV1")

type fotoKey struct {
	k   []byte
	bis time.Time
}

var (
	fotoKeysMu sync.Mutex
	fotoKeys   = map[string]fotoKey{}
)

func fotoSchluessel(token string) []byte {
	fotoKeysMu.Lock()
	defer fotoKeysMu.Unlock()
	if v, ok := fotoKeys[token]; ok && time.Now().Before(v.bis) {
		return v.k
	}
	return nil
}

func fotoSchluesselNeu(token string) []byte {
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		return nil
	}
	fotoKeysMu.Lock()
	defer fotoKeysMu.Unlock()
	for t, v := range fotoKeys { // alte Sitzungen aufräumen
		if time.Now().After(v.bis) {
			delete(fotoKeys, t)
		}
	}
	fotoKeys[token] = fotoKey{k: k, bis: time.Now().Add(6 * time.Hour)}
	return k
}

func fotoSchluesselWeg(token string) {
	fotoKeysMu.Lock()
	delete(fotoKeys, token)
	fotoKeysMu.Unlock()
}

func fotoVerschluesseln(k []byte, kopf map[string]any, daten []byte) ([]byte, error) {
	j, err := json.Marshal(kopf)
	if err != nil {
		return nil, err
	}
	klar := make([]byte, 4, 4+len(j)+len(daten))
	binary.BigEndian.PutUint32(klar, uint32(len(j)))
	klar = append(append(klar, j...), daten...)
	blk, err := aes.NewCipher(k)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(blk)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	out := append(append([]byte{}, fotoMagie...), nonce...)
	return gcm.Seal(out, nonce, klar, nil), nil
}

// verschluesselt: Inhalt beginnt mit "SMV1"
func fotoIstVerschluesselt(b []byte) bool { return bytes.HasPrefix(b, fotoMagie) }

func fotoEntschluesseln(k, b []byte) (map[string]any, []byte, error) {
	blk, err := aes.NewCipher(k)
	if err != nil {
		return nil, nil, err
	}
	gcm, err := cipher.NewGCM(blk)
	if err != nil {
		return nil, nil, err
	}
	n := len(fotoMagie) + gcm.NonceSize()
	if len(b) < n+gcm.Overhead()+4 {
		return nil, nil, errors.New("zu kurz")
	}
	klar, err := gcm.Open(nil, b[len(fotoMagie):n], b[n:], nil)
	if err != nil {
		return nil, nil, err
	}
	l := int(binary.BigEndian.Uint32(klar))
	if l > len(klar)-4 {
		return nil, nil, errors.New("ungültiger Kopf")
	}
	kopf := map[string]any{}
	if err := json.Unmarshal(klar[4:4+l], &kopf); err != nil {
		return nil, nil, err
	}
	return kopf, klar[4+l:], nil
}

// Antwort des Servers nachbearbeiten: Schlüssel an den Link hängen, abgeholte Dateien entschlüsseln.
func fotoAntwort(event, token string, body []byte) []byte {
	switch event {
	case "fotostart":
		var r map[string]any
		if json.Unmarshal(body, &r) != nil || r["ok"] != true {
			return body
		}
		t, _ := r["token"].(string)
		u, _ := r["url"].(string)
		if t == "" || u == "" || strings.Contains(u, "#") || strings.HasPrefix(u, "https://script.google.com/") {
			return body // alte Upload-Seite über Google kennt keine Verschlüsselung
		}
		k := fotoSchluesselNeu(t)
		if k == nil {
			return body
		}
		r["url"] = u + "#k=" + base64.RawURLEncoding.EncodeToString(k)
		r["verschluesselt"] = true
		if b, err := json.Marshal(r); err == nil {
			return b
		}
	case "fotoholen":
		k := fotoSchluessel(token)
		if k == nil {
			return body
		}
		var r map[string]any
		if json.Unmarshal(body, &r) != nil || r["ok"] != true {
			return body
		}
		s, _ := r["b64"].(string)
		roh, err := base64.StdEncoding.DecodeString(s)
		if err != nil || !fotoIstVerschluesselt(roh) {
			return body // unverschlüsselt (alte Handy-Seite): unverändert
		}
		kopf, daten, err := fotoEntschluesseln(k, roh)
		if err != nil {
			b, _ := json.Marshal(map[string]any{"ok": false, "error": "Foto konnte nicht entschlüsselt werden."})
			return b
		}
		r["b64"] = base64.StdEncoding.EncodeToString(daten)
		for _, f := range []string{"name", "mime", "lm", "exif"} {
			if v, ok := kopf[f]; ok {
				r[f] = v
			}
		}
		if b, err := json.Marshal(r); err == nil {
			return b
		}
	case "fotoende":
		fotoSchluesselWeg(token)
	}
	return body
}
