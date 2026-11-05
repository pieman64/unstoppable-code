import { isMacPlatform } from './shortcut-platform';

/**
 * The bulk selection's gestures on a sidebar row (CAN-3975), shared by the
 * worktree rows and the Work Entry rows so every selectable row reads clicks
 * and keys the same way. Pure: the rows apply the intent.
 */

export interface SelectionGestureInputs {
  /** The row can join the selection. */
  readonly selectable: boolean;
  /** Any row in the rail is selected. */
  readonly active: boolean;
}

/**
 * `toggle`: the platform command-click. `range`: Shift-click, with or
 * without the command key (Finder keeps earlier picks either way). `open`: a
 * plain click with no selection, or a modified click on an unselectable row.
 * `open-and-clear`: a plain click while a selection is active. A plain click
 * on a selectable row also anchors later Shift ranges there.
 */
export type SelectionClickIntent =
  | 'toggle'
  | 'range'
  | 'open'
  | 'open-and-clear';

/** `extend-up` / `extend-down`: Shift+Up/Down move the Shift range's far end. */
export type SelectionKeyIntent =
  | 'toggle'
  | 'select-all'
  | 'clear'
  | 'extend-up'
  | 'extend-down'
  | null;

export interface ModifierKeys {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/** The command modifier is Cmd on macOS and Ctrl elsewhere. */
function commandKey(event: ModifierKeys, isMac: boolean): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
}

export function resolveSelectionClick(
  event: ModifierKeys,
  inputs: SelectionGestureInputs,
  isMac: boolean = isMacPlatform(),
): SelectionClickIntent {
  const command = commandKey(event, isMac);
  if (inputs.selectable) {
    if (event.shiftKey) return 'range';
    if (command) return 'toggle';
  }
  if (command || event.shiftKey) return 'open';
  return inputs.active ? 'open-and-clear' : 'open';
}

export function resolveSelectionKey(
  event: ModifierKeys & { readonly key: string },
  inputs: SelectionGestureInputs & { readonly escapeClears: boolean },
  isMac: boolean = isMacPlatform(),
): SelectionKeyIntent {
  const command = commandKey(event, isMac);
  if (
    (event.key === 'x' || event.key === 'X') &&
    !command &&
    !event.altKey &&
    inputs.selectable
  ) {
    return 'toggle';
  }
  if (
    (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
    event.shiftKey &&
    !command &&
    !event.altKey &&
    inputs.selectable
  ) {
    return event.key === 'ArrowUp' ? 'extend-up' : 'extend-down';
  }
  if ((event.key === 'a' || event.key === 'A') && command && !event.altKey) {
    return 'select-all';
  }
  if (event.key === 'Escape' && inputs.active && inputs.escapeClears) {
    return 'clear';
  }
  return null;
}

/** Shift-click on a selectable row ranges, so it must not select text. */
export function shiftMouseDownSuppressesTextSelection(
  event: { readonly shiftKey: boolean },
  selectable: boolean,
): boolean {
  return event.shiftKey && selectable;
}

/**
 * Focuses the rendered row that carries `key` in the selection-row attribute,
 * after Shift+Up/Down moved the range there. Pinned copies carry no key.
 */
export function focusSelectionRow(
  from: HTMLElement,
  attribute: string,
  key: string,
): void {
  const row = from.ownerDocument.querySelector<HTMLElement>(
    `[${attribute}="${CSS.escape(key)}"]`,
  );
  row?.focus();
}
