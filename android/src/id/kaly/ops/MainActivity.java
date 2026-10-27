package id.kaly.ops;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.speech.tts.TextToSpeech;
import android.util.Base64;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.OutputStream;
import java.util.Locale;

/**
 * Aplikasi Android Kaly Ops: membuka Kaly Ops (situs Netlify) di WebView layar penuh,
 * lalu menyediakan window.KalyAndroid untuk cetak langsung ke printer LAN/Wi-Fi,
 * jendela cetak Android, simpan file, suara pemberitahuan, dan (1.2) notifikasi Android.
 */
public class MainActivity extends Activity {
    static final String DEFAULT_HOME = "https://choirulefendy-blip.github.io/kalyops/";   // 1.3: GitHub Pages (sebelumnya Netlify)
    private static final int REQ_FILE = 11, REQ_SAVE = 12, REQ_BT = 13, REQ_NOTIFY = 14;
    private static final String BT_CONNECT = "android.permission.BLUETOOTH_CONNECT";   // Android 12+
    private static final String POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS";   // Android 13+
    private static final String CHANNEL = "kaly";
    private Runnable notifyOk, notifyDeny;
    private volatile boolean foreground;
    private static final String USB_PERMISSION = "id.kaly.ops.USB_PERMISSION";
    private Runnable btOk, btDeny, usbOk, usbDeny;
    private BroadcastReceiver usbReceiver;

    private WebView web;
    private ValueCallback<Uri[]> fileCb;
    private byte[] pendingSave;
    private WebView printWeb;           // dipegang sampai pekerjaan cetak Android selesai disiapkan
    private TextToSpeech tts;
    private boolean ttsReady;
    private volatile String currentUrl = "";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);   // layar kasir tidak mati sendiri
        getWindow().setStatusBarColor(0xFF2A3220);

        web = new WebView(this);
        web.setBackgroundColor(0xFFF2F2F3);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);            // sesi login & pengaturan perangkat (localStorage)
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);   // bunyi notifikasi dapur
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(true);
        s.setUserAgentString(s.getUserAgentString() + " KalyOpsAndroid/" + BuildInfo.VERSION_NAME);

        web.addJavascriptInterface(new Bridge(this, web), "KalyAndroid");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        tts = new TextToSpeech(this, new TextToSpeech.OnInitListener() {
            @Override public void onInit(int status) {
                if (status != TextToSpeech.SUCCESS) return;
                int r = tts.setLanguage(new Locale("id", "ID"));
                ttsReady = r != TextToSpeech.LANG_MISSING_DATA && r != TextToSpeech.LANG_NOT_SUPPORTED;
                if (!ttsReady) ttsReady = tts.setLanguage(Locale.getDefault()) >= 0;
                tts.setSpeechRate(0.95f);
            }
        });

        registerUsbReceiver();

        if (state != null) web.restoreState(state);
        else {
            String h = hashOf(getIntent());
            if (h != null) web.loadUrl(base(home()) + h);   // dibuka dari notifikasi saat aplikasi tertutup
            else loadHome();
        }
    }

    // ---------- Izin Bluetooth (Android 12+: "Perangkat sekitar") ----------
    boolean hasBtPermission() {
        return Build.VERSION.SDK_INT < 31 || checkSelfPermission(BT_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }
    void requestBt(Runnable ok, Runnable deny) {
        if (hasBtPermission()) { ok.run(); return; }
        btOk = ok; btDeny = deny;
        requestPermissions(new String[] { BT_CONNECT }, REQ_BT);
    }
    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
        boolean ok = res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED;
        if (req == REQ_NOTIFY) {
            prefs().edit().putBoolean("notifyAsked", true).apply();
            Runnable r = ok ? notifyOk : notifyDeny;
            notifyOk = notifyDeny = null;
            if (r != null) r.run();
            return;
        }
        if (req != REQ_BT) return;
        Runnable r = ok ? btOk : btDeny;
        btOk = btDeny = null;
        if (r != null) r.run();
    }

    // ---------- Notifikasi Android (1.2) ----------
    /** granted | denied | default (belum pernah ditanya) */
    String notifyPermission() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            return prefs().getBoolean("notifyAsked", false) && !shouldShowRequestPermissionRationale(POST_NOTIFICATIONS) ? "denied" : "default";
        if (Build.VERSION.SDK_INT >= 24) {
            try { if (!(Boolean) NotificationManager.class.getMethod("areNotificationsEnabled").invoke(nm())) return "denied"; } catch (Exception ignore) {}
        }
        return "granted";
    }
    void requestNotify(Runnable ok, Runnable deny) {
        if (Build.VERSION.SDK_INT < 33 || checkSelfPermission(POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            ("granted".equals(notifyPermission()) ? ok : deny).run();
            return;
        }
        notifyOk = ok; notifyDeny = deny;
        requestPermissions(new String[] { POST_NOTIFICATIONS }, REQ_NOTIFY);
    }
    private NotificationManager nm() { return (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE); }
    private boolean channelReady;
    private void ensureChannel() {
        if (channelReady || Build.VERSION.SDK_INT < 26) return;
        try {   // NotificationChannel (Android 8+) lewat refleksi karena dibangun dengan SDK 23
            Class<?> ch = Class.forName("android.app.NotificationChannel");
            Object c = ch.getConstructor(String.class, CharSequence.class, int.class).newInstance(CHANNEL, "Notifikasi Kaly Ops", 4 /* IMPORTANCE_HIGH */);
            ch.getMethod("setDescription", String.class).invoke(c, "Pesanan, laporan shift, keuangan, fraud, dan stok");
            NotificationManager.class.getMethod("createNotificationChannel", ch).invoke(nm(), c);
            channelReady = true;
        } catch (Exception ignore) {}
    }
    /**
     * Tampilkan notifikasi Android. Saat Kaly Ops sedang di layar, kartu di aplikasi sudah cukup (tidak dobel).
     * Tag yang sama menggantikan notifikasi sebelumnya.
     */
    void notifyUser(String title, String body, String tag, String hash) {
        if (foreground && !"kaly-test".equals(tag)) return;
        if (!"granted".equals(notifyPermission())) return;
        ensureChannel();
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            try { b = Notification.Builder.class.getConstructor(Context.class, String.class).newInstance(this, CHANNEL); }
            catch (Exception e) { b = new Notification.Builder(this); }
        } else {
            b = new Notification.Builder(this);
            b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_SOUND | Notification.DEFAULT_VIBRATE);
        }
        Intent i = new Intent(this, MainActivity.class).setAction("id.kaly.ops.OPEN").addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (hash != null && hash.startsWith("#/")) i.putExtra("hash", hash);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? 0x04000000 /* FLAG_IMMUTABLE */ : 0);
        PendingIntent pi = PendingIntent.getActivity(this, tag.hashCode(), i, flags);
        b.setSmallIcon(R.drawable.ic_notify).setColor(0xFF475331)
            .setContentTitle(title).setContentText(body).setStyle(new Notification.BigTextStyle().bigText(body))
            .setAutoCancel(true).setContentIntent(pi).setWhen(System.currentTimeMillis()).setShowWhen(true)
            .setCategory(Notification.CATEGORY_MESSAGE);
        try { nm().notify(tag, 1, b.build()); } catch (Exception ignore) {}
    }
    private static String hashOf(Intent i) {
        String h = i == null ? null : i.getStringExtra("hash");
        return h != null && h.startsWith("#/") && h.length() < 300 ? h : null;
    }
    private static String base(String url) { int k = url.indexOf('#'); return k < 0 ? url : url.substring(0, k); }
    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        setIntent(i);
        String h = hashOf(i);
        if (h == null) return;
        if (isOwnPage()) web.evaluateJavascript("location.hash=" + org.json.JSONObject.quote(h), null);
        else web.loadUrl(base(home()) + h);
    }

    // ---------- Izin USB ----------
    private void registerUsbReceiver() {
        usbReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                if (!USB_PERMISSION.equals(i.getAction())) return;
                boolean ok = i.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false);
                Runnable r = ok ? usbOk : usbDeny;
                usbOk = usbDeny = null;
                if (r != null) r.run();
            }
        };
        IntentFilter f = new IntentFilter(USB_PERMISSION);
        if (Build.VERSION.SDK_INT >= 26) {
            // Android 14 mewajibkan tanda RECEIVER_NOT_EXPORTED (4); dipanggil lewat refleksi karena dibangun dengan SDK 23
            try {
                Context.class.getMethod("registerReceiver", BroadcastReceiver.class, IntentFilter.class, int.class).invoke(this, usbReceiver, f, 4);
                return;
            } catch (Exception ignore) {}
        }
        registerReceiver(usbReceiver, f);
    }
    void requestUsb(UsbDevice dev, Runnable ok, Runnable deny) {
        UsbManager m = (UsbManager) getSystemService(Context.USB_SERVICE);
        if (m.hasPermission(dev)) { ok.run(); return; }
        usbOk = ok; usbDeny = deny;
        Intent i = new Intent(USB_PERMISSION).setPackage(getPackageName());
        int flags = Build.VERSION.SDK_INT >= 31 ? 0x02000000 /* FLAG_MUTABLE: sistem menambah hasil izin */ : 0;
        m.requestPermission(dev, PendingIntent.getBroadcast(this, 0, i, flags));
    }

    // ---------- Alamat Kaly Ops ----------
    private SharedPreferences prefs() { return getSharedPreferences("kaly", Context.MODE_PRIVATE); }
    String home() {
        String h = prefs().getString("home", DEFAULT_HOME);
        // 1.3: alamat lama di Netlify otomatis pindah ke GitHub Pages
        if (h.contains("kaly-ops.netlify.app")) { prefs().edit().putString("home", DEFAULT_HOME).apply(); return DEFAULT_HOME; }
        return h;
    }
    void setHome(String url) {
        if (url == null) return;
        url = url.trim();
        if (!url.startsWith("https://")) { toast("Alamat harus diawali https://"); return; }
        if (!url.endsWith("/") && !url.contains("#") && !url.contains("?")) url = url + "/";
        prefs().edit().putString("home", url).apply();
        loadHome();
    }
    void loadHome() { web.loadUrl(home()); }

    private static String hostOf(String url) {
        try { String h = Uri.parse(url).getHost(); return h == null ? "" : h.toLowerCase(Locale.ROOT); } catch (Exception e) { return ""; }
    }
    /** Jembatan hanya melayani halaman dari alamat Kaly Ops sendiri. */
    boolean isOwnPage() {
        String h = hostOf(currentUrl);
        return h.length() > 0 && h.equals(hostOf(home()));
    }

    // ---------- Navigasi ----------
    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            Uri u = Uri.parse(url);
            String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
            if (("https".equals(scheme) || "http".equals(scheme)) && hostOf(url).equals(hostOf(home()))) return false;
            if ("blob".equals(scheme) || "data".equals(scheme) || "about".equals(scheme)) return false;
            // WhatsApp, Google Maps, telepon, situs lain: buka di aplikasinya
            try {
                Intent i = "intent".equals(scheme) ? Intent.parseUri(url, Intent.URI_INTENT_SCHEME) : new Intent(Intent.ACTION_VIEW, u);
                i.addCategory(Intent.CATEGORY_BROWSABLE);
                i.setComponent(null);
                i.setSelector(null);
                startActivity(i);
            } catch (Exception e) {
                toast("Tidak ada aplikasi untuk membuka tautan ini");
            }
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) { currentUrl = url == null ? "" : url; }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) { currentUrl = url == null ? "" : url; }

        @Override
        public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
            // Hanya dipanggil untuk halaman utama: tampilkan halaman coba lagi
            view.loadDataWithBaseURL(null, OfflinePage.html(home(), description), "text/html", "utf-8", null);
            currentUrl = home();
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
            if (fileCb != null) fileCb.onReceiveValue(null);
            fileCb = cb;
            try {
                startActivityForResult(params.createIntent(), REQ_FILE);
            } catch (ActivityNotFoundException e) {
                fileCb = null;
                toast("Tidak ada aplikasi untuk memilih file");
                return false;
            }
            return true;
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == REQ_FILE) {
            if (fileCb != null) fileCb.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data));
            fileCb = null;
            return;
        }
        if (req == REQ_SAVE) {
            byte[] b = pendingSave; pendingSave = null;
            if (res != RESULT_OK || data == null || data.getData() == null || b == null) return;
            try {
                OutputStream os = getContentResolver().openOutputStream(data.getData());
                os.write(b); os.close();
                toast("File disimpan");
            } catch (Exception e) {
                toast("Gagal menyimpan file: " + e.getMessage());
            }
            return;
        }
        super.onActivityResult(req, res, data);
    }

    // ---------- Dipanggil dari Bridge (di thread UI) ----------
    void saveFile(String name, String mime, String b64) {
        try { pendingSave = Base64.decode(b64, Base64.DEFAULT); } catch (Exception e) { toast("File rusak"); return; }
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType(mime == null || mime.length() == 0 ? "application/octet-stream" : mime);
        i.putExtra(Intent.EXTRA_TITLE, name);
        try { startActivityForResult(i, REQ_SAVE); } catch (ActivityNotFoundException e) { pendingSave = null; toast("Tidak bisa membuka jendela simpan"); }
    }

    void systemPrint(String html, final String name) {
        final WebView pw = new WebView(this);
        pw.getSettings().setJavaScriptEnabled(false);
        pw.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String url) {
                PrintManager pm = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                String job = name == null || name.length() == 0 ? "Kaly Ops" : name;
                pm.print(job, view.createPrintDocumentAdapter(job), new PrintAttributes.Builder().build());
                printWeb = null;
            }
        });
        printWeb = pw;
        pw.loadDataWithBaseURL(home(), html, "text/html", "utf-8", null);
    }

    private int ttsSeq;
    void speak(String text) {
        if (!ttsReady || text == null) return;
        tts.speak(text, TextToSpeech.QUEUE_ADD, null, "kaly" + (++ttsSeq));
    }

    private void toast(String m) { Toast.makeText(this, m, Toast.LENGTH_LONG).show(); }

    // ---------- Siklus hidup ----------
    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true);   // aplikasi tetap berjalan di latar supaya notifikasi tetap masuk
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onResume() { super.onResume(); foreground = true; web.onResume(); }

    @Override
    protected void onPause() { super.onPause(); foreground = false; web.onPause(); }

    @Override
    protected void onDestroy() {
        if (tts != null) tts.shutdown();
        if (usbReceiver != null) try { unregisterReceiver(usbReceiver); } catch (Exception ignore) {}
        web.setVisibility(View.GONE);
        web.destroy();
        super.onDestroy();
    }
}
