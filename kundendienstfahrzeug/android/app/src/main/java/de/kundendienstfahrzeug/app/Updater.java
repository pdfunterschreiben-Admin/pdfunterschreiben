package de.kundendienstfahrzeug.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;

/**
 * Updates über GitHub: Release „kundendienstfahrzeug-android“ mit version.json
 * ({version, code, url, sha256}). Geprüft werden Prüfsumme, Paketname, höhere Versionsnummer;
 * die Signatur prüft Android beim Installieren selbst.
 */
final class Updater {
    private final Activity a;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private File datei;
    private boolean wartetAufErlaubnis;

    Updater(Activity a) { this.a = a; }

    private String repo() { return BuildConfig.REPO.isEmpty() ? "pdfunterschreiben-Admin/pdfunterschreiben" : BuildConfig.REPO; }

    private static byte[] laden(String url, int max) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(60000);
        c.setInstanceFollowRedirects(true);
        if (c.getResponseCode() != 200) throw new Exception("GitHub antwortet mit " + c.getResponseCode());
        try (InputStream in = c.getInputStream()) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) != -1) { b.write(buf, 0, n); if (b.size() > max) throw new Exception("Datei zu groß"); }
            return b.toByteArray();
        }
    }

    void pruefen(boolean vonHand) {
        new Thread(() -> {
            try {
                JSONObject v = new JSONObject(new String(laden("https://github.com/" + repo()
                    + "/releases/download/kundendienstfahrzeug-android/version.json", 1 << 16), "UTF-8"));
                int code = v.getInt("code");
                PackageInfo ich = a.getPackageManager().getPackageInfo(a.getPackageName(), 0);
                if (code <= ich.versionCode) {
                    if (vonHand) ui.post(() -> Toast.makeText(a, "Du hast die neueste Version (" + ich.versionName + ").", Toast.LENGTH_LONG).show());
                    return;
                }
                ui.post(() -> new AlertDialog.Builder(a).setTitle("Neue Version " + v.optString("version"))
                    .setMessage("Eine neue Version vom Kundendienstfahrzeug ist da. Jetzt laden und installieren? Dein Bestand bleibt erhalten.")
                    .setPositiveButton("Aktualisieren", (d, w) -> herunterladen(v))
                    .setNegativeButton("Später", null).show());
            } catch (Exception e) {
                if (vonHand) ui.post(() -> Toast.makeText(a, "Keine Verbindung zum Update-Server.", Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    private void herunterladen(JSONObject v) {
        Toast.makeText(a, "Update wird geladen …", Toast.LENGTH_LONG).show();
        new Thread(() -> {
            try {
                String url = v.getString("url");
                if (!url.startsWith("https://github.com/" + repo() + "/releases/download/kundendienstfahrzeug-android/"))
                    throw new Exception("Ungültige Update-Adresse.");
                byte[] b = laden(url, 50 << 20);
                byte[] h = MessageDigest.getInstance("SHA-256").digest(b);
                StringBuilder hex = new StringBuilder();
                for (byte x : h) hex.append(String.format(Locale.ROOT, "%02x", x & 255));
                if (!hex.toString().equalsIgnoreCase(v.optString("sha256"))) throw new Exception("Die Datei ist beschädigt. Bitte später nochmal versuchen.");
                File f = new File(a.getCacheDir(), "update.apk");
                try (FileOutputStream out = new FileOutputStream(f)) { out.write(b); }
                PackageManager pm = a.getPackageManager();
                PackageInfo neu = pm.getPackageArchiveInfo(f.getPath(), 0);
                PackageInfo ich = pm.getPackageInfo(a.getPackageName(), 0);
                if (neu == null || !ich.packageName.equals(neu.packageName) || neu.versionCode <= ich.versionCode)
                    throw new Exception("Die Datei ist kein neueres Update.");
                datei = f;
                ui.post(this::installieren);
            } catch (Exception e) {
                ui.post(() -> Toast.makeText(a, "Update fehlgeschlagen: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    private void installieren() {
        if (!a.getPackageManager().canRequestPackageInstalls()) {
            wartetAufErlaubnis = true;
            Toast.makeText(a, "Bitte erlauben, dass das Kundendienstfahrzeug Updates installieren darf – dann zurück in die App.", Toast.LENGTH_LONG).show();
            a.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + a.getPackageName())));
            return;
        }
        if (datei == null || !datei.exists()) return;
        try {
            Uri u = Uri.parse("content://de.kundendienstfahrzeug.app.dateien/update.apk");
            Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(u, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            i.setClipData(ClipData.newRawUri("Update", u));
            a.startActivity(i);
        } catch (Exception e) {
            Toast.makeText(a, "Android konnte die Installation nicht öffnen.", Toast.LENGTH_LONG).show();
        }
    }

    void weiter() {
        if (!wartetAufErlaubnis) return;
        wartetAufErlaubnis = false;
        if (a.getPackageManager().canRequestPackageInstalls()) installieren();
    }
}
