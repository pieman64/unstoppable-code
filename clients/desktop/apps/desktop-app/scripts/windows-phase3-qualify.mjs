import assert from 'node:assert/strict';
import process from 'node:process';
import { z } from 'zod';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { arch, release, tmpdir, version } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectCaseResults,
  assertExactHead,
  phase3ElectronCases,
  phase3Suites,
  requiredCaseResults,
  windowsQualificationLane,
} from '../../../scripts/lib/windows-phase3-qualification.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
/** @param {string} path */
const digest = (path) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');
/** @param {...string} args */
const git = (...args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
const missingElectronCases = () =>
  phase3ElectronCases.map((name) => ({
    name,
    layer: 'actual-electron',
    status: 'missing',
    required: true,
  }));

async function qualify() {
  const directory = join(
    root,
    '.playwright',
    'can-5893',
    `qualification-${randomUUID()}`,
  );
  /** @type {Record<string, unknown> & {
   * status: string,
   * cases: import('../../../scripts/lib/windows-phase3-qualification.mjs').CaseResult[],
   * artifacts: {path: string, sha256: string}[]
   * }} */
  const receipt = {
    schema: 1,
    ticket: 'CAN-5893',
    status: 'incomplete',
    started: new Date().toISOString(),
    lane: windowsQualificationLane(process.platform, arch(), release()),
    runner: {
      platform: process.platform,
      arch: arch(),
      release: release(),
      version: version(),
      node: process.version,
    },
    cases: [
      ...collectCaseResults({ testResults: [] }),
      ...missingElectronCases(),
    ],
    artifacts: [],
    applicability: {
      directPlatformContract:
        'native platform suites; not daemon routing evidence',
      daemonComposition:
        'native CLI/client host contracts (including simulated fixtures), plus test-only grants and selection over the real bundled binding; not shipped admission or actual Electron evidence',
      electron:
        'actual electron.exe main calling the production launch and attachment adapters; no renderer',
      builtPackage:
        'built standalone daemon and staged native addon; not an installed or signed package',
      installedPackage: 'not covered',
    },
  };
  const write = () =>
    writeFileSync(
      join(directory, 'qualification.json'),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
  /**
   * @param {string} label
   * @param {string} executable
   * @param {string[]} args
   * @param {NodeJS.ProcessEnv} env
   * @param {number} timeout
   */
  const run = (
    label,
    executable,
    args,
    env = process.env,
    timeout = 900_000,
  ) => {
    const log = join(directory, `${label}.log`);
    const result = spawnSync(executable, args, {
      cwd: root,
      env,
      windowsHide: true,
      timeout,
      maxBuffer: 64 << 20,
      encoding: 'utf8',
    });
    writeFileSync(log, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    if (result.error || result.status !== 0)
      throw new Error(`${label} failed; see ${log}`, { cause: result.error });
  };
  try {
    mkdirSync(directory, { recursive: true });
    write();
    assert.equal(
      process.platform,
      'win32',
      'qualification requires native Windows, never skips prerequisites',
    );
    assert.equal(process.arch, 'x64');
    receipt.revision = git('rev-parse', 'HEAD');
    receipt.git = git('--version');
    receipt.checkoutBefore = git(
      'status',
      '--porcelain',
      '--untracked-files=normal',
    );
    assertExactHead(git);
    assert.ok(
      process.env.CANOPY_PIPE_PROBE_USER &&
        process.env.CANOPY_PIPE_PROBE_PASSWORD,
      'second-user pipe fixture required (win-run --probe)',
    );
    const { inspectDevCoreDaemon } =
      await import('../../../scripts/lib/dev-core-daemon.mjs');
    const built = z
      .object({
        daemon: z.object({ path: z.string(), state: z.string() }).passthrough(),
        ownedChild: z.object({ path: z.string() }),
      })
      .parse(inspectDevCoreDaemon({ root }));
    receipt.build = built.daemon;
    assert.equal(
      built.daemon.state,
      'fresh',
      'rebuild daemon: sources must match this checkout',
    );
    const executable = built.daemon.path;
    const addon = join(root, 'dist/core-daemon/core-owned-child.node');
    const pipe = join(root, 'dist/core-daemon/windows-pipe-security.node');
    const helper = join(root, 'dist/core-daemon/canopy-process-identity.exe');
    const { assertProcessHelper, assertStagedProcessHelper } =
      await import('../../../scripts/lib/windows-process-helper.mjs');
    const electronHelper = assertProcessHelper(root);
    assertStagedProcessHelper(root, dirname(executable));
    const require = createRequire(import.meta.url);
    const electron = z.string().parse(require('electron'));
    for (const path of [
      executable,
      addon,
      pipe,
      helper,
      electronHelper,
      built.ownedChild.path,
      electron,
    ]) {
      receipt.artifacts.push({ path, sha256: digest(path) });
    }
    const sources = [
      'apps/desktop-app/src/main/__tests__/windows-phase3-qualification.test.ts',
      'apps/desktop-app/scripts/windows-phase3-qualify.mjs',
      'scripts/lib/windows-phase3-qualification.mjs',
      'scripts/lib/windows-pipe-inventory.json',
      'apps/desktop-app/src/main/__tests__/fixtures/windows-phase3/electron.ts',
      ...phase3Suites.map(({ file }) => file),
    ].map((path) => ({ path, sha256: digest(join(root, path)) }));
    receipt.sources = sources;
    write();
    const env = {
      ...process.env,
      CANOPY_WINDOWS_PHASE3_QUALIFICATION: '1',
      CANOPY_PIPE_SECURITY_ACCEPTANCE: '1',
      CANOPY_PIPE_SECURITY_ADDON: pipe,
      CANOPY_DAEMON_TRASH_ACCEPTANCE: '1',
      CANOPY_OWNED_CHILD_ACCEPTANCE: '1',
      CANOPY_OWNED_CHILD_ADDON: addon,
    };
    // Do not inherit CI's optional rehearsal/evidence destinations into this run.
    delete env.CANOPY_PIPE_REHEARSAL;
    delete env.CANOPY_PIPE_NATIVE_EVIDENCE;
    const results = join(directory, 'jest-results.json');
    let contractsError;
    try {
      run(
        'contracts',
        process.execPath,
        [
          join(root, 'node_modules/jest/bin/jest.js'),
          '--runInBand',
          '--runTestsByPath',
          ...phase3Suites.map(({ file }) => file),
          '--json',
          `--outputFile=${results}`,
        ],
        env,
      );
    } catch (error) {
      contractsError =
        error instanceof Error ? error : new Error('contracts failed');
    }
    const jest = z
      .object({
        success: z.boolean(),
        wasInterrupted: z.boolean(),
        testResults: z.array(
          z.object({
            name: z.string(),
            status: z.string(),
            message: z.string().optional(),
            assertionResults: z.array(
              z.object({
                fullName: z.string(),
                title: z.string(),
                status: z.string(),
              }),
            ),
          }),
        ),
      })
      .parse(JSON.parse(readFileSync(results, 'utf8')));
    receipt.cases = [...collectCaseResults(jest), ...missingElectronCases()];
    write();
    if (contractsError) throw contractsError;
    requiredCaseResults(jest);
    const { build } = await import('esbuild');
    const { loadBrand } = await import('../../../scripts/brand/load-brand.mjs');
    const brand = z
      .object({ id: z.string() })
      .parse(loadBrand(process.env.CANOPY_BRAND ?? 'canopy'));
    const entry = join(directory, 'electron.cjs');
    await build({
      entryPoints: [
        join(
          root,
          'apps/desktop-app/src/main/__tests__/fixtures/windows-phase3/electron.ts',
        ),
      ],
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      tsconfig: join(root, 'tsconfig.base.json'),
      external: ['electron'],
      alias: {
        '@canopy/brand/current': join(
          root,
          '.cache/brand',
          brand.id,
          'desktop-brand.ts',
        ),
      },
      // Same fixed helper lookup used by Electron's production Vite build.
      define: {
        __CANOPY_WINDOWS_PROCESS_SOURCE_PATH__: JSON.stringify(electronHelper),
        __CANOPY_E2E__: 'false',
        __CANOPY_OLLAMA_ENABLED__: 'true',
        __CANOPY_OLLAMA_PLATFORM__: 'process.platform',
        __CANOPY_RELEASE_FLAVOR__: JSON.stringify('stable'),
      },
    });
    const runtimeRoot = realpathSync(
      mkdtempSync(join(tmpdir(), 'phase3-electron-')),
    );
    receipt.electronFixtureRoot = runtimeRoot;
    write();
    const electronEnv = {
      ...env,
      CANOPY_DATA_DIR: join(runtimeRoot, 'data'),
      CANOPY_SECURE_DATA_DIR: join(runtimeRoot, 'secure'),
    };
    delete electronEnv.ELECTRON_RUN_AS_NODE;
    delete electronEnv.CANOPY_PIPE_PROBE_USER;
    delete electronEnv.CANOPY_PIPE_PROBE_PASSWORD;
    run(
      'electron',
      electron,
      [entry, directory, executable, addon, electronHelper, runtimeRoot],
      electronEnv,
      180_000,
    );
    const observed = z
      .object({
        executable: z.string(),
        daemonExecutable: z.string(),
        electron: z.string().min(1),
        entry: z.string(),
        packaged: z.boolean(),
        cases: z.array(z.string()),
      })
      .passthrough()
      .parse(
        JSON.parse(readFileSync(join(directory, 'electron.json'), 'utf8')),
      );
    assert.equal(
      resolve(observed.executable).toLowerCase(),
      resolve(electron).toLowerCase(),
    );
    assert.equal(
      resolve(observed.daemonExecutable).toLowerCase(),
      resolve(executable).toLowerCase(),
    );
    assert.ok(observed.electron);
    assert.equal(observed.entry, 'getElectronDaemonConnections');
    assert.equal(observed.packaged, false);
    assert.deepEqual(observed.cases, phase3ElectronCases);
    receipt.electron = observed;
    receipt.cases = [
      ...collectCaseResults(jest),
      ...observed.cases.map((name) => ({
        name,
        layer: 'actual-electron',
        status: 'passed',
        required: true,
      })),
    ];
    for (const artifact of receipt.artifacts)
      assert.equal(
        digest(artifact.path),
        artifact.sha256,
        `artifact changed: ${artifact.path}`,
      );
    assert.equal(
      git('rev-parse', 'HEAD'),
      receipt.revision,
      'head changed during qualification',
    );
    receipt.checkoutAfter = git(
      'status',
      '--porcelain',
      '--untracked-files=normal',
    );
    assertExactHead(git);
    for (const source of sources)
      assert.equal(
        digest(join(root, source.path)),
        source.sha256,
        `source changed: ${source.path}`,
      );
    receipt.status = 'qualified';
  } catch (error) {
    receipt.failure =
      error instanceof Error ? error.message : 'qualification failed';
    throw error;
  } finally {
    receipt.finished = new Date().toISOString();
    try {
      write();
    } finally {
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    }
    process.stdout.write(
      `Phase 3 evidence: ${join(directory, 'qualification.json')} (${receipt.status})\n`,
    );
  }
}

qualify().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : 'qualification failed'}\n`,
  );
  process.exitCode = 1;
});
