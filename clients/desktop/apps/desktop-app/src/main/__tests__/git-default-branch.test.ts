jest.mock('../lib/git', () => ({
  getGitCommonDir: jest.fn(),
  getLocalRemoteHeadBranch: jest.fn(),
  getRemoteDefaultBranch: jest.fn(),
  getRemoteHeadBranch: jest.fn(),
  getRemoteUrl: jest.fn(),
  setLocalRemoteHeadBranch: jest.fn(),
}));
jest.mock('../lib/git-default-branch-freshness', () => ({
  readGitDefaultBranchFreshness: jest.fn(),
  recordGitDefaultBranch: jest.fn(),
}));

import {
  getGitCommonDir,
  getLocalRemoteHeadBranch,
  getRemoteDefaultBranch,
  getRemoteHeadBranch,
  getRemoteUrl,
  setLocalRemoteHeadBranch,
} from '../lib/git';
import {
  readGitDefaultBranchFreshness,
  recordGitDefaultBranch,
} from '../lib/git-default-branch-freshness';
import {
  DEFAULT_BRANCH_FRESHNESS_TTL_MS,
  resolveFreshDefaultBranch,
} from '../lib/git-default-branch';

const mockedGetGitCommonDir = jest.mocked(getGitCommonDir);
const mockedGetLocalRemoteHeadBranch = jest.mocked(getLocalRemoteHeadBranch);
const mockedGetRemoteDefaultBranch = jest.mocked(getRemoteDefaultBranch);
const mockedGetRemoteHeadBranch = jest.mocked(getRemoteHeadBranch);
const mockedGetRemoteUrl = jest.mocked(getRemoteUrl);
const mockedSetLocalRemoteHeadBranch = jest.mocked(setLocalRemoteHeadBranch);
const mockedReadFreshness = jest.mocked(readGitDefaultBranchFreshness);
const mockedRecordDefaultBranch = jest.mocked(recordGitDefaultBranch);

describe('resolveFreshDefaultBranch', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedGetGitCommonDir.mockResolvedValue('/repo/.git');
    mockedGetRemoteUrl.mockResolvedValue('https://example.test/repo.git');
    mockedGetLocalRemoteHeadBranch.mockResolvedValue(null);
    mockedReadFreshness.mockResolvedValue(null);
    mockedRecordDefaultBranch.mockResolvedValue(undefined);
    mockedGetRemoteDefaultBranch.mockResolvedValue(null);
    mockedSetLocalRemoteHeadBranch.mockResolvedValue(undefined);
  });

  it('reuses recent identity-matched knowledge without querying remote HEAD', async () => {
    mockedReadFreshness.mockResolvedValue({
      commonDir: '/repo/.git',
      originUrl: 'https://example.test/repo.git',
      defaultBranch: 'trunk',
      resolvedAt: new Date(Date.now() - 1_000).toISOString(),
    });

    await expect(resolveFreshDefaultBranch('/repo')).resolves.toBe('trunk');

    expect(mockedGetRemoteHeadBranch).not.toHaveBeenCalled();
  });

  it('prefers durable remote-verified knowledge over local origin HEAD for local-only reads', async () => {
    mockedGetLocalRemoteHeadBranch.mockResolvedValue('main');
    mockedReadFreshness.mockResolvedValue({
      commonDir: '/repo/.git',
      originUrl: 'https://example.test/repo.git',
      defaultBranch: 'develop',
      resolvedAt: new Date(0).toISOString(),
    });

    await expect(
      resolveFreshDefaultBranch('/repo', { allowRemoteLookup: false }),
    ).resolves.toBe('develop');

    expect(mockedReadFreshness).toHaveBeenCalledWith({
      commonDir: '/repo/.git',
      originUrl: 'https://example.test/repo.git',
    });
    expect(mockedRecordDefaultBranch).not.toHaveBeenCalled();
    expect(mockedGetRemoteHeadBranch).not.toHaveBeenCalled();
  });

  it('revalidates remote HEAD instead of trusting a stale local origin HEAD', async () => {
    mockedGetLocalRemoteHeadBranch.mockResolvedValue('main');
    mockedGetRemoteHeadBranch.mockResolvedValue('develop');

    await expect(resolveFreshDefaultBranch('/repo')).resolves.toBe('develop');

    expect(mockedGetRemoteHeadBranch).toHaveBeenCalledWith('/repo');
    expect(mockedRecordDefaultBranch).toHaveBeenCalledWith(
      expect.objectContaining({ defaultBranch: 'develop' }),
    );
    expect(mockedSetLocalRemoteHeadBranch).toHaveBeenCalledWith(
      '/repo',
      'develop',
    );
  });

  it('does not rewrite local origin HEAD when it matches remote HEAD', async () => {
    mockedGetLocalRemoteHeadBranch.mockResolvedValue('develop');
    mockedGetRemoteHeadBranch.mockResolvedValue('develop');

    await expect(resolveFreshDefaultBranch('/repo')).resolves.toBe('develop');

    expect(mockedSetLocalRemoteHeadBranch).not.toHaveBeenCalled();
  });

  it('swallows failures while repairing a stale local origin HEAD', async () => {
    mockedGetLocalRemoteHeadBranch.mockResolvedValue('main');
    mockedGetRemoteHeadBranch.mockResolvedValue('develop');
    mockedSetLocalRemoteHeadBranch.mockRejectedValue(
      new Error('read-only repository'),
    );

    await expect(resolveFreshDefaultBranch('/repo')).resolves.toBe('develop');
  });

  it('falls back to local origin HEAD when remote revalidation fails', async () => {
    mockedGetLocalRemoteHeadBranch.mockResolvedValue('main');
    mockedGetRemoteHeadBranch.mockRejectedValue(new Error('offline'));

    await expect(resolveFreshDefaultBranch('/repo')).resolves.toBe('main');
  });

  it('revalidates stale knowledge remotely and records the result', async () => {
    mockedReadFreshness.mockResolvedValue({
      commonDir: '/repo/.git',
      originUrl: 'https://example.test/repo.git',
      defaultBranch: 'trunk',
      resolvedAt: new Date(
        Date.now() - DEFAULT_BRANCH_FRESHNESS_TTL_MS - 1,
      ).toISOString(),
    });
    mockedGetRemoteHeadBranch.mockResolvedValue('release');

    await expect(resolveFreshDefaultBranch('/repo')).resolves.toBe('release');

    expect(mockedRecordDefaultBranch).toHaveBeenCalledWith(
      expect.objectContaining({ defaultBranch: 'release' }),
    );
  });

  it('allows local-only callers to reuse stale knowledge without network Git', async () => {
    mockedReadFreshness.mockResolvedValue({
      commonDir: '/repo/.git',
      originUrl: 'https://example.test/repo.git',
      defaultBranch: 'trunk',
      resolvedAt: new Date(0).toISOString(),
    });

    await expect(
      resolveFreshDefaultBranch('/repo', { allowRemoteLookup: false }),
    ).resolves.toBe('trunk');

    expect(mockedGetRemoteHeadBranch).not.toHaveBeenCalled();
    expect(mockedGetRemoteDefaultBranch).not.toHaveBeenCalled();
  });
});
