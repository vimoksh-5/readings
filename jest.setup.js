jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  RN.NativeModules.GlucoseModule = {
    saveCredentials: jest.fn().mockResolvedValue(undefined),
    clearCredentials: jest.fn().mockResolvedValue(undefined),
    startService: jest.fn().mockResolvedValue(true),
    stopService: jest.fn().mockResolvedValue(undefined),
    isServiceRunning: jest.fn().mockResolvedValue(false),
    getLatest: jest.fn().mockResolvedValue(null),
    requestBatteryExemption: jest.fn().mockResolvedValue(true),
    requestNotificationPermission: jest.fn().mockResolvedValue(true),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  };
  return RN;
});

global.__TEST__ = true;
