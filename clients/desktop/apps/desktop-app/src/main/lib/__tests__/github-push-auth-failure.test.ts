import {
  classifyGitHubAuthFailure,
  GitHubAuthFailureError,
  githubAuthFailureCode,
} from '../github-push-auth-failure';
import { GitHubBrokerError } from '../github-broker/errors';

describe('GitHub authentication classifier', () => {
  it.each([
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "fatal: could not read Password for 'https://github.com': No such device or address",
    "fatal: Authentication failed for 'https://github.com/acme/repo.git/'",
    'remote: Invalid username or password.',
    'remote: Invalid username/password.',
    'remote: Invalid username or token. Password authentication is not supported for Git operations.',
  ])('classifies explicit credentials: %s', (message) => {
    expect(
      classifyGitHubAuthFailure(
        'https://github.com/acme/repo.git',
        new Error(message),
      ),
    ).toBe('github_not_authenticated');
  });

  it.each([
    null,
    '/tmp/local.git',
    'git@github.com:acme/repo.git',
    'ssh://git@github.com/acme/repo.git',
    'http://github.com/acme/repo.git',
    'https://github.com.evil.test/a/b',
    'https://github.enterprise.test/a/b',
    'https://gitlab.com/a/b',
  ])('rejects unsupported remote %s', (remote) => {
    expect(
      classifyGitHubAuthFailure(remote, new Error('Authentication failed')),
    ).toBeUndefined();
  });

  // A GitHub source's manifest can list a repository on another host.
  it.each([
    "fatal: Authentication failed for 'https://gitlab.com/acme/child.git/'",
    "fatal: could not read Username for 'https://gitlab.com': terminal prompts disabled",
  ])(
    'rejects a credential failure that names another remote: %s',
    (message) => {
      expect(
        classifyGitHubAuthFailure(
          'https://github.com/acme/repo.git',
          new Error(message),
        ),
      ).toBeUndefined();
    },
  );

  it('classifies a credential failure that names the GitHub remote', () => {
    expect(
      classifyGitHubAuthFailure(
        'https://github.com/acme/repo.git',
        new Error(
          "fatal: Authentication failed for 'https://github.com/acme/repo.git/'",
        ),
      ),
    ).toBe('github_not_authenticated');
  });

  it.each([
    'The requested URL returned error: 403',
    'Permission to acme/repo denied to user',
    'protected branch hook declined',
    'Repository not found',
    'Could not resolve host: github.com',
    'non-fast-forward',
  ])('preserves ordinary errors: %s', (message) => {
    expect(
      classifyGitHubAuthFailure('https://github.com/a/b', new Error(message)),
    ).toBeUndefined();
  });

  it('uses stderr when the process message is generic', () => {
    expect(
      classifyGitHubAuthFailure(
        'https://github.com/a/b',
        Object.assign(new Error('Command failed'), {
          stderr: 'fatal: Authentication failed',
        }),
      ),
    ).toBe('github_not_authenticated');
  });

  it('maps only typed broker not_authenticated errors', () => {
    expect(
      githubAuthFailureCode(
        new GitHubBrokerError('not_authenticated', 'Sign in'),
      ),
    ).toBe('github_not_authenticated');
    expect(
      githubAuthFailureCode(
        new GitHubBrokerError('permission_denied', 'Sign in'),
      ),
    ).toBeUndefined();
    expect(
      githubAuthFailureCode({ code: 'not_authenticated' }),
    ).toBeUndefined();
  });

  it('names the error so the renderer recognises it across IPC', () => {
    const error = new GitHubAuthFailureError(new Error('x'));
    expect(error.name).toBe('GitHubAuthFailureError');
    expect(String(error)).toMatch(/^GitHubAuthFailureError: x/);
    expect(githubAuthFailureCode(error)).toBe('github_not_authenticated');

    const fromString = new GitHubAuthFailureError('plain failure');
    expect(fromString).toBeInstanceOf(Error);
    expect(fromString.name).toBe('GitHubAuthFailureError');
    expect(fromString.message).toBe('plain failure');
    expect(fromString.cause).toBeInstanceOf(Error);
  });
});
