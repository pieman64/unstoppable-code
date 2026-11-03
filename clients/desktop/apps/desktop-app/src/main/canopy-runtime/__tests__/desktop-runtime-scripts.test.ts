import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ScriptExecutionWorker,
  type ScriptChildProcess,
  type ScriptExecutionWorkerHost,
  type ScriptSpawnOptions,
} from '@canopy/core-runtime/node/script/execution';
import {
  CANOPY_IN_PROCESS_WORKER_TARGET_ID,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { createCoreOperationAdapter } from '../core-operation-adapter';
import { createDesktopRuntime } from '../desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../desktop-runtime-identity';
import { createWorkerScriptAdapter } from '../worker-script-adapter';

// CAN-4143: the desktop dispatcher serves worker.script.* over the local
// worker, and each script run is recorded with its dispatch before it runs.

let dir: string;

function nodeSpawn(
  command: string,
  args: string[],
  options: ScriptSpawnOptions,
): ScriptChildProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: options.detached,
  });
  return {
    get pid(): number | undefined {
      return child.pid;
    },
    stdout: {
      onData: (listener): void => void child.stdout.on('data', listener),
      destroy: (): void => {
        child.stdout.destroy();
      },
    },
    stderr: {
      onData: (listener): void => void child.stderr.on('data', listener),
      destroy: (): void => {
        child.stderr.destroy();
      },
    },
    onError: (listener): void => void child.on('error', listener),
    onClose: (listener): void => void child.on('close', listener),
    killGroup: (signal): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Already gone.
      }
    },
  };
}

const caller = (
  grants: CanopyCallerDescriptor['grants'],
): CanopyCallerDescriptor => ({
  principalId: 'local-desktop-user',
  clientInstanceId: 'window-1',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants,
});

function worker(): ScriptExecutionWorker {
  const host: ScriptExecutionWorkerHost = {
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
    platform: () => 'linux',
    findExecutable: () => null,
    windowsGitBash: () => null,
    cmdCommandLine: (path) => path,
    loginShell: () => undefined,
    comSpec: () => undefined,
    prepareLaunch: (command, args) => ({ command, args }),
    lowerPriority: () => undefined,
    spawn: nodeSpawn,
    drainOwnedProcess: () => Promise.resolve(),
    logPaths: {
      runDir: (projectId, worktreeId) =>
        join(dir, 'runs', projectId, worktreeId),
      fileStem: (scriptKey) => scriptKey.replace(/[^a-z0-9]+/g, '-'),
    },
    logFiles: { writeFileAtomically: (path, text) => writeFile(path, text) },
    resolvePlace: () =>
      Promise.resolve({
        cwd: dir,
        env: { PATH: process.env.PATH ?? '', HOME: join(dir, 'home') },
      }),
  };
  return new ScriptExecutionWorker(host);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'desktop-scripts-'));
  mkdirSync(join(dir, 'home'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it('runs a script on the local worker and serves its log to granted callers', async () => {
  const operationAdapter = createCoreOperationAdapter({
    ledgerPath: () => join(dir, 'operation-ledger.sqlite'),
  });
  const scriptWorker = worker();
  const dispatcher = createDesktopRuntime({
    operationAdapter,
    workerScriptAdapter: createWorkerScriptAdapter(() =>
      Promise.resolve(scriptWorker),
    ),
    shutdownTimeoutMs: 25,
  });
  try {
    const outcome = await dispatcher.scriptRuns.run({
      params: {
        scope: { workspaceId: 'project-1', worktreeId: 'wt-1' },
        context: { kind: 'project' },
        command: 'echo ready',
        shellStartup: 'login',
        timeoutMs: null,
        priority: 'normal',
        record: {
          script: {
            scriptKey: 'project:launch',
            scriptName: 'launch',
            label: 'Launch',
            command: 'echo ready',
            lifecycle: 'launch',
            target: 'project',
            devServerPattern: 'ready',
          },
          invocation: 'manual-run',
        },
      },
      origin: { kind: 'client', sourceId: 'desktop' },
      owner: { kind: 'system', id: LOCAL_DESKTOP_AUTHORITY_ID },
    });
    expect(outcome).toMatchObject({
      status: 'completed',
      result: { status: 'success', exitCode: 0 },
    });
    const [delegation] = await dispatcher.localWorker.listDelegations(
      outcome.operationId,
    );
    expect(delegation).toMatchObject({
      targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
      operation: { name: 'worker.script.execute' },
    });

    const params = {
      scope: { workspaceId: 'project-1', worktreeId: 'wt-1' },
      scriptKey: 'project:launch',
      tailLines: 10,
    };
    await expect(
      dispatcher.query('worker.script.execution.get', params, {
        caller: caller(['worker.script.execute']),
      }),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    const read = await dispatcher.query('worker.script.execution.get', params, {
      caller: caller(['worker.script.read']),
    });
    expect(read.run).toMatchObject({
      execution: {
        executionId: outcome.executionId,
        status: 'success',
        script: { devServerPattern: 'ready' },
      },
      lines: ['ready'],
    });
  } finally {
    await dispatcher.shutdown();
  }
});
