jest.mock('../git', () => ({
  getGitCommonDir: jest.fn(() => Promise.resolve('/repo/.git')),
  getLocalRemoteHeadBranch: jest.fn(() => Promise.resolve('main')),
  getRemoteDefaultBranch: jest.fn(() => Promise.resolve(null)),
  getRemoteHeadBranch: jest.fn(),
  getRemoteUrl: jest.fn(() => Promise.resolve('https://github.com/acme/web')),
  setLocalRemoteHeadBranch: jest.fn(() => Promise.resolve()),
}));

jest.mock('../git-default-branch-freshness', () => ({
  readGitDefaultBranchFreshness: jest.fn(),
  recordGitDefaultBranch: jest.fn(() => Promise.resolve()),
}));

import { getRemoteHeadBranch, setLocalRemoteHeadBranch } from '../git';
import {
  readGitDefaultBranchFreshness,
  recordGitDefaultBranch,
} from '../git-default-branch-freshness';
import { revalidateDefaultBranchInBackground } from '../git-default-branch';

const mockedGetRemoteHeadBranch = jest.mocked(getRemoteHeadBranch);
const mockedSetLocalRemoteHeadBranch = jest.mocked(setLocalRemoteHeadBranch);
const mockedReadGitDefaultBranchFreshness = jest.mocked(
  readGitDefaultBranchFreshness,
);
const mockedRecordGitDefaultBranch = jest.mocked(recordGitDefaultBranch);

const STALE_ENTRY = {
  commonDir: '/repo/.git',
  originUrl: 'https://github.com/acme/web',
  defaultBranch: 'develop',
  resolvedAt: '2026-01-01T00:00:00.000Z',
};

async function flushBackgroundWork(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('revalidateDefaultBranchInBackground', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedReadGitDefaultBranchFreshness.mockResolvedValue(STALE_ENTRY);
  });

  it('repairs a stale origin HEAD from the remote without being awaited', async () => {
    mockedGetRemoteHeadBranch.mockResolvedValue('develop');

    expect(revalidateDefaultBranchInBackground('/repo')).toBeUndefined();
    await flushBackgroundWork();

    expect(mockedGetRemoteHeadBranch).toHaveBeenCalledWith('/repo');
    expect(mockedRecordGitDefaultBranch).toHaveBeenCalledWith(
      expect.objectContaining({ defaultBranch: 'develop' }),
    );
    expect(mockedSetLocalRemoteHeadBranch).toHaveBeenCalledWith(
      '/repo',
      'develop',
    );
  });

  it('shares one lookup between concurrent calls for a repository', async () => {
    let answer: (branch: string) => void = () => undefined;
    mockedGetRemoteHeadBranch.mockReturnValue(
      new Promise<string>((resolve) => {
        answer = resolve;
      }),
    );

    revalidateDefaultBranchInBackground('/repo');
    revalidateDefaultBranchInBackground('/repo');
    await flushBackgroundWork();
    expect(mockedGetRemoteHeadBranch).toHaveBeenCalledTimes(1);

    answer('develop');
    await flushBackgroundWork();
    mockedGetRemoteHeadBranch.mockResolvedValue('develop');
    revalidateDefaultBranchInBackground('/repo');
    await flushBackgroundWork();
    expect(mockedGetRemoteHeadBranch).toHaveBeenCalledTimes(2);
  });

  it('ignores a failed remote lookup', async () => {
    mockedGetRemoteHeadBranch.mockRejectedValue(new Error('auth failed'));

    revalidateDefaultBranchInBackground('/repo');
    await flushBackgroundWork();

    expect(mockedRecordGitDefaultBranch).not.toHaveBeenCalled();
    expect(mockedSetLocalRemoteHeadBranch).not.toHaveBeenCalled();
  });
});
