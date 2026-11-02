import { ChildProcess, spawn } from 'node:child_process';
import type * as NodeEvents from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  TERMINAL_USER_CLOSE_SIGNAL,
  type ScriptRunResponse,
} from '@canopy/desktop-shared/types';

type MockPtyListener = (event: { type: string; payload: unknown }) => void;
const mockPtyListeners = new Set<MockPtyListener>();
const mockPtySpawn = jest.fn(() => ({ id: 'pty-1' }));
const mockPtyKill = jest.fn();
const mockPtyDrainTerminal = jest.fn(() => Promise.resolve());

jest.mock('../../terminal/worker-terminal', () => ({
  workerTerminal: {
    addEventListener: (listener: MockPtyListener): (() => void) => {
      mockPtyListeners.add(listener);
      return (): void => {
        mockPtyListeners.delete(listener);
      };
    },
    create: mockPtySpawn,
    kill: mockPtyKill,
    lowerPriority: jest.fn(),
    release: mockPtyDrainTerminal,
  },
}));
jest.mock('node:child_process', () => {
  const { EventEmitter } = jest.requireActual<typeof NodeEvents>('node:events');
  return {
    ChildProcess: class ChildProcess extends EventEmitter {
      stdin = null;
      stdout = null;
      stderr = null;
      pid = 0;
    },
    spawn: jest.fn(),
    spawnSync: jest.fn(() => ({ status: 0 })),
    execFile: jest.fn(),
  };
});
jest.mock('@canopy/desktop-shared/node/lib/path-lookup', () => ({
  findExecutableOnPath: jest.fn(),
}));
jest.mock('../../lib/windows-git-bash', () => ({
  resolveWindowsGitBash: jest.fn(),
}));
jest.mock('../../lib/process-kill', () => ({
  killChildProcessGroup: jest.fn(),
  drainOwnedProcess: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../resource-monitor', () => ({
  getResourceMonitorService: (): unknown => ({
    registerProcess: (): unknown => ({ unregister: jest.fn() }),
  }),
}));

import { findExecutableOnPath } from '@canopy/desktop-shared/node/lib/path-lookup';
import {
  drainOwnedProcess,
  killChildProcessGroup,
} from '../../lib/process-kill';
import {
  buildShellScriptCommand,
  drainTrackedShellScriptRunsForWorktree,
  drainWorktreeShellScripts,
  isTrackedShellScriptRunning,
  listTrackedShellScripts,
  listTrackedShellScriptsForWorktree,
  runShellScript,
  stopAllRunningShellScripts,
  stopTrackedShellScript,
  type ScriptTrackingInfo,
} from '../../lib/script-runner';
import { resolveWindowsGitBash } from '../../lib/windows-git-bash';
import {
  withWorkspaceTargetArchiveDrain,
  withWorkspaceTargetAutoArchiveLease,
  withWorkspaceTargetAutoArchiveTeardown,
} from '../../lib/workspace-target-exclusion';

const mockedSpawn = jest.mocked(spawn);
const mockedFind = jest.mocked(findExecutableOnPath);
const mockedGitBash = jest.mocked(resolveWindowsGitBash);
const mockedKill = jest.mocked(killChildProcessGroup);
const mockedDrain = jest.mocked(drainOwnedProcess);

interface FakeChild {
  child: ChildProcess;
  stdout: PassThrough;
  stderr: PassThrough;
}

function fakeChild(pid: number): FakeChild {
  const child = new ChildProcess();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  child.stdout = stdout;
  child.stderr = stderr;
  Object.defineProperty(child, 'pid', { value: pid, writable: true });
  return { child, stdout, stderr };
}

let nextPid = 100;
function queueChild(): FakeChild {
  const fake = fakeChild(nextPid++);
  mockedSpawn.mockReturnValueOnce(fake.child);
  return fake;
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalShell = process.env.SHELL;
const originalComSpec = process.env.ComSpec;

function tracking(
  overrides: Partial<ScriptTrackingInfo> = {},
): ScriptTrackingInfo {
  return {
    projectId: 'p-1',
    worktreeId: 'w-1',
    scriptKey: 'repo:launch',
    ...overrides,
  };
}

function withoutDuration(
  response: ScriptRunResponse,
): Omit<ScriptRunResponse, 'durationMs'> {
  const { durationMs, ...rest } = response;
  expect(typeof durationMs).toBe('number');
  return rest;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  setPlatform('linux');
  mockedFind.mockReturnValue(null);
  mockedGitBash.mockReturnValue(null);
  mockPtyListeners.clear();
});

afterEach(() => {
  stopAllRunningShellScripts();
  jest.useRealTimers();
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
  if (originalComSpec === undefined) delete process.env.ComSpec;
  else process.env.ComSpec = originalComSpec;
});

describe('CAN-5062 golden: shell selection', () => {
  it('Linux defaults to bash from PATH, then /bin/bash, and uses -l when not interactive', () => {
    process.env.SHELL = '/usr/bin/fish';
    expect(buildShellScriptCommand('echo hi')).toEqual({
      command: '/bin/bash',
      args: ['-li', '-c', 'echo hi'],
    });
    mockedFind.mockImplementation((name) =>
      name === 'bash' ? '/usr/local/bin/bash' : null,
    );
    expect(
      buildShellScriptCommand(
        'echo hi',
        { mac: 'zsh', windows: 'powershell' },
        { interactive: false },
      ),
    ).toEqual({
      command: '/usr/local/bin/bash',
      args: ['-l', '-c', 'echo hi'],
    });
    expect(mockedFind).toHaveBeenLastCalledWith('bash');
  });

  it('Linux zsh resolves from PATH and refuses when missing', () => {
    expect(() => buildShellScriptCommand('x', { linux: 'zsh' })).toThrow(
      'zsh configured in shell.linux is not available on PATH. Install zsh or change shell.linux to "bash".',
    );
    mockedFind.mockReturnValue('/usr/bin/zsh');
    expect(buildShellScriptCommand('x', { linux: 'zsh' })).toEqual({
      command: '/usr/bin/zsh',
      args: ['-li', '-c', 'x'],
    });
  });

  it('macOS uses SHELL, then /bin/bash, or the configured mac shell', () => {
    setPlatform('darwin');
    process.env.SHELL = '/opt/homebrew/bin/fish';
    expect(buildShellScriptCommand('x', { linux: 'zsh' })).toEqual({
      command: '/opt/homebrew/bin/fish',
      args: ['-li', '-c', 'x'],
    });
    delete process.env.SHELL;
    expect(buildShellScriptCommand('x')).toEqual({
      command: '/bin/bash',
      args: ['-li', '-c', 'x'],
    });
    expect(buildShellScriptCommand('x', { mac: 'zsh' })).toEqual({
      command: '/bin/zsh',
      args: ['-li', '-c', 'x'],
    });
    mockedFind.mockReturnValue('/usr/local/bin/bash');
    expect(
      buildShellScriptCommand('x', { mac: 'bash' }, { interactive: false }),
    ).toEqual({ command: '/usr/local/bin/bash', args: ['-l', '-c', 'x'] });
  });

  it('Windows runs Git Bash only when asked and refuses without it', () => {
    setPlatform('win32');
    expect(() => buildShellScriptCommand('x', { windows: 'bash' })).toThrow(
      'Git Bash is not available on this Windows machine.',
    );
    mockedGitBash.mockReturnValue('C:\\Git\\bin\\bash.exe');
    expect(buildShellScriptCommand('ls', { windows: 'bash' })).toEqual({
      command: 'C:\\Git\\bin\\bash.exe',
      args: ['-lc', 'ls'],
    });
  });

  it('Windows defaults to pwsh, then powershell.exe, from a temp script that maps failure to an exit code', () => {
    setPlatform('win32');
    mockedFind.mockImplementation((name) =>
      name === 'pwsh.exe' ? 'C:\\pwsh\\pwsh.exe' : null,
    );
    const pwsh = buildShellScriptCommand('npm test', { linux: 'zsh' });
    const scriptPath = pwsh.args[5] ?? '';
    expect({ ...pwsh, cleanup: typeof pwsh.cleanup }).toEqual({
      command: 'C:\\pwsh\\pwsh.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
      ],
      cleanup: 'function',
    });
    expect(basename(scriptPath)).toBe('canopy-script.ps1');
    expect(basename(dirname(scriptPath))).toMatch(/^canopy-script-/);
    expect(readFileSync(scriptPath, 'utf8')).toBe(
      [
        "$ErrorActionPreference = 'Stop'",
        'npm test',
        '$canopyLastSuccess = $?',
        '$canopyLastExitCode = $LASTEXITCODE',
        'if (-not $canopyLastSuccess) {',
        '  if ($canopyLastExitCode -is [int] -and $canopyLastExitCode -ne 0) { exit $canopyLastExitCode }',
        '  exit 1',
        '}',
        'exit 0',
        '',
      ].join('\n'),
    );
    pwsh.cleanup?.();
    expect(existsSync(dirname(scriptPath))).toBe(false);

    mockedFind.mockImplementation((name) =>
      name === 'powershell.exe' ? 'C:\\WinPS\\powershell.exe' : null,
    );
    const legacy = buildShellScriptCommand('x');
    expect(legacy.command).toBe('C:\\WinPS\\powershell.exe');
    legacy.cleanup?.();

    mockedFind.mockReturnValue(null);
    const explicit = buildShellScriptCommand('x', { windows: 'powershell' });
    expect(explicit.command).toBe('powershell.exe');
    explicit.cleanup?.();
  });

  it('Windows falls back to cmd, or uses it when asked, from a quoted temp script', () => {
    setPlatform('win32');
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
    const fallback = buildShellScriptCommand('echo one');
    const fallbackPath = (fallback.args[3] ?? '').replace(/^"|"$/g, '');
    expect(fallback.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(fallback.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(basename(fallbackPath)).toBe('canopy-script.cmd');
    expect(readFileSync(fallbackPath, 'utf8')).toBe('echo one');
    fallback.cleanup?.();

    delete process.env.ComSpec;
    mockedFind.mockReturnValue('C:\\pwsh\\pwsh.exe');
    const explicit = buildShellScriptCommand('echo two', { windows: 'cmd' });
    expect(explicit.command).toBe('cmd.exe');
    expect(explicit.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    explicit.cleanup?.();
  });
});

describe('CAN-5062 golden: runner outcomes', () => {
  it('spawns detached off Windows and reports a clean exit with its output', async () => {
    const { child, stdout, stderr } = queueChild();
    const chunks: string[][] = [];
    const run = runShellScript({
      script: 'echo ok',
      cwd: '/work',
      env: { A: '1' },
      onChunk: (lines) => chunks.push(lines),
    });
    expect(mockedSpawn).toHaveBeenCalledWith(
      '/bin/bash',
      ['-li', '-c', 'echo ok'],
      {
        cwd: '/work',
        env: { A: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        windowsHide: true,
      },
    );
    stdout.emit('data', Buffer.from('line one\nline '));
    stderr.emit('data', Buffer.from('two\r\npartial'));
    child.emit('close', 0);

    expect(withoutDuration(await run)).toEqual({
      success: true,
      exitCode: 0,
      output: 'line one\nline two\r\npartial',
      timedOut: false,
    });
    expect(chunks).toEqual([['line one', 'line two', 'partial']]);
  });

  it('spawns attached on Windows', async () => {
    setPlatform('win32');
    mockedFind.mockReturnValue(null);
    const { child } = queueChild();
    const run = runShellScript({ script: 'x', cwd: 'C:\\work' });
    expect(mockedSpawn.mock.calls[0]?.[2]).toMatchObject({ detached: false });
    child.emit('close', 0);
    expect((await run).success).toBe(true);
  });

  it('reports a non-zero exit code as a failure', async () => {
    const { child } = queueChild();
    const run = runShellScript({ script: 'exit 3', cwd: '/work' });
    child.emit('close', 3);
    expect(withoutDuration(await run)).toEqual({
      success: false,
      exitCode: 3,
      output: '',
      timedOut: false,
    });
  });

  it('reports a spawn error event and a throwing spawn', async () => {
    const { child, stdout } = queueChild();
    const chunks: string[][] = [];
    const run = runShellScript({
      script: 'x',
      cwd: '/work',
      onChunk: (lines) => chunks.push(lines),
    });
    stdout.emit('data', Buffer.from('before\n'));
    child.emit('error', new Error('spawn EACCES'));
    expect(withoutDuration(await run)).toEqual({
      success: false,
      exitCode: 1,
      output: 'before\n\nError: spawn EACCES',
      timedOut: false,
    });
    expect(chunks).toEqual([['before'], ['Error: spawn EACCES']]);

    mockedSpawn.mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });
    const thrown: string[][] = [];
    expect(
      withoutDuration(
        await runShellScript({
          script: 'x',
          cwd: '/work',
          onChunk: (lines) => thrown.push(lines),
        }),
      ),
    ).toEqual({
      success: false,
      exitCode: 1,
      output: 'Error: ENOENT',
      timedOut: false,
    });
    expect(thrown).toEqual([['Error: ENOENT']]);
  });

  it('refuses before spawning when the shell cannot be built', async () => {
    const run = runShellScript({
      script: 'x',
      cwd: '/work',
      shell: { linux: 'zsh' },
    });
    expect(withoutDuration(await run)).toEqual({
      success: false,
      exitCode: 1,
      output:
        'Error: zsh configured in shell.linux is not available on PATH. Install zsh or change shell.linux to "bash".',
      timedOut: false,
    });
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('truncates collected output at 256 KiB and says so', async () => {
    const { child, stdout } = queueChild();
    const chunks: string[][] = [];
    const run = runShellScript({
      script: 'x',
      cwd: '/work',
      onChunk: (lines) => chunks.push(lines),
    });
    stdout.emit('data', Buffer.alloc(256 * 1024 + 10, 'a'));
    child.emit('close', 0);
    const response = await run;
    expect(response.output).toHaveLength(
      256 * 1024 + '\n[output truncated]'.length,
    );
    expect(response.output.endsWith('a\n[output truncated]')).toBe(true);
    expect(response.success).toBe(true);
    expect(chunks.at(-1)).toEqual(['[output truncated]']);
  });

  it('times out with SIGTERM, keeps the exit code, and clamps the timeout to the maximum', async () => {
    const { child } = queueChild();
    const run = runShellScript({
      script: 'sleep 99',
      cwd: '/work',
      timeoutSeconds: 2,
    });
    jest.advanceTimersByTime(1_999);
    expect(mockedKill).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(mockedKill).toHaveBeenCalledWith(child, 'SIGTERM');
    child.emit('close', 143);
    expect(withoutDuration(await run)).toEqual({
      success: false,
      exitCode: 143,
      output: '',
      timedOut: true,
    });

    const clamped = queueChild();
    const longRun = runShellScript({
      script: 'x',
      cwd: '/work',
      timeoutSeconds: 10 ** 9,
    });
    jest.advanceTimersByTime(2_000_000 * 1000 - 1);
    expect(mockedKill).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(mockedKill).toHaveBeenLastCalledWith(clamped.child, 'SIGTERM');
    clamped.child.emit('close', null);
    expect((await longRun).timedOut).toBe(true);
  });

  it('never times out without a positive timeout', async () => {
    const { child } = queueChild();
    const run = runShellScript({
      script: 'x',
      cwd: '/work',
      timeoutSeconds: 0,
    });
    jest.advanceTimersByTime(48 * 60 * 60 * 1000);
    expect(mockedKill).not.toHaveBeenCalled();
    child.emit('close', 0);
    expect((await run).timedOut).toBe(false);
  });

  it('force-kills five seconds after a stop and settles without close', async () => {
    const { child } = queueChild();
    const target = tracking();
    const run = runShellScript({ script: 'x', cwd: '/work', tracking: target });
    const stopped = stopTrackedShellScript(target);
    expect(mockedKill).toHaveBeenCalledWith(child, 'SIGTERM');
    jest.advanceTimersByTime(4_999);
    expect(mockedKill).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(mockedKill).toHaveBeenLastCalledWith(child, 'SIGKILL');
    const expected = {
      success: false,
      exitCode: null,
      output: '',
      timedOut: false,
    };
    expect(withoutDuration(await run)).toEqual(expected);
    const result = await stopped;
    expect(result?.tracking).toEqual(target);
    expect(withoutDuration(result?.response ?? (await run))).toEqual(expected);
    expect(isTrackedShellScriptRunning(target)).toBe(false);
  });

  it('reports a timed-out run that needs a force kill as timed out', async () => {
    const { child } = queueChild();
    const run = runShellScript({
      script: 'x',
      cwd: '/work',
      timeoutSeconds: 1,
    });
    jest.advanceTimersByTime(1_000 + 5_000);
    expect(mockedKill.mock.calls).toEqual([
      [child, 'SIGTERM'],
      [child, 'SIGKILL'],
    ]);
    expect(withoutDuration(await run)).toEqual({
      success: false,
      exitCode: null,
      output: '',
      timedOut: true,
    });
  });

  it('reports a manual stop and an abort as cancelled with no exit code', async () => {
    const stopped = queueChild();
    const target = tracking({ scriptKey: 'repo:dev' });
    const run = runShellScript({ script: 'x', cwd: '/work', tracking: target });
    void stopTrackedShellScript(target);
    stopped.child.emit('close', 143);
    expect(withoutDuration(await run)).toEqual({
      success: false,
      exitCode: null,
      output: '',
      timedOut: false,
    });

    const aborted = queueChild();
    const controller = new AbortController();
    controller.abort();
    const abortedRun = runShellScript({
      script: 'x',
      cwd: '/work',
      signal: controller.signal,
    });
    expect(mockedKill).toHaveBeenLastCalledWith(aborted.child, 'SIGTERM');
    aborted.child.emit('close', 0);
    expect(withoutDuration(await abortedRun)).toEqual({
      success: false,
      exitCode: null,
      output: '',
      timedOut: false,
    });
  });
});

describe('CAN-5062 golden: tracked runs and the drain on worktree removal', () => {
  it('drains every run of the worktree, hooks included, through the owned-process drain', async () => {
    const script = queueChild();
    const hook = queueChild();
    const other = queueChild();
    const scriptRun = runShellScript({
      script: 'a',
      cwd: '/w',
      tracking: tracking(),
    });
    const hookRun = runShellScript({
      script: 'b',
      cwd: '/w',
      tracking: tracking({ scriptKey: 'repo:launch', kind: 'hook' }),
    });
    const otherRun = runShellScript({
      script: 'c',
      cwd: '/w',
      tracking: tracking({ worktreeId: 'w-2' }),
    });
    expect(listTrackedShellScripts().map((entry) => entry.worktreeId)).toEqual([
      'w-1',
      'w-2',
    ]);
    expect(
      listTrackedShellScriptsForWorktree({
        projectId: 'p-1',
        worktreeId: 'w-1',
      }),
    ).toEqual([tracking()]);

    await drainWorktreeShellScripts('p-1', 'w-1');

    expect(mockedDrain.mock.calls.map(([pid]) => pid)).toEqual([
      script.child.pid,
      hook.child.pid,
    ]);
    const isOwned = mockedDrain.mock.calls[0]?.[1];
    expect(isOwned?.()).toBe(false);
    const cancelled = {
      success: false,
      exitCode: null,
      output: '',
      timedOut: false,
    };
    expect(withoutDuration(await scriptRun)).toEqual(cancelled);
    expect(withoutDuration(await hookRun)).toEqual(cancelled);
    expect(mockedKill).not.toHaveBeenCalled();
    expect(listTrackedShellScripts()).toEqual([
      tracking({ worktreeId: 'w-2' }),
    ]);
    other.child.emit('close', 0);
    expect((await otherRun).success).toBe(true);
  });

  it('keeps a run tracked when its drain fails, and rethrows the failure', async () => {
    const { child } = queueChild();
    const run = runShellScript({
      script: 'a',
      cwd: '/w',
      tracking: tracking(),
    });
    mockedDrain.mockRejectedValueOnce(new Error('ownership changed'));
    await expect(drainWorktreeShellScripts('p-1', 'w-1')).rejects.toThrow(
      'ownership changed',
    );
    expect(isTrackedShellScriptRunning(tracking())).toBe(true);
    child.emit('close', 0);
    expect(withoutDuration(await run)).toEqual({
      success: false,
      exitCode: null,
      output: '',
      timedOut: false,
    });
  });

  it('drains only matching non-hook runs when filtered', async () => {
    queueChild();
    const hook = queueChild();
    const run = runShellScript({
      script: 'a',
      cwd: '/w',
      tracking: tracking(),
    });
    const hookRun = runShellScript({
      script: 'b',
      cwd: '/w',
      tracking: tracking({ kind: 'hook' }),
    });
    const drained = await drainTrackedShellScriptRunsForWorktree(
      { projectId: 'p-1', worktreeId: 'w-1' },
      () => true,
    );
    expect(drained.map((entry) => entry.tracking)).toEqual([tracking()]);
    expect((await run).exitCode).toBeNull();
    expect(isTrackedShellScriptRunning(tracking({ kind: 'hook' }))).toBe(true);
    hook.child.emit('close', 0);
    expect((await hookRun).success).toBe(true);
  });

  it('refuses a tracked start while the worktree is being archived', async () => {
    await withWorkspaceTargetArchiveDrain('p-1', 'w-1', () => {
      expect(() =>
        runShellScript({ script: 'x', cwd: '/w', tracking: tracking() }),
      ).toThrow(
        'This worktree is being archived. Retry after archiving finishes.',
      );
      return Promise.resolve();
    });
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('refuses a tracked start during Auto Delete except in its own teardown, and never fences untracked runs', async () => {
    await withWorkspaceTargetAutoArchiveLease('p-1', 'w-1', async () => {
      expect(() =>
        runShellScript({ script: 'x', cwd: '/w', tracking: tracking() }),
      ).toThrow(
        'This workspace target is being automatically deleted. Retry after deletion finishes.',
      );

      const untracked = queueChild();
      const untrackedRun = runShellScript({ script: 'x', cwd: '/w' });
      untracked.child.emit('close', 0);
      expect((await untrackedRun).success).toBe(true);

      await withWorkspaceTargetAutoArchiveTeardown('p-1', 'w-1', async () => {
        const teardown = queueChild();
        const run = runShellScript({
          script: 'teardown',
          cwd: '/w',
          tracking: tracking({ scriptKey: 'repo:teardown' }),
        });
        teardown.child.emit('close', 0);
        expect((await run).success).toBe(true);
      });
    });
    expect(mockedSpawn).toHaveBeenCalledTimes(2);
  });
});

describe('CAN-5062 golden: interactive runs', () => {
  function emitPty(type: string, payload: unknown): void {
    mockPtyListeners.forEach((listener) => listener({ type, payload }));
  }

  it('refuses an interactive run without worktree ownership', async () => {
    expect(
      withoutDuration(
        await runShellScript({ script: 'x', cwd: '/w', interactive: true }),
      ),
    ).toEqual({
      success: false,
      exitCode: 1,
      output:
        'Interactive scripts require projectId and worktreeId tracking ownership.',
      timedOut: false,
    });
  });

  it('maps PTY exit, timeout and user close outcomes', async () => {
    const exited = runShellScript({
      script: 'x',
      cwd: '/w',
      interactive: true,
      tracking: tracking(),
    });
    await jest.runOnlyPendingTimersAsync();
    emitPty('output', { terminalId: 'pty-1', data: 'hi\n' });
    emitPty('exit', {
      terminalId: 'pty-1',
      exitCode: 4,
      signal: null,
    });
    expect(withoutDuration(await exited)).toEqual({
      success: false,
      exitCode: 4,
      output: 'hi\n',
      timedOut: false,
    });

    const timed = runShellScript({
      script: 'x',
      cwd: '/w',
      interactive: true,
      timeoutSeconds: 1,
      tracking: tracking(),
    });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(mockPtyKill).toHaveBeenCalledWith('pty-1');
    emitPty('exit', {
      terminalId: 'pty-1',
      exitCode: 0,
      signal: 'SIGHUP',
    });
    expect(withoutDuration(await timed)).toEqual({
      success: false,
      exitCode: 0,
      output: '',
      timedOut: true,
    });

    const closed = runShellScript({
      script: 'x',
      cwd: '/w',
      interactive: true,
      tracking: tracking(),
    });
    await jest.runOnlyPendingTimersAsync();
    emitPty('exit', {
      terminalId: 'pty-1',
      exitCode: 0,
      signal: TERMINAL_USER_CLOSE_SIGNAL,
    });
    expect(withoutDuration(await closed)).toEqual({
      success: false,
      exitCode: null,
      output: '',
      timedOut: false,
    });
  });
});
