import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const mockGetCanopyDataDir = jest.fn<string, []>();
const mockResolveViewerRoots = jest.fn<Promise<unknown>, unknown[]>();
const mockReadWorkspaceConfig = jest.fn<Promise<unknown>, [string]>();

jest.mock('@canopy/desktop-shared/canopy-paths', () => ({
  getCanopyDataDir: (): string => mockGetCanopyDataDir(),
}));

jest.mock('../lib/workspace-persistence', () => ({
  ...jest.requireActual<object>('../lib/workspace-persistence'),
  readWorkspaceConfig: (id: string): Promise<unknown> =>
    mockReadWorkspaceConfig(id),
}));

jest.mock('../shared-containers/read/viewer-root', () => ({
  resolveSharedContainerViewerReadRoots: (
    ...args: unknown[]
  ): Promise<unknown> => mockResolveViewerRoots(...args),
}));

import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import {
  APP_ADVISOR_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { getFileBrowserRoots } from '../lib/file-browser-roots';
import { getAppAdvisorHomeDir, getWorkspaceHomeDir } from '../lib/paths';
import { registerWorkspaceTypes } from '../lib/workspace-registry';

describe('getFileBrowserRoots cowork project roots', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'canopy-file-browser-roots-'));
    mockGetCanopyDataDir.mockReturnValue(tempDir);
    registerWorkspaceTypes(new Map());
    mockResolveViewerRoots.mockReset();
  });

  afterEach(() => {
    registerWorkspaceTypes(new Map());
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns cowork workspace/notes/prompts roots for a real cowork project id', async () => {
    registerWorkspaceTypes(new Map([['cowork-default', 'cowork']]));
    const home = getWorkspaceHomeDir('cowork-default');

    const result = await getFileBrowserRoots('cowork-default', 'home');

    // The workspace folder itself is the primary root, labeled "Workspace".
    const workspaceRoot = result.roots.find(
      (root) => root.repoId === 'workspace',
    );
    expect(workspaceRoot?.absolutePath).toBe(home);
    expect(workspaceRoot?.repoName).toBe('Workspace');
    expect(result.roots[0]?.repoId).toBe('workspace');
    expect(
      result.roots.find((root) => root.repoId === 'notes')?.absolutePath,
    ).toBe(getCoworkManagedSubdir(home, 'notes'));
    expect(
      result.roots.find((root) => root.repoId === 'prompts')?.absolutePath,
    ).toBe(getCoworkManagedSubdir(home, 'prompts'));
    // No git-repo root: cowork workspaces are not git worktree chats.
    expect(result.roots.some((root) => root.rootKind === 'git-repo')).toBe(
      false,
    );
  });

  it('excludes the managed notes/prompts/attachments dirs from the project root scan', async () => {
    registerWorkspaceTypes(new Map([['cowork-default', 'cowork']]));
    const home = getWorkspaceHomeDir('cowork-default');

    const result = await getFileBrowserRoots('cowork-default', 'home');

    // The managed dirs live inside the workspace folder but are surfaced as
    // their own, more specific roots — the workspace root's scan skips them
    // so Cmd+P / file-explorer listings never show the same file twice.
    const workspaceRoot = result.roots.find(
      (root) => root.repoId === 'workspace',
    );
    expect(workspaceRoot?.excludedDescendantRoots).toEqual([
      getCoworkManagedSubdir(home, 'notes'),
      getCoworkManagedSubdir(home, 'prompts'),
      getCoworkManagedSubdir(home, 'attachments'),
    ]);
  });

  it('includes an attachments root for a real cowork project id when the attachments dir has visible files', async () => {
    registerWorkspaceTypes(new Map([['cowork-default', 'cowork']]));
    const home = getWorkspaceHomeDir('cowork-default');
    const attachmentsDir = getCoworkManagedSubdir(home, 'attachments');
    mkdirSync(attachmentsDir, { recursive: true });
    writeFileSync(join(attachmentsDir, 'file.txt'), 'hello');

    const result = await getFileBrowserRoots('cowork-default', 'home');

    expect(result.roots.some((root) => root.rootKind === 'attachments')).toBe(
      true,
    );
  });

  it('still returns cowork roots for the legacy standalone-chat sentinel keying', async () => {
    registerWorkspaceTypes(new Map([['legacy-project-a', 'cowork']]));
    const home = getWorkspaceHomeDir('legacy-project-a');

    const result = await getFileBrowserRoots(
      'standalone-chat',
      'legacy-project-a',
    );

    expect(
      result.roots.find((root) => root.repoId === 'notes')?.absolutePath,
    ).toBe(getCoworkManagedSubdir(home, 'notes'));
  });

  it('falls back to a plain git-repo root for a non-cowork project id', async () => {
    const result = await getFileBrowserRoots('project-a', 'wt-a');

    expect(result.roots[0]?.rootKind).toBe('git-repo');
    expect(result.roots.some((root) => root.repoId === 'notes')).toBe(false);
  });

  it('shows only the shared App Advisor home, not private entry attachments', async () => {
    const result = await getFileBrowserRoots(APP_ADVISOR_PROJECT_ID, 'entry-a');

    expect(result.roots).toEqual([
      expect.objectContaining({
        repoId: APP_ADVISOR_PROJECT_ID,
        absolutePath: getAppAdvisorHomeDir(),
        rootKind: 'standalone',
        gitAware: false,
      }),
    ]);
  });

  it('projects the current sealed recipient replica as read-only roots', async () => {
    mockResolveViewerRoots.mockResolvedValue([
      {
        repoId: 'repo-a',
        repoName: 'Repository A',
        absolutePath: '/sealed/revision/repos/repo-a',
        revisionRoot: '/sealed/revision',
        revisionId: 'revision-a',
      },
    ]);

    const result = await getFileBrowserRoots(
      SHARED_CONTAINER_VIEWER_PROJECT_ID,
      'container-a',
    );

    expect(mockResolveViewerRoots).toHaveBeenCalledWith('container-a');
    expect(result.roots).toEqual([
      expect.objectContaining({
        repoId: 'repo-a',
        absolutePath: '/sealed/revision/repos/repo-a',
        readBoundaryRoot: '/sealed/revision',
        rootKind: 'standalone',
        gitAware: false,
      }),
    ]);
  });
});

// Goldens captured from the pre-extraction implementation. Row format:
// `id | name | kind | git? | path | excluded...`, paths relative to data dir.
describe('getFileBrowserRoots golden catalogs', () => {
  let dataDir = '';

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'canopy-file-browser-golden-'));
    mockGetCanopyDataDir.mockReturnValue(dataDir);
    registerWorkspaceTypes(new Map());
    mockReadWorkspaceConfig.mockReset();
  });

  afterEach(() => {
    registerWorkspaceTypes(new Map());
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function golden(
    projectId: string,
    worktreeId: string,
  ): Promise<{ rows: string[]; map: string[] }> {
    const rel = (path: string): string => relative(dataDir, path);
    const { roots, rootMap } = await getFileBrowserRoots(projectId, worktreeId);
    const rows = roots.map((root) =>
      [
        root.repoId,
        root.repoName,
        root.rootKind,
        root.gitAware ? 'git' : '-',
        rel(root.absolutePath),
        ...root.excludedDescendantRoots.map(rel),
      ].join(' | '),
    );
    const map = Array.from(rootMap, ([id, root]) => `${id} ${root.repoName}`);
    return { rows, map };
  }

  function seedDir(path: string, entries: string[]): void {
    mkdirSync(path, { recursive: true });
    entries.forEach((name) => {
      if (name === '.git') mkdirSync(join(path, name));
      else writeFileSync(join(path, name), 'x');
    });
  }

  it.each<[string, string[] | null, boolean]>([
    ['missing', null, false],
    ['empty', [], false],
    ['.git-only', ['.git'], false],
    ['dotfile', ['.keep'], true],
    ['visible', ['.git', 'a.txt'], true],
  ])('single-repo attachments: %s', async (_label, entries, visible) => {
    const attachments = 'workspaces/project-a/attachments/wt-a';
    if (entries) seedDir(join(dataDir, attachments), entries);

    const { rows } = await golden('project-a', 'wt-a');

    expect(rows).toEqual([
      'project-a | project-a | git-repo | git | workspaces/project-a/worktrees/wt-a',
      ...(visible
        ? [`attachments | attachments | attachments | - | ${attachments}`]
        : []),
    ]);
  });

  it('suffixes the attachments id when the project id is "attachments"', async () => {
    seedDir(join(dataDir, 'workspaces/attachments/attachments/wt-a'), ['a']);

    const { rows } = await golden('attachments', 'wt-a');

    expect(rows).toEqual([
      'attachments | attachments | git-repo | git | workspaces/attachments/worktrees/wt-a',
      'canopy-attachments | attachments | attachments | - | workspaces/attachments/attachments/wt-a',
    ]);
  });

  it('multi-repo keeps config order, excludes repos and avoids id collisions', async () => {
    registerWorkspaceTypes(new Map([['ws-a', 'multi-repo']]));
    mockReadWorkspaceConfig.mockResolvedValue({
      sourceRepoPath: '/src/ws-a',
      repos: [
        { id: 'zeta', name: 'Zeta' },
        { id: 'attachments', name: 'Att' },
        { id: 'canopy-attachments', name: 'Two' },
        { id: 'alpha', name: 'Alpha' },
      ],
    });
    seedDir(join(dataDir, 'workspaces/ws-a/attachments/wt-a'), ['a.txt']);

    const { rows, map } = await golden('ws-a', 'wt-a');

    const wt = 'workspaces/ws-a/worktrees/wt-a';
    expect(rows).toEqual([
      `__workspace_root__ | Project root | workspace-root | git | ${wt} | ${wt}/repos | ${wt}/repos/zeta | ${wt}/repos/attachments | ${wt}/repos/canopy-attachments | ${wt}/repos/alpha`,
      `zeta | Zeta | git-repo | git | ${wt}/repos/zeta`,
      `attachments | Att | git-repo | git | ${wt}/repos/attachments`,
      `canopy-attachments | Two | git-repo | git | ${wt}/repos/canopy-attachments`,
      `alpha | Alpha | git-repo | git | ${wt}/repos/alpha`,
      'canopy-attachments-3 | attachments | attachments | - | workspaces/ws-a/attachments/wt-a',
    ]);
    expect(map).toHaveLength(6);
  });

  it('multi-repo without a source repo, .git-only attachments and duplicate ids', async () => {
    registerWorkspaceTypes(new Map([['ws-b', 'multi-repo']]));
    mockReadWorkspaceConfig.mockResolvedValue({
      repos: [
        { id: 'dup', name: 'First' },
        { id: 'dup', name: 'Second' },
      ],
    });
    seedDir(join(dataDir, 'workspaces/ws-b/attachments/wt-b'), ['.git']);

    const { rows, map } = await golden('ws-b', 'wt-b');

    const wt = 'workspaces/ws-b/worktrees/wt-b';
    expect(rows).toEqual([
      `__workspace_root__ | Project root | workspace-root | - | ${wt} | ${wt}/repos | ${wt}/repos/dup | ${wt}/repos/dup`,
      `dup | First | git-repo | git | ${wt}/repos/dup`,
      `dup | Second | git-repo | git | ${wt}/repos/dup`,
    ]);
    expect(map).toEqual(['__workspace_root__ Project root', 'dup Second']);
  });

  it.each([false, true])(
    'cowork orders workspace, notes, prompts, attachments (visible: %s)',
    async (visible) => {
      registerWorkspaceTypes(new Map([['cowork-a', 'cowork']]));
      const home = getWorkspaceHomeDir('cowork-a');
      const [notes, prompts, attachments] = (
        ['notes', 'prompts', 'attachments'] as const
      ).map((sub) => relative(dataDir, getCoworkManagedSubdir(home, sub)));
      if (visible) seedDir(join(dataDir, attachments), ['a.txt']);

      const { rows } = await golden('cowork-a', 'home');

      expect(rows).toEqual([
        `workspace | Workspace | standalone | - | workspaces/cowork-a/home | ${notes} | ${prompts} | ${attachments}`,
        `notes | notes | standalone | - | ${notes}`,
        `prompts | prompts | standalone | - | ${prompts}`,
        ...(visible
          ? [`attachments | attachments | attachments | - | ${attachments}`]
          : []),
      ]);
    },
  );
});
