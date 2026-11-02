/** `Ctrl+L`, `⌘+Z`: two or more keys joined by `+`, none of them empty. */
const PLUS_SEPARATED_CHORD = /^[^+\s]+(?:\+[^+\s]+)+$/u;

/** A named key (`esc`, `Tab`, `F12`) or any other single character. */
const GLYPH_RUN_TOKEN = /[A-Za-z0-9]{2,}|./gu;

/**
 * Splits a shortcut display string into its individual keys.
 *
 * The non-macOS form is space-separated (`Ctrl Shift K`), while the macOS
 * form is a run of single-character glyphs and a key (`⌘⇧K`, `⌘←`). A named
 * key stays whole (`esc`, `⇧Tab`), and a legacy plus-separated chord
 * (`Ctrl+L`, `⌘+Z`) splits on its separators.
 */
export function splitShortcutKeys(shortcut: string): string[] {
  const trimmed = shortcut.trim();
  if (trimmed.length === 0) {
    return [];
  }
  if (/\s/u.test(trimmed)) {
    return trimmed.split(/\s+/u);
  }
  if (PLUS_SEPARATED_CHORD.test(trimmed)) {
    return trimmed.split('+');
  }
  return trimmed.match(GLYPH_RUN_TOKEN) ?? [];
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
