import {
  getRepoSlugForRepoPath,
  __resetRepoSlugCacheForTests,
} from '../lib/github-pr-listing';
import { getRemoteUrl } from '../lib/git';

jest.mock('../lib/git', () => ({
  getRemoteUrl: jest.fn(),
}));

jest.mock('../lib/github-client', () => ({
  getGitHubClient: jest.fn(),
}));

const mockGetRemoteUrl = jest.mocked(getRemoteUrl);

describe('getRepoSlugForRepoPath', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetRepoSlugCacheForTests();
  });

  it('maps an ssh origin remote to an owner/repo slug', async () => {
    mockGetRemoteUrl.mockResolvedValue('git@github.com:acme/app.git');

    await expect(getRepoSlugForRepoPath('/repo')).resolves.toEqual({
      owner: 'acme',
      repo: 'app',
    });
  });

  it('maps an https origin remote to an owner/repo slug', async () => {
    mockGetRemoteUrl.mockResolvedValue('https://github.com/acme/app.git');

    await expect(getRepoSlugForRepoPath('/repo')).resolves.toEqual({
      owner: 'acme',
      repo: 'app',
    });
  });

  it('returns null when the repo has no origin remote', async () => {
    mockGetRemoteUrl.mockResolvedValue(null);

    await expect(getRepoSlugForRepoPath('/repo')).resolves.toBeNull();
  });

  it('returns null when the origin remote is not a GitHub remote', async () => {
    mockGetRemoteUrl.mockResolvedValue('git@gitlab.com:acme/app.git');

    await expect(getRepoSlugForRepoPath('/repo')).resolves.toBeNull();
  });

  it('caches the slug per repo path within the TTL window', async () => {
    mockGetRemoteUrl.mockResolvedValue('git@github.com:acme/app.git');

    const first = await getRepoSlugForRepoPath('/repo');
    const second = await getRepoSlugForRepoPath('/repo');

    expect(first).toEqual(second);
    expect(mockGetRemoteUrl).toHaveBeenCalledTimes(1);
  });

  it('fetches again after the cache is reset for tests', async () => {
    mockGetRemoteUrl.mockResolvedValue('git@github.com:acme/app.git');

    await getRepoSlugForRepoPath('/repo');
    __resetRepoSlugCacheForTests();
    await getRepoSlugForRepoPath('/repo');

    expect(mockGetRemoteUrl).toHaveBeenCalledTimes(2);
  });
});
