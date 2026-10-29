/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatLookProvider } from '@canopy/ui-shared/components';
import { useChatStore } from '@/stores/chatStore';
import { TurnDiffSummary } from '../TurnDiffSummary';
import type { TurnDiffData } from '@canopy/desktop-shared/types';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
// The summary's panel helpers import the terminal stack, and xterm reads
// `document` at import time, which jsdom does not provide the way it expects.
jest.mock('@xterm/xterm', () => ({}));

jest.mock('@/stores/chatStore', () => ({
  useChatStore: jest.fn(() => undefined),
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

describe('TurnDiffSummary', () => {
  it('collapses when a large completed diff arrives after an early file', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const files = [located('report.md')];
    act(() => {
      root.render(
        <TurnDiffSummary
          files={files}
          fileTarget={fileTarget}
          isLastTurnGroup
        />,
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
        <TurnDiffSummary
          turnDiff={largeDiff}
          files={files}
          fileTarget={fileTarget}
          isLastTurnGroup
        />,
      );
    });
    expect(
      container.querySelector('[aria-expanded]')?.getAttribute('aria-expanded'),
    ).toBe('false');
    act(() => root.unmount());
  });
  it('holds the expand default while a completed turn awaits its file check', () => {
    const html = renderToStaticMarkup(
      <TurnDiffSummary
        turnDiff={smallTurnDiff}
        fileTarget={fileTarget}
        filesSettled={false}
        isLastTurnGroup
      />,
    );

    expect(html).toContain('aria-expanded="false"');
  });

  it('starts expanded for the latest small turn diff', () => {
    const html = renderToStaticMarkup(
      <TurnDiffSummary turnDiff={smallTurnDiff} isLastTurnGroup />,
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('app.ts');
  });

  it('starts collapsed for historical small turn diffs', () => {
    const html = renderToStaticMarkup(
      <TurnDiffSummary turnDiff={smallTurnDiff} isLastTurnGroup={false} />,
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('app.ts');
  });

  it('summarizes created files without a diff as openable chips', () => {
    const html = renderToStaticMarkup(
      <TurnDiffSummary
        files={[located('report.md'), located('out/page.html')]}
        fileTarget={fileTarget}
        turnId="turn"
        isLastTurnGroup
      />,
    );

    expect(html).toContain('2 files');
    expect(html).not.toContain('files changed');
    expect(html).toContain('data-turn-id="turn"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-label="Open report.md"');
    expect(html).toContain('aria-label="Open page.html"');
  });

  it('folds created files into the diff summary without repeating diffed paths', () => {
    const html = renderToStaticMarkup(
      <TurnDiffSummary
        turnDiff={smallTurnDiff}
        files={[located('src/app.ts'), located('notes/extra.md')]}
        fileTarget={fileTarget}
        isLastTurnGroup
      />,
    );

    expect(html).toContain('1 file changed');
    expect(html).toContain('1 other file');
    expect(html).toContain('aria-label="Open extra.md"');
    expect(html).not.toContain('aria-label="Open app.ts"');
    expect(html).toContain('aria-label="src/app.ts"');
  });

  it('shows in-flight creations as pending chips', () => {
    const html = renderToStaticMarkup(
      <TurnDiffSummary
        pendingFiles={[{ path: '/ws/draft.md', state: 'creating' }]}
        fileTarget={fileTarget}
        isLastTurnGroup
      />,
    );

    expect(html).toContain('1 file');
    expect(html).toContain('Creating…');
    expect(html).toContain('aria-label="Creating draft.md"');
    expect(html).toContain('aria-disabled="true"');
  });

  it('renders nothing without diffed, created or pending files', () => {
    expect(
      renderToStaticMarkup(
        <TurnDiffSummary
          turnDiff={{ ...smallTurnDiff, files: [] }}
          files={[]}
          pendingFiles={[]}
          isLastTurnGroup
        />,
      ),
    ).toBe('');
  });

  it('starts collapsed for historical created files', () => {
    const html = renderToStaticMarkup(
      <TurnDiffSummary
        files={[located('report.md')]}
        fileTarget={fileTarget}
        isLastTurnGroup={false}
      />,
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('1 file');
    expect(html).toContain('class="hidden"');
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

  it('reads as a changes card with the folder before the file name', () => {
    const html = renderClean({ turnDiff: smallTurnDiff });
    expect(html).toContain('Edited 1 file');
    expect(html).toContain(
      '>src/</span><span class="shrink-0 fg-primary">app.ts<',
    );
    expect(html).toContain('fg-success">+3<');
    expect(html).toContain('fg-destructive">-1<');
    expect(html).not.toContain('Undo');
  });

  it('offers Undo only when the turn can be reset', () => {
    expect(
      renderClean({ turnDiff: smallTurnDiff, onUndo: jest.fn() }),
    ).toContain('Undo');
  });

  it('draws Undo and View changes with the shared ghost and secondary buttons', () => {
    const state = {
      selectedWorktree: { id: 'worktree' },
      openFileTab: jest.fn(),
    };
    jest
      .mocked(useChatStore)
      .mockImplementation((selector: (s: typeof state) => unknown) =>
        selector(state),
      );
    try {
      const html = renderClean({ turnDiff: smallTurnDiff, onUndo: jest.fn() });
      expect(html).toMatch(/<button[^>]*bg-transparent fg-secondary[^>]*>Undo/);
      expect(html).toMatch(/<button[^>]*h-7 rounded-full[^>]*>View changes</);
    } finally {
      jest.mocked(useChatStore).mockImplementation(() => undefined);
    }
  });

  it('lists ten files of a long diff and offers the rest', () => {
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
    expect(html).toContain('file-9.ts');
    expect(html).not.toContain('file-10.ts');
    expect(html).toContain('Show 3 more');
  });
});
