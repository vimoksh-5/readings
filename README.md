
# Readings — Glanceable Blood Glucose Monitor (Android)

React Native + native Kotlin foreground service for Libre 2 Plus (and other FreeStyle Libre sensors) via LibreLinkUp cloud sync.

### Key Features
- **🎨 Material Dark UI:** High-contrast, clean typography, smooth ripples, consistent color accents.
- **🏷️ Floating Overlay:** Draggable accessibility-style floating pill over any app (`SYSTEM_ALERT_WINDOW`). Tap to launch Readings, remembers screen position.
- **📊 Advanced Analytics:** Estimated HbA1c (GMI %), Time-in-Range (TIR %) breakdown bar, average glucose, min/max, standard deviation, and CV %.
- **🔕 Silent Background Polling:** Continuous 60s background refresh with 100% silent status notifications (no buzzing every 60s). High/low audible alerts are throttled to every 10 mins.
- **📱 Resizable Home Screen Widget:** Flexible horizontal and vertical sizing (from 1x1 up to 4x3 cells), color-coded range indicators, and automatic stale-data warnings.
- **⚠ Smart Stale Data / Sensor Ended Detection:** Automatically dims and flags readings older than 15 minutes as STALE and older than 30 minutes as SENSOR ENDED across the app, widget, floating bubble, and notification shade.
- **🖼️ Custom App Icon:** Clean, modern blood drop & glucose wave icon across all Android launcher densities.
<img width="270" height="606" alt="Screenshot_20261017-174016" src="https://github.com/user-attachments/assets/908ce149-78fa-4e0d-8355-abe982e5bc7e" />
<img width="270" height="606" alt="Screenshot_20261017-173939" src="https://github.com/user-attachments/assets/639c9120-2fa9-4832-88ff-b5153dfdbb6b" />
<img width="270" height="606" alt="Screenshot_20261017-173926" src="https://github.com/user-attachments/assets/a5c5b071-28ca-452e-b1c6-8e752a7db007" />

## Requirements

- Freestyle Libre 2 Plus sensor paired to the official **LibreLink** app,
  Bluetooth on, uploading.
- LibreLinkUp sharing accepted: LibreLink → Connected Apps → LibreLinkUp.
- Android 8+ (tested target SDK 35). Notifications allowed, battery
  optimization disabled for this app.

## Install (sideload)

Release APK (bundled JS, no Metro needed):

```
android/app/build/outputs/apk/release/app-release.apk   # 45 MB
```

```sh
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

Debug APK needs Metro (`npm start` + `adb reverse tcp:8081 tcp:8081`).

> Release is currently signed with the debug key (see
> `android/app/build.gradle`). Generate your own keystore before Play
> Console upload per https://reactnative.dev/docs/signed-apk-android.

## First run

1. Open **Readings**, pick region (`US`/`EU`/`GLOBAL`/`LA`/`AP` — must match
   your LibreLink account region).
2. Sign in with LibreLinkUp email + password → first shared patient is used.
3. The service starts automatically. Allow notifications when prompted, then
   **Battery: allow** (ignore battery optimizations) so polling survives Doze.
4. Lock the phone: reading appears as an ongoing notification. Long-press
   home screen → Widgets → **Readings / Blood sugar** → place the 4x1 widget.

## Project layout

```
App.tsx                          login + dashboard + settings
src/lib/libreApi.ts              LibreLinkUp client (login/connections/graph),
                                 mg/dL↔mmol/L, trend arrows 1..5
src/lib/store.ts                 AsyncStorage settings (token metadata only)
src/native/GlucoseBridge.ts      NativeModules.GlucoseModule typed bridge
android/.../GlucoseService.kt    foreground poller, notification, re-login
android/.../GlucoseModule.kt     RN bridge (creds in EncryptedSharedPreferences)
android/.../GlucoseWidgetProvider.kt  home-screen widget
android/.../BootReceiver.kt      restart service on boot
android/.../res/layout/widget_glucose.xml
android/.../res/xml/glucose_widget_info.xml
```

Credentials: email/password live only in `EncryptedSharedPreferences`
(fallback: private prefs); AsyncStorage holds token + patientId + display
settings. Token auto-refreshes via stored creds when expired.

## Configuration

- Units mg/dL or mmol/L (÷ 18.01559), low default 70, high default 180.
- Poll interval 60 / 120 / 300s. Under 60s risks HTTP 429 (service backs off
  silently and keeps the last value).
- Readings > 15 min old are flagged **STALE** — keep LibreLink running.

## Build / verify

```sh
npm install
npx tsc --noEmit
npx jest
./gradlew :app:assembleDebug :app:assembleRelease  # in android/
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Invalid email or password` | Wrong region or creds; region must match account. |
| `No shared patients found` | Accept LibreLinkUp invite in LibreLink first. |
| `Session expired` | Re-sign in (password changed or token revoked). |
| `STALE (>15 min)` | LibreLink not uploading / BT off / sensor warm-up. |
| No lockscreen entry | System Settings → Notifications → allow + show on lock screen; keep service `Live`. |
| Service killed | Disable battery optimization; enable autostart/boot receiver. |

## Limitations / disclaimer

- Unofficial use of Abbott's LibreLinkUp endpoints (`api*.libreview.io`,
  `product: llu.android`, `version: 4.16.0`); Abbott can break or block it at
  any time. ~1 min cloud delay; not real-time CGM.
- Informational only. Confirm with LibreLink / fingerstick before treatment
  decisions. Not a medical device.
