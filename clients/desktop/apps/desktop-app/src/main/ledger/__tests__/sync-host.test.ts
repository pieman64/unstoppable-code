jest.mock('../../observability', () => ({
  getObservabilityService: (): { recordAppDiagnostic: jest.Mock } => ({
    recordAppDiagnostic: jest.fn(),
  }),
}));

jest.mock('../../lib/workspace-persistence', () => ({
  readWorkspaceConfigDetailed: jest.fn(),
  readWorkspaceOwnership: jest.fn(),
}));

import type { WorkspaceOwnerBinding } from '@canopy/desktop-shared/types';
import type { LedgerContainer } from '@canopy/protocol/canopy-core';
import type { CanopyCloudAccountEntry } from '../../lib/canopy-cloud-account-store';
import {
  readWorkspaceConfigDetailed,
  readWorkspaceOwnership,
  type WorkspaceOwnershipRead,
} from '../../lib/workspace-persistence';
import type { AppDiagnosticRecord } from '../../observability/service';
import {
  createLedgerSyncDiagnosticRecorder,
  readLedgerWorkspaceOwner,
  toLedgerSyncAccount,
  toLedgerWorkspaceOwner,
} from '../sync-host';

const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000c1';
const HEALTHY_ORG = '00000000-0000-4000-8000-0000000000b1';
const LAPSED_ORG = '00000000-0000-4000-8000-0000000000b2';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000a1';

function entry(
  overrides: Partial<CanopyCloudAccountEntry> = {},
): CanopyCloudAccountEntry {
  return {
    apiKey: 'key-1',
    capabilities: [],
    account: {
      id: ACCOUNT_ID,
      name: 'Person',
      email: 'person@example.com',
      role: 'DEVELOPER',
    },
    organizations: [
      {
        id: HEALTHY_ORG,
        name: 'Acme',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: LAPSED_ORG,
        name: 'Globex',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    orgBillingStates: [
      {
        organizationId: HEALTHY_ORG,
        organizationName: 'Acme',
        teamsEntitled: true,
      },
      {
        organizationId: LAPSED_ORG,
        organizationName: 'Globex',
        teamsEntitled: false,
      },
    ],
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-01T08:00:00.000Z',
    ...overrides,
  };
}

describe('toLedgerSyncAccount', () => {
  it('reads the account, its organizations, lapsed teams and effective sharing', () => {
    expect(
      toLedgerSyncAccount(entry(), {
        visibility: 'organization',
        prohibited: false,
      }),
    ).toEqual({
      id: ACCOUNT_ID,
      organizationIds: new Set([HEALTHY_ORG, LAPSED_ORG]),
      lapsedOrganizationIds: new Set([LAPSED_ORG]),
      summaries: 'organization',
      summariesProhibited: false,
    });
  });

  it('has nothing to sync to without an account and its credential', () => {
    const sharing = { visibility: 'private', prohibited: false } as const;

    expect(toLedgerSyncAccount(null, sharing)).toBeNull();
    expect(
      toLedgerSyncAccount(entry({ account: undefined }), sharing),
    ).toBeNull();
    expect(toLedgerSyncAccount(entry({ apiKey: '  ' }), sharing)).toBeNull();
  });

  it('carries a prohibition through, whatever the stored choice', () => {
    expect(
      toLedgerSyncAccount(entry({ organizations: undefined }), {
        visibility: 'off',
        prohibited: true,
      }),
    ).toMatchObject({
      organizationIds: new Set(),
      summaries: 'off',
      summariesProhibited: true,
    });
  });
});

describe('toLedgerWorkspaceOwner', () => {
  const owner = {
    type: 'organization',
    organizationId: HEALTHY_ORG,
    projectId: PROJECT_ID,
    instanceId: '00000000-0000-4000-8000-0000000000a2',
    bindingGeneration: 1,
  } as const;

  it('names the organization project of an owned workspace', () => {
    expect(
      toLedgerWorkspaceOwner({
        authority: 'ok',
        type: 'multi-repo',
        owner,
      }),
    ).toEqual({
      kind: 'organization',
      organizationId: HEALTHY_ORG,
      projectId: PROJECT_ID,
    });
    expect(
      toLedgerWorkspaceOwner({
        authority: 'ok',
        type: 'multi-repo',
      }),
    ).toEqual({ kind: 'personal' });
  });

  it('assumes nothing about a config it could not read whole', () => {
    const reads: WorkspaceOwnershipRead[] = [
      { authority: 'absent' },
      { authority: 'unreadable' },
    ];
    for (const read of reads) {
      expect(toLedgerWorkspaceOwner(read)).toEqual({ kind: 'unknown' });
    }
  });
});

describe('readLedgerWorkspaceOwner', () => {
  const container: LedgerContainer = {
    kind: 'code_worktree',
    workspaceId: 'workspace-1',
    worktreeId: 'worktree-1',
  };
  const owner: WorkspaceOwnerBinding = {
    type: 'organization',
    organizationId: HEALTHY_ORG,
    projectId: PROJECT_ID,
    instanceId: '00000000-0000-4000-8000-0000000000a2',
    bindingGeneration: 1,
  };

  beforeEach((): void => {
    jest.mocked(readWorkspaceOwnership).mockReset();
  });

  it('uses the canonical ownership reader for the workspace', async () => {
    jest.mocked(readWorkspaceOwnership).mockResolvedValue({
      authority: 'ok',
      type: 'multi-repo',
      owner,
    });

    await expect(readLedgerWorkspaceOwner(container)).resolves.toEqual({
      kind: 'organization',
      organizationId: HEALTHY_ORG,
      projectId: PROJECT_ID,
    });
    expect(readWorkspaceOwnership).toHaveBeenCalledWith('workspace-1');
    expect(readWorkspaceConfigDetailed).not.toHaveBeenCalled();
  });

  it('fails closed for missing or unhealthy reads but keeps known personal scopes private', async () => {
    jest
      .mocked(readWorkspaceOwnership)
      .mockResolvedValueOnce({ authority: 'absent' })
      .mockResolvedValueOnce({ authority: 'unreadable' })
      .mockResolvedValueOnce({ authority: 'ok', type: 'multi-repo' })
      .mockRejectedValueOnce(new Error('workspace config could not be read'));

    await expect(readLedgerWorkspaceOwner(container)).resolves.toEqual({
      kind: 'unknown',
    });
    await expect(readLedgerWorkspaceOwner(container)).resolves.toEqual({
      kind: 'unknown',
    });
    await expect(readLedgerWorkspaceOwner(container)).resolves.toEqual({
      kind: 'personal',
    });
    await expect(readLedgerWorkspaceOwner(container)).resolves.toEqual({
      kind: 'unknown',
    });
    await expect(
      readLedgerWorkspaceOwner({
        kind: 'advisor_entry',
        appWorkspaceId: 'app-advisor',
        entryId: 'entry-1',
      }),
    ).resolves.toEqual({ kind: 'personal' });
    expect(readWorkspaceOwnership).toHaveBeenCalledTimes(4);
  });
});

describe('createLedgerSyncDiagnosticRecorder', () => {
  const START_MS = Date.parse('2026-10-02T12:00:00.000Z');
  const MINUTE_MS = 60_000;

  it('records each reason as a ledger_sync_failed app diagnostic, at most every 10 minutes', () => {
    const recorded: AppDiagnosticRecord[] = [];
    let now = START_MS;
    const record = createLedgerSyncDiagnosticRecorder(
      (event): void => {
        recorded.push(event);
      },
      (): number => now,
    );

    record({ code: 'repair', detail: 'sequence_gap' });
    record({ code: 'repair', detail: 'sequence_gap' });
    record({ code: 'paused', detail: 'paused' });
    now += 10 * MINUTE_MS - 1;
    record({ code: 'repair', detail: 'sequence_gap' });
    now += 1;
    record({ code: 'repair', detail: 'sequence_gap' });

    expect(recorded).toEqual([
      {
        version: 1,
        timestamp: new Date(START_MS).toISOString(),
        kind: 'ledger_sync_failed',
        reason: 'repair: sequence_gap',
      },
      {
        version: 1,
        timestamp: new Date(START_MS).toISOString(),
        kind: 'ledger_sync_failed',
        reason: 'paused: paused',
      },
      {
        version: 1,
        timestamp: new Date(START_MS + 10 * MINUTE_MS).toISOString(),
        kind: 'ledger_sync_failed',
        reason: 'repair: sequence_gap',
      },
    ]);
  });
});
