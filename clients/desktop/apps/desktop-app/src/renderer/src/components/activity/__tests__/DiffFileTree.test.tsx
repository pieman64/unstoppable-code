/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChangedFileInfo } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { DiffFileTree } from '@/components/activity/DiffFileTree';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('DiffFileTree resizing', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.restoreAllMocks();
  });

  it('defaults to hierarchical folders and preserves source and full paths in list view', () => {
    const file = {
      path: 'src/nested/item.ts',
      status: 'modified' as const,
      insertions: 1,
      deletions: 0,
    };
    const onSelectFile = jest.fn();
    const props = {
      uncommitted: [file],
      committed: [file],
      selectedFile: file,
      selectedSource: 'committed' as const,
      onSelectFile,
      collapsed: false,
      onToggleCollapsed: jest.fn(),
      width: 256,
      clampWidth: (value: number): number => value,
      onWidthCommit: jest.fn(),
      hideHeader: true,
    };
    act(() => root.render(createElement(DiffFileTree, props)));
    expect(container.querySelectorAll('button[aria-expanded]')).toHaveLength(2);
    act(() =>
      root.render(createElement(DiffFileTree, { ...props, listView: true })),
    );
    expect(container.querySelectorAll('button[aria-expanded]')).toHaveLength(0);
    const rows = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid^="diff-file-tree-row-"]',
      ),
    );
    expect(rows).toHaveLength(2);
    expect(
      rows.every((row) => row.textContent?.includes('src/nested/item.ts')),
    ).toBe(true);
    expect(rows[1].dataset.selected).toBe('true');
    act(() => rows[1].click());
    expect(onSelectFile).toHaveBeenCalledWith(file, 'committed');
  });

  it('clamps a prop-updated pending width again when committing', () => {
    const onWidthCommit = jest.fn();
    const clampWidth = (value: number): number =>
      Math.min(560, Math.max(180, value));
    const props: Parameters<typeof DiffFileTree>[0] = {
      uncommitted: [],
      committed: [],
      selectedFile: null,
      selectedSource: null,
      onSelectFile: jest.fn(),
      collapsed: false,
      onToggleCollapsed: jest.fn(),
      width: 260,
      clampWidth,
      onWidthCommit,
    };

    act(() => {
      root.render(createElement(DiffFileTree, props));
    });
    const handle = container.querySelector('[aria-label="Resize file tree"]');
    expect(handle).not.toBeNull();

    act(() => {
      handle?.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          clientX: 260,
        }),
      );
    });

    // A parent update during the active drag replaces the pending ref with an
    // out-of-range prop. Commit must clamp this value independently of the
    // drag path before it is painted or persisted.
    act(() => {
      root.render(createElement(DiffFileTree, { ...props, width: 999 }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup'));
    });

    expect(onWidthCommit).toHaveBeenCalledWith(560);
    const fileTree = container.querySelector<HTMLElement>(
      '[data-testid="diff-file-tree"]',
    );
    expect(fileTree?.style.width).toBe('560px');
  });
});

describe('DiffFileTree status dots', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('paints identity statuses with the hue-stable file roles', () => {
    const file = (
      path: string,
      status: 'renamed' | 'copied' | 'type-changed',
    ): ChangedFileInfo => ({ path, status, insertions: 1, deletions: 0 });
    const props: Parameters<typeof DiffFileTree>[0] = {
      uncommitted: [
        file('src/renamed.ts', 'renamed'),
        file('src/copied.ts', 'copied'),
        file('src/type-changed.ts', 'type-changed'),
      ],
      committed: [],
      selectedFile: null,
      selectedSource: null,
      onSelectFile: jest.fn(),
      collapsed: false,
      onToggleCollapsed: jest.fn(),
      width: 260,
      clampWidth: (value: number): number => value,
      onWidthCommit: jest.fn(),
    };

    act(() => {
      root.render(createElement(DiffFileTree, props));
    });

    const dots = Array.from(
      container.querySelectorAll<HTMLSpanElement>('span.rounded-full'),
      (dot) => dot.className,
    );
    // Renamed and copied share the renamed role; type-changed has its own.
    // Neither is a Tailwind palette color.
    expect(dots.filter((name) => name.includes('bg-fg-info'))).toHaveLength(2);
    expect(
      dots.filter((name) => name.includes('bg-fg-special-strong')),
    ).toHaveLength(1);
    expect(dots.some((name) => /bg-(?:sky|cyan|violet)-/.test(name))).toBe(
      false,
    );
  });
});

describe('DiffFileTree session replay', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('records the expanded file tree panel in session replay', () => {
    const props: Parameters<typeof DiffFileTree>[0] = {
      uncommitted: [
        {
          path: 'src/secret.ts',
          status: 'modified',
          insertions: 1,
          deletions: 0,
        },
      ],
      committed: [],
      selectedFile: null,
      selectedSource: null,
      onSelectFile: jest.fn(),
      collapsed: false,
      onToggleCollapsed: jest.fn(),
      width: 260,
      clampWidth: (value: number): number => value,
      onWidthCommit: jest.fn(),
    };

    act(() => {
      root.render(createElement(DiffFileTree, props));
    });

    const panel = container.querySelector('[data-testid="diff-file-tree"]');
    expect(panel).toBe(container.firstElementChild);
    expect(panel?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
    expect(
      panel?.querySelector('[data-testid^="diff-file-tree-row-"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
  });

  // File names are recorded, in the collapsed root and the expanded panel
  // that reuses it.
  it('records the collapsed root, which the expanded panel reuses', () => {
    const props: Parameters<typeof DiffFileTree>[0] = {
      uncommitted: [
        {
          path: 'src/secret.ts',
          status: 'modified',
          insertions: 1,
          deletions: 0,
        },
      ],
      committed: [],
      selectedFile: null,
      selectedSource: null,
      onSelectFile: jest.fn(),
      collapsed: true,
      onToggleCollapsed: jest.fn(),
      width: 260,
      clampWidth: (value: number): number => value,
      onWidthCommit: jest.fn(),
    };

    act(() => {
      root.render(createElement(DiffFileTree, props));
    });
    const collapsedRoot = container.firstElementChild;
    expect(collapsedRoot?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(
      false,
    );

    act(() => {
      root.render(createElement(DiffFileTree, { ...props, collapsed: false }));
    });
    expect(container.firstElementChild).toBe(collapsedRoot);
  });
});
