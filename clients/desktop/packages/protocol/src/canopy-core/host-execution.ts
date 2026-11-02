import { z } from 'zod';

/**
 * The reserved request member that carries host execution input (CAN-5496).
 * It sits beside `_meta`, never inside it or the operation params, and is
 * accepted only by {@link CANOPY_HOST_EXECUTION_OPERATIONS}.
 */
export const CANOPY_HOST_EXECUTION_MEMBER = '_execution';

/**
 * The operations whose request envelope admits `_execution`: the
 * `worker.git.*` operations whose Git children run with the forwarded
 * environment. `worker.git.executable.get` is absent because executable
 * selection keeps the daemon's own environment. `worker.git.diff.get` is
 * absent too: its change-set reads keep the daemon's own environment,
 * recorded debt (CAN-4729). The branch writes are idempotency `none`, so no
 * receipt or replay can run them again with a stale environment (CAN-4108,
 * CAN-5516).
 */
export const CANOPY_HOST_EXECUTION_OPERATIONS: ReadonlySet<string> = new Set([
  'worker.git.branch.list',
  'worker.git.remote.get',
  'worker.git.worktree.health.get',
  'worker.git.checkout',
  'worker.git.branch.create',
  'worker.git.branch.rename',
  'worker.git.branch.delete',
  // CAN-5517: idempotency none, as the branch writes.
  'worker.git.fetch',
  'worker.git.pull',
]);

/** Bounds well below one 8 MiB frame and macOS `ARG_MAX`. */
export const CANOPY_HOST_EXECUTION_LIMITS = Object.freeze({
  entries: 1_024,
  bytes: 256 * 1024,
});

/**
 * UTF-8 bytes of `text`, counting an unpaired surrogate as U+FFFD (three
 * bytes), as `TextEncoder` and Node's spawn encode it. Counted directly
 * because the renderer's jsdom tests import this module and lack
 * `TextEncoder`.
 */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      index + 1 < text.length &&
      text.charCodeAt(index + 1) >= 0xdc00 &&
      text.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function withinLimits(environment: Readonly<Record<string, string>>): boolean {
  const entries = Object.entries(environment);
  if (entries.length > CANOPY_HOST_EXECUTION_LIMITS.entries) return false;
  let bytes = 0;
  for (const [key, value] of entries) {
    // `KEY=value` plus its terminator, as the child's environment block holds it.
    bytes += utf8ByteLength(key) + utf8ByteLength(value) + 2;
    if (bytes > CANOPY_HOST_EXECUTION_LIMITS.bytes) return false;
  }
  return true;
}

const EnvironmentKeySchema = z
  .string()
  .min(1)
  .refine((key) => !key.includes('\0') && !key.includes('='));
const EnvironmentValueSchema = z
  .string()
  .refine((value) => !value.includes('\0'));

/**
 * The complete environment a host-local child runs with. It replaces the
 * executing host's own environment for that child; it is never merged.
 */
export const CanopyChildEnvironmentSchema = z
  .record(EnvironmentKeySchema, EnvironmentValueSchema)
  .refine(withinLimits, 'The child environment exceeds its limits.');

export const CanopyHostExecutionSchema = z.strictObject({
  childEnvironment: CanopyChildEnvironmentSchema,
});

export type CanopyHostExecution = z.output<typeof CanopyHostExecutionSchema>;

export function canopyOperationAcceptsHostExecution(name: string): boolean {
  return CANOPY_HOST_EXECUTION_OPERATIONS.has(name);
}
