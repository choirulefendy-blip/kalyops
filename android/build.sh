#!/bin/bash
# Bangun APK Kaly Ops tanpa Android Studio: aapt + javac + dx + zipalign + apksigner
# (paket Ubuntu: android-sdk-platform-23 aapt dalvik-exchange zipalign apksigner)
set -euo pipefail
cd "$(dirname "$0")"
VERSION_NAME=${VERSION_NAME:-1.0}
VERSION_CODE=${VERSION_CODE:-1}
# FLAVOR=ops (bawaan): aplikasi Kaly Ops untuk kasir, dapur, service, gudang → kalyops.vercel.app
# FLAVOR=backoffice: aplikasi Kaly Backoffice untuk Owner/Manajer (paket id.kaly.backoffice) → kalybackoffice.vercel.app
FLAVOR=${FLAVOR:-ops}
case "$FLAVOR" in
  ops) PKG=id.kaly.ops; LABEL="Kaly Ops"; HOME_URL=${HOME_URL:-https://kalyops.vercel.app/}; OUT=kaly-ops.apk ;;
  backoffice) PKG=id.kaly.backoffice; LABEL="Kaly Backoffice"; HOME_URL=${HOME_URL:-https://kalybackoffice.vercel.app/}; OUT=kaly-backoffice.apk ;;
  *) echo "FLAVOR harus ops atau backoffice"; exit 1 ;;
esac
SDK=${ANDROID_SDK:-/usr/lib/android-sdk}
AJ=$SDK/platforms/android-23/android.jar
KS=${KEYSTORE:-keystore/kaly-ops.jks}
KS_PASS=${KS_PASS:?Isi KS_PASS (kata sandi keystore)}
rm -rf build && mkdir -p build/gen/id/kaly/ops build/obj
cat > build/gen/id/kaly/ops/BuildInfo.java <<JAVA
package id.kaly.ops;
final class BuildInfo { static final String VERSION_NAME = "$VERSION_NAME"; static final int VERSION_CODE = $VERSION_CODE; static final String FLAVOR = "$FLAVOR"; static final String HOME = "$HOME_URL"; private BuildInfo() {} }
JAVA
sed -e "s/android:versionCode=\"[0-9]*\"/android:versionCode=\"$VERSION_CODE\"/" -e "s/android:versionName=\"[^\"]*\"/android:versionName=\"$VERSION_NAME\"/" AndroidManifest.xml > build/AndroidManifest.xml
cp -a res build/res
if [ "$FLAVOR" = backoffice ]; then
  # Backoffice: tidak ditawari Android saat printer USB dicolok (itu tugas tablet kasir); ikon & nama sendiri
  python3 - build/AndroidManifest.xml <<'PY'
import re, sys
p = sys.argv[1]; s = open(p, encoding='utf-8').read()
s = re.sub(r'\s*<!-- 1\.4: printer USB dicolok.*?</intent-filter>\s*<meta-data android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED"[^>]*/>', '', s, flags=re.S)
open(p, 'w', encoding='utf-8').write(s)
PY
  for d in res-backoffice/*; do [ -d "$d" ] && cp -a "$d"/. "build/res/$(basename "$d")/"; done
fi
sed -i "s|<string name=\"app_name\">[^<]*</string>|<string name=\"app_name\">$LABEL</string>|" build/res/values/strings.xml
aapt package -f -m -J build/gen -M build/AndroidManifest.xml -S build/res -I "$AJ" --rename-manifest-package "$PKG" -F build/app.unsigned.apk
# 1.6: kelas API 26+ (RenderProcessGoneDetail) hanya stub untuk kompilasi, tidak ikut ke APK
mkdir -p build/stubs && javac -nowarn -Xlint:-options -source 8 -target 8 -bootclasspath "$AJ" -encoding UTF-8 -d build/stubs $(find stubs -name '*.java')
javac -nowarn -Xlint:-options -source 8 -target 8 -bootclasspath "$AJ" -classpath build/stubs -encoding UTF-8 -d build/obj $(find src build/gen -name '*.java')
dalvik-exchange --dex --min-sdk-version=21 --output=build/classes.dex build/obj
(cd build && aapt add -f app.unsigned.apk classes.dex >/dev/null)
zipalign -f -p 4 build/app.unsigned.apk build/app.aligned.apk
apksigner sign --ks "$KS" --ks-key-alias kaly-ops --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" --out "build/$OUT" build/app.aligned.apk
apksigner verify "build/$OUT"
echo "APK $LABEL ($PKG): $(pwd)/build/$OUT ($(stat -c %s "build/$OUT") byte)"
