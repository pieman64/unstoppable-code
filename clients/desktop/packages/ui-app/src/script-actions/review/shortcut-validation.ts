import type { ScriptAction } from '@canopy/protocol/script-actions';
import { SCRIPT_ACTION_RESERVED_SHORTCUTS } from '@canopy/protocol/script-actions/reserved-shortcuts';
import {
  normalizeAccelerator,
  parseAccelerator,
  validateGlobalShortcut,
  acceleratorSignature,
  type ShortcutPlatform,
} from '@canopy/protocol/shortcuts';

/** A chord the host already uses, such as the global focus shortcut. */
export interface ReservedScriptShortcut {
  readonly accelerator: string;
  readonly title: string;
}

export type ScriptShortcutValidation =
  | { readonly ok: true; readonly accelerator: string }
  | { readonly ok: false; readonly message: string };

export interface ValidateScriptShortcutOptions {
  /** Canonical or raw accelerator from the recorder. */
  readonly accelerator: string;
  /** The action being edited; its own binding is never a conflict. */
  readonly actionId: string;
  /** Every action in the current snapshot. */
  readonly actions: readonly ScriptAction[];
  /**
   * Platforms the binding must be valid on. A host that does not know the
   * executing desktop's platform passes all of them, so the check is the
   * strictest union rather than a guess.
   */
  readonly platforms: readonly ShortcutPlatform[];
  /** Host chords beyond the shared desktop command table. */
  readonly reserved?: readonly ReservedScriptShortcut[];
}

const PRIMARY_MODIFIERS: ReadonlySet<string> = new Set([
  'CommandOrControl',
  'Command',
  'Control',
  'Alt',
]);

export const SHORTCUT_NEEDS_MODIFIER_MESSAGE = 'Add Command, Control or Alt';
export const SHORTCUT_SYSTEM_RESERVED_MESSAGE =
  'Reserved by your system. Choose another shortcut';
export const SHORTCUT_INVALID_MESSAGE = 'Choose another shortcut';

/**
 * Platform-resolved identity of a chord: `CommandOrControl` becomes the
 * platform's primary key and macOS `Super` folds onto Command, so two
 * spellings of one physical chord compare equal.
 */
export function scriptShortcutSignature(
  accelerator: string,
  platform: ShortcutPlatform,
): string | null {
  return acceleratorSignature(accelerator, platform);
}

function sameChord(
  left: string,
  right: string,
  platform: ShortcutPlatform,
): boolean {
  const a = scriptShortcutSignature(left, platform);
  return a !== null && a === scriptShortcutSignature(right, platform);
}

function reservedFor(
  platform: ShortcutPlatform,
  extra: readonly ReservedScriptShortcut[],
): ReservedScriptShortcut[] {
  return [
    ...SCRIPT_ACTION_RESERVED_SHORTCUTS.map((binding) => ({
      accelerator: platform === 'darwin' ? binding.darwin : binding.other,
      title: binding.title,
    })),
    ...extra,
  ];
}

/**
 * Immediate feedback for a recorded script shortcut. Mirrors the service's
 * rules (a Command, Control or Alt modifier; no OS, app or duplicate
 * bindings) so the recorder can explain a refusal before saving. The service
 * stays authoritative and its `shortcut_conflict` errors are shown too.
 */
export function validateScriptActionShortcut({
  accelerator,
  actionId,
  actions,
  platforms,
  reserved = [],
}: ValidateScriptShortcutOptions): ScriptShortcutValidation {
  const parsed = parseAccelerator(accelerator);
  const normalized = normalizeAccelerator(accelerator);
  if (parsed === null || normalized === null)
    return { ok: false, message: SHORTCUT_INVALID_MESSAGE };
  if (!parsed.modifiers.some((modifier) => PRIMARY_MODIFIERS.has(modifier)))
    return { ok: false, message: SHORTCUT_NEEDS_MODIFIER_MESSAGE };
  for (const platform of platforms) {
    const system = validateGlobalShortcut(normalized, platform);
    // The global-shortcut rules refuse a bare macOS Option chord; script
    // shortcuts are in-app, so the service accepts Alt there.
    if (
      !system.ok &&
      !(system.reason === 'needs-modifier' && parsed.modifiers.includes('Alt'))
    )
      return {
        ok: false,
        message:
          system.reason === 'reserved'
            ? SHORTCUT_SYSTEM_RESERVED_MESSAGE
            : SHORTCUT_INVALID_MESSAGE,
      };
  }
  for (const platform of platforms) {
    const binding = reservedFor(platform, reserved).find((entry) =>
      sameChord(entry.accelerator, normalized, platform),
    );
    if (binding !== undefined)
      return { ok: false, message: `Already used by ${binding.title}` };
    const duplicate = actions.find(
      (action) =>
        action.id !== actionId &&
        action.status === 'approved' &&
        action.unavailableReason === undefined &&
        action.shortcut !== null &&
        sameChord(action.shortcut, normalized, platform),
    );
    if (duplicate !== undefined)
      return { ok: false, message: `Already used by ${duplicate.name}` };
  }
  return { ok: true, accelerator: normalized };
}
