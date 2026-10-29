/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { ShareRunRequest } from '@canopy/desktop-shared/types';
import type { SharedRunCreateRequest } from '@canopy/protocol/runs';

const loadHistoryMock = jest.fn();
const getRetentionDaysMock = jest.fn<number, []>();
const ingestSessionForShareMock = jest.fn();
const createSharedRunMock = jest.fn<
  Promise<{ externalId: string }>,
  [SharedRunCreateRequest]
>();
const unshareSharedRunByClientLocalIdMock = jest.fn<
  Promise<{ unshared: boolean }>,
  [string]
>();
const flushChatScopeMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: () => ({ flushScope: flushChatScopeMock }),
}));
const readDiffMock = jest.fn();
const rollupFromEntriesMock = jest.fn();
const readWorktreeSummaryMock = jest.fn();
const listTrackedPlansMock = jest.fn();
const loadStoredTelemetryEnforcementByOrganizationMock = jest.fn();
const recordTelemetryEnforcementReadFailureMock = jest.fn();
const resolveWorkOwnerOrganizationMock = jest.fn();

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    loadHistory: loadHistoryMock,
    getRetentionDays: getRetentionDaysMock,
  })),
}));

jest.mock('../services/telemetry-sync-service', () => ({
  getTelemetrySyncService: jest.fn(() => ({
    ingestSessionForShare: ingestSessionForShareMock,
  })),
}));

jest.mock('../runs/canopy-server-client', () => ({
  createSharedRun: createSharedRunMock,
  unshareSharedRunByClientLocalId: unshareSharedRunByClientLocalIdMock,
}));

jest.mock('../services/diff-service', () => ({
  readDiff: readDiffMock,
}));

jest.mock('../lib/shared-run-rollup', () => ({
  rollupFromEntries: rollupFromEntriesMock,
}));

jest.mock('../lib/worktree-summary-persistence', () => ({
  readWorktreeSummary: readWorktreeSummaryMock,
}));

jest.mock('../lib/plan-persistence', () => ({
  listTrackedPlans: listTrackedPlansMock,
}));

jest.mock('../lib/telemetry-enforcement-state', () => ({
  loadStoredTelemetryEnforcementByOrganization: (): unknown =>
    loadStoredTelemetryEnforcementByOrganizationMock(),
  recordTelemetryEnforcementReadFailure: (
    reason: string,
    error: unknown,
  ): void => {
    recordTelemetryEnforcementReadFailureMock(reason, error);
  },
}));

jest.mock('../lib/work-owner', () => ({
  resolveWorkOwnerOrganization: (...args: unknown[]): unknown =>
    resolveWorkOwnerOrganizationMock(...args),
}));

jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: () => ({
    getState: () => ({
      context: {
        kind: 'organization',
        organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    }),
  }),
}));

// Per-org billing state (CAN-2311). Default: nothing lapsed.
const resolveLapsedOrganizationNamesMock = jest.fn<
  Promise<string[]>,
  [string[]]
>();
jest.mock('../lib/org-billing-state', () => ({
  resolveLapsedOrganizationNames: (ids: string[]): Promise<string[]> =>
    resolveLapsedOrganizationNamesMock(ids),
}));

const getCanopyCloudCredentialsMock = jest.fn();
jest.mock('../lib/canopy-cloud-account-store', () => ({
  getCanopyCloudCredentials: (): unknown => getCanopyCloudCredentialsMock(),
}));

// Pure pass-through so title/diff assertions read the raw input.
jest.mock('@canopy/desktop-shared/lib/redaction', () => ({
  redactSecrets: (text: string): string => text,
}));

import {
  getShareRunEligibility,
  shareRun,
  unshareRun,
} from '../lib/shared-run-sync';

const NO_SCOPES = {
  transcripts: false,
  plans: false,
  metadata: false,
  summaries: false,
};

/** Nothing required, nothing prohibited — the unenforced default. */
function noEnforcement(): unknown {
  return new Map();
}

/** One org prohibiting `scope`, by name. */
function prohibiting(
  scope: 'transcripts' | 'plans' | 'metadata' | 'summaries',
  organizationName = 'Acme',
): unknown {
  return new Map([
    [
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      {
        organizationName,
        enforcement: {
          required: { ...NO_SCOPES },
          prohibited: { ...NO_SCOPES, [scope]: true },
        },
      },
    ],
  ]);
}

// Only the fields `shareRun` reads (chatId/status/label) need to be present;
// `rollupFromEntries` is mocked, so token/tool fields are unnecessary.
function auditEntry(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'entry-1',
    chatId: 'chat-1',
    status: 'success',
    label: 'Fix the flaky test',
    ...overrides,
  };
}

const baseRequest: ShareRunRequest = {
  projectId: 'ws-1',
  worktreeId: 'wt-1',
  chatId: 'chat-1',
  shareScope: 'organization',
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};

const UUID_V5_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('shareRun', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    loadHistoryMock.mockResolvedValue({
      entries: [auditEntry()],
      nextCursor: undefined,
    });
    getRetentionDaysMock.mockReturnValue(7);
    rollupFromEntriesMock.mockReturnValue({ turnCount: 1 });
    ingestSessionForShareMock.mockResolvedValue({
      status: 'ok',
      workspaceLocalId: 'ws-1-share',
      worktreeLocalId: 'wt-1-share',
    });
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      noEnforcement(),
    );
    resolveWorkOwnerOrganizationMock.mockResolvedValue({
      kind: 'organization',
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    readDiffMock.mockResolvedValue({ patch: 'diff --git a/x b/x' });
    createSharedRunMock.mockResolvedValue({ externalId: 'run-ext-1' });
    unshareSharedRunByClientLocalIdMock.mockResolvedValue({ unshared: true });
    // Default: no better title source, so the run falls back to the audit label.
    readWorktreeSummaryMock.mockResolvedValue(null);
    listTrackedPlansMock.mockResolvedValue([]);
    resolveLapsedOrganizationNamesMock.mockResolvedValue([]);
    getCanopyCloudCredentialsMock.mockResolvedValue({
      teams: [
        { id: 'team-lapsed', organization: { id: 'org-lapsed' } },
        { id: 'team-healthy', organization: { id: 'org-healthy' } },
      ],
    });
  });

  // -----------------------------------------------------------------------
  // Per-org billing gate (CAN-2311). Reuses the `blocked-by-org-policy` shape:
  // from the user's side a lapsed org and a prohibiting org are the same
  // situation — an org-side condition only an admin can lift.
  // -----------------------------------------------------------------------
  it('refuses a share with no audience instead of widening it to the organization', async () => {
    const withoutScope: ShareRunRequest = {
      projectId: baseRequest.projectId,
      worktreeId: baseRequest.worktreeId,
      chatId: baseRequest.chatId,
    };
    await expect(shareRun(withoutScope)).rejects.toThrow(
      'Choose a team or organization to share this run with.',
    );
    expect(loadHistoryMock).not.toHaveBeenCalled();
  });

  describe('lapsed target organization', () => {
    /** Lapse exactly `lapsedOrgId`, leaving every other org entitled. */
    function lapseOnly(lapsedOrgId: string, name: string): void {
      resolveLapsedOrganizationNamesMock.mockImplementation(
        (ids: string[]): Promise<string[]> =>
          Promise.resolve(ids.includes(lapsedOrgId) ? [name] : []),
      );
    }

    it('refuses an organization share into a lapsed org BEFORE any expensive work', async () => {
      lapseOnly('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Lapsed Co');

      await expect(shareRun(baseRequest)).resolves.toEqual({
        externalId: null,
        // A lapse reports its OWN reason. Borrowing the policy reason rendered
        // "sharing that data is blocked by Lapsed Co ... only an organization
        // admin can change this", which is false: the org has no sharing
        // prohibition, its subscription lapsed, and the remedy is to pay.
        reason: 'blocked-by-org-billing',
        auditRetentionDays: 7,
        blockedByOrganizationNames: ['Lapsed Co'],
      });
      expect(loadHistoryMock).not.toHaveBeenCalled();
      expect(readDiffMock).not.toHaveBeenCalled();
      expect(createSharedRunMock).not.toHaveBeenCalled();
    });

    // The load-bearing invariant: per-org, never a global kill switch.
    it('still shares into a HEALTHY org while another org the user belongs to is lapsed', async () => {
      lapseOnly('org-lapsed', 'Lapsed Co');

      await expect(
        shareRun({ ...baseRequest, organizationId: 'org-healthy' }),
      ).resolves.toEqual({ externalId: 'run-ext-1' });
      expect(createSharedRunMock).toHaveBeenCalled();
    });

    it('gates a team share by the team OWNING org, and only that one', async () => {
      lapseOnly('org-lapsed', 'Lapsed Co');
      const teamRequest: ShareRunRequest = {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        shareScope: 'team',
        teamId: 'team-lapsed',
      };

      await expect(shareRun(teamRequest)).resolves.toEqual({
        externalId: null,
        reason: 'blocked-by-org-billing',
        auditRetentionDays: 7,
        blockedByOrganizationNames: ['Lapsed Co'],
      });

      await expect(
        shareRun({ ...teamRequest, teamId: 'team-healthy' }),
      ).resolves.toEqual({ externalId: 'run-ext-1' });
    });

    it('never gates a private share, which has no target org', async () => {
      lapseOnly('org-lapsed', 'Lapsed Co');

      await expect(
        shareRun({
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
          shareScope: 'private',
        }),
      ).resolves.toEqual({ externalId: 'run-ext-1' });
      expect(resolveLapsedOrganizationNamesMock).not.toHaveBeenCalled();
    });

    it('fails open when the team lookup throws', async () => {
      getCanopyCloudCredentialsMock.mockRejectedValue(new Error('locked'));
      lapseOnly('org-lapsed', 'Lapsed Co');

      await expect(
        shareRun({
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
          shareScope: 'team',
          teamId: 'team-lapsed',
        }),
      ).resolves.toEqual({ externalId: 'run-ext-1' });
    });
  });

  it('titles the run from the worktree summary when present', async () => {
    readWorktreeSummaryMock.mockResolvedValue({
      title: '  Hero text change: "Ship faster with a team of agents"  ',
    });
    listTrackedPlansMock.mockResolvedValue([
      { title: 'Plan: Punchier hero headline', hidden: false },
    ]);

    await shareRun(baseRequest);

    expect(createSharedRunMock.mock.calls[0][0].title).toBe(
      'Hero text change: "Ship faster with a team of agents"',
    );
  });

  it('falls back to the latest active tracked plan title without a summary', async () => {
    readWorktreeSummaryMock.mockResolvedValue(null);
    listTrackedPlansMock.mockResolvedValue([
      { title: 'Hidden plan', hidden: true },
      { title: 'Dismissed plan', dismissedAt: '2026-07-09T00:00:00.000Z' },
      { title: 'Plan: Punchier hero headline', hidden: false },
    ]);

    await shareRun(baseRequest);

    expect(createSharedRunMock.mock.calls[0][0].title).toBe(
      'Plan: Punchier hero headline',
    );
  });

  it('falls back to the audit label when no summary or active plan exists', async () => {
    readWorktreeSummaryMock.mockResolvedValue({ title: '   ' });
    listTrackedPlansMock.mockResolvedValue([
      { title: 'Dismissed', dismissedAt: '2026-07-09T00:00:00.000Z' },
    ]);

    await shareRun(baseRequest);

    expect(createSharedRunMock.mock.calls[0][0].title).toBe(
      'Fix the flaky test',
    );
  });

  it('still shares when the title sources throw', async () => {
    readWorktreeSummaryMock.mockRejectedValue(new Error('fs error'));
    listTrackedPlansMock.mockRejectedValue(new Error('fs error'));

    await expect(shareRun(baseRequest)).resolves.toEqual({
      externalId: 'run-ext-1',
    });
    expect(createSharedRunMock.mock.calls[0][0].title).toBe(
      'Fix the flaky test',
    );
  });

  it('derives a deterministic UUIDv5 clientLocalRunId (same session → same key)', async () => {
    await shareRun(baseRequest);
    await shareRun(baseRequest);

    const key1 = createSharedRunMock.mock.calls[0][0].clientLocalRunId;
    const key2 = createSharedRunMock.mock.calls[1][0].clientLocalRunId;
    expect(key1).toMatch(UUID_V5_RE);
    expect(key2).toBe(key1);
  });

  it('produces a different key for a different chat id', async () => {
    await shareRun(baseRequest);
    loadHistoryMock.mockResolvedValue({
      entries: [auditEntry({ chatId: 'chat-2' })],
      nextCursor: undefined,
    });
    await shareRun({ ...baseRequest, chatId: 'chat-2' });

    const key1 = createSharedRunMock.mock.calls[0][0].clientLocalRunId;
    const key2 = createSharedRunMock.mock.calls[1][0].clientLocalRunId;
    expect(key2).not.toBe(key1);
  });

  it('throws when sharing to organization scope without an organizationId', async () => {
    await expect(
      shareRun({ ...baseRequest, organizationId: undefined }),
    ).rejects.toThrow(/organizationId/);
    expect(ingestSessionForShareMock).not.toHaveBeenCalled();
    expect(createSharedRunMock).not.toHaveBeenCalled();
  });

  it('creates a team-scoped grant for the selected team', async () => {
    await shareRun({
      ...baseRequest,
      shareScope: 'team',
      teamId: 'team-ext-1',
      organizationId: undefined,
    });

    expect(createSharedRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        shareScope: 'team',
        teamId: 'team-ext-1',
      }),
    );
  });

  it('creates a user-owned private grant through the redacted shared-run path', async () => {
    await expect(
      shareRun({
        ...baseRequest,
        shareScope: 'private',
        organizationId: undefined,
      }),
    ).resolves.toEqual({ externalId: 'run-ext-1' });
    expect(ingestSessionForShareMock).toHaveBeenCalled();
    expect(createSharedRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        shareScope: 'private',
      }),
    );
    expect(createSharedRunMock.mock.calls[0][0]).not.toHaveProperty('teamId');
    expect(createSharedRunMock.mock.calls[0][0]).not.toHaveProperty(
      'organizationId',
    );
  });

  it('marks background refreshes as owner-preserving', async () => {
    await shareRun({ ...baseRequest, preserveExistingOwner: true });

    expect(createSharedRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ preserveExistingOwner: true }),
    );
  });

  it('throws when ingestSessionForShare reports no activity (no grant created)', async () => {
    ingestSessionForShareMock.mockResolvedValue({ status: 'no-activity' });
    await expect(shareRun(baseRequest)).rejects.toThrow(/sync the session/i);
    expect(createSharedRunMock).not.toHaveBeenCalled();
  });

  // A run is built from audit entries, not the persisted transcript, so a chat
  // whose entries aged out of `auditRetentionDays` can never be shared again.
  // That is a permanent, explainable state — not a retryable failure — so the
  // response has to carry the reason rather than a bare null.
  it('reports no-activity with the retention window for a session with no finished turns', async () => {
    loadHistoryMock.mockResolvedValue({ entries: [], nextCursor: undefined });
    await expect(shareRun(baseRequest)).resolves.toEqual({
      externalId: null,
      reason: 'no-activity',
      auditRetentionDays: 7,
    });
    expect(ingestSessionForShareMock).not.toHaveBeenCalled();
    expect(createSharedRunMock).not.toHaveBeenCalled();
  });

  it('refuses under a transcripts prohibition BEFORE loading entries or computing a diff', async () => {
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      prohibiting('transcripts', 'Globex'),
    );

    await expect(shareRun(baseRequest)).resolves.toEqual({
      externalId: null,
      reason: 'blocked-by-org-policy',
      auditRetentionDays: 7,
      blockedByOrganizationNames: ['Globex'],
    });

    // The expensive work never ran, and no grant was minted.
    expect(loadHistoryMock).not.toHaveBeenCalled();
    expect(readDiffMock).not.toHaveBeenCalled();
    expect(ingestSessionForShareMock).not.toHaveBeenCalled();
    expect(createSharedRunMock).not.toHaveBeenCalled();
  });

  it('refuses under a metadata prohibition', async () => {
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      prohibiting('metadata'),
    );

    const result = await shareRun(baseRequest);
    expect(result.reason).toBe('blocked-by-org-policy');
    expect(createSharedRunMock).not.toHaveBeenCalled();
  });

  it('still shares when only plans are prohibited', async () => {
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      prohibiting('plans'),
    );

    await expect(shareRun(baseRequest)).resolves.toEqual({
      externalId: 'run-ext-1',
    });
    // The plans stripping itself happens inside `ingestSessionForShare`.
    expect(ingestSessionForShareMock).toHaveBeenCalled();
    expect(createSharedRunMock).toHaveBeenCalled();
  });

  it('does not apply another organization policy to Personal work', async () => {
    resolveWorkOwnerOrganizationMock.mockResolvedValue({ kind: 'none' });
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      prohibiting('transcripts', 'Other Org'),
    );

    await expect(shareRun(baseRequest)).resolves.toEqual({
      externalId: 'run-ext-1',
    });
    expect(createSharedRunMock).toHaveBeenCalled();
  });

  it('fails closed before expensive work when the project owner is unknown', async () => {
    resolveWorkOwnerOrganizationMock.mockResolvedValue({ kind: 'unknown' });

    await expect(shareRun(baseRequest)).resolves.toEqual({
      externalId: null,
      reason: 'blocked-by-org-policy',
      auditRetentionDays: 7,
      blockedByOrganizationNames: [],
    });
    expect(loadHistoryMock).not.toHaveBeenCalled();
    expect(readDiffMock).not.toHaveBeenCalled();
    expect(ingestSessionForShareMock).not.toHaveBeenCalled();
    expect(createSharedRunMock).not.toHaveBeenCalled();
  });

  it('fails closed when the governing org policy cannot be read', async () => {
    loadStoredTelemetryEnforcementByOrganizationMock.mockRejectedValue(
      new Error('safeStorage unavailable'),
    );

    await expect(shareRun(baseRequest)).resolves.toEqual({
      externalId: null,
      reason: 'blocked-by-org-policy',
      auditRetentionDays: 7,
      blockedByOrganizationNames: [],
    });
    expect(recordTelemetryEnforcementReadFailureMock).toHaveBeenCalledWith(
      'share-eligibility',
      expect.objectContaining({ message: 'safeStorage unavailable' }),
    );
    expect(loadHistoryMock).not.toHaveBeenCalled();
    expect(ingestSessionForShareMock).not.toHaveBeenCalled();
    expect(createSharedRunMock).not.toHaveBeenCalled();
  });

  it('does not record a diagnostic on a clean enforcement read', async () => {
    await shareRun(baseRequest);
    expect(recordTelemetryEnforcementReadFailureMock).not.toHaveBeenCalled();
  });

  it('surfaces a mid-share policy change reported by ingestSessionForShare', async () => {
    ingestSessionForShareMock.mockResolvedValue({
      status: 'blocked-by-org-policy',
      scope: 'transcripts',
      organizationNames: ['Initech'],
    });

    await expect(shareRun(baseRequest)).resolves.toEqual({
      externalId: null,
      reason: 'blocked-by-org-policy',
      auditRetentionDays: 7,
      blockedByOrganizationNames: ['Initech'],
    });
    expect(createSharedRunMock).not.toHaveBeenCalled();
  });

  it('creates the grant and returns the run externalId on the happy path', async () => {
    await expect(shareRun(baseRequest)).resolves.toEqual({
      externalId: 'run-ext-1',
    });
    expect(ingestSessionForShareMock).toHaveBeenCalledWith(
      'ws-1',
      'wt-1',
      'chat-1',
      {
        kind: 'organization',
        organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    );
    const payload = createSharedRunMock.mock.calls[0][0];
    expect(payload.shareScope).toBe('organization');
    expect(payload.organizationId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(payload.clientChatId).toBe('chat-1');
    // The grant references the share-namespaced ids the rows were written
    // under, not the raw project/worktree ids.
    expect(payload.workspaceLocalId).toBe('ws-1-share');
    expect(payload.worktreeLocalId).toBe('wt-1-share');
  });
});

describe('getShareRunEligibility', () => {
  const sessionRef = {
    projectId: 'ws-1',
    worktreeId: 'wt-1',
    chatId: 'chat-1',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    getRetentionDaysMock.mockReturnValue(7);
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      noEnforcement(),
    );
    resolveLapsedOrganizationNamesMock.mockResolvedValue([]);
  });

  // The probe runs before the user picks an audience, so it cannot know which
  // org a share would land in. Blocking here on "some org is lapsed" would be
  // exactly the global kill switch the gate must not be — it would disable
  // Share even for a private share or a share into a healthy org. The lapsed
  // reason is reported by `shareRun`, once the audience is known.
  it('stays shareable when an org the user belongs to is lapsed, and never asks', async () => {
    resolveLapsedOrganizationNamesMock.mockResolvedValue(['Lapsed Co']);
    loadHistoryMock.mockResolvedValue({
      entries: [auditEntry()],
      nextCursor: undefined,
    });

    await expect(getShareRunEligibility(sessionRef)).resolves.toEqual({
      shareable: true,
      auditRetentionDays: 7,
    });
    expect(resolveLapsedOrganizationNamesMock).not.toHaveBeenCalled();
  });

  it('reports a session with finished activity as shareable', async () => {
    loadHistoryMock.mockResolvedValue({
      entries: [auditEntry()],
      nextCursor: undefined,
    });
    await expect(getShareRunEligibility(sessionRef)).resolves.toEqual({
      shareable: true,
      auditRetentionDays: 7,
    });
  });

  it('reports no-activity when the audit entries have aged out', async () => {
    loadHistoryMock.mockResolvedValue({ entries: [], nextCursor: undefined });
    await expect(getShareRunEligibility(sessionRef)).resolves.toEqual({
      shareable: false,
      reason: 'no-activity',
      auditRetentionDays: 7,
    });
  });

  it('ignores entries belonging to other chats in the same worktree', async () => {
    loadHistoryMock.mockResolvedValue({
      entries: [auditEntry({ chatId: 'chat-other' })],
      nextCursor: undefined,
    });
    await expect(getShareRunEligibility(sessionRef)).resolves.toEqual({
      shareable: false,
      reason: 'no-activity',
      auditRetentionDays: 7,
    });
  });

  it('ignores still-running entries, which have nothing to share yet', async () => {
    loadHistoryMock.mockResolvedValue({
      entries: [auditEntry({ status: 'running' })],
      nextCursor: undefined,
    });
    await expect(getShareRunEligibility(sessionRef)).resolves.toEqual({
      shareable: false,
      reason: 'no-activity',
      auditRetentionDays: 7,
    });
  });

  // -------------------------------------------------------------------------
  // Org data-sharing policy. Run sharing bypasses the ambient telemetry gate by
  // design and defaults to organization scope, so a transcripts prohibition has
  // to be enforced at the pre-check the share modal already calls — otherwise a
  // ZDR org's policy is one click away from being bypassed by any member.
  // -------------------------------------------------------------------------
  it('reports blocked-by-org-policy under a transcripts prohibition, naming the org', async () => {
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      prohibiting('transcripts', 'Globex'),
    );
    loadHistoryMock.mockResolvedValue({
      entries: [auditEntry()],
      nextCursor: undefined,
    });

    await expect(getShareRunEligibility(sessionRef)).resolves.toEqual({
      shareable: false,
      reason: 'blocked-by-org-policy',
      auditRetentionDays: 7,
      blockedByOrganizationNames: ['Globex'],
    });
    // Decided without touching history at all.
    expect(loadHistoryMock).not.toHaveBeenCalled();
  });

  it('reports blocked-by-org-policy under a metadata prohibition', async () => {
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      prohibiting('metadata'),
    );
    loadHistoryMock.mockResolvedValue({
      entries: [auditEntry()],
      nextCursor: undefined,
    });

    const result = await getShareRunEligibility(sessionRef);
    expect(result.shareable).toBe(false);
    expect(result.reason).toBe('blocked-by-org-policy');
  });

  it('stays shareable when only plans are prohibited', async () => {
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      prohibiting('plans'),
    );
    loadHistoryMock.mockResolvedValue({
      entries: [auditEntry()],
      nextCursor: undefined,
    });

    await expect(getShareRunEligibility(sessionRef)).resolves.toEqual({
      shareable: true,
      auditRetentionDays: 7,
    });
  });

  it('stays shareable when only summaries are prohibited', async () => {
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      prohibiting('summaries'),
    );
    loadHistoryMock.mockResolvedValue({
      entries: [auditEntry()],
      nextCursor: undefined,
    });

    const result = await getShareRunEligibility(sessionRef);
    expect(result.shareable).toBe(true);
  });

  it('fails closed when run eligibility cannot read governing org policy', async () => {
    loadStoredTelemetryEnforcementByOrganizationMock.mockRejectedValue(
      new Error('safeStorage unavailable'),
    );
    loadHistoryMock.mockResolvedValue({
      entries: [auditEntry()],
      nextCursor: undefined,
    });

    const result = await getShareRunEligibility(sessionRef);
    expect(result).toEqual({
      shareable: false,
      reason: 'blocked-by-org-policy',
      auditRetentionDays: 7,
      blockedByOrganizationNames: [],
    });
    expect(loadHistoryMock).not.toHaveBeenCalled();
  });

  // The probe runs on every share-modal open, so it must stop paging the
  // moment it finds proof rather than walking the full 10-page budget.
  it('stops paging as soon as one matching entry is found', async () => {
    loadHistoryMock
      .mockResolvedValueOnce({
        entries: [auditEntry({ chatId: 'chat-other' })],
        nextCursor: 'cursor-2',
      })
      .mockResolvedValueOnce({
        entries: [auditEntry()],
        nextCursor: 'cursor-3',
      });
    await expect(getShareRunEligibility(sessionRef)).resolves.toEqual({
      shareable: true,
      auditRetentionDays: 7,
    });
    expect(loadHistoryMock).toHaveBeenCalledTimes(2);
  });

  // A history read failure is not proof of absence; blocking the UI on it would
  // strand a perfectly shareable session behind a permanent-sounding message.
  it('falls back to shareable when the history read fails', async () => {
    loadHistoryMock.mockRejectedValue(new Error('disk gone'));
    await expect(getShareRunEligibility(sessionRef)).resolves.toEqual({
      shareable: true,
      auditRetentionDays: 7,
    });
  });
});

describe('unshareRun', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    unshareSharedRunByClientLocalIdMock.mockResolvedValue({ unshared: true });
  });

  it('recomputes the same idempotency key shareRun used for the session', async () => {
    createSharedRunMock.mockResolvedValue({ externalId: 'run-ext-1' });
    loadHistoryMock.mockResolvedValue({
      entries: [auditEntry()],
      nextCursor: undefined,
    });
    rollupFromEntriesMock.mockReturnValue({ turnCount: 1 });
    ingestSessionForShareMock.mockResolvedValue({
      status: 'ok',
      workspaceLocalId: 'ws-1-share',
      worktreeLocalId: 'wt-1-share',
    });
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      noEnforcement(),
    );
    readDiffMock.mockResolvedValue({ patch: '' });

    await shareRun(baseRequest);
    const shareKey = createSharedRunMock.mock.calls[0][0].clientLocalRunId;

    await unshareRun({
      projectId: baseRequest.projectId,
      worktreeId: baseRequest.worktreeId,
      chatId: baseRequest.chatId,
    });
    const unshareKey = unshareSharedRunByClientLocalIdMock.mock.calls[0][0];

    expect(unshareKey).toMatch(UUID_V5_RE);
    expect(unshareKey).toBe(shareKey);
  });

  it('returns the cloud unshared result', async () => {
    unshareSharedRunByClientLocalIdMock.mockResolvedValue({ unshared: true });
    await expect(
      unshareRun({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
      }),
    ).resolves.toEqual({ unshared: true });
  });
});
