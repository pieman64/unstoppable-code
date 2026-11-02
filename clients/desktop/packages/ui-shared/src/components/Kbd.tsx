import type { JSX } from 'react';
import {
  SHORTCUT_MODIFIER_GLYPHS,
  shortcutGlyphSitsLow,
  splitShortcutKeys,
} from '../lib/shortcut-keys';

/**
 * One key cap: an 18px capsule filled with the muted surface and no border,
 * so it reads as a key without adding an outline to the line it sits in.
 */
export const KBD_CAP_CLASS_NAME =
  'inline-flex h-4.5 min-w-4.5 items-center justify-center whitespace-nowrap rounded-full bg-muted px-1.25 font-sans text-2xs font-normal leading-none tabular-nums fg-tertiary';

function capGlyphClassName(key: string): string | undefined {
  // ⌘ ⇧ ⌥ ⌃ draw small beside a letter at the same size; one step up
  // balances them optically. Descending glyphs lift to centre their ink.
  if (SHORTCUT_MODIFIER_GLYPHS.has(key)) return 'text-xs leading-none';
  if (shortcutGlyphSitsLow(key)) return '-translate-y-px';
  return undefined;
}

export interface KbdProps {
  /**
   * The keys, in press order (`['⌘', 'K']`, see `shortcutKeys(id)`), or a
   * display string such as `⌘⇧K` or `Ctrl Shift K` (see `formatShortcut`).
   */
  shortcut: string | readonly string[];
  /** Placement only; the caps own their size, fill and type. */
  className?: string;
  /** Hide the caps from assistive technology when the control names them. */
  'aria-hidden'?: boolean;
  'data-testid'?: string;
}

/**
 * Keyboard hint drawn as one filled cap per key. Use it in tooltips, picker
 * footers, empty fields and settings; a button carries its shortcut as a
 * `KbdChip` instead, and a menu row as plain trailing text.
 */
export function Kbd({
  shortcut,
  className = '',
  'aria-hidden': ariaHidden,
  'data-testid': testId = 'kbd',
}: KbdProps): JSX.Element {
  const keys =
    typeof shortcut === 'string' ? splitShortcutKeys(shortcut) : shortcut;
  return (
    <span
      aria-hidden={ariaHidden}
      className={`inline-flex shrink-0 items-center gap-0.75 align-middle ${className}`}
      data-testid={testId}
    >
      {keys.map((key, index) => (
        <kbd key={`${key}-${index}`} className={KBD_CAP_CLASS_NAME}>
          <span className={capGlyphClassName(key)}>{key}</span>
        </kbd>
      ))}
    </span>
  );
}
