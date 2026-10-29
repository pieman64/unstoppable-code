import { COMMAND_DEFINITIONS } from '../keyboardShortcuts';
import { splitShortcutKeys } from '../shortcutKeys';

describe('splitShortcutKeys (ECW-7984 follow-up)', () => {
  it('splits a macOS glyph run into individual keys', () => {
    expect(splitShortcutKeys('⌘K')).toEqual(['⌘', 'K']);
    expect(splitShortcutKeys('⌘⇧K')).toEqual(['⌘', '⇧', 'K']);
    expect(splitShortcutKeys('⌘⌥B')).toEqual(['⌘', '⌥', 'B']);
    expect(splitShortcutKeys('⌃`')).toEqual(['⌃', '`']);
  });

  it('keeps multi-byte arrow and punctuation keys intact', () => {
    expect(splitShortcutKeys('⌘←')).toEqual(['⌘', '←']);
    expect(splitShortcutKeys('⌘⌥↓')).toEqual(['⌘', '⌥', '↓']);
    expect(splitShortcutKeys('⌘\\')).toEqual(['⌘', '\\']);
  });

  it('splits the space-separated non-macOS form on words', () => {
    expect(splitShortcutKeys('Ctrl K')).toEqual(['Ctrl', 'K']);
    expect(splitShortcutKeys('Ctrl Shift D')).toEqual(['Ctrl', 'Shift', 'D']);
    expect(splitShortcutKeys('Ctrl Alt B')).toEqual(['Ctrl', 'Alt', 'B']);
    expect(splitShortcutKeys('Alt ←')).toEqual(['Alt', '←']);
  });

  it('returns nothing for an empty shortcut', () => {
    expect(splitShortcutKeys('')).toEqual([]);
    expect(splitShortcutKeys('   ')).toEqual([]);
  });

  it('never drops a character from any defined shortcut', () => {
    const shortcuts = COMMAND_DEFINITIONS.map(
      (definition) => definition.shortcut,
    ).filter((shortcut): shortcut is string => typeof shortcut === 'string');

    expect(shortcuts.length).toBeGreaterThan(0);
    for (const shortcut of shortcuts) {
      const keys = splitShortcutKeys(shortcut);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.join('')).toBe(shortcut.replace(/\s+/g, ''));
    }
  });
});
