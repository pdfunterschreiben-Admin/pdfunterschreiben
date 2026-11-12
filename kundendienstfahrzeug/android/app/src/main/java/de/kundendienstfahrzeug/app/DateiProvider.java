package de.kundendienstfahrzeug.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/** Stellt genau zwei Dateien bereit: das Kamerafoto (schreibbar für die Kamera-App) und das Update. */
public class DateiProvider extends ContentProvider {
    @Override public boolean onCreate() { return true; }

    private File datei(Uri u) throws FileNotFoundException {
        String p = u.getPath();
        if ("/foto.jpg".equals(p)) return new File(getContext().getCacheDir(), "foto.jpg");
        if ("/update.apk".equals(p)) return new File(getContext().getCacheDir(), "update.apk");
        throw new FileNotFoundException();
    }

    @Override public String getType(Uri u) {
        return "/update.apk".equals(u.getPath()) ? "application/vnd.android.package-archive" : "image/jpeg";
    }

    @Override public Cursor query(Uri u, String[] proj, String sel, String[] args, String sort) {
        try {
            File f = datei(u);
            MatrixCursor c = new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
            c.addRow(new Object[]{"/update.apk".equals(u.getPath()) ? "Kundendienstfahrzeug-Update.apk" : "Teilenummer.jpg", f.length()});
            return c;
        } catch (FileNotFoundException e) { return null; }
    }

    @Override public ParcelFileDescriptor openFile(Uri u, String mode) throws FileNotFoundException {
        File f = datei(u);
        if ("/update.apk".equals(u.getPath()) && !"r".equals(mode)) throw new FileNotFoundException();
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.parseMode(mode));
    }

    @Override public Uri insert(Uri u, ContentValues v) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri u, String s, String[] a) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri u, ContentValues v, String s, String[] a) { throw new UnsupportedOperationException(); }
}
