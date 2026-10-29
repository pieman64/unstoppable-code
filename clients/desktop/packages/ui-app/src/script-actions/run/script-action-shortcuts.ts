import type { ScriptAction } from '@canopy/protocol/script-actions';
import { SCRIPT_ACTION_RESERVED_SHORTCUTS } from '@canopy/protocol/script-actions/reserved-shortcuts';
import {
  acceleratorFromKeyboardEvent,
  parseAccelerator,
  type AcceleratorKeyboardEventLike,
  type ShortcutPlatform,
} from '@canopy/protocol/shortcuts';
import { isTerminalTarget } from '../../code/terminal/terminal-dom';
import { hasClosestMethod, isDialogTarget } from '../../find/shortcut-target';
import { scriptActionRunBlock } from './script-action-eligibility';

/** A chord another owner already claims, named the way the user knows it. */
export interface ReservedScriptActionChord {
  readonly accelerator: string;
  readonly title: string;
}

const MODIFIER_ORDER = ['Command', 'Control', 'Alt', 'Shift', 'Super'] as const;

/**
 * Platform-resolved identity of a chord: `CommandOrControl` becomes the
 * platform's real modifier and macOS `Super` becomes `Command`, so `⌘K`
 * spelled either way compares equal. Null when the accelerator does not parse.
 */
export function scriptActionChordKey(
  accelerator: string,
  platform: ShortcutPlatform,
): string | null {
  const parsed = parseAccelerator(accelerator);
  if (parsed === null) return null;
  const modifiers = new Set<string>();
  for (const modifier of parsed.modifiers) {
    if (modifier === 'CommandOrControl')
      modifiers.add(platform === 'darwin' ? 'Command' : 'Control');
    else if (modifier === 'Super' && platform === 'darwin')
      modifiers.add('Command');
    else modifiers.add(modifier);
  }
  return [
    ...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)),
    parsed.key,
  ].join('+');
}

/**
 * Whether a chord may dispatch a script at all on `platform`: it must parse
 * and carry Command/Control or Alt, so plain typing (and Shift-only chords)
 * never runs anything. `Command` exists only on macOS.
 */
export function isScriptActionDispatchChord(
  accelerator: string,
  platform: ShortcutPlatform,
): boolean {
  const key = scriptActionChordKey(accelerator, platform);
  if (key === null) return false;
  const modifiers = key.split('+').slice(0, -1);
  if (platform !== 'darwin' && modifiers.includes('Command')) return false;
  return modifiers.some(
    (modifier) =>
      modifier === 'Command' || modifier === 'Control' || modifier === 'Alt',
  );
}

/**
 * Chords the executing host already owns: desktop command and panel bindings
 * from {@link SCRIPT_ACTION_RESERVED_SHORTCUTS}, plus host extras such as the
 * global-focus shortcut. Keyed by {@link scriptActionChordKey}.
 */
export function reservedScriptActionChords(
  platform: ShortcutPlatform,
  extra: readonly ReservedScriptActionChord[] = [],
): ReadonlyMap<string, string> {
  const reserved = new Map<string, string>();
  for (const binding of SCRIPT_ACTION_RESERVED_SHORTCUTS) {
    const key = scriptActionChordKey(
      platform === 'darwin' ? binding.darwin : binding.other,
      platform,
    );
    if (key !== null && !reserved.has(key)) reserved.set(key, binding.title);
  }
  for (const chord of extra) {
    const key = scriptActionChordKey(chord.accelerator, platform);
    if (key !== null && !reserved.has(key)) reserved.set(key, chord.title);
  }
  return reserved;
}

/**
 * The bindings that may dispatch, keyed by chord. Only approved, available
 * actions without a service-reported conflict qualify, and a chord must be a
 * dispatch chord that no host binding reserves. Two actions sharing one chord
 * both drop out, so one chord never runs two actions.
 */
export function buildScriptActionShortcutBindings(
  actions: readonly ScriptAction[],
  platform: ShortcutPlatform,
  reserved: ReadonlyMap<string, string> = reservedScriptActionChords(platform),
): ReadonlyMap<string, ScriptAction> {
  const candidates = new Map<string, ScriptAction[]>();
  for (const action of actions) {
    if (action.shortcut === null) continue;
    if (scriptActionRunBlock(action, 'shortcut') !== null) continue;
    if (!isScriptActionDispatchChord(action.shortcut, platform)) continue;
    const key = scriptActionChordKey(action.shortcut, platform);
    if (key === null || reserved.has(key)) continue;
    candidates.set(key, [...(candidates.get(key) ?? []), action]);
  }
  const bindings = new Map<string, ScriptAction>();
  candidates.forEach((members, key) => {
    const [only] = members;
    if (members.length === 1 && only !== undefined) bindings.set(key, only);
  });
  return bindings;
}

/** The keyboard-event surface the dispatcher reads. */
export interface ScriptActionShortcutEvent extends AcceleratorKeyboardEventLike {
  readonly defaultPrevented: boolean;
  readonly repeat: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
  readonly target: EventTarget | null;
}

/** Opt-out marker for surfaces that own every chord (recorders, editors). */
export const SCRIPT_ACTION_SHORTCUTS_OFF_ATTRIBUTE =
  'data-script-action-shortcuts';

/**
 * Events the dispatcher must leave alone: already handled, auto-repeat, IME
 * composition, terminal input (the shell owns its chords), dialogs including
 * command palettes, and surfaces that opt out. The composer is NOT excluded:
 * a Command/Control/Alt chord there is an intended script shortcut.
 */
export function isScriptActionShortcutEventIgnored(
  event: ScriptActionShortcutEvent,
): boolean {
  if (event.defaultPrevented || event.repeat) return true;
  if (event.isComposing === true || event.keyCode === 229) return true;
  const target = event.target;
  if (isTerminalTarget(target) || isDialogTarget(target)) return true;
  if (
    hasClosestMethod(target) &&
    target.closest(`[${SCRIPT_ACTION_SHORTCUTS_OFF_ATTRIBUTE}="off"]`) !== null
  )
    return true;
  return false;
}

/** The single action bound to the event's chord, or null. */
export function matchScriptActionShortcut(
  event: ScriptActionShortcutEvent,
  bindings: ReadonlyMap<string, ScriptAction>,
  platform: ShortcutPlatform,
): ScriptAction | null {
  if (bindings.size === 0 || isScriptActionShortcutEventIgnored(event))
    return null;
  const accelerator = acceleratorFromKeyboardEvent(event, platform);
  if (accelerator === null) return null;
  const key = scriptActionChordKey(accelerator, platform);
  return key === null ? null : (bindings.get(key) ?? null);
}
