import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

test('OpenCode ACP and approval subprocess scenarios', async () => {
  try {
    await promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        '--test',
        path.join(__dirname, 'approval-plugin.scenarios.ts'),
        path.join(__dirname, 'turn-driver.scenarios.ts'),
        path.join(__dirname, 'pipeline.scenarios.ts'),
        path.join(__dirname, 'mcp-snapshot.scenarios.ts'),
        path.join(__dirname, 'schema-validation.scenarios.ts'),
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
