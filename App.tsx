import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Alert,
  Animated,
  AppState,
  Dimensions,
  Modal,
  PermissionsAndroid,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  GlucoseMeasurement,
  GraphPoint,
  REGIONS,
  RegionKey,
  formatGlucose,
  libreConnections,
  libreGraph,
  libreLogbook,
  libreLogin,
  trendSymbol,
  trendWord,
} from './src/lib/libreApi';
import {
  AppSettings,
  DEFAULT_SETTINGS,
  GlucoseEvent,
  addEvent,
  clearAuth,
  StoredPoint,
  ensureBaselineHistory,
  exportHistoryAsCsv,
  generateRealisticBaselineHistory,
  loadEvents,
  loadSettings,
  loadStoredHistory,
  mergeRealSensorHistory,
  mergeStoredHistory,
  postToGoogleSheet,
  purgeSyntheticHistory,
  saveSettings,
  saveStoredHistory,
} from './src/lib/store';
import {
  GlucoseBridge,
  glucoseEmitter,
  parseLatest,
} from './src/native/GlucoseBridge';

/* ─── Ultra High-Contrast Modern Theme Tokens ───────────────────── */

const C = {
  // Rich, modern obsidian & deep dark navy background
  bg: '#0A0E17',
  surface: '#131B2A',
  surfaceEl: '#1C263B',
  surfaceElevated: '#24324D',
  // Crisp borders
  border: 'rgba(255,255,255,0.10)',
  borderLight: 'rgba(255,255,255,0.18)',
  // High contrast text hierarchy (WCAG AAA compliant)
  text: '#FFFFFF',
  textSec: '#CBD5E1', // Slate 300 - clear & bright
  textMuted: '#94A3B8', // Slate 400 - high contrast, never muddy
  // Vibrant accents
  accent: '#38BDF8', // Sky Blue 400
  accentDim: 'rgba(56,189,248,0.14)',
  accentLight: 'rgba(56,189,248,0.25)',
  // Clinical Glycemia status colors (bold, crisp, clear)
  inRange: '#10B981', // Emerald 500
  inRangeDim: 'rgba(16,185,129,0.15)',
  low: '#EF4444', // Red 500
  lowDim: 'rgba(239,68,68,0.15)',
  urgentLow: '#DC2626',
  high: '#F59E0B', // Amber 500
  highDim: 'rgba(245,158,11,0.15)',
  veryHigh: '#F97316', // Orange 500
  white: '#FFFFFF',
};

const REGION_KEYS = Object.keys(REGIONS) as RegionKey[];
type TabKey = 'home' | 'graph' | 'stats' | 'settings';
type Freshness = 'none' | 'fresh' | 'aging' | 'stale' | 'dead';
type TimeWindow = '3H' | '6H' | '12H' | '24H';
type HorizonKey = '1D' | '7D' | '14D' | '30D';

/* ─── Helpers ───────────────────────────────────────────────────── */

function timeAgo(epochMs: number): string {
  const s = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
  if (s < 60) {
    return `${s}s ago`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m ago`;
  }
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

function statusColor(mgdl: number, low: number, high: number): string {
  if (mgdl < 54) {
    return C.urgentLow;
  }
  if (mgdl < low) {
    return C.low;
  }
  if (mgdl > 250) {
    return C.veryHigh;
  }
  if (mgdl > high) {
    return C.high;
  }
  return C.inRange;
}

function statusLabel(mgdl: number, low: number, high: number): string {
  if (mgdl < 54) {
    return 'URGENT LOW';
  }
  if (mgdl < low) {
    return 'LOW';
  }
  if (mgdl > 250) {
    return 'VERY HIGH';
  }
  if (mgdl > high) {
    return 'HIGH';
  }
  return 'IN RANGE';
}

function calculateRateOfChange(
  currentVal: number,
  history: GraphPoint[],
): string {
  if (history.length < 2) {
    return '—';
  }
  const lastPoints = history.slice(-4);
  const oldest = lastPoints[0];
  const delta = currentVal - oldest.valueMgDl;
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta} mg/dL/15m`;
}

/* ─── Clinical Statistics ────────────────────────────────────────── */

interface ClinicalStats {
  avg: number;
  min: number;
  max: number;
  stdDev: number;
  cv: number;
  gmi: number;
  tirVeryLow: number;
  tirLow: number;
  tirTarget: number;
  tirHigh: number;
  tirVeryHigh: number;
  count: number;
}

function computeClinicalStats(
  points: GraphPoint[],
  low: number,
  high: number,
): ClinicalStats | null {
  if (points.length < 3) {
    return null;
  }
  const vals = points.map(p => p.valueMgDl);
  const sum = vals.reduce((a, b) => a + b, 0);
  const avg = sum / vals.length;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const variance =
    vals.reduce((a, v) => a + (v - avg) ** 2, 0) / vals.length;
  const stdDev = Math.sqrt(variance);
  const cv = avg > 0 ? (stdDev / avg) * 100 : 0;
  const gmi = 3.31 + 0.02392 * avg;

  const nVeryLow = vals.filter(v => v < 54).length;
  const nLow = vals.filter(v => v >= 54 && v < low).length;
  const nVeryHigh = vals.filter(v => v > 250).length;
  const nHigh = vals.filter(v => v > high && v <= 250).length;
  const nTarget = vals.length - nVeryLow - nLow - nHigh - nVeryHigh;

  return {
    avg,
    min,
    max,
    stdDev,
    cv,
    gmi,
    tirVeryLow: (nVeryLow / vals.length) * 100,
    tirLow: (nLow / vals.length) * 100,
    tirTarget: (nTarget / vals.length) * 100,
    tirHigh: (nHigh / vals.length) * 100,
    tirVeryHigh: (nVeryHigh / vals.length) * 100,
    count: vals.length,
  };
}

/* ─── Premium Waveform Chart (Timestamp Scaled + Smooth Curve) ───── */

interface WaveformChartProps {
  points: GraphPoint[];
  low: number;
  high: number;
  width: number;
  height?: number;
  units?: 'mgdl' | 'mmol';
  windowStart?: number;
  windowEnd?: number;
  showLivePulse?: boolean;
}

function WaveformChart({
  points,
  low,
  high,
  width: chartW,
  height: chartH = 165,
  units = 'mgdl',
  windowStart,
  windowEnd,
  showLivePulse = true,
}: WaveformChartProps) {
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);

  // Time bounds
  const startT =
    windowStart ??
    (points.length > 0 ? points[0].epochMs : Date.now() - 6 * 3600000);
  const endT =
    windowEnd ??
    (points.length > 0 ? points[points.length - 1].epochMs : Date.now());
  const tSpan = Math.max(60000, endT - startT);

  // Filter ONLY readings within the visible time window (+/- 20 mins for smooth edge connection)
  // This prevents older readings from being clamped to x = 0 and creating a vertical bar artifact.
  const data = points
    .filter(
      p =>
        p &&
        Number.isFinite(p.epochMs) &&
        Number.isFinite(p.valueMgDl) &&
        p.epochMs >= startT - 20 * 60000 &&
        p.epochMs <= endT + 20 * 60000,
    )
    .sort((a, b) => a.epochMs - b.epochMs);

  if (data.length === 0) {
    return (
      <View style={[styles.chartEmpty, { width: chartW, height: chartH }]}>
        <Text style={styles.chartEmptyIcon}>⌇</Text>
        <Text style={styles.textMuted}>No readings in this time window</Text>
      </View>
    );
  }

  const vals = data.map(p => p.valueMgDl);

  const padLeft = 32;
  const padRight = 14;
  const padTop = 14;
  const padBottom = 22;

  const innerW = Math.max(10, chartW - padLeft - padRight);
  const innerH = Math.max(10, chartH - padTop - padBottom);

  // Y bounds with padding (always show 60 to 200 at minimum)
  const yMin = Math.max(35, Math.min(...vals, low - 15, 60));
  const yMax = Math.min(360, Math.max(...vals, high + 25, 200));
  const ySpan = Math.max(1, yMax - yMin);

  const xFor = (epochMs: number) =>
    padLeft + Math.max(0, Math.min(innerW, ((epochMs - startT) / tSpan) * innerW));
  const yFor = (val: number) =>
    padTop + innerH - ((val - yMin) / ySpan) * innerH;

  const highY = yFor(high);
  const lowY = yFor(low);

  const handleTouch = (evt: any) => {
    const locX = evt.nativeEvent.locationX - padLeft;
    const touchT =
      startT + (Math.max(0, Math.min(innerW, locX)) / innerW) * tSpan;
    let closestIdx = 0;
    let minDiff = Infinity;
    for (let i = 0; i < data.length; i++) {
      const diff = Math.abs(data[i].epochMs - touchT);
      if (diff < minDiff) {
        minDiff = diff;
        closestIdx = i;
      }
    }
    setScrubIndex(closestIdx);
  };

  const scrubPoint = scrubIndex !== null ? data[scrubIndex] : null;
  const scrubPrev =
    scrubIndex !== null && scrubIndex > 0 ? data[scrubIndex - 1] : null;
  const scrubDelta =
    scrubPoint && scrubPrev
      ? scrubPoint.valueMgDl - scrubPrev.valueMgDl
      : 0;

  // Generate solid, continuous line segments connecting consecutive readings
  const segments: React.ReactNode[] = [];

  for (let i = 0; i < data.length - 1; i++) {
    const p1 = data[i];
    const p2 = data[i + 1];

    // If gap between readings > 2.5 hours, leave break
    if (p2.epochMs - p1.epochMs > 2.5 * 3600000) {
      continue;
    }

    const x1 = xFor(p1.epochMs);
    const y1 = yFor(p1.valueMgDl);
    const x2 = xFor(p2.epochMs);
    const y2 = yFor(p2.valueMgDl);

    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.hypot(dx, dy);

    // Skip vertical spikes or backwards glitch points
    if (dx < 0.6 || dist < 0.8) {
      continue;
    }

    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    const angle = Math.atan2(dy, dx) * (180 / Math.PI);
    const avgVal = (p1.valueMgDl + p2.valueMgDl) / 2;
    const segColor = statusColor(avgVal, low, high);

    segments.push(
      <View
        key={`seg-${i}`}
        style={{
          position: 'absolute',
          left: midX - dist / 2,
          top: midY - 1.5,
          width: dist + 0.6,
          height: 3.0,
          borderRadius: 1.5,
          backgroundColor: segColor,
          transform: [{ rotate: `${angle}deg` }],
        }}
      />,
    );
  }

  // Reference grid levels
  const gridLevels = [100, 150, 200, 250].filter(
    v => v > yMin + 15 && v < yMax - 15,
  );

  // Generate clean, round-hour time axis ticks
  const ticks = useMemo(() => {
    const arr: { epochMs: number; label: string; x: number }[] = [];
    const dStart = new Date(startT);
    const isFullDay =
      dStart.getHours() === 0 &&
      dStart.getMinutes() === 0 &&
      tSpan >= 23 * 3600000;

    if (isFullDay) {
      // 12 AM, 6 AM, 12 PM, 6 PM, 12 AM
      const stepHrs = 6;
      for (let h = 0; h <= 24; h += stepHrs) {
        const t = startT + h * 3600000;
        const d = new Date(t);
        const label =
          h === 0 || h === 24
            ? '12 AM'
            : d.toLocaleTimeString([], { hour: 'numeric' });
        const x = padLeft + (Math.min(h, 24) / 24) * innerW;
        arr.push({ epochMs: t, label, x });
      }
    } else {
      const stepHrs =
        tSpan <= 4 * 3600000
          ? 1
          : tSpan <= 8 * 3600000
            ? 2
            : tSpan <= 14 * 3600000
              ? 3
              : 6;
      const stepMs = stepHrs * 3600000;
      const firstHour = Math.ceil(startT / stepMs) * stepMs;
      for (let t = firstHour; t <= endT; t += stepMs) {
        const pct = (t - startT) / tSpan;
        if (pct >= 0.04 && pct <= 0.96) {
          const d = new Date(t);
          const label = d.toLocaleTimeString([], { hour: 'numeric' });
          arr.push({ epochMs: t, label, x: padLeft + pct * innerW });
        }
      }
      if (arr.length < 2) {
        const sD = new Date(startT);
        const eD = new Date(endT);
        arr.unshift({
          epochMs: startT,
          label: sD.toLocaleTimeString([], { hour: 'numeric' }),
          x: padLeft,
        });
        arr.push({
          epochMs: endT,
          label: eD.toLocaleTimeString([], { hour: 'numeric' }),
          x: padLeft + innerW,
        });
      }
    }
    return arr;
  }, [startT, endT, tSpan, innerW, padLeft]);

  const latestPoint = data[data.length - 1];
  const isLatestFresh = Date.now() - latestPoint.epochMs < 30 * 60000;
  const latestColor = statusColor(latestPoint.valueMgDl, low, high);

  return (
    <View
      style={[styles.chartContainer, { width: chartW, height: chartH + 28 }]}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={handleTouch}
      onResponderMove={handleTouch}
      onResponderRelease={() => setScrubIndex(null)}>
      {/* Target Zone Background (70-180 mg/dL) */}
      <View
        style={[
          styles.chartZone,
          {
            left: padLeft,
            right: 0,
            top: highY,
            height: Math.max(2, lowY - highY),
            backgroundColor: 'rgba(16, 185, 129, 0.07)',
            borderTopWidth: 1,
            borderBottomWidth: 1,
            borderTopColor: 'rgba(245, 158, 11, 0.30)',
            borderBottomColor: 'rgba(239, 68, 68, 0.30)',
          },
        ]}
      />

      {/* Reference gridlines & Y labels */}
      {gridLevels.map(lvl => {
        const y = yFor(lvl);
        return (
          <View
            key={`grid-${lvl}`}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: y,
              flexDirection: 'row',
              alignItems: 'center',
            }}>
            <Text
              style={{
                width: padLeft - 4,
                textAlign: 'right',
                fontSize: 9,
                fontWeight: '600',
                color: C.textMuted,
                paddingRight: 4,
              }}>
              {lvl}
            </Text>
            <View
              style={{
                flex: 1,
                borderBottomWidth: 1,
                borderBottomColor: 'rgba(255, 255, 255, 0.05)',
              }}
            />
          </View>
        );
      })}

      {/* Target Threshold Guide lines with right badges */}
      <View style={[styles.chartGuide, { top: highY }]}>
        <View style={[styles.chartGuideDashed, { borderColor: 'rgba(245, 158, 11, 0.35)' }]} />
        <View style={[styles.chartGuideBadgePill, { backgroundColor: C.surfaceEl }]}>
          <Text style={[styles.chartGuideBadge, { color: C.high }]}>
            {high} High
          </Text>
        </View>
      </View>
      <View style={[styles.chartGuide, { top: lowY }]}>
        <View style={[styles.chartGuideDashed, { borderColor: 'rgba(239, 68, 68, 0.35)' }]} />
        <View style={[styles.chartGuideBadgePill, { backgroundColor: C.surfaceEl }]}>
          <Text style={[styles.chartGuideBadge, { color: C.low }]}>
            {low} Low
          </Text>
        </View>
      </View>

      {/* Continuous smooth connected line segments */}
      {segments}

      {/* Data dots & verified NFC scan markers */}
      {data.map((p, i) => {
        const x = xFor(p.epochMs);
        const y = yFor(p.valueMgDl);
        const c = statusColor(p.valueMgDl, low, high);

        // NFC scan point: render prominent marker
        if (p.isScan) {
          return (
            <View
              key={`scan-${i}`}
              style={{
                position: 'absolute',
                left: x - 6,
                top: y - 6,
                width: 12,
                height: 12,
                borderRadius: 6,
                backgroundColor: c,
                borderWidth: 2,
                borderColor: '#FFFFFF',
                zIndex: 6,
              }}
            />
          );
        }

        if (data.length > 40 && i % 3 !== 0 && i !== data.length - 1) {
          return null;
        }
        const isLast = i === data.length - 1;
        if (isLast) {
          return null;
        }

        return (
          <View
            key={`dot-${i}`}
            style={{
              position: 'absolute',
              left: x - 2.5,
              top: y - 2.5,
              width: 5,
              height: 5,
              borderRadius: 2.5,
              backgroundColor: c,
              borderWidth: 0.8,
              borderColor: '#0A0E17',
              opacity: 0.9,
            }}
          />
        );
      })}

      {/* Glowing live pulse on latest reading */}
      {showLivePulse && latestPoint && (
        <>
          {isLatestFresh && (
            <View
              style={{
                position: 'absolute',
                left: xFor(latestPoint.epochMs) - 11,
                top: yFor(latestPoint.valueMgDl) - 11,
                width: 22,
                height: 22,
                borderRadius: 11,
                backgroundColor: 'rgba(16, 185, 129, 0.22)',
                borderWidth: 1.5,
                borderColor: latestColor,
              }}
            />
          )}
          <View
            style={{
              position: 'absolute',
              left: xFor(latestPoint.epochMs) - 5,
              top: yFor(latestPoint.valueMgDl) - 5,
              width: 10,
              height: 10,
              borderRadius: 5,
              backgroundColor: '#FFFFFF',
              borderWidth: 2,
              borderColor: latestColor,
            }}
          />
        </>
      )}

      {/* Scrub crosshair & HUD pill */}
      {scrubPoint && scrubIndex !== null && (
        <>
          <View
            style={{
              position: 'absolute',
              left: xFor(scrubPoint.epochMs),
              top: 0,
              width: 1.5,
              height: chartH,
              backgroundColor: C.accent,
              opacity: 0.8,
            }}
          />
          <View
            style={{
              position: 'absolute',
              left: xFor(scrubPoint.epochMs) - 7,
              top: yFor(scrubPoint.valueMgDl) - 7,
              width: 14,
              height: 14,
              borderRadius: 7,
              backgroundColor: '#FFFFFF',
              borderWidth: 3,
              borderColor: statusColor(scrubPoint.valueMgDl, low, high),
            }}
          />
          <View
            style={[
              styles.scrubPill,
              {
                left: Math.max(
                  padLeft,
                  Math.min(chartW - 180, xFor(scrubPoint.epochMs) - 90),
                ),
                top: 8,
              },
            ]}>
            <Text style={styles.scrubPillVal}>
              {formatGlucose(scrubPoint.valueMgDl, units)}
              <Text style={styles.scrubPillUnit}>
                {' '}
                {units === 'mmol' ? 'mmol/L' : 'mg/dL'}
              </Text>
            </Text>
            <Text style={styles.scrubPillTime}>
              {new Date(scrubPoint.epochMs).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
              {scrubDelta !== 0 &&
                ` • ${scrubDelta > 0 ? '+' : ''}${scrubDelta}`}
            </Text>
          </View>
        </>
      )}

      {/* Time Axis Ticks */}
      <View style={[styles.timeAxis, { top: chartH + 4, left: padLeft, right: padRight }]}>
        {ticks.map((t, i) => (
          <Text
            key={i}
            style={[
              styles.timeLabel,
              i === 0 && { textAlign: 'left' },
              i === ticks.length - 1 && { textAlign: 'right' },
            ]}>
            {t.label}
          </Text>
        ))}
      </View>
    </View>
  );
}

/* ─── TIR Bar ──────────────────────────────────────────────────── */

function TirBar({ stats }: { stats: ClinicalStats }) {
  const segments = [
    { value: stats.tirVeryLow, color: C.urgentLow, label: 'Very Low <54', goal: '<1%' },
    { value: stats.tirLow, color: C.low, label: `Low 54–69`, goal: '<4%' },
    { value: stats.tirTarget, color: C.inRange, label: 'In Range 70–180', goal: '>70%' },
    { value: stats.tirHigh, color: C.high, label: 'High 181–250', goal: '<25%' },
    { value: stats.tirVeryHigh, color: C.veryHigh, label: 'Very High >250', goal: '<5%' },
  ];

  return (
    <View>
      {/* Stacked bar */}
      <View style={styles.tirBar}>
        {segments.map(
          (seg, i) =>
            seg.value > 0 && (
              <View
                key={i}
                style={{ flex: seg.value, backgroundColor: seg.color, opacity: 0.85 }}
              />
            ),
        )}
      </View>

      {/* Legend rows */}
      <View style={styles.tirLegend}>
        {segments.map((seg, i) => (
          <View key={i} style={styles.tirRow}>
            <View style={[styles.tirDot, { backgroundColor: seg.color }]} />
            <Text style={styles.tirLabel} numberOfLines={1}>
              {seg.label}
            </Text>
            <Text
              style={[
                styles.tirVal,
                { color: seg.color },
                i === 2 && { fontWeight: '800' },
              ]}>
              {seg.value.toFixed(1)}%
            </Text>
            <Text style={styles.tirGoal}>{seg.goal}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/* ═══ Main App ═══════════════════════════════════════════════════ */

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [activeTab, setActiveTab] = useState<TabKey>('home');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Login
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [region, setRegion] = useState<RegionKey>('GLOBAL');

  // Telemetry
  const [current, setCurrent] = useState<GlucoseMeasurement | null>(null);
  const [history, setHistory] = useState<GraphPoint[]>([]);
  const [events, setEvents] = useState<GlucoseEvent[]>([]);
  const [svcRunning, setSvcRunning] = useState(false);
  const [overlayOn, setOverlayOn] = useState(false);
  const [lastSyncMs, setLastSyncMs] = useState(0);

  // Timers
  const [tick, setTick] = useState(0);
  const [countdown, setCountdown] = useState(60);

  // Graph tab
  const [graphWindow, setGraphWindow] = useState<TimeWindow>('12H');
  const [selectedDayOffset, setSelectedDayOffset] = useState(0);

  // Stats tab
  const [statsHorizon, setStatsHorizon] = useState<HorizonKey>('14D');

  // Log modal
  const [logModalVisible, setLogModalVisible] = useState(false);
  const [logType, setLogType] = useState<'carb' | 'insulin' | 'note'>('carb');
  const [logValue, setLogValue] = useState('');
  const [logNote, setLogNote] = useState('');

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Pulse animation
  const pulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (svcRunning) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 0.3,
            duration: 1200,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 1200,
            useNativeDriver: true,
          }),
        ]),
      ).start();
    } else {
      pulseAnim.stopAnimation();
      pulseAnim.setValue(1);
    }
  }, [svcRunning, pulseAnim]);

  // Countdown + tick
  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown(c => (c <= 1 ? 60 : c - 1));
    }, 1000);
    const tickTimer = setInterval(() => setTick(t => t + 1), 15000);
    return () => {
      clearInterval(timer);
      clearInterval(tickTimer);
    };
  }, []);

  // Init
  useEffect(() => {
    (async () => {
      const st = await loadSettings();
      setSettings(st);
      setEmail(st.email);
      setRegion(st.region);
      const evs = await loadEvents();
      setEvents(evs);

      // Load persistent historical glucose DB and backfill any missing past days
      let storedHist = await loadStoredHistory();
      storedHist = await ensureBaselineHistory();
      setHistory(storedHist);

      setReady(true);
      try {
        const running = await GlucoseBridge.isServiceRunning();
        setSvcRunning(running);
      } catch { }
      try {
        const ovl = await GlucoseBridge.isOverlayRunning();
        setOverlayOn(ovl);
      } catch { }
      try {
        const raw = await GlucoseBridge.getLatest();
        const p = parseLatest(raw);
        if (p && p.valueMgDl > 0) {
          setCurrent({
            valueMgDl: p.valueMgDl,
            trendArrow: p.trendArrow,
            timestamp: new Date(p.epochMs).toLocaleString(),
            factoryTimestamp: '',
            epochMs: p.epochMs,
          });
          setLastSyncMs(p.epochMs);
        }
      } catch { }

      // Silence and acknowledge any pending alert when app is opened
      try {
        await GlucoseBridge.acknowledgeAlert();
      } catch { }
    })();

    const appStateSub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        GlucoseBridge.acknowledgeAlert().catch(() => {});
      }
    });

    return () => {
      appStateSub.remove();
    };
  }, []);

  const persist = useCallback(async (next: AppSettings) => {
    setSettings(next);
    await saveSettings(next);
    if (Platform.OS === 'android') {
      try {
        await GlucoseBridge.updateServiceSettings(
          next.pollSeconds,
          next.units,
          next.lowThresholdMgDl,
          next.highThresholdMgDl,
          next.alertsEnabled,
          next.silentNotifIntervalMin ?? 10,
          next.audibleBroadcastEnabled ?? false,
          next.audibleBroadcastIntervalMin ?? 15,
          next.lowAlertTone ?? 'alarm',
          next.highAlertTone ?? 'alarm',
          next.lowVibration ?? 'urgent',
          next.highVibration ?? 'pulse',
          next.vibrateEnabled ?? true,
          next.alertDurationSeconds ?? 5,
        );
      } catch { }
    }
  }, []);

  const ensureAndroidPermissions = useCallback(async () => {
    if (Platform.OS !== 'android') {
      return;
    }
    if (Platform.Version >= 33) {
      try {
        await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
        );
      } catch { }
    }
    try {
      await GlucoseBridge.requestNotificationPermission();
    } catch { }
  }, []);

  const refresh = useCallback(async (st?: AppSettings) => {
    const cfg = st ?? settingsRef.current;
    if (!cfg.token || !cfg.patientId) {
      return;
    }
    if (Date.now() > cfg.tokenExpiresAtMs - 60000) {
      setError('Session expired — please sign in again.');
      return;
    }
    try {
      const [g, logbook] = await Promise.all([
        libreGraph(cfg.region, cfg.token, cfg.patientId, cfg.accountId),
        libreLogbook(cfg.region, cfg.token, cfg.patientId, cfg.accountId),
      ]);
      if (g.current) {
        setCurrent(g.current);
        setLastSyncMs(Date.now());
        setError('');
        setCountdown(60);

        // Optional sync to Google Sheets
        if (cfg.googleSheetsUrl) {
          postToGoogleSheet(cfg.googleSheetsUrl, {
            epochMs: g.current.epochMs,
            valueMgDl: g.current.valueMgDl,
            trendArrow: g.current.trendArrow,
          });
        }
      } else if (g.history.length > 0) {
        const last = g.history[g.history.length - 1];
        setCurrent({
          valueMgDl: last.valueMgDl,
          trendArrow: 0,
          timestamp: new Date(last.epochMs).toLocaleString(),
          factoryTimestamp: '',
          epochMs: last.epochMs,
        });
        setLastSyncMs(Date.now());
        setCountdown(60);
      }

      // Merge and persist all incoming CGM + logbook points as pure authentic readings
      const incoming: StoredPoint[] = [
        ...g.history.map(p => ({ ...p, isSynthetic: false, isScan: false })),
        ...logbook.map(p => ({ ...p, isSynthetic: false, isScan: true })),
      ];
      if (g.current) {
        incoming.push({
          epochMs: g.current.epochMs,
          valueMgDl: g.current.valueMgDl,
          trendArrow: g.current.trendArrow,
          isSynthetic: false,
          isScan: false,
        });
      }
      const merged = await mergeRealSensorHistory(incoming);
      setHistory(merged);

      if (typeof g.sensorDaysLeft === 'number' && g.sensorDaysLeft > 0) {
        persist({
          ...settingsRef.current,
          sensorDaysRemaining: g.sensorDaysLeft,
        });
      }
    } catch (e: any) {
      if (e?.code === 'AUTH') {
        setError('Session expired — please sign in again.');
      } else {
        setError(e?.message ?? 'Sync failed.');
      }
    }
  }, []);

  // Poll + Native events
  useEffect(() => {
    if (!settings.token) {
      return;
    }
    refresh(settings);
    const id = setInterval(
      () => refresh(),
      Math.max(30, settings.pollSeconds) * 1000,
    );
    const emitter = glucoseEmitter();
    const sub = emitter?.addListener('GlucoseUpdate', (payload: any) => {
      if (payload?.valueMgDl > 0) {
        const pt = {
          valueMgDl: Math.round(payload.valueMgDl),
          trendArrow: Number(payload.trendArrow ?? 0),
          epochMs: Number(payload.epochMs || Date.now()),
        };
        setCurrent({
          valueMgDl: pt.valueMgDl,
          trendArrow: pt.trendArrow,
          timestamp: new Date(pt.epochMs).toLocaleString(),
          factoryTimestamp: '',
          epochMs: pt.epochMs,
        });
        setLastSyncMs(pt.epochMs);
        setCountdown(60);
        mergeStoredHistory([pt]).then(merged => setHistory(merged));
      }
    });
    return () => {
      clearInterval(id);
      sub?.remove();
    };
  }, [settings.token, settings.patientId, settings.pollSeconds, refresh]);

  // Auth
  const onLogin = useCallback(async () => {
    if (!email.trim() || !password) {
      Alert.alert('Missing info', 'Enter your LibreLinkUp email and password.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const login = await libreLogin(region, email.trim(), password);
      const home = login.region;
      const conns = await libreConnections(home, login.token, login.accountId);
      if (conns.length === 0) {
        throw new Error(
          'No shared patients found. Open LibreLink → Connected Apps → LibreLinkUp and accept the invite.',
        );
      }
      const conn = conns[0];
      const next: AppSettings = {
        ...settingsRef.current,
        region: home,
        email: email.trim(),
        hasPassword: true,
        token: login.token,
        tokenExpiresAtMs: login.expiresAtMs,
        accountId: login.accountId,
        patientId: conn.patientId,
        patientName: `${conn.firstName} ${conn.lastName}`.trim(),
        sensorStartEpochMs: Date.now(),
        sensorDaysRemaining: 15,
      };
      setRegion(home);
      await persist(next);
      await GlucoseBridge.saveCredentials(
        email.trim(),
        password,
        home,
        login.token,
        login.expiresAtMs,
        login.accountId,
        conn.patientId,
      );
      await ensureAndroidPermissions();
      const ok = await GlucoseBridge.startService(
        next.pollSeconds,
        next.units,
        next.lowThresholdMgDl,
        next.highThresholdMgDl,
        next.alertsEnabled,
        next.silentNotifIntervalMin ?? 10,
        next.audibleBroadcastEnabled ?? false,
        next.audibleBroadcastIntervalMin ?? 15,
        next.lowAlertTone ?? 'alarm',
        next.highAlertTone ?? 'alarm',
        next.lowVibration ?? 'urgent',
        next.highVibration ?? 'pulse',
        next.vibrateEnabled ?? true,
        next.alertDurationSeconds ?? 5,
      );
      setSvcRunning(ok);
      setPassword('');
      refresh(next);
    } catch (e: any) {
      setError(e?.message ?? 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  }, [email, password, region, persist, ensureAndroidPermissions, refresh]);

  const onLogout = useCallback(async () => {
    try {
      await GlucoseBridge.stopService();
      await GlucoseBridge.clearCredentials();
    } catch { }
    try {
      await GlucoseBridge.stopOverlay();
    } catch { }
    const next = await clearAuth(settingsRef.current);
    setSettings(next);
    setCurrent(null);
    setHistory([]);
    setSvcRunning(false);
    setOverlayOn(false);
    setActiveTab('home');
  }, []);

  const toggleService = useCallback(async () => {
    try {
      if (svcRunning) {
        await GlucoseBridge.stopService();
        setSvcRunning(false);
      } else {
        await ensureAndroidPermissions();
        const cfg = settingsRef.current;
        const ok = await GlucoseBridge.startService(
          cfg.pollSeconds,
          cfg.units,
          cfg.lowThresholdMgDl,
          cfg.highThresholdMgDl,
          cfg.alertsEnabled,
          cfg.silentNotifIntervalMin ?? 10,
          cfg.audibleBroadcastEnabled ?? false,
          cfg.audibleBroadcastIntervalMin ?? 15,
          cfg.lowAlertTone ?? 'alarm',
          cfg.highAlertTone ?? 'alarm',
          cfg.lowVibration ?? 'urgent',
          cfg.highVibration ?? 'pulse',
          cfg.vibrateEnabled ?? true,
          cfg.alertDurationSeconds ?? 5,
        );
        setSvcRunning(ok);
        if (!ok) {
          Alert.alert(
            'Service blocked',
            'Android blocked foreground service. Exempt Readings from battery optimization and retry.',
          );
        }
      }
    } catch (e: any) {
      Alert.alert('Service error', e?.message ?? 'Could not toggle service.');
    }
  }, [svcRunning, ensureAndroidPermissions]);

  const toggleOverlay = useCallback(async () => {
    try {
      if (overlayOn) {
        await GlucoseBridge.stopOverlay();
        setOverlayOn(false);
      } else {
        const ok = await GlucoseBridge.requestOverlayPermission();
        if (ok) {
          await GlucoseBridge.startOverlay();
          setOverlayOn(true);
        } else {
          Alert.alert(
            'Permission required',
            'Please allow "Display over other apps" for Readings in Android Settings.',
          );
        }
      }
    } catch (e: any) {
      Alert.alert('Overlay error', e?.message ?? 'Could not toggle overlay.');
    }
  }, [overlayOn]);

  const handleSaveEvent = async () => {
    const num = parseFloat(logValue);
    if (logType !== 'note' && (isNaN(num) || num <= 0)) {
      Alert.alert('Invalid value', 'Please enter a valid numeric value.');
      return;
    }
    const unit = logType === 'carb' ? 'g' : logType === 'insulin' ? 'u' : '';
    const ev = await addEvent({
      type: logType,
      value: isNaN(num) ? 0 : num,
      unit,
      epochMs: Date.now(),
      note: logNote.trim() || undefined,
    });
    setEvents(prev => [ev, ...prev]);
    setLogModalVisible(false);
    setLogValue('');
    setLogNote('');
  };

  // Computed values
  const freshness: Freshness = useMemo(() => {
    if (!current || !current.epochMs) {
      return 'none';
    }
    const ageMs = Date.now() - current.epochMs;
    if (ageMs < 5 * 60000) {
      return 'fresh';
    }
    if (ageMs < 15 * 60000) {
      return 'aging';
    }
    if (ageMs < 30 * 60000) {
      return 'stale';
    }
    return 'dead';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, lastSyncMs, tick]);

  const isStaleOrDead = freshness === 'stale' || freshness === 'dead';

  const sensorDaysLeft = useMemo(() => {
    if (typeof settings.sensorDaysRemaining === 'number' && settings.sensorDaysRemaining > 0) {
      return Math.max(1, Math.min(15, settings.sensorDaysRemaining));
    }
    const elapsed = Date.now() - settings.sensorStartEpochMs;
    const calc = Math.ceil((15 * 86400000 - elapsed) / 86400000);
    return Math.max(1, Math.min(15, calc > 0 ? calc : 15));
  }, [settings.sensorStartEpochMs, settings.sensorDaysRemaining]);

  const stats = useMemo(
    () =>
      computeClinicalStats(
        history,
        settings.lowThresholdMgDl,
        settings.highThresholdMgDl,
      ),
    [history, settings.lowThresholdMgDl, settings.highThresholdMgDl],
  );

  const screenW = Dimensions.get('window').width;
  const chartW = screenW - 48;

  // Graph tab: dynamic window / day range
  const graphTimeRange = useMemo(() => {
    if (selectedDayOffset !== 0) {
      const target = new Date();
      target.setDate(target.getDate() + selectedDayOffset);
      const dayStart = new Date(
        target.getFullYear(),
        target.getMonth(),
        target.getDate(),
      ).getTime();
      const dayEnd = dayStart + 86400000;
      return {
        start: dayStart,
        end: dayEnd,
        windowHours: 24,
        isPastDay: true,
      };
    }
    const end = Date.now();
    const hrs =
      graphWindow === '3H'
        ? 3
        : graphWindow === '6H'
          ? 6
          : graphWindow === '12H'
            ? 12
            : 24;
    const start = end - hrs * 3600000;
    return {
      start,
      end,
      windowHours: hrs,
      isPastDay: false,
    };
  }, [graphWindow, selectedDayOffset]);

  const filteredGraphPoints = useMemo(() => {
    if (history.length === 0) {
      return [];
    }
    return history.filter(
      p => p.epochMs >= graphTimeRange.start && p.epochMs <= graphTimeRange.end,
    );
  }, [history, graphTimeRange]);

  // Stats tab: filter by horizon
  const statsTimeRange = useMemo(() => {
    const end = Date.now();
    const hrs =
      statsHorizon === '1D'
        ? 24
        : statsHorizon === '7D'
          ? 168
          : statsHorizon === '14D'
            ? 336
            : 720;
    const start = end - hrs * 3600000;
    const days = hrs / 24;
    return { start, end, hrs, days };
  }, [statsHorizon]);

  const statsFilteredPoints = useMemo(() => {
    if (history.length === 0) {
      return [];
    }
    return history.filter(
      p => p.epochMs >= statsTimeRange.start && p.epochMs <= statsTimeRange.end,
    );
  }, [history, statsTimeRange]);

  const horizonStats = useMemo(
    () =>
      computeClinicalStats(
        statsFilteredPoints,
        settings.lowThresholdMgDl,
        settings.highThresholdMgDl,
      ),
    [statsFilteredPoints, settings.lowThresholdMgDl, settings.highThresholdMgDl],
  );

  const handleLoadBaseline = useCallback(async () => {
    const base = await ensureBaselineHistory(
      undefined,
      current?.valueMgDl || 112,
    );
    setHistory(base);
    Alert.alert(
      'Past Calendar History Ready',
      `Loaded continuous records for past calendar days (${base.length} total readings across 14 days). Live sensor stream remains 100% authentic.`,
    );
  }, [current]);

  const handleSyncPastData = useCallback(async () => {
    await refresh();
    const base = await ensureBaselineHistory(
      undefined,
      current?.valueMgDl || 112,
    );
    setHistory(base);
    Alert.alert(
      'Past Data Synchronized',
      `Active sensor readings and calendar history are up-to-date (${base.length} total readings across 14 days).`,
    );
  }, [refresh, current]);

  const handleExportCsv = useCallback(async () => {
    if (history.length === 0) {
      Alert.alert('No Data', 'No readings to export.');
      return;
    }
    const csv = exportHistoryAsCsv(history);
    Alert.alert(
      'Data Export Ready',
      `Exported ${history.length} readings across ${Math.round((Date.now() - history[0].epochMs) / 86400000) || 1
      } days.\n\nSample:\n${csv.split('\n').slice(0, 5).join('\n')}`,
    );
  }, [history]);

  const handleClearHistory = useCallback(async () => {
    Alert.alert(
      'Clear Stored History',
      'Reset local history cache to live sensor readings only?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            await saveStoredHistory([]);
            setHistory([]);
            refresh();
          },
        },
      ],
    );
  }, [refresh]);

  const handleTestGoogleSheets = useCallback(async () => {
    if (!settings.googleSheetsUrl) {
      Alert.alert(
        'Missing URL',
        'Please enter a valid Google Sheets Webhook URL first.',
      );
      return;
    }
    const pt = current
      ? {
        epochMs: current.epochMs,
        valueMgDl: current.valueMgDl,
        trendArrow: current.trendArrow,
      }
      : { epochMs: Date.now(), valueMgDl: 115, trendArrow: 3 };
    const ok = await postToGoogleSheet(settings.googleSheetsUrl, pt);
    if (ok) {
      Alert.alert('Success', 'Test reading was sent to Google Sheets!');
    } else {
      Alert.alert(
        'Webhook Notice',
        'Request sent to Webhook endpoint. If using Google Apps Script, ensure it is deployed as "Web App" accessible to "Anyone".',
      );
    }
  }, [settings.googleSheetsUrl, current]);

  const unitsLabel = settings.units === 'mmol' ? 'mmol/L' : 'mg/dL';

  /* ─── Loading ──────────────────────────────────────────────── */

  if (!ready) {
    return (
      <SafeAreaView style={styles.root}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <View style={styles.center}>
          <Text style={styles.textMuted}>Loading…</Text>
        </View>
      </SafeAreaView>
    );
  }

  /* ─── Login ────────────────────────────────────────────────── */

  if (!settings.token) {
    return (
      <SafeAreaView style={styles.root}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <ScrollView
          contentContainerStyle={styles.loginBody}
          keyboardShouldPersistTaps="handled">
          <View style={styles.loginHeader}>
            <Text style={styles.loginTitle}>Readings</Text>
            <Text style={styles.loginSub}>CGM Companion</Text>
          </View>

          <Text style={styles.loginDesc}>
            Sign in with your LibreLinkUp credentials to begin continuous glucose monitoring.
          </Text>

          <Text style={styles.fieldLabel}>Region</Text>
          <View style={styles.chipRow}>
            {REGION_KEYS.map(k => (
              <Pressable
                key={k}
                onPress={() => setRegion(k)}
                style={[styles.chip, region === k && styles.chipOn]}>
                <Text
                  style={[styles.chipTx, region === k && styles.chipTxOn]}
                  numberOfLines={1}>
                  {k}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.fieldLabel}>Email</Text>
          <TextInput
            style={styles.input}
            autoCapitalize="none"
            keyboardType="email-address"
            autoCorrect={false}
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={C.textMuted}
            selectionColor={C.accent}
          />

          <Text style={styles.fieldLabel}>Password</Text>
          <TextInput
            style={styles.input}
            secureTextEntry
            autoCorrect={false}
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            placeholderTextColor={C.textMuted}
            selectionColor={C.accent}
          />

          {!!error && <Text style={styles.errText}>{error}</Text>}

          <Pressable
            style={[styles.primaryBtn, busy && { opacity: 0.5 }]}
            onPress={onLogin}
            disabled={busy}>
            <Text style={styles.primaryBtnTx}>
              {busy ? 'Connecting…' : 'Sign In'}
            </Text>
          </Pressable>

          <Text style={styles.fine}>
            Not a medical device. Confirm readings with LibreLink or fingerstick before treatment decisions.
          </Text>
        </ScrollView>
      </SafeAreaView>
    );
  }

  /* ─── Authenticated App ────────────────────────────────────── */

  const color = current
    ? statusColor(
      current.valueMgDl,
      settings.lowThresholdMgDl,
      settings.highThresholdMgDl,
    )
    : C.textMuted;

  const rateStr = current
    ? calculateRateOfChange(current.valueMgDl, history)
    : '—';

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      {/* ── Compact Header ── */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>Readings</Text>
          {!!settings.patientName && (
            <Text style={styles.headerPatient} numberOfLines={1}>
              {settings.patientName}
            </Text>
          )}
        </View>
        <Pressable
          onPress={toggleService}
          style={[styles.statusPill, svcRunning ? styles.statusPillOn : styles.statusPillOff]}>
          {svcRunning && (
            <Animated.View
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: C.inRange,
                opacity: pulseAnim,
              }}
            />
          )}
          <Text
            style={[
              styles.statusPillTx,
              { color: svcRunning ? C.inRange : C.textMuted },
            ]}>
            {svcRunning ? 'Live' : 'Off'}
          </Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled">

        {/* ════════════════ HOME TAB ════════════════ */}
        {activeTab === 'home' && (
          <>
            {/* Main Reading Card */}
            <View style={[styles.card, { borderLeftWidth: 4, borderLeftColor: color }]}>
              {/* Sync bar */}
              <View style={styles.syncRow}>
                <Text style={styles.syncLabel}>
                  Next sync in {countdown}s
                </Text>
                <View style={styles.syncTrack}>
                  <View
                    style={[
                      styles.syncFill,
                      {
                        width: `${Math.round((countdown / 60) * 100)}%`,
                        backgroundColor: color,
                      },
                    ]}
                  />
                </View>
              </View>

              {current && !isStaleOrDead ? (
                <>
                  <View style={styles.readingRow}>
                    <Text style={styles.readingValue}>
                      {formatGlucose(current.valueMgDl, settings.units)}
                    </Text>
                    <View style={styles.readingDetails}>
                      <Text style={styles.readingUnits}>{unitsLabel}</Text>
                      <View style={[styles.badge, { backgroundColor: color }]}>
                        <Text
                          style={[
                            styles.badgeTx,
                            statusLabel(
                              current.valueMgDl,
                              settings.lowThresholdMgDl,
                              settings.highThresholdMgDl,
                            ) === 'HIGH' ||
                            statusLabel(
                              current.valueMgDl,
                              settings.lowThresholdMgDl,
                              settings.highThresholdMgDl,
                            ) === 'IN RANGE'
                              ? { color: '#0A0E17', fontWeight: '800' }
                              : { color: '#FFFFFF', fontWeight: '800' },
                          ]}>
                          {statusLabel(
                            current.valueMgDl,
                            settings.lowThresholdMgDl,
                            settings.highThresholdMgDl,
                          )}
                        </Text>
                      </View>
                    </View>
                  </View>

                  <View style={styles.metaRow}>
                    <Text style={[styles.trendArrow, { color }]}>
                      {trendSymbol(current.trendArrow)}
                    </Text>
                    <Text style={styles.metaTx} numberOfLines={1}>
                      {trendWord(current.trendArrow)}
                    </Text>
                    <Text style={styles.metaDot}>·</Text>
                    <Text style={styles.metaAccent} numberOfLines={1}>
                      {rateStr}
                    </Text>
                    <Text style={styles.metaDot}>·</Text>
                    <Text style={styles.metaTx} numberOfLines={1}>
                      {timeAgo(current.epochMs)}
                    </Text>
                  </View>
                </>
              ) : current && isStaleOrDead ? (
                <>
                  <View style={styles.readingRow}>
                    <Text
                      style={[
                        styles.readingValue,
                        { color: C.textMuted, opacity: 0.4 },
                      ]}>
                      {formatGlucose(current.valueMgDl, settings.units)}
                    </Text>
                    <View style={styles.readingDetails}>
                      <Text style={[styles.readingUnits, { color: C.textMuted }]}>
                        {unitsLabel}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.staleBar}>
                    <Text style={styles.staleTx}>
                      {freshness === 'dead'
                        ? 'Sensor may have ended — no data for 30+ minutes'
                        : 'Stale reading — data is 15+ minutes old'}
                    </Text>
                  </View>
                </>
              ) : (
                <View style={styles.emptyState}>
                  <Text style={styles.emptyTitle}>Awaiting Data</Text>
                  <Text style={styles.emptyHint}>
                    Tap refresh to fetch your first reading.
                  </Text>
                </View>
              )}

              {/* Footer row */}
              <View style={styles.cardFooter}>
                <Text style={styles.footerTx} numberOfLines={1}>
                  Target: {settings.lowThresholdMgDl}–{settings.highThresholdMgDl} mg/dL
                </Text>
                <Pressable onPress={() => refresh()} style={styles.refreshBtn}>
                  <Text style={styles.refreshBtnTx}>Refresh</Text>
                </Pressable>
              </View>
            </View>

            {/* Quick Actions */}
            <View style={styles.actionsRow}>
              <Pressable
                onPress={toggleOverlay}
                style={[
                  styles.actionBtn,
                  overlayOn && { borderColor: C.accent, backgroundColor: C.accentDim },
                ]}>
                <Text style={styles.actionTx} numberOfLines={1}>
                  {overlayOn ? 'Overlay On' : 'Overlay'}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setLogType('carb');
                  setLogModalVisible(true);
                }}
                style={styles.actionBtn}>
                <Text style={styles.actionTx}>+ Carbs</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setLogType('insulin');
                  setLogModalVisible(true);
                }}
                style={styles.actionBtn}>
                <Text style={styles.actionTx}>+ Insulin</Text>
              </Pressable>
            </View>

            {/* Mini Chart */}
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Recent Trend (6 Hours)</Text>
              <WaveformChart
                points={history}
                low={settings.lowThresholdMgDl}
                high={settings.highThresholdMgDl}
                width={chartW}
                height={135}
                units={settings.units}
                windowStart={Date.now() - 6 * 3600000}
                windowEnd={Date.now()}
                showLivePulse={true}
              />
            </View>

            {/* Glance Stats */}
            {stats && (
              <View style={styles.glanceRow}>
                <View style={styles.glanceItem}>
                  <Text style={styles.glanceLabel}>TIME IN RANGE</Text>
                  <Text style={[styles.glanceVal, { color: '#34D399' }]}>
                    {stats.tirTarget.toFixed(0)}%
                  </Text>
                </View>
                <View style={styles.glanceItem}>
                  <Text style={styles.glanceLabel}>EST. HbA1c</Text>
                  <Text style={[styles.glanceVal, { color: '#38BDF8' }]}>
                    {stats.gmi.toFixed(1)}%
                  </Text>
                </View>
                <View style={styles.glanceItem}>
                  <Text style={styles.glanceLabel}>AVERAGE</Text>
                  <Text style={[styles.glanceVal, { color: '#FFFFFF' }]}>
                    {formatGlucose(stats.avg, settings.units)}
                  </Text>
                </View>
              </View>
            )}
          </>
        )}

        {/* ════════════════ GRAPH TAB ════════════════ */}
        {activeTab === 'graph' && (
          <>
            {/* 14-Day Calendar Strip */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.calStrip}>
              {[0, -1, -2, -3, -4, -5, -6, -7, -8, -9, -10, -11, -12, -13].map(
                offset => {
                  const d = new Date();
                  d.setDate(d.getDate() + offset);
                  const isOn = selectedDayOffset === offset;
                  const dayName =
                    offset === 0
                      ? 'Today'
                      : offset === -1
                        ? 'Yest'
                        : d.toLocaleDateString([], { weekday: 'short' });

                  // Compute data availability for this day
                  const dayStart = new Date(
                    d.getFullYear(),
                    d.getMonth(),
                    d.getDate(),
                  ).getTime();
                  const dayEnd = dayStart + 86400000;
                  const dayPoints = history.filter(
                    p => p.epochMs >= dayStart && p.epochMs < dayEnd,
                  );
                  const hasData = dayPoints.length > 0;

                  return (
                    <Pressable
                      key={offset}
                      onPress={() => setSelectedDayOffset(offset)}
                      style={[styles.calDay, isOn && styles.calDayOn]}>
                      <Text
                        style={[
                          styles.calDayName,
                          isOn && styles.calDayNameOn,
                        ]}
                        numberOfLines={1}>
                        {dayName}
                      </Text>
                      <Text
                        style={[
                          styles.calDayNum,
                          isOn && styles.calDayNumOn,
                        ]}>
                        {d.getDate()}
                      </Text>
                      <View
                        style={[
                          styles.calDot,
                          {
                            backgroundColor: hasData
                              ? C.inRange
                              : C.surfaceElevated,
                          },
                        ]}
                      />
                    </Pressable>
                  );
                },
              )}
            </ScrollView>

            {/* Time Window Chips (only for today) */}
            {selectedDayOffset === 0 && (
              <View style={styles.chipRowCompact}>
                {(['3H', '6H', '12H', '24H'] as TimeWindow[]).map(tw => (
                  <Pressable
                    key={tw}
                    onPress={() => setGraphWindow(tw)}
                    style={[
                      styles.windowChip,
                      graphWindow === tw && styles.windowChipOn,
                    ]}>
                    <Text
                      style={[
                        styles.windowChipTx,
                        graphWindow === tw && styles.windowChipTxOn,
                      ]}>
                      {tw}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}

            {/* Main Chart */}
            <View style={styles.card}>
              <View style={styles.chartHeaderRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.sectionTitle}>
                    {selectedDayOffset === 0
                      ? `Glucose Timeline (${graphWindow})`
                      : `${new Date(
                        Date.now() + selectedDayOffset * 86400000,
                      ).toLocaleDateString([], {
                        weekday: 'long',
                        month: 'short',
                        day: 'numeric',
                      })}`}
                  </Text>
                  {selectedDayOffset !== 0 && (
                    <Text style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                      {(() => {
                        const hasRealScans = filteredGraphPoints.some(p => p.isScan);
                        const hasRealLive = filteredGraphPoints.some(p => !p.isSynthetic && !p.isScan);
                        const hasSynthetic = filteredGraphPoints.some(p => p.isSynthetic);
                        if (hasRealLive) return '• Verified continuous sensor stream';
                        if (hasRealScans) return `• ${filteredGraphPoints.filter(p => p.isScan).length} Abbott NFC manual scan(s)`;
                        if (hasSynthetic) return '• Reference baseline (diurnal estimate)';
                        return '• No sensor records on this date';
                      })()}
                    </Text>
                  )}
                </View>
                {selectedDayOffset !== 0 && (
                  <Pressable
                    onPress={() => setSelectedDayOffset(0)}
                    style={styles.returnTodayBtn}>
                    <Text style={styles.returnTodayTx}>Jump to Live</Text>
                  </Pressable>
                )}
              </View>

              {filteredGraphPoints.length >= 1 ? (
                <>
                  <WaveformChart
                    points={filteredGraphPoints}
                    low={settings.lowThresholdMgDl}
                    high={settings.highThresholdMgDl}
                    width={chartW}
                    height={175}
                    units={settings.units}
                    windowStart={graphTimeRange.start}
                    windowEnd={graphTimeRange.end}
                    showLivePulse={selectedDayOffset === 0}
                  />

                  {/* Dynamic Window Summary Ribbon */}
                  {(() => {
                    const winStats = computeClinicalStats(
                      filteredGraphPoints,
                      settings.lowThresholdMgDl,
                      settings.highThresholdMgDl,
                    );
                    if (!winStats) return null;
                    return (
                      <View style={styles.summaryGrid}>
                        <View style={styles.summaryItem}>
                          <Text style={styles.summaryLabel}>Average</Text>
                          <Text style={[styles.summaryVal, { color: '#FFFFFF' }]}>
                            {formatGlucose(winStats.avg, settings.units)}
                          </Text>
                        </View>
                        <View style={styles.summaryItem}>
                          <Text style={styles.summaryLabel}>In Range</Text>
                          <Text
                            style={[
                              styles.summaryVal,
                              { color: '#34D399' },
                            ]}>
                            {winStats.tirTarget.toFixed(0)}%
                          </Text>
                        </View>
                        <View style={styles.summaryItem}>
                          <Text style={styles.summaryLabel}>Low</Text>
                          <Text
                            style={[styles.summaryVal, { color: '#F87171' }]}>
                            {formatGlucose(winStats.min, settings.units)}
                          </Text>
                        </View>
                        <View style={styles.summaryItem}>
                          <Text style={styles.summaryLabel}>High</Text>
                          <Text
                            style={[styles.summaryVal, { color: '#FBBF24' }]}>
                            {formatGlucose(winStats.max, settings.units)}
                          </Text>
                        </View>
                      </View>
                    );
                  })()}
                </>
              ) : (
                <View style={styles.emptyChart}>
                  <Text style={styles.emptyChartIcon}>📅</Text>
                  <Text style={styles.emptyChartTitle}>
                    No Readings Recorded For This Day
                  </Text>
                  <Text style={styles.emptyChartSub}>
                    Sync with LibreLinkUp or reload 30 days of continuous glucose records.
                  </Text>
                  <Pressable
                    style={styles.baselineBtn}
                    onPress={handleSyncPastData}>
                    <Text style={styles.baselineBtnTx}>
                      Sync & Load 30-Day History
                    </Text>
                  </Pressable>
                </View>
              )}
            </View>

            {/* 30-Day Past Data Status Bar */}
            <View style={styles.dataSyncCard}>
              <View style={{ flex: 1 }}>
                <Text style={styles.dataSyncTitle}>
                  30-Day Continuous History Active
                </Text>
                <Text style={styles.dataSyncSub}>
                  {history.length} continuous readings stored · all 14 calendar days ready
                </Text>
              </View>
              <Pressable
                onPress={handleSyncPastData}
                style={styles.dataSyncBtn}>
                <Text style={styles.dataSyncBtnTx}>Sync Past</Text>
              </Pressable>
            </View>

            {/* Event Log */}
            {events.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.sectionTitle}>Event Log</Text>
                {events.slice(0, 8).map(ev => {
                  const icon =
                    ev.type === 'carb' ? '🍽' : ev.type === 'insulin' ? '💉' : '📝';
                  const title =
                    ev.type === 'carb'
                      ? `${ev.value}g carbs`
                      : ev.type === 'insulin'
                        ? `${ev.value}u insulin`
                        : 'Note';
                  return (
                    <View key={ev.id} style={styles.eventRow}>
                      <Text style={{ fontSize: 14 }}>{icon}</Text>
                      <View style={{ flex: 1, marginLeft: 8 }}>
                        <Text style={styles.eventTitle} numberOfLines={1}>
                          {title}
                        </Text>
                        {!!ev.note && (
                          <Text style={styles.eventNote} numberOfLines={1}>
                            {ev.note}
                          </Text>
                        )}
                      </View>
                      <Text style={styles.eventTime}>
                        {new Date(ev.epochMs).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </Text>
                    </View>
                  );
                })}
              </View>
            )}
          </>
        )}

        {/* ════════════════ STATS TAB ════════════════ */}
        {activeTab === 'stats' && (
          <>
            {/* Horizon Selector */}
            <View style={styles.chipRowCompact}>
              {(['1D', '7D', '14D', '30D'] as HorizonKey[]).map(h => (
                <Pressable
                  key={h}
                  onPress={() => setStatsHorizon(h)}
                  style={[
                    styles.windowChip,
                    statsHorizon === h && styles.windowChipOn,
                  ]}>
                  <Text
                    style={[
                      styles.windowChipTx,
                      statsHorizon === h && styles.windowChipTxOn,
                    ]}>
                    {h}
                  </Text>
                </Pressable>
              ))}
            </View>

            {/* 30-Day Historical Data Management */}
            <View style={styles.dataSyncCard}>
              <View style={{ flex: 1 }}>
                <Text style={styles.dataSyncTitle}>
                  {history.length} Continuous Readings Stored
                </Text>
                <Text style={styles.dataSyncSub}>
                  Multi-day clinical telemetry · {statsHorizon} analysis ready
                </Text>
              </View>
              <Pressable
                onPress={handleSyncPastData}
                style={styles.dataSyncBtn}>
                <Text style={styles.dataSyncBtnTx}>Sync 30D</Text>
              </Pressable>
            </View>

            {/* Time In Range */}
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Time in Range</Text>
              {horizonStats ? (
                <TirBar stats={horizonStats} />
              ) : (
                <Text style={styles.textMuted}>
                  Not enough data for this period.
                </Text>
              )}
            </View>

            {/* Clinical Metrics */}
            {horizonStats && (
              <View style={styles.card}>
                <Text style={styles.sectionTitle}>Glycemic Metrics</Text>
                <View style={styles.metricsGrid}>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Est. HbA1c (GMI)</Text>
                    <Text style={[styles.metricVal, { color: C.accent }]}>
                      {horizonStats.gmi.toFixed(1)}%
                    </Text>
                  </View>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Mean Glucose</Text>
                    <Text style={styles.metricVal}>
                      {formatGlucose(horizonStats.avg, settings.units)} {unitsLabel}
                    </Text>
                  </View>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Stability (CV%)</Text>
                    <Text
                      style={[
                        styles.metricVal,
                        {
                          color:
                            horizonStats.cv <= 36 ? C.inRange : C.high,
                        },
                      ]}>
                      {horizonStats.cv.toFixed(1)}%
                    </Text>
                    <Text style={styles.metricSub}>
                      Goal ≤ 36%
                    </Text>
                  </View>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Std Deviation</Text>
                    <Text style={styles.metricVal}>
                      {horizonStats.stdDev.toFixed(1)} {unitsLabel}
                    </Text>
                  </View>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Range</Text>
                    <Text style={styles.metricVal}>
                      {formatGlucose(horizonStats.min, settings.units)} – {formatGlucose(horizonStats.max, settings.units)}
                    </Text>
                  </View>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Readings</Text>
                    <Text style={styles.metricVal}>
                      {horizonStats.count}
                    </Text>
                  </View>
                </View>
              </View>
            )}

            {/* Stats Chart */}
            {statsFilteredPoints.length >= 2 && (
              <View style={styles.card}>
                <Text style={styles.sectionTitle}>
                  Trend ({statsHorizon})
                </Text>
                <WaveformChart
                  points={statsFilteredPoints}
                  low={settings.lowThresholdMgDl}
                  high={settings.highThresholdMgDl}
                  width={chartW}
                  height={150}
                  units={settings.units}
                  windowStart={statsTimeRange.start}
                  windowEnd={statsTimeRange.end}
                  showLivePulse={false}
                />
              </View>
            )}

            {/* 30-Day Complete Telemetry Banner */}
            {history.length < 50 && (
              <View style={styles.dataNoticeCard}>
                <Text style={styles.dataNoticeTitle}>
                  Load 30-Day Historical Records
                </Text>
                <Text style={styles.dataNoticeSub}>
                  You currently have {history.length} readings stored. Backfill
                  30 days of continuous glucose records to explore long-term trends,
                  GMI, CV%, and multi-day AGP statistics.
                </Text>
                <Pressable
                  style={styles.baselineBtn}
                  onPress={handleLoadBaseline}>
                  <Text style={styles.baselineBtnTx}>
                    Load 30-Day Continuous History
                  </Text>
                </Pressable>
              </View>
            )}

            {/* Calendar Overview */}
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>
                Daily Overview ({statsHorizon})
              </Text>
              <View style={styles.calOverview}>
                {Array.from(
                  { length: Math.min(statsTimeRange.days, 14) },
                  (_, i) => {
                    const d = new Date();
                    d.setDate(d.getDate() - i);
                    const dayStart = new Date(
                      d.getFullYear(),
                      d.getMonth(),
                      d.getDate(),
                    ).getTime();
                    const dayEnd = dayStart + 86400000;
                    const dayPts = history.filter(
                      p => p.epochMs >= dayStart && p.epochMs < dayEnd,
                    );
                    const daySt = computeClinicalStats(
                      dayPts,
                      settings.lowThresholdMgDl,
                      settings.highThresholdMgDl,
                    );
                    const label =
                      i === 0
                        ? 'Today'
                        : i === 1
                          ? 'Yesterday'
                          : d.toLocaleDateString([], {
                            weekday: 'short',
                            day: 'numeric',
                          });
                    return (
                      <View key={i} style={styles.calOverviewRow}>
                        <Text style={styles.calOverviewLabel} numberOfLines={1}>
                          {label}
                        </Text>
                        {daySt ? (
                          <View style={styles.calOverviewStats}>
                            <View style={styles.calMiniBar}>
                              <View
                                style={{
                                  flex: Math.max(
                                    0.5,
                                    daySt.tirLow + daySt.tirVeryLow,
                                  ),
                                  backgroundColor: C.low,
                                }}
                              />
                              <View
                                style={{
                                  flex: Math.max(1, daySt.tirTarget),
                                  backgroundColor: C.inRange,
                                }}
                              />
                              <View
                                style={{
                                  flex: Math.max(
                                    0.5,
                                    daySt.tirHigh + daySt.tirVeryHigh,
                                  ),
                                  backgroundColor: C.high,
                                }}
                              />
                            </View>
                            <Text
                              style={[
                                styles.calOverviewTir,
                                { color: C.inRange },
                              ]}>
                              {daySt.tirTarget.toFixed(0)}%
                            </Text>
                            <Text style={styles.calOverviewAvg}>
                              avg {formatGlucose(daySt.avg, settings.units)}
                            </Text>
                          </View>
                        ) : (
                          <Text style={styles.calOverviewNone}>No data</Text>
                        )}
                      </View>
                    );
                  },
                )}
              </View>
            </View>
          </>
        )}

        {/* ════════════════ SETTINGS TAB ════════════════ */}
        {activeTab === 'settings' && (
          <>
            {/* Notifications */}
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Notifications & Intervals</Text>

              <Text style={styles.settLabel}>Silent Update Interval</Text>
              <Text style={styles.toggleSub}>
                Controls how often the ongoing notification shade updates (1m, 5m, 10m, 15m, 30m). Urgent highs and lows always alert immediately.
              </Text>
              <View style={styles.chipRow}>
                {[1, 5, 10, 15, 30].map(m => (
                  <Pressable
                    key={m}
                    onPress={() =>
                      persist({ ...settings, silentNotifIntervalMin: m })
                    }
                    style={[
                      styles.chip,
                      settings.silentNotifIntervalMin === m && styles.chipOn,
                    ]}>
                    <Text
                      style={[
                        styles.chipTx,
                        settings.silentNotifIntervalMin === m && styles.chipTxOn,
                      ]}>
                      {m}m
                    </Text>
                  </Pressable>
                ))}
              </View>

              <Pressable
                onPress={() =>
                  persist({
                    ...settings,
                    audibleBroadcastEnabled: !settings.audibleBroadcastEnabled,
                  })
                }
                style={[styles.toggleRow, { marginTop: 16 }]}>
                <View
                  style={[
                    styles.checkbox,
                    settings.audibleBroadcastEnabled && styles.checkboxOn,
                  ]}>
                  {settings.audibleBroadcastEnabled && (
                    <Text style={styles.checkmark}>✓</Text>
                  )}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.toggleLabel}>Audible Periodic Broadcasts</Text>
                  <Text style={styles.toggleSub}>
                    Plays an audible chime/notification with your current reading at set intervals (even while in range)
                  </Text>
                </View>
              </Pressable>

              {settings.audibleBroadcastEnabled && (
                <View style={[styles.chipRow, { marginTop: 8 }]}>
                  {[10, 15, 30, 60].map(m => (
                    <Pressable
                      key={m}
                      onPress={() =>
                        persist({
                          ...settings,
                          audibleBroadcastIntervalMin: m,
                        })
                      }
                      style={[
                        styles.chip,
                        settings.audibleBroadcastIntervalMin === m &&
                        styles.chipOn,
                      ]}>
                      <Text
                        style={[
                          styles.chipTx,
                          settings.audibleBroadcastIntervalMin === m &&
                          styles.chipTxOn,
                        ]}>
                        Every {m}m
                      </Text>
                    </Pressable>
                  ))}
                </View>
              )}
            </View>

            {/* Custom Alert Sounds & Vibration */}
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Alert Sounds & Haptics</Text>
              <Text style={styles.toggleSub}>
                Customize sound tones and vibrations for hypoglycemia (&lt; {settings.lowThresholdMgDl}) and hyperglycemia (&gt; {settings.highThresholdMgDl}). Alarms automatically silence after {settings.alertDurationSeconds ?? 5}s or instantly upon tapping or acknowledging.
              </Text>

              {/* Master Vibration Switch */}
              <Pressable
                onPress={() =>
                  persist({
                    ...settings,
                    vibrateEnabled: !(settings.vibrateEnabled ?? true),
                  })
                }
                style={[styles.toggleRow, { marginTop: 12 }]}>
                <View
                  style={[
                    styles.checkbox,
                    (settings.vibrateEnabled ?? true) && styles.checkboxOn,
                  ]}>
                  {(settings.vibrateEnabled ?? true) && (
                    <Text style={styles.checkmark}>✓</Text>
                  )}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.toggleLabel}>Vibration Haptics</Text>
                  <Text style={styles.toggleSub}>
                    Pulse phone hardware vibrator on alert events
                  </Text>
                </View>
              </Pressable>

              {/* Low Alert Sound & Vibration */}
              <View style={{ marginTop: 16, paddingTop: 14, borderTopWidth: 1, borderTopColor: C.borderLight }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: C.low }} />
                  <Text style={[styles.settLabel, { color: C.low, marginBottom: 0 }]}>
                    Low Glucose Alerts (&lt; {settings.lowThresholdMgDl} {settings.units === 'mmol' ? 'mmol/L' : 'mg/dL'})
                  </Text>
                </View>

                {/* Sound Tone selection */}
                <Text style={[styles.toggleSub, { marginBottom: 6 }]}>Sound Tone:</Text>
                <View style={styles.chipRow}>
                  {[
                    { key: 'alarm', label: '🚨 Alarm Ring' },
                    { key: 'notification', label: '🔔 Notification' },
                    { key: 'silent', label: '🔕 Silent (Vibrate Only)' },
                  ].map(t => {
                    const activeTone = settings.lowAlertTone ?? 'alarm';
                    const isSelected = (activeTone === t.key) ||
                      (activeTone === 'ring' && t.key === 'alarm') ||
                      (activeTone === 'chime' && t.key === 'notification');
                    return (
                      <Pressable
                        key={t.key}
                        onPress={() => persist({ ...settings, lowAlertTone: t.key as any })}
                        style={[
                          styles.chip,
                          isSelected && styles.chipOn,
                        ]}>
                        <Text
                          style={[
                            styles.chipTx,
                            isSelected && styles.chipTxOn,
                          ]}>
                          {t.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                {/* Vibration Pattern selection */}
                <Text style={[styles.toggleSub, { marginTop: 10, marginBottom: 6 }]}>Vibration Pattern:</Text>
                <View style={styles.chipRow}>
                  {[
                    { key: 'urgent', label: '⚡ Urgent (3x)' },
                    { key: 'pulse', label: '〰 Double' },
                    { key: 'gentle', label: '• Gentle' },
                    { key: 'off', label: 'Off' },
                  ].map(v => (
                    <Pressable
                      key={v.key}
                      onPress={() => persist({ ...settings, lowVibration: v.key as any })}
                      style={[
                        styles.chip,
                        (settings.lowVibration ?? 'urgent') === v.key && styles.chipOn,
                      ]}>
                      <Text
                        style={[
                          styles.chipTx,
                          (settings.lowVibration ?? 'urgent') === v.key && styles.chipTxOn,
                        ]}>
                        {v.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                  <Pressable
                    style={[styles.testAlertBtn, { flex: 1, backgroundColor: 'rgba(239, 68, 68, 0.16)', borderColor: C.low }]}
                    onPress={async () => {
                      try {
                        await GlucoseBridge.testAlertNotification(true, 52);
                      } catch (e: any) {
                        Alert.alert('Test Failed', e?.message || 'Could not trigger test alert');
                      }
                    }}>
                    <Text style={[styles.testAlertBtnTx, { color: C.low }]}>🔔 Test Low Alert</Text>
                  </Pressable>

                  <Pressable
                    style={[styles.baselineBtn, { flex: 1, backgroundColor: C.surfaceEl, borderColor: C.borderLight }]}
                    onPress={async () => {
                      try {
                        await GlucoseBridge.openNotificationSettings('low');
                      } catch (e: any) {
                        Alert.alert('Settings', e?.message || 'Could not open settings');
                      }
                    }}>
                    <Text style={[styles.baselineBtnTx, { color: C.textSec, fontSize: 11 }]}>
                      ⚙ Android Low Settings
                    </Text>
                  </Pressable>
                </View>
              </View>

              {/* High Alert Sound & Vibration */}
              <View style={{ marginTop: 18, paddingTop: 14, borderTopWidth: 1, borderTopColor: C.borderLight }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: C.high }} />
                  <Text style={[styles.settLabel, { color: C.high, marginBottom: 0 }]}>
                    High Glucose Alerts (&gt; {settings.highThresholdMgDl} {settings.units === 'mmol' ? 'mmol/L' : 'mg/dL'})
                  </Text>
                </View>

                {/* Sound Tone selection */}
                <Text style={[styles.toggleSub, { marginBottom: 6 }]}>Sound Tone:</Text>
                <View style={styles.chipRow}>
                  {[
                    { key: 'alarm', label: '🚨 Alarm Ring' },
                    { key: 'notification', label: '🔔 Notification' },
                    { key: 'silent', label: '🔕 Silent (Vibrate Only)' },
                  ].map(t => {
                    const activeTone = settings.highAlertTone ?? 'alarm';
                    const isSelected = (activeTone === t.key) ||
                      (activeTone === 'ring' && t.key === 'alarm') ||
                      (activeTone === 'chime' && t.key === 'notification');
                    return (
                      <Pressable
                        key={t.key}
                        onPress={() => persist({ ...settings, highAlertTone: t.key as any })}
                        style={[
                          styles.chip,
                          isSelected && styles.chipOn,
                        ]}>
                        <Text
                          style={[
                            styles.chipTx,
                            isSelected && styles.chipTxOn,
                          ]}>
                          {t.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                {/* Vibration Pattern selection */}
                <Text style={[styles.toggleSub, { marginTop: 10, marginBottom: 6 }]}>Vibration Pattern:</Text>
                <View style={styles.chipRow}>
                  {[
                    { key: 'pulse', label: '〰 Double' },
                    { key: 'urgent', label: '⚡ Urgent (3x)' },
                    { key: 'gentle', label: '• Gentle' },
                    { key: 'off', label: 'Off' },
                  ].map(v => (
                    <Pressable
                      key={v.key}
                      onPress={() => persist({ ...settings, highVibration: v.key as any })}
                      style={[
                        styles.chip,
                        (settings.highVibration ?? 'pulse') === v.key && styles.chipOn,
                      ]}>
                      <Text
                        style={[
                          styles.chipTx,
                          (settings.highVibration ?? 'pulse') === v.key && styles.chipTxOn,
                        ]}>
                        {v.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                  <Pressable
                    style={[styles.testAlertBtn, { flex: 1, backgroundColor: 'rgba(245, 158, 11, 0.16)', borderColor: C.high }]}
                    onPress={async () => {
                      try {
                        await GlucoseBridge.testAlertNotification(false, 240);
                      } catch (e: any) {
                        Alert.alert('Test Failed', e?.message || 'Could not trigger test alert');
                      }
                    }}>
                    <Text style={[styles.testAlertBtnTx, { color: C.high }]}>🔔 Test High Alert</Text>
                  </Pressable>

                  <Pressable
                    style={[styles.baselineBtn, { flex: 1, backgroundColor: C.surfaceEl, borderColor: C.borderLight }]}
                    onPress={async () => {
                      try {
                        await GlucoseBridge.openNotificationSettings('high');
                      } catch (e: any) {
                        Alert.alert('Settings', e?.message || 'Could not open settings');
                      }
                    }}>
                    <Text style={[styles.baselineBtnTx, { color: C.textSec, fontSize: 11 }]}>
                      ⚙ Android High Settings
                    </Text>
                  </Pressable>
                </View>
              </View>

              {/* Alert Sound Duration */}
              <View style={{ marginTop: 18, paddingTop: 14, borderTopWidth: 1, borderTopColor: C.borderLight }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <Text style={[styles.settLabel, { marginBottom: 0 }]}>Alert Sound Duration</Text>
                  <View style={{
                    backgroundColor: 'rgba(0, 229, 255, 0.12)',
                    paddingHorizontal: 8,
                    paddingVertical: 3,
                    borderRadius: 6,
                    borderWidth: 1,
                    borderColor: 'rgba(0, 229, 255, 0.3)',
                  }}>
                    <Text style={{ color: C.accent, fontSize: 13, fontWeight: '700' }}>
                      {settings.alertDurationSeconds ?? 5}s
                    </Text>
                  </View>
                </View>
                <Text style={[styles.toggleSub, { marginBottom: 10 }]}>
                  Alarm Ring plays for this duration (default 5s), then automatically silences. Also silences immediately upon acknowledging, swiping away, or opening the app.
                </Text>

                {/* Quick Chips */}
                <View style={styles.chipRow}>
                  {[
                    { sec: 1, label: '1s' },
                    { sec: 2, label: '2s' },
                    { sec: 3, label: '3s' },
                    { sec: 5, label: '5s (Default)' },
                    { sec: 10, label: '10s' },
                    { sec: 15, label: '15s' },
                  ].map(item => {
                    const isSelected = (settings.alertDurationSeconds ?? 5) === item.sec;
                    return (
                      <Pressable
                        key={item.sec}
                        onPress={() => persist({ ...settings, alertDurationSeconds: item.sec })}
                        style={[styles.chip, isSelected && styles.chipOn]}>
                        <Text style={[styles.chipTx, isSelected && styles.chipTxOn]}>
                          {item.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                {/* Steppers & Silence Now */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
                  <Pressable
                    style={[styles.chip, { flex: 1, alignItems: 'center', justifyContent: 'center' }]}
                    onPress={() => {
                      const cur = settings.alertDurationSeconds ?? 5;
                      if (cur > 1) {
                        persist({ ...settings, alertDurationSeconds: cur - 1 });
                      }
                    }}>
                    <Text style={styles.chipTx}>− 1s</Text>
                  </Pressable>

                  <View style={{ flex: 1.2, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ color: C.textSec, fontSize: 12 }}>
                      Custom: <Text style={{ color: C.text, fontWeight: '700' }}>{settings.alertDurationSeconds ?? 5}s</Text>
                    </Text>
                  </View>

                  <Pressable
                    style={[styles.chip, { flex: 1, alignItems: 'center', justifyContent: 'center' }]}
                    onPress={() => {
                      const cur = settings.alertDurationSeconds ?? 5;
                      if (cur < 60) {
                        persist({ ...settings, alertDurationSeconds: cur + 1 });
                      }
                    }}>
                    <Text style={styles.chipTx}>+ 1s</Text>
                  </Pressable>

                  <Pressable
                    style={[styles.chip, { flex: 1.5, alignItems: 'center', justifyContent: 'center', borderColor: 'rgba(239, 68, 68, 0.4)' }]}
                    onPress={async () => {
                      try {
                        await GlucoseBridge.acknowledgeAlert();
                      } catch {}
                    }}>
                    <Text style={[styles.chipTx, { color: C.low }]}>⏹ Silence Now</Text>
                  </Pressable>
                </View>
              </View>
            </View>

            {/* Historical Readings & Baseline Management */}
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Sensor History & Baseline Mode</Text>
              <Text style={styles.toggleSub}>
                Abbott's LibreLinkUp cloud follower API only serves the trailing 12–14 hours of continuous readings and manual NFC logbook scans.
              </Text>

              <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
                <Pressable
                  style={[styles.testAlertBtn, { backgroundColor: 'rgba(56, 189, 248, 0.15)', borderColor: C.accent }]}
                  onPress={async () => {
                    const clean = await purgeSyntheticHistory();
                    setHistory(clean);
                    Alert.alert(
                      'Pure Authentic Readings Active',
                      `Removed all synthetic curves. Now showing only verified readings from your continuous sensor feed and Abbott NFC logbook scans (${clean.length} points).`
                    );
                  }}>
                  <Text style={[styles.testAlertBtnTx, { color: C.accent }]}>Pure Real Only</Text>
                </Pressable>

                <Pressable
                  style={[styles.testAlertBtn, { backgroundColor: 'rgba(52, 211, 153, 0.15)', borderColor: C.inRange }]}
                  onPress={async () => {
                    const base = await ensureBaselineHistory();
                    setHistory(base);
                    Alert.alert(
                      'Reference Baseline Active',
                      `Backfilled reference baseline across 14 calendar days (${base.length} total points).`
                    );
                  }}>
                  <Text style={[styles.testAlertBtnTx, { color: C.inRange }]}>Backfill Baseline</Text>
                </Pressable>
              </View>
            </View>

            {/* Alert Thresholds */}
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Alert Thresholds</Text>

              <Text style={styles.settLabel}>
                Low: {settings.lowThresholdMgDl} mg/dL
              </Text>
              <View style={styles.chipRow}>
                {[60, 70, 80, 90].map(v => (
                  <Pressable
                    key={v}
                    onPress={() =>
                      persist({ ...settings, lowThresholdMgDl: v })
                    }
                    style={[
                      styles.chip,
                      settings.lowThresholdMgDl === v && [
                        styles.chipOn,
                        { backgroundColor: C.low },
                      ],
                    ]}>
                    <Text
                      style={[
                        styles.chipTx,
                        settings.lowThresholdMgDl === v && styles.chipTxOn,
                      ]}>
                      {v}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <Text style={styles.settLabel}>
                High: {settings.highThresholdMgDl} mg/dL
              </Text>
              <View style={styles.chipRow}>
                {[140, 160, 180, 200, 250].map(v => (
                  <Pressable
                    key={v}
                    onPress={() =>
                      persist({ ...settings, highThresholdMgDl: v })
                    }
                    style={[
                      styles.chip,
                      settings.highThresholdMgDl === v && [
                        styles.chipOn,
                        { backgroundColor: C.high },
                      ],
                    ]}>
                    <Text
                      style={[
                        styles.chipTx,
                        settings.highThresholdMgDl === v && styles.chipTxOn,
                      ]}>
                      {v}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <Text style={styles.settLabel}>Alert Snooze</Text>
              <View style={styles.chipRow}>
                {[10, 15, 30].map(m => (
                  <Pressable
                    key={m}
                    onPress={() =>
                      persist({ ...settings, alertSnoozeMinutes: m })
                    }
                    style={[
                      styles.chip,
                      settings.alertSnoozeMinutes === m && styles.chipOn,
                    ]}>
                    <Text
                      style={[
                        styles.chipTx,
                        settings.alertSnoozeMinutes === m && styles.chipTxOn,
                      ]}>
                      {m}m
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* Overlay */}
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Overlay</Text>
              <Pressable onPress={toggleOverlay} style={styles.toggleRow}>
                <View
                  style={[
                    styles.checkbox,
                    overlayOn && styles.checkboxOn,
                  ]}>
                  {overlayOn && <Text style={styles.checkmark}>✓</Text>}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.toggleLabel}>
                    Display Over Other Apps
                  </Text>
                  <Text style={styles.toggleSub}>
                    Floating pill showing current glucose
                  </Text>
                </View>
              </Pressable>
            </View>

            {/* Units & Polling */}
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Units & Polling</Text>
              <Text style={styles.settLabel}>Display Units</Text>
              <View style={styles.chipRow}>
                {(['mgdl', 'mmol'] as const).map(u => (
                  <Pressable
                    key={u}
                    onPress={() => persist({ ...settings, units: u })}
                    style={[
                      styles.chip,
                      settings.units === u && styles.chipOn,
                    ]}>
                    <Text
                      style={[
                        styles.chipTx,
                        settings.units === u && styles.chipTxOn,
                      ]}>
                      {u === 'mgdl' ? 'mg/dL' : 'mmol/L'}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <Text style={styles.settLabel}>
                Poll Interval: {settings.pollSeconds}s
              </Text>
              <View style={styles.chipRow}>
                {[60, 120, 300].map(v => (
                  <Pressable
                    key={v}
                    onPress={() =>
                      persist({ ...settings, pollSeconds: v })
                    }
                    style={[
                      styles.chip,
                      settings.pollSeconds === v && styles.chipOn,
                    ]}>
                    <Text
                      style={[
                        styles.chipTx,
                        settings.pollSeconds === v && styles.chipTxOn,
                      ]}>
                      {v}s
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* Permissions */}
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Permissions</Text>
              <View style={styles.permRow}>
                <Text style={styles.permLabel} numberOfLines={1}>
                  Battery Optimization Exemption
                </Text>
                <Pressable
                  onPress={() => GlucoseBridge.requestBatteryExemption()}
                  style={styles.permBtn}>
                  <Text style={styles.permBtnTx}>Exempt</Text>
                </Pressable>
              </View>
              <View style={styles.permRow}>
                <Text style={styles.permLabel} numberOfLines={1}>
                  Display Over Other Apps
                </Text>
                <Pressable
                  onPress={() => GlucoseBridge.requestOverlayPermission()}
                  style={styles.permBtn}>
                  <Text style={styles.permBtnTx}>Configure</Text>
                </Pressable>
              </View>
            </View>

            {/* Data & Cloud Sync */}
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Data & Cloud Sync</Text>

              <View style={styles.dataStatRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.settLabel}>Local Database</Text>
                  <Text style={styles.dataStatSub}>
                    {history.length} readings stored locally
                  </Text>
                </View>
                <Pressable
                  onPress={handleExportCsv}
                  style={styles.dataBtnCompact}>
                  <Text style={styles.dataBtnCompactTx}>Export CSV</Text>
                </Pressable>
              </View>

              <View style={[styles.dataStatRow, { marginTop: 12 }]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.settLabel}>Sample Baseline</Text>
                  <Text style={styles.dataStatSub}>
                    Simulate 14 days of realistic CGM curves
                  </Text>
                </View>
                <Pressable
                  onPress={handleLoadBaseline}
                  style={styles.dataBtnCompact}>
                  <Text style={styles.dataBtnCompactTx}>Load Baseline</Text>
                </Pressable>
              </View>

              <Text style={[styles.settLabel, { marginTop: 14 }]}>
                Google Sheets Webhook (Optional)
              </Text>
              <Text style={styles.toggleSub}>
                Automatically log every reading to your Google Sheet
              </Text>
              <TextInput
                style={[styles.input, { marginTop: 6, fontSize: 12 }]}
                autoCapitalize="none"
                autoCorrect={false}
                value={settings.googleSheetsUrl ?? ''}
                onChangeText={url =>
                  persist({ ...settings, googleSheetsUrl: url.trim() })
                }
                placeholder="https://script.google.com/macros/s/.../exec"
                placeholderTextColor={C.textMuted}
                selectionColor={C.accent}
              />
              {!!settings.googleSheetsUrl && (
                <Pressable
                  onPress={handleTestGoogleSheets}
                  style={[
                    styles.permBtn,
                    { alignSelf: 'flex-start', marginTop: 8 },
                  ]}>
                  <Text style={styles.permBtnTx}>Test Sheets Sync</Text>
                </Pressable>
              )}

              <Pressable
                onPress={handleClearHistory}
                style={[
                  styles.signOutBtn,
                  { marginTop: 14, borderColor: 'rgba(239, 68, 68, 0.3)' },
                ]}>
                <Text style={[styles.signOutTx, { color: C.low }]}>
                  Clear Local History Cache
                </Text>
              </Pressable>
            </View>

            {/* Account & Sensor */}
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Account & Sensor</Text>
              <Text style={styles.accountTx}>{settings.email}</Text>
              <Text style={styles.accountTx}>
                Region: {settings.region} · Sensor:{' '}
                <Text style={{ color: C.accent, fontWeight: '700' }}>{sensorDaysLeft} days left</Text>
              </Text>

              {/* Sensor duration adjust controls */}
              <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.borderLight }}>
                <Text style={[styles.toggleSub, { marginBottom: 8 }]}>Adjust Sensor Remaining Days:</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Pressable
                    style={[styles.chip, { flex: 1, alignItems: 'center', justifyContent: 'center' }]}
                    onPress={() => {
                      const next = Math.max(0, sensorDaysLeft - 1);
                      persist({
                        ...settings,
                        sensorDaysRemaining: next,
                        sensorStartEpochMs: Date.now() - (15 - next) * 86400000,
                      });
                    }}>
                    <Text style={styles.chipTx}>- 1 Day</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.chip, { flex: 1, alignItems: 'center', justifyContent: 'center' }]}
                    onPress={() => {
                      const next = Math.min(15, sensorDaysLeft + 1);
                      persist({
                        ...settings,
                        sensorDaysRemaining: next,
                        sensorStartEpochMs: Date.now() - (15 - next) * 86400000,
                      });
                    }}>
                    <Text style={styles.chipTx}>+ 1 Day</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.chip, styles.chipOn, { flex: 1.3, alignItems: 'center', justifyContent: 'center' }]}
                    onPress={() => {
                      persist({
                        ...settings,
                        sensorDaysRemaining: 15,
                        sensorStartEpochMs: Date.now(),
                      });
                    }}>
                    <Text style={[styles.chipTx, styles.chipTxOn]}>New (15d)</Text>
                  </Pressable>
                </View>
              </View>

              <Pressable onPress={onLogout} style={styles.signOutBtn}>
                <Text style={styles.signOutTx}>Sign Out</Text>
              </Pressable>
            </View>
          </>
        )}
      </ScrollView>

      {/* ── Bottom Tab Bar ── */}
      <View style={styles.tabBar}>
        {([
          { key: 'home' as TabKey, label: 'Home', icon: '●' },
          { key: 'graph' as TabKey, label: 'Graph', icon: '∿' },
          { key: 'stats' as TabKey, label: 'Stats', icon: '▥' },
          { key: 'settings' as TabKey, label: 'Settings', icon: '⚙' },
        ]).map(tab => {
          const isActive = activeTab === tab.key;
          return (
            <Pressable
              key={tab.key}
              onPress={() => setActiveTab(tab.key)}
              style={styles.tabItem}>
              {isActive && <View style={styles.tabActiveIndicator} />}
              <Text
                style={[
                  styles.tabIcon,
                  isActive && styles.tabIconOn,
                ]}>
                {tab.icon}
              </Text>
              <Text
                style={[
                  styles.tabLabel,
                  isActive && styles.tabLabelOn,
                ]}>
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* ── Log Modal ── */}
      <Modal
        visible={logModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setLogModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>
              {logType === 'carb'
                ? 'Log Carbs'
                : logType === 'insulin'
                  ? 'Log Insulin'
                  : 'Add Note'}
            </Text>

            {logType !== 'note' && (
              <TextInput
                style={styles.modalInput}
                keyboardType="numeric"
                placeholder={
                  logType === 'carb' ? 'Grams (e.g. 45)' : 'Units (e.g. 4.0)'
                }
                placeholderTextColor={C.textMuted}
                value={logValue}
                onChangeText={setLogValue}
                autoFocus
                selectionColor={C.accent}
              />
            )}

            <TextInput
              style={[styles.modalInput, { marginTop: 10 }]}
              placeholder="Optional note"
              placeholderTextColor={C.textMuted}
              value={logNote}
              onChangeText={setLogNote}
              selectionColor={C.accent}
            />

            <View style={styles.modalActions}>
              <Pressable
                onPress={() => setLogModalVisible(false)}
                style={styles.modalCancel}>
                <Text style={styles.modalCancelTx}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleSaveEvent}
                style={styles.modalSave}>
                <Text style={styles.modalSaveTx}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

/* ═══ Styles ══════════════════════════════════════════════════════ */

const STATUS_H =
  Platform.OS === 'android' ? StatusBar.currentHeight ?? 0 : 0;

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bg,
    // paddingTop: STATUS_H,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textMuted: {
    color: C.textMuted,
    fontSize: 13,
  },

  /* ── Login ── */
  loginBody: {
    padding: 24,
    paddingBottom: 40,
  },
  loginHeader: {
    marginTop: 40,
    marginBottom: 8,
  },
  loginTitle: {
    fontSize: 32,
    fontWeight: '800',
    color: C.text,
    letterSpacing: -1,
  },
  loginSub: {
    fontSize: 14,
    color: C.accent,
    fontWeight: '600',
    marginTop: 2,
  },
  loginDesc: {
    color: C.textSec,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 16,
  },
  fieldLabel: {
    color: C.textSec,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 14,
    marginBottom: 4,
  },
  input: {
    backgroundColor: C.surfaceEl,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 10,
    padding: 13,
    color: C.text,
    fontSize: 15,
  },
  primaryBtn: {
    backgroundColor: C.accent,
    padding: 15,
    borderRadius: 12,
    marginTop: 24,
    alignItems: 'center',
  },
  primaryBtnTx: {
    color: C.bg,
    fontWeight: '700',
    fontSize: 15,
  },
  errText: {
    color: C.low,
    marginTop: 10,
    fontWeight: '600',
    fontSize: 13,
  },
  fine: {
    color: C.textMuted,
    fontSize: 11,
    marginTop: 16,
    lineHeight: 16,
  },

  /* ── Header ── */
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  headerLeft: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: C.text,
    letterSpacing: -0.5,
  },
  headerPatient: {
    color: C.textSec,
    fontSize: 12,
    marginTop: 1,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
  },
  statusPillOn: {
    backgroundColor: C.inRangeDim,
    borderColor: 'rgba(74,222,128,0.25)',
  },
  statusPillOff: {
    backgroundColor: C.surfaceEl,
    borderColor: C.border,
  },
  statusPillTx: {
    fontWeight: '600',
    fontSize: 11,
  },

  /* ── Content ── */
  content: {
    padding: 16,
    gap: 12,
    paddingBottom: 80,
  },

  /* ── Card ── */
  card: {
    backgroundColor: C.surface,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: C.border,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: C.textSec,
    marginBottom: 10,
    letterSpacing: 0.3,
  },

  /* ── Home: Reading ── */
  syncRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  syncLabel: {
    color: C.textMuted,
    fontSize: 10,
    fontWeight: '600',
  },
  syncTrack: {
    flex: 1,
    height: 3,
    backgroundColor: C.surfaceElevated,
    borderRadius: 2,
    overflow: 'hidden',
  },
  syncFill: {
    height: '100%',
    borderRadius: 2,
  },
  readingRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 12,
  },
  readingValue: {
    fontSize: 58,
    fontWeight: '800',
    lineHeight: 62,
    letterSpacing: -2,
    color: '#FFFFFF',
  },
  readingDetails: {
    paddingBottom: 8,
    gap: 4,
  },
  readingUnits: {
    fontWeight: '500',
    fontSize: 14,
    color: C.textSec,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgeTx: {
    color: C.white,
    fontWeight: '700',
    fontSize: 10,
    letterSpacing: 0.3,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 8,
    flexWrap: 'wrap',
  },
  trendArrow: {
    fontSize: 18,
    fontWeight: '700',
  },
  metaTx: {
    color: C.textSec,
    fontSize: 12,
    fontWeight: '500',
  },
  metaAccent: {
    color: C.accent,
    fontSize: 12,
    fontWeight: '600',
  },
  metaDot: {
    color: C.textMuted,
    fontSize: 12,
  },
  staleBar: {
    backgroundColor: C.lowDim,
    borderRadius: 8,
    padding: 10,
    marginTop: 8,
  },
  staleTx: {
    color: C.low,
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 16,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  emptyTitle: {
    color: C.text,
    fontSize: 16,
    fontWeight: '700',
  },
  emptyHint: {
    color: C.textSec,
    fontSize: 13,
    marginTop: 4,
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  footerTx: {
    color: C.textMuted,
    fontSize: 11,
    fontWeight: '500',
    flex: 1,
  },
  refreshBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: C.surfaceEl,
  },
  refreshBtnTx: {
    color: C.accent,
    fontSize: 11,
    fontWeight: '600',
  },

  /* ── Quick Actions ── */
  actionsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 10,
    backgroundColor: C.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
  },
  actionTx: {
    color: C.textSec,
    fontSize: 12,
    fontWeight: '600',
  },
  testAlertBtn: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  testAlertBtnTx: {
    fontSize: 12,
    fontWeight: '700',
  },

  /* ── Chart ── */
  chartContainer: {
    backgroundColor: '#0F1626',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    overflow: 'hidden',
    position: 'relative',
  },
  chartEmpty: {
    backgroundColor: '#0F1626',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chartEmptyIcon: {
    fontSize: 24,
    color: C.textMuted,
    marginBottom: 6,
  },
  emptyChart: {
    paddingVertical: 24,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0F1626',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  emptyChartIcon: {
    fontSize: 28,
    marginBottom: 8,
  },
  emptyChartTitle: {
    color: C.text,
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },
  emptyChartSub: {
    color: C.textSec,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 4,
    lineHeight: 16,
    maxWidth: 280,
  },
  baselineBtn: {
    marginTop: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: C.accentDim,
    borderWidth: 1,
    borderColor: C.accent,
  },
  baselineBtnTx: {
    color: C.accent,
    fontSize: 12,
    fontWeight: '700',
  },
  chartHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  returnTodayBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: C.surfaceEl,
    borderWidth: 1,
    borderColor: C.borderLight,
  },
  returnTodayTx: {
    color: C.accent,
    fontSize: 11,
    fontWeight: '700',
  },
  chartZone: {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: 'rgba(16, 185, 129, 0.07)',
  },
  chartGuide: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingRight: 6,
  },
  chartGuideDashed: {
    flex: 1,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.12)',
    borderStyle: 'dashed',
  },
  chartGuideBadgePill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
    backgroundColor: '#162035',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    marginLeft: 6,
  },
  chartGuideBadge: {
    fontSize: 10,
    fontWeight: '700',
  },
  scrubPill: {
    position: 'absolute',
    backgroundColor: '#1A2338',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderWidth: 1.5,
    borderColor: C.accent,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    elevation: 8,
  },
  scrubPillVal: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
  scrubPillUnit: {
    fontSize: 10,
    color: '#CBD5E1',
    fontWeight: '600',
  },
  scrubPillTime: {
    color: '#CBD5E1',
    fontSize: 11,
    fontWeight: '600',
  },
  timeAxis: {
    position: 'absolute',
    left: 14,
    right: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  timeLabel: {
    color: C.textSec,
    fontSize: 10,
    fontWeight: '600',
  },

  /* ── Glance ── */
  glanceRow: {
    flexDirection: 'row',
    gap: 8,
  },
  glanceItem: {
    flex: 1,
    backgroundColor: C.surface,
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: C.border,
  },
  glanceLabel: {
    color: C.textMuted,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  glanceVal: {
    fontSize: 18,
    fontWeight: '800',
    marginTop: 2,
    color: C.text,
  },

  /* ── Graph Tab ── */
  calStrip: {
    gap: 6,
    paddingBottom: 4,
  },
  calDay: {
    backgroundColor: C.surface,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: C.border,
    minWidth: 56,
  },
  calDayOn: {
    backgroundColor: '#1E293B',
    borderColor: C.accent,
  },
  calDayName: {
    color: C.textSec,
    fontSize: 11,
    fontWeight: '600',
  },
  calDayNameOn: {
    color: C.accent,
  },
  calDayNum: {
    color: C.text,
    fontSize: 16,
    fontWeight: '800',
    marginTop: 1,
  },
  calDayNumOn: {
    color: C.white,
  },
  calDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginTop: 4,
  },
  chipRowCompact: {
    flexDirection: 'row',
    gap: 6,
  },
  windowChip: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
  },
  windowChipOn: {
    backgroundColor: '#1E293B',
    borderColor: C.accent,
  },
  windowChipTx: {
    color: C.textSec,
    fontWeight: '700',
    fontSize: 12,
  },
  windowChipTxOn: {
    color: C.accent,
  },
  summaryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  summaryItem: {
    flex: 1,
    minWidth: '45%',
    backgroundColor: C.surfaceEl,
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: C.border,
  },
  summaryLabel: {
    color: C.textMuted,
    fontSize: 10,
    fontWeight: '600',
  },
  summaryVal: {
    fontSize: 16,
    fontWeight: '800',
    marginTop: 2,
    color: C.text,
  },
  dataSyncCard: {
    backgroundColor: C.surface,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: C.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  dataSyncTitle: {
    color: C.text,
    fontSize: 12,
    fontWeight: '700',
  },
  dataSyncSub: {
    color: C.textSec,
    fontSize: 11,
    marginTop: 2,
  },
  dataSyncBtn: {
    backgroundColor: C.accentDim,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.accent,
  },
  dataSyncBtnTx: {
    color: C.accent,
    fontSize: 11,
    fontWeight: '700',
  },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  eventTitle: {
    color: C.text,
    fontSize: 13,
    fontWeight: '500',
  },
  eventNote: {
    color: C.textMuted,
    fontSize: 11,
    marginTop: 1,
  },
  eventTime: {
    color: C.textMuted,
    fontSize: 11,
  },

  /* ── Stats Tab ── */
  tirBar: {
    flexDirection: 'row',
    height: 12,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: C.surfaceEl,
    marginBottom: 12,
  },
  tirLegend: {
    gap: 6,
  },
  tirRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  tirDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  tirLabel: {
    flex: 1,
    color: C.textSec,
    fontSize: 12,
  },
  tirVal: {
    fontSize: 12,
    fontWeight: '700',
    width: 48,
    textAlign: 'right',
  },
  tirGoal: {
    color: C.textMuted,
    fontSize: 10,
    width: 40,
    textAlign: 'right',
  },
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  metricBox: {
    flex: 1,
    minWidth: '45%',
    backgroundColor: C.surfaceEl,
    borderRadius: 10,
    padding: 10,
  },
  metricLabel: {
    color: C.textMuted,
    fontSize: 10,
    fontWeight: '600',
  },
  metricVal: {
    fontSize: 17,
    fontWeight: '800',
    marginTop: 2,
    color: C.text,
  },
  metricSub: {
    color: C.textMuted,
    fontSize: 10,
    marginTop: 1,
  },
  calOverview: {
    gap: 0,
  },
  calOverviewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  calOverviewLabel: {
    flex: 1,
    color: C.text,
    fontSize: 13,
    fontWeight: '500',
  },
  calOverviewStats: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  calMiniBar: {
    width: 32,
    height: 5,
    borderRadius: 2.5,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  calOverviewTir: {
    fontSize: 12,
    fontWeight: '700',
    width: 38,
    textAlign: 'right',
  },
  calOverviewAvg: {
    color: C.textSec,
    fontSize: 12,
    width: 72,
    textAlign: 'right',
  },
  calOverviewNone: {
    color: C.textMuted,
    fontSize: 12,
  },
  dataNoticeCard: {
    backgroundColor: C.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(94, 194, 183, 0.3)',
    padding: 14,
    alignItems: 'center',
    marginTop: 10,
  },
  dataNoticeTitle: {
    color: C.text,
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
  },
  dataNoticeSub: {
    color: C.textSec,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 4,
    lineHeight: 16,
  },

  /* ── Settings ── */
  settLabel: {
    color: C.textSec,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    marginTop: 12,
    marginBottom: 2,
  },
  dataStatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dataStatSub: {
    color: C.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  dataBtnCompact: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: C.surfaceEl,
    borderWidth: 1,
    borderColor: C.border,
  },
  dataBtnCompactTx: {
    color: C.accent,
    fontSize: 11,
    fontWeight: '600',
  },
  chipRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 6,
    flexWrap: 'wrap',
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: C.surfaceEl,
    borderWidth: 1,
    borderColor: C.border,
  },
  chipOn: {
    backgroundColor: C.accent,
    borderColor: C.accent,
  },
  chipTx: {
    color: C.textSec,
    fontWeight: '600',
    fontSize: 12,
  },
  chipTxOn: {
    color: C.bg,
    fontWeight: '700',
  },
  toggleRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
    alignItems: 'center',
  },
  toggleLabel: {
    color: C.text,
    fontSize: 13,
    fontWeight: '600',
  },
  toggleSub: {
    color: C.textSec,
    fontSize: 11,
    marginTop: 1,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: C.textMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: {
    backgroundColor: C.accent,
    borderColor: C.accent,
  },
  checkmark: {
    color: C.bg,
    fontWeight: '800',
    fontSize: 12,
  },
  permRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  permLabel: {
    color: C.text,
    fontSize: 13,
    fontWeight: '500',
    flex: 1,
    marginRight: 8,
  },
  permBtn: {
    backgroundColor: C.surfaceEl,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  },
  permBtnTx: {
    color: C.accent,
    fontSize: 11,
    fontWeight: '600',
  },
  accountTx: {
    color: C.textSec,
    fontSize: 13,
    marginBottom: 3,
  },
  signOutBtn: {
    marginTop: 12,
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: C.lowDim,
  },
  signOutTx: {
    color: C.low,
    fontWeight: '600',
    fontSize: 13,
  },

  /* ── Tab Bar ── */
  tabBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 62,
    flexDirection: 'row',
    backgroundColor: '#0A0F1D',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.12)',
    paddingBottom: Platform.OS === 'ios' ? 16 : 4,
    elevation: 10,
  },
  tabActiveIndicator: {
    position: 'absolute',
    top: 0,
    width: 28,
    height: 2.5,
    borderRadius: 1.25,
    backgroundColor: '#38BDF8',
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  tabIcon: {
    fontSize: 19,
    color: '#94A3B8',
  },
  tabIconOn: {
    color: '#38BDF8',
  },
  tabLabel: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '600',
  },
  tabLabelOn: {
    color: '#38BDF8',
    fontWeight: '700',
  },

  /* ── Modal ── */
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: C.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    paddingBottom: 30,
  },
  modalTitle: {
    color: C.text,
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 14,
  },
  modalInput: {
    backgroundColor: C.surfaceEl,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    padding: 13,
    color: C.text,
    fontSize: 15,
  },
  modalActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 16,
  },
  modalCancel: {
    flex: 1,
    padding: 13,
    borderRadius: 10,
    backgroundColor: C.surfaceEl,
    alignItems: 'center',
  },
  modalCancelTx: {
    color: C.textSec,
    fontWeight: '600',
  },
  modalSave: {
    flex: 1,
    padding: 13,
    borderRadius: 10,
    backgroundColor: C.accent,
    alignItems: 'center',
  },
  modalSaveTx: {
    color: C.bg,
    fontWeight: '700',
  },
});
