/**
 * Splits a shortcut display string into its individual keys.
 *
 * The non-macOS form is space-separated (`Ctrl Shift K`), while the macOS
 * form is a run of single-character glyphs and a key (`⌘⇧K`, `⌘←`).
 */
export function splitShortcutKeys(shortcut: string): string[] {
  const trimmed = shortcut.trim();
  if (trimmed.length === 0) {
    return [];
  }
  if (trimmed.includes(' ')) {
    return trimmed.split(/\s+/);
  }
  return Array.from(trimmed);
}

/** Modifier glyphs that need optical scaling beside letter keys. */
export const SHORTCUT_MODIFIER_GLYPHS: ReadonlySet<string> = new Set([
  '⌘',
  '⇧',
  '⌥',
  '⌃',
]);

/**
 * Glyphs whose ink reaches below the baseline (`@` draws its ring from the
 * x-height down past it; slashes and brackets descend). Centred by their
 * line box they sit about a pixel low beside cap-height keys, so key caps
 * lift them to centre the ink optically.
 */
const SHORTCUT_DESCENDING_GLYPHS: ReadonlySet<string> = new Set([
  '@',
  '/',
  '\\',
  '|',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  ',',
  ';',
  '_',
]);

/** Whether a key cap should lift its glyph to centre the ink optically. */
export function shortcutGlyphSitsLow(key: string): boolean {
  return SHORTCUT_DESCENDING_GLYPHS.has(key);
}
