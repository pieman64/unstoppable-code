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
  type ScriptTerminalPort,
} from '@canopy/core-runtime/node/script/execution';
import type {
  TerminalCreateRequest,
  WorkerTerminalEventListener,
} from '@canopy/core-runtime/node/terminal';
import {
  CANOPY_IN_PROCESS_WORKER_TARGET_ID,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { createCoreOperationAdapter } from '../core-operation-adapter';
import { createDesktopRuntime } from '../desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../desktop-runtime-identity';
import { createWorkerScriptAdapter } from '../worker-script-adapter';
import { runDesktopScript } from '../../lib/script-execution';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';

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

function worker(
  overrides: Partial<ScriptExecutionWorkerHost> = {},
): ScriptExecutionWorker {
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
    ...overrides,
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

it('runs an interactive shared-container command in a worker terminal with its dispatch record and exact environment', async () => {
  const listeners = new Set<WorkerTerminalEventListener>();
  const created: TerminalCreateRequest[] = [];
  const terminals: ScriptTerminalPort = {
    create: (request) => {
      created.push(request);
      setImmediate(() => {
        listeners.forEach((listener) => {
          const scope = {
            projectId: request.projectId,
            worktreeId: request.worktreeId,
            terminalId: 'terminal-1',
          };
          listener({
            type: 'output',
            payload: {
              ...scope,
              data: new TextEncoder().encode('served\n'),
              seq: 7,
            },
          });
          listener({
            type: 'exit',
            payload: { ...scope, exitCode: 0, signal: null },
          });
        });
      });
      return {
        id: 'terminal-1',
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        shell: '/bin/bash',
        shellBasename: 'bash',
        cwd: request.cwd ?? '',
        createdAt: Date.now(),
      };
    },
    kill: () => undefined,
    release: () => Promise.resolve(),
    lowerPriority: () => undefined,
    addEventListener: (listener) => {
      listeners.add(listener);
      return (): void => void listeners.delete(listener);
    },
  };
  const declared = { API_TOKEN: 'assigned-by-recipient' };
  const operationAdapter = createCoreOperationAdapter({
    ledgerPath: () => join(dir, 'operation-ledger.sqlite'),
  });
  const scriptWorker = worker({
    terminals: () => Promise.resolve(terminals),
    resolvePlace: (_scope, context) =>
      Promise.resolve(
        context.kind === 'shared-container'
          ? { cwd: join(dir, 'run-copy'), env: declared }
          : { cwd: dir, env: {} },
      ),
  });
  const dispatcher = createDesktopRuntime({
    operationAdapter,
    workerScriptAdapter: createWorkerScriptAdapter(() =>
      Promise.resolve(scriptWorker),
    ),
    shutdownTimeoutMs: 25,
  });
  try {
    const outcome = await runDesktopScript({
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: 'container-1',
      context: {
        kind: 'shared-container',
        repoId: 'repo-1',
        environmentKeys: ['API_TOKEN'],
      },
      script: {
        scriptKey: 'project:serve',
        scriptName: 'serve',
        label: 'Serve',
        command: 'serve',
        lifecycle: 'custom',
        target: 'project',
        interactive: true,
      },
      invocation: 'manual-run',
      command: 'serve',
      timeoutSeconds: 60,
      interactive: true,
    });

    expect(outcome.response).toMatchObject({ success: true, exitCode: 0 });
    expect(outcome.logRef).not.toBeNull();
    expect(created).toMatchObject([
      {
        projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
        worktreeId: 'container-1',
        cwd: join(dir, 'run-copy'),
        environment: declared,
        managedCommand: { env: declared, title: 'Serve' },
      },
    ]);
    const [run] = (
      await operationAdapter.service.list({
        kinds: ['core.script.run'],
        limit: 5,
      })
    ).items;
    expect(run).toMatchObject({ status: 'completed' });
    const [delegation] = await dispatcher.localWorker.listDelegations(
      run.operationId,
    );
    expect(delegation).toMatchObject({
      targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
      operation: { name: 'worker.script.execute' },
    });
    expect(JSON.stringify(delegation)).not.toContain('assigned-by-recipient');
  } finally {
    await dispatcher.shutdown();
  }
});
