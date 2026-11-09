import { AppErrorSchema } from '@canopy/protocol/app-errors';
import {
  decodeIpcAppError,
  formatIpcLegacyError,
  IpcAppErrorRejection,
} from '@canopy/desktop-shared/ipc/app-error-rejection';
import { registerIpcHandler } from '../../ipc/register';
import * as appErrorPolicy from '../../ipc/app-error-policy';
import * as appErrorRecording from '@canopy/desktop-instrumentation/electron/main';
import {
  restoreIpcAppError,
  resolveIpcAppError,
} from '../../../preload/ipc-app-errors';
/**
 * CAN-5718 migration golden: real terminal/Labs IPC handlers, terminal service,
 * canonical route selection and RemoteTerminals over injected execution hosts.
 * No Electron process or PTY is launched; terminal-conformance covers that seam.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  IPC_CHANNELS,
  type TerminalSession,
} from '@canopy/desktop-shared/types';
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import {
  WorkerTerminalCreateParamsSchema,
  WorkerTerminalRestoreParamsSchema,
  type WorkerTerminalCreateResult,
} from '@canopy/protocol/canopy-core';
import {
  buildRestoreMarker,
  type RemoteTerminals,
  type ResolvedTerminalShell,
  type TerminalCreateRequest,
  type TerminalPersistencePort,
} from '@canopy/core-runtime/node/terminal';
import { LabsExperimentsService } from '../../services/labs-experiments-service';
import { registerTerminalHandlers } from '../../ipc/terminal';
import { registerLabsExperimentsHandlers } from '../../ipc/labs-experiments';
import { markUnreachable } from '../../canopy-runtime/electron-daemon-connection';

interface RouteState {
  root: string;
  daemon: RemoteTerminals | undefined;
  labs: LabsExperimentsService | undefined;
  failure: Error | undefined;
  failureAfterCreate: boolean;
  local: Map<string, TerminalSession>;
  hosted: Map<string, WorkerTerminalCreateResult>;
  restored: Map<string, string>;
  persisted: Map<
    string,
    NonNullable<
      ReturnType<TerminalPersistencePort['getPersistedTerminalEntry']>
    >
  >;
}
const mockState: RouteState = {
  root: '',
  daemon: undefined,
  labs: undefined,
  failure: undefined,
  failureAfterCreate: false,
  local: new Map<string, TerminalSession>(),
  hosted: new Map<string, WorkerTerminalCreateResult>(),
  restored: new Map<string, string>(),
  persisted: new Map<
    string,
    NonNullable<
      ReturnType<TerminalPersistencePort['getPersistedTerminalEntry']>
    >
  >(),
};

jest.mock('@canopy/core-platform', () => ({
  hostPlatformOperatingSystem: (): 'darwin' => 'darwin',
}));
jest.mock('@canopy/core-runtime/node', () => ({
  ...jest.requireActual<object>('@canopy/core-runtime/node'),
  createFilesystemScopeResolver: jest.fn(() =>
    jest.fn(() => Promise.resolve({})),
  ),
  readFilesystemScope: jest.fn(() =>
    Promise.resolve({
      roots: [
        { id: 'project', kind: 'repository', absolutePath: mockState.root },
      ],
    }),
  ),
}));
jest.mock('../../lib/resolve-worktree', () => ({
  resolveWorktreeTargetIds: (): { projectId: string; worktreeId: string } => ({
    projectId: 'project',
    worktreeId: 'task',
  }),
  resolveWorktreeCwd: (): string => mockState.root,
}));
jest.mock('../../lib/workspace-target-exclusion', () => ({
  withWorkspaceTargetRuntimeStartReservation: (
    _project: string,
    _worktree: string,
    start: () => Promise<unknown>,
  ): Promise<unknown> => start(),
}));
jest.mock('../../services/split-lock-service', () => ({
  assertNotSplitLocked: (): void => undefined,
}));
jest.mock('../../services/labs-experiments-runtime', () => ({
  getLabsExperimentsService: (): LabsExperimentsService | undefined =>
    mockState.labs,
}));
jest.mock('../../canopy-runtime/electron-daemon-health', () => ({
  getElectronDaemonHealth: jest.fn(() => ({
    isLatched: (): boolean => false,
    noteFallback: (): void => undefined,
    setConsumerEnabled: (): void => undefined,
  })),
}));
jest.mock('../../canopy-runtime/electron-daemon-access', () => ({
  getElectronDaemonFilesContext: jest.fn(() =>
    Promise.resolve({
      canonicalDataRoot: '/unused',
      authorityId: 'local',
    }),
  ),
  getElectronDaemonConnections: jest.fn(() => ({
    get: jest.fn(() =>
      Promise.resolve().then(() => {
        if (mockState.failure && !('payload' in mockState.failure))
          throw mockState.failure;
        return {
          client: {
            signal: new AbortController().signal,
            instruction: (operation: string, raw: unknown): Promise<unknown> =>
              Promise.resolve().then(() => {
                if (mockState.failure && !mockState.failureAfterCreate)
                  throw mockState.failure;
                if (operation === 'worker.terminal.create') {
                  const p = WorkerTerminalCreateParamsSchema.parse(raw);
                  const terminal: WorkerTerminalCreateResult = {
                    terminalId: `daemon-${mockState.hosted.size + 1}`,
                    scope: p.scope,
                    state: 'running',
                    cwdRootId: p.cwdRootId,
                    cwdRelativePath: p.cwdRelativePath,
                    cols: p.cols,
                    rows: p.rows,
                    exitCode: null,
                    signal: null,
                    outputOffset: 0,
                    profileId: null,
                    initialCommand: null,
                  };
                  mockState.hosted.set(terminal.terminalId, terminal);
                  if (mockState.failure) throw mockState.failure;
                  return terminal;
                }
                if (operation === 'worker.terminal.restore') {
                  const p = WorkerTerminalRestoreParamsSchema.parse(raw);
                  if (p.restoreMode === 'reattach_if_live')
                    return {
                      terminalId: p.terminalId,
                      state: 'running',
                      restored: true,
                      recreated: false,
                      outputOffset: 0,
                    };
                  const scrollback = p.snapshot?.scrollback ?? '';
                  mockState.restored.set(p.terminalId, scrollback);
                  return {
                    terminalId: p.terminalId,
                    state: 'running',
                    restored: true,
                    recreated: true,
                    outputOffset:
                      Buffer.byteLength(scrollback) +
                      buildRestoreMarker(scrollback.length > 0).length,
                  };
                }
                throw new Error(`Unexpected operation: ${operation}`);
              }),
            openStream: jest.fn(() =>
              Promise.resolve({
                onFrame: (): (() => void) => (): void => undefined,
                close: (): void => undefined,
              }),
            ),
          },
        };
      }),
    ),
  })),
}));
jest.mock('../worker-terminal', () => ({
  workerTerminal: {
    setEventSink: (): void => undefined,
    emit: (): void => undefined,
    prewarmShell: (): Promise<void> => Promise.resolve(),
    get daemonTerminals(): RemoteTerminals | undefined {
      return mockState.daemon;
    },
    useDaemonTerminals: (daemon: RemoteTerminals): void => {
      mockState.daemon = daemon;
    },
    list: (): TerminalSession[] => [
      ...mockState.local.values(),
      ...(mockState.daemon?.list() ?? []),
    ],
    get: (id: string): TerminalSession | null =>
      mockState.local.get(id) ?? mockState.daemon?.get(id) ?? null,
    create: (request: TerminalCreateRequest): TerminalSession => {
      const session: TerminalSession = {
        id: `engine-${mockState.local.size + 1}`,
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        shell: '/bin/sh',
        shellBasename: 'sh',
        cwd: mockState.root,
        createdAt: 1,
      };
      mockState.local.set(session.id, session);
      return session;
    },
    restore: ({
      terminalId,
    }: {
      terminalId: string;
    }): TerminalSession | undefined => mockState.local.get(terminalId),
    replayText: (id: string): string | null | undefined =>
      mockState.daemon?.replayText(id),
  },
  createDesktopTerminalHost: jest.fn(() => ({
    resources: {
      register: jest.fn(() => ({ unregister: (): void => undefined })),
    },
  })),
  desktopTerminalShells: {
    profile: (): ResolvedTerminalShell => ({
      shell: '/bin/sh',
      args: [],
      shellBasename: 'sh',
    }),
    persisted: (): ResolvedTerminalShell => ({
      shell: '/bin/sh',
      args: [],
      shellBasename: 'sh',
    }),
  },
  desktopTerminalEnvironmentFor: (): Record<string, string> => ({
    PATH: '/usr/bin:/bin',
  }),
  TERMINAL_EVENT_CHANNELS: {},
}));
jest.mock('../persistence', () => ({
  terminalPersistenceStore: {
    getPersistedTerminalEntry: (
      id: string,
    ): ReturnType<TerminalPersistencePort['getPersistedTerminalEntry']> =>
      mockState.persisted.get(id) ?? null,
    registerLiveSession: (): void => undefined,
    appendTerminalOutput: (): void => undefined,
    markTerminalExited: (): void => undefined,
  },
}));
jest.mock('../../remote-control/host/bridge-window', () => ({
  resolveRemoteBridgeSender: (): null => null,
}));
jest.mock('../../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: jest.fn(() => ({
    setEventSender: (): void => undefined,
    setChatSummaryScheduler: (): void => undefined,
  })),
}));
jest.mock('../../lib/slow-action-tracker', () => ({
  trackSlowAction: (result: unknown): unknown => result,
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: (): void => undefined,
}));

const handlers = new Map<string, Parameters<typeof ipcMain.handle>[1]>();
let main: BrowserWindow;
let foreign: BrowserWindow;

function invoke(
  channel: string,
  request?: unknown,
  window = main,
): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler ${channel}`);
  const event: IpcMainInvokeEvent = {
    sender: window.webContents,
    senderFrame: null,
    frameId: 1,
    processId: 1,
    type: 'frame',
    preventDefault: () => undefined,
    defaultPrevented: false,
  };
  return Promise.resolve().then((): unknown => handler(event, request));
}

function labs(
  choices: Record<string, boolean>,
  ready: boolean,
): LabsExperimentsService {
  return new LabsExperimentsService(
    {
      choicesPath: 'choices',
      availabilityPath: 'availability',
      pendingSyncPath: 'pending',
      read: (file) =>
        file === 'choices'
          ? { version: 1, accounts: { local: choices } }
          : undefined,
      write: () => Promise.resolve(),
      availability: () => ({
        snapshot: getDefaultFeatureFlagSnapshot(
          ready ? 'not_configured' : 'initializing',
        ),
        contextIdentity: null,
        liveValues: {},
      }),
      fetchChoices: () => Promise.resolve({ choices: {} }),
      putChoice: () => Promise.resolve({}),
      diagnostic: () => undefined,
      mirror: () => undefined,
    },
    { scope: 'local', signedIn: false, ready },
  );
}

beforeAll(() => {
  mockState.root = realpathSync.native(
    mkdtempSync(join(tmpdir(), 'terminal-route-golden-')),
  );
  jest.spyOn(ipcMain, 'handle').mockImplementation((channel, handler) => {
    handlers.set(channel, handler);
  });
});
afterAll(() => {
  jest.restoreAllMocks();
  rmSync(mockState.root, { recursive: true, force: true });
});
beforeEach(() => {
  mockState.daemon = undefined;
  mockState.failure = undefined;
  mockState.failureAfterCreate = false;
  mockState.local.clear();
  mockState.hosted.clear();
  mockState.restored.clear();
  mockState.persisted.clear();
  mockState.labs = labs({}, true);
  main = new BrowserWindow();
  foreign = new BrowserWindow();
  registerTerminalHandlers(() => main);
});

const REQUEST = {
  projectId: 'project',
  worktreeId: 'task',
  cols: 80,
  rows: 24,
};

describe('terminal:spawn and terminal:restore default daemon placement (CAN-5718)', () => {
  it.each([
    ['no saved choice', {}, true],
    ['saved false choice', { 'daemon-terminals': false }, true],
    ['Labs unready', { 'daemon-terminals': false }, false],
  ] as const)(
    'keeps spawn, persisted history and Labs retirement with %s',
    async (_label, choices, ready) => {
      mockState.labs = labs(choices, ready);
      registerLabsExperimentsHandlers();
      const snapshot = mockState.labs.getSnapshot();
      expect(snapshot.ready).toBe(ready);
      expect(snapshot.earlyAccessEnabled).toBe(false);
      const retiredExperimentMatcher: unknown = expect.not.arrayContaining([
        expect.objectContaining({ id: 'daemon-terminals' }),
      ]);
      await expect(
        invoke(IPC_CHANNELS.experimentsGetSnapshot),
      ).resolves.toMatchObject({
        experiments: retiredExperimentMatcher,
      });
      await expect(
        invoke(IPC_CHANNELS.experimentsSetChoice, {
          experimentId: 'daemon-terminals',
          enabled: true,
        }),
      ).rejects.toMatchObject({
        name: 'CanopyIpcAppError',
        cause: { code: 'invalid_payload', message: 'Unknown experiment.' },
      });
      await expect(
        invoke(IPC_CHANNELS.terminalSpawn, REQUEST),
      ).resolves.toMatchObject({ id: 'daemon-1' });
      expect([...mockState.hosted.keys()]).toEqual(['daemon-1']);
      // Reattachment does not move an already live session, even for an excluded caller.
      await expect(
        invoke(
          IPC_CHANNELS.terminalRestore,
          { terminalId: 'daemon-1', cols: 100, rows: 30 },
          foreign,
        ),
      ).resolves.toMatchObject({ id: 'daemon-1' });
      expect([...mockState.hosted.keys()]).toEqual(['daemon-1']);
      expect(mockState.restored.size).toBe(0);
      mockState.persisted.set('saved', {
        session: {
          id: 'saved',
          projectId: 'project',
          worktreeId: 'task',
          shell: '/bin/sh',
          shellBasename: 'sh',
          cwd: mockState.root,
          createdAt: 1,
        },
        scrollbackLines: ['previous output'],
        exitCode: null,
        signal: null,
      });
      await expect(
        invoke(IPC_CHANNELS.terminalRestore, {
          terminalId: 'saved',
          cols: 80,
          rows: 24,
        }),
      ).resolves.toMatchObject({ id: 'saved' });
      expect(mockState.restored.get('saved')).toBe('previous output');
      expect(mockState.daemon?.replayText('saved')).toContain(
        'previous output',
      );
      expect([...mockState.local.keys()]).toEqual([]);
    },
  );

  it('keeps a non-local window on the existing engine', async () => {
    await expect(
      invoke(IPC_CHANNELS.terminalSpawn, REQUEST, foreign),
    ).resolves.toMatchObject({ id: 'engine-1' });
    expect([...mockState.local.keys()]).toEqual(['engine-1']);
    expect([...mockState.hosted.keys()]).toEqual([]);
  });

  it.each([
    [
      'unreachable',
      (): unknown => markUnreachable(new Error('setup failed'), 'start_failed'),
    ],
    [
      'definitive unavailable',
      (): Error =>
        Object.assign(new Error('host unavailable'), {
          payload: { kind: 'unavailable', retry: { kind: 'never' } },
        }),
    ],
  ])('falls back only after %s', async (_label, error) => {
    const failure = error();
    if (!(failure instanceof Error)) {
      throw new Error('Fallback fixture must return an Error');
    }
    mockState.failure = failure;
    await expect(
      invoke(IPC_CHANNELS.terminalSpawn, REQUEST),
    ).resolves.toMatchObject({ id: 'engine-1' });
    expect([...mockState.local.keys()]).toEqual(['engine-1']);
    expect([...mockState.hosted.keys()]).toEqual([]);
  });

  it.each([
    ['uncertain keyed create', 'unavailable', 'same_idempotency_key'],
    ['reached-daemon refusal', 'invalid_argument', 'never'],
  ])('does not start a duplicate on %s', async (_label, kind, retry) => {
    mockState.failureAfterCreate = retry === 'same_idempotency_key';
    mockState.failure = Object.assign(new Error('refused'), {
      payload: { kind, retry: { kind: retry } },
    });
    // This source-route assertion inspects the cause; boundary restoration is
    // qualified separately below, without bypassing the carrier.
    await expect(
      invoke(IPC_CHANNELS.terminalSpawn, REQUEST),
    ).rejects.toMatchObject({
      name: 'CanopyIpcAppError',
      cause: mockState.failure,
    });
    expect([...mockState.local.keys()]).toEqual([]);
    expect(mockState.hosted.size).toBe(mockState.failureAfterCreate ? 1 : 0);
  });
});

// CAN-5115: qualify the real registration wrapper and the appErrors.resolve
// transport contract as well as the source route.
// String(error) below models the wrapper proven in real Electron scratch evidence.
test('IPC records before settlement, restores lookup, and fails closed under stable policy', async () => {
  const callbacks = new Map<string, Parameters<typeof ipcMain.handle>[1]>();
  jest.spyOn(ipcMain, 'handle').mockImplementation((channel, handler) => {
    callbacks.set(channel, handler);
  });
  jest.spyOn(appErrorPolicy, 'ipcShowsRawErrorDetail').mockReturnValue(false);
  const report = jest.spyOn(appErrorRecording, 'reportMainAppError');
  const original = new Error('private diagnostic');
  registerIpcHandler('terminal:spawn', () => Promise.reject(original));
  const callback = callbacks.get('terminal:spawn');
  if (!callback) throw new Error('Missing real registration');
  const event: IpcMainInvokeEvent = {
    sender: new BrowserWindow().webContents,
    senderFrame: null,
    frameId: 1,
    processId: 1,
    type: 'frame',
    preventDefault: () => undefined,
    defaultPrevented: false,
  };
  const rejection: unknown = await Promise.resolve(callback(event)).catch(
    (error: unknown) => error,
  );
  expect(rejection).toBeInstanceOf(IpcAppErrorRejection);
  expect(report).toHaveBeenCalledTimes(1);
  if (!(rejection instanceof IpcAppErrorRejection))
    throw new Error('Missing carrier');
  expect(rejection.cause).toBe(original);
  const wrapper = formatIpcLegacyError('terminal:spawn', String(rejection));
  const decoded = decodeIpcAppError(wrapper);
  const shape = AppErrorSchema.parse(decoded?.appError);
  expect(shape).toMatchObject({
    kind: 'defect',
    recordedBy: 'main',
    detail: { message: 'app.unexpected' },
  });
  expect(shape.detail.stack).toBeUndefined();
  expect(wrapper).not.toContain('private diagnostic');
  let restored: Error | undefined;
  try {
    restoreIpcAppError(new Error(wrapper));
  } catch (error) {
    if (error instanceof Error) restored = error;
  }
  expect(restored?.message).toBe(
    formatIpcLegacyError('terminal:spawn', decoded?.legacy ?? ''),
  );
  expect(resolveIpcAppError(restored?.message)).toEqual(shape);
  report.mockImplementation(() => {
    throw new Error('sink failure');
  });
  const failedReport: unknown = await Promise.resolve(callback(event)).catch(
    (error: unknown) => error,
  );
  const unrecorded = AppErrorSchema.parse(
    decodeIpcAppError(
      formatIpcLegacyError('terminal:spawn', String(failedReport)),
    )?.appError,
  );
  expect(unrecorded.recordedBy).toBeUndefined();
  expect(unrecorded.detail).toEqual({ message: 'app.unexpected' });
  jest.restoreAllMocks();
});
