import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import { createExecutionProcessServices } from '@canopy/core-platform';
import type {
  PlatformExecutionProcessServices,
  PlatformOperatingSystem,
} from '@canopy/core-runtime';
import { createOwnedProcessHostPort } from '@canopy/desktop-shared/node/execution-host/owned-process-host';
import type {
  ExecutionHostPort,
  ExecutionHostProcess,
} from '@canopy/desktop-shared/node/execution-host/port';
import type {
  SpawnedProcessResult,
  SpawnedProcessRunOptions,
} from '@canopy/desktop-shared/node/pipelines/executor/types';
import { setExecutionHostPort } from '../execution-host/utility-process-host';
import {
  resetPipelineProcessHostForTests,
  runPipelineProcessInExecutionHost,
  shutdownPipelineProcessHost,
} from '../pipelines/process-host-runner';

// The production pipeline process host, bundled as the desktop bundles it and
// run by the production runner over the owned-process port under plain Node:
// the host and its step processes run without Electron. darwin and linux
// only; the port's own suite covers win32.

const os = ((): PlatformOperatingSystem => {
  const platform: string = process.platform;
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32')
    return platform;
  throw new Error(`unsupported test host ${platform}`);
})();
const ROOT = path.resolve(__dirname, '../../../../..');
const ENTRY = 'pipeline-process-host-worker.js';
const describePosix = os === 'win32' ? describe.skip : describe;

// Real children under a loaded CI host can outlast the 5 s default.
jest.setTimeout(30_000);

let dir = '';
let services: PlatformExecutionProcessServices;
let hosts: ExecutionHostProcess[];
const strays = new Set<number>();

function present(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && Reflect.get(error, 'code') === 'EPERM';
  }
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function options(
  name: string,
  signal: AbortSignal,
  onOutput?: SpawnedProcessRunOptions['onOutput'],
): SpawnedProcessRunOptions {
  return {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '' },
    signal,
    timeout_minutes: 1,
    logFile: path.join(dir, `${name}.log`),
    outputFile: path.join(dir, `${name}.out`),
    envFile: path.join(dir, `${name}.env`),
    onOutput,
  };
}

/** A step that starts a grandchild in its group, records it and waits. */
function waitingStep(pidFile: string): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [
      '-e',
      `const { spawn } = require('node:child_process');
       const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1 << 30)'], { stdio: 'ignore' });
       require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
       setInterval(() => undefined, 1 << 30);`,
    ],
  };
}

async function grandchildOf(pidFile: string): Promise<number> {
  await until(() => existsSync(pidFile));
  const pid = Number(readFileSync(pidFile, 'utf8'));
  strays.add(pid);
  return pid;
}

beforeAll(() => {
  dir = realpathSync.native(
    mkdtempSync(path.join(realpathSync.native(tmpdir()), 'pipeline-host-')),
  );
  buildSync({
    entryPoints: [
      path.join(
        ROOT,
        'apps/desktop-app/src/main/pipelines/process-host-worker.ts',
      ),
    ],
    outfile: path.join(dir, ENTRY),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    tsconfig: path.join(ROOT, 'tsconfig.base.json'),
    external: ['electron', 'node:*'],
    define: { __CANOPY_E2E__: 'false' },
    logLevel: 'silent',
  });
});

beforeEach(() => {
  resetPipelineProcessHostForTests();
  hosts = [];
  services = createExecutionProcessServices({ os });
  const owned = createOwnedProcessHostPort({
    services,
    nodeExecutable: process.execPath,
    entryDirectory: dir,
    cwd: dir,
    environment: () => process.env,
  });
  const port: ExecutionHostPort = {
    launch(request) {
      const host = owned.launch(request);
      hosts.push(host);
      return host;
    },
    probe: (request) => owned.probe(request),
  };
  setExecutionHostPort(port);
});

afterEach(async () => {
  await shutdownPipelineProcessHost();
  await services.shutdown();
  setExecutionHostPort(undefined);
  for (const pid of Array.from(strays))
    if (present(pid)) process.kill(pid, 'SIGKILL');
  strays.clear();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describePosix('pipeline process host over the owned-process port', () => {
  it('runs a step and streams its output', async () => {
    const output: string[] = [];
    const result = await runPipelineProcessInExecutionHost(
      { command: process.execPath, args: ['-e', 'console.log("hello host")'] },
      options('success', new AbortController().signal, (_stream, data) =>
        output.push(data),
      ),
    );
    expect(result).toMatchObject<Partial<SpawnedProcessResult>>({
      status: 'success',
      exit_code: 0,
    });
    expect(output.join('')).toContain('hello host');
    expect(hosts).toHaveLength(1);
  });

  it('cancels a step and cleans its process tree', async () => {
    const pidFile = path.join(dir, 'cancel.pid');
    const controller = new AbortController();
    const run = runPipelineProcessInExecutionHost(
      waitingStep(pidFile),
      options('cancel', controller.signal),
    );
    const grandchild = await grandchildOf(pidFile);
    controller.abort();
    await expect(run).resolves.toMatchObject({ status: 'cancelled' });
    await until(() => !present(grandchild));
  });

  it('reports a host crash once and cleans the steps it owned', async () => {
    const pidFile = path.join(dir, 'crash.pid');
    const run = runPipelineProcessInExecutionHost(
      waitingStep(pidFile),
      options('crash', new AbortController().signal),
    );
    const grandchild = await grandchildOf(pidFile);
    const host = hosts[0];
    const exits: number[] = [];
    host.on('exit', (code) => exits.push(code));
    process.kill(host.pid ?? 0, 'SIGKILL');
    await expect(run).rejects.toThrow(
      'Pipeline process host exited before completing its work (code 137).',
    );
    await until(() => !present(grandchild));
    expect(exits).toEqual([137]);
  });

  it('cancels running steps and exits on shutdown', async () => {
    const pidFile = path.join(dir, 'shutdown.pid');
    const run = runPipelineProcessInExecutionHost(
      waitingStep(pidFile),
      options('shutdown', new AbortController().signal),
    );
    const grandchild = await grandchildOf(pidFile);
    const exited = new Promise<number>((resolve) =>
      hosts[0].once('exit', resolve),
    );
    await shutdownPipelineProcessHost();
    await expect(run).resolves.toMatchObject({ status: 'cancelled' });
    expect(await exited).toBe(0);
    expect(present(grandchild)).toBe(false);
  });
});
