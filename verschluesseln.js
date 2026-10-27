// Wird beim Bauen auf GitHub ausgeführt: verschlüsselt den Zugriffsschlüssel für die Daten
// mit Benutzer + Passwort. Nur wer beides kennt, kann in der App die Liste öffnen.
const { webcrypto: crypto } = require("crypto");
const fs = require("fs");

(async () => {
  const user = (process.env.APP_USER || "").trim().toLowerCase();
  const pass = process.env.APP_PASSWORD || "";
  const token = process.env.DATA_TOKEN || "";
  if (!user || !pass || !token) {
    console.error("Secrets APP_USER, APP_PASSWORD oder DATA_TOKEN fehlen.");
    process.exit(1);
  }
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey("raw", enc.encode(user + ":" + pass), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 200000, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(token)));
  const b64 = (a) => Buffer.from(a).toString("base64");
  fs.writeFileSync("www/secret.js",
    `window.APP_SECRET = ${JSON.stringify({ salt: b64(salt), iv: b64(iv), data: b64(ct) })};\n`);
  console.log("www/secret.js geschrieben.");
})();
