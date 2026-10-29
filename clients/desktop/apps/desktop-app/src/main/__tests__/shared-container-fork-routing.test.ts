jest.mock('../shared-containers/read/reader', () => ({
  getSharedContainerReader: jest.fn(),
}));

jest.mock('../shared-containers/fork/fork-guard', () => ({
  withSharedContainerForkGuard: jest.fn(
    (_request: unknown, operation: (revisionRoot: string) => unknown) =>
      operation('/replicas/container/revisions/revision'),
  ),
}));

jest.mock('../shared-containers/fork/code', () => ({
  forkSharedCodeContainer: jest.fn(),
}));

jest.mock('../shared-containers/fork/cowork', () => ({
  forkSharedCoworkContainer: jest.fn(() =>
    Promise.resolve({ workspaceId: 'workspace', worktreeId: 'entry' }),
  ),
}));

import { getSharedContainerReader } from '../shared-containers/read/reader';
import { forkSharedCoworkContainer } from '../shared-containers/fork/cowork';
import { forkSharedContainer } from '../shared-containers/fork';

describe('shared-container fork routing', () => {
  it('routes a schema-v3 Cowork revision through the Cowork copy path', async () => {
    const layout = {
      schemaVersion: 3 as const,
      containerType: 'COWORK_WORK_ENTRY' as const,
      title: 'Published Cowork work',
      repositories: [],
      files: [],
      notes: [],
      prompts: [],
      attachmentPaths: {},
      layout: {
        orientation: 0 as const,
        root: {
          type: 'leaf' as const,
          size: 1,
          tabs: [{ kind: 'chat' as const, chatId: 'published-chat' }],
          activeTabIndex: 0,
        },
      },
    };
    jest.mocked(getSharedContainerReader).mockReturnValue({
      store: {},
      readForkLayout: jest.fn(() =>
        Promise.resolve({
          root: '/replicas/container/revisions/revision',
          layout,
        }),
      ),
    } as never);

    await expect(
      forkSharedContainer({
        containerId: 'container',
        revisionId: 'revision',
        organizationId: 'organization',
        sourceOwnerDisplayName: 'Ada',
        destination: { kind: 'new-workspace' },
      }),
    ).resolves.toEqual({ workspaceId: 'workspace', worktreeId: 'entry' });

    expect(forkSharedCoworkContainer).toHaveBeenCalledWith(
      expect.objectContaining({ layout }),
    );
  });
});
