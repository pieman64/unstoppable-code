/**
 * Strict, environment-neutral handling of Electron accelerator strings for
 * the user-configurable OS-level focus shortcut (CAN-1963).
 *
 * Electron's own parser is permissive: `globalShortcut.register('Bogus+Q')`
 * silently registers a bare `Q`, and chords the OS reserves (⌘Space, ⌘Tab,
 * ⌘⇧4) "register" successfully but never fire. Everything the app saves,
 * displays, or hands to Electron therefore goes through this module first.
 *
 * The primary platform modifier is always stored as `CommandOrControl` so a
 * saved value reads the same on every platform and matches the default.
 */

export type ShortcutPlatform = 'darwin' | 'win32' | 'linux';

/** Collapses a Node `process.platform` value onto the three shortcut platforms. */
export function toShortcutPlatform(platform: string): ShortcutPlatform {
  if (platform === 'darwin') return 'darwin';
  if (platform === 'win32') return 'win32';
  return 'linux';
}

export const GLOBAL_FOCUS_SHORTCUT_DEFAULT_ACCELERATOR =
  'CommandOrControl+Shift+O';

export type AcceleratorModifier =
  | 'CommandOrControl'
  | 'Command'
  | 'Control'
  | 'Alt'
  | 'Shift'
  | 'Super';

/** Canonical output order for modifiers. */
const MODIFIER_ORDER: readonly AcceleratorModifier[] = [
  'CommandOrControl',
  'Command',
  'Control',
  'Alt',
  'Shift',
  'Super',
];

const MODIFIER_ALIASES: Readonly<Record<string, AcceleratorModifier>> = {
  commandorcontrol: 'CommandOrControl',
  cmdorctrl: 'CommandOrControl',
  command: 'Command',
  cmd: 'Command',
  control: 'Control',
  ctrl: 'Control',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super',
};

const NAMED_KEYS: Readonly<Record<string, string>> = {
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  return: 'Return',
  enter: 'Return',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  escape: 'Escape',
  esc: 'Escape',
};

const PUNCTUATION_KEYS: ReadonlySet<string> = new Set([
  '`',
  '-',
  '=',
  '[',
  ']',
  '\\',
  ';',
  "'",
  ',',
  '.',
  '/',
]);

/** `KeyboardEvent.code` → canonical accelerator key. */
const CODE_TO_KEY: Readonly<Record<string, string>> = {
  Space: 'Space',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Enter: 'Return',
  NumpadEnter: 'Return',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Escape: 'Escape',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

export interface ParsedAccelerator {
  modifiers: readonly AcceleratorModifier[];
  key: string;
}

function normalizeKeyToken(token: string): string | null {
  const trimmed = token.trim();
  if (trimmed.length === 0) return null;
  if (/^[a-z]$/i.test(trimmed)) return trimmed.toUpperCase();
  if (/^[0-9]$/.test(trimmed)) return trimmed;
  if (PUNCTUATION_KEYS.has(trimmed)) return trimmed;
  const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(trimmed);
  if (functionKey) return `F${functionKey[1]}`;
  return NAMED_KEYS[trimmed.toLowerCase()] ?? null;
}

/**
 * Parses an accelerator string into canonical modifiers plus one key.
 * Returns `null` for anything Electron would silently mangle: unknown
 * tokens, duplicate modifiers, a missing key, or a modifier-only chord.
 * Accepts `unknown` because persisted preference values reach it untyped.
 */
export function parseAccelerator(value: unknown): ParsedAccelerator | null {
  if (typeof value !== 'string') return null;
  const tokens = value.split('+').map((token) => token.trim());
  if (tokens.length === 0 || tokens.some((token) => token.length === 0)) {
    return null;
  }
  const keyToken = tokens[tokens.length - 1];
  if (keyToken === undefined) return null;
  const key = normalizeKeyToken(keyToken);
  if (key === null) return null;
  const modifiers = new Set<AcceleratorModifier>();
  for (const token of tokens.slice(0, -1)) {
    const modifier = MODIFIER_ALIASES[token.toLowerCase()];
    if (modifier === undefined || modifiers.has(modifier)) return null;
    modifiers.add(modifier);
  }
  return {
    modifiers: MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)),
    key,
  };
}

export function formatAccelerator(parsed: ParsedAccelerator): string {
  return [...parsed.modifiers, parsed.key].join('+');
}

/** Canonical form of `value`, or `null` when it does not parse. */
export function normalizeAccelerator(value: unknown): string | null {
  const parsed = parseAccelerator(value);
  return parsed === null ? null : formatAccelerator(parsed);
}

export interface AcceleratorKeyboardEventLike {
  code: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

function keyFromEventCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1] ?? null;
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit) return digit[1] ?? null;
  const functionKey = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
  if (functionKey) return `F${functionKey[1]}`;
  return CODE_TO_KEY[code] ?? null;
}

/**
 * Builds the accelerator a keydown represents, keyed on the PHYSICAL key
 * (`event.code`) so macOS Option composition (⌥O → `ø` in `event.key`) does
 * not change the binding. Returns `null` for modifier-only presses and keys
 * the accelerator grammar does not cover.
 */
export function acceleratorFromKeyboardEvent(
  event: AcceleratorKeyboardEventLike,
  platform: ShortcutPlatform,
): string | null {
  const key = keyFromEventCode(event.code);
  if (key === null) return null;
  const modifiers = new Set<AcceleratorModifier>();
  if (platform === 'darwin') {
    if (event.metaKey) modifiers.add('CommandOrControl');
    if (event.ctrlKey) modifiers.add('Control');
  } else {
    if (event.ctrlKey) modifiers.add('CommandOrControl');
    if (event.metaKey) modifiers.add('Super');
  }
  if (event.altKey) modifiers.add('Alt');
  if (event.shiftKey) modifiers.add('Shift');
  return formatAccelerator({
    modifiers: MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)),
    key,
  });
}

type ResolvedModifier = 'Command' | 'Control' | 'Alt' | 'Shift' | 'Super';

/**
 * Collapses `CommandOrControl` onto the platform's real modifier, and `Super`
 * onto `Command` on macOS, where Electron treats the two as the same key (the
 * display layer already renders both as ⌘). Without that collapse `Super+C`
 * would slip past the ⌘C reservation.
 */
function resolveModifiers(
  modifiers: readonly AcceleratorModifier[],
  platform: ShortcutPlatform,
): Set<ResolvedModifier> {
  const resolved = new Set<ResolvedModifier>();
  for (const modifier of modifiers) {
    if (modifier === 'CommandOrControl') {
      resolved.add(platform === 'darwin' ? 'Command' : 'Control');
    } else if (modifier === 'Super' && platform === 'darwin') {
      resolved.add('Command');
    } else {
      resolved.add(modifier);
    }
  }
  return resolved;
}

const MAC_GLYPHS: Readonly<Record<ResolvedModifier, string>> = {
  Control: '⌃',
  Command: '⌘',
  Alt: '⌥',
  Shift: '⇧',
  Super: '⌘',
};

const OTHER_LABELS: Readonly<Record<ResolvedModifier, string>> = {
  Control: 'Ctrl',
  Super: 'Win',
  Alt: 'Alt',
  Shift: 'Shift',
  Command: 'Cmd',
};

/** Display order mirrors the in-app shortcut table (`⌘⇧K`, `Ctrl Alt ←`). */
const MAC_DISPLAY_ORDER: readonly ResolvedModifier[] = [
  'Control',
  'Command',
  'Super',
  'Alt',
  'Shift',
];
const OTHER_DISPLAY_ORDER: readonly ResolvedModifier[] = [
  'Control',
  'Super',
  'Alt',
  'Shift',
  'Command',
];

const MAC_KEY_LABELS: Readonly<Record<string, string>> = {
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Return: '↩',
  Backspace: '⌫',
  Delete: '⌦',
  Escape: '⎋',
  Tab: '⇥',
};

const OTHER_KEY_LABELS: Readonly<Record<string, string>> = {
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Return: 'Enter',
  Delete: 'Del',
  Escape: 'Esc',
};

/**
 * Platform display string in the shape `ShortcutKeys` / `splitShortcutKeys`
 * expect: a spaceless glyph run on macOS (`⌘⇧O`) and space-separated words
 * elsewhere (`Ctrl Shift O`). A macOS key label longer than one glyph
 * (`F5`, `Space`) is space-separated too, because `splitShortcutKeys` splits
 * a spaceless string per character.
 */
export function formatAcceleratorForDisplay(
  accelerator: string,
  platform: ShortcutPlatform,
): string {
  const parsed = parseAccelerator(accelerator);
  if (parsed === null) return accelerator;
  const resolved = resolveModifiers(parsed.modifiers, platform);
  if (platform === 'darwin') {
    const glyphs = Array.from(
      new Set(
        MAC_DISPLAY_ORDER.filter((modifier) => resolved.has(modifier)).map(
          (modifier) => MAC_GLYPHS[modifier],
        ),
      ),
    );
    const keyLabel = MAC_KEY_LABELS[parsed.key] ?? parsed.key;
    const parts = [...glyphs, keyLabel];
    return keyLabel.length > 1 ? parts.join(' ') : parts.join('');
  }
  const labels = OTHER_DISPLAY_ORDER.filter((modifier) =>
    resolved.has(modifier),
  ).map((modifier) => OTHER_LABELS[modifier]);
  return [...labels, OTHER_KEY_LABELS[parsed.key] ?? parsed.key].join(' ');
}

export type GlobalShortcutValidationFailure =
  | 'invalid'
  | 'needs-modifier'
  | 'reserved';

export type GlobalShortcutValidation =
  | { ok: true; accelerator: string }
  | { ok: false; reason: GlobalShortcutValidationFailure };

/**
 * Chords the OS handles before any application sees them. Electron reports
 * these as registered, so they must be refused up front. Written with
 * `CommandOrControl` where the chord is the platform-primary modifier so the
 * comparison resolves the same way user input does. `RESERVED_EVERYWHERE`
 * below adds the editing chords that are not OS-owned but would break every
 * other application.
 */
const RESERVED_BY_PLATFORM: Readonly<
  Record<ShortcutPlatform, readonly string[]>
> = {
  darwin: [
    'CommandOrControl+Space',
    'CommandOrControl+Alt+Space',
    'CommandOrControl+Tab',
    'CommandOrControl+Shift+Tab',
    'CommandOrControl+Q',
    'CommandOrControl+Shift+Q',
    'CommandOrControl+Control+Q',
    'CommandOrControl+H',
    'CommandOrControl+Alt+H',
    'CommandOrControl+M',
    'CommandOrControl+Shift+3',
    'CommandOrControl+Shift+4',
    'CommandOrControl+Shift+5',
    'CommandOrControl+Alt+Escape',
    'CommandOrControl+Control+F',
    // Mission Control, App Exposé, and Spaces switching.
    'Control+Up',
    'Control+Down',
    'Control+Left',
    'Control+Right',
    // Application-menu accelerator (Settings). Unreachable via the recorder,
    // but a hand-edited preferences file must not claim it.
    'CommandOrControl+,',
    // Control-modifier chords are not the primary modifier on macOS, so the
    // everywhere-list does not cover them, yet the recorder produces
    // `Control+C` from a real Ctrl+C press. ⌃C is SIGINT in every terminal,
    // ⌃D ends input, ⌃Z suspends, ⌃Space switches input sources or triggers
    // autocomplete, and the rest are the standard Cocoa text bindings
    // (`StandardKeyBinding.dict`) that every macOS text field honours:
    // ⌃A/⌃E line ends, ⌃B/⌃F characters, ⌃N/⌃P lines, ⌃H delete, ⌃K/⌃U/⌃W
    // kill, ⌃Y yank, ⌃T transpose, ⌃O insert newline, ⌃V page down, ⌃L
    // centre selection.
    'Control+A',
    'Control+B',
    'Control+C',
    'Control+D',
    'Control+E',
    'Control+F',
    'Control+H',
    'Control+K',
    'Control+L',
    'Control+N',
    'Control+O',
    'Control+P',
    'Control+T',
    'Control+U',
    'Control+V',
    'Control+W',
    'Control+Y',
    'Control+Z',
    'Control+Space',
  ],
  win32: [
    'Control+Alt+Delete',
    'Control+Shift+Escape',
    'Control+Escape',
    'Alt+Tab',
    'Alt+Shift+Tab',
    'Alt+Escape',
    'Alt+F4',
    // The window system menu; unlike most Super chords, Electron would
    // register it and claim it application-wide.
    'Alt+Space',
    // Shell-owned Windows key chords: lock, desktop, task view, Action
    // Center, Explorer, Game Bar, Settings, Project, Run, Search, and the
    // power-user menu. The shell takes them before any window sees the key.
    'Super+L',
    'Super+D',
    'Super+Tab',
    'Super+A',
    'Super+E',
    'Super+G',
    'Super+I',
    'Super+P',
    'Super+R',
    'Super+S',
    'Super+X',
  ],
  linux: [
    'Control+Alt+Delete',
    'Control+Alt+Backspace',
    'Alt+Tab',
    'Alt+Shift+Tab',
    'Alt+F4',
    'Super+L',
  ],
};

/**
 * Standard editing chords every application relies on. Electron would register
 * them, and nothing else would warn: claiming ⌘C system-wide breaks copy in
 * every other app, and recovery means returning here to change the chord. So
 * they are reserved on every platform (`CommandOrControl` resolves per OS).
 */
const RESERVED_EVERYWHERE: readonly string[] = [
  'CommandOrControl+A',
  'CommandOrControl+C',
  'CommandOrControl+V',
  'CommandOrControl+X',
  'CommandOrControl+Z',
  'CommandOrControl+Shift+Z',
  'CommandOrControl+Y',
  'CommandOrControl+S',
  'CommandOrControl+F',
  // Window and document chords: claiming ⌘W system-wide stops the user
  // closing a tab or window in any other application.
  'CommandOrControl+W',
  'CommandOrControl+P',
  'CommandOrControl+N',
  'CommandOrControl+T',
];

function modifierSignature(
  parsed: ParsedAccelerator,
  platform: ShortcutPlatform,
): string {
  const resolved = resolveModifiers(parsed.modifiers, platform);
  return `${Array.from(resolved).sort().join('+')}|${parsed.key}`;
}

function isReserved(
  parsed: ParsedAccelerator,
  platform: ShortcutPlatform,
): boolean {
  const signature = modifierSignature(parsed, platform);
  return [...RESERVED_EVERYWHERE, ...RESERVED_BY_PLATFORM[platform]].some(
    (reserved) => {
      const reservedParsed = parseAccelerator(reserved);
      return (
        reservedParsed !== null &&
        modifierSignature(reservedParsed, platform) === signature
      );
    },
  );
}

type ParsedGlobalShortcut = NonNullable<ReturnType<typeof parseAccelerator>>;

/**
 * Drop modifiers that duplicate `CommandOrControl` on this platform
 * (`Command` and `Super` on macOS, `Control` elsewhere) so the saved,
 * displayed, and bound chords agree. Only a hand-edited preferences file can
 * spell such a chord; the recorder never emits one.
 */
function collapseRedundantModifiers(
  parsed: ParsedGlobalShortcut,
  platform: ShortcutPlatform,
): ParsedGlobalShortcut {
  if (!parsed.modifiers.includes('CommandOrControl')) return parsed;
  const redundant: readonly string[] =
    platform === 'darwin' ? ['Command', 'Super'] : ['Control'];
  const modifiers = parsed.modifiers.filter(
    (modifier) => !redundant.includes(modifier),
  );
  return modifiers.length === parsed.modifiers.length
    ? parsed
    : { ...parsed, modifiers };
}

/**
 * Whether a chord may be registered system-wide: it must parse, it must not
 * be an OS-reserved chord, and it must carry a modifier other than Shift.
 * That rule covers function keys too: a bare F5 would never intercept
 * typing, but it would swallow browser refresh, IDE run, and every other
 * single-key binding in every application. On macOS `Alt` (⌥) does not
 * satisfy it either: ⌥+key is the special-character layer (⌥e→´, ⌥o→ø,
 * ⌥Space→NBSP), so a bare ⌥ chord would intercept typing everywhere.
 */
export function validateGlobalShortcut(
  accelerator: unknown,
  platform: ShortcutPlatform,
): GlobalShortcutValidation {
  const raw = parseAccelerator(accelerator);
  if (raw === null) return { ok: false, reason: 'invalid' };
  // Electron ignores `Command` outside macOS, so such a chord parses but can
  // never fire; saving it would leave the status waiting for a press that
  // cannot come.
  if (platform !== 'darwin' && raw.modifiers.includes('Command')) {
    return { ok: false, reason: 'invalid' };
  }
  const parsed = collapseRedundantModifiers(raw, platform);
  const hasStrongModifier = parsed.modifiers.some(
    (modifier) =>
      modifier !== 'Shift' && !(platform === 'darwin' && modifier === 'Alt'),
  );
  if (!hasStrongModifier) {
    return { ok: false, reason: 'needs-modifier' };
  }
  if (isReserved(parsed, platform)) return { ok: false, reason: 'reserved' };
  return { ok: true, accelerator: formatAccelerator(parsed) };
}

/** Identity of the physical chord, shared by authoritative and UI conflicts. */
export function acceleratorSignature(
  accelerator: string,
  platform: ShortcutPlatform,
): string | null {
  const parsed = parseAccelerator(accelerator);
  if (parsed === null) return null;
  const resolved = new Set<string>();
  for (const modifier of parsed.modifiers) {
    if (modifier === 'CommandOrControl')
      resolved.add(platform === 'darwin' ? 'Command' : 'Control');
    else if (modifier === 'Super' && platform === 'darwin')
      resolved.add('Command');
    else resolved.add(modifier);
  }
  return `${Array.from(resolved).sort().join('+')}|${parsed.key}`;
}
