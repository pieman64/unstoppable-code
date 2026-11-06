import { createHash } from 'node:crypto';
import { stableStringify } from '@canopy/protocol/plans';
import { CanopyOperationError } from '@canopy/core-runtime';

const DEFAULT_MAX_KEYS = 4096;

/**
 * The sha256 of an operation and its canonical params, `_meta` excluded
 * (CAN-4110 D8). The operation keeps same-shaped commands, such as a queue
 * entry cancel and force, from sharing a fingerprint.
 */
export function chatCommandFingerprint(
  operation: string,
  params: unknown,
): string {
  const copy =
    typeof params === 'object' && params !== null && !Array.isArray(params)
      ? Object.fromEntries(
          Object.entries(params).filter(([key]) => key !== '_meta'),
        )
      : params;
  return createHash('sha256')
    .update(stableStringify([operation, copy ?? null]) ?? 'null')
    .digest('hex');
}

interface KeyBinding {
  fingerprint: string;
  /** Claims that have not released; a successful attempt never releases. */
  holders: number;
}

/**
 * Binds each chat command key (scope and command id) to the operation and
 * params it was first dispatched with, for the process lifetime. Bounded;
 * oldest evicted.
 */
export class ChatCommandKeyFingerprints {
  private readonly bindings = new Map<string, KeyBinding>();

  public constructor(private readonly max = DEFAULT_MAX_KEYS) {}

  /**
   * Records the key's operation and params, or throws `conflict` when the key
   * already holds others. Returns a release the caller runs when the attempt
   * throws; the key is unbound once every attempt holding it has released, so
   * a failed attempt never unbinds one that succeeded or is still running.
   */
  public claim(
    scope: { projectId: string; worktreeId: string },
    commandId: string,
    operation: string,
    params: unknown,
  ): () => void {
    const key = JSON.stringify([scope.projectId, scope.worktreeId, commandId]);
    const fingerprint = chatCommandFingerprint(operation, params);
    let binding = this.bindings.get(key);
    if (binding) {
      if (binding.fingerprint !== fingerprint)
        throw new CanopyOperationError({
          kind: 'conflict',
          message: 'This idempotency key was used with other parameters.',
          retry: { kind: 'never' },
        });
      this.bindings.delete(key);
      binding.holders += 1;
    } else {
      binding = { fingerprint, holders: 1 };
    }
    this.bindings.set(key, binding);
    while (this.bindings.size > this.max) {
      const oldest = this.bindings.keys().next().value;
      if (oldest === undefined) break;
      this.bindings.delete(oldest);
    }
    const held = binding;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held.holders -= 1;
      if (held.holders === 0 && this.bindings.get(key) === held)
        this.bindings.delete(key);
    };
  }
}
