/* Gewürzregal – Vorratsliste mit Strichcode-Scanner
   Daten: Firebase Firestore, Sammlung "vorrat" (für alle mit dem gemeinsamen Zugang gleich) */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const VERSION = window.APP_VERSION || "0.0.0";
  $("ver1").textContent = $("ver2").textContent = "Version " + VERSION;

  // ---------- Speicher: Datei vorrat.json im privaten GitHub-Repository ----------
  if (!window.APP_SECRET || String(window.DATA_REPO || "").includes("KONTO")) {
    document.body.innerHTML = '<div class="wrap center"><h1>Einrichtung fehlt</h1><p class="sub">Diese App wurde ohne Zugang gebaut. Bitte über GitHub (Actions) bauen, siehe ANLEITUNG.md.</p></div>';
    return;
  }
  const LS = { token: "gr-token", cache: "gr-cache", queue: "gr-queue" };
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  const API = `https://api.github.com/repos/${DATA_REPO}/contents/vorrat.json`;
  let token = ls.get(LS.token, null);
  let data = ls.get(LS.cache, { items: {} });
  let sha = null;
  let queue = ls.get(LS.queue, []);
  let items = [];
  let filter = "all";
  let syncing = false;

  const b64dec = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  function utf8ToB64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  const b64ToUtf8 = (b) => new TextDecoder().decode(b64dec(b.replace(/\n/g, "")));

  async function unlock(user, pass) {
    const S = window.APP_SECRET, enc = new TextEncoder();
    const base = await crypto.subtle.importKey("raw", enc.encode(user.trim().toLowerCase() + ":" + pass), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: b64dec(S.salt), iterations: 200000, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64dec(S.iv) }, key, b64dec(S.data));
    return new TextDecoder().decode(pt);
  }

  function gh(method, body) {
    return fetch(API + (method === "GET" ? "?t=" + Date.now() : ""), {
      method, cache: "no-store",
      headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" },
      body: body ? JSON.stringify(body) : undefined
    });
  }
  async function pull() {
    const r = await gh("GET");
    if (r.status === 404) { sha = null; return { items: {} }; }
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error("auth"), { auth: true });
    if (!r.ok) throw new Error("http " + r.status);
    const j = await r.json();
    sha = j.sha;
    return JSON.parse(b64ToUtf8(j.content) || '{"items":{}}');
  }
  function apply(d, op) {
    const it = d.items[op.id];
    if (op.t === "inc") { if (it) it.qty = Math.max(0, (it.qty || 0) + op.d); }
    else if (op.t === "set") d.items[op.id] = Object.assign({}, it || {}, op.data);
    else if (op.t === "del") delete d.items[op.id];
    return d;
  }
  function showLocal() {
    let view = JSON.parse(JSON.stringify(data));
    queue.forEach((op) => apply(view, op));
    items = Object.entries(view.items).map(([id, v]) => Object.assign({ id }, v));
    render();
  }
  function setStatus(t) { $("sum").dataset.state = t || ""; render(); }

  async function sync() {
    if (syncing || !token) return;
    syncing = true;
    try {
      for (let tries = 0; tries < 5; tries++) {
        const remote = await pull();
        if (!queue.length) { data = remote; break; }
        const merged = queue.reduce((d, op) => apply(d, op), JSON.parse(JSON.stringify(remote)));
        const r = await gh("PUT", {
          message: "Liste geändert",
          content: utf8ToB64(JSON.stringify(merged, null, 1)),
          sha: sha || undefined
        });
        if (r.ok) { data = merged; queue = []; ls.set(LS.queue, queue); break; }
        if (r.status !== 409 && r.status !== 422) throw new Error("http " + r.status);
        // Jemand anderes hat gleichzeitig gespeichert: neu laden und nochmal
      }
      ls.set(LS.cache, data);
      setStatus("");
    } catch (e) {
      if (e.auth) { logout(); $("l-err").textContent = "Zugang ist nicht mehr gültig. Bitte neue App-Version installieren."; }
      else setStatus(navigator.onLine === false ? "offline" : "fehler");
    } finally {
      syncing = false;
      showLocal();
      if (queue.length && navigator.onLine !== false) setTimeout(sync, 4000);
    }
  }
  function change(op) {
    queue.push(op); ls.set(LS.queue, queue);
    showLocal(); sync();
  }

  // ---------- Login ----------
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("l-err").textContent = "";
    $("l-btn").disabled = true;
    try {
      token = await unlock($("l-mail").value, $("l-pass").value);
      ls.set(LS.token, token);
      $("l-pass").value = "";
      start();
    } catch (err) {
      token = null;
      $("l-err").textContent = "Benutzer oder Passwort stimmt nicht.";
    }
    $("l-btn").disabled = false;
  });
  function logout() {
    token = null; ls.del(LS.token);
    $("login").hidden = false; $("app").hidden = true;
  }
  $("logout").onclick = logout;
  let timer = null;
  function start() {
    $("login").hidden = true; $("app").hidden = false;
    showLocal(); sync();
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden) sync(); }, 20000);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && token) sync(); });
  window.addEventListener("online", () => token && sync());
  if (token) start(); else logout();

  // ---------- MHD-Hilfen ----------
  const DAY = 86400000;
  function daysLeft(mhd) {
    if (!mhd) return null;
    const d = new Date(mhd + "T00:00:00");
    const t = new Date(); t.setHours(0, 0, 0, 0);
    return Math.round((d - t) / DAY);
  }
  function fmt(mhd) {
    const [y, m, d] = mhd.split("-");
    return d + "." + m + "." + y;
  }

  // ---------- Liste ----------
  document.querySelectorAll("#filters button").forEach((b) => {
    b.onclick = () => {
      filter = b.dataset.f;
      document.querySelectorAll("#filters button").forEach((x) => x.classList.toggle("on", x === b));
      render();
    };
  });
  $("q").oninput = render;

  function render() {
    const q = $("q").value.trim().toLowerCase();
    const total = items.reduce((s, i) => s + (i.qty || 0), 0);
    const soon = items.filter((i) => i.qty > 0 && daysLeft(i.mhd) !== null && daysLeft(i.mhd) <= 30).length;
    $("sum").textContent = items.length
      ? `${items.length} Sorten · ${total} Stück` + (soon ? ` · ${soon} läuft bald ab` : "")
      : "";
    const st = $("sum").dataset.state;
    if (st === "offline") $("sum").textContent += " · offline";
    if (st === "fehler") $("sum").textContent += " · nicht synchron";
    $("empty").hidden = items.length > 0;

    let shown = items.filter((i) => !q || ((i.name || "") + " " + (i.code || "")).toLowerCase().includes(q));
    if (filter === "soon") shown = shown.filter((i) => i.qty > 0 && daysLeft(i.mhd) !== null && daysLeft(i.mhd) <= 30)
      .sort((a, b) => (a.mhd || "").localeCompare(b.mhd || ""));
    else if (filter === "zero") shown = shown.filter((i) => !i.qty);
    else shown.sort((a, b) => (a.name || "").localeCompare(b.name || "", "de"));

    const ul = $("list");
    ul.innerHTML = "";
    for (const it of shown) {
      const li = document.createElement("li");
      if (!it.qty) li.className = "zero";
      li.innerHTML = '<div class="info"><span class="name"></span><span class="meta"></span>' +
        '<span class="mhd" hidden></span><button class="edit" type="button">Bearbeiten</button></div>' +
        '<div class="qty"><button type="button" aria-label="Weniger">−</button><span></span>' +
        '<button type="button" aria-label="Mehr">+</button></div>';
      li.querySelector(".name").textContent = it.name || "Unbekanntes Produkt";
      li.querySelector(".meta").textContent = it.code ? "EAN " + it.code : "ohne Strichcode";
      const m = li.querySelector(".mhd");
      const dl = daysLeft(it.mhd);
      if (dl !== null) {
        m.hidden = false;
        m.textContent = dl < 0 ? "MHD abgelaufen " + fmt(it.mhd) : "MHD " + fmt(it.mhd) + (dl <= 30 ? ` (noch ${dl} T.)` : "");
        if (dl < 0) m.classList.add("over"); else if (dl <= 30) m.classList.add("soon");
      }
      li.querySelector(".qty span").textContent = it.qty || 0;
      const [minus, plus] = li.querySelectorAll(".qty button");
      minus.onclick = () => { if (it.qty > 0) change({ t: "inc", id: it.id, d: -1 }); };
      plus.onclick = () => change({ t: "inc", id: it.id, d: 1 });
      li.querySelector(".edit").onclick = () => openSheet({ item: it });
      ul.appendChild(li);
    }
  }

  // ---------- Eintrag-Formular ----------
  let editing = null;
  function openSheet({ item, code = "", name = "", mhd = "", msg = "", ok = false }) {
    editing = item || (code && items.find((i) => i.code === code)) || null;
    $("f-code").value = editing ? (editing.code || "") : code;
    $("f-name").value = editing ? editing.name : name;
    $("f-mhd").value = mhd || (editing && editing.mhd) || "";
    $("f-qty").value = editing ? (item ? editing.qty : (editing.qty || 0) + 1) : 1;
    $("status").textContent = msg || (editing && !item ? "Schon im Regal – Stückzahl um 1 erhöht." : "");
    $("status").className = "status" + (ok || (editing && !item) ? " ok" : "");
    $("f-del").hidden = !editing;
    resetDel();
    $("sheet").hidden = false;
  }
  let delTimer = null;
  function resetDel() {
    clearTimeout(delTimer);
    $("f-del").dataset.armed = "";
    $("f-del").textContent = "Aus der Liste löschen";
    $("f-del").classList.remove("armed");
  }
  $("f-del").onclick = () => {
    if (!editing) return;
    if (!$("f-del").dataset.armed) {
      $("f-del").dataset.armed = "1";
      $("f-del").textContent = "Wirklich löschen? Nochmal tippen";
      $("f-del").classList.add("armed");
      delTimer = setTimeout(resetDel, 4000);
      return;
    }
    const id = editing.id;
    resetDel();
    $("sheet").hidden = true;
    change({ t: "del", id });
  };
  $("f-minus").onclick = () => { $("f-qty").value = Math.max(0, (+$("f-qty").value || 0) - 1); };
  $("f-plus").onclick = () => { $("f-qty").value = (+$("f-qty").value || 0) + 1; };
  $("f-cancel").onclick = () => { $("sheet").hidden = true; };
  $("manual").onclick = () => openSheet({ msg: "Name und Stückzahl eintragen. Strichcode ist optional." });

  $("sheet-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = $("f-code").value.replace(/\D/g, "");
    const data = {
      code,
      name: $("f-name").value.trim() || "Unbekanntes Produkt",
      qty: Math.max(0, parseInt($("f-qty").value, 10) || 0),
      mhd: $("f-mhd").value || "",
      updated: new Date().toISOString()
    };
    const id = editing ? editing.id : (code || "m" + Date.now());
    $("sheet").hidden = true;
    change({ t: "set", id, data });
  });

  // ---------- Scanner ----------
  let reader = null;
  function stopScan() {
    try { reader && reader.reset(); } catch (e) {}
    $("camera").hidden = true;
  }
  $("cam-close").onclick = stopScan;

  $("scan").onclick = async () => {
    $("camera").hidden = false;
    $("cam-hint").textContent = "Strichcode in den Rahmen halten";
    const hints = new Map();
    const F = ZXing.BarcodeFormat;
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS,
      [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.DATA_MATRIX, F.QR_CODE]);
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    reader = new ZXing.BrowserMultiFormatReader(hints, 300);
    try {
      await reader.decodeFromConstraints(
        { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } } },
        $("video"),
        (result) => {
          if (!result) return;
          if (navigator.vibrate) navigator.vibrate(80);
          stopScan();
          handleCode(result.getText());
        });
    } catch (err) {
      $("cam-hint").textContent = "Kamera nicht verfügbar. Bitte in den Android-Einstellungen der App die Kamera erlauben.";
    }
  };

  // GS1-Codes (DataMatrix, QR, GS1-128, Digital Link) können GTIN (01) und MHD (17 / 15) enthalten.
  function parseGS1(raw) {
    let s = raw.replace(/^\](d2|Q3|C1|e0)/, "");
    const out = {};
    const link = s.match(/\/01\/(\d{14})/);
    if (link) {
      out.gtin = link[1];
      const m = s.match(/\/(17|15)\/(\d{6})/) || s.match(/[?&](17|15)=(\d{6})/);
      if (m) out.date = m[2];
      return out;
    }
    if (!/^(\x1d)?01\d{14}/.test(s)) return null;
    s = s.replace(/^\x1d/, "");
    const fixed = { "00": 18, "01": 14, "02": 14, "11": 6, "12": 6, "13": 6, "15": 6, "16": 6, "17": 6, "20": 2 };
    while (s.length >= 2) {
      const ai = s.slice(0, 2);
      if (fixed[ai] !== undefined) {
        const v = s.slice(2, 2 + fixed[ai]);
        if (ai === "01") out.gtin = v;
        if (ai === "17" || (ai === "15" && !out.date)) out.date = v;
        s = s.slice(2 + fixed[ai]).replace(/^\x1d/, "");
      } else {
        const g = s.indexOf("\x1d");
        if (g < 0) break;
        s = s.slice(g + 1);
      }
    }
    return out;
  }
  function gs1Date(yymmdd) {
    let y = 2000 + +yymmdd.slice(0, 2), m = +yymmdd.slice(2, 4), d = +yymmdd.slice(4, 6);
    if (d === 0) d = new Date(y, m, 0).getDate(); // "00" = Monatsende
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  async function handleCode(raw) {
    let code = raw.trim(), mhd = "";
    const g = parseGS1(code);
    if (g && g.gtin) {
      code = g.gtin.replace(/^0/, "");
      if (g.date) mhd = gs1Date(g.date);
    }
    code = code.replace(/\D/g, "") || code;
    const known = items.find((i) => i.code === code);
    const mhdMsg = mhd ? " MHD aus dem Code gelesen." : "";
    if (known) {
      openSheet({ code, mhd, msg: "Schon im Regal – Stückzahl um 1 erhöht." + mhdMsg, ok: true });
      return;
    }
    openSheet({ code, mhd, msg: "Produkt wird gesucht …" });
    const name = await lookup(code);
    if (!$("sheet").hidden && $("f-code").value === code && !$("f-name").value) {
      $("f-name").value = name;
      $("status").textContent = (name ? "Gefunden – bitte prüfen." : "Nicht gefunden – bitte Namen eintragen.") + mhdMsg;
      $("status").className = "status" + (name ? " ok" : "");
    }
  }

  // Produktname aus der freien Datenbank Open Food Facts
  async function lookup(code) {
    if (!/^\d{8,14}$/.test(code)) return "";
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 7000);
      const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name_de,product_name,brands,quantity`, { signal: ctl.signal });
      clearTimeout(t);
      const j = await r.json();
      if (j.status !== 1 || !j.product) return "";
      const p = j.product;
      const brand = (p.brands || "").split(",")[0].trim();
      let n = (p.product_name_de || p.product_name || "").trim();
      if (brand && !n.toLowerCase().includes(brand.toLowerCase())) n = brand + " " + n;
      if (p.quantity) n += " " + p.quantity;
      return n.trim();
    } catch (e) { return ""; }
  }

  // ---------- Update-Funktion ----------
  function newer(a, b) {
    const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
    return false;
  }
  async function checkUpdate() {
    if (!window.GITHUB_REPO || GITHUB_REPO.includes("BENUTZERNAME")) return;
    try {
      const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, { cache: "no-store" });
      if (!r.ok) return;
      const rel = await r.json();
      const latest = String(rel.tag_name || "").replace(/^v/, "");
      const apk = (rel.assets || []).find((a) => /\.apk$/i.test(a.name));
      if (!apk || !newer(latest, VERSION)) return;
      $("update-text").textContent = `Neue Version ${latest} verfügbar`;
      $("update").hidden = false;
      $("update-btn").onclick = () => { window.location.href = apk.browser_download_url; };
    } catch (e) {}
  }
  checkUpdate();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkUpdate(); });
})();
