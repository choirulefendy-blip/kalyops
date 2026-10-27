package id.kaly.ops;

import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.util.Locale;

/**
 * Printer thermal USB yang dicolok ke tablet (kabel OTG). Dikenali dari kode vendor:produk,
 * dikirimi data lewat endpoint bulk OUT (kelas printer USB atau kelas vendor).
 */
final class UsbPrinter {
    private UsbPrinter() {}

    static String idOf(UsbDevice d) { return String.format(Locale.ROOT, "%04x:%04x", d.getVendorId(), d.getProductId()); }

    /** Antarmuka & endpoint untuk mengirim data; null bila perangkat tidak bisa menerima cetakan. */
    private static Object[] outOf(UsbDevice d) {
        Object[] best = null;
        for (int i = 0; i < d.getInterfaceCount(); i++) {
            UsbInterface f = d.getInterface(i);
            for (int j = 0; j < f.getEndpointCount(); j++) {
                UsbEndpoint e = f.getEndpoint(j);
                if (e.getType() == UsbConstants.USB_ENDPOINT_XFER_BULK && e.getDirection() == UsbConstants.USB_DIR_OUT) {
                    if (f.getInterfaceClass() == UsbConstants.USB_CLASS_PRINTER) return new Object[] { f, e };
                    if (best == null) best = new Object[] { f, e };
                }
            }
        }
        return best;
    }

    /** Perangkat USB yang tersambung: [{id, name, printer, granted}] */
    static String list(UsbManager m) throws Exception {
        JSONArray out = new JSONArray();
        for (UsbDevice d : m.getDeviceList().values()) {
            Object[] o = outOf(d);
            if (o == null) continue;
            JSONObject j = new JSONObject();
            String name = null;
            if (Build.VERSION.SDK_INT >= 21) {
                String mf = d.getManufacturerName(), pr = d.getProductName();
                name = ((mf == null ? "" : mf + " ") + (pr == null ? "" : pr)).trim();
            }
            j.put("id", idOf(d));
            j.put("name", name == null || name.length() == 0 ? "Perangkat USB " + idOf(d) : name);
            j.put("printer", ((UsbInterface) o[0]).getInterfaceClass() == UsbConstants.USB_CLASS_PRINTER);
            j.put("granted", m.hasPermission(d));
            out.put(j);
        }
        return out.toString();
    }

    static UsbDevice find(UsbManager m, String id) throws IOException {
        for (UsbDevice d : m.getDeviceList().values()) if (idOf(d).equalsIgnoreCase(id)) return d;
        throw new IOException("Printer USB " + id + " tidak tersambung ke tablet ini");
    }

    static void send(UsbManager m, UsbDevice d, byte[] data) throws IOException {
        Object[] o = outOf(d);
        if (o == null) throw new IOException("Perangkat USB ini bukan printer");
        UsbInterface f = (UsbInterface) o[0];
        UsbEndpoint e = (UsbEndpoint) o[1];
        UsbDeviceConnection c = m.openDevice(d);
        if (c == null) throw new IOException("Printer USB tidak bisa dibuka (izin USB belum diberikan?)");
        try {
            if (!c.claimInterface(f, true)) throw new IOException("Printer USB sedang dipakai aplikasi lain");
            try {
                int off = 0;
                while (off < data.length) {
                    int n = Math.min(4096, data.length - off);
                    int r = c.bulkTransfer(e, data, off, n, 8000);
                    if (r <= 0) throw new IOException("Printer USB tidak menerima data (kertas habis atau kabel lepas?)");
                    off += r;
                }
            } finally {
                c.releaseInterface(f);
            }
        } finally {
            c.close();
        }
    }
}
