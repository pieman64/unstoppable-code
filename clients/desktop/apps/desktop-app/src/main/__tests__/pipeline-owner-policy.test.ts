import type { Pipeline } from '@canopy/desktop-shared/types/pipeline';
import type {
  ProjectOwnerTarget,
  ResolvedProjectOwner,
  SameOwnerDecision,
} from '../lib/project-owner';
import type { PipelineLocalMetadata } from '../pipelines/pipeline-local-metadata-store';

const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

let mockFlagEnabled = true;
let mockSelected: string | undefined = `org:${ORG_A}`;
const mockResolveBackgroundTargetContext = jest.fn<
  Promise<unknown>,
  [ProjectOwnerTarget, unknown]
>(() => Promise.reject(new Error('unresolved')));
jest.mock('../services/background-execution-context', () => ({
  backgroundExecutionContextEnabled: (): boolean => mockFlagEnabled,
  captureBackgroundExecutionContext: (): Promise<string | undefined> =>
    Promise.resolve(mockFlagEnabled ? mockSelected : undefined),
  resolveBackgroundTargetContext: (
    destination: ProjectOwnerTarget,
    context: unknown,
  ): unknown => mockResolveBackgroundTargetContext(destination, context),
}));

const mockResolveProjectSavedOwner = jest.fn<
  Promise<ResolvedProjectOwner>,
  [ProjectOwnerTarget]
>(() => Promise.resolve({ kind: 'personal' }));
const mockDecideSameOwnerAccess = jest.fn<
  Promise<SameOwnerDecision>,
  [ResolvedProjectOwner, ProjectOwnerTarget]
>(() => Promise.resolve({ kind: 'allowed' }));
jest.mock('../lib/project-owner', () => ({
  resolveProjectSavedOwner: (target: ProjectOwnerTarget): unknown =>
    mockResolveProjectSavedOwner(target),
  decideSameOwnerAccess: (
    caller: ResolvedProjectOwner,
    target: ProjectOwnerTarget,
  ): unknown => mockDecideSameOwnerAccess(caller, target),
}));

let mockMetadata: Record<string, PipelineLocalMetadata> = {};
let mockMetadataReadable = true;
const mockRecordUserPipelineOwner = jest.fn(
  (pipelineId: string, owner: string): void => {
    mockMetadata[pipelineId] = { ...mockMetadata[pipelineId], owner };
  },
);
jest.mock('../pipelines/pipeline-local-metadata-store', () => ({
  readPipelineLocalMetadata: (locator: { value: string }): unknown =>
    mockMetadata[locator.value] ?? {},
  isPipelineLocalMetadataReadable: (): boolean => mockMetadataReadable,
  recordUserPipelineOwner: (pipelineId: string, owner: string): unknown =>
    mockRecordUserPipelineOwner(pipelineId, owner),
}));

jest.mock('@canopy/desktop-shared/pipelines/store', () => ({
  getStoredPipelinePathWithSource: (id: string): unknown =>
    id === 'user-pipeline'
      ? { success: true, data: { source: 'user', filePath: '/p.yaml' } }
      : id === 'bundled-pipeline'
        ? { success: true, data: { source: 'bundled', filePath: '/b.yaml' } }
        : { success: false, error: 'not found' },
}));

import {
  agentPipelineOwnerContext,
  assertRunPipelineTargetOwner,
  createDesktopPipelineOwnershipPort,
  getUserPipelineOwner,
  isLocalUserPipeline,
  resolveExecutionOwnerContext,
  selectedOwnerContext,
  validatePipelineOwnerTargetsOnSave,
} from '../pipelines/pipeline-owner-policy';

const WORKTREE_TARGET = {
  scope: 'worktree' as const,
  workspace_id: 'project-b',
  worktree_id: 'task-b',
  path: '/repo',
  created: false,
};

function globalPipeline(
  target: Record<string, unknown>,
  scope: string[] = ['global'],
): Pipeline {
  return {
    name: 'Global',
    on: 'dispatch',
    scope: scope as Pipeline['scope'],
    jobs: {
      build: {
        steps: [
          {
            id: 'child',
            uses: 'builtin/run-pipeline',
            target: target as NonNullable<
              Pipeline['jobs'][string]['steps']
            >[number]['target'],
            with: { pipeline: 'child' },
          },
        ],
      },
    },
  };
}

function anyStringContaining(text: string): unknown {
  return expect.stringContaining(text);
}

const BASE_REQUEST = {
  explicit: undefined,
  captured: `org:${ORG_A}`,
  scope: undefined,
  parentExecutionId: undefined,
  projectId: undefined,
  worktreeId: undefined,
  userPipelineId: undefined,
};

describe('pipeline owner policy', () => {
  beforeEach(() => {
    mockFlagEnabled = true;
    mockSelected = `org:${ORG_A}`;
    mockMetadata = {};
    mockMetadataReadable = true;
    mockResolveProjectSavedOwner.mockReset();
    mockResolveProjectSavedOwner.mockResolvedValue({ kind: 'personal' });
    mockDecideSameOwnerAccess.mockReset();
    mockDecideSameOwnerAccess.mockResolvedValue({ kind: 'allowed' });
    mockRecordUserPipelineOwner.mockClear();
    mockResolveBackgroundTargetContext.mockReset();
    mockResolveBackgroundTargetContext.mockRejectedValue(
      new Error('unresolved'),
    );
  });

  describe('selected owner', () => {
    it('is Personal with organization projects off', async () => {
      mockFlagEnabled = false;
      await expect(selectedOwnerContext()).resolves.toBe('personal');
    });

    it('is the selected context with the flag on', async () => {
      await expect(selectedOwnerContext()).resolves.toBe(`org:${ORG_A}`);
    });
  });

  describe('run owner derivation', () => {
    it('honors an explicit binding, even with the flag off', async () => {
      mockFlagEnabled = false;
      await expect(
        resolveExecutionOwnerContext({
          ...BASE_REQUEST,
          explicit: `org:${ORG_B}`,
          projectId: 'project-1',
        }),
      ).resolves.toEqual({ owner: `org:${ORG_B}` });
      expect(mockResolveProjectSavedOwner).not.toHaveBeenCalled();
    });

    it('is Personal with the flag off without reading project configs', async () => {
      mockFlagEnabled = false;
      await expect(
        resolveExecutionOwnerContext({
          ...BASE_REQUEST,
          projectId: 'project-1',
        }),
      ).resolves.toEqual({ owner: 'personal' });
      expect(mockResolveProjectSavedOwner).not.toHaveBeenCalled();
    });

    it("uses a stored user pipeline's owner for a top-level global run", async () => {
      mockMetadata['user-pipeline'] = { owner: `org:${ORG_B}` };
      await expect(
        resolveExecutionOwnerContext({
          ...BASE_REQUEST,
          scope: 'global',
          userPipelineId: 'user-pipeline',
        }),
      ).resolves.toEqual({ owner: `org:${ORG_B}` });
    });

    it("refuses a global user pipeline run while its owner can't be read", async () => {
      mockMetadataReadable = false;
      await expect(
        resolveExecutionOwnerContext({
          ...BASE_REQUEST,
          scope: 'global',
          userPipelineId: 'user-pipeline',
        }),
      ).resolves.toEqual({
        refusal: anyStringContaining("Couldn't confirm where"),
      });
      expect(mockRecordUserPipelineOwner).not.toHaveBeenCalled();
    });

    it('uses the captured context for any other global run', async () => {
      await expect(
        resolveExecutionOwnerContext({ ...BASE_REQUEST, scope: 'global' }),
      ).resolves.toEqual({ owner: `org:${ORG_A}` });
    });

    it("uses the target project's saved owner", async () => {
      mockResolveProjectSavedOwner.mockResolvedValue({
        kind: 'organization',
        organizationId: ORG_B,
      });
      await expect(
        resolveExecutionOwnerContext({
          ...BASE_REQUEST,
          projectId: 'project-1',
          worktreeId: 'task-1',
        }),
      ).resolves.toEqual({ owner: `org:${ORG_B}` });
      expect(mockResolveProjectSavedOwner).toHaveBeenCalledWith({
        projectId: 'project-1',
        worktreeId: 'task-1',
      });
    });

    it('treats App Advisor as Personal', async () => {
      mockResolveProjectSavedOwner.mockResolvedValue({ kind: 'none' });
      await expect(
        resolveExecutionOwnerContext({
          ...BASE_REQUEST,
          projectId: 'app-advisor',
        }),
      ).resolves.toEqual({ owner: 'personal' });
    });

    it('refuses a project whose owner is unknown', async () => {
      mockResolveProjectSavedOwner.mockResolvedValue({ kind: 'unknown' });
      await expect(
        resolveExecutionOwnerContext({
          ...BASE_REQUEST,
          projectId: 'project-1',
        }),
      ).resolves.toEqual({
        refusal: anyStringContaining("Couldn't confirm where"),
      });
    });
  });

  describe('legacy user pipeline owner backfill', () => {
    it('takes and keeps the selected organization', async () => {
      await expect(getUserPipelineOwner('legacy')).resolves.toBe(
        `org:${ORG_A}`,
      );
      expect(mockRecordUserPipelineOwner).toHaveBeenCalledWith(
        'legacy',
        `org:${ORG_A}`,
      );
      mockSelected = 'personal';
      await expect(getUserPipelineOwner('legacy')).resolves.toBe(
        `org:${ORG_A}`,
      );
      expect(mockRecordUserPipelineOwner).toHaveBeenCalledTimes(1);
    });

    it('stays Personal after the flag turns on when first touched with it off', async () => {
      mockFlagEnabled = false;
      await expect(getUserPipelineOwner('legacy')).resolves.toBe('personal');
      mockFlagEnabled = true;
      await expect(getUserPipelineOwner('legacy')).resolves.toBe('personal');
    });
  });

  it('identifies local user pipelines only', () => {
    expect(isLocalUserPipeline('user-pipeline')).toBe(true);
    expect(isLocalUserPipeline('bundled-pipeline')).toBe(false);
    expect(isLocalUserPipeline('missing')).toBe(false);
  });

  describe('agent pipeline owner', () => {
    it("takes the runtime project's saved owner", async () => {
      mockResolveProjectSavedOwner.mockResolvedValue({
        kind: 'organization',
        organizationId: ORG_B,
      });
      await expect(
        agentPipelineOwnerContext({ projectId: 'project-1' }),
      ).resolves.toEqual({ owner: `org:${ORG_B}` });
    });

    it('takes the selected context for App Advisor', async () => {
      mockResolveProjectSavedOwner.mockResolvedValue({ kind: 'none' });
      await expect(
        agentPipelineOwnerContext({ projectId: 'app-advisor' }),
      ).resolves.toEqual({ owner: `org:${ORG_A}` });
    });

    it('refuses an unknown owner and is Personal with the flag off', async () => {
      mockResolveProjectSavedOwner.mockResolvedValue({ kind: 'unknown' });
      await expect(
        agentPipelineOwnerContext({ projectId: 'project-1' }),
      ).resolves.toEqual({ refusal: anyStringContaining('') });
      mockFlagEnabled = false;
      await expect(
        agentPipelineOwnerContext({ projectId: 'project-1' }),
      ).resolves.toEqual({ owner: 'personal' });
    });
  });

  describe('run-time target check', () => {
    it('allows a same-owner worktree target', async () => {
      await expect(
        assertRunPipelineTargetOwner({
          executionContext: undefined,
          target: WORKTREE_TARGET,
        }),
      ).resolves.toBeUndefined();
      expect(mockDecideSameOwnerAccess).toHaveBeenCalledWith(
        { kind: 'personal' },
        { projectId: 'project-b', worktreeId: 'task-b' },
      );
    });

    it('refuses another owner without disclosing it', async () => {
      mockDecideSameOwnerAccess.mockResolvedValue({ kind: 'hidden' });
      await expect(
        assertRunPipelineTargetOwner({
          executionContext: `org:${ORG_A}`,
          target: WORKTREE_TARGET,
        }),
      ).rejects.toThrow("Project `project-b` isn't available to this pipeline");
      expect(mockDecideSameOwnerAccess).toHaveBeenCalledWith(
        { kind: 'organization', organizationId: ORG_A },
        expect.anything(),
      );
    });

    it("allows a Personal project linked to the run's organization", async () => {
      mockDecideSameOwnerAccess.mockResolvedValue({ kind: 'hidden' });
      mockResolveBackgroundTargetContext.mockResolvedValue({
        matches: true,
        targetOwner: { kind: 'personal' },
      });
      await expect(
        assertRunPipelineTargetOwner({
          executionContext: `org:${ORG_A}`,
          target: WORKTREE_TARGET,
        }),
      ).resolves.toBeUndefined();
      expect(mockResolveBackgroundTargetContext).toHaveBeenCalledWith(
        { projectId: 'project-b', worktreeId: 'task-b' },
        { kind: 'organization', organizationId: ORG_A },
      );
    });

    it('does not apply the linked-project rule to a Personal run', async () => {
      mockDecideSameOwnerAccess.mockResolvedValue({ kind: 'hidden' });
      mockResolveBackgroundTargetContext.mockResolvedValue({
        matches: true,
        targetOwner: { kind: 'personal' },
      });
      await expect(
        assertRunPipelineTargetOwner({
          executionContext: 'personal',
          target: WORKTREE_TARGET,
        }),
      ).rejects.toThrow("Project `project-b` isn't available to this pipeline");
      expect(mockResolveBackgroundTargetContext).not.toHaveBeenCalled();
    });

    it.each(['caller_owner_unknown', 'target_owner_unknown'] as const)(
      'asks to retry when the decision is %s',
      async (kind) => {
        mockDecideSameOwnerAccess.mockResolvedValue({ kind });
        await expect(
          assertRunPipelineTargetOwner({
            executionContext: 'personal',
            target: WORKTREE_TARGET,
          }),
        ).rejects.toThrow("Project `project-b` can't be checked right now");
      },
    );

    it('ignores non-worktree targets, also with the flag off', async () => {
      mockFlagEnabled = false;
      await assertRunPipelineTargetOwner({
        executionContext: 'personal',
        target: { scope: 'directory', path: '/repo' },
      });
      expect(mockDecideSameOwnerAccess).not.toHaveBeenCalled();
    });

    it('is exposed through the desktop ownership port', async () => {
      mockDecideSameOwnerAccess.mockResolvedValue({ kind: 'hidden' });
      mockMetadata['user-pipeline'] = {
        agentAuthor: {
          chat: { projectId: 'p', worktreeId: 't', chatId: 'c' },
          recordedAt: 'now',
        },
      };
      const port = createDesktopPipelineOwnershipPort();
      await expect(
        port.authorizeTarget({
          executionContext: 'personal',
          target: WORKTREE_TARGET,
        }),
      ).rejects.toThrow("isn't available");
      expect(
        port.readAgentAuthor({
          type: 'stored',
          source: 'user',
          value: 'user-pipeline',
        })?.chat.chatId,
      ).toBe('c');
    });
  });

  describe('save-time literal target check', () => {
    const literal = {
      scope: 'worktree',
      workspace_id: 'project-b',
      worktree: { id: 'task-b' },
    };

    it('allows a same-owner literal target', async () => {
      await expect(
        validatePipelineOwnerTargetsOnSave(globalPipeline(literal), 'personal'),
      ).resolves.toBeNull();
      expect(mockDecideSameOwnerAccess).toHaveBeenCalledWith(
        { kind: 'personal' },
        { projectId: 'project-b', worktreeId: 'task-b' },
      );
    });

    it('refuses another owner without disclosing it', async () => {
      mockDecideSameOwnerAccess.mockResolvedValue({ kind: 'hidden' });
      await expect(
        validatePipelineOwnerTargetsOnSave(
          globalPipeline(literal),
          `org:${ORG_A}`,
        ),
      ).resolves.toBe("Project `project-b` isn't available to this pipeline");
    });

    it('refuses an owner that cannot be read', async () => {
      mockDecideSameOwnerAccess.mockResolvedValue({
        kind: 'target_owner_unknown',
      });
      await expect(
        validatePipelineOwnerTargetsOnSave(globalPipeline(literal), 'personal'),
      ).resolves.toContain("can't be checked right now");
    });

    it('skips expression targets', async () => {
      await expect(
        validatePipelineOwnerTargetsOnSave(
          globalPipeline({
            scope: 'worktree',
            workspace_id: '${{ inputs.project }}',
            worktree: { id: 'task-b' },
          }),
          'personal',
        ),
      ).resolves.toBeNull();
      expect(mockDecideSameOwnerAccess).not.toHaveBeenCalled();
    });

    it('checks only the project when the task is an expression', async () => {
      await validatePipelineOwnerTargetsOnSave(
        globalPipeline({
          scope: 'worktree',
          workspace_id: 'project-b',
          worktree: { id: '${{ inputs.task }}' },
        }),
        'personal',
      );
      expect(mockDecideSameOwnerAccess).toHaveBeenCalledWith(
        { kind: 'personal' },
        { projectId: 'project-b' },
      );
    });

    it('skips a project-scoped pipeline', async () => {
      await expect(
        validatePipelineOwnerTargetsOnSave(
          globalPipeline(literal, ['worktree']),
          `org:${ORG_A}`,
        ),
      ).resolves.toBeNull();
      expect(mockDecideSameOwnerAccess).not.toHaveBeenCalled();
    });
  });
});
