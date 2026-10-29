import type { FeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import type { LabsAvailabilityState } from '../../feature-flags/labs-availability';
import type { LabsExperimentsDependencies } from '../labs-experiments-service';
import type { FeatureFlagService } from '../../feature-flags/service';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import type { CanopyCloudAccountEntry } from '../../lib/canopy-cloud-account-store';
let mockAccount: {
  apiKey: string;
  authMode?: string;
  credentialSource?: string;
  account?: { id: string };
} | null = null;
let mockSubscriber:
  | ((entry: CanopyCloudAccountEntry | null) => void)
  | undefined;
const mockRequest = jest.fn<Promise<unknown>, [string, unknown?]>();
const mockMirror = jest.fn();
let mockAccountConfirmed: (() => void) | undefined;
let mockFlagState: LabsAvailabilityState;
const mockFlagListeners = new Set<(snapshot: FeatureFlagSnapshot) => void>();
const mockInvalidateFlags = jest.fn(() => {
  if (mockFlagState.snapshot.status === 'not_configured') return;
  mockFlagState = {
    snapshot: getDefaultFeatureFlagSnapshot(
      'initializing',
      null,
      'launchdarkly_enabled_unavailable',
    ),
    contextIdentity: null,
    liveValues: {},
  };
  mockFlagListeners.forEach((listener) => listener(mockFlagState.snapshot));
});
const mockRefreshFlags = jest.fn(() => Promise.resolve(mockFlagState.snapshot));
function accountEntry(apiKey: string, id: string): CanopyCloudAccountEntry {
  return {
    apiKey,
    capabilities: [],
    createdAt: '2026-10-14T00:00:00.000Z',
    updatedAt: '2026-10-14T00:00:00.000Z',
    account: {
      id,
      name: 'Test account',
      email: 'test@example.invalid',
      role: 'DEVELOPER',
    },
  };
}

jest.mock('../../canopy-cloud/client', (): object => ({
  requestCanopyCloudJson: (
    ...args: Parameters<typeof mockRequest>
  ): Promise<unknown> => mockRequest(...args),
}));
jest.mock('../../canopy-cloud/config', (): object => ({
  getCanopyCloudBaseUrl: (): string => 'https://server.example.invalid',
}));
jest.mock('../../lib/canopy-cloud-account-store', (): object => ({
  peekCanopyCloudAccount: (): typeof mockAccount => mockAccount,
  subscribeCanopyCloudAccountChanges: (
    listener: typeof mockSubscriber,
  ): (() => void) => {
    mockSubscriber = listener;
    return (): void => {
      mockSubscriber = undefined;
    };
  },
  subscribeCanopyCloudAccountConfirmations: (
    listener: () => void,
  ): (() => void) => {
    mockAccountConfirmed = listener;
    return (): void => {
      mockAccountConfirmed = undefined;
    };
  },
}));
jest.mock('../../lib/main-process-logging', (): object => ({
  logMainProcessWarn: jest.fn(),
}));
function mockFlags(): Pick<
  FeatureFlagService,
  | 'getLabsAvailabilityState'
  | 'onSnapshotChanged'
  | 'invalidateContext'
  | 'refreshContext'
> {
  return {
    getLabsAvailabilityState: (): LabsAvailabilityState => mockFlagState,
    onSnapshotChanged: (listener): (() => void) => {
      mockFlagListeners.add(listener);
      return () => {
        mockFlagListeners.delete(listener);
      };
    },
    invalidateContext: mockInvalidateFlags,
    refreshContext: mockRefreshFlags,
  };
}
jest.mock('../../feature-flags/service', (): object => ({
  getFeatureFlagService: mockFlags,
}));
function mockStorage(): Pick<
  LabsExperimentsDependencies,
  'choicesPath' | 'availabilityPath' | 'read' | 'write' | 'mirror'
> {
  return {
    choicesPath: 'choices',
    availabilityPath: 'flags',
    read: (): unknown => ({
      version: 1,
      accounts: { local: { 'early-access': true } },
    }),
    write: (): Promise<void> => Promise.resolve(),
    mirror: mockMirror,
  };
}
jest.mock('../labs-experiments-service', (): object => ({
  ...jest.requireActual<object>('../labs-experiments-service'),
  labsExperimentStorageDependencies: mockStorage,
}));
import {
  getLabsExperimentsService,
  initializeLabsExperimentsService,
  disposeLabsExperimentsService,
} from '../labs-experiments-runtime';
beforeEach(() => {
  jest.clearAllMocks();
  mockFlagListeners.clear();
  mockFlagState = {
    snapshot: getDefaultFeatureFlagSnapshot('not_configured'),
    contextIdentity: null,
    liveValues: {},
  };
  mockRequest.mockResolvedValue({ choices: {} });
});
afterEach(async () => {
  await disposeLabsExperimentsService();
});
describe('Labs account binding', () => {
  it('retains live flags and session generation through routine same-account notifications', async () => {
    const account = accountEntry('signed-key', 'account-a');
    mockAccount = account;
    const key = CLIENT_FEATURE_FLAGS.canopyDesktopLabsEarlyAccess.key;
    mockFlagState = {
      snapshot: {
        ...getDefaultFeatureFlagSnapshot(),
        status: 'ready',
        initialized: true,
        values: { ...getDefaultFeatureFlagSnapshot().values, [key]: 'on' },
      },
      contextIdentity: 'same-context',
      liveValues: { [key]: 'on' },
    };
    await initializeLabsExperimentsService();
    const service = getLabsExperimentsService();
    const before = service.getSnapshot();
    const snapshots: ReturnType<typeof service.getSnapshot>[] = [];
    service.onSnapshotChanged((snapshot) => snapshots.push(snapshot));
    const disconnect = jest.fn();
    mockFlagListeners.add((snapshot) => {
      if (!snapshot.values[CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key])
        disconnect();
    });
    mockSubscriber?.({ ...account, updatedAt: '2026-10-14T01:00:00.000Z' });
    await service.flush();
    expect(mockInvalidateFlags).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(service.getSnapshot()).toMatchObject({
      earlyAccessEnabled: true,
      generation: before.generation,
    });
    expect(
      snapshots.every(
        (snapshot) => snapshot.ready && snapshot.earlyAccessEnabled,
      ),
    ).toBe(true);
  });
  it('refreshes flag targeting when a refresh confirms the unchanged account', async () => {
    mockAccount = accountEntry('signed-key', 'account-a');
    await initializeLabsExperimentsService();
    const generation = getLabsExperimentsService().getSnapshot().generation;
    mockRefreshFlags.mockClear();
    // Provider probes (GitHub, Claude, Codex) feed targeting; a confirmed but
    // unchanged account is their only periodic refresh trigger.
    mockAccountConfirmed?.();
    expect(mockRefreshFlags).toHaveBeenCalledTimes(1);
    expect(mockInvalidateFlags).not.toHaveBeenCalled();
    expect(getLabsExperimentsService().getSnapshot().generation).toBe(
      generation,
    );
  });
  it('ignores membership order but invalidates changed targeting without resetting choices', async () => {
    const account = accountEntry('signed-key', 'account-a');
    const org = {
      id: 'org-a',
      name: 'Test org',
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
    account.organizations = [org, { ...org, id: 'org-b' }];
    mockAccount = account;
    await initializeLabsExperimentsService();
    const generation = getLabsExperimentsService().getSnapshot().generation;
    mockSubscriber?.({
      ...account,
      organizations: [...account.organizations].reverse(),
    });
    expect(mockInvalidateFlags).not.toHaveBeenCalled();
    mockSubscriber?.({ ...account, organizations: [org] });
    expect(mockInvalidateFlags).toHaveBeenCalledTimes(1);
    expect(getLabsExperimentsService().getSnapshot().generation).toBe(
      generation,
    );
  });
  it('invalidates flags synchronously when the account identity changes', async () => {
    mockAccount = accountEntry('signed-key', 'account-a');
    await initializeLabsExperimentsService();
    mockSubscriber?.(accountEntry('other-key', 'account-b'));
    expect(mockInvalidateFlags).toHaveBeenCalledTimes(1);
    expect(getLabsExperimentsService().getSnapshot().scope).toBe(
      JSON.stringify(['https://server.example.invalid', 'account-b']),
    );
  });

  it.each([
    null,
    { apiKey: 'guest-key', authMode: 'guest', account: { id: 'guest-id' } },
    {
      apiKey: 'guest-key',
      credentialSource: 'guest',
      account: { id: 'guest-id' },
    },
  ])(
    'uses only durable local choices for signed-out or guest identity %p',
    async (account) => {
      mockAccount = account;
      await initializeLabsExperimentsService();
      const service = getLabsExperimentsService();
      expect(service.getSnapshot()).toMatchObject({
        scope: 'local',
        earlyAccessEnabled: true,
      });
      await service.setChoice({ experimentId: 'early-access', enabled: false });
      expect(mockRequest).not.toHaveBeenCalled();
    },
  );
  it('separates server/account identity from local without merging and binds requests to captured credentials', async () => {
    mockAccount = { apiKey: 'signed-key', account: { id: 'account-a' } };
    await initializeLabsExperimentsService();
    expect(getLabsExperimentsService().getSnapshot()).toMatchObject({
      scope: JSON.stringify(['https://server.example.invalid', 'account-a']),
      earlyAccessEnabled: false,
    });
    expect(mockRequest).toHaveBeenCalledWith('/api/v1/experiments/choices', {
      headers: { 'x-labs-experiments-version': '2' },
      credentialContext: {
        baseUrl: 'https://server.example.invalid',
        apiKey: 'signed-key',
      },
    });
    mockSubscriber?.(null);
    await getLabsExperimentsService().flush();
    expect(getLabsExperimentsService().getSnapshot()).toMatchObject({
      scope: 'local',
      earlyAccessEnabled: true,
    });
  });
});
