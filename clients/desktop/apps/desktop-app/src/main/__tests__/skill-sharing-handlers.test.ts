const mockCommitRemoval = jest.fn<Promise<void>, []>(() => Promise.resolve());
const mockInstallIds = jest.fn<Promise<Set<string>>, [string]>(() =>
  Promise.resolve(new Set()),
);
let mockPrimaryInstallIds: Set<string> | undefined;
const mockSkillContextEnabled = jest.fn(() => false);
const mockAssertStored = jest.fn<Promise<void>, [string]>(() =>
  Promise.resolve(),
);
const mockRollbackInstall = jest.fn<Promise<void>, []>(() => Promise.resolve());
const mockAssertSnapshot = jest.fn<Promise<void>, []>(() => Promise.resolve());
const mockRecordInstall = jest.fn<
  Promise<(() => Promise<void>) | undefined>,
  [unknown, string]
>(() => Promise.resolve(mockRollbackInstall));
const mockCopyOrigin = jest.fn<Promise<void>, [string, string]>(() =>
  Promise.resolve(),
);
const mockHasReceipt = jest.fn<Promise<boolean>, [string]>(() =>
  Promise.resolve(false),
);
const mockGetShared = jest.fn<Promise<unknown>, [string]>();
const mockGetPublicShare = jest.fn<Promise<unknown>, [string]>();
const mockGetPublicCollection = jest.fn<Promise<unknown>, [string]>();
/** A canonical share id, as the catalog and share links supply. */
const PUBLIC_SHARE_ID = '746bdf58-809f-5ef4-8f6c-e1fb229e5d21';
const PUBLIC_COLLECTION_ID = 'fa300900-0000-4000-8000-000000000012';
jest.mock('../canopy-cloud/public-share-client', () => ({
  getPublicSkillShareSnapshot: (id: string): Promise<unknown> =>
    mockGetPublicShare(id),
  getPublicCollectionShareSnapshot: (id: string): Promise<unknown> =>
    mockGetPublicCollection(id),
}));
jest.mock('../skills/resource-lanes', () => ({
  skillResourceContextEnabled: (): boolean => mockSkillContextEnabled(),
  skillContextSnapshot: (): Promise<string> => Promise.resolve('context-a'),
  assertSkillContextSnapshot: (): Promise<void> => mockAssertSnapshot(),
}));
jest.mock('../skills/skill-install-context', () => ({
  prepareSkillUninstall: (): Promise<() => Promise<void>> =>
    Promise.resolve(mockCommitRemoval),
  getSharedSkillInstallIds: (
    id: string,
    primaryOnly = false,
  ): Promise<Set<string>> =>
    primaryOnly && mockPrimaryInstallIds
      ? Promise.resolve(mockPrimaryInstallIds)
      : mockInstallIds(id),
  assertStoredSkillContext: (id: string): Promise<void> => mockAssertStored(id),
  recordSharedSkillInstall: (
    detail: unknown,
    id: string,
  ): Promise<(() => Promise<void>) | undefined> =>
    mockRecordInstall(detail, id),
  copySkillInstallOrigin: (
    source: string,
    destination: string,
  ): Promise<void> => mockCopyOrigin(source, destination),
  hasSkillInstallReceipt: (localId: string): Promise<boolean> =>
    mockHasReceipt(localId),
}));
jest.mock('../skills/canopy-server-client', () => ({
  getSharedSkill: (id: string): Promise<unknown> => mockGetShared(id),
}));
jest.mock('../canopy-cloud/shared-item-subscriptions', () => ({
  recordSharedItemInstall: jest.fn(),
  recordSharedItemLocalUninstall: jest.fn(),
}));
jest.mock('node:fs/promises', () => {
  const actual: typeof fsp = jest.requireActual('node:fs/promises');
  return {
    ...actual,
    rename: jest.fn(actual.rename),
    // Native filesystem errors belong to Node's realm, not Jest's Error realm.
    lstat: async (file: fs.PathLike): Promise<fs.Stats> => {
      try {
        return await actual.lstat(file);
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error)
          throw Object.assign(new Error('Filesystem operation failed'), {
            code: error.code,
          });
        throw error;
      }
    },
  };
});
import { CanopyCloudClientError } from '../canopy-cloud/client';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  PublicShareSkillOrigin,
  WriteRawSkillRequest,
} from '@canopy/desktop-shared/types/skills';

let tempDir = '';

jest.mock('../skills/paths', () => ({
  BUILTIN_SOURCE_ID: 'builtin:app',
  CUSTOM_SOURCE_ID: 'custom:app',
  deriveSourceId: jest.fn(),
  getSkillDir: jest.fn((sourceId: string, skillName: string) =>
    path.join(tempDir, 'skills', sourceId, skillName),
  ),
  getSkillsRootDir: jest.fn(() => path.join(tempDir, 'skills')),
  getSourceDir: jest.fn((sourceId: string) =>
    path.join(tempDir, 'skills', sourceId),
  ),
  getSourceMetadataPath: jest.fn((sourceId: string) =>
    path.join(tempDir, 'skills', sourceId, 'source.json'),
  ),
  isBuiltinSourceId: jest.fn((sourceId: string) => sourceId === 'builtin:app'),
  isCustomSourceId: jest.fn((sourceId: string) => sourceId === 'custom:app'),
}));

jest.mock('../skills/installer', () => ({
  installSkill: jest.fn(),
  sanitizeName: (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unnamed-skill',
}));

jest.mock('../skills/skill-discovery', () => ({
  discoverSkillsFromGitHub: jest.fn(),
  fetchGitHubTree: jest.fn(),
  getGitHubToken: jest.fn(),
}));

jest.mock('../skills/risk', () => ({
  fetchRiskAssessment: jest.fn(),
}));

jest.mock('../skills/lock-file', () => ({
  addLockEntry: jest.fn(),
  checkForUpdate: jest.fn(),
  fetchSkillFolderHash: jest.fn(),
  getLockKey: jest.fn(
    (sourceId: string, skillName: string) => `${sourceId}/${skillName}`,
  ),
  parseLockKey: jest.fn((key: string) => {
    const slash = key.lastIndexOf('/');
    return { sourceId: key.slice(0, slash), skillName: key.slice(slash + 1) };
  }),
  readLockFile: jest.fn(() => ({ version: 2, skills: {} })),
  removeLockEntry: jest.fn(),
}));

jest.mock('../pipelines/config-paths', () => ({
  getBundledSkillDir: jest.fn((skillName: string) =>
    path.join(tempDir, 'bundled-skills', skillName),
  ),
  getBundledSkillsDir: jest.fn(() => path.join(tempDir, 'bundled-skills')),
}));

import { readLockFile } from '../skills/lock-file';
import {
  readRawSkill,
  removeSkill,
  removeSkillForContext,
  writeRawSkill,
  writeRawSkillForContext,
  saveCustomSkill,
} from '../skills/skill-service';
import {
  recordSharedItemInstall,
  recordSharedItemLocalUninstall,
} from '../canopy-cloud/shared-item-subscriptions';

const mockRecordItemInstall = jest.mocked(recordSharedItemInstall);
const mockRecordItemUninstall = jest.mocked(recordSharedItemLocalUninstall);

describe('shared skill raw-byte helpers', () => {
  beforeEach(() => {
    jest
      .mocked(fsp.rename)
      .mockReset()
      .mockImplementation(
        jest.requireActual<typeof fsp>('node:fs/promises').rename,
      );
    mockInstallIds.mockReset().mockResolvedValue(new Set());
    mockPrimaryInstallIds = undefined;
    mockGetPublicShare.mockReset();
    mockGetPublicCollection.mockReset();
    mockGetShared.mockReset();
    mockHasReceipt.mockReset().mockResolvedValue(false);
    mockCopyOrigin.mockReset().mockResolvedValue(undefined);
    mockSkillContextEnabled.mockReturnValue(false);
    mockAssertStored.mockReset().mockResolvedValue(undefined);
    mockRecordInstall.mockReset().mockResolvedValue(mockRollbackInstall);
    mockRollbackInstall.mockClear();
    mockAssertSnapshot.mockReset().mockResolvedValue(undefined);
    mockRecordItemInstall.mockReset();
    mockRecordItemUninstall.mockReset();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-skills-'));
    jest.mocked(readLockFile).mockReturnValue({ version: 2, skills: {} });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads exact custom SKILL.md bytes from the renderer skill id shape', async () => {
    const rawSkill = '---\nname: helper\n---\n\n# Helper\n';
    const skillDir = path.join(tempDir, 'skills', 'custom:app', 'helper');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), rawSkill, 'utf-8');

    await expect(readRawSkill('custom:app/helper')).resolves.toBe(rawSkill);
  });

  it('reads a lock-backed local-filesystem SKILL.md from installed storage', async () => {
    const sourceId = 'local:release-fixture';
    const skillName = 'release-notes';
    const rawSkill = '---\nname: release-notes\n---\n\n# Local release notes\n';
    const skillDir = path.join(tempDir, 'skills', sourceId, skillName);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), rawSkill, 'utf-8');
    jest.mocked(readLockFile).mockReturnValue({
      version: 2,
      skills: {
        [`${sourceId}/${skillName}`]: {
          sourceId,
          source: '/fixtures/release-notes',
          sourceType: 'local',
          sourceUrl: 'file:///fixtures/release-notes',
          skillPath: '.',
          skillFolderHash: '',
          installedAt: '2026-09-24T00:00:00.000Z',
          updatedAt: '2026-09-24T00:00:00.000Z',
        },
      },
    });

    await expect(readRawSkill(`${sourceId}/${skillName}`)).resolves.toBe(
      rawSkill,
    );
  });

  it('reads exact builtin SKILL.md bytes from the bundled resources tree', async () => {
    const rawSkill = '---\nname: review\n---\n\n# Bundled review\r\n';
    const skillDir = path.join(tempDir, 'bundled-skills', 'review');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), rawSkill, 'utf-8');

    await expect(readRawSkill('builtin:app/review')).resolves.toBe(rawSkill);
  });

  it('rejects unknown-source and path-traversal raw skill ids', async () => {
    await expect(readRawSkill('custom:app/../review')).rejects.toThrow(
      'Invalid skill id.',
    );
    await expect(readRawSkill('builtin:app/../review')).rejects.toThrow(
      'Invalid skill id.',
    );
    await expect(readRawSkill('plugin:foo/review')).rejects.toThrow(
      'Invalid skill id.',
    );
  });

  it('rejects a symlinked builtin skill directory', async () => {
    const outsideDir = path.join(tempDir, 'outside-review');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'SKILL.md'), '# Outside\n', 'utf-8');
    fs.mkdirSync(path.join(tempDir, 'bundled-skills'), { recursive: true });
    fs.symlinkSync(
      outsideDir,
      path.join(tempDir, 'bundled-skills', 'review'),
      'dir',
    );

    await expect(readRawSkill('builtin:app/review')).rejects.toThrow(
      'Invalid skill id.',
    );
  });

  it('rejects a symlinked builtin SKILL.md', async () => {
    const outsideFile = path.join(tempDir, 'outside-skill.md');
    fs.writeFileSync(outsideFile, '# Outside\n', 'utf-8');
    const skillDir = path.join(tempDir, 'bundled-skills', 'review');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.symlinkSync(outsideFile, path.join(skillDir, 'SKILL.md'));

    await expect(readRawSkill('builtin:app/review')).rejects.toThrow(
      'Skill "builtin:app/review" not found.',
    );
  });

  it('writes exact raw bytes and returns a custom:app local skill id', () => {
    const rawSkill = '---\nname: helper\n---\n\nBody\n';
    const written = writeRawSkill({ skillName: 'helper', rawSkill });

    expect(written).toEqual({
      skillId: 'custom:app/helper',
      skillName: 'helper',
    });
    expect(
      fs.readFileSync(
        path.join(tempDir, 'skills', 'custom:app', 'helper', 'SKILL.md'),
        'utf-8',
      ),
    ).toBe(rawSkill);
  });
  it('records provenance before writing freshly authorized remote bytes', async () => {
    mockSkillContextEnabled.mockReturnValue(true);
    const detail = {
      id: 'remote-a',
      name: 'helper',
      rawSkill: '# Trusted remote',
    };
    mockGetShared.mockResolvedValue(detail);
    mockRecordInstall.mockImplementation(
      (_detail, id): Promise<(() => Promise<void>) | undefined> => {
        expect(id).toBe('custom:app/helper');
        expect(
          fs.existsSync(
            path.join(tempDir, 'skills', 'custom:app', 'helper', 'SKILL.md'),
          ),
        ).toBe(false);
        return Promise.resolve(undefined);
      },
    );
    const result = await writeRawSkillForContext({
      skillName: 'forged',
      rawSkill: '# Forged',
      sourceRemoteId: 'remote-a',
    });
    expect(result.skillId).toBe('custom:app/helper');
    expect(
      fs.readFileSync(
        path.join(tempDir, 'skills', 'custom:app', 'helper', 'SKILL.md'),
        'utf8',
      ),
    ).toBe('# Trusted remote');
    expect(mockRecordInstall).toHaveBeenCalledWith(detail, 'custom:app/helper');
  });
  it.each([false, true])(
    'preserves identical personal skills during raw import with enforcement %s',
    async (enabled): Promise<void> => {
      mockSkillContextEnabled.mockReturnValue(enabled);
      const rawSkill = '# Identical';
      writeRawSkill({ skillName: 'helper', rawSkill });
      writeRawSkill({ skillName: 'helper-2', rawSkill });
      mockGetShared.mockResolvedValue({
        id: 'remote-a',
        name: 'helper',
        rawSkill,
      });
      const result = await writeRawSkillForContext({
        skillName: 'helper',
        rawSkill,
        sourceRemoteId: 'remote-a',
      });
      expect(result.skillName).toBe(enabled ? 'helper-3' : 'helper');
      expect(await readRawSkill('custom:app/helper')).toBe(rawSkill);
      expect(await readRawSkill('custom:app/helper-2')).toBe(rawSkill);
      if (enabled) {
        expect(mockRecordInstall).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'remote-a' }),
          'custom:app/helper-3',
        );
      } else {
        expect(mockInstallIds).not.toHaveBeenCalled();
        expect(mockRecordInstall).not.toHaveBeenCalled();
      }
    },
  );
  it('reuses an identical receipted copy instead of requiring review', async (): Promise<void> => {
    // Collection and App Advisor imports re-import installed members.
    mockSkillContextEnabled.mockReturnValue(true);
    const rawSkill = '# Identical';
    writeRawSkill({ skillName: 'helper', rawSkill });
    writeRawSkill({ skillName: 'helper-2', rawSkill });
    mockInstallIds.mockResolvedValue(new Set(['custom:app/helper-2']));
    mockGetShared.mockResolvedValue({
      id: 'remote-a',
      name: 'helper',
      rawSkill,
    });
    const result = await writeRawSkillForContext({
      skillName: 'helper',
      rawSkill,
      sourceRemoteId: 'remote-a',
    });
    expect(result.skillName).toBe('helper-2');
    expect(
      fs.existsSync(path.join(tempDir, 'skills', 'custom:app', 'helper-3')),
    ).toBe(false);
    expect(mockRecordInstall).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'remote-a' }),
      'custom:app/helper-2',
    );
  });

  it('requires review when the identical receipted copy has an interrupted update', async (): Promise<void> => {
    mockSkillContextEnabled.mockReturnValue(true);
    const rawSkill = '# Identical';
    writeRawSkill({ skillName: 'helper', rawSkill });
    fs.writeFileSync(
      path.join(
        tempDir,
        'skills',
        'custom:app',
        'helper',
        '.canopy-shared-update.json',
      ),
      '{}',
    );
    mockInstallIds.mockResolvedValue(new Set(['custom:app/helper']));
    mockGetShared.mockResolvedValue({
      id: 'remote-a',
      name: 'helper',
      rawSkill,
    });
    await expect(
      writeRawSkillForContext({
        skillName: 'helper',
        rawSkill,
        sourceRemoteId: 'remote-a',
      }),
    ).rejects.toThrow('review-required');
    expect(mockRecordInstall).not.toHaveBeenCalled();
  });

  function replacementInput(
    local = '# Old',
    source = '# New',
  ): WriteRawSkillRequest & {
    sourceRemoteId: string;
    replaceInstalled: NonNullable<WriteRawSkillRequest['replaceInstalled']>;
  } {
    const hash = (value: string): string =>
      createHash('sha256').update(value).digest('hex');
    return {
      skillName: 'ignored',
      rawSkill: '# Untrusted',
      sourceRemoteId: 'remote-a',
      replaceInstalled: {
        skillName: 'helper',
        expectedLocalContentHash: hash(local),
        expectedSourceContentHash: hash(source),
      },
    };
  }

  function seedReplacement(local = '# Old', source = '# New'): void {
    writeRawSkill({ skillName: 'helper', rawSkill: local });
    mockSkillContextEnabled.mockReturnValue(true);
    mockInstallIds.mockResolvedValue(new Set(['custom:app/helper']));
    mockGetShared.mockResolvedValue({
      id: 'remote-a',
      name: 'publisher-name',
      rawSkill: source,
    });
  }

  it('replaces a stale receipted alias in place using authorized bytes', async () => {
    seedReplacement();
    const result = await writeRawSkillForContext(replacementInput());
    expect(result).toMatchObject({
      skillId: 'custom:app/helper',
      skillName: 'helper',
    });
    expect(await readRawSkill(result.skillId)).toBe('# New');
    expect(
      fs.existsSync(
        path.join(tempDir, 'skills', 'custom:app', 'publisher-name'),
      ),
    ).toBe(false);
    expect(mockRecordInstall).toHaveBeenCalledWith(
      expect.objectContaining({ rawSkill: '# New' }),
      'custom:app/helper',
    );
  });

  it('rejects replacing a packaged dependency even though it shares the primary receipt', async () => {
    seedReplacement();
    const dependency = path.join(
      tempDir,
      'skills',
      'custom:app',
      'a-dependency',
    );
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(path.join(dependency, 'SKILL.md'), '# Dependency');
    mockInstallIds.mockResolvedValue(
      new Set(['custom:app/helper', 'custom:app/a-dependency']),
    );
    mockPrimaryInstallIds = new Set(['custom:app/helper']);
    const input = replacementInput('# Dependency');
    input.replaceInstalled.skillName = 'a-dependency';
    await expect(writeRawSkillForContext(input)).rejects.toThrow(
      'review-required',
    );
    expect(await readRawSkill('custom:app/a-dependency')).toBe('# Dependency');
    expect(await readRawSkill('custom:app/helper')).toBe('# Old');
  });

  it('records intentional removal through the production uninstall boundary', async () => {
    seedReplacement();
    await expect(
      removeSkillForContext('custom:app', 'helper'),
    ).resolves.toMatchObject({ success: true });
    expect(mockCommitRemoval).toHaveBeenCalledTimes(1);
    expect(
      fs.existsSync(path.join(tempDir, 'skills', 'custom:app', 'helper')),
    ).toBe(false);
  });

  it('rejects stale ordinary Install without allocating a second alias', async () => {
    seedReplacement();
    await expect(
      writeRawSkillForContext({
        skillName: 'helper',
        rawSkill: '# New',
        sourceRemoteId: 'remote-a',
      }),
    ).rejects.toThrow('review-required');
    expect(await readRawSkill('custom:app/helper')).toBe('# Old');
    expect(mockRecordInstall).not.toHaveBeenCalled();
  });

  it.each([
    'local',
    'source',
    'package',
    'missing',
    'unreceipted',
    'context',
    'revoked',
    'deleted',
  ])(
    'rejects %s conflicts without changing the installed file',
    async (failure) => {
      seedReplacement();
      const input = replacementInput();
      if (failure === 'local')
        input.replaceInstalled.expectedLocalContentHash = 'a'.repeat(64);
      if (failure === 'source')
        input.replaceInstalled.expectedSourceContentHash = 'b'.repeat(64);
      if (failure === 'package')
        mockGetShared.mockResolvedValue({
          id: 'remote-a',
          name: 'helper',
          rawSkill: '# New',
          package: { digest: 'sha256:' + 'c'.repeat(64) },
        });
      if (failure === 'missing')
        fs.rmSync(
          path.join(tempDir, 'skills', 'custom:app', 'helper', 'SKILL.md'),
        );
      if (failure === 'unreceipted')
        mockInstallIds.mockResolvedValue(new Set());
      if (failure === 'context')
        mockAssertSnapshot.mockRejectedValue(new Error('context-mismatch'));
      if (failure === 'revoked' || failure === 'deleted')
        mockGetShared.mockRejectedValue(new Error('access-removed'));
      await expect(writeRawSkillForContext(input)).rejects.toThrow();
      if (failure !== 'missing')
        expect(await readRawSkill('custom:app/helper')).toBe('# Old');
    },
  );

  it.each(['disabled', 'public', 'source-free', 'empty-hash', 'unsafe-name'])(
    'fails closed for %s replacement',
    async (failure) => {
      seedReplacement();
      const input: ReturnType<typeof replacementInput> & {
        publicShare?: PublicShareSkillOrigin;
      } = replacementInput();
      if (failure === 'disabled')
        mockSkillContextEnabled.mockReturnValue(false);
      if (failure === 'public')
        input.publicShare = {
          externalId: PUBLIC_SHARE_ID,
          contentHash: 'hash',
        };
      if (failure === 'source-free') input.sourceRemoteId = '';
      if (failure === 'empty-hash')
        input.replaceInstalled.expectedLocalContentHash = '';
      if (failure === 'unsafe-name')
        input.replaceInstalled.skillName = '../escape';
      await expect(writeRawSkillForContext(input)).rejects.toThrow();
      expect(await readRawSkill('custom:app/helper')).toBe('# Old');
    },
  );

  it('serializes concurrent first installs so only one can allocate an alias', async () => {
    mockSkillContextEnabled.mockReturnValue(true);
    const aliases = new Set<string>();
    mockInstallIds.mockImplementation(() => Promise.resolve(new Set(aliases)));
    mockGetShared.mockResolvedValue({
      id: 'remote-a',
      name: 'helper',
      rawSkill: '# New',
    });
    mockRecordInstall.mockImplementation((_detail, id) => {
      aliases.add(id);
      return Promise.resolve(mockRollbackInstall);
    });
    const input = {
      skillName: 'helper',
      rawSkill: '# New',
      sourceRemoteId: 'remote-a',
    };
    const results = await Promise.all([
      writeRawSkillForContext(input),
      writeRawSkillForContext(input),
    ]);
    // The second import reuses the first's identical receipted copy.
    expect(results.map((result) => result.skillName)).toEqual([
      'helper',
      'helper',
    ]);
    expect(aliases).toEqual(new Set(['custom:app/helper']));
    expect(
      fs.existsSync(path.join(tempDir, 'skills', 'custom:app', 'helper-2')),
    ).toBe(false);
  });

  it('allows only the first concurrent replacement with the reviewed local hash', async () => {
    seedReplacement();
    const results = await Promise.allSettled([
      writeRawSkillForContext(replacementInput()),
      writeRawSkillForContext(replacementInput()),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(await readRawSkill('custom:app/helper')).toBe('# New');
    expect(mockRecordInstall).toHaveBeenCalledTimes(1);
  });

  it('rejects uninstall during replacement and rechecks edits made during the source read', async () => {
    seedReplacement();
    mockGetShared.mockImplementation(() => {
      const removal = removeSkill('custom:app', 'helper');
      expect(removal.success).toBe(false);
      expect(removal.error).toContain('local-conflict');
      fs.writeFileSync(
        path.join(tempDir, 'skills', 'custom:app', 'helper', 'SKILL.md'),
        '# External edit',
      );
      return Promise.resolve({
        id: 'remote-a',
        name: 'helper',
        rawSkill: '# New',
      });
    });
    await expect(writeRawSkillForContext(replacementInput())).rejects.toThrow(
      'local-conflict',
    );
    expect(await readRawSkill('custom:app/helper')).toBe('# External edit');
  });

  it('serializes custom edits after replacement without losing the edit', async () => {
    seedReplacement();
    let editing: ReturnType<typeof saveCustomSkill> | undefined;
    mockGetShared.mockImplementationOnce(() => {
      editing = saveCustomSkill({
        name: 'helper',
        originalName: 'helper',
        description: 'Edited',
        body: '# My edit',
      });
      return Promise.resolve({
        id: 'remote-a',
        name: 'helper',
        rawSkill: '# New',
      });
    });
    const update = await writeRawSkillForContext(replacementInput());
    const edit = await editing;
    expect(update.skillName).toBe('helper');
    expect(edit?.success).toBe(true);
    expect(await readRawSkill('custom:app/helper')).toContain('# My edit');
  });

  it.each(['source', 'package', 'receipt'])(
    'revalidates %s after asynchronous staging',
    async (failure) => {
      seedReplacement();
      mockGetShared
        .mockResolvedValueOnce({
          id: 'remote-a',
          name: 'helper',
          rawSkill: '# New',
        })
        .mockResolvedValue({
          id: 'remote-a',
          name: 'helper',
          rawSkill: failure === 'source' ? '# Unreviewed' : '# New',
          ...(failure === 'package'
            ? { package: { digest: 'pp:v1:' + 'B'.repeat(43) } }
            : {}),
        });
      if (failure === 'receipt')
        mockInstallIds
          .mockResolvedValueOnce(new Set(['custom:app/helper']))
          .mockResolvedValue(new Set());
      await expect(
        writeRawSkillForContext(replacementInput()),
      ).rejects.toThrow();
      expect(await readRawSkill('custom:app/helper')).toBe('# Old');
      expect(mockRecordInstall).not.toHaveBeenCalled();
    },
  );

  it('checks the reviewed source again after asynchronous target authorization', async () => {
    seedReplacement();
    mockAssertStored.mockImplementationOnce(() => {
      mockGetShared.mockResolvedValue({
        id: 'remote-a',
        name: 'helper',
        rawSkill: '# Unreviewed revision',
      });
      return Promise.resolve();
    });
    await expect(writeRawSkillForContext(replacementInput())).rejects.toThrow(
      'source-conflict',
    );
    expect(await readRawSkill('custom:app/helper')).toBe('# Old');
  });

  it.each(['file', 'directory'])(
    'refuses a symlink at the replacement %s',
    async (kind) => {
      seedReplacement();
      const directory = path.join(tempDir, 'skills', 'custom:app', 'helper');
      const outside = path.join(tempDir, 'outside');
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'SKILL.md'), '# Outside');
      if (kind === 'file') {
        fs.rmSync(path.join(directory, 'SKILL.md'));
        fs.symlinkSync(
          path.join(outside, 'SKILL.md'),
          path.join(directory, 'SKILL.md'),
        );
      } else {
        fs.rmSync(directory, { recursive: true });
        fs.symlinkSync(outside, directory, 'dir');
      }
      await expect(writeRawSkillForContext(replacementInput())).rejects.toThrow(
        'invalid-replacement',
      );
      expect(fs.readFileSync(path.join(outside, 'SKILL.md'), 'utf8')).toBe(
        '# Outside',
      );
    },
  );

  it.each(['rename', 'receipt', 'context-after-receipt'])(
    'compensates %s failure and cleans staged files',
    async (failure) => {
      seedReplacement();
      if (failure === 'rename') {
        const realFs = jest.requireActual<typeof fs>('fs');
        const rename = realFs.renameSync;
        jest
          .spyOn(realFs, 'renameSync')
          .mockImplementation((source, destination) => {
            if (String(destination).endsWith('SKILL.md'))
              throw new Error('rename failed');
            rename(source, destination);
          });
      }
      if (failure === 'receipt')
        mockRecordInstall.mockRejectedValueOnce(new Error('receipt failed'));
      if (failure === 'context-after-receipt')
        mockAssertSnapshot
          .mockResolvedValueOnce(undefined)
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('context-mismatch'));
      await expect(
        writeRawSkillForContext(replacementInput()),
      ).rejects.toThrow();
      expect(await readRawSkill('custom:app/helper')).toBe('# Old');
      expect(
        fs.readdirSync(path.join(tempDir, 'skills', 'custom:app', 'helper')),
      ).toEqual(['SKILL.md']);
      if (failure === 'context-after-receipt')
        expect(mockRollbackInstall).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps recovery evidence if compensating the receipt fails', async () => {
    seedReplacement();
    mockAssertSnapshot
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('context-mismatch'));
    mockRollbackInstall.mockRejectedValueOnce(
      new Error('rollback unavailable'),
    );
    await expect(writeRawSkillForContext(replacementInput())).rejects.toThrow(
      'recovery-required',
    );
    expect(
      fs.existsSync(
        path.join(
          tempDir,
          'skills',
          'custom:app',
          'helper',
          '.canopy-shared-update.json',
        ),
      ),
    ).toBe(true);
  });

  it.each(['# Old', '# New'])(
    'reconciles an interrupted replacement after a fresh review of %s',
    async (local) => {
      seedReplacement(local);
      const directory = path.join(tempDir, 'skills', 'custom:app', 'helper');
      fs.writeFileSync(
        path.join(directory, '.canopy-shared-update.json'),
        JSON.stringify({
          version: 1,
          remoteId: 'remote-a',
          previousHash:
            replacementInput().replaceInstalled.expectedLocalContentHash,
          nextHash:
            replacementInput().replaceInstalled.expectedSourceContentHash,
        }),
      );
      fs.writeFileSync(
        path.join(directory, '.canopy-shared-update-stage'),
        '# Interrupted stage',
      );
      const result = await writeRawSkillForContext(replacementInput(local));
      expect(await readRawSkill(result.skillId)).toBe('# New');
      expect(mockRecordInstall).toHaveBeenCalledTimes(1);
      expect(fs.readdirSync(directory)).toEqual(['SKILL.md']);
    },
  );

  it('preserves permissions and sibling aliases and reports a post-commit subscription failure', async () => {
    seedReplacement();
    const directory = path.join(tempDir, 'skills', 'custom:app', 'helper');
    fs.chmodSync(path.join(directory, 'SKILL.md'), 0o640);
    const sibling = path.join(tempDir, 'skills', 'custom:app', 'helper-2');
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'SKILL.md'), '# Sibling');
    mockInstallIds.mockResolvedValue(
      new Set(['custom:app/helper', 'custom:app/helper-2']),
    );
    mockRecordItemInstall.mockImplementationOnce(() => {
      throw new Error('ledger unavailable');
    });
    const result = await writeRawSkillForContext(replacementInput());
    expect(result.subscriptionWarning).toBe('subscription-update-failed');
    expect(await readRawSkill(result.skillId)).toBe('# New');
    expect(await readRawSkill('custom:app/helper-2')).toBe('# Sibling');
    expect(fs.statSync(path.join(directory, 'SKILL.md')).mode & 0o777).toBe(
      0o640,
    );
    await expect(
      writeRawSkillForContext({
        ...replacementInput('# New'),
        inCollection: true,
      }),
    ).resolves.toEqual({ skillId: 'custom:app/helper', skillName: 'helper' });
    expect(mockRecordItemInstall).toHaveBeenCalledTimes(1);
  });
  it('does not write an import if recording its origin fails', async () => {
    mockSkillContextEnabled.mockReturnValue(true);
    mockGetShared.mockResolvedValue({
      id: 'remote-a',
      name: 'helper',
      rawSkill: '# Remote',
    });
    mockRecordInstall.mockRejectedValueOnce(new Error('Receipt unavailable'));
    await expect(
      writeRawSkillForContext({
        skillName: 'helper',
        rawSkill: '# Remote',
        sourceRemoteId: 'remote-a',
      }),
    ).rejects.toThrow('Receipt unavailable');
    expect(
      fs.existsSync(
        path.join(tempDir, 'skills', 'custom:app', 'helper', 'SKILL.md'),
      ),
    ).toBe(false);
  });
  it('writes an owned import into an existing directory without SKILL.md', async (): Promise<void> => {
    mockSkillContextEnabled.mockReturnValue(true);
    fs.mkdirSync(path.join(tempDir, 'skills', 'custom:app', 'helper'), {
      recursive: true,
    });
    mockGetShared.mockResolvedValue({
      id: 'remote-a',
      name: 'helper',
      rawSkill: '# Remote',
    });
    const result = await writeRawSkillForContext({
      skillName: 'helper',
      rawSkill: '# Remote',
      sourceRemoteId: 'remote-a',
    });
    expect(result.skillId).toBe('custom:app/helper');
    expect(await readRawSkill('custom:app/helper')).toBe('# Remote');
    expect(mockRecordInstall).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'remote-a' }),
      'custom:app/helper',
    );
  });
  it('removes an owned import when closing its claimed file fails', async (): Promise<void> => {
    mockSkillContextEnabled.mockReturnValue(true);
    mockGetShared.mockResolvedValue({
      id: 'remote-a',
      name: 'helper',
      rawSkill: '# Remote',
    });
    const realFs = jest.requireActual<typeof fs>('fs');
    const realCloseSync = realFs.closeSync;
    const closeSpy = jest
      .spyOn(realFs, 'closeSync')
      .mockImplementationOnce((fd) => {
        realCloseSync(fd);
        throw new Error('close failed');
      });
    try {
      await expect(
        writeRawSkillForContext({
          skillName: 'helper',
          rawSkill: '# Remote',
          sourceRemoteId: 'remote-a',
        }),
      ).rejects.toThrow('close failed');
    } finally {
      closeSpy.mockRestore();
    }
    expect(mockRollbackInstall).toHaveBeenCalledTimes(1);
    expect(
      fs.existsSync(
        path.join(tempDir, 'skills', 'custom:app', 'helper', 'SKILL.md'),
      ),
    ).toBe(false);
  });
  it.each(['snapshot', 'write'])(
    'rolls back the import receipt after a failed %s',
    async (failure): Promise<void> => {
      mockSkillContextEnabled.mockReturnValue(true);
      mockGetShared.mockResolvedValue({
        id: 'remote-a',
        name: 'helper',
        rawSkill: '# Remote',
      });
      if (failure === 'snapshot') {
        mockAssertSnapshot
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('Context changed'));
      } else {
        // A file at the destination directory makes the real filesystem write fail.
        const sourceDir = path.join(tempDir, 'skills', 'custom:app');
        fs.mkdirSync(sourceDir, { recursive: true });
        fs.writeFileSync(path.join(sourceDir, 'helper'), 'blocked');
      }
      await expect(
        writeRawSkillForContext({
          skillName: 'helper',
          rawSkill: '# Remote',
          sourceRemoteId: 'remote-a',
        }),
      ).rejects.toThrow();
      expect(mockRollbackInstall).toHaveBeenCalledTimes(1);
    },
  );
  it('does not attach origin to an unrelated skill when rename collides', async () => {
    writeRawSkill({ skillName: 'source', rawSkill: '# Source' });
    writeRawSkill({ skillName: 'existing', rawSkill: '# Existing' });
    const result = await saveCustomSkill({
      name: 'existing',
      originalName: 'source',
      description: 'Desc',
      body: 'Body',
    });
    expect(result.success).toBe(false);
    expect(mockCopyOrigin).not.toHaveBeenCalled();
  });
  it('rejects source-free context imports without writing content or receipts', async (): Promise<void> => {
    mockSkillContextEnabled.mockReturnValue(true);
    await expect(
      writeRawSkillForContext({ skillName: 'copy', rawSkill: '# Org content' }),
    ).rejects.toThrow('source');
    expect(fs.existsSync(path.join(tempDir, 'skills'))).toBe(false);
    expect(mockRecordInstall).not.toHaveBeenCalled();
  });
  // A Marketplace or share-link skill is a public share: it has no owning
  // team or organization, so there is no shared source to receipt. Main
  // verifies the origin itself by re-reading the share and writes those bytes
  // as personal content, mirroring the packaged-files installer.
  it('writes a verified public share import without a receipt when enforcement is on', async (): Promise<void> => {
    mockSkillContextEnabled.mockReturnValue(true);
    mockGetPublicShare.mockResolvedValue({
      entity: 'skill',
      externalId: PUBLIC_SHARE_ID,
      name: 'helper',
      description: '',
      rawSkill: '# Published',
      contentHash: 'hash-a',
      dependencies: [],
    });
    const result = await writeRawSkillForContext({
      skillName: 'forged',
      rawSkill: '# Forged',
      publicShare: { externalId: PUBLIC_SHARE_ID, contentHash: 'hash-a' },
    });
    expect(result).toEqual({
      skillId: 'custom:app/helper',
      skillName: 'helper',
    });
    expect(mockGetPublicShare).toHaveBeenCalledWith(PUBLIC_SHARE_ID);
    expect(
      fs.readFileSync(
        path.join(tempDir, 'skills', 'custom:app', 'helper', 'SKILL.md'),
        'utf8',
      ),
    ).toBe('# Published');
    expect(mockAssertStored).toHaveBeenCalledWith('custom:app/helper');
    expect(mockAssertSnapshot).toHaveBeenCalled();
    expect(mockGetShared).not.toHaveBeenCalled();
    expect(mockRecordInstall).not.toHaveBeenCalled();
  });
  it.each([
    new CanopyCloudClientError('missing-api-key', 'Sign in to continue.'),
    new CanopyCloudClientError('http-error', 'Session expired.', 401),
    new CanopyCloudClientError('http-error', 'Access denied.', 403),
    new CanopyCloudClientError('network-error', 'Connection unavailable.'),
  ])(
    'preserves a scoped read failure during public skill installation: %s',
    async (error) => {
      mockSkillContextEnabled.mockReturnValue(true);
      mockGetPublicShare.mockRejectedValue(error);
      await expect(
        writeRawSkillForContext({
          skillName: 'helper',
          rawSkill: '# Reviewed',
          publicShare: { externalId: PUBLIC_SHARE_ID, contentHash: 'hash-a' },
        }),
      ).rejects.toBe(error);
      expect(fs.existsSync(path.join(tempDir, 'skills'))).toBe(false);
      expect(mockRecordInstall).not.toHaveBeenCalled();
      expect(mockRecordItemInstall).not.toHaveBeenCalled();
    },
  );

  it('rejects a public share import whose content changed since it was reviewed', async (): Promise<void> => {
    mockSkillContextEnabled.mockReturnValue(true);
    mockGetPublicShare.mockResolvedValue({
      entity: 'skill',
      externalId: PUBLIC_SHARE_ID,
      name: 'helper',
      description: '',
      rawSkill: '# Republished',
      contentHash: 'hash-b',
      dependencies: [],
    });
    await expect(
      writeRawSkillForContext({
        skillName: 'helper',
        rawSkill: '# Reviewed',
        publicShare: { externalId: PUBLIC_SHARE_ID, contentHash: 'hash-a' },
      }),
    ).rejects.toThrow('changed');
    expect(fs.existsSync(path.join(tempDir, 'skills'))).toBe(false);
    expect(mockRecordInstall).not.toHaveBeenCalled();
  });
  // Publishing a collection pins its custom skills inside the collection
  // snapshot only. Such a skill has no standalone public share to re-read.
  const pinnedCollection = {
    entity: 'collection',
    externalId: PUBLIC_COLLECTION_ID,
    contentHash: 'collection-a',
    customSkills: [
      {
        id: PUBLIC_SHARE_ID,
        name: 'helper',
        rawSkill: '# Pinned',
        contentHash: 'hash-a',
      },
    ],
  };
  const pinnedOrigin = {
    externalId: PUBLIC_SHARE_ID,
    contentHash: 'hash-a',
    collection: {
      externalId: PUBLIC_COLLECTION_ID,
      contentHash: 'collection-a',
    },
  };
  it('writes a skill pinned in a Public collection from the collection snapshot', async (): Promise<void> => {
    mockSkillContextEnabled.mockReturnValue(true);
    mockGetPublicCollection.mockResolvedValue(pinnedCollection);
    const result = await writeRawSkillForContext({
      skillName: 'forged',
      rawSkill: '# Forged',
      publicShare: pinnedOrigin,
    });
    expect(result).toEqual({
      skillId: 'custom:app/helper',
      skillName: 'helper',
    });
    expect(mockGetPublicCollection).toHaveBeenCalledWith(PUBLIC_COLLECTION_ID);
    expect(mockGetPublicShare).not.toHaveBeenCalled();
    expect(
      fs.readFileSync(
        path.join(tempDir, 'skills', 'custom:app', 'helper', 'SKILL.md'),
        'utf8',
      ),
    ).toBe('# Pinned');
    expect(mockAssertSnapshot).toHaveBeenCalled();
    expect(mockRecordInstall).not.toHaveBeenCalled();
  });
  it.each([
    ['the collection was republished', { contentHash: 'collection-b' }],
    ['the skill is no longer pinned', { customSkills: [] }],
    [
      'the pinned skill changed',
      {
        customSkills: [
          { ...pinnedCollection.customSkills[0], contentHash: 'hash-b' },
        ],
      },
    ],
  ])(
    'rejects a pinned collection skill when %s',
    async (_label, change): Promise<void> => {
      mockSkillContextEnabled.mockReturnValue(true);
      mockGetPublicCollection.mockResolvedValue({
        ...pinnedCollection,
        ...change,
      });
      await expect(
        writeRawSkillForContext({
          skillName: 'helper',
          rawSkill: '# Reviewed',
          publicShare: pinnedOrigin,
        }),
      ).rejects.toThrow('changed');
      expect(mockGetPublicShare).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(tempDir, 'skills'))).toBe(false);
    },
  );
  it('rejects a malformed collection origin before reading any share', async (): Promise<void> => {
    mockSkillContextEnabled.mockReturnValue(true);
    for (const collection of [
      { externalId: '../not-a-share', contentHash: 'collection-a' },
      { externalId: PUBLIC_COLLECTION_ID },
      'collection',
    ]) {
      await expect(
        writeRawSkillForContext({
          skillName: 'helper',
          rawSkill: '# Reviewed',
          publicShare: {
            ...pinnedOrigin,
            collection: collection as {
              externalId: string;
              contentHash: string;
            },
          },
        }),
      ).rejects.toThrow('share id');
    }
    expect(mockGetPublicCollection).not.toHaveBeenCalled();
    expect(mockGetPublicShare).not.toHaveBeenCalled();
  });
  it('rejects a public share origin whose fields are not strings before reading the share', async (): Promise<void> => {
    mockSkillContextEnabled.mockReturnValue(true);
    for (const origin of [
      { externalId: 42, contentHash: 'hash-a' },
      { externalId: PUBLIC_SHARE_ID },
    ]) {
      const publicShare: { externalId: string; contentHash: string } = {
        externalId:
          typeof origin.externalId === 'string' ? origin.externalId : '',
        contentHash: origin.contentHash ?? 'hash-a',
      };
      // Restore the exact malformed fields under test at this typed boundary.
      if (typeof origin.externalId !== 'string') {
        Reflect.set(publicShare, 'externalId', origin.externalId);
      }
      if (origin.contentHash === undefined) {
        Reflect.deleteProperty(publicShare, 'contentHash');
      }
      await expect(
        writeRawSkillForContext({
          skillName: 'helper',
          rawSkill: '# Reviewed',
          publicShare,
        }),
      ).rejects.toThrow('share id');
    }
    expect(mockGetPublicShare).not.toHaveBeenCalled();
  });
  it('rejects a malformed public share id before reading the share', async (): Promise<void> => {
    mockSkillContextEnabled.mockReturnValue(true);
    await expect(
      writeRawSkillForContext({
        skillName: 'helper',
        rawSkill: '# Reviewed',
        publicShare: { externalId: '../not-a-share', contentHash: 'hash-a' },
      }),
    ).rejects.toThrow('share id');
    expect(mockGetPublicShare).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tempDir, 'skills'))).toBe(false);
  });
  it('prefers the owned source when a request names both an owned source and a public share', async (): Promise<void> => {
    mockSkillContextEnabled.mockReturnValue(true);
    mockGetShared.mockResolvedValue({
      id: 'remote-a',
      name: 'helper',
      rawSkill: '# Trusted remote',
    });
    const result = await writeRawSkillForContext({
      skillName: 'helper',
      rawSkill: '# Caller',
      sourceRemoteId: 'remote-a',
      publicShare: { externalId: PUBLIC_SHARE_ID, contentHash: 'hash-a' },
    });
    expect(result.skillId).toBe('custom:app/helper');
    expect(mockGetShared).toHaveBeenCalledWith('remote-a');
    expect(mockGetPublicShare).not.toHaveBeenCalled();
    expect(mockRecordInstall).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'remote-a' }),
      'custom:app/helper',
    );
  });
  it('reuses an identical local copy of a public share instead of writing a duplicate', async (): Promise<void> => {
    mockSkillContextEnabled.mockReturnValue(true);
    writeRawSkill({ skillName: 'helper', rawSkill: '# Published' });
    mockGetPublicShare.mockResolvedValue({
      entity: 'skill',
      externalId: PUBLIC_SHARE_ID,
      name: 'helper',
      description: '',
      rawSkill: '# Published',
      contentHash: 'hash-a',
      dependencies: [],
    });
    const result = await writeRawSkillForContext({
      skillName: 'helper',
      rawSkill: '# Published',
      publicShare: { externalId: PUBLIC_SHARE_ID, contentHash: 'hash-a' },
    });
    expect(result.skillId).toBe('custom:app/helper');
    expect(mockAssertStored).toHaveBeenCalledWith('custom:app/helper');
    expect(
      fs.existsSync(path.join(tempDir, 'skills', 'custom:app', 'helper-2')),
    ).toBe(false);
  });
  // An identical copy bound to a team or organization by an install receipt
  // belongs to that context. The renderer cannot see it from another context,
  // and a public install must neither adopt it nor fail on it.
  it('does not adopt an identical copy that an install receipt binds to an owned source', async (): Promise<void> => {
    mockSkillContextEnabled.mockReturnValue(true);
    writeRawSkill({ skillName: 'helper', rawSkill: '# Published' });
    mockHasReceipt.mockImplementation((localId) =>
      Promise.resolve(localId === 'custom:app/helper'),
    );
    mockGetPublicShare.mockResolvedValue({
      entity: 'skill',
      externalId: PUBLIC_SHARE_ID,
      name: 'helper',
      description: '',
      rawSkill: '# Published',
      contentHash: 'hash-a',
      dependencies: [],
    });
    const result = await writeRawSkillForContext({
      skillName: 'helper',
      rawSkill: '# Published',
      publicShare: { externalId: PUBLIC_SHARE_ID, contentHash: 'hash-a' },
    });
    expect(result.skillId).toBe('custom:app/helper-2');
    expect(mockAssertStored).not.toHaveBeenCalledWith('custom:app/helper');
    expect(mockAssertStored).toHaveBeenCalledWith('custom:app/helper-2');
    expect(await readRawSkill('custom:app/helper-2')).toBe('# Published');
  });
  // A receipt can attach to the matched copy while the context checks await,
  // and an adopted copy is never claimed by an exclusive write, so the
  // binding is checked again right before the adoption.
  it('does not adopt an identical copy that gains a receipt during the context checks', async (): Promise<void> => {
    mockSkillContextEnabled.mockReturnValue(true);
    writeRawSkill({ skillName: 'helper', rawSkill: '# Published' });
    mockHasReceipt.mockResolvedValueOnce(false).mockResolvedValue(true);
    mockGetPublicShare.mockResolvedValue({
      entity: 'skill',
      externalId: PUBLIC_SHARE_ID,
      name: 'helper',
      description: '',
      rawSkill: '# Published',
      contentHash: 'hash-a',
      dependencies: [],
    });
    const result = await writeRawSkillForContext({
      skillName: 'helper',
      rawSkill: '# Published',
      publicShare: { externalId: PUBLIC_SHARE_ID, contentHash: 'hash-a' },
    });
    expect(result.skillId).toBe('custom:app/helper-2');
    expect(await readRawSkill('custom:app/helper-2')).toBe('# Published');
  });
  it('gives up after skipping a bounded number of receipted identical copies', async (): Promise<void> => {
    mockSkillContextEnabled.mockReturnValue(true);
    for (let index = 1; index <= 33; index += 1)
      writeRawSkill({
        skillName: index === 1 ? 'helper' : `helper-${index}`,
        rawSkill: '# Published',
      });
    mockHasReceipt.mockResolvedValue(true);
    mockGetPublicShare.mockResolvedValue({
      entity: 'skill',
      externalId: PUBLIC_SHARE_ID,
      name: 'helper',
      description: '',
      rawSkill: '# Published',
      contentHash: 'hash-a',
      dependencies: [],
    });
    await expect(
      writeRawSkillForContext({
        skillName: 'helper',
        rawSkill: '# Published',
        publicShare: { externalId: PUBLIC_SHARE_ID, contentHash: 'hash-a' },
      }),
    ).rejects.toThrow('Could not claim a skill name');
    expect(
      fs.existsSync(path.join(tempDir, 'skills', 'custom:app', 'helper-34')),
    ).toBe(false);
  });
  it('writes a public share beside a different local skill under a suffixed name', async (): Promise<void> => {
    mockSkillContextEnabled.mockReturnValue(true);
    writeRawSkill({ skillName: 'helper', rawSkill: '# Mine' });
    mockGetPublicShare.mockResolvedValue({
      entity: 'skill',
      externalId: PUBLIC_SHARE_ID,
      name: 'helper',
      description: '',
      rawSkill: '# Published',
      contentHash: 'hash-a',
      dependencies: [],
    });
    const result = await writeRawSkillForContext({
      skillName: 'helper',
      rawSkill: '# Published',
      publicShare: { externalId: PUBLIC_SHARE_ID, contentHash: 'hash-a' },
    });
    expect(result.skillId).toBe('custom:app/helper-2');
    expect(mockAssertStored).toHaveBeenCalledWith('custom:app/helper-2');
    expect(await readRawSkill('custom:app/helper')).toBe('# Mine');
    expect(await readRawSkill('custom:app/helper-2')).toBe('# Published');
  });
  // The context check awaits, so another import can claim the chosen name in
  // the meantime. The write must land only on a name that was checked, so
  // the whole resolve/check/write sequence runs again for the new name.
  it('re-checks the context when a public share name is claimed during the check', async (): Promise<void> => {
    mockSkillContextEnabled.mockReturnValue(true);
    mockGetPublicShare.mockResolvedValue({
      entity: 'skill',
      externalId: PUBLIC_SHARE_ID,
      name: 'helper',
      description: '',
      rawSkill: '# Published',
      contentHash: 'hash-a',
      dependencies: [],
    });
    mockAssertStored.mockImplementationOnce((): Promise<void> => {
      const directory = path.join(tempDir, 'skills', 'custom:app', 'helper');
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'SKILL.md'), '# Someone else');
      return Promise.resolve();
    });
    const result = await writeRawSkillForContext({
      skillName: 'helper',
      rawSkill: '# Published',
      publicShare: { externalId: PUBLIC_SHARE_ID, contentHash: 'hash-a' },
    });
    expect(result.skillId).toBe('custom:app/helper-2');
    expect(mockAssertStored).toHaveBeenLastCalledWith('custom:app/helper-2');
    expect(await readRawSkill('custom:app/helper')).toBe('# Someone else');
    expect(await readRawSkill('custom:app/helper-2')).toBe('# Published');
  });
  // A claimed SKILL.md must not survive a failed write: an empty file would
  // read as a different skill and push the next attempt to a suffix.
  it('removes the claimed SKILL.md when the public share write fails', async (): Promise<void> => {
    mockSkillContextEnabled.mockReturnValue(true);
    mockGetPublicShare.mockResolvedValue({
      entity: 'skill',
      externalId: PUBLIC_SHARE_ID,
      name: 'helper',
      description: '',
      rawSkill: '# Published',
      contentHash: 'hash-a',
      dependencies: [],
    });
    const realFs = jest.requireActual<typeof fs>('fs');
    const realWriteFileSync = realFs.writeFileSync;
    const writeSpy = jest
      .spyOn(realFs, 'writeFileSync')
      .mockImplementation((target, ...rest): void => {
        // Only the claimed file descriptor fails; metadata writes proceed.
        if (typeof target === 'number')
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        realWriteFileSync(target, ...rest);
      });
    try {
      await expect(
        writeRawSkillForContext({
          skillName: 'helper',
          rawSkill: '# Published',
          publicShare: { externalId: PUBLIC_SHARE_ID, contentHash: 'hash-a' },
        }),
      ).rejects.toThrow('disk full');
    } finally {
      writeSpy.mockRestore();
    }
    expect(
      fs.existsSync(
        path.join(tempDir, 'skills', 'custom:app', 'helper', 'SKILL.md'),
      ),
    ).toBe(false);
    expect(mockAssertStored).toHaveBeenCalledTimes(1);
  });
  // The name resolver keys on SKILL.md, so a bare skill directory (a partial
  // tree, or a hand-deleted file) is still a free name, as it always was.
  it('writes a public share into an existing skill directory that has no SKILL.md', async (): Promise<void> => {
    mockSkillContextEnabled.mockReturnValue(true);
    fs.mkdirSync(path.join(tempDir, 'skills', 'custom:app', 'helper'), {
      recursive: true,
    });
    mockGetPublicShare.mockResolvedValue({
      entity: 'skill',
      externalId: PUBLIC_SHARE_ID,
      name: 'helper',
      description: '',
      rawSkill: '# Published',
      contentHash: 'hash-a',
      dependencies: [],
    });
    const result = await writeRawSkillForContext({
      skillName: 'helper',
      rawSkill: '# Published',
      publicShare: { externalId: PUBLIC_SHARE_ID, contentHash: 'hash-a' },
    });
    expect(result.skillId).toBe('custom:app/helper');
    expect(await readRawSkill('custom:app/helper')).toBe('# Published');
    expect(
      fs.existsSync(path.join(tempDir, 'skills', 'custom:app', 'helper-2')),
    ).toBe(false);
  });
  it('accepts a public share id in any letter case', async (): Promise<void> => {
    mockSkillContextEnabled.mockReturnValue(true);
    mockGetPublicShare.mockResolvedValue({
      entity: 'skill',
      externalId: PUBLIC_SHARE_ID,
      name: 'helper',
      description: '',
      rawSkill: '# Published',
      contentHash: 'hash-a',
      dependencies: [],
    });
    await writeRawSkillForContext({
      skillName: 'helper',
      rawSkill: '# Published',
      publicShare: {
        externalId: PUBLIC_SHARE_ID.toUpperCase(),
        contentHash: 'hash-a',
      },
    });
    expect(mockGetPublicShare).toHaveBeenCalledWith(PUBLIC_SHARE_ID);
  });
  it('rejects a public link that resolved to a scoped share without its remote source', async (): Promise<void> => {
    mockSkillContextEnabled.mockReturnValue(true);
    mockGetPublicShare.mockResolvedValue({
      entity: 'skill',
      externalId: PUBLIC_SHARE_ID,
      sourceRemoteId: 'remote-a',
      scopedShare: true,
      name: 'helper',
      description: '',
      rawSkill: '# Org content',
      contentHash: 'hash-a',
      dependencies: [],
    });
    await expect(
      writeRawSkillForContext({
        skillName: 'helper',
        rawSkill: '# Org content',
        publicShare: { externalId: PUBLIC_SHARE_ID, contentHash: 'hash-a' },
      }),
    ).rejects.toThrow('team or organization');
    expect(fs.existsSync(path.join(tempDir, 'skills'))).toBe(false);
    expect(mockRecordInstall).not.toHaveBeenCalled();
  });
  it.each(['swap', 'receipt'])(
    'restores the original rename after a failed %s without an origin alias',
    async (failure): Promise<void> => {
      mockSkillContextEnabled.mockReturnValue(true);
      writeRawSkill({ skillName: 'source', rawSkill: '# Original' });
      const sourceDir = path.join(tempDir, 'skills', 'custom:app', 'source');
      const targetDir = path.join(tempDir, 'skills', 'custom:app', 'renamed');
      const rename = jest.requireActual<typeof fsp>('node:fs/promises').rename;
      if (failure === 'swap') {
        jest
          .mocked(fsp.rename)
          .mockImplementation(async (from, to): Promise<void> => {
            if (to === targetDir) throw new Error('swap failed');
            await rename(from, to);
          });
      } else {
        mockCopyOrigin.mockImplementation((): Promise<void> => {
          expect(fs.existsSync(targetDir)).toBe(true);
          expect(fs.existsSync(sourceDir)).toBe(false);
          return Promise.reject(new Error('receipt failed'));
        });
      }
      const result = await saveCustomSkill({
        name: 'renamed',
        originalName: 'source',
        description: 'Updated',
        body: 'Updated',
      });
      expect(result).toEqual({ success: false, error: `${failure} failed` });
      expect(fs.readFileSync(path.join(sourceDir, 'SKILL.md'), 'utf8')).toBe(
        '# Original',
      );
      expect(fs.existsSync(targetDir)).toBe(false);
      if (failure === 'swap') expect(mockCopyOrigin).not.toHaveBeenCalled();
    },
  );
  describe('install subscriptions', () => {
    const sharedDetail = {
      id: 'remote-a',
      name: 'helper',
      rawSkill: '# Trusted remote',
      contentHash: 'shared-hash',
    };

    it('registers a team or organization import after its SKILL.md is written', async (): Promise<void> => {
      mockSkillContextEnabled.mockReturnValue(true);
      mockGetShared.mockResolvedValue(sharedDetail);
      mockRecordInstall.mockImplementation((): Promise<undefined> => {
        expect(mockRecordItemInstall).not.toHaveBeenCalled();
        return Promise.resolve(undefined);
      });

      await writeRawSkillForContext({
        skillName: 'forged',
        rawSkill: '# Forged',
        sourceRemoteId: 'remote-a',
      });

      expect(mockRecordItemInstall).toHaveBeenCalledTimes(1);
      expect(mockRecordItemInstall).toHaveBeenCalledWith({
        kind: 'skill',
        remoteId: 'remote-a',
        sourceKind: 'shared',
        contentHash: 'shared-hash',
        localId: 'custom:app/helper',
      });
    });

    it('does not register a team skill imported as part of a collection', async (): Promise<void> => {
      mockSkillContextEnabled.mockReturnValue(true);
      mockGetShared.mockResolvedValue(sharedDetail);

      await expect(
        writeRawSkillForContext({
          skillName: 'helper',
          rawSkill: '# Remote',
          sourceRemoteId: 'remote-a',
          inCollection: true,
        }),
      ).resolves.toMatchObject({ skillId: 'custom:app/helper' });

      // The collection's own subscription covers its member skills.
      expect(mockRecordItemInstall).not.toHaveBeenCalled();
    });

    it('does not register an import whose local write failed', async (): Promise<void> => {
      mockSkillContextEnabled.mockReturnValue(true);
      mockGetShared.mockResolvedValue(sharedDetail);
      mockRecordInstall.mockRejectedValueOnce(new Error('Receipt unavailable'));

      await expect(
        writeRawSkillForContext({
          skillName: 'helper',
          rawSkill: '# Remote',
          sourceRemoteId: 'remote-a',
        }),
      ).rejects.toThrow('Receipt unavailable');

      expect(mockRecordItemInstall).not.toHaveBeenCalled();
    });

    it('registers a public share import with its reviewed hash', async (): Promise<void> => {
      mockSkillContextEnabled.mockReturnValue(true);
      mockGetPublicShare.mockResolvedValue({
        entity: 'skill',
        externalId: PUBLIC_SHARE_ID,
        name: 'helper',
        description: '',
        rawSkill: '# Published',
        contentHash: 'hash-a',
        dependencies: [],
      });

      await writeRawSkillForContext({
        skillName: 'forged',
        rawSkill: '# Forged',
        publicShare: {
          externalId: PUBLIC_SHARE_ID.toUpperCase(),
          contentHash: 'hash-a',
        },
      });

      expect(mockRecordItemInstall).toHaveBeenCalledWith({
        kind: 'skill',
        remoteId: PUBLIC_SHARE_ID,
        sourceKind: 'public',
        contentHash: 'hash-a',
        localId: 'custom:app/helper',
      });
    });

    it('does not register a skill installed as part of a collection', async (): Promise<void> => {
      mockSkillContextEnabled.mockReturnValue(true);
      mockGetPublicCollection.mockResolvedValue(pinnedCollection);

      await writeRawSkillForContext({
        skillName: 'forged',
        rawSkill: '# Forged',
        publicShare: pinnedOrigin,
      });

      expect(
        fs.existsSync(
          path.join(tempDir, 'skills', 'custom:app', 'helper', 'SKILL.md'),
        ),
      ).toBe(true);
      expect(mockRecordItemInstall).not.toHaveBeenCalled();
    });

    it('does not register a public share whose content changed', async (): Promise<void> => {
      mockSkillContextEnabled.mockReturnValue(true);
      mockGetPublicShare.mockResolvedValue({
        entity: 'skill',
        externalId: PUBLIC_SHARE_ID,
        name: 'helper',
        description: '',
        rawSkill: '# Republished',
        contentHash: 'hash-b',
        dependencies: [],
      });

      await expect(
        writeRawSkillForContext({
          skillName: 'helper',
          rawSkill: '# Reviewed',
          publicShare: { externalId: PUBLIC_SHARE_ID, contentHash: 'hash-a' },
        }),
      ).rejects.toThrow('changed');

      expect(mockRecordItemInstall).not.toHaveBeenCalled();
    });

    it('unregisters a removed custom skill by its local id', (): void => {
      writeRawSkill({ skillName: 'helper', rawSkill: '# Remote' });

      expect(removeSkill('custom:app', 'helper')).toEqual({
        success: true,
        data: undefined,
      });

      expect(mockRecordItemUninstall).toHaveBeenCalledWith({
        kind: 'skill',
        localId: 'custom:app/helper',
      });
    });

    it('sends nothing for a failed removal', (): void => {
      expect(removeSkill('custom:app', '../escape').success).toBe(false);

      expect(mockRecordItemUninstall).not.toHaveBeenCalled();
    });
  });
});
