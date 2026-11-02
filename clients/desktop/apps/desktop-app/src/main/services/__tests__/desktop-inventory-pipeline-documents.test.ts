const mockReadAllSidebarItems = jest.fn<Promise<unknown>, []>();
let snapshotAuthority = 'ok';
const mockListPipelinesStrict = jest.fn();
const mockLogMainProcessError = jest.fn();
const mockReadWorkspaceConfigDetailed = jest.fn();

jest.mock('../../lib/sidebar-items', () => ({
  readAllSidebarItemsSnapshot: async (): Promise<unknown> => ({
    file: await mockReadAllSidebarItems(),
    authority: snapshotAuthority,
  }),
}));
jest.mock('../pipelines-service', () => ({
  get listPipelinesStrict(): typeof mockListPipelinesStrict {
    return mockListPipelinesStrict;
  },
  pipelineListTargetFor: (
    item: { id: string },
    worktreeLocalId: string,
  ): { workspaceLocalId: string; worktreeLocalId: string; cwd: string } => ({
    workspaceLocalId: item.id,
    worktreeLocalId,
    cwd: `/checkouts/${item.id}/${worktreeLocalId}`,
  }),
}));
jest.mock('../../lib/main-process-logging', () => ({
  get logMainProcessError(): typeof mockLogMainProcessError {
    return mockLogMainProcessError;
  },
}));
jest.mock('../../lib/workspace-persistence', () => ({
  readWorkspaceConfigDetailed: (...args: unknown[]): unknown =>
    mockReadWorkspaceConfigDetailed(...args),
}));

import { listWorktreePipelineInventoryDocuments } from '../desktop-inventory-pipeline-documents';

const summary = (pipelineId: string): Record<string, unknown> => ({
  workspaceLocalId: 'ws-1',
  worktreeLocalId: 'wt-a',
  pipelineId,
  name: pipelineId,
  description: '',
  source: `${pipelineId}.yaml`,
  triggerTypes: ['dispatch'],
  scopes: ['worktree'],
});

describe('listWorktreePipelineInventoryDocuments', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    snapshotAuthority = 'ok';
    mockReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        {
          id: 'ws-1',
          type: 'single-repo',
          worktrees: [{ id: 'wt-a' }, { id: 'wt-b' }],
        },
        { id: 'cowork-1', type: 'cowork' },
      ],
    });
    mockListPipelinesStrict.mockResolvedValue({
      pipelines: [summary('deploy')],
      truncated: false,
    });
    mockReadWorkspaceConfigDetailed.mockResolvedValue({
      authority: 'ok',
      ownerMalformed: false,
      config: { version: 1, type: 'single-repo', repos: [] },
    });
  });

  it('emits one document per worktree of every code project, from targets derived once', async () => {
    const read = await listWorktreePipelineInventoryDocuments();
    expect(read.complete).toBe(true);
    expect(read.nonPersonalWorkspaceIds).toEqual([]);
    expect(read.documents.map((document) => document.scopeKey)).toEqual([
      'ws-1:wt-a',
      'ws-1:wt-b',
    ]);
    expect(read.documents[0]?.payload).toEqual({
      pipelines: [summary('deploy')],
    });
    expect(mockListPipelinesStrict).toHaveBeenCalledWith({
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-a',
      cwd: '/checkouts/ws-1/wt-a',
    });
    expect(mockReadAllSidebarItems).toHaveBeenCalledTimes(1);
  });

  it('carries shared cloud rows through to the document unchanged (CAN-3021)', async () => {
    // The document is the plan picker's data source, so a shared row has to
    // survive the projection verbatim — including the empty `source` (a shared
    // pipeline has no filename) and the absence of trigger inputs, which the
    // picker hydrates on select.
    const shared = {
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-a',
      pipelineId: 'shared:canopy-cloud:remote-1',
      name: 'Ship it',
      description: 'Team release pipeline',
      source: '',
      origin: 'shared',
      triggerTypes: ['plan_ready'],
      scopes: ['directory'],
    };
    mockListPipelinesStrict.mockResolvedValue({
      pipelines: [summary('deploy'), shared],
      truncated: false,
    });

    const read = await listWorktreePipelineInventoryDocuments();

    expect(read.complete).toBe(true);
    expect(read.documents[0]?.payload).toEqual({
      pipelines: [summary('deploy'), shared],
    });
  });

  it('carries a discovery bound as the payload truncation marker', async () => {
    mockListPipelinesStrict.mockResolvedValue({
      pipelines: [summary('deploy')],
      truncated: true,
    });
    const read = await listWorktreePipelineInventoryDocuments();
    expect(read.documents[0]?.payload).toEqual({
      pipelines: [summary('deploy')],
      truncated: true,
    });
  });

  it('reports an incomplete read when a worktree fails, keeping the others', async () => {
    mockListPipelinesStrict
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValueOnce({ pipelines: [], truncated: false });
    const read = await listWorktreePipelineInventoryDocuments();
    expect(read.complete).toBe(false);
    expect(read.documents.map((document) => document.scopeKey)).toEqual([
      'ws-1:wt-b',
    ]);
    expect(mockLogMainProcessError).toHaveBeenCalledTimes(1);
  });

  it('reports an incomplete read when a project failed to load', async () => {
    mockReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [],
      warnings: [{ workspaceId: 'ws-1', message: 'invalid manifest' }],
    });
    const read = await listWorktreePipelineInventoryDocuments();
    expect(read).toEqual({
      documents: [],
      complete: false,
      nonPersonalWorkspaceIds: [],
    });
  });

  it.each([
    [
      'organization-owned',
      false,
      { type: 'organization', organizationId: 'org-a' },
    ],
    ['malformed-owner', true, undefined],
  ])(
    'omits an %s workspace and marks it for removal',
    async (_label, ownerMalformed, owner) => {
      mockReadWorkspaceConfigDetailed.mockResolvedValue({
        authority: 'ok',
        ownerMalformed,
        config: {
          version: 1,
          type: 'single-repo',
          repos: [],
          ...(owner ? { owner } : {}),
        },
      });

      await expect(listWorktreePipelineInventoryDocuments()).resolves.toEqual({
        documents: [],
        complete: true,
        nonPersonalWorkspaceIds: ['ws-1'],
      });
      expect(mockListPipelinesStrict).not.toHaveBeenCalled();
    },
  );

  it('omits an unreadable workspace without authorizing removals', async () => {
    mockReadWorkspaceConfigDetailed.mockResolvedValue({
      authority: 'unreadable',
      ownerMalformed: false,
      config: { version: 1, type: 'single-repo', repos: [] },
    });

    await expect(listWorktreePipelineInventoryDocuments()).resolves.toEqual({
      documents: [],
      complete: false,
      nonPersonalWorkspaceIds: [],
    });
  });

  it('never treats an unreadable or partly malformed index or manifest as complete', async () => {
    // The sidebar reads a corrupt index or manifest as whatever it could
    // recover; taken as authoritative that would remove synced pipeline
    // documents for workspaces and worktrees that still exist.
    mockReadAllSidebarItems.mockResolvedValue({ version: 1, items: [] });
    for (const authority of ['unreadable', 'partial']) {
      snapshotAuthority = authority;
      await expect(listWorktreePipelineInventoryDocuments()).resolves.toEqual({
        documents: [],
        complete: false,
        nonPersonalWorkspaceIds: [],
      });
    }
    // A fresh install with no index yet genuinely has nothing.
    snapshotAuthority = 'absent';
    await expect(listWorktreePipelineInventoryDocuments()).resolves.toEqual({
      documents: [],
      complete: true,
      nonPersonalWorkspaceIds: [],
    });
  });
});
