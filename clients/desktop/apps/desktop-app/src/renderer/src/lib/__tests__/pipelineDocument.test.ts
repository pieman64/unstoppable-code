/**
 * @jest-environment jsdom
 *
 * Coverage for the source-aware pipeline-document loader shared by
 * `usePipelineEditor` and the Pipelines-page row Share flow.
 */
import type {
  PipelineData,
  PipelineInfo,
  SharedPipelineDetail,
} from '@canopy/desktop-shared/types/pipeline';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import {
  fetchPipelineDocument,
  loadAutomationPipelineDocument,
  loadPipelineShareTargetDocument,
  loadPipelineDocument,
  pipelineInfoToDocumentLocator,
  sharedDetailToPipelineData,
} from '../pipelineDocument';

const get = jest.fn();
const getShared = jest.fn();
const list = jest.fn();
const discoverProject = jest.fn();
const getWorktreePath = jest.fn();
const loadProjects = jest.fn();
const getWorkspaceSettingsData = jest.fn();

beforeEach(() => {
  get.mockReset();
  getShared.mockReset();
  list.mockReset();
  discoverProject.mockReset();
  getWorktreePath.mockReset();
  loadProjects.mockReset();
  getWorkspaceSettingsData.mockReset();
  Object.defineProperty(window, 'pipelines', {
    configurable: true,
    writable: true,
    value: { get, getShared, list, discoverProject },
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { getWorktreePath, loadProjects, getWorkspaceSettingsData },
  });
});

function makeInfo(overrides: Partial<PipelineInfo> = {}): PipelineInfo {
  return {
    id: 'demo',
    name: 'Demo',
    filename: 'demo.yaml',
    description: '',
    icon: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    source: 'user',
    readonly: false,
    ...overrides,
  };
}

function makeData(info: PipelineInfo): PipelineData {
  return { info, content: { name: info.name, on: 'dispatch', jobs: {} } };
}

function makeSharedDetail(
  overrides: Partial<SharedPipelineDetail> = {},
): SharedPipelineDetail {
  return {
    id: 'remote-1',
    name: 'Shared demo',
    description: 'desc',
    icon: 'rocket',
    version: '1',
    triggerTypes: ['dispatch'],
    createdBy: { id: 'user-1', name: 'Test User' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    contentHash: 'content-hash',
    rawPipeline: 'name: Shared demo\non: dispatch\njobs: {}\n',
    canUpdate: true,
    canDelete: true,
    ...overrides,
  };
}

describe('pipelineInfoToDocumentLocator', () => {
  it('addresses user/bundled/curated rows by their stored-catalog source', () => {
    expect(
      pipelineInfoToDocumentLocator(makeInfo({ source: 'curated' }), '/repo'),
    ).toEqual({
      pipelineId: 'demo',
      cwd: undefined,
      pipelineFilePath: undefined,
      pipelineSource: 'curated',
      sharedRemoteId: undefined,
    });
  });

  it('carries cwd and filePath for project rows only', () => {
    expect(
      pipelineInfoToDocumentLocator(
        makeInfo({ source: 'project', filePath: '/repo/.canopy/p.yaml' }),
        '/repo',
      ),
    ).toEqual({
      pipelineId: 'demo',
      cwd: '/repo',
      pipelineFilePath: '/repo/.canopy/p.yaml',
      pipelineSource: undefined,
      sharedRemoteId: undefined,
    });
  });

  it('carries the remote id for shared rows', () => {
    expect(
      pipelineInfoToDocumentLocator(
        makeInfo({ source: 'shared', remoteId: 'remote-1' }),
        '/repo',
      ),
    ).toEqual({
      pipelineId: 'demo',
      cwd: undefined,
      pipelineFilePath: undefined,
      pipelineSource: undefined,
      sharedRemoteId: 'remote-1',
    });
  });
});

describe('loadPipelineDocument', () => {
  it('fetches shared pipelines through getShared and rebuilds renderer info', async () => {
    const detail: SharedPipelineDetail = makeSharedDetail({
      id: 'remote-1',
      name: 'Shared demo',
      description: 'desc',
      icon: 'rocket',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      rawPipeline: 'name: Shared demo\non: manual\njobs: {}\n',
      canUpdate: true,
      canDelete: true,
    });
    getShared.mockResolvedValue({ success: true, data: detail });

    const result = await loadPipelineDocument({
      pipelineId: 'shared:canopy-cloud:remote-1',
      sharedRemoteId: 'remote-1',
    });

    expect(getShared).toHaveBeenCalledWith({ remoteId: 'remote-1' });
    expect(get).not.toHaveBeenCalled();
    expect(result.data?.info.id).toBe('shared:canopy-cloud:remote-1');
    expect(result.data?.info.source).toBe('shared');
    expect(result.data?.info.readonly).toBe(false);
    expect(result.data?.info.shareScope).toBe('private');
    expect(result.data?.info.publicShare).toBeNull();
  });

  it('surfaces the typed handler error from a failed shared fetch', async () => {
    getShared.mockResolvedValue({
      success: false,
      error: 'Canopy Cloud account is not configured',
    });

    const result = await loadPipelineDocument({
      pipelineId: 'shared:canopy-cloud:remote-1',
      sharedRemoteId: 'remote-1',
    });

    expect(result).toEqual({
      error: 'Canopy Cloud account is not configured',
    });
  });

  it('looks project pipelines up by cwd and file path', async () => {
    const info = makeInfo({
      source: 'project',
      filePath: '/repo/.canopy/p.yaml',
    });
    get.mockResolvedValue({ success: true, data: makeData(info) });

    const result = await loadPipelineDocument({
      pipelineId: 'demo',
      cwd: '/repo',
      pipelineFilePath: '/repo/.canopy/p.yaml',
    });

    expect(get).toHaveBeenCalledWith({
      id: 'demo',
      cwd: '/repo',
      filePath: '/repo/.canopy/p.yaml',
    });
    expect(result.data?.info.source).toBe('project');
  });

  it('looks stored pipelines up by their namespace', async () => {
    const info = makeInfo({ source: 'bundled' });
    get.mockResolvedValue({ success: true, data: makeData(info) });

    await loadPipelineDocument({
      pipelineId: 'demo',
      pipelineSource: 'bundled',
    });

    expect(get).toHaveBeenCalledWith({ id: 'demo', source: 'bundled' });
  });

  it('falls back to the bare-id lookup when no source is known', async () => {
    get.mockResolvedValue({ success: true, data: makeData(makeInfo()) });

    await loadPipelineDocument({ pipelineId: 'demo' });

    expect(get).toHaveBeenCalledWith('demo');
  });

  it('reports a missing id without touching IPC', async () => {
    const result = await loadPipelineDocument({ pipelineId: null });

    expect(result).toEqual({
      error: 'Workflow id is required to load this workflow',
    });
    expect(get).not.toHaveBeenCalled();
    expect(getShared).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the handler omits one', async () => {
    get.mockResolvedValue({ success: false });

    const result = await loadPipelineDocument({ pipelineId: 'demo' });

    expect(result).toEqual({ error: 'Failed to load workflow' });
  });

  // `registerIpcHandler` rejects the `invoke` when a main-process handler
  // throws instead of returning `{ success: false }`, so a rejection is a real
  // outcome for both callers. `usePipelineEditor` wraps its own call in a
  // try/catch; the Pipelines-page Share flow does not, so the rejection has to
  // be normalized here or it escapes as an unhandled rejection with nothing
  // shown to the user.
  it('normalizes a rejected stored-pipeline invoke into an error result', async () => {
    get.mockRejectedValue(new Error('EPERM: pipelines/index.json'));

    const result = await loadPipelineDocument({ pipelineId: 'demo' });

    expect(result).toEqual({ error: 'EPERM: pipelines/index.json' });
  });

  it('normalizes a rejected shared-pipeline invoke into an error result', async () => {
    getShared.mockRejectedValue('cloud offline');

    const result = await loadPipelineDocument({
      pipelineId: null,
      sharedRemoteId: 'remote-1',
    });

    expect(result).toEqual({ error: 'cloud offline' });
  });
});

describe('loadAutomationPipelineDocument', () => {
  it.each([undefined, WORKSPACE_ROOT_REPO_ID])(
    'resolves a source-backed workspace root pipeline with repo %s',
    async (repoId): Promise<void> => {
      const info = makeInfo({
        source: 'project',
        filename: 'review.yaml',
        filePath: '/reference/.canopy/pipelines/review.yaml',
      });
      loadProjects.mockResolvedValue({
        version: 1,
        items: [
          {
            id: 'project-1',
            type: 'multi-repo',
            repos: [],
            sourceRepoPath: '/source',
            worktrees: [],
          },
        ],
      });
      getWorkspaceSettingsData.mockResolvedValue({
        referenceRepoPath: '/reference',
      });
      discoverProject.mockResolvedValue({ success: true, data: [info] });
      get.mockResolvedValue({ success: true, data: makeData(info) });
      const result = await loadAutomationPipelineDocument({
        type: 'worktree_pipeline',
        workspaceId: 'project-1',
        pipelineId: 'demo',
        pipelineSource: 'project',
        ...(repoId ? { repoId } : {}),
      });
      expect(result.error).toBeUndefined();
      expect(getWorkspaceSettingsData).toHaveBeenCalledWith({
        workspaceId: 'project-1',
      });
      expect(discoverProject).toHaveBeenCalledWith('/reference');
    },
  );
  it("loads a project-folder destination's pipeline from the configured source folder", async () => {
    // Discovery and the run use the configured folder, never the reference
    // checkout it may be a linked worktree of.
    const info = makeInfo({
      source: 'project',
      filename: 'review.yaml',
      filePath: '/source/.canopy/pipelines/review.yaml',
    });
    loadProjects.mockResolvedValue({
      version: 1,
      items: [
        {
          id: 'project-1',
          type: 'multi-repo',
          repos: [],
          sourceRepoPath: '/source',
          worktrees: [],
        },
      ],
    });
    getWorkspaceSettingsData.mockResolvedValue({
      referenceRepoPath: '/reference',
    });
    discoverProject.mockResolvedValue({ success: true, data: [info] });
    get.mockResolvedValue({ success: true, data: makeData(info) });
    const result = await loadAutomationPipelineDocument({
      type: 'worktree_pipeline',
      workspaceId: 'project-1',
      target: { kind: 'project' },
      pipelineId: 'demo',
      pipelineSource: 'project',
    });
    expect(result.error).toBeUndefined();
    expect(discoverProject).toHaveBeenCalledWith('/source');
    expect(getWorkspaceSettingsData).not.toHaveBeenCalled();
  });

  it('loads a project pipeline through its resolved worktree cwd and discovery row', async () => {
    const info = makeInfo({
      source: 'project',
      filename: 'review.yaml',
      filePath: '/repo/.canopy/pipelines/review.yaml',
    });
    getWorktreePath.mockResolvedValue('/repo');
    discoverProject.mockResolvedValue({ success: true, data: [info] });
    get.mockResolvedValue({ success: true, data: makeData(info) });

    await loadAutomationPipelineDocument({
      type: 'worktree_pipeline',
      workspaceId: 'project-1',
      baseWorktreeId: 'worktree-1',
      repoId: 'repo-1',
      pipelineId: 'demo',
      pipelineSource: 'project',
      projectPipelineFilename: 'review.yaml',
    });

    expect(getWorktreePath).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      repoId: 'repo-1',
    });
    expect(discoverProject).toHaveBeenCalledWith('/repo');
    expect(get).toHaveBeenCalledWith({
      id: 'demo',
      cwd: '/repo',
      filePath: '/repo/.canopy/pipelines/review.yaml',
    });
  });

  it('loads a task destination project pipeline from the task checkout', async () => {
    const info = makeInfo({
      source: 'project',
      filename: 'review.yaml',
      filePath: '/tasks/feature/.canopy/pipelines/review.yaml',
    });
    loadProjects.mockResolvedValue({
      version: 1,
      items: [
        {
          id: 'project-1',
          type: 'single-repo',
          repoPath: '/repo',
          worktrees: [{ id: 'task-1' }],
        },
      ],
    });
    getWorktreePath.mockResolvedValue('/tasks/feature');
    discoverProject.mockResolvedValue({ success: true, data: [info] });
    get.mockResolvedValue({ success: true, data: makeData(info) });

    const result = await loadAutomationPipelineDocument({
      type: 'worktree_pipeline',
      workspaceId: 'project-1',
      target: { kind: 'task', taskId: 'task-1' },
      pipelineId: 'demo',
      pipelineSource: 'project',
      projectPipelineFilename: 'review.yaml',
    });

    expect(getWorktreePath).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'task-1',
    });
    expect(discoverProject).toHaveBeenCalledWith('/tasks/feature');
    expect(result.worktree).toEqual({
      projectId: 'project-1',
      worktreeId: 'task-1',
    });
  });

  it('loads a project pipeline from the project root when no base is persisted', async () => {
    const info = makeInfo({
      source: 'project',
      filename: 'review.yaml',
      filePath: '/repo/.canopy/pipelines/review.yaml',
    });
    loadProjects.mockResolvedValue({
      version: 1,
      items: [
        {
          id: 'project-1',
          type: 'single-repo',
          repoPath: '/repo',
          worktrees: [{ id: 'worktree-default' }],
        },
      ],
    });
    getWorktreePath.mockResolvedValue('/repo');
    discoverProject.mockResolvedValue({ success: true, data: [info] });
    get.mockResolvedValue({ success: true, data: makeData(info) });

    const result = await loadAutomationPipelineDocument({
      type: 'worktree_pipeline',
      workspaceId: 'project-1',
      pipelineId: 'demo',
      pipelineSource: 'project',
      projectPipelineFilename: 'review.yaml',
    });

    expect(loadProjects).toHaveBeenCalledTimes(1);
    expect(getWorktreePath).not.toHaveBeenCalled();
    expect(discoverProject).toHaveBeenCalledWith('/repo');
    expect(result.data?.info.source).toBe('project');
    expect(result.worktree).toBeUndefined();
  });

  it('uses the project root while a new checkout is being set up', async () => {
    const info = makeInfo({
      source: 'project',
      filename: 'review.yaml',
      filePath: '/repo/.canopy/pipelines/review.yaml',
    });
    loadProjects.mockResolvedValue({
      version: 1,
      items: [
        {
          id: 'project-1',
          type: 'single-repo',
          repoPath: '/repo',
          worktrees: [
            { id: 'worktree-new', setupPhase: 'git-pending' },
            { id: 'worktree-default' },
          ],
        },
      ],
    });
    getWorktreePath.mockResolvedValue('/repo');
    discoverProject.mockResolvedValue({ success: true, data: [info] });
    get.mockResolvedValue({ success: true, data: makeData(info) });

    await loadAutomationPipelineDocument({
      type: 'worktree_pipeline',
      workspaceId: 'project-1',
      pipelineId: 'demo',
      pipelineSource: 'project',
      projectPipelineFilename: 'review.yaml',
    });

    expect(getWorktreePath).not.toHaveBeenCalled();
    expect(discoverProject).toHaveBeenCalledWith('/repo');
  });
});

describe('fetchPipelineDocument', () => {
  it('derives the locator from the row before loading', async () => {
    const info = makeInfo({
      source: 'project',
      filePath: '/repo/.canopy/p.yaml',
    });
    get.mockResolvedValue({ success: true, data: makeData(info) });

    const result = await fetchPipelineDocument(info, '/repo');

    expect(get).toHaveBeenCalledWith({
      id: 'demo',
      cwd: '/repo',
      filePath: '/repo/.canopy/p.yaml',
    });
    expect(result.error).toBeUndefined();
  });

  it('names the problem when a shared row has no remote id', async () => {
    const info = makeInfo({ source: 'shared', remoteId: undefined });

    const result = await fetchPipelineDocument(info);

    expect(result.error).toBe('This shared workflow is missing its remote id');
    expect(result.data).toBeUndefined();
    // Must not fall through to the bare-id lookup, which would resolve against
    // the local stored catalog and fail with an opaque "not found".
    expect(get).not.toHaveBeenCalled();
    expect(getShared).not.toHaveBeenCalled();
  });
});

describe('sharedDetailToPipelineData', () => {
  it('marks a non-updatable shared pipeline readonly and preserves owner/scope', () => {
    const data = sharedDetailToPipelineData(
      makeSharedDetail({
        id: 'remote-2',
        name: 'Org pipeline',
        description: '',
        icon: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        rawPipeline: 'name: Org pipeline\non: manual\njobs: {}\n',
        canUpdate: false,
        canDelete: false,
        shareScope: 'organization',
      }),
    );

    expect(data.info.readonly).toBe(true);
    expect(data.info.shareScope).toBe('organization');
    expect(data.info.remoteId).toBe('remote-2');
  });
});

describe('pipeline artifact Share locators', () => {
  it('loads the current stored pipeline by stable identity after rename', async () => {
    const info = makeInfo({ name: 'Renamed' });
    list.mockResolvedValue({ success: true, data: [info] });
    get.mockResolvedValue({ success: true, data: makeData(info) });
    expect(
      (
        await loadPipelineShareTargetDocument({
          kind: 'pipeline',
          source: 'stored',
          pipelineId: 'demo',
        })
      ).data?.info.name,
    ).toBe('Renamed');
    expect(get).toHaveBeenCalledWith({ id: 'demo', source: 'user' });
  });
  it('rejects an ambiguous or deleted stored identity without another source fallback', async () => {
    const target = {
      kind: 'pipeline' as const,
      source: 'stored' as const,
      pipelineId: 'demo',
    };
    list.mockResolvedValue({ success: true, data: [makeInfo(), makeInfo()] });
    expect((await loadPipelineShareTargetDocument(target)).error).toBeDefined();
    list.mockResolvedValue({
      success: true,
      data: [makeInfo({ source: 'bundled' })],
    });
    expect((await loadPipelineShareTargetDocument(target)).error).toBeDefined();
    expect(get).not.toHaveBeenCalled();
  });
  it('requires the exact project file and the owning available worktree', async () => {
    const target = {
      kind: 'pipeline' as const,
      source: 'project' as const,
      pipelineId: 'project--ci.yaml',
      projectId: 'p',
      worktreeId: 'w',
      relativePath: '.canopy/pipelines/ci.yaml',
    };
    getWorktreePath.mockResolvedValue(null);
    expect((await loadPipelineShareTargetDocument(target)).error).toBeDefined();
    expect(discoverProject).not.toHaveBeenCalled();
    getWorktreePath.mockResolvedValue('/repo');
    const info = makeInfo({
      id: target.pipelineId,
      source: 'project',
      filePath: '/repo/.canopy/pipelines/other.yaml',
    });
    discoverProject.mockResolvedValue({ success: true, data: [info] });
    expect((await loadPipelineShareTargetDocument(target)).error).toBeDefined();
    info.filePath = '/repo/.canopy/pipelines/ci.yaml';
    get.mockResolvedValue({ success: true, data: makeData(info) });
    const result = await loadPipelineShareTargetDocument(target);
    expect(result.worktree).toEqual({ projectId: 'p', worktreeId: 'w' });
    expect(get).toHaveBeenCalledWith({
      id: target.pipelineId,
      cwd: '/repo',
      filePath: info.filePath,
    });
  });
});
