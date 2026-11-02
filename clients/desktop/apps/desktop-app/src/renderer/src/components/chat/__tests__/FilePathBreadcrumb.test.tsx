/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FileTreeEntry, FileTreeRoot } from '@canopy/desktop-shared/types';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { FilePathBreadcrumb } from '../FilePathBreadcrumb';

function entry(
  name: string,
  kind: FileTreeEntry['kind'],
  relativePath: string = name,
): FileTreeEntry {
  return {
    name,
    relativePath,
    absolutePath: `/repo/${relativePath}`,
    kind,
    isIgnored: false,
    isIndexExcluded: false,
    isSymlink: false,
    hasChildren: kind === 'directory',
  };
}

const mockFileListState = {
  rootsCache: {} as Record<string, { data: { roots: FileTreeRoot[] } }>,
  directoryCache: {
    'root-dir': {
      data: {
        entries: [
          entry('secret-folder', 'directory'),
          entry('secret-notes.md', 'file'),
        ],
      },
      fetchedAt: Date.now(),
    },
  },
  directoryErrors: {},
  directoryLoading: new Set<string>(),
  fetchFileTreeDirectory: jest.fn(),
};

jest.mock('@/stores/fileListStore', () => ({
  getWorktreeCacheKey: (): string => 'project-1/worktree-1',
  getDirectoryCacheKey: (): string => 'root-dir',
  isFileTreeCacheStale: (): boolean => false,
  useFileListStore: (
    selector: (state: typeof mockFileListState) => unknown,
  ): unknown => selector(mockFileListState),
}));

jest.mock('@/stores/chatStore', () => ({
  useChatStore: (
    selector: (state: { openFileTab: () => void }) => unknown,
  ): unknown => selector({ openFileTab: jest.fn() }),
}));

const root: FileTreeRoot = {
  repoId: 'repo-1',
  repoName: 'repo',
  absolutePath: '/repo',
  rootKind: 'git-repo',
};

describe('FilePathBreadcrumb', () => {
  let container: HTMLDivElement;
  let reactRoot: Root;

  beforeEach(() => {
    mockFileListState.rootsCache = {};
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
  });

  afterEach(() => {
    act(() => reactRoot.unmount());
    container.remove();
  });

  it('lists file and folder names in the portaled segment menu', () => {
    act(() => {
      reactRoot.render(
        <FilePathBreadcrumb
          projectId="project-1"
          worktreeId="worktree-1"
          root={root}
          relativePath="README.md"
        />,
      );
    });

    const fileSegment = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'README.md',
    );
    expect(fileSegment).toBeDefined();
    act(() => {
      fileSegment?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const names = Array.from(
      document.body.querySelectorAll(
        '[data-testid="file-breadcrumb-entry"] span',
      ),
    ).filter((node) => node.children.length === 0);
    const folder = names.find((node) => node.textContent === 'secret-folder');
    const file = names.find((node) => node.textContent === 'secret-notes.md');
    expect(folder).toBeDefined();
    expect(file).toBeDefined();
  });

  it.each([['Vendor Spend Q3'], ['支出 / 🌳 '.repeat(20).trim()]])(
    'names and masks the Cowork project root %j',
    (projectName) => {
      act(() => {
        reactRoot.render(
          <FilePathBreadcrumb
            projectId="project-1"
            worktreeId="worktree-1"
            root={{
              repoId: 'workspace',
              repoName: projectName,
              absolutePath: '/Users/priya/vendor',
              rootKind: 'standalone',
            }}
            relativePath="vendor-spend-cleaned.csv"
          />,
        );
      });

      const segment = container.querySelector<HTMLButtonElement>(
        '[data-testid="file-breadcrumb-segment-root"]',
      );
      expect(segment?.textContent).toBe(projectName);
      expect(segment?.querySelector(`.${REPLAY_MASK_CLASS}`)?.textContent).toBe(
        projectName,
      );
    },
  );

  it('updates an open breadcrumb after roots refresh without reopening the file', () => {
    const coworkRoot: FileTreeRoot = {
      ...root,
      repoId: 'workspace',
      rootKind: 'standalone',
      repoName: 'Vendor Spend Q3',
    };
    const render = (): void =>
      act(() =>
        reactRoot.render(
          <FilePathBreadcrumb
            projectId="project-1"
            worktreeId="worktree-1"
            root={coworkRoot}
            relativePath="spend.csv"
          />,
        ),
      );
    render();
    mockFileListState.rootsCache['project-1/worktree-1'] = {
      data: { roots: [{ ...coworkRoot, repoName: 'Renamed Q4' }] },
    };
    render();
    expect(
      container.querySelector('[data-testid="file-breadcrumb-segment-root"]')
        ?.textContent,
    ).toBe('Renamed Q4');
    expect(
      container
        .querySelector('[data-testid="file-breadcrumb-segment-root"]')
        ?.getAttribute('title'),
    ).toBeNull();
  });

  it('leaves repository root names unmasked', () => {
    act(() => {
      reactRoot.render(
        <FilePathBreadcrumb
          projectId="project-1"
          worktreeId="worktree-1"
          root={root}
          relativePath="README.md"
        />,
      );
    });

    const segment = container.querySelector(
      '[data-testid="file-breadcrumb-segment-root"]',
    );
    expect(segment?.textContent).toBe('repo');
    expect(segment?.querySelector(`.${REPLAY_MASK_CLASS}`)).toBeNull();
  });
});
