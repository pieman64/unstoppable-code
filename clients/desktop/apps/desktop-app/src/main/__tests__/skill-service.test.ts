import * as path from 'path';
import * as yaml from 'js-yaml';
import type {
  SkillLockEntry,
  SkillUpdateProgress,
} from '@canopy/desktop-shared/types/skills';

jest.mock('fs');
jest.mock('node:fs/promises');
jest.mock('../skills/skill-discovery', () => ({
  discoverSkillsFromGitHub: jest.fn(),
  getGitHubToken: jest.fn(),
  fetchGitHubTree: jest.fn(),
}));
jest.mock('../skills/installer', () => ({
  sanitizeName: jest.fn((n: string) => n),
  installSkill: jest.fn(),
}));
jest.mock('../skills/risk', () => ({
  fetchRiskAssessment: jest.fn(),
}));
jest.mock('../skills/lock-file', () => ({
  readLockFile: jest.fn(() => ({ version: 2, skills: {} })),
  addLockEntry: jest.fn(),
  removeLockEntry: jest.fn(),
  fetchSkillFolderHash: jest.fn(),
  checkForUpdate: jest.fn(),
  getLockKey: jest.fn(
    (sourceId: string, skillName: string) => `${sourceId}/${skillName}`,
  ),
  parseLockKey: jest.fn((key: string) => {
    const parts = key.split('/');
    return { sourceId: parts[0], skillName: parts[1] };
  }),
}));
jest.mock('../skills/source-parser', () => ({
  parseGitHubSource: jest.fn(),
}));
jest.mock('../lib/paths', () => ({
  getDataDir: jest.fn(() => '/mock/data'),
}));
jest.mock('../pipelines/config-paths', () => ({
  getBundledSkillsDir: jest.fn(() => '/mock/bundled-skills'),
  getBundledSkillDir: jest.fn(
    (skillName: string) => `/mock/bundled-skills/${skillName}`,
  ),
}));
jest.mock('../lib/frontmatter', () => ({
  parseFrontmatter: jest.fn(),
  parseFrontmatterAndBody: jest.fn(() => ({
    frontmatter: {},
    body: '# Skill',
  })),
}));
jest.mock('../lib/fs-utils', () => ({
  safeReadText: jest.fn(),
}));

import * as fs from 'fs';
import * as fsp from 'node:fs/promises';
import {
  checkUpdates,
  updateSkill,
  listSkillFiles,
  loadSkills,
  readSkillFile,
  removeSkill,
  readSkillContent,
  saveCustomSkill,
  clearSkillRemoteMetadataByRemoteId,
  writeSkillRemoteMetadata,
} from '../skills/skill-service';
import {
  addLockEntry,
  checkForUpdate,
  fetchSkillFolderHash,
  readLockFile,
} from '../skills/lock-file';
import {
  discoverSkillsFromGitHub,
  fetchGitHubTree,
  getGitHubToken,
} from '../skills/skill-discovery';
import { installSkill } from '../skills/installer';
import { parseGitHubSource } from '../skills/source-parser';
import { pinOrgProjectsFlagOff } from './helpers/org-projects-flag';

// This suite covers the legacy (context-free) resource paths.
beforeEach(() => {
  pinOrgProjectsFlagOff();
});

const actualFs: typeof fs = jest.requireActual('fs');
const existsSyncMock = fs.existsSync as jest.MockedFunction<
  typeof fs.existsSync
>;
const rmSyncMock = fs.rmSync as jest.MockedFunction<typeof fs.rmSync>;
// Narrow the overloaded Jest mock to the string-name forms used by this suite.
const readdirSyncMock = fs.readdirSync as unknown as jest.MockedFunction<
  (
    path: fs.PathLike,
    options?: { withFileTypes?: boolean },
  ) => string[] | fs.Dirent[]
>;
const readFileSyncMock = fs.readFileSync as jest.MockedFunction<
  typeof fs.readFileSync
>;
const writeFileSyncMock = fs.writeFileSync as jest.MockedFunction<
  typeof fs.writeFileSync
>;
const mkdirSyncMock = fs.mkdirSync as jest.MockedFunction<typeof fs.mkdirSync>;
const renameSyncMock = fs.renameSync as jest.MockedFunction<
  typeof fs.renameSync
>;
const statMock = jest.mocked(fsp.stat);
const lstatMock = jest.mocked(fsp.lstat);
const realpathMock = jest.mocked(fsp.realpath);
// Narrow the overload to the withFileTypes call used by the production code.
const readdirMock = fsp.readdir as unknown as jest.MockedFunction<
  (path: fs.PathLike, options: { withFileTypes: true }) => Promise<fs.Dirent[]>
>;
const opendirMock = jest.mocked(fsp.opendir);
const openMock = jest.mocked(fsp.open);
const cpMock = jest.mocked(fsp.cp);
const mkdirMock = jest.mocked(fsp.mkdir);
const renameMock = jest.mocked(fsp.rename);
const rmMock = jest.mocked(fsp.rm);
const rmdirMock = jest.mocked(fsp.rmdir);
const writeFileMock = jest.mocked(fsp.writeFile);
const directoryReadMocks: Array<jest.Mock<Promise<fs.Dirent | null>, []>> = [];

beforeEach(() => {
  jest.resetAllMocks();
  directoryReadMocks.length = 0;
  // Restore mocks cleared by resetAllMocks
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  jest.requireMock('../lib/paths').getDataDir.mockReturnValue('/mock/data');
  const installerMock: { sanitizeName: jest.Mock; installSkill: jest.Mock } =
    jest.requireMock('../skills/installer');
  installerMock.sanitizeName.mockImplementation((n: string) => n);
  const lockFileMock: {
    readLockFile: jest.Mock;
    getLockKey: jest.Mock;
    parseLockKey: jest.Mock;
  } = jest.requireMock('../skills/lock-file');
  lockFileMock.readLockFile.mockReturnValue({ version: 2, skills: {} });
  lockFileMock.getLockKey.mockImplementation(
    (sourceId: string, skillName: string) => `${sourceId}/${skillName}`,
  );
  lockFileMock.parseLockKey.mockImplementation((key: string) => {
    const lastSlash = key.lastIndexOf('/');
    return {
      sourceId: key.substring(0, lastSlash),
      skillName: key.substring(lastSlash + 1),
    };
  });
  realpathMock.mockImplementation((filePath) =>
    Promise.resolve(path.resolve(String(filePath))),
  );
  lstatMock.mockRejectedValue(
    Object.assign(new Error('missing'), { code: 'ENOENT' }),
  );
  cpMock.mockResolvedValue(undefined);
  mkdirMock.mockResolvedValue(undefined);
  rmMock.mockResolvedValue(undefined);
  rmdirMock.mockResolvedValue(undefined);
  writeFileMock.mockResolvedValue(undefined);
  readFileSyncMock.mockImplementation((filePath) => {
    if (String(filePath).endsWith('.share-links.json')) {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    }
    return undefined as never;
  });
});

// The skills root is /mock/data/skills
// A valid sourceId like "github:owner:repo" and skillName like "my-skill"
// would resolve to /mock/data/skills/github:owner:repo/my-skill

describe('removeSkill', () => {
  it('rejects sourceId with path traversal (../)', () => {
    const result = removeSkill('../../etc', 'my-skill');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid skill path.');
    expect(rmSyncMock).not.toHaveBeenCalled();
  });

  it('rejects skillName with path traversal (../)', () => {
    const result = removeSkill('github:owner:repo', '../../../etc');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid skill path.');
    expect(rmSyncMock).not.toHaveBeenCalled();
  });

  it('rejects empty sourceId', () => {
    const result = removeSkill('', 'my-skill');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid skill path.');
  });

  it('rejects empty skillName', () => {
    const result = removeSkill('github:owner:repo', '');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid skill path.');
  });

  it('rejects skillName of "."', () => {
    const result = removeSkill('github:owner:repo', '.');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid skill path.');
  });

  it('rejects sourceId of "."', () => {
    const result = removeSkill('.', 'my-skill');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid skill path.');
  });

  it('rejects sourceId with forward slash', () => {
    const result = removeSkill('a/b', 'my-skill');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid skill path.');
  });

  it('rejects skillName with backslash', () => {
    const result = removeSkill('github:owner:repo', 'a\\b');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid skill path.');
  });

  it('rejects absolute path as sourceId', () => {
    const result = removeSkill('/etc/passwd', 'my-skill');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid skill path.');
  });

  it('removes skill directory for valid inputs', () => {
    existsSyncMock.mockReturnValue(true);
    readdirSyncMock.mockReturnValue(['other-skill']);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { removeLockEntry } = jest.requireMock('../skills/lock-file');

    const result = removeSkill('github:owner:repo', 'my-skill');
    expect(result.success).toBe(true);
    expect(rmSyncMock).toHaveBeenCalledWith(
      path.resolve('/mock/data/skills/github:owner:repo/my-skill'),
      { recursive: true, force: true },
    );
    expect(removeLockEntry).toHaveBeenCalledWith(
      'github:owner:repo',
      'my-skill',
    );
  });
});

describe('loadSkills', () => {
  it('does not surface hidden transactional staging directories as skills', () => {
    existsSyncMock.mockImplementation((filePath) =>
      String(filePath).endsWith('custom:app'),
    );
    readdirSyncMock.mockReturnValue([
      dirent('.canopy-skill-stage-pending', true),
      dirent('.canopy-skill-backup-pending', true),
    ]);

    const result = loadSkills();

    expect(result).toEqual({ success: true, data: [] });
  });

  it('hydrates cached update availability for installed skills', () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { readLockFile } = jest.requireMock('../skills/lock-file');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    readLockFile.mockReturnValue({
      version: 2,
      skills: {
        'github:owner:repo/my-skill': {
          sourceId: 'github:owner:repo',
          source: 'owner/repo',
          sourceType: 'github',
          sourceUrl: 'https://github.com/owner/repo',
          skillPath: 'skills/my-skill',
          skillFolderHash: 'old',
          installedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });
    existsSyncMock.mockImplementation((p) => {
      const str = String(p);
      return (
        str.endsWith('github:owner:repo/my-skill') ||
        str.endsWith('update-status.json')
      );
    });
    readFileSyncMock.mockImplementation((filePath) => {
      if (String(filePath).endsWith('.share-links.json')) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return JSON.stringify({ 'github:owner:repo/my-skill': true });
    });

    const result = loadSkills();

    if (!result.success) throw new Error(result.error);
    expect(result.data?.[0]?.updateAvailable).toBe(true);
  });

  it('hydrates and clears author-side cloud share metadata', () => {
    const { readLockFile } = jest.requireMock<{
      readLockFile: jest.Mock;
    }>('../skills/lock-file');
    readLockFile.mockReturnValue({
      version: 2,
      skills: {
        'github:owner:repo/my-skill': {
          sourceId: 'github:owner:repo',
          source: 'owner/repo',
          sourceType: 'github',
          sourceUrl: 'https://github.com/owner/repo',
          skillPath: 'skills/my-skill',
          skillFolderHash: 'old',
          installedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });
    const remote = {
      accountId: 'account-a',
      remoteId: '11111111-1111-4111-8111-111111111111',
      contentHash: 'hash-a',
      shareScope: 'team' as const,
      sharedAt: '2026-09-24T16:00:00.000Z',
    };
    let links: Record<string, typeof remote> = {};
    existsSyncMock.mockImplementation((filePath) => {
      const value = String(filePath);
      return (
        value.endsWith('github:owner:repo/my-skill') ||
        value.endsWith('.share-links.json')
      );
    });
    readFileSyncMock.mockImplementation((filePath) => {
      const value = String(filePath);
      return value.endsWith('.share-links.json') ? JSON.stringify(links) : '';
    });
    writeFileSyncMock.mockImplementation((_filePath, value) => {
      if (typeof value !== 'string') throw new Error('Expected JSON text');
      links = JSON.parse(value) as Record<string, typeof remote>;
    });

    writeSkillRemoteMetadata('github:owner:repo/my-skill', remote);
    expect(loadSkills().data?.[0]?.remote).toEqual(remote);
    expect(clearSkillRemoteMetadataByRemoteId(remote.remoteId)).toBe(1);
    expect(loadSkills().data?.[0]?.remote).toBeUndefined();
  });

  it('does not replace a malformed share-link catalog with an empty one', () => {
    readFileSyncMock.mockImplementation((filePath) => {
      if (String(filePath).endsWith('.share-links.json')) return '{broken';
      return '';
    });

    expect(() =>
      writeSkillRemoteMetadata('custom:app/helper', {
        remoteId: '11111111-1111-4111-8111-111111111111',
        contentHash: 'hash-a',
        shareScope: 'private',
        sharedAt: '2026-09-25T00:00:00.000Z',
      }),
    ).toThrow();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-object root', '[]'],
    [
      'an invalid entry',
      JSON.stringify({
        'custom:app/existing': {
          remoteId: 42,
          contentHash: 'hash-existing',
          shareScope: 'private',
          sharedAt: '2026-09-25T00:00:00.000Z',
        },
      }),
    ],
    [
      'an invalid account binding',
      JSON.stringify({
        'custom:app/existing': {
          accountId: 42,
          remoteId: '11111111-1111-4111-8111-111111111111',
          contentHash: 'hash-existing',
          shareScope: 'private',
          sharedAt: '2026-09-25T00:00:00.000Z',
        },
      }),
    ],
  ])('does not replace a share-link catalog with %s', (_label, catalog) => {
    readFileSyncMock.mockImplementation((filePath) => {
      if (String(filePath).endsWith('.share-links.json')) return catalog;
      return '';
    });

    expect(() =>
      writeSkillRemoteMetadata('custom:app/helper', {
        remoteId: '11111111-1111-4111-8111-111111111111',
        contentHash: 'hash-a',
        shareScope: 'private',
        sharedAt: '2026-09-25T00:00:00.000Z',
      }),
    ).toThrow('Invalid Skill share-link catalog.');
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('atomically replaces the share-link catalog', () => {
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });

    writeSkillRemoteMetadata('custom:app/helper', {
      remoteId: '11111111-1111-4111-8111-111111111111',
      contentHash: 'hash-a',
      shareScope: 'private',
      sharedAt: '2026-09-25T00:00:00.000Z',
    });

    const temporaryPath = String(writeFileSyncMock.mock.calls[0]?.[0]);
    expect(temporaryPath).toMatch(/\.share-links\.json\.tmp-/);
    expect(renameSyncMock).toHaveBeenCalledWith(
      temporaryPath,
      '/mock/data/skills/.share-links.json',
    );
  });
});

describe('checkUpdates', () => {
  it('persists checked update availability for later skill loads', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { readLockFile, checkForUpdate } = jest.requireMock(
      '../skills/lock-file',
    );
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    readLockFile.mockReturnValue({
      version: 2,
      skills: {
        'github:owner:repo/my-skill': {
          sourceId: 'github:owner:repo',
          source: 'owner/repo',
          sourceType: 'github',
          sourceUrl: 'https://github.com/owner/repo',
          skillPath: 'skills/my-skill',
          skillFolderHash: 'old',
          installedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    checkForUpdate.mockResolvedValue(true);

    const result = await checkUpdates();

    if (!result.success) throw new Error(result.error);
    expect(result.data).toEqual({ 'github:owner:repo/my-skill': true });
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      path.join('/mock/data/skills', 'update-status.json'),
      `${JSON.stringify({ 'github:owner:repo/my-skill': true }, null, 2)}\n`,
      'utf-8',
    );
  });

  it('preserves cached availability when a lock entry changes during the check', async () => {
    const lockFileMock: {
      readLockFile: jest.Mock;
      checkForUpdate: jest.Mock;
    } = jest.requireMock('../skills/lock-file');
    const originalLock = {
      version: 2,
      skills: {
        'github:owner:repo/my-skill': {
          sourceId: 'github:owner:repo',
          source: 'owner/repo',
          sourceType: 'github',
          sourceUrl: 'https://github.com/owner/repo',
          skillPath: 'skills/my-skill',
          skillFolderHash: 'old',
          installedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    };
    const latestLock = {
      version: 2,
      skills: {
        'github:owner:repo/my-skill': {
          ...originalLock.skills['github:owner:repo/my-skill'],
          skillFolderHash: 'new',
        },
      },
    };
    lockFileMock.readLockFile
      .mockReturnValueOnce(originalLock)
      .mockReturnValueOnce(latestLock);
    lockFileMock.checkForUpdate.mockResolvedValue(true);
    existsSyncMock.mockImplementation((p) =>
      String(p).endsWith('update-status.json'),
    );
    readFileSyncMock.mockReturnValue(
      JSON.stringify({ 'github:owner:repo/my-skill': false }),
    );
    const progress = jest.fn();

    const result = await checkUpdates(progress);

    if (!result.success) throw new Error(result.error);
    expect(result.data).toEqual({ 'github:owner:repo/my-skill': false });
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      path.join('/mock/data/skills', 'update-status.json'),
      `${JSON.stringify({ 'github:owner:repo/my-skill': false }, null, 2)}\n`,
      'utf-8',
    );
    expect(progress).toHaveBeenLastCalledWith({
      operation: 'check-updates',
      status: 'complete',
      message: 'Skill update check complete.',
      updateMap: { 'github:owner:repo/my-skill': false },
    });
  });

  it('prunes cached availability for lock entries removed during the check', async () => {
    const lockFileMock: {
      readLockFile: jest.Mock;
      checkForUpdate: jest.Mock;
    } = jest.requireMock('../skills/lock-file');
    lockFileMock.readLockFile
      .mockReturnValueOnce({
        version: 2,
        skills: {
          'github:owner:repo/my-skill': {
            sourceId: 'github:owner:repo',
            source: 'owner/repo',
            sourceType: 'github',
            sourceUrl: 'https://github.com/owner/repo',
            skillPath: 'skills/my-skill',
            skillFolderHash: 'old',
            installedAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      })
      .mockReturnValueOnce({ version: 2, skills: {} });
    lockFileMock.checkForUpdate.mockResolvedValue(true);
    existsSyncMock.mockImplementation((p) =>
      String(p).endsWith('update-status.json'),
    );
    readFileSyncMock.mockReturnValue(
      JSON.stringify({ 'github:owner:repo/my-skill': true }),
    );
    const progress = jest.fn();

    const result = await checkUpdates(progress);

    if (!result.success) throw new Error(result.error);
    expect(result.data).toEqual({});
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      path.join('/mock/data/skills', 'update-status.json'),
      `${JSON.stringify({}, null, 2)}\n`,
      'utf-8',
    );
    expect(progress).toHaveBeenLastCalledWith({
      operation: 'check-updates',
      status: 'complete',
      message: 'Skill update check complete.',
      updateMap: {},
    });
  });
});

describe('installed skill update contract', () => {
  const sourceId = 'github:owner:repo';
  const skillName = 'my-skill';
  const key = `${sourceId}/${skillName}`;
  const statusPath = '/mock/data/skills/update-status.json';
  const skillDir = `/mock/data/skills/${sourceId}/${skillName}`;
  const entry: SkillLockEntry = {
    sourceId,
    source: 'owner/repo',
    sourceType: 'github',
    sourceUrl: 'https://github.com/owner/repo',
    skillPath: 'skills/my-skill',
    skillFolderHash: 'old',
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const discoveredSkill = {
    name: skillName,
    description: 'Updated skill',
    sourcePath: 'new-path/my-skill',
  };
  let cachedStatus: string;

  beforeEach(() => {
    cachedStatus = JSON.stringify({ [key]: true });
    jest.mocked(readLockFile).mockReturnValue({
      version: 2,
      skills: { [key]: entry },
    });
    existsSyncMock.mockImplementation((filePath) =>
      [statusPath, skillDir].includes(String(filePath)),
    );
    readFileSyncMock.mockImplementation((filePath) => {
      if (String(filePath) === statusPath) return cachedStatus;
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    writeFileSyncMock.mockImplementation((filePath, data) => {
      if (String(filePath) === statusPath && typeof data === 'string') {
        cachedStatus = data;
      }
    });
    jest
      .mocked(parseGitHubSource)
      .mockReturnValue({ owner: 'owner', repo: 'repo' });
    jest.mocked(getGitHubToken).mockResolvedValue(null);
    jest.mocked(fetchGitHubTree).mockResolvedValue({
      tree: [],
      resolvedBranch: 'main',
      treeSha: 'new-tree',
    });
    jest.mocked(discoverSkillsFromGitHub).mockResolvedValue({
      skills: [discoveredSkill],
      resolvedBranch: 'main',
      hasMarketplace: false,
    });
    jest.mocked(installSkill).mockResolvedValue(undefined);
    jest.mocked(fetchSkillFolderHash).mockResolvedValue('new');
  });

  it('checks the whole inventory with source-qualified keys and persists explicit false', async () => {
    const otherKey = `github:other:repo/${skillName}`;
    const otherEntry: SkillLockEntry = {
      ...entry,
      sourceId: 'github:other:repo',
      source: 'other/repo',
    };
    jest.mocked(readLockFile).mockReturnValue({
      version: 2,
      skills: { [key]: entry, [otherKey]: otherEntry },
    });
    jest
      .mocked(checkForUpdate)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const progress = jest.fn<void, [SkillUpdateProgress]>();

    const result = await checkUpdates(progress);

    const updateMap = { [key]: false, [otherKey]: true };
    expect(result).toEqual({ success: true, data: updateMap });
    expect(checkForUpdate).toHaveBeenCalledTimes(2);
    expect(checkForUpdate).toHaveBeenNthCalledWith(1, skillName, entry);
    expect(checkForUpdate).toHaveBeenNthCalledWith(2, skillName, otherEntry);
    expect(JSON.parse(cachedStatus)).toEqual(updateMap);
    expect(progress.mock.calls.map(([event]) => event.status)).toEqual([
      'running',
      'complete',
    ]);
    expect(progress).toHaveBeenLastCalledWith(
      expect.objectContaining({ updateMap }),
    );
    expect(
      loadSkills().data?.find((skill) => skill.sourceId === sourceId)
        ?.updateAvailable,
    ).toBe(false);
  });

  it('reports a rejected check without clearing cached availability and permits retry', async () => {
    jest
      .mocked(checkForUpdate)
      .mockRejectedValueOnce(new Error('GitHub unavailable'));
    const progress = jest.fn<void, [SkillUpdateProgress]>();

    expect(await checkUpdates(progress)).toEqual({
      success: false,
      error: 'GitHub unavailable',
    });
    expect(writeFileSyncMock).not.toHaveBeenCalled();
    expect(loadSkills().data?.[0]?.updateAvailable).toBe(true);
    expect(progress).toHaveBeenLastCalledWith({
      operation: 'check-updates',
      status: 'error',
      message: 'GitHub unavailable',
    });

    jest.mocked(checkForUpdate).mockResolvedValueOnce(false);
    expect(await checkUpdates()).toEqual({
      success: true,
      data: { [key]: false },
    });
  });

  it.each(['builtin:app', 'builtin', 'builtin/app'])(
    'rejects built-in source %s before any mutation',
    async (builtInSource) => {
      expect(await updateSkill(builtInSource, skillName)).toEqual({
        success: false,
        error: 'Built-in skills cannot be updated.',
      });
      expect(readLockFile).not.toHaveBeenCalled();
      expect(fetchGitHubTree).not.toHaveBeenCalled();
      expect(rmSyncMock).not.toHaveBeenCalled();
      expect(installSkill).not.toHaveBeenCalled();
    },
  );

  it('rejects a missing lock entry without fetching or replacing content', async () => {
    jest.mocked(readLockFile).mockReturnValue({ version: 2, skills: {} });

    expect(await updateSkill(sourceId, skillName)).toEqual({
      success: false,
      error: 'Skill "my-skill" not found.',
    });
    expect(fetchGitHubTree).not.toHaveBeenCalled();
    expect(rmSyncMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('rejects an unsupported lock source without clearing its update flag', async () => {
    jest.mocked(parseGitHubSource).mockReturnValue(null);
    jest.mocked(readLockFile).mockReturnValue({
      version: 2,
      skills: {
        [key]: {
          ...entry,
          sourceType: 'url',
          source: 'https://example.com/skill',
        },
      },
    });

    expect(await updateSkill(sourceId, skillName)).toEqual({
      success: false,
      error: 'Invalid source in lock file.',
    });
    expect(parseGitHubSource).toHaveBeenCalledWith('https://example.com/skill');
    expect(fetchGitHubTree).not.toHaveBeenCalled();
    expect(rmSyncMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('reinstalls the selected skill, updates its lock, and clears only its cached flag', async () => {
    const otherKey = 'github:other:repo/my-skill';
    cachedStatus = JSON.stringify({ [key]: true, [otherKey]: true });

    expect(await updateSkill(sourceId, skillName)).toEqual({
      success: true,
      data: undefined,
    });

    expect(parseGitHubSource).toHaveBeenCalledWith(entry.source);
    expect(rmSyncMock).toHaveBeenCalledWith(skillDir, {
      recursive: true,
      force: true,
    });
    expect(installSkill).toHaveBeenCalledWith(
      'owner',
      'repo',
      'main',
      discoveredSkill,
      [],
      `/mock/data/skills/${sourceId}`,
      null,
    );
    expect(fetchSkillFolderHash).toHaveBeenCalledWith(
      'owner',
      'repo',
      discoveredSkill.sourcePath,
      'main',
    );
    expect(addLockEntry).toHaveBeenCalledWith(
      sourceId,
      skillName,
      expect.objectContaining({
        sourceId,
        source: entry.source,
        sourceType: entry.sourceType,
        sourceUrl: entry.sourceUrl,
        installedAt: entry.installedAt,
        skillPath: discoveredSkill.sourcePath,
        skillFolderHash: 'new',
      }),
    );
    expect(jest.mocked(addLockEntry).mock.calls[0]?.[2].updatedAt).toEqual(
      expect.any(String),
    );
    expect(JSON.parse(cachedStatus)).toEqual({
      [key]: false,
      [otherKey]: true,
    });
    expect(loadSkills().data?.[0]?.updateAvailable).toBe(false);
  });

  it('preserves cached availability and lock metadata when installation rejects', async () => {
    jest
      .mocked(installSkill)
      .mockRejectedValueOnce(new Error('Download failed'));

    expect(await updateSkill(sourceId, skillName)).toEqual({
      success: false,
      error: 'Download failed',
    });

    expect(addLockEntry).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
    expect(JSON.parse(cachedStatus)).toEqual({ [key]: true });
  });
});

describe('readSkillContent', () => {
  it('rejects sourceId with path traversal', () => {
    const result = readSkillContent('../../etc', 'skill');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid skill path.');
  });

  it('rejects skillName with path traversal', () => {
    const result = readSkillContent('github:owner:repo', '../secret');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid skill path.');
  });

  it('rejects "." as skillName', () => {
    const result = readSkillContent('github:owner:repo', '.');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid skill path.');
  });

  it('returns content for valid skill', () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue('---\nname: test\n---\n# Test');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { parseFrontmatterAndBody } = jest.requireMock('../lib/frontmatter');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    parseFrontmatterAndBody.mockReturnValue({
      frontmatter: { name: 'test' },
      body: '# Test',
    });

    const result = readSkillContent('github:owner:repo', 'my-skill');
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
  });

  it('returns error when SKILL.md does not exist', () => {
    existsSyncMock.mockReturnValue(false);

    const result = readSkillContent('github:owner:repo', 'nonexistent');
    expect(result.success).toBe(false);
    expect(result.error).toContain('SKILL.md not found');
  });
});

describe('saveCustomSkill', () => {
  it('rejects empty name', async () => {
    const result = await saveCustomSkill({
      name: '',
      description: 'desc',
      body: 'body',
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Skill name is required.');
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it.each([
    ['My-Skill', 'uppercase letters'],
    ['my_skill', 'underscores'],
    ['my skill', 'whitespace'],
  ])('rejects a name containing %s (%s)', async (name) => {
    const result = await saveCustomSkill({
      name,
      description: 'desc',
      body: 'body',
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'Skill name can only contain lowercase letters, numbers, and hyphens.',
    );
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('rejects a trailing hyphen with an actionable message', async () => {
    const result = await saveCustomSkill({
      name: 'my-skill-',
      description: 'desc',
      body: 'body',
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'Skill name must end with a lowercase letter or number.',
    );
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('rejects empty description', async () => {
    const result = await saveCustomSkill({
      name: 'my-skill',
      description: '   ',
      body: 'body',
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Skill description is required.');
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('creates a new custom skill with frontmatter and body', async () => {
    existsSyncMock.mockReturnValue(false);

    const result = await saveCustomSkill({
      name: 'my-skill',
      description: 'A test skill',
      body: '# Hello',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: 'my-skill' });
    }

    const skillMdCall = writeFileMock.mock.calls.find(
      ([filePath]) =>
        typeof filePath === 'string' && path.basename(filePath) === 'SKILL.md',
    );
    expect(skillMdCall).toBeDefined();
    if (!skillMdCall) throw new Error('SKILL.md write call missing');
    const writtenContent = skillMdCall[1];
    if (typeof writtenContent !== 'string') {
      throw new Error('Expected SKILL.md to be written as text.');
    }
    expect(writtenContent).toMatch(/^---\n/);
    expect(writtenContent).toContain('name: my-skill');
    expect(writtenContent).toContain('description: A test skill');
    expect(writtenContent).toContain('# Hello');
    expect(mkdirSyncMock).toHaveBeenCalled();
  });

  it('refuses to overwrite an existing custom skill on create', async () => {
    existsSyncMock.mockImplementation((p) => {
      const str = String(p);
      // The target skill directory already exists; source.json does too.
      if (str.endsWith('custom:app/my-skill')) return true;
      if (str.endsWith('source.json')) return true;
      return false;
    });

    const result = await saveCustomSkill({
      name: 'my-skill',
      description: 'desc',
      body: 'body',
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('A skill named "my-skill" already exists.');
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('writes extra metadata keys into the frontmatter', async () => {
    existsSyncMock.mockReturnValue(false);

    const result = await saveCustomSkill({
      name: 'meta-skill',
      description: 'desc',
      body: '# Body',
      extraMetadata: {
        version: '2',
        owner: 'platform',
        // reserved keys are dropped
        name: 'should-be-ignored',
        description: 'should-be-ignored',
        // whitespace key dropped
        ' bad key ': 'x',
        // empty value dropped
        keep: '',
      },
    });

    expect(result.success).toBe(true);
    const skillMdCall = writeFileMock.mock.calls.find(
      ([filePath]) =>
        typeof filePath === 'string' && path.basename(filePath) === 'SKILL.md',
    );
    expect(skillMdCall).toBeDefined();
    if (!skillMdCall) throw new Error('SKILL.md write call missing');
    const writtenContent = skillMdCall[1];
    if (typeof writtenContent !== 'string') {
      throw new Error('Expected SKILL.md to be written as text.');
    }
    expect(writtenContent).toContain('name: meta-skill');
    expect(writtenContent).toContain('description: desc');
    expect(writtenContent).toContain('version:');
    expect(writtenContent).toContain('owner: platform');
    expect(writtenContent).not.toMatch(/bad key/);
    expect(writtenContent).not.toMatch(/keep:/);
    // reserved keys must keep their canonical value, not the override
    expect(writtenContent).not.toContain('should-be-ignored');
  });

  it('preserves typed frontmatter when an update omits metadata', async () => {
    existsSyncMock.mockReturnValue(true);

    const result = await saveCustomSkill(
      {
        originalName: 'meta-skill',
        name: 'meta-skill',
        description: 'new description',
        body: '# New body',
      },
      {
        preservedMetadata: {
          name: 'meta-skill',
          description: 'old description',
          'user-invocable': false,
          priority: 2,
          tags: ['review', 'safe'],
          config: { nested: true },
        },
      },
    );

    expect(result.success).toBe(true);
    const skillMdCall = writeFileMock.mock.calls.find(
      ([filePath]) =>
        typeof filePath === 'string' && path.basename(filePath) === 'SKILL.md',
    );
    expect(skillMdCall).toBeDefined();
    if (!skillMdCall) throw new Error('SKILL.md write call missing');
    const writtenContent = skillMdCall[1];
    if (typeof writtenContent !== 'string') {
      throw new Error('Expected SKILL.md to be written as text.');
    }
    expect(writtenContent).toContain('user-invocable: false');
    expect(writtenContent).toContain('priority: 2');
    expect(writtenContent).toContain('tags:');
    expect(writtenContent).toContain('- review');
    expect(writtenContent).toContain('config:');
    expect(writtenContent).toContain('nested: true');
  });

  it('preserves untouched typed metadata from the SkillsTab save path after a description edit', async () => {
    existsSyncMock.mockReturnValue(true);

    const result = await saveCustomSkill({
      originalName: 'meta-skill',
      name: 'meta-skill',
      description: 'new description',
      body: '# Unchanged body',
      preservedMetadata: {
        'user-invocable': false,
        priority: 2,
        metadata: { internal: true },
        tags: ['review', 'safe'],
      },
    });

    expect(result.success).toBe(true);
    const skillMdCall = writeFileMock.mock.calls.find(
      ([filePath]) =>
        typeof filePath === 'string' && path.basename(filePath) === 'SKILL.md',
    );
    expect(skillMdCall).toBeDefined();
    if (!skillMdCall) throw new Error('SKILL.md write call missing');
    const writtenContent = skillMdCall[1];
    if (typeof writtenContent !== 'string') {
      throw new Error('Expected SKILL.md to be written as text.');
    }
    const frontmatterMatch = writtenContent.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      throw new Error('Expected written SKILL.md to contain frontmatter.');
    }
    const parsedFrontmatter: unknown = yaml.load(frontmatterMatch[1]);
    expect(parsedFrontmatter).toEqual({
      name: 'meta-skill',
      description: 'new description',
      'user-invocable': false,
      priority: 2,
      metadata: { internal: true },
      tags: ['review', 'safe'],
    });
  });

  it('renames an existing custom skill when originalName differs', async () => {
    existsSyncMock.mockImplementation((p) => {
      const str = String(p);
      if (str.endsWith('custom:app/old-name')) return true;
      if (str.endsWith('custom:app/new-name')) return false;
      if (str.endsWith('source.json')) return true;
      return false;
    });

    const result = await saveCustomSkill({
      name: 'new-name',
      originalName: 'old-name',
      description: 'desc',
      body: 'body',
    });
    expect(result.success).toBe(true);
    const oldDir = path.resolve('/mock/data/skills/custom:app/old-name');
    const newDir = path.resolve('/mock/data/skills/custom:app/new-name');
    const stagingDir = cpMock.mock.calls[0]?.[1];
    expect(stagingDir).toEqual(expect.stringContaining('.canopy-skill-stage-'));
    expect(cpMock).toHaveBeenCalledWith(
      oldDir,
      stagingDir,
      expect.objectContaining({ recursive: true, dereference: false }),
    );
    const backupDir = renameMock.mock.calls[0]?.[1];
    expect(renameMock).toHaveBeenNthCalledWith(1, oldDir, backupDir);
    expect(renameMock).toHaveBeenNthCalledWith(2, stagingDir, newDir);
    expect(writeFileMock).toHaveBeenCalledWith(
      path.join(String(stagingDir), 'SKILL.md'),
      expect.any(String),
      'utf-8',
    );
  });

  it('moves persisted remote metadata when a custom skill is renamed', async () => {
    const remote = {
      remoteId: '11111111-1111-4111-8111-111111111111',
      contentHash: 'hash-a',
      shareScope: 'team' as const,
      sharedAt: '2026-09-24T16:00:00.000Z',
    };
    let links: Record<string, typeof remote> = {
      'custom:app/old-name': remote,
    };
    existsSyncMock.mockImplementation((filePath) => {
      const value = String(filePath);
      if (value.endsWith('custom:app/old-name')) return true;
      if (value.endsWith('custom:app/new-name')) return false;
      return value.endsWith('source.json');
    });
    readFileSyncMock.mockImplementation((filePath) =>
      String(filePath).endsWith('.share-links.json')
        ? JSON.stringify(links)
        : '',
    );
    writeFileSyncMock.mockImplementation((filePath, value) => {
      if (!String(filePath).includes('.share-links.json')) return;
      if (typeof value !== 'string') throw new Error('Expected JSON text');
      links = JSON.parse(value) as Record<string, typeof remote>;
    });

    await expect(
      saveCustomSkill({
        name: 'new-name',
        originalName: 'old-name',
        description: 'desc',
        body: 'body',
      }),
    ).resolves.toMatchObject({ success: true });

    expect(links['custom:app/old-name']).toBeUndefined();
    expect(links['custom:app/new-name']).toEqual(remote);
  });

  it('replaces a staged SKILL.md symlink without writing its target', async () => {
    existsSyncMock.mockReturnValue(true);
    let stagedSkillMdIsSymlink = true;
    let externalTargetContent = 'outside content';

    rmMock.mockImplementation((filePath) => {
      if (
        typeof filePath === 'string' &&
        path.basename(filePath) === 'SKILL.md'
      ) {
        stagedSkillMdIsSymlink = false;
      }
      return Promise.resolve();
    });
    writeFileMock.mockImplementation((filePath) => {
      if (
        typeof filePath === 'string' &&
        path.basename(filePath) === 'SKILL.md' &&
        stagedSkillMdIsSymlink
      ) {
        externalTargetContent = 'overwritten';
      }
      return Promise.resolve();
    });

    const result = await saveCustomSkill({
      name: 'my-skill',
      originalName: 'my-skill',
      description: 'desc',
      body: 'body',
    });

    expect(result.success).toBe(true);
    const stagingDir = String(cpMock.mock.calls[0]?.[1]);
    expect(rmMock).toHaveBeenCalledWith(path.join(stagingDir, 'SKILL.md'), {
      recursive: true,
      force: true,
    });
    expect(externalTargetContent).toBe('outside content');
  });

  it('rejects rename when the original custom skill does not exist', async () => {
    existsSyncMock.mockImplementation((p) => {
      const str = String(p);
      if (str.endsWith('custom:app/old-name')) return false;
      if (str.endsWith('custom:app/new-name')) return false;
      if (str.endsWith('source.json')) return true;
      return false;
    });

    const result = await saveCustomSkill({
      name: 'new-name',
      originalName: 'old-name',
      description: 'desc',
      body: 'body',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Original skill "old-name" does not exist.');
    expect(renameSyncMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('rejects update when the original custom skill does not exist', async () => {
    existsSyncMock.mockImplementation((p) => {
      const str = String(p);
      if (str.endsWith('custom:app/my-skill')) return false;
      if (str.endsWith('source.json')) return true;
      return false;
    });

    const result = await saveCustomSkill({
      name: 'my-skill',
      originalName: 'my-skill',
      description: 'desc',
      body: 'body',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Original skill "my-skill" does not exist.');
    expect(renameSyncMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });
});

describe('removeSkill (custom source)', () => {
  it('removes a custom skill without touching the lock file', () => {
    existsSyncMock.mockReturnValue(true);
    readdirSyncMock.mockReturnValue(['other-skill']);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { removeLockEntry } = jest.requireMock('../skills/lock-file');

    const result = removeSkill('custom:app', 'my-skill');
    expect(result.success).toBe(true);
    expect(rmSyncMock).toHaveBeenCalledWith(
      path.resolve('/mock/data/skills/custom:app/my-skill'),
      { recursive: true, force: true },
    );
    expect(removeLockEntry).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Multi-file skill support
// ---------------------------------------------------------------------------

function dirent(name: string, isDir: boolean, symlink = false): fs.Dirent {
  return Object.assign(new fs.Dirent(), {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir && !symlink,
    isSymbolicLink: () => symlink,
  });
}

const CUSTOM_SKILL_DIR = path.resolve('/mock/data/skills/custom:app/my-skill');

function mapStagedPathToCustomSkill(filePath: fs.PathLike): string {
  if (typeof filePath !== 'string') {
    throw new Error('Expected a string path in the filesystem mock.');
  }
  const resolved = path.resolve(filePath);
  const sourceDir = path.dirname(CUSTOM_SKILL_DIR);
  const relative = path.relative(sourceDir, resolved);
  const [rootSegment, ...rest] = relative.split(path.sep);
  if (rootSegment?.startsWith('.canopy-skill-stage-')) {
    return path.join(CUSTOM_SKILL_DIR, ...rest);
  }
  return resolved;
}

function asyncStats(options: {
  file?: boolean;
  directory?: boolean;
  symlink?: boolean;
  size?: number;
}): fs.Stats {
  const stats = actualFs.statSync(__filename);
  return Object.assign(stats, {
    isFile: () => options.file ?? false,
    isDirectory: () => options.directory ?? false,
    isSymbolicLink: () => options.symlink ?? false,
    size: options.size ?? 0,
  });
}

function mockAsyncDirLayout(layout: Record<string, fs.Dirent[]>): void {
  readdirMock.mockImplementation((dirPath) => {
    const key = mapStagedPathToCustomSkill(dirPath);
    const entries = layout[key];
    if (!entries) throw new Error(`ENOENT: ${key}`);
    return Promise.resolve(entries);
  });
  opendirMock.mockImplementation(async (dirPath) => {
    const key = mapStagedPathToCustomSkill(dirPath);
    const entries = layout[key];
    if (!entries) throw new Error(`ENOENT: ${key}`);
    const actualFsp: typeof fsp = jest.requireActual('node:fs/promises');
    const directory = await actualFsp.opendir(__dirname);
    await directory.close();
    let index = 0;
    const read = jest.fn<Promise<fs.Dirent | null>, []>(() =>
      Promise.resolve(entries[index++] ?? null),
    );
    directoryReadMocks.push(read);
    Object.assign(directory, {
      read,
      close: jest.fn(() => Promise.resolve()),
    });
    return directory;
  });
}

async function mockReadableSkillFile(
  data: Buffer,
  totalSize = data.length,
): Promise<jest.Mock> {
  realpathMock.mockImplementation((filePath) =>
    Promise.resolve(path.resolve(String(filePath))),
  );
  lstatMock.mockImplementation((filePath) => {
    const resolved = path.resolve(String(filePath));
    return Promise.resolve(
      asyncStats({
        directory:
          resolved === path.resolve('/mock/data/skills/custom:app') ||
          resolved === CUSTOM_SKILL_DIR ||
          resolved === path.join(CUSTOM_SKILL_DIR, 'references'),
        file:
          resolved !== path.resolve('/mock/data/skills/custom:app') &&
          resolved !== CUSTOM_SKILL_DIR &&
          resolved !== path.join(CUSTOM_SKILL_DIR, 'references'),
      }),
    );
  });
  statMock.mockImplementation((filePath) =>
    Promise.resolve(
      path.resolve(String(filePath)) === CUSTOM_SKILL_DIR
        ? asyncStats({ directory: true })
        : asyncStats({ file: true, size: totalSize }),
    ),
  );

  const read = jest.fn(
    (buffer: Buffer, offset: number, length: number, position: number) => {
      const chunk = data.subarray(position, position + length);
      chunk.copy(buffer, offset);
      return Promise.resolve({ bytesRead: chunk.length, buffer });
    },
  );
  const actualFsp: typeof fsp = jest.requireActual('node:fs/promises');
  const fileHandle = await actualFsp.open(__filename, 'r');
  await fileHandle.close();
  Object.assign(fileHandle, {
    stat: jest.fn(() =>
      Promise.resolve(asyncStats({ file: true, size: totalSize })),
    ),
    read,
    close: jest.fn(() => Promise.resolve()),
  });
  openMock.mockResolvedValue(fileHandle);
  return read;
}

describe('listSkillFiles', () => {
  it('rejects sourceId with path traversal', async () => {
    const result = await listSkillFiles('../../etc', 'my-skill');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid skill path.');
  });

  it('returns SKILL.md first, recurses into subdirectories, and skips dot entries', async () => {
    statMock.mockResolvedValue(asyncStats({ directory: true }));
    lstatMock.mockResolvedValue(asyncStats({ file: true }));
    mockAsyncDirLayout({
      [CUSTOM_SKILL_DIR]: [
        dirent('zeta.md', false),
        dirent('SKILL.md', false),
        dirent('references', true),
        dirent('.git', true),
      ],
      [path.join(CUSTOM_SKILL_DIR, 'references')]: [dirent('api.md', false)],
    });

    const result = await listSkillFiles('custom:app', 'my-skill');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data?.files).toEqual([
        'SKILL.md',
        'references/api.md',
        'zeta.md',
      ]);
      expect(result.data?.truncated).toBe(false);
    }
  }, 15_000);

  it('stops listing after the supporting-file cap', async () => {
    statMock.mockResolvedValue(asyncStats({ directory: true }));
    lstatMock.mockResolvedValue(asyncStats({ file: true }));
    mockAsyncDirLayout({
      [CUSTOM_SKILL_DIR]: Array.from({ length: 600 }, (_, index) =>
        dirent(`file-${String(index).padStart(3, '0')}.md`, false),
      ),
    });

    const result = await listSkillFiles('custom:app', 'my-skill');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data?.files).toHaveLength(501);
      expect(result.data?.files[0]).toBe('SKILL.md');
      expect(result.data?.truncated).toBe(true);
    }
  });

  it('stops reading directory entries when the visit budget is exhausted', async () => {
    statMock.mockResolvedValue(asyncStats({ directory: true }));
    lstatMock.mockResolvedValue(asyncStats({ file: true }));
    mockAsyncDirLayout({
      [CUSTOM_SKILL_DIR]: Array.from({ length: 2_100 }, (_, index) =>
        dirent(`.hidden-${index}`, false),
      ),
    });

    const result = await listSkillFiles('custom:app', 'my-skill');

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      files: ['SKILL.md'],
      truncated: true,
    });
    expect(directoryReadMocks[0]).toHaveBeenCalledTimes(2_001);
  });

  it.each([
    [
      'listing files',
      (): ReturnType<typeof listSkillFiles> =>
        listSkillFiles('custom:app', 'my-skill'),
    ],
    [
      'reading a file',
      (): ReturnType<typeof readSkillFile> =>
        readSkillFile('custom:app', 'my-skill', 'outside.txt'),
    ],
  ])('rejects a symlinked skill root when %s', async (_operation, run) => {
    lstatMock.mockResolvedValue(asyncStats({ symlink: true }));

    const result = await run();

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid skill path.');
    expect(openMock).not.toHaveBeenCalled();
  });

  it('fails when the skill directory does not exist', async () => {
    statMock.mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );
    const result = await listSkillFiles('custom:app', 'my-skill');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Skill "my-skill" not found.');
  });
});

describe('readSkillFile', () => {
  it.each([['../evil.md'], ['a/../../evil.md'], ['/abs/path.md'], ['a\\b.md']])(
    'rejects traversal-style file path %s',
    async (filePath) => {
      const result = await readSkillFile('custom:app', 'my-skill', filePath);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid file path.');
    },
  );

  it.each([['.env'], ['references/.secret'], ['.git/config']])(
    'rejects hidden file path %s at the service boundary',
    async (filePath) => {
      const result = await readSkillFile('custom:app', 'my-skill', filePath);
      expect(result).toEqual({
        success: false,
        error: 'Invalid file path.',
      });
      expect(openMock).not.toHaveBeenCalled();
    },
  );

  it('returns text file content', async () => {
    await mockReadableSkillFile(Buffer.from('# API docs'));

    const result = await readSkillFile(
      'custom:app',
      'my-skill',
      'references/api.md',
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        content: '# API docs',
        truncated: false,
        binary: false,
      });
    }
  });

  it('preserves a UTF-8 BOM when reading text for round-trip editing', async () => {
    await mockReadableSkillFile(
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('# API docs'),
      ]),
    );

    const result = await readSkillFile(
      'custom:app',
      'my-skill',
      'references/api.md',
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        content: '\uFEFF# API docs',
        truncated: false,
        binary: false,
      });
    }
  });

  it('flags files containing NUL bytes without returning content', async () => {
    await mockReadableSkillFile(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
    );

    const result = await readSkillFile('custom:app', 'my-skill', 'logo.png');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        content: '',
        truncated: false,
        binary: true,
      });
    }
  });

  it('flags invalid UTF-8 as binary so saving preserves its bytes', async () => {
    await mockReadableSkillFile(Buffer.from([0xc3, 0x28]));

    const result = await readSkillFile('custom:app', 'my-skill', 'invalid.txt');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        content: '',
        truncated: false,
        binary: true,
      });
    }
  });

  it('reads at most the preview limit for oversized files', async () => {
    const preview = Buffer.alloc(512 * 1024, 0x61);
    const read = await mockReadableSkillFile(
      preview,
      preview.length + 1_000_000,
    );

    const result = await readSkillFile('custom:app', 'my-skill', 'large.txt');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data?.content).toHaveLength(512 * 1024);
      expect(result.data?.truncated).toBe(true);
      expect(result.data?.binary).toBe(false);
    }
    expect(read).toHaveBeenCalledWith(expect.any(Buffer), 0, 512 * 1024, 0);
  });

  it('rejects a symlinked file without opening it', async () => {
    statMock.mockResolvedValue(asyncStats({ directory: true }));
    lstatMock.mockImplementation((filePath) =>
      Promise.resolve(
        path.resolve(String(filePath)) ===
          path.join(CUSTOM_SKILL_DIR, 'outside.txt')
          ? asyncStats({ symlink: true })
          : asyncStats({ directory: true }),
      ),
    );

    const result = await readSkillFile('custom:app', 'my-skill', 'outside.txt');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid file path.');
    expect(openMock).not.toHaveBeenCalled();
  });

  it('fails when the file is missing', async () => {
    statMock.mockResolvedValue(asyncStats({ directory: true }));
    lstatMock.mockImplementation((filePath) => {
      if (
        path.resolve(String(filePath)) ===
        path.join(CUSTOM_SKILL_DIR, 'missing.md')
      ) {
        return Promise.reject(
          Object.assign(new Error('missing'), { code: 'ENOENT' }),
        );
      }
      return Promise.resolve(asyncStats({ directory: true }));
    });
    const result = await readSkillFile('custom:app', 'my-skill', 'missing.md');
    expect(result.success).toBe(false);
    expect(result.error).toBe('File "missing.md" not found.');
  });
});

describe('saveCustomSkill (multi-file sync)', () => {
  it('rejects a symlinked skill root before writing or deleting files', async () => {
    existsSyncMock.mockReturnValue(true);
    lstatMock.mockImplementation((filePath) => {
      const resolved = path.resolve(String(filePath));
      if (resolved === path.resolve('/mock/data/skills/custom:app')) {
        return Promise.resolve(asyncStats({ directory: true }));
      }
      if (resolved === CUSTOM_SKILL_DIR) {
        return Promise.resolve(asyncStats({ symlink: true }));
      }
      return Promise.reject(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );
    });

    const result = await saveCustomSkill({
      name: 'my-skill',
      originalName: 'my-skill',
      description: 'desc',
      body: 'body',
      files: [{ path: 'notes.md', content: 'notes' }],
    });

    expect(result).toEqual({
      success: false,
      error: 'Skill directory is unsafe to modify.',
    });
    expect(writeFileSyncMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid supporting file path before writing anything', async () => {
    const result = await saveCustomSkill({
      name: 'my-skill',
      description: 'desc',
      body: 'body',
      files: [{ path: '../evil.md', content: 'x' }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'File names can only contain letters, numbers, dots, hyphens, and underscores, and must start with a letter or number.',
    );
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('rejects a root-level skill.md supporting file (reserved, case-insensitive)', async () => {
    const result = await saveCustomSkill({
      name: 'my-skill',
      description: 'desc',
      body: 'body',
      files: [{ path: 'skill.md', content: 'x' }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('SKILL.md is reserved for the main skill file.');
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('rejects supporting files nested beneath SKILL.md before staging', async () => {
    const result = await saveCustomSkill({
      name: 'my-skill',
      description: 'desc',
      body: 'body',
      files: [{ path: 'SKILL.md/notes.txt', content: 'x' }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('SKILL.md is reserved for the main skill file.');
    expect(cpMock).not.toHaveBeenCalled();
    expect(mkdirMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('rejects case-insensitive duplicate file paths', async () => {
    const result = await saveCustomSkill({
      name: 'my-skill',
      description: 'desc',
      body: 'body',
      files: [
        { path: 'Notes.md', content: 'a' },
        { path: 'notes.md', content: 'b' },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Duplicate file path "notes.md".');
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('aligns existing supporting-file casing before writing', async () => {
    existsSyncMock.mockReturnValue(true);
    let casingAligned = false;
    readdirMock.mockImplementation((dirPath) => {
      const resolved = mapStagedPathToCustomSkill(dirPath);
      if (resolved !== CUSTOM_SKILL_DIR) {
        throw new Error(`ENOENT: ${resolved}`);
      }
      return Promise.resolve([
        dirent('SKILL.md', false),
        dirent(casingAligned ? 'notes.md' : 'Notes.md', false),
      ]);
    });
    renameMock.mockImplementation((_from, to) => {
      if (
        mapStagedPathToCustomSkill(to) ===
        path.join(CUSTOM_SKILL_DIR, 'notes.md')
      ) {
        casingAligned = true;
      }
      return Promise.resolve();
    });
    lstatMock.mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );

    const result = await saveCustomSkill({
      name: 'my-skill',
      originalName: 'my-skill',
      description: 'desc',
      body: 'body',
      files: [{ path: 'notes.md', content: 'updated' }],
    });

    expect(result.success).toBe(true);
    const stagingDir = String(cpMock.mock.calls[0]?.[1]);
    const temporaryPath = renameMock.mock.calls[0]?.[1];
    expect(renameMock).toHaveBeenNthCalledWith(
      1,
      path.join(stagingDir, 'Notes.md'),
      expect.stringContaining('.canopy-case-rename-'),
    );
    expect(renameMock).toHaveBeenNthCalledWith(
      2,
      temporaryPath,
      path.join(stagingDir, 'notes.md'),
    );
    expect(rmMock).not.toHaveBeenCalledWith(path.join(stagingDir, 'Notes.md'), {
      force: true,
    });
  });

  it('writes supporting files and deletes files omitted from the set', async () => {
    existsSyncMock.mockReturnValue(true);
    lstatMock.mockImplementation((filePath) => {
      const resolved = mapStagedPathToCustomSkill(filePath);
      if (resolved === path.join(CUSTOM_SKILL_DIR, 'references')) {
        return Promise.resolve(asyncStats({ directory: true }));
      }
      return Promise.reject(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );
    });
    mockAsyncDirLayout({
      [CUSTOM_SKILL_DIR]: [
        dirent('SKILL.md', false),
        dirent('stale.md', false),
        dirent('references', true),
      ],
      [path.join(CUSTOM_SKILL_DIR, 'references')]: [dirent('api.md', false)],
    });

    const result = await saveCustomSkill({
      name: 'my-skill',
      originalName: 'my-skill',
      description: 'desc',
      body: 'body',
      files: [{ path: 'references/api.md', content: '# API' }],
    });

    expect(result.success).toBe(true);
    const stagingDir = String(cpMock.mock.calls[0]?.[1]);
    const apiWrite = writeFileMock.mock.calls.find(
      ([filePath]) =>
        filePath === path.join(stagingDir, 'references', 'api.md'),
    );
    expect(apiWrite).toBeDefined();
    expect(apiWrite?.[1]).toBe('# API');
    expect(rmMock).toHaveBeenCalledWith(path.join(stagingDir, 'stale.md'), {
      force: true,
    });
    // SKILL.md itself is never part of the sync deletion.
    expect(rmMock).not.toHaveBeenCalledWith(path.join(stagingDir, 'SKILL.md'), {
      force: true,
    });
  });

  it('keeps a new file beneath an existing case-differing directory', async () => {
    existsSyncMock.mockReturnValue(true);
    lstatMock.mockImplementation((filePath) => {
      const resolved = mapStagedPathToCustomSkill(filePath);
      return resolved.toLowerCase() ===
        path.join(CUSTOM_SKILL_DIR, 'docs').toLowerCase()
        ? Promise.resolve(asyncStats({ directory: true }))
        : Promise.reject(
            Object.assign(new Error('missing'), { code: 'ENOENT' }),
          );
    });
    mockAsyncDirLayout({
      [CUSTOM_SKILL_DIR]: [dirent('SKILL.md', false), dirent('docs', true)],
      [path.join(CUSTOM_SKILL_DIR, 'docs')]: [],
    });

    const result = await saveCustomSkill({
      name: 'my-skill',
      originalName: 'my-skill',
      description: 'desc',
      body: 'body',
      files: [{ path: 'Docs/new.md', content: 'new content' }],
    });

    expect(result.success).toBe(true);
    const stagingDir = String(cpMock.mock.calls[0]?.[1]);
    expect(writeFileMock).toHaveBeenCalledWith(
      path.join(stagingDir, 'Docs', 'new.md'),
      'new content',
      'utf-8',
    );
    expect(rmMock).not.toHaveBeenCalledWith(
      path.join(stagingDir, 'docs'),
      expect.objectContaining({ recursive: true }),
    );
  });

  it('removes hidden entries and symlinks omitted from the exact file set', async () => {
    existsSyncMock.mockReturnValue(true);
    mockAsyncDirLayout({
      [CUSTOM_SKILL_DIR]: [
        dirent('SKILL.md', false),
        dirent('.env', false),
        dirent('external', false, true),
        dirent('.cache', true),
      ],
      [path.join(CUSTOM_SKILL_DIR, '.cache')]: [dirent('stale.json', false)],
    });

    const result = await saveCustomSkill({
      name: 'my-skill',
      originalName: 'my-skill',
      description: 'desc',
      body: 'body',
      files: [],
    });

    expect(result.success).toBe(true);
    const stagingDir = String(cpMock.mock.calls[0]?.[1]);
    expect(rmMock).toHaveBeenCalledWith(path.join(stagingDir, '.env'), {
      force: true,
    });
    expect(rmMock).toHaveBeenCalledWith(path.join(stagingDir, 'external'), {
      force: true,
    });
    expect(rmMock).toHaveBeenCalledWith(path.join(stagingDir, '.cache'), {
      recursive: true,
      force: true,
    });
  });

  it('removes a stale file before creating a directory at the same path', async () => {
    const docsPath = path.join(CUSTOM_SKILL_DIR, 'docs');
    existsSyncMock.mockImplementation((filePath) => {
      const resolved = path.resolve(String(filePath));
      return (
        resolved === CUSTOM_SKILL_DIR ||
        resolved === docsPath ||
        resolved.endsWith('source.json')
      );
    });
    lstatMock.mockImplementation((filePath) => {
      const resolved = mapStagedPathToCustomSkill(filePath);
      return resolved === docsPath
        ? Promise.resolve(asyncStats({ file: true }))
        : Promise.reject(
            Object.assign(new Error('missing'), { code: 'ENOENT' }),
          );
    });
    mockAsyncDirLayout({
      [CUSTOM_SKILL_DIR]: [dirent('SKILL.md', false), dirent('docs', true)],
      [docsPath]: [dirent('note.md', false)],
    });

    const result = await saveCustomSkill({
      name: 'my-skill',
      originalName: 'my-skill',
      description: 'desc',
      body: 'body',
      files: [{ path: 'docs/note.md', content: 'note' }],
    });

    expect(result.success).toBe(true);
    const stagingDir = String(cpMock.mock.calls[0]?.[1]);
    const stagedDocsPath = path.join(stagingDir, 'docs');
    expect(rmMock).toHaveBeenCalledWith(stagedDocsPath, {
      recursive: true,
      force: true,
    });
    expect(writeFileMock).toHaveBeenCalledWith(
      path.join(stagedDocsPath, 'note.md'),
      'note',
      'utf-8',
    );
  });

  it('removes a stale directory before creating a file at the same path', async () => {
    const docsPath = path.join(CUSTOM_SKILL_DIR, 'docs');
    existsSyncMock.mockImplementation((filePath) => {
      const resolved = path.resolve(String(filePath));
      return (
        resolved === CUSTOM_SKILL_DIR ||
        resolved === docsPath ||
        resolved.endsWith('source.json')
      );
    });
    lstatMock.mockResolvedValue(asyncStats({ directory: true }));
    mockAsyncDirLayout({
      [CUSTOM_SKILL_DIR]: [dirent('SKILL.md', false), dirent('docs', false)],
    });

    const result = await saveCustomSkill({
      name: 'my-skill',
      originalName: 'my-skill',
      description: 'desc',
      body: 'body',
      files: [{ path: 'docs', content: 'now a file' }],
    });

    expect(result.success).toBe(true);
    const stagingDir = String(cpMock.mock.calls[0]?.[1]);
    const stagedDocsPath = path.join(stagingDir, 'docs');
    expect(rmMock).toHaveBeenCalledWith(stagedDocsPath, {
      recursive: true,
      force: true,
    });
    expect(writeFileMock).toHaveBeenCalledWith(
      stagedDocsPath,
      'now a file',
      'utf-8',
    );
  });

  it('keeps files sent without content (binary placeholders) as-is', async () => {
    existsSyncMock.mockReturnValue(true);
    mockAsyncDirLayout({
      [CUSTOM_SKILL_DIR]: [
        dirent('SKILL.md', false),
        dirent('logo.png', false),
      ],
    });

    const result = await saveCustomSkill({
      name: 'my-skill',
      originalName: 'my-skill',
      description: 'desc',
      body: 'body',
      files: [{ path: 'logo.png' }],
    });

    expect(result.success).toBe(true);
    const stagingDir = String(cpMock.mock.calls[0]?.[1]);
    const logoWrite = writeFileMock.mock.calls.find(
      ([filePath]) => filePath === path.join(stagingDir, 'logo.png'),
    );
    expect(logoWrite).toBeUndefined();
    expect(rmMock).not.toHaveBeenCalledWith(path.join(stagingDir, 'logo.png'), {
      force: true,
    });
  });

  it('leaves the live skill untouched when staging a supporting file fails', async () => {
    existsSyncMock.mockReturnValue(true);
    mockAsyncDirLayout({
      [CUSTOM_SKILL_DIR]: [
        dirent('SKILL.md', false),
        dirent('notes.md', false),
      ],
    });
    writeFileMock.mockImplementation((filePath) => {
      if (typeof filePath !== 'string') {
        throw new Error('Expected a string path in the filesystem mock.');
      }
      return path.basename(filePath) === 'notes.md'
        ? Promise.reject(new Error('disk full'))
        : Promise.resolve();
    });

    const result = await saveCustomSkill({
      name: 'my-skill',
      originalName: 'my-skill',
      description: 'updated',
      body: 'updated body',
      files: [{ path: 'notes.md', content: 'updated notes' }],
    });

    expect(result).toEqual({ success: false, error: 'disk full' });
    expect(renameMock).not.toHaveBeenCalled();
    const stagingDir = String(cpMock.mock.calls[0]?.[1]);
    expect(rmMock).toHaveBeenCalledWith(stagingDir, {
      recursive: true,
      force: true,
    });
  });

  it('restores the original skill when the final staged swap fails', async () => {
    existsSyncMock.mockReturnValue(true);
    renameMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('swap failed'))
      .mockResolvedValueOnce(undefined);

    const result = await saveCustomSkill({
      name: 'my-skill',
      originalName: 'my-skill',
      description: 'updated',
      body: 'updated body',
    });

    expect(result).toEqual({ success: false, error: 'swap failed' });
    const stagingDir = String(cpMock.mock.calls[0]?.[1]);
    const backupDir = String(renameMock.mock.calls[0]?.[1]);
    expect(renameMock).toHaveBeenNthCalledWith(1, CUSTOM_SKILL_DIR, backupDir);
    expect(renameMock).toHaveBeenNthCalledWith(2, stagingDir, CUSTOM_SKILL_DIR);
    expect(renameMock).toHaveBeenNthCalledWith(3, backupDir, CUSTOM_SKILL_DIR);
  });
});
