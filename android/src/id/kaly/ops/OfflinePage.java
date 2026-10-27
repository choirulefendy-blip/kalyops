package id.kaly.ops;

import android.text.TextUtils;

/** Halaman sederhana saat Kaly Ops tidak bisa dibuka: coba lagi, atau ganti alamat. */
final class OfflinePage {
    private OfflinePage() {}

    static String html(String home, String reason) {
        String h = TextUtils.htmlEncode(home == null ? "" : home);
        String r = TextUtils.htmlEncode(reason == null ? "" : reason);
        return "<!doctype html><html lang=\"id\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            + "<style>body{font-family:sans-serif;background:#F2F2F3;color:#1F2418;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}"
            + ".c{background:#fff;border-radius:14px;padding:24px;max-width:420px;margin:16px;box-shadow:0 8px 24px -12px rgba(0,0,0,.3)}"
            + "h1{font-size:20px;margin:0 0 8px}p{color:#5B6152;font-size:15px;line-height:1.5}small{color:#8A8F80}"
            + "button{font-size:16px;border:0;border-radius:10px;padding:12px 18px;background:#475331;color:#fff;width:100%;margin-top:8px}"
            + "button.g{background:#E3E6DA;color:#2A3220}input{font-size:16px;width:100%;box-sizing:border-box;padding:11px;border:1px solid #DADCD3;border-radius:10px;margin-top:12px}"
            + "details{margin-top:14px}summary{color:#475331}</style></head><body><div class=\"c\">"
            + "<h1>Kaly Ops belum bisa dibuka</h1><p>Periksa Wi-Fi atau data seluler tablet, lalu coba lagi.</p><small>" + r + "</small>"
            + "<button onclick=\"KalyAndroid.reload()\">Coba lagi</button>"
            + "<details><summary>Ganti alamat Kaly Ops</summary><input id=\"u\" value=\"" + h + "\" inputmode=\"url\">"
            + "<button class=\"g\" onclick=\"KalyAndroid.setHome(document.getElementById('u').value)\">Simpan & buka</button></details>"
            + "</div></body></html>";
    }
}
