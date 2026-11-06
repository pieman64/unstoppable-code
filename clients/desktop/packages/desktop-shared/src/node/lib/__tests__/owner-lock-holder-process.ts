import { writeSync } from 'node:fs';
import { withOwnerLockFile, withOwnerLockFileSync } from '../owner-lock-file';

const [mode, lockPath = ''] = process.argv.slice(2);
const options = { maxWaitMs: 5_000, timeoutMessage: 'busy' };

if (mode === 'sync') {
  withOwnerLockFileSync(
    lockPath,
    () => {
      writeSync(1, 'held\n');
      for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    },
    options,
  );
} else {
  void withOwnerLockFile(
    lockPath,
    () => {
      writeSync(1, 'held\n');
      setInterval(() => undefined, 60_000);
      return new Promise<never>(() => undefined);
    },
    options,
  );
}
