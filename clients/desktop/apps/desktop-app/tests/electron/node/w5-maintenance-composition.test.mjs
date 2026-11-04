import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildW5MaintenanceComposition } from '../helpers/w5-maintenance-composition.mjs';

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

test(
  'offline maintenance starts in plain Node without Electron',
  {
    timeout: 60_000,
  },
  async (t) => {
    const directory = await realpath(
      await mkdtemp(path.join(tmpdir(), 'w5-maintenance-node-')),
    );
    let composition;
    t.after(async () => {
      await composition?.killAll();
      await rm(directory, { recursive: true, force: true });
    });
    composition = await buildW5MaintenanceComposition({
      directory,
      repoRoot,
      // Neither refusal nor diagnosis may start the recovering writer.
      workerEntry: path.join(directory, 'no-worker.cjs'),
    });
    // A warm local desktop build must not hide a clean-CI bundling failure.
    assert.deepEqual(
      composition.buildInputs.filter((input) =>
        /(?:^|[\\/])\.cache[\\/]brand[\\/]/.test(input),
      ),
      [],
      'maintenance composition must not consume generated desktop brand files',
    );

    await t.test(
      'reports a missing runtime as a maintenance refusal',
      async () => {
        const root = await mkdtemp(path.join(directory, 'missing-runtime-'));
        assert.deepEqual(await composition.run('diagnose', root), {
          line:
            process.platform === 'win32'
              ? 'refused:platform-unsupported'
              : 'refused:runtime-unavailable',
          code: 3,
        });
      },
    );

    await t.test(
      'diagnoses a private root without starting a writer and releases maintenance',
      {
        skip:
          process.platform === 'win32' &&
          'Windows offline maintenance is not qualified',
      },
      async (t) => {
        // Keep the canonical runtime socket below the POSIX path limit.
        const root = await realpath(await mkdtemp(path.join(tmpdir(), 'w5-')));
        t.after(() => rm(root, { recursive: true, force: true }));
        const runtime = path.join(root, 'runtime');
        await mkdir(runtime, { mode: 0o700 });

        assert.deepEqual(await composition.run('diagnose', root), {
          line: 'diagnosed',
          code: 0,
        });
        assert.deepEqual(await readdir(root), ['runtime']);
        assert.equal(
          (await readdir(runtime)).includes('w5-maintenance.json'),
          false,
        );
        assert.equal(
          (await readdir(runtime)).includes('startup-claim.json'),
          false,
        );
        assert.deepEqual(await composition.run('diagnose', root), {
          line: 'diagnosed',
          code: 0,
        });
      },
    );

    await t.test(
      'reports an invalid mode on stderr, not Electron startup output',
      async () => {
        const result = await composition.run('unknown', directory);
        assert.equal(result.code, 1);
        assert.match(
          result.line,
          /maintenance unknown exited 1: Error: unknown mode unknown/,
        );
      },
    );
  },
);
