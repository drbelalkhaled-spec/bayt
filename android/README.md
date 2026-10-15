# Bayt for Android

Bayt is packaged as a Trusted Web Activity using Google's Bubblewrap 1.27.0 and
Android Browser Helper 2.7.4. The APK opens the existing Cloudflare app at
https://bayt.dr-belal-khaled.workers.dev/#/list. Website updates appear in the APK
without rebuilding it. This is a browser-backed app: keep Chrome installed and
up to date. It does not require Chrome's PWA installation service.

The package is `dev.workers.dr_belal_khaled.bayt`, version 1.0.0 (code 1), with
minimum Android 7 and target Android 16. It contains no native architecture-specific
libraries, so the same APK works on ARM and x86 devices. The intended device is a
Redmi A5 running Android 15; physical-device testing is still required.

## Install on the Redmi

1. Transfer `releases/Bayt-1.0.0.apk` to the phone.
2. Open it in Files or Downloads. If Android asks, enable **Allow from this source**
   for the app opening the APK, then install it. The permission can be disabled
   again afterward.
3. Open **Bayt** from the phone's app list. If the nanny is not already signed in,
   create an **Invite nanny** link from a parent's Bayt Settings and open it on
   her phone. Do not use the household setup code to create another household.
4. In Bayt Settings, enable notifications and allow the requested permission.
   Check chat, tasks, photos, voice messages, and a notification on the phone.

## Fullscreen verification

Deploy `public/.well-known/assetlinks.json` to the existing Worker using the normal
website deployment. It binds this package to its public signing certificate. The
live endpoint must serve JSON, without login or redirects, at:

https://bayt.dr-belal-khaled.workers.dev/.well-known/assetlinks.json

Until it is deployed and Chrome verifies it, the APK opens Bayt with a browser
toolbar. The same APK switches to a Trusted Web Activity once verification works;
no rebuild is needed. Chrome can cache failed verification, so close/reopen Bayt
and allow time for re-verification after deployment.

The original phone-specific Chrome installation failure was not reproduced.
This APK bypasses the PWA installation step, while retaining the web app's browser
runtime, Web Push, offline cache, camera and microphone support. These features
still depend on Chrome support, permissions, and the phone's background settings.

## Signing key: keep a private backup

`android/signing/` contains the release keystore, its password, and a public
certificate. It is ignored by Git. Back up this folder securely: future APK
updates must use this same key. Do not distribute the folder with the APK or
publish the password. The APK contains no household setup code or login token.

## Rebuild on Windows

Use JDK 21, Android SDK platform 36, and build tools 36.0.0. Set `JAVA_HOME` and
`ANDROID_HOME`, or pass their paths explicitly:

```powershell
./android/build-apk.ps1 -JdkPath 'C:/path/to/jdk' -AndroidSdkPath 'C:/path/to/android-sdk'
```

This runs the Gradle release build and Android lint, aligns and signs the APK,
verifies its signature, and writes the APK plus SHA-256 checksum into `releases/`.
No Cloudflare deployment is performed by the build script.

For a new Android release, increment `versionCode`/`versionName` in
`app/build.gradle` and `appVersionCode`/`appVersion` in `twa-manifest.json` together.
Normal website changes do not need an APK rebuild.

The generated project uses Gradle 8.14.3 and Android Gradle Plugin 8.13.0 with
Google Maven and Maven Central repositories. The Java launcher and delegation
service are generated Bubblewrap code. To regenerate, use Bubblewrap with
`twa-manifest.json` and preserve these Gradle settings and the original signing key.

References: [Chrome TWA documentation](https://developer.chrome.com/docs/android/trusted-web-activity)
and [setup and verification](https://developer.chrome.com/docs/android/trusted-web-activity/quick-start).
