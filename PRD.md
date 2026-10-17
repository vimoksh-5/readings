# Product Requirements Document (PRD)
## Project Name: Readings — Continuous Glucose Monitoring Companion (Android / React Native)

---

### 1. Executive Summary & Product Vision
**Readings** is an open, clinically aligned continuous glucose monitoring (CGM) companion application built in **React Native for Android**. Designed specifically for users of the **Abbott FreeStyle Libre 2 Plus** sensor (and compatible 14/15-day continuous BLE sensors), *Readings* bridges the gap between clinical CGM hardware and flexible Android OS user experiences.

The app transforms raw continuous 60-second Bluetooth Low Energy (BLE) interstitial glucose telemetry into actionable, glanceable, and customizable feedback across:
- In-app interactive telemetry dashboards and Ambulatory Glucose Profile (AGP) analytics.
- Android system integrations: Home screen widgets (Material You adaptive), persistent silent status-bar ticker, heads-up sound alerts, Always-On Display (AOD) complications, and an Android system floating overlay (Picture-in-Picture / overlay bubble).

---

### 2. Problem Statement & Target Audience
- **Problem**: Proprietary manufacturer CGM applications often restrict telemetry cadence, offer limited notification customization, lack versatile Android home screen widgets, and do not provide persistent floating glance views or customizable audible broadcast intervals.
- **Target Audience**:
  - Type 1 and Type 2 diabetics managing intensive insulin or lifestyle therapies.
  - Individuals with pre-diabetes, gestational diabetes, or athletes optimizing metabolic stability.
  - Power users seeking open telemetry access on Android without manual NFC tapping every time.

---

### 3. Core Tech Stack & Architectural Foundation
- **Framework**: React Native (Android Target SDK 34+, Material You / Dynamic Colors).
- **Hardware Protocol**: Bluetooth Low Energy (BLE) GATT client connecting directly to Abbott FreeStyle Libre 2 Plus transceivers (polling/stream every 60 seconds).
- **Background Persistence**: Android Foreground Service with continuous wake-lock management and battery optimization whitelist.
- **Audio / Haptic Engine**: Dual-channel dispatcher with custom audio sample playback and notification channel sound overrides (bypassing DND for urgent thresholds).
- **UI Architecture**: Clinical Vitality dark theme (`#0f131c` canvas, `#00e5ff` cyan telemetry accents, `#22c55e` safe target corridor, `#ef4444` hypo alerts).

---

### 4. Key Functional Modules & User Stories

#### Module A: Live Telemetry & Real-Time Monitoring
- **60-Second Auto-Refresh HUD**:
  - Displays instantaneous blood glucose in `mg/dL` (or mmol/L toggle).
  - Trend velocity arrow (e.g., `↑ Rapid Rise`, `→ Steady`, `↓ Rapid Fall`) with numeric rate of change (`+2 mg/dL in 15 min`).
  - Next-telemetry 60s countdown progress ticker.
- **Sensor Telemetry Status**:
  - Libre 2 Plus lifespan badge (countdown of 15-day wear cycle).
  - BLE packet signal strength indicator, battery telemetry, and calibration state.
- **Interactive Glucose Waveform (SVG/Canvas)**:
  - Time ranges: 3H, 12H, 24H.
  - **Y-Axis Clinical Demarcations**:
    - `250 mg/dL`: Hyperglycemic excursion ceiling.
    - `180 mg/dL`: Target ceiling (dashed line).
    - `120 mg/dL`: Target midpoint corridor.
    - `70 mg/dL`: Hypoglycemic floor (dashed line).
    - `50 mg/dL`: Critical urgent floor.
  - **Touch & Hover Scrubbing**: Interactive vertical crosshair that locks to touch coordinates, displaying exact timestamp, glucose value, delta rate (`+1 mg/dL/m`), and glycemic status pill (`IN RANGE`).
  - **Event Markers**: Visual icons on the graph for meal carbs (amber fork/knife) and bolus insulin injections (cyan syringe).
- **Quick Logging Bar**:
  - Instant modal dialogs for `+ Log Carbs`, `+ Log Insulin`, `+ Activity Note`, and fallback `Scan NFC`.

#### Module B: System Integrations & Android Ecosystem
- **Android Floating Overlay Window (`SYSTEM_ALERT_WINDOW` / PiP)**:
  - Movable, persistent semi-transparent pill overlay showing live glucose (`114 mg/dL → Steady (±0)`).
  - Accessible on top of any other Android app, gaming, or GPS navigation.
- **Android Home Screen Widgets**:
  - **4x2 Hero Widget**: Interactive chart, current reading, trend arrow, and quick logging buttons.
  - **2x2 Glance Widget**: Circular Time in Range gauge, sensor days remaining, and current glucose.
  - **4x1 Minimal Ticker**: Ultra-compact launcher ribbon.
- **Always-On Display (AOD) & Lock Screen**:
  - Low-power OLED complication displaying clock, current glucose value, and TIR percentage.

#### Module C: Smart Dual-Tier Notification Engine
1. **Audible Interval Broadcasts**:
   - Cadence configurable: **Every 15 min** (options for 10m, 15m, 30m, 60m).
   - Mode: Text-to-speech reading or acoustic chime signature ("Soft Ripple", "Clinical Tone").
   - Announces glucose levels, trend arrow direction, and delta velocity without waking screen.
2. **Silent Persistent Notification**:
   - Persistent Android notification bar ticker updating silently every **5 minutes** (configurable: 1m, 3m, 5m, 10m).
   - Displays real-time delta, target range status, and mini sparkline.
3. **Clinical Safeguard Alarms**:
   - **Urgent Low Alarm (<55 mg/dL)**: Hardcoded critical safety alert; bypasses Android Do Not Disturb (DND) and Bedtime mode.
   - **Low Glucose Warning (70 mg/dL default)**: Slider configurable between 60–90 mg/dL with customizable alarm tone.
   - **High Glucose Excursion (180 mg/dL default)**: Slider configurable between 140–250 mg/dL with snooze duration timer (default 30 min).
   - **Velocity Alarms**: Rapid drop (>2.0 mg/dL/min) and rapid rise warnings.
   - **Signal Drop Safeguard**: Warns if no BLE packet is received within 20 minutes.

#### Module D: Clinical Analytics & Ambulatory Glucose Profile (AGP)
- **Time Horizons**: 1 Day, 7 Days, **14 Days (Clinical Consensus Standard)**, 30 Days, and Custom Calendar Date Picker.
- **Key Glycemic Metrics**:
  - **Time in Range (TIR)**: International consensus breakdown (Target: >70% in 70–180 mg/dL):
    - Very High (>250 mg/dL, goal <5%)
    - High (181–250 mg/dL, goal <25%)
    - In Target (70–180 mg/dL, goal >70%)
    - Low (54–69 mg/dL, goal <4%)
    - Very Low (<54 mg/dL, goal <1%)
  - **Average Glucose** and Standard Deviation (`SD`).
  - **Estimated GMI / Projected HbA1c** (e.g., `5.9% GMI`).
  - **Coefficient of Variation (CV %)**: Glycemic stability threshold (target ≤ 36%).
  - **Sensor Capture Integrity %**: Verification of total received BLE packets (e.g., 99.8% over 14 days).
- **24h AGP Modal Profile**: Percentile band distribution curves (10th, 25th, 50th median, 75th, 90th percentile) mapping daily circadian glycemic patterns.
- **Algorithmic Insights**: Automated pattern recognition (e.g., Morning Dawn Phenomenon, Evening Postprandial Buffering).
- **Doctor PDF AGP Export**: One-tap export to standardized clinical PDF format for endocrinologist appointments.

#### Module E: Sensor Logbook & Day Playback
- **Calendar Strip Navigation**: Quick weekday swiper with color-coded glycemic dots indicating daily Time in Range quality.
- **Daily Summary Cards**: Daily average, lowest value (with timestamp), highest peak (with timestamp).
- **Chronological 24-Hour Event Timeline**:
  - Structured event cards connecting meals, insulin units, exercise routines, and rapid drop/spike alerts with recovery notes.
  - Filter chips: `All Entries`, `Meals`, `Insulin`, `Warnings`.

---

### 5. Non-Functional Requirements & Compliance
- **Safety & Regulatory Disclaimer**: Prominent disclaimers stating that algorithmically derived trends are for adjunctive informational use; emergency treatment decisions should be cross-verified with capillary fingersticks.
- **Battery Optimization**: BLE background scan window and interval tuned to consume <3.5% of total Android battery per 24 hours.
- **Data Privacy**: Local-first encrypted SQLite database (SQLCipher); no patient biometric data exported without user-initiated authorization.

---

### 6. Release Roadmap & Milestones
- **Phase 1 (MVP)**: BLE GATT communication with Libre 2 Plus, Live HUD, interactive 12h chart, and Android foreground persistent notification.
- **Phase 2 (Safety & Notifications)**: Dual-tier audible/silent notification dispatcher, DND bypass alarms, and Android Home Screen widgets (4x2, 2x2).
- **Phase 3 (Analytics & Logbook)**: 14-day AGP modal profile, clinical HbA1c/GMI calculations, calendar logbook, and doctor PDF export.
- **Phase 4 (Android Enhancements)**: System floating overlay bubble (PiP), AOD complication tiles, and Wear OS companion support.
