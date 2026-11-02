import type {
  PlatformKeySlot,
  PlatformKeySlotBlocked,
  PlatformKeySlotCallOptions,
  PlatformKeySlotDeleteResult,
  PlatformKeySlotReadResult,
  PlatformKeySlotWriteOptions,
  PlatformKeySlotWriteResult,
  PlatformSecretProtectionBackend,
  PlatformSecretProtectionCallOptions,
  PlatformSecretProtectionServices,
  PlatformSecretProtectionState,
  PlatformSecretProtectionUnavailableReason,
} from '../secret-protection';

export const KEY_SLOT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const KEY_SLOT_MAX_BYTES = 1024;

/**
 * Protection faults persist until `clearFaults` or, for `locked` and
 * `unknown`, until an `interaction: 'allowed'` call prompts. Slot faults change
 * one slot. `uncertain` and `write_failed` arm the next mutation of that kind
 * that would otherwise succeed; `abort` arms the next call not `blocked`.
 */
export type FakeSecretProtectionFault =
  | { readonly kind: 'locked'; readonly evidence?: 'reported' | 'inferred' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'denied' }
  | {
      readonly kind: 'unavailable';
      readonly reason: PlatformSecretProtectionUnavailableReason;
    }
  | { readonly kind: 'corrupt'; readonly slot: string }
  | { readonly kind: 'key_missing'; readonly slot: string }
  | {
      readonly kind: 'uncertain';
      readonly operation: 'write' | 'delete';
      /** Whether the mutation lands despite the `uncertain` result. */
      readonly applied: boolean;
    }
  | { readonly kind: 'write_failed' }
  /** The next call stalls until its signal aborts; a mutation then reports `uncertain`. */
  | { readonly kind: 'abort'; readonly applied?: boolean };

export interface FakeSecretProtectionOptions {
  readonly backend: PlatformSecretProtectionBackend;
  readonly slots?: Readonly<Record<string, Uint8Array>>;
}

export type FakeKeySlotContents = Uint8Array | 'corrupt' | null;

export interface FakeSecretProtection {
  readonly port: PlatformSecretProtectionServices;
  inject(fault: FakeSecretProtectionFault): void;
  /** Restores `available` and disarms pending faults; slot contents stay. */
  clearFaults(): void;
  /** Prompts shown so far; only `interaction: 'allowed'` calls may add one. */
  readonly prompts: number;
  /** A copy of the stored slot, for assertions. */
  peek(name: string): FakeKeySlotContents;
}

const CORRUPT = 'corrupt';
type StoredSlot = Uint8Array | typeof CORRUPT;
type Mutation = 'write' | 'delete';
const AVAILABLE: PlatformSecretProtectionState = Object.freeze({
  state: 'available',
});

function blocked(
  reason: PlatformKeySlotBlocked['reason'],
): PlatformKeySlotBlocked {
  return { kind: 'blocked', reason };
}

function checkSlot(slot: PlatformKeySlot): string {
  const name: unknown = slot?.name;
  if (typeof name !== 'string' || !KEY_SLOT_NAME_PATTERN.test(name))
    throw new TypeError('Invalid key slot name.');
  return name;
}

function checkMaterial(material: Uint8Array): void {
  if (
    !(material instanceof Uint8Array) ||
    material.byteLength < 1 ||
    material.byteLength > KEY_SLOT_MAX_BYTES
  )
    throw new TypeError(
      `Key slot material must be 1-${KEY_SLOT_MAX_BYTES} bytes.`,
    );
}

function checkInteraction(
  interaction: PlatformKeySlotCallOptions['interaction'],
): void {
  if (interaction !== 'never' && interaction !== 'allowed')
    throw new TypeError('Invalid key slot interaction.');
}

// Never `slice()`: on a Node Buffer it returns a view of the caller's memory.
function copyBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** In-memory port with fault injection, for vault tests before V2–V4 land. */
export function createFakeSecretProtection(
  options: FakeSecretProtectionOptions,
): FakeSecretProtection {
  const slots = new Map<string, StoredSlot>();
  for (const [name, material] of Object.entries(options.slots ?? {})) {
    checkSlot({ name });
    checkMaterial(material);
    slots.set(name, copyBytes(material));
  }
  let protection: PlatformSecretProtectionState = AVAILABLE;
  let prompts = 0;
  let hold: { readonly applied: boolean } | null = null;
  const armed = new Map<
    Mutation,
    { readonly result: 'uncertain' | 'failed'; readonly applied: boolean }
  >();

  // Returns null when the call may reach the backend.
  function gate(
    interaction: PlatformKeySlotCallOptions['interaction'],
  ): PlatformKeySlotBlocked | null {
    switch (protection.state) {
      case 'available':
        return null;
      case 'denied':
        return blocked('denied');
      case 'unavailable':
        return blocked('unavailable');
      case 'locked':
      case 'unknown':
        if (interaction === 'never')
          return blocked(
            protection.state === 'locked' ? 'locked' : 'interaction_required',
          );
        prompts += 1;
        protection = AVAILABLE;
        return null;
      default: {
        const unreachable: never = protection;
        return unreachable;
      }
    }
  }

  // Resolves false when nothing stalled; throws for a stalled read. Callers
  // recheck their signal after a false result: an abort may land in the await.
  async function stall(
    signal: AbortSignal,
    mutation: (() => void) | null,
  ): Promise<boolean> {
    const current = hold;
    if (!current) return false;
    hold = null;
    await aborted(signal);
    if (!mutation) signal.throwIfAborted();
    else if (current.applied) mutation();
    return true;
  }

  function settleArmed(
    operation: Mutation,
    mutation: () => void,
  ): 'uncertain' | 'failed' | null {
    const fault = armed.get(operation);
    if (!fault) return null;
    armed.delete(operation);
    if (fault.applied) mutation();
    return fault.result;
  }

  const port: PlatformSecretProtectionServices = {
    backend: options.backend,

    async status({
      signal,
    }: PlatformSecretProtectionCallOptions): Promise<PlatformSecretProtectionState> {
      signal.throwIfAborted();
      await stall(signal, null);
      signal.throwIfAborted();
      return { ...protection };
    },

    async readKeySlot(
      slot: PlatformKeySlot,
      { signal, interaction }: PlatformKeySlotCallOptions,
    ): Promise<PlatformKeySlotReadResult> {
      const name = checkSlot(slot);
      checkInteraction(interaction);
      signal.throwIfAborted();
      const denied = gate(interaction);
      if (denied) return denied;
      await stall(signal, null);
      signal.throwIfAborted();
      const stored = slots.get(name);
      if (stored === undefined) return { kind: 'absent' };
      if (stored === CORRUPT) return { kind: 'corrupt' };
      return { kind: 'present', material: copyBytes(stored) };
    },

    async writeKeySlot(
      slot: PlatformKeySlot,
      material: Uint8Array,
      { signal, interaction, mode }: PlatformKeySlotWriteOptions,
    ): Promise<PlatformKeySlotWriteResult> {
      const name = checkSlot(slot);
      checkInteraction(interaction);
      checkMaterial(material);
      if (mode !== 'create' && mode !== 'replace')
        throw new TypeError('Invalid key slot write mode.');
      signal.throwIfAborted();
      const denied = gate(interaction);
      if (denied) return denied;
      const copy = copyBytes(material);
      const matchesMode = (): boolean =>
        slots.has(name) === (mode === 'replace');
      const write = (): void => {
        if (matchesMode()) slots.set(name, copy);
      };
      if (await stall(signal, write)) return { kind: 'uncertain' };
      signal.throwIfAborted();
      if (!matchesMode()) return { kind: 'conflict' };
      const fault = settleArmed('write', write);
      if (fault) return { kind: fault };
      write();
      return { kind: 'written' };
    },

    async deleteKeySlot(
      slot: PlatformKeySlot,
      { signal, interaction }: PlatformKeySlotCallOptions,
    ): Promise<PlatformKeySlotDeleteResult> {
      const name = checkSlot(slot);
      checkInteraction(interaction);
      signal.throwIfAborted();
      const denied = gate(interaction);
      if (denied) return denied;
      const remove = (): void => void slots.delete(name);
      if (await stall(signal, remove)) return { kind: 'uncertain' };
      signal.throwIfAborted();
      if (!slots.has(name)) return { kind: 'absent' };
      if (settleArmed('delete', remove)) return { kind: 'uncertain' };
      remove();
      return { kind: 'deleted' };
    },
  };

  return {
    port,
    get prompts(): number {
      return prompts;
    },
    inject(fault: FakeSecretProtectionFault): void {
      switch (fault.kind) {
        case 'locked':
          protection = {
            state: 'locked',
            evidence: fault.evidence ?? 'reported',
          };
          return;
        case 'unknown':
        case 'denied':
          protection = { state: fault.kind };
          return;
        case 'unavailable':
          protection = { state: 'unavailable', reason: fault.reason };
          return;
        case 'corrupt':
          slots.set(checkSlot({ name: fault.slot }), CORRUPT);
          return;
        case 'key_missing':
          slots.delete(checkSlot({ name: fault.slot }));
          return;
        case 'uncertain':
          armed.set(fault.operation, {
            result: 'uncertain',
            applied: fault.applied,
          });
          return;
        case 'write_failed':
          armed.set('write', { result: 'failed', applied: false });
          return;
        case 'abort':
          hold = { applied: fault.applied ?? false };
          return;
        default: {
          const unreachable: never = fault;
          throw new TypeError(`Unknown fault ${String(unreachable)}.`);
        }
      }
    },
    clearFaults(): void {
      protection = AVAILABLE;
      hold = null;
      armed.clear();
    },
    peek(name: string): FakeKeySlotContents {
      const stored = slots.get(name);
      if (stored === undefined) return null;
      return stored === CORRUPT ? CORRUPT : copyBytes(stored);
    },
  };
}
