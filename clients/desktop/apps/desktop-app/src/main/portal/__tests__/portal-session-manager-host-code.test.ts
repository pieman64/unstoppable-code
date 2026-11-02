import type * as PortalSessionManagerModule from '../portal-session-manager';
import type {
  CreatePortalSessionRequest,
  CreatePortalSessionResponse,
  PortalHeartbeatRequest,
  PortalHeartbeatResponse,
} from '@canopy/protocol/portal';

const mockIsEnabled = jest.fn();
const mockLoadCanopyCloudAccount = jest.fn();
const mockCreatePortalSession = jest.fn<
  Promise<CreatePortalSessionResponse>,
  [CreatePortalSessionRequest]
>();
const mockEndPortalSession = jest.fn();
const mockPollPortalCommands = jest.fn();
const mockSendPortalEvents = jest.fn();
const mockSendPortalHeartbeat = jest.fn<
  Promise<PortalHeartbeatResponse>,
  [{ sessionId: string; signal?: AbortSignal } & PortalHeartbeatRequest]
>();
const mockReadPortalStateStore = jest.fn();
const mockPersistPortalStopReason = jest.fn();
const mockPersistPortalEventOutbox = jest.fn();
const mockPersistCompletedPortalCommand = jest.fn();
const mockPersistPortalCommandCursor = jest.fn();
const mockClearActivePortalSession = jest.fn();
const mockReadCompletedPortalCommand = jest.fn();
const mockRecordAppDiagnostic = jest.fn();
const mockRecordSessionDiagnostic = jest.fn();
const mockClearWorktreeSummaryPortalFingerprints = jest.fn();
const mockResolvePortalClientPlatform = jest.fn();

jest.mock('../../account-proxy/service', () => ({
  getAccountProxyStatus: jest.fn(() => Promise.resolve(null)),
  onAccountProxyInventoryChanged: jest.fn(() => jest.fn()),
}));
jest.mock('../../agents/ai-credits-routing', () => ({
  isAiCreditsChosenOverAccountProxy: jest.fn(() => false),
  subscribeAiCreditsRoutingModeChanges: jest.fn(() => jest.fn()),
}));
jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): { isEnabled: typeof mockIsEnabled } => ({
    isEnabled: mockIsEnabled,
  }),
}));
jest.mock('../../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: mockLoadCanopyCloudAccount,
  subscribeCanopyCloudAccountChanges: jest.fn(() => jest.fn()),
}));
jest.mock('../canopy-portal-client', () => ({
  CanopyPortalClientError: class CanopyPortalClientError extends Error {
    code: string;
    status: number;
    constructor(code = 'http-error', message = '', status = 500) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
  assertLiveCanopyPortalSupport: jest.fn(),
  createPortalSession: mockCreatePortalSession,
  endPortalSession: mockEndPortalSession,
  pollPortalCommands: mockPollPortalCommands,
  sendPortalEvents: mockSendPortalEvents,
  sendPortalHeartbeat: mockSendPortalHeartbeat,
}));
jest.mock('../portal-client-platform', () => ({
  resolvePortalClientPlatform: mockResolvePortalClientPlatform,
  isPortalHostCode: (value: unknown): value is string =>
    typeof value === 'string' && /^[0-9a-hjkmnp-tv-z]{10}$/.test(value),
}));
jest.mock('../portal-state-store', () => ({
  clearActivePortalSession: mockClearActivePortalSession,
  persistCompletedPortalCommand: mockPersistCompletedPortalCommand,
  persistActivePortalSession: jest.fn(),
  persistPortalCommandCursor: mockPersistPortalCommandCursor,
  persistPortalEventOutbox: mockPersistPortalEventOutbox,
  persistPortalStopReason: mockPersistPortalStopReason,
  readCompletedPortalCommand: mockReadCompletedPortalCommand,
  readPortalStateStore: mockReadPortalStateStore,
}));
jest.mock('../../services/terminal-service', () => ({
  subscribeTerminalPortalEvents: jest.fn(() => jest.fn()),
}));
const mockObservabilityListeners = new Set<(event: unknown) => void>();
const mockObservabilitySubscribe = jest.fn(
  (listener: (event: unknown) => void): (() => void) => {
    mockObservabilityListeners.add(listener);
    return (): void => {
      mockObservabilityListeners.delete(listener);
    };
  },
);
jest.mock('../../observability', (): unknown => ({
  getObservabilityService: () => ({
    recordAppDiagnostic: mockRecordAppDiagnostic,
    recordSessionDiagnostic: mockRecordSessionDiagnostic,
    subscribe: mockObservabilitySubscribe,
    getUsageOverview: jest.fn(),
  }),
}));
jest.mock('../../lib/worktree-summary-persistence', () => ({
  clearWorktreeSummaryPortalFingerprints:
    mockClearWorktreeSummaryPortalFingerprints,
}));
const mockHandlePortalCommand = jest.fn();
const mockExecutePortalStateRequest = jest.fn();
jest.mock('../portal-command-handlers', () => ({
  handlePortalCommand: mockHandlePortalCommand,
  executePortalStateRequest: mockExecutePortalStateRequest,
  normalizeStateRequestPayload: (payload: unknown): unknown =>
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? { scope: 'overview', ...payload }
      : { scope: 'overview' },
}));

import type { CanopyPortalState } from '@canopy/desktop-shared/types';
const {
  getCanopyPortalState,
  onCanopyPortalStateChanged,
  resumeCanopyPortalIfPossible,
  startCanopyPortal,
  stopCanopyPortal,
} = jest.requireActual<typeof PortalSessionManagerModule>(
  '../portal-session-manager',
);

async function startSession(): Promise<void> {
  await startCanopyPortal();
}

async function advanceHeartbeatTimers(milliseconds = 15_000): Promise<void> {
  await jest.advanceTimersByTimeAsync(milliseconds);
}

async function pumpAsync(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('Portal session host code', () => {
  beforeEach(async () => {
    jest.useRealTimers();
    jest.clearAllMocks();
    mockIsEnabled.mockReturnValue(true);
    mockResolvePortalClientPlatform.mockReturnValue('mac');
    mockLoadCanopyCloudAccount.mockResolvedValue({
      apiKey: 'test-key',
      capabilities: ['portal-v1'],
    });
    mockCreatePortalSession.mockResolvedValue({
      sessionId: 'session-1',
      status: 'pending_auth',
      pendingExpiresAt: '2099-01-01T00:00:00.000Z',
      commandCursor: 0,
    });
    mockEndPortalSession.mockResolvedValue(undefined);
    mockPollPortalCommands.mockImplementation(
      () => new Promise(() => undefined),
    );
    mockSendPortalEvents.mockResolvedValue({
      accepted: 0,
      duplicates: 0,
      connectionStatus: 'active',
    });
    mockSendPortalHeartbeat.mockResolvedValue({ ok: true, status: 'active' });
    mockReadPortalStateStore.mockResolvedValue({
      clientDeviceId: 'device-1',
      eventOutbox: [],
    });
    mockPersistPortalStopReason.mockResolvedValue(undefined);
    mockPersistPortalEventOutbox.mockResolvedValue(undefined);
    mockPersistCompletedPortalCommand.mockResolvedValue(undefined);
    mockPersistPortalCommandCursor.mockResolvedValue(undefined);
    mockClearActivePortalSession.mockResolvedValue(undefined);
    mockReadCompletedPortalCommand.mockResolvedValue(null);

    await stopCanopyPortal();
    jest.clearAllMocks();
    mockIsEnabled.mockReturnValue(true);
    mockResolvePortalClientPlatform.mockReturnValue('mac');
    mockLoadCanopyCloudAccount.mockResolvedValue({
      apiKey: 'test-key',
      capabilities: ['portal-v1'],
    });
    mockCreatePortalSession.mockResolvedValue({
      sessionId: 'session-1',
      status: 'pending_auth',
      pendingExpiresAt: '2099-01-01T00:00:00.000Z',
      commandCursor: 0,
    });
    mockEndPortalSession.mockResolvedValue(undefined);
    mockPollPortalCommands.mockImplementation(
      () => new Promise(() => undefined),
    );
    mockSendPortalEvents.mockResolvedValue({
      accepted: 0,
      duplicates: 0,
      connectionStatus: 'active',
    });
    mockSendPortalHeartbeat.mockResolvedValue({ ok: true, status: 'active' });
    mockReadPortalStateStore.mockResolvedValue({
      clientDeviceId: 'device-1',
      eventOutbox: [],
    });
    mockPersistPortalStopReason.mockResolvedValue(undefined);
    mockPersistPortalEventOutbox.mockResolvedValue(undefined);
    mockPersistCompletedPortalCommand.mockResolvedValue(undefined);
    mockPersistPortalCommandCursor.mockResolvedValue(undefined);
    mockClearActivePortalSession.mockResolvedValue(undefined);
    mockReadCompletedPortalCommand.mockResolvedValue(null);
  });

  afterEach(async () => {
    try {
      await stopCanopyPortal();
    } finally {
      jest.useRealTimers();
    }
  });

  it('announces the platform and broadcasts a valid code from the scheduled heartbeat', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    mockSendPortalHeartbeat.mockResolvedValue({
      ok: true,
      status: 'pending_auth',
      hostCode: 'k3m9p2x7qa',
    });
    const changedStates: CanopyPortalState[] = [];
    const unsubscribe = onCanopyPortalStateChanged((nextState) => {
      changedStates.push(nextState);
    });

    try {
      await startSession();
      expect(mockCreatePortalSession).toHaveBeenCalledWith(
        expect.objectContaining({ clientPlatform: 'mac' }),
      );
      expect(getCanopyPortalState().hostCode).toBeNull();

      await advanceHeartbeatTimers();

      expect(mockSendPortalHeartbeat).toHaveBeenCalledWith(
        expect.objectContaining({ clientPlatform: 'mac' }),
      );
      expect(getCanopyPortalState().hostCode).toBe('k3m9p2x7qa');
      expect(
        changedStates.filter(
          (nextState) => nextState.hostCode === 'k3m9p2x7qa',
        ),
      ).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it('keeps a missing heartbeat code null and does not clear an existing code', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    mockSendPortalHeartbeat
      .mockResolvedValueOnce({ ok: true, status: 'pending_auth' })
      .mockResolvedValueOnce({
        ok: true,
        status: 'pending_auth',
        hostCode: 'k3m9p2x7qa',
      })
      .mockResolvedValueOnce({ ok: true, status: 'pending_auth' });

    await startSession();
    expect(getCanopyPortalState().hostCode).toBeNull();
    await advanceHeartbeatTimers();
    expect(getCanopyPortalState().hostCode).toBeNull();
    await advanceHeartbeatTimers(30_000);
    expect(getCanopyPortalState().hostCode).toBe('k3m9p2x7qa');
  });

  it('ignores an invalid heartbeat host code', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    mockSendPortalHeartbeat.mockResolvedValue({
      ok: true,
      status: 'pending_auth',
      hostCode: 'K3M9P2X7QA',
    });

    await startSession();
    await advanceHeartbeatTimers();

    expect(getCanopyPortalState().hostCode).toBeNull();
  });

  it('resets the host code when stopping a session', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    mockSendPortalHeartbeat.mockResolvedValue({
      ok: true,
      status: 'pending_auth',
      hostCode: 'k3m9p2x7qa',
    });

    await startSession();
    await advanceHeartbeatTimers();
    expect(getCanopyPortalState().hostCode).toBe('k3m9p2x7qa');

    await stopCanopyPortal();

    expect(getCanopyPortalState().hostCode).toBeNull();
  });

  it('omits the platform from session creation and scheduled heartbeat when unavailable', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    mockResolvePortalClientPlatform.mockReturnValue(undefined);

    await startSession();
    const createRequest = mockCreatePortalSession.mock.calls[0]?.[0];
    if (!createRequest || typeof createRequest !== 'object') {
      throw new Error('Expected a create session request');
    }
    expect(
      Object.prototype.hasOwnProperty.call(createRequest, 'clientPlatform'),
    ).toBe(false);

    await advanceHeartbeatTimers();
    const heartbeatRequest = mockSendPortalHeartbeat.mock.calls[0]?.[0];
    if (!heartbeatRequest || typeof heartbeatRequest !== 'object') {
      throw new Error('Expected a heartbeat request');
    }
    expect(
      Object.prototype.hasOwnProperty.call(heartbeatRequest, 'clientPlatform'),
    ).toBe(false);
  });

  it('captures the host code from the immediate heartbeat when resuming', async () => {
    mockReadPortalStateStore.mockResolvedValue({
      clientDeviceId: 'device-1',
      activeSession: {
        serverId: 'canopy-cloud',
        sessionId: 'session-1',
        commandCursor: 0,
        activatedAt: '2026-07-31T00:00:00.000Z',
        lastSeenAt: null,
      },
      lastStopReason: 'app_shutdown',
      eventOutbox: [],
    });
    mockSendPortalHeartbeat.mockResolvedValue({
      ok: true,
      status: 'pending_auth',
      hostCode: 'k3m9p2x7qa',
    });

    await resumeCanopyPortalIfPossible();
    await pumpAsync();

    expect(mockSendPortalHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        clientPlatform: 'mac',
      }),
    );
    expect(getCanopyPortalState().hostCode).toBe('k3m9p2x7qa');
  });
});
