/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatLookProvider } from '@canopy/ui-shared/components';
import { useChatStore } from '@/stores/chatStore';
import type * as ChatStoreModule from '@/stores/chatStore';
import { TurnDiffSummary } from '../TurnDiffSummary';
import { showFilesInRenderer } from '@/lib/show-files';
import { onTurnFileViewerClosed } from '@/lib/turn-file-viewer';
import type { TurnDiffData } from '@canopy/desktop-shared/types';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
// The summary's panel helpers import the terminal stack, and xterm reads
// `document` at import time, which jsdom does not provide the way it expects.
jest.mock('@xterm/xterm', () => ({}));

jest.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    jest.fn(() => undefined),
    {
      getState: (): unknown => ({ worktreeChats: {}, closingChatTabs: {} }),
      subscribe: jest.fn(() => jest.fn()),
    },
  ),
}));
jest.mock('@/lib/show-files', () => ({ showFilesInRenderer: jest.fn() }));
jest.mock('@/lib/turn-file-viewer', () => ({
  onTurnFileViewerClosed: jest.fn(() => jest.fn()),
}));
jest.mock('@/stores/chat/surface', () => ({
  detectChatStoreSurface: (): string => 'main',
}));

const fileTarget = {
  projectId: 'project',
  worktreeId: 'worktree',
  chatId: 'chat',
};
const located = (
  relativePath: string,
): {
  path: string;
  absolutePath: string;
  repoId: string;
  relativePath: string;
} => ({
  path: `/ws/${relativePath}`,
  absolutePath: `/ws/${relativePath}`,
  repoId: 'project',
  relativePath,
});

const smallTurnDiff: TurnDiffData = {
  files: [
    {
      path: 'src/app.ts',
      status: 'modified',
      insertions: 3,
      deletions: 1,
    },
  ],
  totalInsertions: 3,
  totalDeletions: 1,
  capturedAt: 123,
  treeRefs: [{ startTree: 'start-tree', endTree: 'end-tree' }],
};

const twoFileTurnDiff: TurnDiffData = {
  ...smallTurnDiff,
  files: [
    ...smallTurnDiff.files,
    { path: 'src/view.tsx', status: 'added', insertions: 2, deletions: 0 },
  ],
  totalInsertions: 5,
  totalDeletions: 1,
};

function selectedWorktreeState(): ReturnType<typeof useChatStore.getState> {
  const actualStore =
    jest.requireActual<typeof ChatStoreModule>(
      '@/stores/chatStore',
    ).useChatStore;
  return {
    ...actualStore.getState(),
    selectedWorktree: { projectId: 'project', worktreeId: 'worktree' },
  };
}

describe('TurnDiffSummary', () => {
  it('collapses when a large completed diff arrives after an early file', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const files = [located('report.md')];
    act(() => {
      root.render(
        <ChatLookProvider value="classic">
          <TurnDiffSummary
            files={files}
            fileTarget={fileTarget}
            isLastTurnGroup
          />
        </ChatLookProvider>,
      );
    });
    expect(
      container.querySelector('[aria-expanded]')?.getAttribute('aria-expanded'),
    ).toBe('true');
    const largeDiff: TurnDiffData = {
      ...smallTurnDiff,
      files: Array.from({ length: 11 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        status: 'modified',
        insertions: 1,
        deletions: 0,
      })),
    };
    act(() => {
      root.render(
        <ChatLookProvider value="classic">
          <TurnDiffSummary
            turnDiff={largeDiff}
            files={files}
            fileTarget={fileTarget}
            isLastTurnGroup
          />
        </ChatLookProvider>,
      );
    });
    expect(
      container.querySelector('[aria-expanded]')?.getAttribute('aria-expanded'),
    ).toBe('false');
    act(() => root.unmount());
  });
  it('holds the expand default while a completed turn awaits its file check', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TurnDiffSummary
          turnDiff={smallTurnDiff}
          fileTarget={fileTarget}
          filesSettled={false}
          isLastTurnGroup
        />
      </ChatLookProvider>,
    );

    expect(html).toContain('aria-expanded="false"');
  });

  it('starts expanded for the latest small turn diff', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TurnDiffSummary turnDiff={smallTurnDiff} isLastTurnGroup />
      </ChatLookProvider>,
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('app.ts');
  });

  it('starts collapsed for historical small turn diffs', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TurnDiffSummary turnDiff={smallTurnDiff} isLastTurnGroup={false} />
      </ChatLookProvider>,
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('app.ts');
  });

  it('summarizes created files without a diff as openable chips', () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { showInFinder: jest.fn() },
    });
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TurnDiffSummary
          files={[located('report.md'), located('out/page.html')]}
          fileTarget={fileTarget}
          turnId="turn"
          isLastTurnGroup
        />
      </ChatLookProvider>,
    );

    expect(html).toContain('2 files');
    expect(html).not.toContain('files changed');
    expect(html).toContain('data-turn-id="turn"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-label="Open report.md"');
    expect(html).toContain('aria-label="Open page.html"');
    // Each completed chip reveals its own file and says where it was saved.
    expect(html).toContain('aria-label="Show report.md in Finder"');
    expect(html).toContain('aria-label="Show page.html in Finder"');
    expect(html).toContain('Saved in project folder');
    expect(html).not.toContain('title="/ws/');
  });

  it('folds created files into the diff summary without repeating diffed paths', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TurnDiffSummary
          turnDiff={smallTurnDiff}
          files={[located('src/app.ts'), located('notes/extra.md')]}
          fileTarget={fileTarget}
          isLastTurnGroup
        />
      </ChatLookProvider>,
    );

    expect(html).toContain('1 file changed');
    expect(html).toContain('1 other file');
    expect(html).toContain('aria-label="Open extra.md"');
    expect(html).not.toContain('aria-label="Open app.ts"');
    expect(html).toContain('aria-label="src/app.ts"');
  });

  it('shows in-flight creations as pending chips', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TurnDiffSummary
          pendingFiles={[{ path: '/ws/draft.md', state: 'creating' }]}
          fileTarget={fileTarget}
          isLastTurnGroup
        />
      </ChatLookProvider>,
    );

    expect(html).toContain('1 file');
    expect(html).toContain('Creating…');
    expect(html).toContain('aria-label="Creating draft.md"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain('turn-file-chip-reveal');
    expect(html).not.toContain('Saved in');
  });

  it('summarizes an edit-only turn as an updated file', () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { showInFinder: jest.fn() },
    });
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TurnDiffSummary
          files={[{ ...located('report.md'), change: 'updated' }]}
          fileTarget={fileTarget}
          isLastTurnGroup
        />
      </ChatLookProvider>,
    );

    expect(html).toContain('1 file updated');
    expect(html).toContain('data-file-change="updated"');
    expect(html).toContain('aria-label="Open report.md"');
    expect(html).toContain('aria-label="Show report.md in Finder"');
    expect(html).toContain('Updated in project folder');
    expect(html).not.toContain('Saved in');
  });

  it('does not count pending paths already represented by the diff', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TurnDiffSummary
          turnDiff={smallTurnDiff}
          fileTarget={fileTarget}
          isLastTurnGroup
          pendingFiles={[
            { path: 'src/app.ts', state: 'creating', change: 'updated' },
          ]}
        />
      </ChatLookProvider>,
    );
    expect(html).not.toContain('other file');
    expect(html).not.toContain('turn-file-chip');
  });

  it('does not render an empty summary when file actions have no target', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TurnDiffSummary files={[located('report.md')]} isLastTurnGroup />
      </ChatLookProvider>,
    );
    expect(html).toBe('');
  });

  it('counts updated files within a mixed summary', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TurnDiffSummary
          files={[
            located('new.md'),
            { ...located('report.md'), change: 'updated' },
          ]}
          fileTarget={fileTarget}
          isLastTurnGroup
        />
      </ChatLookProvider>,
    );

    expect(html).toContain('2 files, 1 updated');
    expect(html).toContain('data-file-change="created"');
    expect(html).toContain('data-file-change="updated"');
    expect(html).toContain('Saved in project folder');
    expect(html).toContain('Updated in project folder');
  });

  it('words an updated file beside a diff as another updated file', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TurnDiffSummary
          turnDiff={smallTurnDiff}
          files={[
            { ...located('src/app.ts'), change: 'updated' },
            { ...located('notes/extra.md'), change: 'updated' },
          ]}
          fileTarget={fileTarget}
          isLastTurnGroup
        />
      </ChatLookProvider>,
    );

    // The diffed update stays in the diff only and is not counted again.
    expect(html).toContain('1 file changed');
    expect(html).toContain('· 1 other file updated');
    expect(html).not.toContain('aria-label="Open app.ts"');
  });

  it('shows in-flight updates as pending chips that never claim completion', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TurnDiffSummary
          pendingFiles={[
            { path: '/ws/report.md', state: 'creating', change: 'updated' },
          ]}
          fileTarget={fileTarget}
          isLastTurnGroup
        />
      </ChatLookProvider>,
    );

    expect(html).toContain('1 file updating');
    expect(html).not.toContain('1 file updated');
    expect(html).toContain('Updating…');
    expect(html).toContain('aria-label="Updating report.md"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain('turn-file-chip-reveal');
    expect(html).not.toContain('Updated in');
  });

  it('keeps a neutral heading while pending and completed updates mix', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TurnDiffSummary
          files={[{ ...located('done.md'), change: 'updated' }]}
          pendingFiles={[
            { path: '/ws/report.md', state: 'creating', change: 'updated' },
          ]}
          fileTarget={fileTarget}
          isLastTurnGroup
        />
      </ChatLookProvider>,
    );

    expect(html).toContain('>2 files<');
    expect(html).not.toContain('updated<');
    expect(html).not.toContain('updating<');
  });

  it('renders nothing without diffed, created or pending files', () => {
    expect(
      renderToStaticMarkup(
        <ChatLookProvider value="classic">
          <TurnDiffSummary
            turnDiff={{ ...smallTurnDiff, files: [] }}
            files={[]}
            pendingFiles={[]}
            isLastTurnGroup
          />
        </ChatLookProvider>,
      ),
    ).toBe('');
  });

  it('starts collapsed for historical created files', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TurnDiffSummary
          files={[located('report.md')]}
          fileTarget={fileTarget}
          isLastTurnGroup={false}
        />
      </ChatLookProvider>,
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('1 file');
    expect(html).not.toContain('data-testid="turn-file-chip"');
  });
});

describe('TurnDiffSummary under the clean chat look', () => {
  function renderClean(props: {
    turnDiff: TurnDiffData;
    isLastTurnGroup?: boolean;
    onUndo?: () => void;
  }): string {
    return renderToStaticMarkup(
      <ChatLookProvider value="clean">
        <TurnDiffSummary
          turnDiff={props.turnDiff}
          isLastTurnGroup={props.isLastTurnGroup ?? true}
          {...(props.onUndo ? { onUndo: props.onUndo } : {})}
        />
      </ChatLookProvider>,
    );
  }

  it('titles an edit-only card with the updated count', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="clean">
        <TurnDiffSummary
          files={[
            { ...located('a.md'), change: 'updated' },
            { ...located('b.md'), change: 'updated' },
          ]}
          fileTarget={fileTarget}
          isLastTurnGroup
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-turn-files-title="">2 files updated<');
    expect(html).toContain('Updated in project folder');
  });

  it('appends other updated files to the edited count', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="clean">
        <TurnDiffSummary
          turnDiff={smallTurnDiff}
          files={[
            located('new.md'),
            { ...located('notes/extra.md'), change: 'updated' },
          ]}
          fileTarget={fileTarget}
          isLastTurnGroup
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('Edited 1 file, 2 other files, 1 updated');
  });

  it('reads as a changes card with the folder before the file name', () => {
    const html = renderClean({ turnDiff: twoFileTurnDiff });
    expect(html).toContain('Edited 2 files');
    expect(html).toContain(
      '>src/</span><span class="shrink-0 fg-primary">app.ts<',
    );
    expect(html).toContain('fg-success">+3<');
    expect(html).toContain('fg-destructive">-1<');
    expect(html).not.toContain('Undo');
  });

  it('collapses a one-file turn to its header, named for the file', () => {
    const host = document.createElement('div');
    host.innerHTML = renderClean({ turnDiff: smallTurnDiff });
    expect(host.querySelector('[data-turn-files-title]')?.textContent).toBe(
      'app.ts',
    );
    expect(host.querySelector('[data-line-counts]')?.textContent).toBe('+3-1');
    // No file list under the header.
    expect(host.querySelector('button[aria-label="src/app.ts"]')).toBeNull();
    expect(
      host.querySelector('button[aria-label="Edited app.ts"]'),
    ).not.toBeNull();
  });

  it.each([
    ['added', 'Created'],
    ['untracked', 'Created'],
    ['deleted', 'Deleted'],
    ['renamed', 'Edited'],
  ] as const)('names a one-file %s turn "%s <file>"', (status, verb) => {
    const host = document.createElement('div');
    host.innerHTML = renderClean({
      turnDiff: {
        ...smallTurnDiff,
        files: [{ ...smallTurnDiff.files[0], status }],
      },
    });
    expect(host.querySelector('[data-turn-files-title]')?.textContent).toBe(
      'app.ts',
    );
    expect(
      host.querySelector('[data-turn-files-title]')?.getAttribute('aria-label'),
    ).toBe(`${verb} app.ts`);
  });

  it('keeps the count and one row per file for two or more files', () => {
    const host = document.createElement('div');
    host.innerHTML = renderClean({ turnDiff: twoFileTurnDiff });
    expect(host.querySelector('[data-turn-files-title]')?.textContent).toBe(
      'Edited 2 files',
    );
    expect(host.querySelector('[data-line-counts]')?.textContent).toBe('+5-1');
    expect(
      host.querySelector('button[aria-label="src/app.ts"]'),
    ).toBeInstanceOf(HTMLElement);
    expect(
      host.querySelector('button[aria-label="src/view.tsx"]'),
    ).toBeInstanceOf(HTMLElement);
  });

  it('offers Undo only when the turn can be reset', () => {
    expect(
      renderClean({ turnDiff: smallTurnDiff, onUndo: jest.fn() }),
    ).toContain('Undo');
  });

  it('draws Undo and View changes with the shared ghost and secondary buttons', () => {
    const state = selectedWorktreeState();
    jest.mocked(useChatStore).mockImplementation((selector) => selector(state));
    try {
      const html = renderClean({ turnDiff: smallTurnDiff, onUndo: jest.fn() });
      expect(html).toMatch(/<button[^>]*bg-transparent fg-secondary[^>]*>Undo/);
      expect(html).toMatch(/<button[^>]*h-7 rounded-full[^>]*>View changes</);
    } finally {
      jest.mocked(useChatStore).mockImplementation(() => undefined);
    }
  });

  it('keeps the header on one line when it fits and moves the actions under it when not', () => {
    const state = selectedWorktreeState();
    jest.mocked(useChatStore).mockImplementation((selector) => selector(state));
    try {
      const host = document.createElement('div');
      host.innerHTML = renderClean({
        turnDiff: twoFileTurnDiff,
        onUndo: jest.fn(),
      });
      const title = host.querySelector('[data-turn-files-title]');
      expect(title).toBeInstanceOf(HTMLElement);
      const header = host.querySelector(
        '[data-testid="turn-files"]',
      )?.firstElementChild;
      // The row wraps by its own content, not by a viewport breakpoint: the
      // title block's basis is its full text (flex-auto, not flex-1).
      expect(header?.className.split(' ')).toEqual(
        expect.arrayContaining(['flex', 'flex-wrap']),
      );
      expect(title?.parentElement?.parentElement?.className.split(' ')).toEqual(
        expect.arrayContaining(['flex-auto', 'min-w-0']),
      );
      // Undo and View changes travel together, right-aligned.
      const actions = host.querySelector('[data-turn-files-actions]');
      expect(actions).toBeInstanceOf(HTMLElement);
      expect(actions?.parentElement).toBe(header);
      expect(actions?.className.split(' ')).toEqual(
        expect.arrayContaining(['ml-auto', 'shrink-0']),
      );
      expect(actions?.textContent).toBe('UndoView changes');
      // The line counts never break across lines.
      const counts = host.querySelector('[data-line-counts]');
      expect(counts).toBeInstanceOf(HTMLElement);
      expect(counts?.className.split(' ')).toContain('whitespace-nowrap');
      expect(counts?.textContent).toBe('+5-1');
    } finally {
      jest.mocked(useChatStore).mockImplementation(() => undefined);
    }
  });

  it('nests each row inside the card: a 4px-inset list with nested corners', () => {
    const host = document.createElement('div');
    host.innerHTML = renderClean({ turnDiff: twoFileTurnDiff });
    const row = host.querySelector('button[aria-label="src/app.ts"]');
    expect(row).toBeInstanceOf(HTMLElement);
    expect(row?.className.split(' ')).toEqual(
      expect.arrayContaining([
        'rounded-[calc(var(--radius-xl)-5px)]',
        'px-2',
        'hover:bg-subtle',
      ]),
    );
    expect(row?.parentElement?.className.split(' ')).toContain('py-1');
  });

  it('keeps older long summaries folded until opened', () => {
    const largeDiff: TurnDiffData = {
      ...smallTurnDiff,
      files: Array.from({ length: 13 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        status: 'modified' as const,
        insertions: 1,
        deletions: 0,
      })),
    };
    const html = renderClean({ turnDiff: largeDiff, isLastTurnGroup: false });
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('file-9.ts');
    expect(html).not.toContain('Show 3 more');
  });
});

describe('reviewed file-summary behavior', () => {
  it('omits zero line counts from clean cards and rows', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="clean">
        <TurnDiffSummary
          turnDiff={{
            ...twoFileTurnDiff,
            totalDeletions: 0,
            files: twoFileTurnDiff.files.map((file) => ({
              ...file,
              deletions: 0,
            })),
          }}
          isLastTurnGroup
        />
      </ChatLookProvider>,
    );
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(
      Array.from(
        host.querySelectorAll<HTMLElement>('.fg-destructive'),
        (node): string | null => node.textContent,
      ),
    ).not.toContain('-0');
  });

  it('keeps every changed file reachable by scrolling without expand controls', () => {
    const files = Array.from({ length: 400 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      status: 'modified' as const,
      insertions: 1,
      deletions: 0,
    }));
    const html = renderToStaticMarkup(
      <ChatLookProvider value="clean">
        <TurnDiffSummary
          turnDiff={{
            ...smallTurnDiff,
            files,
            totalInsertions: 400,
            totalDeletions: 0,
          }}
          isLastTurnGroup
        />
      </ChatLookProvider>,
    );
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(
      host.querySelector('[data-testid="turn-files-scroll"]'),
    ).not.toBeNull();
    expect(host.textContent).not.toContain('Show 390 more');
    expect(
      host.querySelector('button[aria-label="src/file-399.ts"]'),
    ).not.toBeNull();
  });
});

test('clean changed files honor manual collapse and collapse when the next turn starts', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = (latest: boolean): void => {
    act(() =>
      root.render(
        <ChatLookProvider value="clean">
          <TurnDiffSummary
            turnDiff={twoFileTurnDiff}
            isLastTurnGroup={latest}
          />
        </ChatLookProvider>,
      ),
    );
  };
  try {
    render(true);
    const toggle = container.querySelector('button[aria-expanded]');
    expect(toggle).not.toBeNull();
    act(() => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      container.querySelector('button[aria-label="src/view.tsx"]'),
    ).toBeNull();
    act(() => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      container.querySelector('button[aria-label="src/view.tsx"]'),
    ).not.toBeNull();
    render(false);
    expect(
      container.querySelector('button[aria-label="src/view.tsx"]'),
    ).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

test.each([1, 3])(
  'keeps an HTML output viewer and focus subscription when %s outputs grow',
  async (count) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const cleanup = jest.fn();
    jest.mocked(onTurnFileViewerClosed).mockReturnValue(cleanup);
    jest
      .mocked(showFilesInRenderer)
      .mockReset()
      .mockResolvedValue({
        opened: 1,
        failed: 0,
        files: [
          { path: '/ws/report.html', ok: true, browserId: 'existing-page' },
        ],
      });
    const names = ['report.html', 'notes.md', 'data.csv', 'last.txt'];
    const render = async (size: number): Promise<void> => {
      await act(async () => {
        root.render(
          <ChatLookProvider value="clean">
            <TurnDiffSummary
              files={names.slice(0, size).map(located)}
              fileTarget={fileTarget}
              isLastTurnGroup
            />
          </ChatLookProvider>,
        );
        await Promise.resolve();
      });
    };
    try {
      await render(count);
      const open = host.querySelector<HTMLButtonElement>(
        '[aria-label="Open report.html"]',
      );
      expect(open).toBeInstanceOf(HTMLButtonElement);
      await act(async () => {
        open?.click();
        await Promise.resolve();
      });
      await render(count + 1);
      expect(cleanup).not.toHaveBeenCalled();
      const reopened = host.querySelector<HTMLButtonElement>(
        '[aria-label="Open report.html"]',
      );
      expect(reopened).toBeInstanceOf(HTMLButtonElement);
      await act(async () => {
        reopened?.click();
        await Promise.resolve();
      });
      expect(showFilesInRenderer).toHaveBeenLastCalledWith(
        expect.anything(),
        'main',
        { reuseBrowserId: 'existing-page' },
      );
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);

test('closing a viewer from a folded summary focuses its visible disclosure', async () => {
  const host = document.createElement('div');
  const close = document.createElement('button');
  document.body.append(host, close);
  const root = createRoot(host);
  jest.mocked(onTurnFileViewerClosed).mockReset().mockReturnValue(jest.fn());
  jest.mocked(showFilesInRenderer).mockResolvedValue({
    opened: 1,
    failed: 0,
    files: [{ path: '/ws/report.html', ok: true, browserId: 'folded-page' }],
  });
  try {
    await act(async () => {
      root.render(
        <ChatLookProvider value="clean">
          <TurnDiffSummary
            files={[located('report.html'), located('notes.md')]}
            fileTarget={fileTarget}
            isLastTurnGroup
          />
        </ChatLookProvider>,
      );
      await Promise.resolve();
    });
    const open = host.querySelector<HTMLButtonElement>(
      '[aria-label="Open report.html"]',
    );
    const toggle = host.querySelector<HTMLButtonElement>('[aria-controls]');
    if (!open || !toggle) throw new Error('Missing file summary controls');
    open.focus();
    await act(async () => {
      open.click();
      await Promise.resolve();
    });
    const restore = jest.mocked(onTurnFileViewerClosed).mock.calls.at(-1)?.[2];
    if (!restore) throw new Error('Missing viewer focus subscription');
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(open.closest('[hidden]')).not.toBeNull();
    close.focus();
    act(restore);
    expect(document.activeElement).toBe(toggle);
  } finally {
    act(() => root.unmount());
    host.remove();
    close.remove();
  }
});
