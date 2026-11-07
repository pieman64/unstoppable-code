import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

test('OpenCode turns over the provider process seam', async () => {
  try {
    await promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        '--test',
        path.join(__dirname, 'opencode-provider-process.scenarios.ts'),
      ],
      { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'stdout' in error &&
      typeof error.stdout === 'string'
    )
      throw new Error(error.stdout);
    throw error;
  }
}, 130_000);
