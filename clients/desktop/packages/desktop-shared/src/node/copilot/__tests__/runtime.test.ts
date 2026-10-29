import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { copilotRuntimeEnvironment } from '../runtime-environment';
import {
  MAX_CONSECUTIVE_OBSERVATION_FAILURES,
  startCopilotRuntime,
} from '../runtime';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import * as loader from '../../lib/packaged-module-loader';
import * as ownership from '../process-ownership';

jest.mock('node:fs/promises', () => ({
  __esModule: true,
  ...jest.requireActual<typeof fs>('node:fs/promises'),
}));
jest.mock('node:child_process', () => ({
  __esModule: true,
  ...jest.requireActual<typeof childProcess>('node:child_process'),
}));

describe('Copilot runtime ownership', () => {
  it('strips ambient credentials, endpoint overrides and injected hooks without changing HOME', () => {
    expect(
      copilotRuntimeEnvironment(
        {
          HOME: '/home/user',
          PATH: '/bin',
          TOOL_SECRET: 'intended',
          COPILOT_API_URL: 'https://other.invalid',
          GITHUB_TOKEN: 'ambient',
          gh_token: 'case-insensitive',
          NODE_OPTIONS: '--require untrusted.js',
          BASH_ENV: '/untrusted',
          COPILOT_ALLOW_ALL: 'true',
        },
        '/owned',
        'connection-secret',
      ),
    ).toEqual({
      HOME: '/home/user',
      PATH: '/bin',
      TOOL_SECRET: 'intended',
      COPILOT_HOME: '/owned',
      COPILOT_CONNECTION_TOKEN: 'connection-secret',
      COPILOT_AUTO_UPDATE: 'false',
      COPILOT_DISABLE_KEYTAR: '1',
      COPILOT_TELEMETRY_OFF: 'true',
      NO_COLOR: '1',
    });
  });

  it('launches headless with ambient sign-in disabled', async () => {
    const mkdir = jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    const spawn = jest.spyOn(childProcess, 'spawn').mockImplementation(() => {
      throw new Error('stop at spawn');
    });
    try {
      await expect(
        startCopilotRuntime({
          executable: '/owned/copilot',
          workingDirectory: '/owned',
          stateDirectory: '/owned/state',
          expectedVersion: 'fixture',
          env: {},
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('stop at spawn');
      expect(spawn.mock.calls[0]?.[1]).toEqual([
        '--headless',
        '--no-auto-update',
        '--log-level',
        'none',
        '--no-remote-export',
        '--disable-builtin-mcps',
        '--no-bash-env',
        '--no-auto-login',
      ]);
    } finally {
      spawn.mockRestore();
      mkdir.mockRestore();
    }
  });

  it('rejects and reaps a failed spawn instead of leaving startup pending', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'copilot-spawn-test-'));
    try {
      await expect(
        startCopilotRuntime({
          executable: join(directory, 'missing'),
          expectedVersion: 'fixture',
          workingDirectory: directory,
          stateDirectory: directory,
          env: {},
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('could not start');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not launch an already cancelled owner', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      startCopilotRuntime({
        executable: '/missing',
        expectedVersion: 'fixture',
        workingDirectory: '/',
        stateDirectory: '/unused',
        env: {},
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});

describe('Copilot bounded process cleanup', () => {
  const platform = process.platform;
  const client = {
    start: jest.fn(() => Promise.resolve()),
    getStatus: jest.fn(() => Promise.resolve({ version: 'fixture' })),
    stop: jest.fn(() => Promise.resolve()),
    forceStop: jest.fn(() => Promise.resolve()),
    rpc: { runtime: { shutdown: jest.fn(() => Promise.resolve()) } },
  };
  const connectedRpc = client.rpc;
  let child: childProcess.ChildProcess;
  let output: PassThrough;
  let controller: AbortController;
  beforeEach(() => {
    jest.useFakeTimers();
    output = new PassThrough();
    child = Object.assign(new childProcess.ChildProcess(), {
      pid: 12345,
      stdout: output,
      stderr: new PassThrough(),
    });
    controller = new AbortController();
    jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    jest.spyOn(childProcess, 'spawn').mockReturnValue(child);
    jest.spyOn(ownership, 'killCopilotProcess').mockResolvedValue();
    jest.spyOn(ownership, 'snapshotCopilotDescendants').mockResolvedValue([]);
    jest.spyOn(ownership, 'terminateCopilotDescendants').mockResolvedValue();
    jest.spyOn(loader, 'loadRequiredNodeModule').mockReturnValue({
      CopilotClient: jest.fn(() => client),
      RuntimeConnection: { forUri: jest.fn() },
    });
  });
  afterEach(() => {
    Object.defineProperty(client, 'rpc', {
      value: connectedRpc,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process, 'platform', { value: platform });
    jest.restoreAllMocks();
    jest.clearAllMocks();
    jest.useRealTimers();
  });
  const options = (): Parameters<typeof startCopilotRuntime>[0] => ({
    executable: '/owned/copilot',
    workingDirectory: '/owned',
    stateDirectory: '/owned/state',
    expectedVersion: 'fixture',
    env: {},
    signal: controller.signal,
  });

  it.each(['darwin', 'win32'])(
    'never signals or inspects a reaped parent on %s',
    async (platformName) => {
      Object.defineProperty(process, 'platform', { value: platformName });
      const starting = startCopilotRuntime(options());
      await jest.advanceTimersByTimeAsync(0);
      output.write('listening on port 1234');
      const runtime = await starting;
      jest.mocked(ownership.snapshotCopilotDescendants).mockClear();
      Object.defineProperty(child, 'exitCode', { value: 0 });
      child.emit('exit', 0);
      child.emit('close', 0);
      await runtime.close();
      expect(ownership.killCopilotProcess).not.toHaveBeenCalled();
      expect(ownership.snapshotCopilotDescendants).not.toHaveBeenCalled();
    },
  );

  it.each(['darwin', 'win32'])(
    'retains observed descendants when the parent crashes on %s',
    async (platformName) => {
      Object.defineProperty(process, 'platform', { value: platformName });
      const survivor = {
        pid: 23456,
        parent: 12345,
        group: 23456,
        started: 'original',
      };
      jest
        .mocked(ownership.snapshotCopilotDescendants)
        .mockResolvedValue([survivor]);
      const starting = startCopilotRuntime(options());
      await jest.advanceTimersByTimeAsync(0);
      output.write('listening on port 1234');
      const runtime = await starting;
      await jest.advanceTimersByTimeAsync(1000);
      Object.defineProperty(child, 'exitCode', { value: 1 });
      child.emit('exit', 1);
      child.emit('close', 1);
      await runtime.close();
      expect(ownership.terminateCopilotDescendants).toHaveBeenCalledWith([
        survivor,
      ]);
      expect(ownership.killCopilotProcess).not.toHaveBeenCalled();
    },
  );

  it('does not escalate against the PID after SIGTERM reaps the runtime', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    jest.mocked(ownership.killCopilotProcess).mockImplementation(() => {
      Object.defineProperty(child, 'exitCode', { value: 0 });
      child.emit('exit', 0);
      child.emit('close', 0);
      return Promise.resolve();
    });
    const starting = startCopilotRuntime(options());
    await jest.advanceTimersByTimeAsync(0);
    output.write('listening on port 1234');
    await (await starting).close();
    expect(ownership.killCopilotProcess).toHaveBeenCalledTimes(1);
    expect(ownership.killCopilotProcess).toHaveBeenCalledWith(child, 'SIGTERM');
  });

  it('terminates the owned process if the SDK RPC getter throws before connection', async () => {
    client.start.mockRejectedValueOnce(new Error('connection failed'));
    Object.defineProperty(client, 'rpc', {
      configurable: true,
      get: () => {
        throw new Error('disconnected');
      },
    });
    jest.mocked(ownership.killCopilotProcess).mockImplementation(() => {
      child.emit('close', 0);
      return Promise.resolve();
    });
    const starting = startCopilotRuntime(options());
    const failure = starting.catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(0);
    output.write('listening on port 1234');
    const result = await failure;
    expect(ownership.killCopilotProcess).toHaveBeenCalled();
    expect(result).toMatchObject({ message: 'connection failed' });
  });

  it('reports a bounded shutdown failure when the process cannot be reaped', async () => {
    const starting = startCopilotRuntime(options());
    await jest.advanceTimersByTimeAsync(0);
    output.write('listening on port 1234');
    const runtime = await starting;
    let failure: unknown;
    const closing = runtime.close().catch((error: unknown) => {
      failure = error;
    });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(failure).toBeInstanceOf(Error);
    await closing;
  });

  it('kills the Windows tree before any RPC can exit its parent', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    jest.mocked(ownership.killCopilotProcess).mockImplementation(() => {
      child.emit('close', 0);
      return Promise.resolve();
    });
    const starting = startCopilotRuntime(options());
    await jest.advanceTimersByTimeAsync(0);
    output.write('listening on port 1234');
    const runtime = await starting;
    await runtime.close();
    expect(ownership.killCopilotProcess).toHaveBeenCalledWith(child, 'SIGKILL');
    expect(client.rpc.runtime.shutdown).not.toHaveBeenCalled();
  });

  describe('ownership observation failures', () => {
    const inspectionFailure = new Error(
      'Copilot process ownership could not be inspected.',
    );
    const started = async (): Promise<
      Awaited<ReturnType<typeof startCopilotRuntime>>
    > => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      jest.mocked(ownership.killCopilotProcess).mockImplementation(() => {
        child.emit('close', 0);
        return Promise.resolve();
      });
      const starting = startCopilotRuntime(options());
      await jest.advanceTimersByTimeAsync(0);
      output.write('listening on port 1234');
      return starting;
    };

    it('keeps the runtime through transient inspection failures', async () => {
      const runtime = await started();
      const snapshot = jest.mocked(ownership.snapshotCopilotDescendants);
      for (let round = 0; round < 2; round++) {
        for (let i = 1; i < MAX_CONSECUTIVE_OBSERVATION_FAILURES; i++)
          snapshot.mockRejectedValueOnce(inspectionFailure);
        snapshot.mockResolvedValueOnce([]);
        await jest.advanceTimersByTimeAsync(
          500 * MAX_CONSECUTIVE_OBSERVATION_FAILURES,
        );
      }
      expect(ownership.killCopilotProcess).not.toHaveBeenCalled();
      await runtime.close();
    });

    it('stops the runtime when inspection keeps failing', async () => {
      const runtime = await started();
      jest
        .mocked(ownership.snapshotCopilotDescendants)
        .mockRejectedValue(inspectionFailure);
      await jest.advanceTimersByTimeAsync(
        500 * (MAX_CONSECUTIVE_OBSERVATION_FAILURES - 1),
      );
      expect(ownership.killCopilotProcess).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(500);
      expect(ownership.killCopilotProcess).toHaveBeenCalledWith(
        child,
        'SIGKILL',
      );
      await expect(runtime.close()).rejects.toBe(inspectionFailure);
    });

    it('stops the runtime at once when the ownership limit is reached', async () => {
      const runtime = await started();
      jest.mocked(ownership.snapshotCopilotDescendants).mockResolvedValue(
        Array.from({ length: 16_385 }, (_, index) => ({
          pid: 20_000 + index,
          parent: 12345,
          group: 0,
          started: '1',
        })),
      );
      await jest.advanceTimersByTimeAsync(500);
      expect(ownership.killCopilotProcess).toHaveBeenCalledWith(
        child,
        'SIGKILL',
      );
      await expect(runtime.close()).rejects.toThrow(
        'Copilot process ownership limit exceeded.',
      );
    });
  });
});

describe('Copilot process signals', () => {
  afterEach(() => jest.restoreAllMocks());

  it('does not fall back to a bare PID if the owned process group is gone', async () => {
    if (process.platform === 'win32') return;
    const child = Object.assign(new childProcess.ChildProcess(), {
      pid: 12345,
    });
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    await ownership.killCopilotProcess(child, 'SIGTERM');
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(-12345, 'SIGTERM');
  });
});

describe('Windows Copilot descendant ownership', () => {
  const platform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
    jest.restoreAllMocks();
  });

  it.each([true, false])(
    'rejects stale parent links (root present: %s)',
    async (rootPresent) => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const rows = [
        ...(rootPresent ? ['12345 10 20260930030002000000'] : []),
        '23456 12345 20260930030003000000',
        '34567 12345 20260930030001000000',
        '45678 23456 20260930030002000000',
        '56789 34567 20260930030004000000',
        '67890 23456 20260930030004000000',
      ].join('\n');
      jest.spyOn(childProcess, 'execFile').mockImplementation((...args) => {
        const callback = args[args.length - 1];
        if (typeof callback === 'function') callback(null, rows, '');
        return new childProcess.ChildProcess();
      });
      const descendants = await ownership.snapshotCopilotDescendants(12345);
      expect(descendants.map((row) => row.pid)).toEqual(
        rootPresent ? [23456, 67890] : [],
      );
    },
  );
});

test('reaps an observed detached tool after a real CLI process crashes', async () => {
  if (process.platform === 'win32') return;
  const directory = await mkdtemp(join(tmpdir(), 'copilot-crash-test-'));
  const executable = join(directory, 'fixture.cjs');
  const marker = join(directory, 'child.pid');
  let survivor: number | undefined;
  const abort = new AbortController();
  const sdk = jest.spyOn(loader, 'loadRequiredNodeModule').mockReturnValue({
    CopilotClient: class {
      async start(): Promise<void> {}
      getStatus(): Promise<{ version: string }> {
        return Promise.resolve({ version: 'fixture' });
      }
      async forceStop(): Promise<void> {}
    },
    RuntimeConnection: { forUri: jest.fn() },
  });
  try {
    await writeFile(
      executable,
      `#!/usr/bin/env node
const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(child.pid));
child.unref();
console.log('listening on port 1234');
setTimeout(() => process.exit(1), 900);
`,
      { mode: 0o700 },
    );
    const runtime = await startCopilotRuntime({
      executable,
      expectedVersion: 'fixture',
      workingDirectory: directory,
      stateDirectory: directory,
      env: process.env,
      signal: abort.signal,
    });
    const toolPid = Number(await readFile(marker, 'utf8'));
    survivor = toolPid;
    await runtime.exited;
    expect(() => process.kill(toolPid, 0)).not.toThrow();
    await runtime.close();
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        process.kill(survivor, 0);
      } catch {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Detached tool survived its crashed owner');
  } finally {
    abort.abort();
    if (survivor) {
      try {
        process.kill(-survivor, 'SIGKILL');
      } catch {
        /* already reaped */
      }
    }
    sdk.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);

describe('Windows Copilot descendant termination', () => {
  const platform = process.platform;
  // Report the real-process cases as skipped off Windows instead of passing.
  const itOnWindows = platform === 'win32' ? it : it.skip;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
    jest.restoreAllMocks();
  });

  it('reports success explicitly so an already reaped descendant cannot fail the kill', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    let script = '';
    jest.spyOn(childProcess, 'execFile').mockImplementation((...args) => {
      const callback = args[args.length - 1];
      const stdin = new PassThrough();
      stdin.on('data', (chunk: Buffer) => {
        script += chunk.toString('utf8');
      });
      stdin.on('finish', () => {
        if (typeof callback === 'function') callback(null, '', '');
      });
      return Object.assign(new childProcess.ChildProcess(), { stdin });
    });
    await ownership.terminateCopilotDescendants([
      { pid: 23456, parent: 12345, group: 0, started: '20260930030003000000' },
    ]);
    expect(script).toContain("@{Id=23456;Started='20260930030003000000'}");
    expect(script.trimEnd().endsWith('; exit 0')).toBe(true);
  });

  itOnWindows(
    'resolves after taskkill has already reaped every observed descendant',
    async () => {
      const reaped = childProcess.spawn(
        process.execPath,
        ['-e', 'process.exit(0)'],
        {
          stdio: 'ignore',
          windowsHide: true,
        },
      );
      const pid = reaped.pid;
      if (!pid) throw new Error('fixture process did not spawn');
      await new Promise<void>((resolve) =>
        reaped.once('close', () => resolve()),
      );
      await expect(
        ownership.terminateCopilotDescendants([
          {
            pid,
            parent: process.pid,
            group: 0,
            started: '20260101000000000000',
          },
        ]),
      ).resolves.toBeUndefined();
    },
    15_000,
  );

  itOnWindows(
    'skips a reused PID this user cannot open instead of failing the kill',
    async () => {
      await expect(
        ownership.terminateCopilotDescendants([
          { pid: 4, parent: 0, group: 0, started: '19700101000000000000' },
        ]),
      ).resolves.toBeUndefined();
    },
    15_000,
  );

  itOnWindows(
    'kills only a live descendant whose observed start time still matches',
    async () => {
      const idle = ['-e', 'setInterval(() => {}, 1000)'];
      const owned = childProcess.spawn(process.execPath, idle, {
        stdio: 'ignore',
        windowsHide: true,
      });
      const bystander = childProcess.spawn(process.execPath, idle, {
        stdio: 'ignore',
        windowsHide: true,
      });
      try {
        const rows = await ownership.snapshotCopilotDescendants(process.pid);
        const ownedRow = rows.find((row) => row.pid === owned.pid);
        const bystanderPid = bystander.pid;
        if (!ownedRow || !bystanderPid)
          throw new Error('fixture processes were not enumerated');
        const ownedExit = new Promise<void>((resolve) =>
          owned.once('exit', () => resolve()),
        );
        await ownership.terminateCopilotDescendants([
          ownedRow,
          {
            pid: bystanderPid,
            parent: process.pid,
            group: 0,
            started: '19700101000000000000',
          },
        ]);
        await ownedExit;
        // Give a wrongly killed bystander time to be reaped before probing it.
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        expect(() => process.kill(bystanderPid, 0)).not.toThrow();
        expect(bystander.exitCode).toBeNull();
      } finally {
        owned.kill();
        bystander.kill();
      }
    },
    15_000,
  );
});
