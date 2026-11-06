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

export type NativeOperation =
  | 'status'
  | 'unlock'
  | 'read'
  | 'create'
  | 'replace'
  | 'delete';

/** Host-local binding only. No native handles, paths or diagnostics cross the port. */
export interface KeychainNative {
  run(
    this: void,
    operation: NativeOperation,
    service: string,
    account: string,
    material: Uint8Array,
  ): Promise<unknown>;
}

function slotName(slot: PlatformKeySlot): string {
  const name = slot?.name;
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name))
    throw new TypeError('Invalid key slot.');
  return name;
}

function validInteraction(options: PlatformKeySlotCallOptions): void {
  if (options.interaction !== 'never' && options.interaction !== 'allowed')
    throw new TypeError('Invalid key-slot interaction.');
}

interface NativeQueue {
  tail: Promise<void>;
  unlocking?: {
    promise: Promise<unknown>;
    callers: Set<AbortSignal>;
  };
}

const queues = new WeakMap<KeychainNative['run'], NativeQueue>();

function queueFor(backend: KeychainNative): NativeQueue {
  let queue = queues.get(backend.run);
  if (!queue) {
    queue = { tail: Promise.resolve() };
    queues.set(backend.run, queue);
  }
  return queue;
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject): void => {
    const abort = (): void => {
      resolve(
        Promise.resolve().then((): never => {
          signal.throwIfAborted();
          throw new Error('Expected an aborted key-slot call.');
        }),
      );
    };
    signal.addEventListener('abort', abort, { once: true });
    void work.then(resolve, reject).finally((): void => {
      signal.removeEventListener('abort', abort);
    });
  });
}

/**
 * Unlock is a separate, coalesced phase with no slot effects. Aborting it settles
 * immediately but cannot dismiss legacy OS UI; other slots wait for its answer.
 * Slot work is noninteractive and awaited through native completion on abort.
 */
export function createDarwinSecretProtection(
  native: () => KeychainNative | undefined,
  namespace: KeychainNamespace,
  unavailable: PlatformSecretProtectionUnavailableReason = 'backend_failed',
): PlatformSecretProtectionServices {
  const unavailableQueue: NativeQueue = { tail: Promise.resolve() };
  const identity = { ...namespace };

  function enqueue<T>(
    queue: NativeQueue,
    signal: AbortSignal,
    run: () => Promise<T>,
  ): Promise<T> {
    const aborted = (): never => {
      signal.throwIfAborted();
      throw new Error('Expected an aborted key-slot call.');
    };
    if (signal.aborted) {
      return Promise.resolve().then(aborted);
    }
    return new Promise<T>((resolve, reject): void => {
      let started = false;
      let cancelled = false;
      const abort = (): void => {
        if (started || cancelled) return;
        cancelled = true;
        resolve(Promise.resolve().then(aborted));
      };
      signal.addEventListener('abort', abort, { once: true });
      const work = queue.tail.then(async (): Promise<void> => {
        signal.removeEventListener('abort', abort);
        if (cancelled) return;
        if (signal.aborted) {
          abort();
          return;
        }
        started = true;
        resolve(await run());
      });
      void work.catch(reject);
      queue.tail = work.then(
        (): void => undefined,
        (): void => undefined,
      );
    });
  }

  async function invoke(
    backend: KeychainNative | undefined,
    operation: NativeOperation,
    name = '',
    bytes: Uint8Array = new Uint8Array(),
  ): Promise<unknown> {
    try {
      if (!backend) return { code: 'unavailable' };
      return await backend.run(
        operation,
        identity.service,
        keychainAccount(identity, name),
        bytes,
      );
    } catch {
      // No backend error text, path or native diagnostic is allowed to escape.
      const mutating =
        operation === 'create' ||
        operation === 'replace' ||
        operation === 'delete';
      return { code: mutating ? 'uncertain' : 'unavailable' };
    }
  }

  async function unlock(
    backend: KeychainNative,
    queue: NativeQueue,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    if (!queue.unlocking) {
      const callers = new Set<AbortSignal>();
      const promise = queue.tail.then(async (): Promise<unknown> => {
        if (![...callers].some((caller) => !caller.aborted))
          return { code: 'locked' };
        return invoke(backend, 'unlock');
      });
      const pending = { promise, callers };
      queue.unlocking = pending;
      queue.tail = promise.then((): void => {
        if (queue.unlocking === pending) queue.unlocking = undefined;
      });
    }
    const pending = queue.unlocking;
    pending.callers.add(signal);
    try {
      return await abortable(pending.promise, signal);
    } finally {
      pending.callers.delete(signal);
    }
  }

  async function slotWork<T>(
    options: PlatformKeySlotCallOptions,
    operation: NativeOperation,
    name: string,
    bytes: Uint8Array,
    result: (value: unknown) => T,
    clean: () => void = (): void => undefined,
  ): Promise<T> {
    const { signal, interaction } = options;
    try {
      signal.throwIfAborted();
      let backend: KeychainNative | undefined;
      try {
        backend = native();
      } catch {
        return result({ code: 'unavailable' });
      }
      const queue = backend ? queueFor(backend) : unavailableQueue;
      const unlockResult = async (): Promise<unknown> => {
        if (!backend) return { code: 'unavailable' };
        const value = await unlock(backend, queue, signal);
        if (nativeCode(value) === 'denied') return { code: 'locked' };
        return ['ok', 'locked', 'interaction_required', 'unavailable'].includes(
          nativeCode(value),
        )
          ? value
          : { code: 'unavailable' };
      };
      if (interaction === 'allowed' && queue.unlocking) {
        const value = await unlockResult();
        if (nativeCode(value) !== 'ok') return result(value);
      }
      const run = (): Promise<unknown> =>
        invoke(backend, operation, name, bytes);
      let value = await enqueue(queue, signal, run);
      if (
        backend &&
        interaction === 'allowed' &&
        nativeCode(value) === 'locked'
      ) {
        value = await unlockResult();
        if (nativeCode(value) === 'ok')
          value = await enqueue(queue, signal, run);
      }
      return result(value);
    } finally {
      clean();
    }
  }

  return {
    backend: 'macos_keychain',
    status(
      options: PlatformSecretProtectionCallOptions,
    ): Promise<PlatformSecretProtectionState> {
      return Promise.resolve().then(
        async (): Promise<PlatformSecretProtectionState> => {
          options.signal.throwIfAborted();
          try {
            const backend = native();
            if (!backend) return { state: 'unavailable', reason: unavailable };
            return await abortable(
              invoke(backend, 'status').then(statusResult),
              options.signal,
            );
          } catch {
            options.signal.throwIfAborted();
            return { state: 'unavailable', reason: 'backend_failed' };
          }
        },
      );
    },
    async readKeySlot(
      slot: PlatformKeySlot,
      options: PlatformKeySlotCallOptions,
    ): Promise<PlatformKeySlotReadResult> {
      const name = slotName(slot);
      validInteraction(options);
      return slotWork(options, 'read', name, new Uint8Array(), readResult);
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
      const mode = options.mode;
      // Uint8Array constructor copies even Buffer and custom slice subclasses.
      const owned = new Uint8Array(material);
      return slotWork(options, mode, name, owned, writeResult, (): void => {
        owned.fill(0);
      });
    },
    async deleteKeySlot(
      slot: PlatformKeySlot,
      options: PlatformKeySlotCallOptions,
    ): Promise<PlatformKeySlotDeleteResult> {
      const name = slotName(slot);
      validInteraction(options);
      return slotWork(options, 'delete', name, new Uint8Array(), deleteResult);
    },
  };
}
