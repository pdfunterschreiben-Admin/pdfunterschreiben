//go:build windows

package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Verschlüsselte Kundendaten (Visitenkarten).
//
// Die Einträge liegen auf dem Server nur verschlüsselt (Spalte „Daten (verschlüsselt)“). Den gemeinsamen
// Kundendaten-Schlüssel (AES-256) haben nur die Service-Mappen: Jede hat ein eigenes Schlüsselpaar, der
// Kundendaten-Schlüssel liegt je Rechner mit dessen öffentlichem Schlüssel verpackt auf dem Server. Der erste
// entsteht beim Admin; danach gibt jede Service-Mappe, die ihn hat, ihn automatisch an neue Rechner weiter.
// Zusammenführen und das Erkennen doppelter Einträge macht deshalb das Programm, nicht mehr der Server.
//
// Eintrag: "SKD1" | 12 Byte Nonce | AES-256-GCM(JSON {firma,name,email,tel,strasse,ort})

type kdEintrag struct {
	ID      string `json:"-"`
	Firma   string `json:"firma"`
	Name    string `json:"name"`
	Email   string `json:"email"`
	Tel     string `json:"tel"`
	Strasse string `json:"strasse"`
	Ort     string `json:"ort"`
	klar    bool   // noch unverschlüsselt auf dem Server
}

func (e kdEintrag) inhalt() string {
	n := func(s string) string { return strings.Join(strings.Fields(strings.ToLower(s)), " ") }
	return strings.Join([]string{n(e.Firma), n(e.Name), n(e.Email), n(e.Tel), n(e.Strasse), n(e.Ort)}, "|")
}

// Server-Anfrage (austauschbar für Tests)
var kdServer = func(daten map[string]any) (string, error) {
	u := angemeldeterNutzer()
	if u == nil || u.Email == "" || u.ID == "" {
		return "", errors.New("Bitte zuerst im Programm anmelden.")
	}
	daten["key"], daten["email"], daten["name"], daten["id"], daten["version"] = ReportKey, u.Email, u.Name, u.ID, Version
	t, err := serverText(daten, 60*time.Second)
	if err != nil {
		return "", errors.New("Keine Verbindung zum Server.")
	}
	t = strings.ReplaceAll(t, "\r", "")
	if !strings.HasPrefix(t, "OK\n") {
		return "", errors.New(serverFehlerText(t, "kd"))
	}
	return t[3:], nil
}

var (
	kdMu        sync.Mutex
	kdK         []byte // gemeinsamer Kundendaten-Schlüssel
	kdKFp       string
	kdLetzte    time.Time
	kdVerzeich  = func() string { return dataDir() }
	kdGeraetKey *rsa.PrivateKey
)

func kdFp(k []byte) string { h := sha256.Sum256(k); return hex.EncodeToString(h[:])[:16] }

func kdGeraet() (*rsa.PrivateKey, error) {
	if kdGeraetKey != nil {
		return kdGeraetKey, nil
	}
	p := filepath.Join(kdVerzeich(), "kd-geraet.pem")
	if b, err := os.ReadFile(p); err == nil {
		if blk, _ := pem.Decode(b); blk != nil {
			if k, err := x509.ParsePKCS8PrivateKey(blk.Bytes); err == nil {
				if rk, ok := k.(*rsa.PrivateKey); ok {
					kdGeraetKey = rk
					return rk, nil
				}
			}
		}
	}
	k, err := rsa.GenerateKey(rand.Reader, 3072)
	if err != nil {
		return nil, err
	}
	der, _ := x509.MarshalPKCS8PrivateKey(k)
	if err := os.WriteFile(p, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		return nil, err
	}
	kdGeraetKey = k
	return k, nil
}

func kdKLaden() {
	if kdK != nil {
		return
	}
	if b, err := os.ReadFile(filepath.Join(kdVerzeich(), "kd-schluessel.bin")); err == nil && len(b) == 32 {
		kdK, kdKFp = b, kdFp(b)
	}
}

func kdKSpeichern(k []byte) error {
	if err := os.WriteFile(filepath.Join(kdVerzeich(), "kd-schluessel.bin"), k, 0o600); err != nil {
		return err
	}
	kdK, kdKFp = k, kdFp(k)
	return nil
}

func pubB64(k *rsa.PublicKey) string {
	der, _ := x509.MarshalPKIXPublicKey(k)
	return base64.StdEncoding.EncodeToString(der)
}

func verpacken(pubB string, k []byte) (string, error) {
	der, err := base64.StdEncoding.DecodeString(pubB)
	if err != nil {
		return "", err
	}
	p, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return "", err
	}
	rp, ok := p.(*rsa.PublicKey)
	if !ok || rp.N.BitLen() < 2048 {
		return "", errors.New("ungültiger Schlüssel")
	}
	w, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, rp, k, nil)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(w), nil
}

// kdBereit sorgt für den Kundendaten-Schlüssel (holen, beim Admin einmal erzeugen) und gibt ihn an neue Rechner weiter.
// Fehler „unbekannt“ = der Server kann noch keine Verschlüsselung (altes Apps-Script) → bisheriger Weg.
var errKdAlt = errors.New("Server ohne Verschlüsselung")

func kdBereit(erzwingen bool) error {
	kdMu.Lock()
	defer kdMu.Unlock()
	kdKLaden()
	if !erzwingen && kdK != nil && time.Since(kdLetzte) < 2*time.Minute {
		return nil
	}
	g, err := kdGeraet()
	if err != nil {
		return err
	}
	t, err := kdServer(map[string]any{"event": "kd_krypto", "pub": pubB64(&g.PublicKey)})
	if err != nil {
		if strings.Contains(err.Error(), "berechtigt") || strings.Contains(err.Error(), "Unbekannte") {
			return errKdAlt
		}
		if kdK != nil {
			return nil // kurz keine Verbindung: mit dem vorhandenen Schlüssel weiterarbeiten
		}
		return err
	}
	var r struct {
		K      string `json:"k"`
		Fp     string `json:"fp"`
		Neu    bool   `json:"neu"`
		Bedarf []struct {
			ID  string `json:"id"`
			Pub string `json:"pub"`
		} `json:"bedarf"`
	}
	if err := json.Unmarshal([]byte(t), &r); err != nil {
		return errKdAlt
	}
	kdLetzte = time.Now()
	switch {
	case r.K != "" && (kdK == nil || kdKFp != r.Fp):
		w, err := base64.StdEncoding.DecodeString(r.K)
		if err == nil {
			if k, err := rsa.DecryptOAEP(sha256.New(), nil, g, w, nil); err == nil && len(k) == 32 && kdFp(k) == r.Fp {
				if err := kdKSpeichern(k); err != nil {
					return err
				}
			}
		}
	case r.K == "" && r.Fp == "" && r.Neu:
		// erster Schlüssel überhaupt – beim Admin
		k := make([]byte, 32)
		if _, err := io.ReadFull(rand.Reader, k); err != nil {
			return err
		}
		w, err := verpacken(pubB64(&g.PublicKey), k)
		if err != nil {
			return err
		}
		if _, err := kdServer(map[string]any{"event": "kd_krypto_neu", "k": w, "fp": kdFp(k)}); err != nil {
			return err
		}
		if err := kdKSpeichern(k); err != nil {
			return err
		}
		// gleich nochmal fragen: jetzt kennt der Server den Schlüssel und nennt die Rechner, die ihn noch brauchen
		if t2, err := kdServer(map[string]any{"event": "kd_krypto", "pub": pubB64(&g.PublicKey)}); err == nil {
			_ = json.Unmarshal([]byte(t2), &r)
		}
	}
	if kdK != nil && r.Fp == kdKFp && len(r.Bedarf) > 0 && r.K != "" {
		liste := []map[string]string{}
		for _, b := range r.Bedarf {
			if w, err := verpacken(b.Pub, kdK); err == nil {
				liste = append(liste, map[string]string{"id": b.ID, "k": w})
			}
		}
		if len(liste) > 0 {
			_, _ = kdServer(map[string]any{"event": "kd_krypto_geben", "fp": kdKFp, "liste": liste})
		}
	}
	if kdK == nil {
		return errors.New("Die Kundendaten werden auf diesem Rechner gerade eingerichtet (verschlüsselt). Bitte in ein paar Minuten nochmal öffnen.")
	}
	return nil
}

func kdVerschluesseln(e kdEintrag) (string, error) {
	j, _ := json.Marshal(e)
	blk, _ := aes.NewCipher(kdK)
	gcm, _ := cipher.NewGCM(blk)
	nonce := make([]byte, 12)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	out := append([]byte("SKD1"), nonce...)
	return base64.StdEncoding.EncodeToString(gcm.Seal(out, nonce, j, nil)), nil
}

func kdEntschluesseln(b64 string) (kdEintrag, error) {
	var e kdEintrag
	b, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || len(b) < 4+12+16 || string(b[:4]) != "SKD1" {
		return e, errors.New("ungültig")
	}
	blk, _ := aes.NewCipher(kdK)
	gcm, _ := cipher.NewGCM(blk)
	j, err := gcm.Open(nil, b[4:16], b[16:], nil)
	if err != nil {
		return e, err
	}
	err = json.Unmarshal(j, &e)
	return e, err
}

// alle Einträge (entschlüsselt) holen; unverschlüsselte werden dabei auf dem Server verschlüsselt
func kdListe() ([]kdEintrag, error) {
	t, err := kdServer(map[string]any{"event": "kd_holen2"})
	if err != nil {
		return nil, err
	}
	var out, klar []kdEintrag
	for _, z := range strings.Split(t, "\n") {
		c := strings.Split(z, "\t")
		if len(c) < 3 || c[0] == "" {
			continue
		}
		if c[1] == "E" {
			e, err := kdEntschluesseln(c[2])
			if err != nil {
				continue // anderer Schlüssel / kaputt: überspringen
			}
			e.ID = c[0]
			out = append(out, e)
		} else if c[1] == "P" && len(c) >= 8 {
			e := kdEintrag{ID: c[0], Firma: c[2], Name: c[3], Email: c[4], Tel: c[5], Strasse: c[6], Ort: c[7], klar: true}
			out = append(out, e)
			klar = append(klar, e)
		}
	}
	// noch unverschlüsselte Einträge (von früher oder von älteren Service-Mappen) jetzt verschlüsseln –
	// erst ab der freigegebenen Version, damit Kollegen mit der alten Service-Mappe in der Testphase nichts fehlt
	if len(klar) > 0 && !strings.Contains(Version, "-test") {
		liste := []map[string]string{}
		for _, e := range klar {
			if b, err := kdVerschluesseln(e); err == nil {
				liste = append(liste, map[string]string{"id": e.ID, "blob": b})
			}
		}
		for i := 0; i < len(liste); i += 200 {
			j := min(i+200, len(liste))
			_, _ = kdServer(map[string]any{"event": "kd_speichern2", "kd": map[string]any{"liste": liste[i:j]}})
		}
	}
	return out, nil
}

// Antwort im bisherigen Format (id \t firma \t name \t email \t tel \t strasse \t ort), doppelte nur einmal
func kdHolen() (string, error) {
	if err := kdBereit(false); err != nil {
		return "", err
	}
	l, err := kdListe()
	if err != nil {
		return "", err
	}
	gesehen := map[string]bool{}
	z := []string{}
	sauber := func(s string) string { return strings.NewReplacer("\t", " ", "\n", " ").Replace(s) }
	for _, e := range l {
		if e.Firma == "" && e.Name == "" && e.Email == "" && e.Tel == "" {
			continue
		}
		if gesehen[e.inhalt()] {
			continue
		}
		gesehen[e.inhalt()] = true
		z = append(z, strings.Join([]string{e.ID, sauber(e.Firma), sauber(e.Name), sauber(e.Email), sauber(e.Tel), sauber(e.Strasse), sauber(e.Ort)}, "\t"))
	}
	return strings.Join(z, "\n"), nil
}

func kdSpeichern(kd map[string]string) (string, error) {
	if err := kdBereit(false); err != nil {
		return "", err
	}
	tr := func(s string, n int) string {
		s = strings.TrimSpace(s)
		if r := []rune(s); len(r) > n {
			s = string(r[:n])
		}
		return s
	}
	e := kdEintrag{ID: tr(kd["id"], 40), Firma: tr(kd["firma"], 120), Name: tr(kd["name"], 120), Email: tr(kd["email"], 150),
		Tel: tr(kd["tel"], 60), Strasse: tr(kd["strasse"], 150), Ort: tr(kd["ort"], 150)}
	if e.Firma == "" && e.Name == "" && e.Email == "" && e.Tel == "" {
		return "", errors.New("Leerer Eintrag.")
	}
	l, err := kdListe()
	if err != nil {
		return "", err
	}
	n := func(s string) string { return strings.Join(strings.Fields(strings.ToLower(s)), " ") }
	if e.ID == "" {
		// neu: gleiche Firma + gleicher Ansprechpartner schon da (z. B. von einem Kollegen) -> diesen ergänzen
		for _, a := range l {
			if n(a.Firma) == n(e.Firma) && n(a.Name) == n(e.Name) {
				w := func(neu, alt string) string {
					if neu != "" {
						return neu
					}
					return alt
				}
				e = kdEintrag{ID: a.ID, Firma: w(e.Firma, a.Firma), Name: w(e.Name, a.Name), Email: w(e.Email, a.Email),
					Tel: w(e.Tel, a.Tel), Strasse: w(e.Strasse, a.Strasse), Ort: w(e.Ort, a.Ort)}
				break
			}
		}
	}
	// gleiche Einträge (z. B. doppelt angelegt) beim Ändern mit entfernen
	var alt *kdEintrag
	for i := range l {
		if l[i].ID == e.ID {
			alt = &l[i]
		}
	}
	b, err := kdVerschluesseln(e)
	if err != nil {
		return "", err
	}
	t, err := kdServer(map[string]any{"event": "kd_speichern2", "kd": map[string]any{"id": e.ID, "blob": b}})
	if err != nil {
		return "", err
	}
	id := strings.TrimSpace(t)
	if alt != nil {
		kdDoppelteWeg(l, *alt, id)
	}
	return id, nil
}

func kdDoppelteWeg(l []kdEintrag, e kdEintrag, behalten string) {
	for _, a := range l {
		if a.ID != behalten && a.ID != e.ID && a.inhalt() == e.inhalt() {
			_, _ = kdServer(map[string]any{"event": "kd_loeschen", "kd": map[string]string{"id": a.ID}})
		}
	}
}

func kdLoeschen(id string) error {
	if err := kdBereit(false); err != nil {
		return err
	}
	l, err := kdListe()
	if err != nil {
		return err
	}
	if _, err := kdServer(map[string]any{"event": "kd_loeschen", "kd": map[string]string{"id": id}}); err != nil {
		return err
	}
	for _, a := range l {
		if a.ID == id {
			kdDoppelteWeg(l, a, id)
		}
	}
	return nil
}

// im Hintergrund: Schlüssel bereithalten und an neue Kollegen weitergeben
func kdHintergrund() {
	go func() {
		time.Sleep(20 * time.Second)
		for {
			if u := angemeldeterNutzer(); u != nil && u.ID != "" {
				_ = kdBereit(true)
			}
			time.Sleep(10 * time.Minute)
		}
	}()
}
