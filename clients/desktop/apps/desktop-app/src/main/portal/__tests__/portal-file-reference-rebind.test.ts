import { join } from 'node:path';
import type {
  FileIndexResponse,
  RepoFileIndex,
} from '@canopy/desktop-shared/types';
import { buildFileIndexes } from '../../services/files-service';
import { portalFileReferences } from '../portal-file-references';
import { rebindPortalFileReferences } from '../portal-file-reference-rebind';

jest.mock('../../services/files-service', () => ({
  buildFileIndexes: jest.fn(),
}));

const sourceScope = {
  sessionId: 'session',
  projectId: 'workspace',
  worktreeId: 'source',
  canRead: (): boolean => true,
};
const destinationScope = { ...sourceScope, worktreeId: 'destination' };

function catalog(
  root: string,
  overrides: Partial<RepoFileIndex> = {},
): FileIndexResponse {
  return {
    repos: [
      {
        repoId: 'repo',
        repoName: 'Repository',
        rootKind: 'git-repo',
        absolutePath: root,
        files: [
          {
            relativePath: 'src/example.ts',
            filename: 'example.ts',
            absolutePath: join(root, 'src/example.ts'),
            isIgnored: false,
          },
        ],
        ...overrides,
      },
    ],
  };
}

describe('host-authorized Portal mention rebinding', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    portalFileReferences.clear();
  });
  afterEach(() => portalFileReferences.clear());

  it.each(['git-repo', 'standalone'] as const)(
    'rebinds %s roots without exposing paths and keeps selector metadata',
    async (rootKind) => {
      jest
        .mocked(buildFileIndexes)
        .mockResolvedValueOnce(catalog('/source', { rootKind }))
        .mockResolvedValueOnce(catalog('/destination', { rootKind }));
      const original = portalFileReferences.mint(sourceScope, {
        absolutePath: '/source/src/example.ts',
        displayPath: 'src/example.ts',
        repoName: 'Repository',
        kind: 'prompt',
        textStart: 4,
      });
      const references = await rebindPortalFileReferences({
        sourceScope,
        destinationScope,
        fileReferences: [original],
      });
      expect(references).toHaveLength(1);
      expect(references[0]?.referenceId).toEqual(expect.any(String));
      expect(references[0]?.displayPath).toBe(original.displayPath);
      expect(references[0]?.repoName).toBe(original.repoName);
      expect(references[0]?.kind).toBe(original.kind);
      expect(references[0]?.textStart).toBe(original.textStart);
      expect(references[0]?.referenceId).not.toBe(original.referenceId);
      expect(JSON.stringify(references)).not.toContain('/destination');
      const rebound = references[0];
      if (!rebound) throw new Error('Expected rebound reference.');
      expect(portalFileReferences.resolve(destinationScope, rebound)).toEqual({
        absolutePath: '/destination/src/example.ts',
        displayPath: 'src/example.ts',
        repoName: 'Repository',
        kind: 'prompt',
        textStart: 4,
      });
      expect(() =>
        portalFileReferences.resolve(destinationScope, original),
      ).toThrow('authorized');
    },
  );

  it.each([
    { repoId: 'different' },
    { repoName: 'different' },
    { rootKind: 'attachments' as const },
    { files: [] },
    {
      files: [
        {
          relativePath: 'src/example.ts',
          filename: 'example.ts',
          absolutePath: '/outside/example.ts',
          isIgnored: false,
        },
      ],
    },
  ])(
    'rejects missing or colliding destination catalog entries: %j',
    async (overrides) => {
      jest
        .mocked(buildFileIndexes)
        .mockResolvedValueOnce(catalog('/source'))
        .mockResolvedValueOnce(catalog('/destination', overrides));
      const original = portalFileReferences.mint(sourceScope, {
        absolutePath: '/source/src/example.ts',
        displayPath: 'src/example.ts',
      });
      await expect(
        rebindPortalFileReferences({
          sourceScope,
          destinationScope,
          fileReferences: [original],
        }),
      ).rejects.toThrow('mapped');
    },
  );

  it('rejects cross-workspace, unknown, cleared and revoked source ids before indexing', async () => {
    const original = portalFileReferences.mint(sourceScope, {
      absolutePath: '/source/src/example.ts',
      displayPath: 'src/example.ts',
    });
    await expect(
      rebindPortalFileReferences({
        sourceScope,
        destinationScope: { ...destinationScope, projectId: 'other' },
        fileReferences: [original],
      }),
    ).rejects.toThrow('authorized');
    await expect(
      rebindPortalFileReferences({
        sourceScope: { ...sourceScope, worktreeId: 'other' },
        destinationScope,
        fileReferences: [original],
      }),
    ).rejects.toThrow('authorized');
    portalFileReferences.clear();
    await expect(
      rebindPortalFileReferences({
        sourceScope,
        destinationScope,
        fileReferences: [original],
      }),
    ).rejects.toThrow('authorized');
    const revoked = portalFileReferences.mint(sourceScope, {
      absolutePath: '/source/src/example.ts',
      displayPath: 'src/example.ts',
    });
    await expect(
      rebindPortalFileReferences({
        sourceScope: { ...sourceScope, canRead: () => false },
        destinationScope,
        fileReferences: [revoked],
      }),
    ).rejects.toThrow('authorized');
    expect(buildFileIndexes).not.toHaveBeenCalled();
  });

  it('rechecks source authorization after catalog awaits and rejects deleted source files', async () => {
    let authorized = true;
    const scope = { ...sourceScope, canRead: (): boolean => authorized };
    const original = portalFileReferences.mint(scope, {
      absolutePath: '/source/src/example.ts',
      displayPath: 'src/example.ts',
    });
    jest.mocked(buildFileIndexes).mockImplementation(({ worktreeId }) => {
      authorized = false;
      return Promise.resolve(
        catalog(worktreeId === 'source' ? '/source' : '/destination'),
      );
    });
    await expect(
      rebindPortalFileReferences({
        sourceScope: scope,
        destinationScope,
        fileReferences: [original],
      }),
    ).rejects.toThrow('authorized');
    authorized = true;
    const next = portalFileReferences.mint(scope, {
      absolutePath: '/source/src/example.ts',
      displayPath: 'src/example.ts',
    });
    jest
      .mocked(buildFileIndexes)
      .mockReset()
      .mockResolvedValueOnce(catalog('/source', { files: [] }))
      .mockResolvedValueOnce(catalog('/destination'));
    await expect(
      rebindPortalFileReferences({
        sourceScope: scope,
        destinationScope,
        fileReferences: [next],
      }),
    ).rejects.toThrow('mapped');
  });

  it('rejects a genuinely expired reference after the destination catalog await without minting a destination id', async () => {
    let now = 1_000_000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const mint = jest.spyOn(portalFileReferences, 'mint');
    try {
      const original = portalFileReferences.mint(sourceScope, {
        absolutePath: '/source/src/example.ts',
        displayPath: 'src/example.ts',
      });
      mint.mockClear();
      jest.mocked(buildFileIndexes).mockImplementation(({ worktreeId }) => {
        if (worktreeId === 'destination') now += 30 * 60 * 1000;
        return Promise.resolve(
          catalog(worktreeId === 'source' ? '/source' : '/destination'),
        );
      });
      await expect(
        rebindPortalFileReferences({
          sourceScope,
          destinationScope,
          fileReferences: [original],
        }),
      ).rejects.toThrow('authorized');
      expect(buildFileIndexes).toHaveBeenCalledTimes(2);
      expect(mint).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
      mint.mockRestore();
    }
  });
});
