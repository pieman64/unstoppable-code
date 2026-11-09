/**
 * CAN-6006: App Advisor's file tree mutations on the real desktop runtime and
 * worker engines over temporary folders (worker.filesystem.file.write,
 * worker.filesystem.directory.create, worker.filesystem.entry.copy,
 * worker.filesystem.entry.move and worker.filesystem.entry.delete), as the
 * advisor chat with only worker.filesystem.write. Covers the coordinator's conditions: root
 * containment for all five operations, a Trash-only delete, and no
 * overwrite beyond the window's own requests.
 */
import type * as NodeFsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppAdvisorActionResponse } from '@canopy/desktop-shared/types';
import type * as ElectronMock from '../../../__tests__/electronMock';

const mockTrashItem = jest.fn<Promise<void>, [string]>();
jest.mock('electron', () => {
  const actual = jest.requireActual<typeof ElectronMock>('electron');
  return {
    ...actual,
    shell: {
      ...actual.shell,
      trashItem: (path: string): Promise<void> => mockTrashItem(path),
    },
  };
});
jest.mock('../../lib/paths', () => ({
  getWorkspaceHomeDir: jest.fn(),
  getWorkspaceWorktreeRepoDir: jest.fn(),
  getWorkspaceWorktreeReposDir: jest.fn(),
  getWorkspaceWorktreeRootRepoDir: jest.fn(),
  getWorktreeAttachmentsDir: jest.fn(),
  getWorkspaceWorktreeAttachmentsDir: jest.fn(),
}));
jest.mock('../../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
  resolveWorktreeTargetIds: jest.fn(),
}));
jest.mock('../../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
}));
jest.mock('../../lib/workspace-registry', () => ({
  isMultiRepoWorkspace: jest.fn(() => false),
  isCoworkWorkspace: jest.fn(() => false),
}));

import { getWorktreeAttachmentsDir } from '../../lib/paths';
import {
  resolveWorktreeCwd,
  resolveWorktreeTargetIds,
} from '../../lib/resolve-worktree';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../../canopy-runtime/desktop-runtime-identity';
import {
  dispatchAdvisorFileTreeAction,
  type AdvisorFileTreeAction,
} from '../advisor-file-tree-actions';
import { mainAdvisorFileTreeActionHost } from '../advisor-file-tree-actions-host';

const fs = jest.requireActual<typeof NodeFsPromises>('node:fs/promises');
const itPosix = process.platform !== 'win32' ? it : it.skip;
const SCOPE = { projectId: 'project-1', worktreeId: 'wt-1' };

let tempRoot = '';
let repo = '';
let outside = '';
let runtime: DesktopCanopyDispatcher;

function ref(relativePath: string): {
  repoId: string;
  relativePath: string;
} {
  return { repoId: 'project-1', relativePath };
}

function run(
  action: AdvisorFileTreeAction,
): Promise<Omit<AppAdvisorActionResponse, 'requestId'>> {
  return dispatchAdvisorFileTreeAction(
    action,
    mainAdvisorFileTreeActionHost({
      chatId: 'advisor-chat',
      runtime: () => runtime,
    }),
  );
}

async function put(path: string, content: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, content);
}

/** Every entry under `root`: file content, `dir`, or `-> link target`. */
async function tree(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const name of (await fs.readdir(directory)).sort()) {
      const path = join(directory, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const info = await fs.lstat(path);
      if (info.isSymbolicLink()) {
        entries[relativePath] = `-> ${await fs.readlink(path)}`;
      } else if (info.isDirectory()) {
        entries[`${relativePath}/`] = 'dir';
        await walk(path, relativePath);
      } else {
        entries[relativePath] = await fs.readFile(path, 'utf8');
      }
    }
  }
  await walk(root, '');
  return entries;
}

beforeEach(async () => {
  tempRoot = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'can-6006-file-tree-')),
  );
  repo = join(tempRoot, 'repo');
  outside = join(tempRoot, 'outside');
  await put(join(repo, 'src', 'index.ts'), 'export {};\n');
  await put(join(repo, 'docs', 'intro.md'), '# Intro\n');
  await put(join(outside, 'secret.txt'), 'secret\n');
  await fs.mkdir(join(tempRoot, 'attachments'));
  jest.mocked(resolveWorktreeCwd).mockReturnValue(repo);
  jest
    .mocked(getWorktreeAttachmentsDir)
    .mockReturnValue(join(tempRoot, 'attachments'));
  jest
    .mocked(resolveWorktreeTargetIds)
    .mockImplementation((projectId, worktreeId) => ({
      projectId,
      worktreeId,
    }));
  mockTrashItem.mockReset();
  mockTrashItem.mockResolvedValue(undefined);
  runtime = createDesktopRuntime({ shutdownTimeoutMs: 1_000 });
});

afterEach(async () => {
  await runtime.shutdown();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('App Advisor file tree actions on the desktop runtime (CAN-6006)', () => {
  it('calls the explorer owners as the advisor chat with only worker.filesystem.write', async () => {
    const create = jest.spyOn(runtime, 'createFileTreeEntryForLegacyIpc');
    await expect(
      run({
        type: 'file-tree.create_file',
        ...SCOPE,
        target: ref('src/new.ts'),
      }),
    ).resolves.toEqual({
      ok: true,
      result: { operation: 'create-file', target: ref('src/new.ts') },
    });
    expect(create.mock.calls).toEqual([
      [
        { operation: 'create-file', ...SCOPE, target: ref('src/new.ts') },
        {
          caller: {
            principalId: 'local-desktop-user',
            clientInstanceId: 'agent-action:advisor-chat',
            authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
            interfaceKind: 'mcp',
            grants: ['worker.filesystem.write'],
          },
        },
      ],
    ]);
  });

  itPosix(
    'refuses ../ and symlink escapes for every operation, source and destination, and touches nothing outside',
    async () => {
      await fs.symlink(outside, join(repo, 'escape'));
      const before = await tree(repo);
      const escapes: AdvisorFileTreeAction[] = [];
      for (const path of ['../made.txt', 'escape/made.txt']) {
        escapes.push(
          { type: 'file-tree.create_file', ...SCOPE, target: ref(path) },
          { type: 'file-tree.create_directory', ...SCOPE, target: ref(path) },
        );
      }
      for (const path of ['../outside/secret.txt', 'escape/secret.txt']) {
        escapes.push(
          { type: 'file-tree.delete', ...SCOPE, target: ref(path) },
          {
            type: 'file-tree.copy',
            ...SCOPE,
            source: ref(path),
            target: ref('copied.txt'),
          },
          {
            type: 'file-tree.move',
            ...SCOPE,
            source: ref(path),
            target: ref('moved.txt'),
          },
        );
      }
      for (const path of ['../landed.ts', 'escape/landed.ts']) {
        escapes.push(
          {
            type: 'file-tree.copy',
            ...SCOPE,
            source: ref('src/index.ts'),
            target: ref(path),
          },
          {
            type: 'file-tree.move',
            ...SCOPE,
            source: ref('src/index.ts'),
            target: ref(path),
          },
        );
      }
      escapes.push({
        type: 'file-tree.delete',
        ...SCOPE,
        target: ref('escape'),
      });
      // Both escapes for each create, source, destination and delete.
      expect(escapes).toHaveLength(15);

      const notContained: unknown[] = [];
      for (const action of escapes) {
        const result = await run(action);
        if (
          result.ok ||
          result.error?.code !== 'execution_failed' ||
          !/outside the selected worktree root|traverse outside the worktree/.test(
            result.error.message,
          )
        )
          notContained.push({ action, result });
      }
      expect(notContained).toEqual([]);
      expect(await tree(outside)).toEqual({ 'secret.txt': 'secret\n' });
      expect(await fs.readdir(tempRoot)).toEqual([
        'attachments',
        'outside',
        'repo',
      ]);
      expect(await tree(repo)).toEqual(before);
      expect(mockTrashItem).not.toHaveBeenCalled();
    },
  );

  it('deletes only to the Trash, with the lexical path', async () => {
    await expect(
      run({ type: 'file-tree.delete', ...SCOPE, target: ref('docs') }),
    ).resolves.toEqual({
      ok: true,
      result: { operation: 'delete', target: ref('docs') },
    });
    expect(mockTrashItem.mock.calls).toEqual([[join(repo, 'docs')]]);
    // The Trash is the shell's; nothing was removed here.
    expect(await fs.readFile(join(repo, 'docs', 'intro.md'), 'utf8')).toBe(
      '# Intro\n',
    );
  });

  it('refuses with the Trash error when the Trash fails, and never deletes permanently', async () => {
    mockTrashItem.mockRejectedValue(new Error('Trash is unavailable'));
    await expect(
      run({ type: 'file-tree.delete', ...SCOPE, target: ref('src/index.ts') }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'execution_failed',
        message: 'Trash is unavailable',
        retryable: true,
      },
    });
    expect(mockTrashItem).toHaveBeenCalledTimes(1);
    expect(await tree(repo)).toEqual({
      'docs/': 'dir',
      'docs/intro.md': '# Intro\n',
      'src/': 'dir',
      'src/index.ts': 'export {};\n',
    });
  });

  it('never replaces an existing entry: a move or plain copy is refused, and an increment copy takes a new name', async () => {
    const occupied: AdvisorFileTreeAction[] = [
      {
        type: 'file-tree.move',
        ...SCOPE,
        source: ref('src/index.ts'),
        target: ref('docs/intro.md'),
      },
      {
        type: 'file-tree.copy',
        ...SCOPE,
        source: ref('src/index.ts'),
        target: ref('docs/intro.md'),
      },
      {
        type: 'file-tree.copy',
        ...SCOPE,
        source: ref('src/index.ts'),
        target: ref('docs/intro.md'),
        conflict: 'error',
      },
      { type: 'file-tree.create_file', ...SCOPE, target: ref('docs/intro.md') },
      { type: 'file-tree.create_directory', ...SCOPE, target: ref('docs') },
    ];
    for (const action of occupied)
      expect({ action, result: await run(action) }).toMatchObject({
        action,
        result: { ok: false, error: { code: 'execution_failed' } },
      });
    expect(await tree(repo)).toEqual({
      'docs/': 'dir',
      'docs/intro.md': '# Intro\n',
      'src/': 'dir',
      'src/index.ts': 'export {};\n',
    });

    const incremented = await run({
      type: 'file-tree.copy',
      ...SCOPE,
      source: ref('src/index.ts'),
      target: ref('docs/intro.md'),
      conflict: 'increment',
    });
    expect(incremented).toMatchObject({
      ok: true,
      result: { operation: 'copy' },
    });
    expect(await fs.readFile(join(repo, 'docs', 'intro.md'), 'utf8')).toBe(
      '# Intro\n',
    );
    expect(Object.keys(await tree(join(repo, 'docs'))).length).toBe(2);
  });
});
