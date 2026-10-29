const mockHasCompletedCodeGraph = jest.fn();
const mockCloneCompletedCodeGraphDatabase = jest.fn();
const mockReadPublishedCodeGraphBase = jest.fn();
const mockSeedCodeGraphDatabase = jest.fn();

jest.mock('@canopy/desktop-shared/node/code-graph/base-graph', () => ({
  hasCompletedCodeGraph: (...args: unknown[]): unknown =>
    mockHasCompletedCodeGraph(...args),
  cloneCompletedCodeGraphDatabase: (...args: unknown[]): unknown =>
    mockCloneCompletedCodeGraphDatabase(...args),
  readPublishedCodeGraphBase: (...args: unknown[]): unknown =>
    mockReadPublishedCodeGraphBase(...args),
  seedCodeGraphDatabase: (...args: unknown[]): unknown =>
    mockSeedCodeGraphDatabase(...args),
}));
jest.mock('@canopy/desktop-shared/node/code-graph/engine', () => ({
  CodeGraphEngine: { open: jest.fn() },
}));

import { executeCodeGraphEagerSeed } from '../code-graph/build-worker';

describe('executeCodeGraphEagerSeed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHasCompletedCodeGraph.mockReturnValue(false);
    mockCloneCompletedCodeGraphDatabase.mockResolvedValue({
      installed: true,
      durationMs: 10,
    });
  });

  it('clones and rebinds a live base-worktree database in the worker', async () => {
    await expect(
      executeCodeGraphEagerSeed({
        operation: 'eager-seed',
        targetDbPath: '/target/graph.db',
        repositories: [{ repoId: 'root', rootPath: '/worktree' }],
        source: { kind: 'base-worktree', dbPath: '/base/graph.db' },
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 'seeded',
      source: 'base-worktree',
    });
    expect(mockCloneCompletedCodeGraphDatabase).toHaveBeenCalledWith({
      sourceDbPath: '/base/graph.db',
      targetDbPath: '/target/graph.db',
      repositories: [{ repoId: 'root', rootPath: '/worktree' }],
      sourceValidation: 'metadata-only',
      targetValidation: 'metadata-only',
    });
  });

  it('validates then directly clones a single immutable shadow base', async () => {
    mockReadPublishedCodeGraphBase.mockResolvedValue({
      dbPath: '/base/generations/one/graph.db',
      manifest: {
        generationId: 'one',
        gitHead: 'abc',
        publishedAt: '2026-07-22T00:00:00.000Z',
      },
    });

    await expect(
      executeCodeGraphEagerSeed({
        operation: 'eager-seed',
        targetDbPath: '/target/graph.db',
        repositories: [{ repoId: 'root', rootPath: '/worktree' }],
        source: {
          kind: 'workspace-shadow',
          bases: [
            {
              variantDir: '/base',
              identity: {
                repoId: 'root',
                canonicalRepoRoot: '/source',
                customLanguagesFingerprint: 'languages',
              },
              destinationRootPath: '/worktree',
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 'seeded',
      source: 'workspace-shadow',
    });
    expect(mockReadPublishedCodeGraphBase).toHaveBeenCalledWith({
      variantDir: '/base',
      identity: {
        repoId: 'root',
        canonicalRepoRoot: '/source',
        customLanguagesFingerprint: 'languages',
      },
      validation: 'metadata-only',
    });
    expect(mockCloneCompletedCodeGraphDatabase).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceDbPath: '/base/generations/one/graph.db',
        copyMode: 'immutable-file-copy',
        sourceAlreadyValidated: true,
        targetValidation: 'metadata-only',
      }),
    );
  });

  it('fuses a complete multi-repository base set inside the worker', async () => {
    mockReadPublishedCodeGraphBase
      .mockResolvedValueOnce({
        dbPath: '/bases/a/graph.db',
        manifest: {
          generationId: 'a',
          gitHead: 'a1',
          publishedAt: '2026-07-22T00:00:00.000Z',
        },
      })
      .mockResolvedValueOnce({
        dbPath: '/bases/b/graph.db',
        manifest: {
          generationId: 'b',
          gitHead: 'b1',
          publishedAt: '2026-07-22T00:00:00.000Z',
        },
      });
    mockSeedCodeGraphDatabase.mockResolvedValue({
      installed: true,
      outcomes: [],
      durationMs: 20,
    });
    const bases = ['a', 'b'].map((repoId) => ({
      variantDir: `/bases/${repoId}`,
      identity: {
        repoId,
        canonicalRepoRoot: `/sources/${repoId}`,
        customLanguagesFingerprint: 'languages',
      },
      destinationRootPath: `/worktree/${repoId}`,
    }));

    await executeCodeGraphEagerSeed({
      operation: 'eager-seed',
      targetDbPath: '/target/graph.db',
      repositories: bases.map((base) => ({
        repoId: base.identity.repoId,
        rootPath: base.destinationRootPath,
      })),
      source: { kind: 'workspace-shadow', bases },
    });

    expect(mockSeedCodeGraphDatabase).toHaveBeenCalledWith(
      expect.objectContaining({
        targetDbPath: '/target/graph.db',
        customLanguagesFingerprint: 'languages',
        markCompletedFromSources: true,
        sources: [
          expect.objectContaining({ repoId: 'a' }),
          expect.objectContaining({ repoId: 'b' }),
        ],
      }),
    );
  });

  it('does not install a partial shadow-base set', async () => {
    mockReadPublishedCodeGraphBase
      .mockResolvedValueOnce({
        dbPath: '/bases/a/graph.db',
        manifest: {
          generationId: 'a',
          gitHead: null,
          publishedAt: '2026-07-22T00:00:00.000Z',
        },
      })
      .mockResolvedValueOnce(null);

    await expect(
      executeCodeGraphEagerSeed({
        operation: 'eager-seed',
        targetDbPath: '/target/graph.db',
        repositories: [
          { repoId: 'a', rootPath: '/worktree/a' },
          { repoId: 'b', rootPath: '/worktree/b' },
        ],
        source: {
          kind: 'workspace-shadow',
          bases: [
            {
              variantDir: '/bases/a',
              identity: {
                repoId: 'a',
                canonicalRepoRoot: '/sources/a',
                customLanguagesFingerprint: 'languages',
              },
              destinationRootPath: '/worktree/a',
            },
            {
              variantDir: '/bases/b',
              identity: {
                repoId: 'b',
                canonicalRepoRoot: '/sources/b',
                customLanguagesFingerprint: 'languages',
              },
              destinationRootPath: '/worktree/b',
            },
          ],
        },
      }),
    ).resolves.toMatchObject({ ok: true, status: 'no-compatible-source' });
    expect(mockSeedCodeGraphDatabase).not.toHaveBeenCalled();
  });
});
