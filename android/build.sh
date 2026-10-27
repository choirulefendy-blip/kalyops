#!/bin/bash
# Bangun APK Kaly Ops tanpa Android Studio: aapt + javac + dx + zipalign + apksigner
# (paket Ubuntu: android-sdk-platform-23 aapt dalvik-exchange zipalign apksigner)
set -euo pipefail
cd "$(dirname "$0")"
VERSION_NAME=${VERSION_NAME:-1.0}
VERSION_CODE=${VERSION_CODE:-1}
SDK=${ANDROID_SDK:-/usr/lib/android-sdk}
AJ=$SDK/platforms/android-23/android.jar
KS=${KEYSTORE:-keystore/kaly-ops.jks}
KS_PASS=${KS_PASS:?Isi KS_PASS (kata sandi keystore)}
rm -rf build && mkdir -p build/gen/id/kaly/ops build/obj
cat > build/gen/id/kaly/ops/BuildInfo.java <<JAVA
package id.kaly.ops;
final class BuildInfo { static final String VERSION_NAME = "$VERSION_NAME"; static final int VERSION_CODE = $VERSION_CODE; private BuildInfo() {} }
JAVA
sed -e "s/android:versionCode=\"[0-9]*\"/android:versionCode=\"$VERSION_CODE\"/" -e "s/android:versionName=\"[^\"]*\"/android:versionName=\"$VERSION_NAME\"/" AndroidManifest.xml > build/AndroidManifest.xml
aapt package -f -m -J build/gen -M build/AndroidManifest.xml -S res -I "$AJ" -F build/app.unsigned.apk
javac -nowarn -Xlint:-options -source 8 -target 8 -bootclasspath "$AJ" -encoding UTF-8 -d build/obj $(find src build/gen -name '*.java')
dalvik-exchange --dex --min-sdk-version=21 --output=build/classes.dex build/obj
(cd build && aapt add -f app.unsigned.apk classes.dex >/dev/null)
zipalign -f -p 4 build/app.unsigned.apk build/app.aligned.apk
apksigner sign --ks "$KS" --ks-key-alias kaly-ops --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" --out build/kaly-ops.apk build/app.aligned.apk
apksigner verify build/kaly-ops.apk
echo "APK: $(pwd)/build/kaly-ops.apk ($(stat -c %s build/kaly-ops.apk) byte)"
