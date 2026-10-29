import { COMMAND_DEFINITIONS, formatShortcut } from '../keyboardShortcuts';
import {
  findInAppShortcutConflict,
  rendererShortcutPlatform,
} from '../globalFocusShortcut';

// `COMMAND_DEFINITIONS` formats chords for the platform at module load, so the
// oracle reads the table (and `formatShortcut`) instead of hardcoding one
// platform's spelling.
function shortcutOf(id: string): string {
  const shortcut = COMMAND_DEFINITIONS.find((c) => c.id === id)?.shortcut;
  if (!shortcut) throw new Error(`no shortcut for ${id}`);
  return shortcut;
}

describe('findInAppShortcutConflict', () => {
  it('names the in-app command that already owns the chord', () => {
    expect(
      findInAppShortcutConflict(shortcutOf('open-command-palette'))?.title,
    ).toBe('Open command palette');
    expect(
      findInAppShortcutConflict(shortcutOf('open-shortcuts-settings'))?.title,
    ).toBe('Keyboard shortcuts');
  });

  it('ignores case and spacing so recorder output matches table entries', () => {
    const loose = ` ${shortcutOf('open-shortcuts-settings').toLowerCase().split('').join(' ')} `;
    expect(findInAppShortcutConflict(loose)?.title).toBe('Keyboard shortcuts');
  });

  it('returns null for a free chord', () => {
    expect(
      findInAppShortcutConflict(formatShortcut('⌘⇧O', 'Ctrl Shift O')),
    ).toBeNull();
  });

  // The View menu's zoom items are main-process accelerators and so are
  // absent from COMMAND_DEFINITIONS, but the OS still gives a global shortcut
  // the keydown first. These assert the exact display spellings the recorder
  // produces; a mismatch would make the guard silently match nothing.
  it.each([
    ['darwin', '⌘=', 'Zoom In'],
    // ⌘+ is Shift plus the `=` key on most layouts, so this is what the
    // recorder actually emits when someone presses the chord they think of
    // as "zoom in" — the likeliest collision of the three.
    ['darwin', '⌘⇧=', 'Zoom In'],
    ['darwin', '⌘-', 'Zoom Out'],
    ['darwin', '⌘0', 'Actual Size'],
    ['win32', 'Ctrl =', 'Zoom In'],
    ['win32', 'Ctrl Shift =', 'Zoom In'],
    ['win32', 'Ctrl -', 'Zoom Out'],
    ['win32', 'Ctrl 0', 'Actual Size'],
  ] as const)(
    'flags %s %s as owned by the View menu',
    (platform, chord, title) => {
      expect(findInAppShortcutConflict(chord, platform)).toEqual({ title });
    },
  );

  it('names a real command the same way as a View menu item', () => {
    expect(
      findInAppShortcutConflict(shortcutOf('open-command-palette')),
    ).toEqual({ title: 'Open command palette' });
  });

  it('does not claim the menu owns a chord on the other platform', () => {
    expect(findInAppShortcutConflict('Ctrl 0', 'darwin')).toBeNull();
    expect(findInAppShortcutConflict('⌘0', 'win32')).toBeNull();
  });
});

describe('rendererShortcutPlatform', () => {
  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: undefined,
    });
  });

  function stubPlatform(platform: string): void {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { platform },
    });
  }

  it('maps macOS, Linux, and Windows navigator platforms to the shortcut platforms', () => {
    stubPlatform('MacIntel');
    expect(rendererShortcutPlatform()).toBe('darwin');
    stubPlatform('Linux x86_64');
    expect(rendererShortcutPlatform()).toBe('linux');
    stubPlatform('Win32');
    expect(rendererShortcutPlatform()).toBe('win32');
  });

  it('falls back to win32 without a navigator', () => {
    expect(rendererShortcutPlatform()).toBe('win32');
  });
});
