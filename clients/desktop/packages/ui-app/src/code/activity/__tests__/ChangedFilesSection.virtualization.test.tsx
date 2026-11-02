/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PortalChangedFile,
  PortalChangedFiles,
} from '@canopy/protocol/portal';
import {
  ChangedFilesSection,
  type ChangedFilesSectionProps,
} from '../sections/ChangedFilesSection';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const PAGE_SIZE = 200;

function makeFiles(prefix: string, count: number): PortalChangedFile[] {
  return Array.from({ length: count }, (_, index) => ({
    filePath: `src/${prefix}-${String(index).padStart(5, '0')}.ts`,
    status: 'M',
  }));
}

function makeChangedFiles(
  uncommittedCount: number,
  committedCount = 0,
  notices: PortalChangedFiles['notices'] = [],
): PortalChangedFiles {
  return {
    worktreeLocalId: 'worktree-1',
    uncommitted: makeFiles('uncommitted', uncommittedCount),
    committed: makeFiles('committed', committedCount),
    notices,
  };
}

interface MountedSection {
  readonly container: HTMLDivElement;
  readonly root: Root;
  render(props: ChangedFilesSectionProps): void;
  unmount(): void;
}

function mountSection(
  props: ChangedFilesSectionProps,
  parent: HTMLElement = document.body,
): MountedSection {
  const container = parent.ownerDocument.createElement('div');
  parent.append(container);
  const root = createRoot(container);
  act(() => root.render(<ChangedFilesSection {...props} />));
  return {
    container,
    root,
    render(nextProps): void {
      act(() => root.render(<ChangedFilesSection {...nextProps} />));
    },
    unmount(): void {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function getList(container: HTMLElement): HTMLElement {
  const list = container.querySelector<HTMLElement>(
    '[data-testid="activity-changed-files"]',
  );
  if (!list) throw new Error('Expected the Changed files list');
  return list;
}

function getShowMore(
  container: HTMLElement,
  group: 'uncommitted' | 'committed',
): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    `[data-testid="activity-changed-files-show-more"][data-group="${group}"]`,
  );
  if (!button) throw new Error(`Expected ${group} Show more button`);
  return button;
}

interface InstalledVirtualLayout {
  setHeight(height: number): void;
  restore(): void;
}

function installVirtualLayout(
  initialHeight = 600,
  ownerDocument: Document = document,
): InstalledVirtualLayout {
  let height = initialHeight;
  const view = ownerDocument.defaultView;
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
        if (
          this.dataset['testid'] === 'activity-changed-files' ||
          this.dataset['testid'] === 'frameless-section-body'
        ) {
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
    .spyOn(view.HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement): DOMRect {
      if (
        this.dataset['testid'] === 'activity-changed-files' ||
        this.dataset['testid'] === 'frameless-section-body'
      ) {
        return DOMRect.fromRect({ x: 0, y: 0, width: 400, height });
      }
      if (this.hasAttribute('data-index')) {
        return DOMRect.fromRect({ x: 0, y: 0, width: 400, height: 24 });
      }
      if (this.classList.contains('relative')) {
        let ancestor = this.parentElement;
        while (ancestor !== null) {
          if (
            ancestor.dataset['testid'] === 'activity-changed-files' ||
            ancestor.dataset['testid'] === 'frameless-section-body'
          ) {
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

  return {
    setHeight(nextHeight): void {
      height = nextHeight;
    },
    restore(): void {
      rect.mockRestore();
      for (const property of dimensionProperties) {
        const descriptor = descriptors[property];
        if (descriptor === undefined) {
          Reflect.deleteProperty(prototype, property);
        } else {
          Object.defineProperty(prototype, property, descriptor);
        }
      }
    },
  };
}

function scrollTo(scroller: HTMLElement, scrollTop: number): void {
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    value: scrollTop,
    writable: true,
  });
  act(() => {
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
}

class TestIntersectionObserver implements IntersectionObserver {
  static readonly observers: TestIntersectionObserver[] = [];

  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly scrollMargin = '0px';
  readonly thresholds: readonly number[];
  readonly targets = new Set<Element>();
  private readonly callback: IntersectionObserverCallback;

  constructor(
    callback: IntersectionObserverCallback,
    options: IntersectionObserverInit = {},
  ) {
    this.callback = callback;
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? '0px';
    const threshold = options.threshold ?? 0;
    this.thresholds = Array.isArray(threshold) ? threshold : [threshold];
    TestIntersectionObserver.observers.push(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  intersect(isIntersecting = true): void {
    const entries = Array.from(this.targets, (target) => ({
      boundingClientRect: DOMRect.fromRect({
        x: 0,
        y: 0,
        width: 400,
        height: 24,
      }),
      intersectionRatio: isIntersecting ? 1 : 0,
      intersectionRect: isIntersecting
        ? DOMRect.fromRect({ x: 0, y: 0, width: 400, height: 24 })
        : DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 }),
      isIntersecting,
      rootBounds: null,
      target,
      time: 0,
    }));
    this.callback(entries, this);
  }
}

function installIntersectionObserver(
  ownerDocument: Document = document,
): () => void {
  TestIntersectionObserver.observers.length = 0;
  const view = ownerDocument.defaultView;
  if (view === null) throw new Error('Expected a document window');
  const previousDescriptor = Object.getOwnPropertyDescriptor(
    view,
    'IntersectionObserver',
  );
  Object.defineProperty(view, 'IntersectionObserver', {
    configurable: true,
    value: TestIntersectionObserver,
  });
  return (): void => {
    if (previousDescriptor === undefined) {
      Reflect.deleteProperty(view, 'IntersectionObserver');
    } else {
      Object.defineProperty(view, 'IntersectionObserver', previousDescriptor);
    }
  };
}

describe('ChangedFilesSection virtualization and reveal budget', () => {
  it('keeps 10,000 rows bounded in a real TanStack virtualizer window', () => {
    const restoreIntersectionObserver = installIntersectionObserver();
    const layout = installVirtualLayout();
    const mounted = mountSection({
      changedFiles: makeChangedFiles(10_000),
      onFileClick: jest.fn(),
    });
    const list = getList(mounted.container);

    try {
      scrollTo(list, 0);
      const rows = list.querySelectorAll(
        '[data-testid="activity-changed-file"]',
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(80);
      expect(list.dataset['virtualized']).toBe('true');
    } finally {
      mounted.unmount();
      layout.restore();
      restoreIntersectionObserver();
    }
  });

  it('pins a focused row and its Tab neighbor when the virtual window moves', () => {
    const restoreIntersectionObserver = installIntersectionObserver();
    const layout = installVirtualLayout();
    const mounted = mountSection({
      changedFiles: makeChangedFiles(10_000),
      onFileClick: jest.fn(),
    });
    const list = getList(mounted.container);

    try {
      const firstRow = mounted.container.querySelector<HTMLElement>(
        '[data-testid="activity-changed-file"][title="src/uncommitted-00000.ts"]',
      );
      expect(firstRow).not.toBeNull();
      if (firstRow === null) throw new Error('Expected the first file row');

      act(() => firstRow.focus());
      scrollTo(list, 4_000);

      expect(firstRow.isConnected).toBe(true);
      expect(document.activeElement).toBe(firstRow);
      const nextRow = mounted.container.querySelector<HTMLElement>(
        '[data-testid="activity-changed-file"][title="src/uncommitted-00001.ts"]',
      );
      if (nextRow === null) throw new Error('Expected the next file row');
      expect(nextRow.tabIndex).toBe(0);
      expect(
        firstRow.compareDocumentPosition(nextRow) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
      expect(
        list.querySelectorAll('[data-testid="activity-changed-file"]').length,
      ).toBeLessThanOrEqual(80);
    } finally {
      mounted.unmount();
      layout.restore();
      restoreIntersectionObserver();
    }
  });

  it('pins a focused row in a secondary document when the virtual window moves', () => {
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const ownerDocument = iframe.contentDocument;
    if (ownerDocument === null) {
      iframe.remove();
      throw new Error('Expected the iframe document');
    }
    const restoreIntersectionObserver =
      installIntersectionObserver(ownerDocument);
    const layout = installVirtualLayout(600, ownerDocument);
    const mounted = mountSection(
      {
        changedFiles: makeChangedFiles(10_000),
        onFileClick: jest.fn(),
      },
      ownerDocument.body,
    );
    const list = getList(mounted.container);

    try {
      const firstRow = mounted.container.querySelector<HTMLElement>(
        '[data-testid="activity-changed-file"][title="src/uncommitted-00000.ts"]',
      );
      if (firstRow === null) throw new Error('Expected the first file row');

      act(() => firstRow.focus());
      expect(ownerDocument.activeElement).toBe(firstRow);

      scrollTo(list, 4_000);

      expect(firstRow.isConnected).toBe(true);
      expect(ownerDocument.activeElement).toBe(firstRow);
    } finally {
      mounted.unmount();
      layout.restore();
      restoreIntersectionObserver();
      iframe.remove();
    }
  });

  it('does not scroll back to a blurred row after files are inserted above it', () => {
    const restoreIntersectionObserver = installIntersectionObserver();
    const layout = installVirtualLayout();
    const outside = document.createElement('button');
    document.body.append(outside);
    const changedFiles = makeChangedFiles(1_000);
    const mounted = mountSection({
      changedFiles,
      onFileClick: (): void => outside.focus(),
    });
    const list = getList(mounted.container);

    try {
      const row = mounted.container.querySelector<HTMLElement>(
        '[data-testid="activity-changed-file"][title="src/uncommitted-00000.ts"]',
      );
      if (row === null) throw new Error('Expected the first file row');

      act(() => row.focus());
      act(() => row.click());
      expect(document.activeElement).toBe(outside);

      scrollTo(list, 4_000);
      const beforeRefresh = list.scrollTop;
      const insertedFile: PortalChangedFile = {
        filePath: 'src/000-inserted.ts',
        status: 'A',
      };
      const scrollToCalls: number[] = [];
      Object.defineProperty(list, 'scrollTo', {
        configurable: true,
        value: (options: ScrollToOptions): void => {
          if (options.top !== undefined) scrollToCalls.push(options.top);
        },
      });

      mounted.render({
        changedFiles: {
          ...changedFiles,
          uncommitted: [insertedFile, ...changedFiles.uncommitted],
        },
        onFileClick: (): void => outside.focus(),
      });

      expect(list.scrollTop).toBe(beforeRefresh);
      expect(scrollToCalls).toEqual([]);
    } finally {
      mounted.unmount();
      outside.remove();
      layout.restore();
      restoreIntersectionObserver();
    }
  });

  it('restores focus when a focused row changes status', () => {
    const restoreIntersectionObserver = installIntersectionObserver();
    const layout = installVirtualLayout();
    const changedFiles = makeChangedFiles(10_000);
    const mounted = mountSection({
      changedFiles,
      onFileClick: jest.fn(),
    });

    try {
      const firstRow = mounted.container.querySelector<HTMLElement>(
        '[data-testid="activity-changed-file"][title="src/uncommitted-00000.ts"]',
      );
      expect(firstRow).not.toBeNull();
      if (firstRow === null) throw new Error('Expected the first file row');

      act(() => firstRow.focus());

      const firstFile = changedFiles.uncommitted[0];
      if (firstFile === undefined) throw new Error('Expected a changed file');
      const updatedUncommitted = [...changedFiles.uncommitted];
      updatedUncommitted[0] = { ...firstFile, status: 'UU' };
      mounted.render({
        changedFiles: {
          ...changedFiles,
          uncommitted: updatedUncommitted,
        },
        onFileClick: jest.fn(),
      });

      const updatedRow = mounted.container.querySelector<HTMLElement>(
        '[data-testid="activity-changed-file"][title="src/uncommitted-00000.ts"]',
      );
      expect(updatedRow).not.toBeNull();
      expect(updatedRow).not.toBe(firstRow);
      expect(document.activeElement).toBe(updatedRow);
    } finally {
      mounted.unmount();
      layout.restore();
      restoreIntersectionObserver();
    }
  });

  it('moves focus to the next revealed row when refresh removes the focused row', () => {
    const restoreIntersectionObserver = installIntersectionObserver();
    const layout = installVirtualLayout();
    const changedFiles = makeChangedFiles(10_000);
    const mounted = mountSection({
      changedFiles,
      onFileClick: jest.fn(),
    });

    try {
      const firstRow = mounted.container.querySelector<HTMLElement>(
        '[data-testid="activity-changed-file"][title="src/uncommitted-00000.ts"]',
      );
      expect(firstRow).not.toBeNull();
      if (firstRow === null) throw new Error('Expected the first file row');

      act(() => firstRow.focus());
      mounted.render({
        changedFiles: {
          ...changedFiles,
          uncommitted: changedFiles.uncommitted.slice(1),
        },
        onFileClick: jest.fn(),
      });

      const nextRow = mounted.container.querySelector<HTMLElement>(
        '[data-testid="activity-changed-file"][title="src/uncommitted-00001.ts"]',
      );
      expect(nextRow).not.toBeNull();
      expect(document.activeElement).toBe(nextRow);
    } finally {
      mounted.unmount();
      layout.restore();
      restoreIntersectionObserver();
    }
  });

  it('keeps focus on a replacement row after refresh moves it outside the virtual window', () => {
    const restoreIntersectionObserver = installIntersectionObserver();
    const layout = installVirtualLayout();
    const changedFiles = makeChangedFiles(1_000);
    const mounted = mountSection({
      changedFiles,
      onFileClick: jest.fn(),
    });
    const list = getList(mounted.container);

    try {
      scrollTo(list, 4_000);
      act(() => getShowMore(mounted.container, 'uncommitted').click());
      scrollTo(list, 9_000);
      act(() => getShowMore(mounted.container, 'uncommitted').click());
      scrollTo(list, 6_000);

      const focusedRow = mounted.container.querySelector<HTMLElement>(
        '[data-testid="activity-changed-file"][title="src/uncommitted-00250.ts"]',
      );
      if (focusedRow === null) throw new Error('Expected the focused file row');
      act(() => focusedRow.focus());
      expect(document.activeElement).toBe(focusedRow);

      const insertedFiles: PortalChangedFile[] = Array.from(
        { length: 100 },
        (_, index) => ({
          filePath: `src/aaa-${String(index).padStart(3, '0')}.ts`,
          status: 'A',
        }),
      );
      const refreshedFiles = [
        ...changedFiles.uncommitted.slice(0, 250),
        ...changedFiles.uncommitted.slice(251),
        ...insertedFiles,
      ];
      mounted.render({
        changedFiles: { ...changedFiles, uncommitted: refreshedFiles },
        onFileClick: jest.fn(),
      });

      const replacementRow = mounted.container.querySelector<HTMLElement>(
        '[data-testid="activity-changed-file"][title="src/uncommitted-00251.ts"]',
      );
      expect(replacementRow).not.toBeNull();
      expect(document.activeElement).toBe(replacementRow);
    } finally {
      mounted.unmount();
      layout.restore();
      restoreIntersectionObserver();
    }
  });

  it('keeps focus when a 101-row list shrinks below the virtualization threshold', () => {
    const changedFiles = makeChangedFiles(101);
    const mounted = mountSection({
      changedFiles,
      scrollable: false,
      onFileClick: jest.fn(),
    });

    try {
      const focusedRow = mounted.container.querySelector<HTMLElement>(
        '[data-testid="activity-changed-file"][title="src/uncommitted-00050.ts"]',
      );
      if (focusedRow === null) throw new Error('Expected the focused file row');
      act(() => focusedRow.focus());

      mounted.render({
        changedFiles: {
          ...changedFiles,
          uncommitted: changedFiles.uncommitted.slice(0, 100),
        },
        scrollable: false,
        onFileClick: jest.fn(),
      });

      const currentRow = mounted.container.querySelector<HTMLElement>(
        '[data-testid="activity-changed-file"][title="src/uncommitted-00050.ts"]',
      );
      expect(currentRow).not.toBeNull();
      expect(document.activeElement).toBe(currentRow);
    } finally {
      mounted.unmount();
    }
  });

  it('keeps focus when a 100-row list grows above the virtualization threshold', () => {
    const changedFiles = makeChangedFiles(100);
    const mounted = mountSection({
      changedFiles,
      scrollable: false,
      onFileClick: jest.fn(),
    });

    try {
      const focusedRow = mounted.container.querySelector<HTMLElement>(
        '[data-testid="activity-changed-file"][title="src/uncommitted-00050.ts"]',
      );
      if (focusedRow === null) throw new Error('Expected the focused file row');
      act(() => focusedRow.focus());

      mounted.render({
        changedFiles: {
          ...changedFiles,
          uncommitted: [
            ...changedFiles.uncommitted,
            { filePath: 'src/uncommitted-00100.ts', status: 'M' },
          ],
        },
        scrollable: false,
        onFileClick: jest.fn(),
      });

      const currentRow = mounted.container.querySelector<HTMLElement>(
        '[data-testid="activity-changed-file"][title="src/uncommitted-00050.ts"]',
      );
      expect(currentRow).not.toBeNull();
      expect(document.activeElement).toBe(currentRow);
    } finally {
      mounted.unmount();
    }
  });

  it('reveals an explicit page by click and keeps the next partial-page count', () => {
    const mounted = mountSection({
      changedFiles: makeChangedFiles(450, 1),
      scrollable: false,
    });

    try {
      expect(getList(mounted.container).dataset['virtualized']).toBeUndefined();
      expect(
        getList(mounted.container).querySelectorAll(
          '[data-testid="activity-changed-file"]',
        ),
      ).toHaveLength(201);
      const button = getShowMore(mounted.container, 'uncommitted');
      expect(button.type).toBe('button');
      expect(button.textContent).toContain('Show 200 more files');
      expect(button.getAttribute('aria-label')).toMatch(
        /^Show 200 more files.*Uncommitted/,
      );
      expect(button.dataset['total']).toBe('450');
      expect(button.textContent).toContain('250 files not shown');

      act(() => button.click());

      expect(
        mounted.container.querySelector(
          '[data-testid="activity-changed-file"][title="src/uncommitted-00250.ts"]',
        ),
      ).not.toBeNull();
      expect(
        getShowMore(mounted.container, 'uncommitted').textContent,
      ).toContain('Show 50 more files');
      expect(
        getShowMore(mounted.container, 'uncommitted').textContent,
      ).toContain('50 files not shown');

      const finalPage = getShowMore(mounted.container, 'uncommitted');
      act(() => finalPage.focus());
      act(() => {
        finalPage.dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }),
        );
        finalPage.click();
      });
      expect(
        mounted.container.querySelector(
          '[data-testid="activity-changed-file"][title="src/uncommitted-00449.ts"]',
        ),
      ).not.toBeNull();
      expect(
        mounted.container.querySelector(
          '[data-testid="activity-changed-files-show-more"][data-group="uncommitted"]',
        ),
      ).toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  it('uses formatted group totals and marks truncated totals as listed', () => {
    const complete = mountSection({
      changedFiles: makeChangedFiles(1_201, 201),
      scrollable: false,
    });
    const formattedTotal = new Intl.NumberFormat().format(1_201);

    try {
      const heading = complete.container.querySelector<HTMLElement>(
        'h4[data-total="1201"]',
      );
      expect(heading?.textContent).toContain(
        `Uncommitted · ${formattedTotal} files`,
      );
      expect(heading?.dataset['total']).toBe('1201');
    } finally {
      complete.unmount();
    }

    const incomplete = mountSection({
      changedFiles: makeChangedFiles(201, 1, [{ kind: 'truncated' }]),
      scrollable: false,
    });

    try {
      const heading = incomplete.container.querySelector<HTMLElement>(
        'h4[data-total="201"]',
      );
      expect(heading?.textContent).toContain('201 files listed');
      expect(heading?.textContent).not.toBe('Uncommitted · 201 files');
    } finally {
      incomplete.unmount();
    }
  });

  it('keeps later-page click, context-menu, and revert callbacks wired', () => {
    const onFileClick = jest.fn();
    const onFileContextMenu = jest.fn();
    const onRevertFile = jest.fn();
    const mounted = mountSection({
      changedFiles: makeChangedFiles(450),
      canRevert: true,
      onFileClick,
      onFileContextMenu,
      onRevertFile,
      scrollable: false,
    });

    try {
      act(() => getShowMore(mounted.container, 'uncommitted').click());
      const row = mounted.container.querySelector<HTMLElement>(
        '[data-testid="activity-changed-file"][title="src/uncommitted-00250.ts"]',
      );
      expect(row).not.toBeNull();
      if (!row) throw new Error('Expected a revealed file row');

      act(() => row.click());
      act(() => {
        row.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 12,
            clientY: 34,
          }),
        );
      });
      const revert = row.querySelector<HTMLButtonElement>(
        '[data-testid="activity-file-revert"]',
      );
      expect(revert).not.toBeNull();
      act(() => revert?.click());

      expect(onFileClick).toHaveBeenCalledTimes(1);
      expect(onFileContextMenu).toHaveBeenCalledTimes(1);
      expect(onRevertFile).toHaveBeenCalledTimes(1);
    } finally {
      mounted.unmount();
    }
  });

  it('moves focus from a disappearing final Show more button to the last row', () => {
    const mounted = mountSection({
      changedFiles: makeChangedFiles(PAGE_SIZE + 1),
      scrollable: false,
      onFileClick: jest.fn(),
    });

    try {
      const button = getShowMore(mounted.container, 'uncommitted');
      expect(button.textContent).toContain('Show 1 more file');
      button.focus();
      act(() => button.click());

      const lastRow = mounted.container.querySelector<HTMLElement>(
        '[data-testid="activity-changed-file"][title="src/uncommitted-00200.ts"]',
      );
      expect(lastRow).not.toBeNull();
      expect(document.activeElement).toBe(lastRow);
      expect(
        mounted.container.querySelector(
          '[data-testid="activity-changed-files-show-more"][data-group="uncommitted"]',
        ),
      ).toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  it('does not reveal from a stale intersection after the sentinel unmounts', () => {
    const restoreIntersectionObserver = installIntersectionObserver();
    const layout = installVirtualLayout(20_000);
    const mounted = mountSection({ changedFiles: makeChangedFiles(201, 401) });

    try {
      const list = getList(mounted.container);
      expect(list.dataset['virtualized']).toBe('true');
      scrollTo(list, 0);
      const observer = [...TestIntersectionObserver.observers]
        .reverse()
        .find((candidate) => candidate.targets.size > 0);
      expect(observer).toBeDefined();
      expect(getShowMore(mounted.container, 'committed').textContent).toContain(
        '201 files not shown',
      );

      act(() => observer?.intersect());
      mounted.render({ changedFiles: makeChangedFiles(201) });
      expect(observer?.targets.size).toBe(0);
      expect(
        getShowMore(mounted.container, 'uncommitted').textContent,
      ).toContain('1 file not shown');

      scrollTo(list, 1);

      const uncommittedShowMore =
        mounted.container.querySelector<HTMLButtonElement>(
          '[data-testid="activity-changed-files-show-more"][data-group="uncommitted"]',
        );
      expect(uncommittedShowMore).not.toBeNull();
      expect(uncommittedShowMore?.textContent).toContain('1 file not shown');
      expect(
        mounted.container.querySelector(
          '[data-testid="activity-changed-file"][title="src/uncommitted-00200.ts"]',
        ),
      ).toBeNull();
    } finally {
      mounted.unmount();
      layout.restore();
      restoreIntersectionObserver();
    }
  });

  it('focuses the first newly revealed row after keyboard Show more', () => {
    const restoreIntersectionObserver = installIntersectionObserver();
    const layout = installVirtualLayout();
    const mounted = mountSection({
      changedFiles: makeChangedFiles(1_000),
      onFileClick: jest.fn(),
    });

    try {
      const list = getList(mounted.container);
      expect(list.dataset['virtualized']).toBe('true');
      scrollTo(list, 4_500);

      const button = getShowMore(mounted.container, 'uncommitted');
      button.focus();
      act(() => {
        button.dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }),
        );
        button.click();
      });

      const firstRevealedRow = mounted.container.querySelector<HTMLElement>(
        '[data-testid="activity-changed-file"][title="src/uncommitted-00200.ts"]',
      );
      expect(firstRevealedRow).not.toBeNull();
      expect(firstRevealedRow?.isConnected).toBe(true);
      expect(button.isConnected).toBe(false);
      expect(document.activeElement === firstRevealedRow).toBe(true);
      expect(document.activeElement === document.body).toBe(false);
    } finally {
      mounted.unmount();
      layout.restore();
      restoreIntersectionObserver();
    }
  });

  it('keeps reveal budgets through refresh and empty data, then resets on scope change', () => {
    const firstFiles = makeChangedFiles(450);
    const mounted = mountSection({
      changedFiles: firstFiles,
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'worktree-1',
      scrollable: false,
    });

    try {
      act(() => getShowMore(mounted.container, 'uncommitted').click());
      expect(
        getShowMore(mounted.container, 'uncommitted').textContent,
      ).toContain('50 files not shown');

      mounted.render({
        changedFiles: { ...firstFiles, uncommitted: [], committed: [] },
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'worktree-1',
        scrollable: false,
      });
      mounted.render({
        changedFiles: makeChangedFiles(450),
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'worktree-1',
        scrollable: false,
      });
      expect(
        getShowMore(mounted.container, 'uncommitted').textContent,
      ).toContain('50 files not shown');

      mounted.render({
        changedFiles: makeChangedFiles(450),
        workspaceLocalId: 'workspace-2',
        worktreeLocalId: 'worktree-1',
        scrollable: false,
      });
      expect(
        getShowMore(mounted.container, 'uncommitted').textContent,
      ).toContain('250 files not shown');
      expect(
        mounted.container.querySelector(
          '[data-testid="activity-changed-file"][title="src/uncommitted-00350.ts"]',
        ),
      ).toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  it('memoizes each group sort by its array identity', () => {
    const changedFiles = makeChangedFiles(3, 3);
    const localeCompare = jest.spyOn(String.prototype, 'localeCompare');
    const mounted = mountSection({ changedFiles, scrollable: false });

    try {
      const comparisonsAfterFirstRender = localeCompare.mock.calls.length;
      expect(comparisonsAfterFirstRender).toBeGreaterThan(0);

      mounted.render({ changedFiles, scrollable: false });

      expect(localeCompare).toHaveBeenCalledTimes(comparisonsAfterFirstRender);
    } finally {
      localeCompare.mockRestore();
      mounted.unmount();
    }
  });

  it('resolves the nearest frameless scroller after it becomes scrollable', async () => {
    const restoreIntersectionObserver = installIntersectionObserver();
    const layout = installVirtualLayout();
    const outerRail = document.createElement('div');
    outerRail.dataset['testid'] = 'activity-list';
    outerRail.style.overflowY = 'auto';
    const framelessBody = document.createElement('div');
    framelessBody.dataset['testid'] = 'frameless-section-body';
    framelessBody.style.overflowY = 'hidden';
    outerRail.append(framelessBody);
    document.body.append(outerRail);
    const mounted = mountSection(
      { changedFiles: makeChangedFiles(401), scrollable: false },
      framelessBody,
    );

    try {
      const list = getList(mounted.container);
      expect(list.dataset['virtualized']).toBeUndefined();

      framelessBody.style.overflowY = 'auto';
      await act(async () => {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      });

      expect(list.dataset['virtualized']).toBe('true');
      expect(
        list.querySelectorAll('[data-testid="activity-changed-file"]').length,
      ).toBeLessThanOrEqual(80);
    } finally {
      mounted.unmount();
      outerRail.remove();
      layout.restore();
      restoreIntersectionObserver();
    }
  });

  it('auto-reveals only the last group after forward scroll and never cascades on resize', () => {
    const restoreIntersectionObserver = installIntersectionObserver();
    const layout = installVirtualLayout(20_000);
    const mounted = mountSection({
      changedFiles: makeChangedFiles(201, 401),
    });
    const list = getList(mounted.container);

    try {
      scrollTo(list, 0);
      const lastGroupObserver = TestIntersectionObserver.observers.find(
        (observer) => observer.targets.size > 0,
      );
      expect(lastGroupObserver).toBeDefined();
      expect(lastGroupObserver?.root).toBe(list);
      expect(lastGroupObserver?.rootMargin).toMatch(/\d+px 0px \d+px 0px/);

      act(() => lastGroupObserver?.intersect());
      expect(getShowMore(mounted.container, 'committed').textContent).toContain(
        '201 files not shown',
      );
      expect(
        mounted.container.querySelector(
          '[data-testid="activity-changed-files-show-more"][data-group="uncommitted"]',
        )?.textContent,
      ).toContain('1 file not shown');

      act(() => getShowMore(mounted.container, 'uncommitted').click());
      expect(
        mounted.container.querySelector(
          '[data-testid="activity-changed-files-show-more"][data-group="uncommitted"]',
        ),
      ).toBeNull();
      expect(getShowMore(mounted.container, 'committed').textContent).toContain(
        '201 files not shown',
      );

      layout.setHeight(30_000);
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });
      const resizeObserver =
        TestIntersectionObserver.observers[
          TestIntersectionObserver.observers.length - 1
        ];
      act(() => resizeObserver?.intersect());
      expect(getShowMore(mounted.container, 'committed').textContent).toContain(
        '201 files not shown',
      );

      scrollTo(list, 1);
      expect(getShowMore(mounted.container, 'committed').textContent).toContain(
        '1 file not shown',
      );
      expect(
        mounted.container.querySelector(
          '[data-testid="activity-changed-files-show-more"][data-group="uncommitted"]',
        ),
      ).toBeNull();

      layout.setHeight(40_000);
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });
      const finalResizeObserver =
        TestIntersectionObserver.observers[
          TestIntersectionObserver.observers.length - 1
        ];
      act(() => finalResizeObserver?.intersect());
      expect(getShowMore(mounted.container, 'committed').textContent).toContain(
        '1 file not shown',
      );
    } finally {
      mounted.unmount();
      layout.restore();
      restoreIntersectionObserver();
    }
  });
});
