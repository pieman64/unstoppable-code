import { EventEmitter } from 'node:events';
import type * as NodeFs from 'node:fs';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { basename, delimiter } from 'node:path';
import { join } from 'node:path';
import * as childProcess from 'node:child_process';
import type { IPty, IPtyForkOptions, IWindowsPtyForkOptions } from 'node-pty';
import {
  IPC_CHANNELS,
  TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
  TERMINAL_WORKTREE_CLEANUP_SIGNAL,
  type ManagedTerminalCommand,
  type PersistedTerminalEntry,
  type TerminalExitEvent,
  type TerminalOutputEvent,
  type TerminalRunningChangedEvent,
  type TerminalSession,
} from '@canopy/desktop-shared/types';
import {
  listAvailableTerminalProfiles,
  prewarmLinuxTerminalShell,
  PtyManager,
  resetLinuxTerminalShellLookupForTests,
  TERMINAL_FLUSH_THRESHOLD_BYTES,
  TERMINAL_MAX_UNFLUSHED_BYTES,
  TERMINAL_REPLAY_BUFFER_MAX_BYTES,
  TERMINAL_USER_INTERRUPT_SUPPRESS_MS,
} from '../terminal/pty-manager';

jest.mock('node:os', () => {
  const actual = jest.requireActual<Record<string, unknown>>('node:os');
  return {
    ...actual,
    setPriority: jest.fn(),
  };
});

const mockUnregisterResource = jest.fn();
const mockRegisterResource = jest.fn(() => ({
  update: jest.fn(),
  unregister: mockUnregisterResource,
}));

jest.mock('../resource-monitor', () => ({
  getResourceMonitorService: (): {
    registerProcess: typeof mockRegisterResource;
  } => ({ registerProcess: mockRegisterResource }),
}));

type VirtualFsEntries = Record<string, 'exec' | 'plain' | 'dir'>;

interface LinuxVirtualFs {
  entries: VirtualFsEntries | null;
}

// Linux shell validation reads fixed system paths (`/bin/bash`, …). A virtual
// table stands in for them so the cases do not depend on the macOS host.
jest.mock('node:fs', () => {
  const actual = jest.requireActual<typeof NodeFs>('node:fs');
  const virtualFs: LinuxVirtualFs = { entries: null };
  const virtualPrefixes = ['/bin/', '/usr/', '/opt/', '/sbin/', '/home/'];
  const lookup = (
    file: unknown,
  ): 'exec' | 'plain' | 'dir' | null | undefined => {
    if (
      virtualFs.entries === null ||
      typeof file !== 'string' ||
      !virtualPrefixes.some((prefix) => file.startsWith(prefix))
    ) {
      return undefined;
    }
    return virtualFs.entries[file] ?? null;
  };
  const errno = (code: string, file: string): Error =>
    Object.assign(new Error(`${code}: ${file}`), { code });
  return {
    ...actual,
    __virtualFs: virtualFs,
    statSync: (file: unknown, ...rest: unknown[]): unknown => {
      const kind = lookup(file);
      if (kind === undefined) {
        return Reflect.apply(actual.statSync, actual, [file, ...rest]);
      }
      if (kind === null) throw errno('ENOENT', String(file));
      return { isFile: (): boolean => kind !== 'dir' };
    },
    accessSync: (file: unknown, ...rest: unknown[]): unknown => {
      const kind = lookup(file);
      if (kind === undefined) {
        return Reflect.apply(actual.accessSync, actual, [file, ...rest]);
      }
      if (kind === null) throw errno('ENOENT', String(file));
      if (kind !== 'exec') throw errno('EACCES', String(file));
      return undefined;
    },
    realpathSync: (file: unknown, ...rest: unknown[]): unknown =>
      lookup(file) === undefined
        ? Reflect.apply(actual.realpathSync, actual, [file, ...rest])
        : file,
  };
});

const virtualFs = jest.requireMock<{ __virtualFs: LinuxVirtualFs }>(
  'node:fs',
).__virtualFs;

const mockSetPriority = jest.requireMock<{
  setPriority: jest.Mock;
}>('node:os').setPriority;

jest.mock('node:child_process', () => {
  const actual: typeof childProcess = jest.requireActual('node:child_process');
  return {
    ...actual,
    execFile: jest.fn(),
    spawn: jest.fn(),
    spawnSync: jest.fn(),
  };
});

type PtySpawn = (
  file: string,
  args: string[] | string,
  options: IPtyForkOptions | IWindowsPtyForkOptions,
) => IPty;

type TerminalEvent =
  | TerminalSession
  | TerminalOutputEvent
  | TerminalExitEvent
  | TerminalRunningChangedEvent;

interface SpawnCall {
  file: string;
  args: string[] | string;
  options: Parameters<PtySpawn>[2];
}

interface EventRecord {
  channel: string;
  payload: TerminalEvent;
}

interface EnhancedEnvOptions {
  environment?: unknown;
}

interface BuildWorktreeEnvCall {
  projectId: string;
  worktreeId: string;
  env?: NodeJS.ProcessEnv;
  options?: unknown;
}

interface MockPersistenceStore {
  registerLiveSession: jest.Mock<void, [TerminalSession]>;
  appendTerminalOutput: jest.Mock<void, [string, string, string, Buffer]>;
  markTerminalExited: jest.Mock<
    void,
    [string, string, string, number | null, string | null]
  >;
  getPersistedTerminalEntry: jest.Mock<PersistedTerminalEntry | null, [string]>;
}

class MockPty implements IPty {
  public readonly pid: number;

  public readonly cols = 80;

  public readonly rows = 24;

  public process = 'zsh';

  public handleFlowControl = false;

  public readonly writes: string[] = [];

  public readonly _agent = { inSocket: new EventEmitter() };

  public readonly resizes: Array<{ cols: number; rows: number }> = [];

  public readonly killSignals: Array<string | undefined> = [];

  public dataDisposeCount = 0;

  public exitDisposeCount = 0;

  public destroyCount = 0;

  private dataListener: ((data: string) => void) | null = null;

  private exitListener:
    | ((event: { exitCode: number; signal?: number }) => void)
    | null = null;

  public constructor(pid: number) {
    this.pid = pid;
  }

  public readonly onData = (
    listener: (data: string) => void,
  ): { dispose(): void } => {
    this.dataListener = listener;
    return {
      dispose: (): void => {
        this.dataDisposeCount += 1;
        this.dataListener = null;
      },
    };
  };

  public readonly onExit = (
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): { dispose(): void } => {
    this.exitListener = listener;
    return {
      dispose: (): void => {
        this.exitDisposeCount += 1;
        this.exitListener = null;
      },
    };
  };

  public resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  public clear(): void {}

  public write(data: string | Buffer): void {
    this.writes.push(typeof data === 'string' ? data : data.toString('utf8'));
  }

  public kill(signal?: string): void {
    this.killSignals.push(signal);
    void signal;
    this.emitExit(0);
  }

  public destroy(): void {
    this.destroyCount += 1;
  }

  public pause(): void {}

  public resume(): void {}

  public emitData(data: string): void {
    this.dataListener?.(data);
  }

  public emitExit(exitCode: number, signal?: number): void {
    this.exitListener?.({ exitCode, signal });
  }
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function outputText(event: TerminalOutputEvent): string {
  return Buffer.from(event.data).toString('utf8');
}

function runningEvent(
  event: TerminalRunningChangedEvent | TerminalExitEvent | TerminalOutputEvent,
): event is TerminalRunningChangedEvent {
  return 'running' in event;
}

function outputEvent(
  event: TerminalRunningChangedEvent | TerminalExitEvent | TerminalOutputEvent,
): event is TerminalOutputEvent {
  return 'data' in event;
}

function expectedShellBasename(): string {
  const shell = process.env.SHELL?.trim();
  if (process.platform === 'linux' && process.arch === 'x64') {
    const name = shell ? basename(shell) : '';
    return ['bash', 'zsh', 'fish'].includes(name) ? name : 'bash';
  }
  return basename(
    process.env.SHELL ??
      (process.platform === 'linux' ? '/bin/bash' : '/bin/zsh'),
  );
}

function createMissingProcessError(): Error {
  const error = new Error('process not found');
  Reflect.set(error, 'code', 'ESRCH');
  return error;
}

function createTaskkill(): EventEmitter {
  const taskkill = new EventEmitter();
  jest
    .mocked(childProcess.spawn)
    .mockReturnValue(taskkill as unknown as childProcess.ChildProcess);
  return taskkill;
}

type MockExecFileCallback = (
  error: childProcess.ExecFileException | null,
  stdout: string,
  stderr: string,
) => void;

function findExecFileCallback(args: unknown[]): MockExecFileCallback | null {
  return (
    args.find(
      (arg): arg is MockExecFileCallback => typeof arg === 'function',
    ) ?? null
  );
}

function setArch(arch: NodeJS.Architecture): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'arch');
  Object.defineProperty(process, 'arch', { configurable: true, value: arch });
  return (): void => {
    if (original) Object.defineProperty(process, 'arch', original);
  };
}

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

describe('PtyManager', () => {
  it('contains a Windows input pipe EOF, exits only that terminal, and permits restart', () => {
    const restore = setPlatform('win32');
    createTaskkill();
    try {
      const { manager, ptys, events, persistenceStore } = createManager();
      const first = manager.spawn('project', 'worktree', 80, 24);
      const second = manager.spawn('project', 'worktree', 80, 24);
      const error = Object.assign(new Error('write EOF'), {
        code: 'EOF',
        syscall: 'write',
      });
      expect(() => ptys[0]._agent.inSocket.emit('error', error)).not.toThrow();
      expect(persistenceStore.markTerminalExited).toHaveBeenCalledWith(
        'project',
        'worktree',
        first.id,
        null,
        'pipe-error',
      );
      manager.write(first.id, 'ignored');
      manager.write(second.id, 'still live');
      expect(ptys[0].writes).toEqual([]);
      expect(ptys[1].writes).toEqual(['still live']);
      expect(
        events.filter((entry) => entry.channel === IPC_CHANNELS.terminalExit),
      ).toHaveLength(1);
      expect(() => ptys[0]._agent.inSocket.emit('error', error)).not.toThrow();
      manager.killAll();
    } finally {
      restore();
    }
  });

  function createManager(options?: {
    resolveWorktreeCwdFn?: (
      projectId: string,
      worktreeId: string,
      selectedRepoId?: string,
    ) => string;
    getEnhancedEnvFn?: () => Record<string, string | undefined>;
    buildWorktreeDataEnvFn?: (
      projectId: string,
      worktreeId: string,
      env?: NodeJS.ProcessEnv,
      buildOptions?: unknown,
    ) => NodeJS.ProcessEnv;
    now?: () => number;
    maxLiveTerminals?: number;
    killExitGraceMs?: number;
    ptySpawnFailure?: Error;
  }): {
    manager: PtyManager;
    ptys: MockPty[];
    spawnCalls: SpawnCall[];
    buildWorktreeEnvCalls: BuildWorktreeEnvCall[];
    syncLifecycle: jest.Mock;
    events: EventRecord[];
    persistenceStore: MockPersistenceStore;
  } {
    const ptys: MockPty[] = [];
    const spawnCalls: SpawnCall[] = [];
    const buildWorktreeEnvCalls: BuildWorktreeEnvCall[] = [];
    const syncLifecycle = jest.fn();
    const ptySpawnFailure = options?.ptySpawnFailure;
    const events: EventRecord[] = [];
    const now = options?.now ?? ((): number => 10_000);
    let nextTerminalId = 1;

    const ptySpawn: PtySpawn = (
      file: string,
      args: string[] | string,
      options: Parameters<PtySpawn>[2],
    ) => {
      if (ptySpawnFailure) throw ptySpawnFailure;
      const pty = new MockPty(ptys.length + 1);
      ptys.push(pty);
      spawnCalls.push({ file, args, options });
      return pty;
    };

    const persistenceStore: MockPersistenceStore = {
      registerLiveSession: jest.fn<void, [TerminalSession]>(),
      appendTerminalOutput: jest.fn<void, [string, string, string, Buffer]>(),
      markTerminalExited: jest.fn<
        void,
        [string, string, string, number | null, string | null]
      >(),
      getPersistedTerminalEntry: jest.fn<
        PersistedTerminalEntry | null,
        [string]
      >((): PersistedTerminalEntry | null => null),
    };

    const manager = new PtyManager({
      createTerminalId: (): string => `term-${nextTerminalId++}`,
      now,
      ptySpawn,
      resolveWorktreeCwdFn:
        options?.resolveWorktreeCwdFn ??
        ((
          projectId: string,
          worktreeId: string,
          selectedRepoId?: string,
        ): string => {
          const basePath = `/worktrees/${projectId}/${worktreeId}`;
          return selectedRepoId
            ? `${basePath}/repos/${selectedRepoId}`
            : basePath;
        }),
      buildWorktreeDataEnvFn:
        options?.buildWorktreeDataEnvFn ??
        ((
          projectId: string,
          worktreeId: string,
          env?: NodeJS.ProcessEnv,
          buildOptions?: unknown,
        ): NodeJS.ProcessEnv => {
          buildWorktreeEnvCalls.push({
            projectId,
            worktreeId,
            env,
            options: buildOptions,
          });
          return {
            ...env,
            CANOPY_WORKSPACE_ID: projectId,
            CANOPY_WORKTREE_NAME: worktreeId,
          };
        }),
      getEnhancedEnvFn:
        options?.getEnhancedEnvFn ??
        ((): Record<string, string | undefined> => ({
          PATH: '/mock/bin:/usr/bin',
        })),
      runningDetector: {
        syncLifecycle,
      },
      persistenceStore,
      ...(options?.maxLiveTerminals !== undefined
        ? { maxLiveTerminals: options.maxLiveTerminals }
        : {}),
      ...(options?.killExitGraceMs !== undefined
        ? { killExitGraceMs: options.killExitGraceMs }
        : {}),
    });
    manager.setEventSender((channel, payload): void => {
      events.push({ channel, payload });
    });

    return {
      manager,
      ptys,
      spawnCalls,
      buildWorktreeEnvCalls,
      syncLifecycle,
      events,
      persistenceStore,
    };
  }

  let processKillSpy: jest.SpiedFunction<typeof process.kill>;
  const mockedExecFile = jest.mocked(childProcess.execFile);
  const mockedSpawn = jest.mocked(childProcess.spawn);
  const mockedSpawnSync = jest.mocked(childProcess.spawnSync);

  function mockWindowsForegroundProbe(stdout: string): void {
    mockedExecFile.mockImplementation((...args) => {
      const callback = findExecFileCallback(args);
      callback?.(null, stdout, '');
      return undefined;
    });
  }

  beforeEach(() => {
    mockSetPriority.mockReset();
    processKillSpy = jest
      .spyOn(process, 'kill')
      .mockImplementation((): never => {
        throw createMissingProcessError();
      });
    mockedExecFile.mockReset();
    mockedSpawn.mockReset();
    mockedSpawnSync.mockReset();
  });

  afterEach(() => {
    processKillSpy.mockRestore();
  });

  it('spawns a PTY with worktree cwd/env and supports write/kill lifecycle', () => {
    const {
      manager,
      ptys,
      spawnCalls,
      syncLifecycle,
      events,
      persistenceStore,
    } = createManager();

    const session = manager.spawn('project-1', 'wt-1', 120, 30);

    expect(session).toMatchObject({
      id: 'term-1',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      shellBasename: expectedShellBasename(),
      cwd: '/worktrees/project-1/wt-1',
      createdAt: 10_000,
    });
    expect(syncLifecycle).toHaveBeenCalledTimes(1);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].file).toBe(session.shell);
    expect(spawnCalls[0].args).toEqual(['-l']);
    expect(spawnCalls[0].options.cols).toBe(120);
    expect(spawnCalls[0].options.rows).toBe(30);
    expect(spawnCalls[0].options.cwd).toBe('/worktrees/project-1/wt-1');
    expect(spawnCalls[0].options.env).toMatchObject({
      PATH: '/mock/bin:/usr/bin',
      CANOPY_WORKSPACE_ID: 'project-1',
      CANOPY_WORKTREE_NAME: 'wt-1',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    });
    expect(persistenceStore.registerLiveSession).toHaveBeenCalledWith(session);

    manager.write(session.id, 'echo hello');
    expect(ptys[0].writes).toEqual(['echo hello']);

    manager.kill(session.id);
    expect(events).toContainEqual({
      channel: IPC_CHANNELS.terminalExit,
      payload: {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        terminalId: session.id,
        kind: 'shell',
        exitCode: 0,
        signal: null,
      },
    });
    expect(persistenceStore.markTerminalExited).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      session.id,
      0,
      null,
    );
  });

  it('owns the shell lifecycle for an initial command and reruns it after restore', async () => {
    const { manager, ptys, events, persistenceStore } = createManager();
    const command = "printf 'PRESET_OUTPUT_ONLY\\n'";
    const session = manager.spawn(
      'project-1',
      'wt-1',
      80,
      24,
      undefined,
      undefined,
      undefined,
      'default',
      command,
    );
    expect(session.initialCommand).toBe(command);

    ptys[0].emitData('MacBook-Pro:demo user$ ');
    expect(ptys[0].writes).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ptys[0].writes).toEqual([
      `eval -- 'printf '"'"'PRESET_OUTPUT_ONLY\\n'"'"''; exit\r`,
    ]);
    const initialSubmission = ptys[0].writes[0];
    if (!initialSubmission) throw new Error('Expected initial submission');

    ptys[0].emitData(`\x1b[32m${initialSubmission.slice(0, 20)}\r`);
    ptys[0].emitData(
      `<${initialSubmission.slice(-20)}\x1b[0m\r\r\nPRESET_OUTPUT_ONLY\r\n`,
    );
    await flushMicrotasks();

    const outputEvents = events
      .filter(
        (entry): entry is EventRecord & { payload: TerminalOutputEvent } =>
          entry.channel === IPC_CHANNELS.terminalOutput &&
          outputEvent(entry.payload),
      )
      .map((entry) => entry.payload);
    expect(outputEvents.map(outputText)).toEqual(['PRESET_OUTPUT_ONLY\r\n']);
    expect(
      Buffer.from(manager.attach(session.id).replay).toString('utf8'),
    ).toBe('PRESET_OUTPUT_ONLY\r\n');
    expect(persistenceStore.appendTerminalOutput).toHaveBeenCalledTimes(1);
    expect(
      persistenceStore.appendTerminalOutput.mock.calls[0]?.[3].toString('utf8'),
    ).toBe('PRESET_OUTPUT_ONLY\r\n');

    ptys[0].emitExit(0);
    expect(
      events.some(
        (entry) =>
          entry.channel === IPC_CHANNELS.terminalExit &&
          'terminalId' in entry.payload &&
          entry.payload.terminalId === session.id,
      ),
    ).toBe(true);

    persistenceStore.getPersistedTerminalEntry.mockReturnValue({
      session,
      scrollbackLines: ['PRESET_OUTPUT_ONLY'],
      exitCode: 0,
      signal: null,
    });

    const restored = manager.restore(session.id, 80, 24);
    expect(restored.id).toBe(session.id);
    expect(ptys).toHaveLength(2);

    ptys[1].emitData('MacBook-Pro:demo user$ ');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ptys[1].writes).toEqual([initialSubmission]);

    ptys[1].emitData(`${initialSubmission}\nPRESET_OUTPUT_ONLY\r\n`);
    await flushMicrotasks();
    const restoredReplay = Buffer.from(
      manager.attach(restored.id).replay,
    ).toString('utf8');
    expect(restoredReplay).toContain('PRESET_OUTPUT_ONLY');
    expect(restoredReplay).not.toContain(command);
  });

  it('keeps a POSIX preset exit outside a trailing user comment', async () => {
    const { manager, ptys } = createManager();
    const command = 'echo done # keep this note';

    manager.spawn(
      'project-1',
      'wt-1',
      80,
      24,
      undefined,
      undefined,
      undefined,
      'default',
      command,
    );
    ptys[0].emitData('MacBook-Pro:demo user$ ');
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(ptys[0].writes).toEqual([`eval -- '${command}'; exit\r`]);
  });

  it('keeps a PowerShell preset exit outside a trailing user comment', async () => {
    const restorePlatform = setPlatform('darwin');
    const originalShell = process.env.SHELL;
    process.env.SHELL = '/bin/pwsh';
    try {
      const { manager, ptys } = createManager();
      const command = "Write-Output 'done' # keep this note";

      manager.spawn(
        'project-1',
        'wt-1',
        80,
        24,
        undefined,
        undefined,
        undefined,
        'default',
        command,
      );
      ptys[0].emitData('PS /tmp> ');
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(ptys[0].writes).toEqual([
        "& ([scriptblock]::Create('Write-Output ''done'' # keep this note')); exit\r",
      ]);
    } finally {
      if (originalShell === undefined) {
        delete process.env.SHELL;
      } else {
        process.env.SHELL = originalShell;
      }
      restorePlatform();
    }
  });

  it('lowers the priority of a live PTY by terminal id', () => {
    const { manager, ptys } = createManager();
    const session = manager.spawn('project-1', 'wt-1', 120, 30);

    manager.lowerPriority(session.id);

    expect(mockSetPriority).toHaveBeenCalledWith(
      ptys[0]?.pid,
      osConstants.priority.PRIORITY_LOW,
    );
  });

  it('spawns an explicit bash profile on macOS', () => {
    const restorePlatform = setPlatform('darwin');
    const originalShell = process.env.SHELL;
    process.env.SHELL = '/bin/zsh';
    try {
      const { manager, spawnCalls } = createManager();

      const session = manager.spawn(
        'project-1',
        'wt-1',
        120,
        30,
        undefined,
        undefined,
        undefined,
        'bash',
      );

      expect(session.shell).toBe('/bin/bash');
      expect(session.shellBasename).toBe('bash');
      expect(spawnCalls[0].file).toBe('/bin/bash');
      expect(spawnCalls[0].args).toEqual(['-l']);
      expect(spawnCalls[0].options.env).toMatchObject({
        BASH_SILENCE_DEPRECATION_WARNING: '1',
      });
    } finally {
      if (originalShell === undefined) {
        delete process.env.SHELL;
      } else {
        process.env.SHELL = originalShell;
      }
      restorePlatform();
    }
  });

  it('spawns an explicit command prompt profile on Windows', () => {
    const restorePlatform = setPlatform('win32');
    const originalComSpec = process.env.ComSpec;
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
    try {
      const { manager, spawnCalls } = createManager();

      const session = manager.spawn(
        'project-1',
        'wt-1',
        120,
        30,
        undefined,
        undefined,
        undefined,
        'cmd',
      );

      expect(session.shell).toBe('C:\\Windows\\System32\\cmd.exe');
      expect(session.shellBasename).toBe('cmd.exe');
      expect(spawnCalls[0].file).toBe('C:\\Windows\\System32\\cmd.exe');
      expect(spawnCalls[0].args).toEqual([]);
    } finally {
      if (originalComSpec === undefined) {
        delete process.env.ComSpec;
      } else {
        process.env.ComSpec = originalComSpec;
      }
      restorePlatform();
    }
  });

  it('closes command prompt after a Windows preset command completes', async () => {
    const restorePlatform = setPlatform('win32');
    const originalComSpec = process.env.ComSpec;
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
    try {
      const { manager, ptys } = createManager();
      const command = 'echo PRESET_OUTPUT_ONLY';

      manager.spawn(
        'project-1',
        'wt-1',
        120,
        30,
        undefined,
        undefined,
        undefined,
        'cmd',
        command,
      );
      ptys[0].emitData('C:\\worktrees\\project-1>');
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(ptys[0].writes).toEqual([`${command} & exit\r`]);
    } finally {
      if (originalComSpec === undefined) {
        delete process.env.ComSpec;
      } else {
        process.env.ComSpec = originalComSpec;
      }
      restorePlatform();
    }
  });

  it('lists Command Prompt as a launch profile on Windows', () => {
    const restorePlatform = setPlatform('win32');
    const originalComSpec = process.env.ComSpec;
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
    try {
      const profiles = listAvailableTerminalProfiles();

      const commandPromptProfile = profiles.find(
        (profile) => profile.id === 'cmd',
      );
      expect(commandPromptProfile?.id).toBe('cmd');
      expect(commandPromptProfile?.label).toBe('Command Prompt');
      expect(typeof commandPromptProfile?.isDefault).toBe('boolean');
      expect(profiles.filter((profile) => profile.isDefault)).toHaveLength(1);
    } finally {
      if (originalComSpec === undefined) {
        delete process.env.ComSpec;
      } else {
        process.env.ComSpec = originalComSpec;
      }
      restorePlatform();
    }
  });

  it('falls back to System32 cmd.exe for the Command Prompt profile when ComSpec is empty', () => {
    const restorePlatform = setPlatform('win32');
    const originalComSpec = process.env.ComSpec;
    process.env.ComSpec = '';
    try {
      const { manager, spawnCalls } = createManager();

      const session = manager.spawn(
        'project-1',
        'wt-1',
        120,
        30,
        undefined,
        undefined,
        undefined,
        'cmd',
      );

      expect(session.shell).toBe('C:\\Windows\\System32\\cmd.exe');
      expect(session.shellBasename).toBe('cmd.exe');
      expect(spawnCalls[0].file).toBe('C:\\Windows\\System32\\cmd.exe');
      expect(spawnCalls[0].args).toEqual([]);
    } finally {
      if (originalComSpec === undefined) {
        delete process.env.ComSpec;
      } else {
        process.env.ComSpec = originalComSpec;
      }
      restorePlatform();
    }
  });

  it('includes a default profile when the non-Windows login shell is not a built-in profile', () => {
    const restorePlatform = setPlatform('darwin');
    const originalShell = process.env.SHELL;
    process.env.SHELL = '/opt/homebrew/bin/fish';
    try {
      const profiles = listAvailableTerminalProfiles();

      expect(profiles[0]).toEqual({
        id: 'default',
        label: 'fish',
        isDefault: true,
      });
      expect(profiles.filter((profile) => profile.isDefault)).toHaveLength(1);
    } finally {
      if (originalShell === undefined) {
        delete process.env.SHELL;
      } else {
        process.env.SHELL = originalShell;
      }
      restorePlatform();
    }
  });

  it('builds terminal env from the worktree Canopy runtime without a separate user env overlay', () => {
    const getEnhancedEnvFn = jest.fn(
      (options?: EnhancedEnvOptions): Record<string, string | undefined> => {
        void options;
        return {
          PATH: '/mock/bin:/usr/bin',
        };
      },
    );
    const { manager, buildWorktreeEnvCalls } = createManager({
      getEnhancedEnvFn,
    });

    manager.spawn('project-1', 'wt-1', 120, 30);

    expect(getEnhancedEnvFn).toHaveBeenCalledWith({ environment: false });
    expect(buildWorktreeEnvCalls).toEqual([
      {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        env: undefined,
        options: { runtime: 'canopy' },
      },
    ]);
  });

  it('keeps assigned Canopy Runtime variables authoritative over the base terminal env', () => {
    const { manager, spawnCalls } = createManager({
      getEnhancedEnvFn: () => ({
        PATH: '/base/bin',
        SHARED_VALUE: 'base',
      }),
      buildWorktreeDataEnvFn: (
        projectId: string,
        worktreeId: string,
      ): NodeJS.ProcessEnv => ({
        PATH: '/runtime/bin',
        SHARED_VALUE: 'runtime',
        CANOPY_WORKSPACE_ID: projectId,
        CANOPY_WORKTREE_NAME: worktreeId,
      }),
    });

    manager.spawn('project-1', 'wt-1', 120, 30);

    expect(spawnCalls[0].options.env).toMatchObject({
      PATH: '/runtime/bin',
      SHARED_VALUE: 'runtime',
      CANOPY_WORKSPACE_ID: 'project-1',
      CANOPY_WORKTREE_NAME: 'wt-1',
    });
  });

  it('sanitizes dangerous inherited env keys for managed terminals', () => {
    const { manager, spawnCalls } = createManager({
      getEnhancedEnvFn: () => ({
        PATH: '/mock/bin:/usr/bin',
        NODE_OPTIONS: '--inspect',
        ELECTRON_RUN_AS_NODE: '1',
        SHELL: '/bin/zsh',
        LD_PRELOAD: '/tmp/libpreload.dylib',
        DYLD_INSERT_LIBRARIES: '/tmp/libinsert.dylib',
        SAFE_BASE_ENV: 'safe',
      }),
    });
    const managedCommand: ManagedTerminalCommand = {
      executable: '/bin/claude',
      args: ['--session-id', 'sdk'],
      env: {
        CANOPY_CLAUDE_TERMINAL_MODE: '1',
      },
      title: 'Claude Code',
      kind: 'claude-code',
      chatId: 'chat',
      sessionKey: 'session',
    };

    const session = manager.spawn(
      'project-1',
      'wt-1',
      120,
      30,
      undefined,
      managedCommand,
    );

    expect(session).toMatchObject({
      kind: 'claude-code',
      title: 'Claude Code',
      chatId: 'chat',
      sessionKey: 'session',
      shell: '/bin/claude',
      shellBasename: 'claude',
    });
    expect(spawnCalls[0]).toMatchObject({
      file: '/bin/claude',
      args: ['--session-id', 'sdk'],
    });
    const env = spawnCalls[0].options.env as Record<string, string | undefined>;
    expect(env.PATH).toBe('/mock/bin:/usr/bin');
    expect(env.SAFE_BASE_ENV).toBe('safe');
    expect(env.CANOPY_CLAUDE_TERMINAL_MODE).toBe('1');
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.SHELL).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();
  });

  it('announces script terminals so the renderer can add them to the drawer', () => {
    const { manager, events } = createManager();
    const managedCommand: ManagedTerminalCommand = {
      executable: '/bin/zsh',
      args: ['-li', '-c', 'read answer'],
      title: 'Setup',
      kind: 'script',
      focusOnSpawn: true,
    };

    const session = manager.spawn(
      'project-1',
      'wt-1',
      120,
      30,
      undefined,
      managedCommand,
    );

    expect(session.focusOnSpawn).toBe(true);
    expect(events).toContainEqual({
      channel: IPC_CHANNELS.terminalSpawned,
      payload: session,
    });
  });

  it('prepends internal managed terminal path entries', () => {
    const { manager, spawnCalls } = createManager({
      getEnhancedEnvFn: () => ({
        PATH: '/mock/bin:/usr/bin',
      }),
    });
    const managedCommand: ManagedTerminalCommand = {
      executable: '/bin/claude',
      args: ['--session-id', 'sdk'],
      pathPrepend: ['/runtime/shims'],
      title: 'Claude Code',
      kind: 'claude-code',
    };

    manager.spawn('project-1', 'wt-1', 120, 30, undefined, managedCommand);

    const env = spawnCalls[0].options.env as Record<string, string | undefined>;
    expect(env.PATH).toBe(
      ['/runtime/shims', '/mock/bin:/usr/bin'].join(delimiter),
    );
  });

  it('sanitizes dangerous Canopy Runtime keys reintroduced by worktree env for managed terminals', () => {
    const { manager, spawnCalls } = createManager({
      getEnhancedEnvFn: () => ({
        PATH: '/mock/bin:/usr/bin',
        SAFE_BASE_ENV: 'safe',
      }),
      buildWorktreeDataEnvFn: (
        projectId: string,
        worktreeId: string,
      ): NodeJS.ProcessEnv => ({
        PATH: '/runtime/bin',
        NODE_OPTIONS: '--inspect',
        ELECTRON_RUN_AS_NODE: '1',
        SHELL: '/bin/zsh',
        LD_PRELOAD: '/tmp/libpreload.dylib',
        DYLD_INSERT_LIBRARIES: '/tmp/libinsert.dylib',
        CANOPY_WORKSPACE_ID: projectId,
        CANOPY_WORKTREE_NAME: worktreeId,
      }),
    });
    const managedCommand: ManagedTerminalCommand = {
      executable: '/bin/claude',
      args: ['--session-id', 'sdk'],
      env: {
        CANOPY_CLAUDE_TERMINAL_MODE: '1',
      },
      title: 'Claude Code',
      kind: 'claude-code',
      chatId: 'chat',
      sessionKey: 'session',
    };

    manager.spawn('project-1', 'wt-1', 120, 30, undefined, managedCommand);

    const env = spawnCalls[0].options.env as Record<string, string | undefined>;
    expect(env.PATH).toBe('/runtime/bin');
    expect(env.SAFE_BASE_ENV).toBe('safe');
    expect(env.CANOPY_WORKSPACE_ID).toBe('project-1');
    expect(env.CANOPY_CLAUDE_TERMINAL_MODE).toBe('1');
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.SHELL).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();
  });

  it('normalizes PTY signal 0 to null on clean exits', () => {
    const { manager, ptys, events, persistenceStore } = createManager();
    const session = manager.spawn('project-1', 'wt-1', 120, 30);

    ptys[0].emitExit(0, 0);

    expect(events).toContainEqual({
      channel: IPC_CHANNELS.terminalExit,
      payload: {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        terminalId: session.id,
        kind: 'shell',
        exitCode: 0,
        signal: null,
      },
    });
    expect(persistenceStore.markTerminalExited).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      session.id,
      0,
      null,
    );
  });

  it('disposes PTY listeners and streams when a terminal exits', () => {
    const { manager, ptys } = createManager();
    const session = manager.spawn('project-1', 'wt-1', 120, 30);

    expect(manager.getLiveTerminalCount()).toBe(1);

    ptys[0].emitExit(0);

    expect(manager.getLiveTerminalCount()).toBe(0);
    expect(ptys[0].dataDisposeCount).toBe(1);
    expect(ptys[0].exitDisposeCount).toBe(1);
    expect(ptys[0].destroyCount).toBe(1);
    expect(() => manager.write(session.id, 'echo ignored')).not.toThrow();
  });

  it('claims the PTY process tree in the resource monitor until exit', () => {
    mockRegisterResource.mockClear();
    mockUnregisterResource.mockClear();
    const { manager, ptys } = createManager();
    const session = manager.spawn('project-1', 'wt-1', 120, 30);

    expect(mockRegisterResource).toHaveBeenCalledWith({
      id: `terminal:${session.id}`,
      groupId: 'terminal',
      kind: 'terminal',
      label: session.shellBasename,
      pid: ptys[0].pid,
      processGroupId: ptys[0].pid,
      metadata: { type: 'generic' },
    });
    expect(mockUnregisterResource).not.toHaveBeenCalled();

    ptys[0].emitExit(0);

    expect(mockUnregisterResource).toHaveBeenCalledTimes(1);
  });

  it('forces terminal cleanup when a killed PTY never emits exit', () => {
    jest.useFakeTimers();
    try {
      const { manager, ptys, events, persistenceStore } = createManager({
        killExitGraceMs: 25,
      });
      const session = manager.spawn('project-1', 'wt-1', 120, 30);
      jest
        .spyOn(ptys[0], 'kill')
        .mockImplementation((signal?: string): void => {
          ptys[0].killSignals.push(signal);
        });

      manager.kill(session.id);

      expect(manager.getLiveTerminalCount()).toBe(1);

      jest.advanceTimersByTime(25);

      expect(manager.getLiveTerminalCount()).toBe(0);
      expect(events).toContainEqual({
        channel: IPC_CHANNELS.terminalExit,
        payload: {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          terminalId: session.id,
          kind: 'shell',
          exitCode: null,
          signal: 'forced-cleanup',
        },
      });
      expect(persistenceStore.markTerminalExited).toHaveBeenCalledWith(
        'project-1',
        'wt-1',
        session.id,
        null,
        'forced-cleanup',
      );
      expect(ptys[0].dataDisposeCount).toBe(1);
      expect(ptys[0].exitDisposeCount).toBe(1);
      expect(ptys[0].destroyCount).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses to spawn beyond the live terminal cap and tears down the rejected PTY', () => {
    const { manager, ptys } = createManager({ maxLiveTerminals: 1 });

    manager.spawn('project-1', 'wt-1', 120, 30);

    expect(() => manager.spawn('project-1', 'wt-1', 120, 30)).toThrow(
      'ERR_TERMINAL_CAPACITY',
    );
    expect(manager.getLiveTerminalCount()).toBe(1);
    expect(ptys).toHaveLength(2);
    expect(ptys[1].killSignals).toEqual([undefined]);
    expect(ptys[1].destroyCount).toBe(1);
  });

  it('uses taskkill for Windows terminal process-tree teardown', () => {
    const restorePlatform = setPlatform('win32');
    const taskkill = createTaskkill();

    try {
      const { manager, ptys } = createManager();
      const session = manager.spawn('project-1', 'wt-1', 80, 24);

      manager.kill(session.id);
      taskkill.emit('exit', 0, null);

      expect(mockedSpawnSync).not.toHaveBeenCalled();
      expect(mockedSpawn).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '1', '/t', '/f'],
        { detached: true, stdio: 'ignore', windowsHide: true },
      );
      expect(processKillSpy).not.toHaveBeenCalledWith(-1, 'SIGKILL');
      expect(ptys[0].killSignals).toEqual([]);
    } finally {
      restorePlatform();
    }
  });

  it('falls back to pty.kill when Windows taskkill fails', () => {
    const restorePlatform = setPlatform('win32');
    const taskkill = createTaskkill();

    try {
      const { manager, ptys } = createManager();
      const session = manager.spawn('project-1', 'wt-1', 80, 24);

      manager.kill(session.id);
      // The kill returns while taskkill is still walking the tree.
      expect(ptys[0].killSignals).toEqual([]);
      taskkill.emit('exit', 1, null);

      expect(ptys[0].killSignals).toEqual([undefined]);
    } finally {
      restorePlatform();
    }
  });

  it('ignores pty.kill failures after Windows taskkill fails', () => {
    const restorePlatform = setPlatform('win32');
    const taskkill = createTaskkill();

    try {
      const { manager, ptys } = createManager();
      const session = manager.spawn('project-1', 'wt-1', 80, 24);
      jest.spyOn(ptys[0], 'kill').mockImplementation(() => {
        throw new Error('already gone');
      });

      expect(() => manager.kill(session.id)).not.toThrow();
      expect(() => taskkill.emit('exit', 1, null)).not.toThrow();
    } finally {
      restorePlatform();
    }
  });

  it('keeps POSIX process-group teardown for non-Windows terminals', () => {
    const restorePlatform = setPlatform('darwin');
    processKillSpy.mockImplementation(() => true);

    try {
      const { manager } = createManager();
      const session = manager.spawn('project-1', 'wt-1', 80, 24);

      manager.kill(session.id);

      expect(processKillSpy).toHaveBeenCalledWith(-1, 'SIGKILL');
      expect(mockedSpawn).not.toHaveBeenCalled();
    } finally {
      restorePlatform();
    }
  });

  it('forces ConPTY for Windows terminal spawns', () => {
    const restorePlatform = setPlatform('win32');

    try {
      const { manager, spawnCalls } = createManager();

      manager.spawn('project-1', 'wt-1', 80, 24);

      expect(spawnCalls[0].options).toMatchObject({
        useConpty: true,
      });
    } finally {
      restorePlatform();
    }
  });

  it('spawns a PTY in the selected repo cwd', () => {
    const { manager, spawnCalls } = createManager();

    const session = manager.spawn('workspace-1', 'wt-1', 80, 24, 'frontend');

    expect(session.cwd).toBe('/worktrees/workspace-1/wt-1/repos/frontend');
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].options.cwd).toBe(
      '/worktrees/workspace-1/wt-1/repos/frontend',
    );
  });

  it('microtask-coalesces output frames and keeps seq monotonic', async () => {
    const { manager, ptys, events, persistenceStore } = createManager();
    const session = manager.spawn('project-1', 'wt-1', 80, 24);

    ptys[0].emitData('hello ');
    ptys[0].emitData('world');

    expect(events).toHaveLength(0);

    await flushMicrotasks();

    const outputEvents = events
      .filter(
        (entry): entry is EventRecord & { payload: TerminalOutputEvent } =>
          entry.channel === IPC_CHANNELS.terminalOutput &&
          outputEvent(entry.payload),
      )
      .map((entry) => entry.payload);

    expect(outputEvents).toHaveLength(1);
    expect(outputText(outputEvents[0])).toBe('hello world');
    expect(outputEvents[0].seq).toBe(Buffer.byteLength('hello world'));

    ptys[0].emitData('!');
    await flushMicrotasks();

    const nextOutputEvents = events
      .filter(
        (entry): entry is EventRecord & { payload: TerminalOutputEvent } =>
          entry.channel === IPC_CHANNELS.terminalOutput &&
          outputEvent(entry.payload),
      )
      .map((entry) => entry.payload);

    expect(nextOutputEvents).toHaveLength(2);
    expect(nextOutputEvents[1].seq).toBe(Buffer.byteLength('hello world!'));
    expect(manager.attach(session.id).seq).toBe(
      Buffer.byteLength('hello world!'),
    );
    expect(persistenceStore.appendTerminalOutput).toHaveBeenNthCalledWith(
      1,
      'project-1',
      'wt-1',
      session.id,
      Buffer.from('hello ', 'utf8'),
    );
  });

  it('flushes immediately once the queued output reaches the threshold', () => {
    const { manager, ptys, events } = createManager();
    const session = manager.spawn('project-1', 'wt-1', 80, 24);

    ptys[0].emitData('a'.repeat(TERMINAL_FLUSH_THRESHOLD_BYTES));

    const outputEvents = events
      .filter(
        (entry): entry is EventRecord & { payload: TerminalOutputEvent } =>
          entry.channel === IPC_CHANNELS.terminalOutput &&
          outputEvent(entry.payload),
      )
      .map((entry) => entry.payload);

    expect(outputEvents).toHaveLength(1);
    expect(outputEvents[0].terminalId).toBe(session.id);
    expect(outputEvents[0].seq).toBe(TERMINAL_FLUSH_THRESHOLD_BYTES);
  });

  it('drops over-cap queued output and emits a truncation marker', () => {
    const { manager, ptys, events, persistenceStore } = createManager();
    const session = manager.spawn('project-1', 'wt-1', 80, 24);

    ptys[0].emitData('a'.repeat(TERMINAL_MAX_UNFLUSHED_BYTES + 1));

    const outputEvents = events
      .filter(
        (entry): entry is EventRecord & { payload: TerminalOutputEvent } =>
          entry.channel === IPC_CHANNELS.terminalOutput &&
          outputEvent(entry.payload),
      )
      .map((entry) => entry.payload);

    expect(outputEvents).toHaveLength(1);
    expect(outputText(outputEvents[0])).toBe(
      '\r\n\x1b[33m[output truncated]\x1b[0m\r\n',
    );

    const attachment = manager.attach(session.id);
    expect(Buffer.from(attachment.replay).toString('utf8')).toBe(
      '\r\n\x1b[33m[output truncated]\x1b[0m\r\n',
    );
    expect(attachment.seq).toBe(
      Buffer.byteLength('\r\n\x1b[33m[output truncated]\x1b[0m\r\n'),
    );
    expect(persistenceStore.appendTerminalOutput).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      session.id,
      Buffer.from('\r\n\x1b[33m[output truncated]\x1b[0m\r\n', 'utf8'),
    );
  });

  it('flushes queued bytes before truncating an over-cap chunk', () => {
    const { manager, ptys, events } = createManager();
    const session = manager.spawn('project-1', 'wt-1', 80, 24);

    ptys[0].emitData('queued');
    ptys[0].emitData('a'.repeat(TERMINAL_MAX_UNFLUSHED_BYTES));

    const outputEvents = events
      .filter(
        (entry): entry is EventRecord & { payload: TerminalOutputEvent } =>
          entry.channel === IPC_CHANNELS.terminalOutput &&
          outputEvent(entry.payload),
      )
      .map((entry) => entry.payload);

    expect(outputEvents).toHaveLength(2);
    expect(outputText(outputEvents[0])).toBe('queued');
    expect(outputEvents[0].seq).toBe(Buffer.byteLength('queued'));
    expect(outputText(outputEvents[1])).toBe(
      '\r\n\x1b[33m[output truncated]\x1b[0m\r\n',
    );
    expect(outputEvents[1].seq).toBe(
      Buffer.byteLength('queued') +
        Buffer.byteLength('\r\n\x1b[33m[output truncated]\x1b[0m\r\n'),
    );

    const attachment = manager.attach(session.id);
    expect(Buffer.from(attachment.replay).toString('utf8')).toBe(
      `queued\r\n\x1b[33m[output truncated]\x1b[0m\r\n`,
    );
    expect(attachment.seq).toBe(outputEvents[1].seq);
  });

  it('maintains a rolling replay buffer for attach responses', () => {
    const { manager, ptys } = createManager();
    const session = manager.spawn('project-1', 'wt-1', 80, 24);
    const oversized = 'x'.repeat(TERMINAL_REPLAY_BUFFER_MAX_BYTES + 64);

    ptys[0].emitData(oversized);

    const attachment = manager.attach(session.id);

    expect(attachment.replay.byteLength).toBe(TERMINAL_REPLAY_BUFFER_MAX_BYTES);
    expect(Buffer.from(attachment.replay).toString('utf8')).toBe(
      oversized.slice(oversized.length - TERMINAL_REPLAY_BUFFER_MAX_BYTES),
    );
    expect(attachment.seq).toBe(Buffer.byteLength(oversized));
  });

  it('emits current running-state snapshots when list is requested', async () => {
    const { manager, ptys, events } = createManager();
    const session = manager.spawn('project-1', 'wt-1', 80, 24);

    ptys[0].process = 'sleep';
    manager.list();
    await flushMicrotasks();

    expect(events).toContainEqual({
      channel: IPC_CHANNELS.terminalRunningChanged,
      payload: {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        terminalId: session.id,
        kind: 'shell',
        running: true,
        processName: 'sleep',
      },
    });
  });

  it('uses Windows child processes when node-pty reports only a terminal type', async () => {
    const restorePlatform = setPlatform('win32');
    const originalComSpec = process.env.ComSpec;
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
    mockWindowsForegroundProbe('cmd.exe\r\nnode.exe\r\n');

    try {
      const { manager, ptys, events } = createManager();
      const session = manager.spawn(
        'project-1',
        'wt-1',
        80,
        24,
        undefined,
        undefined,
        undefined,
        'cmd',
      );

      ptys[0].process = 'xterm-256color';
      manager.list();
      await flushMicrotasks();

      expect(events).toContainEqual({
        channel: IPC_CHANNELS.terminalRunningChanged,
        payload: {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          terminalId: session.id,
          kind: 'shell',
          running: true,
          processName: 'node.exe',
        },
      });
    } finally {
      if (originalComSpec === undefined) {
        delete process.env.ComSpec;
      } else {
        process.env.ComSpec = originalComSpec;
      }
      restorePlatform();
    }
  });

  it('refreshes Windows terminal-type process names asynchronously', async () => {
    const restorePlatform = setPlatform('win32');
    const originalComSpec = process.env.ComSpec;
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
    let completeProbe: ((stdout: string) => void) | null = null;
    mockedExecFile.mockImplementation((...args) => {
      const callback = findExecFileCallback(args);
      completeProbe = (stdout: string): void => {
        callback?.(null, stdout, '');
      };
      return undefined;
    });

    let currentTime = 10_000;
    try {
      const { manager, ptys, events } = createManager({
        now: (): number => currentTime,
      });
      const session = manager.spawn(
        'project-1',
        'wt-1',
        80,
        24,
        undefined,
        undefined,
        undefined,
        'cmd',
      );
      ptys[0].process = 'xterm-256color';

      manager.list();
      await flushMicrotasks();

      expect(mockedExecFile).toHaveBeenCalledTimes(1);
      expect(events).toContainEqual({
        channel: IPC_CHANNELS.terminalRunningChanged,
        payload: {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          terminalId: session.id,
          kind: 'shell',
          running: false,
          processName: null,
        },
      });

      currentTime += 2500;
      events.length = 0;
      manager.list();
      await flushMicrotasks();

      expect(mockedExecFile).toHaveBeenCalledTimes(1);

      completeProbe?.('cmd.exe\r\nnode.exe\r\n');
      await flushMicrotasks();

      events.length = 0;
      manager.list();
      await flushMicrotasks();

      expect(mockedExecFile).toHaveBeenCalledTimes(2);
      expect(events).toContainEqual({
        channel: IPC_CHANNELS.terminalRunningChanged,
        payload: {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          terminalId: session.id,
          kind: 'shell',
          running: true,
          processName: 'node.exe',
        },
      });
    } finally {
      if (originalComSpec === undefined) {
        delete process.env.ComSpec;
      } else {
        process.env.ComSpec = originalComSpec;
      }
      restorePlatform();
    }
  });

  it('keeps Windows terminals idle when the terminal-type fallback finds only the shell', async () => {
    const restorePlatform = setPlatform('win32');
    const originalComSpec = process.env.ComSpec;
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
    mockWindowsForegroundProbe('cmd.exe\r\nconhost.exe\r\n');

    try {
      const { manager, ptys, events } = createManager();
      const session = manager.spawn(
        'project-1',
        'wt-1',
        80,
        24,
        undefined,
        undefined,
        undefined,
        'cmd',
      );

      ptys[0].process = 'xterm-256color';
      manager.list();
      await flushMicrotasks();

      expect(events).toContainEqual({
        channel: IPC_CHANNELS.terminalRunningChanged,
        payload: {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          terminalId: session.id,
          kind: 'shell',
          running: false,
          processName: null,
        },
      });
    } finally {
      if (originalComSpec === undefined) {
        delete process.env.ComSpec;
      } else {
        process.env.ComSpec = originalComSpec;
      }
      restorePlatform();
    }
  });

  it('keeps Windows shell commands active until the prompt returns when no child process is visible', async () => {
    const restorePlatform = setPlatform('win32');
    const originalComSpec = process.env.ComSpec;
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
    mockWindowsForegroundProbe('cmd.exe\r\n');

    let currentTime = 10_000;
    try {
      const { manager, ptys, events } = createManager({
        now: (): number => currentTime,
      });
      const session = manager.spawn(
        'project-1',
        'wt-1',
        80,
        24,
        undefined,
        undefined,
        undefined,
        'cmd',
      );
      ptys[0].process = 'xterm-256color';

      manager.write(session.id, 'dir\r');
      manager.list();
      await flushMicrotasks();

      expect(events).toContainEqual({
        channel: IPC_CHANNELS.terminalRunningChanged,
        payload: {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          terminalId: session.id,
          kind: 'shell',
          running: true,
          processName: 'command',
        },
      });

      events.length = 0;
      currentTime += 2500;
      manager.list();
      await flushMicrotasks();

      expect(events).not.toContainEqual({
        channel: IPC_CHANNELS.terminalRunningChanged,
        payload: {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          terminalId: session.id,
          kind: 'shell',
          running: false,
          processName: null,
        },
      });

      events.length = 0;
      ptys[0].emitData('\r\nTotal $');
      manager.list();
      await flushMicrotasks();

      expect(events).not.toContainEqual({
        channel: IPC_CHANNELS.terminalRunningChanged,
        payload: {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          terminalId: session.id,
          kind: 'shell',
          running: false,
          processName: null,
        },
      });

      events.length = 0;
      ptys[0].emitData('\r\nC:\\Users\\Tommy> ');
      manager.list();
      await flushMicrotasks();

      expect(events).toContainEqual({
        channel: IPC_CHANNELS.terminalRunningChanged,
        payload: {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          terminalId: session.id,
          kind: 'shell',
          running: false,
          processName: null,
        },
      });
    } finally {
      if (originalComSpec === undefined) {
        delete process.env.ComSpec;
      } else {
        process.env.ComSpec = originalComSpec;
      }
      restorePlatform();
    }
  });

  it('uses the submitted command name for Windows terminal-type fallback labels', async () => {
    const restorePlatform = setPlatform('win32');
    const originalComSpec = process.env.ComSpec;
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
    mockWindowsForegroundProbe('bash.exe\r\n');

    try {
      const { manager, ptys, events } = createManager();
      const session = manager.spawn(
        'project-1',
        'wt-1',
        80,
        24,
        undefined,
        undefined,
        undefined,
        'cmd',
      );
      session.shellBasename = 'bash.exe';
      ptys[0].process = 'xterm-256color';

      manager.write(session.id, '\x1b[Inode\r');
      manager.list();
      await flushMicrotasks();

      expect(events).toContainEqual({
        channel: IPC_CHANNELS.terminalRunningChanged,
        payload: {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          terminalId: session.id,
          kind: 'shell',
          running: true,
          processName: 'node.exe',
        },
      });
    } finally {
      if (originalComSpec === undefined) {
        delete process.env.ComSpec;
      } else {
        process.env.ComSpec = originalComSpec;
      }
      restorePlatform();
    }
  });

  it('re-emits current running snapshots when listing live terminals', async () => {
    const { manager, ptys, events } = createManager();
    const first = manager.spawn('project-1', 'wt-1', 80, 24);
    const second = manager.spawn('project-1', 'wt-2', 80, 24);

    ptys[0].process = 'sleep';
    ptys[1].process = expectedShellBasename();
    events.length = 0;

    const sessions = manager.list();
    expect(sessions).toEqual([
      expect.objectContaining({
        id: first.id,
        running: true,
        processName: 'sleep',
      }),
      expect.objectContaining({
        id: second.id,
        running: false,
        processName: null,
      }),
    ]);

    await flushMicrotasks();

    const runningEvents = events
      .filter(
        (
          entry,
        ): entry is EventRecord & { payload: TerminalRunningChangedEvent } =>
          entry.channel === IPC_CHANNELS.terminalRunningChanged &&
          runningEvent(entry.payload),
      )
      .map((entry) => entry.payload);

    expect(runningEvents).toEqual([
      {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        terminalId: first.id,
        kind: 'shell',
        running: true,
        processName: 'sleep',
      },
      {
        projectId: 'project-1',
        worktreeId: 'wt-2',
        terminalId: second.id,
        kind: 'shell',
        running: false,
        processName: null,
      },
    ]);
  });

  it('marks the next idle transition after Ctrl+C as user-interrupted', () => {
    const { manager, events } = createManager();
    const session = manager.spawn('project-1', 'wt-1', 80, 24);
    manager.setTerminalStatus(session.id, true, 'sleep');
    events.length = 0;

    manager.write(session.id, '\x03');
    manager.setTerminalStatus(session.id, false, null);

    expect(events).toContainEqual({
      channel: IPC_CHANNELS.terminalRunningChanged,
      payload: {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        terminalId: session.id,
        kind: 'shell',
        running: false,
        processName: null,
        interruptedByUser: true,
      },
    });
  });

  it('does not mark delayed idle transitions as user-interrupted', () => {
    let nowMs = 10_000;
    const { manager, events } = createManager({ now: (): number => nowMs });
    const session = manager.spawn('project-1', 'wt-1', 80, 24);
    manager.setTerminalStatus(session.id, true, 'sleep');
    events.length = 0;

    manager.write(session.id, '\x03');
    nowMs += TERMINAL_USER_INTERRUPT_SUPPRESS_MS + 1;
    manager.setTerminalStatus(session.id, false, null);

    expect(events).toContainEqual({
      channel: IPC_CHANNELS.terminalRunningChanged,
      payload: {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        terminalId: session.id,
        kind: 'shell',
        running: false,
        processName: null,
      },
    });
  });

  it('does not carry Ctrl+C suppression into the next foreground process', () => {
    let nowMs = 10_000;
    const { manager, events } = createManager({ now: (): number => nowMs });
    const session = manager.spawn('project-1', 'wt-1', 80, 24);
    manager.setTerminalStatus(session.id, true, 'sleep');
    events.length = 0;

    manager.write(session.id, '\x03');
    nowMs += 100;
    manager.setTerminalStatus(session.id, true, 'node');
    nowMs += 3_500;
    manager.setTerminalStatus(session.id, false, null);

    expect(events).toContainEqual({
      channel: IPC_CHANNELS.terminalRunningChanged,
      payload: {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        terminalId: session.id,
        kind: 'shell',
        running: false,
        processName: null,
      },
    });
    expect(
      events.some(
        (event): boolean =>
          event.channel === IPC_CHANNELS.terminalRunningChanged &&
          runningEvent(event.payload) &&
          event.payload.running === false &&
          event.payload.interruptedByUser === true,
      ),
    ).toBe(false);
  });

  it('kills only terminals owned by the requested worktree', () => {
    const { manager, ptys } = createManager();
    manager.spawn('project-1', 'wt-1', 80, 24);
    manager.spawn('project-1', 'wt-2', 80, 24);
    manager.spawn('project-2', 'wt-1', 80, 24);

    const killSpies = ptys.map((pty) => jest.spyOn(pty, 'kill'));

    manager.killWorktreeTerminals('project-1', 'wt-1');

    expect(killSpies[0]).toHaveBeenCalledTimes(1);
    expect(killSpies[1]).not.toHaveBeenCalled();
    expect(killSpies[2]).not.toHaveBeenCalled();
  });

  it('drains native worktree terminal groups before completing archive cleanup', async () => {
    const { manager, ptys } = createManager();
    manager.spawn('project-1', 'wt-1', 80, 24);
    manager.spawn('project-1', 'wt-2', 80, 24);
    processKillSpy.mockImplementation((_pid, signal) => {
      if (signal === 0)
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return true;
    });
    await manager.drainWorktreeTerminals('project-1', 'wt-1');
    expect(processKillSpy).toHaveBeenCalledWith(-ptys[0].pid, 'SIGKILL');
    expect(processKillSpy).not.toHaveBeenCalledWith(-ptys[1].pid, 'SIGKILL');
    expect(manager.hasWorktreeTerminals('project-1', 'wt-1')).toBe(false);
    expect(manager.hasWorktreeTerminals('project-1', 'wt-2')).toBe(true);
  });

  it('treats kill as a no-op once the terminal has already exited', () => {
    const { manager, ptys } = createManager();
    const session = manager.spawn('project-1', 'wt-1', 80, 24);

    ptys[0].emitExit(0);

    expect(() => {
      manager.kill(session.id);
      manager.kill('missing-terminal');
    }).not.toThrow();
  });

  it('emits a provided kill signal override for Canopy-managed cleanup', () => {
    const { manager, events, persistenceStore } = createManager();
    const session = manager.spawn('project-1', 'wt-1', 80, 24);
    manager.setTerminalStatus(session.id, true, 'claude');
    events.length = 0;

    manager.kill(session.id, {
      signalOverride: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
    });

    expect(events).toContainEqual({
      channel: IPC_CHANNELS.terminalExit,
      payload: {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        terminalId: session.id,
        kind: 'shell',
        exitCode: 0,
        signal: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
      },
    });
    expect(persistenceStore.markTerminalExited).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      session.id,
      0,
      TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
    );
    expect(
      events.some(
        (event): boolean =>
          event.channel === IPC_CHANNELS.terminalRunningChanged &&
          event.payload.terminalId === session.id,
      ),
    ).toBe(false);
  });

  it('marks worktree cleanup exits as intentional', () => {
    const { manager, events, persistenceStore } = createManager();
    const session = manager.spawn('project-1', 'wt-1', 80, 24);
    manager.spawn('project-1', 'wt-2', 80, 24);
    manager.setTerminalStatus(session.id, true, 'sleep');
    events.length = 0;

    manager.killWorktreeTerminals('project-1', 'wt-1');

    expect(events).toContainEqual({
      channel: IPC_CHANNELS.terminalExit,
      payload: {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        terminalId: session.id,
        kind: 'shell',
        exitCode: 0,
        signal: TERMINAL_WORKTREE_CLEANUP_SIGNAL,
      },
    });
    expect(
      events.some(
        (event): boolean =>
          event.channel === IPC_CHANNELS.terminalRunningChanged &&
          event.payload.terminalId === session.id,
      ),
    ).toBe(false);
    expect(persistenceStore.markTerminalExited).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      session.id,
      0,
      TERMINAL_WORKTREE_CLEANUP_SIGNAL,
    );
    expect(
      events.some(
        (event): boolean =>
          event.channel === IPC_CHANNELS.terminalExit &&
          event.payload.worktreeId === 'wt-2',
      ),
    ).toBe(false);
  });

  it('treats write and resize as no-ops once the terminal has exited', () => {
    const { manager, ptys } = createManager();
    const session = manager.spawn('project-1', 'wt-1', 80, 24);

    ptys[0].emitExit(0);

    expect(() => {
      manager.write(session.id, 'echo ignored');
      manager.write('missing-terminal', 'echo ignored');
      manager.resize(session.id, 100, 40);
      manager.resize('missing-terminal', 100, 40);
    }).not.toThrow();
  });

  it('falls back to persisted attach snapshots for historical terminals', () => {
    const { manager, persistenceStore } = createManager();

    persistenceStore.getPersistedTerminalEntry.mockReturnValue({
      session: {
        id: 'historical',
        projectId: 'project-1',
        worktreeId: 'wt-1',
        shell: '/bin/zsh',
        shellBasename: 'zsh',
        cwd: '/worktrees/project-1/wt-1',
        createdAt: 10_000,
      },
      scrollbackLines: ['previous output'],
      exitCode: 0,
      signal: null,
    });

    expect(manager.attach('historical')).toEqual({
      session: {
        id: 'historical',
        projectId: 'project-1',
        worktreeId: 'wt-1',
        shell: '/bin/zsh',
        shellBasename: 'zsh',
        cwd: '/worktrees/project-1/wt-1',
        createdAt: 10_000,
      },
      replay: Uint8Array.from(Buffer.from('previous output', 'utf8')),
      seq: Buffer.byteLength('previous output'),
    });
  });

  describe('terminal restoration', () => {
    let restorePlatform: () => void;
    let restoreArch: () => void;

    beforeEach(() => {
      restorePlatform = setPlatform('linux');
      restoreArch = setArch('x64');
      // Exercise Linux validation without depending on host shell binaries.
      virtualFs.entries = { '/bin/zsh': 'exec' };
    });

    afterEach(() => {
      virtualFs.entries = null;
      restoreArch();
      restorePlatform();
    });

    it('restores a restart-killed terminal lazily under the same terminal id', () => {
      const { manager, persistenceStore, ptys } = createManager();

      persistenceStore.getPersistedTerminalEntry.mockReturnValue({
        session: {
          id: 'historical',
          projectId: 'project-1',
          worktreeId: 'wt-1',
          shell: '/bin/zsh',
          shellBasename: 'zsh',
          cwd: '/worktrees/project-1/wt-1',
          createdAt: 10_000,
        },
        scrollbackLines: ['previous output'],
        exitCode: null,
        signal: 'app-quit',
      });

      const session = manager.restore('historical', 100, 40);

      expect(session.id).toBe('historical');
      expect(ptys).toHaveLength(1);
      expect(persistenceStore.registerLiveSession).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'historical',
          projectId: 'project-1',
          worktreeId: 'wt-1',
        }),
      );
      expect(persistenceStore.appendTerminalOutput).toHaveBeenCalledWith(
        'project-1',
        'wt-1',
        'historical',
        expect.any(Buffer),
      );

      const attach = manager.attach('historical');
      const replayText = Buffer.from(attach.replay).toString('utf8');
      expect(replayText).toContain('previous output');
      expect(replayText).toContain('Terminal restarted');
    });

    it.each([null, 'pipe-error'])(
      'restarts a shell with exit signal %s under the same id with its history',
      (signal) => {
        const { manager, persistenceStore } = createManager();

        persistenceStore.getPersistedTerminalEntry.mockReturnValue({
          session: {
            id: 'historical',
            projectId: 'project-1',
            worktreeId: 'wt-1',
            shell: '/bin/zsh',
            shellBasename: 'zsh',
            cwd: '/worktrees/project-1/wt-1',
            createdAt: 10_000,
          },
          scrollbackLines: ['completed command output'],
          exitCode: 0,
          signal,
        });

        const session = manager.restore('historical', 100, 40);

        expect(session.id).toBe('historical');
        const replayText = Buffer.from(
          manager.attach('historical').replay,
        ).toString('utf8');
        expect(replayText).toContain('completed command output');
        expect(replayText).toContain('Terminal restarted');
      },
    );

    it('does not restore a terminal closed for worktree cleanup', () => {
      const { manager, persistenceStore, ptys } = createManager();

      persistenceStore.getPersistedTerminalEntry.mockReturnValue({
        session: {
          id: 'historical',
          projectId: 'project-1',
          worktreeId: 'wt-1',
          shell: '/bin/zsh',
          shellBasename: 'zsh',
          cwd: '/worktrees/project-1/wt-1',
          createdAt: 10_000,
        },
        scrollbackLines: [],
        exitCode: null,
        signal: TERMINAL_WORKTREE_CLEANUP_SIGNAL,
      });

      expect(() => manager.restore('historical', 100, 40)).toThrow(
        'Terminal is not restorable: historical',
      );
      expect(ptys).toHaveLength(0);
    });

    it('restores a restart-killed terminal with its persisted shell', () => {
      const restorePlatform = setPlatform('darwin');
      const originalShell = process.env.SHELL;
      process.env.SHELL = '/bin/zsh';
      try {
        const { manager, persistenceStore, spawnCalls } = createManager();

        persistenceStore.getPersistedTerminalEntry.mockReturnValue({
          session: {
            id: 'historical',
            projectId: 'project-1',
            worktreeId: 'wt-1',
            shell: '/bin/bash',
            shellBasename: 'bash',
            cwd: '/worktrees/project-1/wt-1',
            createdAt: 10_000,
          },
          scrollbackLines: ['previous output'],
          exitCode: null,
          signal: 'app-quit',
        });

        const session = manager.restore('historical', 100, 40);

        expect(session.shell).toBe('/bin/bash');
        expect(session.shellBasename).toBe('bash');
        expect(spawnCalls[0]).toMatchObject({
          file: '/bin/bash',
          args: ['-l'],
        });
      } finally {
        if (originalShell === undefined) {
          delete process.env.SHELL;
        } else {
          process.env.SHELL = originalShell;
        }
        restorePlatform();
      }
    });

    it('returns the full persisted replay on the first attach after restore', () => {
      const { manager, persistenceStore } = createManager();
      const persistedReplay = 'x'.repeat(
        TERMINAL_REPLAY_BUFFER_MAX_BYTES + 512,
      );

      persistenceStore.getPersistedTerminalEntry.mockReturnValue({
        session: {
          id: 'historical',
          projectId: 'project-1',
          worktreeId: 'wt-1',
          shell: '/bin/zsh',
          shellBasename: 'zsh',
          cwd: '/worktrees/project-1/wt-1',
          createdAt: 10_000,
        },
        scrollbackLines: [persistedReplay],
        exitCode: null,
        signal: 'app-quit',
      });

      manager.restore('historical', 100, 40);

      const firstAttach = manager.attach('historical');
      const firstReplayText = Buffer.from(firstAttach.replay).toString('utf8');
      expect(firstReplayText).toContain(persistedReplay);
      expect(firstReplayText).toContain('Terminal restarted');
      expect(firstAttach.seq).toBe(Buffer.byteLength(firstReplayText, 'utf8'));

      const secondAttach = manager.attach('historical');
      expect(secondAttach.replay.length).toBeLessThanOrEqual(
        TERMINAL_REPLAY_BUFFER_MAX_BYTES,
      );
      expect(secondAttach.seq).toBe(firstAttach.seq);
    });

    it('restores terminals using a valid persisted cwd inside the worktree root', () => {
      const tempRoot = mkdtempSync(join(tmpdir(), 'pty-manager-restore-'));
      const worktreeRoot = join(tempRoot, 'workspace-1', 'wt-1');
      const persistedCwd = join(worktreeRoot, 'repos', 'frontend');
      mkdirSync(persistedCwd, { recursive: true });

      try {
        const { manager, persistenceStore, spawnCalls } = createManager({
          resolveWorktreeCwdFn: (
            projectId: string,
            worktreeId: string,
            selectedRepoId?: string,
          ): string => {
            const basePath = join(tempRoot, projectId, worktreeId);
            return selectedRepoId
              ? join(basePath, 'repos', selectedRepoId)
              : basePath;
          },
        });

        persistenceStore.getPersistedTerminalEntry.mockReturnValue({
          session: {
            id: 'historical',
            projectId: 'workspace-1',
            worktreeId: 'wt-1',
            shell: '/bin/zsh',
            shellBasename: 'zsh',
            cwd: persistedCwd,
            createdAt: 10_000,
          },
          scrollbackLines: ['previous output'],
          exitCode: null,
          signal: 'app-quit',
        });

        const session = manager.restore('historical', 100, 40);

        expect(session.cwd).toBe(persistedCwd);
        expect(spawnCalls).toHaveLength(1);
        expect(spawnCalls[0].options.cwd).toBe(persistedCwd);
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('falls back to the resolved worktree cwd when the persisted cwd is invalid', () => {
      const tempRoot = mkdtempSync(join(tmpdir(), 'pty-manager-fallback-'));
      const worktreeRoot = join(tempRoot, 'workspace-1', 'wt-1');
      mkdirSync(worktreeRoot, { recursive: true });

      try {
        const { manager, persistenceStore, spawnCalls } = createManager({
          resolveWorktreeCwdFn: (
            projectId: string,
            worktreeId: string,
          ): string => join(tempRoot, projectId, worktreeId),
        });

        persistenceStore.getPersistedTerminalEntry.mockReturnValue({
          session: {
            id: 'historical',
            projectId: 'workspace-1',
            worktreeId: 'wt-1',
            shell: '/bin/zsh',
            shellBasename: 'zsh',
            cwd: '/tmp/not-the-worktree',
            createdAt: 10_000,
          },
          scrollbackLines: ['previous output'],
          exitCode: null,
          signal: 'app-quit',
        });

        const session = manager.restore('historical', 100, 40);

        expect(session.cwd).toBe(worktreeRoot);
        expect(spawnCalls).toHaveLength(1);
        expect(spawnCalls[0].options.cwd).toBe(worktreeRoot);
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  });

  it('tries to kill the entire process group before falling back to pty.kill', () => {
    processKillSpy.mockImplementation(() => true);
    const { manager, ptys } = createManager();
    const session = manager.spawn('project-1', 'wt-1', 80, 24);
    const actualPtyKillSpy = jest.spyOn(ptys[0], 'kill');

    manager.kill(session.id);

    expect(processKillSpy).toHaveBeenCalledWith(-ptys[0].pid, 'SIGKILL');
    expect(actualPtyKillSpy).not.toHaveBeenCalled();
    actualPtyKillSpy.mockRestore();
  });

  describe('Linux x64 terminal shell resolution', () => {
    let restorePlatform: () => void;
    let restoreArch: () => void;
    let originalShell: string | undefined;

    const SYSTEM_BASH: VirtualFsEntries = { '/bin/bash': 'exec' };
    const uid = String(process.getuid?.() ?? 1000);

    function setShell(value: string | undefined): void {
      if (value === undefined) delete process.env.SHELL;
      else process.env.SHELL = value;
    }

    function mockAccountShell(output: string | Error | null): void {
      mockedExecFile.mockImplementation((...args) => {
        const callback = findExecFileCallback(args);
        if (output === null || output instanceof Error) {
          callback?.(output ?? new Error('Command timed out'), '', '');
        } else {
          callback?.(null, output, '');
        }
        return undefined;
      });
    }

    function accountLookups(): unknown[][] {
      return mockedExecFile.mock.calls.filter(
        (call) => call[0] === '/usr/bin/getent',
      );
    }

    function passwd(shell: string, fields = 7, entryUid = uid): string {
      return ['user', 'x', entryUid, '1000', 'User', '/home/user', shell]
        .slice(0, fields)
        .join(':');
    }

    beforeEach(() => {
      restorePlatform = setPlatform('linux');
      restoreArch = setArch('x64');
      originalShell = process.env.SHELL;
      resetLinuxTerminalShellLookupForTests();
      virtualFs.entries = { ...SYSTEM_BASH };
      mockAccountShell(null);
    });

    afterEach(() => {
      virtualFs.entries = null;
      setShell(originalShell);
      restoreArch();
      restorePlatform();
    });

    function spawnDefault(): TerminalSession & { spawnCalls: SpawnCall[] } {
      const { manager, spawnCalls } = createManager();
      return { ...manager.spawn('project-1', 'wt-1', 80, 24), spawnCalls };
    }

    function spawnProfile(
      manager: PtyManager,
      profile: 'zsh' | 'bash',
    ): TerminalSession {
      return manager.spawn(
        'project-1',
        'wt-1',
        80,
        24,
        undefined,
        undefined,
        undefined,
        profile,
      );
    }

    function persistShell(
      persistenceStore: MockPersistenceStore,
      shell: string,
    ): void {
      persistenceStore.getPersistedTerminalEntry.mockReturnValue({
        session: {
          id: 'historical',
          projectId: 'project-1',
          worktreeId: 'wt-1',
          shell,
          shellBasename: basename(shell),
          cwd: '/worktrees/project-1/wt-1',
          createdAt: 10_000,
        },
        scrollbackLines: ['previous output'],
        exitCode: null,
        signal: 'app-quit',
      });
    }

    it("launches a user's Fish default through the login shell argument and labels it", () => {
      virtualFs.entries = { ...SYSTEM_BASH, '/usr/bin/fish': 'exec' };
      setShell('/usr/bin/fish');

      const session = spawnDefault();

      expect(session).toMatchObject({
        shell: '/usr/bin/fish',
        shellBasename: 'fish',
      });
      expect(session.spawnCalls[0]).toMatchObject({
        file: '/usr/bin/fish',
        args: ['-l'],
      });
      expect(accountLookups()).toHaveLength(0);
    });

    it.each([
      ['unset', undefined],
      ['empty', ''],
      ['whitespace-only', '  \t '],
    ])(
      'uses a bounded, asynchronous account lookup when SHELL is %s',
      async (_label, value) => {
        virtualFs.entries = { ...SYSTEM_BASH, '/usr/bin/fish': 'exec' };
        setShell(value);
        mockAccountShell(`${passwd('/usr/bin/fish')}\n`);

        await prewarmLinuxTerminalShell();
        const session = spawnDefault();

        expect(session.shell).toBe('/usr/bin/fish');
        expect(accountLookups()).toEqual([
          [
            '/usr/bin/getent',
            ['passwd', uid],
            expect.objectContaining({
              timeout: 1000,
              killSignal: 'SIGKILL',
              maxBuffer: 16 * 1024,
            }),
            expect.any(Function),
          ],
        ]);
      },
    );

    it('never runs the account lookup inside a synchronous spawn', async () => {
      virtualFs.entries = { ...SYSTEM_BASH, '/usr/bin/fish': 'exec' };
      setShell(undefined);
      mockAccountShell(`${passwd('/usr/bin/fish')}\n`);

      // Cold cache: validated Bash now, the lookup only starts in the background.
      const cold = spawnDefault();
      expect(cold.shell).toBe('/bin/bash');
      expect(mockedSpawnSync).not.toHaveBeenCalled();

      await prewarmLinuxTerminalShell();
      expect(spawnDefault().shell).toBe('/usr/bin/fish');
      expect(accountLookups()).toHaveLength(1);
    });

    it('does not look anything up when SHELL is already usable', async () => {
      virtualFs.entries = { ...SYSTEM_BASH, '/usr/bin/fish': 'exec' };
      setShell('/usr/bin/fish');

      await prewarmLinuxTerminalShell();

      expect(accountLookups()).toHaveLength(0);
    });

    it('shares one in-flight lookup and ignores a lookup finished after a reset', async () => {
      virtualFs.entries = { ...SYSTEM_BASH, '/usr/bin/fish': 'exec' };
      setShell(undefined);
      const callbacks: MockExecFileCallback[] = [];
      mockedExecFile.mockImplementation((...args) => {
        const callback = findExecFileCallback(args);
        if (callback) callbacks.push(callback);
        return undefined;
      });

      const first = prewarmLinuxTerminalShell();
      const second = prewarmLinuxTerminalShell();
      expect(accountLookups()).toHaveLength(1);

      resetLinuxTerminalShellLookupForTests();
      callbacks[0](null, `${passwd('/usr/bin/fish')}\n`, '');
      await Promise.all([first, second]);

      // The superseded result was dropped, so the default is still Bash.
      expect(spawnDefault().shell).toBe('/bin/bash');
    });

    it.each<[string, VirtualFsEntries, string]>([
      ['nonexistent', {}, '/opt/gone/fish'],
      ['non-executable', { '/usr/bin/fish': 'plain' }, '/usr/bin/fish'],
      ['a directory', { '/usr/bin/fish': 'dir' }, '/usr/bin/fish'],
      ['a relative path', {}, 'fish'],
      [
        'an unsupported shell',
        { '/usr/sbin/nologin': 'exec' },
        '/usr/sbin/nologin',
      ],
      ['an unqualified shell', { '/usr/bin/tcsh': 'exec' }, '/usr/bin/tcsh'],
    ])(
      'falls back to validated Bash when SHELL is %s',
      (_label, extra, shell) => {
        virtualFs.entries = { ...SYSTEM_BASH, ...extra };
        setShell(shell);

        const session = spawnDefault();

        expect(session).toMatchObject({
          shell: '/bin/bash',
          shellBasename: 'bash',
        });
        expect(session.spawnCalls[0].args).toEqual(['-l']);
      },
    );

    it('prefers the account shell when SHELL is stale', async () => {
      virtualFs.entries = { ...SYSTEM_BASH, '/usr/bin/zsh': 'exec' };
      setShell('/opt/removed/fish');
      mockAccountShell(`${passwd('/usr/bin/zsh')}\n`);

      await prewarmLinuxTerminalShell();
      expect(spawnDefault().shell).toBe('/usr/bin/zsh');
    });

    it.each([
      ['an error', new Error('spawn /usr/bin/getent ENOENT')],
      ['a timeout', null],
      [
        'several records',
        `${passwd('/usr/bin/fish')}\n${passwd('/bin/zsh')}\n`,
      ],
      ['a malformed record', `${passwd('/usr/bin/fish', 6)}\n`],
      ['another user id', `${passwd('/usr/bin/fish', 7, '0')}\n`],
      ['startup noise instead of a record', 'motd: welcome\n'],
      ['an unusable account shell', `${passwd('/usr/bin/fish')}\n`],
    ])(
      'falls back to Bash after account lookup returns %s',
      async (_label, output) => {
        setShell(undefined);
        mockAccountShell(output);

        await prewarmLinuxTerminalShell();
        const session = spawnDefault();

        expect(session.shell).toBe('/bin/bash');
        expect(accountLookups()).toHaveLength(1);
      },
    );

    it('does not repeat a failed account lookup on every spawn', async () => {
      setShell(undefined);
      mockAccountShell(new Error('spawn /usr/bin/getent ENOENT'));
      const { manager } = createManager();

      await prewarmLinuxTerminalShell();
      manager.spawn('project-1', 'wt-1', 80, 24);
      await prewarmLinuxTerminalShell();
      manager.spawn('project-1', 'wt-1', 80, 24);

      expect(accountLookups()).toHaveLength(1);
    });

    it('uses /usr/bin/bash when /bin/bash is absent', () => {
      virtualFs.entries = { '/usr/bin/bash': 'exec' };
      setShell(undefined);

      expect(spawnDefault().shell).toBe('/usr/bin/bash');
    });

    it('refuses to start, with an actionable reason, when no Bash fallback exists', () => {
      virtualFs.entries = {};
      setShell('/opt/removed/fish');
      const { manager, spawnCalls } = createManager();

      expect(() => manager.spawn('project-1', 'wt-1', 80, 24)).toThrow(
        /^Terminal shell unavailable: .*Bash/,
      );
      expect(spawnCalls).toHaveLength(0);
    });

    it('launches an explicit zsh and bash profile and labels the launched process', () => {
      virtualFs.entries = { ...SYSTEM_BASH, '/usr/bin/zsh': 'exec' };
      setShell('/bin/bash');
      const { manager, spawnCalls } = createManager();

      const zsh = spawnProfile(manager, 'zsh');
      const bash = spawnProfile(manager, 'bash');

      expect(zsh).toMatchObject({
        shell: '/usr/bin/zsh',
        shellBasename: 'zsh',
      });
      expect(bash).toMatchObject({ shell: '/bin/bash', shellBasename: 'bash' });
      expect(spawnCalls.map((call) => call.file)).toEqual([
        '/usr/bin/zsh',
        '/bin/bash',
      ]);
    });

    it.each<[string, VirtualFsEntries, RegExp]>([
      ['missing', {}, /^Terminal shell unavailable: zsh can't start/],
      [
        'non-executable',
        { '/usr/bin/zsh': 'plain' },
        /^Terminal shell unavailable: .*\/usr\/bin\/zsh.*executable/,
      ],
      [
        'a directory',
        { '/usr/bin/zsh': 'dir' },
        /^Terminal shell unavailable: .*\/usr\/bin\/zsh.*not a file/,
      ],
    ])(
      'fails an explicit zsh selection when zsh is %s without switching shells',
      (_label, extra, message) => {
        virtualFs.entries = { ...SYSTEM_BASH, ...extra };
        setShell('/bin/bash');
        const { manager, spawnCalls } = createManager();

        expect(() => spawnProfile(manager, 'zsh')).toThrow(message);
        expect(spawnCalls).toHaveLength(0);
      },
    );

    it('fails an explicit bash selection when Bash was removed instead of using the default', () => {
      virtualFs.entries = { '/usr/bin/fish': 'exec' };
      setShell('/usr/bin/fish');
      const { manager, spawnCalls } = createManager();

      expect(() => spawnProfile(manager, 'bash')).toThrow(
        /^Terminal shell unavailable: bash can't start/,
      );
      expect(spawnCalls).toHaveLength(0);
    });

    it('reports a failed PTY spawn against the selected shell without retrying another', () => {
      setShell('/bin/bash');
      const { manager, spawnCalls } = createManager({
        ptySpawnFailure: new Error('posix_spawnp failed.'),
      });

      expect(() => manager.spawn('project-1', 'wt-1', 80, 24)).toThrow(
        /^Terminal shell unavailable: \/bin\/bash.*posix_spawnp failed/,
      );
      expect(spawnCalls).toHaveLength(0);
    });

    it('restores the persisted shell instead of the current default', () => {
      virtualFs.entries = { ...SYSTEM_BASH, '/usr/bin/fish': 'exec' };
      setShell('/bin/bash');
      const { manager, persistenceStore, spawnCalls } = createManager();
      persistShell(persistenceStore, '/usr/bin/fish');

      const session = manager.restore('historical', 100, 40);

      expect(session).toMatchObject({
        shell: '/usr/bin/fish',
        shellBasename: 'fish',
      });
      expect(spawnCalls[0]).toMatchObject({
        file: '/usr/bin/fish',
        args: ['-l'],
      });
    });

    it('does not restore into another shell when the persisted shell was removed', () => {
      setShell('/bin/bash');
      const { manager, persistenceStore, spawnCalls } = createManager();
      persistShell(persistenceStore, '/usr/bin/fish');

      expect(() => manager.restore('historical', 100, 40)).toThrow(
        /^Terminal shell unavailable: .*\/usr\/bin\/fish/,
      );
      expect(spawnCalls).toHaveLength(0);
    });

    it('lists Fish as the default alongside installed Bash and optional zsh', () => {
      virtualFs.entries = {
        ...SYSTEM_BASH,
        '/usr/bin/fish': 'exec',
        '/usr/bin/zsh': 'exec',
      };
      setShell('/usr/bin/fish');

      expect(listAvailableTerminalProfiles()).toEqual([
        { id: 'default', label: 'fish', isDefault: true },
        { id: 'zsh', label: 'zsh', isDefault: false },
        { id: 'bash', label: 'bash', isDefault: false },
      ]);
    });

    it('labels the Bash fallback as the default and hides an unusable zsh', () => {
      virtualFs.entries = { ...SYSTEM_BASH, '/usr/bin/zsh': 'plain' };
      setShell('/opt/removed/fish');

      expect(listAvailableTerminalProfiles()).toEqual([
        { id: 'bash', label: 'bash', isDefault: true },
      ]);
    });

    it('lists no profiles, without throwing, when no usable shell exists', () => {
      virtualFs.entries = {};
      setShell('/opt/removed/fish');

      expect(listAvailableTerminalProfiles()).toEqual([]);
    });

    it('keeps macOS and non-x64 Linux resolution unchanged', () => {
      setShell('/opt/removed/fish');
      restoreArch();
      restoreArch = setArch('arm64');
      expect(spawnDefault()).toMatchObject({ shell: '/opt/removed/fish' });

      restoreArch();
      restoreArch = setArch('x64');
      restorePlatform();
      restorePlatform = setPlatform('darwin');
      expect(spawnDefault()).toMatchObject({ shell: '/opt/removed/fish' });
      expect(accountLookups()).toHaveLength(0);
    });
  });
});
