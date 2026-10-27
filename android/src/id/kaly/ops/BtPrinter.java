package id.kaly.ops;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Printer thermal Bluetooth (profil Serial Port / SPP). Printer harus sudah dipasangkan (paired)
 * di Pengaturan > Bluetooth tablet. Data dikirim sedikit demi sedikit karena buffer printer Bluetooth kecil.
 */
final class BtPrinter {
    private BtPrinter() {}

    private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private static final Map<String, Object> LOCKS = new HashMap<String, Object>();

    private static Object lockFor(String addr) {
        synchronized (LOCKS) {
            Object o = LOCKS.get(addr);
            if (o == null) { o = new Object(); LOCKS.put(addr, o); }
            return o;
        }
    }

    private static BluetoothAdapter adapter() throws IOException {
        BluetoothAdapter a = BluetoothAdapter.getDefaultAdapter();
        if (a == null) throw new IOException("Tablet ini tidak punya Bluetooth");
        if (!a.isEnabled()) throw new IOException("Bluetooth tablet belum dinyalakan");
        return a;
    }

    /** Daftar printer/perangkat Bluetooth yang sudah dipasangkan: [{name, addr, printer}] */
    static String list() throws Exception {
        BluetoothAdapter a = adapter();
        JSONArray out = new JSONArray();
        Set<BluetoothDevice> ds = a.getBondedDevices();
        if (ds != null) for (BluetoothDevice d : ds) {
            JSONObject o = new JSONObject();
            o.put("name", d.getName() == null ? d.getAddress() : d.getName());
            o.put("addr", d.getAddress());
            int major = d.getBluetoothClass() == null ? -1 : d.getBluetoothClass().getMajorDeviceClass();
            o.put("printer", major == 0x0600 || major == 0x1F00);   // IMAGING (printer) atau tanpa kelas: umum pada printer murah
            out.put(o);
        }
        return out.toString();
    }

    private static BluetoothSocket open(BluetoothAdapter a, String addr) throws IOException {
        BluetoothDevice d;
        try { d = a.getRemoteDevice(addr.toUpperCase()); }
        catch (IllegalArgumentException e) { throw new IOException("Alamat Bluetooth tidak valid"); }
        try { a.cancelDiscovery(); } catch (Throwable ignore) {}
        IOException last = null;
        // Cara sambung yang umum dipakai printer thermal: aman, tidak aman, lalu kanal 1 langsung
        for (int k = 0; k < 3; k++) {
            BluetoothSocket s = null;
            try {
                if (k == 0) s = d.createRfcommSocketToServiceRecord(SPP);
                else if (k == 1) s = d.createInsecureRfcommSocketToServiceRecord(SPP);
                else {
                    Method m = d.getClass().getMethod("createRfcommSocket", int.class);
                    s = (BluetoothSocket) m.invoke(d, 1);
                }
                s.connect();
                return s;
            } catch (Exception e) {
                last = e instanceof IOException ? (IOException) e : new IOException(e.getMessage());
                if (s != null) try { s.close(); } catch (IOException ignore) {}
            }
        }
        throw new IOException("Printer Bluetooth tidak bisa dihubungi. Pastikan printer menyala, sudah dipasangkan, dan tidak sedang tersambung ke HP lain"
            + (last != null && last.getMessage() != null ? " (" + last.getMessage() + ")" : ""));
    }

    static void send(String addr, byte[] data) throws Exception {
        BluetoothAdapter a = adapter();
        synchronized (lockFor(addr)) {
            BluetoothSocket s = open(a, addr);
            try {
                OutputStream out = s.getOutputStream();
                int off = 0;
                while (off < data.length) {
                    int n = Math.min(512, data.length - off);
                    out.write(data, off, n);
                    out.flush();
                    off += n;
                    Thread.sleep(12);
                }
                // Tunggu sisa data terkirim sebelum sambungan ditutup
                Thread.sleep(Math.min(4000, 600 + data.length / 40));
            } finally {
                try { s.close(); } catch (IOException ignore) {}
            }
        }
    }

    static void check(String addr) throws Exception {
        BluetoothAdapter a = adapter();
        synchronized (lockFor(addr)) {
            BluetoothSocket s = open(a, addr);
            try { s.close(); } catch (IOException ignore) {}
        }
    }
}
