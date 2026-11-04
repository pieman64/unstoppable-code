// Native API fault injection only. Successful writes/reads always use Electron's
// original encryption; no renderer bridge or production test seam is replaced.
// Simulate transient native availability loss during one fake credential's
// decryption. Unrelated asynchronous account/policy reads stay healthy.
// Never log or return decrypted values from the main process.
export async function injectSecureStorageReadFault(
  electronApp,
  plaintextFixture,
) {
  const handle = await electronApp.evaluateHandle(
    ({ safeStorage }, fixture) => {
      const descriptor = Object.getOwnPropertyDescriptor(
        safeStorage,
        'decryptString',
      );
      const original = safeStorage.decryptString;
      const availabilityDescriptor = Object.getOwnPropertyDescriptor(
        safeStorage,
        'isEncryptionAvailable',
      );
      const restoreAvailability = () => {
        if (availabilityDescriptor)
          Object.defineProperty(
            safeStorage,
            'isEncryptionAvailable',
            availabilityDescriptor,
          );
        else delete safeStorage.isEncryptionAvailable;
      };
      const unavailable = () => {
        throw new Error('Synthetic transient native availability failure');
      };
      safeStorage.decryptString = (ciphertext) => {
        const plaintext = original.call(safeStorage, ciphertext);
        if (plaintext === fixture) {
          // The real policy synchronously observes native status to classify
          // this decryption failure. Restore before any other async read runs.
          safeStorage.isEncryptionAvailable = unavailable;
          queueMicrotask(() => {
            if (safeStorage.isEncryptionAvailable === unavailable)
              restoreAvailability();
          });
          throw new Error('Synthetic native fixture decryption failure');
        }
        return plaintext;
      };
      return {
        restore() {
          if (descriptor)
            Object.defineProperty(safeStorage, 'decryptString', descriptor);
          else delete safeStorage.decryptString;
          restoreAvailability();
        },
      };
    },
    plaintextFixture,
  );
  let restored = false;
  return async () => {
    if (restored) return;
    await handle.evaluate((fixture) => fixture.restore());
    restored = true;
    await handle.dispose();
  };
}

export async function injectSecureStorageFault(electronApp, fault) {
  if (
    !['encrypt-failed', 'probe-failed', 'unavailable', 'locked'].includes(fault)
  ) {
    throw new Error(`Unknown secure-storage fixture fault: ${fault}`);
  }
  const handle = await electronApp.evaluateHandle(({ safeStorage }, kind) => {
    const originals = [
      'isEncryptionAvailable',
      'getSelectedStorageBackend',
      'encryptString',
    ].map((name) => [name, Object.getOwnPropertyDescriptor(safeStorage, name)]);
    let restoreMetadata = () => {};
    if (kind === 'locked' && process.platform === 'linux') {
      // Production deliberately recovers native=false while the real provider
      // is unlocked. Model a lock at the metadata boundary instead, forwarding
      // owner/alias discovery and every unrelated process invocation unchanged.
      const childProcess = process.getBuiltinModule('node:child_process');
      const originalExec = childProcess.execFileSync;
      childProcess.execFileSync = function (file, args, ...options) {
        if (
          file === '/usr/bin/gdbus' &&
          Array.isArray(args) &&
          args.length === 12 &&
          args[0] === 'call' &&
          args[1] === '--session' &&
          args[2] === '--dest' &&
          /^:[0-9]+\.[0-9]+$/.test(args[3]) &&
          args[4] === '--object-path' &&
          /^\/org\/freedesktop\/secrets\/collection\/[A-Za-z0-9_]+$/.test(
            args[5],
          ) &&
          args[6] === '--method' &&
          args[7] === 'org.freedesktop.DBus.Properties.Get' &&
          args[8] === '--timeout' &&
          args[9] === '1' &&
          args[10] === 'org.freedesktop.Secret.Collection' &&
          args[11] === 'Locked'
        )
          return '(<true>,)';
        return originalExec.call(this, file, args, ...options);
      };
      restoreMetadata = () => {
        childProcess.execFileSync = originalExec;
      };
    } else if (kind === 'encrypt-failed') {
      safeStorage.encryptString = () => {
        throw new Error('Synthetic native encryption failure');
      };
    } else if (kind === 'probe-failed') {
      safeStorage.isEncryptionAvailable = () => {
        throw new Error('Synthetic native availability failure');
      };
    } else if (kind === 'unavailable') {
      // Missing/unsupported native backend cannot be recovered by the helper.
      safeStorage.isEncryptionAvailable = () => false;
      if (process.platform === 'linux') {
        safeStorage.getSelectedStorageBackend = () => 'unknown';
      }
    } else {
      throw new Error('Locked metadata fixture requires Linux.');
    }
    return {
      restore() {
        restoreMetadata();
        for (const [name, descriptor] of originals) {
          if (descriptor) Object.defineProperty(safeStorage, name, descriptor);
          else delete safeStorage[name];
        }
      },
    };
  }, fault);
  let restored = false;
  return async () => {
    if (restored) return;
    await handle.evaluate((fixture) => fixture.restore());
    restored = true;
    await handle.dispose();
  };
}
