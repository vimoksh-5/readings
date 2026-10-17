import {NativeModules, NativeEventEmitter, Platform} from 'react-native';

interface GlucoseNative {
  saveCredentials(
    email: string,
    password: string,
    region: string,
    token: string,
    tokenExpiresAtMs: number,
    accountId: string,
    patientId: string,
  ): Promise<void>;
  clearCredentials(): Promise<void>;
  startService(
    pollSeconds: number,
    units: string,
    lowMgDl: number,
    highMgDl: number,
    alertsEnabled: boolean,
    silentNotifIntervalMin?: number,
    audibleBroadcastEnabled?: boolean,
    audibleBroadcastIntervalMin?: number,
  ): Promise<boolean>;
  updateServiceSettings(
    pollSeconds: number,
    units: string,
    lowMgDl: number,
    highMgDl: number,
    alertsEnabled: boolean,
    silentNotifIntervalMin: number,
    audibleBroadcastEnabled: boolean,
    audibleBroadcastIntervalMin: number,
  ): Promise<boolean>;
  stopService(): Promise<void>;
  isServiceRunning(): Promise<boolean>;
  getLatest(): Promise<string | null>;
  requestBatteryExemption(): Promise<boolean>;
  requestNotificationPermission(): Promise<boolean>;
  // Overlay
  startOverlay(): Promise<boolean>;
  stopOverlay(): Promise<void>;
  isOverlayRunning(): Promise<boolean>;
  requestOverlayPermission(): Promise<boolean>;
  // Notifications & Sound
  testAlertNotification(isLow: boolean, valueMgDl: number): Promise<boolean>;
  openNotificationSettings(): Promise<boolean>;
}

const LINKING_ERROR =
  'Glucose native module not found. Rebuild the Android app.';
const impl: GlucoseNative =
  NativeModules.GlucoseModule ??
  new Proxy(
    {},
    {
      get() {
        throw new Error(LINKING_ERROR);
      },
    },
  );

export const GlucoseBridge = impl;

export interface NativeGlucosePayload {
  valueMgDl: number;
  trendArrow: number;
  epochMs: number;
  stale: boolean;
  error?: string;
}

export function parseLatest(json: string | null): NativeGlucosePayload | null {
  if (!json) {
    return null;
  }
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function glucoseEmitter() {
  if (Platform.OS !== 'android') {
    return null;
  }
  return new NativeEventEmitter(NativeModules.GlucoseModule);
}
