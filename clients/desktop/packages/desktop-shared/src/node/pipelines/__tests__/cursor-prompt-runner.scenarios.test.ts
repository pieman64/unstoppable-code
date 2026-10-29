import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// The shared runner spawns a real runtime and speaks the ESM-only ACP SDK, so
// these scenarios run in Node rather than inside Jest's CJS VM, exactly as the
// turn-driver scenarios do.
it('passes the shared Cursor runner scenarios against the ACP fixture', async () => {
  try {
    await run(
      process.execPath,
      [
        '--import',
        'tsx',
        '--test',
        path.join(__dirname, 'cursor-prompt-runner.scenarios.ts'),
      ],
      { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
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
}, 190_000);
