import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const qualify =
  process.platform === 'win32' ||
  process.env.CANOPY_WINDOWS_PHASE3_QUALIFICATION === '1'
    ? test
    : test.skip;

qualify(
  'Windows Phase 3 exact-head qualification',
  () => {
    // A native Node subprocess avoids Jest's Electron mock and ESM transforms.
    const result = spawnSync(
      process.execPath,
      [require.resolve('../../../scripts/windows-phase3-qualify.mjs')],
      {
        cwd: resolve(__dirname, '../../../../..'),
        env: process.env,
        windowsHide: true,
        timeout: 1_800_000,
        maxBuffer: 64 << 20,
        encoding: 'utf8',
      },
    );
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.error) throw result.error;
    expect(result.status).toBe(0);
  },
  1_810_000,
);
