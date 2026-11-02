jest.mock('../lib/github-client', () => ({
  getGitHubClient: jest.fn(),
}));

import { getGitHubClient } from '../lib/github-client';
import {
  invalidateGitHubRepoListCache,
  listUserRepoSnapshot,
  listUserRepos,
} from '../lib/github-repo-listing';

const mockedGetClient = jest.mocked(getGitHubClient);

interface FakeRepo {
  full_name: string;
  owner: { login: string };
  name: string;
  description: string | null;
  clone_url: string;
  ssh_url: string;
  html_url: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  default_branch: string;
  updated_at: string | null;
  permissions?: { admin: boolean; push: boolean; pull: boolean };
}

interface FakeRepoListParams {
  affiliation: string;
  sort: string;
  per_page: number;
  page: number;
  request: {
    timeout: number;
  };
}

interface FakeOctokit {
  repos: {
    listForAuthenticatedUser: jest.Mock<
      Promise<{ data: FakeRepo[] }>,
      [FakeRepoListParams]
    >;
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function makeRepo(index: number): FakeRepo {
  return {
    full_name: `owner/repo-${index}`,
    owner: { login: 'owner' },
    name: `repo-${index}`,
    description: `repo ${index}`,
    clone_url: `https://github.com/owner/repo-${index}.git`,
    ssh_url: `git@github.com:owner/repo-${index}.git`,
    html_url: `https://github.com/owner/repo-${index}`,
    private: false,
    fork: false,
    archived: false,
    default_branch: 'main',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function createDeferred<T>(): Deferred<T> {
  let resolveDeferred: ((value: T) => void) | undefined;
  let rejectDeferred: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });

  if (!resolveDeferred || !rejectDeferred) {
    throw new Error('Expected deferred handlers to be assigned');
  }

  return {
    promise,
    resolve: resolveDeferred,
    reject: rejectDeferred,
  };
}

function isRepoListCallback(
  value: unknown,
): value is (octokit: FakeOctokit) => Promise<unknown> {
  return typeof value === 'function';
}

function mockPagedResponses(pages: FakeRepo[][]): {
  enqueue: jest.Mock;
  listForAuthenticatedUser: FakeOctokit['repos']['listForAuthenticatedUser'];
} {
  const listForAuthenticatedUser: FakeOctokit['repos']['listForAuthenticatedUser'] =
    jest.fn<Promise<{ data: FakeRepo[] }>, [FakeRepoListParams]>();
  for (const data of pages) {
    listForAuthenticatedUser.mockResolvedValueOnce({ data });
  }
  const octokit: FakeOctokit = {
    repos: { listForAuthenticatedUser },
  };
  const enqueue = jest.fn();
  enqueue.mockImplementation((fn: unknown): Promise<unknown> => {
    if (!isRepoListCallback(fn)) {
      throw new Error('Expected repo-list callback');
    }
    return fn(octokit);
  });
  mockedGetClient.mockReturnValue({ enqueue });
  return { enqueue, listForAuthenticatedUser };
}

describe('listUserRepos', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    invalidateGitHubRepoListCache();
  });

  it('maps repo fields to GitHubRepoSummary', async () => {
    mockPagedResponses([[makeRepo(1)]]);

    const results = await listUserRepos();
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      fullName: 'owner/repo-1',
      ownerLogin: 'owner',
      name: 'repo-1',
      description: 'repo 1',
      cloneUrl: 'https://github.com/owner/repo-1.git',
      sshUrl: 'git@github.com:owner/repo-1.git',
      htmlUrl: 'https://github.com/owner/repo-1',
      isPrivate: false,
      isFork: false,
      isArchived: false,
      defaultBranch: 'main',
      updatedAt: '2026-01-01T00:00:00Z',
    });
  });

  it('stops paginating when a short page is returned', async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => makeRepo(i));
    const secondPage = Array.from({ length: 5 }, (_, i) => makeRepo(100 + i));
    const { enqueue, listForAuthenticatedUser } = mockPagedResponses([
      firstPage,
      secondPage,
    ]);

    const results = await listUserRepos();
    expect(results).toHaveLength(105);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith(expect.any(Function), 'high', {
      operation: 'read',
      idempotency: 'safe',
      timeoutMs: 15_000,
    });
    expect(listForAuthenticatedUser).toHaveBeenCalledTimes(2);
  });

  it('caps results at 300 repos', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeRepo(i));
    const page2 = Array.from({ length: 100 }, (_, i) => makeRepo(100 + i));
    const page3 = Array.from({ length: 100 }, (_, i) => makeRepo(200 + i));
    const page4 = Array.from({ length: 100 }, (_, i) => makeRepo(300 + i));
    const { enqueue, listForAuthenticatedUser } = mockPagedResponses([
      page1,
      page2,
      page3,
      page4,
    ]);

    const results = await listUserRepos();
    expect(results).toHaveLength(300);
    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(listForAuthenticatedUser).toHaveBeenCalledTimes(3);
  });

  it('returns empty array when first page is empty', async () => {
    const { enqueue, listForAuthenticatedUser } = mockPagedResponses([[]]);

    const results = await listUserRepos();
    expect(results).toEqual([]);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(listForAuthenticatedUser).toHaveBeenCalledTimes(1);
  });

  it('passes bounded request options to GitHub', async () => {
    const { listForAuthenticatedUser } = mockPagedResponses([[makeRepo(1)]]);

    await listUserRepos();

    expect(listForAuthenticatedUser).toHaveBeenCalledWith({
      affiliation: 'owner,collaborator,organization_member',
      sort: 'updated',
      per_page: 100,
      page: 1,
      request: {
        timeout: 15_000,
      },
    });
  });

  it('returns cached repos for repeated lookups', async () => {
    const { enqueue } = mockPagedResponses([[makeRepo(1)]]);

    const first = await listUserRepos();
    const second = await listUserRepos();

    expect(first).toBe(second);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('shares an in-flight lookup between callers', async () => {
    const { enqueue } = mockPagedResponses([[makeRepo(1)]]);

    const first = listUserRepos();
    const second = listUserRepos();
    const results = await Promise.all([first, second]);

    expect(results[0]).toEqual(results[1]);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('does not cache a lookup that resolves after invalidation', async () => {
    const firstPage = createDeferred<{ data: FakeRepo[] }>();
    const listForAuthenticatedUser: FakeOctokit['repos']['listForAuthenticatedUser'] =
      jest.fn<Promise<{ data: FakeRepo[] }>, [FakeRepoListParams]>();
    listForAuthenticatedUser
      .mockReturnValueOnce(firstPage.promise)
      .mockResolvedValueOnce({ data: [makeRepo(2)] });
    const octokit: FakeOctokit = {
      repos: { listForAuthenticatedUser },
    };
    const enqueue = jest.fn();
    enqueue.mockImplementation((fn: unknown): Promise<unknown> => {
      if (!isRepoListCallback(fn)) {
        throw new Error('Expected repo-list callback');
      }
      return fn(octokit);
    });
    mockedGetClient.mockReturnValue({ enqueue });

    const first = listUserRepos();
    invalidateGitHubRepoListCache();
    firstPage.resolve({ data: [makeRepo(1)] });

    await expect(first).resolves.toHaveLength(1);
    const second = await listUserRepos();

    expect(second[0]?.fullName).toBe('owner/repo-2');
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
});

// CAN-4109: the snapshot core.integration.resource.list pages.
describe('listUserRepoSnapshot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    invalidateGitHubRepoListCache();
  });

  it('reads the legacy rows and their access in one order, as one snapshot', async () => {
    mockPagedResponses([
      [
        {
          ...makeRepo(0),
          permissions: { admin: true, push: true, pull: true },
        },
        { ...makeRepo(1), updated_at: null },
      ],
    ]);

    const snapshot = await listUserRepoSnapshot();

    expect(snapshot.repos.map((repo) => repo.fullName)).toEqual([
      'owner/repo-0',
      'owner/repo-1',
    ]);
    expect(snapshot.repos[1].updatedAt).toBeNull();
    expect(snapshot.access).toEqual([
      {
        fullName: 'owner/repo-0',
        htmlUrl: 'https://github.com/owner/repo-0',
        permissions: { pull: true, push: true, admin: true },
        updatedAt: '2026-01-01T00:00:00Z',
      },
      {
        fullName: 'owner/repo-1',
        htmlUrl: 'https://github.com/owner/repo-1',
        permissions: { pull: false, push: false, admin: false },
        updatedAt: null,
      },
    ]);
    await expect(listUserRepos()).resolves.toBe(snapshot.repos);
  });

  it('keeps one snapshot id until the listing is re-read', async () => {
    mockPagedResponses([[makeRepo(0)], [makeRepo(0)]]);

    const first = await listUserRepoSnapshot();
    await expect(listUserRepoSnapshot()).resolves.toBe(first);
    invalidateGitHubRepoListCache();
    const second = await listUserRepoSnapshot();

    expect(second.id).not.toBe(first.id);
  });
});
