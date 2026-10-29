/**
 * Unit tests for the portal editor catalog service that backs the new
 * `portal.editor.list_slash_commands` and `portal.editor.list_file_mentions`
 * commands (Phase 5). The service reads cached worktree discovery for
 * slash commands and reuses the existing file-index builder for mentions —
 * both helpers are mocked here so the tests stay deterministic.
 */
jest.mock('node:fs/promises', () => ({
  readFile: jest.fn(),
}));
jest.mock('../../lib/paths', () => ({
  getWorkspaceWorktreesFilePath: jest.fn(
    () => '/mock/workspace/worktrees.json',
  ),
}));
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

import { readFile } from 'node:fs/promises';
import {
  listEditorFileMentions,
  listEditorSlashCommands,
} from '../editor-service';
import { buildFileIndexes } from '../files-service';

const mockedReadFile = readFile as jest.MockedFunction<typeof readFile>;
const mockedBuildFileIndexes = buildFileIndexes as jest.MockedFunction<
  typeof buildFileIndexes
>;

describe('editor-service', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns the cached slash-command catalog from worktrees.json', async () => {
    mockedReadFile.mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        worktrees: [
          {
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
          },
        ],
      }),
    );

    const result = await listEditorSlashCommands({
      projectId: 'workspace-1',
      worktreeId: 'wt-1',
    });

    expect(result).toEqual([
      { name: 'branch', description: 'Name a branch', insertText: '/branch ' },
    ]);
  });

  it('returns an empty list when the worktree has no discovery cached', async () => {
    mockedReadFile.mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        worktrees: [
          {
            id: 'wt-1',
            branchName: 'feature/foo',
            createdAt: '2026-05-12T00:00:00.000Z',
          },
        ],
      }),
    );

    const result = await listEditorSlashCommands({
      projectId: 'workspace-1',
      worktreeId: 'wt-1',
    });
    expect(result).toEqual([]);
  });

  it('returns an empty list when worktrees.json cannot be read', async () => {
    mockedReadFile.mockRejectedValueOnce(new Error('boom'));
    const result = await listEditorSlashCommands({
      projectId: 'workspace-1',
      worktreeId: 'wt-1',
    });
    expect(result).toEqual([]);
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
