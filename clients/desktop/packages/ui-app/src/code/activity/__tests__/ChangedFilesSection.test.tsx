/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import type {
  PortalChangedFiles,
  PortalCodeViewerSelection,
} from '@canopy/protocol/portal';
import {
  ChangedFilesSection,
  type ChangedFileRow,
} from '../sections/ChangedFilesSection';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const CHANGED: PortalChangedFiles = {
  worktreeLocalId: 'w',
  uncommitted: [{ filePath: 'src/a.ts', status: 'M' }],
  committed: [{ filePath: 'src/b.ts', status: 'A' }],
};

function installTestVirtualLayout(height = 500): () => void {
  const view = document.defaultView;
  if (view === null) throw new Error('Expected a document window');
  const prototype = view.HTMLElement.prototype;
  type DimensionProperty =
    | 'offsetHeight'
    | 'offsetWidth'
    | 'clientHeight'
    | 'clientWidth'
    | 'scrollHeight';
  const dimensionProperties: readonly DimensionProperty[] = [
    'offsetHeight',
    'offsetWidth',
    'clientHeight',
    'clientWidth',
    'scrollHeight',
  ];
  const descriptors: Record<DimensionProperty, PropertyDescriptor | undefined> =
    {
      offsetHeight: Object.getOwnPropertyDescriptor(prototype, 'offsetHeight'),
      offsetWidth: Object.getOwnPropertyDescriptor(prototype, 'offsetWidth'),
      clientHeight: Object.getOwnPropertyDescriptor(prototype, 'clientHeight'),
      clientWidth: Object.getOwnPropertyDescriptor(prototype, 'clientWidth'),
      scrollHeight: Object.getOwnPropertyDescriptor(prototype, 'scrollHeight'),
    };
  for (const property of dimensionProperties) {
    Object.defineProperty(prototype, property, {
      configurable: true,
      get: function (this: HTMLElement): number {
        if (this.hasAttribute('data-index')) {
          return property.endsWith('Width') ? 400 : 24;
        }
        if (this.dataset['testid'] === 'activity-changed-files') {
          return property === 'scrollHeight'
            ? 1_000_000
            : property.endsWith('Width')
              ? 400
              : height;
        }
        return 0;
      },
    });
  }
  const rect = jest
    .spyOn(prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement): DOMRect {
      if (this.dataset['testid'] === 'activity-changed-files') {
        return DOMRect.fromRect({ x: 0, y: 0, width: 400, height });
      }
      if (this.hasAttribute('data-index')) {
        return DOMRect.fromRect({ x: 0, y: 0, width: 400, height: 24 });
      }
      if (this.classList.contains('relative')) {
        let ancestor = this.parentElement;
        while (ancestor !== null) {
          if (ancestor.dataset['testid'] === 'activity-changed-files') {
            return DOMRect.fromRect({
              x: 0,
              y: -ancestor.scrollTop,
              width: 400,
              height: 0,
            });
          }
          ancestor = ancestor.parentElement;
        }
      }
      return DOMRect.fromRect({ x: 0, y: 0, width: 400, height: 0 });
    });
  return (): void => {
    rect.mockRestore();
    for (const property of dimensionProperties) {
      const descriptor = descriptors[property];
      if (descriptor === undefined) {
        Reflect.deleteProperty(prototype, property);
      } else {
        Object.defineProperty(prototype, property, descriptor);
      }
    }
  };
}

function scrollTo(element: HTMLElement, scrollTop: number): void {
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    value: scrollTop,
    writable: true,
  });
  act(() => {
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
}

describe('ChangedFilesSection', () => {
  it('renders an empty state with no changes', () => {
    const out = renderToString(
      <ChangedFilesSection changedFiles={undefined} />,
    );
    expect(out).toContain('data-testid="activity-changed-files-empty"');
  });

  it('renders uncommitted and committed files', () => {
    const out = renderToString(
      <ChangedFilesSection changedFiles={CHANGED} onSelectFile={() => {}} />,
    ).replace(/<!-- -->/g, '');
    expect(out).toContain('src/a.ts');
    expect(out).toContain('src/b.ts');
    expect(out).toContain('Uncommitted');
    expect(out).toContain('Committed');
    expect(out).not.toContain('Uncommitted (1)');
    expect(out).not.toContain('Committed (1)');
    // Existing container/row test IDs stay stable.
    expect(out).toContain('data-testid="activity-changed-files"');
    expect(out).toContain('data-testid="activity-changed-file"');
  });

  it('loads the next page after all local rows are revealed', () => {
    const onLoadMore = jest.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <ChangedFilesSection
          changedFiles={{
            ...CHANGED,
            page: {
              revision: 'rev-1',
              uncommitted: { total: 4, nextCursor: 'cursor-u' },
              committed: { total: 1 },
            },
          }}
          hasMore={{ uncommitted: true }}
          onLoadMore={onLoadMore}
          scrollable={false}
        />,
      );
    });

    const control = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-changed-files-show-more"][data-group="uncommitted"]',
    );
    expect(control?.getAttribute('data-load-more')).toBe('true');
    act(() => control?.click());
    expect(onLoadMore).toHaveBeenCalledWith('uncommitted');
    act(() => root.unmount());
  });

  it('moves focus from Load more to the first loaded row', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const page = {
      revision: 'rev-1',
      uncommitted: { total: 2, nextCursor: 'cursor-u' },
      committed: { total: 0 },
    };
    const render = (
      uncommitted: { filePath: string; status: string }[],
      loading: boolean,
    ): void =>
      act(() => {
        root.render(
          <ChangedFilesSection
            changedFiles={{
              worktreeLocalId: 'w',
              uncommitted,
              committed: [],
              page,
            }}
            hasMore={{ uncommitted: !loading && uncommitted.length < 2 }}
            loadingMore={{ uncommitted: loading }}
            onLoadMore={() => {}}
            onFileClick={() => {}}
            scrollable={false}
          />,
        );
      });
    const first = { filePath: 'src/a.ts', status: 'modified' };
    const loaded = { filePath: 'src/z.ts', status: 'added' };

    render([first], false);
    const control = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-changed-files-show-more"][data-load-more="true"]',
    );
    act(() => {
      control?.focus();
      control?.click();
    });
    render([first], true);
    render([first, loaded], false);

    expect(
      document.activeElement
        ?.closest('[data-testid="activity-changed-file"]')
        ?.querySelector('[title]')
        ?.getAttribute('title'),
    ).toBe('src/z.ts');
    act(() => root.unmount());
    container.remove();
  });

  it('shows quiet loading feedback while a page is in flight', () => {
    const out = renderToString(
      <ChangedFilesSection
        changedFiles={{
          ...CHANGED,
          page: {
            revision: 'rev-1',
            uncommitted: { total: 4, nextCursor: 'cursor-u' },
            committed: { total: 1 },
          },
        }}
        hasMore={{ uncommitted: true }}
        loadingMore={{ uncommitted: true }}
        onLoadMore={() => {}}
      />,
    );

    expect(out).toContain('Loading more files');
    expect(out).toContain('data-testid="activity-changed-files-show-more"');
    expect(out).toContain('data-load-more="true"');
  });

  it('shows exact page totals and keeps truncation notice while files remain incomplete', () => {
    const paged = {
      ...CHANGED,
      notices: [{ kind: 'truncated' as const }],
      page: {
        revision: 'rev-1',
        uncommitted: { total: 12, nextCursor: 'cursor-u' },
        committed: { total: 3 },
      },
    };
    const loadingMoreAvailable = renderToString(
      <ChangedFilesSection
        changedFiles={paged}
        hasMore={{ uncommitted: true }}
        onLoadMore={() => {}}
      />,
    ).replace(/<!-- -->/g, '');
    const exhausted = renderToString(
      <ChangedFilesSection
        changedFiles={{
          ...paged,
          uncommitted: Array.from({ length: 12 }, (_, index) => ({
            filePath: `src/uncommitted-${index}.ts`,
            status: 'modified',
          })),
          committed: Array.from({ length: 3 }, (_, index) => ({
            filePath: `src/committed-${index}.ts`,
            status: 'added',
          })),
          page: {
            revision: 'rev-1',
            uncommitted: { total: 12 },
            committed: { total: 3 },
          },
        }}
        hasMore={{ uncommitted: false, committed: false }}
        onLoadMore={() => {}}
      />,
    );

    expect(loadingMoreAvailable).toContain('Uncommitted · 12 files');
    expect(loadingMoreAvailable).toContain('Committed · 3 files');
    expect(loadingMoreAvailable).toContain('Not every changed file is listed.');
    expect(exhausted).not.toContain('Not every changed file is listed.');
  });

  it('keeps the truncation notice when a cursorless page is still incomplete', () => {
    const out = renderToString(
      <ChangedFilesSection
        changedFiles={{
          worktreeLocalId: 'w',
          uncommitted: [{ filePath: 'src/a.ts', status: 'modified' }],
          committed: [{ filePath: 'src/b.ts', status: 'added' }],
          notices: [{ kind: 'truncated' }],
          page: {
            revision: 'rev-1',
            uncommitted: { total: 2 },
            committed: { total: 1 },
          },
        }}
        hasMore={{ uncommitted: false, committed: false }}
        onLoadMore={() => {}}
      />,
    );

    expect(out).toContain('Not every changed file is listed.');
  });

  it('counts files still on the desktop in a paged group as not shown', () => {
    const uncommitted = Array.from({ length: 250 }, (_, index) => ({
      filePath: `src/file-${String(index).padStart(3, '0')}.ts`,
      status: 'modified',
    }));
    const out = renderToString(
      <ChangedFilesSection
        changedFiles={{
          worktreeLocalId: 'w',
          uncommitted,
          committed: [],
          page: {
            revision: 'rev-1',
            uncommitted: { total: 900, nextCursor: 'cursor-u' },
            committed: { total: 0 },
          },
        }}
        onLoadMore={() => {}}
      />,
    ).replace(/<!-- -->/g, '');

    expect(out).toContain('Show 50 more files');
    expect(out).toContain('700 files not shown');
  });

  it('keeps phase 05 local reveal behavior when no page is available', () => {
    const files = Array.from({ length: 201 }, (_, index) => ({
      filePath: `src/file-${String(index).padStart(3, '0')}.ts`,
      status: 'modified',
    }));
    const out = renderToString(
      <ChangedFilesSection
        changedFiles={{ ...CHANGED, uncommitted: files, committed: [] }}
      />,
    );

    expect(out).toContain('Show 1 more file');
    expect(out).not.toContain('data-load-more="true"');
  });

  it('auto-reveals the last group by requesting a page when local rows are exhausted', () => {
    const originalObserver = window.IntersectionObserver;
    const restoreVirtualLayout = installTestVirtualLayout(20_000);
    let observeCallback: IntersectionObserverCallback | undefined;
    class TestIntersectionObserver implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = '';
      readonly scrollMargin = '';
      readonly thresholds = [0];

      constructor(callback: IntersectionObserverCallback) {
        observeCallback = callback;
      }

      disconnect(): void {}
      observe(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      unobserve(): void {}
    }
    window.IntersectionObserver = TestIntersectionObserver;
    const onLoadMore = jest.fn();
    const files = Array.from({ length: 101 }, (_, index) => ({
      filePath: `src/file-${String(index).padStart(3, '0')}.ts`,
      status: 'modified',
    }));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <ChangedFilesSection
          changedFiles={{
            worktreeLocalId: 'w',
            uncommitted: files,
            committed: [],
            page: {
              revision: 'rev-1',
              uncommitted: { total: 201, nextCursor: 'cursor-u' },
              committed: { total: 0 },
            },
          }}
          hasMore={{ uncommitted: true }}
          onLoadMore={onLoadMore}
        />,
      );
    });

    const scrollElement = container.querySelector<HTMLElement>(
      '[data-testid="activity-changed-files"]',
    );
    if (scrollElement) {
      scrollTo(scrollElement, 1);
    }
    const autoRevealControl = container.querySelector<HTMLElement>(
      '[data-testid="activity-changed-files-show-more"]',
    );
    if (autoRevealControl && scrollElement && observeCallback) {
      act(() => {
        observeCallback?.(
          [
            {
              target: autoRevealControl,
              isIntersecting: true,
              intersectionRatio: 1,
              boundingClientRect: autoRevealControl.getBoundingClientRect(),
              intersectionRect: autoRevealControl.getBoundingClientRect(),
              rootBounds: scrollElement.getBoundingClientRect(),
              time: 0,
            },
          ],
          {} as IntersectionObserver,
        );
      });
    }

    expect(onLoadMore).toHaveBeenCalledWith('uncommitted');
    act(() => root.unmount());
    container.remove();
    window.IntersectionObserver = originalObserver;
    restoreVirtualLayout();
  });

  it('positions the overlay scrollbar close to the card edge', () => {
    const out = renderToString(
      <ChangedFilesSection changedFiles={CHANGED} scrollable />,
    );
    const container = document.createElement('div');
    container.innerHTML = out;
    const scrollbar = container.querySelector('[data-overlay-scrollbar]');

    expect(scrollbar).not.toBeNull();
    expect(Array.from(scrollbar?.classList ?? [])).toEqual(
      expect.arrayContaining(['absolute', 'inset-y-0', 'z-10', '-right-1']),
    );
  });

  it('keeps single-repo markup byte-identical when repo identity is present', () => {
    const legacy = renderToString(
      <ChangedFilesSection changedFiles={CHANGED} onSelectFile={() => {}} />,
    );
    const withRepoIdentity = renderToString(
      <ChangedFilesSection
        changedFiles={{
          ...CHANGED,
          uncommitted: CHANGED.uncommitted.map((file) => ({
            ...file,
            repoId: 'only-repo',
            repoName: 'Only Repo',
          })),
          committed: CHANGED.committed.map((file) => ({
            ...file,
            repoId: 'only-repo',
            repoName: 'Only Repo',
          })),
        }}
        onSelectFile={() => {}}
      />,
    );

    expect(withRepoIdentity).toBe(legacy);
  });

  it('renders wire-format word statuses with their correct tone classes', () => {
    const out = renderToString(
      <ChangedFilesSection
        changedFiles={{
          worktreeLocalId: 'w',
          uncommitted: [
            {
              filePath: 'src/modified.ts',
              status: 'modified',
              staged: true,
              insertions: 3,
              deletions: 1,
            },
            { filePath: 'src/deleted.ts', status: 'deleted' },
            { filePath: 'src/renamed.ts', status: 'renamed' },
            { filePath: 'src/untracked.ts', status: 'untracked' },
          ],
          committed: [{ filePath: 'src/added.ts', status: 'added' }],
        }}
      />,
    );

    expect(out).toContain('bg-warning');
    expect(out).not.toContain('bg-amber-400');
    expect(out).toContain('bg-destructive');
    // Renamed is an identity, not a state: it takes the info ink, the same
    // as copied.
    expect(out).toMatch(/class="[^"]*\bbg-fg-info\b[^"]*" title="Renamed"/);
    expect(out).not.toContain('bg-sky-400');
    expect(out).toContain('bg-success');
    // A new file reads as new whether or not git tracks it yet: untracked
    // shares the added green, and the dot's title still says Untracked.
    expect(out).toMatch(/class="[^"]*\bbg-success\b[^"]*" title="Untracked"/);
    expect(out).not.toContain('bg-lime-400');
    expect(out).not.toContain('bg-fg-primary/40');
  });

  it('shows only non-zero line counts', () => {
    const out = renderToString(
      <ChangedFilesSection
        changedFiles={{
          worktreeLocalId: 'w',
          uncommitted: [
            {
              filePath: 'src/added-lines.ts',
              status: 'modified',
              insertions: 4,
              deletions: 0,
            },
            {
              filePath: 'src/removed-lines.ts',
              status: 'modified',
              insertions: 0,
              deletions: 2,
            },
            // A new symlink has no line changes at all.
            {
              filePath: 'link',
              status: 'added',
              insertions: 0,
              deletions: 0,
            },
          ],
          committed: [],
        }}
      />,
    );

    const text = out.replaceAll('<!-- -->', '');
    expect(text).toContain('>+4<');
    expect(text).toContain('>-2<');
    expect(text).not.toContain('>+0<');
    expect(text).not.toContain('>-0<');
  });

  it('splits the path into a muted directory prefix and a foreground filename', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <ChangedFilesSection
          changedFiles={{
            worktreeLocalId: 'w',
            uncommitted: [{ filePath: 'src/deep/file.ts', status: 'M' }],
            committed: [],
          }}
          openDataTestId="portal-changed-file-open"
        />,
      );
    });
    const open = container.querySelector<HTMLElement>(
      '[data-testid="portal-changed-file-open"]',
    );
    const spans = open?.querySelectorAll('span');
    // First span is the muted directory prefix (with trailing slash), the
    // second is the emphasized filename.
    expect(spans?.[0]?.textContent).toBe('src/deep/');
    expect(spans?.[0]?.className).toContain('fg-secondary');
    expect(spans?.[1]?.textContent).toBe('file.ts');
    expect(spans?.[1]?.className).toContain('fg-primary/80');
    act(() => root.unmount());
  });

  it('sorts by path and emits a source-aware diff selection on row click', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const selections: PortalCodeViewerSelection[] = [];
    act(() => {
      root.render(
        <ChangedFilesSection
          changedFiles={{
            ...CHANGED,
            uncommitted: [
              { filePath: 'z.ts', status: 'M' },
              { filePath: 'a.ts', status: 'M', repoId: 'repo-a' },
            ],
          }}
          workspaceLocalId="ws"
          worktreeLocalId="wt"
          onSelectFile={(selection): void => {
            selections.push(selection);
          }}
        />,
      );
    });
    const rows = container.querySelectorAll<HTMLElement>(
      '[data-testid="activity-changed-file"]',
    );
    // Sorted: a.ts before z.ts.
    expect(rows[0]?.textContent).toBe('a.ts');
    // Selectable rows are keyboard-operable.
    expect(rows[0]?.getAttribute('role')).toBe('button');
    expect(rows[0]?.getAttribute('tabindex')).toBe('0');
    act(() => rows[0]?.click());
    expect(selections).toEqual([
      {
        kind: 'diff',
        title: 'a.ts',
        request: {
          workspaceId: 'ws',
          worktreeId: 'wt',
          path: 'a.ts',
          source: 'uncommitted',
          repoId: 'repo-a',
        },
      },
    ]);
    act(() => root.unmount());
  });

  it('selects a file via Enter and Space keyboard activation', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onSelectFile = jest.fn<void, [PortalCodeViewerSelection]>();
    act(() => {
      root.render(
        <ChangedFilesSection
          changedFiles={{
            worktreeLocalId: 'w',
            uncommitted: [{ filePath: 'a.ts', status: 'M' }],
            committed: [],
          }}
          workspaceLocalId="ws"
          worktreeLocalId="wt"
          onSelectFile={onSelectFile}
        />,
      );
    });
    const row = container.querySelector<HTMLElement>(
      '[data-testid="activity-changed-file"]',
    );
    act(() => {
      row?.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    act(() => {
      row?.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: ' ', bubbles: true }),
      );
    });
    expect(onSelectFile).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
  });

  it('reports a file row right click without selecting it', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onFileClick = jest.fn<void, [ChangedFileRow]>();
    const onFileContextMenu = jest.fn<
      void,
      [ChangedFileRow, { clientX: number; clientY: number }]
    >();
    act(() => {
      root.render(
        <ChangedFilesSection
          changedFiles={{
            worktreeLocalId: 'w',
            uncommitted: [
              { filePath: 'src/right-click.ts', status: 'M', repoId: 'repo-a' },
            ],
            committed: [],
          }}
          onFileClick={onFileClick}
          onFileContextMenu={onFileContextMenu}
        />,
      );
    });
    const row = container.querySelector<HTMLElement>(
      '[data-testid="activity-changed-file"]',
    );
    act(() => {
      row?.dispatchEvent(
        new window.MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 123,
          clientY: 234,
        }),
      );
    });
    expect(onFileContextMenu).toHaveBeenCalledWith(
      {
        filePath: 'src/right-click.ts',
        status: 'M',
        repoId: 'repo-a',
        source: 'uncommitted',
      },
      { clientX: 123, clientY: 234 },
    );
    expect(onFileClick).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('shows Revert only when the host can revert and a handler is injected', () => {
    const withRevert = renderToString(
      <ChangedFilesSection
        changedFiles={CHANGED}
        canRevert
        onRevertFile={() => {}}
      />,
    );
    expect(withRevert).toContain('data-testid="activity-file-revert"');

    const readOnly = renderToString(
      <ChangedFilesSection
        changedFiles={CHANGED}
        canRevert={false}
        onRevertFile={() => {}}
      />,
    );
    expect(readOnly).not.toContain('data-testid="activity-file-revert"');
  });

  it('reverts without selecting the file (callback isolation)', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onSelectFile = jest.fn<void, [PortalCodeViewerSelection]>();
    const onRevertFile = jest.fn<void, [ChangedFileRow]>();
    act(() => {
      root.render(
        <ChangedFilesSection
          changedFiles={{
            worktreeLocalId: 'w',
            uncommitted: [{ filePath: 'a.ts', status: 'M' }],
            committed: [],
          }}
          workspaceLocalId="ws"
          worktreeLocalId="wt"
          canRevert
          onSelectFile={onSelectFile}
          onRevertFile={onRevertFile}
        />,
      );
    });
    const revert = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-file-revert"]',
    );
    act(() => revert?.click());
    expect(onRevertFile).toHaveBeenCalledWith({
      filePath: 'a.ts',
      status: 'M',
      source: 'uncommitted',
    });
    // Reverting must not bubble into the row's diff selection.
    expect(onSelectFile).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('records the scrollable list in session replay', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToString(
      <ChangedFilesSection changedFiles={CHANGED} scrollable />,
    );
    const root = container.firstElementChild;

    expect(root?.hasAttribute('data-overlay-scroll-area')).toBe(true);
    expect(container.querySelector(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
    expect(Array.from(root?.classList ?? [])).toEqual([
      'flex',
      'min-h-0',
      'flex-col',
      '-mb-3',
      '-mt-3',
      'max-h-70',
    ]);
  });

  it('records the non-scrollable list in session replay', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToString(
      <ChangedFilesSection changedFiles={CHANGED} scrollable={false} />,
    );
    const root = container.firstElementChild;

    expect(root?.getAttribute('data-testid')).toBe('activity-changed-files');
    expect(Array.from(root?.classList ?? [])).toEqual(['space-y-2']);
    expect(container.querySelector(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
  });

  it('allows desktop to suppress the portal empty state', () => {
    const out = renderToString(
      <ChangedFilesSection changedFiles={undefined} emptyState={null} />,
    );
    expect(out).toBe('');
    expect(out).not.toContain('activity-changed-files-empty');
  });

  it('matches native headings and rail scroll chrome', () => {
    const uncommittedOnly = renderToString(
      <ChangedFilesSection
        changedFiles={{ ...CHANGED, committed: [] }}
        emptyState={null}
      />,
    );
    expect(uncommittedOnly).not.toContain('Uncommitted');
    expect(uncommittedOnly).toContain('max-h-70');
    expect(uncommittedOnly).toContain('-mt-3');
    expect(uncommittedOnly).toContain('-mb-3');
    expect(uncommittedOnly).toContain('space-y-2 py-3');

    const committedOnly = renderToString(
      <ChangedFilesSection
        changedFiles={{ ...CHANGED, uncommitted: [] }}
        emptyState={null}
        scrollable={false}
      />,
    );
    expect(committedOnly).toContain('Committed');
    expect(committedOnly).not.toContain('max-h-70');
  });

  it('does not select a file when either request id is missing', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onSelectFile = jest.fn<void, [PortalCodeViewerSelection]>();
    act(() => {
      root.render(
        <ChangedFilesSection
          changedFiles={CHANGED}
          workspaceLocalId="ws"
          onSelectFile={onSelectFile}
        />,
      );
    });

    const row = container.querySelector<HTMLElement>(
      '[data-testid="activity-changed-file"]',
    );
    // Non-selectable rows are neither clickable nor keyboard-operable.
    expect(row?.getAttribute('role')).toBeNull();
    expect(row?.getAttribute('tabindex')).toBeNull();
    act(() => row?.click());
    expect(onSelectFile).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});

describe('ChangedFilesSection bounded answers (REG-3024)', () => {
  const render = (
    changedFiles: PortalChangedFiles,
    showRepoName = false,
  ): string =>
    renderToString(
      <ChangedFilesSection
        changedFiles={changedFiles}
        showRepoName={showRepoName}
      />,
    ).replace(/<!-- -->/g, '');

  it('renders no notice when the producer reports none', () => {
    expect(render(CHANGED)).not.toContain('activity-changed-files-notice');
  });

  it.each([
    ['truncated', 'Not every changed file is listed.'],
    [
      'base_unavailable',
      'The base branch isn&#x27;t available, so committed changes can&#x27;t be compared.',
    ],
    ['unavailable', 'Changes aren&#x27;t available right now.'],
    ['sleeping', 'Project is sleeping. Changes load when it wakes.'],
  ] as const)('explains a %s answer above the lists', (kind, copy) => {
    const out = render({ ...CHANGED, notices: [{ kind }] });
    expect(out).toContain('data-testid="activity-changed-files-notice"');
    // The shared inline Notice (DESIGN.md), not a bare line.
    expect(out).toContain('data-notice-intent="neutral"');
    expect(out).toContain(copy);
    expect(out).toContain('src/a.ts');
  });

  it('shows the notice instead of "No changed files." when nothing loaded', () => {
    const out = render({
      worktreeLocalId: 'w',
      uncommitted: [],
      committed: [],
      notices: [{ kind: 'sleeping' }],
    });
    expect(out).toContain('Project is sleeping. Changes load when it wakes.');
    expect(out).not.toContain('activity-changed-files-empty');
  });

  it('names the repository when several are shown', () => {
    const out = render(
      {
        ...CHANGED,
        notices: [{ kind: 'base_unavailable', repoId: 'r2', repoName: 'web' }],
      },
      true,
    );
    expect(out).toContain('web: The base branch');
  });

  it('labels a binary file in place of line counts', () => {
    const out = render({
      worktreeLocalId: 'w',
      uncommitted: [{ filePath: 'logo.png', status: 'added', binary: true }],
      committed: [],
    });
    expect(out).toContain('Binary');
  });

  it('keeps one row per repository for the same path', () => {
    const out = render(
      {
        worktreeLocalId: 'w',
        uncommitted: [
          {
            filePath: 'README.md',
            status: 'modified',
            repoId: 'r1',
            repoName: 'api',
          },
          {
            filePath: 'README.md',
            status: 'modified',
            repoId: 'r2',
            repoName: 'web',
          },
        ],
        committed: [],
      },
      true,
    );
    expect(out.match(/data-testid="activity-changed-file"/g)).toHaveLength(2);
    expect(out).toContain('api/');
    expect(out).toContain('web/');
  });
});
