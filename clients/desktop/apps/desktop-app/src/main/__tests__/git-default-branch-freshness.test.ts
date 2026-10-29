import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockFreshnessDir = mkdtempSync(
  path.join(os.tmpdir(), 'canopy-git-default-branch-freshness-'),
);
const mockFreshnessPath = path.join(
  mockFreshnessDir,
  'git-default-branch-freshness.json',
);

jest.mock('../lib/paths', () => ({
  getGitDefaultBranchFreshnessFilePath: (): string => mockFreshnessPath,
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
          defaultBranch: 'main',
          resolvedAt: '1970-01-01T00:00:01.000Z',
        },
      },
    }),
    'utf8',
  );
  const freshness = await import('../lib/git-default-branch-freshness');

  await expect(
    freshness.readGitDefaultBranchFreshness({
      commonDir: '/repo/.git',
      originUrl,
    }),
  ).resolves.toBeNull();

  const persisted = readFileSync(mockFreshnessPath, 'utf8');
  expect(persisted).not.toContain(originUrl);
  expect(JSON.parse(persisted)).toEqual({ version: 2, entries: {} });
});

test('recovers from corruption and replaces knowledge when origin identity changes', async () => {
  writeFileSync(mockFreshnessPath, '{not-json', 'utf8');
  const freshness = await import('../lib/git-default-branch-freshness');
  const originOne = {
    commonDir: '/repo/.git',
    originUrl: 'https://example.test/one.git',
  };

  await expect(
    freshness.readGitDefaultBranchFreshness(originOne),
  ).resolves.toBeNull();
  await freshness.recordGitDefaultBranch({
    identity: originOne,
    defaultBranch: 'trunk',
    resolvedAt: 1_000,
  });
  await expect(
    freshness.readGitDefaultBranchFreshness(originOne),
  ).resolves.toEqual({
    ...originOne,
    defaultBranch: 'trunk',
    resolvedAt: '1970-01-01T00:00:01.000Z',
  });

  const originTwo = {
    ...originOne,
    originUrl: 'https://token@example.test/two.git?signature=secret',
  };
  await expect(
    freshness.readGitDefaultBranchFreshness(originTwo),
  ).resolves.toBeNull();
  await freshness.recordGitDefaultBranch({
    identity: originTwo,
    defaultBranch: 'release',
    resolvedAt: 2_000,
  });
  await expect(
    freshness.readGitDefaultBranchFreshness(originOne),
  ).resolves.toBeNull();

  const persisted: unknown = JSON.parse(
    readFileSync(mockFreshnessPath, 'utf8'),
  );
  if (typeof persisted !== 'object' || persisted === null) {
    throw new Error('Expected persisted default-branch freshness object');
  }
  expect(readProperty(persisted, 'version')).toBe(2);
  const entries = readProperty(persisted, 'entries');
  if (
    typeof entries !== 'object' ||
    entries === null ||
    Array.isArray(entries)
  ) {
    throw new Error('Expected persisted default-branch entries');
  }
  expect(Object.values(entries)).toEqual([
    {
      commonDir: originTwo.commonDir,
      originHash: createHash('sha256')
        .update(originTwo.originUrl)
        .digest('hex'),
      defaultBranch: 'release',
      resolvedAt: '1970-01-01T00:00:02.000Z',
    },
  ]);
  expect(readFileSync(mockFreshnessPath, 'utf8')).not.toContain(
    originTwo.originUrl,
  );
});
