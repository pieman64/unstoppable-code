import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Run the real ESM-only SDK in Node, rather than mocking it in Jest's CJS VM.
it('passes the ACP subprocess conformance scenarios', async () => {
  try {
    await run(
      process.execPath,
      [
        '--import',
        'tsx',
        '--test',
        path.join(__dirname, 'client.scenarios.ts'),
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
