jest.mock('../lib/git', () => ({
  getRemoteUrl: jest.fn(() =>
    Promise.resolve('https://github.com/acme/example-repo.git'),
  ),
  getCurrentBranch: jest.fn(),
}));

jest.mock('../lib/github-client', () => ({
  getGitHubClient: jest.fn(),
}));

jest.mock('../lib/github-pr-read-model', () => ({
  invalidateGitHubPullRequest: jest.fn(),
}));

import { getGitHubClient } from '../lib/github-client';
import {
  closePrForRepo,
  mergePrForRepo,
  updatePrBaseBranchForRepo,
  updatePrBodyForRepo,
} from '../lib/github-pr';
import { invalidateGitHubPullRequest } from '../lib/github-pr-read-model';

const mockedGetGitHubClient = jest.mocked(getGitHubClient);
const mockedInvalidate = jest.mocked(invalidateGitHubPullRequest);
const PR = { owner: 'acme', repo: 'example-repo', number: 42 };

function clientAnswering(octokit: Record<string, unknown>): jest.Mock {
  const enqueue = jest.fn((callback: (client: unknown) => unknown) =>
    callback(octokit),
  );
  mockedGetGitHubClient.mockReturnValue({ enqueue });
  return enqueue;
}

describe('pull request mutations invalidate the shared read model', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('after a base branch update', async () => {
    clientAnswering({
      pulls: {
        update: jest.fn(() =>
          Promise.resolve({
            data: { html_url: 'https://github.com/acme/example-repo/pull/42' },
          }),
        ),
      },
    });
    await updatePrBaseBranchForRepo('/tmp/repo', 42, 'main');
    expect(mockedInvalidate).toHaveBeenCalledWith(PR);
  });

  it('after a close', async () => {
    clientAnswering({
      pulls: { update: jest.fn(() => Promise.resolve({ data: {} })) },
    });
    await closePrForRepo('/tmp/repo', 42);
    expect(mockedInvalidate).toHaveBeenCalledWith(PR);
  });

  it('after a body update', async () => {
    clientAnswering({
      pulls: { update: jest.fn(() => Promise.resolve({ data: {} })) },
    });
    await updatePrBodyForRepo('/tmp/repo', 42, 'body');
    expect(mockedInvalidate).toHaveBeenCalledWith(PR);
  });

  it('not when the mutation failed', async () => {
    clientAnswering({
      pulls: { update: jest.fn(() => Promise.reject(new Error('down'))) },
    });
    await expect(closePrForRepo('/tmp/repo', 42)).rejects.toThrow('down');
    expect(mockedInvalidate).not.toHaveBeenCalled();
  });

  it('after a verified merge', async () => {
    clientAnswering({
      repos: {
        get: jest.fn(() =>
          Promise.resolve({
            data: {
              allow_merge_commit: true,
              allow_squash_merge: false,
              allow_rebase_merge: false,
            },
          }),
        ),
      },
      graphql: jest.fn(() =>
        Promise.resolve({
          repository: {
            pullRequest: {
              id: 'PR_node',
              isMergeQueueEnabled: false,
              isInMergeQueue: false,
              mergeQueueEntry: null,
            },
          },
        }),
      ),
      pulls: {
        merge: jest.fn(() =>
          Promise.resolve({ data: { merged: true, sha: 'merge-sha' } }),
        ),
        get: jest.fn(() => Promise.resolve({ data: { merged: true } })),
      },
    });
    await expect(
      mergePrForRepo('/tmp/repo', 42, 'head-sha'),
    ).resolves.toMatchObject({ outcome: 'merged' });
    expect(mockedInvalidate).toHaveBeenCalledWith(PR);
  });

  it('after a merge attempt that failed partway', async () => {
    clientAnswering({
      repos: { get: jest.fn(() => Promise.reject(new Error('down'))) },
    });
    await expect(mergePrForRepo('/tmp/repo', 42, 'head-sha')).rejects.toThrow(
      'down',
    );
    expect(mockedInvalidate).toHaveBeenCalledWith(PR);
  });
});
