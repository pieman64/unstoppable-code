import { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

jest.mock('../lib/process-kill', () => ({
  killChildProcessGroup: jest.fn(),
}));

let mockDataDir: string;

jest.mock('../lib/paths', () => ({
  getCodexAppServerPidsFilePath: (): string =>
    `${mockDataDir}/codex-app-server-pids.json`,
}));

import { killChildProcessGroup } from '../lib/process-kill';
import {
  enableCodexAppServerPidPersistence,
  flushCodexAppServerPidPersistenceForTests,
  isCodexAppServerCommandForTests,
  registerCodexAppServerProcess,
  unregisterCodexAppServerProcess,
  reapStaleCodexAppServerProcesses,
  resetCodexAppServerProcessRegistryForTests,
  terminateAllCodexAppServerProcesses,
  type CodexAppServerProcessOps,
} from '../codex/app-server-process-registry';

const killChildProcessGroupMock = jest.mocked(killChildProcessGroup);

function fakeProcess(pid: number | undefined): ChildProcess {
  const proc = new ChildProcess();
  Object.defineProperties(proc, {
    pid: { value: pid, configurable: true },
    exitCode: { value: null, writable: true, configurable: true },
    signalCode: { value: null, writable: true, configurable: true },
  });
  return proc;
}

async function readPidsFile(): Promise<number[]> {
  const raw = await readFile(
    join(mockDataDir, 'codex-app-server-pids.json'),
    'utf8',
  );
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('pids' in parsed) ||
    !Array.isArray(parsed.pids)
  ) {
    throw new Error('Unexpected pids file shape');
  }
  return parsed.pids.filter((pid): pid is number => typeof pid === 'number');
}

function flushPersistQueue(): Promise<void> {
  return flushCodexAppServerPidPersistenceForTests();
}

beforeEach(async () => {
  mockDataDir = await mkdtemp(join(tmpdir(), 'codex-pids-test-'));
  resetCodexAppServerProcessRegistryForTests();
  enableCodexAppServerPidPersistence();
  killChildProcessGroupMock.mockClear();
});

afterEach(async () => {
  await rm(mockDataDir, { recursive: true, force: true });
});

describe('pid persistence', () => {
  it('persists registered pids and removes them on unregister', async () => {
    const first = fakeProcess(101);
    const second = fakeProcess(202);
    registerCodexAppServerProcess(first);
    registerCodexAppServerProcess(second);
    await flushPersistQueue();
    expect(await readPidsFile()).toEqual([101, 202]);

    unregisterCodexAppServerProcess(first);
    await flushPersistQueue();
    expect(await readPidsFile()).toEqual([202]);
  });

  it('ignores processes without a pid', async () => {
    registerCodexAppServerProcess(fakeProcess(undefined));
    await flushPersistQueue();
    // No pid was recorded, so no file write was required; reading may fail.
    await expect(readPidsFile()).rejects.toThrow();
  });
});

describe('reapStaleCodexAppServerProcesses', () => {
  it('matches only codex app-server command lines before reaping stale pids', () => {
    expect(
      isCodexAppServerCommandForTests(
        'C:\\Users\\app\\codex.exe app-server --experimental',
      ),
    ).toBe(true);
    expect(
      isCodexAppServerCommandForTests('C:\\Users\\app\\codex.exe --version'),
    ).toBe(false);
    expect(isCodexAppServerCommandForTests('node worker.js')).toBe(false);
  });

  it('kills only verified codex app-server pids from a previous run', async () => {
    await writeFile(
      join(mockDataDir, 'codex-app-server-pids.json'),
      JSON.stringify({ version: 1, pids: [111, 222, 333] }),
      'utf8',
    );

    const killed: number[] = [];
    const ops: CodexAppServerProcessOps = {
      isCodexAppServerProcess: (pid: number): Promise<boolean> =>
        Promise.resolve(pid !== 222),
      killProcessTree: (pid: number): Promise<void> => {
        killed.push(pid);
        return Promise.resolve();
      },
    };

    const reaped = await reapStaleCodexAppServerProcesses(ops);
    expect(reaped).toBe(2);
    expect(killed).toEqual([111, 333]);
    // The file is rewritten to only reflect this run's live spawns.
    expect(await readPidsFile()).toEqual([]);
  });

  it('never reaps pids spawned by the current run', async () => {
    const live = fakeProcess(555);
    registerCodexAppServerProcess(live);
    await flushPersistQueue();

    const killed: number[] = [];
    const ops: CodexAppServerProcessOps = {
      isCodexAppServerProcess: (): Promise<boolean> => Promise.resolve(true),
      killProcessTree: (pid: number): Promise<void> => {
        killed.push(pid);
        return Promise.resolve();
      },
    };

    const reaped = await reapStaleCodexAppServerProcesses(ops);
    expect(reaped).toBe(0);
    expect(killed).toEqual([]);
    expect(await readPidsFile()).toEqual([555]);
  });

  it('returns zero when no pids file exists', async () => {
    const ops: CodexAppServerProcessOps = {
      isCodexAppServerProcess: (): Promise<boolean> => Promise.resolve(true),
      killProcessTree: (): Promise<void> => Promise.resolve(),
    };
    await expect(reapStaleCodexAppServerProcesses(ops)).resolves.toBe(0);
  });
});

describe('terminateAllCodexAppServerProcesses', () => {
  it('SIGTERMs live processes and SIGKILLs survivors after the grace window', async () => {
    const graceful = fakeProcess(11);
    const stubborn = fakeProcess(22);
    registerCodexAppServerProcess(graceful);
    registerCodexAppServerProcess(stubborn);

    killChildProcessGroupMock.mockImplementation(
      (child: ChildProcess, signal: NodeJS.Signals): void => {
        if (child.pid === 11 && signal === 'SIGTERM') {
          Reflect.set(graceful, 'exitCode', 0);
        }
        if (child.pid === 22 && signal === 'SIGKILL') {
          Reflect.set(stubborn, 'signalCode', 'SIGKILL');
        }
      },
    );

    await terminateAllCodexAppServerProcesses(150);

    const calls = killChildProcessGroupMock.mock.calls.map(
      ([child, signal]) => [child.pid, signal] as const,
    );
    expect(calls).toContainEqual([11, 'SIGTERM']);
    expect(calls).toContainEqual([22, 'SIGTERM']);
    expect(calls).toContainEqual([22, 'SIGKILL']);
    expect(calls).not.toContainEqual([11, 'SIGKILL']);
  });

  it('returns immediately when nothing is live', async () => {
    const exited = fakeProcess(33);
    Reflect.set(exited, 'exitCode', 0);
    registerCodexAppServerProcess(exited);

    await terminateAllCodexAppServerProcesses(50);
    expect(killChildProcessGroupMock).not.toHaveBeenCalled();
  });
});
