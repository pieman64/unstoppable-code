import { createHash } from 'node:crypto';
import type {
  PlatformKeySlot,
  PlatformKeySlotCallOptions,
  PlatformKeySlotWriteOptions,
  PlatformSecretProtectionServices,
  PlatformSecretProtectionUnavailableReason,
} from '@canopy/core-runtime';
import {
  deleteResult,
  nativeCode,
  readResult,
  statusResult,
  writeResult,
} from './native-results';
import type { CredentialNamespace } from './policy';

export type CredentialOperation =
  | 'status'
  | 'read'
  | 'create'
  | 'replace'
  | 'delete';
export interface CredentialNative {
  run(
    operation: CredentialOperation,
    target: string,
    mutex: string,
    material: Uint8Array,
    principal: string,
    cancellation: Uint32Array,
  ): Promise<unknown>;
}

export function credentialMutexName(target: string, principal: string): string {
  return `Global\\canopy.vault.v1.${createHash('sha256')
    .update(JSON.stringify([principal, target]))
    .digest('hex')}`;
}

function slotName(
  slot: PlatformKeySlot,
  options: PlatformKeySlotCallOptions,
): string {
  if (
    typeof slot?.name !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(slot.name)
  )
    throw new TypeError('Invalid key slot.');
  if (options.interaction !== 'never' && options.interaction !== 'allowed')
    throw new TypeError('Invalid key-slot interaction.');
  return slot.name;
}

/**
 * q-28: this noninteractive path has no OS unlock/consent prompt to dismiss.
 * Queued aborts reject immediately. In-flight CredReadW settles when it returns
 * (q-27 gap 2's bounded residual), not after user interaction. Submitted mutations
 * report their true outcome (q-27).
 */
export function createWindowsSecretProtection(
  native: () => CredentialNative | undefined,
  namespace: CredentialNamespace,
  unavailable: PlatformSecretProtectionUnavailableReason = 'backend_failed',
): PlatformSecretProtectionServices {
  const identity = { ...namespace };
  let tail = Promise.resolve();
  function enqueue<T>(
    signal: AbortSignal,
    work: (cancel: Uint32Array) => Promise<T>,
    clean = (): void => undefined,
  ): Promise<T> {
    if (signal.aborted) {
      clean();
      // Preserve caller-owned AbortSignal reasons, including non-Errors.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(signal.reason);
    }
    return new Promise<T>((resolve, reject) => {
      const cancellation = new Uint32Array(new SharedArrayBuffer(4));
      let started = false;
      let cancelled = false;
      const abort = (): void => {
        Atomics.store(cancellation, 0, 1);
        if (!started && !cancelled) {
          cancelled = true;
          clean();
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(signal.reason);
        }
      };
      signal.addEventListener('abort', abort, { once: true });
      const pending = tail
        .then(async () => {
          if (signal.aborted) abort();
          if (cancelled) return;
          started = true;
          try {
            resolve(await work(cancellation));
          } catch (error) {
            // AbortSignal.throwIfAborted may throw a caller-owned non-Error.
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            reject(error);
          } finally {
            clean();
          }
        })
        .finally(() => signal.removeEventListener('abort', abort));
      tail = pending.catch(() => undefined);
    });
  }
  async function invoke(
    operation: CredentialOperation,
    name: string,
    bytes: Uint8Array,
    signal: AbortSignal,
    cancellation: Uint32Array,
  ): Promise<unknown> {
    signal.throwIfAborted();
    let backend: CredentialNative | undefined;
    try {
      backend = native();
    } catch {
      return { code: 'unavailable' };
    }
    if (!backend) return { code: 'unavailable' };
    signal.throwIfAborted();
    const target = identity.prefix + name;
    let result: unknown;
    try {
      result = await backend.run(
        operation,
        target,
        credentialMutexName(target, identity.principalSid),
        bytes,
        identity.principalSid,
        cancellation,
      );
    } catch {
      return {
        code: ['create', 'replace', 'delete'].includes(operation)
          ? 'uncertain'
          : 'unavailable',
      };
    }
    if (nativeCode(result) === 'cancelled') signal.throwIfAborted();
    return result;
  }
  return {
    backend: 'windows_credential_manager',
    status: (options) =>
      enqueue(options.signal, async (cancel) => {
        if (unavailable !== 'backend_failed')
          return { state: 'unavailable', reason: unavailable };
        const result = await invoke(
          'status',
          '',
          new Uint8Array(),
          options.signal,
          cancel,
        );
        // Session support is not proof that an arbitrary credential can be read.
        if (nativeCode(result) === 'unknown') return { state: 'unknown' };
        return statusResult(result);
      }),
    async readKeySlot(slot, options) {
      const name = slotName(slot, options);
      return enqueue(options.signal, async (cancel) =>
        readResult(
          await invoke('read', name, new Uint8Array(), options.signal, cancel),
        ),
      );
    },
    async writeKeySlot(
      slot: PlatformKeySlot,
      material: Uint8Array,
      options: PlatformKeySlotWriteOptions,
    ) {
      const name = slotName(slot, options);
      if (options.mode !== 'create' && options.mode !== 'replace')
        throw new TypeError('Invalid key-slot mode.');
      if (
        !(material instanceof Uint8Array) ||
        material.byteLength < 1 ||
        material.byteLength > 1024
      )
        throw new TypeError('Invalid key-slot material.');
      options.signal.throwIfAborted();
      const bytes = new Uint8Array(material);
      const mode = options.mode;
      return enqueue(
        options.signal,
        async (cancel) =>
          writeResult(await invoke(mode, name, bytes, options.signal, cancel)),
        () => {
          bytes.fill(0);
        },
      );
    },
    async deleteKeySlot(slot, options) {
      const name = slotName(slot, options);
      return enqueue(options.signal, async (cancel) =>
        deleteResult(
          await invoke(
            'delete',
            name,
            new Uint8Array(),
            options.signal,
            cancel,
          ),
        ),
      );
    },
  };
}
