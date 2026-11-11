# MONSTERA Android Hello World

Kotlin + Jetpack Compose. One screen: a tap counter (`rememberSaveable`, so it survives
rotation and process recreation) and the latest Activity lifecycle callback, which is also
logged under the `MonsteraHello` tag.

## Requirements

- JDK 17+ (verified with Android Studio's bundled JBR 21).
- Android SDK with `platforms;android-36` and `build-tools`. Set `ANDROID_HOME` or `local.properties`.

## Build

```bash
cd reference/g0/android
./gradlew assembleDebug          # Windows: .\gradlew.bat assembleDebug
# -> app/build/outputs/apk/debug/app-debug.apk
```

## Emulator: install, launch, screenshot

```bash
emulator -avd <avd-name> -no-window -no-audio -no-snapshot -gpu swiftshader_indirect &
adb wait-for-device
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -W -n app.monstera.hello/.MainActivity
adb exec-out screencap -p > screenshot.png
adb logcat -d -s MonsteraHello
```

Or through Device Lab: `device-lab/android/adapter.sh <op>`, or the full smoke run
`tools/scripts/android-emulator-smoke.sh`.

## Pinned versions

| Component | Version | Note |
|---|---|---|
| Gradle | 9.9.1 | wrapper |
| Android Gradle Plugin | 9.5.1 | built-in Kotlin support, no `kotlin-android` plugin |
| Kotlin Compose compiler plugin | 2.4.21 | |
| Compose BOM | 2026.06.01 | 2026.08.00+ requires compileSdk 37 |
| activity-compose | 1.12.4 | |
| compileSdk / targetSdk / minSdk | 36 / 36 / 26 | |
