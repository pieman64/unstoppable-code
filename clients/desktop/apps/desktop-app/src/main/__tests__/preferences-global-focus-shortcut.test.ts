import {
  DEFAULT_PREFERENCES,
  normalizePreferences,
} from '../lib/preferences-store';

describe('normalizePreferences — OS focus shortcut (CAN-1963)', () => {
  test('defaults to off with the ⌘⇧O / Ctrl+Shift+O chord', () => {
    expect(DEFAULT_PREFERENCES.globalFocusShortcutEnabled).toBe(false);
    expect(DEFAULT_PREFERENCES.globalFocusShortcut).toBe(
      'CommandOrControl+Shift+O',
    );
    const normalized = normalizePreferences({});
    expect(normalized.globalFocusShortcutEnabled).toBe(false);
    expect(normalized.globalFocusShortcut).toBe('CommandOrControl+Shift+O');
  });

  test('round-trips a valid chord in canonical form', () => {
    const normalized = normalizePreferences({
      globalFocusShortcutEnabled: true,
      globalFocusShortcut: 'shift+cmdorctrl+p',
    });
    expect(normalized.globalFocusShortcutEnabled).toBe(true);
    expect(normalized.globalFocusShortcut).toBe('CommandOrControl+Shift+P');
  });

  test('falls back to the default chord for values the OS could not register', () => {
    // Electron would silently register `Bogus+Q` as a bare Q; a corrupt file
    // must never turn into a typing-stealing global hotkey.
    for (const value of ['Bogus+Q', 'O', '', 42, null]) {
      const raw: Record<string, unknown> = { globalFocusShortcut: value };
      expect(normalizePreferences(raw).globalFocusShortcut).toBe(
        'CommandOrControl+Shift+O',
      );
    }
    const raw: Record<string, unknown> = { globalFocusShortcutEnabled: 'yes' };
    expect(normalizePreferences(raw).globalFocusShortcutEnabled).toBe(false);
  });
});
