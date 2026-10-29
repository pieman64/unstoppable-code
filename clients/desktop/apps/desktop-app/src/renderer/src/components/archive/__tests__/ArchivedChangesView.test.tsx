/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ArchivedContainerListChangesRequest,
  ArchivedContainerListChangesResponse,
  ArchivedContainerReadChangeDiffResponse,
  ArchivedGitChangesSummary,
  ChangedFileInfo,
} from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { ArchivedChangesView } from '@/components/archive/ArchivedChangesView';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Rendering thousands of file-tree rows can exceed Jest's 5-second default
// when the full repository suite is sharing CPU with other workers.
jest.setTimeout(30_000);

const WORKSPACE_ID = 'ws-1';
const CONTAINER_ID = 'container-1';

function makeFile(
  index: number,
  overrides: Partial<ChangedFileInfo> = {},
): ChangedFileInfo {
  return {
    path: `src/file-${index}.ts`,
    status: 'modified',
    insertions: index + 1,
    deletions: index,
    repoId: 'repo-a',
    repoName: 'repo-a',
    ...overrides,
  };
}

function makeFiles(count: number): ChangedFileInfo[] {
  return Array.from({ length: count }, (_, index) => makeFile(index));
}

function completeGitChanges(
  overrides: Partial<
    Extract<ArchivedGitChangesSummary, { status: 'complete' }>
  > = {},
): ArchivedGitChangesSummary {
  return {
    status: 'complete',
    capturedAt: '2026-07-20T00:00:00.000Z',
    fileCount: 3,
    insertions: 12,
    deletions: 4,
    repositories: [
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        fileCount: 3,
        insertions: 12,
        deletions: 4,
      },
    ],
    ...overrides,
  };
}

const listChangesMock = jest.fn<
  Promise<ArchivedContainerListChangesResponse>,
  [ArchivedContainerListChangesRequest]
>();
const readChangeDiffMock = jest.fn<
  Promise<ArchivedContainerReadChangeDiffResponse>,
  [{ projectId: string; containerId: string; repoId: string; filePath: string }]
>();

/** Serve `allFiles` in `pageSize` chunks with numeric offsets as cursors. */
function servePages(
  allFiles: ChangedFileInfo[],
  pageSize: number,
  options: { totalCount?: number; truncated?: boolean } = {},
): void {
  listChangesMock.mockImplementation((request) => {
    const start =
      request.cursor !== undefined ? Number.parseInt(request.cursor, 10) : 0;
    const files = allFiles.slice(start, start + pageSize);
    const nextStart = start + pageSize;
    return Promise.resolve({
      files,
      totalCount: options.totalCount ?? allFiles.length,
      nextCursor: nextStart < allFiles.length ? String(nextStart) : null,
      truncated: options.truncated ?? false,
    });
  });
}

function diffResponse(
  overrides: Partial<ArchivedContainerReadChangeDiffResponse> = {},
): ArchivedContainerReadChangeDiffResponse {
  return {
    oldValue: 'old',
    newValue: 'new',
    filePath: 'src/file-0.ts',
    source: 'combined',
    truncated: false,
    binary: false,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(
  props: Partial<Parameters<typeof ArchivedChangesView>[0]> = {},
): Promise<void> {
  await act(async () => {
    root.render(
      <ArchivedChangesView
        workspaceId={WORKSPACE_ID}
        containerId={CONTAINER_ID}
        gitChanges={completeGitChanges()}
        {...props}
      />,
    );
    await Promise.resolve();
  });
  await flush();
}

/** File rows rendered by the shared code-review file tree. */
function fileRows(): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      '[data-testid^="diff-file-tree-row-"]',
    ),
  );
}

/** Folder rows of the tree (repository sections included). */
function folderLabels(): string[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="diff-file-tree"] button',
    ),
  )
    .filter((button) => button.dataset['testid'] === undefined)
    .map((button) => button.textContent ?? '');
}

function clickRow(repoId: string, path: string): Promise<void> {
  return act(async () => {
    container
      .querySelector(`[data-testid="diff-file-tree-row-${repoId}:${path}"]`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  listChangesMock.mockReset();
  readChangeDiffMock.mockReset().mockResolvedValue(diffResponse());
  servePages(makeFiles(3), 250);

  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      archivedContainers: {
        listChanges: listChangesMock,
        readChangeDiff: readChangeDiffMock,
      },
    },
  });

  useArchivedContainersStore.setState({
    byWorkspace: {},
    loadedWorkspaces: {},
    viewer: null,
    changesList: null,
    restoringContainer: null,
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe('ArchivedChangesView', () => {
  it('shows the initial loading state with the required copy', async () => {
    let resolveList: (
      value: ArchivedContainerListChangesResponse,
    ) => void = () => undefined;
    listChangesMock.mockImplementation(
      () =>
        new Promise<ArchivedContainerListChangesResponse>((resolve) => {
          resolveList = resolve;
        }),
    );
    await render();

    expect(
      container.querySelector('[data-testid="archived-changes-loading"]')
        ?.textContent,
    ).toContain('Loading changed files…');

    await act(async () => {
      resolveList({
        files: makeFiles(1),
        totalCount: 1,
        nextCursor: null,
        truncated: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      container.querySelector('[data-testid="archived-changes-loading"]'),
    ).toBeNull();
    expect(fileRows()).toHaveLength(1);
  });

  it('renders a retryable list error and recovers after Retry', async () => {
    listChangesMock.mockRejectedValue(new Error('boom'));
    await render();

    const error = container.querySelector(
      '[data-testid="archived-changes-list-error"]',
    );
    expect(error?.textContent).toContain(
      'Changed files couldn’t be loaded for this archive.',
    );

    servePages(makeFiles(2), 250);
    await act(async () => {
      container
        .querySelector('[data-testid="archived-changes-list-retry"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();

    expect(
      container.querySelector('[data-testid="archived-changes-list-error"]'),
    ).toBeNull();
    expect(fileRows()).toHaveLength(2);
  });

  it('renders the empty state and never requests a diff', async () => {
    servePages([], 250);
    await render();

    expect(
      container.querySelector('[data-testid="archived-changes-empty"]')
        ?.textContent,
    ).toBe('No changed files were captured with this archive.');
    expect(readChangeDiffMock).not.toHaveBeenCalled();
  });

  it('records the explorer and file names and blocks only the diff content', async () => {
    await render();

    const view = container.querySelector(
      '[data-testid="archived-changes-view"]',
    );
    expect(view).toBe(container.firstElementChild);
    expect(view?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
    expect(
      container
        .querySelector('[data-testid="diff-file-tree"]')
        ?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
    const pane = container.querySelector(
      '[data-testid="archived-changes-diff-pane"]',
    );
    expect(pane?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
    expect(
      pane?.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
    ).not.toBeNull();
  });

  it('auto-selects the first file of the first page and lazily loads its diff once', async () => {
    await render();

    expect(readChangeDiffMock).toHaveBeenCalledTimes(1);
    expect(readChangeDiffMock).toHaveBeenCalledWith({
      projectId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      repoId: 'repo-a',
      filePath: 'src/file-0.ts',
    });
  });

  it('auto-pages to the terminal cursor so the tree holds whole folders', async () => {
    servePages(makeFiles(60), 40);
    await render();

    expect(listChangesMock).toHaveBeenCalledTimes(2);
    expect(listChangesMock.mock.calls[0][0].cursor).toBeUndefined();
    expect(listChangesMock.mock.calls[1][0].cursor).toBe('40');

    // Terminal cursor: further flushes must not fetch again.
    await flush();
    expect(listChangesMock).toHaveBeenCalledTimes(2);

    const state = useArchivedContainersStore.getState().changesList;
    expect(state?.files).toHaveLength(60);
    expect(state?.nextCursor).toBeNull();
    expect(fileRows()).toHaveLength(60);
    expect(
      container.querySelector('[data-testid="diff-file-tree-header-count"]')
        ?.textContent,
    ).toBe('60 Files');
  });

  it('stops auto-paging at the row limit and requires an explicit Load more', async () => {
    // Two 1,000-row pages reach the 2,000-row auto-paging limit; the rest of
    // the archive waits for a click so the tree stays a bounded render.
    servePages(makeFiles(2500), 1000);
    await render();

    expect(listChangesMock).toHaveBeenCalledTimes(2);
    await flush();
    expect(listChangesMock).toHaveBeenCalledTimes(2);

    const loadMore = container.querySelector(
      '[data-testid="archived-changes-load-more"]',
    );
    expect(loadMore?.textContent).toContain('Showing 2,000 of 2,500');

    await act(async () => {
      container
        .querySelector('[data-testid="archived-changes-load-more-button"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();

    expect(listChangesMock).toHaveBeenCalledTimes(3);
    expect(
      useArchivedContainersStore.getState().changesList?.files,
    ).toHaveLength(2500);
    expect(
      container.querySelector('[data-testid="archived-changes-load-more"]'),
    ).toBeNull();
  });

  it('keeps loaded pages and offers an appending retry when a next page fails', async () => {
    const files = makeFiles(60);
    let failNextPage = true;
    listChangesMock.mockImplementation((request) => {
      if (request.cursor !== undefined && failNextPage) {
        return Promise.reject(new Error('page boom'));
      }
      const start =
        request.cursor !== undefined ? Number.parseInt(request.cursor, 10) : 0;
      return Promise.resolve({
        files: files.slice(start, start + 40),
        totalCount: files.length,
        nextCursor: start + 40 < files.length ? String(start + 40) : null,
        truncated: false,
      });
    });
    await render();

    // First page loaded, second failed: rows stay, inline retry appears.
    expect(fileRows().length).toBeGreaterThan(0);
    expect(
      container.querySelector('[data-testid="archived-changes-page-error"]')
        ?.textContent,
    ).toContain('Changed files couldn’t be loaded for this archive.');
    const callsBeforeRetry = listChangesMock.mock.calls.length;

    failNextPage = false;
    await act(async () => {
      container
        .querySelector('[data-testid="archived-changes-page-retry"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();

    expect(listChangesMock.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
    expect(
      useArchivedContainersStore.getState().changesList?.files,
    ).toHaveLength(60);
  });

  it('renders the truncation banner with the real total', async () => {
    servePages(makeFiles(30), 30, { totalCount: 60_000, truncated: true });
    await render();

    expect(
      container.querySelector('[data-testid="archived-changes-truncation"]')
        ?.textContent,
    ).toBe('List truncated. Showing the first 50,000 of 60,000 changed files.');
  });

  it('groups multi-repo archives under one folder per repository', async () => {
    const files = [
      makeFile(0, { repoId: 'repo-a', repoName: 'Repo A' }),
      makeFile(1, { repoId: 'repo-a', repoName: 'Repo A' }),
      makeFile(2, { repoId: 'repo-b', repoName: 'Repo B' }),
    ];
    servePages(files, 250);
    await render({
      gitChanges: completeGitChanges({
        repositories: [
          {
            repoId: 'repo-a',
            repoName: 'Repo A',
            fileCount: 2,
            insertions: 3,
            deletions: 1,
          },
          {
            repoId: 'repo-b',
            repoName: 'Repo B',
            fileCount: 1,
            insertions: 3,
            deletions: 2,
          },
        ],
      }),
    });

    // Each repository becomes a top-level folder, with its own `src/` below.
    const labels = folderLabels();
    expect(labels.some((label) => label.includes('Repo A'))).toBe(true);
    expect(labels.some((label) => label.includes('Repo B'))).toBe(true);
    expect(fileRows().map((row) => row.getAttribute('data-testid'))).toEqual([
      'diff-file-tree-row-repo-a:src/file-0.ts',
      'diff-file-tree-row-repo-a:src/file-1.ts',
      'diff-file-tree-row-repo-b:src/file-2.ts',
    ]);
  });

  it('omits the repository folder for single-repo archives', async () => {
    await render();
    // Only the shared `src/` folder — no repository-named root.
    expect(folderLabels().some((label) => label.includes('repo-a'))).toBe(
      false,
    );
    expect(folderLabels().some((label) => label.includes('src'))).toBe(true);
  });

  it('shows the file name in the row and the full rename path accessibly', async () => {
    const files = [
      makeFile(0, {
        path: 'src/renamed-new.ts',
        previousPath: 'src/renamed-old.ts',
        status: 'renamed',
        insertions: 5,
        deletions: 2,
      }),
    ];
    servePages(files, 250);
    await render();

    const row = fileRows()[0];
    // Tree rows show the leaf name; the folder path is the tree itself.
    expect(row.textContent).toContain('renamed-new.ts');
    expect(row.textContent).toContain('+5');
    expect(row.textContent).toContain('-2');
    // CAN-2799: the full description is the accessible name and a rich hover
    // tooltip, never a native title.
    expect(row.hasAttribute('title')).toBe(false);
    expect(row.getAttribute('aria-label')).toBe(
      'renamed: src/renamed-old.ts → src/renamed-new.ts (+5 −2)',
    );
    act(() => {
      row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'renamed: src/renamed-old.ts → src/renamed-new.ts (+5 −2)',
    );
    act(() => {
      row.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
  });

  it('caches per-file diffs for the mounted view: switching back makes no second request', async () => {
    servePages(makeFiles(3), 250);
    await render();
    expect(readChangeDiffMock).toHaveBeenCalledTimes(1);

    await clickRow('repo-a', 'src/file-1.ts');
    expect(readChangeDiffMock).toHaveBeenCalledTimes(2);

    await clickRow('repo-a', 'src/file-0.ts');
    await clickRow('repo-a', 'src/file-1.ts');
    expect(readChangeDiffMock).toHaveBeenCalledTimes(2);
  });

  it('never lets a slower older response replace the selected file’s diff', async () => {
    const resolvers = new Map<
      string,
      (value: ArchivedContainerReadChangeDiffResponse) => void
    >();
    readChangeDiffMock.mockImplementation(
      ({ filePath }) =>
        new Promise((resolve) => {
          resolvers.set(filePath, resolve);
        }),
    );
    servePages(makeFiles(3), 250);
    await render();

    // Rapidly switch to file-1 while file-0 (auto-selected) is in flight.
    await clickRow('repo-a', 'src/file-1.ts');

    // file-1 resolves as an empty diff; the slow file-0 response lands later
    // as a binary diff and must not blank or replace the selected pane.
    await act(async () => {
      resolvers.get('src/file-1.ts')?.(
        diffResponse({ filePath: 'src/file-1.ts', oldValue: '', newValue: '' }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain('No changes in this file');

    await act(async () => {
      resolvers.get('src/file-0.ts')?.(
        diffResponse({ filePath: 'src/file-0.ts', binary: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain('No changes in this file');
    expect(container.textContent).not.toContain(
      'Binary file. There is no text diff to show.',
    );

    // The older response is still cached for its own file.
    await clickRow('repo-a', 'src/file-0.ts');
    expect(container.textContent).toContain(
      'Binary file. There is no text diff to show.',
    );
    expect(readChangeDiffMock).toHaveBeenCalledTimes(2);
  });

  it('shows a retryable per-file diff error without discarding the loaded list', async () => {
    readChangeDiffMock.mockRejectedValue(new Error('diff boom'));
    servePages(makeFiles(3), 250);
    await render();

    const error = container.querySelector(
      '[data-testid="archived-changes-diff-error"]',
    );
    expect(error?.textContent).toContain(
      'This archived diff couldn’t be loaded.',
    );
    expect(fileRows()).toHaveLength(3);
    expect(listChangesMock).toHaveBeenCalledTimes(1);

    readChangeDiffMock.mockResolvedValue(diffResponse({ binary: true }));
    await act(async () => {
      container
        .querySelector('[data-testid="archived-changes-diff-retry"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain(
      'Binary file. There is no text diff to show.',
    );
    // Retrying the diff never refetches the list.
    expect(listChangesMock).toHaveBeenCalledTimes(1);
  });

  it('shows the no-selection state when the selected record disappears after a list restart', async () => {
    servePages(makeFiles(2), 250);
    await render();

    await clickRow('repo-a', 'src/file-1.ts');

    // Simulate the archive view changing under a user selection: the list
    // restarts with different membership (store-level, same identity).
    const current = useArchivedContainersStore.getState().changesList;
    if (current === null) throw new Error('changes list missing');
    await act(async () => {
      useArchivedContainersStore.setState({
        changesList: {
          ...current,
          files: [makeFile(7, { path: 'src/other.ts' })],
        },
      });
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      'Select a file to view its archived diff.',
    );
  });

  it('toggles Unified/Split with visible labels without refetching the diff', async () => {
    readChangeDiffMock.mockResolvedValue(
      diffResponse({ oldValue: 'a', newValue: 'b' }),
    );
    await render();
    expect(readChangeDiffMock).toHaveBeenCalledTimes(1);

    const unified = container.querySelector(
      '[data-testid="archived-changes-view-mode-unified"]',
    );
    const split = container.querySelector(
      '[data-testid="archived-changes-view-mode-split"]',
    );
    expect(unified?.textContent).toBe('Unified');
    expect(split?.textContent).toBe('Split');
    expect(unified?.getAttribute('aria-pressed')).toBe('true');

    await act(async () => {
      split?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(split?.getAttribute('aria-pressed')).toBe('true');
    expect(readChangeDiffMock).toHaveBeenCalledTimes(1);
  });

  it('renders image and truncated diffs through DiffContentView', async () => {
    readChangeDiffMock.mockResolvedValue(
      diffResponse({
        imagePreview: { newDataUrl: 'data:image/png;base64,xyz' },
      }),
    );
    await render();
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,xyz',
    );

    readChangeDiffMock.mockResolvedValue(
      diffResponse({ oldValue: 'a', newValue: 'b', truncated: true }),
    );
    await clickRow('repo-a', 'src/file-1.ts');
    expect(container.textContent).toContain(
      'This diff is too large to show in full. Showing the beginning.',
    );
  });

  it('shows the aggregate summary with the captured totals when stats are complete', async () => {
    await render();

    expect(
      container.querySelector('[data-testid="archived-changes-summary-count"]')
        ?.textContent,
    ).toBe('3 changed files');
    expect(container.textContent).toContain('+12');
    expect(container.textContent).toContain('-4');
    expect(
      container.querySelector(
        '[data-testid="archived-changes-totals-unavailable"]',
      ),
    ).toBeNull();
  });

  it('shows `Change totals unavailable` when the captured stats are unavailable', async () => {
    await render({
      gitChanges: {
        status: 'unavailable',
        capturedAt: '2026-07-20T00:00:00.000Z',
      },
    });

    expect(
      container.querySelector(
        '[data-testid="archived-changes-totals-unavailable"]',
      )?.textContent,
    ).toBe('Change totals unavailable');
    // The explorer still lists files from the paged transport.
    expect(fileRows()).toHaveLength(3);
  });

  it('exposes no mutation or live-file actions anywhere in the explorer', async () => {
    await render();

    const buttonLabels = Array.from(container.querySelectorAll('button')).map(
      (button) =>
        `${button.textContent ?? ''} ${button.getAttribute('title') ?? ''}`,
    );
    for (const forbidden of [
      /revert/i,
      /edit/i,
      /comment/i,
      /reveal/i,
      /finder/i,
      /open file/i,
    ]) {
      expect(buttonLabels.some((label) => forbidden.test(label))).toBe(false);
    }
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
  });

  it('resets the list state when the view unmounts', async () => {
    await render();
    expect(useArchivedContainersStore.getState().changesList).not.toBeNull();

    act(() => {
      root.unmount();
    });
    expect(useArchivedContainersStore.getState().changesList).toBeNull();

    // afterEach unmounts again; recreate to keep it idempotent.
    root = createRoot(container);
  });
});
