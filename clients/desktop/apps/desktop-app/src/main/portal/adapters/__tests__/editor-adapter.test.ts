import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  FileIndexResponse,
  PortalChatFileReference,
  PortalCommandEnvelope,
  PortalEditorListFileMentionsPayload,
  PortalEditorFileMentionOption,
  PortalEditorFileMentionsResult,
} from '@canopy/desktop-shared/types';
import { buildFileGlobMatcher } from '../../../lib/file-glob-matcher';
import { listDirectory } from '../../../lib/file-system-listing';
import {
  buildFileIndexes,
  listFileTreeDirectory,
} from '../../../services/files-service';
import { portalFileReferences } from '../../portal-file-references';
import {
  handlePortalEditorListFileMentions,
  handlePortalEditorListSlashCommands,
} from '../editor-adapter';
import type { PortalAdapterContext } from '../types';
import { isRecord } from '../validation';
import { createDesktopRuntime } from '../../../canopy-runtime/desktop-runtime';
import { setDesktopCanopyRuntime } from '../../../canopy-runtime/desktop-runtime-access';

jest.mock('../../../services/files-service', () => ({
  buildFileIndexes: jest.fn(),
  listFileTreeDirectory: jest.fn(),
}));
jest.mock('../../../lib/paths', () => ({
  getWorkspaceWorktreesFilePath: jest.fn(),
}));
jest.mock('../../../lib/git', () => ({
  checkIgnoredPaths: jest.fn(() => Promise.resolve(new Set<string>())),
}));

function mentionRow(value: unknown): value is PortalEditorFileMentionOption {
  return (
    isRecord(value) &&
    typeof value.referenceId === 'string' &&
    typeof value.repoId === 'string' &&
    typeof value.repoName === 'string' &&
    typeof value.relativePath === 'string' &&
    typeof value.filename === 'string'
  );
}

function command(
  payload: PortalEditorListFileMentionsPayload,
): PortalCommandEnvelope<PortalEditorListFileMentionsPayload> {
  return {
    id: 'command',
    sequence: 1,
    type: 'portal.editor.list_file_mentions',
    createdAt: '2026-10-03T00:00:00.000Z',
    expiresAt: null,
    payload,
    target: {
      workspaceLocalId: payload.projectId,
      worktreeLocalId: payload.worktreeId,
    },
  };
}

describe('Portal editor opaque-reference integration', () => {
  let temporary = '';
  let source = '';
  let destination = '';
  let authorized = true;
  let listingHook: (() => void) | undefined;
  const completions: unknown[] = [];
  const failures: { code: string; message: string }[] = [];
  const context: PortalAdapterContext = {
    sessionId: 'session',
    canReadAssets: () => authorized,
    getWindow: () => null,
    enqueueEvent: () => undefined,
    complete: (_command, result) => {
      completions.push(result);
    },
    fail: (_command, code, message) => {
      failures.push({ code, message });
    },
  };
  const scope = {
    sessionId: 'session',
    projectId: 'workspace',
    worktreeId: 'source',
    canRead: (): boolean => authorized,
  };

  function catalog(root: string): FileIndexResponse {
    return {
      repos: [
        {
          repoId: 'repo',
          repoName: 'Repository',
          absolutePath: root,
          rootKind: 'git-repo',
          files: [
            {
              relativePath: 'src/file.ts',
              filename: 'file.ts',
              absolutePath: join(root, 'src/file.ts'),
              isIgnored: false,
            },
          ],
        },
      ],
    };
  }

  function completedRows(): PortalEditorFileMentionOption[] {
    const result = completions.at(-1);
    if (
      !isRecord(result) ||
      !Array.isArray(result.files) ||
      !result.files.every(mentionRow)
    )
      throw new Error('Expected typed mention completion.');
    return result.files;
  }

  function selectedReference(
    row: PortalEditorFileMentionOption,
  ): PortalChatFileReference {
    return {
      referenceId: row.referenceId,
      displayPath: row.relativePath || row.repoName,
      repoName: row.repoName,
      ...(row.kind ? { kind: row.kind } : {}),
      textStart: 3,
    };
  }

  beforeEach(async () => {
    jest.resetAllMocks();
    setDesktopCanopyRuntime(
      createDesktopRuntime({
        services: {
          listFileTreeRoots: () => Promise.resolve({ roots: [] }),
          listFileTreeDirectory,
        },
      }),
    );
    authorized = true;
    listingHook = undefined;
    completions.length = 0;
    failures.length = 0;
    portalFileReferences.clear();
    temporary = await mkdtemp(join(tmpdir(), 'portal-editor-'));
    source = join(temporary, 'source');
    destination = join(temporary, 'destination');
    for (const root of [source, destination]) {
      await mkdir(join(root, 'src'), { recursive: true });
      await mkdir(join(root, 'empty'));
      await writeFile(join(root, 'src/file.ts'), 'content');
    }
    jest
      .mocked(buildFileIndexes)
      .mockImplementation(({ worktreeId }) =>
        Promise.resolve(
          catalog(worktreeId === 'source' ? source : destination),
        ),
      );
    jest
      .mocked(listFileTreeDirectory)
      .mockImplementation(async ({ worktreeId, relativeDir }) => {
        const root = worktreeId === 'source' ? source : destination;
        const entries = await listDirectory(root, relativeDir, {
          gitAware: false,
          globMatcher: buildFileGlobMatcher({
            disabledBuiltinGlobIds: [],
            customGlobs: [
              { id: 'excluded', pattern: 'excluded/**', enabled: true },
            ],
          }),
        });
        listingHook?.();
        return { entries };
      });
  });

  afterEach(async () => {
    setDesktopCanopyRuntime(null);
    portalFileReferences.clear();
    jest.restoreAllMocks();
    await rm(temporary, { recursive: true, force: true });
  });

  it('lists opaque file ids that resolve only in the listed scope', async () => {
    await handlePortalEditorListFileMentions(
      command({ projectId: 'workspace', worktreeId: 'source' }),
      context,
    );
    const rows = completedRows();
    const row = rows[0];
    if (!row) throw new Error('Expected a file row.');
    expect(row.referenceId).toEqual(expect.any(String));
    expect(row).toEqual({
      repoId: 'repo',
      repoName: 'Repository',
      relativePath: 'src/file.ts',
      filename: 'file.ts',
      referenceId: row.referenceId,
    });
    expect(JSON.stringify(rows)).not.toContain(temporary);
    expect(
      portalFileReferences.resolve(scope, selectedReference(row)).absolutePath,
    ).toBe(join(source, 'src/file.ts'));
    expect(() =>
      portalFileReferences.resolve(
        { ...scope, worktreeId: 'destination' },
        selectedReference(row),
      ),
    ).toThrow('authorized');
  });

  it.each(['', 'empty', 'src'])(
    'mints and rebinds real directory selectors end to end: %j',
    async (relativePath) => {
      await handlePortalEditorListFileMentions(
        command({
          projectId: 'workspace',
          worktreeId: 'source',
          selector: { repoId: 'repo', relativePath, kind: 'directory' },
        }),
        context,
      );
      const row = completedRows()[0];
      if (!row) throw new Error('Expected a directory row.');
      const original = selectedReference(row);
      const rebind = command({
        projectId: 'workspace',
        worktreeId: 'destination',
        rebind: {
          sourceProjectId: 'workspace',
          sourceWorktreeId: 'source',
          fileReferences: [original],
        },
      });
      await handlePortalEditorListFileMentions(rebind, context);
      const rebound = portalFileReferences.mint(
        { ...scope, worktreeId: 'destination' },
        {
          absolutePath: join(destination, relativePath),
          displayPath: original.displayPath,
          repoName: 'Repository',
          kind: 'directory',
          textStart: 3,
        },
      );
      const expected: PortalEditorFileMentionsResult = {
        files: [],
        fileReferences: [rebound],
      };
      expect(completions.at(-1)).toEqual(expected);
      expect(rebound.referenceId).not.toBe(original.referenceId);
      expect(
        portalFileReferences.resolve(
          { ...scope, worktreeId: 'destination' },
          rebound,
        ),
      ).toMatchObject({
        absolutePath: join(destination, relativePath),
        kind: 'directory',
        textStart: 3,
      });
      expect(failures).toEqual([]);
      expect(JSON.stringify(completions)).not.toContain(temporary);
    },
  );

  it.each(['source', 'destination'])(
    'rejects an actual nested symlink during directory rebinding in %s',
    async (side) => {
      await mkdir(join(source, 'src/nested'));
      await mkdir(join(destination, 'src/nested'));
      const original = portalFileReferences.mint(scope, {
        absolutePath: join(source, 'src/nested'),
        displayPath: 'src/nested',
        repoName: 'Repository',
        kind: 'directory',
      });
      const root = side === 'source' ? source : destination;
      await rm(join(root, 'src'), { recursive: true });
      const outside = join(temporary, 'outside');
      await mkdir(join(outside, 'nested'), { recursive: true });
      await symlink(outside, join(root, 'src'));
      await handlePortalEditorListFileMentions(
        command({
          projectId: 'workspace',
          worktreeId: 'destination',
          rebind: {
            sourceProjectId: 'workspace',
            sourceWorktreeId: 'source',
            fileReferences: [original],
          },
        }),
        context,
      );
      expect(completions).toEqual([]);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.code).toBe('invalid_target');
      expect(failures[0]?.message).toContain('catalog');
      expect(JSON.stringify(failures)).not.toContain(temporary);
    },
  );

  it('rejects an actual ignored directory during rebinding without minting a destination id', async () => {
    for (const root of [source, destination])
      await mkdir(join(root, 'excluded/child'), { recursive: true });
    const original = portalFileReferences.mint(scope, {
      absolutePath: join(source, 'excluded/child'),
      displayPath: 'excluded/child',
      repoName: 'Repository',
      kind: 'directory',
    });
    const mint = jest.spyOn(portalFileReferences, 'mint');
    await handlePortalEditorListFileMentions(
      command({
        projectId: 'workspace',
        worktreeId: 'destination',
        rebind: {
          sourceProjectId: 'workspace',
          sourceWorktreeId: 'source',
          fileReferences: [original],
        },
      }),
      context,
    );
    expect(mint).not.toHaveBeenCalled();
    expect(completions).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.code).toBe('invalid_target');
    expect(failures[0]?.message).toContain('catalog');
  });

  it('rejects expiration during an awaited directory listing before a rebind completion', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const original = portalFileReferences.mint(scope, {
      absolutePath: join(source, 'empty'),
      displayPath: 'empty',
      repoName: 'Repository',
      kind: 'directory',
    });
    listingHook = (): void => {
      now += 30 * 60 * 1000;
    };
    const mint = jest.spyOn(portalFileReferences, 'mint');
    await handlePortalEditorListFileMentions(
      command({
        projectId: 'workspace',
        worktreeId: 'destination',
        rebind: {
          sourceProjectId: 'workspace',
          sourceWorktreeId: 'source',
          fileReferences: [original],
        },
      }),
      context,
    );
    expect(listFileTreeDirectory).toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
    expect(completions).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.code).toBe('invalid_target');
    expect(failures[0]?.message).toContain('authorized');
  });

  it('rejects revoked authorization after selector discovery', async () => {
    listingHook = (): void => {
      authorized = false;
    };
    await handlePortalEditorListFileMentions(
      command({
        projectId: 'workspace',
        worktreeId: 'source',
        selector: { repoId: 'repo', relativePath: 'src', kind: 'directory' },
      }),
      context,
    );
    expect(completions).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.code).toBe('invalid_target');
    expect(failures[0]?.message).toContain('authorized');
  });

  it.each([
    '../outside',
    '/outside',
    'src\\nested',
    'src/../nested',
    'src//nested',
  ])('rejects forged selector path %j', async (relativePath) => {
    await handlePortalEditorListFileMentions(
      command({
        projectId: 'workspace',
        worktreeId: 'source',
        selector: { repoId: 'repo', relativePath, kind: 'directory' },
      }),
      context,
    );
    expect(completions).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.code).toBe('invalid_payload');
    expect(failures[0]?.message).toContain('relative');
    expect(listFileTreeDirectory).not.toHaveBeenCalled();
  });

  it('rejects unknown roots and mismatched target without minting ids', async () => {
    await handlePortalEditorListFileMentions(
      command({
        projectId: 'workspace',
        worktreeId: 'source',
        selector: { repoId: 'unknown', relativePath: '', kind: 'directory' },
      }),
      context,
    );
    const wrongTarget = command({
      projectId: 'workspace',
      worktreeId: 'source',
      selector: { repoId: 'repo', relativePath: '', kind: 'directory' },
    });
    wrongTarget.target = {
      workspaceLocalId: 'other',
      worktreeLocalId: 'source',
    };
    await handlePortalEditorListFileMentions(wrongTarget, context);
    expect(completions).toEqual([]);
    expect(failures.map((failure) => failure.code)).toEqual([
      'invalid_target',
      'invalid_target',
    ]);
  });

  it('rejects mixed selector/rebind and malformed selector metadata', async () => {
    const mixed = command({
      projectId: 'workspace',
      worktreeId: 'source',
      selector: { repoId: 'repo', relativePath: '', kind: 'directory' },
      rebind: {
        sourceProjectId: 'workspace',
        sourceWorktreeId: 'source',
        fileReferences: [],
      },
    });
    await handlePortalEditorListFileMentions(mixed, context);
    for (const invalid of [
      { textStart: -1 },
      { textStart: Infinity },
      { textStart: 1.5 },
      { referenceId: '' },
      { absolutePath: source },
      { repoName: 7 },
      { kind: [] },
    ]) {
      const reference: PortalChatFileReference = {
        referenceId: 'reference',
        displayPath: 'file',
      };
      Object.assign(reference, invalid);
      await handlePortalEditorListFileMentions(
        command({
          projectId: 'workspace',
          worktreeId: 'destination',
          rebind: {
            sourceProjectId: 'workspace',
            sourceWorktreeId: 'source',
            fileReferences: [reference],
          },
        }),
        context,
      );
    }
    expect(completions).toEqual([]);
    expect(failures).toHaveLength(8);
    expect(
      failures.every((failure) => failure.code === 'invalid_payload'),
    ).toBe(true);
    expect(buildFileIndexes).not.toHaveBeenCalled();
  });
});

describe('portal.editor.list_slash_commands', () => {
  it('lists the catalog of the worktree row that core.worktree.get reads', async () => {
    const runtime = createDesktopRuntime({
      workspaceServices: {
        readAllSidebarItems: jest.fn(),
        readWorkspaceIndexEntry: jest.fn().mockResolvedValue({
          id: 'workspace',
          name: 'Workspace',
          type: 'single-repo',
        }),
        readWorkspaceConfig: jest.fn(),
        readWorkspaceWorktrees: jest.fn().mockResolvedValue([
          {
            id: 'source',
            branchName: 'feature/source',
            createdAt: '2026-10-03T00:00:00.000Z',
            discovery: {
              slashCommands: [{ name: 'review', description: 'Review' }],
              mcpServers: [],
              discoveredAt: '2026-10-03T00:00:00.000Z',
            },
          },
        ]),
        readEffectiveWorkspaceConfig: jest.fn(),
      },
    });
    setDesktopCanopyRuntime(runtime);
    const completions: unknown[] = [];
    try {
      await handlePortalEditorListSlashCommands(
        {
          id: 'command',
          sequence: 1,
          type: 'portal.editor.list_slash_commands',
          createdAt: '2026-10-03T00:00:00.000Z',
          expiresAt: null,
          payload: { projectId: 'workspace', worktreeId: 'source' },
        },
        {
          sessionId: 'session',
          getWindow: () => null,
          enqueueEvent: () => undefined,
          complete: (_command, result) => {
            completions.push(result);
          },
          fail: () => undefined,
        },
      );
    } finally {
      setDesktopCanopyRuntime(null);
      await runtime.shutdown();
    }
    expect(completions).toEqual([
      { commands: [{ name: 'review', description: 'Review' }] },
    ]);
  });
});
