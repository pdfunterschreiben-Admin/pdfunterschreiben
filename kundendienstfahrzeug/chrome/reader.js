async function readToyotaPart(requested,timeoutMs=45000){
 const compact=s=>String(s||'').replace(/[\s-]/g,'').replace(/^BT/i,'').toUpperCase();
 const normalize=s=>String(s||'').toLowerCase().replace(/[\s\-_/()]/g,'');
 const target=compact(requested);const deadline=Date.now()+timeoutMs;const clicked=new WeakSet();let expansionCount=0;
 function cells(row){return Array.from(row.children).filter(c=>['TD','TH'].includes(c.tagName)||['cell','columnheader'].includes(c.getAttribute('role')));}
 function find(){const names=new Set();for(const row of document.querySelectorAll('tr,[role="row"]')){const cs=cells(row);if(!cs.length)continue;const ni=cs.findIndex(c=>compact(c.innerText)===target);if(ni<0)continue;const table=row.closest('table,[role="table"]');if(!table)continue;const header=Array.from(table.querySelectorAll('tr,[role="row"]')).find(r=>cells(r).some(c=>/^(ersatzteilname|partname|description|beschreibung|bezeichnung)$/.test(normalize(c.innerText))));if(!header)continue;const headers=cells(header).map(c=>normalize(c.innerText));const di=headers.findIndex(h=>/^(ersatzteilname|partname|description|beschreibung|bezeichnung)$/.test(h));const numberColumns=headers.map((h,i)=>/^(ersatzteilnummer|partnumber|originalpartnumber|nein|no|teilenummer)$/.test(h)?i:-1).filter(i=>i>=0);if(!numberColumns.includes(ni))continue;const name=cs[di]?.innerText?.trim();if(name&&name.length<=250&&!/^(ersatzteilname|partname)$/i.test(name))names.add(name);}
 if(names.size===1)return {name:[...names][0]};if(names.size>1)return {error:'T-Doc liefert mehrere Bezeichnungen für diese Nummer: '+[...names].join(' / ')+'. Bitte im Katalog prüfen.'};return null;}
 while(Date.now()<deadline){const found=find();if(found)return found;const text=document.body?.innerText||'';if(/(sign in to your account|bei ihrem konto anmelden|microsoft.*anmelden|retry login|blocked the popup)/i.test(text)&&!document.querySelector('table'))return {error:'Bitte zuerst auf diesem Gerät bei Toyota T-Doc anmelden.'};
 if(expansionCount<30){const candidates=[...document.querySelectorAll('tr.example-element-row,mat-expansion-panel-header[aria-expanded="false"],button[aria-expanded="false"],[role="button"][aria-expanded="false"]')];for(const el of candidates){if(clicked.has(el)||!el.getClientRects().length)continue;clicked.add(el);el.click();expansionCount++;break;}}
 await new Promise(r=>setTimeout(r,700));}
 return {error:'Keine eindeutige Artikelbezeichnung gefunden. Prüfe Anmeldung, Suchergebnis und aufgeklappte Teileliste in T-Doc.'};
}
if(typeof globalThis!=='undefined')globalThis.readToyotaPart=readToyotaPart;

