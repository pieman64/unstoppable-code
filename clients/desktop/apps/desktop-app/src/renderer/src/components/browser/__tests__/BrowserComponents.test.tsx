/**
 * @jest-environment jsdom
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type BrowserSetBoundsRequest,
  type BrowserJavaScriptDialog,
  type BrowserRecordingResult,
  type BrowserSessionSnapshot,
} from '@canopy/desktop-shared/types';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import { useBrowserStore } from '@/stores/browserStore';
import { BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE } from '@/lib/browserNativeOverlay';
import { BROWSER_VIEW_BOUNDS_INVALIDATED_EVENT } from '@/lib/browserViewBounds';
import {
  IN_APP_BROWSER_LOCAL_ONLY_URL_MESSAGE,
  IN_APP_BROWSER_NETWORK_PATH_URL_MESSAGE,
} from '@/lib/browserUrl';
import { resetBrowserTabPreviewsForTests } from '@/lib/panels/browser-tab-preview';
import { BrowserBar } from '../BrowserBar';
import { BrowserConsolePanel } from '../BrowserConsolePanel';
import { BrowserNetworkPanel } from '../BrowserNetworkPanel';
import { BrowserPane } from '../BrowserPane';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { BrowserRecordingPanel } from '../BrowserRecordingPanel';
import { BrowserSnapshotsPanel } from '../BrowserSnapshotsPanel';
import { resetExperimentalFeaturesStoreForTest } from '@/stores/experimentalFeaturesStore';

const PROJECT_ID = 'p';
const WORKTREE_ID = 'w';
const BROWSER_ID = 'b1';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface MockBrowserApi {
  setBounds: jest.Mock;
  setVisible: jest.Mock;
  create: jest.Mock;
  navigate: jest.Mock;
  reload: jest.Mock;
  stop: jest.Mock;
  destroy: jest.Mock;
  saveWorktreeState: jest.Mock;
  screenshot: jest.Mock;
  getDialog: jest.Mock;
  handleDialog: jest.Mock;
  clearRecording: jest.Mock;
  startRecording: jest.Mock;
  stopRecording: jest.Mock;
  openExternal: jest.Mock;
}

let browserApi: MockBrowserApi;
let boundingRectSpy: jest.SpyInstance;
let requestAnimationFrameSpy: jest.SpyInstance;
let cancelAnimationFrameSpy: jest.SpyInstance;

function snapshot(
  overrides: Partial<BrowserSessionSnapshot> = {},
): BrowserSessionSnapshot {
  return {
    id: BROWSER_ID,
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    createdAt: 1,
    updatedAt: 2,
    url: 'http://localhost:3000/',
    title: 'Local',
    status: 'ready',
    canGoBack: false,
    canGoForward: false,
    loading: false,
    themeMode: 'light',
    pickMode: false,
    recording: false,
    ...overrides,
  };
}

function recordingResult(
  overrides: Partial<BrowserRecordingResult> = {},
): BrowserRecordingResult {
  return {
    browserId: BROWSER_ID,
    recording: false,
    steps: [
      {
        id: 'step-1',
        action: 'click',
        locator: "page.getByRole('button', { name: 'Save' })",
        playwright: "await page.getByRole('button', { name: 'Save' }).click();",
        timestamp: 3,
      },
    ],
    playwrightScript:
      "await page.getByRole('button', { name: 'Save' }).click();",
    ...overrides,
  };
}

function seedBrowser(
  overrides: Partial<BrowserSessionSnapshot> = {},
  options: { live?: boolean } = {},
): void {
  useBrowserStore.setState({
    worktrees: {
      [`${PROJECT_ID}/${WORKTREE_ID}`]: {
        browserOrder: [BROWSER_ID],
        activeBrowserId: BROWSER_ID,
        browsers: { [BROWSER_ID]: snapshot(overrides) },
        live: new Set(options.live === false ? [] : [BROWSER_ID]),
        hydrated: true,
      },
    },
    consoleEntries: {},
    networkEntries: {},
    recordings: {},
    screenshots: {},
    dialogs: {},
    inspectorOpen: {},
    inspectorTab: {},
    diagnosticsSeenAt: {},
  });
}

function seedLiveBrowser(
  overrides: Partial<BrowserSessionSnapshot> = {},
): void {
  seedBrowser(overrides);
}

function seedTwoLiveBrowsers(secondBrowserId = 'b2'): string {
  useBrowserStore.setState({
    worktrees: {
      [`${PROJECT_ID}/${WORKTREE_ID}`]: {
        browserOrder: [BROWSER_ID, secondBrowserId],
        activeBrowserId: BROWSER_ID,
        browsers: {
          [BROWSER_ID]: snapshot(),
          [secondBrowserId]: snapshot({ id: secondBrowserId, title: 'Two' }),
        },
        live: new Set([BROWSER_ID, secondBrowserId]),
        hydrated: true,
      },
    },
  });
  return secondBrowserId;
}

beforeEach(() => {
  browserApi = {
    setBounds: jest.fn().mockResolvedValue(undefined),
    setVisible: jest.fn().mockResolvedValue(undefined),
    create: jest.fn().mockResolvedValue(snapshot()),
    navigate: jest.fn().mockResolvedValue(snapshot()),
    reload: jest.fn().mockResolvedValue(snapshot()),
    stop: jest.fn().mockResolvedValue(snapshot()),
    destroy: jest.fn().mockResolvedValue(undefined),
    saveWorktreeState: jest.fn().mockResolvedValue(undefined),
    screenshot: jest
      .fn()
      .mockResolvedValue({ dataUrl: 'data:image/png;base64,freeze' }),
    getDialog: jest.fn().mockResolvedValue(null),
    handleDialog: jest.fn().mockResolvedValue(undefined),
    clearRecording: jest.fn().mockResolvedValue(undefined),
    startRecording: jest.fn().mockResolvedValue(snapshot({ recording: true })),
    stopRecording: jest.fn().mockResolvedValue(recordingResult()),
    openExternal: jest.fn().mockResolvedValue(undefined),
  };
  (window as unknown as { api: unknown }).api = { browser: browserApi };
  class MockResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    MockResizeObserver;
  requestAnimationFrameSpy = jest
    .spyOn(window, 'requestAnimationFrame')
    .mockImplementation((callback: FrameRequestCallback): number => {
      callback(0);
      return 1;
    });
  cancelAnimationFrameSpy = jest
    .spyOn(window, 'cancelAnimationFrame')
    .mockImplementation(() => undefined);
  boundingRectSpy = jest
    .spyOn(Element.prototype, 'getBoundingClientRect')
    .mockReturnValue({
      left: 100.4,
      top: 200.6,
      width: 300.2,
      height: 150.9,
      right: 400,
      bottom: 351,
      x: 100.4,
      y: 200.6,
      toJSON: () => ({}),
    });
});

afterEach(() => {
  // Two Browser-bar cases opt into local-only browsing; reset so the rest of
  // the file keeps the default.
  useBrowserStore.setState({ localServersOnly: false });
  boundingRectSpy.mockRestore();
  requestAnimationFrameSpy.mockRestore();
  cancelAnimationFrameSpy.mockRestore();
});

function mount(node: React.ReactElement): {
  container: HTMLElement;
  root: Root;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(node);
  });
  return { container, root };
}

/**
 * Sets a React-controlled input's value through the native setter so React's
 * synthetic `change` handler observes it.
 */
function setInputValue(input: HTMLInputElement | null, value: string): void {
  if (!input) {
    throw new Error('Expected the Browser bar URL input to be mounted.');
  }
  // The native value setter is immediately re-bound with `.call(input, ...)`,
  // which is the standard way to make React's value tracker observe a
  // programmatic write.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function setBoundsArgs(): BrowserSetBoundsRequest[] {
  return (
    browserApi.setBounds.mock.calls as Array<[BrowserSetBoundsRequest]>
  ).map((call) => call[0]);
}

describe('BrowserConsolePanel', () => {
  it('renders the empty state and filter/clear controls', () => {
    useBrowserStore.setState({ consoleEntries: {} });
    const { container, root } = mount(
      <BrowserConsolePanel browserId={BROWSER_ID} />,
    );
    try {
      expect(container.textContent).toContain('No console output');
      const labels = Array.from(container.querySelectorAll('button')).map(
        (b) => b.textContent,
      );
      expect(labels).toEqual(
        expect.arrayContaining(['All', 'Errors', 'Clear']),
      );
      const clear = container.querySelector('[aria-label="Clear console"]');
      expect(clear).not.toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('shows a chat action for captured console entries', () => {
    useBrowserStore.setState({
      consoleEntries: {
        [BROWSER_ID]: [
          {
            id: 'console-1',
            browserId: BROWSER_ID,
            timestamp: 1,
            level: 'error',
            text: 'Unable to save',
            url: 'http://localhost:5173/app.js',
            lineNumber: 12,
          },
        ],
      },
    });

    const { container, root } = mount(
      <BrowserConsolePanel browserId={BROWSER_ID} />,
    );
    try {
      expect(container.textContent).toContain('Unable to save');
      expect(container.textContent).toContain(CHAT_UNIT_LABEL);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

describe('BrowserNetworkPanel', () => {
  it('renders failed requests with separate URL and error detail', () => {
    useBrowserStore.setState({
      networkEntries: {
        [BROWSER_ID]: [
          {
            id: 'request-1',
            browserId: BROWSER_ID,
            requestId: 'request-1',
            timestamp: 1,
            method: 'GET',
            url: 'http://localhost:5173/api/session?fresh=1',
            resourceType: 'fetch',
            failed: true,
            errorText: 'net::ERR_CONNECTION_REFUSED',
            durationMs: 18,
          },
        ],
      },
    });

    const { container, root } = mount(
      <BrowserNetworkPanel browserId={BROWSER_ID} />,
    );
    try {
      expect(container.textContent).toContain('GET');
      expect(container.textContent).toContain('failed');
      expect(container.textContent).toContain('/api/session?fresh=1');
      expect(container.textContent).toContain('net::ERR_CONNECTION_REFUSED');
      expect(container.textContent).toContain('http://localhost:5173');
      expect(container.textContent).toContain('18 ms');
      expect(container.textContent).toContain(CHAT_UNIT_LABEL);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

describe('BrowserSnapshotsPanel', () => {
  it('shows chat and delete actions for snapshots', () => {
    useBrowserStore.setState({
      screenshots: {
        [BROWSER_ID]: [
          {
            id: 'shot-1',
            filename: 'browser-shot.png',
            attachmentPath: '/tmp/browser-shot.png',
            capturedAt: 1,
            attached: false,
          },
        ],
      },
    });

    const { container, root } = mount(
      <BrowserSnapshotsPanel browserId={BROWSER_ID} />,
    );
    try {
      expect(container.textContent).toContain('browser-shot.png');
      expect(container.textContent).toContain(CHAT_UNIT_LABEL);
      const deleteButton = container.querySelector<HTMLButtonElement>(
        '[aria-label="Delete snapshot"]',
      );
      expect(deleteButton).not.toBeNull();
      act(() => {
        deleteButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(
        useBrowserStore.getState().screenshots[BROWSER_ID],
      ).toBeUndefined();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

describe('BrowserRecordingPanel', () => {
  it('shows chat and delete actions for recordings', () => {
    useBrowserStore.setState({
      recordings: {
        [BROWSER_ID]: recordingResult(),
      },
    });

    const { container, root } = mount(
      <BrowserRecordingPanel browserId={BROWSER_ID} />,
    );
    try {
      expect(container.textContent).toContain(CHAT_UNIT_LABEL);
      const deleteButton = container.querySelector<HTMLButtonElement>(
        '[aria-label="Delete recording"]',
      );
      expect(deleteButton).not.toBeNull();
      act(() => {
        deleteButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(browserApi.clearRecording).toHaveBeenCalledWith({
        browserId: BROWSER_ID,
      });
      expect(useBrowserStore.getState().recordings[BROWSER_ID].steps).toEqual(
        [],
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

describe('BrowserBar', () => {
  it('keeps browser profiles and automation controls off private sign-in pages', () => {
    const { container, root } = mount(
      <BrowserBar
        browserId={BROWSER_ID}
        snapshot={snapshot({ projectId: 'app-oauth', worktreeId: 'mcp' })}
        inspectorOpen={false}
        errorCount={0}
        onToggleInspector={(): void => undefined}
      />,
    );
    try {
      expect(
        container.querySelector('[aria-label^="Browser profile:"]'),
      ).toBeNull();
      expect(
        container.querySelector('[aria-label="Record browser actions"]'),
      ).toBeNull();
      expect(
        container.querySelector('[aria-label="Capture screenshot"]'),
      ).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('opens the recording panel after stopping a recording with steps', async () => {
    seedLiveBrowser({ recording: true });
    browserApi.stopRecording.mockResolvedValue(recordingResult());
    const { container, root } = mount(
      <BrowserBar
        browserId={BROWSER_ID}
        snapshot={snapshot({ recording: true })}
        inspectorOpen={false}
        errorCount={0}
        onToggleInspector={(): void => undefined}
      />,
    );
    try {
      const recordButton = container.querySelector<HTMLButtonElement>(
        '[aria-label="Record browser actions"]',
      );
      expect(recordButton).not.toBeNull();
      await act(async () => {
        recordButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(useBrowserStore.getState().inspectorOpen[BROWSER_ID]).toBe(true);
      expect(useBrowserStore.getState().inspectorTab[BROWSER_ID]).toBe(
        'recording',
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('replaces refresh with a red stop button while loading and aborts on click', async () => {
    seedLiveBrowser({ status: 'loading', loading: true });
    const { container, root } = mount(
      <BrowserBar
        browserId={BROWSER_ID}
        snapshot={snapshot({ status: 'loading', loading: true })}
        inspectorOpen={false}
        errorCount={0}
        onToggleInspector={(): void => undefined}
      />,
    );
    try {
      expect(container.querySelector('[aria-label="Refresh"]')).toBeNull();
      const stopButton = container.querySelector<HTMLButtonElement>(
        '[aria-label="Stop loading"]',
      );
      expect(stopButton).not.toBeNull();
      await act(async () => {
        stopButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
      });
      expect(browserApi.stop).toHaveBeenCalledWith({ browserId: BROWSER_ID });
      expect(browserApi.reload).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('opens a typed absolute path as a local file URL', async () => {
    seedLiveBrowser();
    useBrowserStore.setState({ localServersOnly: true });
    const { container, root } = mount(
      <BrowserBar
        browserId={BROWSER_ID}
        snapshot={snapshot()}
        inspectorOpen={false}
        errorCount={0}
        onToggleInspector={(): void => undefined}
      />,
    );
    try {
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="browser-url-input"]',
      );
      expect(input).not.toBeNull();
      await act(async () => {
        setInputValue(input, '/Users/me/My Site/index.html');
        input?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
        await Promise.resolve();
      });
      expect(browserApi.navigate).toHaveBeenCalledWith({
        browserId: BROWSER_ID,
        url: 'file:///Users/me/My%20Site/index.html',
      });
      expect(input?.getAttribute('aria-invalid')).toBe('false');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('refuses a network share path with its own message', async () => {
    seedLiveBrowser();
    const { container, root } = mount(
      <BrowserBar
        browserId={BROWSER_ID}
        snapshot={snapshot()}
        inspectorOpen={false}
        errorCount={0}
        onToggleInspector={(): void => undefined}
      />,
    );
    try {
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="browser-url-input"]',
      );
      await act(async () => {
        setInputValue(input, '\\\\server\\share\\page.html');
        input?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
        await Promise.resolve();
      });
      expect(browserApi.navigate).not.toHaveBeenCalled();
      expect(container.textContent).toContain(
        IN_APP_BROWSER_NETWORK_PATH_URL_MESSAGE,
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('keeps the local-only message honest about local files', async () => {
    seedLiveBrowser();
    useBrowserStore.setState({ localServersOnly: true });
    const { container, root } = mount(
      <BrowserBar
        browserId={BROWSER_ID}
        snapshot={snapshot()}
        inspectorOpen={false}
        errorCount={0}
        onToggleInspector={(): void => undefined}
      />,
    );
    try {
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="browser-url-input"]',
      );
      await act(async () => {
        setInputValue(input, 'https://example.com');
        input?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
        await Promise.resolve();
      });
      expect(browserApi.navigate).not.toHaveBeenCalled();
      expect(container.textContent).toContain(
        IN_APP_BROWSER_LOCAL_ONLY_URL_MESSAGE,
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  function renderExternalButton(overrides: Partial<BrowserSessionSnapshot>): {
    readonly external: HTMLButtonElement | null;
    readonly cleanup: () => void;
  } {
    seedLiveBrowser(overrides);
    const { container, root } = mount(
      <BrowserBar
        browserId={BROWSER_ID}
        snapshot={snapshot(overrides)}
        inspectorOpen={false}
        errorCount={0}
        onToggleInspector={(): void => undefined}
      />,
    );
    return {
      external: container.querySelector<HTMLButtonElement>(
        '[aria-label="Open in external browser"]',
      ),
      cleanup: (): void => {
        act(() => root.unmount());
        container.remove();
      },
    };
  }

  function clickButton(button: HTMLButtonElement | null): void {
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  it('opens a local file page in the default web browser', () => {
    const { external, cleanup } = renderExternalButton({
      url: 'file:///Users/me/site/index.html',
    });
    try {
      expect(external).not.toBeNull();
      expect(external?.disabled).toBe(false);
      clickButton(external);
      expect(browserApi.openExternal).toHaveBeenCalledWith({
        url: 'file:///Users/me/site/index.html',
        browserId: BROWSER_ID,
      });
    } finally {
      cleanup();
    }
  });

  it('keeps the external-browser button disabled on a blank tab', () => {
    const { external, cleanup } = renderExternalButton({ url: '' });
    try {
      expect(external?.disabled).toBe(true);
      clickButton(external);
      expect(browserApi.openExternal).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('keeps the external-browser button disabled on a viewer-scope file page', () => {
    const { external, cleanup } = renderExternalButton({
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      url: 'file:///Users/me/site/index.html',
    });
    try {
      expect(external?.disabled).toBe(true);
      clickButton(external);
      expect(browserApi.openExternal).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('still opens an http page in the external browser', () => {
    const { external, cleanup } = renderExternalButton({
      url: 'http://localhost:3000/',
    });
    try {
      expect(external?.disabled).toBe(false);
      clickButton(external);
      expect(browserApi.openExternal).toHaveBeenCalledWith({
        url: 'http://localhost:3000/',
        browserId: BROWSER_ID,
      });
    } finally {
      cleanup();
    }
  });

  it('shows the refresh button when not loading', () => {
    seedLiveBrowser();
    const { container, root } = mount(
      <BrowserBar
        browserId={BROWSER_ID}
        snapshot={snapshot()}
        inspectorOpen={false}
        errorCount={0}
        onToggleInspector={(): void => undefined}
      />,
    );
    try {
      expect(container.querySelector('[aria-label="Refresh"]')).not.toBeNull();
      expect(container.querySelector('[aria-label="Stop loading"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('waits for a returning tab to rematerialize before refreshing it', async () => {
    seedBrowser({}, { live: false });
    let finishCreate: ((value: BrowserSessionSnapshot) => void) | undefined;
    browserApi.create.mockImplementationOnce(
      () =>
        new Promise<BrowserSessionSnapshot>((resolve) => {
          finishCreate = resolve;
        }),
    );
    const { container, root } = mount(
      <BrowserBar
        browserId={BROWSER_ID}
        snapshot={snapshot()}
        inspectorOpen={false}
        errorCount={0}
        onToggleInspector={() => undefined}
      />,
    );
    try {
      await act(() => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="browser-refresh"]')
          ?.click();
        return Promise.resolve();
      });
      expect(browserApi.create).toHaveBeenCalledWith(
        expect.objectContaining({ browserId: BROWSER_ID }),
      );
      expect(browserApi.reload).not.toHaveBeenCalled();
      await act(() => {
        finishCreate?.(snapshot());
        return Promise.resolve();
      });
      expect(browserApi.reload).toHaveBeenCalledWith({ browserId: BROWSER_ID });
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('keeps a failed rematerialization inert without sending reload', async () => {
    seedBrowser({}, { live: false });
    browserApi.create.mockRejectedValueOnce(new Error('Creation unavailable'));
    const { container, root } = mount(
      <BrowserBar
        browserId={BROWSER_ID}
        snapshot={snapshot()}
        inspectorOpen={false}
        errorCount={0}
        onToggleInspector={(): void => undefined}
      />,
    );
    try {
      await act(() => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="browser-refresh"]')
          ?.click();
        return Promise.resolve();
      });
      expect(browserApi.reload).not.toHaveBeenCalled();
      expect(
        useBrowserStore
          .getState()
          .worktrees[`${PROJECT_ID}/${WORKTREE_ID}`]?.live.has(BROWSER_ID),
      ).toBe(false);
      expect(
        useBrowserStore.getState().worktrees[`${PROJECT_ID}/${WORKTREE_ID}`]
          ?.browsers[BROWSER_ID].lastError,
      ).toBe('Creation unavailable');
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="browser-url-input"]',
      );
      expect(input?.getAttribute('aria-invalid')).toBe('true');
      expect(
        container.querySelector(`#${input?.getAttribute('aria-describedby')}`)
          ?.textContent,
      ).toBe('Creation unavailable');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

const SQUARE_CORNER_RADII = {
  topLeft: 0,
  topRight: 0,
  bottomRight: 0,
  bottomLeft: 0,
};

describe('BrowserPane bounds sync', () => {
  it('sends the page area’s corner radii for the native view to copy', () => {
    seedLiveBrowser();
    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible
      />,
    );
    try {
      const pageArea = container.querySelector<HTMLElement>(
        '[data-testid="browser-page-area"]',
      );
      if (!pageArea) throw new Error('Missing page area');
      // The inset layout rounds the page area's bottom corners with its
      // card's, and keeps the top square under the toolbar.
      pageArea.style.borderBottomLeftRadius = '9px';
      pageArea.style.borderBottomRightRadius = '9px';
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });
      const visibleCalls = setBoundsArgs().filter((arg) => arg.visible);
      expect(visibleCalls.at(-1)?.cornerRadii).toEqual({
        topLeft: 0,
        topRight: 0,
        bottomRight: 9,
        bottomLeft: 9,
      });
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('sends setBounds with rounded rect + visible:true when shown', () => {
    seedLiveBrowser();
    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible
      />,
    );
    try {
      const visibleCall = setBoundsArgs().find((arg) => arg.visible === true);
      expect(visibleCall).toBeDefined();
      expect(visibleCall).toEqual({
        browserId: BROWSER_ID,
        visible: true,
        bounds: { x: 100, y: 201, width: 300, height: 151 },
        cornerRadii: SQUARE_CORNER_RADII,
      });
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('navigates a visible live-but-idle browser to its URL', async () => {
    seedLiveBrowser({
      url: 'http://localhost:5173/',
      status: 'idle',
      loading: false,
    });
    browserApi.navigate.mockResolvedValue(
      snapshot({
        url: 'http://localhost:5173/',
        status: 'ready',
        loading: false,
      }),
    );

    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible
      />,
    );
    try {
      await act(async () => {
        await Promise.resolve();
      });

      expect(browserApi.navigate).toHaveBeenCalledWith({
        browserId: BROWSER_ID,
        url: 'http://localhost:5173/',
      });
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('shows a centered spinner and hides the native view during a blank first load', () => {
    seedLiveBrowser({
      url: 'http://localhost:5173/',
      status: 'loading',
      loading: true,
    });
    // Keep the navigation in flight so the blank-load state is deterministic.
    browserApi.navigate.mockResolvedValue(
      snapshot({
        url: 'http://localhost:5173/',
        status: 'loading',
        loading: true,
      }),
    );
    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible
      />,
    );
    try {
      const loading = container.querySelector(
        '[data-testid="browser-pane-loading"]',
      );
      expect(loading?.getAttribute('role')).toBe('status');
      expect(loading?.textContent).toBe('Loading localhost:5173…');
      expect(setBoundsArgs().some((arg) => arg.visible === true)).toBe(false);
      expect(browserApi.setVisible).toHaveBeenCalledWith({
        browserId: BROWSER_ID,
        visible: false,
      });
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('isolates freeze-frame capture failure and still hides the requested native view', async () => {
    const overlay = document.createElement('div');
    overlay.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');
    document.body.appendChild(overlay);
    browserApi.screenshot.mockRejectedValueOnce(new Error('capture failed'));
    seedLiveBrowser();

    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible
      />,
    );
    try {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(container.querySelector('img[aria-hidden="true"]')).toBeNull();
      expect(browserApi.setVisible).toHaveBeenCalledWith({
        browserId: BROWSER_ID,
        visible: false,
      });

      browserApi.setBounds.mockClear();
      overlay.remove();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(
        setBoundsArgs().some(
          (arg) => arg.browserId === BROWSER_ID && arg.visible === true,
        ),
      ).toBe(true);
    } finally {
      act(() => root.unmount());
      container.remove();
      overlay.remove();
    }
  });

  it('captures side-by-side pane freeze frames independently by browser id', async () => {
    const secondBrowserId = seedTwoLiveBrowsers();
    const overlay = document.createElement('div');
    overlay.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');
    document.body.appendChild(overlay);
    browserApi.screenshot.mockImplementation(
      ({ browserId }: { browserId: string }) =>
        Promise.resolve({
          dataUrl: `data:image/png;base64,freeze-${browserId}`,
        }),
    );

    const { container, root } = mount(
      <>
        <BrowserPane
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          browserId={BROWSER_ID}
          visible
        />
        <BrowserPane
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          browserId={secondBrowserId}
          visible
        />
      </>,
    );
    try {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(browserApi.screenshot).toHaveBeenCalledWith({
        browserId: BROWSER_ID,
        purpose: 'freeze-frame',
      });
      expect(browserApi.screenshot).toHaveBeenCalledWith({
        browserId: secondBrowserId,
        purpose: 'freeze-frame',
      });
      expect(
        container
          .querySelector(`[data-testid="browser-pane-${BROWSER_ID}"]`)
          ?.querySelector('img[aria-hidden="true"]')
          ?.getAttribute('src'),
      ).toBe(`data:image/png;base64,freeze-${BROWSER_ID}`);
      expect(
        container
          .querySelector(`[data-testid="browser-pane-${secondBrowserId}"]`)
          ?.querySelector('img[aria-hidden="true"]')
          ?.getAttribute('src'),
      ).toBe(`data:image/png;base64,freeze-${secondBrowserId}`);
    } finally {
      act(() => root.unmount());
      container.remove();
      overlay.remove();
    }
  });

  it('isolates a concurrent pane capture failure from the successful pane', async () => {
    const secondBrowserId = seedTwoLiveBrowsers();
    const overlay = document.createElement('div');
    overlay.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');
    document.body.appendChild(overlay);
    browserApi.screenshot.mockImplementation(
      ({ browserId }: { browserId: string }) =>
        browserId === BROWSER_ID
          ? Promise.reject(new Error('first capture failed'))
          : Promise.resolve({
              dataUrl: `data:image/png;base64,freeze-${browserId}`,
            }),
    );

    const { container, root } = mount(
      <>
        <BrowserPane
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          browserId={BROWSER_ID}
          visible
        />
        <BrowserPane
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          browserId={secondBrowserId}
          visible
        />
      </>,
    );
    try {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(
        container
          .querySelector(`[data-testid="browser-pane-${BROWSER_ID}"]`)
          ?.querySelector('img[aria-hidden="true"]'),
      ).toBeNull();
      expect(
        container
          .querySelector(`[data-testid="browser-pane-${secondBrowserId}"]`)
          ?.querySelector('img[aria-hidden="true"]')
          ?.getAttribute('src'),
      ).toBe(`data:image/png;base64,freeze-${secondBrowserId}`);
      expect(browserApi.setVisible).toHaveBeenCalledWith({
        browserId: BROWSER_ID,
        visible: false,
      });
      expect(browserApi.setVisible).toHaveBeenCalledWith({
        browserId: secondBrowserId,
        visible: false,
      });
    } finally {
      act(() => root.unmount());
      container.remove();
      overlay.remove();
    }
  });

  it('isolates a concurrent pane capture timeout from the successful pane', async () => {
    jest.useFakeTimers();
    const secondBrowserId = seedTwoLiveBrowsers();
    const overlay = document.createElement('div');
    overlay.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');
    document.body.appendChild(overlay);
    browserApi.screenshot.mockImplementation(
      ({ browserId }: { browserId: string }) =>
        browserId === BROWSER_ID
          ? new Promise(() => undefined)
          : Promise.resolve({
              dataUrl: `data:image/png;base64,freeze-${browserId}`,
            }),
    );

    const { container, root } = mount(
      <>
        <BrowserPane
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          browserId={BROWSER_ID}
          visible
        />
        <BrowserPane
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          browserId={secondBrowserId}
          visible
        />
      </>,
    );
    try {
      await act(async () => {
        await Promise.resolve();
      });
      act(() => {
        jest.advanceTimersByTime(251);
      });
      expect(
        container
          .querySelector(`[data-testid="browser-pane-${BROWSER_ID}"]`)
          ?.querySelector('img[aria-hidden="true"]'),
      ).toBeNull();
      expect(
        container
          .querySelector(`[data-testid="browser-pane-${secondBrowserId}"]`)
          ?.querySelector('img[aria-hidden="true"]')
          ?.getAttribute('src'),
      ).toBe(`data:image/png;base64,freeze-${secondBrowserId}`);
    } finally {
      act(() => root.unmount());
      container.remove();
      overlay.remove();
      jest.useRealTimers();
    }
  });

  it('restores only the pane that remains visible after an overlay closes', async () => {
    const secondBrowserId = seedTwoLiveBrowsers();
    const overlay = document.createElement('div');
    overlay.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');
    document.body.appendChild(overlay);
    browserApi.screenshot.mockRejectedValue(new Error('capture unavailable'));
    const panes = (firstVisible: boolean): React.ReactElement => (
      <>
        <BrowserPane
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          browserId={BROWSER_ID}
          visible={firstVisible}
        />
        <BrowserPane
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          browserId={secondBrowserId}
          visible
        />
      </>
    );
    const { container, root } = mount(panes(true));
    try {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      act(() => root.render(panes(false)));
      browserApi.setBounds.mockClear();
      browserApi.setVisible.mockClear();
      overlay.remove();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      });
      act(() => {
        window.dispatchEvent(new Event(BROWSER_VIEW_BOUNDS_INVALIDATED_EVENT));
      });

      expect(
        setBoundsArgs().some(
          (arg) => arg.browserId === BROWSER_ID && arg.visible === true,
        ),
      ).toBe(false);
      expect(
        setBoundsArgs().some(
          (arg) => arg.browserId === secondBrowserId && arg.visible === true,
        ),
      ).toBe(true);
    } finally {
      act(() => root.unmount());
      container.remove();
      overlay.remove();
    }
  });

  it('times out one freeze-frame capture without leaving its native view visible', () => {
    jest.useFakeTimers();
    const overlay = document.createElement('div');
    overlay.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');
    document.body.appendChild(overlay);
    browserApi.screenshot.mockReturnValueOnce(new Promise(() => undefined));
    seedLiveBrowser();

    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible
      />,
    );
    try {
      act(() => {
        jest.advanceTimersByTime(251);
      });
      expect(container.querySelector('img[aria-hidden="true"]')).toBeNull();
      expect(browserApi.setVisible).toHaveBeenCalledWith({
        browserId: BROWSER_ID,
        visible: false,
      });
    } finally {
      act(() => root.unmount());
      container.remove();
      overlay.remove();
      jest.useRealTimers();
    }
  });

  it('shows a freeze frame that arrives after the capture fallback hid the native view', async () => {
    jest.useFakeTimers();
    const overlay = document.createElement('div');
    overlay.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');
    document.body.appendChild(overlay);
    let resolveCapture: (value: { dataUrl: string }) => void = () => undefined;
    browserApi.screenshot.mockReturnValueOnce(
      new Promise<{ dataUrl: string }>((resolve) => {
        resolveCapture = resolve;
      }),
    );
    seedLiveBrowser();

    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible
      />,
    );
    try {
      act(() => {
        jest.advanceTimersByTime(251);
      });
      expect(container.querySelector('img[aria-hidden="true"]')).toBeNull();
      expect(browserApi.setVisible).toHaveBeenCalledWith({
        browserId: BROWSER_ID,
        visible: false,
      });

      await act(async () => {
        resolveCapture({ dataUrl: 'data:image/jpeg;base64,late' });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(
        container.querySelector('img[aria-hidden="true"]')?.getAttribute('src'),
      ).toBe('data:image/jpeg;base64,late');
      expect(browserApi.screenshot).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
      container.remove();
      overlay.remove();
      jest.useRealTimers();
    }
  });

  it('keeps a late freeze frame under the live page once its overlay has closed', async () => {
    jest.useFakeTimers();
    const overlay = document.createElement('div');
    overlay.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');
    document.body.appendChild(overlay);
    let resolveCapture: (value: { dataUrl: string }) => void = () => undefined;
    browserApi.screenshot.mockReturnValueOnce(
      new Promise<{ dataUrl: string }>((resolve) => {
        resolveCapture = resolve;
      }),
    );
    seedLiveBrowser();

    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible
      />,
    );
    try {
      act(() => {
        jest.advanceTimersByTime(251);
      });
      overlay.remove();
      await act(async () => {
        await Promise.resolve();
        jest.advanceTimersByTime(50);
        await Promise.resolve();
      });

      browserApi.setVisible.mockClear();
      await act(async () => {
        resolveCapture({ dataUrl: 'data:image/jpeg;base64,late' });
        await Promise.resolve();
        await Promise.resolve();
      });
      // Kept for the next overlay, under the live view, which stays shown.
      const frame = container.querySelector(
        '[data-testid="browser-pane-freeze-frame-ready"]',
      );
      expect(frame?.getAttribute('src')).toBe('data:image/jpeg;base64,late');
      expect(browserApi.setVisible).not.toHaveBeenCalledWith({
        browserId: BROWSER_ID,
        visible: false,
      });
    } finally {
      act(() => root.unmount());
      container.remove();
      overlay.remove();
      jest.useRealTimers();
    }
  });

  it('recreates a visible live-but-idle browser when navigate cannot find a native session', async () => {
    seedLiveBrowser({
      url: 'http://localhost:5173/',
      status: 'idle',
      loading: false,
    });
    browserApi.navigate.mockRejectedValueOnce(
      new Error(`Browser ${BROWSER_ID} not found.`),
    );
    browserApi.create.mockResolvedValue(
      snapshot({
        url: 'http://localhost:5173/',
        status: 'ready',
        loading: false,
      }),
    );

    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible
      />,
    );
    try {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(browserApi.create).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          browserId: BROWSER_ID,
          url: 'http://localhost:5173/',
        }),
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('resyncs native bounds when the surrounding chat layout changes', () => {
    seedLiveBrowser();
    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible
      />,
    );
    try {
      browserApi.setBounds.mockClear();
      boundingRectSpy.mockReturnValue({
        left: 100.4,
        top: 260.6,
        width: 300.2,
        height: 150.9,
        right: 400,
        bottom: 411,
        x: 100.4,
        y: 260.6,
        toJSON: () => ({}),
      });

      act(() => {
        window.dispatchEvent(new Event(BROWSER_VIEW_BOUNDS_INVALIDATED_EVENT));
      });

      expect(browserApi.setBounds).toHaveBeenCalledWith({
        browserId: BROWSER_ID,
        visible: true,
        bounds: { x: 100, y: 261, width: 300, height: 151 },
        cornerRadii: SQUARE_CORNER_RADII,
      });
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('reports independent native bounds for two simultaneously visible panes', () => {
    const secondBrowserId = seedTwoLiveBrowsers();
    boundingRectSpy.mockImplementation(function (this: Element): DOMRect {
      const second = this.closest(
        `[data-testid="browser-pane-${secondBrowserId}"]`,
      );
      const left = second ? 420 : 20;
      return {
        left,
        top: 100,
        right: left + 300,
        bottom: 300,
        width: 300,
        height: 200,
        x: left,
        y: 100,
        toJSON: () => ({}),
      };
    });

    const { container, root } = mount(
      <>
        <BrowserPane
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          browserId={BROWSER_ID}
          visible
        />
        <BrowserPane
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          browserId={secondBrowserId}
          visible
        />
      </>,
    );
    try {
      expect(browserApi.setBounds).toHaveBeenCalledWith({
        browserId: BROWSER_ID,
        visible: true,
        bounds: { x: 20, y: 100, width: 300, height: 200 },
        cornerRadii: SQUARE_CORNER_RADII,
      });
      expect(browserApi.setBounds).toHaveBeenCalledWith({
        browserId: secondBrowserId,
        visible: true,
        bounds: { x: 420, y: 100, width: 300, height: 200 },
        cornerRadii: SQUARE_CORNER_RADII,
      });
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('hides the view (setVisible:false) when not visible', () => {
    seedLiveBrowser();
    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible={false}
      />,
    );
    try {
      expect(browserApi.setVisible).toHaveBeenCalledWith({
        browserId: BROWSER_ID,
        visible: false,
      });
      expect(setBoundsArgs().some((arg) => arg.visible === true)).toBe(false);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('hides the view when its still-mounted page gives it zero bounds', () => {
    seedLiveBrowser();
    const zeroBounds: DOMRect = {
      left: 0,
      top: 0,
      width: 0,
      height: 0,
      right: 0,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
    boundingRectSpy.mockReturnValue(zeroBounds);

    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible
      />,
    );
    try {
      expect(browserApi.setVisible).toHaveBeenCalledWith({
        browserId: BROWSER_ID,
        visible: false,
      });
      expect(setBoundsArgs().some((arg) => arg.visible === true)).toBe(false);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('shows a freeze frame before hiding the native view under explicitly marked foreground overlays', async () => {
    const overlay = document.createElement('div');
    overlay.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');
    document.body.appendChild(overlay);

    seedLiveBrowser();
    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible
      />,
    );
    try {
      expect(browserApi.screenshot).toHaveBeenCalledWith({
        browserId: BROWSER_ID,
        purpose: 'freeze-frame',
      });

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const freezeFrame = container.querySelector('img[aria-hidden="true"]');
      expect(freezeFrame?.getAttribute('src')).toBe(
        'data:image/png;base64,freeze',
      );
      expect(browserApi.setVisible).toHaveBeenCalledWith({
        browserId: BROWSER_ID,
        visible: false,
      });
    } finally {
      act(() => root.unmount());
      container.remove();
      overlay.remove();
    }
  });

  describe('freeze frame timing', () => {
    // Frames run only when a test flushes them, so the order of "frame on
    // screen" and "native view hidden/shown" is observable.
    let frames: FrameRequestCallback[] = [];
    const flushFrames = async (count: number): Promise<void> => {
      for (let i = 0; i < count; i += 1) {
        await act(async () => {
          // Let pending observers queue their frame callbacks first.
          await Promise.resolve();
          const due = frames;
          frames = [];
          due.forEach((callback) => callback(0));
          await Promise.resolve();
          await Promise.resolve();
        });
      }
    };
    const hiddenCalls = (): number =>
      browserApi.setVisible.mock.calls.filter(
        ([arg]: [{ visible: boolean }]) => arg.visible === false,
      ).length;
    const freezeFrame = (container: HTMLElement): Element | null =>
      container.querySelector('[data-testid^="browser-pane-freeze-frame"]');

    beforeEach(() => {
      frames = [];
      requestAnimationFrameSpy.mockImplementation(
        (callback: FrameRequestCallback): number => {
          frames.push(callback);
          return frames.length;
        },
      );
    });

    it('keeps the native view shown until the freeze frame has been painted', async () => {
      seedLiveBrowser();
      const { container, root } = mount(
        <BrowserPane
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          browserId={BROWSER_ID}
          visible
        />,
      );
      const overlay = document.createElement('div');
      overlay.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');
      try {
        await flushFrames(1);
        browserApi.setVisible.mockClear();
        document.body.appendChild(overlay);
        await flushFrames(1);
        expect(browserApi.screenshot).toHaveBeenCalledTimes(1);
        // The capture lands: the frame goes up under the native view first.
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(freezeFrame(container)).not.toBeNull();
        expect(hiddenCalls()).toBe(0);
        // Hidden only once the frame has made it to the screen.
        await flushFrames(3);
        expect(hiddenCalls()).toBeGreaterThan(0);
      } finally {
        act(() => root.unmount());
        container.remove();
        overlay.remove();
      }
    });

    it.each([
      [false, 1],
      [true, 0],
    ])(
      'keeps a freeze frame as the tab preview only once its page has loaded (loading: %s)',
      async (loading, previews) => {
        const scaler = jest.fn(() => 'data:image/jpeg;base64,preview');
        resetBrowserTabPreviewsForTests(scaler);
        // Mid-navigation the snapshot has the new URL while the old page is
        // still on screen, so a frame then would label A's pixels with B.
        seedLiveBrowser({ loading });
        const { container, root } = mount(
          <BrowserPane
            projectId={PROJECT_ID}
            worktreeId={WORKTREE_ID}
            browserId={BROWSER_ID}
            visible
          />,
        );
        const overlay = document.createElement('div');
        overlay.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');
        try {
          await flushFrames(1);
          document.body.appendChild(overlay);
          await flushFrames(1);
          expect(browserApi.screenshot).toHaveBeenCalled();
          await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
          });
          expect(scaler).toHaveBeenCalledTimes(previews);
        } finally {
          act(() => root.unmount());
          container.remove();
          overlay.remove();
          resetBrowserTabPreviewsForTests();
        }
      },
    );

    it('keeps the freeze frame under the page when the overlay closes', async () => {
      seedLiveBrowser();
      const { container, root } = mount(
        <BrowserPane
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          browserId={BROWSER_ID}
          visible
        />,
      );
      const overlay = document.createElement('div');
      overlay.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');
      try {
        await flushFrames(1);
        document.body.appendChild(overlay);
        await flushFrames(1);
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        });
        await flushFrames(3);
        expect(hiddenCalls()).toBeGreaterThan(0);

        let showView: () => void = () => undefined;
        browserApi.setBounds.mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              showView = resolve;
            }),
        );
        browserApi.setBounds.mockClear();
        overlay.remove();
        await flushFrames(3);
        expect(
          setBoundsArgs().some(
            (arg) => arg.browserId === BROWSER_ID && arg.visible === true,
          ),
        ).toBe(true);
        // Main has not shown the view yet: the frame stays over the page.
        expect(freezeFrame(container)).not.toBeNull();

        await act(async () => {
          showView();
          await Promise.resolve();
        });
        await flushFrames(3);
        // It stays drawn under the live view, ready for the next overlay.
        expect(freezeFrame(container)?.getAttribute('data-testid')).toBe(
          'browser-pane-freeze-frame-ready',
        );
      } finally {
        act(() => root.unmount());
        container.remove();
        overlay.remove();
      }
    });

    it('covers the page with a frame captured on hover, without a new capture', async () => {
      seedLiveBrowser();
      const { container, root } = mount(
        <BrowserPane
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          browserId={BROWSER_ID}
          visible
        />,
      );
      const control = document.createElement('button');
      document.body.appendChild(control);
      const overlay = document.createElement('div');
      overlay.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');
      try {
        await flushFrames(1);
        // Pointing at a control in the app captures the page ahead of time.
        await act(async () => {
          control.dispatchEvent(new Event('pointerover', { bubbles: true }));
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(browserApi.screenshot).toHaveBeenCalledTimes(1);
        // Drawn under the live view; the view stays shown.
        await flushFrames(3);
        expect(freezeFrame(container)?.getAttribute('data-testid')).toBe(
          'browser-pane-freeze-frame-ready',
        );
        expect(hiddenCalls()).toBe(0);

        document.body.appendChild(overlay);
        // Already on screen: the view hides in the overlay's own update.
        await flushFrames(2);
        expect(browserApi.screenshot).toHaveBeenCalledTimes(1);
        expect(freezeFrame(container)?.getAttribute('src')).toBe(
          'data:image/png;base64,freeze',
        );
        expect(hiddenCalls()).toBeGreaterThan(0);
      } finally {
        act(() => root.unmount());
        container.remove();
        control.remove();
        overlay.remove();
      }
    });

    it('takes a first frame after the page loads, so the first overlay has one', async () => {
      seedLiveBrowser();
      const { container, root } = mount(
        <BrowserPane
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          browserId={BROWSER_ID}
          visible
        />,
      );
      const overlay = document.createElement('div');
      overlay.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');
      try {
        await flushFrames(1);
        expect(browserApi.screenshot).not.toHaveBeenCalled();
        await act(async () => {
          await new Promise((resolve) => window.setTimeout(resolve, 550));
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(browserApi.screenshot).toHaveBeenCalledTimes(1);
        await flushFrames(3);
        expect(freezeFrame(container)?.getAttribute('data-testid')).toBe(
          'browser-pane-freeze-frame-ready',
        );

        document.body.appendChild(overlay);
        await flushFrames(2);
        expect(hiddenCalls()).toBeGreaterThan(0);
        expect(browserApi.screenshot).toHaveBeenCalledTimes(1);
      } finally {
        act(() => root.unmount());
        container.remove();
        overlay.remove();
      }
    });

    it('keeps the page steady under an open overlay, taking a newer frame only after it closes', async () => {
      let now = 1_000;
      const nowSpy = jest
        .spyOn(performance, 'now')
        .mockImplementation(() => now);
      let landSecond: (value: { dataUrl: string }) => void = () => undefined;
      browserApi.screenshot
        .mockResolvedValueOnce({ dataUrl: 'data:image/jpeg;base64,first' })
        .mockReturnValueOnce(
          new Promise<{ dataUrl: string }>((resolve) => {
            landSecond = resolve;
          }),
        );
      seedLiveBrowser();
      const { container, root } = mount(
        <BrowserPane
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          browserId={BROWSER_ID}
          visible
        />,
      );
      const control = document.createElement('button');
      document.body.appendChild(control);
      const overlay = document.createElement('div');
      overlay.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');
      const src = (): string | null | undefined =>
        freezeFrame(container)?.getAttribute('src');
      const pointAt = async (): Promise<void> => {
        await act(async () => {
          control.dispatchEvent(new Event('pointerover', { bubbles: true }));
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        });
      };
      try {
        await flushFrames(1);
        await pointAt();
        await flushFrames(3);
        // A moment later the press that opens the overlay starts a newer
        // capture; the frame from pointing at the control covers the page.
        now += 400;
        browserApi.setVisible.mockClear();
        control.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        expect(browserApi.screenshot).toHaveBeenCalledTimes(2);
        document.body.appendChild(overlay);
        await flushFrames(2);
        expect(hiddenCalls()).toBeGreaterThan(0);
        expect(src()).toBe('data:image/jpeg;base64,first');

        // It lands while the overlay is open: the page under it holds still.
        await act(async () => {
          landSecond({ dataUrl: 'data:image/jpeg;base64,second' });
          await Promise.resolve();
          await Promise.resolve();
        });
        await flushFrames(3);
        expect(src()).toBe('data:image/jpeg;base64,first');

        overlay.remove();
        await flushFrames(4);
        // Back under the live view, the newer frame takes its place.
        expect(src()).toBe('data:image/jpeg;base64,second');
        expect(freezeFrame(container)?.getAttribute('data-testid')).toBe(
          'browser-pane-freeze-frame-ready',
        );
      } finally {
        nowSpy.mockRestore();
        act(() => root.unmount());
        container.remove();
        control.remove();
        overlay.remove();
      }
    });

    it('waits for a newer frame than a stale one when the pointer did not open the overlay', async () => {
      let now = 1_000;
      const nowSpy = jest
        .spyOn(performance, 'now')
        .mockImplementation(() => now);
      let landSecond: (value: { dataUrl: string }) => void = () => undefined;
      browserApi.screenshot
        .mockResolvedValueOnce({ dataUrl: 'data:image/jpeg;base64,first' })
        .mockReturnValueOnce(
          new Promise<{ dataUrl: string }>((resolve) => {
            landSecond = resolve;
          }),
        );
      seedLiveBrowser();
      const { container, root } = mount(
        <BrowserPane
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          browserId={BROWSER_ID}
          visible
        />,
      );
      const control = document.createElement('button');
      document.body.appendChild(control);
      const overlay = document.createElement('div');
      overlay.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');
      try {
        await flushFrames(1);
        await act(async () => {
          control.dispatchEvent(new Event('pointerover', { bubbles: true }));
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        });
        await flushFrames(3);
        expect(freezeFrame(container)?.getAttribute('src')).toBe(
          'data:image/jpeg;base64,first',
        );

        // Much later, a toast or a shortcut opens an overlay: the page may
        // have changed since, so a new frame is taken before covering it.
        now += 5_000;
        browserApi.setVisible.mockClear();
        document.body.appendChild(overlay);
        await flushFrames(2);
        expect(browserApi.screenshot).toHaveBeenCalledTimes(2);
        expect(hiddenCalls()).toBe(0);
        // Covered but not frozen yet: the above-browser mirror draws the
        // overlay over the live page meanwhile.
        const pageArea = container.querySelector(
          '[data-testid="browser-page-area"]',
        );
        expect(pageArea?.getAttribute('data-browser-native-view-covered')).toBe(
          'true',
        );
        expect(pageArea?.getAttribute('data-browser-native-view-frozen')).toBe(
          'false',
        );

        await act(async () => {
          landSecond({ dataUrl: 'data:image/jpeg;base64,second' });
          await Promise.resolve();
          await Promise.resolve();
        });
        await flushFrames(3);
        expect(freezeFrame(container)?.getAttribute('src')).toBe(
          'data:image/jpeg;base64,second',
        );
        expect(hiddenCalls()).toBeGreaterThan(0);
        expect(
          container
            .querySelector('[data-testid="browser-page-area"]')
            ?.getAttribute('data-browser-native-view-frozen'),
        ).toBe('true');
      } finally {
        nowSpy.mockRestore();
        act(() => root.unmount());
        container.remove();
        control.remove();
        overlay.remove();
      }
    });

    it('waits for a newer frame when a press opens an overlay over an old one', async () => {
      let now = 1_000;
      const nowSpy = jest
        .spyOn(performance, 'now')
        .mockImplementation(() => now);
      let landSecond: (value: { dataUrl: string }) => void = () => undefined;
      browserApi.screenshot
        .mockResolvedValueOnce({ dataUrl: 'data:image/jpeg;base64,first' })
        .mockReturnValueOnce(
          new Promise<{ dataUrl: string }>((resolve) => {
            landSecond = resolve;
          }),
        );
      seedLiveBrowser();
      const { container, root } = mount(
        <BrowserPane
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          browserId={BROWSER_ID}
          visible
        />,
      );
      const control = document.createElement('button');
      document.body.appendChild(control);
      const overlay = document.createElement('div');
      overlay.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');
      try {
        await flushFrames(1);
        await act(async () => {
          control.dispatchEvent(new Event('pointerover', { bubbles: true }));
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        });
        await flushFrames(3);

        // Much later (the page may have scrolled since), a press opens an
        // overlay: the old frame does not cover the page.
        now += 5_000;
        browserApi.setVisible.mockClear();
        control.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        document.body.appendChild(overlay);
        await flushFrames(2);
        expect(browserApi.screenshot).toHaveBeenCalledTimes(2);
        expect(hiddenCalls()).toBe(0);

        await act(async () => {
          landSecond({ dataUrl: 'data:image/jpeg;base64,second' });
          await Promise.resolve();
          await Promise.resolve();
        });
        await flushFrames(3);
        expect(freezeFrame(container)?.getAttribute('src')).toBe(
          'data:image/jpeg;base64,second',
        );
        expect(hiddenCalls()).toBeGreaterThan(0);
      } finally {
        nowSpy.mockRestore();
        act(() => root.unmount());
        container.remove();
        control.remove();
        overlay.remove();
      }
    });

    it('drops a frame that no longer fits once the native view is back after a resize under an overlay', async () => {
      seedLiveBrowser();
      const { container, root } = mount(
        <BrowserPane
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          browserId={BROWSER_ID}
          visible
        />,
      );
      const control = document.createElement('button');
      document.body.appendChild(control);
      const overlay = document.createElement('div');
      overlay.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');
      try {
        await flushFrames(1);
        await act(async () => {
          control.dispatchEvent(new Event('pointerover', { bubbles: true }));
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        });
        await flushFrames(3);
        browserApi.setVisible.mockClear();
        control.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        document.body.appendChild(overlay);
        await flushFrames(2);
        expect(hiddenCalls()).toBeGreaterThan(0);

        // The window is resized while the overlay is open.
        boundingRectSpy.mockReturnValue({
          left: 100.4,
          top: 200.6,
          width: 500.2,
          height: 150.9,
          right: 600,
          bottom: 351,
          x: 100.4,
          y: 200.6,
          toJSON: () => ({}),
        });
        await flushFrames(2);
        // Still covering the page: it stays until the live view is back, and
        // fills the larger area from its top-left corner without stretching.
        const held = freezeFrame(container);
        expect(held).toBeInstanceOf(HTMLImageElement);
        expect(held?.getAttribute('data-testid')).toBe(
          'browser-pane-freeze-frame',
        );
        expect(held?.className).toEqual(
          expect.stringContaining('inset-0 h-full w-full object-cover'),
        );
        expect(held instanceof HTMLImageElement ? held.style.width : null).toBe(
          '',
        );

        overlay.remove();
        await flushFrames(4);
        expect(freezeFrame(container)).toBeNull();
      } finally {
        act(() => root.unmount());
        container.remove();
        control.remove();
        overlay.remove();
      }
    });

    it('captures for the current page while a capture for the previous page is still running', async () => {
      browserApi.screenshot.mockReturnValueOnce(
        new Promise<{ dataUrl: string }>(() => undefined),
      );
      seedLiveBrowser();
      const { container, root } = mount(
        <BrowserPane
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          browserId={BROWSER_ID}
          visible
        />,
      );
      const control = document.createElement('button');
      document.body.appendChild(control);
      const overlay = document.createElement('div');
      overlay.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');
      try {
        await flushFrames(1);
        await act(async () => {
          control.dispatchEvent(new Event('pointerover', { bubbles: true }));
          await Promise.resolve();
        });
        expect(browserApi.screenshot).toHaveBeenCalledTimes(1);

        // The page navigates before that capture returns.
        act(() => {
          seedLiveBrowser({ url: 'https://example.com/next' });
        });
        await flushFrames(1);
        document.body.appendChild(overlay);
        await flushFrames(1);
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(browserApi.screenshot).toHaveBeenCalledTimes(2);
        await flushFrames(3);
        expect(freezeFrame(container)?.getAttribute('src')).toBe(
          'data:image/png;base64,freeze',
        );
        expect(hiddenCalls()).toBeGreaterThan(0);
      } finally {
        act(() => root.unmount());
        container.remove();
        control.remove();
        overlay.remove();
      }
    });

    it('takes newer frames again after an overlay closed before its frame was on screen', async () => {
      let now = 1_000;
      const nowSpy = jest
        .spyOn(performance, 'now')
        .mockImplementation(() => now);
      let landFirst: (value: { dataUrl: string }) => void = () => undefined;
      browserApi.screenshot
        .mockReturnValueOnce(
          new Promise<{ dataUrl: string }>((resolve) => {
            landFirst = resolve;
          }),
        )
        .mockResolvedValueOnce({ dataUrl: 'data:image/jpeg;base64,second' });
      seedLiveBrowser();
      const { container, root } = mount(
        <BrowserPane
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          browserId={BROWSER_ID}
          visible
        />,
      );
      const control = document.createElement('button');
      document.body.appendChild(control);
      const overlay = document.createElement('div');
      overlay.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');
      try {
        await flushFrames(1);
        // A quick overlay with no frame yet opens and closes before its
        // capture returns; the native view was never hidden.
        document.body.appendChild(overlay);
        await flushFrames(1);
        overlay.remove();
        await flushFrames(1);
        await act(async () => {
          landFirst({ dataUrl: 'data:image/jpeg;base64,first' });
          await Promise.resolve();
          await Promise.resolve();
        });
        await flushFrames(3);
        expect(freezeFrame(container)?.getAttribute('src')).toBe(
          'data:image/jpeg;base64,first',
        );

        // Pointing at a control later replaces it with a newer frame.
        now += 5_000;
        await act(async () => {
          control.dispatchEvent(new Event('pointerover', { bubbles: true }));
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        });
        await flushFrames(3);
        expect(browserApi.screenshot).toHaveBeenCalledTimes(2);
        expect(freezeFrame(container)?.getAttribute('src')).toBe(
          'data:image/jpeg;base64,second',
        );
      } finally {
        nowSpy.mockRestore();
        act(() => root.unmount());
        container.remove();
        control.remove();
        overlay.remove();
      }
    });
  });

  it('marks the page area available from the live view, not from the freeze state', async () => {
    seedLiveBrowser();
    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible
      />,
    );
    const pageArea = (): Element | null =>
      container.querySelector('[data-testid="browser-page-area"]');
    const overlay = document.createElement('div');
    try {
      expect(
        pageArea()?.getAttribute('data-browser-native-view-available'),
      ).toBe('true');

      // Frozen under an overlay, the area still offers a live view, so the
      // notification corner can lift its toasts and let the page unfreeze.
      overlay.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');
      document.body.appendChild(overlay);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(container.querySelector('img[aria-hidden="true"]')).not.toBeNull();
      expect(
        pageArea()?.getAttribute('data-browser-native-view-available'),
      ).toBe('true');

      act(() => {
        root.render(
          <BrowserPane
            projectId={PROJECT_ID}
            worktreeId={WORKTREE_ID}
            browserId={BROWSER_ID}
            visible={false}
          />,
        );
      });
      expect(
        pageArea()?.getAttribute('data-browser-native-view-available'),
      ).toBe('false');
    } finally {
      act(() => root.unmount());
      container.remove();
      overlay.remove();
    }
  });

  it('renders an app-owned prompt, freezes the page, and returns the entered text', async () => {
    seedLiveBrowser();
    const dialog: BrowserJavaScriptDialog = {
      id: 'dialog-1',
      browserId: BROWSER_ID,
      type: 'prompt',
      message: 'What is your name?',
      defaultPrompt: 'Initial',
      url: 'http://localhost:3000/form',
      openedAt: 10,
    };
    browserApi.getDialog.mockResolvedValue(dialog);

    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible
      />,
    );
    try {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const modal = container.querySelector(
        '[data-testid="browser-javascript-dialog"]',
      );
      const input = container.querySelector<HTMLInputElement>(
        'input[aria-label="Response"]',
      );
      expect(modal?.getAttribute('aria-modal')).toBe('true');
      expect(input?.value).toBe('Initial');
      expect(browserApi.screenshot).toHaveBeenCalledWith({
        browserId: BROWSER_ID,
        purpose: 'freeze-frame',
      });
      expect(browserApi.setVisible).toHaveBeenCalledWith({
        browserId: BROWSER_ID,
        visible: false,
      });

      await act(async () => {
        if (!input) throw new Error('Expected prompt input.');
        // React tracks the instance setter, so use the native setter with an
        // explicit receiver to produce a real controlled-input change.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set;
        if (valueSetter) {
          Reflect.apply(valueSetter, input, ['Ada']);
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        container
          .querySelector<HTMLButtonElement>('button[type="submit"]')
          ?.click();
        await Promise.resolve();
      });

      expect(browserApi.handleDialog).toHaveBeenCalledWith({
        browserId: BROWSER_ID,
        dialogId: 'dialog-1',
        accept: true,
        promptText: 'Ada',
      });
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('hides the view on unmount', () => {
    seedLiveBrowser();
    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible
      />,
    );
    browserApi.setVisible.mockClear();
    act(() => root.unmount());
    container.remove();
    expect(browserApi.setVisible).toHaveBeenCalledWith({
      browserId: BROWSER_ID,
      visible: false,
    });
  });

  it('keeps about:blank panes in the pre-navigation empty state', () => {
    seedLiveBrowser({ url: 'about:blank' });
    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible
      />,
    );
    try {
      expect(container.textContent).toContain('Enter a URL to start.');
      expect(setBoundsArgs().some((arg) => arg.visible === true)).toBe(false);
      expect(browserApi.setVisible).toHaveBeenCalledWith({
        browserId: BROWSER_ID,
        visible: false,
      });
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('shows a failed-load state instead of exposing a blank native view', () => {
    seedLiveBrowser({
      status: 'failed',
      lastError: 'ERR_CONNECTION_REFUSED',
      url: 'http://localhost:3544/',
    });
    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible
      />,
    );
    try {
      expect(container.textContent).toContain('Unable to load page');
      expect(container.textContent).toContain('ERR_CONNECTION_REFUSED');
      expect(setBoundsArgs().some((arg) => arg.visible === true)).toBe(false);
      expect(browserApi.setVisible).toHaveBeenCalledWith({
        browserId: BROWSER_ID,
        visible: false,
      });
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

describe('BrowserPane opening a new tab', () => {
  function seedOpening(overrides: Partial<BrowserSessionSnapshot>): void {
    seedBrowser(overrides, { live: false });
    useBrowserStore.setState({ openingBrowserIds: { [BROWSER_ID]: true } });
  }

  afterEach(() => {
    useBrowserStore.setState({ openingBrowserIds: {} });
  });

  it('shows the prefilled URL and a labelled spinner while the session is created', () => {
    seedOpening({
      url: 'http://localhost:5173/app',
      status: 'loading',
      loading: true,
      title: '',
    });
    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible
      />,
    );
    try {
      expect(
        container.querySelector<HTMLInputElement>(
          '[data-testid="browser-url-input"]',
        )?.value,
      ).toBe('localhost:5173');
      expect(
        container.querySelector('[data-testid="browser-pane-loading"]')
          ?.textContent,
      ).toBe('Loading localhost:5173…');
      // No native view exists yet: nothing is shown or moved.
      expect(browserApi.setBounds).not.toHaveBeenCalled();
      expect(browserApi.setVisible).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('shows the normal empty state for a blank tab that is still opening', () => {
    seedOpening({ url: '', status: 'idle', loading: false, title: '' });
    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible
      />,
    );
    try {
      expect(
        container.querySelector('[data-testid="browser-pane-loading"]'),
      ).toBeNull();
      expect(container.textContent).toContain('Enter a URL to start.');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('shows a URL submitted before the session exists as loading, then navigates once it does', async () => {
    seedOpening({ url: '', status: 'idle', loading: false, title: '' });
    let finishCreate: (() => void) | undefined;
    browserApi.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCreate = (): void =>
            resolve(snapshot({ url: '', status: 'idle', title: '' }));
        }),
    );
    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible
      />,
    );
    try {
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="browser-url-input"]',
      );
      act(() => {
        setInputValue(input, 'http://localhost:5173/');
      });
      await act(async () => {
        input?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
        await Promise.resolve();
      });

      expect(
        container.querySelector('[data-testid="browser-pane-loading"]')
          ?.textContent,
      ).toBe('Loading localhost:5173…');
      expect(browserApi.navigate).not.toHaveBeenCalled();

      // The session lands blank; the submitted URL stays loading, then the
      // navigation is sent.
      useBrowserStore.setState({ openingBrowserIds: {} });
      await act(async () => {
        finishCreate?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(browserApi.navigate).toHaveBeenCalledWith({
        browserId: BROWSER_ID,
        url: 'http://localhost:5173/',
      });
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('navigates only the latest URL submitted while the tab is opening', async () => {
    seedOpening({ url: '', status: 'idle', loading: false, title: '' });
    let finishCreate: (() => void) | undefined;
    browserApi.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCreate = (): void =>
            resolve(snapshot({ url: '', status: 'idle', title: '' }));
        }),
    );
    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible
      />,
    );
    try {
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="browser-url-input"]',
      );
      for (const url of ['http://localhost:5173/', 'http://localhost:4000/']) {
        act(() => {
          setInputValue(input, url);
        });
        await act(async () => {
          input?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
          );
          await Promise.resolve();
        });
      }

      useBrowserStore.setState({ openingBrowserIds: {} });
      await act(async () => {
        finishCreate?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(browserApi.navigate).toHaveBeenCalledTimes(1);
      expect(browserApi.navigate).toHaveBeenCalledWith({
        browserId: BROWSER_ID,
        url: 'http://localhost:4000/',
      });
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('loads a URL submitted into an inert tab once, through its recreate', async () => {
    seedBrowser(
      { url: 'http://localhost:3000/', status: 'idle', loading: false },
      { live: false },
    );
    browserApi.create.mockImplementation((request: { url?: string }) =>
      Promise.resolve(
        snapshot({ url: request.url ?? '', status: 'loading', loading: true }),
      ),
    );
    // Hidden, so only the submitted URL recreates the view.
    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible={false}
      />,
    );
    try {
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="browser-url-input"]',
      );
      act(() => {
        setInputValue(input, 'http://localhost:5173/');
      });
      await act(async () => {
        input?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(browserApi.create).toHaveBeenCalledTimes(1);
      expect(browserApi.create).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'http://localhost:5173/' }),
      );
      expect(browserApi.navigate).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('offers Retry in the tab when the session could not be created', async () => {
    seedBrowser(
      {
        url: 'http://localhost:5173/',
        status: 'failed',
        loading: false,
        lastError: 'Profile unavailable',
      },
      { live: false },
    );
    // Hidden, so mounting does not already recreate it.
    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible={false}
      />,
    );
    try {
      const failed = container.querySelector(
        '[data-testid="browser-pane-failed"]',
      );
      expect(failed?.textContent).toContain("Couldn't open Browser");
      expect(failed?.textContent).toContain('Profile unavailable');
      const retry = failed?.querySelector('button');
      await act(async () => {
        retry?.click();
        await Promise.resolve();
      });
      expect(browserApi.create).toHaveBeenCalledWith(
        expect.objectContaining({
          browserId: BROWSER_ID,
          url: 'http://localhost:5173/',
        }),
      );
      expect(browserApi.navigate).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

describe('BrowserPane lazy live views + explicit activation', () => {
  it('a hidden RESTORED pane stays inert: no live-view creation, no IPC', () => {
    seedBrowser({ status: 'idle', loading: false }, { live: false });
    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible={false}
      />,
    );
    try {
      expect(browserApi.create).not.toHaveBeenCalled();
      expect(browserApi.setVisible).not.toHaveBeenCalled();
      expect(setBoundsArgs().some((arg) => arg.visible === true)).toBe(false);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('creates the live view lazily once the pane becomes visible', () => {
    seedBrowser({ status: 'idle', loading: false }, { live: false });
    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible
      />,
    );
    try {
      expect(browserApi.create).toHaveBeenCalledWith(
        expect.objectContaining({ browserId: BROWSER_ID }),
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('pointer interaction inside the pane explicitly activates its browser', () => {
    seedBrowser();
    const setActiveBrowser = jest.fn().mockResolvedValue(undefined);
    useBrowserStore.setState({ setActiveBrowser });
    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible
      />,
    );
    try {
      const pane = container.querySelector(
        `[data-testid="browser-pane-${BROWSER_ID}"]`,
      );
      expect(pane).not.toBeNull();
      act(() => {
        pane?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
      expect(setActiveBrowser).toHaveBeenCalledWith(
        PROJECT_ID,
        WORKTREE_ID,
        BROWSER_ID,
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

describe('BrowserPane download notices', () => {
  it('shows the download toast under the bar, outside the native page area', () => {
    seedLiveBrowser();
    useBrowserStore.setState({
      downloadToasts: {
        [BROWSER_ID]: {
          kind: 'download',
          id: 'download-1',
          browserId: BROWSER_ID,
          source: 'user',
          origin: 'http://localhost:3000/report.csv',
          fileName: 'report.csv',
          receivedBytes: 4,
          totalBytes: 4,
          status: 'complete',
          startedAt: 1,
        },
      },
    });
    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible
      />,
    );
    try {
      const pane = container.querySelector(
        `[data-testid="browser-pane-${BROWSER_ID}"]`,
      );
      const bar = pane?.querySelector('[data-testid="browser-bar"]');
      const toast = pane?.querySelector(
        '[data-testid="browser-download-toast"]',
      );
      expect(toast?.textContent).toContain('Downloaded report.csv');
      // A sibling that follows the bar, never inside the page's content rect.
      expect(toast?.closest('.bg-base.relative')).toBeNull();
      expect(
        bar && toast
          ? bar.compareDocumentPosition(toast) &
              Node.DOCUMENT_POSITION_FOLLOWING
          : 0,
      ).toBeTruthy();
    } finally {
      act(() => root.unmount());
      container.remove();
      useBrowserStore.setState({ downloadToasts: {} });
    }
  });
});

describe('BrowserPane session replay', () => {
  it('records the URL bar and blocks the page area and devtools', () => {
    seedLiveBrowser({ url: 'https://secret.example.test/account' });
    useBrowserStore.setState({ inspectorOpen: { [BROWSER_ID]: true } });
    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible
      />,
    );
    try {
      const pane = container.querySelector(
        `[data-testid="browser-pane-${BROWSER_ID}"]`,
      );
      expect(pane?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
      const url = container.querySelector('input');
      expect(url).not.toBeNull();
      expect(url?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
      // The page area and the devtools panel are the pane's only blocks,
      // both direct regions of its body row.
      const blocks = Array.from(
        pane?.querySelectorAll(`.${POSTHOG_REPLAY_BLOCK_CLASS}`) ?? [],
      );
      expect(blocks).toHaveLength(2);
      for (const block of blocks) {
        expect(block.parentElement?.parentElement).toBe(pane);
        expect(block.querySelector('input[type="url"], form')).toBeNull();
      }
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('mounts the page-area block with the pane after the first snapshot', () => {
    useBrowserStore.setState({ worktrees: {} });
    const { container, root } = mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible
      />,
    );
    try {
      // The placeholder carries no block: the block sits on the page area,
      // a child that mounts together with its content.
      const placeholder = container.firstElementChild;
      expect(placeholder?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(
        false,
      );
      act(() => seedLiveBrowser());
      const pane = container.querySelector(
        `[data-testid="browser-pane-${BROWSER_ID}"]`,
      );
      expect(pane).toBe(placeholder);
      expect(pane?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
      expect(pane?.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).not.toBe(
        null,
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

describe('BrowserPane early access', () => {
  afterEach(() => {
    resetExperimentalFeaturesStoreForTest();
  });

  function mountPaneWithDetails(): { container: HTMLElement; root: Root } {
    seedLiveBrowser();
    useBrowserStore.setState({ inspectorOpen: { [BROWSER_ID]: true } });
    return mount(
      <BrowserPane
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        browserId={BROWSER_ID}
        visible
      />,
    );
  }

  it('shows the address bar and closable details without a Labs opt-in', () => {
    const { container, root } = mountPaneWithDetails();
    try {
      const bar = container.querySelector('[data-testid="browser-bar"]');
      expect(bar).not.toBeNull();
      expect(bar?.getAttribute('data-variant')).toBe('address-bar');
      expect(
        container.querySelector('[data-testid="browser-url-input"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="browser-inspector-close"]'),
      ).not.toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('draws the address bar and a details close button when on', () => {
    setTestEarlyAccessFeatures({ enabled: true });
    const { container, root } = mountPaneWithDetails();
    try {
      expect(
        container
          .querySelector('[data-testid="browser-bar"]')
          ?.getAttribute('data-variant'),
      ).toBe('address-bar');
      const close = container.querySelector<HTMLButtonElement>(
        '[data-testid="browser-inspector-close"]',
      );
      expect(close).not.toBeNull();
      act(() => close?.click());
      expect(useBrowserStore.getState().inspectorOpen[BROWSER_ID]).toBe(false);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
