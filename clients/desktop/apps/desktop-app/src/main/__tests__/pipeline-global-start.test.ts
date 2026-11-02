import type { ExecutePipelineRequestOptions } from '@canopy/desktop-shared/node/pipelines/executor';
import type { Pipeline } from '@canopy/desktop-shared/types/pipeline';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import type { PipelineLocalMetadata } from '../pipelines/pipeline-local-metadata-store';

const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

let mockFlagEnabled = true;
let mockSelected: string | undefined = `org:${ORG_A}`;
const mockAccountMayRunIn = jest.fn<Promise<boolean>, [WorkspaceContext]>(() =>
  Promise.resolve(true),
);
jest.mock('../services/background-execution-context', () => ({
  backgroundExecutionContextEnabled: (): boolean => mockFlagEnabled,
  captureBackgroundExecutionContext: (): Promise<string | undefined> =>
    Promise.resolve(mockFlagEnabled ? mockSelected : undefined),
  accountMayRunIn: (context: WorkspaceContext): unknown =>
    mockAccountMayRunIn(context),
  resolveBackgroundTargetContext: (): unknown =>
    Promise.reject(new Error('unresolved')),
}));

jest.mock('../lib/project-owner', () => ({
  resolveProjectSavedOwner: (): unknown =>
    Promise.resolve({ kind: 'personal' }),
  decideSameOwnerAccess: (): unknown => Promise.resolve({ kind: 'allowed' }),
}));

let mockMetadata: Record<string, PipelineLocalMetadata> = {};
let mockMetadataReadable = true;
const mockRecordUserPipelineOwner = jest.fn<void, [string, string]>();
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
  GLOBAL_RUN_DISPATCH_ONLY_MESSAGE,
  GLOBAL_RUN_OWNER_TARGETED_MESSAGE,
  GLOBAL_RUN_OWNER_CHECK_FAILED_MESSAGE,
  GLOBAL_RUN_SCOPE_MESSAGE,
  GLOBAL_RUN_TARGET_MESSAGE,
  GLOBAL_RUN_WATCHERS_MESSAGE,
  isGlobalStartRequest,
  isPersonStart,
  localUserPipelineIdForRequest,
  preflightGlobalStart,
  validateGlobalStartShape,
} from '../pipelines/pipeline-global-start';
import {
  CHOOSE_RUN_OWNER_MESSAGE,
  RUN_OWNER_UNAVAILABLE_MESSAGE,
} from '../pipelines/pipeline-owner-policy';
import { PIPELINE_NOW_OWNED_MESSAGE } from '@canopy/desktop-shared/types/pipeline';

type StartOptions = Parameters<typeof preflightGlobalStart>[1];

function pipeline(scope?: unknown): Pipeline {
  return {
    name: 'Global',
    on: 'dispatch',
    ...(scope === undefined ? {} : { scope: scope as Pipeline['scope'] }),
    jobs: { build: { steps: [{ id: 'hello', run: 'echo hi' }] } },
  };
}

const GLOBAL_PIPELINE = pipeline(['global']);

function anyStringContaining(text: string): unknown {
  return expect.stringContaining(text);
}

function globalStart(overrides: Partial<StartOptions> = {}): StartOptions {
  return {
    pipelineId: 'user-pipeline',
    scope: 'global',
    requestedOwner: `org:${ORG_B}`,
    ...overrides,
  };
}

const WATCHER: NonNullable<
  ExecutePipelineRequestOptions['appAdvisorPipelineWatchers']
>[number] = {
  destination: { projectId: 'project-1', worktreeId: 'task-1', chatId: 'c' },
  watcher: {},
};

describe('global pipeline start preflight', () => {
  beforeEach(() => {
    mockFlagEnabled = true;
    mockSelected = `org:${ORG_A}`;
    mockMetadata = {};
    mockMetadataReadable = true;
    mockAccountMayRunIn.mockReset();
    mockAccountMayRunIn.mockResolvedValue(true);
    mockRecordUserPipelineOwner.mockClear();
  });

  it('identifies a global start from its scope or target', () => {
    expect(isGlobalStartRequest({ scope: 'global' })).toBe(true);
    expect(isGlobalStartRequest({ target: { scope: 'global' } })).toBe(true);
    expect(isGlobalStartRequest({ scope: 'worktree' })).toBe(false);
    expect(isGlobalStartRequest({})).toBe(false);
  });

  it('treats only people as person starts', () => {
    expect(isPersonStart({})).toBe(true);
    expect(isPersonStart({ initiationSource: 'user' })).toBe(true);
    expect(isPersonStart({ initiationSource: 'portal' })).toBe(true);
    expect(isPersonStart({ initiator: { kind: 'user' } })).toBe(true);
    expect(isPersonStart({ initiator: { kind: 'portal' } })).toBe(true);
    expect(isPersonStart({ initiationSource: 'hook' })).toBe(false);
    expect(isPersonStart({ initiationSource: 'automation' })).toBe(false);
    expect(isPersonStart({ initiationSource: 'app_advisor' })).toBe(false);
    expect(
      isPersonStart({
        initiationSource: 'user',
        initiator: {
          kind: 'agent',
          chat: { projectId: 'p', worktreeId: 't', chatId: 'c' },
        },
      }),
    ).toBe(false);
  });

  it('names a local user pipeline only for a stored user definition', () => {
    expect(localUserPipelineIdForRequest({ pipelineId: 'user-pipeline' })).toBe(
      'user-pipeline',
    );
    expect(
      localUserPipelineIdForRequest({ pipelineId: 'bundled-pipeline' }),
    ).toBeUndefined();
    expect(
      localUserPipelineIdForRequest({
        pipelineId: 'user-pipeline',
        pipelineFilePath: '/repo/.canopy/pipelines/p.yaml',
      }),
    ).toBeUndefined();
    expect(
      localUserPipelineIdForRequest({
        pipelineId: 'user-pipeline',
        pipelinePreferenceLocator: {
          type: 'stored',
          source: 'bundled',
          value: 'user-pipeline',
        },
      }),
    ).toBeUndefined();
    expect(
      localUserPipelineIdForRequest({ pipelineId: 'curated:user-pipeline' }),
    ).toBeUndefined();
  });

  describe('request shape', () => {
    it('accepts a global dispatch with no project', () => {
      expect(
        validateGlobalStartShape(GLOBAL_PIPELINE, globalStart()),
      ).toBeNull();
      expect(
        validateGlobalStartShape(
          GLOBAL_PIPELINE,
          globalStart({
            eventName: 'dispatch',
            appAdvisorPipelineWatchers: [],
          }),
        ),
      ).toBeNull();
    });

    it.each<[string, Partial<StartOptions>]>([
      ['a non-dispatch event', { eventName: 'plan_ready' }],
      ['a plan id', { planId: 'plan-1' }],
      [
        'plan_ready event data',
        { eventData: { plan_ready: { planId: 'plan-1' } } },
      ],
      [
        'task_ready event data',
        { eventData: { task_ready: { task_text: 'Do it' } } },
      ],
    ])('refuses %s as dispatch-only', (_label, overrides) => {
      expect(
        validateGlobalStartShape(GLOBAL_PIPELINE, globalStart(overrides)),
      ).toEqual({
        reason: 'invalid_target',
        message: GLOBAL_RUN_DISPATCH_ONLY_MESSAGE,
      });
    });

    it.each<[string, Partial<StartOptions>]>([
      ['a project', { projectId: 'project-1' }],
      ['a task', { worktreeId: 'task-1' }],
      ['a repository path', { repoPath: '/repo' }],
      ['a pipeline file', { pipelineFilePath: '/repo/p.yaml' }],
      ['a working directory', { cwd: '/repo' }],
      [
        'a non-global target',
        { target: { scope: 'directory', path: '/repo' } },
      ],
      [
        'a non-global scope with a global target',
        { scope: 'worktree', target: { scope: 'global' } },
      ],
    ])('refuses %s', (_label, overrides) => {
      expect(
        validateGlobalStartShape(GLOBAL_PIPELINE, globalStart(overrides)),
      ).toEqual({
        reason: 'invalid_target',
        message: GLOBAL_RUN_TARGET_MESSAGE,
      });
    });

    it('refuses completion watchers', () => {
      expect(
        validateGlobalStartShape(
          GLOBAL_PIPELINE,
          globalStart({ appAdvisorPipelineWatchers: [WATCHER] }),
        ),
      ).toEqual({
        reason: 'unsupported_watchers',
        message: GLOBAL_RUN_WATCHERS_MESSAGE,
      });
    });

    it('refuses a chosen owner on a targeted run', () => {
      expect(
        validateGlobalStartShape(GLOBAL_PIPELINE, {
          pipelineId: 'user-pipeline',
          scope: 'worktree',
          projectId: 'project-1',
          worktreeId: 'task-1',
          requestedOwner: 'personal',
        }),
      ).toEqual({
        reason: 'invalid_target',
        message: GLOBAL_RUN_OWNER_TARGETED_MESSAGE,
      });
    });

    it('leaves a targeted run without a chosen owner alone', () => {
      expect(
        validateGlobalStartShape(pipeline(['worktree']), {
          pipelineId: 'user-pipeline',
          scope: 'worktree',
          projectId: 'project-1',
          cwd: '/repo',
        }),
      ).toBeNull();
    });
  });

  describe('scope support', () => {
    it('accepts a global-only pipeline', () => {
      expect(
        validateGlobalStartShape(pipeline(['global']), globalStart()),
      ).toBeNull();
      expect(validateGlobalStartShape(pipeline('global'), globalStart())).toBe(
        null,
      );
    });

    it('accepts a pipeline that also runs in a task', () => {
      expect(
        validateGlobalStartShape(
          pipeline(['global', 'worktree']),
          globalStart(),
        ),
      ).toBeNull();
    });

    it.each<[string, unknown]>([
      ['directory-only', ['directory']],
      ['worktree-only', ['worktree']],
      ['default (directory)', undefined],
      ['invalid', ['nowhere']],
    ])('refuses a %s pipeline', (_label, scope) => {
      expect(validateGlobalStartShape(pipeline(scope), globalStart())).toEqual({
        reason: 'unsupported_scope',
        message: GLOBAL_RUN_SCOPE_MESSAGE,
      });
    });
  });

  describe('refusal order', () => {
    it('reports dispatch-only before a project target', async () => {
      await expect(
        preflightGlobalStart(
          GLOBAL_PIPELINE,
          globalStart({ eventName: 'plan_ready', cwd: '/repo' }),
        ),
      ).resolves.toMatchObject({ message: GLOBAL_RUN_DISPATCH_ONLY_MESSAGE });
    });

    it('reports a project target before watchers', async () => {
      await expect(
        preflightGlobalStart(
          GLOBAL_PIPELINE,
          globalStart({
            projectId: 'project-1',
            appAdvisorPipelineWatchers: [WATCHER],
          }),
        ),
      ).resolves.toMatchObject({ message: GLOBAL_RUN_TARGET_MESSAGE });
    });

    it('reports watchers before scope support', async () => {
      await expect(
        preflightGlobalStart(
          pipeline(['directory']),
          globalStart({ appAdvisorPipelineWatchers: [WATCHER] }),
        ),
      ).resolves.toMatchObject({ message: GLOBAL_RUN_WATCHERS_MESSAGE });
    });

    it('reports scope support before the owner choice', async () => {
      await expect(
        preflightGlobalStart(
          pipeline(['directory']),
          globalStart({ requestedOwner: 'org:not-a-uuid' }),
        ),
      ).resolves.toMatchObject({ message: GLOBAL_RUN_SCOPE_MESSAGE });
      await expect(
        preflightGlobalStart(
          GLOBAL_PIPELINE,
          globalStart({ requestedOwner: 'org:not-a-uuid' }),
        ),
      ).resolves.toEqual({
        reason: 'owner_unavailable',
        message: RUN_OWNER_UNAVAILABLE_MESSAGE,
      });
    });
  });

  describe('trusted callers', () => {
    it.each(['hook', 'automation'] as const)(
      'skips every check for a %s',
      async (initiationSource) => {
        await expect(
          preflightGlobalStart(
            pipeline(['directory']),
            globalStart({
              initiationSource,
              cwd: '/repo',
              requestedOwner: undefined,
            }),
          ),
        ).resolves.toBeNull();
        expect(mockAccountMayRunIn).not.toHaveBeenCalled();
      },
    );

    it("checks an agent's request shape but not a person's owner choice", async () => {
      const agent = {
        initiator: {
          kind: 'agent' as const,
          chat: { projectId: 'p', worktreeId: 't', chatId: 'c' },
        },
      };
      await expect(
        preflightGlobalStart(
          GLOBAL_PIPELINE,
          globalStart({ ...agent, cwd: '/repo' }),
        ),
      ).resolves.toMatchObject({ message: GLOBAL_RUN_TARGET_MESSAGE });
      await expect(
        preflightGlobalStart(
          GLOBAL_PIPELINE,
          globalStart({ ...agent, requestedOwner: undefined }),
        ),
      ).resolves.toBeNull();
    });

    it('does not check the owner of a targeted run', async () => {
      await expect(
        preflightGlobalStart(pipeline(['worktree']), {
          pipelineId: 'user-pipeline',
          scope: 'worktree',
          projectId: 'project-1',
          cwd: '/repo',
        }),
      ).resolves.toBeNull();
      expect(mockAccountMayRunIn).not.toHaveBeenCalled();
    });
  });

  describe("a person's owner", () => {
    it('accepts a chosen organization the account belongs to', async () => {
      await expect(
        preflightGlobalStart(GLOBAL_PIPELINE, globalStart()),
      ).resolves.toBeNull();
      expect(mockAccountMayRunIn).toHaveBeenCalledWith({
        kind: 'organization',
        organizationId: ORG_B,
      });
      expect(mockRecordUserPipelineOwner).not.toHaveBeenCalled();
    });

    it('refuses an organization the account no longer belongs to', async () => {
      mockAccountMayRunIn.mockResolvedValue(false);
      await expect(
        preflightGlobalStart(GLOBAL_PIPELINE, globalStart()),
      ).resolves.toEqual({
        reason: 'owner_unavailable',
        message: anyStringContaining('You no longer have access'),
      });
      expect(mockRecordUserPipelineOwner).not.toHaveBeenCalled();
    });

    it("refuses, rather than throws, when membership can't be read", async () => {
      mockAccountMayRunIn.mockRejectedValue(new Error('offline'));
      await expect(
        preflightGlobalStart(GLOBAL_PIPELINE, globalStart()),
      ).resolves.toEqual({
        reason: 'owner_unavailable',
        message: GLOBAL_RUN_OWNER_CHECK_FAILED_MESSAGE,
      });
      expect(mockRecordUserPipelineOwner).not.toHaveBeenCalled();
    });

    it('refuses a saved organization the account no longer belongs to', async () => {
      mockMetadata['user-pipeline'] = { owner: `org:${ORG_B}` };
      mockAccountMayRunIn.mockResolvedValue(false);
      await expect(
        preflightGlobalStart(
          GLOBAL_PIPELINE,
          globalStart({ requestedOwner: undefined }),
        ),
      ).resolves.toMatchObject({ reason: 'owner_unavailable' });
    });

    it('trusts membership of the selected organization', async () => {
      mockAccountMayRunIn.mockResolvedValue(false);
      await expect(
        preflightGlobalStart(
          GLOBAL_PIPELINE,
          globalStart({ requestedOwner: `org:${ORG_A}` }),
        ),
      ).resolves.toBeNull();
      expect(mockAccountMayRunIn).not.toHaveBeenCalled();
    });

    it('does not check membership for Personal', async () => {
      await expect(
        preflightGlobalStart(
          GLOBAL_PIPELINE,
          globalStart({ requestedOwner: 'personal' }),
        ),
      ).resolves.toBeNull();
      expect(mockAccountMayRunIn).not.toHaveBeenCalled();
    });

    it('requires a choice for an unowned pipeline', async () => {
      await expect(
        preflightGlobalStart(
          GLOBAL_PIPELINE,
          globalStart({ requestedOwner: undefined }),
        ),
      ).resolves.toEqual({
        reason: 'owner_unavailable',
        message: CHOOSE_RUN_OWNER_MESSAGE,
      });
    });

    it('refuses a choice that conflicts with a saved owner', async () => {
      mockMetadata['user-pipeline'] = { owner: 'personal' };
      await expect(
        preflightGlobalStart(GLOBAL_PIPELINE, globalStart()),
      ).resolves.toEqual({
        reason: 'owner_unavailable',
        message: PIPELINE_NOW_OWNED_MESSAGE,
        code: 'pipeline_now_owned',
      });
      expect(mockRecordUserPipelineOwner).not.toHaveBeenCalled();
    });

    it("refuses while the saved owner can't be read", async () => {
      mockMetadataReadable = false;
      await expect(
        preflightGlobalStart(GLOBAL_PIPELINE, globalStart()),
      ).resolves.toEqual({
        reason: 'owner_unavailable',
        message: anyStringContaining("Couldn't confirm where"),
      });
    });

    it('with organization projects off, accepts Personal and refuses an organization', async () => {
      mockFlagEnabled = false;
      await expect(
        preflightGlobalStart(
          GLOBAL_PIPELINE,
          globalStart({ requestedOwner: undefined }),
        ),
      ).resolves.toBeNull();
      await expect(
        preflightGlobalStart(
          GLOBAL_PIPELINE,
          globalStart({ requestedOwner: 'personal' }),
        ),
      ).resolves.toBeNull();
      await expect(
        preflightGlobalStart(GLOBAL_PIPELINE, globalStart()),
      ).resolves.toEqual({
        reason: 'owner_unavailable',
        message: RUN_OWNER_UNAVAILABLE_MESSAGE,
      });
      expect(mockAccountMayRunIn).not.toHaveBeenCalled();
    });
  });
});
