import { handleSearchPullRequestsRequest } from '../ipc/github-pr-search';
import { searchOpenPullRequestsForRepo } from '../lib/github-pr-listing';

jest.mock('../lib/github-pr-listing', () => ({
  searchOpenPullRequestsForRepo: jest.fn(),
}));
const search = jest.mocked(searchOpenPullRequestsForRepo);

describe('PR search IPC validation', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    undefined,
    null,
    [],
    'title',
    {},
    { repoPath: 42, query: 'title' },
    { repoPath: 'relative', query: 'title' },
    { repoPath: '/repo', query: null },
    { repoPath: '/repo', query: '' },
    { repoPath: '/repo', query: '" \\"' },
    { repoPath: '/repo', query: 'x'.repeat(101) },
  ])('rejects malformed requests %p before dispatch', async (request) => {
    await expect(handleSearchPullRequestsRequest(request)).rejects.toThrow();
    expect(search).not.toHaveBeenCalled();
  });

  it('returns the typed response envelope', async () => {
    search.mockResolvedValue([]);
    await expect(
      handleSearchPullRequestsRequest({ repoPath: '/repo', query: 'title' }),
    ).resolves.toEqual({ pullRequests: [] });
    expect(search).toHaveBeenCalledWith('/repo', 'title');
  });

  it('preserves service errors for the picker error state', async () => {
    search.mockRejectedValue(new Error('authentication required'));
    await expect(
      handleSearchPullRequestsRequest({ repoPath: '/repo', query: 'title' }),
    ).rejects.toThrow('authentication required');
  });
});
