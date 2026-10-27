import id.kaly.ops.PrinterClient;
import java.nio.file.*;
import java.util.Base64;

public class PrinterClientTest {
    public static void main(String[] a) throws Exception {
        final byte[] data = Base64.getDecoder().decode(new String(Files.readAllBytes(Paths.get(a[0]))).trim());
        final int port = Integer.parseInt(a[1]);
        PrinterClient.ping("127.0.0.1", port, 2000);
        System.out.println("PASS ping printer menyala");
        try { PrinterClient.ping("127.0.0.1", port + 7, 2000); System.out.println("FAIL ping port tertutup"); }
        catch (Exception e) { System.out.println("PASS ping port tertutup: " + PrinterClient.message(e)); }
        try { PrinterClient.send("10.255.255.1", 9100, data, 1500); System.out.println("FAIL kirim ke IP tidak ada"); }
        catch (Exception e) { System.out.println("PASS kirim ke IP tidak ada: " + PrinterClient.message(e)); }
        long t = System.currentTimeMillis();
        PrinterClient.send("127.0.0.1", port, data, 5000);
        System.out.println("PASS kirim " + data.length + " byte (" + (System.currentTimeMillis() - t) + " ms)");
        // dua kasir mencetak bersamaan ke printer yang sama: harus bergantian, tidak bercampur
        Thread[] th = new Thread[2];
        for (int i = 0; i < 2; i++) { th[i] = new Thread(new Runnable() { public void run() { try { PrinterClient.send("127.0.0.1", port, data, 5000); } catch (Exception e) { System.out.println("FAIL " + e); } } }); th[i].start(); }
        for (Thread x : th) x.join();
        System.out.println("PASS dua cetakan bersamaan selesai");
    }
}
