async function readToyotaPart(requested,timeoutMs=45000){
 const compact=s=>String(s||'').replace(/[\s-]/g,'').replace(/^BT/i,'').replace(/^0+(?=\d)/,'').toUpperCase();
 const normalize=s=>String(s||'').toLowerCase().replace(/[\s\-_/()]/g,'');
 const target=compact(requested);const deadline=Date.now()+timeoutMs;
 // Angeklickte Zeilen merken – auch über mehrere Aufrufe auf derselben Seite (ein zweiter Klick klappt sie wieder zu)
 const st=globalThis.__kdfAufgeklappt||(globalThis.__kdfAufgeklappt={clicked:new WeakSet(),count:0});const clicked=st.clicked;
 function cells(row){return Array.from(row.children).filter(c=>['TD','TH'].includes(c.tagName)||['cell','columnheader'].includes(c.getAttribute('role')));}
 function find(){const names=new Set();for(const row of document.querySelectorAll('tr,[role="row"]')){if(row.hasAttribute('data-kdf-alt'))continue;const cs=cells(row);if(!cs.length)continue;const ni=cs.findIndex(c=>compact(c.innerText)===target);if(ni<0)continue;const table=row.closest('table,[role="table"]');if(!table)continue;const header=Array.from(table.querySelectorAll('tr,[role="row"]')).find(r=>cells(r).some(c=>/^(ersatzteilname|partname|description|beschreibung|bezeichnung)$/.test(normalize(c.innerText))));if(!header)continue;const headers=cells(header).map(c=>normalize(c.innerText));const di=headers.findIndex(h=>/^(ersatzteilname|partname|description|beschreibung|bezeichnung)$/.test(h));const numberColumns=headers.map((h,i)=>/^(ersatzteilnummer|partnumber|originalpartnumber|nein|no|teilenummer)$/.test(h)?i:-1).filter(i=>i>=0);if(!numberColumns.includes(ni))continue;const name=cs[di]?.innerText?.trim();if(name&&name.length<=250&&!/^(ersatzteilname|partname)$/i.test(name))names.add(name);}
 if(names.size===1)return {name:[...names][0],klicks:st.count};if(names.size>1)return {error:'T-Doc liefert mehrere Bezeichnungen für diese Nummer: '+[...names].join(' / ')+'. Bitte im Katalog prüfen.'};return null;}
 while(Date.now()<deadline){const found=find();if(found)return found;const text=document.body?.innerText||'';if(/(sign in to your account|bei ihrem konto anmelden|microsoft.*anmelden|retry login|blocked the popup)/i.test(text)&&!document.querySelector('table'))return {error:'Bitte zuerst auf diesem Gerät bei Toyota T-Doc anmelden.'};
 // Nach dem Aufklappen warten, bis die Teileliste der Zeile da ist (neue Tabelle mit Spalte Ersatzteilname),
 // erst dann – falls die Nummer dort nicht steht – die nächste Zeile; ein zu früher Klick klappt sie wieder zu.
 const koepfe=[...document.querySelectorAll('tr,[role="row"]')].filter(r=>cells(r).some(c=>/^(ersatzteilname|partname|description|beschreibung|bezeichnung)$/.test(normalize(c.innerText)))).length;
 if(st.letzter&&!st.detailSeit&&koepfe>st.koepfe)st.detailSeit=Date.now();
 const bereit=!st.letzter||Date.now()-st.letzter>15000||(st.detailSeit&&Date.now()-st.detailSeit>1500);
 if(st.count<30&&bereit){const candidates=[...document.querySelectorAll('tr.example-element-row,mat-expansion-panel-header[aria-expanded="false"],button[aria-expanded="false"],[role="button"][aria-expanded="false"]')];for(const el of candidates){if(clicked.has(el)||el.hasAttribute('data-kdf-alt')||!el.getClientRects().length)continue;clicked.add(el);st.koepfe=koepfe;st.detailSeit=0;el.click();st.count++;st.letzter=Date.now();break;}}
 await new Promise(r=>setTimeout(r,250));}
 return {error:'Keine eindeutige Artikelbezeichnung gefunden. Prüfe Anmeldung, Suchergebnis und aufgeklappte Teileliste in T-Doc.'};
}
if(typeof globalThis!=='undefined')globalThis.readToyotaPart=readToyotaPart;

