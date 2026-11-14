//go:build windows

package main

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"time"

	"pdfunterschreiben/internal/ole"
	"pdfunterschreiben/internal/ole/oleutil"
)

var kontaktMail = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

// Legt die E-Mail-Adresse eines Kunden als Kontakt in Outlook an, falls es sie dort noch nicht gibt.
// Dann schlägt Outlook die Adresse beim Tippen im „An“-Feld von selbst vor.
func (a *app) handleKontakt(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	var in struct {
		Firma   string `json:"firma"`
		Name    string `json:"name"`
		Email   string `json:"email"`
		Tel     string `json:"tel"`
		Strasse string `json:"strasse"`
		Ort     string `json:"ort"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": "Ungültige Anfrage."})
		return
	}
	in.Email = strings.TrimSpace(in.Email)
	in.Name = strings.TrimSpace(in.Name)
	in.Firma = strings.TrimSpace(in.Firma)
	in.Tel = strings.TrimSpace(in.Tel)
	in.Strasse = strings.TrimSpace(in.Strasse)
	in.Ort = strings.TrimSpace(in.Ort)
	hasMail := kontaktMail.MatchString(in.Email)
	if !hasMail && in.Tel == "" {
		writeJSON(w, map[string]any{"ok": false, "error": "Weder E-Mail noch Telefon."})
		return
	}
	err := olNativAuftrag(olAuftrag{art: "fn", fn: func(app *ole.IDispatch) error {
		items, fertig, err := olKontaktOrdner(app)
		if err != nil {
			return err
		}
		defer fertig()
		_, err = olKontaktAnlegen(app, items, olKontakt{in.Firma, in.Name, in.Email, in.Tel, in.Strasse, in.Ort})
		return err
	}}, 60*time.Second)
	if err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func kontaktEig(c *ole.IDispatch, eig string) string {
	v, err := oleutil.GetProperty(c, eig)
	if err != nil || v == nil {
		return ""
	}
	return strings.TrimSpace(v.ToString())
}

type kontaktEintrag struct {
	Firma   string `json:"firma"`
	Name    string `json:"name"`
	Email   string `json:"email"`
	Tel     string `json:"tel"`
	Strasse string `json:"strasse"`
	Ort     string `json:"ort"`
}

// Liest die vorhandenen Outlook-Kontakte (Firma, Name, E-Mail, Telefon, Adresse), damit sie als
// persönliche Kundendaten übernommen werden können (umgekehrte Richtung zu handleKontakt).
func (a *app) handleKontaktImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	var liste []kontaktEintrag
	err := olNativAuftrag(olAuftrag{art: "fn", fn: func(app *ole.IDispatch) error {
		nv, err := oleutil.CallMethod(app, "GetNamespace", "MAPI")
		if err != nil {
			return err
		}
		ns := nv.ToIDispatch()
		defer ns.Release()
		fv, err := oleutil.CallMethod(ns, "GetDefaultFolder", 10) // olFolderContacts
		if err != nil {
			return err
		}
		folder := fv.ToIDispatch()
		defer folder.Release()
		iv, err := oleutil.GetProperty(folder, "Items")
		if err != nil {
			return err
		}
		items := iv.ToIDispatch()
		defer items.Release()
		cv, err := oleutil.GetProperty(items, "Count")
		if err != nil {
			return err
		}
		n := int(cv.Val)
		if n > 3000 {
			n = 3000 // Sicherheitsgrenze, falls das Adressbuch riesig ist
		}
		for i := 1; i <= n; i++ {
			iv2, err := oleutil.CallMethod(items, "Item", i)
			if err != nil {
				continue
			}
			c := iv2.ToIDispatch()
			if c == nil {
				continue
			}
			em := kontaktEig(c, "Email1Address")
			tel := kontaktEig(c, "BusinessTelephoneNumber")
			if tel == "" {
				tel = kontaktEig(c, "MobileTelephoneNumber")
			}
			if em != "" || tel != "" {
				liste = append(liste, kontaktEintrag{
					Firma:   kontaktEig(c, "CompanyName"),
					Name:    kontaktEig(c, "FullName"),
					Email:   em,
					Tel:     tel,
					Strasse: kontaktEig(c, "BusinessAddressStreet"),
					Ort:     kontaktEig(c, "BusinessAddressCity"),
				})
			}
			c.Release()
		}
		return nil
	}}, 90*time.Second)
	if err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, map[string]any{"ok": true, "liste": liste})
}

type olKontakt struct{ Firma, Name, Email, Tel, Strasse, Ort string }

// Kontakte-Ordner von Outlook (olFolderContacts) – fertig() gibt alles wieder frei
func olKontaktOrdner(app *ole.IDispatch) (*ole.IDispatch, func(), error) {
	nv, err := oleutil.CallMethod(app, "GetNamespace", "MAPI")
	if err != nil {
		return nil, nil, err
	}
	ns := nv.ToIDispatch()
	fv, err := oleutil.CallMethod(ns, "GetDefaultFolder", 10)
	if err != nil {
		ns.Release()
		return nil, nil, err
	}
	folder := fv.ToIDispatch()
	iv, err := oleutil.GetProperty(folder, "Items")
	if err != nil {
		folder.Release()
		ns.Release()
		return nil, nil, err
	}
	items := iv.ToIDispatch()
	return items, func() { items.Release(); folder.Release(); ns.Release() }, nil
}

func olFinde(items *ole.IDispatch, filter string) bool {
	fv, err := oleutil.CallMethod(items, "Find", filter)
	if err != nil {
		return false
	}
	if d := fv.ToIDispatch(); d != nil {
		d.Release()
		return true
	}
	return false
}

// Legt einen Outlook-Kontakt an – außer es gibt ihn schon (gleiche E-Mail, ohne E-Mail: gleicher Name + Firma).
func olKontaktAnlegen(app, items *ole.IDispatch, k olKontakt) (bool, error) {
	q := func(v string) string { return strings.ReplaceAll(v, "'", "''") }
	hasMail := kontaktMail.MatchString(k.Email)
	if !hasMail && k.Tel == "" {
		return false, nil
	}
	name := k.Name
	if name == "" {
		name = k.Firma
	}
	if hasMail {
		if olFinde(items, "[Email1Address] = '"+q(k.Email)+"'") {
			return false, nil
		}
	} else if name != "" && olFinde(items, "[FullName] = '"+q(name)+"' And [CompanyName] = '"+q(k.Firma)+"'") {
		return false, nil
	}
	cv, err := oleutil.CallMethod(app, "CreateItem", 2) // olContactItem
	if err != nil {
		return false, err
	}
	c := cv.ToIDispatch()
	defer c.Release()
	if name != "" {
		_, _ = oleutil.PutProperty(c, "FullName", name)
	}
	if k.Firma != "" {
		_, _ = oleutil.PutProperty(c, "CompanyName", k.Firma)
	}
	if hasMail {
		_, _ = oleutil.PutProperty(c, "Email1Address", k.Email)
		_, _ = oleutil.PutProperty(c, "Email1DisplayName", strings.TrimSpace(name+" ("+k.Firma+")"))
	}
	if k.Tel != "" {
		_, _ = oleutil.PutProperty(c, "BusinessTelephoneNumber", k.Tel)
	}
	if k.Strasse != "" {
		_, _ = oleutil.PutProperty(c, "BusinessAddressStreet", k.Strasse)
	}
	if k.Ort != "" {
		_, _ = oleutil.PutProperty(c, "BusinessAddressCity", k.Ort)
	}
	_, err = oleutil.CallMethod(c, "Save")
	return err == nil, err
}

// Alle Kundendaten auf einmal ins Outlook dieses PCs übernehmen (vorhandene werden übersprungen)
func (a *app) handleKontaktAlle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	var in struct {
		Liste []olKontakt `json:"liste"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20)).Decode(&in); err != nil || len(in.Liste) > 5000 {
		writeJSON(w, map[string]any{"ok": false, "error": "Ungültige Anfrage."})
		return
	}
	neu, da := 0, 0
	err := olNativAuftrag(olAuftrag{art: "fn", fn: func(app *ole.IDispatch) error {
		items, fertig, err := olKontaktOrdner(app)
		if err != nil {
			return err
		}
		defer fertig()
		for _, k := range in.Liste {
			k = olKontakt{strings.TrimSpace(k.Firma), strings.TrimSpace(k.Name), strings.TrimSpace(k.Email), strings.TrimSpace(k.Tel), strings.TrimSpace(k.Strasse), strings.TrimSpace(k.Ort)}
			ok, err := olKontaktAnlegen(app, items, k)
			if err != nil {
				return err
			}
			if ok {
				neu++
			} else {
				da++
			}
		}
		return nil
	}}, 10*time.Minute)
	if err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": err.Error(), "neu": neu})
		return
	}
	writeJSON(w, map[string]any{"ok": true, "neu": neu, "vorhanden": da})
}
