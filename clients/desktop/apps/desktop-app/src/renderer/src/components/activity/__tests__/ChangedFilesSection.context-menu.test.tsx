/**
 * @jest-environment jsdom
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore } from '@/stores/chatStore';

import { openFileInDiff } from '@/lib/panels/open-file-diff';
jest.mock('@/lib/panels/open-file-diff', () => ({ openFileInDiff: jest.fn() }));
import { useFileListStore } from '@/stores/fileListStore';
import {
  ChangedFilesHostSection,
  type DesktopChangedFilesSectionModel,
  useChangedFilesSectionHostModel,
} from '../ChangedFilesSection';

jest.mock('@/lib/clipboard', () => ({
  copyTextToClipboard: jest.fn(() => Promise.resolve(true)),
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';
const WORKTREE_KEY = `${PROJECT_ID}/${WORKTREE_ID}`;

function Harness(): JSX.Element {
  const model = useChangedFilesSectionHostModel({
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
  });
  return <ChangedFilesHostSection model={model} />;
}

function ModelHarness({
  revision,
  onModel,
}: {
  readonly revision: number;
  readonly onModel: (model: DesktopChangedFilesSectionModel) => void;
}): JSX.Element {
  const model = useChangedFilesSectionHostModel({
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
  });
  onModel(model);
  return (
    <>
      <ChangedFilesHostSection model={model} />
      <span data-testid="changed-files-model-revision">{revision}</span>
    </>
  );
}

describe('Changed Files file context menu', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    jest.mocked(copyTextToClipboard).mockClear();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getFileTreeRoots: jest.fn(),
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
        showInFinder: jest.fn(() => Promise.resolve()),
        mutateFileTree: jest.fn(() =>
          Promise.resolve({ operation: 'copy' as const }),
        ),
        openExternalFile: jest.fn(() => Promise.resolve()),
      },
    });
    useActivityStore.setState({
      changedFiles: {
        [WORKTREE_KEY]: {
          uncommitted: [
            {
              path: 'src/right-click.ts',
              status: 'modified',
              insertions: 2,
              deletions: 1,
            },
          ],
          committed: [],
        },
      },
    });
    useFileListStore.setState({
      rootsCache: {
        [WORKTREE_KEY]: {
          data: {
            roots: [
              {
                repoId: 'repo-1',
                repoName: 'demo',
                absolutePath: '/tmp/demo',
                rootKind: 'git-repo',
              },
            ],
          },
          fetchedAt: Date.now(),
        },
      },
    });
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useActivityStore.setState({ changedFiles: {} });
    useFileListStore.setState({ rootsCache: {} });
    useChatStore.setState({ selectedWorktree: null });
    jest.mocked(openFileInDiff).mockClear();
    setTestEarlyAccessFeatures({ enabled: false });
  });

  it('draws the diagram glyph on the review button without a Labs opt-in', () => {
    // The connected-nodes glyph (`ChangeDiagramIcon`).
    const connectorsGlyph = 'data-glyph="network"';
    act(() => root.render(<Harness />));
    const button = container.querySelector<HTMLElement>(
      '[data-testid="view-change-diagram-button"]',
    );
    expect(button?.querySelector('svg')).not.toBeNull();
    expect(button?.innerHTML).toContain(connectorsGlyph);
    act(() => {
      setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
    });
    expect(button?.innerHTML).toContain(connectorsGlyph);
  });

  it('reuses filtered conversions and sorts when its host model rerenders', () => {
    useActivityStore.setState({
      changedFiles: {
        [WORKTREE_KEY]: {
          uncommitted: [
            {
              path: 'src/z-last.ts',
              status: 'modified',
              insertions: 1,
              deletions: 0,
            },
            {
              path: 'src/a-first.ts',
              status: 'modified',
              insertions: 1,
              deletions: 0,
            },
            {
              path: 'src/m-middle.ts',
              status: 'modified',
              insertions: 1,
              deletions: 0,
            },
          ],
          committed: [
            {
              path: 'docs/z-last.md',
              status: 'modified',
              insertions: 1,
              deletions: 0,
            },
            {
              path: 'docs/a-first.md',
              status: 'modified',
              insertions: 1,
              deletions: 0,
            },
            {
              path: 'docs/m-middle.md',
              status: 'modified',
              insertions: 1,
              deletions: 0,
            },
          ],
        },
      },
    });
    const models: DesktopChangedFilesSectionModel[] = [];
    const localeCompare = jest.spyOn(String.prototype, 'localeCompare');

    try {
      act(() =>
        root.render(
          <ModelHarness revision={0} onModel={(model) => models.push(model)} />,
        ),
      );
      const comparisonsAfterFirstRender = localeCompare.mock.calls.length;
      expect(comparisonsAfterFirstRender).toBeGreaterThan(0);

      act(() =>
        root.render(
          <ModelHarness revision={1} onModel={(model) => models.push(model)} />,
        ),
      );

      expect(models[0]?.changedFiles).toBe(models[1]?.changedFiles);
      expect(models[1]?.workspaceLocalId).toBe(PROJECT_ID);
      expect(models[1]?.worktreeLocalId).toBe(WORKTREE_ID);
      expect(localeCompare).toHaveBeenCalledTimes(comparisonsAfterFirstRender);
    } finally {
      localeCompare.mockRestore();
    }
  });

  it('opens the limited changed-file menu with the preferred app action', async () => {
    act(() => root.render(<Harness />));
    const row = container.querySelector<HTMLElement>(
      '[data-testid="activity-changed-file"]',
    );
    expect(row).not.toBeNull();

    await act(async () => {
      row?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 90,
          clientY: 120,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const menu = document.querySelector<HTMLElement>(
      '[data-testid="files-tree-action-menu"]',
    );
    expect(menu).not.toBeNull();
    const items = Array.from(
      menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    expect(
      items.map((item) => item.getAttribute('aria-label') ?? item.textContent),
    ).toEqual([
      'Open',
      'Open in VS Code',
      'Send to chat',
      'Copy relative path',
      'Copy path',
      'Open in Finder',
    ]);
    expect(menu?.textContent).not.toContain('Open to the side');
    expect(menu?.textContent).not.toContain('New File');
    expect(menu?.textContent).not.toContain('Cut');
    expect(menu?.textContent).not.toContain('Rename');
    expect(menu?.textContent).not.toContain('Delete');

    const openInApp = menu?.querySelector<HTMLButtonElement>(
      '[data-testid="files-tree-action-open-in-app"]',
    );
    expect(openInApp?.textContent).toBe('Open in');
    expect(openInApp?.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,AA==',
    );
    act(() => {
      openInApp?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Open in VS Code',
    );

    await act(async () => {
      openInApp?.click();
      await Promise.resolve();
    });
    expect(window.api.openInApp).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      appId: 'vscode',
    });
    expect(window.api.savePreferences).toHaveBeenCalledWith({
      lastOpenApp: 'vscode',
    });

    await act(async () => {
      row?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 90,
          clientY: 120,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const reopenedMenu = document.querySelector<HTMLElement>(
      '[data-testid="files-tree-action-menu"]',
    );

    const copyRelative = Array.from(
      reopenedMenu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ??
        [],
    ).find((item) => item.textContent === 'Copy relative path');
    expect(copyRelative).toBeDefined();
    await act(async () => {
      copyRelative?.click();
      await Promise.resolve();
    });
    expect(copyTextToClipboard).toHaveBeenCalledWith('src/right-click.ts');
    expect(
      document.querySelector('[data-testid="files-tree-action-menu"]'),
    ).toBeNull();
  });

  it('uses the Git root when an attachments root is also present', async () => {
    useFileListStore.setState({
      rootsCache: {
        [WORKTREE_KEY]: {
          data: {
            roots: [
              {
                repoId: 'repo-1',
                repoName: 'demo',
                absolutePath: '/tmp/demo',
                rootKind: 'git-repo',
              },
              {
                repoId: 'attachments',
                repoName: 'Attachments',
                absolutePath: '/tmp/attachments',
                rootKind: 'attachments',
              },
            ],
          },
          fetchedAt: Date.now(),
        },
      },
    });
    act(() => root.render(<Harness />));
    const row = container.querySelector<HTMLElement>(
      '[data-testid="activity-changed-file"]',
    );

    await act(async () => {
      row?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 90,
          clientY: 120,
        }),
      );
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="files-tree-action-menu"]'),
    ).not.toBeNull();
  });

  it('routes deleted files to the diff and reveals their existing parent directory', async () => {
    useActivityStore.setState({
      changedFiles: {
        [WORKTREE_KEY]: {
          uncommitted: [
            {
              path: 'src/deleted.ts',
              status: 'deleted',
              insertions: 0,
              deletions: 4,
            },
          ],
          committed: [],
        },
      },
    });
    act(() => root.render(<Harness />));
    const row = container.querySelector<HTMLElement>(
      '[data-testid="activity-changed-file"]',
    );

    await act(async () => {
      row?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 90,
          clientY: 120,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const menu = document.querySelector<HTMLElement>(
      '[data-testid="files-tree-action-menu"]',
    );
    const items = Array.from(
      menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    expect(
      items.map((item) => item.getAttribute('aria-label') ?? item.textContent),
    ).toEqual(['Open', 'Copy relative path', 'Copy path', 'Open in Finder']);

    await act(async () => {
      items.find((item) => item.textContent === 'Open')?.click();
      await Promise.resolve();
    });
    expect(openFileInDiff).toHaveBeenCalledWith(
      { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      {
        path: 'src/deleted.ts',
        status: 'deleted',
        insertions: 0,
        deletions: 4,
      },
      'uncommitted',
    );

    await act(async () => {
      row?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 90,
          clientY: 120,
        }),
      );
      await Promise.resolve();
    });
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="files-tree-action-open-in-file-manager"]',
        )
        ?.click();
    });
    expect(window.api.showInFinder).toHaveBeenCalledWith({
      absolutePath: '/tmp/demo/src',
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
  });

  it('still opens when the file lists are invalidated while roots load', async () => {
    const roots = {
      roots: [
        {
          repoId: 'repo-1',
          repoName: 'demo',
          absolutePath: '/tmp/demo',
          rootKind: 'git-repo' as const,
        },
      ],
    };
    let resolveDiscarded!: (value: typeof roots) => void;
    jest
      .mocked(window.api.getFileTreeRoots)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveDiscarded = resolve;
        }),
      )
      .mockResolvedValueOnce(roots);
    useFileListStore.setState({ rootsCache: {} });
    act(() => root.render(<Harness />));
    const row = container.querySelector<HTMLElement>(
      '[data-testid="activity-changed-file"]',
    );

    act(() => {
      row?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 90,
          clientY: 120,
        }),
      );
    });
    // The worktree's first diff stats land mid-read and invalidate its file
    // lists, discarding the roots response the menu is waiting for.
    await act(async () => {
      useFileListStore.getState().invalidate(PROJECT_ID, WORKTREE_ID);
      resolveDiscarded(roots);
      for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="files-tree-action-menu"]'),
    ).not.toBeNull();
    expect(window.api.getFileTreeRoots).toHaveBeenCalledTimes(2);
  });

  it('keeps the newest target when uncached root fetches resolve out of order', async () => {
    let resolveFirst!: (value: {
      roots: Array<{
        repoId: string;
        repoName: string;
        absolutePath: string;
        rootKind: 'git-repo';
      }>;
    }) => void;
    let resolveSecond!: typeof resolveFirst;
    const first = new Promise<Parameters<typeof resolveFirst>[0]>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<Parameters<typeof resolveSecond>[0]>(
      (resolve) => {
        resolveSecond = resolve;
      },
    );
    jest
      .mocked(window.api.getFileTreeRoots)
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    useFileListStore.setState({ rootsCache: {} });
    useActivityStore.setState({
      changedFiles: {
        [WORKTREE_KEY]: {
          uncommitted: [
            {
              path: 'src/first.ts',
              status: 'modified',
              insertions: 1,
              deletions: 0,
            },
            {
              path: 'src/second.ts',
              status: 'modified',
              insertions: 1,
              deletions: 0,
            },
          ],
          committed: [],
        },
      },
    });
    act(() => root.render(<Harness />));
    const rows = container.querySelectorAll<HTMLElement>(
      '[data-testid="activity-changed-file"]',
    );

    act(() => {
      rows[0]?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 40,
          clientY: 60,
        }),
      );
      rows[1]?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 80,
          clientY: 100,
        }),
      );
    });

    const roots = {
      roots: [
        {
          repoId: 'repo-1',
          repoName: 'demo',
          absolutePath: '/tmp/demo',
          rootKind: 'git-repo' as const,
        },
      ],
    };
    await act(async () => {
      resolveSecond(roots);
      await second;
      await Promise.resolve();
      resolveFirst(roots);
      await first;
      await Promise.resolve();
    });

    const copyPath = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((item) => item.textContent === 'Copy path');
    await act(async () => {
      copyPath?.click();
      await Promise.resolve();
    });
    expect(copyTextToClipboard).toHaveBeenCalledWith('/tmp/demo/src/second.ts');
  });
});
