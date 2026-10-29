/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react';
import type * as ReactNamespace from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  FileViewerPanelHost,
  type FileViewerTabDescriptor,
} from '../FileViewerPanelHost';
import { DesktopSharedFileViewer } from '../DesktopSharedFileViewer';

// Isolate host behavior from the real viewer: render a stub that exposes the
// props it received (notably `onPreserveMountedChange`) and a stable test id.
jest.mock('../DesktopSharedFileViewer', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    DesktopSharedFileViewer: jest.fn((props: { tabId: string }): unknown =>
      react.createElement('div', {
        'data-testid': `mock-file-viewer-${props.tabId}`,
      }),
    ),
  };
});

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const mockPanel = jest.mocked(DesktopSharedFileViewer);

function tab(id: string): FileViewerTabDescriptor {
  return {
    id,
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    filePath: `/tmp/${id}.html`,
  };
}

interface RenderedHost {
  container: HTMLDivElement;
  rerender: (
    fileTabs: FileViewerTabDescriptor[],
    activeFileTab: FileViewerTabDescriptor | null,
  ) => void;
  unmount: () => void;
}

function renderHost(
  fileTabs: FileViewerTabDescriptor[],
  activeFileTab: FileViewerTabDescriptor | null,
): RenderedHost {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const rerender = (
    nextTabs: FileViewerTabDescriptor[],
    nextActive: FileViewerTabDescriptor | null,
  ): void => {
    act(() => {
      root.render(
        createElement(FileViewerPanelHost, {
          fileTabs: nextTabs,
          activeFileTab: nextActive,
        }),
      );
    });
  };
  rerender(fileTabs, activeFileTab);
  return {
    container,
    rerender,
    unmount: (): void => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Most recent props the mocked panel received for a given tab id. */
function latestPropsFor(tabId: string): {
  onPreserveMountedChange?: (id: string, preserve: boolean) => void;
  recheckAfterWorktreeSetup?: boolean;
} {
  for (let i = mockPanel.mock.calls.length - 1; i >= 0; i -= 1) {
    const props = mockPanel.mock.calls[i][0];
    if (props.tabId === tabId) return props;
  }
  throw new Error(`No FileViewerPanel render captured for tab "${tabId}"`);
}

function wrapperFor(container: HTMLElement, tabId: string): HTMLElement | null {
  const panel = container.querySelector(
    `[data-testid="mock-file-viewer-${tabId}"]`,
  );
  const wrapper = panel?.parentElement ?? null;
  return wrapper instanceof HTMLElement ? wrapper : null;
}

beforeEach(() => {
  mockPanel.mockClear();
});

describe('FileViewerPanelHost', () => {
  it('forwards the Branch-from setup recheck marker', () => {
    const t1 = { ...tab('t1'), recheckAfterWorktreeSetup: true };
    const host = renderHost([t1], t1);

    expect(latestPropsFor('t1').recheckAfterWorktreeSetup).toBe(true);
    host.unmount();
  });

  it('keeps a preserved HTML preview mounted but hidden while inactive', () => {
    const t1 = tab('t1');
    const host = renderHost([t1], t1);

    expect(wrapperFor(host.container, 't1')).not.toBeNull();

    // The viewer asks to be preserved (it is an HTML preview).
    act(() => {
      latestPropsFor('t1').onPreserveMountedChange?.('t1', true);
    });

    // Switch away: the panel stays mounted but its wrapper is hidden.
    host.rerender([t1], null);
    const hiddenWrapper = wrapperFor(host.container, 't1');
    expect(hiddenWrapper).not.toBeNull();
    expect(hiddenWrapper?.className).toBe('hidden');
    expect(hiddenWrapper?.getAttribute('aria-hidden')).toBe('true');

    // Switch back: same keyed panel, now visible.
    host.rerender([t1], t1);
    const activeWrapper = wrapperFor(host.container, 't1');
    expect(activeWrapper).not.toBeNull();
    expect(activeWrapper?.className).not.toBe('hidden');
    expect(activeWrapper?.getAttribute('aria-hidden')).toBe('false');

    // Stop preserving, then leave: the panel unmounts.
    act(() => {
      latestPropsFor('t1').onPreserveMountedChange?.('t1', false);
    });
    host.rerender([t1], null);
    expect(wrapperFor(host.container, 't1')).toBeNull();

    host.unmount();
  });

  it('unmounts inactive non-preserved file tabs', () => {
    const t1 = tab('t1');
    const t2 = tab('t2');
    const host = renderHost([t1, t2], t1);

    // Only the active tab renders; the other inactive tab is not mounted.
    expect(wrapperFor(host.container, 't1')).not.toBeNull();
    expect(wrapperFor(host.container, 't2')).toBeNull();

    host.rerender([t1, t2], t2);
    expect(wrapperFor(host.container, 't2')).not.toBeNull();
    expect(wrapperFor(host.container, 't1')).toBeNull();

    host.unmount();
  });

  it('prunes preserved state for tabs that are closed', () => {
    const t1 = tab('t1');
    const host = renderHost([t1], t1);

    act(() => {
      latestPropsFor('t1').onPreserveMountedChange?.('t1', true);
    });

    // Close the tab entirely.
    host.rerender([], null);
    expect(wrapperFor(host.container, 't1')).toBeNull();

    // Reopening the same id without making it active must not resurrect it
    // from stale preserved state — proving the prune ran.
    host.rerender([t1], null);
    expect(wrapperFor(host.container, 't1')).toBeNull();

    host.unmount();
  });
});
