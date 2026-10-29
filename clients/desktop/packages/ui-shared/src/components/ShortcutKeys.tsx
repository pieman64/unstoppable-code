import type { JSX } from 'react';
import {
  SHORTCUT_MODIFIER_GLYPHS,
  splitShortcutKeys,
} from '../lib/shortcut-keys';

export interface ShortcutKeysProps {
  /** A shortcut display string such as `⌘⇧K` or `Ctrl Shift K`. */
  shortcut: string;
}

/** Renders a shortcut as discrete, optically balanced key caps. */
export function ShortcutKeys({ shortcut }: ShortcutKeysProps): JSX.Element {
  const keys = splitShortcutKeys(shortcut);

  return (
    <span
      className="inline-flex items-center gap-1"
      data-testid="shortcut-keys"
    >
      {keys.map((key, index) => (
        <kbd
          key={`${key}-${index}`}
          className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border bg-secondary px-1.5 font-sans text-xs leading-none fg-secondary"
        >
          <span
            className={
              SHORTCUT_MODIFIER_GLYPHS.has(key)
                ? 'text-s leading-none'
                : undefined
            }
          >
            {key}
          </span>
        </kbd>
      ))}
    </span>
  );
}
