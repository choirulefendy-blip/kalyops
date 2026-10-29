package id.kaly.ops;

import android.content.Context;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Jembatan JavaScript ↔ Android, tersedia di halaman Kaly Ops sebagai window.KalyAndroid.
 * 1.2: notify / notifyPermission / requestNotify untuk notifikasi Android.
 * Hanya dipasang untuk halaman dari alamat Kaly Ops (lihat MainActivity.isOwnPage).
 * Hasil pekerjaan latar dikirim balik lewat window.KalyNative._done(id, galat|null).
 */
public final class Bridge {
    private final MainActivity act;
    private final WebView web;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);

    Bridge(MainActivity act, WebView web) { this.act = act; this.web = web; }

    @JavascriptInterface
    public String info() {
        JSONObject o = new JSONObject();
        try {
            o.put("app", BuildInfo.VERSION_NAME);
            o.put("code", BuildInfo.VERSION_CODE);
            o.put("android", Build.VERSION.SDK_INT);
            o.put("model", Build.MANUFACTURER + " " + Build.MODEL);
            o.put("home", act.home());
            o.put("features", new org.json.JSONArray().put("lan").put("bt").put("usb").put("notify").put("scan"));
        } catch (JSONException ignore) {}
        return o.toString();
    }

    /** Kirim ESC/POS (base64) ke printer ip:port. */
    @JavascriptInterface
    public void printRaw(final String host, final int port, final String b64, final String cb) {
        if (!act.isOwnPage()) { done(cb, "Ditolak: halaman bukan Kaly Ops"); return; }
        pool.execute(new Runnable() {
            @Override public void run() {
                String err = null;
                try {
                    byte[] data = Base64.decode(b64, Base64.DEFAULT);
                    PrinterClient.send(host, port, data, 7000);
                } catch (Throwable e) {
                    err = PrinterClient.message(e);
                }
                done(cb, err);
            }
        });
    }

    /** Cek apakah printer bisa dihubungi. */
    @JavascriptInterface
    public void ping(final String host, final int port, final String cb) {
        if (!act.isOwnPage()) { done(cb, "Ditolak: halaman bukan Kaly Ops"); return; }
        pool.execute(new Runnable() {
            @Override public void run() {
                String err = null;
                try { PrinterClient.ping(host, port, 4000); } catch (Throwable e) { err = PrinterClient.message(e); }
                done(cb, err);
            }
        });
    }

    // ---------- 1.1: satu pintu untuk LAN/Wi-Fi, Bluetooth, dan USB ----------
    /** Kirim ESC/POS. conn = lan (target ip, port) | bt (target alamat MAC) | usb (target vendor:produk). */
    @JavascriptInterface
    public void send(final String conn, final String target, final int port, final String b64, final String cb) {
        if (!act.isOwnPage()) { done(cb, "Ditolak: halaman bukan Kaly Ops"); return; }
        final byte[] data;
        try { data = Base64.decode(b64, Base64.DEFAULT); } catch (Exception e) { done(cb, "Data cetak rusak"); return; }
        run(conn, target, cb, new Job() {
            @Override public String go(UsbDevice dev) throws Exception {
                if ("lan".equals(conn)) PrinterClient.send(target, port, data, 7000);
                else if ("bt".equals(conn)) BtPrinter.send(target, data);
                else UsbPrinter.send(usb(), dev, data);
                return null;
            }
        });
    }

    /** Cek printer bisa dihubungi tanpa mencetak. */
    @JavascriptInterface
    public void check(final String conn, final String target, final int port, final String cb) {
        if (!act.isOwnPage()) { done(cb, "Ditolak: halaman bukan Kaly Ops"); return; }
        run(conn, target, cb, new Job() {
            @Override public String go(UsbDevice dev) throws Exception {
                if ("lan".equals(conn)) PrinterClient.ping(target, port, 4000);
                else if ("bt".equals(conn)) BtPrinter.check(target);
                return null;    // usb: sudah ditemukan & diizinkan
            }
        });
    }

    /** Daftar printer di tablet ini: kind = bt (sudah dipasangkan) | usb (tersambung). Hasil JSON di argumen ke-3. */
    @JavascriptInterface
    public void list(final String kind, final String cb) {
        if (!act.isOwnPage()) { done(cb, "Ditolak: halaman bukan Kaly Ops"); return; }
        run("bt".equals(kind) ? "bt" : "usb-list", "", cb, new Job() {
            @Override public String go(UsbDevice dev) throws Exception {
                return "bt".equals(kind) ? BtPrinter.list() : UsbPrinter.list(usb());
            }
        });
    }

    // ---------- 1.4: cari printer tanpa mengetik alamat ----------
    /** Pindai jaringan Wi-Fi/LAN tablet ini untuk printer ESC/POS (port 9100). Hasil JSON [{ip, port, name, model}]. */
    @JavascriptInterface
    public void scanLan(final String cb) {
        if (!act.isOwnPage()) { done(cb, "Ditolak: halaman bukan Kaly Ops"); return; }
        exec(null, cb, new Job() { @Override public String go(UsbDevice dev) throws Exception { return LanScanner.scan(9100, 450); } });
    }

    /** Cari printer Bluetooth: yang sudah dipasangkan + yang ada di sekitar (±12 detik). */
    @JavascriptInterface
    public void scanBt(final String cb) {
        if (!act.isOwnPage()) { done(cb, "Ditolak: halaman bukan Kaly Ops"); return; }
        act.runOnUiThread(new Runnable() { @Override public void run() {
            act.requestScan(new Runnable() { @Override public void run() {
                BtScanner.discover(act, 12000, new BtScanner.Done() {
                    @Override public void ok(String json) { done(cb, null, json); }
                    @Override public void fail(String msg) { done(cb, msg); }
                });
            } }, new Runnable() { @Override public void run() {
                done(cb, android.os.Build.VERSION.SDK_INT >= 31 ? "Izin \"Perangkat sekitar\" belum diberikan untuk Kaly Ops" : "Izin Lokasi belum diberikan (Android memerlukannya untuk mencari Bluetooth)");
            } });
        } });
    }

    /** Pasangkan printer Bluetooth langsung dari Kaly Ops (PIN 0000 / 1234 diisi otomatis). */
    @JavascriptInterface
    public void pairBt(final String addr, final String cb) {
        if (!act.isOwnPage()) { done(cb, "Ditolak: halaman bukan Kaly Ops"); return; }
        act.runOnUiThread(new Runnable() { @Override public void run() {
            act.requestScan(new Runnable() { @Override public void run() {
                BtScanner.pair(act, addr, new BtScanner.Done() {
                    @Override public void ok(String json) { done(cb, null, json); }
                    @Override public void fail(String msg) { done(cb, msg); }
                });
            } }, new Runnable() { @Override public void run() { done(cb, "Izin Bluetooth belum diberikan untuk Kaly Ops"); } });
        } });
    }

    /** Kabar dari Android ke halaman (mis. printer USB baru dicolok): window.KalyNative._event(kind, data). */
    void event(String kind, String json) {
        if (!act.isOwnPage()) return;
        final String js = "window.KalyNative&&window.KalyNative._event&&window.KalyNative._event(" + JSONObject.quote(kind) + "," + JSONObject.quote(json) + ")";
        web.post(new Runnable() { @Override public void run() { web.evaluateJavascript(js, null); } });
    }

    private interface Job { String go(UsbDevice dev) throws Exception; }

    private UsbManager usb() { return (UsbManager) act.getSystemService(Context.USB_SERVICE); }

    /** Jalankan di latar setelah izin yang diperlukan (Bluetooth / USB) didapat. */
    private void run(final String conn, final String target, final String cb, final Job job) {
        if ("bt".equals(conn) && !act.hasBtPermission()) {
            act.runOnUiThread(new Runnable() { @Override public void run() {
                act.requestBt(new Runnable() { @Override public void run() { exec(null, cb, job); } },
                    new Runnable() { @Override public void run() { done(cb, "Izin Bluetooth (Perangkat sekitar) belum diberikan untuk Kaly Ops"); } });
            } });
            return;
        }
        if ("usb".equals(conn)) {
            final UsbDevice dev;
            try { dev = UsbPrinter.find(usb(), target); } catch (Exception e) { done(cb, PrinterClient.message(e)); return; }
            if (!usb().hasPermission(dev)) {
                act.runOnUiThread(new Runnable() { @Override public void run() {
                    act.requestUsb(dev, new Runnable() { @Override public void run() { exec(dev, cb, job); } },
                        new Runnable() { @Override public void run() { done(cb, "Izin memakai printer USB tidak diberikan"); } });
                } });
                return;
            }
            exec(dev, cb, job);
            return;
        }
        exec(null, cb, job);
    }

    private void exec(final UsbDevice dev, final String cb, final Job job) {
        pool.execute(new Runnable() {
            @Override public void run() {
                String err = null, data = null;
                try { data = job.go(dev); } catch (Throwable e) { err = PrinterClient.message(e); }
                done(cb, err, data);
            }
        });
    }

    /** Cetak HTML lewat layanan cetak Android (printer tanpa IP, kertas A4, dll). */
    @JavascriptInterface
    public void systemPrint(final String html, final String name) {
        if (!act.isOwnPage()) return;
        act.runOnUiThread(new Runnable() { @Override public void run() { act.systemPrint(html, name); } });
    }

    /** Simpan file (Excel, CSV) lewat jendela simpan Android. */
    @JavascriptInterface
    public void saveFile(final String name, final String mime, final String b64) {
        if (!act.isOwnPage()) return;
        act.runOnUiThread(new Runnable() { @Override public void run() { act.saveFile(name, mime, b64); } });
    }

    /** Ucapkan pemberitahuan dengan suara Android (Bahasa Indonesia bila tersedia). */
    @JavascriptInterface
    public void speak(final String text) {
        if (!act.isOwnPage()) return;
        act.runOnUiThread(new Runnable() { @Override public void run() { act.speak(text); } });
    }

    // ---------- 1.2: notifikasi Android ----------
    /** Tampilkan notifikasi di bilah notifikasi Android (hanya bila Kaly Ops tidak sedang di layar). */
    @JavascriptInterface
    public void notify(final String title, final String body, final String tag, final String hash) {
        if (!act.isOwnPage()) return;
        act.runOnUiThread(new Runnable() { @Override public void run() {
            act.notifyUser(title == null ? "Kaly Ops" : title, body == null ? "" : body, tag == null || tag.length() == 0 ? "kaly" : tag, hash);
        } });
    }

    @JavascriptInterface
    public String notifyPermission() { return act.notifyPermission(); }

    /** Minta izin notifikasi (Android 13+). Jawaban: window.__kalyNotifyDone(id, "granted"|"denied"). */
    @JavascriptInterface
    public void requestNotify(final String id) {
        if (!act.isOwnPage()) return;
        act.runOnUiThread(new Runnable() { @Override public void run() {
            act.requestNotify(new Runnable() { @Override public void run() { notifyDone(id, "granted"); } },
                new Runnable() { @Override public void run() { notifyDone(id, "denied"); } });
        } });
    }
    private void notifyDone(String id, String p) {
        final String js = "window.__kalyNotifyDone&&window.__kalyNotifyDone(" + JSONObject.quote(id) + "," + JSONObject.quote(p) + ")";
        web.post(new Runnable() { @Override public void run() { web.evaluateJavascript(js, null); } });
    }

    @JavascriptInterface
    public String home() { return act.home(); }

    /** Ganti alamat Kaly Ops (dari halaman galat sambungan). */
    @JavascriptInterface
    public void setHome(final String url) {
        act.runOnUiThread(new Runnable() { @Override public void run() { act.setHome(url); } });
    }

    @JavascriptInterface
    public void reload() {
        act.runOnUiThread(new Runnable() { @Override public void run() { act.loadHome(); } });
    }

    private void done(String cb, String err) { done(cb, err, null); }

    private void done(String cb, String err, String data) {
        if (cb == null) return;
        final String js = "window.KalyNative&&window.KalyNative._done(" + JSONObject.quote(cb) + "," + (err == null ? "null" : JSONObject.quote(err))
            + "," + (data == null ? "null" : JSONObject.quote(data)) + ")";
        web.post(new Runnable() { @Override public void run() { web.evaluateJavascript(js, null); } });
    }
}
