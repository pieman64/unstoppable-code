import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import { createExecutionProcessServices } from '@canopy/core-platform';
import type {
  PlatformExecutionProcessServices,
  PlatformOperatingSystem,
} from '@canopy/core-runtime';
import { createOwnedProcessHostPort } from '@canopy/desktop-shared/node/execution-host/owned-process-host';
import { setExecutionHostPort } from '../execution-host/utility-process-host';
import {
  resetCodeGraphFingerprintRunnerForTests,
  runCodeGraphWorkerFingerprint,
  shutdownCodeGraphFingerprintWorkers,
} from '../code-graph/fingerprint-runner';
import { executeCodeGraphFingerprint } from '../code-graph/fingerprint-worker';
import {
  resetCodeGraphReadRunnerForTests,
  runCodeGraphWorkerRead,
  shutdownCodeGraphReadWorkers,
  type CodeGraphWorkerReadRequest,
} from '../code-graph/read-runner';
import { executeCodeGraphRead } from '../code-graph/read-worker';

// The production code-graph fingerprint and read hosts, bundled as the
// desktop bundles them and driven by their production runners over the
// owned-process port under plain Node, inside the execution host shell that
// enforces the runners' budgets. Each answer must equal the same work
// done in process. darwin and linux only; the port's own suite covers win32.

const os = ((): PlatformOperatingSystem => {
  const platform: string = process.platform;
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32')
    return platform;
  throw new Error(`unsupported test host ${platform}`);
})();
const ROOT = path.resolve(__dirname, '../../../../..');
const describePosix = os === 'win32' ? describe.skip : describe;

// Real children under a loaded CI host can outlast the 5 s default.
jest.setTimeout(30_000);

let dir = '';
let repo = '';
let services: PlatformExecutionProcessServices;

function bundle(worker: string, outfile: string): void {
  buildSync({
    entryPoints: [
      path.join(ROOT, 'apps/desktop-app/src/main/code-graph', worker),
    ],
    outfile: path.join(dir, outfile),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    tsconfig: path.join(ROOT, 'tsconfig.base.json'),
    external: ['electron', 'web-tree-sitter', 'typescript', 'node:*'],
    logLevel: 'silent',
  });
}

beforeAll(() => {
  dir = realpathSync.native(
    mkdtempSync(path.join(realpathSync.native(tmpdir()), 'code-graph-host-')),
  );
  bundle('fingerprint-worker.ts', 'code-graph-fingerprint-worker.js');
  bundle('read-worker.ts', 'code-graph-read-worker.js');
  // The runners launch with budgets, which only a shell can enforce.
  buildSync({
    stdin: {
      contents: `import { runRequestedExecutionHostShell } from '@canopy/core-platform/execution-host/shell';
runRequestedExecutionHostShell(process.argv.slice(2), {
  directory: __dirname,
  names: ['code-graph-fingerprint-worker.js', 'code-graph-read-worker.js'],
});`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    outfile: path.join(dir, 'shell.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    tsconfig: path.join(ROOT, 'tsconfig.base.json'),
    logLevel: 'silent',
  });
  repo = path.join(dir, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(path.join(repo, 'index.ts'), 'export const value = 1;\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', [
    '-C',
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-qm',
    'initial',
  ]);
  writeFileSync(path.join(repo, 'dirty.ts'), 'export const dirty = 2;\n');
});

beforeEach(() => {
  resetCodeGraphFingerprintRunnerForTests();
  resetCodeGraphReadRunnerForTests();
  services = createExecutionProcessServices({ os });
  setExecutionHostPort(
    createOwnedProcessHostPort({
      services,
      shell: {
        executable: process.execPath,
        args: [path.join(dir, 'shell.js')],
      },
      cwd: dir,
      environment: () => process.env,
    }),
  );
});

afterEach(async () => {
  await shutdownCodeGraphFingerprintWorkers();
  await shutdownCodeGraphReadWorkers();
  await services.shutdown();
  setExecutionHostPort(undefined);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describePosix('code-graph hosts over the owned-process port', () => {
  it('fingerprints a worktree exactly as in process', async () => {
    const repositories = [{ repoId: 'repo', rootPath: repo }];
    const hosted = await runCodeGraphWorkerFingerprint(
      'fingerprint',
      repositories,
      {
        background: false,
      },
    );
    expect(hosted).toEqual(await executeCodeGraphFingerprint({ repositories }));
    expect(hosted.ok && hosted.fingerprint.length > 0).toBe(true);
  });

  it('reads a retained graph exactly as in process', async () => {
    const request: CodeGraphWorkerReadRequest = {
      dbPath: path.join(dir, 'missing', 'graph.db'),
      task: { kind: 'readonly-summary' },
    };
    const hosted = await runCodeGraphWorkerRead({
      key: 'read',
      kind: 'context',
      request,
    });
    expect(hosted).toEqual(await executeCodeGraphRead(request));
    expect(hosted).toEqual({
      ok: true,
      result: { kind: 'readonly-summary', value: { state: 'missing' } },
    });
  });
});
