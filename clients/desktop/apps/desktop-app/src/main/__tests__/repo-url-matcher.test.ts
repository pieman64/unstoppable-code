import { normalizeRemoteUrl, remoteUrlsMatch } from '../lib/repo-url-matcher';

describe('repo-url-matcher', () => {
  it('normalizes https remotes with userinfo by stripping the username', () => {
    expect(
      normalizeRemoteUrl('https://octocat@github.com/Owner/Repo.git'),
    ).toBe('github.com/owner/repo');
  });

  it('matches https remotes even when only one side includes userinfo', () => {
    expect(
      remoteUrlsMatch(
        'https://octocat@github.com/Owner/Repo.git',
        'https://github.com/owner/repo',
      ),
    ).toBe(true);
  });
});
