import { createHash } from 'node:crypto';
import type {
  AgentAuditEntry,
  AgentAuditEventType,
  AgentObservabilityUpdateEvent,
} from '@canopy/desktop-shared/types/observability';
import {
  clampTelemetryClientId,
  MAX_TELEMETRY_CLIENT_ID_LENGTH,
} from '@canopy/protocol/telemetry';
import type { WorkOwnerOrganization } from '../lib/work-owner';

type ObsListener = (event: AgentObservabilityUpdateEvent) => void;
const unsubscribeMock = jest.fn();
const subscribeMock = jest.fn<() => void, [ObsListener]>();
const resolveOwnerMock = jest.fn<
  Promise<WorkOwnerOrganization>,
  [{ projectId: string; worktreeId: string }, () => Promise<unknown>]
>();
const reportMock = jest.fn<
  Promise<void>,
  [{ turnKey: string; organizationExternalId: string | undefined }]
>();
const clearRetryTimersMock = jest.fn();
const telemetrySyncAccessMock = jest.fn();

jest.mock('../observability', () => ({
  getObservabilityService: (): { subscribe: typeof subscribeMock } => ({
    subscribe: subscribeMock,
  }),
}));

jest.mock('../lib/work-owner', () => ({
  ambientWorkOwnerContext: (): Promise<null> => Promise.resolve(null),
  resolveWorkOwnerOrganization: (
    ...args: Parameters<typeof resolveOwnerMock>
  ): Promise<WorkOwnerOrganization> => resolveOwnerMock(...args),
}));

jest.mock('../canopy-cloud/product-activity-events', () => ({
  clearProductActivityRetryTimers: (): void => {
    clearRetryTimersMock();
  },
  reportDesktopChatTurnActivity: (
    ...args: Parameters<typeof reportMock>
  ): Promise<void> => reportMock(...args),
}));

// The reporter counts turns whatever the sharing scopes say. Any read of the
// telemetry sync service (its Off gate, scopes, or org policy) fails the test.
jest.mock('../services/telemetry-sync-service', () => ({
  getTelemetrySyncService: (): never => {
    telemetrySyncAccessMock();
    throw new Error('the product activity reporter must not read sharing');
  },
}));

import {
  disposeProductActivityReporter,
  initializeProductActivityReporter,
} from '../services/product-activity-reporter';

// sha256('turn-1'), the vector shared with the protocol and web tests.
const TURN_1_KEY =
  '974cad2dd603827b06e9e6affa3de03db5af2c12c045db679a7b1bef42b41a1c';
const ORGANIZATION_ID = 'e2e1a0c4-7d3b-4c2a-9f10-0000000c3561';

function auditEntry(overrides: Partial<AgentAuditEntry> = {}): AgentAuditEntry {
  return {
    id: 'turn-1',
    eventType: 'worktree_chat',
    status: 'running',
    projectId: 'proj',
    worktreeId: 'wt',
    chatId: 'chat-1',
    ...overrides,
  } as AgentAuditEntry;
}

function listener(index = 0): ObsListener {
  const registered = subscribeMock.mock.calls[index]?.[0];
  if (!registered) throw new Error('the reporter has not subscribed');
  return registered;
}

function emit(entries: AgentAuditEntry[], index = 0): void {
  listener(index)({ type: 'entries', entries });
}

/** Lets owner resolution and the detached send settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function deferredOwner(): {
  promise: Promise<WorkOwnerOrganization>;
  resolve: (owner: WorkOwnerOrganization) => void;
} {
  let resolve: (owner: WorkOwnerOrganization) => void = () => undefined;
  const promise = new Promise<WorkOwnerOrganization>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('product activity reporter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    subscribeMock.mockReturnValue(unsubscribeMock);
    resolveOwnerMock.mockResolvedValue({ kind: 'none' });
    reportMock.mockResolvedValue(undefined);
    initializeProductActivityReporter();
  });

  afterEach(() => {
    disposeProductActivityReporter();
  });

  it.each<AgentAuditEventType>([
    'worktree_chat',
    'standalone_chat',
    'app_advisor',
    'worktree_plan_chat',
  ])(
    'reports a running %s turn without consulting sharing scopes or flags',
    async (eventType) => {
      emit([auditEntry({ eventType })]);
      await settle();

      expect(reportMock).toHaveBeenCalledTimes(1);
      expect(reportMock).toHaveBeenCalledWith({
        turnKey: TURN_1_KEY,
        organizationExternalId: undefined,
      });
      expect(telemetrySyncAccessMock).not.toHaveBeenCalled();
    },
  );

  // Automation, hook, and Remote Control turns carry no marker of their own:
  // they arrive as ordinary chat audit entries, so they count like any other.
  it("doesn't count an autonomous turn's entry, such as a wake", async () => {
    emit([auditEntry({ id: 'wake-turn', autonomous: true })]);
    await settle();
    expect(reportMock).not.toHaveBeenCalled();
  });

  it('counts an automation-started turn', async () => {
    emit([
      auditEntry({
        id: 'automation-run-7-turn-1',
        eventType: 'standalone_chat',
        label: 'Automation: nightly triage',
      }),
    ]);
    await settle();

    expect(reportMock).toHaveBeenCalledTimes(1);
  });

  it.each<AgentAuditEventType>([
    'pipeline_editor',
    'pipeline_agent_turn',
    'pr_generation',
    'chat_summary',
    'worktree_summary',
    'branch_naming',
    'worktree_plan_diagram',
  ])('ignores %s entries', async (eventType) => {
    emit([auditEntry({ eventType })]);
    await settle();

    expect(reportMock).not.toHaveBeenCalled();
    expect(resolveOwnerMock).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure', 'cancelled', 'interrupted'] as const)(
    'ignores a %s entry that was never seen running',
    async (status) => {
      emit([auditEntry({ status })]);
      await settle();

      expect(reportMock).not.toHaveBeenCalled();
    },
  );

  it('ignores updates that are not audit entries', async () => {
    listener()({ type: 'retention', retentionDays: 30 });
    await settle();

    expect(reportMock).not.toHaveBeenCalled();
  });

  it('reports a turn once across repeated running emissions', async () => {
    emit([auditEntry()]);
    await settle();
    emit([auditEntry(), auditEntry()]);
    emit([auditEntry({ status: 'success' })]);
    await settle();

    expect(reportMock).toHaveBeenCalledTimes(1);
  });

  it('reports a turn once when a duplicate arrives during owner resolution', async () => {
    const owner = deferredOwner();
    resolveOwnerMock.mockReturnValue(owner.promise);

    emit([auditEntry()]);
    emit([auditEntry()]);
    expect(resolveOwnerMock).toHaveBeenCalledTimes(1);

    owner.resolve({ kind: 'none' });
    await settle();
    expect(reportMock).toHaveBeenCalledTimes(1);
  });

  it('bounds the seen set and evicts the oldest turn first', async () => {
    emit([auditEntry({ id: 'turn-oldest' })]);
    for (let i = 0; i < 2_000; i += 1) {
      emit([auditEntry({ id: `turn-fill-${i}` })]);
    }
    await settle();
    expect(reportMock).toHaveBeenCalledTimes(2_001);

    // Still remembered: the most recent 2,000 are not reported again.
    emit([auditEntry({ id: 'turn-fill-0' })]);
    await settle();
    expect(reportMock).toHaveBeenCalledTimes(2_001);

    // Evicted: the oldest ID is no longer remembered, so it reports again.
    // The server's dedupe key is what keeps that from double counting.
    emit([auditEntry({ id: 'turn-oldest' })]);
    await settle();
    expect(reportMock).toHaveBeenCalledTimes(2_002);
  });

  it('hashes the clamped ID for an overlength turn ID', async () => {
    const overlength = `turn-${'x'.repeat(300)}`;
    // The same clamp ambient telemetry ingest applies to `clientTurnId`, so
    // the signal and the later upload produce one dedupe key.
    const clamped = clampTelemetryClientId(overlength);
    expect(clamped).toHaveLength(MAX_TELEMETRY_CLIENT_ID_LENGTH);

    emit([auditEntry({ id: overlength })]);
    await settle();

    const [{ turnKey }] = reportMock.mock.calls[0];
    expect(turnKey).toBe(createHash('sha256').update(clamped).digest('hex'));
    // Never the digest of the raw ID: the server only ever sees the clamp.
    expect(turnKey).not.toBe(
      createHash('sha256').update(overlength).digest('hex'),
    );
  });

  it('sends the owning organization and resolves it with the ambient context', async () => {
    resolveOwnerMock.mockResolvedValue({
      kind: 'organization',
      organizationId: ORGANIZATION_ID,
    });

    emit([auditEntry()]);
    await settle();

    expect(resolveOwnerMock).toHaveBeenCalledTimes(1);
    const [target, getContext] = resolveOwnerMock.mock.calls[0];
    expect(target).toEqual({ projectId: 'proj', worktreeId: 'wt' });
    // Ambient: the selected organization is never consulted for the count.
    await expect(getContext()).resolves.toBeNull();
    expect(reportMock).toHaveBeenCalledWith({
      turnKey: TURN_1_KEY,
      organizationExternalId: ORGANIZATION_ID,
    });
  });

  it.each<[string, WorkOwnerOrganization]>([
    ['an ungoverned owner', { kind: 'none' }],
    ['an unknown owner', { kind: 'unknown' }],
  ])(
    'still reports the turn with no organization for %s',
    async (_l, owner) => {
      resolveOwnerMock.mockResolvedValue(owner);

      emit([auditEntry()]);
      await settle();

      expect(reportMock).toHaveBeenCalledWith({
        turnKey: TURN_1_KEY,
        organizationExternalId: undefined,
      });
    },
  );

  it.each<[string, Partial<AgentAuditEntry>]>([
    ['no project ID', { projectId: undefined }],
    ['no worktree ID', { worktreeId: undefined }],
  ])('reports without resolving an owner when there is %s', async (_l, ids) => {
    emit([auditEntry(ids)]);
    await settle();

    expect(resolveOwnerMock).not.toHaveBeenCalled();
    expect(reportMock).toHaveBeenCalledWith({
      turnKey: TURN_1_KEY,
      organizationExternalId: undefined,
    });
  });

  it('still reports the turn when owner resolution throws', async () => {
    resolveOwnerMock.mockRejectedValue(new Error('registry unreadable'));

    emit([auditEntry()]);
    await settle();

    expect(reportMock).toHaveBeenCalledWith({
      turnKey: TURN_1_KEY,
      organizationExternalId: undefined,
    });
  });

  it('does not let a failing sender escape the observability callback', async () => {
    reportMock.mockRejectedValue(new Error('sender bug'));

    expect(() => emit([auditEntry()])).not.toThrow();
    await settle();
  });

  it('subscribes once however many times it is initialized', () => {
    initializeProductActivityReporter();
    initializeProductActivityReporter();

    expect(subscribeMock).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes and clears sender retries on dispose, and tolerates a second dispose', () => {
    disposeProductActivityReporter();
    disposeProductActivityReporter();

    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
    expect(clearRetryTimersMock).toHaveBeenCalled();
  });

  it('does not send when disposed while owner resolution is pending', async () => {
    const owner = deferredOwner();
    resolveOwnerMock.mockReturnValue(owner.promise);
    emit([auditEntry()]);

    disposeProductActivityReporter();
    owner.resolve({ kind: 'organization', organizationId: ORGANIZATION_ID });
    await settle();

    expect(reportMock).not.toHaveBeenCalled();
  });

  it('starts a clean lifecycle when initialized again after dispose', async () => {
    const owner = deferredOwner();
    resolveOwnerMock.mockReturnValueOnce(owner.promise);
    emit([auditEntry()]);
    disposeProductActivityReporter();

    initializeProductActivityReporter();
    expect(subscribeMock).toHaveBeenCalledTimes(2);

    // The seen set was cleared: the same turn reports in the new lifecycle.
    emit([auditEntry()], 1);
    await settle();
    expect(reportMock).toHaveBeenCalledTimes(1);

    // The first lifecycle's pending resolution stays invalidated.
    owner.resolve({ kind: 'none' });
    await settle();
    expect(reportMock).toHaveBeenCalledTimes(1);
  });
});
