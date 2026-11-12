package de.kundendienstfahrzeug.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.view.Gravity;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.util.Locale;

/**
 * Kundendienstfahrzeug für Android.
 *
 * Zeigt die Handy-Seite (GitHub Pages) und gibt ihr zwei Dinge, die eine Webseite nicht kann:
 *  - Foto mit der Kamera aufnehmen (für die Texterkennung der Teilenummer)
 *  - die Bezeichnung einer Teilenummer in Toyota T-Doc nachschlagen. Dafür gibt es eine zweite,
 *    meist unsichtbare Browser-Ansicht, in der man sich einmal bei Toyota anmeldet; die Anmeldung
 *    bleibt in der App gespeichert. Gelesen wird nur die Bezeichnung aus der sichtbaren Teileliste.
 */
public class MainActivity extends Activity {
    static final String HOST = "pdfunterschreiben-admin.github.io";
    static final String SEITE = "https://" + HOST + "/pdfunterschreiben/kundendienstfahrzeug/?app=android";
    static final String TDOC = "https://tdoc.toyota-forklifts.eu/";

    private WebView seite, toyota;
    private LinearLayout toyotaLeiste;
    private TextView toyotaText;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private String leser = "";
    private String suche = null;      // laufende T-Doc-Abfrage (Nummer ohne Bindestriche, ohne BT)
    private String sucheOriginal = null;
    private long sucheBis = 0;
    private boolean toyotaSichtbar = false;
    private ValueCallback<Uri[]> auswahl;
    private Uri fotoUri;
    private Updater updater;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        try (InputStream in = getAssets().open("reader.js")) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) != -1) b.write(buf, 0, n);
            leser = b.toString("UTF-8");
        } catch (Exception e) {
            leser = "";
        }

        rahmen = new FrameLayout(this);
        seite = browser();
        toyota = browser();
        LinearLayout toyotaBox = new LinearLayout(this);
        toyotaBox.setOrientation(LinearLayout.VERTICAL);
        toyotaLeiste = new LinearLayout(this);
        toyotaLeiste.setOrientation(LinearLayout.HORIZONTAL);
        toyotaLeiste.setBackgroundColor(Color.rgb(29, 63, 184));
        toyotaLeiste.setPadding(dp(12), dp(8), dp(8), dp(8));
        toyotaLeiste.setGravity(Gravity.CENTER_VERTICAL);
        toyotaText = new TextView(this);
        toyotaText.setTextColor(Color.WHITE);
        toyotaText.setTextSize(14);
        toyotaText.setText("Toyota T-Doc");
        Button zurueck = new Button(this);
        zurueck.setText("Zurück");
        zurueck.setOnClickListener(v -> zeigeToyota(false));
        toyotaLeiste.addView(toyotaText, new LinearLayout.LayoutParams(0, -2, 1));
        toyotaLeiste.addView(zurueck, new LinearLayout.LayoutParams(-2, -2));
        toyotaBox.addView(toyotaLeiste, new LinearLayout.LayoutParams(-1, -2));
        toyotaBox.addView(toyota, new LinearLayout.LayoutParams(-1, 0, 1));
        rahmen.addView(toyotaBox, new FrameLayout.LayoutParams(-1, -1));
        rahmen.addView(seite, new FrameLayout.LayoutParams(-1, -1));
        setContentView(rahmen);
        this.toyotaBoxView = toyotaBox;
        zeigeToyota(false);

        seite.addJavascriptInterface(new Bruecke(), "KDF");
        seite.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (unsereSeite(u)) return false;
                // T-Doc-Links in der App öffnen (dort ist man bei Toyota angemeldet), alles andere im Browser
                if (u.toString().startsWith(TDOC)) { toyota.loadUrl(u.toString()); zeigeToyota(true); return true; }
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }
        });
        seite.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (auswahl != null) auswahl.onReceiveValue(null);
                auswahl = cb;
                return fotoWaehlen(p != null && p.isCaptureEnabled());
            }
        });

        // Die Toyota-Anmeldung (Microsoft) öffnet ein Pop-up-Fenster – das wird über der T-Doc-Ansicht gezeigt.
        toyota.getSettings().setSupportMultipleWindows(true);
        toyota.getSettings().setJavaScriptCanOpenWindowsAutomatically(true);
        toyota.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onCreateWindow(WebView v, boolean dialog, boolean user, android.os.Message msg) {
                WebView pop = browser();
                pop.getSettings().setSupportMultipleWindows(false);
                pop.setWebViewClient(new WebViewClient());
                pop.setWebChromeClient(new WebChromeClient() {
                    @Override public void onCloseWindow(WebView w) { popZu(w); }
                });
                rahmen.addView(pop, new FrameLayout.LayoutParams(-1, -1));
                popups.add(pop);
                zeigeToyota(true);
                toyotaText.setText("Bei Toyota anmelden …");
                WebView.WebViewTransport t = (WebView.WebViewTransport) msg.obj;
                t.setWebView(pop);
                msg.sendToTarget();
                return true;
            }
            @Override public void onCloseWindow(WebView w) { }
        });
        toyota.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView v, String url) {
                if (suche == null) return;
                if (url != null && url.startsWith(TDOC)) {
                    lesen();
                } else {
                    toyotaText.setText("Bitte einmal bei Toyota anmelden – danach geht die Suche von selbst weiter.");
                    zeigeToyota(true);
                }
            }
        });

        if (state != null) seite.restoreState(state);
        else seite.loadUrl(SEITE);
        toyota.loadUrl(TDOC);

        updater = new Updater(this);
        updater.pruefen(false);
    }

    private View toyotaBoxView;
    private FrameLayout rahmen;
    private final java.util.ArrayList<WebView> popups = new java.util.ArrayList<>();

    private void popZu(WebView w) {
        popups.remove(w);
        rahmen.removeView(w);
        w.destroy();
        // Nach der Anmeldung: laufende Suche neu starten
        if (suche != null && sucheOriginal != null) { String n = sucheOriginal; suche = null; suchen(n); }
    }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView browser() {
        WebView v = new WebView(this);
        WebSettings s = v.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(v, true);
        return v;
    }

    static boolean unsereSeite(Uri u) {
        return u != null && "https".equals(u.getScheme()) && HOST.equals(u.getHost())
            && u.getPath() != null && u.getPath().startsWith("/pdfunterschreiben/kundendienstfahrzeug");
    }

    private void zeigeToyota(boolean an) {
        toyotaSichtbar = an;
        toyotaBoxView.setVisibility(an ? View.VISIBLE : View.INVISIBLE);
        seite.setVisibility(an ? View.GONE : View.VISIBLE);
    }

    /* ---------------- Kamera ---------------- */

    private boolean fotoWaehlen(boolean nurKamera) {
        try {
            File f = new File(getCacheDir(), "foto.jpg");
            if (f.exists()) f.delete();
            fotoUri = Uri.parse("content://de.kundendienstfahrzeug.app.dateien/foto.jpg");
            Intent kamera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            kamera.putExtra(MediaStore.EXTRA_OUTPUT, fotoUri);
            kamera.setClipData(ClipData.newRawUri("foto", fotoUri));
            kamera.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            Intent bild = new Intent(Intent.ACTION_GET_CONTENT);
            bild.setType("image/*");
            bild.addCategory(Intent.CATEGORY_OPENABLE);
            Intent start;
            if (nurKamera && kamera.resolveActivity(getPackageManager()) != null) {
                start = kamera;
            } else {
                start = Intent.createChooser(bild, "Teilenummer fotografieren oder Bild wählen");
                if (kamera.resolveActivity(getPackageManager()) != null)
                    start.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{kamera});
            }
            startActivityForResult(start, 2);
            return true;
        } catch (Exception e) {
            if (auswahl != null) auswahl.onReceiveValue(null);
            auswahl = null;
            return false;
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != 2 || auswahl == null) return;
        Uri u = null;
        if (res == RESULT_OK) {
            u = data != null && data.getData() != null ? data.getData() : fotoUri;
            if (u == fotoUri && !new File(getCacheDir(), "foto.jpg").exists()) u = null;
        }
        auswahl.onReceiveValue(u != null ? new Uri[]{u} : null);
        auswahl = null;
    }

    /* ---------------- T-Doc ---------------- */

    private void suchen(String nummer) {
        String n = nummer == null ? "" : nummer.trim().toUpperCase(Locale.ROOT).replaceAll("[\\s-]", "");
        if (!n.matches("(BT)?[0-9]{7}|[0-9]{5}[A-Z0-9]{5}[0-9]{2}")) {
            antwort(nummer, null, "Für T-Doc bitte eine Toyota- (12345-ABCDE-12) oder BT-Nummer.");
            return;
        }
        boolean bt = n.matches("(BT)?[0-9]{7}");
        suche = n.replaceFirst("^BT", "");
        sucheOriginal = nummer;
        sucheBis = System.currentTimeMillis() + 70000;
        Uri.Builder u = Uri.parse(TDOC).buildUpon()
            .appendQueryParameter("partNumber", suche)
            .appendQueryParameter("truckType", bt ? "warehouseTrucks" : "counterBalanceTrucks")
            .appendQueryParameter("reset", "false")
            .appendQueryParameter("source", "partsSearch");
        if (bt) u.appendQueryParameter("flag", "Standard,Special");
        toyotaText.setText("T-Doc sucht " + nummer + " …");
        toyota.loadUrl(u.build().toString());
        final String meine = suche;
        handler.postDelayed(() -> {
            if (meine.equals(suche)) {
                String alt = sucheOriginal;
                suche = null;
                antwort(alt, null, "T-Doc hat nicht rechtzeitig geantwortet. Bitte die Toyota-Anmeldung prüfen (oben „T-Doc“).");
            }
        }, 70000);
    }

    private void lesen() {
        if (suche == null || leser.isEmpty()) return;
        final String meine = suche;
        String js = leser + "\nwindow.__kdfErgebnis=null;readToyotaPart(" + JSONObject.quote(meine)
            + ",45000).then(function(r){window.__kdfErgebnis=r;});void(0);";
        toyota.evaluateJavascript(js, null);
        abfragen(meine);
    }

    private void abfragen(final String meine) {
        handler.postDelayed(() -> {
            if (!meine.equals(suche) || System.currentTimeMillis() > sucheBis) return;
            toyota.evaluateJavascript("JSON.stringify(window.__kdfErgebnis||null)", wert -> {
                if (!meine.equals(suche)) return;
                try {
                    Object o = new JSONTokener(wert).nextValue();
                    if (o instanceof String && !"null".equals(o)) {
                        JSONObject r = new JSONObject((String) o);
                        String alt = sucheOriginal;
                        suche = null;
                        if (r.has("error")) {
                            String f = r.getString("error");
                            if (f.contains("anmelden")) { toyotaText.setText(f); zeigeToyota(true); }
                            antwort(alt, null, f);
                        } else {
                            antwort(alt, r.optString("name"), null);
                            if (toyotaSichtbar) zeigeToyota(false);
                        }
                        return;
                    }
                } catch (Exception ignored) { }
                abfragen(meine);
            });
        }, 800);
    }

    private void antwort(String nummer, String name, String fehler) {
        try {
            JSONObject o = new JSONObject();
            o.put("nr", nummer == null ? "" : nummer);
            if (name != null) o.put("name", name);
            if (fehler != null) o.put("error", fehler);
            String js = "window.kdfTdoc&&window.kdfTdoc(" + JSONObject.quote(o.toString()) + ")";
            handler.post(() -> { if (unsereSeite(Uri.parse(String.valueOf(seite.getUrl())))) seite.evaluateJavascript(js, null); });
        } catch (Exception ignored) { }
    }

    /** Schnittstelle für die Handy-Seite (nur auf unserer eigenen Seite benutzbar). */
    final class Bruecke {
        private boolean erlaubt() {
            // getUrl() darf nur im UI-Thread gelesen werden – der zuletzt bekannte Stand reicht hier
            return unsereSeite(Uri.parse(String.valueOf(letzteUrl)));
        }

        @JavascriptInterface
        public String info() {
            try {
                return new JSONObject().put("app", "android")
                    .put("version", getPackageManager().getPackageInfo(getPackageName(), 0).versionName).toString();
            } catch (Exception e) { return "{\"app\":\"android\"}"; }
        }

        @JavascriptInterface
        public void tdoc(String nummer) {
            if (!erlaubt()) return;
            handler.post(() -> suchen(nummer));
        }

        @JavascriptInterface
        public void toyotaZeigen() {
            if (!erlaubt()) return;
            handler.post(() -> { toyotaText.setText("Toyota T-Doc – hier einmal anmelden."); zeigeToyota(true); });
        }

        @JavascriptInterface
        public void updatePruefen() {
            if (!erlaubt()) return;
            handler.post(() -> updater.pruefen(true));
        }
    }

    private volatile String letzteUrl = SEITE;
    private final Runnable urlMerken = new Runnable() {
        @Override public void run() {
            if (seite != null) letzteUrl = String.valueOf(seite.getUrl());
            handler.postDelayed(this, 500);
        }
    };

    @Override
    protected void onResume() {
        super.onResume();
        handler.post(urlMerken);
        if (updater != null) updater.weiter();
    }

    @Override
    protected void onPause() {
        super.onPause();
        handler.removeCallbacks(urlMerken);
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        seite.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (!popups.isEmpty()) { popZu(popups.get(popups.size() - 1)); return; }
        if (toyotaSichtbar) {
            if (toyota.canGoBack() && suche == null) toyota.goBack();
            else zeigeToyota(false);
            return;
        }
        if (seite.canGoBack()) seite.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        seite.destroy();
        toyota.destroy();
        super.onDestroy();
    }

    void hinweis(String titel, String text) {
        new AlertDialog.Builder(this).setTitle(titel).setMessage(text).setPositiveButton("OK", null).show();
    }
}
