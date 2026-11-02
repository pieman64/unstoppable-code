jest.mock('../org-shared-multi-repo-readiness', () => ({
  assertSharedMultiRepoWorkReady: jest.fn(
    (): Promise<void> => Promise.resolve(),
  ),
}));
// CAN-3810: admission and projection of the worktree creation boundary, with
// the create service mocked. Real-Git round trips are in
// worktree-creation.integration.test.ts.
jest.mock('../worktree-service', () => ({
  createMultiRepoWorktree: jest.fn(),
  createSingleRepoWorktree: jest.fn(),
}));
// Keyed creates run the real keyed operation against an in-memory receipt
// store, so the receipt caller, fingerprint and replay are observable.
const mockReceiptStore = {
  lookupReceipt: jest.fn<Promise<W5ReceiptLookup>, [W5Receipt]>(),
  reserve: jest.fn<Promise<void>, [unknown]>(),
  releaseReservation: jest.fn<Promise<void>, [string]>(),
  markReservationRecoveryRequired: jest.fn<Promise<void>, [string, unknown]>(),
};
jest.mock('../w5-commit-log-file-store', () => ({
  getW5ReceiptStore: (): typeof mockReceiptStore => mockReceiptStore,
  withW5Commit: (
    _options: unknown,
    work: () => Promise<unknown>,
  ): Promise<unknown> => work(),
}));

import type {
  W5CommitRequest,
  W5ReceiptLookup,
} from '@canopy/desktop-shared/node/w5-commit-log';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  createWorktreeFromSelection,
  type WorktreeCreationRequest,
} from '../worktree-creation';
import {
  createMultiRepoWorktree,
  createSingleRepoWorktree,
} from '../worktree-service';

type W5Receipt = NonNullable<W5CommitRequest['receipt']>;

const mockedCreateSingle = jest.mocked(createSingleRepoWorktree);
const mockedCreateMulti = jest.mocked(createMultiRepoWorktree);

const SINGLE_RESPONSE = {
  id: 'otter',
  branchName: 'otter',
  createdAt: '2026-10-12T00:00:00.000Z',
  trackedBaseBranch: 'main',
};

function keyedRequest(
  overrides: Partial<WorktreeCreationRequest<'single-repo'>> = {},
): WorktreeCreationRequest<'single-repo'> {
  return {
    workspaceId: 'project',
    workspaceKind: 'single-repo',
    branch: { kind: 'default' },
    base: { kind: 'branch', baseBranch: 'main' },
    idempotencyKey: 'key-1',
    deferGitSetup: false,
    startPostCreateSetup: true,
    ...overrides,
  };
}

/** The fingerprint of {@link keyedRequest} before CAN-4544. */
const PLAIN_KEYED_FINGERPRINT =
  'e8ae313147039bf54e72338a7fe143e5ac2ea17a68697e6cd9a5019c709ab2b9';

function lookedUpReceipts(): W5Receipt[] {
  return mockReceiptStore.lookupReceipt.mock.calls.map(([receipt]) => receipt);
}

describe('worktree creation boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReceiptStore.lookupReceipt.mockResolvedValue({ status: 'none' });
    mockReceiptStore.reserve.mockResolvedValue();
    mockReceiptStore.releaseReservation.mockResolvedValue();
    mockReceiptStore.markReservationRecoveryRequired.mockResolvedValue();
  });

  describe('keyed creation', () => {
    it('records the receipt under the worktree-selection caller by default', async () => {
      mockedCreateSingle.mockResolvedValue(SINGLE_RESPONSE);

      await createWorktreeFromSelection(keyedRequest());
      await createWorktreeFromSelection(
        keyedRequest({ callerSource: 'worktree-selection' }),
      );

      expect(lookedUpReceipts().map((receipt) => receipt.caller)).toEqual([
        'desktop-host:worktree-selection',
        'desktop-host:worktree-selection',
      ]);
    });

    it('records the receipt under the pipeline-host caller when asked', async () => {
      mockedCreateSingle.mockResolvedValue(SINGLE_RESPONSE);

      await createWorktreeFromSelection(
        keyedRequest({ callerSource: 'pipeline-host' }),
      );

      expect(lookedUpReceipts()).toEqual([
        expect.objectContaining({
          caller: 'desktop-host:pipeline-host',
          operation: 'core.worktree.create',
          idempotencyKey: 'key-1',
        }),
      ]);
    });

    it('keeps the caller source, replay hook and lifecycle callbacks out of the service and the fingerprint', async () => {
      mockedCreateSingle.mockResolvedValue(SINGLE_RESPONSE);
      const onKeyedReplay = jest.fn();

      await createWorktreeFromSelection(keyedRequest());
      await createWorktreeFromSelection(
        keyedRequest({
          callerSource: 'pipeline-host',
          onKeyedReplay,
          onGitReady: jest.fn(),
          getWindow: () => null,
          startProjectPostCreateSetup: jest.fn(),
        }),
      );

      const [plain, withLifecycle] = lookedUpReceipts();
      expect(withLifecycle.fingerprint).toBe(plain.fingerprint);
      // Pinned against the unchanged boundary: existing receipts still match.
      expect(plain.fingerprint).toBe(PLAIN_KEYED_FINGERPRINT);
      for (const [options] of mockedCreateSingle.mock.calls) {
        expect(options).not.toHaveProperty('callerSource');
        expect(options).not.toHaveProperty('onKeyedReplay');
        expect(options).not.toHaveProperty('idempotencyKey');
      }
      expect(onKeyedReplay).not.toHaveBeenCalled();
    });

    it('keeps the caller source and replay hook out of an unkeyed service request', async () => {
      mockedCreateSingle.mockResolvedValue(SINGLE_RESPONSE);

      await createWorktreeFromSelection(
        keyedRequest({
          idempotencyKey: undefined,
          callerSource: 'pipeline-host',
          onKeyedReplay: jest.fn(),
        }),
      );

      expect(mockReceiptStore.lookupReceipt).not.toHaveBeenCalled();
      expect(mockedCreateSingle.mock.calls).toEqual([
        [
          {
            workspaceId: 'project',
            baseBranch: 'main',
            deferGitSetup: false,
            startPostCreateSetup: true,
          },
        ],
      ]);
    });

    it('reports a replayed creation through onKeyedReplay without entering the service', async () => {
      mockedCreateSingle.mockResolvedValue(SINGLE_RESPONSE);
      const first = await createWorktreeFromSelection(keyedRequest());
      mockedCreateSingle.mockClear();
      mockReceiptStore.lookupReceipt.mockResolvedValue({
        status: 'replay',
        commitId: 1,
        outcome: first,
      });
      const onKeyedReplay = jest.fn();

      const replayed = await createWorktreeFromSelection(
        keyedRequest({ callerSource: 'pipeline-host', onKeyedReplay }),
      );

      expect(replayed).toEqual(first);
      expect(onKeyedReplay).toHaveBeenCalledTimes(1);
      expect(mockedCreateSingle).not.toHaveBeenCalled();
    });

    it('fingerprints the worktree-id default branch naming only when supplied', async () => {
      mockedCreateSingle.mockResolvedValue(SINGLE_RESPONSE);

      await createWorktreeFromSelection(keyedRequest());
      await createWorktreeFromSelection(
        keyedRequest({ defaultBranchNaming: 'worktree-id' }),
      );

      const [plain, named] = lookedUpReceipts();
      expect(plain.fingerprint).toBe(PLAIN_KEYED_FINGERPRINT);
      expect(named.fingerprint).not.toBe(plain.fingerprint);
      expect(mockedCreateSingle.mock.calls[1][0]).toMatchObject({
        defaultBranchNaming: 'worktree-id',
      });
    });

    it('passes the worktree-id default branch naming to an unkeyed create', async () => {
      mockedCreateMulti.mockResolvedValueOnce({
        id: 'otter',
        branchName: 'otter',
        createdAt: '2026-10-12T00:00:00.000Z',
      });

      await createWorktreeFromSelection({
        workspaceId: 'project',
        workspaceKind: 'multi-repo',
        branch: { kind: 'default' },
        base: { kind: 'repository-default' },
        defaultBranchNaming: 'worktree-id',
      });

      expect(mockedCreateMulti.mock.calls).toEqual([
        [{ workspaceId: 'project', defaultBranchNaming: 'worktree-id' }],
      ]);
    });
  });

  it('projects the typed selection and passes the host lifecycle through', async () => {
    const onGitReady = jest.fn();
    mockedCreateSingle.mockResolvedValueOnce({
      id: 'otter',
      branchName: 'feature/x',
      createdAt: '2026-10-12T00:00:00.000Z',
      trackedBaseBranch: 'main',
      setupPhase: 'git-pending',
    });

    const outcome = await createWorktreeFromSelection({
      workspaceId: 'project',
      workspaceKind: 'single-repo',
      branch: { kind: 'existing', branchName: ' feature/x ' },
      base: { kind: 'branch', baseBranch: 'main' },
      sidebarItemGroupId: 'sig-1',
      existingWorktreeIds: ['heron'],
      deferGitSetup: true,
      startPostCreateSetup: true,
      onGitReady,
    });

    expect(mockedCreateSingle.mock.calls).toEqual([
      [
        {
          workspaceId: 'project',
          existingBranch: 'feature/x',
          baseBranch: 'main',
          sidebarItemGroupId: 'sig-1',
          existingWorktreeIds: ['heron'],
          deferGitSetup: true,
          startPostCreateSetup: true,
          onGitReady,
        },
      ],
    ]);
    expect(mockedCreateMulti).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      status: 'created',
      workspaceKind: 'single-repo',
      record: {
        worktreeId: 'otter',
        branchName: 'feature/x',
        createdAt: '2026-10-12T00:00:00.000Z',
        setupPhase: 'git-pending',
        trackedBaseBranch: 'main',
        trackedRepoBaseBranches: {},
        includedRepoIds: null,
      },
      response: {
        id: 'otter',
        branchName: 'feature/x',
        createdAt: '2026-10-12T00:00:00.000Z',
        trackedBaseBranch: 'main',
        setupPhase: 'git-pending',
      },
    });
  });

  it('reports a ready multi-repository creation with its repository scope', async () => {
    mockedCreateMulti.mockResolvedValueOnce({
      id: 'otter',
      branchName: 'otter-1',
      createdAt: '2026-10-12T00:00:00.000Z',
      trackedRepoBaseBranches: { api: 'main' },
    });

    const outcome = await createWorktreeFromSelection({
      workspaceId: 'project',
      workspaceKind: 'multi-repo',
      branch: { kind: 'default' },
      base: { kind: 'per-repository', baseBranches: { api: 'main' } },
      includedRepoIds: ['api'],
    });

    expect(mockedCreateMulti.mock.calls).toEqual([
      [
        {
          workspaceId: 'project',
          baseBranchesByRepo: { api: 'main' },
          includedRepoIds: ['api'],
        },
      ],
    ]);
    expect(outcome).toMatchObject({
      status: 'created',
      record: {
        setupPhase: 'git-ready',
        trackedBaseBranch: null,
        trackedRepoBaseBranches: { api: 'main' },
        includedRepoIds: ['api'],
      },
    });
  });

  it('reports a workspace root that needs repair', async () => {
    const repairIssues = [
      {
        code: 'missing-claude-md' as const,
        message: 'CLAUDE.md is missing',
        blocking: true,
      },
    ];
    mockedCreateMulti.mockResolvedValueOnce({
      id: 'otter',
      branchName: 'otter-1',
      needsRepair: true,
      repairIssues,
    });

    const outcome = await createWorktreeFromSelection({
      workspaceId: 'project',
      workspaceKind: 'multi-repo',
      branch: { kind: 'default' },
      base: { kind: 'repository-default' },
      surfaceNeedsRepairInResponse: true,
    });

    expect(outcome).toMatchObject({
      status: 'needs-repair',
      worktreeId: 'otter',
      branchName: 'otter-1',
      repairIssues,
    });
  });

  describe('admission denies before the service is entered', () => {
    it.each([
      {
        name: 'the read-only shared-container scope',
        request: {
          workspaceId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
          workspaceKind: 'single-repo' as const,
          branch: { kind: 'default' as const },
          base: { kind: 'repository-default' as const },
        },
        reason: 'read-only-scope',
        message: 'Shared-container recipient workspaces are read-only',
      },
      {
        name: 'a per-repository base for a single repository',
        request: {
          workspaceId: 'project',
          workspaceKind: 'single-repo' as const,
          branch: { kind: 'default' as const },
          base: {
            kind: 'per-repository' as const,
            baseBranches: { api: 'main' },
          },
        },
        reason: 'invalid-selection',
        message:
          'baseBranchesByRepo is only supported for multi-repository projects',
      },
      {
        name: 'an existing branch with a base worktree',
        request: {
          workspaceId: 'project',
          workspaceKind: 'multi-repo' as const,
          branch: { kind: 'existing' as const, branchName: 'feature/x' },
          base: { kind: 'worktree' as const, baseWorktreeId: 'heron' },
        },
        reason: 'invalid-selection',
        message:
          'baseWorktreeId is mutually exclusive with baseBranch and existingBranch',
      },
      {
        name: 'a blank branch name',
        request: {
          workspaceId: 'project',
          workspaceKind: 'single-repo' as const,
          branch: { kind: 'new' as const, branchName: '  ' },
          base: { kind: 'repository-default' as const },
        },
        reason: 'invalid-selection',
        message: 'Branch name must be a non-empty value',
      },
      {
        name: 'included repositories for a single repository',
        request: {
          workspaceId: 'project',
          workspaceKind: 'single-repo' as const,
          branch: { kind: 'default' as const },
          base: { kind: 'repository-default' as const },
          includedRepoIds: ['api'],
        },
        reason: 'invalid-repository-selection',
        message:
          'includedRepoIds is only supported for multi-repository projects',
      },
    ])('refuses $name', async ({ request, reason, message }) => {
      await expect(createWorktreeFromSelection(request)).rejects.toMatchObject({
        reason,
        message,
      });
      expect(mockedCreateSingle).not.toHaveBeenCalled();
      expect(mockedCreateMulti).not.toHaveBeenCalled();
    });

    it('validates the workspace id first', async () => {
      await expect(
        createWorktreeFromSelection({
          workspaceId: 'Not Valid',
          workspaceKind: 'single-repo',
          branch: { kind: 'default' },
          base: { kind: 'repository-default' },
        }),
      ).rejects.toThrow(
        'Invalid workspaceId: must be lowercase alphanumeric with hyphens',
      );
      expect(mockedCreateSingle).not.toHaveBeenCalled();
    });
  });
});
