import id.kaly.ops.LanScanner;
import java.io.*;
import java.net.*;
import java.util.*;

/** Uji pemindai printer LAN: dua "printer" palsu di 127.0.0.x, satu punya halaman web Epson. */
public class LanScannerTest {
    static int pass = 0, fail = 0;
    static void ok(String l, boolean c, String x) { if (c) pass++; else fail++; System.out.println((c ? "PASS " : "FAIL ") + l + (c ? "" : "  [" + x + "]")); }
    static ServerSocket listen(String ip, int port, final String http) throws Exception {
        final ServerSocket s = new ServerSocket(); s.bind(new InetSocketAddress(ip, port));
        final List<byte[]> got = new ArrayList<byte[]>();
        Thread t = new Thread(new Runnable() { public void run() { try { while (true) { Socket c = s.accept();
            if (http != null) { BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream())); r.readLine();
                c.getOutputStream().write(("HTTP/1.0 200 OK\r\nContent-Type: text/html\r\n\r\n<html><head><title>" + http + "</title></head></html>").getBytes()); }
            else { c.setSoTimeout(300); try { int n = c.getInputStream().read(new byte[64]); if (n > 0) received++; } catch (IOException ignore) {} }
            c.close(); } } catch (IOException e) {} } });
        t.setDaemon(true); t.start(); return s;
    }
    static volatile int received = 0;
    public static void main(String[] a) throws Exception {
        int P = 19100, H = 18080;
        listen("127.0.0.7", P, null); listen("127.0.0.7", H, "EPSON TM-T82X Series");
        listen("127.0.0.9", P, null);
        List<String> hosts = new ArrayList<String>();
        for (int i = 1; i <= 40; i++) hosts.add("127.0.0." + i);
        long t0 = System.currentTimeMillis();
        String j = LanScanner.scanHosts(hosts, P, 300, H);
        long ms = System.currentTimeMillis() - t0;
        System.out.println("hasil: " + j);
        ok("menemukan 2 printer di port " + P, j.contains("\"ip\":\"127.0.0.7\"") && j.contains("\"ip\":\"127.0.0.9\"") && j.split("\"ip\"").length == 3, j);
        ok("nama Epson dari halaman web printer & model ditebak", j.contains("EPSON TM-T82X Series") && j.contains("\"model\":\"epson_t82x\""), j);
        ok("printer tanpa halaman web tetap muncul dengan nama IP", j.contains("127.0.0.9") && j.matches(".*\"ip\":\"127.0.0.9\".*\"model\":\"umum\".*"), j);
        ok("urut berdasarkan IP", j.indexOf("127.0.0.7") < j.indexOf("127.0.0.9"), j);
        ok("pemindaian tidak mengirim data ke port printer (tidak mencetak)", received == 0, "" + received);
        ok("40 alamat selesai < 4 detik (" + ms + " ms)", ms < 4000, "" + ms);
        List<String> around = LanScanner.hostsAround(Arrays.asList("192.168.1.23"));
        ok("satu jaringan /24: 253 alamat tanpa IP sendiri", around.size() == 253 && !around.contains("192.168.1.23") && around.get(0).equals("192.168.1.1") && around.get(252).equals("192.168.1.254"), "" + around.size());
        ok("tebak model Rongta dari nama", LanScanner.guessModel("RPP02N-B3C1").equals("rongta_rpp02n") && LanScanner.guessModel("Printer001").equals("umum"), "");
        String e = LanScanner.scanHosts(Arrays.asList("127.0.0.30", "127.0.0.31"), P, 300, H);
        ok("jaringan tanpa printer → daftar kosong", e.equals("[]"), e);
        System.out.println("\n" + pass + " lulus, " + fail + " gagal");
        System.exit(fail == 0 ? 0 : 1);
    }
}
