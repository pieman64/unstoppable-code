import type {
  BrowserWindow,
  ContextMenuParams,
  EditFlags,
  MenuItemConstructorOptions,
  WebContents,
} from 'electron';
import type * as EditableContextMenuModule from '../lib/editable-context-menu';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPopup = jest.fn();
const mockBuildFromTemplate = jest.fn(
  (template: MenuItemConstructorOptions[]) => ({ template, popup: mockPopup }),
);
const mockAvailableFormats = jest.fn<string[], []>(() => ['text/plain']);
const mockIpcOn = jest.fn<void, [string, (...args: unknown[]) => void]>();

jest.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]): unknown =>
      mockBuildFromTemplate(template),
  },
  clipboard: {
    availableFormats: (): string[] => mockAvailableFormats(),
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ContextMenuInput = Pick<ContextMenuParams, 'isEditable' | 'editFlags'>;

const ALL_EDIT_FLAGS: EditFlags = {
  canUndo: true,
  canRedo: true,
  canCut: true,
  canCopy: true,
  canPaste: true,
  canDelete: true,
  canSelectAll: true,
  canEditRichly: true,
};

function contextMenuInput(
  overrides: { isEditable?: boolean; editFlags?: Partial<EditFlags> } = {},
): ContextMenuInput {
  return {
    isEditable: overrides.isEditable ?? true,
    editFlags: { ...ALL_EDIT_FLAGS, ...overrides.editFlags },
  };
}

interface FakeWindow {
  window: BrowserWindow;
  contents: {
    cut: jest.Mock;
    copy: jest.Mock;
    paste: jest.Mock;
    selectAll: jest.Mock;
    isDestroyed: jest.Mock<boolean, []>;
  };
  rightClick: (input: ContextMenuInput) => void;
}

function createFakeWindow(id: number): FakeWindow {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const contents = {
    on: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
    }),
    cut: jest.fn(),
    copy: jest.fn(),
    paste: jest.fn(),
    selectAll: jest.fn(),
    isDestroyed: jest.fn<boolean, []>(() => false),
  };
  const window = { id, webContents: contents } as unknown as BrowserWindow;
  return {
    window,
    contents,
    rightClick: (input): void => {
      const listener = listeners.get('context-menu');
      if (!listener) throw new Error('context-menu listener not attached');
      listener({ preventDefault: jest.fn() }, input);
    },
  };
}

async function loadModule(): Promise<typeof EditableContextMenuModule> {
  let loaded: typeof EditableContextMenuModule | undefined;
  await jest.isolateModulesAsync(async (): Promise<void> => {
    loaded = await import('../lib/editable-context-menu');
  });
  if (!loaded) throw new Error('Failed to load editable-context-menu module');
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

const E2E_CLICK_CHANNEL = 'e2e:editable-context-menu-click';

function e2eClickListener(): (...args: unknown[]) => void {
  const registration = mockIpcOn.mock.calls.find(
    ([channel]) => channel === E2E_CLICK_CHANNEL,
  );
  if (!registration) throw new Error('E2E click listener not registered');
  return registration[1];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsE2eBuild.mockReturnValue(false);
  mockAvailableFormats.mockReturnValue(['text/plain']);
  delete globalThis.__CANOPY_E2E_EDITABLE_CONTEXT_MENU__;
});

// ---------------------------------------------------------------------------
// buildEditableContextMenuItems
// ---------------------------------------------------------------------------

describe('buildEditableContextMenuItems', () => {
  const macEnvironment = {
    clipboardHasContent: true,
    platform: 'darwin' as const,
  };

  test('returns null outside editable fields so no menu is shown', async () => {
    const { buildEditableContextMenuItems } = await loadModule();

    expect(
      buildEditableContextMenuItems(
        contextMenuInput({ isEditable: false }),
        macEnvironment,
      ),
    ).toBeNull();
  });

  test('lists Cut, Copy, Paste and Select All, all enabled when allowed', async () => {
    const { buildEditableContextMenuItems } = await loadModule();

    expect(
      buildEditableContextMenuItems(contextMenuInput(), macEnvironment),
    ).toEqual([
      { id: 'cut', label: 'Cut', enabled: true },
      { id: 'copy', label: 'Copy', enabled: true },
      { id: 'paste', label: 'Paste', enabled: true },
      { id: 'selectAll', label: 'Select All', enabled: true },
    ]);
  });

  test('disables Cut and Copy without a selection', async () => {
    const { buildEditableContextMenuItems } = await loadModule();

    const items = buildEditableContextMenuItems(
      contextMenuInput({ editFlags: { canCut: false, canCopy: false } }),
      macEnvironment,
    );

    expect(items?.map((item) => [item.id, item.enabled])).toEqual([
      ['cut', false],
      ['copy', false],
      ['paste', true],
      ['selectAll', true],
    ]);
  });

  test('disables Paste when the field cannot paste', async () => {
    const { buildEditableContextMenuItems } = await loadModule();

    const items = buildEditableContextMenuItems(
      contextMenuInput({ editFlags: { canPaste: false } }),
      macEnvironment,
    );

    expect(items?.find((item) => item.id === 'paste')?.enabled).toBe(false);
  });

  test('disables Paste on an empty clipboard even though Blink allows it', async () => {
    const { buildEditableContextMenuItems } = await loadModule();

    const items = buildEditableContextMenuItems(contextMenuInput(), {
      clipboardHasContent: false,
      platform: 'darwin',
    });

    expect(items?.find((item) => item.id === 'paste')?.enabled).toBe(false);
  });

  test('disables Select All when the field has nothing to select', async () => {
    const { buildEditableContextMenuItems } = await loadModule();

    const items = buildEditableContextMenuItems(
      contextMenuInput({ editFlags: { canSelectAll: false } }),
      macEnvironment,
    );

    expect(items?.find((item) => item.id === 'selectAll')?.enabled).toBe(false);
  });

  test('shows shortcut hints on Windows', async () => {
    const { buildEditableContextMenuItems } = await loadModule();

    const items = buildEditableContextMenuItems(contextMenuInput(), {
      clipboardHasContent: true,
      platform: 'win32',
    });

    expect(items?.map((item) => item.accelerator)).toEqual([
      'CmdOrCtrl+X',
      'CmdOrCtrl+C',
      'CmdOrCtrl+V',
      'CmdOrCtrl+A',
    ]);
  });

  test('omits shortcut hints on macOS', async () => {
    const { buildEditableContextMenuItems } = await loadModule();

    const items = buildEditableContextMenuItems(
      contextMenuInput(),
      macEnvironment,
    );

    expect(items?.every((item) => item.accelerator === undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isEditableContextMenuAction / runEditableContextMenuAction
// ---------------------------------------------------------------------------

describe('isEditableContextMenuAction', () => {
  test('accepts only the four menu actions', async () => {
    const { isEditableContextMenuAction } = await loadModule();

    for (const id of ['cut', 'copy', 'paste', 'selectAll']) {
      expect(isEditableContextMenuAction(id)).toBe(true);
    }
    for (const value of ['undo', 'delete', 'SelectAll', '', 1, null, {}]) {
      expect(isEditableContextMenuAction(value)).toBe(false);
    }
  });
});

describe('runEditableContextMenuAction', () => {
  test.each([
    ['cut', 'cut'],
    ['copy', 'copy'],
    ['paste', 'paste'],
    ['selectAll', 'selectAll'],
  ] as const)('%s calls webContents.%s once', async (id, method) => {
    const { runEditableContextMenuAction } = await loadModule();
    const { window, contents } = createFakeWindow(1);

    runEditableContextMenuAction(window.webContents, id);

    expect(contents[method]).toHaveBeenCalledTimes(1);
    for (const other of ['cut', 'copy', 'paste', 'selectAll'] as const) {
      if (other !== method) expect(contents[other]).not.toHaveBeenCalled();
    }
  });

  test('does nothing on a destroyed webContents', async () => {
    const { runEditableContextMenuAction } = await loadModule();
    const { window, contents } = createFakeWindow(1);
    contents.isDestroyed.mockReturnValue(true);

    runEditableContextMenuAction(window.webContents, 'paste');

    expect(contents.paste).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// attachEditableContextMenu — production
// ---------------------------------------------------------------------------

describe('attachEditableContextMenu (production build)', () => {
  test('pops up a four-item menu at the pointer for an editable field', async () => {
    const { attachEditableContextMenu } = await loadModule();
    const { window, rightClick } = createFakeWindow(3);
    attachEditableContextMenu(window);

    rightClick(contextMenuInput());

    expect(lastTemplate().map((item) => item.label)).toEqual([
      'Cut',
      'Copy',
      'Paste',
      'Select All',
    ]);
    expect(mockPopup).toHaveBeenCalledTimes(1);
    expect(mockPopup).toHaveBeenCalledWith({ window });
    expect(mockIpcOn).not.toHaveBeenCalled();
    expect(globalThis.__CANOPY_E2E_EDITABLE_CONTEXT_MENU__).toBeUndefined();
  });

  test('serves a page hosted in a view, over the window that holds it now', async () => {
    const { attachEditableContextMenuToContents } = await loadModule();
    const { contents, rightClick } = createFakeWindow(3);
    const first = { id: 7 } as unknown as BrowserWindow;
    const second = { id: 8 } as unknown as BrowserWindow;
    let host: BrowserWindow | null = first;
    attachEditableContextMenuToContents(
      contents as unknown as WebContents,
      () => host,
    );

    rightClick(contextMenuInput());
    expect(mockPopup).toHaveBeenLastCalledWith({ window: first });

    // The view moved to another window: the menu follows it.
    host = second;
    rightClick(contextMenuInput());
    expect(mockPopup).toHaveBeenLastCalledWith({ window: second });
    expect(lastTemplate().map((item) => item.label)).toEqual([
      'Cut',
      'Copy',
      'Paste',
      'Select All',
    ]);
  });

  test('shows nothing outside editable fields', async () => {
    const { attachEditableContextMenu } = await loadModule();
    const { window, rightClick } = createFakeWindow(3);
    attachEditableContextMenu(window);

    rightClick(contextMenuInput({ isEditable: false }));

    expect(mockBuildFromTemplate).not.toHaveBeenCalled();
    expect(mockPopup).not.toHaveBeenCalled();
  });

  test('reads the clipboard to enable Paste', async () => {
    const { attachEditableContextMenu } = await loadModule();
    const { window, rightClick } = createFakeWindow(3);
    attachEditableContextMenu(window);
    mockAvailableFormats.mockReturnValue([]);

    rightClick(contextMenuInput());

    expect(lastTemplate().find((item) => item.label === 'Paste')?.enabled).toBe(
      false,
    );
  });

  test.each([
    ['Cut', 'cut'],
    ['Copy', 'copy'],
    ['Paste', 'paste'],
    ['Select All', 'selectAll'],
  ] as const)(
    'clicking %s runs webContents.%s once on the right-clicked window',
    async (label, method) => {
      const { attachEditableContextMenu } = await loadModule();
      const { window, contents, rightClick } = createFakeWindow(3);
      attachEditableContextMenu(window);

      rightClick(contextMenuInput());
      clickTemplateItem(label);

      expect(contents[method]).toHaveBeenCalledTimes(1);
    },
  );

  test('a click after the window closed does nothing', async () => {
    const { attachEditableContextMenu } = await loadModule();
    const { window, contents, rightClick } = createFakeWindow(3);
    attachEditableContextMenu(window);

    rightClick(contextMenuInput());
    contents.isDestroyed.mockReturnValue(true);
    clickTemplateItem('Paste');

    expect(contents.paste).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// attachEditableContextMenu — E2E seam
// ---------------------------------------------------------------------------

describe('attachEditableContextMenu (E2E build)', () => {
  beforeEach(() => {
    mockIsE2eBuild.mockReturnValue(true);
  });

  test('records the menu instead of popping it up', async () => {
    const { attachEditableContextMenu } = await loadModule();
    const { window, rightClick } = createFakeWindow(5);
    attachEditableContextMenu(window);

    rightClick(contextMenuInput({ editFlags: { canCut: false } }));

    expect(mockPopup).not.toHaveBeenCalled();
    expect(mockBuildFromTemplate).not.toHaveBeenCalled();
    const record = globalThis.__CANOPY_E2E_EDITABLE_CONTEXT_MENU__;
    expect(record?.count).toBe(1);
    expect(record?.windowId).toBe(5);
    expect(record?.items.map((item) => [item.id, item.enabled])).toEqual([
      ['cut', false],
      ['copy', true],
      ['paste', true],
      ['selectAll', true],
    ]);
  });

  test('counts every presented menu and records the latest window', async () => {
    const { attachEditableContextMenu } = await loadModule();
    const first = createFakeWindow(5);
    const second = createFakeWindow(9);
    attachEditableContextMenu(first.window);
    attachEditableContextMenu(second.window);

    first.rightClick(contextMenuInput());
    first.rightClick(contextMenuInput({ isEditable: false }));
    second.rightClick(contextMenuInput());

    expect(globalThis.__CANOPY_E2E_EDITABLE_CONTEXT_MENU__).toMatchObject({
      count: 2,
      windowId: 9,
    });
  });

  test('registers the click listener once however many windows attach', async () => {
    const { attachEditableContextMenu } = await loadModule();
    attachEditableContextMenu(createFakeWindow(5).window);
    attachEditableContextMenu(createFakeWindow(9).window);

    expect(
      mockIpcOn.mock.calls.filter(([channel]) => channel === E2E_CLICK_CHANNEL),
    ).toHaveLength(1);
  });

  test('a click runs the action once on the window that presented the last menu', async () => {
    const { attachEditableContextMenu } = await loadModule();
    const first = createFakeWindow(5);
    const second = createFakeWindow(9);
    attachEditableContextMenu(first.window);
    attachEditableContextMenu(second.window);

    first.rightClick(contextMenuInput());
    second.rightClick(contextMenuInput());
    e2eClickListener()({}, 'paste');

    expect(second.contents.paste).toHaveBeenCalledTimes(1);
    expect(first.contents.paste).not.toHaveBeenCalled();
  });

  test('ignores unknown click payloads', async () => {
    const { attachEditableContextMenu } = await loadModule();
    const { window, contents, rightClick } = createFakeWindow(5);
    attachEditableContextMenu(window);

    rightClick(contextMenuInput());
    e2eClickListener()({}, 'undo');
    e2eClickListener()({}, undefined);

    for (const method of ['cut', 'copy', 'paste', 'selectAll'] as const) {
      expect(contents[method]).not.toHaveBeenCalled();
    }
  });

  test('a click before any menu was presented does nothing', async () => {
    const { attachEditableContextMenu } = await loadModule();
    const { window, contents } = createFakeWindow(5);
    attachEditableContextMenu(window);

    e2eClickListener()({}, 'paste');

    expect(contents.paste).not.toHaveBeenCalled();
  });
});
