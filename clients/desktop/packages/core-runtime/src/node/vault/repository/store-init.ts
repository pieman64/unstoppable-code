import { randomBytes, timingSafeEqual } from 'node:crypto';

import type {
  PlatformKeySlot,
  PlatformKeySlotBlocked,
  PlatformKeySlotReadResult,
  PlatformKeySlotWriteResult,
  PlatformSecretProtectionServices,
} from '../../../platform/secret-protection';
import { vaultKeySlot } from './key-slot-outcome';
import type { VaultStore } from './store';
import type { VaultStoredHeader } from './store-records';
import { generateVaultKey, wrapDataKey } from './vault-keys';
import { zeroBytes } from './zero-bytes';

/*
 * Init order (plan r4 Q4c item 7): mint the vault ID and KEK, create the slot
 * without prompting, then write the header. An uncertain slot write is
 * settled by one re-read. Any failure leaves the store empty, so a later open
 * starts a new vault and leaves an orphaned slot alone; V1 never replaces or
 * deletes a slot.
 */

export type VaultInitStep =
  /** The store is not open, or already has a header. */
  | 'store'
  | 'slot_conflict'
  | 'slot_failed'
  /** The slot call rejected (abort or backend error); nothing changed. */
  | 'slot_rejected'
  /** The re-read after an uncertain write did not find this KEK. */
  | 'slot_uncertain'
  | 'header'
  /**
   * The header commit may have landed, or landed but was not checkpointed;
   * the store is faulted until reopened.
   */
  | 'header_uncertain';

/** `step` is internal context; callers handle every step the same way. */
export interface VaultNotInitialized {
  readonly kind: 'not_initialized';
  readonly step: VaultInitStep;
}

export type VaultInitResult =
  /** The caller owns `dataKey`: it derives the subkeys, then zeroes it. */
  | {
      readonly kind: 'initialized';
      readonly header: VaultStoredHeader;
      readonly dataKey: Uint8Array;
    }
  /** The backend refused the prompt-free create or re-read. */
  | PlatformKeySlotBlocked
  | VaultNotInitialized;

type SlotCreation =
  | { readonly kind: 'created' }
  | PlatformKeySlotBlocked
  | VaultNotInitialized;

function notInitialized(step: VaultInitStep): VaultNotInitialized {
  return Object.freeze({ kind: 'not_initialized', step });
}

/** 20 lowercase hex characters: fits `VAULT_ID_PATTERN` and the slot name. */
export function mintVaultId(): string {
  return randomBytes(10).toString('hex');
}

async function confirmSlot(
  slots: PlatformSecretProtectionServices,
  slot: PlatformKeySlot,
  kek: Uint8Array,
  signal: AbortSignal,
): Promise<SlotCreation> {
  let read: PlatformKeySlotReadResult;
  try {
    read = await slots.readKeySlot(slot, { signal, interaction: 'never' });
  } catch {
    return notInitialized('slot_uncertain');
  }
  if (read.kind === 'blocked') return read;
  if (read.kind !== 'present') return notInitialized('slot_uncertain');
  try {
    const matches =
      read.material.byteLength === kek.byteLength &&
      timingSafeEqual(read.material, kek);
    return matches ? { kind: 'created' } : notInitialized('slot_uncertain');
  } finally {
    zeroBytes(read.material);
  }
}

async function createSlot(
  slots: PlatformSecretProtectionServices,
  slot: PlatformKeySlot,
  kek: Uint8Array,
  signal: AbortSignal,
): Promise<SlotCreation> {
  let written: PlatformKeySlotWriteResult;
  try {
    written = await slots.writeKeySlot(slot, kek, {
      signal,
      interaction: 'never',
      mode: 'create',
    });
  } catch {
    return notInitialized('slot_rejected');
  }
  switch (written.kind) {
    case 'written':
      return { kind: 'created' };
    case 'blocked':
      return written;
    case 'conflict':
      return notInitialized('slot_conflict');
    case 'failed':
      return notInitialized('slot_failed');
    case 'uncertain':
      return confirmSlot(slots, slot, kek, signal);
    default: {
      const unreachable: never = written;
      void unreachable;
      return notInitialized('slot_failed');
    }
  }
}

/** Starts a new vault in an empty, open store. Calls the backend only here, at open. */
export async function initializeVault(
  store: VaultStore,
  slots: PlatformSecretProtectionServices,
  signal: AbortSignal,
): Promise<VaultInitResult> {
  if (store.state !== 'open' || store.header !== null)
    return notInitialized('store');
  const vaultId = mintVaultId();
  const kek = generateVaultKey();
  const dataKey = generateVaultKey();
  let handedOff = false;
  try {
    const wrappedDataKey = wrapDataKey(kek, dataKey, vaultId);
    const slot = await createSlot(slots, vaultKeySlot(vaultId), kek, signal);
    if (slot.kind !== 'created') return slot;
    const written = store.writeHeader({ vaultId, wrappedDataKey });
    if (written.kind !== 'written')
      return notInitialized(
        written.kind === 'uncertain' ? 'header_uncertain' : 'header',
      );
    handedOff = true;
    return { kind: 'initialized', header: written.value, dataKey };
  } finally {
    zeroBytes(kek);
    if (!handedOff) zeroBytes(dataKey);
  }
}
