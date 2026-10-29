import {
  acceleratorFromKeyboardEvent,
  formatAcceleratorForDisplay,
  normalizeAccelerator,
  parseAccelerator,
  validateGlobalShortcut,
} from '../global-shortcut-accelerator';

describe('parseAccelerator', () => {
  it('canonicalizes modifier aliases, order, and key case', () => {
    expect(normalizeAccelerator('shift+cmdorctrl+o')).toBe(
      'CommandOrControl+Shift+O',
    );
    expect(normalizeAccelerator('Ctrl+Option+F5')).toBe('Control+Alt+F5');
    expect(normalizeAccelerator('Cmd+`')).toBe('Command+`');
  });

  it('returns null for non-string input such as a missing preference', () => {
    // Persisted data reaches the parser untyped; it must reject, not throw.
    const missing: unknown = undefined;
    expect(parseAccelerator(missing)).toBeNull();
    const numeric: unknown = 42;
    expect(normalizeAccelerator(numeric)).toBeNull();
    expect(validateGlobalShortcut(missing, 'darwin')).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('rejects unknown tokens instead of ignoring them like Electron does', () => {
    // Electron registers `Bogus+Q` as a bare Q; a strict parser must not.
    expect(parseAccelerator('Bogus+Q')).toBeNull();
    expect(parseAccelerator('')).toBeNull();
    expect(parseAccelerator('CommandOrControl+')).toBeNull();
    expect(parseAccelerator('CommandOrControl+Shift')).toBeNull();
    expect(parseAccelerator('Shift+Shift+O')).toBeNull();
  });
});

describe('acceleratorFromKeyboardEvent', () => {
  const event = (
    overrides: Partial<{
      code: string;
      key: string;
      metaKey: boolean;
      ctrlKey: boolean;
      altKey: boolean;
      shiftKey: boolean;
    }>,
  ): {
    code: string;
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  } => ({
    code: 'KeyO',
    key: 'o',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  });

  it('maps the platform primary modifier to CommandOrControl', () => {
    expect(
      acceleratorFromKeyboardEvent(
        event({ metaKey: true, shiftKey: true }),
        'darwin',
      ),
    ).toBe('CommandOrControl+Shift+O');
    expect(
      acceleratorFromKeyboardEvent(
        event({ ctrlKey: true, shiftKey: true }),
        'win32',
      ),
    ).toBe('CommandOrControl+Shift+O');
  });

  it('keeps the secondary modifier explicit per platform', () => {
    expect(
      acceleratorFromKeyboardEvent(event({ ctrlKey: true }), 'darwin'),
    ).toBe('Control+O');
    expect(
      acceleratorFromKeyboardEvent(event({ metaKey: true }), 'win32'),
    ).toBe('Super+O');
  });

  it('uses the physical key so Option-composed characters still bind', () => {
    // macOS turns ⌥O into `ø` in `event.key`; `code` stays `KeyO`.
    expect(
      acceleratorFromKeyboardEvent(
        event({ altKey: true, metaKey: true, key: 'ø' }),
        'darwin',
      ),
    ).toBe('CommandOrControl+Alt+O');
  });

  it('returns null for modifier-only presses and unknown keys', () => {
    expect(
      acceleratorFromKeyboardEvent(
        event({ code: 'ShiftLeft', key: 'Shift', shiftKey: true }),
        'darwin',
      ),
    ).toBeNull();
    expect(
      acceleratorFromKeyboardEvent(
        event({ code: 'MetaLeft', key: 'Meta', metaKey: true }),
        'darwin',
      ),
    ).toBeNull();
    expect(
      acceleratorFromKeyboardEvent(
        event({ code: 'Lang1', key: 'HangulMode', metaKey: true }),
        'darwin',
      ),
    ).toBeNull();
  });

  it('maps navigation, function, and punctuation codes', () => {
    expect(
      acceleratorFromKeyboardEvent(
        event({ code: 'ArrowUp', key: 'ArrowUp', metaKey: true }),
        'darwin',
      ),
    ).toBe('CommandOrControl+Up');
    expect(
      acceleratorFromKeyboardEvent(
        event({ code: 'F19', key: 'F19' }),
        'darwin',
      ),
    ).toBe('F19');
    expect(
      acceleratorFromKeyboardEvent(
        event({ code: 'Backquote', key: '`', ctrlKey: true }),
        'win32',
      ),
    ).toBe('CommandOrControl+`');
    expect(
      acceleratorFromKeyboardEvent(
        event({ code: 'Digit3', key: '#', shiftKey: true, metaKey: true }),
        'darwin',
      ),
    ).toBe('CommandOrControl+Shift+3');
  });
});

describe('formatAcceleratorForDisplay', () => {
  it('renders macOS glyphs in the platform order without spaces', () => {
    expect(
      formatAcceleratorForDisplay('CommandOrControl+Shift+O', 'darwin'),
    ).toBe('⌘⇧O');
    // Same order the in-app shortcut table already uses (⌘ before ⌥/⇧).
    expect(
      formatAcceleratorForDisplay('Control+Alt+Shift+Command+P', 'darwin'),
    ).toBe('⌃⌘⌥⇧P');
  });

  it('space-separates macOS chords whose key label is more than one glyph', () => {
    // `splitShortcutKeys` splits a spaceless macOS chord per character, which
    // would shred `F5` and `Space` into separate key caps.
    expect(formatAcceleratorForDisplay('CommandOrControl+F5', 'darwin')).toBe(
      '⌘ F5',
    );
    expect(
      formatAcceleratorForDisplay('CommandOrControl+Shift+Space', 'darwin'),
    ).toBe('⌘ ⇧ Space');
  });

  it('renders Windows and Linux chords as space-separated words', () => {
    expect(
      formatAcceleratorForDisplay('CommandOrControl+Shift+O', 'win32'),
    ).toBe('Ctrl Shift O');
    expect(formatAcceleratorForDisplay('Super+Alt+Up', 'linux')).toBe(
      'Win Alt ↑',
    );
  });

  it('falls back to the raw string for an unparseable value', () => {
    expect(formatAcceleratorForDisplay('nonsense', 'darwin')).toBe('nonsense');
  });
});

describe('validateGlobalShortcut', () => {
  it('accepts the default and returns its canonical form', () => {
    expect(validateGlobalShortcut('shift+cmdorctrl+o', 'darwin')).toEqual({
      ok: true,
      accelerator: 'CommandOrControl+Shift+O',
    });
  });

  it('requires a non-Shift modifier for keys that type characters', () => {
    expect(validateGlobalShortcut('O', 'darwin')).toEqual({
      ok: false,
      reason: 'needs-modifier',
    });
    expect(validateGlobalShortcut('Shift+O', 'win32')).toEqual({
      ok: false,
      reason: 'needs-modifier',
    });
    expect(validateGlobalShortcut('Space', 'linux')).toEqual({
      ok: false,
      reason: 'needs-modifier',
    });
    expect(validateGlobalShortcut('Return', 'darwin')).toEqual({
      ok: false,
      reason: 'needs-modifier',
    });
  });

  it('requires a modifier for function keys too, since other apps bind them bare', () => {
    // A bare F5 would swallow browser refresh and IDE run in every app.
    expect(validateGlobalShortcut('F19', 'darwin')).toEqual({
      ok: false,
      reason: 'needs-modifier',
    });
    expect(validateGlobalShortcut('CommandOrControl+F19', 'darwin')).toEqual({
      ok: true,
      accelerator: 'CommandOrControl+F19',
    });
  });

  it('rejects chords the OS reserves, resolving CommandOrControl per platform', () => {
    expect(validateGlobalShortcut('Command+Space', 'darwin')).toEqual({
      ok: false,
      reason: 'reserved',
    });
    expect(validateGlobalShortcut('CommandOrControl+Tab', 'darwin')).toEqual({
      ok: false,
      reason: 'reserved',
    });
    expect(
      validateGlobalShortcut('CommandOrControl+Shift+4', 'darwin'),
    ).toEqual({ ok: false, reason: 'reserved' });
    // Application-menu accelerators are unreachable via the recorder, but a
    // hand-edited preferences file must not be able to claim them either.
    expect(validateGlobalShortcut('CommandOrControl+,', 'darwin')).toEqual({
      ok: false,
      reason: 'reserved',
    });
    expect(validateGlobalShortcut('Control+Alt+Delete', 'win32')).toEqual({
      ok: false,
      reason: 'reserved',
    });
    // The Windows window system menu.
    expect(validateGlobalShortcut('Alt+Space', 'win32')).toEqual({
      ok: false,
      reason: 'reserved',
    });
    expect(validateGlobalShortcut('Alt+F4', 'linux')).toEqual({
      ok: false,
      reason: 'reserved',
    });
    // ⌘Space is Spotlight on macOS only; Ctrl+Space is free elsewhere.
    expect(validateGlobalShortcut('CommandOrControl+Space', 'win32')).toEqual({
      ok: true,
      accelerator: 'CommandOrControl+Space',
    });
  });

  it('rejects the standard editing chords every application relies on', () => {
    // Claiming ⌘C system-wide would break copy in every other app with no
    // conflict warning; these are reserved on every platform.
    for (const chord of [
      'CommandOrControl+C',
      'CommandOrControl+V',
      'CommandOrControl+X',
      'CommandOrControl+A',
      'CommandOrControl+Z',
      'CommandOrControl+Shift+Z',
      'CommandOrControl+S',
      'CommandOrControl+F',
    ]) {
      for (const platform of ['darwin', 'win32', 'linux'] as const) {
        expect(validateGlobalShortcut(chord, platform)).toEqual({
          ok: false,
          reason: 'reserved',
        });
      }
    }
    expect(validateGlobalShortcut('Control+Y', 'win32')).toEqual({
      ok: false,
      reason: 'reserved',
    });
    // A modifier-heavier variant is still free.
    expect(validateGlobalShortcut('CommandOrControl+Alt+C', 'darwin')).toEqual({
      ok: true,
      accelerator: 'CommandOrControl+Alt+C',
    });
  });

  it('reserves the Windows key chords the shell owns and the macOS Spaces chords', () => {
    // Electron reports these as registered, but the OS handles them first
    // and they never fire; only a hand-edited preferences file can reach them.
    for (const key of ['A', 'D', 'E', 'G', 'I', 'L', 'P', 'R', 'S', 'X']) {
      expect(validateGlobalShortcut(`Super+${key}`, 'win32')).toEqual({
        ok: false,
        reason: 'reserved',
      });
    }
    expect(validateGlobalShortcut('Super+Shift+O', 'win32')).toEqual({
      ok: true,
      accelerator: 'Shift+Super+O',
    });
    for (const chord of [
      'Control+Left',
      'Control+Right',
      'Control+Up',
      'Control+Down',
    ]) {
      expect(validateGlobalShortcut(chord, 'darwin')).toEqual({
        ok: false,
        reason: 'reserved',
      });
    }
  });

  it('reserves the Control-modifier editing chords on macOS too', () => {
    // ⌃C is SIGINT in every terminal and ⌃A/⌃E/⌃K are readline everywhere;
    // the recorder produces `Control+C` from a real Ctrl+C press on a Mac.
    for (const chord of [
      'Control+C',
      'Control+A',
      'Control+E',
      'Control+K',
      'Control+D',
      'Control+Z',
      'Control+Space',
      // The rest of the Cocoa text bindings every macOS text field honours.
      'Control+B',
      'Control+F',
      'Control+H',
      'Control+L',
      'Control+N',
      'Control+O',
      'Control+P',
      'Control+T',
      'Control+V',
      'Control+Y',
    ]) {
      expect(validateGlobalShortcut(chord, 'darwin')).toEqual({
        ok: false,
        reason: 'reserved',
      });
    }
    expect(validateGlobalShortcut('Control+Shift+O', 'darwin')).toEqual({
      ok: true,
      accelerator: 'Control+Shift+O',
    });
  });

  it('requires ⌘ or ⌃ alongside ⌥ on macOS, where ⌥ alone types characters', () => {
    // ⌥e→´, ⌥o→ø, ⌥5→∞, ⌥Space→NBSP: Option is the special-character layer,
    // so a bare ⌥ chord would intercept typing in every application.
    for (const chord of [
      'Alt+O',
      'Alt+Shift+O',
      'Alt+E',
      'Alt+5',
      'Alt+Space',
    ]) {
      expect(validateGlobalShortcut(chord, 'darwin')).toEqual({
        ok: false,
        reason: 'needs-modifier',
      });
    }
    expect(validateGlobalShortcut('CommandOrControl+Alt+O', 'darwin')).toEqual({
      ok: true,
      accelerator: 'CommandOrControl+Alt+O',
    });
    expect(validateGlobalShortcut('Control+Alt+O', 'darwin')).toEqual({
      ok: true,
      accelerator: 'Control+Alt+O',
    });
    // Alt is an ordinary modifier elsewhere.
    expect(validateGlobalShortcut('Alt+O', 'win32')).toEqual({
      ok: true,
      accelerator: 'Alt+O',
    });
    expect(validateGlobalShortcut('Alt+O', 'linux')).toEqual({
      ok: true,
      accelerator: 'Alt+O',
    });
  });

  it('collapses modifiers that duplicate CommandOrControl on the platform', () => {
    // Only a hand-edited preferences file can spell these; the saved,
    // displayed, and bound chords must still agree.
    expect(
      validateGlobalShortcut('Control+CommandOrControl+O', 'win32'),
    ).toEqual({ ok: true, accelerator: 'CommandOrControl+O' });
    expect(
      validateGlobalShortcut('CommandOrControl+Command+O', 'darwin'),
    ).toEqual({ ok: true, accelerator: 'CommandOrControl+O' });
    expect(
      validateGlobalShortcut('CommandOrControl+Super+O', 'darwin'),
    ).toEqual({ ok: true, accelerator: 'CommandOrControl+O' });
    // ⌘⌃O is a distinct chord on macOS and stays as spelled.
    expect(
      validateGlobalShortcut('CommandOrControl+Control+O', 'darwin'),
    ).toEqual({ ok: true, accelerator: 'CommandOrControl+Control+O' });
    // The collapsed form is what the reservation check sees.
    expect(
      validateGlobalShortcut('CommandOrControl+Command+C', 'darwin'),
    ).toEqual({ ok: false, reason: 'reserved' });
  });

  it('treats Super as Command on macOS and refuses Command elsewhere', () => {
    // Electron maps Super to ⌘ on macOS, so `Super+C` must hit the same
    // reserved entry as ⌘C; off macOS Electron ignores `Command`, so such a
    // chord could never fire and must not be saved.
    expect(validateGlobalShortcut('Super+C', 'darwin')).toEqual({
      ok: false,
      reason: 'reserved',
    });
    expect(validateGlobalShortcut('Super+Q', 'darwin')).toEqual({
      ok: false,
      reason: 'reserved',
    });
    // Canonical modifier order places Super after Shift.
    expect(validateGlobalShortcut('Super+Shift+O', 'darwin')).toEqual({
      ok: true,
      accelerator: 'Shift+Super+O',
    });
    expect(validateGlobalShortcut('Command+O', 'win32')).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(validateGlobalShortcut('Command+O', 'linux')).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('reserves the window and document chords alongside the editing ones', () => {
    for (const chord of [
      'CommandOrControl+W',
      'CommandOrControl+P',
      'CommandOrControl+N',
      'CommandOrControl+T',
    ]) {
      for (const platform of ['darwin', 'win32', 'linux'] as const) {
        expect(validateGlobalShortcut(chord, platform)).toEqual({
          ok: false,
          reason: 'reserved',
        });
      }
    }
  });

  it('reports unparseable input as invalid', () => {
    expect(validateGlobalShortcut('Bogus+Q', 'darwin')).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});
