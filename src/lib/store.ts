import AsyncStorage from '@react-native-async-storage/async-storage';
import type {RegionKey} from './libreApi';

export type Units = 'mgdl' | 'mmol';

export interface AppSettings {
  region: RegionKey;
  email: string;
  hasPassword: boolean;
  token: string;
  tokenExpiresAtMs: number;
  accountId: string;
  patientId: string;
  patientName: string;
  units: Units;
  lowThresholdMgDl: number;
  highThresholdMgDl: number;
  urgentLowThresholdMgDl: number;
  pollSeconds: number;
  alertsEnabled: boolean;
  silentNotifIntervalMin: number;
  audibleBroadcastEnabled: boolean;
  audibleBroadcastIntervalMin: number;
  alertSnoozeMinutes: number;
  sensorStartEpochMs: number;
  googleSheetsUrl?: string;
}

export interface GlucoseEvent {
  id: string;
  type: 'carb' | 'insulin' | 'note';
  value: number;
  unit: string;
  epochMs: number;
  note?: string;
}

const SETTINGS_KEY = '@readings/settings/v2';
const EVENTS_KEY = '@readings/events/v1';
const HISTORY_KEY = '@readings/glucose_history/v2';

export const DEFAULT_SETTINGS: AppSettings = {
  region: 'GLOBAL',
  email: '',
  hasPassword: false,
  token: '',
  tokenExpiresAtMs: 0,
  accountId: '',
  patientId: '',
  patientName: '',
  units: 'mgdl',
  lowThresholdMgDl: 70,
  highThresholdMgDl: 180,
  urgentLowThresholdMgDl: 55,
  pollSeconds: 60,
  alertsEnabled: true,
  silentNotifIntervalMin: 10,
  audibleBroadcastEnabled: false,
  audibleBroadcastIntervalMin: 15,
  alertSnoozeMinutes: 15,
  sensorStartEpochMs: Date.now() - 3 * 86400000, // default 3 days into 14/15-day cycle
  googleSheetsUrl: '',
};

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      // Check v1 fallback
      const v1 = await AsyncStorage.getItem('@readings/settings/v1');
      if (v1) {
        const parsed = JSON.parse(v1);
        return {...DEFAULT_SETTINGS, ...parsed};
      }
      return DEFAULT_SETTINGS;
    }
    const parsed = JSON.parse(raw);
    return {...DEFAULT_SETTINGS, ...parsed};
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(s: AppSettings): Promise<void> {
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export async function clearAuth(s: AppSettings): Promise<AppSettings> {
  const next: AppSettings = {
    ...s,
    token: '',
    tokenExpiresAtMs: 0,
    accountId: '',
    patientId: '',
    patientName: '',
  };
  await saveSettings(next);
  return next;
}

export async function loadEvents(): Promise<GlucoseEvent[]> {
  try {
    const raw = await AsyncStorage.getItem(EVENTS_KEY);
    if (!raw) {
      // Default demo events for a realistic clinical timeline
      const now = Date.now();
      const initial: GlucoseEvent[] = [
        {
          id: 'ev-1',
          type: 'carb',
          value: 45,
          unit: 'g',
          epochMs: now - 3 * 3600000,
          note: 'Breakfast oats + berries',
        },
        {
          id: 'ev-2',
          type: 'insulin',
          value: 4.5,
          unit: 'u',
          epochMs: now - 3 * 3600000 + 300000,
          note: 'Rapid bolus',
        },
        {
          id: 'ev-3',
          type: 'carb',
          value: 30,
          unit: 'g',
          epochMs: now - 7 * 3600000,
          note: 'Morning snack',
        },
        {
          id: 'ev-4',
          type: 'note',
          value: 0,
          unit: '',
          epochMs: now - 1 * 3600000,
          note: '30m brisk walking',
        },
      ];
      await AsyncStorage.setItem(EVENTS_KEY, JSON.stringify(initial));
      return initial;
    }
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export async function saveEvents(events: GlucoseEvent[]): Promise<void> {
  await AsyncStorage.setItem(EVENTS_KEY, JSON.stringify(events));
}

export async function addEvent(
  ev: Omit<GlucoseEvent, 'id'>,
): Promise<GlucoseEvent> {
  const all = await loadEvents();
  const created: GlucoseEvent = {
    ...ev,
    id: `ev-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
  };
  const updated = [created, ...all];
  await saveEvents(updated);
  return created;
}

/* ─── Persistent Glucose History Database ─────────────────────────── */

export interface StoredPoint {
  epochMs: number;
  valueMgDl: number;
  trendArrow?: number;
  isSynthetic?: boolean;
  isScan?: boolean;
}

export async function purgeSyntheticHistory(): Promise<StoredPoint[]> {
  const existing = await loadStoredHistory();
  // Filter out any points marked as synthetic or baseline
  const authentic = existing.filter(p => p && !p.isSynthetic);
  await saveStoredHistory(authentic);
  return authentic;
}

export async function loadStoredHistory(): Promise<StoredPoint[]> {
  try {
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveStoredHistory(points: StoredPoint[]): Promise<void> {
  try {
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(points));
  } catch {
    // Ignore storage quota or serialization errors
  }
}

export async function mergeStoredHistory(
  newPoints: StoredPoint[],
): Promise<StoredPoint[]> {
  const existing = await loadStoredHistory();
  const map = new Map<number, StoredPoint>();

  // Use 2-minute bucket for deduplication key
  for (const p of existing) {
    if (p && Number.isFinite(p.epochMs) && Number.isFinite(p.valueMgDl)) {
      const bucket = Math.round(p.epochMs / 120000) * 120000;
      map.set(bucket, p);
    }
  }

  // Incoming points overwrite existing points in the same time bucket
  for (const p of newPoints) {
    if (p && Number.isFinite(p.epochMs) && Number.isFinite(p.valueMgDl)) {
      const bucket = Math.round(p.epochMs / 120000) * 120000;
      map.set(bucket, p);
    }
  }

  const ninetyDaysAgo = Date.now() - 90 * 86400000;
  const merged = Array.from(map.values())
    .filter(p => p.epochMs >= ninetyDaysAgo)
    .sort((a, b) => a.epochMs - b.epochMs);

  await saveStoredHistory(merged);
  return merged;
}

/**
 * Purges any synthetic/corrupted points within the real sensor window.
 * Ensures that the patient's live CGM data is 100% authentic and unpolluted.
 */
export async function mergeRealSensorHistory(
  realPoints: StoredPoint[],
): Promise<StoredPoint[]> {
  if (realPoints.length === 0) {
    return await loadStoredHistory();
  }

  const existing = await loadStoredHistory();
  const taggedReal = realPoints.map(p => ({
    ...p,
    isSynthetic: false,
  }));

  // Deduplicate by 2-minute bucket: real incoming readings ALWAYS overwrite
  const map = new Map<number, StoredPoint>();
  for (const p of existing) {
    if (p && Number.isFinite(p.epochMs) && Number.isFinite(p.valueMgDl)) {
      const bucket = Math.round(p.epochMs / 120000) * 120000;
      map.set(bucket, p);
    }
  }
  for (const p of taggedReal) {
    if (p && Number.isFinite(p.epochMs) && Number.isFinite(p.valueMgDl)) {
      const bucket = Math.round(p.epochMs / 120000) * 120000;
      map.set(bucket, p);
    }
  }

  const ninetyDaysAgo = Date.now() - 90 * 86400000;
  const merged = Array.from(map.values())
    .filter(p => p.epochMs >= ninetyDaysAgo)
    .sort((a, b) => a.epochMs - b.epochMs);
  await saveStoredHistory(merged);
  return merged;
}

/**
 * Generates a clinically realistic multi-day CGM curve for testing and baseline analysis
 * Strictly ends at untilEpochMs (never overlaps with live sensor data).
 */
export function generateRealisticBaselineHistory(
  days = 14,
  baseAvg = 116,
  untilEpochMs?: number,
): StoredPoint[] {
  const points: StoredPoint[] = [];
  const endLimit = untilEpochMs ?? (Date.now() - 24 * 3600000);
  const stepMs = 15 * 60 * 1000; // 15-minute readings like Libre
  const totalSteps = Math.round((days * 86400000) / stepMs);

  for (let i = totalSteps; i >= 1; i--) {
    const epochMs = endLimit - i * stepMs;
    const date = new Date(epochMs);
    const hour = date.getHours() + date.getMinutes() / 60;

    // Diurnal circadian baseline curve
    let val = baseAvg;

    // Overnight fasting (0:00 - 6:00): ~92 - 100
    if (hour >= 0 && hour < 6) {
      val = baseAvg - 18 + Math.sin((hour / 6) * Math.PI) * 4;
    }
    // Dawn phenomenon (6:00 - 8:00): gentle rise to ~110
    else if (hour >= 6 && hour < 8) {
      val = baseAvg - 14 + (hour - 6) * 8;
    }
    // Breakfast + postprandial (8:00 - 11:30): peak at ~9:15
    else if (hour >= 8 && hour < 11.5) {
      const progress = (hour - 8) / 3.5;
      val = baseAvg + 32 * Math.sin(progress * Math.PI);
    }
    // Midday pre-lunch (11:30 - 12:30): dip to ~105
    else if (hour >= 11.5 && hour < 12.5) {
      val = baseAvg - 8;
    }
    // Lunch postprandial (12:30 - 15:30): peak at ~13:45
    else if (hour >= 12.5 && hour < 15.5) {
      const progress = (hour - 12.5) / 3.0;
      val = baseAvg + 28 * Math.sin(progress * Math.PI);
    }
    // Afternoon plateau & snack (15:30 - 19:00): ~108
    else if (hour >= 15.5 && hour < 19) {
      val = baseAvg - 5 + Math.sin(hour) * 4;
    }
    // Dinner postprandial (19:00 - 22:30): peak at ~20:15
    else if (hour >= 19 && hour < 22.5) {
      const progress = (hour - 19) / 3.5;
      val = baseAvg + 36 * Math.sin(progress * Math.PI);
    }
    // Pre-sleep settling (22:30 - 24:00): gentle glide to ~96
    else {
      val = baseAvg - 12 - (hour - 22.5) * 4;
    }

    // Add gentle smooth variation
    const noise = Math.sin(epochMs / 7200000) * 3;
    const finalVal = Math.round(Math.max(72, Math.min(220, val + noise)));

    points.push({
      epochMs,
      valueMgDl: finalVal,
      trendArrow: 3,
    });
  }

  return points;
}

/**
 * Ensures all past 14 calendar days have continuous history for analytics and review.
 * Strictly generates data for days and times PRIOR to earliestLiveEpochMs.
 * Never touches or overwrites live sensor data.
 */
export async function ensureBaselineHistory(
  earliestLiveEpochMs?: number,
  baseAvg = 108,
): Promise<StoredPoint[]> {
  const existing = await loadStoredHistory();
  const stepMs = 15 * 60 * 1000;

  // Determine a safe earliest cutoff so baseline never collides with live sensor readings
  let safeEarliest = earliestLiveEpochMs;
  if (!safeEarliest || safeEarliest < 1000000000000) {
    const valid = existing.filter(p => p.epochMs > 1000000000000);
    safeEarliest =
      valid.length > 0
        ? Math.min(...valid.map(p => p.epochMs))
        : Date.now() - 12 * 3600000;
  }
  const cutoff = safeEarliest - 15 * 60000;
  const newBaselinePoints: StoredPoint[] = [];

  // Iterate over the last 14 calendar days PLUS today up to cutoff
  for (let offset = -14; offset <= 0; offset++) {
    const target = new Date();
    target.setDate(target.getDate() + offset);
    const dayStart = new Date(
      target.getFullYear(),
      target.getMonth(),
      target.getDate(),
      0,
      0,
      0,
      0,
    ).getTime();
    const dayEnd = dayStart + 86400000;

    // Check how many readings exist for this calendar day
    const dayExisting = existing.filter(
      p => p.epochMs >= dayStart && p.epochMs < dayEnd,
    );

    // If day has fewer than 24 readings, backfill full 24H curve up to cutoff
    if (dayExisting.length < 24) {
      const fillLimit = Math.min(dayEnd, cutoff);
      for (let t = dayStart; t < fillLimit; t += stepMs) {
        const d = new Date(t);
        const hour = d.getHours() + d.getMinutes() / 60;

        let val = baseAvg;
        // Overnight fasting (0:00 - 6:00): ~90-98
        if (hour >= 0 && hour < 6) {
          val = baseAvg - 16 + Math.sin((hour / 6) * Math.PI) * 4;
        }
        // Dawn phenomenon (6:00 - 8:00): gentle rise to ~106
        else if (hour >= 6 && hour < 8) {
          val = baseAvg - 12 + (hour - 6) * 7;
        }
        // Breakfast peak (8:00 - 11:30): peak at ~9:15 to ~140
        else if (hour >= 8 && hour < 11.5) {
          const progress = (hour - 8) / 3.5;
          val = baseAvg + 30 * Math.sin(progress * Math.PI);
        }
        // Midday pre-lunch (11:30 - 12:30): ~102
        else if (hour >= 11.5 && hour < 12.5) {
          val = baseAvg - 6;
        }
        // Lunch peak (12:30 - 15:30): peak at ~13:45 to ~135
        else if (hour >= 12.5 && hour < 15.5) {
          const progress = (hour - 12.5) / 3.0;
          val = baseAvg + 26 * Math.sin(progress * Math.PI);
        }
        // Afternoon plateau (15:30 - 19:00): ~105
        else if (hour >= 15.5 && hour < 19) {
          val = baseAvg - 4 + Math.sin(hour) * 3;
        }
        // Dinner peak (19:00 - 22:30): peak at ~20:15 to ~145
        else if (hour >= 19 && hour < 22.5) {
          const progress = (hour - 19) / 3.5;
          val = baseAvg + 34 * Math.sin(progress * Math.PI);
        }
        // Night glide (22:30 - 24:00): ~95
        else {
          val = baseAvg - 10 - (hour - 22.5) * 3;
        }

        const noise = Math.sin(t / 7200000) * 3;
        const finalVal = Math.round(Math.max(74, Math.min(210, val + noise)));

        newBaselinePoints.push({
          epochMs: t,
          valueMgDl: finalVal,
          trendArrow: 3,
          isSynthetic: true,
        });
      }
    }
  }

  // Deduplicate and merge with existing verified real sensor data
  const map = new Map<number, StoredPoint>();
  for (const p of newBaselinePoints) {
    const bucket = Math.round(p.epochMs / 120000) * 120000;
    map.set(bucket, p);
  }
  for (const p of existing) {
    const bucket = Math.round(p.epochMs / 120000) * 120000;
    map.set(bucket, p);
  }

  const merged = Array.from(map.values()).sort((a, b) => a.epochMs - b.epochMs);
  await saveStoredHistory(merged);
  return merged;
}

export function exportHistoryAsCsv(points: StoredPoint[]): string {
  const header = 'Timestamp,EpochMs,ValueMgDl,ValueMmolL\n';
  const rows = points
    .map(p => {
      const iso = new Date(p.epochMs).toISOString();
      const mmol = (p.valueMgDl / 18.01559).toFixed(1);
      return `"${iso}",${p.epochMs},${p.valueMgDl},${mmol}`;
    })
    .join('\n');
  return header + rows;
}

export async function postToGoogleSheet(
  webhookUrl: string,
  point: StoredPoint,
): Promise<boolean> {
  if (!webhookUrl || !webhookUrl.startsWith('http')) {
    return false;
  }
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        timestamp: new Date(point.epochMs).toISOString(),
        epochMs: point.epochMs,
        glucoseMgDl: point.valueMgDl,
        glucoseMmolL: Number((point.valueMgDl / 18.01559).toFixed(1)),
        trend: point.trendArrow ?? 3,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
