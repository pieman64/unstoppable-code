import {
  COMMAND_DEFINITIONS,
  filterCommandDefinitions,
  formatShortcut,
  isAltCodeShortcutEvent,
  isBrowserHistoryShortcutEvent,
  isEditableTarget,
  isShortcutEvent,
  isDictationShortcutEvent,
} from '../keyboardShortcuts';

/**
 * A macOS Option+<letter> keydown. `key` carries the COMPOSED character the
 * platform produces (⌥W → `∑`), which is exactly why these chords have to be
 * matched by `code`.
 */
function optionLetterEvent(
  composedKey: string,
  code: string,
  overrides: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {},
): {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  isComposing: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
} {
  return {
    altKey: true,
    code,
    ctrlKey: overrides.ctrlKey ?? false,
    isComposing: false,
    key: composedKey,
    metaKey: overrides.metaKey ?? false,
    shiftKey: overrides.shiftKey ?? false,
  };
}

class ClosestTarget extends EventTarget {
  private readonly matchedSelector: string | null;

  constructor(matchedSelector: string | null) {
    super();
    this.matchedSelector = matchedSelector;
  }

  closest(selector: string): object | null {
    if (this.matchedSelector && selector.includes(this.matchedSelector)) {
      return {};
    }

    return null;
  }
}

describe('keyboardShortcuts', () => {
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
  });

  it('formats shortcuts for macOS', () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { platform: 'MacIntel' },
    });

    expect(formatShortcut('⌘K', 'Ctrl K')).toBe('⌘K');
  });

  it('formats shortcuts for non-mac platforms', () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { platform: 'Linux x86_64' },
    });

    expect(formatShortcut('⌘K', 'Ctrl K')).toBe('Ctrl K');
  });

  it('accepts plain Alt+Arrow browser history on Windows and Linux', () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { platform: 'Linux x86_64' },
    });

    expect(
      isBrowserHistoryShortcutEvent(
        {
          altKey: true,
          ctrlKey: false,
          isComposing: false,
          key: 'ArrowLeft',
          metaKey: false,
          shiftKey: false,
        },
        'ArrowLeft',
      ),
    ).toBe(true);
  });

  it('does not treat macOS Option+Arrow as browser history', () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { platform: 'MacIntel' },
    });

    expect(
      isBrowserHistoryShortcutEvent(
        {
          altKey: true,
          ctrlKey: false,
          isComposing: false,
          key: 'ArrowLeft',
          metaKey: false,
          shiftKey: false,
        },
        'ArrowLeft',
      ),
    ).toBe(false);
  });

  describe('isAltCodeShortcutEvent (ECW-7984 follow-up)', () => {
    beforeEach(() => {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { platform: 'MacIntel' },
      });
    });

    it('matches a bare Option chord by code despite the composed key', () => {
      expect(
        isAltCodeShortcutEvent(optionLetterEvent('∑', 'KeyW'), 'KeyW'),
      ).toBe(true);
      expect(
        isAltCodeShortcutEvent(optionLetterEvent('µ', 'KeyM'), 'KeyM'),
      ).toBe(true);
      expect(
        isAltCodeShortcutEvent(optionLetterEvent('†', 'KeyT'), 'KeyT'),
      ).toBe(true);
    });

    it('is why isShortcutEvent cannot be used for these chords', () => {
      // Guards the premise: the composed `key` never equals the letter, so the
      // key-based matcher misses ⌥W entirely.
      expect(isShortcutEvent(optionLetterEvent('∑', 'KeyW'), 'w')).toBe(false);
    });

    it('does not match a different physical key', () => {
      expect(
        isAltCodeShortcutEvent(optionLetterEvent('∑', 'KeyW'), 'KeyM'),
      ).toBe(false);
    });

    it('rejects a bare Option chord once Cmd or Shift joins it', () => {
      expect(
        isAltCodeShortcutEvent(
          optionLetterEvent('∑', 'KeyW', { metaKey: true }),
          'KeyW',
        ),
      ).toBe(false);
      expect(
        isAltCodeShortcutEvent(
          optionLetterEvent('∑', 'KeyW', { shiftKey: true }),
          'KeyW',
        ),
      ).toBe(false);
    });

    it('matches ⌘⌥B only with primary, keeping it distinct from bare ⌥B', () => {
      const cmdOptionB = optionLetterEvent('∫', 'KeyB', { metaKey: true });
      expect(
        isAltCodeShortcutEvent(cmdOptionB, 'KeyB', { primary: true }),
      ).toBe(true);
      expect(isAltCodeShortcutEvent(cmdOptionB, 'KeyB')).toBe(false);

      const bareOptionB = optionLetterEvent('∫', 'KeyB');
      expect(
        isAltCodeShortcutEvent(bareOptionB, 'KeyB', { primary: true }),
      ).toBe(false);
    });

    it('requires Ctrl rather than Cmd for the primary chord off macOS', () => {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { platform: 'Win32' },
      });

      expect(
        isAltCodeShortcutEvent(
          optionLetterEvent('b', 'KeyB', { ctrlKey: true }),
          'KeyB',
          { primary: true },
        ),
      ).toBe(true);
      expect(
        isAltCodeShortcutEvent(
          optionLetterEvent('b', 'KeyB', { metaKey: true }),
          'KeyB',
          { primary: true },
        ),
      ).toBe(false);
    });

    it('ignores keydowns emitted mid-IME-composition', () => {
      expect(
        isAltCodeShortcutEvent(
          { ...optionLetterEvent('∑', 'KeyW'), isComposing: true },
          'KeyW',
        ),
      ).toBe(false);
    });
  });

  it('detects editable targets', () => {
    expect(isEditableTarget(new ClosestTarget('input'))).toBe(true);
    expect(isEditableTarget(new ClosestTarget('textarea'))).toBe(true);
    expect(isEditableTarget(new ClosestTarget('select'))).toBe(true);
    expect(
      isEditableTarget(new ClosestTarget('[contenteditable="true"]')),
    ).toBe(true);
    expect(isEditableTarget(new ClosestTarget(null))).toBe(false);
  });

  it('filters commands by title, subtitle, and keywords', () => {
    expect(
      filterCommandDefinitions(COMMAND_DEFINITIONS, 'overview').map(
        (command) => command.id,
      ),
    ).toContain('navigate-overview');

    expect(
      filterCommandDefinitions(COMMAND_DEFINITIONS, 'selected worktree').map(
        (command) => command.id,
      ),
    ).toContain('new-chat-tab');

    expect(
      filterCommandDefinitions(COMMAND_DEFINITIONS, 'automation').map(
        (command) => command.id,
      ),
    ).toContain('open-worktree-hooks');
  });
});

describe('Open Customize command', () => {
  const command = COMMAND_DEFINITIONS.find(
    (definition) => definition.id === 'navigate-plugins',
  );

  it('is named after the page it opens and still navigates to it', () => {
    expect(command).toMatchObject({
      title: 'Open Customize',
      category: 'navigation',
      page: 'plugins',
    });
    expect(command?.shortcut).toBe(formatShortcut('⌘5', 'Ctrl 5'));
  });

  it.each([
    'customize',
    'marketplace',
    'plugins',
    'skills',
    'pipelines',
    'automations',
  ])('is found by searching for %s', (query) => {
    expect(
      filterCommandDefinitions(COMMAND_DEFINITIONS, query).some(
        (definition) => definition.id === 'navigate-plugins',
      ),
    ).toBe(true);
  });
});

describe('isDictationShortcutEvent', () => {
  const base = {
    altKey: false,
    ctrlKey: true,
    isComposing: false,
    key: 'm',
    metaKey: false,
    shiftKey: false,
    code: 'KeyM',
  };

  it('matches Control+M by physical key', () => {
    expect(isDictationShortcutEvent(base)).toBe(true);
    expect(isDictationShortcutEvent({ ...base, key: 'µ' })).toBe(true);
  });

  it('ignores the chord with Command, Option, Shift, or mid-composition', () => {
    expect(isDictationShortcutEvent({ ...base, metaKey: true })).toBe(false);
    expect(isDictationShortcutEvent({ ...base, altKey: true })).toBe(false);
    expect(isDictationShortcutEvent({ ...base, shiftKey: true })).toBe(false);
    expect(isDictationShortcutEvent({ ...base, isComposing: true })).toBe(
      false,
    );
    expect(isDictationShortcutEvent({ ...base, code: 'KeyN' })).toBe(false);
  });
});
