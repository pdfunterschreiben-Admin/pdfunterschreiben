(function(){
var K='tdocSammlung', MAX_ALTER=4*3600*1000, KOPF='TDOC-ERSATZTEILE';
function lade(){try{var s=JSON.parse(localStorage.getItem(K)||'null');if(s&&Date.now()-s.t<MAX_ALTER)return s;}catch(e){}return{t:Date.now(),rows:[]};}
function speichere(s){s.t=Date.now();try{localStorage.setItem(K,JSON.stringify(s));}catch(e){}}
function hinweis(text,leer){var d=document.getElementById('tdocHinweis');if(d)d.remove();d=document.createElement('div');d.id='tdocHinweis';
d.style.cssText='position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#1c1f26;color:#fff;font:14px Segoe UI,Arial,sans-serif;padding:12px 14px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.3);max-width:360px;line-height:1.4;white-space:pre-line';
d.innerHTML='<div></div><div style="margin-top:8px;text-align:right"></div>';d.firstChild.textContent=text;
if(leer){var b=document.createElement('button');b.textContent='Sammlung leeren';b.style.cssText='font:13px Segoe UI,Arial;padding:4px 10px;border-radius:6px;border:0;background:#c8102e;color:#fff;cursor:pointer;margin-right:6px';
b.onclick=function(){try{localStorage.removeItem(K);}catch(e){}var leerText='TDOC-EINGEFUEGT';try{navigator.clipboard.writeText(leerText);}catch(e){}d.firstChild.textContent='Sammlung geleert.';b.remove();setTimeout(function(){d.remove();},1500);};d.lastChild.appendChild(b);}
var x=document.createElement('button');x.textContent='OK';x.style.cssText='font:13px Segoe UI,Arial;padding:4px 10px;border-radius:6px;border:0;background:#fff;color:#1c1f26;cursor:pointer';x.onclick=function(){d.remove();};d.lastChild.appendChild(x);
document.body.appendChild(d);setTimeout(function(){if(d.parentNode)d.remove();},12000);}
function weiter(ablage){
ablage=String(ablage||'').replace(/\r/g,'');
var geleert=ablage.indexOf('TDOC-EINGEFUEGT')===0;
var s=geleert?{t:Date.now(),rows:[]}:lade();
/* Teile aus der Zwischenablage (aus anderen Fenstern) mit übernehmen */
var zeilen=[];
if(!geleert&&ablage.indexOf(KOPF)===0){ablage.split('\n').slice(1).forEach(function(z){if(z.trim())zeilen.push(z);});}
s.rows.forEach(function(r){if(zeilen.indexOf(r.z)<0)zeilen.push(r.z);});
var rows=[].slice.call(document.querySelectorAll('tr.selectedRow'));
if(!rows.length){hinweis(zeilen.length?('Keine Teile markiert. In der Sammlung: '+zeilen.length+' Teil(e).'):'Keine Ersatzteile markiert. Bitte zuerst die Teile in der Liste anklicken (rot).',zeilen.length>0);return;}
var neu=0;
rows.forEach(function(r){var tab=r.closest('table'),h=tab?[].slice.call(tab.querySelectorAll('th')).map(function(x){return x.innerText.trim().toLowerCase();}):[];
function ix(n,d){for(var k=0;k<h.length;k++){if(h[k].indexOf(n)>=0)return k;}return d;}
var c=[].slice.call(r.querySelectorAll('td')).map(function(d){return d.innerText.replace(/\s+/g,' ').trim();});
var nr=c[ix('nummer',1)]||'',nm=c[ix('name',2)]||'',mg=c[ix('menge',3)]||'1',bm=c[ix('bemerkung',4)]||'';
if(!nr)return;var z=[mg,nr,nm,bm].join('\t');
if(zeilen.indexOf(z)>=0)return;
zeilen.push(z);neu++;});
s.rows=zeilen.map(function(z){return{key:z,z:z};});speichere(s);
var txt=KOPF+'\r\n'+zeilen.join('\r\n');
var msg=(neu?neu+' Ersatzteil(e) hinzugefügt':'Diese Teile sind schon in der Sammlung')+' – zusammen '+zeilen.length+' in der Zwischenablage.\nWeitere Fenster/Baugruppen genauso sammeln, dann in Excel einmal auf „Ersatzteile einfügen“ klicken.';
function alt(){var t=document.createElement('textarea');t.value=txt;document.body.appendChild(t);t.select();try{document.execCommand('copy');hinweis(msg,true);}catch(e){prompt('Bitte mit Strg+C kopieren:',txt);}document.body.removeChild(t);}
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(txt).then(function(){hinweis(msg,true);},alt);}else{alt();}}
try{if(navigator.clipboard&&navigator.clipboard.readText){navigator.clipboard.readText().then(weiter,function(){weiter('');});return;}}catch(e){}
weiter('');
})();
