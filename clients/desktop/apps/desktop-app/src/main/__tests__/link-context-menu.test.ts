import type {
  BrowserWindow,
  ContextMenuParams,
  MenuItemConstructorOptions,
  WebContents,
} from 'electron';
import type * as LinkContextMenuModule from '../lib/link-context-menu';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPopup = jest.fn();
const mockBuildFromTemplate = jest.fn(
  (template: MenuItemConstructorOptions[]) => ({ template, popup: mockPopup }),
);
const mockWriteText = jest.fn<void, [string]>();
const mockIpcOn = jest.fn<void, [string, (...args: unknown[]) => void]>();

jest.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]): unknown =>
      mockBuildFromTemplate(template),
  },
  clipboard: {
    writeText: (text: string): void => mockWriteText(text),
  },
  ipcMain: {
    on: (channel: string, listener: (...args: unknown[]) => void): void =>
      mockIpcOn(channel, listener),
  },
}));

const mockIsE2eBuild = jest.fn<boolean, []>(() => false);
jest.mock('../lib/e2e-gate', () => ({
  isE2eBuild: (): boolean => mockIsE2eBuild(),
}));

jest.mock('../lib/main-process-logging', () => ({
  logMainProcessDebug: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ContextMenuInput = Pick<ContextMenuParams, 'linkURL' | 'isEditable'>;

const LINK = 'https://example.com/path?x=1#frag';

function linkInput(
  overrides: Partial<ContextMenuInput> = {},
): ContextMenuInput {
  return { linkURL: LINK, isEditable: false, ...overrides };
}

interface Deps {
  canOpenInBrowser: jest.Mock<boolean, []>;
  openInBrowser: jest.Mock<Promise<boolean>, [string]>;
  openExternal: jest.Mock<Promise<void>, [string]>;
}

function createDeps(canOpenInBrowser = true): Deps {
  return {
    canOpenInBrowser: jest.fn<boolean, []>(() => canOpenInBrowser),
    openInBrowser: jest.fn<Promise<boolean>, [string]>(() =>
      Promise.resolve(true),
    ),
    openExternal: jest.fn<Promise<void>, [string]>(() => Promise.resolve()),
  };
}

interface FakeWindow {
  window: BrowserWindow;
  contents: WebContents;
  rightClick: (input: ContextMenuInput) => void;
}

function createFakeWindow(id: number): FakeWindow {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const contents = {
    on: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
    }),
  };
  const window = { id, webContents: contents } as unknown as BrowserWindow;
  return {
    window,
    contents: contents as unknown as WebContents,
    rightClick: (input): void => {
      const listener = listeners.get('context-menu');
      if (!listener) throw new Error('context-menu listener not attached');
      listener({ preventDefault: jest.fn() }, input);
    },
  };
}

async function loadModule(): Promise<typeof LinkContextMenuModule> {
  let loaded: typeof LinkContextMenuModule | undefined;
  await jest.isolateModulesAsync(async (): Promise<void> => {
    loaded = await import('../lib/link-context-menu');
  });
  if (!loaded) throw new Error('Failed to load link-context-menu module');
  return loaded;
}

function lastTemplate(): MenuItemConstructorOptions[] {
  const call = mockBuildFromTemplate.mock.calls.at(-1);
  if (!call) throw new Error('no menu was built');
  return call[0];
}

function clickTemplateItem(label: string): void {
  const item = lastTemplate().find((entry) => entry.label === label);
  if (!item?.click) throw new Error(`no clickable ${label} item`);
  // The handlers ignore Electron's (menuItem, window, event) arguments.
  Reflect.apply(item.click, undefined, []);
}

const E2E_CLICK_CHANNEL = 'e2e:link-context-menu-click';

function e2eClickListener(): (...args: unknown[]) => void {
  const registration = mockIpcOn.mock.calls.find(
    ([channel]) => channel === E2E_CLICK_CHANNEL,
  );
  if (!registration) throw new Error('E2E click listener not registered');
  return registration[1];
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsE2eBuild.mockReturnValue(false);
  delete globalThis.__CANOPY_E2E_LINK_CONTEXT_MENU__;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildLinkContextMenuItems', () => {
  it('lists Copy link, Open in browser, Open in external browser in order', async () => {
    const { buildLinkContextMenuItems } = await loadModule();
    expect(
      buildLinkContextMenuItems(linkInput(), { canOpenInBrowser: true }),
    ).toEqual({
      url: LINK,
      items: [
        { id: 'copyLink', label: 'Copy link' },
        { id: 'openInBrowser', label: 'Open in browser' },
        { id: 'openExternal', label: 'Open in external browser' },
      ],
    });
  });

  it('omits Open in browser without a browser target', async () => {
    const { buildLinkContextMenuItems } = await loadModule();
    expect(
      buildLinkContextMenuItems(linkInput(), { canOpenInBrowser: false })
        ?.items,
    ).toEqual([
      { id: 'copyLink', label: 'Copy link' },
      { id: 'openExternal', label: 'Open in external browser' },
    ]);
  });

  it.each([
    ['an empty link', linkInput({ linkURL: '' })],
    ['an editable target', linkInput({ isEditable: true })],
    ['a mailto: link', linkInput({ linkURL: 'mailto:someone@example.com' })],
    ['a javascript: link', linkInput({ linkURL: 'javascript:alert(1)' })],
    ['a file: link', linkInput({ linkURL: 'file:///etc/hosts' })],
  ])('returns null for %s', async (_name, input) => {
    const { buildLinkContextMenuItems } = await loadModule();
    expect(
      buildLinkContextMenuItems(input, { canOpenInBrowser: true }),
    ).toBeNull();
  });
});

describe('shouldOfferOpenInBrowser', () => {
  it.each([
    ['main', true, true, true],
    ['aux', false, true, true],
    ['main', true, false, false],
    ['aux', false, false, false],
    ['app-advisor', false, true, false],
    ['unknown', false, true, false],
    // A remote-control client window loads the main renderer URL, so its
    // label reads 'main', but it shows another computer.
    ['main', false, true, false],
  ] as const)(
    'label %s, isMainWindow=%s, available=%s -> %s',
    async (label, isMainWindow, available, expected) => {
      const { shouldOfferOpenInBrowser } = await loadModule();
      expect(shouldOfferOpenInBrowser({ label, isMainWindow, available })).toBe(
        expected,
      );
    },
  );
});

describe('link browser target availability', () => {
  it('defaults to unavailable and stores reports', async () => {
    const { isLinkBrowserTargetAvailable, setLinkBrowserTargetAvailable } =
      await loadModule();
    expect(isLinkBrowserTargetAvailable()).toBe(false);
    setLinkBrowserTargetAvailable(true);
    expect(isLinkBrowserTargetAvailable()).toBe(true);
    setLinkBrowserTargetAvailable(false);
    expect(isLinkBrowserTargetAvailable()).toBe(false);
  });
});

describe('runLinkContextMenuAction', () => {
  it('copies the full resolved URL', async () => {
    const { runLinkContextMenuAction } = await loadModule();
    runLinkContextMenuAction('copyLink', LINK, createDeps());
    expect(mockWriteText).toHaveBeenCalledWith(LINK);
  });

  it('routes each open action to its dependency', async () => {
    const { runLinkContextMenuAction } = await loadModule();
    const deps = createDeps();
    runLinkContextMenuAction('openInBrowser', LINK, deps);
    runLinkContextMenuAction('openExternal', LINK, deps);
    expect(deps.openInBrowser).toHaveBeenCalledWith(LINK);
    expect(deps.openExternal).toHaveBeenCalledWith(LINK);
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('swallows rejected and declined opens', async () => {
    const { runLinkContextMenuAction } = await loadModule();
    const deps = createDeps();
    deps.openInBrowser.mockResolvedValueOnce(false);
    deps.openExternal.mockRejectedValueOnce(new Error('denied'));
    expect(() => {
      runLinkContextMenuAction('openInBrowser', LINK, deps);
      runLinkContextMenuAction('openExternal', LINK, deps);
    }).not.toThrow();
    deps.openInBrowser.mockRejectedValueOnce(new Error('gone'));
    runLinkContextMenuAction('openInBrowser', LINK, deps);
    await flushPromises();
  });
});

describe('attachLinkContextMenu (production)', () => {
  it('pops up the menu at the pointer for the window', async () => {
    const { attachLinkContextMenu } = await loadModule();
    const fake = createFakeWindow(4);
    const deps = createDeps();
    attachLinkContextMenu(fake.window, deps);
    fake.rightClick(linkInput());

    expect(lastTemplate().map((item) => item.label)).toEqual([
      'Copy link',
      'Open in browser',
      'Open in external browser',
    ]);
    expect(mockPopup).toHaveBeenCalledWith({ window: fake.window });
    clickTemplateItem('Open in browser');
    expect(deps.openInBrowser).toHaveBeenCalledWith(LINK);
    clickTemplateItem('Copy link');
    expect(mockWriteText).toHaveBeenCalledWith(LINK);
  });

  it('evaluates canOpenInBrowser at right-click time', async () => {
    const { attachLinkContextMenu } = await loadModule();
    const fake = createFakeWindow(4);
    const deps = createDeps(true);
    attachLinkContextMenu(fake.window, deps);
    deps.canOpenInBrowser.mockReturnValue(false);
    fake.rightClick(linkInput());
    expect(lastTemplate().map((item) => item.label)).toEqual([
      'Copy link',
      'Open in external browser',
    ]);
  });

  it('shows nothing for non-link, editable and non-http targets', async () => {
    const { attachLinkContextMenu } = await loadModule();
    const fake = createFakeWindow(4);
    attachLinkContextMenu(fake.window, createDeps());
    fake.rightClick(linkInput({ linkURL: '' }));
    fake.rightClick(linkInput({ isEditable: true }));
    fake.rightClick(linkInput({ linkURL: 'mailto:someone@example.com' }));
    expect(mockBuildFromTemplate).not.toHaveBeenCalled();
    expect(mockPopup).not.toHaveBeenCalled();
  });

  it('pops up a view-hosted page menu in its host window', async () => {
    const { attachLinkContextMenuToContents } = await loadModule();
    const host = createFakeWindow(9);
    const view = createFakeWindow(10);
    attachLinkContextMenuToContents(
      view.contents,
      () => host.window,
      createDeps(),
    );
    view.rightClick(linkInput());
    expect(mockPopup).toHaveBeenCalledWith({ window: host.window });
  });

  it('skips the menu when the view has no host window', async () => {
    const { attachLinkContextMenuToContents } = await loadModule();
    const view = createFakeWindow(10);
    attachLinkContextMenuToContents(view.contents, () => null, createDeps());
    view.rightClick(linkInput());
    expect(mockPopup).not.toHaveBeenCalled();
  });

  it('never registers the E2E click listener', async () => {
    const { attachLinkContextMenu } = await loadModule();
    attachLinkContextMenu(createFakeWindow(1).window, createDeps());
    expect(mockIpcOn).not.toHaveBeenCalled();
  });
});

describe('attachLinkContextMenu (E2E build)', () => {
  beforeEach(() => {
    mockIsE2eBuild.mockReturnValue(true);
  });

  it('records the menu instead of popping it up', async () => {
    const { attachLinkContextMenu } = await loadModule();
    const fake = createFakeWindow(7);
    attachLinkContextMenu(fake.window, createDeps(false));
    fake.rightClick(linkInput());
    fake.rightClick(linkInput());

    expect(mockPopup).not.toHaveBeenCalled();
    expect(globalThis.__CANOPY_E2E_LINK_CONTEXT_MENU__).toEqual({
      count: 2,
      windowId: 7,
      url: LINK,
      items: [
        { id: 'copyLink', label: 'Copy link' },
        { id: 'openExternal', label: 'Open in external browser' },
      ],
    });
  });

  it('records nothing when no menu applies', async () => {
    const { attachLinkContextMenu } = await loadModule();
    const fake = createFakeWindow(7);
    attachLinkContextMenu(fake.window, createDeps());
    fake.rightClick(linkInput({ linkURL: 'mailto:someone@example.com' }));
    fake.rightClick(linkInput({ isEditable: true }));
    expect(globalThis.__CANOPY_E2E_LINK_CONTEXT_MENU__).toBeUndefined();
  });

  it('registers one click listener and runs it for the last menu', async () => {
    const { attachLinkContextMenu } = await loadModule();
    const first = createFakeWindow(1);
    const second = createFakeWindow(2);
    const firstDeps = createDeps();
    const secondDeps = createDeps();
    attachLinkContextMenu(first.window, firstDeps);
    attachLinkContextMenu(second.window, secondDeps);
    expect(
      mockIpcOn.mock.calls.filter(([channel]) => channel === E2E_CLICK_CHANNEL),
    ).toHaveLength(1);

    first.rightClick(linkInput({ linkURL: 'https://first.example/' }));
    second.rightClick(linkInput());
    const click = e2eClickListener();
    click({}, 'openInBrowser');
    click({}, 'openExternal');
    click({}, 'copyLink');
    click({}, 'bogus');

    expect(firstDeps.openInBrowser).not.toHaveBeenCalled();
    expect(secondDeps.openInBrowser).toHaveBeenCalledWith(LINK);
    expect(secondDeps.openExternal).toHaveBeenCalledWith(LINK);
    expect(mockWriteText).toHaveBeenCalledWith(LINK);
  });

  it('ignores clicks before any menu was recorded', async () => {
    const { attachLinkContextMenu } = await loadModule();
    const deps = createDeps();
    attachLinkContextMenu(createFakeWindow(1).window, deps);
    e2eClickListener()({}, 'openExternal');
    expect(deps.openExternal).not.toHaveBeenCalled();
  });
});
