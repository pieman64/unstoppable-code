import * as path from 'path';
import type {
  SkillLockEntry,
  SkillLockFile,
} from '@canopy/desktop-shared/types/skills';

const MOCK_LOCK_PATH = '/mock/userData/skills/skills-lock.json';
const MOCK_SKILLS_ROOT = '/mock/userData/skills';

jest.mock('fs');
jest.mock('../skills/paths', () => ({
  getSkillsLockFilePath: (): string => MOCK_LOCK_PATH,
  getSkillsRootDir: (): string => MOCK_SKILLS_ROOT,
  getSourceDir: (sourceId: string): string =>
    path.join(MOCK_SKILLS_ROOT, sourceId),
  getSourceMetadataPath: (sourceId: string): string =>
    path.join(MOCK_SKILLS_ROOT, sourceId, 'source.json'),
  getSkillDir: (sourceId: string, skillName: string): string =>
    path.join(MOCK_SKILLS_ROOT, sourceId, skillName),
  deriveSourceId: (sourceType: string, source: string): string => {
    if (sourceType === 'github') return `github:${source.replace(/\//g, ':')}`;
    return `${sourceType}:${source.replace(/[/\\]/g, '_')}`;
  },
}));
jest.mock('../skills/skill-discovery', () => ({
  fetchGitHubTree: jest.fn(),
  getGitHubToken: jest.fn(),
}));

import * as fs from 'fs';
import {
  getLockKey,
  parseLockKey,
  readLockFile,
  writeLockFile,
  addLockEntry,
  removeLockEntry,
  getInstalledSkillDirs,
  fetchSkillFolderHash,
  checkForUpdate,
} from '../skills/lock-file';
import { fetchGitHubTree, getGitHubToken } from '../skills/skill-discovery';

const mockedFs = jest.mocked(fs);
const mockedGetGitHubToken = getGitHubToken as jest.MockedFunction<
  typeof getGitHubToken
>;
const mockedFetchGitHubTree = fetchGitHubTree as jest.MockedFunction<
  typeof fetchGitHubTree
>;

function makeEntry(overrides: Partial<SkillLockEntry> = {}): SkillLockEntry {
  return {
    sourceId: 'github:owner:repo',
    source: 'owner/repo',
    sourceType: 'github',
    sourceUrl: 'https://github.com/owner/repo',
    skillPath: 'skills/my-skill',
    skillFolderHash: 'abc123',
    installedAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeLockFile(
  skills: Record<string, SkillLockEntry> = {},
  version: 1 | 2 = 2,
): SkillLockFile {
  return { version, skills };
}

function parseWrittenJson(callIndex: number): SkillLockFile {
  // writeLockFile writes to a .tmp file then renames; find the right call
  const calls = (mockedFs.writeFileSync as jest.Mock).mock.calls as string[][];
  const tmpCalls = calls.filter((call) => call[0].endsWith('.tmp'));
  const raw = tmpCalls[callIndex]?.[1] ?? calls[callIndex][1];
  return JSON.parse(raw) as SkillLockFile;
}

function mockTreeResponse(
  tree: Array<{ path: string; type: string; sha: string }>,
): void {
  mockedFetchGitHubTree.mockResolvedValue({
    tree,
    resolvedBranch: 'main',
  } as Awaited<ReturnType<typeof fetchGitHubTree>>);
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe('getLockKey', () => {
  it('combines sourceId and skillName with a slash', () => {
    expect(getLockKey('github:owner:repo', 'my-skill')).toBe(
      'github:owner:repo/my-skill',
    );
  });

  it('handles empty strings', () => {
    expect(getLockKey('', '')).toBe('/');
  });
});

describe('parseLockKey', () => {
  it('splits on last slash', () => {
    expect(parseLockKey('github:owner:repo/my-skill')).toEqual({
      sourceId: 'github:owner:repo',
      skillName: 'my-skill',
    });
  });

  it('throws on key with no slash', () => {
    expect(() => parseLockKey('no-slash-here')).toThrow(
      'Invalid lock key (no separator): no-slash-here',
    );
  });

  it('splits on last slash when key contains multiple slashes', () => {
    expect(parseLockKey('a/b/c')).toEqual({ sourceId: 'a/b', skillName: 'c' });
  });

  it('handles slash at start of key', () => {
    expect(parseLockKey('/skill')).toEqual({
      sourceId: '',
      skillName: 'skill',
    });
  });

  it('handles slash at end of key', () => {
    expect(parseLockKey('source/')).toEqual({
      sourceId: 'source',
      skillName: '',
    });
  });
});

describe('readLockFile', () => {
  it('returns default when file does not exist', () => {
    mockedFs.existsSync.mockReturnValue(false);
    const result = readLockFile();
    expect(result).toEqual({ version: 2, skills: {} });
    expect(mockedFs.existsSync).toHaveBeenCalledWith(MOCK_LOCK_PATH);
  });

  it('returns parsed content for valid v2 file', () => {
    const entry = makeEntry();
    const lockContent = makeLockFile({ 'github:owner:repo/my-skill': entry });
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(lockContent));
    const result = readLockFile();
    expect(result).toEqual(lockContent);
  });

  it('returns default when skills is not an object', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ version: 2, skills: 'not-an-object' }),
    );
    expect(readLockFile()).toEqual({ version: 2, skills: {} });
  });

  it('returns default when skills is a number', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ version: 2, skills: 42 }),
    );
    expect(readLockFile()).toEqual({ version: 2, skills: {} });
  });

  it('returns default when version is not 2 and not 1', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ version: 99, skills: {} }),
    );
    expect(readLockFile()).toEqual({ version: 2, skills: {} });
  });

  it('returns default when version is 0', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ version: 0, skills: {} }),
    );
    expect(readLockFile()).toEqual({ version: 2, skills: {} });
  });

  it('returns default when JSON parse throws', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('not valid json {{{');
    expect(readLockFile()).toEqual({ version: 2, skills: {} });
  });

  it('returns default when readFileSync throws', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation(() => {
      throw new Error('EACCES');
    });
    expect(readLockFile()).toEqual({ version: 2, skills: {} });
  });

  describe('v1 migration', () => {
    it('migrates v1 lock file to v2, moves directories, writes source metadata, and returns migrated lock', () => {
      const v1Entry = makeEntry({
        sourceId: undefined as unknown as string,
        source: 'owner/repo',
        sourceType: 'github',
        sourceUrl: 'https://github.com/owner/repo',
        skillPath: 'skills/my-skill',
      });
      const v1Lock = makeLockFile({ 'my-skill': v1Entry }, 1);

      const oldDir = path.join(MOCK_SKILLS_ROOT, 'my-skill');
      const sourceDir = path.join(MOCK_SKILLS_ROOT, 'github:owner:repo');
      const newDir = path.join(sourceDir, 'my-skill');
      const sourceMetaPath = path.join(sourceDir, 'source.json');

      mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const s = p.toString();
        if (s === MOCK_LOCK_PATH) return true;
        if (s === oldDir) return true;
        if (s === newDir) return false;
        if (s === sourceDir) return false;
        if (s === sourceMetaPath) return false;
        if (s === path.dirname(MOCK_LOCK_PATH)) return true;
        return false;
      });
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(v1Lock));

      const result = readLockFile();

      expect(result.version).toBe(2);
      expect(result.skills['github:owner:repo/my-skill']).toEqual(
        expect.objectContaining({
          source: 'owner/repo',
          sourceType: 'github',
          sourceId: 'github:owner:repo',
        }),
      );
      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(sourceDir, {
        recursive: true,
      });
      expect(mockedFs.renameSync).toHaveBeenCalledWith(oldDir, newDir);

      const allWriteCalls = (mockedFs.writeFileSync as jest.Mock).mock
        .calls as string[][];
      const sourceMetaWrite = allWriteCalls.find(
        (call) => call[0] === sourceMetaPath,
      );
      expect(sourceMetaWrite).toBeDefined();
      const writtenMeta = JSON.parse(
        (sourceMetaWrite as string[])[1],
      ) as Record<string, unknown>;
      expect(writtenMeta.type).toBe('github');
      expect(writtenMeta.owner).toBe('owner');
      expect(writtenMeta.repo).toBe('repo');
    });

    it('skips rename when old directory does not exist', () => {
      const v1Entry = makeEntry({ source: 'owner/repo', sourceType: 'github' });
      const v1Lock = makeLockFile({ 'my-skill': v1Entry }, 1);

      mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const s = p.toString();
        if (s === MOCK_LOCK_PATH) return true;
        if (s === path.join(MOCK_SKILLS_ROOT, 'my-skill')) return false;
        if (s === path.dirname(MOCK_LOCK_PATH)) return true;
        return false;
      });
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(v1Lock));

      readLockFile();
      // renameSync is called only for the atomic lock file write (tmp → lock),
      // not for directory moves
      const renameCalls = (mockedFs.renameSync as jest.Mock).mock
        .calls as string[][];
      const dirRenames = renameCalls.filter(
        (call) => !call[0].endsWith('.tmp'),
      );
      expect(dirRenames).toHaveLength(0);
    });

    it('skips rename when new directory already exists', () => {
      const v1Entry = makeEntry({ source: 'owner/repo', sourceType: 'github' });
      const v1Lock = makeLockFile({ 'my-skill': v1Entry }, 1);

      const oldDir = path.join(MOCK_SKILLS_ROOT, 'my-skill');
      const newDir = path.join(
        MOCK_SKILLS_ROOT,
        'github:owner:repo',
        'my-skill',
      );

      mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const s = p.toString();
        if (s === MOCK_LOCK_PATH) return true;
        if (s === oldDir) return true;
        if (s === newDir) return true;
        if (s === path.dirname(MOCK_LOCK_PATH)) return true;
        return false;
      });
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(v1Lock));

      readLockFile();
      // renameSync is called only for the atomic lock file write (tmp → lock),
      // not for directory moves
      const renameCalls = (mockedFs.renameSync as jest.Mock).mock
        .calls as string[][];
      const dirRenames = renameCalls.filter(
        (call) => !call[0].endsWith('.tmp'),
      );
      expect(dirRenames).toHaveLength(0);
    });

    it('does not create source dir if it already exists during migration', () => {
      const v1Entry = makeEntry({ source: 'owner/repo', sourceType: 'github' });
      const v1Lock = makeLockFile({ 'my-skill': v1Entry }, 1);

      const oldDir = path.join(MOCK_SKILLS_ROOT, 'my-skill');
      const sourceDir = path.join(MOCK_SKILLS_ROOT, 'github:owner:repo');
      const newDir = path.join(sourceDir, 'my-skill');
      const sourceMetaPath = path.join(sourceDir, 'source.json');

      mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const s = p.toString();
        if (s === MOCK_LOCK_PATH) return true;
        if (s === oldDir) return true;
        if (s === newDir) return false;
        if (s === sourceDir) return true;
        if (s === sourceMetaPath) return true;
        if (s === path.dirname(MOCK_LOCK_PATH)) return true;
        return false;
      });
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(v1Lock));

      readLockFile();

      const mkdirCalls = (mockedFs.mkdirSync as jest.Mock).mock
        .calls as unknown[][];
      const createdSourceDir = mkdirCalls.some((call) => call[0] === sourceDir);
      expect(createdSourceDir).toBe(false);
    });

    it('does not write source.json if it already exists', () => {
      const v1Entry = makeEntry({ source: 'owner/repo', sourceType: 'github' });
      const v1Lock = makeLockFile({ 'my-skill': v1Entry }, 1);

      const sourceDir = path.join(MOCK_SKILLS_ROOT, 'github:owner:repo');
      const sourceMetaPath = path.join(sourceDir, 'source.json');

      mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const s = p.toString();
        if (s === MOCK_LOCK_PATH) return true;
        if (s === path.join(MOCK_SKILLS_ROOT, 'my-skill')) return false;
        if (s === sourceDir) return true;
        if (s === sourceMetaPath) return true;
        if (s === path.dirname(MOCK_LOCK_PATH)) return true;
        return false;
      });
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(v1Lock));

      readLockFile();

      const writeFileCalls = (mockedFs.writeFileSync as jest.Mock).mock
        .calls as unknown[][];
      const wroteSourceMeta = writeFileCalls.some(
        (call) => (call as string[])[0] === sourceMetaPath,
      );
      expect(wroteSourceMeta).toBe(false);
    });

    it('handles non-github source types without owner/repo in metadata', () => {
      const v1Entry = makeEntry({
        source: '/local/path',
        sourceType: 'local',
        sourceUrl: 'file:///local/path',
      });
      const v1Lock = makeLockFile({ 'local-skill': v1Entry }, 1);

      mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const s = p.toString();
        if (s === MOCK_LOCK_PATH) return true;
        if (s === path.join(MOCK_SKILLS_ROOT, 'local-skill')) return false;
        if (s === path.dirname(MOCK_LOCK_PATH)) return true;
        return false;
      });
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(v1Lock));

      const result = readLockFile();

      expect(result.version).toBe(2);
      const key = Object.keys(result.skills)[0];
      expect(key).toBe('local:_local_path/local-skill');

      const sourceMetaWriteCall = (
        mockedFs.writeFileSync as jest.Mock
      ).mock.calls.find((call: unknown[]) =>
        (call as string[])[0].includes('source.json'),
      ) as [string, string, string] | undefined;
      if (sourceMetaWriteCall) {
        const metadata = JSON.parse(sourceMetaWriteCall[1]) as Record<
          string,
          unknown
        >;
        expect(metadata.owner).toBeUndefined();
        expect(metadata.repo).toBeUndefined();
        expect(metadata.type).toBe('local');
      }
    });

    it('writes source metadata only once per source when multiple skills share a source', () => {
      const entryA = makeEntry({
        source: 'owner/repo',
        sourceType: 'github',
        skillPath: 'a',
      });
      const entryB = makeEntry({
        source: 'owner/repo',
        sourceType: 'github',
        skillPath: 'b',
      });
      const v1Lock = makeLockFile({ 'skill-a': entryA, 'skill-b': entryB }, 1);

      mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const s = p.toString();
        if (s === MOCK_LOCK_PATH) return true;
        if (s === path.dirname(MOCK_LOCK_PATH)) return true;
        return false;
      });
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(v1Lock));

      const result = readLockFile();

      expect(Object.keys(result.skills)).toHaveLength(2);

      const sourceMetaPath = path.join(
        MOCK_SKILLS_ROOT,
        'github:owner:repo',
        'source.json',
      );
      const sourceMetaWrites = (
        mockedFs.writeFileSync as jest.Mock
      ).mock.calls.filter(
        (call: unknown[]) => (call as string[])[0] === sourceMetaPath,
      );
      expect(sourceMetaWrites).toHaveLength(1);
    });
  });
});

describe('writeLockFile', () => {
  it('creates directory if it does not exist and sorts keys', () => {
    mockedFs.existsSync.mockReturnValue(false);

    const entryB = makeEntry({ skillPath: 'b' });
    const entryA = makeEntry({ skillPath: 'a' });

    writeLockFile(makeLockFile({ 'z/b': entryB, 'a/a': entryA }));

    expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
      path.dirname(MOCK_LOCK_PATH),
      {
        recursive: true,
      },
    );

    const written = parseWrittenJson(0);
    expect(Object.keys(written.skills)).toEqual(['a/a', 'z/b']);
  });

  it('does not create directory if it already exists', () => {
    mockedFs.existsSync.mockReturnValue(true);
    writeLockFile(makeLockFile());
    expect(mockedFs.mkdirSync).not.toHaveBeenCalled();
  });

  it('writes correct JSON structure with version preserved', () => {
    mockedFs.existsSync.mockReturnValue(true);
    const entry = makeEntry();
    writeLockFile(makeLockFile({ 'src/skill': entry }));

    // Atomic write: writes to .tmp then renames to final path
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      MOCK_LOCK_PATH + '.tmp',
      expect.any(String),
      'utf-8',
    );
    expect(mockedFs.renameSync).toHaveBeenCalledWith(
      MOCK_LOCK_PATH + '.tmp',
      MOCK_LOCK_PATH,
    );

    const written = parseWrittenJson(0);
    expect(written.version).toBe(2);
    expect(written.skills['src/skill']).toEqual(entry);
  });

  it('writes pretty-printed JSON with 2-space indent and trailing newline', () => {
    mockedFs.existsSync.mockReturnValue(true);
    const entry = makeEntry();
    writeLockFile(makeLockFile({ key: entry }));

    const writeCalls = (mockedFs.writeFileSync as jest.Mock).mock
      .calls as string[][];
    // Find the .tmp write call
    const tmpCall = writeCalls.find((call) => call[0].endsWith('.tmp'));
    expect(tmpCall).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const rawOutput = tmpCall![1];
    const expected =
      JSON.stringify({ version: 2, skills: { key: entry } }, null, 2) + '\n';
    expect(rawOutput).toBe(expected);
  });
});

describe('addLockEntry', () => {
  it('reads existing lock, adds entry, and writes back', () => {
    const existingEntry = makeEntry({ skillPath: 'existing' });
    const existingLock = makeLockFile({
      'github:owner:repo/existing': existingEntry,
    });

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(existingLock));

    const newEntry = makeEntry({ skillPath: 'new-skill' });
    addLockEntry('github:owner:repo', 'new-skill', newEntry);

    expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(1);
    const written = parseWrittenJson(0);
    expect(written.skills['github:owner:repo/existing']).toEqual(existingEntry);
    expect(written.skills['github:owner:repo/new-skill']).toEqual(newEntry);
  });

  it('creates a new lock file when none exists', () => {
    mockedFs.existsSync.mockReturnValue(false);

    const entry = makeEntry();
    addLockEntry('github:owner:repo', 'my-skill', entry);

    expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(1);
    const written = parseWrittenJson(0);
    expect(written.skills['github:owner:repo/my-skill']).toEqual(entry);
    expect(written.version).toBe(2);
  });
});

describe('removeLockEntry', () => {
  it('reads existing lock, removes entry, and writes back', () => {
    const entryA = makeEntry({ skillPath: 'a' });
    const entryB = makeEntry({ skillPath: 'b' });
    const lock = makeLockFile({ 'src/a': entryA, 'src/b': entryB });

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(lock));

    removeLockEntry('src', 'a');

    const written = parseWrittenJson(0);
    expect(written.skills['src/a']).toBeUndefined();
    expect(written.skills['src/b']).toEqual(entryB);
  });

  it('is a no-op write when entry does not exist', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(makeLockFile()));

    removeLockEntry('nonexistent', 'skill');

    expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(1);
    const written = parseWrittenJson(0);
    expect(written.skills).toEqual({});
  });
});

describe('fetchSkillFolderHash', () => {
  it('returns sha when tree entry matches skill path', async () => {
    mockedGetGitHubToken.mockResolvedValue('mock-token');
    mockTreeResponse([
      { path: 'skills/my-skill', type: 'tree', sha: 'skill-sha' },
      { path: 'README.md', type: 'blob', sha: 'readme-sha' },
    ]);

    const result = await fetchSkillFolderHash(
      'owner',
      'repo',
      'skills/my-skill',
    );

    expect(result).toBe('skill-sha');
    expect(mockedFetchGitHubTree).toHaveBeenCalledWith(
      'owner',
      'repo',
      'mock-token',
      undefined,
    );
  });

  it('returns null when no matching tree entry', async () => {
    mockedGetGitHubToken.mockResolvedValue('mock-token');
    mockTreeResponse([{ path: 'other/path', type: 'tree', sha: 'other-sha' }]);

    const result = await fetchSkillFolderHash(
      'owner',
      'repo',
      'skills/my-skill',
    );
    expect(result).toBeNull();
  });

  it('returns null when entry is a blob not a tree', async () => {
    mockedGetGitHubToken.mockResolvedValue('mock-token');
    mockTreeResponse([
      { path: 'skills/my-skill', type: 'blob', sha: 'blob-sha' },
    ]);

    const result = await fetchSkillFolderHash(
      'owner',
      'repo',
      'skills/my-skill',
    );
    expect(result).toBeNull();
  });

  it('passes branch parameter to fetchGitHubTree', async () => {
    mockedGetGitHubToken.mockResolvedValue('mock-token');
    mockTreeResponse([]);

    await fetchSkillFolderHash('owner', 'repo', 'skills/my-skill', 'develop');
    expect(mockedFetchGitHubTree).toHaveBeenCalledWith(
      'owner',
      'repo',
      'mock-token',
      'develop',
    );
  });

  it('returns null when fetchGitHubTree throws', async () => {
    mockedGetGitHubToken.mockResolvedValue('mock-token');
    mockedFetchGitHubTree.mockRejectedValue(new Error('network error'));

    const result = await fetchSkillFolderHash(
      'owner',
      'repo',
      'skills/my-skill',
    );
    expect(result).toBeNull();
  });

  it('returns null when getGitHubToken throws', async () => {
    mockedGetGitHubToken.mockRejectedValue(new Error('no token'));

    const result = await fetchSkillFolderHash(
      'owner',
      'repo',
      'skills/my-skill',
    );
    expect(result).toBeNull();
  });
});

describe('checkForUpdate', () => {
  it('returns true when current hash differs from stored hash', async () => {
    mockedGetGitHubToken.mockResolvedValue('mock-token');
    mockTreeResponse([
      { path: 'skills/my-skill', type: 'tree', sha: 'new-sha' },
    ]);

    const entry = makeEntry({ skillFolderHash: 'old-sha' });
    const result = await checkForUpdate('my-skill', entry);
    expect(result).toBe(true);
  });

  it('returns false when current hash matches stored hash', async () => {
    mockedGetGitHubToken.mockResolvedValue('mock-token');
    mockTreeResponse([
      { path: 'skills/my-skill', type: 'tree', sha: 'abc123' },
    ]);

    const entry = makeEntry({ skillFolderHash: 'abc123' });
    const result = await checkForUpdate('my-skill', entry);
    expect(result).toBe(false);
  });

  it('returns false when source has no owner', async () => {
    const entry = makeEntry({ source: '' });
    const result = await checkForUpdate('my-skill', entry);
    expect(result).toBe(false);
    expect(mockedFetchGitHubTree).not.toHaveBeenCalled();
  });

  it('returns false when source has no repo', async () => {
    const entry = makeEntry({ source: 'owner-only' });
    const result = await checkForUpdate('my-skill', entry);
    expect(result).toBe(false);
    expect(mockedFetchGitHubTree).not.toHaveBeenCalled();
  });

  it('returns false when fetchSkillFolderHash returns null', async () => {
    mockedGetGitHubToken.mockResolvedValue('mock-token');
    mockedFetchGitHubTree.mockRejectedValue(new Error('fail'));

    const entry = makeEntry();
    const result = await checkForUpdate('my-skill', entry);
    expect(result).toBe(false);
  });
});

describe('getInstalledSkillDirs', () => {
  function makeDirent(name: string, isDir: boolean): fs.Dirent {
    return {
      name,
      isDirectory: (): boolean => isDir,
      isFile: (): boolean => !isDir,
      isBlockDevice: (): boolean => false,
      isCharacterDevice: (): boolean => false,
      isFIFO: (): boolean => false,
      isSocket: (): boolean => false,
      isSymbolicLink: (): boolean => false,
      path: '',
      parentPath: '',
    } as fs.Dirent;
  }

  it('returns empty array when root directory does not exist', () => {
    mockedFs.existsSync.mockReturnValue(false);
    expect(getInstalledSkillDirs()).toEqual([]);
  });

  it('scans source and skill directories', () => {
    mockedFs.existsSync.mockReturnValue(true);

    (mockedFs.readdirSync as jest.Mock).mockImplementation(
      (dirPath: string) => {
        if (dirPath === MOCK_SKILLS_ROOT) {
          return [
            makeDirent('github:owner:repo', true),
            makeDirent('skills-lock.json', false),
          ];
        }
        if (dirPath === path.join(MOCK_SKILLS_ROOT, 'github:owner:repo')) {
          return [
            makeDirent('skill-alpha', true),
            makeDirent('skill-beta', true),
            makeDirent('source.json', false),
          ];
        }
        return [];
      },
    );

    const result = getInstalledSkillDirs();

    expect(result).toEqual([
      {
        sourceId: 'github:owner:repo',
        skillName: 'skill-alpha',
        fullPath: path.join(
          MOCK_SKILLS_ROOT,
          'github:owner:repo',
          'skill-alpha',
        ),
      },
      {
        sourceId: 'github:owner:repo',
        skillName: 'skill-beta',
        fullPath: path.join(
          MOCK_SKILLS_ROOT,
          'github:owner:repo',
          'skill-beta',
        ),
      },
    ]);
  });

  it('returns empty array when readdirSync throws', () => {
    mockedFs.existsSync.mockReturnValue(true);
    (mockedFs.readdirSync as jest.Mock).mockImplementation(() => {
      throw new Error('EPERM');
    });
    expect(getInstalledSkillDirs()).toEqual([]);
  });

  it('handles multiple source directories', () => {
    mockedFs.existsSync.mockReturnValue(true);

    (mockedFs.readdirSync as jest.Mock).mockImplementation(
      (dirPath: string) => {
        if (dirPath === MOCK_SKILLS_ROOT) {
          return [makeDirent('source-a', true), makeDirent('source-b', true)];
        }
        if (dirPath === path.join(MOCK_SKILLS_ROOT, 'source-a')) {
          return [makeDirent('skill-1', true)];
        }
        if (dirPath === path.join(MOCK_SKILLS_ROOT, 'source-b')) {
          return [makeDirent('skill-2', true)];
        }
        return [];
      },
    );

    const result = getInstalledSkillDirs();

    expect(result).toHaveLength(2);
    expect(result[0].sourceId).toBe('source-a');
    expect(result[0].skillName).toBe('skill-1');
    expect(result[1].sourceId).toBe('source-b');
    expect(result[1].skillName).toBe('skill-2');
  });

  it('returns empty array when root has no subdirectories', () => {
    mockedFs.existsSync.mockReturnValue(true);
    (mockedFs.readdirSync as jest.Mock).mockReturnValue([
      makeDirent('skills-lock.json', false),
    ]);
    expect(getInstalledSkillDirs()).toEqual([]);
  });
});
