import type {
  AgentAuditEntry,
  AgentObservabilityUpdateEvent,
} from '@canopy/desktop-shared/types/observability';

type ObsListener = (event: AgentObservabilityUpdateEvent) => void;
const subscribeMock = jest.fn<() => void, [ObsListener]>();
const recordSessionDiagnosticMock = jest.fn();
const readSharedRunMetadataMock = jest.fn();
const shareRunMock = jest.fn();

jest.mock('../observability', () => ({
  getObservabilityService: (): {
    subscribe: typeof subscribeMock;
    recordSessionDiagnostic: typeof recordSessionDiagnosticMock;
  } => ({
    subscribe: subscribeMock,
    recordSessionDiagnostic: recordSessionDiagnosticMock,
  }),
}));

jest.mock('../lib/chat-tabs-reader', () => ({
  readSharedRunMetadata: (...args: unknown[]): unknown =>
    readSharedRunMetadataMock(...args),
}));

jest.mock('../lib/shared-run-sync', () => ({
  shareRun: (...args: unknown[]): unknown => shareRunMock(...args),
}));

import { getSharedRunAutoUpdater } from '../services/shared-run-auto-updater';

const DEBOUNCE_MS = 10_000;

function auditEntry(overrides: Partial<AgentAuditEntry> = {}): AgentAuditEntry {
  return {
    eventType: 'worktree_chat',
    status: 'success',
    projectId: 'proj',
    worktreeId: 'wt',
    chatId: 'chat-1',
    ...overrides,
  } as AgentAuditEntry;
}

function emit(entries: AgentAuditEntry[]): void {
  const event: AgentObservabilityUpdateEvent = { type: 'entries', entries };
  subscribeMock.mock.calls[0]?.[0]?.(event);
}

describe('SharedRunAutoUpdater', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    subscribeMock.mockReturnValue(() => undefined);
    readSharedRunMetadataMock.mockResolvedValue({
      externalId: 'run-ext',
      shareScope: 'organization',
      organizationId: 'org-ext',
      sharedAt: '2026-07-10T00:00:00.000Z',
    });
    shareRunMock.mockResolvedValue({ externalId: 'run-ext' });
    getSharedRunAutoUpdater().start();
  });

  afterEach(() => {
    getSharedRunAutoUpdater().shutdown();
    jest.useRealTimers();
  });

  it('re-shares a shared chat after a finished conversation turn (debounced)', async () => {
    emit([auditEntry()]);
    // Debounced: nothing fires immediately.
    expect(shareRunMock).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(shareRunMock).toHaveBeenCalledTimes(1);
    expect(shareRunMock).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      shareScope: 'organization',
      preserveExistingOwner: true,
      organizationId: 'org-ext',
    });
  });

  it('also updates a shared standalone (cowork) chat', async () => {
    emit([auditEntry({ eventType: 'standalone_chat' })]);
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(shareRunMock).toHaveBeenCalledTimes(1);
  });

  it('ignores helper events (branch naming, chat summary) and in-flight turns', async () => {
    emit([
      auditEntry({ eventType: 'branch_naming' }),
      auditEntry({ eventType: 'chat_summary' }),
      auditEntry({ eventType: 'worktree_summary' }),
      auditEntry({ status: 'running' }),
    ]);
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(shareRunMock).not.toHaveBeenCalled();
  });

  it('does not re-share a chat that is not shared', async () => {
    readSharedRunMetadataMock.mockResolvedValue(null);
    emit([auditEntry()]);
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(shareRunMock).not.toHaveBeenCalled();
  });

  it('coalesces a burst of turns for one chat into a single re-share', async () => {
    emit([auditEntry()]);
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS / 2);
    emit([auditEntry()]); // resets the debounce
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS / 2);
    // The first window was superseded; still nothing yet.
    expect(shareRunMock).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS / 2);
    expect(shareRunMock).toHaveBeenCalledTimes(1);
  });

  it('preserves the selected team when re-sharing', async () => {
    readSharedRunMetadataMock.mockResolvedValue({
      externalId: 'run-ext',
      shareScope: 'team',
      teamId: 'team-ext',
      sharedAt: '2026-07-10T00:00:00.000Z',
    });
    emit([auditEntry()]);
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(shareRunMock).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      shareScope: 'team',
      preserveExistingOwner: true,
      teamId: 'team-ext',
    });
  });

  it('does not re-share a legacy private run after later turns', async () => {
    // A private run share is a hidden copy nobody else can read, and its
    // Manage/Unshare controls are gone, so it is not kept up to date.
    readSharedRunMetadataMock.mockResolvedValue({
      externalId: 'run-ext',
      shareScope: 'private',
      sharedAt: '2026-07-10T00:00:00.000Z',
    });
    emit([auditEntry()]);
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(shareRunMock).not.toHaveBeenCalled();
  });

  it('does not re-share after shutdown clears pending timers', async () => {
    emit([auditEntry()]);
    getSharedRunAutoUpdater().shutdown();
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(shareRunMock).not.toHaveBeenCalled();
  });

  it('cancelPending stops a pending re-share (unshare race)', async () => {
    emit([auditEntry()]);
    // Unshare cancels the pending timer before it fires — no resurrection.
    getSharedRunAutoUpdater().cancelPending('proj', 'wt', 'chat-1');
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(shareRunMock).not.toHaveBeenCalled();
  });

  it('records a session diagnostic when a re-share fails (best-effort)', async () => {
    shareRunMock.mockRejectedValue(new Error('network'));
    emit([auditEntry()]);
    await expect(
      jest.advanceTimersByTimeAsync(DEBOUNCE_MS),
    ).resolves.not.toThrow();
    expect(shareRunMock).toHaveBeenCalledTimes(1);
    expect(recordSessionDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'shared_run_reshare_failed',
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat-1',
      }),
    );
  });
});
