/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  listOpenCodeModels,
  assertOpenCodeModelAvailable,
  assertOpenCodeRuntimeModelAvailable,
  revokeOpenCodeRuntimes,
  disconnectOpenCode,
  connectOpenCode,
  openManagedOpenCodeRuntime,
  assertOpenCodeConnectionGeneration,
  refreshOpenCodeAccounts,
  opencodeConnectionStatus,
} from '../opencode/connection';
import { peekOpenCodeAccounts } from '../opencode/account-information';
import {
  beginOpenCodeAvailabilityProbe,
  peekOpenCodeRuntimeAvailability,
} from '../opencode/runtime-availability';
import {
  getOpenCodeModelEntries,
  initAgentModels,
} from '@canopy/desktop-shared/types';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

const mockBroadcastPreferencesChanged = jest.fn<void, []>();
jest.mock('../lib/preferences-broadcast', () => ({
  broadcastPreferencesChanged: () => mockBroadcastPreferencesChanged(),
}));

let mockRolloutEnabled = true;
let mockSnapshotChanged: (() => void) | undefined;
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: () => ({
    onSnapshotChanged: (callback: () => void) => {
      mockSnapshotChanged = callback;
      return () => undefined;
    },
  }),
}));
jest.mock('../opencode/feature-flag', () => ({
  isOpenCodeHarnessEnabled: () => mockRolloutEnabled,
  assertOpenCodeHarnessEnabled: () => {
    if (!mockRolloutEnabled) throw new Error('OpenCode is unavailable.');
  },
}));
const mockPreferences = { opencodeEnabled: true, colorMode: 'light' };
let mockEnabledRevision = 0;
const mockVerify = jest.fn(() => Promise.resolve('/verified/opencode'));
const mockInstall = jest.fn(() => Promise.resolve('/verified/opencode'));
const mockIsInstalled = jest.fn(() => Promise.resolve(true));
const mockClose = jest.fn(() => Promise.resolve());
const mockDeleteSession = jest.fn<Promise<Record<string, never>>, [string]>(
  () => Promise.resolve({}),
);
const applyPreferences = (
  update: (value: typeof mockPreferences) => typeof mockPreferences | null,
  onCommitted?: (value: typeof mockPreferences) => void,
) => {
  const next = update(mockPreferences);
  if (next === null) return Promise.resolve();
  if (next.opencodeEnabled !== mockPreferences.opencodeEnabled)
    mockEnabledRevision++;
  Object.assign(mockPreferences, next);
  onCommitted?.(mockPreferences);
  return Promise.resolve();
};
const mockUpdatePreferences = jest.fn(applyPreferences);
let releaseDiscovery: (() => void) | undefined;
let discoveryStarted: (() => void) | undefined;
let started: Promise<void>;
let held: Promise<void>;
interface DiscoveryOptions {
  signal: AbortSignal;
  env: NodeJS.ProcessEnv;
  cwd: string;
  profileDir: string;
  providerConfig: Record<string, unknown>;
}
const mockNewSession = jest.fn<
  void,
  [{ cwd: string; mcpServers: unknown[] }]
>();
const mockReadMetadata = jest.fn((url: string): Promise<unknown> => {
  void url;
  return Promise.resolve(undefined);
});
const mockStart = jest.fn((options: DiscoveryOptions) => {
  discoveryStarted?.();
  return Promise.resolve({
    client: {
      deleteSession: mockDeleteSession,
      newSession: async (request: { cwd: string; mcpServers: unknown[] }) => {
        mockNewSession(request);
        await new Promise<void>((resolve, reject) => {
          const abort = (): void => reject(new Error('revoked'));
          options.signal.addEventListener('abort', abort, { once: true });
          void held.then(() => {
            options.signal.removeEventListener('abort', abort);
            resolve();
          });
          if (options.signal.aborted) abort();
        });
        const model =
          options.env.PIPELINE_ONLY_PROVIDER === 'enabled'
            ? 'pipeline/only'
            : 'fixture/model';
        return {
          sessionId: 'discovery',
          configOptions: [
            {
              id: 'model',
              type: 'select',
              currentValue: model,
              options: [{ value: model, name: 'Fixture' }],
            },
          ],
        };
      },
    },
    assertApprovalReady: (): void => undefined,
    readMetadata: mockReadMetadata,
    close: mockClose,
  });
});
jest.mock('@canopy/desktop-shared/node/opencode/runtime-metadata', () => ({
  OPENCODE_RUNTIME_VERSION: 'fixture',
  opencodeExecutableName: () => 'opencode',
  getOpenCodeRuntimeArtifact: () => ({
    version: 'fixture',
    url: 'https://example.test',
    integrity: 'sha512-fixture',
    executableSha256: '0'.repeat(64),
    archiveBytes: 1,
  }),
}));
jest.mock('../opencode/runtime-installer', () => ({
  OpenCodeRuntimeInstaller: jest.fn(() => ({
    verify: mockVerify,
    install: mockInstall,
    isInstalled: () => mockIsInstalled(),
  })),
}));
jest.mock('../pipelines/config-paths', () => ({ getEnhancedEnv: () => ({}) }));
jest.mock('@canopy/desktop-shared/pipelines/config-paths', () => ({
  getOpenCodeRuntimeRootDir: () => '/fixture/runtime',
  getOpenCodeRuntimeStateDir: () => '/fixture/state',
}));
jest.mock('@canopy/desktop-shared/node/opencode/provider-config', () => ({
  readOpenCodeProviderConfig: () => Promise.resolve({}),
}));
jest.mock('@canopy/desktop-shared/node/opencode/runtime', () => ({
  startOpenCodeRuntime: (options: DiscoveryOptions) => mockStart(options),
}));
jest.mock('../lib/preferences-store', () => ({
  getOpenCodeEnabledRevision: () => mockEnabledRevision,
  readPreferencesFile: () => Promise.resolve({ ...mockPreferences }),
  updatePreferencesFile: (
    update: (value: typeof mockPreferences) => typeof mockPreferences | null,
    onCommitted?: (value: typeof mockPreferences) => void,
  ) => {
    return mockUpdatePreferences(update, onCommitted);
  },
}));

beforeEach(async () => {
  initAgentModels([]);
  mockRolloutEnabled = true;
  await revokeOpenCodeRuntimes();
  mockPreferences.opencodeEnabled = true;
  jest.clearAllMocks();
  mockReadMetadata.mockReset().mockResolvedValue(undefined);
  mockUpdatePreferences.mockReset().mockImplementation(applyPreferences);
  mockClose.mockReset().mockResolvedValue(undefined);
  mockDeleteSession.mockReset().mockResolvedValue({});
  mockIsInstalled.mockReset().mockResolvedValue(true);
  started = new Promise((resolve) => {
    discoveryStarted = resolve;
  });
  held = new Promise((resolve) => {
    releaseDiscovery = resolve;
  });
});
afterEach(async () => {
  initAgentModels([]);
  releaseDiscovery?.();
  await revokeOpenCodeRuntimes();
});

it.each(['catalog', 'preflight', 'metadata-error'])(
  'deletes the native discovery session before teardown for %s',
  async (mode) => {
    releaseDiscovery?.();
    if (mode === 'metadata-error')
      mockReadMetadata.mockRejectedValueOnce(new Error('metadata failed'));
    if (mode === 'preflight') {
      const managed = await openManagedOpenCodeRuntime({
        signal: new AbortController().signal,
      });
      try {
        await assertOpenCodeRuntimeModelAvailable(
          'opencode:fixture%2Fmodel',
          managed,
          '/workspace',
        );
      } finally {
        await managed.close();
      }
    } else if (mode === 'metadata-error') {
      await expect(
        listOpenCodeModels(new AbortController().signal),
      ).rejects.toThrow('metadata failed');
    } else {
      await listOpenCodeModels(new AbortController().signal);
    }
    expect(mockDeleteSession).toHaveBeenCalledWith('discovery');
    expect(mockDeleteSession.mock.invocationCallOrder[0]).toBeLessThan(
      mockClose.mock.invocationCallOrder[0],
    );
  },
);

it('closes the runtime and does not publish models if native session deletion fails', async () => {
  releaseDiscovery?.();
  mockDeleteSession.mockRejectedValueOnce(new Error('delete failed'));
  await expect(
    listOpenCodeModels(new AbortController().signal),
  ).rejects.toThrow('delete failed');
  expect(mockClose).toHaveBeenCalledTimes(1);
  expect(getOpenCodeModelEntries()).toEqual([]);
});

it('deletes a created native discovery session even after caller cancellation', async () => {
  const abort = new AbortController();
  releaseDiscovery?.();
  mockReadMetadata.mockImplementationOnce(() => {
    abort.abort();
    return Promise.resolve(undefined);
  });
  const managed = await openManagedOpenCodeRuntime({ signal: abort.signal });
  try {
    await expect(
      assertOpenCodeRuntimeModelAvailable(
        'opencode:fixture%2Fmodel',
        managed,
        '/workspace',
      ),
    ).rejects.toThrow('aborted');
    expect(mockDeleteSession).toHaveBeenCalledWith('discovery');
    expect(mockStart.mock.calls[0]?.[0].signal.aborted).toBe(false);
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(getOpenCodeModelEntries()).toEqual([]);
  } finally {
    await managed.close();
  }
});

it('one cancelled model caller does not cancel another subscriber', async () => {
  const firstAbort = new AbortController();
  const first = listOpenCodeModels(firstAbort.signal);
  const second = listOpenCodeModels(new AbortController().signal);
  await started;
  firstAbort.abort();
  await expect(first).rejects.toThrow('cancelled');
  releaseDiscovery?.();
  await expect(second).resolves.toMatchObject([
    { id: 'opencode:fixture%2Fmodel' },
  ]);
  expect(mockStart).toHaveBeenCalledTimes(1);
  expect(mockClose).toHaveBeenCalledTimes(1);
});

it('disconnect aborts discovery and cannot publish stale enabled models', async () => {
  const pending = listOpenCodeModels(new AbortController().signal);
  const rejected = expect(pending).rejects.toThrow();
  await started;
  const disconnected = disconnectOpenCode();
  releaseDiscovery?.();
  await disconnected;
  await rejected;
  expect(mockPreferences.opencodeEnabled).toBe(false);
  expect(await listOpenCodeModels(new AbortController().signal)).toEqual([]);
  await expect(
    openManagedOpenCodeRuntime({ signal: new AbortController().signal }),
  ).rejects.toThrow('Connect OpenCode');
});

it('setup cancelled during discovery never turns on the preference', async () => {
  mockPreferences.opencodeEnabled = false;
  const abort = new AbortController();
  const connecting = connectOpenCode(abort.signal, () => undefined);
  const rejected = expect(connecting).rejects.toThrow();
  await started;
  abort.abort();
  releaseDiscovery?.();
  await rejected;
  expect(mockPreferences.opencodeEnabled).toBe(false);
  expect(mockClose).toHaveBeenCalledTimes(1);
});

it('setup cancellation during discovery teardown never publishes models', async () => {
  const abort = new AbortController();
  mockClose.mockImplementationOnce(() => {
    abort.abort();
    return Promise.resolve();
  });
  releaseDiscovery?.();
  await expect(
    connectOpenCode(abort.signal, () => undefined),
  ).rejects.toThrow();
  expect(mockPreferences.opencodeEnabled).toBe(false);
  expect(getOpenCodeModelEntries()).toEqual([]);
});

it('a failed final preference write never publishes the discovered catalog', async () => {
  mockUpdatePreferences
    .mockImplementationOnce(applyPreferences)
    .mockRejectedValueOnce(new Error('write failed'));
  releaseDiscovery?.();
  await expect(
    connectOpenCode(new AbortController().signal, () => undefined),
  ).rejects.toThrow('write failed');
  expect(mockPreferences.opencodeEnabled).toBe(false);
  expect(getOpenCodeModelEntries()).toEqual([]);
});

it.each(['queued', 'committing'])(
  'setup cancellation while the enabling write is %s keeps OpenCode disabled',
  async (phase) => {
    const abort = new AbortController();
    mockUpdatePreferences
      .mockImplementationOnce(applyPreferences)
      .mockImplementationOnce(async (update, onCommitted) => {
        if (phase === 'queued') abort.abort();
        await applyPreferences(update, onCommitted);
        if (phase === 'committing') abort.abort();
      });
    releaseDiscovery?.();
    await expect(
      connectOpenCode(abort.signal, () => undefined),
    ).rejects.toThrow();
    expect(mockPreferences.opencodeEnabled).toBe(false);
    expect(getOpenCodeModelEntries()).toEqual([]);
  },
);

it('successful setup publishes models after the enabled preference is committed', async () => {
  mockUpdatePreferences
    .mockImplementationOnce(applyPreferences)
    .mockImplementationOnce(async (update, onCommitted) => {
      expect(getOpenCodeModelEntries()).toEqual([]);
      await applyPreferences(update, onCommitted);
    });
  releaseDiscovery?.();
  await expect(
    connectOpenCode(new AbortController().signal, () => undefined),
  ).resolves.toMatchObject({ phase: 'connected' });
  expect(getOpenCodeModelEntries()).toEqual([
    expect.objectContaining({ id: 'opencode:fixture%2Fmodel' }),
  ]);
});

it('publishes connected availability for Portal without another status request', async () => {
  mockPreferences.opencodeEnabled = false;
  const pending = connectOpenCode(
    new AbortController().signal,
    () => undefined,
  );
  await started;
  expect(peekOpenCodeRuntimeAvailability()).toBe(false);
  const staleProbe = beginOpenCodeAvailabilityProbe();
  releaseDiscovery?.();
  await expect(pending).resolves.toMatchObject({
    enabled: true,
    phase: 'connected',
  });
  expect(peekOpenCodeRuntimeAvailability()).toBe(true);
  staleProbe(false);
  expect(peekOpenCodeRuntimeAvailability()).toBe(true);
  await disconnectOpenCode();
  expect(peekOpenCodeRuntimeAvailability()).toBe(false);
});

it('disabled rollout refuses setup and every managed launch while preserving the preference', async () => {
  mockRolloutEnabled = false;
  releaseDiscovery?.();
  const signal = new AbortController().signal;
  await expect(connectOpenCode(signal, () => undefined)).rejects.toThrow(
    'unavailable',
  );
  await expect(
    openManagedOpenCodeRuntime({ signal, requireEnabled: false }),
  ).rejects.toThrow('unavailable');
  expect(await listOpenCodeModels(signal)).toEqual([]);
  expect(mockInstall).not.toHaveBeenCalled();
  expect(mockVerify).not.toHaveBeenCalled();
  expect(mockPreferences.opencodeEnabled).toBe(true);
});

it('a live rollout disable revokes open generations without disconnecting native accounts', async () => {
  const managed = await openManagedOpenCodeRuntime({
    signal: new AbortController().signal,
  });
  try {
    mockRolloutEnabled = false;
    mockSnapshotChanged?.();
    expect(managed.signal.aborted).toBe(true);
  } finally {
    await managed.close();
  }
  expect(() =>
    assertOpenCodeConnectionGeneration(managed.generation),
  ).toThrow();
  expect(mockPreferences.opencodeEnabled).toBe(true);
});

it('disabling rollout during setup aborts discovery before it enables the preference', async () => {
  mockPreferences.opencodeEnabled = false;
  const pending = connectOpenCode(
    new AbortController().signal,
    () => undefined,
  );
  const rejected = expect(pending).rejects.toThrow();
  await started;
  mockRolloutEnabled = false;
  mockSnapshotChanged?.();
  releaseDiscovery?.();
  await rejected;
  expect(mockPreferences.opencodeEnabled).toBe(false);
});

it('rollout revocation during the enabling commit rolls back setup', async () => {
  mockPreferences.opencodeEnabled = false;
  mockUpdatePreferences
    .mockImplementationOnce(applyPreferences)
    .mockImplementationOnce(async (update, onCommitted) => {
      await applyPreferences(update, onCommitted);
      mockRolloutEnabled = false;
      mockSnapshotChanged?.();
    });
  releaseDiscovery?.();
  await expect(
    connectOpenCode(new AbortController().signal, () => undefined),
  ).rejects.toThrow();
  expect(mockPreferences.opencodeEnabled).toBe(false);
  expect(getOpenCodeModelEntries()).toEqual([]);
  mockRolloutEnabled = true;
  expect(await listOpenCodeModels(new AbortController().signal)).toEqual([]);
});

it.each([false, true])(
  'notifies an already-mounted preference subscriber after connection change from %s',
  async (initiallyConnected) => {
    mockPreferences.opencodeEnabled = initiallyConnected;
    let subscriberEnabled = initiallyConnected;
    mockBroadcastPreferencesChanged.mockImplementation(() => {
      subscriberEnabled = mockPreferences.opencodeEnabled;
    });
    releaseDiscovery?.();
    if (initiallyConnected) await disconnectOpenCode();
    else await connectOpenCode(new AbortController().signal, () => undefined);
    expect(mockPreferences.opencodeEnabled).toBe(!initiallyConnected);
    expect(subscriberEnabled).toBe(!initiallyConnected);
  },
);

it('cancelled setup preserves a later disable and re-enable preference commit', async () => {
  const abort = new AbortController();
  mockUpdatePreferences
    .mockImplementationOnce(applyPreferences)
    .mockImplementationOnce(async (update, onCommitted) => {
      await applyPreferences(update, onCommitted);
      await applyPreferences((value) => ({ ...value, opencodeEnabled: false }));
      await applyPreferences((value) => ({ ...value, opencodeEnabled: true }));
      abort.abort();
    });
  releaseDiscovery?.();
  await expect(
    connectOpenCode(abort.signal, () => undefined),
  ).rejects.toThrow();
  expect(mockPreferences.opencodeEnabled).toBe(true);
  expect(getOpenCodeModelEntries()).toEqual([]);
});

it('rollout rollback survives an unrelated preference write and preserves that write', async () => {
  mockPreferences.colorMode = 'light';
  mockUpdatePreferences
    .mockImplementationOnce(applyPreferences)
    .mockImplementationOnce(async (update, onCommitted) => {
      await applyPreferences(update, onCommitted);
      await applyPreferences((value) => ({ ...value, colorMode: 'dark' }));
      mockRolloutEnabled = false;
      mockSnapshotChanged?.();
    });
  releaseDiscovery?.();
  await expect(
    connectOpenCode(new AbortController().signal, () => undefined),
  ).rejects.toThrow();
  expect(mockPreferences).toMatchObject({
    opencodeEnabled: false,
    colorMode: 'dark',
  });
});

it('cancellation during the final status read rolls back this setup enablement', async () => {
  mockPreferences.opencodeEnabled = false;
  const controller = new AbortController();
  mockIsInstalled.mockImplementation(() => {
    if (mockPreferences.opencodeEnabled) controller.abort();
    return Promise.resolve(true);
  });
  releaseDiscovery?.();
  await expect(
    connectOpenCode(controller.signal, () => undefined),
  ).rejects.toThrow();
  expect(mockPreferences.opencodeEnabled).toBe(false);
  expect(getOpenCodeModelEntries()).toEqual([]);
  expect(peekOpenCodeRuntimeAvailability()).toBe(false);
});

it('checks a registered OpenCode Agent against its provider model', async () => {
  releaseDiscovery?.();
  await listOpenCodeModels(new AbortController().signal);
  initAgentModels([
    {
      id: 'agent_model_opencode',
      name: 'OpenCode Agent',
      baseModel: 'opencode:fixture%2Fmodel',
      instructions: '',
      createdAt: '',
      updatedAt: '',
      available: true,
    },
  ]);
  await expect(
    assertOpenCodeModelAvailable('agent_model_opencode'),
  ).resolves.toMatchObject({ id: 'opencode:fixture%2Fmodel' });
});
it.each([
  'agent_model_missing',
  'agent_model_stale',
  'agent_model_other_harness',
])('rejects unavailable Agent %s', async (model) => {
  releaseDiscovery?.();
  await listOpenCodeModels(new AbortController().signal);
  initAgentModels([
    {
      id: 'agent_model_stale',
      name: 'Stale',
      baseModel: 'opencode:fixture%2Fmissing',
      instructions: '',
      createdAt: '',
      updatedAt: '',
      available: false,
    },
    {
      id: 'agent_model_other_harness',
      name: 'Other',
      baseModel: 'claude-sonnet-4-6',
      instructions: '',
      createdAt: '',
      updatedAt: '',
      available: true,
    },
  ]);
  await expect(assertOpenCodeModelAvailable(model)).rejects.toThrow(
    'unavailable',
  );
});

it('discovers pipeline-only models with the caller context without changing the global cache', async () => {
  releaseDiscovery?.();
  mockReadMetadata.mockImplementation((url) =>
    Promise.resolve(url === '/accounts' ? accountMetadata : undefined),
  );
  const signal = new AbortController().signal;
  const globalModels = await listOpenCodeModels(signal);
  const globalAccounts = peekOpenCodeAccounts();
  const managed = await openManagedOpenCodeRuntime({
    signal: new AbortController().signal,
    workspaceId: 'pipeline-workspace',
    executionKind: 'pipeline',
    environment: { PIPELINE_ONLY_PROVIDER: 'enabled' },
  });
  const close = jest.spyOn(managed, 'close');
  try {
    await expect(
      assertOpenCodeRuntimeModelAvailable(
        'opencode:pipeline%2Fonly',
        managed,
        '/pipeline/worktree',
      ),
    ).resolves.toMatchObject({ id: 'opencode:pipeline%2Fonly' });
    const first = mockStart.mock.calls[1]?.[0];
    expect(first).toMatchObject({
      cwd: '/pipeline/worktree',
      env: managed.env,
      providerConfig: managed.providerConfig,
    });
    expect(mockNewSession).toHaveBeenLastCalledWith({
      cwd: '/pipeline/worktree',
      mcpServers: [],
    });
    expect(mockReadMetadata).toHaveBeenLastCalledWith('/models');
    expect(first).toBeDefined();
    if (!first) throw new Error('Missing scoped discovery');
    expect(existsSync(dirname(first.profileDir))).toBe(false);
    await assertOpenCodeRuntimeModelAvailable(
      'opencode:pipeline%2Fonly',
      managed,
      '/pipeline/worktree',
    );
    expect(mockStart.mock.calls[2]?.[0].profileDir).not.toBe(first.profileDir);
    expect(await listOpenCodeModels(signal)).toEqual(globalModels);
    expect(getOpenCodeModelEntries()).toEqual(globalModels);
    expect(peekOpenCodeAccounts()).toEqual(globalAccounts);
    expect(
      mockReadMetadata.mock.calls.filter(([url]) => url === '/accounts'),
    ).toHaveLength(1);
    expect(mockStart).toHaveBeenCalledTimes(3);
    expect(close).not.toHaveBeenCalled();
    expect(managed.signal.aborted).toBe(false);
  } finally {
    await managed.close();
  }
});

it.each(['cancel', 'unavailable'])(
  'cleans up scoped discovery on %s without closing the caller lease',
  async (reason) => {
    const abort = new AbortController();
    const managed = await openManagedOpenCodeRuntime({ signal: abort.signal });
    const close = jest.spyOn(managed, 'close');
    try {
      const pending = assertOpenCodeRuntimeModelAvailable(
        'opencode:missing%2Fmodel',
        managed,
        '/pipeline/worktree',
      );
      const rejected = expect(pending).rejects.toThrow(
        reason === 'cancel' ? 'aborted' : 'unavailable',
      );
      await started;
      if (reason === 'cancel') abort.abort();
      releaseDiscovery?.();
      await rejected;
      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(close).not.toHaveBeenCalled();
      const launch = mockStart.mock.calls[0]?.[0];
      if (!launch) throw new Error('Missing scoped discovery');
      expect(existsSync(dirname(launch.profileDir))).toBe(false);
      expect(getOpenCodeModelEntries()).toEqual([]);
    } finally {
      await managed.close();
    }
  },
);

const accountMetadata = {
  providers: [
    {
      id: 'fixture',
      name: 'Fixture',
      accounts: [
        {
          label: 'Work account',
          method: 'oauth',
          selected: true,
          needsSignIn: false,
        },
      ],
    },
  ],
};

it('shares model discovery with account refresh and publishes only after teardown', async () => {
  mockReadMetadata.mockImplementation((url) =>
    Promise.resolve(url === '/accounts' ? accountMetadata : undefined),
  );
  const models = listOpenCodeModels(new AbortController().signal);
  await started;
  const accounts = refreshOpenCodeAccounts(new AbortController().signal);
  expect(peekOpenCodeAccounts()).toBeUndefined();
  releaseDiscovery?.();
  await Promise.all([models, accounts]);
  expect(mockStart).toHaveBeenCalledTimes(1);
  expect(peekOpenCodeAccounts()).toMatchObject({
    status: 'ready',
    ...accountMetadata,
  });
  const snapshot = peekOpenCodeAccounts();
  snapshot?.providers.splice(0);
  expect(peekOpenCodeAccounts()?.providers).toHaveLength(1);
  expect(mockStart).toHaveBeenCalledTimes(1);
  await disconnectOpenCode();
  expect(peekOpenCodeAccounts()).toBeUndefined();
});

it('a failed account read removes old labels without disabling model discovery', async () => {
  releaseDiscovery?.();
  mockReadMetadata.mockImplementation((url) =>
    Promise.resolve(url === '/accounts' ? accountMetadata : undefined),
  );
  await refreshOpenCodeAccounts(new AbortController().signal);
  mockReadMetadata.mockImplementation((url) =>
    url === '/accounts'
      ? Promise.reject(new Error('secret provider error'))
      : Promise.resolve(undefined),
  );
  await refreshOpenCodeAccounts(new AbortController().signal);
  expect(peekOpenCodeAccounts()).toMatchObject({
    status: 'unavailable',
    providers: [],
  });
  expect(JSON.stringify(peekOpenCodeAccounts())).not.toContain('secret');
  expect(
    await listOpenCodeModels(new AbortController().signal),
  ).not.toHaveLength(0);
});

it('disconnect during account discovery cannot republish the previous account', async () => {
  mockReadMetadata.mockImplementation((url) =>
    Promise.resolve(url === '/accounts' ? accountMetadata : undefined),
  );
  const pending = refreshOpenCodeAccounts(new AbortController().signal);
  await started;
  const disconnect = disconnectOpenCode();
  releaseDiscovery?.();
  await Promise.allSettled([pending, disconnect]);
  expect(peekOpenCodeAccounts()).toBeUndefined();
});

it('makes account refresh available for a connected runtime without launching discovery from a status read', async () => {
  await opencodeConnectionStatus();
  expect(peekOpenCodeAccounts()).toMatchObject({
    status: 'unavailable',
    providers: [],
  });
  expect(mockStart).not.toHaveBeenCalled();
});
