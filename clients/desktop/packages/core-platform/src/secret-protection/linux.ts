import type {
  PlatformKeySlot,
  PlatformKeySlotCallOptions,
  PlatformKeySlotDeleteResult,
  PlatformKeySlotReadResult,
  PlatformKeySlotWriteOptions,
  PlatformKeySlotWriteResult,
  PlatformSecretProtectionCallOptions,
  PlatformSecretProtectionServices,
  PlatformSecretProtectionState,
  PlatformSecretProtectionUnavailableReason,
} from '@canopy/core-runtime';
import { keychainAccount, type KeychainNamespace } from './policy';
import {
  deleteResult,
  nativeCode,
  readResult,
  statusResult,
  writeResult,
} from './native-results';

export type SecretServiceOperation =
  | 'status'
  | 'read'
  | 'create'
  | 'replace'
  | 'delete';

/** Host-local ABI. The addon owns the FIFO, unlock prompts and abort phases. */
export interface SecretServiceNative {
  run(
    this: void,
    operation: SecretServiceOperation,
    service: string,
    account: string,
    material: Uint8Array,
    interaction: 'never' | 'allowed',
    signal: AbortSignal,
  ): Promise<unknown>;
}

const failures = new WeakSet<SecretServiceNative['run']>();

function slotName(slot: PlatformKeySlot): string {
  const name = slot?.name;
  if (
    typeof name !== 'string' ||
    name.length < 1 ||
    name.length > 64 ||
    !/^[a-z0-9]/.test(name) ||
    /[^a-z0-9-]/.test(name)
  )
    throw new TypeError('Invalid key slot.');
  return name;
}

function validInteraction(options: PlatformKeySlotCallOptions): void {
  if (options.interaction !== 'never' && options.interaction !== 'allowed')
    throw new TypeError('Invalid key-slot interaction.');
}

/**
 * L-D4: GIO's default user session bus only; no bus/session selector or fallback.
 * q-26/q-28: native cancellation drains submitted mutations, never dismisses
 * unlock UI, and latches transport ambiguity until the daemon restarts.
 */
export function createLinuxSecretProtection(
  native: () => SecretServiceNative | undefined,
  namespace: KeychainNamespace,
  unavailable: PlatformSecretProtectionUnavailableReason = 'backend_failed',
): PlatformSecretProtectionServices {
  const identity = { ...namespace };

  async function invoke(
    operation: SecretServiceOperation,
    name: string,
    bytes: Uint8Array,
    options: PlatformKeySlotCallOptions,
  ): Promise<unknown> {
    const { signal, interaction } = options;
    signal.throwIfAborted();
    let backend: SecretServiceNative | undefined;
    try {
      backend = native();
    } catch {
      return { code: 'unavailable' };
    }
    signal.throwIfAborted();
    if (!backend) return { code: 'unavailable', missing: true };
    if (failures.has(backend.run)) return { code: 'unavailable' };
    const mutating = operation !== 'read' && operation !== 'status';
    try {
      const value = await backend.run(
        operation,
        identity.service,
        keychainAccount(identity, name),
        bytes,
        interaction,
        signal,
      );
      // Corrupt duplicates are refused before submission, not transport loss.
      // Unknown mutation replies, like explicit uncertain replies, must latch.
      if (
        mutating &&
        nativeCode(value) !== 'corrupt' &&
        (operation === 'delete' ? deleteResult(value) : writeResult(value))
          .kind === 'uncertain'
      )
        failures.add(backend.run);
      return value;
    } catch (error) {
      // Only the native abort rejection proves that no mutation was submitted.
      if (signal.aborted && error === signal.reason) throw error;
      failures.add(backend.run);
      return { code: mutating ? 'uncertain' : 'unavailable' };
    }
  }

  return {
    backend: 'linux_secret_service',
    async status(
      options: PlatformSecretProtectionCallOptions,
    ): Promise<PlatformSecretProtectionState> {
      const value = await invoke('status', 'status', new Uint8Array(), {
        signal: options.signal,
        interaction: 'never',
      });
      if (
        typeof value === 'object' &&
        value !== null &&
        Object.getOwnPropertyDescriptor(value, 'missing')?.value === true
      )
        return { state: 'unavailable', reason: unavailable };
      return statusResult(value);
    },
    async readKeySlot(
      slot: PlatformKeySlot,
      options: PlatformKeySlotCallOptions,
    ): Promise<PlatformKeySlotReadResult> {
      const name = slotName(slot);
      validInteraction(options);
      return readResult(await invoke('read', name, new Uint8Array(), options));
    },
    async writeKeySlot(
      slot: PlatformKeySlot,
      material: Uint8Array,
      options: PlatformKeySlotWriteOptions,
    ): Promise<PlatformKeySlotWriteResult> {
      const name = slotName(slot);
      validInteraction(options);
      if (options.mode !== 'create' && options.mode !== 'replace')
        throw new TypeError('Invalid key-slot mode.');
      if (
        !(material instanceof Uint8Array) ||
        material.byteLength < 1 ||
        material.byteLength > 1024
      )
        throw new TypeError('Invalid key-slot material.');
      options.signal.throwIfAborted();
      const owned = new Uint8Array(material);
      try {
        return writeResult(await invoke(options.mode, name, owned, options));
      } finally {
        owned.fill(0);
      }
    },
    async deleteKeySlot(
      slot: PlatformKeySlot,
      options: PlatformKeySlotCallOptions,
    ): Promise<PlatformKeySlotDeleteResult> {
      const name = slotName(slot);
      validInteraction(options);
      return deleteResult(
        await invoke('delete', name, new Uint8Array(), options),
      );
    },
  };
}
