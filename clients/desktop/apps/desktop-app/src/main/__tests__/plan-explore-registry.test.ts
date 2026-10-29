const mockReadFile = jest.fn<Promise<string>, [string, string]>();
const mockWriteFile = jest.fn<Promise<void>, [string, string, string]>();
const mockMkdir = jest.fn<Promise<void>, [string, { recursive: boolean }]>();
const mockReadFileSync = jest.fn<string, [string, string]>();
const mockStatSync = jest.fn<{ mtimeMs: number }, [string]>();

jest.mock('node:fs/promises', () => ({
  mkdir: (path: string, options: { recursive: boolean }): Promise<void> =>
    mockMkdir(path, options),
  readFile: (path: string, encoding: string): Promise<string> =>
    mockReadFile(path, encoding),
  writeFile: (
    path: string,
    contents: string,
    encoding: string,
  ): Promise<void> => mockWriteFile(path, contents, encoding),
}));

jest.mock('node:fs', () => ({
  readFileSync: (path: string, encoding: string): string =>
    mockReadFileSync(path, encoding),
  statSync: (path: string): { mtimeMs: number } => mockStatSync(path),
}));

const mockRegistryPath = '/mock/data-dir/plan-explore-chats/registry.json';
jest.mock('../lib/paths', () => ({
  getPlanExploreRegistryFilePath: (): string => mockRegistryPath,
}));

import {
  getPlanExploreTarget,
  getPlanExploreTargetSync,
  isSamePlanExploreScope,
  listPlanExploreTargetIdsForScope,
  registerPlanExploreTarget,
  removePlanExploreTarget,
  transferPlanExploreTargets,
  type PlanExploreTargetRef,
} from '../lib/plan-explore-registry';

// In-memory "disk" backing the fs mocks above. `diskMtimeMs` only ever
// increases across the whole file (never resets in `beforeEach`) so a stale
// module-level `cachedRegistry` from an earlier test can never collide with a
// later test's mtime by coincidence.
let diskContent: string | null = null;
let diskMtimeMs = 0;

function enoent(): Error {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
}

function setDiskContent(raw: string | null): void {
  diskContent = raw;
  diskMtimeMs += 1;
}

const projA: PlanExploreTargetRef = { projectId: 'proj-1', worktreeId: 'wt-1' };
const projB: PlanExploreTargetRef = { projectId: 'proj-2', worktreeId: 'wt-2' };

beforeEach(() => {
  jest.clearAllMocks();
  diskContent = null;
  mockMkdir.mockResolvedValue(undefined);
  mockReadFile.mockImplementation((): Promise<string> => {
    if (diskContent === null) {
      return Promise.reject(enoent());
    }
    return Promise.resolve(diskContent);
  });
  mockWriteFile.mockImplementation((_path, contents): Promise<void> => {
    diskContent = contents;
    diskMtimeMs += 1;
    return Promise.resolve();
  });
  mockReadFileSync.mockImplementation(() => {
    if (diskContent === null) {
      throw enoent();
    }
    return diskContent;
  });
  mockStatSync.mockImplementation(() => {
    if (diskContent === null) {
      throw enoent();
    }
    return { mtimeMs: diskMtimeMs };
  });
});

describe('isSamePlanExploreScope', () => {
  it('compares projectId and worktreeId', () => {
    expect(isSamePlanExploreScope(projA, { ...projA })).toBe(true);
    expect(isSamePlanExploreScope(projA, projB)).toBe(false);
    expect(
      isSamePlanExploreScope(projA, { ...projA, worktreeId: 'wt-other' }),
    ).toBe(false);
  });
});

describe('registerPlanExploreTarget / getPlanExploreTarget', () => {
  it('round-trips a registered target', async () => {
    await expect(getPlanExploreTarget('plan-a')).resolves.toBeNull();

    await registerPlanExploreTarget('plan-a', projA);

    await expect(getPlanExploreTarget('plan-a')).resolves.toEqual(projA);
  });

  it('returns the target only when it matches an expected scope', async () => {
    await registerPlanExploreTarget('plan-a', projA);

    await expect(getPlanExploreTarget('plan-a', { ...projA })).resolves.toEqual(
      projA,
    );
    await expect(getPlanExploreTarget('plan-a', projB)).resolves.toBeNull();
  });

  it('treats corrupt JSON as an empty registry', async () => {
    setDiskContent('{not json');

    await expect(getPlanExploreTarget('plan-a')).resolves.toBeNull();
  });

  it('treats an unknown registry version as an empty registry', async () => {
    setDiskContent(
      JSON.stringify({ version: 2, targets: { 'plan-a': projA } }),
    );

    await expect(getPlanExploreTarget('plan-a')).resolves.toBeNull();
  });
});

describe('removePlanExploreTarget', () => {
  it("returns 'absent' and does not write when the plan was never registered", async () => {
    const result = await removePlanExploreTarget('missing-plan', projA);

    expect(result).toBe('absent');
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("returns 'other-scope' and does not write when a different scope owns the row", async () => {
    await registerPlanExploreTarget('plan-a', projA);
    mockWriteFile.mockClear();

    const result = await removePlanExploreTarget('plan-a', projB);

    expect(result).toBe('other-scope');
    expect(mockWriteFile).not.toHaveBeenCalled();
    await expect(getPlanExploreTarget('plan-a')).resolves.toEqual(projA);
  });

  it("removes a matching scope and returns 'removed'", async () => {
    await registerPlanExploreTarget('plan-a', projA);
    mockWriteFile.mockClear();

    const result = await removePlanExploreTarget('plan-a', { ...projA });

    expect(result).toBe('removed');
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    await expect(getPlanExploreTarget('plan-a')).resolves.toBeNull();
  });
});

describe('listPlanExploreTargetIdsForScope', () => {
  it('filters registered plan ids by owner scope', async () => {
    await registerPlanExploreTarget('plan-a', projA);
    await registerPlanExploreTarget('plan-b', projB);
    await registerPlanExploreTarget('plan-c', projA);

    await expect(listPlanExploreTargetIdsForScope(projA)).resolves.toEqual(
      expect.arrayContaining(['plan-a', 'plan-c']),
    );
    await expect(listPlanExploreTargetIdsForScope(projA)).resolves.toHaveLength(
      2,
    );
    await expect(listPlanExploreTargetIdsForScope(projB)).resolves.toEqual([
      'plan-b',
    ]);
  });

  it('returns an empty list when nothing is registered to that scope', async () => {
    await registerPlanExploreTarget('plan-a', projA);

    await expect(listPlanExploreTargetIdsForScope(projB)).resolves.toEqual([]);
  });
});

describe('transferPlanExploreTargets', () => {
  const restored: PlanExploreTargetRef = {
    projectId: 'proj-1',
    worktreeId: 'wt-restored',
  };

  it('moves only the rows owned by the source scope', async () => {
    await registerPlanExploreTarget('plan-a', projA);
    await registerPlanExploreTarget('plan-b', projB);
    await registerPlanExploreTarget('plan-c', projA);

    await expect(transferPlanExploreTargets(projA, restored)).resolves.toEqual(
      expect.arrayContaining(['plan-a', 'plan-c']),
    );

    await expect(getPlanExploreTarget('plan-a')).resolves.toEqual(restored);
    await expect(getPlanExploreTarget('plan-c')).resolves.toEqual(restored);
    await expect(getPlanExploreTarget('plan-b')).resolves.toEqual(projB);
  });

  it('writes nothing when the source scope owns no rows, so a retry is a no-op', async () => {
    await registerPlanExploreTarget('plan-b', projB);
    mockWriteFile.mockClear();

    await expect(transferPlanExploreTargets(projA, restored)).resolves.toEqual(
      [],
    );
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});

describe('concurrent register and remove', () => {
  it('serializes so both effects persist', async () => {
    await registerPlanExploreTarget('plan-a', projA);

    const callLog: string[] = [];
    mockReadFile.mockImplementation(async () => {
      callLog.push('read');
      // Yield to the microtask queue: a non-serialized implementation would
      // let the second operation's read interleave before the first write.
      await Promise.resolve();
      if (diskContent === null) {
        throw enoent();
      }
      return diskContent;
    });
    mockWriteFile.mockImplementation((_path, contents): Promise<void> => {
      callLog.push('write');
      diskContent = contents;
      diskMtimeMs += 1;
      return Promise.resolve();
    });

    const registerPromise = registerPlanExploreTarget('plan-b', projB);
    const removePromise = removePlanExploreTarget('plan-a', { ...projA });

    const [, removeResult] = await Promise.all([
      registerPromise,
      removePromise,
    ]);

    expect(removeResult).toBe('removed');
    // Each read/write pair completes before the next operation's read starts.
    expect(callLog).toEqual(['read', 'write', 'read', 'write']);
    await expect(getPlanExploreTarget('plan-b')).resolves.toEqual(projB);
    await expect(getPlanExploreTarget('plan-a')).resolves.toBeNull();
  });
});

describe('getPlanExploreTargetSync', () => {
  it('returns null when the registry file is missing', () => {
    expect(getPlanExploreTargetSync('plan-a')).toBeNull();
  });

  it('caches the parsed registry by mtime and re-reads only when it changes', async () => {
    await registerPlanExploreTarget('plan-a', projA);

    expect(getPlanExploreTargetSync('plan-a')).toEqual(projA);
    const readsAfterFirst = mockReadFileSync.mock.calls.length;
    expect(readsAfterFirst).toBeGreaterThan(0);

    // Same mtime: served from cache, no additional readFileSync call.
    expect(getPlanExploreTargetSync('plan-a')).toEqual(projA);
    expect(mockReadFileSync.mock.calls.length).toBe(readsAfterFirst);

    // File changes on disk (new mtime): cache is invalidated and re-read.
    await registerPlanExploreTarget('plan-b', projB);
    expect(getPlanExploreTargetSync('plan-b')).toEqual(projB);
    expect(mockReadFileSync.mock.calls.length).toBeGreaterThan(readsAfterFirst);
  });
});
