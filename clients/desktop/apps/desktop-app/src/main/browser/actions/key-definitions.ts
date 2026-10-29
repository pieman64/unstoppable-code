import { resolveBrowserShortcutAction } from '../browser-shortcuts';

export type KeyModifier = 'Alt' | 'Control' | 'Meta' | 'Shift';
export type ParsedKeyCombo = {
  ok: true;
  key: string;
  modifiers: KeyModifier[];
};
export type KeyComboParseError = {
  ok: false;
  error: {
    code:
      | 'empty'
      | 'missing_key'
      | 'multiple_keys'
      | 'duplicate_modifier'
      | 'unknown_key';
    message: string;
  };
};
export type KeyDefinition = {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
};
/**
 * No `nativeVirtualKeyCode`: Chromium turns a nonzero one into a real OS key
 * event that macOS offers to the app menu when the page leaves it unhandled,
 * so agent typing could run app menu items. Without it the key stays in the
 * page, as in Playwright.
 */
export type KeyEvent = KeyDefinition & {
  type: 'rawKeyDown' | 'keyDown' | 'keyUp';
  modifiers: number;
  commands?: string[];
  unmodifiedText?: string;
};

const modifierBits: Record<KeyModifier, number> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

// Browser-use's named get_key_info keys, with the corresponding Windows VK values.
const namedCodes: Record<string, [string, number, string?]> = {
  Alt: ['AltLeft', 18],
  Control: ['ControlLeft', 17],
  Meta: ['MetaLeft', 91],
  Shift: ['ShiftLeft', 16],
  Backspace: ['Backspace', 8],
  Tab: ['Tab', 9],
  Enter: ['Enter', 13, '\r'],
  Escape: ['Escape', 27],
  Space: ['Space', 32, ' '],
  PageUp: ['PageUp', 33],
  PageDown: ['PageDown', 34],
  End: ['End', 35],
  Home: ['Home', 36],
  ArrowLeft: ['ArrowLeft', 37],
  ArrowUp: ['ArrowUp', 38],
  ArrowRight: ['ArrowRight', 39],
  ArrowDown: ['ArrowDown', 40],
  Insert: ['Insert', 45],
  Delete: ['Delete', 46],
  F1: ['F1', 112],
  F2: ['F2', 113],
  F3: ['F3', 114],
  F4: ['F4', 115],
  F5: ['F5', 116],
  F6: ['F6', 117],
  F7: ['F7', 118],
  F8: ['F8', 119],
  F9: ['F9', 120],
  F10: ['F10', 121],
  F11: ['F11', 122],
  F12: ['F12', 123],
};

const punctuation: Record<string, [string, number]> = {
  '`': ['Backquote', 192],
  '~': ['Backquote', 192],
  '-': ['Minus', 189],
  _: ['Minus', 189],
  '=': ['Equal', 187],
  '+': ['Equal', 187],
  '[': ['BracketLeft', 219],
  '{': ['BracketLeft', 219],
  ']': ['BracketRight', 221],
  '}': ['BracketRight', 221],
  '\\': ['Backslash', 220],
  '|': ['Backslash', 220],
  ';': ['Semicolon', 186],
  ':': ['Semicolon', 186],
  "'": ['Quote', 222],
  '"': ['Quote', 222],
  ',': ['Comma', 188],
  '<': ['Comma', 188],
  '.': ['Period', 190],
  '>': ['Period', 190],
  '/': ['Slash', 191],
  '?': ['Slash', 191],
  '!': ['Digit1', 49],
  '@': ['Digit2', 50],
  '#': ['Digit3', 51],
  $: ['Digit4', 52],
  '%': ['Digit5', 53],
  '^': ['Digit6', 54],
  '&': ['Digit7', 55],
  '*': ['Digit8', 56],
  '(': ['Digit9', 57],
  ')': ['Digit0', 48],
};

const shiftedCharacters: Record<string, string> = {
  '`': '~',
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
  '-': '_',
  '=': '+',
  '[': '{',
  ']': '}',
  '\\': '|',
  ';': ':',
  "'": '"',
  ',': '<',
  '.': '>',
  '/': '?',
};

const aliases: Record<string, string> = {
  cmd: 'Meta',
  command: 'Meta',
  meta: 'Meta',
  ctrl: 'Control',
  control: 'Control',
  option: 'Alt',
  opt: 'Alt',
  alt: 'Alt',
  shift: 'Shift',
  esc: 'Escape',
  escape: 'Escape',
  return: 'Enter',
  enter: 'Enter',
  del: 'Delete',
  delete: 'Delete',
  backspace: 'Backspace',
  space: 'Space',
  spacebar: 'Space',
  tab: 'Tab',
  insert: 'Insert',
  ins: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
};

function parseError(
  code: KeyComboParseError['error']['code'],
  message: string,
): KeyComboParseError {
  return { ok: false, error: { code, message } };
}

export function parseKeyCombo(
  input: string,
  platform: NodeJS.Platform,
): ParsedKeyCombo | KeyComboParseError {
  if (!input.trim()) return parseError('empty', 'Key combo is empty');
  const trimmed = input.trim();
  const parts =
    trimmed === '+'
      ? ['+']
      : trimmed.endsWith('++')
        ? [
            ...trimmed
              .slice(0, -2)
              .split('+')
              .map((part) => part.trim()),
            '+',
          ]
        : trimmed.split('+').map((part) => part.trim());
  if (parts.some((part) => !part))
    return parseError('missing_key', 'Key combo has an empty part');
  const modifiers: KeyModifier[] = [];
  let key: string | undefined;
  for (const part of parts) {
    const lower = part.toLowerCase();
    const canonical =
      lower === 'controlormeta'
        ? platform === 'darwin'
          ? 'Meta'
          : 'Control'
        : (aliases[lower] ??
          (/^f(?:[1-9]|1[0-2])$/.test(lower) ? lower.toUpperCase() : part));
    if (
      canonical === 'Alt' ||
      canonical === 'Control' ||
      canonical === 'Meta' ||
      canonical === 'Shift'
    ) {
      if (modifiers.includes(canonical))
        return parseError(
          'duplicate_modifier',
          `Duplicate modifier: ${canonical}`,
        );
      modifiers.push(canonical);
    } else {
      if (key)
        return parseError('multiple_keys', 'Key combo has multiple main keys');
      if (Array.from(canonical).length !== 1 && !namedCodes[canonical])
        return parseError('unknown_key', `Unknown key: ${part}`);
      key = canonical;
    }
  }
  if (!key) return parseError('missing_key', 'Key combo has no main key');
  return { ok: true, key, modifiers };
}

export function keyDefinition(key: string): KeyDefinition {
  const named = namedCodes[key];
  if (named) {
    const [code, virtualKeyCode, text] = named;
    return {
      key: key === 'Space' ? ' ' : key,
      code,
      windowsVirtualKeyCode: virtualKeyCode,
      ...(text !== undefined ? { text } : {}),
    };
  }
  if (/^[a-z]$/i.test(key)) {
    const virtualKeyCode = key.toUpperCase().charCodeAt(0);
    return {
      key,
      code: `Key${key.toUpperCase()}`,
      windowsVirtualKeyCode: virtualKeyCode,
      text: key,
    };
  }
  if (/^[0-9]$/.test(key)) {
    const virtualKeyCode = key.charCodeAt(0);
    return {
      key,
      code: `Digit${key}`,
      windowsVirtualKeyCode: virtualKeyCode,
      text: key,
    };
  }
  const mapped = punctuation[key];
  if (mapped)
    return {
      key,
      code: mapped[0],
      windowsVirtualKeyCode: mapped[1],
      text: key,
    };
  return {
    key,
    code: key,
    windowsVirtualKeyCode: 0,
    ...(Array.from(key).length === 1 ? { text: key } : {}),
  };
}

// Chromium selectors from Playwright's macEditingCommands, without trailing colons.
const macEditingCommands: Record<string, string[]> = {
  Backspace: ['deleteBackward'],
  Delete: ['deleteForward'],
  Escape: ['cancelOperation'],
  Home: ['scrollToBeginningOfDocument'],
  End: ['scrollToEndOfDocument'],
  PageUp: ['scrollPageUp'],
  PageDown: ['scrollPageDown'],
  'Shift+Backspace': ['deleteBackward'],
  'Shift+Delete': ['deleteForward'],
  'Shift+Home': ['moveToBeginningOfDocumentAndModifySelection'],
  'Shift+End': ['moveToEndOfDocumentAndModifySelection'],
  'Shift+PageUp': ['pageUpAndModifySelection'],
  'Shift+PageDown': ['pageDownAndModifySelection'],
  'Meta+KeyA': ['selectAll'],
  'Meta+KeyC': ['copy'],
  'Meta+KeyX': ['cut'],
  'Meta+KeyV': ['paste'],
  'Meta+KeyZ': ['undo'],
  'Shift+Meta+KeyZ': ['redo'],
  'Alt+Backspace': ['deleteWordBackward'],
  'Alt+Delete': ['deleteWordForward'],
  'Meta+Backspace': ['deleteToBeginningOfLine'],
  ArrowLeft: ['moveLeft'],
  ArrowRight: ['moveRight'],
  ArrowUp: ['moveUp'],
  ArrowDown: ['moveDown'],
  'Shift+ArrowLeft': ['moveLeftAndModifySelection'],
  'Shift+ArrowRight': ['moveRightAndModifySelection'],
  'Shift+ArrowUp': ['moveUpAndModifySelection'],
  'Shift+ArrowDown': ['moveDownAndModifySelection'],
  'Alt+ArrowLeft': ['moveWordLeft'],
  'Alt+ArrowRight': ['moveWordRight'],
  'Alt+ArrowUp': ['moveBackward', 'moveToBeginningOfParagraph'],
  'Alt+ArrowDown': ['moveForward', 'moveToEndOfParagraph'],
  'Shift+Alt+ArrowLeft': ['moveWordLeftAndModifySelection'],
  'Shift+Alt+ArrowRight': ['moveWordRightAndModifySelection'],
  'Shift+Alt+ArrowUp': ['moveParagraphBackwardAndModifySelection'],
  'Shift+Alt+ArrowDown': ['moveParagraphForwardAndModifySelection'],
  'Meta+ArrowLeft': ['moveToLeftEndOfLine'],
  'Meta+ArrowRight': ['moveToRightEndOfLine'],
  'Meta+ArrowUp': ['moveToBeginningOfDocument'],
  'Meta+ArrowDown': ['moveToEndOfDocument'],
  'Shift+Meta+ArrowLeft': ['moveToLeftEndOfLineAndModifySelection'],
  'Shift+Meta+ArrowRight': ['moveToRightEndOfLineAndModifySelection'],
  'Shift+Meta+ArrowUp': ['moveToBeginningOfDocumentAndModifySelection'],
  'Shift+Meta+ArrowDown': ['moveToEndOfDocumentAndModifySelection'],
  'Control+ArrowLeft': ['moveToLeftEndOfLine'],
  'Control+ArrowRight': ['moveToRightEndOfLine'],
  'Control+ArrowUp': ['scrollPageUp'],
  'Control+ArrowDown': ['scrollPageDown'],
  'Shift+Control+ArrowLeft': ['moveToLeftEndOfLineAndModifySelection'],
  'Shift+Control+ArrowRight': ['moveToRightEndOfLineAndModifySelection'],
  'Shift+Control+ArrowUp': ['scrollPageUp'],
  'Shift+Control+ArrowDown': ['scrollPageDown'],
};

function event(
  type: KeyEvent['type'],
  definition: KeyDefinition,
  modifiers: number,
  commands?: string[],
  unmodifiedText?: string,
): KeyEvent {
  const { text, ...base } = definition;
  return {
    ...base,
    type,
    modifiers,
    ...(type === 'keyDown' && text !== undefined ? { text } : {}),
    ...(type === 'keyDown' && unmodifiedText !== undefined
      ? { unmodifiedText }
      : {}),
    ...(commands ? { commands } : {}),
  };
}

export function buildKeyEventSequence(
  combo: ParsedKeyCombo,
  platform: NodeJS.Platform,
): KeyEvent[] {
  const events: KeyEvent[] = [];
  let mask = 0;
  for (const modifier of combo.modifiers) {
    mask |= modifierBits[modifier];
    events.push(event('rawKeyDown', keyDefinition(modifier), mask));
  }
  const definition = keyDefinition(combo.key);
  const shiftedKey = combo.modifiers.includes('Shift')
    ? /^[a-z]$/.test(definition.key)
      ? definition.key.toUpperCase()
      : (shiftedCharacters[definition.key] ?? definition.key)
    : definition.key;
  const main =
    shiftedKey === definition.key ? definition : keyDefinition(shiftedKey);
  const hasCommandModifier = combo.modifiers.some(
    (modifier) =>
      modifier === 'Control' || modifier === 'Meta' || modifier === 'Alt',
  );
  const shortcut = [
    ...(['Shift', 'Control', 'Alt', 'Meta'] as const).filter((modifier) =>
      combo.modifiers.includes(modifier),
    ),
    main.code,
  ].join('+');
  const commands =
    platform === 'darwin' ? macEditingCommands[shortcut] : undefined;
  // The text rides on the keyDown, not a separate char event: Chromium then
  // inserts it only when the page does not cancel the keydown, so an editor
  // that handles Enter itself gets one line break, not two.
  const typed = main.text !== undefined && !hasCommandModifier;
  events.push(
    event(
      typed ? 'keyDown' : 'rawKeyDown',
      main,
      mask,
      commands,
      typed && shiftedKey !== definition.key ? definition.text : undefined,
    ),
  );
  events.push(event('keyUp', main, mask));
  for (const modifier of [...combo.modifiers].reverse()) {
    mask &= ~modifierBits[modifier];
    events.push(event('keyUp', keyDefinition(modifier), mask));
  }
  return events;
}

export function isChordRefused(
  combo: ParsedKeyCombo,
  platform: NodeJS.Platform,
): string | null {
  const definition = keyDefinition(combo.key);
  const modifiers = combo.modifiers;
  const command = modifiers.includes('Control') || modifiers.includes('Meta');
  if (
    (command && definition.code === 'KeyV' && !modifiers.includes('Alt')) ||
    (modifiers.includes('Shift') && definition.code === 'Insert')
  )
    return 'Paste chords are not allowed';
  const action = resolveBrowserShortcutAction(
    {
      type: 'keyDown',
      code: definition.code,
      alt: modifiers.includes('Alt'),
      control: modifiers.includes('Control'),
      meta: modifiers.includes('Meta'),
      shift: modifiers.includes('Shift'),
    },
    platform,
  );
  return action ? `App browser shortcut: ${action}` : null;
}
