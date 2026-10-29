jest.mock('../../lib/git', () => ({
  getRemoteUrl: jest.fn(),
  getRemoteUrlStrict: jest.fn(),
}));

jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));

import { getRemoteUrl, getRemoteUrlStrict } from '../../lib/git';
import { schedulePortalStructuralSync } from '../../portal/portal-structural-sync';
import {
  PROJECT_AVATAR_REFRESH_MS,
  PROJECT_AVATAR_RETRY_MS,
  readProjectAvatarUrl,
  retainProjectAvatarRepoPaths,
} from '../project-avatar-cache';

const mockedGetRemoteUrl = jest.mocked(getRemoteUrl);
const mockedGetRemoteUrlStrict = jest.mocked(getRemoteUrlStrict);
const mockedScheduleSync = jest.mocked(schedulePortalStructuralSync);

/** Both lookups agree on the configured origin (`null`: no origin remote). */
function remoteIs(remoteUrl: string | null): void {
  mockedGetRemoteUrl.mockResolvedValue(remoteUrl);
  mockedGetRemoteUrlStrict.mockResolvedValue(remoteUrl);
}

/**
 * An operational git failure (a lock, a timeout, a missing binary). The
 * lenient lookup swallows it into "no origin", exactly as the real one does;
 * only the strict lookup reports it.
 */
function remoteLookupFails(): void {
  mockedGetRemoteUrl.mockResolvedValue(null);
  mockedGetRemoteUrlStrict.mockRejectedValue(new Error('index.lock exists'));
}

/** How many times git was asked for the origin, through either lookup. */
function lookupCount(): number {
  return (
    mockedGetRemoteUrl.mock.calls.length +
    mockedGetRemoteUrlStrict.mock.calls.length
  );
}

/** Let the serialized lookup queue drain (mocked git resolves in microtasks). */
async function flushLookups(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const ACME = 'https://github.com/acme.png?size=32';

// Each test uses its own repo path: the cache is process-lifetime state, and
// distinct keys keep the cases independent without a test-only reset export.
describe('project avatar cache', () => {
  let now: jest.SpyInstance<number, []>;

  beforeEach(() => {
    jest.clearAllMocks();
    now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  });

  afterEach(() => {
    now.mockRestore();
  });

  it('resolves a GitHub origin to the owner avatar off the read path and republishes once', async () => {
    remoteIs('https://github.com/example-org/example-repo.git');

    // A miss never blocks the snapshot: it answers "no avatar yet".
    expect(readProjectAvatarUrl('/repos/github')).toBeUndefined();
    await flushLookups();

    expect(readProjectAvatarUrl('/repos/github')).toBe(
      'https://github.com/example-org.png?size=32',
    );
    expect(mockedScheduleSync).toHaveBeenCalledTimes(1);
    // A hit is served from the cache without spawning git again.
    await flushLookups();
    expect(lookupCount()).toBe(1);
  });

  it.each([
    ['a non-GitHub origin', 'git@gitlab.com:acme/repo.git', '/repos/gitlab'],
    ['no origin remote', null, '/repos/no-origin'],
  ])(
    'leaves the avatar unset for %s and remembers the answer',
    async (_case, remoteUrl, repoPath) => {
      remoteIs(remoteUrl);

      expect(readProjectAvatarUrl(repoPath)).toBeUndefined();
      await flushLookups();
      expect(readProjectAvatarUrl(repoPath)).toBeUndefined();
      await flushLookups();

      expect(lookupCount()).toBe(1);
      expect(mockedScheduleSync).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['origin is confirmed absent', null, '/repos/origin-removed'],
    [
      'origin moved off GitHub',
      'git@gitlab.com:acme/repo.git',
      '/repos/origin-moved',
    ],
  ])(
    'clears a cached avatar only once %s',
    async (_case, remoteUrl, repoPath) => {
      remoteIs('git@github.com:acme/repo.git');
      readProjectAvatarUrl(repoPath);
      await flushLookups();
      expect(readProjectAvatarUrl(repoPath)).toBe(ACME);

      now.mockReturnValue(1_000 + PROJECT_AVATAR_REFRESH_MS);
      remoteIs(remoteUrl);
      readProjectAvatarUrl(repoPath);
      await flushLookups();

      expect(readProjectAvatarUrl(repoPath)).toBeUndefined();
      expect(mockedScheduleSync).toHaveBeenCalledTimes(2);
    },
  );

  it('coalesces concurrent misses for one repository into one git call', async () => {
    remoteIs('git@github.com:acme/repo.git');

    readProjectAvatarUrl('/repos/burst');
    readProjectAvatarUrl('/repos/burst');
    readProjectAvatarUrl('/repos/burst');
    await flushLookups();

    expect(lookupCount()).toBe(1);
    expect(readProjectAvatarUrl('/repos/burst')).toBe(ACME);
  });

  it('serves the cached avatar while it revalidates, republishing only on change', async () => {
    remoteIs('git@github.com:acme/repo.git');
    readProjectAvatarUrl('/repos/moved');
    await flushLookups();
    expect(mockedScheduleSync).toHaveBeenCalledTimes(1);

    // Stale, same owner: still served, re-checked, no republish.
    now.mockReturnValue(1_000 + PROJECT_AVATAR_REFRESH_MS);
    expect(readProjectAvatarUrl('/repos/moved')).toBe(ACME);
    await flushLookups();
    expect(lookupCount()).toBe(2);
    expect(mockedScheduleSync).toHaveBeenCalledTimes(1);

    // Stale, new owner: the old value serves this read, the next gets the new.
    now.mockReturnValue(1_000 + 2 * PROJECT_AVATAR_REFRESH_MS);
    remoteIs('git@github.com:other-org/repo.git');
    expect(readProjectAvatarUrl('/repos/moved')).toBe(ACME);
    await flushLookups();
    expect(readProjectAvatarUrl('/repos/moved')).toBe(
      'https://github.com/other-org.png?size=32',
    );
    expect(mockedScheduleSync).toHaveBeenCalledTimes(2);
  });

  it('keeps the last avatar through an operational git failure and retries after a short backoff', async () => {
    remoteIs('git@github.com:acme/repo.git');
    readProjectAvatarUrl('/repos/flaky');
    await flushLookups();
    expect(readProjectAvatarUrl('/repos/flaky')).toBe(ACME);
    expect(mockedScheduleSync).toHaveBeenCalledTimes(1);

    // The revalidation hits a transient failure: the good answer stands, and
    // nothing is republished for a lookup that learned nothing.
    const failedAt = 1_000 + PROJECT_AVATAR_REFRESH_MS;
    now.mockReturnValue(failedAt);
    remoteLookupFails();
    readProjectAvatarUrl('/repos/flaky');
    await flushLookups();
    expect(readProjectAvatarUrl('/repos/flaky')).toBe(ACME);
    expect(mockedScheduleSync).toHaveBeenCalledTimes(1);
    const lookupsAfterFailure = lookupCount();

    // Not retried on every read in the meantime...
    now.mockReturnValue(failedAt + PROJECT_AVATAR_RETRY_MS - 1);
    readProjectAvatarUrl('/repos/flaky');
    await flushLookups();
    expect(lookupCount()).toBe(lookupsAfterFailure);

    // ...but soon after, well before the normal refresh window.
    expect(PROJECT_AVATAR_RETRY_MS).toBeLessThan(PROJECT_AVATAR_REFRESH_MS);
    now.mockReturnValue(failedAt + PROJECT_AVATAR_RETRY_MS);
    remoteIs('git@github.com:acme/repo.git');
    readProjectAvatarUrl('/repos/flaky');
    await flushLookups();
    expect(lookupCount()).toBe(lookupsAfterFailure + 1);
    expect(readProjectAvatarUrl('/repos/flaky')).toBe(ACME);
    expect(mockedScheduleSync).toHaveBeenCalledTimes(1);
  });

  it('prunes repositories a projection pass no longer names', async () => {
    remoteIs('git@github.com:acme/repo.git');
    readProjectAvatarUrl('/repos/kept');
    readProjectAvatarUrl('/repos/deleted');
    await flushLookups();
    expect(lookupCount()).toBe(2);

    retainProjectAvatarRepoPaths(new Set(['/repos/kept']));

    // The retained entry is still a hit; the pruned one is a fresh miss.
    expect(readProjectAvatarUrl('/repos/kept')).toBe(ACME);
    expect(readProjectAvatarUrl('/repos/deleted')).toBeUndefined();
    await flushLookups();
    expect(lookupCount()).toBe(3);
  });

  it('drops a lookup that finishes after its repository was pruned', async () => {
    remoteIs('git@github.com:acme/repo.git');
    readProjectAvatarUrl('/repos/renamed');
    retainProjectAvatarRepoPaths(new Set());
    await flushLookups();

    expect(readProjectAvatarUrl('/repos/renamed')).toBeUndefined();
    expect(mockedScheduleSync).not.toHaveBeenCalled();
  });
});
