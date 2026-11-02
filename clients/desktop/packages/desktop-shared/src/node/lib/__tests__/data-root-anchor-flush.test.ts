import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { flushDirectory } from '@canopy/core-platform/directory-flush';
import {
  getCanopyDataDir,
  getPrimaryBrandDataDir,
} from '../../../canopy-paths';

const windowsIt = process.platform === 'win32' ? it : it.skip;

// CAN-5153: `createDirectoryDurably` and the W5 worker flush the data root's
// parent last; on Windows that needs a read-write handle the user is granted.
windowsIt(
  'flushes the parent of the default and the configured data root read-write',
  async () => {
    for (const dataRoot of [getPrimaryBrandDataDir(), getCanopyDataDir()]) {
      // Under Jest the configured root is a per-worker temp folder that may
      // not exist yet; a first durable write creates it the same way.
      await mkdir(dirname(dataRoot), { recursive: true });
      await expect(
        flushDirectory(dirname(dataRoot), { os: 'win32' }),
      ).resolves.toBe('flushed');
    }
  },
);
