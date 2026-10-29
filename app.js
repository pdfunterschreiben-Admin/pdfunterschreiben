/* Bestandsaufnahme – Vorratsliste mit Strichcode-Scanner
   Mehrere Haushalte: jeder Haushalt hat eine eigene, mit seinem Passwort
   verschlüsselte Datei haushalte/<id>.json im privaten Daten-Repository. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const VERSION = window.APP_VERSION || "0.0.0";
  $("ver1").textContent = $("ver2").textContent = "Version " + VERSION;

  if (!window.APP_SECRET || !window.APP_SECRET.k || String(window.DATA_REPO || "").includes("KONTO")) {
    document.body.innerHTML = '<div class="wrap center"><h1>Einrichtung fehlt</h1><p class="sub">Diese App wurde ohne Zugang gebaut. Bitte über GitHub (Actions) bauen, siehe ANLEITUNG.md.</p></div>';
    return;
  }
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64dec = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  function b64enc(bytes) {
    bytes = new Uint8Array(bytes);
    let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  const utf8ToB64 = (str) => b64enc(enc.encode(str));
  const b64ToUtf8 = (b) => dec.decode(b64dec(b.replace(/\n/g, "")));
  const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
  const normName = (n) => n.trim().toLowerCase().replace(/\s+/g, " ");

  // ---------- Schlüssel ----------
  let token = null;
  async function appToken() {
    if (token) return token;
    const S = window.APP_SECRET;
    const key = await crypto.subtle.importKey("raw", b64dec(S.k), "AES-GCM", false, ["decrypt"]);
    token = dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64dec(S.iv) }, key, b64dec(S.data)));
    return token;
  }
  async function householdId(name) {
    return hex(await crypto.subtle.digest("SHA-256", enc.encode("bestand:" + normName(name)))).slice(0, 40);
  }
  async function deriveKey(name, pass, salt) {
    const base = await crypto.subtle.importKey("raw", enc.encode(normName(name) + ":" + pass), "PBKDF2", false, ["deriveKey"]);
    const k = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 200000, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    return b64enc(await crypto.subtle.exportKey("raw", k));
  }
  const aesKey = (raw) => crypto.subtle.importKey("raw", b64dec(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
  async function seal(obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(hh.key), enc.encode(JSON.stringify(obj)));
    return { v: 1, salt: hh.salt, iv: b64enc(iv), data: b64enc(ct) };
  }
  async function open(file, rawKey) {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64dec(file.iv) }, await aesKey(rawKey), b64dec(file.data));
    return JSON.parse(dec.decode(pt));
  }

  // ---------- GitHub-Speicher ----------
  const fileUrl = (id) => `https://api.github.com/repos/${DATA_REPO}/contents/haushalte/${id}.json`;
  async function gh(id, method, body) {
    const r = await fetch(fileUrl(id) + (method === "GET" ? "?t=" + Date.now() : ""), {
      method, cache: "no-store",
      headers: { Authorization: "Bearer " + (await appToken()), Accept: "application/vnd.github+json" },
      body: body ? JSON.stringify(body) : undefined
    });
    if (r.status === 401) throw Object.assign(new Error("auth"), { auth: true });
    return r;
  }
  async function readFile(id) {
    const r = await gh(id, "GET");
    if (r.status === 404) return null;
    if (!r.ok) throw new Error("http " + r.status);
    const j = await r.json();
    return { sha: j.sha, file: JSON.parse(b64ToUtf8(j.content)) };
  }

  // ---------- Sitzung (angemeldeter Haushalt) ----------
  let hh = ls.get("gr-hh", null); // { id, name, key, salt }
  const K = () => ({ cache: "gr-cache-" + hh.id, queue: "gr-queue-" + hh.id });
  let data = { items: {} }, queue = [], sha = null;
  let items = [];
  let filter = "all";
  let syncing = false;

  function apply(d, op) {
    const it = d.items[op.id];
    if (op.t === "inc") { if (it) it.qty = Math.max(0, (it.qty || 0) + op.d); }
    else if (op.t === "set") d.items[op.id] = Object.assign({}, it || {}, op.data);
    else if (op.t === "del") delete d.items[op.id];
    else if (op.t === "merge") {
      const a = d.items[op.into], b = d.items[op.from];
      if (a && b && op.into !== op.from) {
        a.qty = (a.qty || 0) + (b.qty || 0);
        const codes = new Set([...(a.codes || []), ...(b.codes || []), b.code].filter(Boolean));
        codes.delete(a.code); a.codes = [...codes];
        if (b.mhd && (!a.mhd || b.mhd < a.mhd)) a.mhd = b.mhd;
        if (!a.brand && b.brand) a.brand = b.brand;
        a.aliases = [...new Set([...(a.aliases || []), ...(b.aliases || []), op.alias].filter(Boolean))];
        delete d.items[op.from];
      }
    }
    return d;
  }
  function showLocal() {
    const view = JSON.parse(JSON.stringify(data));
    queue.forEach((op) => apply(view, op));
    items = Object.entries(view.items).map(([id, v]) => Object.assign({ id }, v));
    if (autoMerge()) return;
    render();
  }
  function setStatus(t) { $("sum").dataset.state = t || ""; render(); }

  async function sync() {
    if (syncing || !hh) return;
    syncing = true;
    const me = hh.id;
    try {
      for (let tries = 0; tries < 5; tries++) {
        const got = await readFile(me);
        if (!hh || hh.id !== me) return;
        const remote = got ? await open(got.file, hh.key) : { items: {} };
        sha = got ? got.sha : null;
        if (!queue.length) { data = remote; break; }
        const merged = queue.reduce((d, op) => apply(d, op), JSON.parse(JSON.stringify(remote)));
        const r = await gh(me, "PUT", {
          message: "Bestand geändert",
          content: utf8ToB64(JSON.stringify(await seal(merged))),
          sha: sha || undefined
        });
        if (r.ok) { data = merged; queue = []; ls.set(K().queue, queue); break; }
        if (r.status !== 409 && r.status !== 422) throw new Error("http " + r.status);
        // Ein anderes Handy hat gleichzeitig gespeichert: neu laden und nochmal
      }
      ls.set(K().cache, data);
      setStatus("");
    } catch (e) {
      if (e.auth) setStatus("zugang");
      else if (e.name === "OperationError") { logout(); $("l-err").textContent = "Passwort des Haushalts wurde geändert. Bitte neu anmelden."; }
      else setStatus(navigator.onLine === false ? "offline" : "fehler");
    } finally {
      syncing = false;
      if (hh) {
        showLocal();
        if (queue.length && navigator.onLine !== false) setTimeout(sync, 4000);
      }
    }
  }
  function change(op) {
    queue.push(op); ls.set(K().queue, queue);
    showLocal(); sync();
  }

  // ---------- Anmelden / Haushalt anlegen ----------
  let mode = "login";
  function setMode(m) {
    mode = m;
    const neu = m === "create";
    $("l-title").textContent = neu ? "Neuen Haushalt anlegen" : "Anmelden";
    $("l-hint").textContent = neu
      ? "Name und Passwort selbst ausdenken. Alle in eurem Haushalt melden sich damit an und sehen dieselbe Liste."
      : "Mit Haushalt und Passwort anmelden.";
    $("l-pass2-wrap").hidden = !neu;
    $("l-pass").autocomplete = neu ? "new-password" : "current-password";
    $("l-btn").textContent = neu ? "Haushalt anlegen" : "Anmelden";
    $("l-switch").textContent = neu ? "Ich habe schon einen Haushalt – anmelden" : "Neuen Haushalt anlegen";
    $("l-err").textContent = "";
  }
  $("l-switch").onclick = () => setMode(mode === "login" ? "create" : "login");

  // Liste aus Version 1.x (vor den Haushalten) für die Übernahme
  function legacyData() {
    const d = ls.get("gr-cache", null);
    if (!d || !d.items) return null;
    ls.get("gr-queue", []).forEach((op) => apply(d, op));
    return Object.keys(d.items).length ? d : null;
  }

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("l-mail").value, pass = $("l-pass").value;
    $("l-err").textContent = "";
    if (normName(name).length < 3) { $("l-err").textContent = "Der Haushaltsname braucht mindestens 3 Zeichen."; return; }
    if (mode === "create") {
      if (pass.length < 6) { $("l-err").textContent = "Das Passwort braucht mindestens 6 Zeichen."; return; }
      if (pass !== $("l-pass2").value) { $("l-err").textContent = "Die beiden Passwörter sind verschieden."; return; }
    }
    $("l-btn").disabled = true;
    $("l-btn").textContent = "Bitte warten …";
    try {
      const id = await householdId(name);
      const got = await readFile(id);
      if (mode === "login") {
        if (!got) throw new Error("Diesen Haushalt gibt es nicht. Name prüfen oder neuen Haushalt anlegen.");
        const key = await deriveKey(name, pass, b64dec(got.file.salt));
        let d;
        try { d = await open(got.file, key); } catch (x) { throw new Error("Passwort stimmt nicht."); }
        begin({ id, name: name.trim(), key, salt: got.file.salt }, d);
      } else {
        if (got) throw new Error("Diesen Haushaltsnamen gibt es schon. Bitte einen anderen wählen.");
        const salt = b64enc(crypto.getRandomValues(new Uint8Array(16)));
        const key = await deriveKey(name, pass, b64dec(salt));
        const session = { id, name: name.trim(), key, salt };
        hh = session;
        const start = legacyData() || { items: {} };
        const r = await gh(id, "PUT", { message: "Haushalt angelegt", content: utf8ToB64(JSON.stringify(await seal(start))) });
        if (!r.ok) { hh = null; throw new Error(r.status === 422 ? "Diesen Haushaltsnamen gibt es schon." : "Anlegen fehlgeschlagen (" + r.status + ")."); }
        if (start.items && Object.keys(start.items).length) { ls.del("gr-cache"); ls.del("gr-queue"); }
        ls.del("gr-token");
        begin(session, start);
      }
      $("l-pass").value = ""; $("l-pass2").value = "";
    } catch (err) {
      $("l-err").textContent = err.auth ? "Die App hat keinen Zugriff mehr auf den Speicher. Bitte neue Version installieren."
        : (err.message && !/^http|Failed to fetch|NetworkError/.test(err.message)) ? err.message
        : "Keine Verbindung. Bitte Internet prüfen.";
    }
    $("l-btn").disabled = false;
    $("l-btn").textContent = mode === "create" ? "Haushalt anlegen" : "Anmelden";
  });

  function begin(session, d) {
    hh = session; ls.set("gr-hh", hh);
    data = d || ls.get(K().cache, { items: {} });
    queue = ls.get(K().queue, []);
    if (d) ls.set(K().cache, d);
    start();
  }
  function logout() {
    hh = null; ls.del("gr-hh");
    data = { items: {} }; queue = []; items = [];
    clearInterval(timer);
    $("login").hidden = false; $("app").hidden = true;
    setMode(legacyData() ? "create" : "login");
  }
  $("logout").onclick = logout;
  let timer = null;
  function start() {
    $("login").hidden = true; $("app").hidden = false;
    $("hh-name").textContent = hh.name;
    showLocal(); sync();
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden) sync(); }, 45000);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && hh) sync(); });
  window.addEventListener("online", () => hh && sync());

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

  // ---------- Ordner / Kategorien ----------
  const CATS = ["Gewürze", "Aufschnitt", "Käse", "Fleisch", "TK-Produkte", "Milchprodukte", "Konserven", "Getränke", "Alkohol", "Backwaren", "Sonstiges"];
  // Reihenfolge wichtig: das Spezifischere zuerst (TK vor Fleisch, Aufschnitt vor Fleisch)
  const TAG_RULES = [
    ["TK-Produkte", /frozen/],
    ["Gewürze", /spice|herb|condiment|seasoning|bouillon|broth|stock-cube|soup-seasoning|seasoning-sauce|salts?$|peppers?$|curry|paprika|gewurz/],
    ["Aufschnitt", /sausage|cold-cut|(:|-)hams?\b|salami|charcuterie|cooked-meat|prepared-meat|cured-meat|wurst|aufschnitt|mortadella|bologna/],
    ["Käse", /chees|kase|fromage/],
    ["Fleisch", /meat|beef|pork|poultry|chicken|turkey|veal|lamb|minced|fleisch/],
    ["Milchprodukte", /dair|milk|yogh?urt|butter|cream|quark|desserts-lactes/],
    ["Alkohol", /alcoholic|spirit|liqueur|liquor|beers?\b|wines?\b|vodka|whisk|(:|-)rums?\b|(:|-)gins?\b|korn|schnaps|brandy|cognac|champagne|sparkling-wine|prosecco|cider|aperitif|bitters/],
    ["Getränke", /beverage|drink|juice|water|soda|coffee|tea/],
    ["Konserven", /canned|preserve|tinned/],
    ["Backwaren", /bread|bakery|baked|toast|roll|cereal/]
  ];
  const NAME_RULES = [
    ["TK-Produkte", /\btk\b|tiefkühl|tiefgekühlt|frozen|iglo|frosta|pizza/i],
    ["Gewürze", /gewürz|ankerkraut|just spices|maggi|würze|brühe|bouillon|fond|knorr|fix für|pfeffer|paprika|curry|oregano|basilikum|thymian|rosmarin|zimt|muskat|kümmel|chili|kräuter|salz|ostmann|fuchs|kotanyi|wiberg|knoblauch(pulver|granulat)/i],
    ["Aufschnitt", /wurst|salami|schinken|aufschnitt|mortadella|lyoner|leberwurst|mettwurst|bierschinken|kassler|cervelat|bacon|speck/i],
    ["Käse", /käse|gouda|emmentaler|edamer|mozzarella|cheddar|camembert|brie|feta|parmesan|leerdammer|tilsiter|bergkäse/i],
    ["Fleisch", /fleisch|hack|schnitzel|steak|filet|hähnchen|huhn|pute|rind|schwein|gulasch|braten|kotelett|nacken/i],
    ["Milchprodukte", /milch|joghurt|jogurt|quark|sahne|butter|schmand|skyr|pudding/i],
    ["Alkohol", /\bkorn\b|doppelkorn|kornbrand|schnaps|wodka|vodka|\brum\b|whisky|whiskey|likör|\bgin\b|sekt|prosecco|champagner|bier|\bpils|pilsner|radler|hefeweizen|weißbier|wein(?!essig|stein|traube|blatt)|cognac|tequila|ouzo|grappa|jägermeister|aperol|amaretto|obstler|klarer|kräuterlikör|\d+([,.]\d+)?\s*%\s*vol/i],
    ["Getränke", /saft|wasser|cola|limo|kaffee|tee\b|schorle/i],
    ["Konserven", /dose|konserve|eintopf|ravioli|mais|bohnen|erbsen|tomaten (gehackt|passiert)/i],
    ["Backwaren", /brot|brötchen|toast|knäcke|zwieback|kuchen|keks/i]
  ];
  function catFromTags(tags) {
    const t = (tags || []).join(" ").toLowerCase();
    for (const [c, re] of TAG_RULES) if (t && re.test(t)) return c;
    return "";
  }
  function catFromName(name) {
    for (const [c, re] of NAME_RULES) if (re.test(name || "")) return c;
    return "";
  }
  const catOf = (it) => CATS.includes(it.cat) ? it.cat : (catFromName(it.name) || "Sonstiges");

  const OPEN_KEY = "gr-open";
  let openCats = ls.get(OPEN_KEY, null);
  function isOpen(c) { return openCats ? openCats.includes(c) : true; }
  function setOpen(c, on) {
    const cur = new Set(openCats || CATS);
    on ? cur.add(c) : cur.delete(c);
    openCats = [...cur]; ls.set(OPEN_KEY, openCats);
  }

  // Auswahlfeld im Formular füllen
  $("f-cat").innerHTML = CATS.map((c) => `<option>${c}</option>`).join("");

  // ---------- Gewürze: Namen ohne Hersteller, Ankerkraut extra ----------
  const SPICE_BRANDS = ["ankerkraut", "kania", "ostmann", "fuchs gewürze", "fuchs", "kotányi", "kotanyi", "wiberg",
    "le gusto", "gut & günstig", "gut&günstig", "ja!", "k-classic", "rewe beste wahl", "beste wahl", "rewe bio", "rewe",
    "edeka bio", "edeka", "spar", "alnatura", "lebensbaum", "sonnentor", "just spices", "schuhbecks", "schuhbeck",
    "altes gewürzamt", "dennree", "rapunzel", "herbaria", "aldi", "lidl", "netto", "penny", "dm bio", "denree",
    "gefro", "kühne", "bad reichenhaller", "knorr", "ubena", "hela", "raps", "spice for life", "steinhaus",
    "kaufland", "k-bio", "k bio", "k classic", "milfina", "nur nur natur", "gut bio", "bio sonne", "aldi süd", "aldi nord",
    "penny ready", "rewe ja!", "ja", "jeden tag", "real quality", "globus", "mühlenhof", "bioland", "demeter", "naturland"]
    .sort((a, b) => b.length - a.length);
  const SIZE_RE = /\(?\s*\b\d+([.,]\d+)?\s*(g|gr|gramm|kg|mg|ml|cl|l|liter|stk|stück|st|x|er)\b\.?\s*\)?/gi;
  const isAnker = (it) => /ankerkraut/i.test((it.name || "") + " " + (it.brand || ""));
  function stripBrand(name, brand) {
    let n = (name || "").trim();
    const list = (brand ? [brand.toLowerCase()] : []).concat(SPICE_BRANDS);
    for (let k = 0; k < 2; k++) {
      const low = n.toLowerCase();
      const b = list.find((x) => x && low.startsWith(x) && /^[\s\-–:,.®™]|^$/.test(n.slice(x.length)));
      if (!b) break;
      n = n.slice(b.length).replace(/^[\s\-–:,.®™]+/, "");
    }
    // Marke am Ende („Pfeffer gemahlen Kaufland“)
    for (let k = 0; k < 2; k++) {
      const low = n.toLowerCase();
      const b = list.find((x) => x && low.endsWith(x) && /[\s\-–,(]$/.test(n.slice(0, n.length - x.length)));
      if (!b) break;
      n = n.slice(0, n.length - b.length).replace(/[\s\-–,(]+$/, "");
    }
    n = n.replace(/\s*[-–]?\s*ankerkraut\b/ig, "").replace(SIZE_RE, " ").replace(/\s{2,}/g, " ").replace(/[\s\-–,]+$/, "").trim();
    return n ? n.charAt(0).toUpperCase() + n.slice(1) : (name || "");
  }
  // Maggi-Würze bleibt „Maggi …“, sonst wäre nur „Würze“ übrig
  const displayName = (it) => {
    const n = it.name || "Unbekanntes Produkt";
    if (catOf(it) !== "Gewürze" || /^maggi/i.test(n)) return n;
    return stripBrand(n, it.brand);
  };
  const byName = (a, b) => displayName(a).localeCompare(displayName(b), "de");
  // Gleiches Gewürz = gleicher Schlüssel (ohne Marke, Größe, Groß/Klein, Satzzeichen)
  // Gleiche Gewürze unter anderem Namen
  const SYNONYMS = {
    "pfeffer weiß": "pfeffer gemahlen", "pfeffer weiss": "pfeffer gemahlen", "weißer pfeffer": "pfeffer gemahlen",
    "weisser pfeffer": "pfeffer gemahlen", "pfeffer weiß gemahlen": "pfeffer gemahlen", "weißer pfeffer gemahlen": "pfeffer gemahlen",
    "pfeffer weiss gemahlen": "pfeffer gemahlen", "pfeffer gemahlen weiß": "pfeffer gemahlen"
  };
  const spiceKey = (it) => {
    if (catOf(it) !== "Gewürze" || /^maggi/i.test(it.name || "")) return null;
    let k = displayName(it).toLowerCase().replace(/[^a-zäöüß0-9]+/g, " ").trim();
    k = SYNONYMS[k] || k;
    return (isAnker(it) ? "anker:" : "g:") + k;
  };
  const matches = (i, k) => k && (spiceKey(i) === k || (i.aliases || []).includes(k));
  const findByCode = (code) => code ? items.find((i) => i.code === code || (i.codes || []).includes(code)) : null;
  const findSame = (probe, exceptId) => {
    const k = spiceKey(probe);
    return k ? items.find((i) => i.id !== exceptId && matches(i, k)) : null;
  };
  let merging = false;
  function autoMerge() {
    if (merging || !hh) return false;
    const seen = new Map(), ops = [];
    for (const it of items) for (const a of it.aliases || []) if (!seen.has(a)) seen.set(a, it.id);
    for (const it of items) {
      const k = spiceKey(it);
      if (!k) continue;
      if (seen.has(k) && seen.get(k) !== it.id) ops.push({ t: "merge", into: seen.get(k), from: it.id, alias: k });
      else seen.set(k, it.id);
    }
    if (!ops.length) return false;
    merging = true;
    queue.push(...ops); ls.set(K().queue, queue);
    merging = false;
    showLocal(); sync();
    return true;
  }

  // ---------- Bestand / Einkaufsliste ----------
  let view = ls.get("gr-view", "stock");
  function setView(v) {
    view = v; ls.set("gr-view", v);
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
    render();
  }
  document.querySelectorAll(".tabs button").forEach((b) => { b.onclick = () => setView(b.dataset.v); });
  const toBuy = () => items.filter((i) => !i.qty);
  async function copyText(txt, btn, label) {
    try { await navigator.clipboard.writeText(txt); btn.textContent = "Kopiert ✓"; }
    catch (e) {
      const ta = document.createElement("textarea"); ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); btn.textContent = "Kopiert ✓"; } catch (x) { btn.textContent = "Kopieren ging nicht"; }
      ta.remove();
    }
    setTimeout(() => { btn.textContent = label; }, 2500);
  }
  // Kompletter Bestand als Text (zum Weitergeben oder für den Support)
  $("stock-copy").onclick = () => {
    const groups = new Map(CATS.map((c) => [c, []]));
    items.forEach((i) => groups.get(catOf(i)).push(i));
    let txt = `Bestand ${hh ? hh.name : ""} (Version ${VERSION}, ${items.length} Einträge)\n`;
    for (const [c, l] of groups) {
      if (!l.length) continue;
      txt += `\n== ${c} ==\n`;
      l.sort(byName).forEach((i) => {
        const codes = [i.code, ...(i.codes || [])].filter(Boolean).join("/");
        txt += `${displayName(i)}${isAnker(i) ? " [Ankerkraut]" : ""} | ${i.qty || 0} Stk | gespeichert: ${i.name || ""}` +
          (i.brand ? ` | Marke: ${i.brand}` : "") + (i.cat ? ` | Ordner: ${i.cat}` : "") + (codes ? ` | EAN ${codes}` : "") +
          (i.mhd ? ` | MHD ${i.mhd}` : "") + "\n";
      });
    }
    copyText(txt, $("stock-copy"), "Bestand als Text kopieren");
  };
  $("shop-copy").onclick = async () => {
    const groups = new Map(CATS.map((c) => [c, []]));
    toBuy().forEach((i) => groups.get(catOf(i)).push(displayName(i) + (isAnker(i) ? " (Ankerkraut)" : "")));
    let txt = "Einkaufsliste" + (hh ? " – " + hh.name : "") + "\n";
    for (const [c, l] of groups) if (l.length) txt += "\n" + c + ":\n" + l.sort((a, b) => a.localeCompare(b, "de")).map((n) => "• " + n).join("\n") + "\n";
    const b = $("shop-copy");
    try { await navigator.clipboard.writeText(txt); b.textContent = "Kopiert ✓"; }
    catch (e) {
      const ta = document.createElement("textarea"); ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); b.textContent = "Kopiert ✓"; } catch (x) { b.textContent = "Kopieren ging nicht"; }
      ta.remove();
    }
    setTimeout(() => { b.textContent = "Liste kopieren"; }, 2000);
  };

  function render() {
    const q = $("q").value.trim().toLowerCase();
    const total = items.reduce((s, i) => s + (i.qty || 0), 0);
    const soon = items.filter((i) => i.qty > 0 && daysLeft(i.mhd) !== null && daysLeft(i.mhd) <= 30).length;
    $("sum").textContent = items.length
      ? `${items.length} ${items.length === 1 ? "Sorte" : "Sorten"} · ${total} Stück` + (soon ? ` · ${soon} läuft bald ab` : "")
      : "";
    const st = $("sum").dataset.state;
    if (st === "offline") $("sum").textContent += " · offline";
    if (st === "fehler") $("sum").textContent += " · nicht synchron";
    if (st === "zugang") $("sum").textContent += " · kein Speicherzugriff";
    const shop = view === "shop";
    const nBuy = toBuy().length;
    $("shop-n").textContent = nBuy; $("shop-n").hidden = !nBuy;
    $("filters").hidden = shop;
    $("shopbar").hidden = !shop;
    $("shop-copy").hidden = !nBuy;
    if (shop) $("sum").textContent = nBuy ? `${nBuy} ${nBuy === 1 ? "Produkt" : "Produkte"} einkaufen` : "Alles da";
    $("empty").hidden = shop ? nBuy > 0 : items.length > 0;
    $("empty").innerHTML = shop ? "Nichts zu kaufen. Sobald ein Produkt auf 0 Stück fällt, steht es hier."
      : "Noch nichts im Bestand. Tippe unten auf <b>Scannen</b>.";

    let shown = items.filter((i) => !q || ((i.name || "") + " " + (i.code || "")).toLowerCase().includes(q));
    if (shop) shown = shown.filter((i) => !i.qty).sort(byName);
    else if (filter === "soon") shown = shown.filter((i) => i.qty > 0 && daysLeft(i.mhd) !== null && daysLeft(i.mhd) <= 30)
      .sort((a, b) => (a.mhd || "").localeCompare(b.mhd || ""));
    else shown.sort(byName);

    const ul = $("list");
    ul.innerHTML = "";
    const groups = new Map(CATS.map((c) => [c, []]));
    for (const it of shown) groups.get(catOf(it)).push(it);
    const forceOpen = shop || !!q || filter !== "all";
    for (const [cat, list] of groups) {
      if (!list.length) continue;
      const det = document.createElement("details");
      det.className = "folder";
      det.open = forceOpen || isOpen(cat);
      const sum = document.createElement("summary");
      const pcs = list.reduce((s, i) => s + (i.qty || 0), 0);
      const warn = list.filter((i) => i.qty > 0 && daysLeft(i.mhd) !== null && daysLeft(i.mhd) <= 30).length;
      sum.innerHTML = '<span class="fname"></span><span class="fcount"></span>';
      sum.querySelector(".fname").textContent = cat;
      sum.querySelector(".fcount").textContent = shop ? `${list.length} zu kaufen` : `${list.length} ${list.length === 1 ? "Sorte" : "Sorten"} · ${pcs} Stk.` + (warn ? ` · ${warn} MHD` : "");
      if (warn && !shop) sum.classList.add("warn");
      det.appendChild(sum);
      det.addEventListener("toggle", () => { if (!forceOpen) setOpen(cat, det.open); });
      const inner = document.createElement("ul");
      det.appendChild(inner);
      ul.appendChild(det);
      const anker = cat === "Gewürze" ? list.filter(isAnker) : [];
      for (const it of list) if (!anker.includes(it)) inner.appendChild(row(it));
      if (anker.length) {
        const sub = document.createElement("details");
        sub.className = "folder subfolder";
        sub.open = forceOpen || isOpen("Gewürze/Ankerkraut");
        const ss = document.createElement("summary");
        const apcs = anker.reduce((s, i) => s + (i.qty || 0), 0);
        ss.innerHTML = '<span class="fname">Ankerkraut</span><span class="fcount"></span>';
        ss.querySelector(".fcount").textContent = shop ? `${anker.length} zu kaufen` : `${anker.length} ${anker.length === 1 ? "Sorte" : "Sorten"} · ${apcs} Stk.`;
        sub.appendChild(ss);
        sub.addEventListener("toggle", () => { if (!forceOpen) setOpen("Gewürze/Ankerkraut", sub.open); });
        const subUl = document.createElement("ul");
        anker.forEach((it) => subUl.appendChild(row(it)));
        sub.appendChild(subUl);
        const wrap = document.createElement("li"); wrap.className = "subwrap"; wrap.appendChild(sub);
        inner.appendChild(wrap);
      }
    }

    function row(it) {
      const li = document.createElement("li");
      if (!it.qty) li.className = "zero";
      li.innerHTML = '<div class="info"><span class="name"></span><span class="meta"></span>' +
        '<span class="mhd" hidden></span><button class="edit" type="button">Bearbeiten</button></div>' +
        '<div class="qty"><button type="button" aria-label="Weniger">−</button><span></span>' +
        '<button type="button" aria-label="Mehr">+</button></div>';
      li.querySelector(".name").textContent = displayName(it);
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
      if (!it.qty && !shop) {
        m.hidden = false; m.className = "mhd buy"; m.textContent = "Auf der Einkaufsliste";
      }
      if (shop) {
        li.className = "buyrow";
        const q2 = li.querySelector(".qty");
        q2.innerHTML = '<button type="button" class="bought">✓ Gekauft</button>';
        q2.querySelector(".bought").onclick = () => change({ t: "inc", id: it.id, d: 1 });
        m.hidden = true;
      }
      return li;
    }
  }

  // ---------- Eintrag-Formular ----------
  let editing = null;
  function openSheet({ item, code = "", name = "", mhd = "", cat = "", msg = "", ok = false }) {
    editing = item || findByCode(code) || null;
    $("f-code").value = editing ? (editing.code || "") : code;
    $("f-name").value = editing ? editing.name : name;
    $("f-mhd").value = mhd || (editing && editing.mhd) || "";
    $("f-cat").value = editing ? catOf(editing) : (cat || "Sonstiges");
    catTouched = false;
    $("f-name").dataset.brand = (editing && editing.brand) || "";
    $("f-qty").value = editing ? (item ? editing.qty : (editing.qty || 0) + 1) : 1;
    $("status").textContent = msg || (editing && !item ? "Schon im Bestand – Stückzahl um 1 erhöht." : "");
    $("status").className = "status" + (ok || (editing && !item) ? " ok" : "");
    $("f-del").hidden = !editing;
    const others = editing ? items.filter((i) => i.id !== editing.id && catOf(i) === catOf(editing)).sort(byName) : [];
    $("f-merge-wrap").hidden = !others.length;
    $("f-merge").innerHTML = '<option value="">– auswählen –</option>' +
      others.map((i) => `<option value="${i.id}"></option>`).join("");
    [...$("f-merge").options].slice(1).forEach((o, n) => { o.textContent = displayName(others[n]) + (isAnker(others[n]) ? " (Ankerkraut)" : "") + ` · ${others[n].qty || 0} Stk.`; });
    $("f-merge-btn").disabled = true;
    resetDel();
    $("sheet").hidden = false;
  }
  let catTouched = false;
  $("f-cat").onchange = () => { catTouched = true; };
  // Beim Tippen des Namens Ordner mitraten, solange man ihn nicht selbst gewählt hat
  $("f-name").addEventListener("input", () => {
    if (editing || catTouched) return;
    const c = catFromName($("f-name").value);
    if (c) $("f-cat").value = c;
  });
  $("f-merge").onchange = () => { $("f-merge-btn").disabled = !$("f-merge").value; };
  $("f-merge-btn").onclick = () => {
    const into = items.find((i) => i.id === $("f-merge").value);
    if (!editing || !into) return;
    const from = editing;
    const alias = spiceKey(from) || ("n:" + displayName(from).toLowerCase());
    $("sheet").hidden = true;
    change({ t: "merge", into: into.id, from: from.id, alias });
    toast(`„${displayName(from)}“ gehört jetzt zu „${displayName(into)}“`);
  };
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
      cat: $("f-cat").value || "Sonstiges",
      brand: $("f-name").dataset.brand || "",
      updated: new Date().toISOString()
    };
    const id = editing ? editing.id : (code || "m" + Date.now());
    $("sheet").hidden = true;
    const same = !editing && findSame(data, null);
    if (same) {
      const codes = [...new Set([...(same.codes || []), code].filter((c) => c && c !== same.code))];
      change({ t: "set", id: same.id, data: { codes, brand: same.brand || data.brand,
        mhd: data.mhd && (!same.mhd || data.mhd < same.mhd) ? data.mhd : (same.mhd || "") } });
      change({ t: "inc", id: same.id, d: data.qty });
      toast(`Zu „${displayName(same)}“ dazugezählt: jetzt ${(same.qty || 0) + data.qty} Stück`,
        () => change({ t: "inc", id: same.id, d: -data.qty }));
      return;
    }
    change({ t: "set", id, data });
  });

  // ---------- Scanner ----------
  let reader = null;
  function stopScan() {
    try { reader && reader.reset(); } catch (e) {}
    $("camera").hidden = true;
  }
  $("cam-close").onclick = stopScan;

  // ---------- Scanner: zuerst Google-Scanner (ML Kit, nativ), sonst Kamera im Browser ----------
  let Native = null;
  try {
    if (window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform())
      Native = Capacitor.registerPlugin("BarcodeScanner");
  } catch (e) { Native = null; }
  let nativeBroken = false;

  function scanToast(msg) {
    $("sum").dataset.state = ""; render();
    $("sum").textContent = msg;
  }
  async function ensureModule() {
    const { available } = await Native.isGoogleBarcodeScannerModuleAvailable();
    if (available) return true;
    scanToast("Scanner wird einmalig eingerichtet …");
    await new Promise(async (resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try {
        const h = await Native.addListener("googleBarcodeScannerModuleInstallProgress", (ev) => {
          if (ev && typeof ev.progress === "number") scanToast(`Scanner wird eingerichtet … ${ev.progress} %`);
          if (ev && (ev.progress >= 100 || ev.state === 4)) { setTimeout(finish, 500); try { h.remove(); } catch (x) {} }
        });
      } catch (x) {}
      try { await Native.installGoogleBarcodeScannerModule(); } catch (x) { finish(); }
      // Sicherheitsnetz: regelmäßig nachsehen
      for (let i = 0; i < 60 && !done; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        try { if ((await Native.isGoogleBarcodeScannerModuleAvailable()).available) finish(); } catch (x) {}
      }
      finish();
    });
    render();
    return (await Native.isGoogleBarcodeScannerModuleAvailable()).available;
  }

  async function nativeScan() {
    if (!(await ensureModule())) throw new Error("module");
    const res = await Native.scan({ formats: ["EAN_13", "EAN_8", "UPC_A", "UPC_E", "CODE_128", "DATA_MATRIX", "QR_CODE"] });
    const bc = res && res.barcodes && res.barcodes[0];
    return bc ? (bc.rawValue || bc.displayValue || "") : "";
  }

  $("scan").onclick = async () => {
    if (Native && !nativeBroken) {
      try {
        const raw = await nativeScan();
        if (raw) { if (navigator.vibrate) navigator.vibrate(80); handleCode(raw); }
        return; // abgebrochen oder erkannt
      } catch (e) {
        const msg = String((e && (e.message || e.code)) || e);
        if (/cancel/i.test(msg)) return;
        nativeBroken = true; // z. B. ohne Google-Play-Dienste: Kamera-Scanner nehmen
        render();
      }
    }
    webScan();
  };

  async function webScan() {
    $("camera").hidden = false;
    $("cam-hint").textContent = "Strichcode in den Rahmen halten";
    const hints = new Map();
    const F = ZXing.BarcodeFormat;
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS,
      [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.DATA_MATRIX, F.QR_CODE]);
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    reader = new ZXing.BrowserMultiFormatReader(hints, 200);
    try {
      await reader.decodeFromConstraints(
        { video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 }, advanced: [{ focusMode: "continuous" }] } },
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
  }

  // Kurze Meldung unten mit „Rückgängig“
  let toastTimer = null;
  function toast(text, undo) {
    const t = $("toast");
    t.querySelector(".t-text").textContent = text;
    const b = t.querySelector(".t-undo");
    b.hidden = !undo;
    b.onclick = () => { if (undo) undo(); t.hidden = true; clearTimeout(toastTimer); };
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
  }

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
    const known = findByCode(code);
    const mhdMsg = mhd ? " MHD aus dem Code gelesen." : "";
    if (known) {
      // Schon im Bestand: direkt +1, ohne Formular
      change({ t: "inc", id: known.id, d: 1 });
      if (mhd && (!known.mhd || mhd < known.mhd)) change({ t: "set", id: known.id, data: { mhd } });
      const now = (known.qty || 0) + 1;
      toast(`${displayName(known)}: jetzt ${now} Stück` + (mhd ? " · MHD übernommen" : ""),
        () => change({ t: "inc", id: known.id, d: -1 }));
      return;
    }
    openSheet({ code, mhd, msg: "Produkt wird gesucht …" });
    const { name, cat, brand } = await lookup(code);
    $("f-name").dataset.brand = brand || "";
    if (!$("sheet").hidden && $("f-code").value === code && !$("f-name").value) {
      $("f-name").value = name;
      const c = cat || catFromName(name);
      if (c && !catTouched) $("f-cat").value = c;
      $("status").textContent = (name ? `Gefunden – Ordner „${$("f-cat").value}“. Bitte prüfen.` : "Nicht gefunden – bitte Namen und Ordner eintragen.") + mhdMsg;
      $("status").className = "status" + (name ? " ok" : "");
    }
  }

  // Produktname aus der freien Datenbank Open Food Facts
  async function lookup(code) {
    const none = { name: "", cat: "" };
    if (!/^\d{8,14}$/.test(code)) return none;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 7000);
      const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name_de,product_name,brands,quantity,categories_tags`, { signal: ctl.signal });
      clearTimeout(t);
      const j = await r.json();
      if (j.status !== 1 || !j.product) return none;
      const p = j.product;
      const brand = (p.brands || "").split(",")[0].trim();
      let n = (p.product_name_de || p.product_name || "").trim();
      if (brand && !n.toLowerCase().includes(brand.toLowerCase())) n = brand + " " + n;
      if (p.quantity) n += " " + p.quantity;
      return { name: n.trim(), cat: catFromTags(p.categories_tags), brand };
    } catch (e) { return none; }
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
  // Start erst, wenn alles oben definiert ist
  if (hh) begin(hh); else logout();
  checkUpdate();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkUpdate(); });
})();
