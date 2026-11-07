import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// The ACP turn driver speaks the ESM-only SDK, so the scenarios run in Node
// rather than inside Jest's CJS VM, as the shared ACP client conformance suite
// does. Each scenario's CLI runs under the provider process host.
it('passes the Cursor turn scenarios through the provider process host', async () => {
  try {
    await run(
      process.execPath,
      [
        '--import',
        'tsx',
        '--test',
        path.join(__dirname, 'cursor-turn-host.scenarios.ts'),
      ],
      {
        timeout: 240_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, TMPDIR: process.env.TMPDIR },
      },
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
}, 250_000);
