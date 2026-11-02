/* eslint-disable @typescript-eslint/explicit-function-return-type */
// CAN-4926: one grant authority per account epoch. Runs the real connection,
// authority and broker against a compare-and-swap store and a GitHub fake
// that retires a refresh token the first time it is presented.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { getCopilotRotationAttemptPath } from '../lib/paths';
import type { CopilotAccount } from '@canopy/desktop-shared/types';
import type * as CopilotRuntimeMetadata from '@canopy/desktop-shared/node/copilot/runtime-metadata';
import type * as CurrentBrand from '@canopy/brand/current';
import type { CopilotRecipientHandle } from '@canopy/desktop-shared/node/copilot/recipient-handle';
import type { SessionConfig } from '@github/copilot-sdk';
import type {
  CopilotCredential,
  CopilotCredentialDelete,
  CopilotCredentialRead,
  CopilotCredentialReplace,
  CopilotCredentialRevision,
  CopilotGrant,
} from '../copilot/credential-store';

const HOUR = 60 * 60 * 1000;
const realNow = Date.now.bind(Date);
const account: CopilotAccount = {
  host: 'https://github.com',
  login: 'octocat',
};

const mockStore: {
  read: CopilotCredentialRead;
  /** Refresh tokens written by compare-and-swap replacements. */
  saves: string[];
  /** Compare-and-swap deletes, as a rejected refresh makes. */
  clears: number;
  /** Unconditional deletes, as Disconnect and Change account make. */
  wipes: number;
  entries: number;
  failNextSave: boolean;
  /** Fails the next create without landing it; the store then reads this. */
  failNextCreate: CopilotCredentialRead | undefined;
  saveGate?: Promise<void>;
  saving?: () => void;
  /** Holds one store read when it returns a promise. */
  onRead?: () => Promise<void> | undefined;
} = {
  read: { status: 'absent' },
  saves: [],
  clears: 0,
  wipes: 0,
  entries: 0,
  failNextSave: false,
  failNextCreate: undefined,
};
const mockPreferences: {
  copilotEnabled: boolean;
  copilotAccount: CopilotAccount | undefined;
} = { copilotEnabled: false, copilotAccount: undefined };
const mockHarness = { enabled: true };
let mockFailPreferences = false;
const mockFlagListeners: Array<() => void> = [];
const mockStart = jest.fn<Promise<unknown>, [{ signal: AbortSignal }]>();
const mockRefresh = jest.fn<Promise<unknown>, unknown[]>();
const mockStartFlow = jest.fn<Promise<unknown>, unknown[]>();
const mockPollFlow = jest.fn<Promise<unknown>, unknown[]>();
const mockModels = jest.fn<
  Promise<{ models: unknown[] }>,
  [{ gitHubToken: string }]
>(() =>
  Promise.resolve({
    models: [
      { id: 'available', name: 'Available', policy: { state: 'enabled' } },
    ],
  }),
);

jest.mock('@canopy/desktop-shared/node/copilot/runtime-metadata', () => {
  const actual = jest.requireActual<typeof CopilotRuntimeMetadata>(
    '@canopy/desktop-shared/node/copilot/runtime-metadata',
  );
  return {
    ...actual,
    getCopilotRuntimeArtifact: () =>
      actual.getCopilotRuntimeArtifact('darwin', 'arm64'),
  };
});
jest.mock('@canopy/brand/current', () => {
  const actual = jest.requireActual<typeof CurrentBrand>(
    '@canopy/brand/current',
  );
  return {
    ...actual,
    BRAND: { ...actual.BRAND, copilot: { gitHubAppClientId: 'Iv23test' } },
  };
});
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: () => ({
    onSnapshotChanged: (listener: () => void) => {
      mockFlagListeners.push(listener);
    },
  }),
}));
jest.mock('../copilot/feature-flag', () => ({
  assertCopilotHarnessEnabled: () => {
    if (!mockHarness.enabled) throw new Error('harness disabled');
  },
  isCopilotHarnessEnabled: () => mockHarness.enabled,
}));
jest.mock('../copilot/runtime-installer', () => ({
  CopilotRuntimeInstaller: jest.fn(() => ({
    isInstalled: () => Promise.resolve(true),
    verify: () => Promise.resolve('/fixture/copilot'),
    install: () => Promise.resolve('/fixture/copilot'),
  })),
}));
jest.mock('../copilot/runtime-availability', () => ({
  beginCopilotAvailabilityProbe: () => () => undefined,
  invalidateCopilotRuntimeAvailability: () => undefined,
}));
jest.mock('../lib/e2e-gate', () => ({ isE2eBuild: () => false }));
jest.mock('../pipelines/config-paths', () => ({ getEnhancedEnv: () => ({}) }));
jest.mock('@canopy/desktop-shared/pipelines/config-paths', () => ({
  getCopilotRuntimeRootDir: () => '/fixture/runtime',
  getCopilotRuntimeReceiptsDir: () => '/fixture/receipts',
  getCopilotRuntimeStateDir: () => '/fixture/state',
}));
jest.mock('@canopy/desktop-shared/node/copilot/process-receipts', () => ({
  reapCopilotProcessReceipts: () => Promise.resolve(),
}));
jest.mock('@canopy/desktop-shared/node/copilot/runtime', () => ({
  startCopilotRuntime: (options: { signal: AbortSignal }) => mockStart(options),
}));
jest.mock('@canopy/desktop-shared/node/copilot/device-flow', () => ({
  startDeviceFlow: (...args: unknown[]) => mockStartFlow(...args),
  pollDeviceFlow: (...args: unknown[]) => mockPollFlow(...args),
  refreshDeviceGrant: (...args: unknown[]) => mockRefresh(...args),
  DeviceFlowRefreshRejectedError: class extends Error {},
}));
jest.mock('../lib/github-octokit-loader', () => ({
  loadOctokitConstructor: () =>
    class {
      rest = {
        users: {
          getAuthenticated: () =>
            Promise.resolve({ data: { login: 'octocat', id: 1 } }),
        },
      };
    },
}));
jest.mock('../lib/github-octokit-options', () => ({
  resolveOctokitClientOptions: (auth: string) => ({ auth }),
}));
const storedAt = (expected: { entryId: string; revision?: number }) =>
  mockStore.read.status === 'present' &&
  mockStore.read.credential.entryId === expected.entryId &&
  (expected.revision === undefined ||
    mockStore.read.credential.revision === expected.revision);
jest.mock('../copilot/credential-store', () => ({
  isCopilotCredentialStorageAvailable: () => true,
  readCopilotCredential: () => {
    const held = mockStore.onRead?.();
    return held
      ? held.then(() => mockStore.read)
      : Promise.resolve(mockStore.read);
  },
  createCopilotCredential: (grant: CopilotGrant) => {
    const failure = mockStore.failNextCreate;
    if (failure) {
      mockStore.failNextCreate = undefined;
      mockStore.read = failure;
      return Promise.reject(new Error('EIO: write failed'));
    }
    mockStore.entries += 1;
    const credential: CopilotCredential = {
      version: 1,
      ...grant,
      entryId: mockStore.entries.toString(16).padStart(32, 'e'),
      revision: 1,
    };
    mockStore.read = { status: 'present', credential };
    return Promise.resolve(credential);
  },
  replaceCopilotCredential: async (
    from: CopilotCredentialRevision,
    grant: CopilotGrant,
  ): Promise<CopilotCredentialReplace> => {
    mockStore.saving?.();
    await mockStore.saveGate;
    if (mockStore.failNextSave) {
      mockStore.failNextSave = false;
      return Promise.reject(new Error('EIO: write failed'));
    }
    if (!storedAt(from)) return Promise.resolve({ status: 'conflict' });
    const credential: CopilotCredential = {
      version: 1,
      ...grant,
      entryId: from.entryId,
      revision: from.revision + 1,
    };
    mockStore.saves.push(credential.refreshToken);
    mockStore.read = { status: 'present', credential };
    return Promise.resolve({ status: 'written', credential });
  },
  deleteCopilotCredential: (expected: {
    entryId: string;
    revision?: number;
  }): Promise<CopilotCredentialDelete> => {
    if (!storedAt(expected)) return Promise.resolve({ status: 'conflict' });
    if (expected.revision === undefined) mockStore.wipes += 1;
    else mockStore.clears += 1;
    mockStore.read = { status: 'absent' };
    return Promise.resolve({ status: 'deleted' });
  },
  clearCopilotCredential: () => {
    mockStore.wipes += 1;
    mockStore.read = { status: 'absent' };
    return Promise.resolve();
  },
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: () => Promise.resolve({ ...mockPreferences }),
  updatePreferencesFile: (
    update: (
      current: typeof mockPreferences,
    ) => Partial<typeof mockPreferences>,
  ) => {
    if (mockFailPreferences)
      return Promise.reject(new Error('preferences failed'));
    Object.assign(mockPreferences, update(mockPreferences));
    return Promise.resolve();
  },
}));

import {
  connectCopilot,
  copilotConnectionStatus,
  disconnectCopilot,
  getCopilotAccountGeneration,
  listCopilotModels,
  openManagedCopilotRuntime,
  resetCopilotShutdownForTests,
  revokeCopilotRuntimes,
  shutdownCopilotRuntimes,
} from '../copilot/connection';
import {
  copilotGrantAuthority,
  drainCopilotGrant,
} from '../copilot/grant-authority';
import {
  requestSessionToken,
  sessionToken,
} from './helpers/copilot-session-token';

interface Grant {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}
interface Presentation {
  token: string;
  deliver: () => void;
}

/** The first presentation of the live refresh token rotates it; any other is rejected. */
function fakeGitHub(rejection: () => Error) {
  const state = {
    live: 'ghr_old',
    sequence: 0,
    presentations: [] as Presentation[],
  };
  const present = (token: string): Promise<Grant> =>
    new Promise<Grant>((resolve, reject) => {
      let grant: Grant | undefined;
      if (token === state.live) {
        state.sequence += 1;
        state.live = `ghr_new${state.sequence}`;
        grant = {
          accessToken: `ghu_new${state.sequence}`,
          accessTokenExpiresAt: new Date(Date.now() + 8 * HOUR).toISOString(),
          refreshToken: state.live,
          refreshTokenExpiresAt: new Date(
            Date.now() + 1000 * HOUR,
          ).toISOString(),
        };
      }
      let delivered = false;
      state.presentations.push({
        token,
        deliver: () => {
          if (delivered) return;
          delivered = true;
          if (grant) resolve(grant);
          else reject(rejection());
        },
      });
    });
  return { state, present };
}

function storedCredential(): CopilotCredential {
  return {
    version: 1,
    clientId: 'Iv23test',
    host: 'https://github.com',
    login: 'octocat',
    id: '1',
    accessToken: 'ghu_old',
    // Two hours left: opening does not refresh until the clock moves.
    accessTokenExpiresAt: new Date(Date.now() + 2 * HOUR).toISOString(),
    refreshToken: 'ghr_old',
    refreshTokenExpiresAt: new Date(Date.now() + 1000 * HOUR).toISOString(),
    entryId: 'a'.repeat(32),
    revision: 1,
  };
}

function outcome(promise: Promise<string>): Promise<string> {
  return promise.then(
    (token) => `token:${token}`,
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('sign-in expired')) return 'error:expired';
      if (message.includes('sign-in changed')) return 'error:changed';
      return `error:${message}`;
    },
  );
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    // Refresh admission now includes durable asynchronous filesystem work.
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Lets every pending open, read and refresh reach GitHub or join one. */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

const signal = () => new AbortController().signal;
let github: ReturnType<typeof fakeGitHub>;
let clockOffset = 0;
let dateSpy: jest.SpyInstance<number, []> | undefined;

function slot(): string | null {
  return mockStore.read.status === 'present'
    ? mockStore.read.credential.refreshToken
    : null;
}

function presented(): string[] {
  return github.state.presentations.map((presentation) => presentation.token);
}

/** Delivers GitHub's answers in `order`; an index nobody presented is skipped. */
async function deliver(order: readonly number[]): Promise<void> {
  for (const index of order) {
    github.state.presentations[index]?.deliver();
    await settle();
  }
}

/** One fresh-generation consumer: open (which preflights the token), read it, close. */
function freshConsumer(): Promise<string> {
  return outcome(
    openManagedCopilotRuntime({ signal: signal() }).then(async (runtime) => {
      try {
        return await sessionToken(runtime);
      } finally {
        await runtime.close();
      }
    }),
  );
}

const SHUT_DOWN = 'error:Copilot is shutting down.';
/** A consumer opened after quit began: refused before any runtime spawns. */
async function consumerAfterQuit(): Promise<string> {
  const spawns = mockStart.mock.calls.length;
  const result = await freshConsumer();
  expect(mockStart).toHaveBeenCalledTimes(spawns);
  return result;
}

type Trigger = 'preferences' | 'rollout' | 'connect';
const TRIGGERS: Trigger[] = ['preferences', 'rollout', 'connect'];

/** Each path that revokes runtimes without ending the account epoch. */
async function revokeBy(trigger: Trigger): Promise<void> {
  if (trigger === 'preferences') {
    // ipc/preferences.ts revokes on a copilotEnabled or pin change.
    await revokeCopilotRuntimes();
    return;
  }
  if (trigger === 'rollout') {
    const before = getCopilotAccountGeneration();
    mockHarness.enabled = false;
    for (const listener of mockFlagListeners) listener();
    await until(
      () => getCopilotAccountGeneration() !== before,
      'rollout revoke',
    );
    await settle();
    mockHarness.enabled = true;
    return;
  }
  // Connect on the signed-in account reuses its grant and revokes twice.
  await expect(
    connectCopilot(signal(), () => undefined),
  ).resolves.toMatchObject({ phase: 'connected', account });
}

async function revokedHandle(
  trigger: Trigger,
): Promise<CopilotRecipientHandle> {
  const runtime = await openManagedCopilotRuntime({ signal: signal() });
  await revokeBy(trigger);
  // The access token ages into its last hour.
  clockOffset = 1.5 * HOUR;
  return runtime;
}

/** GitHub grants `ghu_<suffix>` / `ghr_<suffix>` to the next device flow. */
function grantOnNextConnect(suffix: string): void {
  mockStartFlow.mockResolvedValueOnce({
    deviceCode: 'dc',
    userCode: 'ABCD-1234',
    verificationUri: 'https://github.com/login/device',
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    intervalMs: 5000,
  });
  mockPollFlow.mockResolvedValueOnce({
    status: 'granted',
    grant: {
      accessToken: `ghu_${suffix}`,
      accessTokenExpiresAt: new Date(Date.now() + 2 * HOUR).toISOString(),
      refreshToken: `ghr_${suffix}`,
      refreshTokenExpiresAt: new Date(Date.now() + 1000 * HOUR).toISOString(),
    },
  });
}

const REVOKED = 'error:Copilot connection was revoked.';
const FIXED = {
  staleFinal: REVOKED,
  freshFinal: 'token:ghu_new1',
  presented: ['ghr_old'],
  saves: ['ghr_new1'],
  clears: 0,
  slot: 'ghr_new1',
};

async function result(staleFinal: Promise<string>, fresh: Promise<string>) {
  return {
    staleFinal: await staleFinal,
    freshFinal: await fresh,
    presented: presented(),
    saves: [...mockStore.saves],
    clears: mockStore.clears,
    slot: slot(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  clockOffset = 0;
  dateSpy = jest
    .spyOn(Date, 'now')
    .mockImplementation(() => realNow() + clockOffset);
  mockHarness.enabled = true;
  mockFailPreferences = false;
  mockPreferences.copilotEnabled = true;
  mockPreferences.copilotAccount = account;
  mockStore.saves = [];
  mockStore.clears = 0;
  mockStore.wipes = 0;
  mockStore.failNextSave = false;
  mockStore.failNextCreate = undefined;
  mockStore.saveGate = undefined;
  mockStore.saving = undefined;
  mockStore.onRead = undefined;
  mockStore.read = { status: 'present', credential: storedCredential() };
  const { DeviceFlowRefreshRejectedError } = jest.requireMock<{
    DeviceFlowRefreshRejectedError: new (message: string) => Error;
  }>('@canopy/desktop-shared/node/copilot/device-flow');
  github = fakeGitHub(
    () => new DeviceFlowRefreshRejectedError('bad_refresh_token'),
  );
  mockRefresh.mockImplementation((...args: unknown[]) =>
    github.present(String(args[1])),
  );
  mockStart.mockImplementation(({ signal: runtimeSignal }) => {
    let reap: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      reap = resolve;
    });
    runtimeSignal.addEventListener('abort', () => reap(), { once: true });
    return Promise.resolve({
      identity: { runtimeId: 'fixture', pid: 123, started: 1 },
      isClosed: () => false,
      client: {
        rpc: { models: { list: mockModels } },
        createSession: (config: SessionConfig) => requestSessionToken(config),
        resumeSession: (sessionId: string, config: SessionConfig) =>
          requestSessionToken(config, { sessionId, reason: 'refresh' }),
      },
      exited,
      close: () => {
        reap();
        return Promise.resolve();
      },
    });
  });
});

afterEach(async () => {
  for (const presentation of github.state.presentations) presentation.deliver();
  await settle();
  mockHarness.enabled = true;
  mockFailPreferences = false;
  // Quit is terminal in production; each test starts its own process lifetime.
  resetCopilotShutdownForTests();
  // Each test is its own account epoch.
  await disconnectCopilot();
  dateSpy?.mockRestore();
  dateSpy = undefined;
});

describe('revoke keeps one grant authority (O1–O4, T3)', () => {
  // O1/O2: the fresh open is first; O3/O4: the revoked handle is refused first.
  // Odd cases deliver GitHub's later answer first. With one authority only
  // index 0 exists, so every ordering collapses to one presentation.
  const ORDERS = [
    { name: 'O1', first: 'fresh', order: [1, 0] },
    { name: 'O2', first: 'fresh', order: [0, 1] },
    { name: 'O3', first: 'stale', order: [1, 0] },
    { name: 'O4', first: 'stale', order: [0, 1] },
  ] as const;
  const cases = TRIGGERS.flatMap((trigger) =>
    ORDERS.map((entry) => ({ ...entry, trigger })),
  );

  it.each(cases)(
    '$name after a $trigger revoke: one presentation, the successor saved, no clear',
    async ({ first, order, trigger }) => {
      const stale = await revokedHandle(trigger);
      let staleFinal: Promise<string>;
      let fresh: Promise<string>;
      if (first === 'fresh') {
        fresh = freshConsumer();
        await until(() => presented().length === 1, 'fresh presentation');
        staleFinal = outcome(sessionToken(stale));
      } else {
        staleFinal = outcome(sessionToken(stale));
        await settle();
        expect(presented()).toEqual([]);
        fresh = freshConsumer();
        await until(() => presented().length === 1, 'fresh presentation');
      }
      await settle();
      await deliver(order);
      expect(await result(staleFinal, fresh)).toEqual(FIXED);
      await expect(copilotConnectionStatus()).resolves.toMatchObject({
        enabled: true,
      });
    },
  );
});

describe('a rotation in flight across a revoke is shared (T2, T3)', () => {
  it.each(
    TRIGGERS.flatMap((trigger) =>
      [
        { delivery: 'rejection first', order: [1, 0] },
        { delivery: 'success first', order: [0, 1] },
      ].map((entry) => ({ ...entry, trigger })),
    ),
  )(
    'old- and new-generation consumers share one presentation of ghr_old ($trigger, $delivery)',
    async ({ order, trigger }) => {
      const runtime = await openManagedCopilotRuntime({ signal: signal() });
      clockOffset = 1.5 * HOUR;
      const staleFinal = outcome(sessionToken(runtime));
      await until(() => presented().length === 1, 'old-generation refresh');
      await revokeBy(trigger);
      const fresh = freshConsumer();
      await settle();
      await deliver(order);
      expect(await result(staleFinal, fresh)).toEqual(FIXED);
    },
  );
});

describe('Connect on a signed-in account during a refresh (I2)', () => {
  it.each([
    { delivery: 'rejection first', order: [1, 0] },
    { delivery: 'success first', order: [0, 1] },
  ])(
    'keeps the epoch: no fork, no clear, no spurious change ($delivery)',
    async ({ order }) => {
      const runtime = await openManagedCopilotRuntime({ signal: signal() });
      clockOffset = 1.5 * HOUR;
      const staleFinal = outcome(sessionToken(runtime));
      await until(() => presented().length === 1, 'in-flight refresh');
      const status = await connectCopilot(signal(), () => undefined);
      // The Connect IPC handler lists models next; that open refreshes too.
      const models = listCopilotModels(signal()).then(
        (listed) => listed.map((model) => model.id).join(','),
        (error: unknown) =>
          `error:${error instanceof Error ? error.message : String(error)}`,
      );
      await settle();
      await deliver(order);
      expect({
        phase: status.phase,
        models: await models,
        staleFinal: await staleFinal,
        presented: presented(),
        saves: [...mockStore.saves],
        clears: mockStore.clears,
        slot: slot(),
      }).toEqual({
        phase: 'connected',
        models: 'copilot:available',
        staleFinal: REVOKED,
        presented: ['ghr_old'],
        saves: ['ghr_new1'],
        clears: 0,
        slot: 'ghr_new1',
      });
      expect(mockModels).toHaveBeenLastCalledWith({ gitHubToken: 'ghu_new1' });
    },
  );
});

describe('a revoked handle cannot refresh on its own (B2)', () => {
  it('saves its unsaved successor through the authority without presenting again', async () => {
    const runtime = await openManagedCopilotRuntime({ signal: signal() });
    clockOffset = 1.5 * HOUR;
    mockStore.failNextSave = true;
    const staleFinal = outcome(sessionToken(runtime));
    await until(() => presented().length === 1, 'refresh before revoke');
    await revokeCopilotRuntimes();
    await deliver([0]);
    // D27: the received successor serves while its save is retried.
    expect(await staleFinal).toBe(REVOKED);
    expect(slot()).toBe('ghr_old');
    const fresh = freshConsumer();
    await settle();
    await deliver([1]);
    expect({
      freshFinal: await fresh,
      presented: presented(),
      saves: [...mockStore.saves],
      clears: mockStore.clears,
      slot: slot(),
    }).toEqual({
      freshFinal: 'token:ghu_new1',
      presented: ['ghr_old'],
      saves: ['ghr_new1'],
      clears: 0,
      slot: 'ghr_new1',
    });
  });
});

describe('a revoked session token provider (T2)', () => {
  it('refuses the revoked session while the fresh open refreshes', async () => {
    const stale = await revokedHandle('preferences');
    const fresh = freshConsumer();
    await until(() => presented().length === 1, 'fresh presentation');
    const staleFinal = outcome(sessionToken(stale, { sessionId: 's' }));
    await settle();
    await deliver([0, 1]);
    expect(await result(staleFinal, fresh)).toEqual(FIXED);
  });
});

describe('revoke and the in-flight rotation (T22; capped wait is I1/I1b)', () => {
  it('returns without waiting, saves the successor once and refuses stale delivery', async () => {
    const runtime = await openManagedCopilotRuntime({ signal: signal() });
    clockOffset = 1.5 * HOUR;
    const staleFinal = outcome(sessionToken(runtime));
    await until(() => presented().length === 1, 'in-flight refresh');
    let revoked = false;
    const revoking = revokeCopilotRuntimes().then(() => {
      revoked = true;
    });
    await settle();
    // Revoke alone never waits; D30 caps the drain in Disconnect and quit.
    expect(revoked).toBe(true);
    await revoking;
    await deliver([0]);
    // Lease admission (PR 4) withholds the successor from a revoked lease.
    expect(await staleFinal).toBe(REVOKED);
    expect({ saves: mockStore.saves, clears: mockStore.clears }).toEqual({
      saves: ['ghr_new1'],
      clears: 0,
    });
  });
});

describe('the account epoch (D24)', () => {
  it('a handle from before Disconnect and Connect cannot present the new entry', async () => {
    const runtime = await openManagedCopilotRuntime({ signal: signal() });
    await disconnectCopilot();
    grantOnNextConnect('second');
    await expect(
      connectCopilot(signal(), () => undefined),
    ).resolves.toMatchObject({ phase: 'connected', account });
    github.state.live = 'ghr_second';
    clockOffset = 1.5 * HOUR;
    const staleFinal = outcome(sessionToken(runtime));
    await settle();
    expect(presented()).toEqual([]);
    expect(await staleFinal).toBe(REVOKED);
    const fresh = freshConsumer();
    await until(() => presented().length === 1, 'new-epoch refresh');
    await deliver([0]);
    expect(await fresh).toBe('token:ghu_new1');
    expect({ presented: presented(), saves: mockStore.saves }).toEqual({
      presented: ['ghr_second'],
      saves: ['ghr_new1'],
    });
  });

  it('an entry written outside the authority ends its epoch; the next open adopts the entry', async () => {
    const runtime = await openManagedCopilotRuntime({ signal: signal() });
    mockStore.read = {
      status: 'present',
      credential: {
        ...storedCredential(),
        entryId: 'b'.repeat(32),
        accessToken: 'ghu_adopted',
      },
    };
    expect(await outcome(sessionToken(runtime))).toBe(REVOKED);
    expect(await freshConsumer()).toBe('token:ghu_adopted');
    expect(presented()).toEqual([]);
  });

  it('a failed Connect create keeps the epoch and its unsaved successor', async () => {
    const runtime = await openManagedCopilotRuntime({ signal: signal() });
    clockOffset = 1.5 * HOUR;
    mockStore.failNextSave = true;
    const staleFinal = outcome(sessionToken(runtime));
    await until(() => presented().length === 1, 'refresh');
    await deliver([0]);
    expect(await staleFinal).toBe('token:ghu_new1');
    // Unreadable storage sends Connect to a new sign-in; its create fails
    // without landing and storage recovers.
    mockStore.failNextCreate = mockStore.read;
    mockStore.read = { status: 'unreadable' };
    grantOnNextConnect('second');
    await expect(connectCopilot(signal(), () => undefined)).rejects.toThrow(
      'EIO',
    );
    expect(mockPreferences).toEqual({
      copilotEnabled: true,
      copilotAccount: account,
    });
    const fresh = freshConsumer();
    await settle();
    // A second presentation of the retired grant would be answered here.
    await deliver([1]);
    expect({
      freshFinal: await fresh,
      presented: presented(),
      saves: [...mockStore.saves],
      clears: mockStore.clears,
      slot: slot(),
    }).toEqual({
      freshFinal: 'token:ghu_new1',
      presented: ['ghr_old'],
      saves: ['ghr_new1'],
      clears: 0,
      slot: 'ghr_new1',
    });
  });

  it.each([
    { name: 'Disconnect', slotAfter: null },
    { name: 'Change account', slotAfter: 'ghr_second' },
  ])(
    '$name during a rotation: the ended epoch neither saves nor clears',
    async ({ name, slotAfter }) => {
      const runtime = await openManagedCopilotRuntime({ signal: signal() });
      clockOffset = 1.5 * HOUR;
      const staleFinal = outcome(sessionToken(runtime));
      await until(() => presented().length === 1, 'refresh');
      if (name === 'Disconnect') await disconnectCopilot();
      else {
        grantOnNextConnect('second');
        await connectCopilot(signal(), () => undefined, true);
      }
      await deliver([0]);
      expect({
        staleFinal: await staleFinal,
        presented: presented(),
        saves: [...mockStore.saves],
        clears: mockStore.clears,
        slot: slot(),
      }).toEqual({
        staleFinal: REVOKED,
        presented: ['ghr_old'],
        saves: [],
        clears: 0,
        slot: slotAfter,
      });
    },
  );

  it('a rejected refresh still clears the grant the authority presented (D31)', async () => {
    github.state.live = 'ghr_elsewhere';
    const runtime = await openManagedCopilotRuntime({ signal: signal() });
    await revokeCopilotRuntimes();
    clockOffset = 1.5 * HOUR;
    const staleFinal = outcome(sessionToken(runtime));
    await settle();
    expect(presented()).toEqual([]);
    const fresh = freshConsumer();
    await until(() => presented().length === 1, 'fresh refresh');
    await deliver([0, 1]);
    expect({
      staleFinal: await staleFinal,
      freshFinal: await fresh,
      presented: presented(),
      clears: mockStore.clears,
      slot: slot(),
    }).toEqual({
      staleFinal: REVOKED,
      freshFinal: 'error:expired',
      presented: ['ghr_old'],
      clears: 1,
      slot: null,
    });
  });
});

describe('Disconnect rotation drain (I1b)', () => {
  it('fences consumers before preferences and adopts the answer before deleting', async () => {
    const runtime = await openManagedCopilotRuntime({ signal: signal() });
    clockOffset = 1.5 * HOUR;
    const token = outcome(sessionToken(runtime));
    await until(() => presented().length === 1, 'refresh');
    const disconnected = disconnectCopilot();
    await settle();
    expect(mockPreferences.copilotEnabled).toBe(true);
    expect(mockStore.wipes).toBe(0);
    await deliver([0]);
    await disconnected;
    expect(await token).toBe(REVOKED);
    expect(mockStore.saves).toHaveLength(1);
    expect(slot()).toBe(null);
  });

  // Reads after open: 1 lease admission, 2 authority load, 3 its admission recheck.
  it.each([
    { read: 1, capped: false },
    { read: 2, capped: true },
    { read: 3, capped: false },
  ])(
    'a stalled read $read during lease delivery never presents, and the cap applies only to authority work ($capped)',
    async ({ read, capped }) => {
      const runtime = await openManagedCopilotRuntime({ signal: signal() });
      clockOffset = 1.5 * HOUR;
      let reads = 0;
      let release: (() => void) | undefined;
      mockStore.onRead = () => {
        reads += 1;
        if (reads !== read) return undefined;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      };
      const order: string[] = [];
      const token = outcome(sessionToken(runtime));
      await until(() => release !== undefined, 'stalled read');
      jest.useFakeTimers();
      try {
        let done = false;
        const disconnected = disconnectCopilot().then(() => {
          order.push(
            `done:${String(mockPreferences.copilotEnabled)}:${String(slot())}`,
          );
          done = true;
        });
        await jest.advanceTimersByTimeAsync(0);
        expect(await token).toBe(REVOKED);
        expect(done).toBe(!capped);
        if (capped) {
          expect(mockPreferences.copilotEnabled).toBe(true);
          expect(slot()).toBe('ghr_old');
          await jest.advanceTimersByTimeAsync(2000);
        }
        await disconnected;
        expect(order).toEqual(['done:false:null']);
      } finally {
        jest.useRealTimers();
        release?.();
      }
      await settle();
      expect(presented()).toEqual([]);
      expect(mockStore.saves).toEqual([]);
      expect(slot()).toBe(null);
    },
  );
});

describe('Quit rotation drain (I1)', () => {
  it('caps a stalled durable save at two seconds, leaving it to finish without re-presenting', async () => {
    const runtime = await openManagedCopilotRuntime({ signal: signal() });
    clockOffset = 1.5 * HOUR;
    let release: () => void = () => undefined;
    mockStore.saveGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const saving = new Promise<void>((resolve) => {
      mockStore.saving = resolve;
    });
    const token = outcome(sessionToken(runtime));
    await until(() => presented().length === 1, 'refresh');
    await deliver([0]);
    await saving;
    jest.useFakeTimers();
    try {
      let stopped = false;
      const shutdown = shutdownCopilotRuntimes().then(() => {
        stopped = true;
      });
      await jest.advanceTimersByTimeAsync(1999);
      expect(stopped).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await shutdown;
      expect(slot()).toBe('ghr_old');
      expect(mockStore.saves).toEqual([]);
      expect(mockStore.wipes).toBe(0);
      jest.useRealTimers();
      // PR 4: the revoked lease is refused; quit refuses new opens before spawning.
      expect(await token).toBe(REVOKED);
      expect(await outcome(sessionToken(runtime))).toBe(REVOKED);
      expect(await consumerAfterQuit()).toBe(SHUT_DOWN);
      release();
      await until(() => mockStore.saves.length === 1, 'retained save');
      expect(slot()).toBe('ghr_new1');
      expect(mockStore.saves).toEqual(['ghr_new1']);
      expect(presented()).toEqual(['ghr_old']);
    } finally {
      release();
      jest.useRealTimers();
      await token;
    }
  });

  it('durably records the actual epoch and digest before presenting the stored grant', async () => {
    const runtime = await openManagedCopilotRuntime({ signal: signal() });
    clockOffset = 1.5 * HOUR;
    let recorded = '';
    mockRefresh.mockImplementationOnce(async (...args: unknown[]) => {
      recorded = await readFile(getCopilotRotationAttemptPath(), 'utf8');
      return github.present(String(args[1]));
    });
    const token = outcome(sessionToken(runtime));
    await until(() => presented().length === 1, 'write-ahead refresh');
    const attemptId: unknown = expect.any(String);
    const bootId: unknown = expect.any(String);
    expect(JSON.parse(recorded)).toEqual({
      version: 1,
      attemptId,
      bootId,
      accountEpoch: { host: account.host, id: '1', entryId: 'a'.repeat(32) },
      fromDigest: createHash('sha256').update('ghr_old').digest('hex'),
    });
    for (const secret of ['ghr_', 'ghu_', 'accessToken', 'refreshToken'])
      expect(recorded).not.toContain(secret);
    await deliver([0]);
    await token;
  });

  it('saves an answer received during teardown without another presentation', async () => {
    const runtime = await openManagedCopilotRuntime({ signal: signal() });
    clockOffset = 1.5 * HOUR;
    const token = outcome(sessionToken(runtime));
    await until(() => presented().length === 1, 'refresh');
    const stopped = shutdownCopilotRuntimes();
    await settle();
    expect(slot()).toBe('ghr_old');
    await deliver([0]);
    await stopped;
    expect(await token).toBe(REVOKED);
    expect(mockStore.saves).toHaveLength(1);
    expect(presented()).toEqual(['ghr_old']);
    expect(await outcome(sessionToken(runtime))).toBe(REVOKED);
    expect(await consumerAfterQuit()).toBe(SHUT_DOWN);
    expect(presented()).toEqual(['ghr_old']);
  });

  it('does not wait past 2 seconds for a lost response or clear the stored grant', async () => {
    const runtime = await openManagedCopilotRuntime({ signal: signal() });
    clockOffset = 1.5 * HOUR;
    const token = outcome(sessionToken(runtime));
    await until(() => presented().length === 1, 'refresh');
    jest.useFakeTimers();
    try {
      let done = false;
      const stopped = shutdownCopilotRuntimes().then(() => {
        done = true;
      });
      await jest.advanceTimersByTimeAsync(1999);
      expect(done).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await stopped;
      expect(slot()).toBe('ghr_old');
      expect(mockStore.clears).toBe(0);
      expect(mockStore.wipes).toBe(0);
    } finally {
      jest.useRealTimers();
      await deliver([0]);
      await token;
    }
  });

  it('refuses an open that passed its binding read before quit, without presenting', async () => {
    clockOffset = 1.5 * HOUR;
    const start = mockStart.getMockImplementation();
    if (!start) throw new Error('missing runtime fake');
    let started: () => void = () => undefined;
    let starting = false;
    mockStart.mockImplementationOnce(async (options) => {
      starting = true;
      await new Promise<void>((resolve) => {
        started = resolve;
      });
      return start(options);
    });
    const opening = freshConsumer();
    await until(() => starting, 'runtime start after binding');
    // The start finishes as quit begins; teardown waits for that runtime.
    const stopped = shutdownCopilotRuntimes();
    started();
    await stopped;
    expect(await opening).toMatch(/^error:/);
    expect(await consumerAfterQuit()).toBe(SHUT_DOWN);
    expect(presented()).toEqual([]);
    expect(slot()).toBe('ghr_old');
  });

  it('adopts an unsaved successor once without presenting it again', async () => {
    const runtime = await openManagedCopilotRuntime({ signal: signal() });
    clockOffset = 1.5 * HOUR;
    mockStore.failNextSave = true;
    const token = outcome(sessionToken(runtime));
    await until(() => presented().length === 1, 'refresh');
    await deliver([0]);
    await token;
    expect(slot()).toBe('ghr_old');
    await shutdownCopilotRuntimes();
    expect(mockStore.saves).toHaveLength(1);
    expect(presented()).toEqual(['ghr_old']);
  });

  it('refuses an open that begins after quit without spawning or presenting', async () => {
    await shutdownCopilotRuntimes();
    expect(await consumerAfterQuit()).toBe(SHUT_DOWN);
    expect(mockStart).not.toHaveBeenCalled();
    expect(presented()).toEqual([]);
    expect(slot()).toBe('ghr_old');
  });

  it("keeps the quit fence on the epoch's existing authority", async () => {
    const runtime = await openManagedCopilotRuntime({ signal: signal() });
    await shutdownCopilotRuntimes();
    // Same pin and still active: this returns the authority the drain fenced.
    const handle = copilotGrantAuthority(account, {
      refresh: (refreshToken) => github.present(refreshToken),
      onCleared: () => undefined,
    });
    expect(await outcome(handle.token(signal()))).toBe('error:changed');
    handle.resume();
    expect(await outcome(handle.token(signal()))).toBe('error:changed');
    expect(await outcome(sessionToken(runtime))).toBe(REVOKED);
    expect(presented()).toEqual([]);
    expect(slot()).toBe('ghr_old');
  });

  it('keeps the quit fence for a grant authority started after the drain', async () => {
    await drainCopilotGrant(true);
    const handle = copilotGrantAuthority(account, {
      refresh: (refreshToken) => github.present(refreshToken),
      onCleared: () => undefined,
    });
    expect(await outcome(handle.token(signal()))).toBe('error:changed');
    handle.resume();
    expect(await outcome(handle.token(signal()))).toBe('error:changed');
    expect(presented()).toEqual([]);
    expect(slot()).toBe('ghr_old');
  });
});

test('a failed removal preference write keeps the same grant epoch usable', async () => {
  await openManagedCopilotRuntime({ signal: signal() });
  mockFailPreferences = true;
  await expect(disconnectCopilot()).rejects.toThrow('preferences failed');
  expect(mockPreferences.copilotEnabled).toBe(true);
  expect(slot()).toBe('ghr_old');
  mockFailPreferences = false;
  const next = await openManagedCopilotRuntime({ signal: signal() });
  await expect(sessionToken(next)).resolves.toBe('ghu_old');
  expect(presented()).toEqual([]);
});

test('a failed removal after the cap resumes the pending rotation without presenting again', async () => {
  const runtime = await openManagedCopilotRuntime({ signal: signal() });
  clockOffset = 1.5 * HOUR;
  const token = outcome(sessionToken(runtime));
  await until(() => presented().length === 1, 'refresh');
  mockFailPreferences = true;
  jest.useFakeTimers();
  try {
    const failedRemoval =
      expect(disconnectCopilot()).rejects.toThrow('preferences failed');
    await jest.advanceTimersByTimeAsync(2000);
    await failedRemoval;
    jest.useRealTimers();
    mockFailPreferences = false;
    expect(slot()).toBe('ghr_old');
    const fresh = freshConsumer();
    await settle();
    await deliver([0]);
    expect(await token).toBe(REVOKED);
    expect(await fresh).toBe('token:ghu_new1');
    expect(presented()).toEqual(['ghr_old']);
    expect(mockStore.saves).toEqual(['ghr_new1']);
    expect(mockPreferences.copilotEnabled).toBe(true);
  } finally {
    jest.useRealTimers();
    mockFailPreferences = false;
    await deliver([0]);
    await token;
  }
});
