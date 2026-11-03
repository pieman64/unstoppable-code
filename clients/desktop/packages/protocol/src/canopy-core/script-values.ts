import { z } from 'zod';

// The script model's limits (`@canopy/protocol/scripts`), which canopy-core
// cannot import; the core-runtime script tests pin them together.
export const MAX_SCRIPT_TIMEOUT_SECONDS = 2_000_000;
const MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH = 1000;
const MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH = 80;
const MAX_SCRIPT_DEV_SERVER_PATTERNS = 8;

/*
 * Script values the core definitions (`core.script.definition.*`) and the
 * worker's execution (`worker.script.*`) share.
 */

export const CORE_SCRIPT_LIFECYCLE_ROLES = [
  'before-setup',
  'setup',
  'after-setup',
  'before-launch',
  'launch',
  'after-launch',
  'before-teardown',
  'teardown',
  'after-teardown',
  'custom',
] as const;

const devServerPatternEntry = z.union([
  z.string().min(1).max(MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH),
  z.strictObject({
    pattern: z.string().min(1).max(MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH),
    label: z.string().min(1).max(MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH).optional(),
    openTarget: z.enum(['in-app', 'external']).optional(),
    autoOpen: z.boolean().optional(),
  }),
]);
/** A script's dev-server URL pattern or patterns, as a definition stores them. */
export const CoreScriptDevServerPatternSchema = z.union([
  devServerPatternEntry,
  z.array(devServerPatternEntry).min(1).max(MAX_SCRIPT_DEV_SERVER_PATTERNS),
]);

/** A definition's per-OS shell override. */
export const CoreScriptCommandShellSchema = z.strictObject({
  windows: z.enum(['cmd', 'powershell', 'bash']).optional(),
  mac: z.enum(['zsh', 'bash']).optional(),
  linux: z.enum(['bash', 'zsh']).optional(),
});
export type CoreScriptCommandShell = z.output<
  typeof CoreScriptCommandShellSchema
>;

/** A script command: non-blank, at most 64 KiB of UTF-16 code units. */
export const CoreScriptCommandSchema = z
  .string()
  .min(1)
  .max(65_536)
  .refine((value) => value.trim().length > 0, 'Commands are not blank');
