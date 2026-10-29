package id.kaly.ops;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.nio.charset.Charset;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 1.4 · Cari printer thermal LAN/Wi-Fi di jaringan toko tanpa mengetik IP.
 * Memindai alamat satu jaringan (/24) dengan tablet ini pada port ESC/POS (9100).
 * Nama printer diambil dari halaman pengaturan web printer (port 80) atau nama host; tidak ada data yang dikirim
 * ke port 9100, jadi pemindaian tidak pernah mencetak apa pun.
 * Kelas Java murni supaya bisa diuji di komputer biasa.
 */
public final class LanScanner {
    private LanScanner() {}

    /** Alamat IPv4 jaringan lokal milik perangkat ini (Wi-Fi / Ethernet). */
    public static List<String> localIps() {
        List<String> out = new ArrayList<String>();
        try {
            Enumeration<NetworkInterface> it = NetworkInterface.getNetworkInterfaces();
            if (it == null) return out;
            for (NetworkInterface ni : Collections.list(it)) {
                try { if (!ni.isUp() || ni.isLoopback()) continue; } catch (Exception e) { continue; }
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    InetAddress a = ia.getAddress();
                    if (a instanceof Inet4Address && a.isSiteLocalAddress()) out.add(a.getHostAddress());
                }
            }
        } catch (Exception ignore) {}
        return out;
    }

    /** Semua alamat 1..254 di jaringan /24 dari tiap IP lokal (tanpa IP perangkat ini sendiri). */
    public static List<String> hostsAround(List<String> own) {
        Set<String> out = new LinkedHashSet<String>();
        for (String ip : own) {
            int k = ip.lastIndexOf('.');
            if (k < 0) continue;
            String base = ip.substring(0, k + 1);
            for (int i = 1; i <= 254; i++) { String h = base + i; if (!own.contains(h)) out.add(h); }
        }
        return new ArrayList<String>(out);
    }

    /** Pindai jaringan tablet ini. Hasil JSON: [{ip, port, name, model}] */
    public static String scan(int port, int timeoutMs) throws Exception {
        List<String> own = localIps();
        if (own.isEmpty()) throw new Exception("Tablet belum tersambung ke Wi-Fi / LAN toko");
        return scanHosts(hostsAround(own), port, timeoutMs, 80);
    }

    /** Pindai daftar alamat tertentu (dipakai juga oleh uji). */
    public static String scanHosts(List<String> hosts, final int port, final int timeoutMs, final int httpPort) throws Exception {
        final List<String> open = Collections.synchronizedList(new ArrayList<String>());
        ExecutorService pool = Executors.newFixedThreadPool(48);
        for (final String h : hosts) {
            pool.execute(new Runnable() {
                @Override public void run() {
                    Socket s = new Socket();
                    try { s.connect(new InetSocketAddress(h, port), timeoutMs); open.add(h); }
                    catch (Exception ignore) {}
                    finally { try { s.close(); } catch (Exception ignore) {} }
                }
            });
        }
        pool.shutdown();
        pool.awaitTermination(Math.max(5, hosts.size() * (long) timeoutMs / 48 / 1000 + 5), TimeUnit.SECONDS);
        Collections.sort(open, new java.util.Comparator<String>() {
            @Override public int compare(String a, String b) { return Long.compare(num(a), num(b)); }
        });
        final JSONArray out = new JSONArray();
        final JSONObject[] rows = new JSONObject[open.size()];
        ExecutorService names = Executors.newFixedThreadPool(8);
        for (int i = 0; i < open.size(); i++) {
            final int k = i; final String ip = open.get(i);
            names.execute(new Runnable() {
                @Override public void run() {
                    try {
                        String n = httpTitle(ip, httpPort, 1200);
                        if (n == null) n = hostName(ip);
                        JSONObject o = new JSONObject();
                        o.put("ip", ip); o.put("port", port);
                        o.put("name", n == null ? "Printer " + ip : n);
                        o.put("model", guessModel(n));
                        rows[k] = o;
                    } catch (Exception ignore) {}
                }
            });
        }
        names.shutdown();
        names.awaitTermination(10, TimeUnit.SECONDS);
        for (JSONObject o : rows) if (o != null) out.put(o);
        return out.toString();
    }

    private static long num(String ip) {
        long v = 0;
        for (String p : ip.split("\\.")) { try { v = v * 256 + Integer.parseInt(p); } catch (Exception e) { v = v * 256; } }
        return v;
    }

    private static final Pattern TITLE = Pattern.compile("<title[^>]*>([^<]{1,80})</title>", Pattern.CASE_INSENSITIVE);

    /** Judul halaman web pengaturan printer (Epson TM: "EPSON TM-T82X ..."). */
    static String httpTitle(String ip, int port, int timeoutMs) {
        Socket s = new Socket();
        try {
            s.connect(new InetSocketAddress(ip, port), timeoutMs);
            s.setSoTimeout(timeoutMs);
            OutputStream o = s.getOutputStream();
            o.write(("GET / HTTP/1.0\r\nHost: " + ip + "\r\nUser-Agent: KalyOps\r\nConnection: close\r\n\r\n").getBytes("US-ASCII"));
            o.flush();
            InputStream in = s.getInputStream();
            byte[] buf = new byte[16384];
            int n = 0, r;
            while (n < buf.length && (r = in.read(buf, n, buf.length - n)) > 0) n += r;
            String t = new String(buf, 0, n, Charset.forName("ISO-8859-1"));
            Matcher m = TITLE.matcher(t);
            if (m.find()) { String v = m.group(1).replaceAll("\\s+", " ").trim(); return v.length() > 0 ? v : null; }
            return null;
        } catch (Exception e) {
            return null;
        } finally { try { s.close(); } catch (Exception ignore) {} }
    }

    static String hostName(String ip) {
        try {
            String h = InetAddress.getByName(ip).getCanonicalHostName();
            return h == null || h.equals(ip) ? null : h;
        } catch (Exception e) { return null; }
    }

    /** Tebak model dari nama: epson_t82x | rongta_rpp02n | umum */
    public static String guessModel(String name) {
        String n = name == null ? "" : name.toUpperCase(Locale.ROOT);
        if (n.contains("T82")) return "epson_t82x";
        if (n.contains("RPP02") || n.contains("RONGTA")) return "rongta_rpp02n";
        return "umum";
    }
}
