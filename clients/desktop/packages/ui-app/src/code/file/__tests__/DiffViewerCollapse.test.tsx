/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DiffViewerSession, FileViewerState } from '@canopy/app-state';
import type { PortalDiffReadPayload } from '@canopy/protocol/portal';

let mockState: FileViewerState;
// Per-target capabilities the viewer gates on (REG-3024); empty = defaults.
const mockCapabilities: { readonly wholeWorktreeDiff?: boolean } = {};
jest.mock('@canopy/app-state', () => {
  const real: Record<string, unknown> = jest.requireActual('@canopy/app-state');
  return {
    __esModule: true,
    ...real,
    useFileViewerStore: <T,>(selector: (state: FileViewerState) => T): T =>
      selector(mockState),
    useWorkspaceCapabilities: (): { readonly wholeWorktreeDiff?: boolean } =>
      mockCapabilities,
  };
});

import { diffViewerKey } from '@canopy/app-state';
import { DiffViewer } from '../DiffViewer';

const REQUEST: PortalDiffReadPayload = {
  workspaceId: 'w1',
  worktreeId: 'wt1',
  source: 'combined',
};

function baseState(diff: DiffViewerSession | undefined): FileViewerState {
  const key = diffViewerKey(REQUEST);
  return {
    files: {},
    diffs: diff ? { [key]: diff } : {},
    activeFileKey: null,
    activeDiffKey: diff ? key : null,
    canEdit: true,
    openFile: (): Promise<string> => Promise.resolve(''),
    updateContent: (): void => {},
    saveFile: (): Promise<boolean> => Promise.resolve(true),
    discardEdits: (): void => {},
    setViewMode: (): void => {},
    closeFile: (): void => {},
    openDiff: (): Promise<string> => Promise.resolve(key),
    closeDiff: (): void => {},
  };
}

const PATCH = ['@@ -1 +1 @@', '-old', '+new'].join('\n');

function loadedDiff(): DiffViewerSession {
  return {
    key: diffViewerKey(REQUEST),
    request: REQUEST,
    diff: {
      workspaceLocalId: 'w1',
      worktreeLocalId: 'wt1',
      files: [
        { filePath: 'src/a.ts', status: 'M', insertions: 1, deletions: 1 },
        { filePath: 'src/b.ts', status: 'A' },
      ],
      patch: PATCH,
      rangeLabel: 'abc..WORKTREE',
    },
    status: 'idle',
    error: null,
  };
}

/** A diff spanning several directories, so grouping yields multiple groups. */
function multiDirectoryDiff(): DiffViewerSession {
  return {
    key: diffViewerKey(REQUEST),
    request: REQUEST,
    diff: {
      workspaceLocalId: 'w1',
      worktreeLocalId: 'wt1',
      files: [
        { filePath: 'src/a.ts', status: 'M', insertions: 1, deletions: 1 },
        { filePath: 'src/b.ts', status: 'A' },
        { filePath: 'docs/readme.md', status: 'M' },
        { filePath: 'test/c.spec.ts', status: 'A' },
        { filePath: 'root.ts', status: 'M' },
      ],
      patch: PATCH,
      rangeLabel: 'abc..WORKTREE',
    },
    status: 'idle',
    error: null,
  };
}

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

/**
 * Build a real `MediaQueryList` without a type assertion: an `EventTarget`
 * supplies the listener plumbing, and `Object.assign` adds the query-specific
 * members, so the result satisfies the interface structurally.
 */
function mediaQueryList(query: string, matches: boolean): MediaQueryList {
  return Object.assign(new EventTarget(), {
    matches,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
  });
}

function setViewportMobile(isMobile: boolean): void {
  window.matchMedia = jest
    .fn()
    .mockImplementation(
      (query: string): MediaQueryList =>
        mediaQueryList(query, query === '(max-width: 1023px)' && isMobile),
    );
}

describe('DiffViewer directory grouping (CAN-2517)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setViewportMobile(false);
    mockState = baseState(loadedDiff());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.restoreAllMocks();
  });

  it('heads each group with its directory instead of repeating full paths', () => {
    // Both fixture files live in `src/`, so the directory becomes a heading and
    // the rows no longer each carry the prefix.
    act(() => {
      root.render(<DiffViewer request={REQUEST} />);
    });

    // Directory becomes the heading; rows drop the redundant prefix.
    expect(container.textContent).toContain('src');
    expect(container.textContent).toContain('a.ts');
    expect(container.textContent).toContain('b.ts');
    expect(container.textContent).not.toContain('src/a.ts');
    expect(container.textContent).not.toContain('src/b.ts');
  });

  it('orders root-level files before directories, then directories A to Z', () => {
    mockState = baseState({
      ...loadedDiff(),
      diff: {
        workspaceLocalId: 'w1',
        worktreeLocalId: 'wt1',
        files: [
          { filePath: 'zeta/z.ts', status: 'M' },
          { filePath: 'README.md', status: 'M' },
          { filePath: 'alpha/a.ts', status: 'M' },
        ],
        patch: '',
        rangeLabel: 'abc..WORKTREE',
      },
    });

    act(() => {
      root.render(<DiffViewer request={REQUEST} />);
    });

    const text = container.textContent ?? '';
    // Root files sit under the range heading, which must come first.
    expect(text.indexOf('abc..WORKTREE')).toBeLessThan(text.indexOf('alpha'));
    expect(text.indexOf('alpha')).toBeLessThan(text.indexOf('zeta'));
  });
});

describe('DiffViewer collapsible file list (CAN-2516)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockState = baseState(loadedDiff());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.restoreAllMocks();
  });

  function render(): void {
    act(() => {
      root.render(<DiffViewer request={REQUEST} />);
    });
  }

  const collapseBtn = (): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>(
      '[data-testid="diff-viewer-files-collapse"]',
    );
  const expandBtn = (): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>(
      '[data-testid="diff-viewer-files-expand"]',
    );

  // Fails the test loudly if the control is absent, rather than throwing an
  // opaque TypeError on a null .click().
  function clickButton(button: HTMLButtonElement | null): void {
    if (!button) throw new Error('expected the button to be rendered');
    button.click();
  }

  it('shows the file list expanded on desktop, with a control to hide it', () => {
    setViewportMobile(false);
    render();

    expect(collapseBtn()).not.toBeNull();
    expect(expandBtn()).toBeNull();
    expect(container.textContent).toContain('a.ts');
  });

  it('starts collapsed on a narrow viewport so the diff is readable', () => {
    // Tommy's report: a fixed 256px file list left almost nothing for the diff
    // on mobile, and there was no way to fold it away.
    setViewportMobile(true);
    render();

    expect(expandBtn()).not.toBeNull();
    expect(collapseBtn()).toBeNull();
    expect(container.textContent).not.toContain('a.ts');
  });

  it('keeps the file count visible while collapsed', () => {
    setViewportMobile(true);
    render();

    expect(container.textContent).toContain('2');
  });

  it('names the expand control with the file count for screen readers', () => {
    // The visible count node is aria-hidden, so without this the count is
    // unavailable to assistive tech even though the rail exists to preserve it.
    setViewportMobile(true);
    render();

    expect(expandBtn()?.getAttribute('aria-label')).toBe(
      'Show 2 changed files',
    );
  });

  it('keeps an explicit expand when the viewport later reports mobile', () => {
    // `collapseOverride ?? isMobile`: once the user chooses, the viewport
    // default must not win back. Without re-rendering under a changed query
    // these paths look identical.
    setViewportMobile(true);
    render();
    act(() => {
      clickButton(expandBtn());
    });
    expect(collapseBtn()).not.toBeNull();

    setViewportMobile(true);
    render();

    expect(collapseBtn()).not.toBeNull();
    expect(expandBtn()).toBeNull();
  });

  it('keeps an explicit collapse when the viewport later reports desktop', () => {
    setViewportMobile(false);
    render();
    act(() => {
      clickButton(collapseBtn());
    });
    expect(expandBtn()).not.toBeNull();

    setViewportMobile(false);
    render();

    expect(expandBtn()).not.toBeNull();
    expect(collapseBtn()).toBeNull();
  });

  it('counts files across every directory group, not just the first', () => {
    // Directory grouping splits the diff into one group per directory. The
    // count was read from `groups[0]` alone, so a diff spanning several
    // directories under-reported in the rail and the "Files (N)" header --
    // here it would have shown the first group's size instead of 5.
    mockState = baseState(multiDirectoryDiff());
    setViewportMobile(true);
    render();

    expect(expandBtn()?.getAttribute('aria-label')).toBe(
      'Show 5 changed files',
    );
  });

  it("keeps the full path as each row's accessible name", () => {
    // Grouped rows show only the base name, so two directories holding the
    // same filename would otherwise be indistinguishable to assistive tech.
    mockState = baseState(multiDirectoryDiff());
    setViewportMobile(false);
    render();

    const labels = Array.from(
      container.querySelectorAll('[data-testid="diff-file-tree-row"]'),
    ).map((row) => row.getAttribute('aria-label'));
    expect(labels).toContain('src/a.ts');
    expect(labels).toContain('docs/readme.md');
  });

  it('expands on demand from the collapsed rail', () => {
    setViewportMobile(true);
    render();

    act(() => {
      clickButton(expandBtn());
    });

    expect(container.textContent).toContain('a.ts');
    expect(collapseBtn()).not.toBeNull();
  });

  it('collapses on demand from the expanded list', () => {
    setViewportMobile(false);
    render();

    act(() => {
      clickButton(collapseBtn());
    });

    expect(container.textContent).not.toContain('a.ts');
    expect(expandBtn()).not.toBeNull();
  });
});

describe('DiffViewer incomplete file list on a narrow viewport (REG-3024)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    const loaded = loadedDiff();
    mockState = baseState({
      ...loaded,
      diff: loaded.diff === null ? null : { ...loaded.diff, truncated: true },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.restoreAllMocks();
  });

  it('keeps the cut-list notice visible while the file list is collapsed', () => {
    setViewportMobile(true);
    act(() => {
      root.render(<DiffViewer request={REQUEST} />);
    });

    expect(
      container.querySelector('[data-testid="diff-viewer-files-expand"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="diff-viewer-notice-truncated"]')
        ?.textContent,
    ).toContain('Not every changed file is listed.');
  });

  it('does not name a collapsed cut list as a complete count', () => {
    setViewportMobile(true);
    act(() => {
      root.render(<DiffViewer request={REQUEST} />);
    });

    const expand = container.querySelector(
      '[data-testid="diff-viewer-files-expand"]',
    );
    expect(expand?.getAttribute('aria-label')).toBe(
      'Show 2+ changed files. Not every changed file is listed.',
    );
    expect(expand?.parentElement?.textContent).toContain('2+');
  });
});

describe('DiffViewer single-file request and layout toggle', () => {
  let container: HTMLDivElement;
  let root: Root;
  const FILE_REQUEST: PortalDiffReadPayload = { ...REQUEST, path: 'src/a.ts' };

  beforeEach(() => {
    setViewportMobile(false);
    const loaded = loadedDiff();
    mockState = {
      ...baseState(loaded),
      diffs: {
        [diffViewerKey(FILE_REQUEST)]: { ...loaded, request: FILE_REQUEST },
      },
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.restoreAllMocks();
  });

  it('starts with the file list collapsed for a single-file request', () => {
    // Desktop opens one file's diff with no list beside it.
    act(() => {
      root.render(<DiffViewer request={FILE_REQUEST} />);
    });

    const expand = container.querySelector<HTMLButtonElement>(
      '[data-testid="diff-viewer-files-expand"]',
    );
    expect(expand).not.toBeNull();
    act(() => {
      expand?.click();
    });
    expect(
      container.querySelector('[data-testid="diff-viewer-files-collapse"]'),
    ).not.toBeNull();
  });

  it('switches the patch to split view from the layout toggle', () => {
    act(() => {
      root.render(<DiffViewer request={FILE_REQUEST} />);
    });
    const diff = (): Element | null =>
      container.querySelector('[data-testid="file-unified-diff"]');
    expect(diff()?.getAttribute('data-diff-view-mode')).toBe('unified');

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="diff-viewer-layout-split"]',
        )
        ?.click();
    });

    expect(diff()?.getAttribute('data-diff-view-mode')).toBe('split');
    expect(diff()?.querySelector('[data-diff-row="change"]')).not.toBeNull();
  });
});
