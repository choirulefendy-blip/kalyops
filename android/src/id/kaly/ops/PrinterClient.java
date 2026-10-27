package id.kaly.ops;

import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.InetSocketAddress;
import java.net.NoRouteToHostException;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.util.HashMap;
import java.util.Map;

/**
 * Kirim byte ESC/POS ke printer thermal LAN/Wi-Fi (raw TCP, biasanya port 9100).
 * Kelas Java murni (tanpa Android) supaya bisa diuji di komputer biasa.
 */
public final class PrinterClient {
    private PrinterClient() {}

    private static final Map<String, Object> LOCKS = new HashMap<String, Object>();

    /** Satu printer dilayani bergantian supaya dua cetakan tidak bercampur. */
    private static Object lockFor(String host, int port) {
        String k = host + ":" + port;
        synchronized (LOCKS) {
            Object o = LOCKS.get(k);
            if (o == null) { o = new Object(); LOCKS.put(k, o); }
            return o;
        }
    }

    public static void send(String host, int port, byte[] data, int timeoutMs) throws IOException {
        synchronized (lockFor(host, port)) {
            Socket s = new Socket();
            try {
                s.connect(new InetSocketAddress(host, port), timeoutMs);
                s.setSoTimeout(timeoutMs);
                s.setTcpNoDelay(true);
                OutputStream out = new BufferedOutputStream(s.getOutputStream(), 8192);
                int off = 0;
                while (off < data.length) {
                    int n = Math.min(4096, data.length - off);
                    out.write(data, off, n);
                    off += n;
                }
                out.flush();
                // Beri waktu printer menerima semua data sebelum koneksi ditutup
                try { s.shutdownOutput(); } catch (IOException ignore) {}
                drain(s, 400);
            } finally {
                try { s.close(); } catch (IOException ignore) {}
            }
        }
    }

    /** Tunggu sebentar: sebagian printer menutup koneksi sendiri setelah selesai menerima. */
    private static void drain(Socket s, int ms) {
        try {
            s.setSoTimeout(ms);
            InputStream in = s.getInputStream();
            byte[] buf = new byte[256];
            while (in.read(buf) >= 0) { /* buang status dari printer */ }
        } catch (IOException ignore) {
            // waktu habis = printer tidak menutup koneksi; normal
        }
    }

    public static void ping(String host, int port, int timeoutMs) throws IOException {
        Socket s = new Socket();
        try { s.connect(new InetSocketAddress(host, port), timeoutMs); }
        finally { try { s.close(); } catch (IOException ignore) {} }
    }

    /** Pesan galat berbahasa Indonesia untuk ditampilkan ke kasir. */
    public static String message(Throwable e) {
        if (e instanceof UnknownHostException) return "Alamat printer tidak dikenal";
        if (e instanceof SocketTimeoutException) return "Printer tidak menjawab (waktu habis)";
        if (e instanceof NoRouteToHostException) return "Tidak ada jalur ke printer, periksa Wi-Fi/LAN tablet";
        if (e instanceof ConnectException) return "Printer menolak sambungan atau sedang mati";
        String m = e.getMessage();
        return m == null || m.length() == 0 ? e.getClass().getSimpleName() : m;
    }
}
