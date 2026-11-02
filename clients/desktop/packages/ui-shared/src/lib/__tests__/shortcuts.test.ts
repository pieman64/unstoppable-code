/**
 * @jest-environment jsdom
 */
import { splitShortcutKeys } from '../shortcut-keys';
import { formatChord, ROW_SELECTION_CHORD } from '../shortcut-platform';
import {
  currentShortcutPlatform,
  formatShortcut,
  isMacPlatform,
  joinShortcutKeys,
  SHORTCUTS,
  shortcutKeys,
  type ShortcutId,
} from '../shortcuts';

function withPlatform(platform: string, run: () => void): void {
  const spy = jest.spyOn(navigator, 'platform', 'get');
  spy.mockReturnValue(platform);
  try {
    run();
  } finally {
    spy.mockRestore();
  }
}

describe('shortcut registry', () => {
  it('formats one binding per platform', () => {
    expect(formatShortcut('open-command-palette', 'mac')).toBe('⌘K');
    expect(formatShortcut('open-command-palette', 'other')).toBe('Ctrl K');
    expect(formatShortcut('open-shortcuts-settings', 'mac')).toBe('⌘⇧K');
    expect(formatShortcut('open-shortcuts-settings', 'other')).toBe(
      'Ctrl Shift K',
    );
    expect(formatShortcut('browser-history-back', 'other')).toBe('Alt ←');
    expect(formatShortcut('toggle-dictation', 'mac')).toBe('⌃M');
    expect(formatShortcut('list-open', 'mac')).toBe('↵');
    expect(formatShortcut('dismiss', 'other')).toBe('Esc');
  });

  it('spaces a word key on macOS so it stays one cap', () => {
    expect(formatShortcut('toggle-row-selection', 'mac')).toBe('⌘ Click');
    expect(formatShortcut('toggle-row-selection', 'other')).toBe('Ctrl Click');
  });

  it('shares the row-selection chord with the registry-free formatter', () => {
    expect(SHORTCUTS['toggle-row-selection']).toBe(ROW_SELECTION_CHORD);
    expect(formatChord(ROW_SELECTION_CHORD, 'mac')).toBe('⌘ Click');
    expect(formatChord(ROW_SELECTION_CHORD, 'other')).toBe('Ctrl Click');
  });

  it('round-trips every binding through the key-cap splitter', () => {
    const ids = Object.keys(SHORTCUTS).filter((id): id is ShortcutId =>
      Object.hasOwn(SHORTCUTS, id),
    );
    expect(ids.length).toBeGreaterThan(40);
    for (const id of ids) {
      for (const platform of ['mac', 'other'] as const) {
        expect(splitShortcutKeys(formatShortcut(id, platform))).toEqual(
          shortcutKeys(id, platform),
        );
      }
    }
  });

  it('joins macOS glyphs and spaces words', () => {
    expect(joinShortcutKeys(['⌘', '⇧', 'K'], 'mac')).toBe('⌘⇧K');
    expect(joinShortcutKeys(['Ctrl', 'Shift', 'K'], 'other')).toBe(
      'Ctrl Shift K',
    );
  });

  it('reads the platform from the navigator by default', () => {
    withPlatform('MacIntel', () => {
      expect(isMacPlatform()).toBe(true);
      expect(currentShortcutPlatform()).toBe('mac');
      expect(formatShortcut('new-task')).toBe('⌘N');
    });
    withPlatform('Win32', () => {
      expect(isMacPlatform()).toBe(false);
      expect(formatShortcut('new-task')).toBe('Ctrl N');
    });
  });
});
