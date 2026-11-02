package android.webkit;
// Hanya untuk kompilasi (android.jar API 23 belum punya kelas ini; tersedia di Android 8.0 / API 26 ke atas).
// Tidak ikut dimasukkan ke APK: dipakai lewat -classpath, bukan sumber yang dikompilasi ke classes.dex.
public abstract class RenderProcessGoneDetail {
    public abstract boolean didCrash();
    public abstract int rendererPriorityAtExit();
}
