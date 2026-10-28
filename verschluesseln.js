// Wird beim Bauen auf GitHub ausgeführt: legt den Speicher-Zugang (DATA_TOKEN)
// verschlüsselt in die App. Die Listen selbst sind zusätzlich mit dem Passwort
// des jeweiligen Haushalts verschlüsselt.
const { webcrypto: crypto } = require("crypto");
const fs = require("fs");

(async () => {
  const token = process.env.DATA_TOKEN || "";
  if (!token) { console.error("Secret DATA_TOKEN fehlt."); process.exit(1); }
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token)));
  const b64 = (a) => Buffer.from(a).toString("base64");
  const out = process.argv[2] || "www/secret.js";
  fs.writeFileSync(out, `window.APP_SECRET = ${JSON.stringify({ k: b64(raw), iv: b64(iv), data: b64(ct) })};\n`);
  console.log(out + " geschrieben.");
})();
