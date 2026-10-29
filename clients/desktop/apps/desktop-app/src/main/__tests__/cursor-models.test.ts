import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import {
  discoverCursorModels,
  listCursorModels,
  invalidateCursorModels,
} from '../cursor/models';
import { getManagedCursorRuntime } from '../cursor/connection';
import { cursorConnectionStatus } from '../cursor/runtime-status';
import {
  runCursorRuntimeCommand,
  stopCursorProcessGroup,
} from '@canopy/desktop-shared/node/cursor/runtime-process';
import { rm } from 'node:fs/promises';

const mockNewSession = jest.fn(() =>
  Promise.resolve({
    sessionId: 'discovery',
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'default[]',
        options: [
          { value: 'default[]', name: 'Auto' },
          { value: 'gpt-test[effort=high]', name: 'GPT Test' },
        ],
      },
    ],
  }),
);
const mockClose = jest.fn();
const mockAuthenticate = jest.fn(() => Promise.resolve({}));
const mockExtMethod = jest.fn<Promise<unknown>, [string, unknown]>(() =>
  Promise.resolve({
    models: [
      { value: 'default', name: 'Auto', configOptions: [] },
      {
        value: 'gpt-test',
        name: 'GPT-5 Test',
        configOptions: [
          {
            id: 'effort',
            name: 'Effort',
            category: 'thought_level',
            type: 'select',
            currentValue: 'high',
            options: [
              { value: 'low', name: 'Low' },
              { value: 'high', name: 'High' },
            ],
          },
        ],
      },
    ],
  }),
);
jest.mock('@canopy/desktop-shared/node/acp', () => ({
  connectAcp: jest.fn(() =>
    Promise.resolve({
      getInitialization: () => ({ authMethods: [{ id: 'cursor_login' }] }),
      newSession: mockNewSession,
      authenticate: mockAuthenticate,
      extMethod: mockExtMethod,
      close: mockClose,
    }),
  ),
}));
const mockRecordAppDiagnostic = jest.fn();
jest.mock('../observability', () => ({
  getObservabilityService: (): { recordAppDiagnostic: jest.Mock } => ({
    recordAppDiagnostic: mockRecordAppDiagnostic,
  }),
}));
jest.mock('../cursor/connection', () => ({
  getManagedCursorRuntime: jest.fn(() =>
    Promise.resolve({
      launch: {
        command: '/verified/node',
        prefix: ['/verified/index.js'],
      },
      // Connect signs in against this profile. On Windows the CLI keeps that
      // sign-in in `%APPDATA%\Cursor\auth.json`, so the key stands in for
      // every credential the shared profile carries.
      env: { PATH: '/managed', APPDATA: '/managed/state/home/AppData/Roaming' },
    }),
  ),
}));
jest.mock('../cursor/runtime-status', () => ({
  cursorConnectionStatus: jest.fn(() =>
    Promise.resolve({ enabled: true, installed: true, supported: true }),
  ),
}));
jest.mock('@canopy/desktop-shared/node/cursor/runtime-process', () => ({
  runCursorRuntimeCommand: jest.fn(() =>
    Promise.resolve({ code: 0, stdout: '{"isAuthenticated":true}' }),
  ),
  stopCursorProcessGroup: jest.fn(() => Promise.resolve()),
}));
jest.mock('node:fs/promises', () => ({
  mkdtemp: jest.fn(() => Promise.resolve('/model-discovery')),
  rm: jest.fn(() => Promise.resolve()),
}));
jest.mock('node:child_process', () => ({
  spawn: jest.fn(() =>
    Object.assign(new EventEmitter(), {
      pid: 12345,
      stdout: new PassThrough(),
      stdin: new PassThrough(),
      stderr: new PassThrough(),
    }),
  ),
}));
afterEach(async () => {
  await invalidateCursorModels();
  jest.clearAllMocks();
});

test('discovers ACP models from a verified private runtime without prompting', async () => {
  const models = await discoverCursorModels(AbortSignal.timeout(5000));
  expect(models).toEqual([
    {
      id: 'cursor-default',
      rawModelId: 'default[]',
      label: 'Cursor default',
      supportedThinkingLevels: [],
    },
    {
      id: 'cursor:gpt-test%5Beffort%3Dhigh%5D',
      rawModelId: 'gpt-test[effort=high]',
      label: 'GPT Test',
      supportedThinkingLevels: ['low', 'high'],
      catalogName: 'GPT 5 Test',
    },
  ]);
  expect(mockExtMethod).toHaveBeenCalledWith(
    'cursor/list_available_models',
    {},
    expect.any(AbortSignal),
    5000,
  );
  expect(getManagedCursorRuntime).toHaveBeenCalled();
  expect(runCursorRuntimeCommand).toHaveBeenCalledWith(
    {
      command: '/verified/node',
      prefix: ['/verified/index.js'],
    },
    ['status', '--format', 'json'],
    expect.any(Object),
    expect.any(AbortSignal),
  );
  expect(spawn).toHaveBeenCalledWith(
    '/verified/node',
    ['/verified/index.js', '--disable-auto-update', 'acp'],
    expect.objectContaining({
      cwd: '/model-discovery',
      // Not `process.platform !== 'win32'`: that is the implementation's own
      // expression, so it would assert true === true on every CI host. The
      // Windows branch is pinned separately below.
      detached: true,
      windowsHide: true,
    }),
  );
  expect(mockNewSession).toHaveBeenCalledWith({
    cwd: '/model-discovery',
    mcpServers: [],
  });
  expect(mockClose).toHaveBeenCalled();
  expect(stopCursorProcessGroup).toHaveBeenCalled();
  expect(rm).toHaveBeenCalledWith('/model-discovery', {
    recursive: true,
    force: true,
  });
});

test('discovers inside the managed sign-in profile with a throwaway HOME', async () => {
  // macOS reaches the Keychain from any HOME, which hid this: a discovery
  // profile built from scratch under the temp directory has no APPDATA
  // credential file, so on Windows `status` reported signed out and the
  // picker emptied right after Connect. Discovery must run in the same
  // managed profile as Connect and swap only HOME for a private overlay that
  // dies with the temp directory.
  await discoverCursorModels(AbortSignal.timeout(5000));
  // This call shape is what pins the regression: the old code asked for the
  // runtime with no overlay and then rebuilt a profile under the temp
  // directory. The state overlay keeps the CLI's session records and
  // per-project worker state in the temp directory as well, so a run leaves
  // nothing behind in the shared profile.
  expect(getManagedCursorRuntime).toHaveBeenCalledWith(
    expect.any(AbortSignal),
    undefined,
    {
      homeOverlay: '/model-discovery/home',
      stateOverlay: '/model-discovery/state',
    },
  );
  // The checks below only prove that discovery forwards the managed
  // environment unchanged. The win32 rule that APPDATA stays at the shared
  // home when overlays are set is covered in runtime-environment.test.ts.
  expect(runCursorRuntimeCommand).toHaveBeenCalledWith(
    expect.any(Object),
    ['status', '--format', 'json'],
    expect.objectContaining({
      APPDATA: '/managed/state/home/AppData/Roaming',
    }),
    expect.any(AbortSignal),
  );
  const [, , spawnOptions] = jest.mocked(spawn).mock.calls[0] ?? [];
  expect(spawnOptions).toMatchObject({
    env: { APPDATA: '/managed/state/home/AppData/Roaming' },
  });
});

test('keeps the catalog when the runtime cannot list per-model options', async () => {
  mockExtMethod.mockRejectedValueOnce(new Error('Method not found'));
  const models = await discoverCursorModels(AbortSignal.timeout(5000));
  expect(mockRecordAppDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'cursor_model_listing_unavailable',
      reason: 'cursor/list_available_models: Method not found',
    }),
  );
  expect(models).toEqual([
    { id: 'cursor-default', rawModelId: 'default[]', label: 'Cursor default' },
    {
      id: 'cursor:gpt-test%5Beffort%3Dhigh%5D',
      rawModelId: 'gpt-test[effort=high]',
      label: 'GPT Test',
    },
  ]);
  mockExtMethod.mockResolvedValueOnce({ models: 'malformed' });
  expect(
    (await discoverCursorModels(AbortSignal.timeout(5000)))[1],
  ).not.toHaveProperty('supportedThinkingLevels');
});

test('deduplicates concurrent discovery and returns defensive cached copies', async () => {
  const [first, second] = await Promise.all([
    listCursorModels(),
    listCursorModels(),
  ]);
  expect(mockNewSession).toHaveBeenCalledTimes(1);
  first[1].label = 'changed';
  expect(second[1].label).toBe('GPT Test');
  expect((await listCursorModels())[1].label).toBe('GPT Test');
  expect(mockNewSession).toHaveBeenCalledTimes(1);
});

test('invalidates cache on disconnect and rediscovers when reconnected', async () => {
  await listCursorModels();
  jest.mocked(cursorConnectionStatus).mockResolvedValueOnce({
    enabled: false,
    installed: true,
    supported: true,
    phase: 'idle',
    version: 'test',
  });
  expect(await listCursorModels()).toEqual([]);
  await listCursorModels();
  expect(mockNewSession).toHaveBeenCalledTimes(2);
});

test('does not launch ACP sign-in from the picker for a signed-out account', async () => {
  jest
    .mocked(runCursorRuntimeCommand)
    .mockResolvedValueOnce({ code: 0, stdout: '{"isAuthenticated":false}' });
  await expect(listCursorModels()).rejects.toThrow('Reconnect Cursor');
  expect(spawn).not.toHaveBeenCalled();
  expect(mockAuthenticate).not.toHaveBeenCalled();
  expect(rm).toHaveBeenCalled();
  await listCursorModels();
  expect(mockNewSession).toHaveBeenCalledTimes(1);
});

test('drains cancelled discovery, discards late metadata, and permits retry', async () => {
  const normal = await mockNewSession();
  mockNewSession.mockClear();
  let release: (value: typeof normal) => void = () => {};
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  mockNewSession.mockImplementationOnce(() => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const loading = listCursorModels();
  const rejected = expect(loading).rejects.toThrow();
  await started;
  const stopped = invalidateCursorModels();
  expect(mockClose).toHaveBeenCalled();
  release(normal);
  await stopped;
  await rejected;
  expect(rm).toHaveBeenCalled();
  await listCursorModels();
  expect(mockNewSession).toHaveBeenCalledTimes(2);
});

test('refreshes expired metadata on the next request', async () => {
  await listCursorModels();
  const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
  try {
    await listCursorModels();
    expect(mockNewSession).toHaveBeenCalledTimes(2);
  } finally {
    now.mockRestore();
  }
});

test('sanitizes malformed authentication output and cleans temporary state', async () => {
  jest
    .mocked(runCursorRuntimeCommand)
    .mockResolvedValueOnce({ code: 1, stdout: 'SECRET malformed' });
  await expect(listCursorModels()).rejects.toThrow('Reconnect Cursor');
  expect(spawn).not.toHaveBeenCalled();
  expect(rm).toHaveBeenCalled();
});

test('Windows discovery spawns without a process group and without a console window', async () => {
  // Windows has no process groups, and Electron main is a GUI process, so the
  // console-subsystem node.exe would otherwise flash a window. Neither fact is
  // observable on a macOS or Linux runner without pinning the platform.
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: 'win32',
  });
  try {
    await invalidateCursorModels();
    jest.mocked(spawn).mockClear();
    await discoverCursorModels(AbortSignal.timeout(5000));
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ detached: false, windowsHide: true }),
    );
  } finally {
    if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
  }
});
