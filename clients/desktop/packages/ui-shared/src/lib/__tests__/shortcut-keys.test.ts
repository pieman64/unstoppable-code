import { splitShortcutKeys } from '../shortcut-keys';

describe('splitShortcutKeys', () => {
  it('splits a plus-separated chord into one key per cap', () => {
    // "Ctrl+L" used to come back as a single cap holding the whole string.
    expect(splitShortcutKeys('Ctrl+L')).toEqual(['Ctrl', 'L']);
    expect(splitShortcutKeys('Ctrl+Shift+Z')).toEqual(['Ctrl', 'Shift', 'Z']);
    expect(splitShortcutKeys('⌘+Z')).toEqual(['⌘', 'Z']);
  });

  it('keeps a plus key that is the key itself', () => {
    expect(splitShortcutKeys('⌘+')).toEqual(['⌘', '+']);
    expect(splitShortcutKeys('+')).toEqual(['+']);
  });

  it('keeps a named key whole instead of splitting it into letters', () => {
    expect(splitShortcutKeys('esc')).toEqual(['esc']);
    expect(splitShortcutKeys('Enter')).toEqual(['Enter']);
    expect(splitShortcutKeys('F12')).toEqual(['F12']);
    expect(splitShortcutKeys('⇧Tab')).toEqual(['⇧', 'Tab']);
  });

  it('still splits macOS glyph runs and the spaced form', () => {
    expect(splitShortcutKeys('⌘⇧K')).toEqual(['⌘', '⇧', 'K']);
    expect(splitShortcutKeys('⌘1')).toEqual(['⌘', '1']);
    expect(splitShortcutKeys('↑↓')).toEqual(['↑', '↓']);
    expect(splitShortcutKeys('⌘ Click')).toEqual(['⌘', 'Click']);
    expect(splitShortcutKeys('Ctrl Shift K')).toEqual(['Ctrl', 'Shift', 'K']);
  });
});
