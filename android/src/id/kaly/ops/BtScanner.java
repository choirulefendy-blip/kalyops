package id.kaly.ops;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothClass;
import android.bluetooth.BluetoothDevice;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * 1.4 · Cari & pasangkan printer Bluetooth langsung dari Kaly Ops (tanpa membuka Pengaturan Android).
 * Pencarian: perangkat yang sudah dipasangkan + perangkat di sekitar (discovery ±12 detik).
 * Pemasangan: PIN printer thermal yang umum (0000, lalu 1234) diisi otomatis; bila PIN lain,
 * Android menampilkan kotak PIN-nya sendiri.
 */
final class BtScanner {
    private BtScanner() {}

    interface Done { void ok(String json); void fail(String msg); }

    private static Handler main() { return new Handler(Looper.getMainLooper()); }

    static BluetoothAdapter adapter() throws Exception {
        BluetoothAdapter a = BluetoothAdapter.getDefaultAdapter();
        if (a == null) throw new Exception("Tablet ini tidak punya Bluetooth");
        if (!a.isEnabled()) throw new Exception("Nyalakan Bluetooth tablet dulu, lalu cari lagi");
        return a;
    }

    static boolean looksPrinter(BluetoothDevice d) {
        BluetoothClass c = d.getBluetoothClass();
        int major = c == null ? -1 : c.getMajorDeviceClass();
        if (major == 0x0600 || major == 0x1F00) return true;   // IMAGING (printer) / tanpa kelas: umum pada printer thermal murah
        String n = d.getName() == null ? "" : d.getName().toUpperCase();
        return n.contains("PRINT") || n.contains("RPP") || n.contains("POS") || n.contains("MTP") || n.contains("RONGTA") || n.contains("TM-");
    }

    private static JSONObject row(BluetoothDevice d, boolean bonded, short rssi) throws Exception {
        JSONObject o = new JSONObject();
        String n = d.getName();
        o.put("name", n == null || n.length() == 0 ? d.getAddress() : n);
        o.put("addr", d.getAddress());
        o.put("printer", looksPrinter(d));
        o.put("bonded", bonded);
        o.put("model", LanScanner.guessModel(n));
        if (rssi != Short.MIN_VALUE) o.put("rssi", rssi);
        return o;
    }

    /** Cari printer Bluetooth: yang sudah dipasangkan + yang ada di sekitar. Hasil di Done.ok sebagai JSON array. */
    static void discover(final Context ctx, final int ms, final Done done) {
        final BluetoothAdapter a;
        try { a = adapter(); } catch (Exception e) { done.fail(e.getMessage()); return; }
        final Map<String, JSONObject> found = new LinkedHashMap<String, JSONObject>();
        try {
            Set<BluetoothDevice> b = a.getBondedDevices();
            if (b != null) for (BluetoothDevice d : b) found.put(d.getAddress(), row(d, true, Short.MIN_VALUE));
        } catch (Exception ignore) {}
        final BroadcastReceiver r = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                if (!BluetoothDevice.ACTION_FOUND.equals(i.getAction())) return;
                BluetoothDevice d = i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                if (d == null) return;
                short rssi = i.getShortExtra(BluetoothDevice.EXTRA_RSSI, Short.MIN_VALUE);
                try {
                    synchronized (found) {
                        JSONObject old = found.get(d.getAddress());
                        if (old == null || (old.optString("name").equals(d.getAddress()) && d.getName() != null))
                            found.put(d.getAddress(), row(d, d.getBondState() == BluetoothDevice.BOND_BONDED, rssi));
                    }
                } catch (Exception ignore) {}
            }
        };
        register(ctx, r, new IntentFilter(BluetoothDevice.ACTION_FOUND));
        try { if (a.isDiscovering()) a.cancelDiscovery(); } catch (Exception ignore) {}
        boolean started;
        try { started = a.startDiscovery(); } catch (Exception e) { started = false; }
        final boolean noScan = !started;
        main().postDelayed(new Runnable() {
            @Override public void run() {
                try { a.cancelDiscovery(); } catch (Exception ignore) {}
                try { ctx.unregisterReceiver(r); } catch (Exception ignore) {}
                JSONArray out = new JSONArray();
                synchronized (found) {
                    // printer dulu, lalu perangkat lain
                    for (JSONObject o : found.values()) if (o.optBoolean("printer")) out.put(o);
                    for (JSONObject o : found.values()) if (!o.optBoolean("printer")) out.put(o);
                }
                if (noScan && out.length() == 0) done.fail(Build.VERSION.SDK_INT < 31
                    ? "Pencarian Bluetooth tidak bisa dimulai. Nyalakan Lokasi (GPS) tablet, lalu cari lagi"
                    : "Pencarian Bluetooth tidak bisa dimulai");
                else done.ok(out.toString());
            }
        }, noScan ? 300 : ms);
    }

    private static final String[] PINS = { "0000", "1234" };

    /** Pasangkan printer. Selesai saat tersambung (BOND_BONDED) atau gagal setelah semua PIN dicoba. */
    static void pair(final Context ctx, final String addr, final Done done) {
        final BluetoothAdapter a;
        final BluetoothDevice d;
        try { a = adapter(); d = a.getRemoteDevice(addr.toUpperCase()); }
        catch (IllegalArgumentException e) { done.fail("Alamat Bluetooth tidak valid"); return; }
        catch (Exception e) { done.fail(e.getMessage()); return; }
        if (d.getBondState() == BluetoothDevice.BOND_BONDED) { done.ok("{\"bonded\":true}"); return; }
        try { a.cancelDiscovery(); } catch (Exception ignore) {}
        final int[] attempt = { 0 };
        final boolean[] finished = { false };
        final Handler h = main();
        final BroadcastReceiver[] holder = new BroadcastReceiver[1];
        final Runnable[] timeout = new Runnable[1];
        final Done end = new Done() {
            void close() {
                finished[0] = true;
                try { ctx.unregisterReceiver(holder[0]); } catch (Exception ignore) {}
                if (timeout[0] != null) h.removeCallbacks(timeout[0]);
            }
            @Override public void ok(String j) { if (finished[0]) return; close(); done.ok(j); }
            @Override public void fail(String m) { if (finished[0]) return; close(); done.fail(m); }
        };
        holder[0] = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                BluetoothDevice x = i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                if (x == null || !addr.equalsIgnoreCase(x.getAddress())) return;
                if ("android.bluetooth.device.action.PAIRING_REQUEST".equals(i.getAction())) {
                    int variant = i.getIntExtra("android.bluetooth.device.extra.PAIRING_VARIANT", -1);
                    try {
                        if (variant == 0 /* PIN */ || variant == 5 /* PIN 16 digit */) {
                            String pin = PINS[Math.min(attempt[0], PINS.length - 1)];
                            if (x.setPin(pin.getBytes("UTF-8"))) abortBroadcast();
                        } else if (variant == 2 /* konfirmasi kode */ || variant == 3 /* setuju */) {
                            BluetoothDevice.class.getMethod("setPairingConfirmation", boolean.class).invoke(x, true);
                            abortBroadcast();
                        }
                    } catch (Throwable ignore) { /* biarkan Android menampilkan kotak PIN-nya */ }
                    return;
                }
                if (BluetoothDevice.ACTION_BOND_STATE_CHANGED.equals(i.getAction())) {
                    int st = i.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.ERROR);
                    int prev = i.getIntExtra(BluetoothDevice.EXTRA_PREVIOUS_BOND_STATE, BluetoothDevice.ERROR);
                    if (st == BluetoothDevice.BOND_BONDED) end.ok("{\"bonded\":true}");
                    else if (st == BluetoothDevice.BOND_NONE && prev == BluetoothDevice.BOND_BONDING) {
                        attempt[0]++;
                        if (attempt[0] < PINS.length) {
                            h.postDelayed(new Runnable() { @Override public void run() { if (!finished[0] && !x.createBond()) end.fail("Printer menolak dipasangkan"); } }, 800);
                        } else end.fail("Printer tidak mau dipasangkan dengan PIN 0000 / 1234. Pastikan printer menyala dan tidak tersambung ke HP lain, lalu coba lagi");
                    }
                }
            }
        };
        IntentFilter f = new IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED);
        f.addAction("android.bluetooth.device.action.PAIRING_REQUEST");
        f.setPriority(IntentFilter.SYSTEM_HIGH_PRIORITY - 1);
        register(ctx, holder[0], f);
        timeout[0] = new Runnable() { @Override public void run() { end.fail("Pemasangan terlalu lama. Pastikan printer menyala & dekat tablet, lalu coba lagi"); } };
        h.postDelayed(timeout[0], 45000);
        if (!d.createBond()) end.fail("Pemasangan tidak bisa dimulai. Matikan lalu nyalakan Bluetooth tablet, lalu coba lagi");
    }

    /** Daftarkan penerima siaran sistem (Android 13+ mewajibkan tanda EXPORTED untuk siaran sistem dari luar). */
    static void register(Context ctx, BroadcastReceiver r, IntentFilter f) {
        if (Build.VERSION.SDK_INT >= 33) {
            try {
                Context.class.getMethod("registerReceiver", BroadcastReceiver.class, IntentFilter.class, int.class).invoke(ctx, r, f, 2 /* RECEIVER_EXPORTED */);
                return;
            } catch (Exception ignore) {}
        }
        ctx.registerReceiver(r, f);
    }
}
