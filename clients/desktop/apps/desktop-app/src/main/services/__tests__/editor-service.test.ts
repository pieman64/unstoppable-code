/**
 * Unit tests for the portal editor catalog service that backs the new
 * `portal.editor.list_slash_commands` and `portal.editor.list_file_mentions`
 * commands (Phase 5). The service reads cached worktree discovery for
 * slash commands through `core.worktree.get`, served here by stub workspace
 * reads, and reuses the mocked file-index builder for mentions.
 */
jest.mock('../../lib/validation', () => ({
  validateId: jest.fn((value: string, field: string): void => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
      throw new Error(`Invalid ${field}: ${value}`);
    }
  }),
}));
jest.mock('../files-service', () => ({
  buildFileIndexes: jest.fn(),
}));

import type {
  WorkspaceIndexEntry,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import { setDesktopCanopyRuntime } from '../../canopy-runtime/desktop-runtime-access';
import {
  listEditorFileMentions,
  listEditorSlashCommands,
} from '../editor-service';
import { buildFileIndexes } from '../files-service';

const mockedBuildFileIndexes = buildFileIndexes as jest.MockedFunction<
  typeof buildFileIndexes
>;
const SESSION = { sessionId: 'session-1' };

const WORKSPACE_ONE: WorkspaceIndexEntry = {
  id: 'workspace-1',
  name: 'One',
  type: 'single-repo',
  color: '#fff',
  collapsed: false,
  order: 0,
};

const DISCOVERED: WorktreeData = {
  id: 'wt-1',
  branchName: 'feature/foo',
  createdAt: '2026-05-12T00:00:00.000Z',
  discovery: {
    slashCommands: [
      {
        name: 'branch',
        description: 'Name a branch',
        insertText: '/branch ',
      },
    ],
    mcpServers: [],
    discoveredAt: '2026-05-12T00:00:00.000Z',
    providerType: 'claude',
  },
};

describe('editor-service', () => {
  const runtimes: DesktopCanopyDispatcher[] = [];
  let readWorkspaceWorktrees: jest.Mock;

  /** workspace-1's rows, served only through `core.worktree.get`. */
  function useWorktrees(rows: WorktreeData[] | Error): void {
    readWorkspaceWorktrees = jest.fn(() =>
      rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows),
    );
    const runtime = createDesktopRuntime({
      workspaceServices: {
        readAllSidebarItems: jest.fn(),
        readWorkspaceIndexEntry: jest.fn((workspaceId: string) =>
          Promise.resolve(
            workspaceId === WORKSPACE_ONE.id ? WORKSPACE_ONE : null,
          ),
        ),
        readWorkspaceConfig: jest.fn(),
        readWorkspaceWorktrees,
        readEffectiveWorkspaceConfig: jest.fn(),
      },
    });
    runtimes.push(runtime);
    setDesktopCanopyRuntime(runtime);
  }

  beforeEach(() => {
    jest.resetAllMocks();
  });

  afterEach(async () => {
    setDesktopCanopyRuntime(null);
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
  });

  it('returns the cached slash-command catalog of the worktree row', async () => {
    useWorktrees([DISCOVERED]);

    const result = await listEditorSlashCommands(
      { projectId: 'workspace-1', worktreeId: 'wt-1' },
      SESSION,
    );

    expect(result).toEqual([
      { name: 'branch', description: 'Name a branch', insertText: '/branch ' },
    ]);
    expect(readWorkspaceWorktrees).toHaveBeenCalledWith('workspace-1');
  });

  it('returns an empty list when the worktree has no discovery cached', async () => {
    useWorktrees([
      {
        id: 'wt-1',
        branchName: 'feature/foo',
        createdAt: '2026-05-12T00:00:00.000Z',
      },
    ]);

    const result = await listEditorSlashCommands(
      { projectId: 'workspace-1', worktreeId: 'wt-1' },
      SESSION,
    );
    expect(result).toEqual([]);
  });

  it("returns an empty list for another provider's catalog", async () => {
    useWorktrees([DISCOVERED]);

    const result = await listEditorSlashCommands(
      { projectId: 'workspace-1', worktreeId: 'wt-1', providerType: 'codex' },
      SESSION,
    );
    expect(result).toEqual([]);
  });

  it('returns an empty list when the worktree cannot be read', async () => {
    useWorktrees(new Error('boom'));
    await expect(
      listEditorSlashCommands(
        { projectId: 'workspace-1', worktreeId: 'wt-1' },
        SESSION,
      ),
    ).resolves.toEqual([]);

    // Not indexed, not listed, or no runtime: no catalog either.
    useWorktrees([DISCOVERED]);
    await expect(
      listEditorSlashCommands(
        { projectId: 'workspace-2', worktreeId: 'wt-1' },
        SESSION,
      ),
    ).resolves.toEqual([]);
    await expect(
      listEditorSlashCommands(
        { projectId: 'workspace-1', worktreeId: 'wt-2' },
        SESSION,
      ),
    ).resolves.toEqual([]);
    setDesktopCanopyRuntime(null);
    await expect(
      listEditorSlashCommands(
        { projectId: 'workspace-1', worktreeId: 'wt-1' },
        SESSION,
      ),
    ).resolves.toEqual([]);
  });

  it('honors the limit and applies fuzzy contains over file mentions', async () => {
    mockedBuildFileIndexes.mockResolvedValueOnce({
      repos: [
        {
          repoId: 'r1',
          repoName: 'main',
          absolutePath: '/abs/repo',
          rootKind: 'git-repo',
          files: [
            {
              relativePath: 'src/index.ts',
              filename: 'index.ts',
              absolutePath: '/abs/repo/src/index.ts',
              isIgnored: false,
            },
            {
              relativePath: 'src/helper.ts',
              filename: 'helper.ts',
              absolutePath: '/abs/repo/src/helper.ts',
              isIgnored: false,
            },
            {
              relativePath: 'README.md',
              filename: 'README.md',
              absolutePath: '/abs/repo/README.md',
              isIgnored: false,
            },
            {
              relativePath: 'node_modules/x.js',
              filename: 'x.js',
              absolutePath: '/abs/repo/node_modules/x.js',
              isIgnored: true,
            },
          ],
        },
      ],
    });

    const result = await listEditorFileMentions({
      projectId: 'workspace-1',
      worktreeId: 'wt-1',
      query: 'src',
      limit: 5,
    });

    // The "src" query matches both .ts files; the README does not contain
    // "src" and the ignored node_modules entry is filtered.
    expect(result).toHaveLength(2);
    expect(result[0].relativePath).toBe('src/index.ts');
    expect(result[0].absolutePath).toBe('/abs/repo/src/index.ts');
    expect(result[1].relativePath).toBe('src/helper.ts');
  });

  it('caps mention results at the protocol maximum', async () => {
    const files = Array.from({ length: 250 }, (_, i) => ({
      relativePath: `src/file-${i}.ts`,
      filename: `file-${i}.ts`,
      absolutePath: `/abs/repo/src/file-${i}.ts`,
      isIgnored: false,
    }));
    mockedBuildFileIndexes.mockResolvedValueOnce({
      repos: [
        {
          repoId: 'r1',
          repoName: 'main',
          absolutePath: '/abs/repo',
          rootKind: 'git-repo',
          files,
        },
      ],
    });

    const result = await listEditorFileMentions({
      projectId: 'workspace-1',
      worktreeId: 'wt-1',
      limit: 1000,
    });
    expect(result).toHaveLength(200);
  });
});
