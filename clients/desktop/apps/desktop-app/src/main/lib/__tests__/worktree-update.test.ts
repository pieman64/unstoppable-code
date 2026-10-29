import '../../../__tests__/worktree-replica-compatibility';
// CAN-3810: the typed in-process worktree update boundary. Runs the real
// workspace persistence module against a temporary data dir, so each patch is
// checked through the persisted `worktrees.json` row and back through the
// typed read projection.
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import { getWorkspaceWorktreesFilePath } from '../paths';
import {
  clearWorktreesSelfWriteTracking,
  readWorkspaceWorktrees,
} from '../workspace-persistence';
import {
  moveWorktree,
  projectWorktreeMetadata,
  updateWorktree,
  WorktreeUpdateRefusedError,
  worktreeMoveRequestSchema,
  type WorktreeMetadata,
  type WorktreeMetadataPatch,
  type WorktreeMoveRequest,
} from '../worktree-update';

const WORKSPACE_ID = 'project';

function row(id: string, extra: Partial<WorktreeData> = {}): WorktreeData {
  return {
    id,
    branchName: `branch-${id}`,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...extra,
  };
}

/** Renderer data reaches the boundary unchecked; tests send it the same way. */
function untypedPatch(value: Record<string, unknown>): WorktreeMetadataPatch {
  return value as WorktreeMetadataPatch;
}

function untypedMove(value: Record<string, unknown>): WorktreeMoveRequest {
  return value as WorktreeMoveRequest;
}

const EMPTY_METADATA: WorktreeMetadata = {
  label: null,
  hidden: false,
  pinned: false,
  branchGroupingOverride: null,
  trackedBaseBranch: null,
  trackedRepoBaseBranches: {},
};

describe('worktree update boundary (real fs)', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;
  let listPath: string;

  async function writeList(worktrees: unknown[]): Promise<void> {
    await mkdir(path.dirname(listPath), { recursive: true });
    await writeFile(
      listPath,
      JSON.stringify({ version: 1, worktrees }, null, 2),
    );
  }

  async function readRow(id: string): Promise<WorktreeData> {
    const worktrees = await readWorkspaceWorktrees(WORKSPACE_ID);
    const found = worktrees.find((worktree) => worktree.id === id);
    if (!found) throw new Error(`Expected a persisted row for ${id}`);
    return found;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    clearWorktreesSelfWriteTracking(WORKSPACE_ID);
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-worktree-update-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    listPath = getWorkspaceWorktreesFilePath(WORKSPACE_ID);
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('round trip of every patchable field', () => {
    const cases: Array<{
      name: string;
      before: Partial<WorktreeData>;
      patch: WorktreeMetadataPatch;
      persisted: Partial<WorktreeData>;
      metadata: Partial<WorktreeMetadata>;
    }> = [
      {
        name: 'label is trimmed',
        before: {},
        patch: { label: '  Review  ' },
        persisted: { label: 'Review' },
        metadata: { label: 'Review' },
      },
      {
        name: 'a blank label clears it',
        before: { label: 'Old' },
        patch: { label: '   ' },
        persisted: {},
        metadata: { label: null },
      },
      {
        name: 'a null label clears it',
        before: { label: 'Old' },
        patch: { label: null },
        persisted: {},
        metadata: { label: null },
      },
      {
        name: 'hidden is set',
        before: {},
        patch: { hidden: true },
        persisted: { hidden: true },
        metadata: { hidden: true },
      },
      {
        name: 'hidden false removes the key',
        before: { hidden: true },
        patch: { hidden: false },
        persisted: {},
        metadata: { hidden: false },
      },
      {
        name: 'pinned is set',
        before: {},
        patch: { pinned: true },
        persisted: { pinned: true },
        metadata: { pinned: true },
      },
      {
        name: 'pinned false removes the key',
        before: { pinned: true },
        patch: { pinned: false },
        persisted: {},
        metadata: { pinned: false },
      },
      {
        name: 'a grouping override is set',
        before: {},
        patch: { branchGroupingOverride: 'ungroup' },
        persisted: { branchGroupingOverride: 'ungroup' },
        metadata: { branchGroupingOverride: 'ungroup' },
      },
      {
        name: 'a null grouping override clears it',
        before: { branchGroupingOverride: 'group' },
        patch: { branchGroupingOverride: null },
        persisted: {},
        metadata: { branchGroupingOverride: null },
      },
      {
        name: 'a tracked base clears the merge-retarget parent',
        before: {
          trackedBaseBranch: 'feature',
          branchGroupingParentWorktreeId: 'heron',
        },
        patch: { trackedBaseBranch: 'main' },
        persisted: { trackedBaseBranch: 'main' },
        metadata: { trackedBaseBranch: 'main' },
      },
      {
        // A persisted null is the clear tombstone a stale whole-list save
        // cannot roll back.
        name: 'a null tracked base persists the clear',
        before: { trackedBaseBranch: 'main' },
        patch: { trackedBaseBranch: null },
        persisted: { trackedBaseBranch: null },
        metadata: { trackedBaseBranch: null },
      },
      {
        name: 'per-repository tracked bases are set and cleared',
        before: {
          trackedRepoBaseBranches: { api: 'main', web: 'develop' },
          branchGroupingParentWorktreeId: 'heron',
        },
        patch: { trackedRepoBaseBranches: { api: null, docs: 'release' } },
        persisted: {
          trackedRepoBaseBranches: { web: 'develop', docs: 'release' },
        },
        metadata: {
          trackedRepoBaseBranches: { web: 'develop', docs: 'release' },
        },
      },
      {
        name: 'clearing the last per-repository base removes the map',
        before: { trackedRepoBaseBranches: { api: 'main' } },
        patch: { trackedRepoBaseBranches: { api: null } },
        persisted: {},
        metadata: { trackedRepoBaseBranches: {} },
      },
    ];

    it.each(cases)('$name', async ({ before, patch, persisted, metadata }) => {
      await writeList([row('otter', before), row('heron')]);

      const outcome = await updateWorktree({
        workspaceId: WORKSPACE_ID,
        worktreeId: 'otter',
        patch,
      });

      const stored = await readRow('otter');
      expect(stored).toEqual(row('otter', persisted));
      expect(outcome.worktree).toEqual(stored);
      expect(outcome.changed).toBe(true);
      expect(projectWorktreeMetadata(stored)).toEqual({
        ...EMPTY_METADATA,
        ...metadata,
      });
      expect(await readRow('heron')).toEqual(row('heron'));
    });
  });

  it('applies several fields in one write and keeps fields it does not own', async () => {
    const owned = {
      ...row('otter', {
        healthIssue: {
          status: 'broken',
          code: 'invalid-git-worktree',
          message: 'broken',
          checkedAt: '2026-10-01T00:00:00.000Z',
          worktreePath: '/worktrees/otter',
        },
        lastTouchedAt: '2026-10-02T00:00:00.000Z',
      }),
      futureRowField: 'kept',
    };
    await writeList([owned]);

    await updateWorktree({
      workspaceId: WORKSPACE_ID,
      worktreeId: 'otter',
      patch: { label: 'Otter', hidden: true, pinned: true },
    });

    const list: unknown = JSON.parse(await readFile(listPath, 'utf8'));
    expect(list).toEqual({
      version: 1,
      worktrees: [{ ...owned, label: 'Otter', hidden: true, pinned: true }],
    });
  });

  it('does not rewrite the list when the patch changes nothing', async () => {
    await writeList([row('otter', { label: 'Otter', pinned: true })]);
    const before = await readFile(listPath, 'utf8');

    const outcome = await updateWorktree({
      workspaceId: WORKSPACE_ID,
      worktreeId: 'otter',
      patch: { label: ' Otter ', pinned: true, hidden: false },
    });

    expect(outcome.changed).toBe(false);
    expect(await readFile(listPath, 'utf8')).toBe(before);
  });

  it('applies a manual order in the same write as the grouping override', async () => {
    await writeList([row('otter'), row('heron'), row('lynx')]);

    await updateWorktree({
      workspaceId: WORKSPACE_ID,
      worktreeId: 'heron',
      patch: { branchGroupingOverride: 'group' },
      worktreeOrder: ['lynx', 'heron'],
    });

    const worktrees = await readWorkspaceWorktrees(WORKSPACE_ID);
    expect(worktrees.map((worktree) => worktree.id)).toEqual([
      'lynx',
      'heron',
      'otter',
    ]);
    expect(worktrees[1]?.branchGroupingOverride).toBe('group');
  });

  it('does not apply the manual order when the worktree is unknown', async () => {
    await writeList([row('otter'), row('heron')]);
    const before = await readFile(listPath, 'utf8');

    await expect(
      updateWorktree({
        workspaceId: WORKSPACE_ID,
        worktreeId: 'lynx',
        patch: { branchGroupingOverride: 'ungroup' },
        worktreeOrder: ['heron', 'otter'],
      }),
    ).rejects.toMatchObject({
      reason: 'not-found',
      message: 'Worktree lynx not found in project project',
    });
    expect(await readFile(listPath, 'utf8')).toBe(before);
  });

  it('writes nothing when the override and order are unchanged', async () => {
    await writeList([
      row('otter', { branchGroupingOverride: 'ungroup' }),
      row('heron'),
    ]);
    const before = await readFile(listPath, 'utf8');

    const outcome = await updateWorktree({
      workspaceId: WORKSPACE_ID,
      worktreeId: 'otter',
      patch: { branchGroupingOverride: 'ungroup' },
      worktreeOrder: ['otter', 'heron'],
    });

    expect(outcome.changed).toBe(false);
    expect(await readFile(listPath, 'utf8')).toBe(before);
  });

  describe('admission', () => {
    it('refuses an unknown worktree with the existing message', async () => {
      await writeList([row('otter')]);

      const refusal = updateWorktree({
        workspaceId: WORKSPACE_ID,
        worktreeId: 'heron',
        patch: { hidden: true },
      });

      await expect(refusal).rejects.toBeInstanceOf(WorktreeUpdateRefusedError);
      await expect(refusal).rejects.toMatchObject({
        reason: 'not-found',
        message: 'Worktree heron not found in project project',
      });
    });

    it('refuses an absent list as an unknown worktree', async () => {
      await expect(
        updateWorktree({
          workspaceId: WORKSPACE_ID,
          worktreeId: 'otter',
          patch: { pinned: true },
        }),
      ).rejects.toMatchObject({
        reason: 'not-found',
        message: 'Worktree otter not found in project project',
      });
    });

    it('denies the read-only shared-container scope before reading or writing', async () => {
      const viewerListPath = getWorkspaceWorktreesFilePath(
        SHARED_CONTAINER_VIEWER_PROJECT_ID,
      );
      await mkdir(path.dirname(viewerListPath), { recursive: true });
      const contents = JSON.stringify({
        version: 1,
        worktrees: [row('otter')],
      });
      await writeFile(viewerListPath, contents);

      await expect(
        updateWorktree({
          workspaceId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
          worktreeId: 'otter',
          patch: { label: 'Changed' },
        }),
      ).rejects.toMatchObject({
        reason: 'read-only-scope',
        message: 'Shared-container recipient workspaces are read-only',
      });
      expect(await readFile(viewerListPath, 'utf8')).toBe(contents);
    });

    it.each([
      {
        name: 'a non-boolean pinned state',
        patch: { pinned: 'yes' },
        message: 'Invalid worktree pinned state',
      },
      {
        name: 'a non-boolean hidden state',
        patch: { hidden: 1 },
        message: 'Invalid worktree hidden state',
      },
      {
        name: 'an unknown grouping override',
        patch: { branchGroupingOverride: 'nest' },
        message: 'Invalid worktree branch grouping override',
      },
      {
        name: 'a blank tracked base',
        patch: { trackedBaseBranch: '  ' },
        message: 'baseBranch is required.',
      },
      {
        name: 'an empty patch',
        patch: {},
        message: 'A worktree update needs at least one field',
      },
    ])('refuses $name before writing', async ({ patch, message }) => {
      await writeList([row('otter')]);
      const before = await readFile(listPath, 'utf8');

      await expect(
        updateWorktree({
          workspaceId: WORKSPACE_ID,
          worktreeId: 'otter',
          patch: untypedPatch(patch),
        }),
      ).rejects.toMatchObject({ reason: 'invalid-patch', message });
      expect(await readFile(listPath, 'utf8')).toBe(before);
    });

    it('validates the workspace id before the scope and the worktree id', async () => {
      await expect(
        updateWorktree({
          workspaceId: 'Not Valid',
          worktreeId: 'otter',
          patch: { hidden: true },
        }),
      ).rejects.toThrow(
        'Invalid workspaceId: must be lowercase alphanumeric with hyphens',
      );
      await expect(
        updateWorktree({
          workspaceId: WORKSPACE_ID,
          worktreeId: 'Not Valid',
          patch: { hidden: true },
        }),
      ).rejects.toThrow(
        'Invalid worktreeId: must be lowercase alphanumeric with hyphens',
      );
      await expect(
        updateWorktree({
          workspaceId: WORKSPACE_ID,
          worktreeId: 'otter',
          patch: { hidden: true },
          worktreeOrder: ['otter', 'Bad Id'],
        }),
      ).rejects.toThrow(
        'Invalid worktreeOrder[1]: must be lowercase alphanumeric with hyphens',
      );
    });
  });

  describe('moveWorktree', () => {
    it('moves a visible row and keeps hidden rows in their slots', async () => {
      await writeList([
        row('otter'),
        row('heron', { hidden: true }),
        row('lynx'),
        row('wren'),
      ]);

      await moveWorktree({
        workspaceId: WORKSPACE_ID,
        activeWorktreeId: 'wren',
        overWorktreeId: 'otter',
      });

      const worktrees = await readWorkspaceWorktrees(WORKSPACE_ID);
      expect(worktrees.map((worktree) => worktree.id)).toEqual([
        'wren',
        'heron',
        'otter',
        'lynx',
      ]);
    });

    it('refuses a move whose rows are unknown or hidden', async () => {
      await writeList([row('otter'), row('heron', { hidden: true })]);

      await expect(
        moveWorktree({
          workspaceId: WORKSPACE_ID,
          activeWorktreeId: 'heron',
          overWorktreeId: 'otter',
        }),
      ).rejects.toMatchObject({
        reason: 'not-found',
        message: 'Worktree to reorder was not found.',
      });
    });

    it('accepts a move onto itself without rewriting the list', async () => {
      await writeList([row('otter'), row('heron')]);
      const before = await readFile(listPath, 'utf8');

      await moveWorktree({
        workspaceId: WORKSPACE_ID,
        activeWorktreeId: 'otter',
        overWorktreeId: 'otter',
      });

      expect(await readFile(listPath, 'utf8')).toBe(before);
    });

    it('has a closed request schema with no group membership field', () => {
      const move = {
        workspaceId: WORKSPACE_ID,
        activeWorktreeId: 'heron',
        overWorktreeId: 'otter',
      };
      expect(Object.keys(worktreeMoveRequestSchema.shape).sort()).toEqual([
        'activeWorktreeId',
        'expectedRevision',
        'idempotencyKey',
        'overWorktreeId',
        'workspaceId',
      ]);
      expect(
        worktreeMoveRequestSchema.parse({
          ...move,
          expectedRevision: 3,
          idempotencyKey: 'key',
        }),
      ).toEqual({ ...move, expectedRevision: 3, idempotencyKey: 'key' });
      for (const field of [
        'groupId',
        'sidebarItemGroupId',
        'memberIds',
        'membership',
        'source',
        'decide',
        'commitMembership',
      ])
        expect(
          worktreeMoveRequestSchema.safeParse({ ...move, [field]: 'grp-one' })
            .error?.issues,
        ).toEqual([
          expect.objectContaining({ code: 'unrecognized_keys', keys: [field] }),
        ]);
    });

    // A22(a): group membership is desktop-only, so the reorder request,
    // keyed or not, has no membership field and refuses one before any read.
    it.each([
      ['groupId', 'grp-one'],
      ['sidebarItemGroupId', 'grp-one'],
      ['memberIds', ['otter']],
      ['source', 'sidebar_item_groups'],
      ['commitMembership', (): Promise<void> => Promise.resolve()],
    ])(
      'refuses a %s field without writing: group membership is desktop-only',
      async (field, value) => {
        await writeList([row('otter'), row('heron')]);
        const before = await readFile(listPath, 'utf8');

        await expect(
          moveWorktree(
            untypedMove({
              workspaceId: WORKSPACE_ID,
              activeWorktreeId: 'heron',
              overWorktreeId: 'otter',
              [field]: value,
            }),
          ),
        ).rejects.toMatchObject({ reason: 'invalid-patch' });
        expect(await readFile(listPath, 'utf8')).toBe(before);
      },
    );

    it('denies the read-only shared-container scope', async () => {
      await expect(
        moveWorktree({
          workspaceId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
          activeWorktreeId: 'otter',
          overWorktreeId: 'heron',
        }),
      ).rejects.toMatchObject({ reason: 'read-only-scope' });
    });
  });
});
