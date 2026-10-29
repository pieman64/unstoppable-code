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
    if (kind === 'encrypt-failed') {
      safeStorage.encryptString = () => {
        throw new Error('Synthetic native encryption failure');
      };
    } else if (kind === 'probe-failed') {
      safeStorage.isEncryptionAvailable = () => {
        throw new Error('Synthetic native availability failure');
      };
    } else if (kind === 'unavailable') {
      // Missing libsecret is unavailable; a recognized backend with false
      // availability would instead represent an inferred lock on Linux.
      safeStorage.isEncryptionAvailable = () => false;
      if (process.platform === 'linux') {
        safeStorage.getSelectedStorageBackend = () => 'unknown';
      }
    } else {
      safeStorage.isEncryptionAvailable = () => false;
      if (process.platform === 'linux') {
        safeStorage.getSelectedStorageBackend = () => 'gnome_libsecret';
      }
    }
    return {
      restore() {
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
