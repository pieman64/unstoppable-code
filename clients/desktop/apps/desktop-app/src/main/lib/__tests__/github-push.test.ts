jest.mock('../git', () => ({
  getPushRemoteUrlStrict: jest.fn(),
  pushBranch: jest.fn(),
}));

import { getPushRemoteUrlStrict, pushBranch } from '../git';
import {
  pushBranchWithAuthFailure,
  withGitHubPushAuthFailure,
} from '../github-push';
import { GitHubAuthFailureError } from '../github-push-auth-failure';

beforeEach(() => {
  jest.resetAllMocks();
  jest
    .mocked(getPushRemoteUrlStrict)
    .mockResolvedValue('https://github.com/acme/repo.git');
  jest.mocked(pushBranch).mockResolvedValue();
});

it('classifies the configured push destination before pushing', async () => {
  const error = new Error('Authentication failed');
  jest.mocked(pushBranch).mockRejectedValue(error);
  await expect(pushBranchWithAuthFailure('/repo')).rejects.toMatchObject({
    message: error.message,
    cause: error,
  });
  expect(getPushRemoteUrlStrict).toHaveBeenCalledWith('/repo');
  expect(
    jest.mocked(getPushRemoteUrlStrict).mock.invocationCallOrder[0],
  ).toBeLessThan(jest.mocked(pushBranch).mock.invocationCallOrder[0]);
});

it.each(['git@github.com:acme/repo.git', 'https://gitlab.com/acme/repo.git'])(
  'keeps an unsupported push destination ordinary: %s',
  async (url) => {
    jest.mocked(getPushRemoteUrlStrict).mockResolvedValue(url);
    const error = new Error('Authentication failed');
    jest.mocked(pushBranch).mockRejectedValue(error);
    await expect(pushBranchWithAuthFailure('/repo')).rejects.toBe(error);
  },
);

it('still pushes when remote metadata is unavailable', async () => {
  jest
    .mocked(getPushRemoteUrlStrict)
    .mockRejectedValue(new Error('lookup unavailable'));
  await expect(pushBranchWithAuthFailure('/repo')).resolves.toBeUndefined();
  expect(pushBranch).toHaveBeenCalledTimes(1);
});

it('does not guess missing authentication when the remote lookup fails', async () => {
  jest
    .mocked(getPushRemoteUrlStrict)
    .mockRejectedValue(new Error('lookup unavailable'));
  const error = new Error('Authentication failed');
  jest.mocked(pushBranch).mockRejectedValue(error);
  await expect(pushBranchWithAuthFailure('/repo')).rejects.toBe(error);
});

it('classifies force-push callbacks through the same boundary', async () => {
  await expect(
    withGitHubPushAuthFailure('/repo', () =>
      Promise.reject(new Error('Invalid username/password')),
    ),
  ).rejects.toBeInstanceOf(GitHubAuthFailureError);
  expect(pushBranch).not.toHaveBeenCalled();
});
