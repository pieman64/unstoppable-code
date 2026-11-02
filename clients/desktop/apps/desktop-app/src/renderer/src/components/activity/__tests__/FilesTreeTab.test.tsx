/**
 * @jest-environment jsdom
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FileTreeChangeEvent } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  getDirectoryCacheKey,
  getFileTreeIndexCacheKey,
  useFileListStore,
} from '@/stores/fileListStore';
import { useChatStore } from '@/stores/chatStore';

import {
  APP_MANAGED_ROOTS_TREE_PATH,
  FILE_TREE_SEARCH_DEBOUNCE_MS,
} from '../files-tree-tab-state';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { brandText } from '@/lib/brand';
import { FilesTreeTab } from '../FilesTreeTab';
import { EarlyAccessUiProviders } from '@/components/EarlyAccessUiProviders';

jest.mock('@/components/shared', () => ({
  LoadingPlaceholder: (): JSX.Element => (
    <div data-testid="loading-placeholder" />
  ),
}));

jest.mock('@/lib/clipboard', () => ({
  copyTextToClipboard: jest.fn(() => Promise.resolve(true)),
}));

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));

const mockedUseCurrentUiStateReporter = jest.mocked(useCurrentUiStateReporter);

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';
const WORKTREE_KEY = `${PROJECT_ID}/${WORKTREE_ID}`;
const EXPLORER_INDEX_KEY = getFileTreeIndexCacheKey(PROJECT_ID, WORKTREE_ID);
const OTHER_WORKTREE_ID = 'worktree-2';
const OTHER_WORKTREE_KEY = `${PROJECT_ID}/${OTHER_WORKTREE_ID}`;
const mockShowInFinder = jest.fn(() => Promise.resolve());
const mockMutateFileTree = jest.fn<
  ReturnType<typeof window.api.mutateFileTree>,
  Parameters<typeof window.api.mutateFileTree>
>(() => Promise.resolve({ operation: 'create-file' }));
const mockStartFileTreeWatch = jest.fn(() => Promise.resolve());
const mockStopFileTreeWatch = jest.fn(() => Promise.resolve());
let fileTreeChangedCallback:
  | ((event: {
      projectId: string;
      worktreeId: string;
      changeCount: number;
    }) => void)
  | null = null;

function getFolderButton(
  container: HTMLElement,
  label: string,
): HTMLButtonElement {
  const button = Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="files-tree-folder"]',
    ),
  ).find((candidate) => candidate.textContent?.includes(label));

  if (!button) {
    throw new Error(`Unable to find folder ${label}`);
  }

  return button;
}

function getFileButton(
  container: HTMLElement,
  label: string,
): HTMLButtonElement {
  const button = Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="files-tree-row"]',
    ),
  ).find((candidate) => candidate.textContent?.includes(label));

  if (!button) {
    throw new Error(`Unable to find file ${label}`);
  }

  return button;
}

function getMenuItem(label: string): HTMLButtonElement {
  const item = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!item) throw new Error(`Unable to find menu item ${label}`);
  return item;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- always invoked with an explicit receiver below
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function expandSrcFolder(container: HTMLElement): void {
  act(() => {
    getFolderButton(container, 'src').click();
  });
}

function mockScrollMetrics(
  scrollHeight: number | (() => number),
  clientHeight: number | (() => number),
): () => void {
  const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'scrollHeight',
  );
  const clientHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'clientHeight',
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () =>
      typeof scrollHeight === 'function' ? scrollHeight() : scrollHeight,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () =>
      typeof clientHeight === 'function' ? clientHeight() : clientHeight,
  });
  return () => {
    if (scrollHeightDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        'scrollHeight',
        scrollHeightDescriptor,
      );
    }
    if (clientHeightDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        'clientHeight',
        clientHeightDescriptor,
      );
    }
  };
}

describe('FilesTreeTab', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    mockShowInFinder.mockClear();
    mockMutateFileTree.mockClear();
    mockStartFileTreeWatch.mockClear();
    mockStartFileTreeWatch.mockImplementation(
      () => new Promise<void>(() => undefined),
    );
    mockStopFileTreeWatch.mockClear();
    fileTreeChangedCallback = null;

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getFileTreeRoots: jest.fn(),
        getFileTreeDirectory: jest.fn(),
        detectApps: jest.fn(() =>
          Promise.resolve([
            {
              id: 'vscode',
              name: 'VS Code',
              category: 'editor' as const,
              icon: 'data:image/png;base64,AA==',
            },
          ]),
        ),
        loadPreferences: jest.fn(() =>
          Promise.resolve({
            lastOpenApp: 'vscode',
            disabledOpenApps: [],
          }),
        ),
        openInApp: jest.fn(() => Promise.resolve()),
        savePreferences: jest.fn(() => Promise.resolve()),
        showInFinder: mockShowInFinder,
        mutateFileTree: mockMutateFileTree,
        startFileTreeWatch: mockStartFileTreeWatch,
        stopFileTreeWatch: mockStopFileTreeWatch,
        onFileTreeChanged: jest.fn(
          (callback: (event: FileTreeChangeEvent) => void): (() => void) => {
            fileTreeChangedCallback = callback;
            return (): void => {
              fileTreeChangedCallback = null;
            };
          },
        ),
      },
    });
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'darwin',
    });

    useFileListStore.setState({
      indexCache: {},
      indexErrors: {},
      indexLoading: new Set(),
      indexVersions: {},
      rootsCache: {
        [WORKTREE_KEY]: {
          fetchedAt: Date.now(),
          data: {
            roots: [
              {
                repoId: 'repo-1',
                repoName: 'repo',
                absolutePath: '/repo',
                rootKind: 'git-repo',
              },
            ],
          },
        },
      },
      rootsErrors: {},
      rootsLoading: new Set(),
      rootsVersions: {},
      directoryCache: {
        [getDirectoryCacheKey(PROJECT_ID, WORKTREE_ID, 'repo-1', '')]: {
          fetchedAt: Date.now(),
          data: {
            entries: [
              {
                name: 'src',
                relativePath: 'src',
                absolutePath: '/repo/src',
                kind: 'directory',
                isIgnored: false,
                isIndexExcluded: false,
                isSymlink: false,
                hasChildren: true,
              },
            ],
          },
        },
        [getDirectoryCacheKey(PROJECT_ID, WORKTREE_ID, 'repo-1', 'src')]: {
          fetchedAt: Date.now(),
          data: {
            entries: [
              {
                name: 'index.ts',
                relativePath: 'src/index.ts',
                absolutePath: '/repo/src/index.ts',
                kind: 'file',
                isIgnored: false,
                isIndexExcluded: false,
                isSymlink: false,
                hasChildren: false,
              },
            ],
          },
        },
      },
      directoryErrors: {},
      directoryLoading: new Set(),
      directoryVersions: {},
      fileTreeExpandedPaths: {},
      fileTreeScrollPositions: {},
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    jest.clearAllMocks();
    setTestEarlyAccessFeatures({ enabled: false });
  });

  it('records the explorer in session replay', () => {
    act(() => {
      root.render(
        <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
      );
    });

    const explorer = container.querySelector('[data-testid="files-tree-tab"]');
    expect(explorer?.parentElement).toBe(container);
    expect(explorer?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(
      false,
    );
    expect(
      container.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
  });

  it('preserves expanded folders when the explorer remounts', () => {
    act(() => {
      root.render(
        <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
      );
    });

    act(() => {
      getFolderButton(container, 'src').click();
    });

    expect(container.textContent).toContain('index.ts');

    act(() => {
      root.unmount();
    });
    root = createRoot(container);

    act(() => {
      root.render(
        <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
      );
    });

    expect(container.textContent).toContain('index.ts');
  });

  it('opens standalone explorer files in the explorer workspace scope', () => {
    const previousOpenFileTab = useChatStore.getState().openFileTab;
    const openFileTab = jest.fn(() => 'file-tab');
    useChatStore.setState({ openFileTab });
    try {
      act(() => {
        root.render(
          <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
        );
      });
      expandSrcFolder(container);

      act(() => {
        getFileButton(container, 'index.ts').click();
      });

      expect(openFileTab).toHaveBeenCalledWith(
        { absolutePath: '/repo/src/index.ts', filename: 'index.ts' },
        { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      );
    } finally {
      act(() => {
        useChatStore.setState({ openFileTab: previousOpenFileTab });
      });
    }
  });

  it('reveals and marks the current file, then restores it from the toolbar', () => {
    const onCurrentFileInitialReveal = jest.fn();
    const onOpenFile = jest.fn();
    act(() => {
      root.render(
        <FilesTreeTab
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          currentFilePath="/repo/src/index.ts"
          revealCurrentFileInitially
          onCurrentFileInitialReveal={onCurrentFileInitialReveal}
          onOpenFile={onOpenFile}
        />,
      );
    });

    const currentFile = getFileButton(container, 'index.ts');
    expect(currentFile.dataset.currentFile).toBe('true');
    expect(currentFile.getAttribute('aria-current')).toBe('page');
    expect(onCurrentFileInitialReveal).toHaveBeenCalledTimes(1);
    expect(onCurrentFileInitialReveal).toHaveBeenCalledWith(
      '/repo/src/index.ts',
    );

    act(() => {
      currentFile.click();
    });
    expect(onOpenFile).toHaveBeenCalledWith({
      absolutePath: '/repo/src/index.ts',
      filename: 'index.ts',
    });
    expect(currentFile.getAttribute('aria-selected')).toBe('false');
    expect(currentFile.dataset.currentFile).toBe('true');

    act(() => {
      getFolderButton(container, 'src').click();
    });
    expect(container.textContent).not.toContain('index.ts');

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="files-tree-jump-to-file"]',
        )
        ?.click();
    });
    expect(getFileButton(container, 'index.ts').dataset.currentFile).toBe(
      'true',
    );
  });

  it('reveals and expands a linked directory in an empty file tab tree', () => {
    const onInitialDirectoryReveal = jest.fn();
    act(() => {
      root.render(
        <FilesTreeTab
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          initialDirectoryPath="/repo/src"
          revealInitialDirectory
          onInitialDirectoryReveal={onInitialDirectoryReveal}
        />,
      );
    });

    expect(
      getFolderButton(container, 'src').getAttribute('aria-expanded'),
    ).toBe('true');
    expect(container.textContent).toContain('index.ts');
    expect(onInitialDirectoryReveal).toHaveBeenCalledWith('/repo/src');
  });

  it('reveals a Windows current file when its path casing differs from the tree', () => {
    useFileListStore.setState({
      rootsCache: {
        [WORKTREE_KEY]: {
          fetchedAt: Date.now(),
          data: {
            roots: [
              {
                repoId: 'repo-1',
                repoName: 'repo',
                absolutePath: 'C:\\Repo',
                rootKind: 'git-repo',
              },
            ],
          },
        },
      },
      directoryCache: {
        [getDirectoryCacheKey(PROJECT_ID, WORKTREE_ID, 'repo-1', '')]: {
          fetchedAt: Date.now(),
          data: {
            entries: [
              {
                name: 'Src',
                relativePath: 'Src',
                absolutePath: 'C:\\Repo\\Src',
                kind: 'directory',
                isIgnored: false,
                isIndexExcluded: false,
                isSymlink: false,
                hasChildren: true,
              },
            ],
          },
        },
        [getDirectoryCacheKey(PROJECT_ID, WORKTREE_ID, 'repo-1', 'Src')]: {
          fetchedAt: Date.now(),
          data: {
            entries: [
              {
                name: 'Index.ts',
                relativePath: 'Src/Index.ts',
                absolutePath: 'C:\\Repo\\Src\\Index.ts',
                kind: 'file',
                isIgnored: false,
                isIndexExcluded: false,
                isSymlink: false,
                hasChildren: false,
              },
            ],
          },
        },
      },
    });

    act(() => {
      root.render(
        <FilesTreeTab
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          currentFilePath={'c:\\repo\\src\\index.ts'}
          revealCurrentFileInitially
        />,
      );
    });

    expect(
      Array.from(
        useFileListStore.getState().fileTreeExpandedPaths[WORKTREE_KEY] ?? [],
      ),
    ).toEqual(['repo:repo-1', 'repo:repo-1/src']);
    const currentFile = getFileButton(container, 'Index.ts');
    expect(currentFile.dataset.currentFile).toBe('true');
  });

  it('clears a standalone opened-file selection when navigation hides the tree', () => {
    act(() => {
      root.render(
        <FilesTreeTab
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          isVisible
        />,
      );
    });
    act(() => {
      getFolderButton(container, 'src').click();
    });
    const file = getFileButton(container, 'index.ts');
    act(() => {
      file.click();
    });
    expect(file.getAttribute('aria-selected')).toBe('true');

    act(() => {
      root.render(
        <FilesTreeTab
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          isVisible={false}
        />,
      );
    });
    expect(file.getAttribute('aria-selected')).toBe('false');
  });

  it('keeps the current tree stable while an expanded directory loads', () => {
    const srcKey = getDirectoryCacheKey(
      PROJECT_ID,
      WORKTREE_ID,
      'repo-1',
      'src',
    );
    const directoryCache = {
      ...useFileListStore.getState().directoryCache,
    };
    delete directoryCache[srcKey];
    useFileListStore.setState({
      directoryCache,
      directoryLoading: new Set([srcKey]),
    });

    act(() => {
      root.render(
        <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
      );
    });
    act(() => {
      getFolderButton(container, 'src').click();
    });

    expect(container.textContent).toContain('src');
    expect(container.textContent).not.toContain('Loading…');
    expect(
      container.querySelector('[data-testid="loading-placeholder"]'),
    ).toBeNull();
  });

  it('retains the selected tree while invalidated roots reload', () => {
    act(() => {
      root.render(
        <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
      );
    });
    act(() => {
      getFolderButton(container, 'src').click();
    });
    expect(
      getFolderButton(container, 'src').getAttribute('aria-selected'),
    ).toBe('true');

    act(() => {
      useFileListStore.setState({
        rootsCache: {},
        rootsLoading: new Set([WORKTREE_KEY]),
      });
    });

    expect(container.textContent).toContain('src');
    expect(
      getFolderButton(container, 'src').getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      container.querySelector('[data-testid="loading-placeholder"]'),
    ).toBeNull();
  });

  it('does not restart tree layout when a refresh returns identical data', async () => {
    const rootsResponse = {
      roots: [
        {
          repoId: 'repo-1',
          repoName: 'repo',
          absolutePath: '/repo',
          rootKind: 'git-repo' as const,
        },
      ],
    };
    const rootDirectoryResponse = {
      entries: [
        {
          name: 'src',
          relativePath: 'src',
          absolutePath: '/repo/src',
          kind: 'directory' as const,
          isIgnored: false,
          isIndexExcluded: false,
          isSymlink: false,
          hasChildren: true,
        },
      ],
    };
    jest.mocked(window.api.getFileTreeRoots).mockResolvedValue(rootsResponse);
    jest
      .mocked(window.api.getFileTreeDirectory)
      .mockResolvedValue(rootDirectoryResponse);
    const measure = jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect');

    act(() => {
      root.render(
        <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
      );
    });
    measure.mockClear();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="files-tree-refresh"]')
        ?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(measure).not.toHaveBeenCalled();
    measure.mockRestore();
  });

  it('shows a roots error when an invalidation refresh fails', () => {
    act(() => {
      root.render(
        <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
      );
    });
    expect(container.textContent).toContain('src');

    act(() => {
      useFileListStore.setState({
        rootsCache: {},
        rootsErrors: {},
        rootsLoading: new Set([WORKTREE_KEY]),
      });
    });
    expect(container.textContent).toContain('src');

    act(() => {
      useFileListStore.setState({
        rootsErrors: { [WORKTREE_KEY]: 'roots failed' },
        rootsLoading: new Set(),
      });
    });

    expect(container.textContent).toContain('Unable to load files.');
    expect(container.textContent).not.toContain('src');
  });

  it('uses rich tooltips instead of native titles on the toolbar and row actions (CAN-2799)', () => {
    act(() => {
      root.render(
        <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
      );
    });
    for (const testId of [
      'files-tree-new-file',
      'files-tree-new-folder',
      'files-tree-search-toggle',
      'files-tree-collapse-all',
    ]) {
      const button = container.querySelector<HTMLButtonElement>(
        `[data-testid="${testId}"]`,
      );
      expect(button).not.toBeNull();
      expect(button?.hasAttribute('title')).toBe(false);
    }
    const search = container.querySelector<HTMLButtonElement>(
      '[data-testid="files-tree-search-toggle"]',
    );
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    act(() => {
      search?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Search files',
    );
    act(() => {
      search?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();

    const openInFileManager = container.querySelector<HTMLButtonElement>(
      '[data-testid="files-tree-row-open-in-file-manager"]',
    );
    expect(openInFileManager).not.toBeNull();
    expect(openInFileManager?.hasAttribute('title')).toBe(false);
    act(() => {
      openInFileManager?.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
    });
    expect(
      document.body.querySelector('[role="tooltip"]')?.textContent,
    ).toMatch(/^Open in /);
  });

  it('places create editors in the target folder and cancels them with Escape', () => {
    act(() => {
      root.render(
        <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
      );
    });
    expandSrcFolder(container);
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="files-tree-new-file"]')
        ?.click();
    });

    const placeholder = container.querySelector<HTMLElement>(
      '[data-testid="files-tree-inline-editor-container"]',
    );
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="files-tree-inline-editor"]',
    );
    const scroll = container.querySelector('[data-testid="files-tree-scroll"]');
    expect(placeholder?.dataset.parentPath).toBe('src');
    expect(placeholder?.dataset.createKind).toBe('file');
    expect(scroll?.contains(placeholder ?? null)).toBe(true);
    expect(placeholder).not.toBeNull();
    if (!placeholder) throw new Error('Expected inline editor placeholder');
    expect(
      getFileButton(container, 'index.ts').compareDocumentPosition(
        placeholder,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    act(() => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(
      container.querySelector('[data-testid="files-tree-inline-editor"]'),
    ).toBeNull();
    expect(mockMutateFileTree).not.toHaveBeenCalled();
  });

  it('expands a collapsed repository root before showing a create editor', () => {
    useFileListStore.setState({
      fileTreeExpandedPaths: { [WORKTREE_KEY]: new Set() },
    });
    act(() => {
      root.render(
        <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
      );
    });

    expect(container.textContent).not.toContain('index.ts');
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="files-tree-new-file"]')
        ?.click();
    });

    expect(
      container.querySelector('[data-testid="files-tree-inline-editor"]'),
    ).not.toBeNull();
  });

  it('submits an inline editor only once when Enter is immediately followed by blur', async () => {
    const rootsResponse =
      useFileListStore.getState().rootsCache[WORKTREE_KEY]?.data;
    jest.mocked(window.api.getFileTreeRoots).mockResolvedValue(rootsResponse);
    jest
      .mocked(window.api.getFileTreeDirectory)
      .mockResolvedValue({ entries: [] });
    let releaseMutation = (): void => undefined;
    mockMutateFileTree.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseMutation = (): void =>
            resolve({ operation: 'create-file' as const });
        }),
    );
    act(() => {
      root.render(
        <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
      );
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="files-tree-new-file"]')
        ?.click();
    });
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="files-tree-inline-editor"]',
    );
    if (!input) throw new Error('Expected inline editor');

    act(() => {
      setInputValue(input, 'created-once.txt');
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );
      input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    });

    expect(mockMutateFileTree).toHaveBeenCalledTimes(1);
    await act(async () => {
      releaseMutation();
      await Promise.resolve();
    });
  });

  it('closes an unchanged rename on blur without dispatching a mutation', async () => {
    act(() => {
      root.render(
        <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
      );
    });
    expandSrcFolder(container);
    act(() => {
      getFileButton(container, 'index.ts').dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      );
    });
    act(() => getMenuItem('Rename').click());
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="files-tree-inline-editor"]',
    );
    if (!input) throw new Error('Expected rename editor');

    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockMutateFileTree).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="files-tree-inline-editor"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain('already exists');
  });

  it('reports an empty-name error when a rename is cleared', () => {
    act(() => {
      root.render(
        <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
      );
    });
    expandSrcFolder(container);
    act(() => {
      getFileButton(container, 'index.ts').focus();
      getFileButton(container, 'index.ts').dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'F2',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="files-tree-inline-editor"]',
    );
    if (!input) throw new Error('Expected rename editor');

    act(() => setInputValue(input, ''));
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Enter a file or folder name.',
    );
    expect(container.textContent).not.toContain(
      'Names cannot contain path separators.',
    );
    expect(mockMutateFileTree).not.toHaveBeenCalled();
  });

  it('deletes only the selected top-level folder when a descendant is also selected', async () => {
    const rootsResponse =
      useFileListStore.getState().rootsCache[WORKTREE_KEY]?.data;
    jest.mocked(window.api.getFileTreeRoots).mockResolvedValue(rootsResponse);
    jest.mocked(window.api.getFileTreeDirectory).mockResolvedValue({
      entries: [],
    });
    act(() => {
      root.render(
        <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
      );
    });
    const src = getFolderButton(container, 'src');
    act(() => src.click());
    const index = getFileButton(container, 'index.ts');
    act(() => {
      index.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          metaKey: true,
        }),
      );
    });
    expect(src.getAttribute('aria-selected')).toBe('true');
    expect(index.getAttribute('aria-selected')).toBe('true');

    act(() => {
      index.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Delete',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="files-tree-delete-confirm-button"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(mockMutateFileTree).toHaveBeenCalledTimes(1);
    expect(mockMutateFileTree).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'delete',
        target: { repoId: 'repo-1', relativePath: 'src' },
      }),
    );
  });

  it('removes completed entries from a partially failed delete batch', async () => {
    const rootsResponse =
      useFileListStore.getState().rootsCache[WORKTREE_KEY]?.data;
    jest.mocked(window.api.getFileTreeRoots).mockResolvedValue(rootsResponse);
    jest
      .mocked(window.api.getFileTreeDirectory)
      .mockResolvedValue({ entries: [] });
    const srcKey = getDirectoryCacheKey(
      PROJECT_ID,
      WORKTREE_ID,
      'repo-1',
      'src',
    );
    const srcDirectory = useFileListStore.getState().directoryCache[srcKey];
    useFileListStore.setState((state) => ({
      directoryCache: {
        ...state.directoryCache,
        [srcKey]: {
          ...srcDirectory,
          data: {
            entries: [
              ...(srcDirectory?.data.entries ?? []),
              {
                name: 'second.ts',
                relativePath: 'src/second.ts',
                absolutePath: '/repo/src/second.ts',
                kind: 'file',
                isIgnored: false,
                isIndexExcluded: false,
                isSymlink: false,
                hasChildren: false,
              },
            ],
          },
        },
      },
    }));
    mockMutateFileTree
      .mockResolvedValueOnce({ operation: 'delete' })
      .mockRejectedValueOnce(new Error('second delete failed'));
    act(() => {
      root.render(
        <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
      );
    });
    expandSrcFolder(container);
    act(() => {
      getFolderButton(container, 'src').dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', bubbles: true }),
      );
    });
    const first = getFileButton(container, 'index.ts');
    const second = getFileButton(container, 'second.ts');
    act(() => {
      first.dispatchEvent(
        new MouseEvent('click', { bubbles: true, metaKey: true }),
      );
    });
    act(() => {
      second.dispatchEvent(
        new MouseEvent('click', { bubbles: true, metaKey: true }),
      );
    });
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(second.getAttribute('aria-selected')).toBe('true');
    act(() => {
      second.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }),
      );
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="files-tree-delete-confirm-button"]',
        )
        ?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockMutateFileTree).toHaveBeenCalledTimes(2);

    mockMutateFileTree.mockClear();
    mockMutateFileTree.mockResolvedValue({ operation: 'delete' });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="files-tree-delete-confirm-button"]',
        )
        ?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockMutateFileTree).toHaveBeenCalledTimes(1);
    expect(mockMutateFileTree).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'delete',
        target: { repoId: 'repo-1', relativePath: 'src/second.ts' },
      }),
    );
  });

  it('transfers only the selected top-level folder when a descendant is also selected', async () => {
    const rootsResponse =
      useFileListStore.getState().rootsCache[WORKTREE_KEY]?.data;
    jest.mocked(window.api.getFileTreeRoots).mockResolvedValue(rootsResponse);
    jest
      .mocked(window.api.getFileTreeDirectory)
      .mockResolvedValue({ entries: [] });
    act(() => {
      root.render(
        <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
      );
    });
    const src = getFolderButton(container, 'src');
    act(() => src.click());
    const index = getFileButton(container, 'index.ts');
    act(() => {
      index.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          metaKey: true,
        }),
      );
    });
    act(() => {
      index.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      );
    });
    act(() => getMenuItem('Copy').click());
    act(() => {
      getFolderButton(container, 'repo').dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      );
    });
    await act(async () => {
      getMenuItem('Paste').click();
      await Promise.resolve();
    });

    expect(mockMutateFileTree).toHaveBeenCalledTimes(1);
    expect(mockMutateFileTree).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'copy',
        source: { repoId: 'repo-1', relativePath: 'src' },
      }),
    );
  });

  it('preserves an existing clipboard when a different file is dragged', async () => {
    const rootsResponse =
      useFileListStore.getState().rootsCache[WORKTREE_KEY]?.data;
    jest.mocked(window.api.getFileTreeRoots).mockResolvedValue(rootsResponse);
    jest
      .mocked(window.api.getFileTreeDirectory)
      .mockResolvedValue({ entries: [] });
    const rootKey = getDirectoryCacheKey(PROJECT_ID, WORKTREE_ID, 'repo-1', '');
    const rootDirectory = useFileListStore.getState().directoryCache[rootKey];
    useFileListStore.setState((state) => ({
      directoryCache: {
        ...state.directoryCache,
        [rootKey]: {
          ...rootDirectory,
          data: {
            entries: [
              ...(rootDirectory?.data.entries ?? []),
              {
                name: 'other.txt',
                relativePath: 'other.txt',
                absolutePath: '/repo/other.txt',
                kind: 'file',
                isIgnored: false,
                isIndexExcluded: false,
                isSymlink: false,
                hasChildren: false,
              },
            ],
          },
        },
      },
    }));
    act(() => {
      root.render(
        <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
      );
    });
    expandSrcFolder(container);
    const copied = getFileButton(container, 'index.ts');
    act(() => {
      copied.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
    });
    act(() => getMenuItem('Copy').click());

    const dataTransfer = {
      dropEffect: 'move',
      effectAllowed: 'copyMove',
      setData: jest.fn(),
    };
    const dragStart = new Event('dragstart', {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(dragStart, 'dataTransfer', { value: dataTransfer });
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer });
    Object.defineProperty(drop, 'altKey', { value: false });
    Object.defineProperty(drop, 'ctrlKey', { value: false });
    act(() => {
      getFileButton(container, 'other.txt').dispatchEvent(dragStart);
    });
    await act(async () => {
      getFolderButton(container, 'src').dispatchEvent(drop);
      await Promise.resolve();
    });

    mockMutateFileTree.mockClear();
    act(() => {
      getFolderButton(container, 'repo').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
    });
    const paste = getMenuItem('Paste');
    expect(paste.disabled).toBe(false);
    await act(async () => {
      paste.click();
      await Promise.resolve();
    });
    expect(mockMutateFileTree).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'copy',
        source: { repoId: 'repo-1', relativePath: 'src/index.ts' },
      }),
    );
  });

  it('removes completed entries from a cut clipboard after a partial failure', async () => {
    const rootsResponse =
      useFileListStore.getState().rootsCache[WORKTREE_KEY]?.data;
    jest.mocked(window.api.getFileTreeRoots).mockResolvedValue(rootsResponse);
    jest
      .mocked(window.api.getFileTreeDirectory)
      .mockResolvedValue({ entries: [] });
    const srcKey = getDirectoryCacheKey(
      PROJECT_ID,
      WORKTREE_ID,
      'repo-1',
      'src',
    );
    const srcDirectory = useFileListStore.getState().directoryCache[srcKey];
    useFileListStore.setState((state) => ({
      directoryCache: {
        ...state.directoryCache,
        [srcKey]: {
          ...srcDirectory,
          data: {
            entries: [
              ...(srcDirectory?.data.entries ?? []),
              {
                name: 'second.ts',
                relativePath: 'src/second.ts',
                absolutePath: '/repo/src/second.ts',
                kind: 'file',
                isIgnored: false,
                isIndexExcluded: false,
                isSymlink: false,
                hasChildren: false,
              },
            ],
          },
        },
      },
    }));
    mockMutateFileTree
      .mockResolvedValueOnce({ operation: 'move' })
      .mockRejectedValueOnce(new Error('second move failed'));

    act(() => {
      root.render(
        <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
      );
    });
    expandSrcFolder(container);
    const first = getFileButton(container, 'index.ts');
    const second = getFileButton(container, 'second.ts');
    act(() => first.click());
    act(() => {
      second.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          metaKey: true,
        }),
      );
      second.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      );
    });
    act(() => getMenuItem('Cut').click());
    act(() => {
      getFolderButton(container, 'repo').dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      );
    });
    await act(async () => {
      getMenuItem('Paste').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockMutateFileTree).toHaveBeenCalledTimes(2);

    mockMutateFileTree.mockClear();
    mockMutateFileTree.mockResolvedValue({ operation: 'move' });
    act(() => {
      getFolderButton(container, 'repo').dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      );
    });
    await act(async () => {
      getMenuItem('Paste').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockMutateFileTree).toHaveBeenCalledTimes(1);
    expect(mockMutateFileTree).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'move',
        source: { repoId: 'repo-1', relativePath: 'src/second.ts' },
      }),
    );
  });

  it('removes descendants of a completed folder from a partial cut retry', async () => {
    const rootsResponse =
      useFileListStore.getState().rootsCache[WORKTREE_KEY]?.data;
    jest.mocked(window.api.getFileTreeRoots).mockResolvedValue(rootsResponse);
    const rootKey = getDirectoryCacheKey(PROJECT_ID, WORKTREE_ID, 'repo-1', '');
    const rootDirectory = useFileListStore.getState().directoryCache[rootKey];
    useFileListStore.setState((state) => ({
      directoryCache: {
        ...state.directoryCache,
        [rootKey]: {
          ...rootDirectory,
          data: {
            entries: [
              ...(rootDirectory?.data.entries ?? []),
              {
                name: 'other.txt',
                relativePath: 'other.txt',
                absolutePath: '/repo/other.txt',
                kind: 'file',
                isIgnored: false,
                isIndexExcluded: false,
                isSymlink: false,
                hasChildren: false,
              },
              {
                name: 'destination',
                relativePath: 'destination',
                absolutePath: '/repo/destination',
                kind: 'directory',
                isIgnored: false,
                isIndexExcluded: false,
                isSymlink: false,
                hasChildren: false,
              },
            ],
          },
        },
      },
    }));
    const directoryResponses = new Map(
      ['', 'src'].map((relativeDir) => {
        const key = getDirectoryCacheKey(
          PROJECT_ID,
          WORKTREE_ID,
          'repo-1',
          relativeDir,
        );
        return [
          relativeDir,
          useFileListStore.getState().directoryCache[key]?.data ?? {
            entries: [],
          },
        ] as const;
      }),
    );
    jest
      .mocked(window.api.getFileTreeDirectory)
      .mockImplementation((request) =>
        Promise.resolve(
          directoryResponses.get(request.relativeDir) ?? { entries: [] },
        ),
      );
    mockMutateFileTree
      .mockResolvedValueOnce({ operation: 'move' })
      .mockRejectedValueOnce(new Error('other move failed'));

    act(() => {
      root.render(
        <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
      );
    });
    expandSrcFolder(container);
    const index = getFileButton(container, 'index.ts');
    const other = getFileButton(container, 'other.txt');
    act(() => {
      index.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          metaKey: true,
        }),
      );
      other.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          metaKey: true,
        }),
      );
      other.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      );
    });
    act(() => getMenuItem('Cut').click());
    const destination = getFolderButton(container, 'destination');
    act(() => {
      destination.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      );
    });
    await act(async () => {
      getMenuItem('Paste').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockMutateFileTree).toHaveBeenCalledTimes(2);
    expect(mockMutateFileTree).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        source: { repoId: 'repo-1', relativePath: 'src' },
      }),
    );

    mockMutateFileTree.mockClear();
    mockMutateFileTree.mockResolvedValue({ operation: 'move' });
    act(() => {
      destination.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      );
    });
    await act(async () => {
      getMenuItem('Paste').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockMutateFileTree).toHaveBeenCalledTimes(1);
    expect(mockMutateFileTree).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { repoId: 'repo-1', relativePath: 'other.txt' },
      }),
    );
  });

  it('resets the scroll container when the next worktree has no saved offset', () => {
    const restoreScrollMetrics = mockScrollMetrics(1000, 200);
    try {
      useFileListStore.setState((state) => ({
        rootsCache: {
          ...state.rootsCache,
          [OTHER_WORKTREE_KEY]: state.rootsCache[WORKTREE_KEY],
        },
        directoryCache: {
          ...state.directoryCache,
          [getDirectoryCacheKey(PROJECT_ID, OTHER_WORKTREE_ID, 'repo-1', '')]:
            state.directoryCache[
              getDirectoryCacheKey(PROJECT_ID, WORKTREE_ID, 'repo-1', '')
            ],
        },
        fileTreeScrollPositions: {
          [WORKTREE_KEY]: 240,
        },
      }));

      act(() => {
        root.render(
          <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
        );
      });

      const scroll = container.querySelector<HTMLElement>(
        '[data-testid="files-tree-scroll"]',
      );
      expect(scroll?.scrollTop).toBe(240);

      act(() => {
        root.render(
          <FilesTreeTab
            projectId={PROJECT_ID}
            worktreeId={OTHER_WORKTREE_ID}
          />,
        );
      });

      expect(scroll?.scrollTop).toBe(0);
    } finally {
      restoreScrollMetrics();
    }
  });

  it('does not overwrite a saved offset while lazy content is still too short', () => {
    const restoreScrollMetrics = mockScrollMetrics(100, 100);
    try {
      useFileListStore.setState({
        fileTreeScrollPositions: {
          [WORKTREE_KEY]: 320,
        },
      });

      act(() => {
        root.render(
          <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
        );
      });

      const scroll = container.querySelector<HTMLElement>(
        '[data-testid="files-tree-scroll"]',
      );
      expect(scroll?.scrollTop).toBe(0);

      act(() => {
        scroll?.dispatchEvent(new Event('scroll'));
      });

      expect(
        useFileListStore.getState().fileTreeScrollPositions[WORKTREE_KEY],
      ).toBe(320);
    } finally {
      restoreScrollMetrics();
    }
  });

  it('persists the last meaningful offset when the scroll container temporarily collapses', () => {
    jest.useFakeTimers();
    let scrollHeight = 1000;
    const restoreScrollMetrics = mockScrollMetrics(() => scrollHeight, 200);
    try {
      useFileListStore.setState({
        fileTreeScrollPositions: {
          [WORKTREE_KEY]: 320,
        },
      });

      act(() => {
        root.render(
          <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
        );
      });

      const scroll = container.querySelector<HTMLElement>(
        '[data-testid="files-tree-scroll"]',
      );
      expect(scroll?.scrollTop).toBe(320);

      act(() => {
        if (!scroll) return;
        scroll.scrollTop = 420;
        scroll.dispatchEvent(new Event('scroll'));
      });

      scrollHeight = 200;
      act(() => {
        if (!scroll) return;
        scroll.scrollTop = 0;
        scroll.dispatchEvent(new Event('scroll'));
        scrollHeight = 1000;
        jest.advanceTimersByTime(150);
      });

      expect(
        useFileListStore.getState().fileTreeScrollPositions[WORKTREE_KEY],
      ).toBe(420);
    } finally {
      restoreScrollMetrics();
      jest.useRealTimers();
    }
  });

  it('does not overwrite a saved offset when panel teardown clamps scrollTop to zero', () => {
    jest.useFakeTimers();
    const restoreScrollMetrics = mockScrollMetrics(1000, 200);
    try {
      act(() => {
        root.render(
          <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
        );
      });

      const scroll = container.querySelector<HTMLElement>(
        '[data-testid="files-tree-scroll"]',
      );
      expect(scroll).not.toBeNull();

      act(() => {
        if (!scroll) return;
        scroll.scrollTop = 420;
        scroll.dispatchEvent(new Event('scroll'));
        jest.advanceTimersByTime(200);
      });
      expect(
        useFileListStore.getState().fileTreeScrollPositions[WORKTREE_KEY],
      ).toBe(420);

      act(() => {
        if (!scroll) return;
        scroll.scrollTop = 0;
        scroll.dispatchEvent(new Event('scroll'));
        root.unmount();
      });

      expect(
        useFileListStore.getState().fileTreeScrollPositions[WORKTREE_KEY],
      ).toBe(420);
    } finally {
      restoreScrollMetrics();
      jest.useRealTimers();
      root = createRoot(container);
    }
  });

  it('persists zero when direct user input scrolls back to the top', () => {
    jest.useFakeTimers();
    const restoreScrollMetrics = mockScrollMetrics(1000, 200);
    try {
      act(() => {
        root.render(
          <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
        );
      });

      const scroll = container.querySelector<HTMLElement>(
        '[data-testid="files-tree-scroll"]',
      );
      expect(scroll).not.toBeNull();

      act(() => {
        if (!scroll) return;
        scroll.scrollTop = 420;
        scroll.dispatchEvent(new Event('scroll'));
        jest.advanceTimersByTime(150);

        scroll.dispatchEvent(new WheelEvent('wheel'));
        scroll.scrollTop = 0;
        scroll.dispatchEvent(new Event('scroll'));
        jest.advanceTimersByTime(200);
      });

      expect(
        useFileListStore.getState().fileTreeScrollPositions[WORKTREE_KEY],
      ).toBe(0);
    } finally {
      restoreScrollMetrics();
      jest.useRealTimers();
    }
  });

  it('persists a wheel-applied offset when no scroll event is delivered', () => {
    jest.useFakeTimers();
    const restoreScrollMetrics = mockScrollMetrics(1000, 200);
    try {
      act(() => {
        root.render(
          <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
        );
      });

      const scroll = container.querySelector<HTMLElement>(
        '[data-testid="files-tree-scroll"]',
      );
      expect(scroll).not.toBeNull();

      act(() => {
        if (!scroll) return;
        scroll.dispatchEvent(new WheelEvent('wheel'));
        scroll.scrollTop = 360;
        jest.advanceTimersByTime(200);
      });

      expect(
        useFileListStore.getState().fileTreeScrollPositions[WORKTREE_KEY],
      ).toBe(360);
    } finally {
      restoreScrollMetrics();
      jest.useRealTimers();
    }
  });

  it('flushes wheel intent when the effect cleans up before its capture frame', () => {
    jest.useFakeTimers();
    const restoreScrollMetrics = mockScrollMetrics(1000, 200);
    try {
      act(() => {
        root.render(
          <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
        );
      });

      const scroll = container.querySelector<HTMLElement>(
        '[data-testid="files-tree-scroll"]',
      );
      expect(scroll).not.toBeNull();

      act(() => {
        if (!scroll) return;
        scroll.dispatchEvent(new WheelEvent('wheel'));
        scroll.scrollTop = 360;
        root.unmount();
      });

      expect(
        useFileListStore.getState().fileTreeScrollPositions[WORKTREE_KEY],
      ).toBe(360);
    } finally {
      restoreScrollMetrics();
      jest.useRealTimers();
      root = createRoot(container);
    }
  });

  it('retains a positive scroll position through unmount', () => {
    jest.useFakeTimers();
    const restoreScrollMetrics = mockScrollMetrics(1000, 200);
    try {
      act(() => {
        root.render(
          <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
        );
      });

      const scroll = container.querySelector<HTMLElement>(
        '[data-testid="files-tree-scroll"]',
      );
      expect(scroll).not.toBeNull();

      act(() => {
        if (!scroll) return;
        scroll.scrollTop = 180;
        scroll.dispatchEvent(new Event('scroll'));
      });

      expect(
        useFileListStore.getState().fileTreeScrollPositions[WORKTREE_KEY],
      ).toBe(180);

      act(() => {
        root.unmount();
      });

      expect(
        useFileListStore.getState().fileTreeScrollPositions[WORKTREE_KEY],
      ).toBe(180);
    } finally {
      restoreScrollMetrics();
      jest.useRealTimers();
      root = createRoot(container);
    }
  });

  it('closes file actions after copying relative and absolute paths', async () => {
    act(() => {
      root.render(
        <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
      );
    });
    expandSrcFolder(container);

    act(() => {
      getFileButton(container, 'index.ts').dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 24,
          clientY: 32,
        }),
      );
    });

    const menu = document.body.querySelector(
      '[data-testid="files-tree-action-menu"]',
    );
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain('Copy');
    expect(menu?.textContent).toContain('Send to chat');
    expect(menu?.textContent).toContain('Open in Finder');

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="files-tree-action-copy"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(copyTextToClipboard).toHaveBeenCalledWith('src/index.ts');
    expect(
      document.querySelector('[data-testid="files-tree-action-menu"]'),
    ).toBeNull();

    act(() => {
      getFileButton(container, 'index.ts').dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 24,
          clientY: 32,
        }),
      );
    });
    await act(async () => {
      getMenuItem('Copy path').click();
      await Promise.resolve();
    });

    expect(copyTextToClipboard).toHaveBeenLastCalledWith('/repo/src/index.ts');
    expect(
      document.querySelector('[data-testid="files-tree-action-menu"]'),
    ).toBeNull();

    act(() => {
      getFileButton(container, 'index.ts').dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 24,
          clientY: 32,
        }),
      );
    });
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="files-tree-action-open-in-file-manager"]',
        )
        ?.click();
    });
    expect(mockShowInFinder).toHaveBeenCalledWith({
      absolutePath: '/repo/src/index.ts',
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
  });

  it('supports additive selection and exposes a vertical full action menu', async () => {
    const directoryKey = getDirectoryCacheKey(
      PROJECT_ID,
      WORKTREE_ID,
      'repo-1',
      'src',
    );
    const original = useFileListStore.getState().directoryCache[directoryKey];
    useFileListStore.setState((state) => ({
      directoryCache: {
        ...state.directoryCache,
        [directoryKey]: {
          fetchedAt: Date.now(),
          data: {
            entries: ['a.ts', 'b.ts', 'c.ts'].map((name) => ({
              name,
              relativePath: `src/${name}`,
              absolutePath: `/repo/src/${name}`,
              kind: 'file' as const,
              isIgnored: false,
              isIndexExcluded: false,
              isSymlink: false,
              hasChildren: false,
            })),
          },
        },
      },
    }));
    expect(original).toBeDefined();

    act(() => {
      root.render(
        <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
      );
    });
    expandSrcFolder(container);
    const first = getFileButton(container, 'a.ts');
    const second = getFileButton(container, 'b.ts');
    const third = getFileButton(container, 'c.ts');

    act(() => first.click());
    await act(async () => {
      second.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          metaKey: true,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(second.getAttribute('aria-selected')).toBe('true');

    act(() => {
      third.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          shiftKey: true,
        }),
      );
    });
    expect(second.getAttribute('aria-selected')).toBe('true');
    expect(third.getAttribute('aria-selected')).toBe('true');

    await act(async () => {
      second.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const menu = document.querySelector<HTMLElement>(
      '[data-testid="files-tree-action-menu"]',
    );
    expect(menu?.className).toContain('canopy-floating-menu');
    expect(menu?.className).toContain('flex-col');
    expect(
      menu?.querySelector('[data-testid="files-tree-action-copy"] svg'),
    ).not.toBeNull();
    const rows = Array.from(
      menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    // Every row leads with the icon slot, so the labels line up.
    for (const row of rows) {
      expect(row.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    }
    expect(rows.at(-1)?.textContent).toBe('Delete');
    for (const label of [
      'Open',
      'Open to the side',
      'Open with default application',
      'Send to chat',
      'Cut',
      'Copy',
      'Copy path',
      'Copy relative path',
      'Rename',
      'Delete',
      'Open in Finder',
    ]) {
      expect(menu?.textContent).toContain(label);
    }
    expect(
      menu?.querySelector('[data-testid="files-tree-action-open-in-app"]'),
    ).not.toBeNull();

    act(() => {
      container
        .querySelector<HTMLElement>('[data-testid="files-tree-scroll"]')
        ?.dispatchEvent(new Event('scroll'));
    });
    expect(
      document.querySelector('[data-testid="files-tree-action-menu"]'),
    ).toBeNull();
  });

  it('arms native change detection only while visible and invalidates on change', async () => {
    mockStartFileTreeWatch.mockResolvedValueOnce();
    const rootsResponse =
      useFileListStore.getState().rootsCache[WORKTREE_KEY]?.data;
    const rootDirectoryResponse =
      useFileListStore.getState().directoryCache[
        getDirectoryCacheKey(PROJECT_ID, WORKTREE_ID, 'repo-1', '')
      ]?.data;
    const srcDirectoryResponse =
      useFileListStore.getState().directoryCache[
        getDirectoryCacheKey(PROJECT_ID, WORKTREE_ID, 'repo-1', 'src')
      ]?.data;
    jest.mocked(window.api.getFileTreeRoots).mockResolvedValue(rootsResponse);
    jest
      .mocked(window.api.getFileTreeDirectory)
      .mockImplementation(({ relativeDir }) =>
        Promise.resolve(
          relativeDir === 'src'
            ? (srcDirectoryResponse ?? { entries: [] })
            : (rootDirectoryResponse ?? { entries: [] }),
        ),
      );
    await act(async () => {
      root.render(
        <FilesTreeTab
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          isVisible
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockStartFileTreeWatch).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    expect(fileTreeChangedCallback).not.toBeNull();
    mockStartFileTreeWatch.mockClear();
    mockStopFileTreeWatch.mockClear();
    expandSrcFolder(container);
    expect(mockStopFileTreeWatch).not.toHaveBeenCalled();
    expect(mockStartFileTreeWatch).not.toHaveBeenCalled();

    act(() => {
      fileTreeChangedCallback?.({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        changeCount: 5,
      });
    });
    expect(window.api.getFileTreeRoots).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });

    await act(async () => {
      root.render(
        <FilesTreeTab
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          isVisible={false}
        />,
      );
      await Promise.resolve();
    });
    expect(mockStopFileTreeWatch).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    expect(
      container
        .querySelector('[data-testid="files-tree-tab"]')
        ?.getAttribute('data-watching'),
    ).toBe('false');
  });

  it('does not refresh retained descendants below a collapsed folder', async () => {
    mockStartFileTreeWatch.mockResolvedValueOnce();
    useFileListStore.setState({
      fileTreeExpandedPaths: {
        [WORKTREE_KEY]: new Set([
          'repo:repo-1',
          'repo:repo-1/src',
          'repo:repo-1/src/nested',
        ]),
      },
    });
    const rootsResponse =
      useFileListStore.getState().rootsCache[WORKTREE_KEY]?.data;
    const rootDirectoryResponse =
      useFileListStore.getState().directoryCache[
        getDirectoryCacheKey(PROJECT_ID, WORKTREE_ID, 'repo-1', '')
      ]?.data;
    const srcDirectoryResponse =
      useFileListStore.getState().directoryCache[
        getDirectoryCacheKey(PROJECT_ID, WORKTREE_ID, 'repo-1', 'src')
      ]?.data;
    jest.mocked(window.api.getFileTreeRoots).mockResolvedValue(rootsResponse);
    jest
      .mocked(window.api.getFileTreeDirectory)
      .mockImplementation(({ relativeDir }) =>
        Promise.resolve(
          relativeDir === 'src'
            ? (srcDirectoryResponse ?? { entries: [] })
            : (rootDirectoryResponse ?? { entries: [] }),
        ),
      );
    await act(async () => {
      root.render(
        <FilesTreeTab
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          isVisible
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    act(() => getFolderButton(container, 'src').click());
    jest.mocked(window.api.getFileTreeDirectory).mockClear();
    await act(async () => {
      fileTreeChangedCallback?.({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        changeCount: 1,
      });
      await Promise.resolve();
    });

    expect(window.api.getFileTreeDirectory).not.toHaveBeenCalledWith(
      expect.objectContaining({ relativeDir: 'src/nested' }),
    );
  });

  it('reconciles cached directories after the first watcher start', async () => {
    mockStartFileTreeWatch.mockResolvedValueOnce();
    const rootsResponse =
      useFileListStore.getState().rootsCache[WORKTREE_KEY]?.data;
    let resolveRoots: ((value: typeof rootsResponse) => void) | null = null;
    jest.mocked(window.api.getFileTreeRoots).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRoots = resolve;
        }),
    );
    jest.mocked(window.api.getFileTreeDirectory).mockResolvedValue({
      entries: [],
    });

    await act(async () => {
      root.render(
        <FilesTreeTab
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          isVisible
        />,
      );
      await Promise.resolve();
    });

    expect(window.api.getFileTreeRoots).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    expect(
      container
        .querySelector('[data-testid="files-tree-tab"]')
        ?.getAttribute('data-watching'),
    ).toBe('false');

    await act(async () => {
      resolveRoots?.(rootsResponse);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      container
        .querySelector('[data-testid="files-tree-tab"]')
        ?.getAttribute('data-watching'),
    ).toBe('true');
  });

  it('opens folder actions on right click and reveals the folder', async () => {
    act(() => {
      root.render(
        <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
      );
    });

    await act(async () => {
      getFolderButton(container, 'src').dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 24,
          clientY: 32,
        }),
      );
      await Promise.resolve();
    });

    expect(window.api.detectApps).not.toHaveBeenCalled();
    expect(window.api.loadPreferences).not.toHaveBeenCalled();

    const menu = document.body.querySelector(
      '[data-testid="files-tree-action-menu"]',
    );
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain('Copy');
    expect(menu?.textContent).toContain('Open in Finder');
    expect(menu?.textContent).not.toContain('Send to chat');
    expect(
      document.querySelector('[data-testid="files-tree-action-send-to-chat"]'),
    ).toBeNull();

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="files-tree-action-copy"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(copyTextToClipboard).toHaveBeenCalledWith('src');

    act(() => {
      getFolderButton(container, 'src').dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 24,
          clientY: 32,
        }),
      );
    });
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="files-tree-action-open-in-file-manager"]',
        )
        ?.click();
    });
    expect(mockShowInFinder).toHaveBeenCalledWith({
      absolutePath: '/repo/src',
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
  });

  it('reveals files from the row hover and keyboard-focus action', () => {
    act(() => {
      root.render(
        <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
      );
    });
    expandSrcFolder(container);

    const fileRow = getFileButton(container, 'index.ts');
    const rowAction = fileRow.parentElement?.querySelector<HTMLButtonElement>(
      '[data-testid="files-tree-row-open-in-file-manager"]',
    );
    expect(rowAction).not.toBeNull();

    act(() => {
      rowAction?.focus();
      rowAction?.click();
    });

    expect(document.activeElement).toBe(rowAction);
    expect(mockShowInFinder).toHaveBeenCalledWith({
      absolutePath: '/repo/src/index.ts',
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
  });

  it('copies the repo root as a relative root path', async () => {
    act(() => {
      root.render(
        <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
      );
    });

    act(() => {
      getFolderButton(container, 'repo').dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 24,
          clientY: 32,
        }),
      );
    });

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="files-tree-action-copy"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(copyTextToClipboard).toHaveBeenCalledWith('.');
  });

  describe('toolbar glyphs', () => {
    function glyphIsAppIcon(selector: string): boolean {
      const svg = container.querySelector(`${selector} svg`);
      if (!svg) throw new Error(`Expected a glyph in ${selector}`);
      return svg.getAttribute('data-app-icon') === 'true';
    }

    // The refresh control is the shared FilesTreeRefreshButton, which reads
    // the icon style the renderer root provides from early access.
    function renderWithRootProviders(): void {
      act(() => {
        root.render(
          <EarlyAccessUiProviders>
            <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />
          </EarlyAccessUiProviders>,
        );
      });
    }

    it('uses the compact app refresh glyph with early access off', () => {
      renderWithRootProviders();
      const refresh = '[data-testid="files-tree-refresh"]';
      expect(glyphIsAppIcon(refresh)).toBe(true);
      // Compact desktop density: the shared refresh glyph keeps its 14px size and
      // the control has no tooltip wrapper.
      const svg = container.querySelector(`${refresh} svg`);
      expect(svg?.getAttribute('width')).toBe('14px');
      expect(
        container.querySelector(refresh)?.parentElement?.getAttribute('class'),
      ).toBe('flex items-center gap-0.5');
    });

    it('draws the app refresh glyph with early access on', () => {
      setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
      renderWithRootProviders();
      const refresh = '[data-testid="files-tree-refresh"]';
      expect(glyphIsAppIcon(refresh)).toBe(true);
      expect(
        container.querySelector(`${refresh} svg`)?.classList.contains('h-3'),
      ).toBe(true);
    });

    it('keeps the app overflow glyph across early-access states', () => {
      const overflow = '[aria-label="File tree actions"]';
      act(() => {
        root.render(
          <FilesTreeTab
            projectId={PROJECT_ID}
            worktreeId={WORKTREE_ID}
            onTreeModeChange={jest.fn()}
          />,
        );
      });
      expect(glyphIsAppIcon(overflow)).toBe(true);
      act(() => {
        setTestEarlyAccessFeatures({
          enabled: true,
          hydrated: true,
        });
      });
      expect(glyphIsAppIcon(overflow)).toBe(true);
    });
  });

  describe('search', () => {
    function seedFileIndex(truncated = false): void {
      useFileListStore.setState({
        indexCache: {
          [EXPLORER_INDEX_KEY]: {
            fetchedAt: Date.now(),
            data: {
              repos: [
                {
                  repoId: 'repo-1',
                  repoName: 'repo',
                  absolutePath: '/repo',
                  rootKind: 'git-repo',
                  truncated,
                  files: [
                    {
                      relativePath: 'README.md',
                      filename: 'README.md',
                      absolutePath: '/repo/README.md',
                      isIgnored: false,
                    },
                    {
                      relativePath: 'src/index.ts',
                      filename: 'index.ts',
                      absolutePath: '/repo/src/index.ts',
                      isIgnored: false,
                    },
                    {
                      relativePath: 'src/ui/nested/Widget.tsx',
                      filename: 'Widget.tsx',
                      absolutePath: '/repo/src/ui/nested/Widget.tsx',
                      isIgnored: false,
                    },
                  ],
                },
              ],
            },
          },
        },
      });
    }

    function dispatchCmdF(): KeyboardEvent {
      const event = new KeyboardEvent('keydown', {
        key: 'f',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        document.dispatchEvent(event);
      });
      return event;
    }

    function getSearchInput(): HTMLInputElement {
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="files-tree-search-input"]',
      );
      if (!input) {
        throw new Error('Search input is not open');
      }
      return input;
    }

    /**
     * React installs its own `value` setter on the input node, so assigning
     * `input.value` directly leaves its change tracker thinking nothing
     * changed and `onChange` never fires. Go through the native setter.
     */
    function typeSearch(value: string): void {
      const input = getSearchInput();
      const setValue =
        // eslint-disable-next-line @typescript-eslint/unbound-method -- always invoked with an explicit receiver below
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set;
      act(() => {
        setValue?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }

    function folderLabels(): string[] {
      return Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          '[data-testid="files-tree-folder"]',
        ),
        // Strip the leading expand/collapse chevron glyph.
      ).map((button) => (button.textContent ?? '').replace(/^[▼▶]/, ''));
    }

    beforeEach(() => {
      Object.defineProperty(document, 'hasFocus', {
        configurable: true,
        value: jest.fn(() => true),
      });
      seedFileIndex();
    });

    it('opens and focuses the search input on Cmd+F', () => {
      act(() => {
        root.render(
          <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
        );
      });
      expect(
        container.querySelector('[data-testid="files-tree-search-input"]'),
      ).toBeNull();

      const event = dispatchCmdF();

      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(getSearchInput());
    });

    it('ignores Cmd+F while the hosting panel is not the active one', () => {
      act(() => {
        root.render(
          <FilesTreeTab
            projectId={PROJECT_ID}
            worktreeId={WORKTREE_ID}
            searchShortcutActive={false}
          />,
        );
      });

      const event = dispatchCmdF();

      expect(event.defaultPrevented).toBe(false);
      expect(
        container.querySelector('[data-testid="files-tree-search-input"]'),
      ).toBeNull();
    });

    it('opens and focuses the search input from the toolbar button', () => {
      act(() => {
        root.render(
          <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
        );
      });

      act(() => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="files-tree-search-toggle"]',
          )
          ?.click();
      });

      expect(document.activeElement).toBe(getSearchInput());
    });

    it('closes an active search before showing a create editor', () => {
      jest.useFakeTimers();
      try {
        act(() => {
          root.render(
            <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
          );
        });
        dispatchCmdF();
        typeSearch('README');
        act(() => {
          jest.advanceTimersByTime(FILE_TREE_SEARCH_DEBOUNCE_MS);
        });
        expect(container.textContent).toContain('README.md');

        act(() => {
          container
            .querySelector<HTMLButtonElement>(
              '[data-testid="files-tree-new-file"]',
            )
            ?.click();
        });

        expect(
          container.querySelector('[data-testid="files-tree-search-input"]'),
        ).toBeNull();
        expect(
          container.querySelector('[data-testid="files-tree-inline-editor"]'),
        ).not.toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('shows a create editor for a file under collapsed search-result ancestors', () => {
      jest.useFakeTimers();
      try {
        useFileListStore.setState((state) => ({
          directoryCache: {
            ...state.directoryCache,
            [getDirectoryCacheKey(PROJECT_ID, WORKTREE_ID, 'repo-1', 'src')]: {
              fetchedAt: Date.now(),
              data: {
                entries: [
                  {
                    name: 'ui',
                    relativePath: 'src/ui',
                    absolutePath: '/repo/src/ui',
                    kind: 'directory',
                    isIgnored: false,
                    isIndexExcluded: false,
                    isSymlink: false,
                    hasChildren: true,
                  },
                ],
              },
            },
            [getDirectoryCacheKey(PROJECT_ID, WORKTREE_ID, 'repo-1', 'src/ui')]:
              {
                fetchedAt: Date.now(),
                data: {
                  entries: [
                    {
                      name: 'nested',
                      relativePath: 'src/ui/nested',
                      absolutePath: '/repo/src/ui/nested',
                      kind: 'directory',
                      isIgnored: false,
                      isIndexExcluded: false,
                      isSymlink: false,
                      hasChildren: true,
                    },
                  ],
                },
              },
            [getDirectoryCacheKey(
              PROJECT_ID,
              WORKTREE_ID,
              'repo-1',
              'src/ui/nested',
            )]: {
              fetchedAt: Date.now(),
              data: {
                entries: [
                  {
                    name: 'Widget.tsx',
                    relativePath: 'src/ui/nested/Widget.tsx',
                    absolutePath: '/repo/src/ui/nested/Widget.tsx',
                    kind: 'file',
                    isIgnored: false,
                    isIndexExcluded: false,
                    isSymlink: false,
                    hasChildren: false,
                  },
                ],
              },
            },
          },
        }));
        act(() => {
          root.render(
            <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
          );
        });
        dispatchCmdF();
        typeSearch('Widget');
        act(() => {
          jest.advanceTimersByTime(FILE_TREE_SEARCH_DEBOUNCE_MS);
        });
        act(() => {
          getFileButton(container, 'Widget.tsx').dispatchEvent(
            new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              clientX: 20,
              clientY: 20,
            }),
          );
        });
        act(() => getMenuItem('New file…').click());

        expect(
          container.querySelector('[data-testid="files-tree-search-input"]'),
        ).toBeNull();
        expect(
          container.querySelector('[data-testid="files-tree-inline-editor"]'),
        ).not.toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('retries an initial search-index failure from Refresh', () => {
      jest.useFakeTimers();
      const fetchFileTreeIndex = useFileListStore.getState().fetchFileTreeIndex;
      const retry = jest.fn(() => Promise.resolve());
      try {
        const rootsResponse =
          useFileListStore.getState().rootsCache[WORKTREE_KEY]?.data;
        jest
          .mocked(window.api.getFileTreeRoots)
          .mockResolvedValue(rootsResponse);
        jest.mocked(window.api.getFileTreeDirectory).mockResolvedValue({
          entries: [],
        });
        useFileListStore.setState({
          indexCache: {},
          indexErrors: { [EXPLORER_INDEX_KEY]: 'index failed' },
          indexLoading: new Set(),
          fetchFileTreeIndex: retry,
        });
        act(() => {
          root.render(
            <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
          );
        });
        dispatchCmdF();
        typeSearch('Widget');
        act(() => {
          jest.advanceTimersByTime(FILE_TREE_SEARCH_DEBOUNCE_MS);
        });
        expect(retry).not.toHaveBeenCalled();

        act(() => {
          container
            .querySelector<HTMLButtonElement>(
              '[data-testid="files-tree-refresh"]',
            )
            ?.click();
        });

        expect(retry).toHaveBeenCalledTimes(1);
      } finally {
        act(() => {
          seedFileIndex();
          useFileListStore.setState({ fetchFileTreeIndex });
        });
        jest.useRealTimers();
      }
    });

    it('debounces before filtering, then keeps the folder parentage of a nested match', () => {
      jest.useFakeTimers();
      try {
        act(() => {
          root.render(
            <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
          );
        });
        dispatchCmdF();
        typeSearch('Widget');

        // Still the unfiltered tree until the debounce elapses.
        expect(container.textContent).toContain('src');
        expect(container.textContent).not.toContain('Widget.tsx');

        act(() => {
          jest.advanceTimersByTime(FILE_TREE_SEARCH_DEBOUNCE_MS);
        });

        // The match is nested inside folders the user never expanded; each
        // ancestor is rendered so the hit keeps its place in the tree.
        expect(folderLabels()).toEqual(['repo', 'src', 'ui', 'nested']);
        expect(container.textContent).toContain('Widget.tsx');
        expect(container.textContent).not.toContain('README.md');
        expect(container.textContent).not.toContain('index.ts');
      } finally {
        jest.useRealTimers();
      }
    });

    it('reports a query with no matches', () => {
      jest.useFakeTimers();
      try {
        act(() => {
          root.render(
            <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
          );
        });
        dispatchCmdF();
        typeSearch('no-such-file');
        act(() => {
          jest.advanceTimersByTime(FILE_TREE_SEARCH_DEBOUNCE_MS);
        });

        expect(
          container.querySelector('[data-testid="files-tree-search-empty"]'),
        ).not.toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('reports when the bounded explorer index is incomplete', () => {
      jest.useFakeTimers();
      try {
        seedFileIndex(true);
        act(() => {
          root.render(
            <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
          );
        });
        dispatchCmdF();
        typeSearch('Widget');
        act(() => {
          jest.advanceTimersByTime(FILE_TREE_SEARCH_DEBOUNCE_MS);
        });

        expect(
          container.querySelector('[data-testid="files-tree-index-truncated"]'),
        ).not.toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('shows loading before the first search index request has started', () => {
      jest.useFakeTimers();
      const fetchFileTreeIndex = useFileListStore.getState().fetchFileTreeIndex;
      try {
        useFileListStore.setState({
          indexCache: {},
          indexErrors: {},
          indexLoading: new Set(),
          fetchFileTreeIndex: jest.fn(() => Promise.resolve()),
        });
        act(() => {
          root.render(
            <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
          );
        });
        dispatchCmdF();
        typeSearch('Widget');
        act(() => {
          jest.advanceTimersByTime(FILE_TREE_SEARCH_DEBOUNCE_MS);
        });

        expect(
          container.querySelector('[data-testid="loading-placeholder"]'),
        ).not.toBeNull();
        expect(
          container.querySelector('[data-testid="files-tree-search-empty"]'),
        ).toBeNull();
      } finally {
        act(() => {
          seedFileIndex();
          useFileListStore.setState({ fetchFileTreeIndex });
        });
        jest.useRealTimers();
      }
    });

    it('reports a roots failure while search is active', () => {
      jest.useFakeTimers();
      try {
        useFileListStore.setState({
          rootsCache: {},
          rootsErrors: { [WORKTREE_KEY]: 'roots failed' },
          rootsLoading: new Set(),
        });
        act(() => {
          root.render(
            <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
          );
        });
        dispatchCmdF();
        typeSearch('Widget');
        act(() => {
          jest.advanceTimersByTime(FILE_TREE_SEARCH_DEBOUNCE_MS);
        });

        expect(
          container.querySelector('[data-testid="files-tree-search-error"]'),
        ).not.toBeNull();
        expect(
          container.querySelector('[data-testid="files-tree-search-empty"]'),
        ).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('restores the unfiltered tree when Escape closes the search', () => {
      jest.useFakeTimers();
      try {
        act(() => {
          root.render(
            <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
          );
        });
        dispatchCmdF();
        typeSearch('Widget');
        act(() => {
          jest.advanceTimersByTime(FILE_TREE_SEARCH_DEBOUNCE_MS);
        });
        expect(container.textContent).toContain('Widget.tsx');

        act(() => {
          getSearchInput().dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Escape',
              bubbles: true,
              cancelable: true,
            }),
          );
        });

        expect(
          container.querySelector('[data-testid="files-tree-search-input"]'),
        ).toBeNull();
        expect(container.textContent).not.toContain('Widget.tsx');
        expect(folderLabels()).toEqual(['repo', 'src']);
      } finally {
        jest.useRealTimers();
      }
    });

    it('leaves the saved scroll offset alone while a filter is active', () => {
      jest.useFakeTimers();
      const restoreScrollMetrics = mockScrollMetrics(1000, 200);
      try {
        act(() => {
          root.render(
            <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
          );
        });
        const scroll = container.querySelector<HTMLElement>(
          '[data-testid="files-tree-scroll"]',
        );
        act(() => {
          if (!scroll) return;
          scroll.scrollTop = 420;
          scroll.dispatchEvent(new Event('scroll'));
          jest.advanceTimersByTime(200);
        });
        expect(
          useFileListStore.getState().fileTreeScrollPositions[WORKTREE_KEY],
        ).toBe(420);

        dispatchCmdF();
        typeSearch('Widget');
        act(() => {
          jest.advanceTimersByTime(FILE_TREE_SEARCH_DEBOUNCE_MS);
        });
        act(() => {
          if (!scroll) return;
          scroll.scrollTop = 12;
          scroll.dispatchEvent(new Event('scroll'));
          jest.advanceTimersByTime(200);
        });

        expect(
          useFileListStore.getState().fileTreeScrollPositions[WORKTREE_KEY],
        ).toBe(420);
      } finally {
        restoreScrollMetrics();
        jest.useRealTimers();
      }
    });

    it('restores the saved unfiltered offset when search closes', () => {
      jest.useFakeTimers();
      const restoreScrollMetrics = mockScrollMetrics(1000, 200);
      try {
        useFileListStore.setState({
          fileTreeScrollPositions: { [WORKTREE_KEY]: 420 },
        });
        act(() => {
          root.render(
            <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
          );
        });
        const scroll = container.querySelector<HTMLElement>(
          '[data-testid="files-tree-scroll"]',
        );
        expect(scroll?.scrollTop).toBe(420);

        dispatchCmdF();
        typeSearch('Widget');
        act(() => {
          jest.advanceTimersByTime(FILE_TREE_SEARCH_DEBOUNCE_MS);
          if (scroll) scroll.scrollTop = 12;
        });
        act(() => {
          getSearchInput().dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Escape',
              bubbles: true,
              cancelable: true,
            }),
          );
        });

        expect(scroll?.scrollTop).toBe(420);
      } finally {
        restoreScrollMetrics();
        jest.useRealTimers();
      }
    });

    it('does not flush a pending filtered offset when search closes', () => {
      jest.useFakeTimers();
      const restoreScrollMetrics = mockScrollMetrics(1000, 200);
      try {
        useFileListStore.setState({
          fileTreeScrollPositions: { [WORKTREE_KEY]: 420 },
        });
        act(() => {
          root.render(
            <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
          );
        });
        const scroll = container.querySelector<HTMLElement>(
          '[data-testid="files-tree-scroll"]',
        );
        expect(scroll?.scrollTop).toBe(420);

        dispatchCmdF();
        typeSearch('Widget');
        act(() => {
          jest.advanceTimersByTime(FILE_TREE_SEARCH_DEBOUNCE_MS);
        });
        act(() => {
          if (!scroll) return;
          scroll.scrollTop = 12;
          scroll.dispatchEvent(new Event('scroll'));
        });
        act(() => {
          getSearchInput().dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Escape',
              bubbles: true,
              cancelable: true,
            }),
          );
        });

        expect(
          useFileListStore.getState().fileTreeScrollPositions[WORKTREE_KEY],
        ).toBe(420);
        expect(scroll?.scrollTop).toBe(420);
      } finally {
        restoreScrollMetrics();
        jest.useRealTimers();
      }
    });

    it('reports the active explorer search state to App Advisor', () => {
      jest.useFakeTimers();
      try {
        act(() => {
          root.render(
            <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
          );
        });
        dispatchCmdF();
        typeSearch('Widget');
        act(() => {
          jest.advanceTimersByTime(FILE_TREE_SEARCH_DEBOUNCE_MS);
        });

        expect(mockedUseCurrentUiStateReporter).toHaveBeenLastCalledWith(
          'files.treeSearch',
          {
            projectId: PROJECT_ID,
            worktreeId: WORKTREE_ID,
            open: true,
            filtering: true,
          },
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('qualifies a filtered file reference using the project root count', () => {
      jest.useFakeTimers();
      const details: unknown[] = [];
      const handler = (event: Event): void => {
        if (event instanceof CustomEvent) details.push(event.detail);
      };
      document.addEventListener('canopy:insert-file-reference', handler);
      try {
        useFileListStore.setState((state) => ({
          rootsCache: {
            ...state.rootsCache,
            [WORKTREE_KEY]: {
              fetchedAt: Date.now(),
              data: {
                roots: [
                  {
                    repoId: 'repo-1',
                    repoName: 'repo',
                    absolutePath: '/repo',
                    rootKind: 'git-repo',
                  },
                  {
                    repoId: 'repo-2',
                    repoName: 'api',
                    absolutePath: '/api',
                    rootKind: 'git-repo',
                  },
                ],
              },
            },
          },
        }));
        act(() => {
          root.render(
            <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
          );
        });
        dispatchCmdF();
        typeSearch('index.ts');
        act(() => {
          jest.advanceTimersByTime(FILE_TREE_SEARCH_DEBOUNCE_MS);
        });
        act(() => {
          getFileButton(container, 'index.ts').dispatchEvent(
            new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              clientX: 24,
              clientY: 32,
            }),
          );
        });
        act(() => {
          document
            .querySelector<HTMLButtonElement>(
              '[data-testid="files-tree-action-send-to-chat"]',
            )
            ?.click();
        });

        expect(details).toEqual([
          {
            displayPath: 'repo/src/index.ts',
            absolutePath: '/repo/src/index.ts',
            repoName: 'repo',
          },
        ]);
      } finally {
        document.removeEventListener('canopy:insert-file-reference', handler);
        jest.useRealTimers();
      }
    });
  });

  it('sends a repo-qualified file reference to chat in multi-repo projects', () => {
    useFileListStore.setState((state) => ({
      rootsCache: {
        ...state.rootsCache,
        [WORKTREE_KEY]: {
          fetchedAt: Date.now(),
          data: {
            roots: [
              {
                repoId: 'repo-1',
                repoName: 'repo',
                absolutePath: '/repo',
                rootKind: 'git-repo',
              },
              {
                repoId: 'repo-2',
                repoName: 'api',
                absolutePath: '/api',
                rootKind: 'git-repo',
              },
            ],
          },
        },
      },
    }));

    const details: unknown[] = [];
    const handler = (event: Event): void => {
      if (event instanceof CustomEvent) {
        details.push(event.detail);
      }
    };
    document.addEventListener('canopy:insert-file-reference', handler);

    try {
      act(() => {
        root.render(
          <FilesTreeTab projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
        );
      });
      act(() => {
        getFolderButton(container, 'repo').click();
      });
      expandSrcFolder(container);

      act(() => {
        getFileButton(container, 'index.ts').dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 24,
            clientY: 32,
          }),
        );
      });

      act(() => {
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="files-tree-action-send-to-chat"]',
          )
          ?.click();
      });
    } finally {
      document.removeEventListener('canopy:insert-file-reference', handler);
    }

    expect(details).toEqual([
      {
        displayPath: 'repo/src/index.ts',
        absolutePath: '/repo/src/index.ts',
        repoName: 'repo',
      },
    ]);
  });
  describe('Cowork root grouping', () => {
    const HOME = '/Users/priya/Vendor Spend Q3';
    const NOTES = `${HOME}/.canopy/notes`;
    const coworkRoots = [
      {
        repoId: 'workspace',
        repoName: 'Vendor Spend Q3',
        absolutePath: HOME,
        rootKind: 'standalone' as const,
      },
      {
        repoId: 'notes',
        repoName: 'notes',
        absolutePath: NOTES,
        rootKind: 'standalone' as const,
      },
      {
        repoId: 'prompts',
        repoName: 'prompts',
        absolutePath: `${HOME}/.canopy/prompts`,
        rootKind: 'standalone' as const,
      },
      {
        repoId: 'attachments',
        repoName: 'attachments',
        absolutePath: `${HOME}/.canopy/attachments`,
        rootKind: 'attachments' as const,
      },
    ];
    const fileEntry = (
      name: string,
      parent: string,
    ): {
      name: string;
      relativePath: string;
      absolutePath: string;
      kind: 'file';
      isIgnored: boolean;
      isIndexExcluded: boolean;
      isSymlink: boolean;
      hasChildren: boolean;
    } => ({
      name,
      relativePath: name,
      absolutePath: `${parent}/${name}`,
      kind: 'file',
      isIgnored: false,
      isIndexExcluded: false,
      isSymlink: false,
      hasChildren: false,
    });

    function seedCowork(expanded?: Set<string>): void {
      const directory = (repoId: string, entries: unknown[]): object => ({
        [getDirectoryCacheKey(PROJECT_ID, WORKTREE_ID, repoId, '')]: {
          fetchedAt: Date.now(),
          data: { entries },
        },
      });
      useFileListStore.setState({
        rootsCache: {
          [WORKTREE_KEY]: {
            fetchedAt: Date.now(),
            data: { roots: coworkRoots },
          },
        },
        directoryCache: {
          ...directory('workspace', [
            fileEntry('vendor-spend-cleaned.csv', HOME),
          ]),
          ...directory('notes', [fileEntry('meeting.md', NOTES)]),
          ...directory('prompts', []),
          ...directory('attachments', []),
        },
        fileTreeExpandedPaths:
          expanded === undefined ? {} : { [WORKTREE_KEY]: expanded },
      });
    }

    function groupRow(): HTMLButtonElement {
      const row = container.querySelector<HTMLButtonElement>(
        '[data-testid="files-tree-root-group"]',
      );
      if (!row) throw new Error('Missing app-owned root group');
      return row;
    }

    function rootLabels(): string[] {
      return Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          '[data-testid="files-tree-folder"][data-path=""]',
        ),
        (button) => (button.textContent ?? '').replace(/^[▼▶]/, ''),
      );
    }

    function renderTree(
      props: Partial<Parameters<typeof FilesTreeTab>[0]> = {},
    ): void {
      act(() => {
        root.render(
          <FilesTreeTab
            projectId={PROJECT_ID}
            worktreeId={WORKTREE_ID}
            {...props}
          />,
        );
      });
    }

    it('expands the named project root once and keeps the brand group collapsed', () => {
      seedCowork();
      renderTree();

      expect(rootLabels()).toEqual(['Vendor Spend Q3']);
      expect(container.textContent).toContain('vendor-spend-cleaned.csv');
      expect(groupRow().textContent).toContain(brandText.appName);
      expect(groupRow().getAttribute('aria-expanded')).toBe('false');
      expect(groupRow().getAttribute('role')).toBe('treeitem');
      expect(groupRow().hasAttribute('data-path')).toBe(false);
      expect(container.textContent).not.toContain('meeting.md');
      expect(
        Array.from(
          useFileListStore.getState().fileTreeExpandedPaths[WORKTREE_KEY] ?? [],
        ),
      ).toEqual(['repo:workspace']);
      const label = Array.from(
        getFolderButton(container, 'Vendor Spend Q3').querySelectorAll('span'),
      ).find((span) => span.textContent === 'Vendor Spend Q3');
      expect(label?.classList.contains(REPLAY_MASK_CLASS)).toBe(true);
    });

    it('waits for asynchronously loaded roots before expanding the project root', async () => {
      useFileListStore.setState({ rootsCache: {}, fileTreeExpandedPaths: {} });
      let resolveRoots: (value: { roots: typeof coworkRoots }) => void = () =>
        undefined;
      jest.mocked(window.api.getFileTreeRoots).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRoots = resolve;
          }),
      );
      jest
        .mocked(window.api.getFileTreeDirectory)
        .mockResolvedValue({ entries: [] });
      renderTree();
      expect(
        useFileListStore.getState().fileTreeExpandedPaths[WORKTREE_KEY],
      ).toBeUndefined();

      await act(async () => {
        resolveRoots({ roots: coworkRoots });
        await Promise.resolve();
      });

      expect(
        Array.from(
          useFileListStore.getState().fileTreeExpandedPaths[WORKTREE_KEY] ?? [],
        ),
      ).toEqual(['repo:workspace']);
    });

    it('preserves Cowork expansion through rename refresh and workspace switches', () => {
      seedCowork(new Set([APP_MANAGED_ROOTS_TREE_PATH, 'repo:notes']));
      renderTree();
      const saved =
        useFileListStore.getState().fileTreeExpandedPaths[WORKTREE_KEY];
      act(() =>
        useFileListStore.setState((state) => ({
          rootsCache: {
            ...state.rootsCache,
            [WORKTREE_KEY]: {
              fetchedAt: Date.now(),
              data: {
                roots: coworkRoots.map((root) =>
                  root.repoId === 'workspace'
                    ? { ...root, repoName: 'Renamed Q4 / 支出 🌳' }
                    : root,
                ),
              },
            },
            [OTHER_WORKTREE_KEY]: {
              fetchedAt: Date.now(),
              data: { roots: coworkRoots },
            },
          },
        })),
      );
      expect(rootLabels()).toContain('Renamed Q4 / 支出 🌳');
      expect(
        useFileListStore.getState().fileTreeExpandedPaths[WORKTREE_KEY],
      ).toEqual(saved);
      renderTree({ worktreeId: OTHER_WORKTREE_ID });
      expect(groupRow().getAttribute('aria-expanded')).toBe('false');
      renderTree();
      expect(groupRow().getAttribute('aria-expanded')).toBe('true');
      expect(
        useFileListStore.getState().fileTreeExpandedPaths[WORKTREE_KEY],
      ).toEqual(saved);
    });

    it('respects a saved all-collapsed state', () => {
      seedCowork(new Set());
      renderTree();

      expect(
        getFolderButton(container, 'Vendor Spend Q3').getAttribute(
          'aria-expanded',
        ),
      ).toBe('false');
      expect(container.textContent).not.toContain('vendor-spend-cleaned.csv');
    });

    it('shows app-owned roots indented under the group and remembers the choice', () => {
      seedCowork();
      renderTree();

      act(() => groupRow().click());

      expect(groupRow().getAttribute('aria-expanded')).toBe('true');
      expect(rootLabels()).toEqual([
        'Vendor Spend Q3',
        'notes',
        'prompts',
        'attachments',
      ]);
      expect(
        getFolderButton(container, 'notes').getAttribute('aria-level'),
      ).toBe('2');
      expect(
        useFileListStore
          .getState()
          .fileTreeExpandedPaths[
            WORKTREE_KEY
          ]?.has(APP_MANAGED_ROOTS_TREE_PATH),
      ).toBe(true);

      act(() => root.unmount());
      root = createRoot(container);
      renderTree();
      expect(groupRow().getAttribute('aria-expanded')).toBe('true');
    });

    it('operates the group from the keyboard and keeps focus on collapse', () => {
      // jsdom has no CSS.escape; the tree's row lookup only needs identity here.
      Object.defineProperty(globalThis, 'CSS', {
        configurable: true,
        value: { escape: (value: string): string => value },
      });
      seedCowork();
      renderTree();
      const keyDown = (key: string): void => {
        const target = document.activeElement ?? groupRow();
        act(() => {
          target.dispatchEvent(
            new KeyboardEvent('keydown', { key, bubbles: true }),
          );
        });
      };

      act(() => groupRow().focus());
      keyDown('ArrowRight');
      expect(groupRow().getAttribute('aria-expanded')).toBe('true');
      keyDown('ArrowRight');
      expect(document.activeElement).toBe(getFolderButton(container, 'notes'));
      keyDown('ArrowUp');
      expect(document.activeElement).toBe(groupRow());
      expect(groupRow().tabIndex).toBe(0);
      keyDown('ArrowLeft');
      expect(groupRow().getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(groupRow());
      keyDown('Enter');
      expect(groupRow().getAttribute('aria-expanded')).toBe('true');
      keyDown(' ');
      expect(groupRow().getAttribute('aria-expanded')).toBe('false');
      keyDown('ArrowUp');
      expect(document.activeElement).toBe(
        getFileButton(container, 'vendor-spend-cleaned.csv'),
      );
    });

    it('moves from a collapsed managed root to its group with ArrowLeft', () => {
      seedCowork(new Set(['repo:workspace', APP_MANAGED_ROOTS_TREE_PATH]));
      renderTree();
      const notes = getFolderButton(container, 'notes');
      act(() => {
        notes.focus();
        notes.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
        );
      });
      expect(document.activeElement).toBe(groupRow());
    });

    it('reveals an app-owned file by expanding the group and its root', () => {
      seedCowork();
      renderTree({
        currentFilePath: `${NOTES}/meeting.md`,
        revealCurrentFileInitially: true,
        onCurrentFileInitialReveal: jest.fn(),
      });

      expect(groupRow().getAttribute('aria-expanded')).toBe('true');
      expect(getFileButton(container, 'meeting.md').dataset.currentFile).toBe(
        'true',
      );
    });

    it('does not refresh directories hidden inside the collapsed group', async () => {
      mockStartFileTreeWatch.mockResolvedValueOnce();
      seedCowork(new Set(['repo:workspace', 'repo:notes']));
      jest
        .mocked(window.api.getFileTreeRoots)
        .mockResolvedValue({ roots: coworkRoots });
      jest
        .mocked(window.api.getFileTreeDirectory)
        .mockResolvedValue({ entries: [] });
      await act(async () => {
        root.render(
          <FilesTreeTab
            projectId={PROJECT_ID}
            worktreeId={WORKTREE_ID}
            isVisible
          />,
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      jest.mocked(window.api.getFileTreeDirectory).mockClear();

      await act(async () => {
        fileTreeChangedCallback?.({
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          changeCount: 1,
        });
        await Promise.resolve();
      });

      expect(window.api.getFileTreeDirectory).toHaveBeenCalledWith(
        expect.objectContaining({ repoId: 'workspace' }),
      );
      expect(window.api.getFileTreeDirectory).not.toHaveBeenCalledWith(
        expect.objectContaining({ repoId: 'notes' }),
      );
    });

    it('shows managed search matches without changing the saved group state', () => {
      Object.defineProperty(document, 'hasFocus', {
        configurable: true,
        value: jest.fn(() => true),
      });
      seedCowork();
      useFileListStore.setState({
        indexCache: {
          [EXPLORER_INDEX_KEY]: {
            fetchedAt: Date.now(),
            data: {
              repos: coworkRoots.map((candidate) => ({
                ...candidate,
                files:
                  candidate.repoId === 'notes'
                    ? [
                        {
                          relativePath: 'meeting.md',
                          filename: 'meeting.md',
                          absolutePath: `${NOTES}/meeting.md`,
                          isIgnored: false,
                        },
                      ]
                    : candidate.repoId === 'workspace'
                      ? [
                          {
                            relativePath: 'vendor-spend-cleaned.csv',
                            filename: 'vendor-spend-cleaned.csv',
                            absolutePath: `${HOME}/vendor-spend-cleaned.csv`,
                            isIgnored: false,
                          },
                        ]
                      : [],
              })),
            },
          },
        },
      });
      jest.useFakeTimers();
      try {
        renderTree();
        act(() => {
          document.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'f',
              metaKey: true,
              bubbles: true,
              cancelable: true,
            }),
          );
        });
        const input = container.querySelector<HTMLInputElement>(
          '[data-testid="files-tree-search-input"]',
        );
        if (!input) throw new Error('Search input is not open');
        act(() => setInputValue(input, 'meeting'));
        act(() => {
          jest.advanceTimersByTime(FILE_TREE_SEARCH_DEBOUNCE_MS);
        });

        expect(groupRow().getAttribute('aria-expanded')).toBe('true');
        expect(container.textContent).toContain('meeting.md');
        expect(rootLabels()).toEqual(['notes']);

        act(() => groupRow().click());
        expect(container.textContent).not.toContain('meeting.md');

        act(() => setInputValue(input, 'vendor'));
        act(() => {
          jest.advanceTimersByTime(FILE_TREE_SEARCH_DEBOUNCE_MS);
        });
        expect(
          container.querySelector('[data-testid="files-tree-root-group"]'),
        ).toBeNull();

        act(() => setInputValue(input, ''));
        act(() => {
          jest.advanceTimersByTime(FILE_TREE_SEARCH_DEBOUNCE_MS);
        });
        expect(groupRow().getAttribute('aria-expanded')).toBe('false');
        expect(
          useFileListStore
            .getState()
            .fileTreeExpandedPaths[
              WORKTREE_KEY
            ]?.has(APP_MANAGED_ROOTS_TREE_PATH),
        ).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not group roots outside a Cowork catalog', () => {
      renderTree();
      expect(
        container.querySelector('[data-testid="files-tree-root-group"]'),
      ).toBeNull();
      expect(rootLabels()).toEqual(['repo']);
    });
  });
});
