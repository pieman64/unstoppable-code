import { ChildProcess, spawn } from 'node:child_process';
import type * as NodeEvents from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { MAX_SCRIPT_TIMEOUT_SECONDS } from '@canopy/desktop-shared/scripts';
import {
  IPC_CHANNELS,
  TERMINAL_USER_CLOSE_SIGNAL,
  type TerminalExitEvent,
  type TerminalOutputEvent,
  type TerminalRunningChangedEvent,
  type TerminalSession,
} from '@canopy/desktop-shared/types';
import type { ResourceProcessRegistration } from '../resource-monitor';

const mockSetPriority = jest.fn();
const mockResourceRegistrationUnregister = jest.fn((): void => undefined);
const mockRegisterResourceProcess = jest.fn(
  (
    registration: ResourceProcessRegistration,
  ): {
    unregister: typeof mockResourceRegistrationUnregister;
    update: jest.MockedFunction<
      (update: Partial<ResourceProcessRegistration>) => void
    >;
  } => {
    void registration;
    return {
      unregister: mockResourceRegistrationUnregister,
      update: jest.fn(),
    };
  },
);
type MockPtyEventPayload =
  | TerminalSession
  | TerminalOutputEvent
  | TerminalExitEvent
  | TerminalRunningChangedEvent;
type MockPtyListener = (channel: string, payload: MockPtyEventPayload) => void;

const mockPtyListeners = new Set<MockPtyListener>();
const mockPtySpawn = jest.fn(() => ({
  id: 'interactive-terminal-1',
  projectId: 'project-1',
  worktreeId: 'wt-1',
  shell: '/bin/zsh',
  shellBasename: 'zsh',
  cwd: '/tmp',
  createdAt: 1,
  kind: 'script' as const,
  title: 'Wizard',
}));
const mockPtySpawnWithEnvironment = jest.fn(() => ({
  id: 'interactive-terminal-1',
  projectId: 'project-1',
  worktreeId: 'wt-1',
  shell: '/bin/zsh',
  shellBasename: 'zsh',
  cwd: '/tmp',
  createdAt: 1,
  kind: 'script' as const,
  title: 'Wizard',
}));
const mockPtyKill = jest.fn();
const mockPtyLowerPriority = jest.fn();

function emitMockPtyEvent(channel: string, payload: MockPtyEventPayload): void {
  mockPtyListeners.forEach((listener: MockPtyListener) => {
    listener(channel, payload);
  });
}

jest.mock('../terminal/pty-manager', () => ({
  ptyManager: {
    addEventListener: jest.fn((listener: MockPtyListener) => {
      mockPtyListeners.add(listener);
      return (): void => {
        mockPtyListeners.delete(listener);
      };
    }),
    spawn: mockPtySpawn,
    spawnWithEnvironment: mockPtySpawnWithEnvironment,
    kill: mockPtyKill,
    lowerPriority: mockPtyLowerPriority,
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
  };
});

jest.mock('node:os', () => {
  const actual = jest.requireActual<Record<string, unknown>>('node:os');
  return {
    ...actual,
    setPriority: mockSetPriority,
  };
});

jest.mock('@canopy/desktop-shared/node/lib/path-lookup', () => ({
  findExecutableOnPath: jest.fn(),
}));

jest.mock('../lib/windows-git-bash', () => ({
  resolveWindowsGitBash: jest.fn(),
}));

jest.mock('../resource-monitor', () => ({
  getResourceMonitorService: (): {
    registerProcess: typeof mockRegisterResourceProcess;
  } => ({
    registerProcess: mockRegisterResourceProcess,
  }),
}));

import {
  type ScriptTrackingInfo,
  buildShellScriptCommand,
  drainWorktreeShellScripts,
  runShellScript,
  stopTrackedShellScript,
  stopTrackedShellScriptRun,
  drainTrackedShellScriptRunsForWorktree,
  stopAllRunningShellScripts,
} from '../lib/script-runner';

const pathLookupMock = jest.requireMock<{
  findExecutableOnPath: jest.MockedFunction<(name: string) => string | null>;
}>('@canopy/desktop-shared/node/lib/path-lookup');
const mockedFindExecutableOnPath = pathLookupMock.findExecutableOnPath;
const windowsGitBashMock = jest.requireMock<{
  resolveWindowsGitBash: jest.MockedFunction<() => string | null>;
}>('../lib/windows-git-bash');
const mockedResolveWindowsGitBash = windowsGitBashMock.resolveWindowsGitBash;

interface MockSpawnProcess {
  child: ReturnType<typeof spawn>;
  stdout: PassThrough;
  stderr: PassThrough;
}

function createMockChildProcess(pid: number = 4242): MockSpawnProcess {
  const child = new ChildProcess();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  Object.defineProperty(child, 'pid', {
    value: pid,
    writable: true,
  });
  Object.defineProperty(child, 'stdio', {
    value: [stdin, stdout, stderr, null, null],
  });
  return { child, stdout, stderr };
}

const mockedSpawn = jest.mocked(spawn);

function setPlatform(platform: NodeJS.Platform): () => void {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  );
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });

  return (): void => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  };
}

describe('script-runner', () => {
  let killSpy: jest.SpiedFunction<typeof process.kill>;
  let restoreDefaultPlatform: (() => void) | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    restoreDefaultPlatform = setPlatform('darwin');
    mockedFindExecutableOnPath.mockReturnValue(null);
    mockedResolveWindowsGitBash.mockReturnValue(null);
    killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
  });

  it('builds explicit mac shell commands with the selected runtime', () => {
    mockedFindExecutableOnPath.mockImplementation((name) =>
      name === 'zsh' ? '/bin/zsh' : null,
    );

    expect(buildShellScriptCommand('echo hello', { mac: 'zsh' })).toMatchObject(
      {
        command: '/bin/zsh',
        args: ['-li', '-c', 'echo hello'],
      },
    );
  });

  it('builds unattended mac shell commands without interactive mode', () => {
    mockedFindExecutableOnPath.mockImplementation((name) =>
      name === 'zsh' ? '/bin/zsh' : null,
    );

    expect(
      buildShellScriptCommand(
        'echo hello',
        { mac: 'zsh' },
        { interactive: false },
      ),
    ).toMatchObject({
      command: '/bin/zsh',
      args: ['-l', '-c', 'echo hello'],
    });
  });

  it('builds explicit Windows Git Bash commands', () => {
    restoreDefaultPlatform?.();
    restoreDefaultPlatform = setPlatform('win32');
    mockedResolveWindowsGitBash.mockReturnValue(
      'C:\\Program Files\\Git\\bin\\bash.exe',
    );

    expect(buildShellScriptCommand('echo hello', { windows: 'bash' })).toEqual({
      command: 'C:\\Program Files\\Git\\bin\\bash.exe',
      args: ['-lc', 'echo hello'],
    });
  });

  it('fails explicit Windows Git Bash commands when Git Bash is unavailable', () => {
    restoreDefaultPlatform?.();
    restoreDefaultPlatform = setPlatform('win32');

    expect(() =>
      buildShellScriptCommand('echo hello', { windows: 'bash' }),
    ).toThrow('Git Bash is not available on this Windows machine.');
  });

  it('uses cmd for explicit Windows cmd shell even when PowerShell exists', () => {
    restoreDefaultPlatform?.();
    restoreDefaultPlatform = setPlatform('win32');
    mockedFindExecutableOnPath.mockImplementation((name) =>
      name === 'pwsh.exe' ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : null,
    );

    const built = buildShellScriptCommand('echo hello', { windows: 'cmd' });
    try {
      expect(built.command).toBe(process.env.ComSpec || 'cmd.exe');
      expect(built.args[0]).toBe('/d');
      expect(built.args[1]).toBe('/s');
      expect(built.args[2]).toBe('/c');
    } finally {
      built.cleanup?.();
    }
  });

  it('uses PowerShell for explicit Windows powershell shell', () => {
    restoreDefaultPlatform?.();
    restoreDefaultPlatform = setPlatform('win32');
    mockedFindExecutableOnPath.mockImplementation((name) =>
      name === 'powershell.exe'
        ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
        : null,
    );

    const built = buildShellScriptCommand('Write-Output hello', {
      windows: 'powershell',
    });
    try {
      expect(built.command).toBe(
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      );
      expect(built.args).toContain('-File');
    } finally {
      built.cleanup?.();
    }
  });

  afterEach(() => {
    stopAllRunningShellScripts();
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    killSpy.mockRestore();
    restoreDefaultPlatform?.();
    restoreDefaultPlatform = undefined;
    mockPtyListeners.clear();
    mockPtySpawn.mockClear();
    mockPtySpawnWithEnvironment.mockClear();
    mockPtyKill.mockClear();
  });

  it('runs interactive scripts in a tracked PTY and preserves output and exit status', async () => {
    const onChunk = jest.fn<void, [string[]]>();
    const pending = runShellScript({
      script: 'read answer && echo "$answer"',
      cwd: '/tmp',
      interactive: true,
      onChunk,
      tracking: {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        scriptKey: 'project:wizard',
        invocation: 'manual-run',
        script: {
          scriptKey: 'project:wizard',
          scriptName: 'wizard',
          label: 'Wizard',
          command: 'read answer && echo "$answer"',
          lifecycle: 'custom',
          target: 'project',
          interactive: true,
        },
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(mockPtySpawn).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      80,
      24,
      undefined,
      expect.objectContaining({
        kind: 'script',
        title: 'Wizard',
        focusOnSpawn: true,
      }),
      '/tmp',
    );
    emitMockPtyEvent(IPC_CHANNELS.terminalOutput, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      terminalId: 'interactive-terminal-1',
      data: new TextEncoder().encode('Answer: yes\n'),
      seq: 12,
    });
    emitMockPtyEvent(IPC_CHANNELS.terminalExit, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      terminalId: 'interactive-terminal-1',
      kind: 'script',
      exitCode: 0,
      signal: null,
    });

    await expect(pending).resolves.toMatchObject({
      success: true,
      exitCode: 0,
      output: 'Answer: yes\n',
    });
    expect(onChunk).toHaveBeenCalledWith(['Answer: yes']);
  });

  it('drains every tracked setup and hook, including duplicate keys unseen by the renderer', async () => {
    const kinds: Array<'script' | 'hook'> = ['script', 'hook'];
    const runs = kinds.map((kind) => {
      const { child } = createMockChildProcess();
      mockedSpawn.mockReturnValueOnce(child);
      return runShellScript({
        script: 'sleep 60',
        cwd: '/tmp',
        tracking: {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          scriptKey: 'setup',
          kind,
        },
      });
    });
    killSpy.mockImplementation((_pid, signal) => {
      if (signal === 0)
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return true;
    });
    await drainWorktreeShellScripts('project-1', 'wt-1');
    for (const run of runs)
      await expect(run).resolves.toMatchObject({
        success: false,
        exitCode: null,
      });
  });

  it('uses the exact supplied environment for an interactive script PTY', async () => {
    const run = runShellScript({
      script: 'make dev',
      cwd: '/tmp/run-copy',
      interactive: true,
      env: { PATH: '/login/bin', DATABASE_URL: 'recipient-value' },
      tracking: {
        projectId: 'shared-container-viewer',
        worktreeId: 'container-1',
        scriptKey: 'project:launch',
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(mockPtySpawnWithEnvironment).toHaveBeenCalledWith(
      { PATH: '/login/bin', DATABASE_URL: 'recipient-value' },
      'shared-container-viewer',
      'container-1',
      80,
      24,
      undefined,
      expect.objectContaining({ kind: 'script' }),
      '/tmp/run-copy',
    );
    expect(mockPtySpawn).not.toHaveBeenCalled();

    emitMockPtyEvent(IPC_CHANNELS.terminalExit, {
      terminalId: 'interactive-terminal-1',
      exitCode: 0,
      signal: null,
    });
    await expect(run).resolves.toMatchObject({ success: true });
  });

  it('bounds newline-free interactive output while waiting for the next line', async () => {
    const maxOutputBytes = 256 * 1024;
    const emittedChunks: string[][] = [];
    const pending = runShellScript({
      script: 'render-progress',
      cwd: '/tmp',
      interactive: true,
      onChunk: (lines): void => {
        emittedChunks.push(lines);
      },
      tracking: {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        scriptKey: 'project:progress',
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    emitMockPtyEvent(IPC_CHANNELS.terminalOutput, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      terminalId: 'interactive-terminal-1',
      data: new TextEncoder().encode('x'.repeat(maxOutputBytes + 1024)),
      seq: 13,
    });
    emitMockPtyEvent(IPC_CHANNELS.terminalExit, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      terminalId: 'interactive-terminal-1',
      kind: 'script',
      exitCode: 0,
      signal: null,
    });

    const result = await pending;
    expect(Buffer.byteLength(result.output, 'utf8')).toBe(maxOutputBytes);
    const emittedPartialLine =
      emittedChunks[emittedChunks.length - 1]?.[0] ?? '';
    expect(Buffer.byteLength(emittedPartialLine, 'utf8')).toBeLessThanOrEqual(
      maxOutputBytes,
    );
  });

  it('rejects interactive scripts without worktree ownership before spawning a PTY', async () => {
    await expect(
      runShellScript({
        script: 'read answer',
        cwd: '/tmp',
        interactive: true,
      }),
    ).resolves.toMatchObject({
      success: false,
      exitCode: 1,
      timedOut: false,
    });

    expect(mockPtySpawn).not.toHaveBeenCalled();
  });

  it('wraps background-priority interactive scripts with macOS utility QoS', async () => {
    const pending = runShellScript({
      script: 'npm install',
      cwd: '/tmp',
      interactive: true,
      backgroundPriority: true,
      tracking: {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        scriptKey: 'project:setup',
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    const managedCommand = mockPtySpawn.mock.calls[0]?.[5];
    expect(managedCommand?.executable).toBe('/usr/sbin/taskpolicy');
    expect(managedCommand?.args).toEqual(
      expect.arrayContaining(['-c', 'utility']),
    );
    emitMockPtyEvent(IPC_CHANNELS.terminalExit, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      terminalId: 'interactive-terminal-1',
      kind: 'script',
      exitCode: 0,
      signal: null,
    });
    await pending;
  });

  it('lowers background-priority interactive PTYs after spawn off macOS', async () => {
    restoreDefaultPlatform?.();
    restoreDefaultPlatform = setPlatform('linux');
    const pending = runShellScript({
      script: 'npm install',
      cwd: '/tmp',
      interactive: true,
      backgroundPriority: true,
      tracking: {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        scriptKey: 'project:setup',
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(mockPtyLowerPriority).toHaveBeenCalledWith('interactive-terminal-1');
    emitMockPtyEvent(IPC_CHANNELS.terminalExit, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      terminalId: 'interactive-terminal-1',
      kind: 'script',
      exitCode: 0,
      signal: null,
    });
    await pending;
  });

  it('preserves failure status from an interactive PTY', async () => {
    const pending = runShellScript({
      script: 'exit 23',
      cwd: '/tmp',
      interactive: true,
      tracking: {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        scriptKey: 'project:setup',
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    emitMockPtyEvent(IPC_CHANNELS.terminalExit, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      terminalId: 'interactive-terminal-1',
      kind: 'script',
      exitCode: 23,
      signal: null,
    });

    await expect(pending).resolves.toMatchObject({
      success: false,
      exitCode: 23,
      timedOut: false,
    });
  });

  it('stops a tracked interactive lifecycle script through its PTY', async () => {
    const tracking = {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      scriptKey: 'project:launch',
    };
    const pending = runShellScript({
      script: 'read answer',
      cwd: '/tmp',
      interactive: true,
      tracking,
    });

    await Promise.resolve();
    await Promise.resolve();
    const stoppedPending = stopTrackedShellScript(tracking);
    expect(mockPtyKill).toHaveBeenCalledWith('interactive-terminal-1');
    emitMockPtyEvent(IPC_CHANNELS.terminalExit, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      terminalId: 'interactive-terminal-1',
      kind: 'script',
      exitCode: 0,
      signal: 'SIGTERM',
    });

    await expect(stoppedPending).resolves.toMatchObject({
      response: { success: false, exitCode: null, timedOut: false },
      tracking,
    });
    await expect(pending).resolves.toMatchObject({
      success: false,
      exitCode: null,
      timedOut: false,
    });
  });

  it('reports a user-closed interactive terminal as cancelled', async () => {
    const pending = runShellScript({
      script: 'read answer',
      cwd: '/tmp',
      interactive: true,
      tracking: {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        scriptKey: 'project:setup',
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    emitMockPtyEvent(IPC_CHANNELS.terminalExit, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      terminalId: 'interactive-terminal-1',
      kind: 'script',
      exitCode: 0,
      signal: TERMINAL_USER_CLOSE_SIGNAL,
    });

    await expect(pending).resolves.toMatchObject({
      success: false,
      exitCode: null,
      timedOut: false,
    });
  });

  it('does not stop a hook that shares a custom script key', async () => {
    mockPtySpawn
      .mockReturnValueOnce({
        id: 'hook-terminal',
        projectId: 'project-1',
        worktreeId: 'wt-1',
        shell: '/bin/zsh',
        shellBasename: 'zsh',
        cwd: '/tmp',
        createdAt: 1,
        kind: 'script',
        title: 'Hook',
      })
      .mockReturnValueOnce({
        id: 'script-terminal',
        projectId: 'project-1',
        worktreeId: 'wt-1',
        shell: '/bin/zsh',
        shellBasename: 'zsh',
        cwd: '/tmp',
        createdAt: 2,
        kind: 'script',
        title: 'Script',
      });
    const hookTracking = {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      scriptKey: 'project:pr:create',
      kind: 'hook' as const,
    };
    const scriptTracking = {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      scriptKey: 'project:pr:create',
    };
    const hookPending = runShellScript({
      script: 'read hook',
      cwd: '/tmp',
      interactive: true,
      tracking: hookTracking,
    });
    const scriptPending = runShellScript({
      script: 'read script',
      cwd: '/tmp',
      interactive: true,
      tracking: scriptTracking,
    });

    await Promise.resolve();
    await Promise.resolve();
    const stoppedPending = stopTrackedShellScript(scriptTracking);
    try {
      expect(mockPtyKill).toHaveBeenCalledTimes(1);
      expect(mockPtyKill).toHaveBeenCalledWith('script-terminal');
    } finally {
      emitMockPtyEvent(IPC_CHANNELS.terminalExit, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        terminalId: 'script-terminal',
        kind: 'script',
        exitCode: 0,
        signal: 'SIGTERM',
      });
      emitMockPtyEvent(IPC_CHANNELS.terminalExit, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        terminalId: 'hook-terminal',
        kind: 'script',
        exitCode: 0,
        signal: null,
      });
    }

    await expect(stoppedPending).resolves.toMatchObject({
      tracking: scriptTracking,
    });
    await expect(scriptPending).resolves.toMatchObject({ success: false });
    await expect(hookPending).resolves.toMatchObject({ success: true });
  });

  it('kills active detached script process groups when the app shuts down', async () => {
    const { child } = createMockChildProcess();
    mockedSpawn.mockReturnValue(child);

    const pending = runShellScript({
      script: 'sleep 30',
      cwd: '/tmp',
      timeoutSeconds: 300,
    });

    stopAllRunningShellScripts();

    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');

    jest.advanceTimersByTime(5_000);

    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');

    child.emit('close', 143);

    const result = await pending;
    expect(result.success).toBe(false);

    killSpy.mockClear();
    stopAllRunningShellScripts();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('launches automatic background scripts with inherited macOS scheduling policy', async () => {
    const { child } = createMockChildProcess();
    mockedSpawn.mockReturnValue(child);

    const pending = runShellScript({
      script: 'npm install',
      cwd: '/tmp',
      backgroundPriority: true,
    });

    expect(mockedSpawn).toHaveBeenCalledWith(
      '/usr/sbin/taskpolicy',
      ['-c', 'utility', expect.any(String), '-li', '-c', 'npm install'],
      expect.any(Object),
    );
    expect(mockSetPriority).not.toHaveBeenCalled();
    child.emit('close', 0);
    await expect(pending).resolves.toMatchObject({ success: true });
  });

  it('continues when the host rejects a background priority change', async () => {
    restoreDefaultPlatform?.();
    restoreDefaultPlatform = setPlatform('linux');
    const { child } = createMockChildProcess();
    mockedSpawn.mockReturnValue(child);
    mockSetPriority.mockImplementationOnce(() => {
      throw new Error('not permitted');
    });

    const pending = runShellScript({
      script: 'npm install',
      cwd: '/tmp',
      backgroundPriority: true,
    });

    expect(mockSetPriority).toHaveBeenCalledWith(
      4242,
      jest.requireActual<{
        constants: { priority: { PRIORITY_LOW: number } };
      }>('node:os').constants.priority.PRIORITY_LOW,
    );
    child.emit('close', 0);
    await expect(pending).resolves.toMatchObject({ success: true });
  });

  it('keeps user-started scripts at normal process priority', async () => {
    const { child } = createMockChildProcess();
    mockedSpawn.mockReturnValue(child);

    const pending = runShellScript({
      script: 'npm test',
      cwd: '/tmp',
    });

    expect(mockedSpawn).not.toHaveBeenCalledWith(
      '/usr/sbin/taskpolicy',
      expect.anything(),
      expect.anything(),
    );
    expect(mockSetPriority).not.toHaveBeenCalled();
    child.emit('close', 0);
    await expect(pending).resolves.toMatchObject({ success: true });
  });

  it('registers tracked shell scripts with the resource monitor', async () => {
    const { child } = createMockChildProcess(5151);
    mockedSpawn.mockReturnValue(child);

    const pending = runShellScript({
      script: 'npm run dev',
      cwd: '/tmp',
      tracking: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scriptKey: 'project:dev',
        invocation: 'manual-run',
        script: {
          scriptKey: 'project:dev',
          scriptName: 'dev',
          label: 'Dev',
          command: 'npm run dev',
          lifecycle: 'custom',
          target: 'project',
        },
      },
    });

    child.emit('close', 0);
    await pending;

    expect(mockRegisterResourceProcess).toHaveBeenCalledWith({
      id: 'script:project-1:worktree-1:project:dev:5151',
      groupId: 'scripts',
      kind: 'script',
      label: 'Dev',
      pid: 5151,
      processGroupId: 5151,
      metadata: {
        type: 'script',
        script: {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scriptKey: 'project:dev',
          scriptName: 'dev',
          scriptLabel: 'Dev',
          target: 'project',
          invocation: 'manual-run',
        },
      },
    });
    expect(mockResourceRegistrationUnregister).toHaveBeenCalledTimes(1);
  });

  it('does not trigger a timeout when timeoutSeconds is null', async () => {
    const { child } = createMockChildProcess();
    mockedSpawn.mockReturnValue(child);

    const pending = runShellScript({
      script: 'long-running-server',
      cwd: '/tmp',
      timeoutSeconds: null,
    });

    // Advance well past a typical timeout window (e.g. 10 minutes)
    jest.advanceTimersByTime(10 * 60_000);

    // No SIGTERM or SIGKILL should have been sent from a timeout
    expect(killSpy).not.toHaveBeenCalled();

    // Let the process finish naturally
    child.emit('close', 0);
    const result = await pending;

    expect(result.success).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it('clamps oversized timeoutSeconds instead of overflowing to an immediate timeout', async () => {
    const { child } = createMockChildProcess();
    mockedSpawn.mockReturnValue(child);

    const pending = runShellScript({
      script: 'long-running-check',
      cwd: '/tmp',
      timeoutSeconds: MAX_SCRIPT_TIMEOUT_SECONDS + 1,
    });

    jest.advanceTimersByTime(1);
    expect(killSpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(MAX_SCRIPT_TIMEOUT_SECONDS * 1000 - 1);
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');

    child.emit('close', null);
    const result = await pending;
    expect(result.timedOut).toBe(true);
  });

  it('batches multiple data events into a single onChunk call', async () => {
    const { child, stdout } = createMockChildProcess();
    mockedSpawn.mockReturnValue(child);
    const onChunk = jest.fn<void, [string[]]>();

    const pending = runShellScript({
      script: 'echo hello',
      cwd: '/tmp',
      onChunk,
    });

    // Emit two data events rapidly — both within the flush interval.
    stdout.write(Buffer.from('line1\nline2\n'));
    stdout.write(Buffer.from('line3\nline4\n'));

    // onChunk should NOT have been called yet (waiting for timer).
    expect(onChunk).not.toHaveBeenCalled();

    // Advance past the flush interval (250ms) + setImmediate.
    jest.advanceTimersByTime(300);
    // setImmediate is scheduled by the timer callback; run it.
    await jest.advanceTimersToNextTimerAsync();

    // Both data events should be flushed in a single onChunk call.
    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith(['line1', 'line2', 'line3', 'line4']);

    child.emit('close', 0);
    await pending;
  });

  it('flushes immediately when the line threshold is exceeded', async () => {
    const { child, stdout } = createMockChildProcess();
    mockedSpawn.mockReturnValue(child);
    const onChunk = jest.fn<void, [string[]]>();

    const pending = runShellScript({
      script: 'big-output',
      cwd: '/tmp',
      onChunk,
    });

    // Generate enough lines to exceed EMIT_FLUSH_LINE_THRESHOLD (120).
    const bigOutput = Array.from({ length: 130 }, (_, i) => `line${i}`)
      .join('\n')
      .concat('\n');
    stdout.write(Buffer.from(bigOutput));

    // Should flush immediately without waiting for the timer.
    expect(onChunk).toHaveBeenCalledTimes(1);
    const firstCall = onChunk.mock.calls[0];
    expect(firstCall?.[0]).toHaveLength(130);

    child.emit('close', 0);
    await pending;
  });

  it('flushes remaining buffered lines on close', async () => {
    const { child, stdout } = createMockChildProcess();
    mockedSpawn.mockReturnValue(child);
    const onChunk = jest.fn<void, [string[]]>();

    const pending = runShellScript({
      script: 'echo partial',
      cwd: '/tmp',
      onChunk,
    });

    // Emit data without a trailing newline — stays in lineBuf.
    stdout.write(Buffer.from('complete\npartial'));
    expect(onChunk).not.toHaveBeenCalled();

    // Close the process — should flush both the pending full line
    // and the incomplete line from lineBuf.
    child.emit('close', 0);

    // The flush on close is synchronous.
    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith(['complete', 'partial']);

    await pending;
  });

  it('emits the truncation marker through onChunk before completing', async () => {
    const { child, stdout } = createMockChildProcess();
    mockedSpawn.mockReturnValue(child);
    const onChunk = jest.fn<void, [string[]]>();

    const pending = runShellScript({
      script: 'huge-output',
      cwd: '/tmp',
      onChunk,
    });

    stdout.write(Buffer.from('a'.repeat(300 * 1024)));
    child.emit('close', 0);

    await pending;

    expect(onChunk).toHaveBeenCalledWith(['[output truncated]']);
  });

  it('emits final error lines through onChunk before completing', async () => {
    const { child } = createMockChildProcess();
    mockedSpawn.mockReturnValue(child);
    const onChunk = jest.fn<void, [string[]]>();

    const pending = runShellScript({
      script: 'bad-command',
      cwd: '/tmp',
      onChunk,
    });

    child.emit('error', new Error('spawn failed'));

    const result = await pending;

    expect(onChunk).toHaveBeenCalledWith(['Error: spawn failed']);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Error: spawn failed');
  });

  it('runs Windows PowerShell lifecycle scripts from a temp file', async () => {
    const restorePlatform = setPlatform('win32');
    mockedFindExecutableOnPath.mockImplementation((name) =>
      name === 'pwsh.exe' ? 'C:\\Program Files\\PowerShell\\pwsh.exe' : null,
    );
    const { child } = createMockChildProcess();
    mockedSpawn.mockReturnValue(child);

    try {
      const pending = runShellScript({
        script: 'Write-Output hello',
        cwd: 'C:\\repo',
      });
      const spawnCall = mockedSpawn.mock.calls[0];
      const args = spawnCall?.[1] as string[];
      const scriptPath = args[5];

      expect(spawnCall?.[0]).toBe('C:\\Program Files\\PowerShell\\pwsh.exe');
      expect(spawnCall?.[2]).toMatchObject({
        detached: false,
        windowsHide: true,
      });
      expect(args).toEqual([
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
      ]);
      expect(scriptPath.endsWith('canopy-script.ps1')).toBe(true);
      expect(existsSync(scriptPath)).toBe(true);
      const scriptContent = readFileSync(scriptPath, 'utf8');
      expect(scriptContent).toContain("$ErrorActionPreference = 'Stop'");
      expect(scriptContent).toContain('Write-Output hello');
      expect(scriptContent).toContain(
        'if ($canopyLastExitCode -is [int] -and $canopyLastExitCode -ne 0) { exit $canopyLastExitCode }',
      );
      expect(
        scriptContent.match(
          /if \(\$canopyLastExitCode -is \[int\] -and \$canopyLastExitCode -ne 0\) \{ exit \$canopyLastExitCode \}/g,
        ),
      ).toHaveLength(1);
      expect(scriptContent).toContain('exit 0');

      child.emit('close', 0);
      await pending;

      expect(existsSync(scriptPath)).toBe(false);
    } finally {
      restorePlatform();
    }
  });

  it('runs Windows cmd lifecycle scripts from a temp file', async () => {
    const restorePlatform = setPlatform('win32');
    const originalComSpec = process.env.ComSpec;
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
    const { child } = createMockChildProcess();
    mockedSpawn.mockReturnValue(child);

    try {
      const pending = runShellScript({
        script: 'echo hello',
        cwd: 'C:\\repo',
      });
      const spawnCall = mockedSpawn.mock.calls[0];
      const args = spawnCall?.[1] as string[];
      const scriptCommand = args[3];
      const scriptPath = scriptCommand.startsWith('"')
        ? scriptCommand.slice(1, -1).replace(/""/g, '"')
        : scriptCommand;

      expect(spawnCall?.[0]).toBe('C:\\Windows\\System32\\cmd.exe');
      expect(spawnCall?.[2]).toMatchObject({
        detached: false,
        windowsHide: true,
      });
      expect(args).toEqual(['/d', '/s', '/c', scriptCommand]);
      expect(scriptPath.endsWith('canopy-script.cmd')).toBe(true);
      expect(existsSync(scriptPath)).toBe(true);

      child.emit('close', 0);
      await pending;

      expect(existsSync(scriptPath)).toBe(false);
    } finally {
      restorePlatform();
      if (originalComSpec === undefined) {
        delete process.env.ComSpec;
      } else {
        process.env.ComSpec = originalComSpec;
      }
    }
  });

  it('cleans Windows temp script files after cancellation', async () => {
    const restorePlatform = setPlatform('win32');
    mockedFindExecutableOnPath.mockReturnValue('C:\\pwsh.exe');
    const { child } = createMockChildProcess();
    mockedSpawn.mockReturnValue(child);
    const controller = new AbortController();

    try {
      const pending = runShellScript({
        script: 'Start-Sleep 30',
        cwd: 'C:\\repo',
        signal: controller.signal,
      });
      const args = mockedSpawn.mock.calls[0]?.[1] as string[];
      const scriptPath = args[5];
      expect(existsSync(scriptPath)).toBe(true);

      controller.abort();
      child.emit('close', 143);
      await pending;

      expect(existsSync(scriptPath)).toBe(false);
    } finally {
      restorePlatform();
    }
  });

  it('cleans Windows temp script files when process start throws', async () => {
    const restorePlatform = setPlatform('win32');
    mockedFindExecutableOnPath.mockReturnValue('C:\\pwsh.exe');
    mockedSpawn.mockImplementationOnce(() => {
      throw new Error('spawn sync failed');
    });

    try {
      const result = await runShellScript({
        script: 'Write-Output hello',
        cwd: 'C:\\repo',
      });
      const args = mockedSpawn.mock.calls[0]?.[1] as string[];
      const scriptPath = args[5];

      expect(result.success).toBe(false);
      expect(result.output).toContain('spawn sync failed');
      expect(existsSync(scriptPath)).toBe(false);
    } finally {
      restorePlatform();
    }
  });

  it('keeps macOS and Linux lifecycle scripts on the login shell command path', async () => {
    const restorePlatform = setPlatform('darwin');
    const originalShell = process.env.SHELL;
    process.env.SHELL = '/bin/zsh';
    const { child } = createMockChildProcess();
    mockedSpawn.mockReturnValue(child);

    try {
      const pending = runShellScript({
        script: 'echo hello',
        cwd: '/tmp',
      });

      expect(mockedSpawn).toHaveBeenCalledWith(
        '/bin/zsh',
        ['-li', '-c', 'echo hello'],
        expect.objectContaining({ cwd: '/tmp' }),
      );

      child.emit('close', 0);
      await pending;
    } finally {
      restorePlatform();
      if (originalShell === undefined) {
        delete process.env.SHELL;
      } else {
        process.env.SHELL = originalShell;
      }
    }
  });

  it('stops only the tracked script requested by worktree and key', async () => {
    const setupChild = createMockChildProcess(1111);
    const runChild = createMockChildProcess(2222);
    mockedSpawn
      .mockReturnValueOnce(setupChild.child)
      .mockReturnValueOnce(runChild.child);

    const setupPending = runShellScript({
      script: 'sleep 30',
      cwd: '/tmp/setup',
      timeoutSeconds: 300,
      tracking: {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        scriptKey: 'setup',
        logRef: {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          script: {
            scriptKey: 'project:setup',
            scriptName: 'setup',
            label: 'Setup',
            command: 'npm install',
            lifecycle: 'setup',
            target: 'project',
          },
          runId: 'run-1',
        },
      },
    });
    const runPending = runShellScript({
      script: 'sleep 30',
      cwd: '/tmp/run',
      timeoutSeconds: 300,
      tracking: {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        scriptKey: 'run',
      },
    });

    const stopPromise = stopTrackedShellScript({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      scriptKey: 'setup',
    });

    expect(killSpy).toHaveBeenCalledWith(-1111, 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith(-2222, 'SIGTERM');

    setupChild.child.emit('close', 143);
    const stopped = await stopPromise;

    runChild.child.emit('close', 0);
    const [setupResult, runResult] = await Promise.all([
      setupPending,
      runPending,
    ]);

    expect(stopped?.tracking?.logRef?.runId).toBe('run-1');
    expect(stopped?.response.exitCode).toBeNull();
    expect(setupResult.success).toBe(false);
    expect(runResult.success).toBe(true);
  });

  it('stops only the selected run among concurrent instances of the same script', async (): Promise<void> => {
    const first = createMockChildProcess(1111);
    const second = createMockChildProcess(2222);
    mockedSpawn
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child);
    const tracking = {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      scriptKey: 'project:setup',
      logRef: {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        runId: 'run-one',
        script: {
          scriptKey: 'project:setup',
          scriptName: 'setup',
          label: 'Setup',
          command: 'sleep 30',
          lifecycle: 'setup',
          target: 'project',
        },
      },
    } satisfies ScriptTrackingInfo;
    const firstPending = runShellScript({
      script: 'sleep 30',
      cwd: '/tmp',
      tracking,
    });
    const secondPending = runShellScript({
      script: 'sleep 30',
      cwd: '/tmp',
      tracking: {
        ...tracking,
        logRef: { ...tracking.logRef, runId: 'run-two' },
      },
    });
    const stopPending = stopTrackedShellScriptRun(tracking);
    try {
      expect(killSpy).toHaveBeenCalledWith(-1111, 'SIGTERM');
      expect(killSpy).not.toHaveBeenCalledWith(-2222, 'SIGTERM');
    } finally {
      first.child.emit('close', 143);
      second.child.emit('close', 0);
      await Promise.all([stopPending, firstPending, secondPending]);
    }
  });

  // A process group that received SIGKILL is gone; every other one stays alive.
  function trackKilledProcessGroups(): Set<number> {
    const killed = new Set<number>();
    killSpy.mockImplementation((pid, signal) => {
      if (signal === 'SIGKILL') killed.add(Math.abs(pid));
      if (signal === 0 && killed.has(Math.abs(pid)))
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return true;
    });
    return killed;
  }

  it.each([
    ['a manual run started first', ['manual-run', 'automatic-setup']],
    ['the setup run started first', ['automatic-setup', 'manual-run']],
  ] as const)(
    'drains only the matching run of a worktree when %s under the same script key',
    async (_order, invocations): Promise<void> => {
      const children = [
        createMockChildProcess(1111),
        createMockChildProcess(2222),
      ];
      mockedSpawn
        .mockReturnValueOnce(children[0].child)
        .mockReturnValueOnce(children[1].child);
      const pending = invocations.map((invocation) =>
        runShellScript({
          script: 'sleep 30',
          cwd: '/tmp',
          tracking: {
            projectId: 'project-1',
            worktreeId: 'wt-1',
            scriptKey: 'project:setup',
            runId: `run-${invocation}`,
            invocation,
          },
        }),
      );
      const setupIndex = invocations.indexOf('automatic-setup');
      const manualIndex = invocations.indexOf('manual-run');
      const killed = trackKilledProcessGroups();

      const drained = await drainTrackedShellScriptRunsForWorktree(
        { projectId: 'project-1', worktreeId: 'wt-1' },
        ({ invocation }) => invocation === 'automatic-setup',
      );
      children[manualIndex].child.emit('close', 0);
      const results = await Promise.all(pending);

      expect([...killed]).toEqual([setupIndex === 0 ? 1111 : 2222]);
      expect(drained.map(({ tracking }) => tracking?.runId)).toEqual([
        'run-automatic-setup',
      ]);
      expect(results[setupIndex]).toMatchObject({
        success: false,
        exitCode: null,
      });
      expect(results[manualIndex].success).toBe(true);
    },
  );

  it('kills the whole process group of a matching run, so a child that outlives its shell is not left running', async (): Promise<void> => {
    const { child } = createMockChildProcess(1111);
    mockedSpawn.mockReturnValueOnce(child);
    const pending = runShellScript({
      script: 'trap-resistant-child & wait',
      cwd: '/tmp',
      tracking: {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        scriptKey: 'project:setup',
        invocation: 'automatic-setup',
      },
    });
    let groupAlive = true;
    killSpy.mockImplementation((pid, signal) => {
      if (signal === 'SIGKILL' && pid === -1111) groupAlive = false;
      if (signal === 0 && !groupAlive)
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      // The shell exits on SIGTERM and its run is no longer tracked, while
      // the child ignores the signal and stays alive in the process group.
      if (signal === 'SIGTERM')
        void Promise.resolve().then(() => child.emit('close', 143));
      return true;
    });

    const drained = await drainTrackedShellScriptRunsForWorktree(
      { projectId: 'project-1', worktreeId: 'wt-1' },
      () => true,
    );
    await pending;

    expect(groupAlive).toBe(false);
    expect(drained.map(({ response }) => response.exitCode)).toEqual([null]);
  });

  it('leaves hooks and other worktrees running when draining the matching runs of a worktree', async (): Promise<void> => {
    const children = [
      createMockChildProcess(1111),
      createMockChildProcess(2222),
      createMockChildProcess(3333),
    ];
    children.forEach(({ child }) => mockedSpawn.mockReturnValueOnce(child));
    const pending = [
      { worktreeId: 'wt-1' },
      { worktreeId: 'wt-1', kind: 'hook' as const },
      { worktreeId: 'wt-2' },
    ].map((tracking) =>
      runShellScript({
        script: 'sleep 30',
        cwd: '/tmp',
        tracking: {
          projectId: 'project-1',
          scriptKey: 'project:setup',
          ...tracking,
        },
      }),
    );
    const killed = trackKilledProcessGroups();

    await drainTrackedShellScriptRunsForWorktree(
      { projectId: 'project-1', worktreeId: 'wt-1' },
      () => true,
    );
    children[1].child.emit('close', 0);
    children[2].child.emit('close', 0);
    await Promise.all(pending);

    expect([...killed]).toEqual([1111]);
  });

  it('resolves a stopped tracked script after force-kill even when close never fires', async () => {
    const { child } = createMockChildProcess(3333);
    mockedSpawn.mockReturnValue(child);

    const pending = runShellScript({
      script: 'long-lived-detached-child',
      cwd: '/tmp/setup',
      timeoutSeconds: 300,
      tracking: {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        scriptKey: 'project:setup',
      },
    });

    const stopPromise = stopTrackedShellScript({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      scriptKey: 'project:setup',
    });

    expect(killSpy).toHaveBeenCalledWith(-3333, 'SIGTERM');

    jest.advanceTimersByTime(5_000);
    expect(killSpy).toHaveBeenCalledWith(-3333, 'SIGKILL');

    const stopped = await stopPromise;
    const result = await pending;

    expect(stopped?.response).toMatchObject({
      success: false,
      exitCode: null,
      timedOut: false,
    });
    expect(result).toMatchObject({
      success: false,
      exitCode: null,
      timedOut: false,
    });

    child.emit('close', 0);
    expect(await pending).toBe(result);
  });
});
