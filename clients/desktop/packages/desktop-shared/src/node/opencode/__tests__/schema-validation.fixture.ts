import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before } from 'node:test';
import { build } from 'esbuild';
import { createOpenCodeSchemaValidator } from '../schema-validation';

export const directory = mkdtempSync(join(tmpdir(), 'opencode-schema-test-'));
export const worker = join(directory, 'worker.cjs');
export const validate = createOpenCodeSchemaValidator(worker);
before(async () => {
  await build({
    entryPoints: [join(__dirname, '../schema-validation-worker.ts')],
    outfile: worker,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
});
after(async () => {
  await rm(directory, { recursive: true, force: true });
});
