import type { VaultStatusGetResult } from '@canopy/protocol/canopy-core';

import type {
  PlatformKeySlotReadResult,
  PlatformSecretProtectionServices,
  PlatformSecretProtectionState,
} from '../../../platform/secret-protection';
import {
  mapVaultKeySlotOutcome,
  observeVaultKeySlotRead,
  vaultKeySlot,
  type VaultKeySlotEntryBlock,
  type VaultKeySlotObservation,
  type VaultKeySlotOutcome,
  type VaultKeySlotRead,
} from './key-slot-outcome';
import type { VaultStoredHeader } from './store-records';
import {
  deriveVaultSubkeys,
  disposeVaultSubkeys,
  type VaultSubkeys,
} from './vault-keys';
import { zeroBytes } from './zero-bytes';

/*
 * Key acquisition (plan r4 Q4, Q4c items 8 and 9). One prompt-free,
 * single-flight read of the vault's key slot, then an unwrap of the data key.
 * The subkeys are held exactly while the last observation unwrapped: any other
 * observation, a lock included, drops them before `status()` is asked
 * (2026-10-29 checkpoint). At most one backend call is outstanding, even past
 * a timeout.
 */

export interface VaultKeyHolderOptions {
  readonly slots: PlatformSecretProtectionServices;
  readonly header: VaultStoredHeader;
  readonly clock: () => Date;
  /** A probe still pending after this, waiting included, is `rejected`. */
  readonly probeTimeoutMs: number;
  /** The least time between probes that `probeIfDue` starts. */
  readonly minProbeIntervalMs: number;
}

export interface VaultKeyHolder {
  /** The last observation, synchronously; never calls the backend. */
  status(): VaultStatusGetResult;
  /** Null while the key is held; otherwise the entry state it imposes. */
  entryBlock(): VaultKeySlotEntryBlock | null;
  keys(): VaultSubkeys | null;
  /** For `get` while the key is not held: joins a probe in flight, else throttled. */
  probeIfDue(): Promise<void>;
  /** Trusted re-probe, not throttled; joins a probe in flight. */
  refresh(): Promise<void>;
  /** Holds a data key `initializeVault` just wrapped into the slot; zeroes it. */
  adopt(dataKey: Uint8Array): void;
  /** Drops the key and aborts a probe in flight. Idempotent. */
  dispose(): void;
}

const REJECTED: VaultKeySlotRead = {
  observation: { kind: 'rejected' },
  dataKey: null,
};

const noop = (): void => undefined;

// `status()` only refines lock evidence and the unavailable reason.
function needsStatus(observation: VaultKeySlotObservation): boolean {
  return (
    observation.kind === 'blocked' &&
    (observation.reason === 'locked' || observation.reason === 'unavailable')
  );
}

/**
 * Settles with the call's result, or null once `signal` aborts, even when the
 * backend ignores the abort. A result that lands later goes to `discard`.
 */
function bounded<T>(
  signal: AbortSignal,
  call: () => Promise<T>,
  discard: (late: T) => void,
): Promise<{ readonly value: T } | null> {
  return new Promise((resolve) => {
    let pending: Promise<T>;
    try {
      pending = call();
    } catch {
      resolve(null);
      return;
    }
    const onAbort = (): void => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    void pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) {
          discard(value);
          resolve(null);
        } else resolve({ value });
      },
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve(null);
      },
    );
  });
}

function discardRead(read: PlatformKeySlotReadResult): void {
  if (read.kind === 'present') zeroBytes(read.material);
}

export function createVaultKeyHolder(
  options: VaultKeyHolderOptions,
): VaultKeyHolder {
  const { slots, header, clock } = options;
  const slot = vaultKeySlot(header.vaultId);
  const lifetime = new AbortController();
  const notProbed = (): VaultKeySlotOutcome =>
    mapVaultKeySlotOutcome({
      backend: slots.backend,
      observation: { kind: 'not_probed' },
      status: null,
    });
  let outcome = notProbed();
  let observedAt: string | null = null;
  let held: VaultSubkeys | null = null;
  let inFlight: Promise<void> | null = null;
  /** One fresh probe shared by every refresh that arrived during `inFlight`. */
  let queued: Promise<void> | null = null;
  let lastProbeAt: number | null = null;
  /** Settles with the last backend call, which may outlive its probe's timeout. */
  let outstanding: Promise<void> | null = null;
  /** Bumped by every `record`, so a late refinement cannot overwrite a newer one. */
  let generation = 0;

  function drop(): void {
    if (held) disposeVaultSubkeys(held);
    held = null;
  }

  function record(
    observation: VaultKeySlotObservation,
    dataKey: Uint8Array | null,
  ): void {
    try {
      if (lifetime.signal.aborted) return;
      drop();
      generation += 1;
      outcome = mapVaultKeySlotOutcome({
        backend: slots.backend,
        observation,
        status: null,
      });
      observedAt = clock().toISOString();
      if (dataKey) held = deriveVaultSubkeys(dataKey, header.vaultId);
    } finally {
      if (dataKey) zeroBytes(dataKey);
    }
  }

  // Applies a `status()` result to the observation `record` already published.
  function refine(
    observation: VaultKeySlotObservation,
    status: PlatformSecretProtectionState,
    recorded: number,
  ): void {
    if (lifetime.signal.aborted || generation !== recorded) return;
    outcome = mapVaultKeySlotOutcome({
      backend: slots.backend,
      observation,
      status,
    });
  }

  function reserve<T>(call: () => Promise<T>): Promise<T> {
    const pending = call();
    const settled: Promise<void> = pending.then(
      () => release(settled),
      () => release(settled),
    );
    outstanding = settled;
    return pending;
  }

  function release(settled: Promise<void>): void {
    if (outstanding === settled) outstanding = null;
  }

  // A result that lands after its abort or timeout counts as the timeout.
  async function readSlot(signal: AbortSignal): Promise<VaultKeySlotRead> {
    const read = await bounded(
      signal,
      () =>
        reserve(() =>
          slots.readKeySlot(slot, { interaction: 'never', signal }),
        ),
      discardRead,
    );
    if (read === null) return REJECTED;
    return observeVaultKeySlotRead(
      read.value,
      header.wrappedDataKey,
      header.vaultId,
    );
  }

  async function readStatus(
    signal: AbortSignal,
  ): Promise<PlatformSecretProtectionState | null> {
    const status = await bounded(
      signal,
      () => reserve(() => slots.status({ signal })),
      noop,
    );
    return status?.value ?? null;
  }

  async function observe(signal: AbortSignal): Promise<void> {
    // A backend call abandoned at an earlier timeout keeps the slot reserved;
    // this probe waits for it within its own timeout, never beside it.
    const abandoned = outstanding;
    if (abandoned && (await bounded(signal, () => abandoned, noop)) === null) {
      record(REJECTED.observation, null);
      return;
    }
    const { observation, dataKey } = await readSlot(signal);
    // The key drops on this observation; `status()` only refines how it reads.
    record(observation, dataKey);
    if (!needsStatus(observation)) return;
    const recorded = generation;
    const status = await readStatus(signal);
    if (status) refine(observation, status, recorded);
  }

  function probe(): Promise<void> {
    if (inFlight) return inFlight;
    if (lifetime.signal.aborted) return Promise.resolve();
    const signal = AbortSignal.any([
      lifetime.signal,
      AbortSignal.timeout(options.probeTimeoutMs),
    ]);
    const running = observe(signal).finally(() => {
      inFlight = null;
      lastProbeAt = clock().getTime();
    });
    inFlight = running;
    return running;
  }

  // The probe in flight may have read the slot before the event behind this
  // refresh (a lock), so a refresh waits for a probe that starts after it.
  function refresh(): Promise<void> {
    if (!inFlight) return probe();
    queued ??= inFlight.then(() => {
      queued = null;
      return probe();
    });
    return queued;
  }

  // A clock that stepped backwards makes a probe due rather than stalling it.
  function isProbeDue(): boolean {
    if (lastProbeAt === null) return true;
    const elapsed = clock().getTime() - lastProbeAt;
    return elapsed < 0 || elapsed >= options.minProbeIntervalMs;
  }

  return {
    status(): VaultStatusGetResult {
      return { protection: { ...outcome.protection }, observedAt };
    },
    entryBlock(): VaultKeySlotEntryBlock | null {
      if (held) return null;
      return outcome.entryBlock ?? 'unavailable';
    },
    keys(): VaultSubkeys | null {
      return held;
    },
    probeIfDue(): Promise<void> {
      if (held) return Promise.resolve();
      if (inFlight) return inFlight;
      return isProbeDue() ? probe() : Promise.resolve();
    },
    refresh,
    adopt(dataKey): void {
      record({ kind: 'unwrapped' }, dataKey);
      lastProbeAt = clock().getTime();
    },
    dispose(): void {
      lifetime.abort();
      drop();
      outcome = notProbed();
      observedAt = null;
    },
  };
}
