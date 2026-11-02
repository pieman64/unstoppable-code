import type { MenuItem, MenuItemConstructorOptions } from 'electron';
import { Menu } from 'electron';
import {
  buildApplicationMenuTemplate,
  handleCloseWindowClick,
  installApplicationMenu,
  shouldBlockBeforeInput,
  type BeforeInputGuardInput,
} from '../menu';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('electron', () => ({
  Menu: {
    buildFromTemplate: jest.fn((template: unknown): { template: unknown } => ({
      template,
    })),
    setApplicationMenu: jest.fn(),
  },
}));

jest.mock('@electron-toolkit/utils', () => ({
  is: { dev: false },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MenuItemTemplateItem = MenuItem | MenuItemConstructorOptions;

function flattenItems(
  items: MenuItemConstructorOptions[],
): MenuItemConstructorOptions[];
function flattenItems(items: MenuItemTemplateItem[]): MenuItemTemplateItem[];
function flattenItems(items: MenuItemTemplateItem[]): MenuItemTemplateItem[] {
  const flat: MenuItemTemplateItem[] = [];
  for (const item of items) {
    flat.push(item);
    if (Array.isArray(item.submenu)) {
      flat.push(...flattenItems(item.submenu));
    }
  }
  return flat;
}

const PLAIN_RELOAD_ACCELERATORS = [
  'cmdorctrl+r',
  'commandorcontrol+r',
  'ctrl+r',
  'control+r',
  'cmd+r',
  'command+r',
];

const PLAIN_CLOSE_ACCELERATORS = [
  'cmdorctrl+w',
  'commandorcontrol+w',
  'ctrl+w',
  'control+w',
  'cmd+w',
  'command+w',
];

const ALL_OPTION_COMBOS = [
  { isMac: true, isDev: true },
  { isMac: true, isDev: false },
  { isMac: false, isDev: true },
  { isMac: false, isDev: false },
];

function keyDownInput(
  overrides: Partial<BeforeInputGuardInput>,
): BeforeInputGuardInput {
  return {
    type: 'keyDown',
    code: '',
    alt: false,
    control: false,
    meta: false,
    shift: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildApplicationMenuTemplate
// ---------------------------------------------------------------------------

describe('buildApplicationMenuTemplate', () => {
  it.each(ALL_OPTION_COMBOS)(
    'never binds a plain Ctrl/Cmd+R accelerator (isMac=$isMac isDev=$isDev)',
    (options) => {
      const flat = flattenItems(buildApplicationMenuTemplate(options));
      for (const item of flat) {
        if (typeof item.accelerator === 'string') {
          expect(PLAIN_RELOAD_ACCELERATORS).not.toContain(
            item.accelerator.toLowerCase(),
          );
        }
      }
    },
  );

  it.each(ALL_OPTION_COMBOS)(
    'gives every reload-family role an explicit non-conflicting accelerator (isMac=$isMac isDev=$isDev)',
    (options) => {
      const flat = flattenItems(buildApplicationMenuTemplate(options));
      const reloadItems = flat.filter(
        (item) => item.role === 'reload' || item.role === 'forceReload',
      );
      for (const item of reloadItems) {
        // A reload role without an explicit accelerator falls back to the
        // Electron default (plain CmdOrCtrl+R), which steals Ctrl+R from the
        // integrated terminal on Windows/Linux.
        expect(item.accelerator).toBe('CmdOrCtrl+Shift+R');
      }
    },
  );

  it('only offers reload in dev builds', () => {
    for (const isMac of [true, false]) {
      const devFlat = flattenItems(
        buildApplicationMenuTemplate({ isMac, isDev: true }),
      );
      const prodFlat = flattenItems(
        buildApplicationMenuTemplate({ isMac, isDev: false }),
      );
      expect(devFlat.some((item) => item.role === 'reload')).toBe(true);
      expect(prodFlat.some((item) => item.role === 'reload')).toBe(false);
      expect(prodFlat.some((item) => item.role === 'forceReload')).toBe(false);
    }
  });

  it('keeps the standard role menus and devtools toggle', () => {
    const macFlat = flattenItems(
      buildApplicationMenuTemplate({ isMac: true, isDev: false }),
    );
    const winFlat = flattenItems(
      buildApplicationMenuTemplate({ isMac: false, isDev: false }),
    );
    for (const role of ['editMenu', 'toggleDevTools', 'togglefullscreen']) {
      expect(macFlat.some((item) => item.role === role)).toBe(true);
      expect(winFlat.some((item) => item.role === role)).toBe(true);
    }
    // The `fileMenu` role embeds `close` (⌘W) on macOS and the `windowMenu`
    // role embeds `close` (Ctrl+W) on Windows/Linux, so each platform gets a
    // custom replacement for exactly the menu that would steal the chord.
    expect(macFlat.some((item) => item.role === 'fileMenu')).toBe(false);
    expect(macFlat.some((item) => item.role === 'windowMenu')).toBe(true);
    expect(winFlat.some((item) => item.role === 'fileMenu')).toBe(true);
    expect(winFlat.some((item) => item.role === 'windowMenu')).toBe(false);
    expect(winFlat.some((item) => item.role === 'minimize')).toBe(true);
    expect(macFlat.some((item) => item.role === 'help')).toBe(true);
    expect(winFlat.some((item) => item.role === 'help')).toBe(false);
    expect(macFlat.some((item) => item.role === 'appMenu')).toBe(true);
    expect(winFlat.some((item) => item.role === 'appMenu')).toBe(false);
  });

  it.each(ALL_OPTION_COMBOS)(
    'never binds CmdOrCtrl+W and never uses the close role (isMac=$isMac isDev=$isDev)',
    (options) => {
      const flat = flattenItems(buildApplicationMenuTemplate(options));
      for (const item of flat) {
        // The `close` role would register the default CmdOrCtrl+W
        // accelerator, which must reach the renderer's close-tab shortcut.
        expect(item.role).not.toBe('close');
        if (typeof item.accelerator === 'string') {
          expect(PLAIN_CLOSE_ACCELERATORS).not.toContain(
            item.accelerator.toLowerCase(),
          );
        }
      }
    },
  );

  it.each(ALL_OPTION_COMBOS)(
    'keeps an accelerator-free Close Window click item (isMac=$isMac isDev=$isDev)',
    (options) => {
      const flat = flattenItems(buildApplicationMenuTemplate(options));
      const closeItems = flat.filter((item) => item.label === 'Close Window');
      expect(closeItems).toHaveLength(1);
      const closeItem = closeItems[0];
      expect(closeItem?.accelerator).toBeUndefined();
      expect(typeof closeItem?.click).toBe('function');

      const close = jest.fn();
      handleCloseWindowClick({ close });
      handleCloseWindowClick(undefined);
      expect(close).toHaveBeenCalledTimes(1);
    },
  );
});

// ---------------------------------------------------------------------------
// Interface-scale menu items
// ---------------------------------------------------------------------------

const ZOOM_LABELS = ['Zoom In', 'Zoom Out', 'Actual Size'];

function zoomItems(
  options: Parameters<typeof buildApplicationMenuTemplate>[0],
): MenuItemConstructorOptions[] {
  return flattenItems(buildApplicationMenuTemplate(options)).filter(
    (item) =>
      typeof item.label === 'string' && ZOOM_LABELS.includes(item.label),
  );
}

describe('interface-scale menu items', () => {
  it.each(ALL_OPTION_COMBOS)(
    'always adds Zoom In, Zoom Out and Actual Size to View (isMac=$isMac isDev=$isDev)',
    (options) => {
      const view = buildApplicationMenuTemplate(options).find(
        (item) => item.label === 'View',
      );
      expect(Array.isArray(view?.submenu)).toBe(true);
      const submenu = Array.isArray(view?.submenu) ? view.submenu : [];
      const visibleLabels = submenu
        .filter((item) => item.visible !== false)
        .map((item) => item.label)
        .filter((label): label is string => typeof label === 'string');
      expect(
        visibleLabels.filter((label) => ZOOM_LABELS.includes(label)),
      ).toEqual(ZOOM_LABELS);
      // Three visible commands, four accelerators: Zoom In has a hidden twin.
      expect(zoomItems(options)).toHaveLength(4);
    },
  );

  it.each(ALL_OPTION_COMBOS)(
    'never uses the built-in zoom roles (isMac=$isMac isDev=$isDev)',
    (options) => {
      // `zoomIn`/`zoomOut`/`resetZoom` move `webContents` zoom directly and
      // never touch `uiScale`, so the saved preference and the live zoom
      // would drift apart and the next save or reload would revert them.
      for (const item of flattenItems(buildApplicationMenuTemplate(options))) {
        expect(['zoomIn', 'zoomOut', 'resetZoom']).not.toContain(item.role);
      }
    },
  );

  it.each(ALL_OPTION_COMBOS)(
    'binds the conventional accelerators and a click handler (isMac=$isMac isDev=$isDev)',
    (options) => {
      const items = zoomItems(options);
      const accelerators = items.map((item) => item.accelerator);
      // `+` needs Shift on most layouts, so both spellings are conventional.
      expect(accelerators).toContain('CommandOrControl+Plus');
      expect(accelerators).toContain('CommandOrControl+=');
      expect(accelerators).toContain('CommandOrControl+-');
      expect(accelerators).toContain('CommandOrControl+0');
      for (const item of items) {
        expect(typeof item.click).toBe('function');
      }
    },
  );

  it.each(ALL_OPTION_COMBOS)(
    'keeps the alternate Zoom In accelerator on a hidden twin that still registers (isMac=$isMac isDev=$isDev)',
    (options) => {
      // Electron binds one accelerator per item, so the second spelling
      // rides a hidden duplicate. `acceleratorWorksWhenHidden` is what keeps
      // macOS registering a hidden item's key equivalent.
      const alternate = zoomItems(options).find(
        (item) => item.accelerator === 'CommandOrControl+=',
      );
      expect(alternate?.visible).toBe(false);
      expect(alternate?.acceleratorWorksWhenHidden).toBe(true);
      const primary = zoomItems(options).find(
        (item) => item.accelerator === 'CommandOrControl+Plus',
      );
      expect(primary?.visible).not.toBe(false);
    },
  );

  it.each(ALL_OPTION_COMBOS)(
    'never collides with a renderer-owned chord (isMac=$isMac isDev=$isDev)',
    (options) => {
      // ⌘1–⌘9 are the renderer's page shortcuts (`useGlobalShortcuts`); ⌘0
      // is free. Nothing in the renderer binds +, = or -.
      const accelerators = zoomItems(options).map((item) =>
        String(item.accelerator).toLowerCase(),
      );
      for (const digit of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
        expect(accelerators).not.toContain(`commandorcontrol+${digit}`);
      }
      expect(accelerators).not.toContain('commandorcontrol+shift+o');
    },
  );
});

// ---------------------------------------------------------------------------
// installApplicationMenu
// ---------------------------------------------------------------------------

describe('installApplicationMenu', () => {
  it('builds the template and installs it as the application menu', () => {
    const mockedMenu = jest.mocked(Menu);
    const buildFromTemplate = mockedMenu.buildFromTemplate;
    const setApplicationMenu = mockedMenu.setApplicationMenu;
    buildFromTemplate.mockClear();
    setApplicationMenu.mockClear();

    installApplicationMenu();

    expect(buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(setApplicationMenu).toHaveBeenCalledTimes(1);
    const template = buildFromTemplate.mock.calls[0]?.[0];
    expect(Array.isArray(template)).toBe(true);
    if (Array.isArray(template)) {
      const flat = flattenItems(template);
      for (const item of flat) {
        if (typeof item.accelerator === 'string') {
          expect(PLAIN_RELOAD_ACCELERATORS).not.toContain(
            item.accelerator.toLowerCase(),
          );
        }
      }
      // The first install runs before preferences are read; the zoom items
      // must already be there rather than waiting on a saved setting.
      const labels = flat
        .filter((item) => item.visible !== false)
        .map((item) => item.label);
      for (const label of ZOOM_LABELS) {
        expect(labels).toContain(label);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// shouldBlockBeforeInput
// ---------------------------------------------------------------------------

describe('shouldBlockBeforeInput', () => {
  it.each([{ isDev: true }, { isDev: false }])(
    'lets Ctrl+R and Cmd+R reach the renderer (isDev=$isDev)',
    (options) => {
      expect(
        shouldBlockBeforeInput(
          keyDownInput({ code: 'KeyR', control: true }),
          options,
        ),
      ).toBe(false);
      expect(
        shouldBlockBeforeInput(
          keyDownInput({ code: 'KeyR', meta: true }),
          options,
        ),
      ).toBe(false);
    },
  );

  it('blocks devtools shortcuts only in packaged builds', () => {
    const cmdAltI = keyDownInput({ code: 'KeyI', alt: true, meta: true });
    const ctrlShiftI = keyDownInput({
      code: 'KeyI',
      control: true,
      shift: true,
    });
    expect(shouldBlockBeforeInput(cmdAltI, { isDev: false })).toBe(true);
    expect(shouldBlockBeforeInput(ctrlShiftI, { isDev: false })).toBe(true);
    expect(shouldBlockBeforeInput(cmdAltI, { isDev: true })).toBe(false);
    expect(shouldBlockBeforeInput(ctrlShiftI, { isDev: true })).toBe(false);
  });

  it.each([
    { isDev: true, modifier: 'control' },
    { isDev: true, modifier: 'meta' },
    { isDev: false, modifier: 'control' },
    { isDev: false, modifier: 'meta' },
  ] as const)(
    'hands every zoom chord to the View menu (isDev=$isDev $modifier)',
    ({ isDev, modifier }) => {
      // The View menu owns these chords and steps the persisted `uiScale`.
      // Swallowing the keystroke here would break it on the platforms where
      // `before-input-event` runs ahead of the menu.
      for (const chord of [
        { code: 'Minus' },
        { code: 'Equal' },
        { code: 'Equal', shift: true },
        { code: 'Digit0' },
      ]) {
        expect(
          shouldBlockBeforeInput(keyDownInput({ ...chord, [modifier]: true }), {
            isDev,
          }),
        ).toBe(false);
      }
    },
  );

  it('ignores keyUp events and plain typing', () => {
    expect(
      shouldBlockBeforeInput(
        {
          type: 'keyUp',
          code: 'Minus',
          alt: false,
          control: true,
          meta: false,
          shift: false,
        },
        { isDev: false },
      ),
    ).toBe(false);
    expect(
      shouldBlockBeforeInput(keyDownInput({ code: 'KeyI' }), { isDev: false }),
    ).toBe(false);
    expect(
      shouldBlockBeforeInput(keyDownInput({ code: 'Minus' }), {
        isDev: false,
      }),
    ).toBe(false);
  });
});
