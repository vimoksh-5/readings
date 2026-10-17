export type RegionKey =
  | 'GLOBAL'
  | 'US'
  | 'EU'
  | 'EU2'
  | 'LA'
  | 'AP'
  | 'AE'
  | 'AU'
  | 'CA'
  | 'DE'
  | 'FR'
  | 'JP';

export const REGIONS: Record<RegionKey, string> = {
  GLOBAL: 'https://api.libreview.io',
  US: 'https://api-us.libreview.io',
  EU: 'https://api-eu.libreview.io',
  EU2: 'https://api-eu2.libreview.io',
  LA: 'https://api-la.libreview.io',
  AP: 'https://api-ap.libreview.io',
  AE: 'https://api-ae.libreview.io',
  AU: 'https://api-au.libreview.io',
  CA: 'https://api-ca.libreview.io',
  DE: 'https://api-de.libreview.io',
  FR: 'https://api-fr.libreview.io',
  JP: 'https://api-jp.libreview.io',
};

export function regionFromString(s: string): RegionKey {
  const k = (s || '').trim().toUpperCase();
  if ((Object.keys(REGIONS) as RegionKey[]).includes(k as RegionKey)) {
    return k as RegionKey;
  }
  return 'GLOBAL';
}

// NOTE: do NOT set Accept-Encoding / Connection / Cache-Control here.
// React Native's OkHttp stack manages those itself; setting them manually
// is a known cause of "Network request failed" on Android.
const APP_HEADERS = {
  'Content-Type': 'application/json',
  product: 'llu.android',
  version: '4.16.0',
  Accept: 'application/json',
};

function authHeaders(token: string, accountId?: string): Record<string, string> {
  const h: Record<string, string> = {
    ...(APP_HEADERS as Record<string, string>),
    Authorization: `Bearer ${token}`,
  };
  if (accountId) {
    h['account-id'] = sha256Hex(accountId);
  }
  return h;
}

/** Minimal synchronous SHA-256 (hex) — used for the `account-id` header. */
export function sha256Hex(input: string): string {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const bytes: number[] = [];
  const unescaped = unescape(encodeURIComponent(input));
  for (let i = 0; i < unescaped.length; i++) {
    bytes.push(unescaped.charCodeAt(i));
  }
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) {
    bytes.push(0);
  }
  for (let i = 7; i >= 0; i--) {
    bytes.push(Math.floor(bitLen / Math.pow(2, i * 8)) & 0xff);
  }
  const w = new Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let j = 0; j < bytes.length; j += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] =
        ((bytes[j + i * 4] << 24) |
          (bytes[j + i * 4 + 1] << 16) |
          (bytes[j + i * 4 + 2] << 8) |
          bytes[j + i * 4 + 3]) >>>
        0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = [h0, h1, h2, h3, h4, h5, h6, h7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map(x => (x >>> 0).toString(16).padStart(8, '0'))
    .join('');
}

export interface GlucoseMeasurement {
  valueMgDl: number;
  trendArrow: number; // 0..6 (0/6 = no trend, 1 = down, 3 = flat, 5 = up)
  timestamp: string; // ISO from server
  factoryTimestamp: string;
  epochMs: number;
}

export interface GraphPoint {
  epochMs: number;
  valueMgDl: number;
  isScan?: boolean;
  isSynthetic?: boolean;
}

export interface LoginResult {
  token: string;
  expiresAtMs: number;
  accountId: string;
  /** Home region after following any server redirect (may differ from request). */
  region: RegionKey;
}

export interface ConnectionInfo {
  patientId: string;
  firstName: string;
  lastName: string;
}

function parseMeasurement(raw: any): GlucoseMeasurement | null {
  if (!raw) {
    return null;
  }
  const value = Number(raw.ValueInMgPerDl ?? raw.Value);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  const fts: string = raw.FactoryTimestamp ?? '';
  const ts: string = raw.Timestamp ?? fts;
  const epochMs = parseLibrePointTimestamp({
    FactoryTimestamp: fts,
    Timestamp: ts,
  });
  return {
    valueMgDl: Math.round(value),
    trendArrow: Number(raw.TrendArrow ?? 0),
    timestamp: ts,
    factoryTimestamp: fts,
    epochMs,
  };
}

export function parseFactoryTimestampUtc(fts: string): number {
  if (!fts) {
    return 0;
  }
  // If ISO string with timezone offset (Z, +, -)
  if (
    fts.includes('T') &&
    (fts.endsWith('Z') || fts.includes('+') || fts.includes('-'))
  ) {
    const p = Date.parse(fts);
    if (Number.isFinite(p)) {
      return p;
    }
  }
  // Standard LibreLinkUp format: "M/D/YYYY h:mm:ss A" in UTC
  const m = fts.match(
    /(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+):?(\d*)\s*(AM|PM)?/i,
  );
  if (m) {
    let month = Number(m[1]);
    let day = Number(m[2]);
    let year = Number(m[3]);
    let hour = Number(m[4]);
    const min = Number(m[5]);
    const sec = Number(m[6] || 0);
    const ampm = (m[7] || '').toUpperCase();
    if (ampm === 'PM' && hour < 12) {
      hour += 12;
    }
    if (ampm === 'AM' && hour === 12) {
      hour = 0;
    }
    return Date.UTC(year, month - 1, day, hour, min, sec);
  }
  return 0;
}

export function parseLocalTimestamp(ts: string): number {
  if (!ts) {
    return 0;
  }
  const m = ts.match(
    /(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+):?(\d*)\s*(AM|PM)?/i,
  );
  if (m) {
    let month = Number(m[1]);
    let day = Number(m[2]);
    let year = Number(m[3]);
    let hour = Number(m[4]);
    const min = Number(m[5]);
    const sec = Number(m[6] || 0);
    const ampm = (m[7] || '').toUpperCase();
    if (ampm === 'PM' && hour < 12) {
      hour += 12;
    }
    if (ampm === 'AM' && hour === 12) {
      hour = 0;
    }
    return new Date(year, month - 1, day, hour, min, sec).getTime();
  }
  const iso = Date.parse(ts);
  return Number.isFinite(iso) ? iso : 0;
}

export function parseLibrePointTimestamp(item: {
  FactoryTimestamp?: string;
  Timestamp?: string;
}): number {
  if (item.FactoryTimestamp) {
    const epoch = parseFactoryTimestampUtc(item.FactoryTimestamp);
    if (epoch > 0) {
      return epoch;
    }
  }
  if (item.Timestamp) {
    const epoch = parseLocalTimestamp(item.Timestamp);
    if (epoch > 0) {
      return epoch;
    }
  }
  return Date.now();
}

export function parseServerTimestamp(ts: string): number {
  if (!ts) {
    return Date.now();
  }
  const utc = parseFactoryTimestampUtc(ts);
  if (utc > 0) {
    return utc;
  }
  const loc = parseLocalTimestamp(ts);
  if (loc > 0) {
    return loc;
  }
  return Date.now();
}

export async function libreLogin(
  region: RegionKey,
  email: string,
  password: string,
): Promise<LoginResult> {
  // The global endpoint auto-redirects to the account's home region.
  let current: RegionKey = region;
  for (let attempt = 0; attempt < 3; attempt++) {
    const base = REGIONS[current];
    let res: Response;
    try {
      res = await fetch(`${base}/llu/auth/login`, {
        method: 'POST',
        headers: APP_HEADERS as any,
        body: JSON.stringify({email, password}),
      });
    } catch (e: any) {
      throw new Error(
        `Could not reach ${base}. Check internet connection. ` +
          `Detail: ${e?.message ?? 'network error'}`,
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        'Invalid email/password, or wrong region selected. ' +
          'Try GLOBAL first — it auto-redirects to your home region.',
      );
    }
    if (!res.ok) {
      throw new Error(`Login failed (HTTP ${res.status}).`);
    }
    const json = await res.json();
    // Regional redirect: { status, data: { redirect: true, region: "EU" } }
    if (json?.data?.redirect === true && json?.data?.region) {
      current = regionFromString(String(json.data.region));
      continue;
    }
    if (json?.status === 2) {
      throw new Error('Invalid email/password, or wrong region selected.');
    }
    if (json?.status === 4) {
      throw new Error(
        'Abbott requires an extra verification step (e.g. email code). ' +
          'Complete it once in the LibreLink/LibreLinkUp app, then try again.',
      );
    }
    if (json?.data?.data?.lockout || json?.data?.code === 429) {
      throw new Error(
        'Account temporarily locked after too many attempts. Wait a few minutes and try again.',
      );
    }
    const ticket = json?.data?.authTicket;
    const user = json?.data?.user;
    const token: string | undefined = ticket?.token;
    if (!token) {
      throw new Error('Login failed: no auth token in response.');
    }
    const durationSec = Number(ticket?.duration ?? 2592000);
    return {
      token,
      expiresAtMs: Date.now() + durationSec * 1000 - 60_000,
      accountId: String(user?.id ?? ''),
      region: current,
    };
  }
  throw new Error('Login failed: too many regional redirects.');
}

export async function libreConnections(
  region: RegionKey,
  token: string,
  accountId?: string,
): Promise<ConnectionInfo[]> {
  const base = REGIONS[region];
  const res = await fetch(`${base}/llu/connections`, {
    headers: authHeaders(token, accountId),
  });
  if (res.status === 401) {
    throw Object.assign(new Error('Token expired'), {code: 'AUTH'});
  }
  if (!res.ok) {
    throw new Error(`Connections failed (HTTP ${res.status}).`);
  }
  const json = await res.json();
  const list = Array.isArray(json?.data) ? json.data : [];
  return list.map((c: any) => ({
    patientId: String(c.patientId ?? c.patient_id ?? ''),
    firstName: String(c.firstName ?? ''),
    lastName: String(c.lastName ?? ''),
  }));
}

export async function libreGraph(
  region: RegionKey,
  token: string,
  patientId: string,
  accountId?: string,
): Promise<{current: GlucoseMeasurement | null; history: GraphPoint[]; sensorDaysLeft?: number}> {
  const base = REGIONS[region];
  const res = await fetch(`${base}/llu/connections/${patientId}/graph`, {
    headers: authHeaders(token, accountId),
  });
  if (res.status === 401) {
    throw Object.assign(new Error('Token expired'), {code: 'AUTH'});
  }
  if (res.status === 429) {
    throw Object.assign(new Error('Rate limited, backing off'), {
      code: 'RATE',
    });
  }
  if (!res.ok) {
    throw new Error(`Graph failed (HTTP ${res.status}).`);
  }
  const json = await res.json();
  const conn = json?.data?.connection;
  const current = parseMeasurement(conn?.glucoseMeasurement);

  let sensorDaysLeft: number | undefined;
  const sensorObj = conn?.sensor || (Array.isArray(conn?.sensors) ? conn.sensors[0] : null);
  if (sensorObj?.a) {
    const rawA = Number(sensorObj.a);
    if (Number.isFinite(rawA) && rawA > 0) {
      // 'a' is the sensor activation epoch timestamp in seconds (or ms)
      const activationMs = rawA > 1e11 ? rawA : rawA * 1000;
      const elapsedMs = Math.max(0, Date.now() - activationMs);
      const lifespanMs = 15 * 86400 * 1000;
      const remainingMs = lifespanMs - elapsedMs;
      sensorDaysLeft = Math.max(1, Math.min(15, Math.ceil(remainingMs / (86400 * 1000))));
    }
  }

  const rawHistory: any[] = Array.isArray(json?.data?.graphData)
    ? json.data.graphData
    : [];
  const history: GraphPoint[] = rawHistory
    .map(h => {
      const v = Number(h.ValueInMgPerDl ?? h.Value);
      if (!Number.isFinite(v) || v <= 0) {
        return null;
      }
      const epochMs = parseLibrePointTimestamp({
        FactoryTimestamp: h.FactoryTimestamp,
        Timestamp: h.Timestamp,
      });
      return {epochMs, valueMgDl: Math.round(v)};
    })
    .filter((x): x is GraphPoint => x !== null)
    .sort((a, b) => a.epochMs - b.epochMs);
  return {current, history, sensorDaysLeft};
}

export async function libreLogbook(
  region: RegionKey,
  token: string,
  patientId: string,
  accountId?: string,
): Promise<GraphPoint[]> {
  const base = REGIONS[region];
  try {
    const res = await fetch(`${base}/llu/connections/${patientId}/logbook`, {
      headers: authHeaders(token, accountId),
    });
    if (!res.ok) {
      console.log('[libreLogbook] HTTP error:', res.status);
      return [];
    }
    const json = await res.json();
    const list: any[] = Array.isArray(json?.data)
      ? json.data
      : Array.isArray(json?.data?.logbook)
        ? json.data.logbook
        : [];
    console.log('[libreLogbook] entries received:', list.length);
    return list
      .map((h): GraphPoint | null => {
        const v = Number(h.ValueInMgPerDl ?? h.Value);
        if (!Number.isFinite(v) || v <= 0) {
          return null;
        }
        const epochMs = parseLibrePointTimestamp({
          FactoryTimestamp: h.FactoryTimestamp,
          Timestamp: h.Timestamp,
        });
        return {epochMs, valueMgDl: Math.round(v), isScan: true};
      })
      .filter((x): x is GraphPoint => x !== null)
      .sort((a, b) => a.epochMs - b.epochMs);
  } catch (err: any) {
    console.log('[libreLogbook] exception:', err?.message);
    return [];
  }
}

export function trendSymbol(arrow: number): string {
  switch (arrow) {
    case 1:
      return '↓';
    case 2:
      return '↘';
    case 3:
      return '→';
    case 4:
      return '↗';
    case 5:
      return '↑';
    default:
      return '•';
  }
}

export function trendWord(arrow: number): string {
  switch (arrow) {
    case 1:
      return 'Falling';
    case 2:
      return 'Falling slowly';
    case 3:
      return 'Stable';
    case 4:
      return 'Rising slowly';
    case 5:
      return 'Rising';
    case 0:
    case 6:
      return 'No trend';
    default:
      return 'Unknown';
  }
}

export function mgDlToMmol(mgdl: number): number {
  return mgdl / 18.01559;
}

export function formatGlucose(mgdl: number, units: 'mgdl' | 'mmol'): string {
  if (units === 'mmol') {
    return mgDlToMmol(mgdl).toFixed(1);
  }
  return String(Math.round(mgdl));
}
