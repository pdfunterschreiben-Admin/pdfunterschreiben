// Schnellweg: T-Docs eigene Abfrage (getComponentsByPartNumber) mithören. Deren Antwort enthält die
// Bezeichnung direkt (PartDescription) – kein Aufklappen nötig. Die Kopfzeilen (Anmeldung) bleiben nur
// im Speicher dieser Seite und werden für weitere direkte Abfragen derselben Schnittstelle genutzt.
function kdfHaken(){
 if(globalThis.__kdfHaken||typeof XMLHttpRequest==="undefined")return;globalThis.__kdfHaken=true;
 const api=globalThis.__kdfApi||(globalThis.__kdfApi={kopf:{},vorlage:'',typ:'',bez:{}});
 const kurz=s=>String(s||'').replace(/[\s-]/g,'').replace(/^BT/i,'').replace(/^0+(?=\d)/,'').toUpperCase();
 const P=XMLHttpRequest.prototype,oO=P.open,oH=P.setRequestHeader,oS=P.send;
 P.open=function(m,u){this.__kdfU=String(u||'');return oO.apply(this,arguments)};
 P.setRequestHeader=function(k,v){if(/toyota-forklifts\.eu\/servicemarket\//.test(this.__kdfU||'')&&/^(authorization|ocp-apim-subscription-key)$/i.test(k))(this.__kdfK=this.__kdfK||{})[k]=v;return oH.apply(this,arguments)};
 P.send=function(){const u=this.__kdfU||'';const m=u.match(/\/getComponentsByPartNumber\/([^/?]+)\//);
  if(m&&!this.__kdfEigen){const x=this;const typ=new URLSearchParams(location.search).get('truckType')||'';
   x.addEventListener('load',()=>{if(x.status!==200)return;if(x.__kdfK&&x.__kdfK.Authorization){api.kopf=x.__kdfK;api.vorlage=u;api.typ=typ}
    try{const j=JSON.parse(x.responseText);const d=String(j&&j.PartDescription||'').trim();api.bez[kurz(decodeURIComponent(m[1]))]=d||'-'}catch(e){}})}
  return oS.apply(this,arguments)};
}
// Direkte Abfrage mit den mitgehörten Kopfzeilen (nur wenn schon eine T-Doc-Suche desselben Fahrzeugtyps lief)
function kdfDirekt(nr){
 const api=globalThis.__kdfApi;if(typeof XMLHttpRequest==="undefined")return Promise.resolve(null);const typ=new URLSearchParams(location.search).get('truckType')||'';
 if(!api||!api.vorlage||!api.kopf.Authorization||api.typ!==typ)return Promise.resolve(null);
 const u=api.vorlage.replace(/(\/getComponentsByPartNumber\/)[^/?]+/,'$1'+encodeURIComponent(nr));
 return new Promise(res=>{const x=new XMLHttpRequest();x.__kdfEigen=true;x.open('GET',u);for(const k in api.kopf)x.setRequestHeader(k,api.kopf[k]);x.setRequestHeader('Accept','application/json, text/plain, */*');x.timeout=8000;
  x.onload=()=>{if(x.status===401||x.status===403){api.kopf={};api.vorlage='';return res(null)}if(x.status!==200)return res(null);try{const j=JSON.parse(x.responseText);res(String(j&&j.PartDescription||'').trim()||'-')}catch(e){res(null)}};
  x.onerror=x.ontimeout=()=>res(null);x.send()});
}
kdfHaken();
async function readToyotaPart(requested,timeoutMs=45000){
 const compact=s=>String(s||'').replace(/[\s-]/g,'').replace(/^BT/i,'').replace(/^0+(?=\d)/,'').toUpperCase();
 const normalize=s=>String(s||'').toLowerCase().replace(/[\s\-_/()]/g,'');
 const target=compact(requested);const deadline=Date.now()+timeoutMs;
 // Angeklickte Zeilen merken – auch über mehrere Aufrufe auf derselben Seite (ein zweiter Klick klappt sie wieder zu)
 const st=globalThis.__kdfAufgeklappt||(globalThis.__kdfAufgeklappt={clicked:new WeakSet(),count:0});const clicked=st.clicked;
 function cells(row){return Array.from(row.children).filter(c=>['TD','TH'].includes(c.tagName)||['cell','columnheader'].includes(c.getAttribute('role')));}
 function find(){const names=new Set();for(const row of document.querySelectorAll('tr,[role="row"]')){if(row.hasAttribute('data-kdf-alt'))continue;const cs=cells(row);if(!cs.length)continue;const ni=cs.findIndex(c=>compact(c.innerText)===target);if(ni<0)continue;const table=row.closest('table,[role="table"]');if(!table)continue;const header=Array.from(table.querySelectorAll('tr,[role="row"]')).find(r=>cells(r).some(c=>/^(ersatzteilname|partname|description|beschreibung|bezeichnung)$/.test(normalize(c.innerText))));if(!header)continue;const headers=cells(header).map(c=>normalize(c.innerText));const di=headers.findIndex(h=>/^(ersatzteilname|partname|description|beschreibung|bezeichnung)$/.test(h));const numberColumns=headers.map((h,i)=>/^(ersatzteilnummer|partnumber|originalpartnumber|nein|no|teilenummer)$/.test(h)?i:-1).filter(i=>i>=0);if(!numberColumns.includes(ni))continue;const name=cs[di]?.innerText?.trim();if(name&&name.length<=250&&!/^(ersatzteilname|partname)$/i.test(name))names.add(name);}
 if(names.size===1)return {name:[...names][0],klicks:st.count};if(names.size>1)return {error:'T-Doc liefert mehrere Bezeichnungen für diese Nummer: '+[...names].join(' / ')+'. Bitte im Katalog prüfen.'};return null;}
 kdfHaken();const api=globalThis.__kdfApi||(globalThis.__kdfApi={kopf:{},vorlage:"",typ:"",bez:{}});
 // Direkt fragen (läuft parallel zur normalen Suche auf der Seite)
 const qNr=(()=>{const q=new URLSearchParams(location.search).get('partNumber');return q&&compact(q)===target?q:String(requested||'').replace(/^BT/i,'').replace(/[\s]/g,'')})();
 if(!globalThis.__kdfDirekt||globalThis.__kdfDirekt.t!==target){globalThis.__kdfDirekt={t:target};kdfDirekt(qNr).then(d=>{if(d)api.bez[target]=d})}
 while(Date.now()<deadline){const b=api.bez[target];if(b&&b!=='-')return {name:b,klicks:0,schnell:true};
 const found=find();if(found)return found;const text=document.body?.innerText||'';if(/(sign in to your account|bei ihrem konto anmelden|microsoft.*anmelden|retry login|blocked the popup)/i.test(text)&&!document.querySelector('table'))return {error:'Bitte zuerst auf diesem Gerät bei Toyota T-Doc anmelden.'};
 // Nach dem Aufklappen warten, bis die Teileliste der Zeile da ist (neue Tabelle mit Spalte Ersatzteilname),
 // erst dann – falls die Nummer dort nicht steht – die nächste Zeile; ein zu früher Klick klappt sie wieder zu.
 const koepfe=[...document.querySelectorAll('tr,[role="row"]')].filter(r=>cells(r).some(c=>/^(ersatzteilname|partname|description|beschreibung|bezeichnung)$/.test(normalize(c.innerText)))).length;
 if(st.letzter&&!st.detailSeit&&koepfe>st.koepfe)st.detailSeit=Date.now();
 const bereit=!st.letzter||Date.now()-st.letzter>15000||(st.detailSeit&&Date.now()-st.detailSeit>700);
 if(st.count<30&&bereit){const candidates=[...document.querySelectorAll('tr.example-element-row,mat-expansion-panel-header[aria-expanded="false"],button[aria-expanded="false"],[role="button"][aria-expanded="false"]')];for(const el of candidates){if(clicked.has(el)||el.hasAttribute('data-kdf-alt')||!el.getClientRects().length)continue;clicked.add(el);st.koepfe=koepfe;st.detailSeit=0;el.click();st.count++;st.letzter=Date.now();(st.zeiten=st.zeiten||[]).push(st.letzter);break;}}
 await new Promise(r=>setTimeout(r,100));}
 return {error:'Keine eindeutige Artikelbezeichnung gefunden. Prüfe Anmeldung, Suchergebnis und aufgeklappte Teileliste in T-Doc.'};
}
if(typeof globalThis!=='undefined')globalThis.readToyotaPart=readToyotaPart;

