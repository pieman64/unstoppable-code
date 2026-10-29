import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// The ACP turn driver spawns a real runtime and speaks the ESM-only SDK, so
// the scenarios run in Node rather than inside Jest's CJS VM, exactly as the
// shared ACP client conformance suite does.
it('passes the Cursor turn driver scenarios against the ACP fixture', async () => {
  try {
    await run(
      process.execPath,
      [
        '--import',
        'tsx',
        '--test',
        path.join(__dirname, 'turn-driver.scenarios.ts'),
      ],
      { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'stdout' in error &&
      typeof error.stdout === 'string'
    ) {
      throw new Error(error.stdout);
    }
    throw error;
  }
}, 130_000);
