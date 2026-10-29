import {
  acceleratorFromKeyboardEvent,
  type AcceleratorKeyboardEventLike,
  type ShortcutPlatform,
} from '@canopy/protocol/shortcuts';

/** What one keydown means to a shortcut recorder. */
export type ShortcutRecorderKey =
  /** Focus movement: let the browser handle it. */
  | { readonly kind: 'pass' }
  /** Bare Escape: stop recording without saving. */
  | { readonly kind: 'cancel' }
  /** Bare Backspace or Delete: record "no shortcut". */
  | { readonly kind: 'clear' }
  /** A modifier alone or a key outside the accelerator grammar. */
  | { readonly kind: 'ignore' }
  | { readonly kind: 'record'; readonly accelerator: string };

/**
 * Interprets a recorder keydown. The physical key (`event.code`) decides the
 * chord, so macOS Option composition does not change the binding. Tab and
 * Shift+Tab always move focus, so keyboard users can reach Save and Cancel.
 */
export function interpretShortcutRecorderKey(
  event: AcceleratorKeyboardEventLike,
  platform: ShortcutPlatform,
): ShortcutRecorderKey {
  if (event.code === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey)
    return { kind: 'pass' };
  const bare =
    !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
  if (bare && event.code === 'Escape') return { kind: 'cancel' };
  if (bare && (event.code === 'Backspace' || event.code === 'Delete'))
    return { kind: 'clear' };
  const accelerator = acceleratorFromKeyboardEvent(event, platform);
  return accelerator === null
    ? { kind: 'ignore' }
    : { kind: 'record', accelerator };
}
