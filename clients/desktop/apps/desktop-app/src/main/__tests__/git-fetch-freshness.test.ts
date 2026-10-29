import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockFreshnessDir = mkdtempSync(
  path.join(os.tmpdir(), 'canopy-git-fetch-freshness-'),
);
const mockFreshnessPath = path.join(
  mockFreshnessDir,
  'git-fetch-freshness.json',
);

jest.mock('../lib/paths', () => ({
  getGitFetchFreshnessFilePath: (): string => mockFreshnessPath,
}));

function readProperty(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

afterAll(() => {
  rmSync(mockFreshnessDir, { recursive: true, force: true });
});

beforeEach(() => {
  jest.resetModules();
});

test('replaces legacy files so raw origin URLs do not remain on disk', async () => {
  const originUrl = 'https://token@example.test/legacy.git?signature=secret';
  writeFileSync(
    mockFreshnessPath,
    JSON.stringify({
      version: 1,
      entries: {
        legacy: {
          commonDir: '/repo/.git',
          originUrl,
          prune: true,
          lastAttemptAt: '1970-01-01T00:00:01.000Z',
          lastSuccessAt: '1970-01-01T00:00:01.000Z',
          consecutiveFailures: 0,
        },
      },
    }),
    'utf8',
  );
  const freshness = await import('../lib/git-fetch-freshness');

  await expect(
    freshness.readGitFetchFreshness({
      commonDir: '/repo/.git',
      originUrl,
      prune: true,
    }),
  ).resolves.toBeNull();

  const persisted = readFileSync(mockFreshnessPath, 'utf8');
  expect(persisted).not.toContain(originUrl);
  expect(JSON.parse(persisted)).toEqual({ version: 2, entries: {} });
});

test('recovers from corruption and invalidates freshness when origin identity changes', async () => {
  writeFileSync(mockFreshnessPath, '{not-json', 'utf8');
  const freshness = await import('../lib/git-fetch-freshness');
  const originOne = {
    commonDir: '/repo/.git',
    originUrl: 'https://example.test/one.git',
    prune: true,
  };

  await expect(freshness.readGitFetchFreshness(originOne)).resolves.toBeNull();
  await freshness.recordGitFetchSuccess({
    identity: originOne,
    succeededAt: 1_000,
  });
  await expect(freshness.readGitFetchFreshness(originOne)).resolves.toEqual({
    ...originOne,
    lastAttemptAt: '1970-01-01T00:00:01.000Z',
    lastSuccessAt: '1970-01-01T00:00:01.000Z',
    consecutiveFailures: 0,
  });

  await freshness.recordGitFetchFailure({
    identity: originOne,
    failedAt: 2_000,
  });
  await expect(freshness.readGitFetchFreshness(originOne)).resolves.toEqual({
    ...originOne,
    lastAttemptAt: '1970-01-01T00:00:02.000Z',
    lastSuccessAt: '1970-01-01T00:00:01.000Z',
    lastFailureAt: '1970-01-01T00:00:02.000Z',
    retryAfterAt: '1970-01-01T00:00:32.000Z',
    consecutiveFailures: 1,
  });

  const originTwo = {
    ...originOne,
    originUrl: 'https://token@example.test/two.git?signature=secret',
  };
  await expect(freshness.readGitFetchFreshness(originTwo)).resolves.toBeNull();
  await freshness.recordGitFetchSuccess({
    identity: originTwo,
    succeededAt: 3_000,
  });
  await expect(freshness.readGitFetchFreshness(originOne)).resolves.toBeNull();

  const persisted: unknown = JSON.parse(
    readFileSync(mockFreshnessPath, 'utf8'),
  );
  if (typeof persisted !== 'object' || persisted === null) {
    throw new Error('Expected persisted freshness object');
  }
  expect(readProperty(persisted, 'version')).toBe(2);
  const entries = readProperty(persisted, 'entries');
  if (
    typeof entries !== 'object' ||
    entries === null ||
    Array.isArray(entries)
  ) {
    throw new Error('Expected persisted freshness entries');
  }
  expect(Object.values(entries)).toEqual([
    {
      commonDir: originTwo.commonDir,
      originHash: createHash('sha256')
        .update(originTwo.originUrl)
        .digest('hex'),
      prune: originTwo.prune,
      lastAttemptAt: '1970-01-01T00:00:03.000Z',
      lastSuccessAt: '1970-01-01T00:00:03.000Z',
      consecutiveFailures: 0,
    },
  ]);
  expect(readFileSync(mockFreshnessPath, 'utf8')).not.toContain(
    originTwo.originUrl,
  );
});

test('does not carry successful freshness across an origin change that fails', async () => {
  const freshness = await import('../lib/git-fetch-freshness');
  const originOne = {
    commonDir: '/repo/.git',
    originUrl: 'https://example.test/one.git',
    prune: true,
  };
  const originTwo = {
    ...originOne,
    originUrl: 'https://example.test/two.git',
  };

  await freshness.recordGitFetchSuccess({
    identity: originOne,
    succeededAt: 1_000,
  });
  await expect(
    freshness.recordGitFetchFailure({
      identity: originTwo,
      failedAt: 2_000,
    }),
  ).resolves.toEqual({
    ...originTwo,
    lastAttemptAt: '1970-01-01T00:00:02.000Z',
    lastFailureAt: '1970-01-01T00:00:02.000Z',
    retryAfterAt: '1970-01-01T00:00:32.000Z',
    consecutiveFailures: 1,
  });

  await expect(freshness.readGitFetchFreshness(originOne)).resolves.toBeNull();
  await expect(freshness.readGitFetchFreshness(originTwo)).resolves.toEqual({
    ...originTwo,
    lastAttemptAt: '1970-01-01T00:00:02.000Z',
    lastFailureAt: '1970-01-01T00:00:02.000Z',
    retryAfterAt: '1970-01-01T00:00:32.000Z',
    consecutiveFailures: 1,
  });
});

test('invalidates persisted freshness only for the matching origin', async () => {
  const freshness = await import('../lib/git-fetch-freshness');
  const identity = {
    commonDir: '/repo/.git',
    originUrl: 'https://example.test/repo.git',
    prune: false,
  };

  await freshness.recordGitFetchSuccess({ identity, succeededAt: 1_000 });
  await freshness.invalidateGitFetchFreshness({
    ...identity,
    originUrl: 'https://example.test/other.git',
  });
  await expect(
    freshness.readGitFetchFreshness(identity),
  ).resolves.not.toBeNull();

  await freshness.invalidateGitFetchFreshness(identity);
  await expect(freshness.readGitFetchFreshness(identity)).resolves.toBeNull();
});
