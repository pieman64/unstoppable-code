import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { release } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { defineComposedMigrationCases } from './fixtures/composed-internal-root-migration';
import type * as Workers from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof Workers
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);

const requested =
  process.env.CANOPY_INTERNAL_ROOT_MIGRATION_QUALIFICATION === '1';
(requested ? describe : describe.skip)(
  'CAN-5942 manual exact-head composed qualification',
  () => {
    const root = resolve('.');
    const git = process.platform === 'win32' ? 'git.exe' : 'git';
    let revision = '';
    const hashes: Record<string, string> = {};
    const sha256 = async (file: string): Promise<string> =>
      createHash('sha256')
        .update(await readFile(join(root, file)))
        .digest('hex');
    async function assertExactHead(): Promise<void> {
      expect(
        (
          await promisify(execFile)(git, ['rev-parse', 'HEAD'], { cwd: root })
        ).stdout.trim(),
      ).toBe(revision);
      const dirty = await promisify(execFile)(
        git,
        ['status', '--porcelain', '--untracked-files=normal'],
        { cwd: root },
      );
      if (dirty.stdout.trim())
        throw new Error('Commit the exact qualification head first');
      for (const [file, hash] of Object.entries(hashes))
        expect(await sha256(file)).toBe(hash);
    }
    beforeAll(async () => {
      if (process.platform !== 'win32' && process.platform !== 'linux')
        throw new Error(
          'Composed qualification requires native Windows or Linux',
        );
      if (process.platform === 'linux' && process.getuid?.() === 0)
        throw new Error('Qualify with a non-root user');
      revision = (
        await promisify(execFile)(git, ['rev-parse', 'HEAD'], { cwd: root })
      ).stdout.trim();
      await assertExactHead();
      for (const file of [
        `.cache/native-owned-child/${process.platform}-${process.arch}/core-owned-child.node`,
        'scripts/build-owned-child.mjs',
      ])
        hashes[file] = await sha256(file);
      if (process.platform === 'win32') {
        await promisify(execFile)(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            "import { assertProcessHelper } from './scripts/lib/windows-process-helper.mjs'; assertProcessHelper(process.cwd());",
          ],
          { cwd: root, timeout: 15_000 },
        );
        hashes['.cache/bin/win32-x64/canopy-process-identity.exe'] =
          await sha256('.cache/bin/win32-x64/canopy-process-identity.exe');
      }
    }, 30_000);
    const outcomes = defineComposedMigrationCases({
      wholeHost: true,
      assertExactHead,
    });
    afterAll(async () => {
      let exactHead = false;
      try {
        if (revision) {
          await assertExactHead();
          exactHead = true;
        }
      } catch {
        /* Receipt remains incomplete. */
      }
      const expected = [
        ...['prepared', 'building', 'exposure', 'complete', 'rebuilding'].map(
          (scenario) => ({
            brand: 'canopy',
            scenario,
            outcome: 'phase-interrupted',
          }),
        ),
        ...['source-settled', 'copy', 'publication', 'restoring-external'].map(
          (scenario) => ({
            brand: 'unstoppable-code',
            scenario,
            outcome: 'phase-interrupted',
          }),
        ),
        ...['canopy', 'unstoppable-code'].map((brand) => ({
          brand,
          scenario: 'W5 + Git',
          outcome: 'composed-complete',
        })),
        ...['commit', 'reservation'].map((state) => ({
          brand: 'canopy',
          scenario: `unresolved ${state}`,
          outcome: 'recovery-required',
        })),
        {
          brand: 'canopy',
          scenario: 'uncomposed',
          outcome: 'uncomposed-refused',
        },
      ];
      const qualified =
        exactHead &&
        expected.every(
          (row) =>
            outcomes.filter(
              (actual) =>
                actual.brand === row.brand &&
                actual.scenario === row.scenario &&
                actual.outcome === row.outcome,
            ).length === 1,
        ) &&
        !outcomes.some((row) => row.outcome.endsWith('refusal-only'));
      const receipt = JSON.stringify({
        status: qualified ? 'qualified' : 'incomplete',
        revision,
        platform: process.platform,
        arch: process.arch,
        os: release(),
        node: process.version,
        hashes,
        outcomes,
      });
      if (process.env.CANOPY_INTERNAL_ROOT_MIGRATION_RECEIPT)
        await writeFile(
          process.env.CANOPY_INTERNAL_ROOT_MIGRATION_RECEIPT,
          receipt,
        );
      process.stdout.write(`CAN-5942 qualification receipt: ${receipt}\n`);
      expect(qualified).toBe(true);
    }, 30_000);
  },
);
