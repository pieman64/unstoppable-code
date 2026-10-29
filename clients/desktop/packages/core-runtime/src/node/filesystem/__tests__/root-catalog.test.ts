import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  allocateAttachmentsRootId,
  buildCoworkRootCatalog,
  buildMultiRepoRootCatalog,
  buildSingleRepoRootCatalog,
  createFilesystemRoot,
  createFilesystemRootCatalog,
  findFilesystemRoot,
  hasVisibleRootEntries,
  readRootVisibility,
  type FilesystemRootCatalog,
} from '../root-catalog';

const summary = (catalog: FilesystemRootCatalog): string[] =>
  catalog.roots.map((root) =>
    [root.id, root.kind, root.gitAware ? 'git' : '-', root.absolutePath].join(
      ' ',
    ),
  );

describe('root catalog primitives', () => {
  it('allocates collision-safe attachments ids', () => {
    expect(allocateAttachmentsRootId(new Set())).toBe('attachments');
    expect(allocateAttachmentsRootId(new Set(['attachments']))).toBe(
      'canopy-attachments',
    );
    expect(
      allocateAttachmentsRootId(
        new Set(['attachments', 'canopy-attachments', 'canopy-attachments-3']),
      ),
    ).toBe('canopy-attachments-4');
  });

  it('keeps order and resolves duplicate ids to the last root', () => {
    const first = createFilesystemRoot({
      id: 'dup',
      name: 'First',
      kind: 'git-repo',
      absolutePath: '/a',
    });
    const second = { ...first, name: 'Second' };
    const catalog = createFilesystemRootCatalog([first, second]);

    expect(catalog.roots).toEqual([first, second]);
    expect(findFilesystemRoot(catalog, 'dup')).toBe(second);
    expect(findFilesystemRoot(catalog, 'missing')).toBeUndefined();
  });

  it('copies excluded descendants and defaults gitAware to false', () => {
    const excluded = ['/a/x'];
    const root = createFilesystemRoot({
      id: 'a',
      name: 'a',
      kind: 'standalone',
      absolutePath: '/a',
      excludedDescendantRoots: excluded,
    });
    excluded.push('/a/y');

    expect(root).toMatchObject({
      gitAware: false,
      excludedDescendantRoots: ['/a/x'],
    });
  });

  it('ignores .git when deciding visibility', () => {
    expect(hasVisibleRootEntries([])).toBe(false);
    expect(hasVisibleRootEntries(['.git'])).toBe(false);
    expect(hasVisibleRootEntries(['.git', '.keep'])).toBe(true);
  });

  describe('readRootVisibility', () => {
    let dir = '';
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'canopy-root-catalog-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('treats missing, empty, .git-only and file paths as hidden', async () => {
      mkdirSync(join(dir, 'empty'));
      mkdirSync(join(dir, 'git-only', '.git'), { recursive: true });
      writeFileSync(join(dir, 'file'), 'x');
      mkdirSync(join(dir, 'visible'));
      writeFileSync(join(dir, 'visible', 'a.txt'), 'x');

      const visibility = await Promise.all(
        ['missing', 'empty', 'git-only', 'file', 'visible'].map((name) =>
          readRootVisibility(join(dir, name)),
        ),
      );

      expect(visibility).toEqual([false, false, false, false, true]);
    });
  });
});

describe('root catalog layouts', () => {
  it('single-repo appends visible attachments after the repo', () => {
    const catalog = buildSingleRepoRootCatalog({
      repo: { id: 'attachments', name: 'attachments', absolutePath: '/wt' },
      attachments: { absolutePath: '/att', visible: true },
    });

    expect(summary(catalog)).toEqual([
      'attachments git-repo git /wt',
      'canopy-attachments attachments - /att',
    ]);
  });

  it('multi-repo keeps repo order and Windows-form paths verbatim', () => {
    const catalog = buildMultiRepoRootCatalog({
      workspaceRoot: {
        id: '__workspace_root__',
        name: 'Project root',
        absolutePath: 'C:\\wt',
        gitAware: false,
      },
      reposDir: 'C:\\wt\\repos',
      repos: [
        { id: 'zeta', name: 'Zeta', absolutePath: 'C:\\wt\\repos\\zeta' },
        { id: 'alpha', name: 'Alpha', absolutePath: 'C:\\wt\\repos\\alpha' },
      ],
      attachments: { absolutePath: 'C:\\att', visible: false },
    });

    expect(summary(catalog)).toEqual([
      '__workspace_root__ workspace-root - C:\\wt',
      'zeta git-repo git C:\\wt\\repos\\zeta',
      'alpha git-repo git C:\\wt\\repos\\alpha',
    ]);
    expect(catalog.roots[0]?.excludedDescendantRoots).toEqual([
      'C:\\wt\\repos',
      'C:\\wt\\repos\\zeta',
      'C:\\wt\\repos\\alpha',
    ]);
  });

  it('cowork excludes managed dirs even while attachments is hidden', () => {
    const catalog = buildCoworkRootCatalog({
      workspace: { id: 'workspace', name: 'Workspace', absolutePath: '/h' },
      notesPath: '/h/.c/notes',
      promptsPath: '/h/.c/prompts',
      attachments: { absolutePath: '/h/.c/attachments', visible: false },
    });

    expect(summary(catalog)).toEqual([
      'workspace standalone - /h',
      'notes standalone - /h/.c/notes',
      'prompts standalone - /h/.c/prompts',
    ]);
    expect(catalog.roots[0]?.excludedDescendantRoots).toEqual([
      '/h/.c/notes',
      '/h/.c/prompts',
      '/h/.c/attachments',
    ]);
  });
});
