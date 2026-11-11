// Unit tests replace Electron's native cipher. Pair it with a synthetic provider
// rather than consulting the developer/CI host's D-Bus session. Resolve Electron
// lazily so each suite's factory and later availability changes remain in force.
// Provider/policy tests can supply their own mock or unmock this module to test
// the real bounded metadata adapter. No production module imports this setup.
jest.mock('../main/lib/linux-secret-service', () => {
  function isAvailabilityProbe(value: unknown): value is () => unknown {
    return typeof value === 'function';
  }
  function getLinuxSecretServiceState(): 'secure' | 'unavailable' {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const electron: unknown = require('electron');
      if (
        typeof electron !== 'object' ||
        electron === null ||
        !('safeStorage' in electron)
      )
        return 'unavailable';
      const storage = electron.safeStorage;
      return typeof storage === 'object' &&
        storage !== null &&
        'isEncryptionAvailable' in storage &&
        isAvailabilityProbe(storage.isEncryptionAvailable) &&
        storage.isEncryptionAvailable() === true
        ? 'secure'
        : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }
  return {
    getLinuxSecretServiceState,
    getLinuxSecretServiceStateAsync: (): Promise<'secure' | 'unavailable'> =>
      Promise.resolve(getLinuxSecretServiceState()),
  };
});
