import { resolveCoworkSharedContainerTitles } from '../shared-containers/publish/cowork';

const listWorkEntriesMock = jest.fn<
  Promise<Array<{ id: string; title: string }>>,
  [string]
>();
jest.mock('../lib/cowork-work-entries', () => ({
  listWorkEntries: (
    projectId: string,
  ): Promise<Array<{ id: string; title: string }>> =>
    listWorkEntriesMock(projectId),
}));

describe('Cowork shared-container titles', () => {
  beforeEach(() => jest.clearAllMocks());

  it('publishes the sidebar Work Entry name as the pre-accept list title', async () => {
    listWorkEntriesMock.mockResolvedValue([
      { id: 'entry-0', title: 'Some other entry' },
      { id: 'entry-1', title: 'Customer follow-up' },
    ]);

    await expect(
      resolveCoworkSharedContainerTitles({
        projectId: 'cowork-1',
        worktreeId: 'entry-1',
      }),
    ).resolves.toEqual({
      // A recipient decides whether to accept from the list title alone, so it
      // has to name the actual work rather than its container type.
      publishedTitle: 'Customer follow-up',
      listTitle: 'Customer follow-up',
    });
    expect(listWorkEntriesMock).toHaveBeenCalledWith('cowork-1');
  });

  it('falls back to the container noun when the entry is gone', async () => {
    listWorkEntriesMock.mockResolvedValue([]);

    await expect(
      resolveCoworkSharedContainerTitles({
        projectId: 'cowork-1',
        worktreeId: 'entry-1',
      }),
    ).resolves.toEqual({
      publishedTitle: 'Work Entry',
      listTitle: 'Work Entry',
    });
  });
});
