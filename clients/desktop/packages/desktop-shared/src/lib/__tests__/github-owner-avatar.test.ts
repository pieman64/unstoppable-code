import {
  getGitHubOwnerAvatarUrl,
  getGitHubRemoteOwner,
} from '../github-owner-avatar';

describe('GitHub owner avatar parsing', () => {
  it.each([
    ['git@github.com:acme/repo.git', 'acme'],
    ['https://github.com/acme/repo.git', 'acme'],
    ['ssh://git@github.com/acme/repo.git', 'acme'],
    ['git://github.com/acme/repo.git', 'acme'],
  ])('extracts the GitHub owner from %s', (remoteUrl, owner) => {
    expect(getGitHubRemoteOwner(remoteUrl)).toBe(owner);
  });

  it('rejects non-GitHub and malformed remotes', () => {
    expect(getGitHubRemoteOwner('https://gitlab.com/acme/repo.git')).toBeNull();
    expect(getGitHubRemoteOwner('https://github.com/acme')).toBeNull();
    expect(getGitHubOwnerAvatarUrl('https://gitlab.com/acme/repo.git')).toBe(
      null,
    );
  });

  it('requests a 2x GitHub owner avatar for the 16px badge', () => {
    expect(getGitHubOwnerAvatarUrl('git@github.com:acme/repo.git')).toBe(
      'https://github.com/acme.png?size=32',
    );
  });
});
