import type {
  PlatformKeySlot,
  PlatformKeySlotBlocked,
  PlatformKeySlotReadResult,
  PlatformSecretProtectionBackend,
  PlatformSecretProtectionState,
  PlatformSecretProtectionUnavailableReason,
} from '../../../platform/secret-protection';
import {
  vaultIntegrityFailure,
  type VaultIntegrityFailure,
} from './integrity-failure';
import {
  VAULT_ID_PATTERN,
  VAULT_KEY_SLOT_PREFIX,
  type VaultSealedBox,
} from './record-format';
import { unwrapDataKey } from './vault-keys';
import { zeroBytes } from './zero-bytes';

/*
 * Q4 (plan r4): the vault status comes from one prompt-free read of its key
 * slot plus an unwrap of the data key. A `status()` observation only refines
 * lock evidence and the unavailable reason; a bare `unknown` never sets one.
 */

/** One per-vault slot; V1 never replaces or deletes it. */
export function vaultKeySlot(vaultId: string): PlatformKeySlot {
  if (typeof vaultId !== 'string' || !VAULT_ID_PATTERN.test(vaultId))
    throw new TypeError('Invalid vault ID.');
  return { name: `${VAULT_KEY_SLOT_PREFIX}${vaultId}` };
}

export type VaultKeySlotObservation =
  | { readonly kind: 'not_probed' }
  /** The slot was present and its KEK unwrapped the data key. */
  | { readonly kind: 'unwrapped' }
  | { readonly kind: 'absent' }
  /** Step `slot` when the platform reports it; otherwise the unwrap failure. */
  | VaultIntegrityFailure
  | PlatformKeySlotBlocked
  /** The read rejected, was aborted or timed out. */
  | { readonly kind: 'rejected' };

export type VaultKeySlotRead =
  /** The caller owns `dataKey`: it derives the subkeys, then zeroes it. */
  | {
      readonly observation: { readonly kind: 'unwrapped' };
      readonly dataKey: Uint8Array;
    }
  | {
      readonly observation: Exclude<
        VaultKeySlotObservation,
        { readonly kind: 'unwrapped' }
      >;
      readonly dataKey: null;
    };

/**
 * Reduces one resolved slot read to mapper input, unwrapping the header with
 * a present KEK and zeroing the slot material. A corrupt slot and every
 * unwrap failure leave as the same integrity failure.
 */
export function observeVaultKeySlotRead(
  read: PlatformKeySlotReadResult,
  wrapped: VaultSealedBox,
  vaultId: string,
): VaultKeySlotRead {
  switch (read.kind) {
    case 'present': {
      try {
        const unwrap = unwrapDataKey(read.material, wrapped, vaultId);
        return unwrap.kind === 'unwrapped'
          ? { observation: { kind: 'unwrapped' }, dataKey: unwrap.dataKey }
          : { observation: unwrap, dataKey: null };
      } finally {
        zeroBytes(read.material);
      }
    }
    case 'corrupt':
      return { observation: vaultIntegrityFailure('slot'), dataKey: null };
    default:
      return { observation: read, dataKey: null };
  }
}

// Mirrors the wire `VaultProtectionStatus`, kept local while D0 amends contracts.
export type VaultKeySlotProtection =
  | {
      readonly state: 'unknown' | 'available' | 'denied' | 'key_missing';
      readonly backend: PlatformSecretProtectionBackend;
    }
  | {
      readonly state: 'locked';
      readonly backend: PlatformSecretProtectionBackend;
      readonly evidence: 'reported' | 'inferred';
    }
  | {
      readonly state: 'unavailable';
      readonly backend: PlatformSecretProtectionBackend;
      readonly reason: PlatformSecretProtectionUnavailableReason;
    };

export type VaultKeySlotEntryBlock =
  | 'locked'
  | 'denied'
  | 'unavailable'
  | 'key_missing';

export interface VaultKeySlotOutcome {
  readonly protection: VaultKeySlotProtection;
  /** Null: the data key is held, so normal entry precedence applies. */
  readonly entryBlock: VaultKeySlotEntryBlock | null;
}

export interface VaultKeySlotOutcomeInput {
  readonly backend: PlatformSecretProtectionBackend;
  readonly observation: VaultKeySlotObservation;
  /** Null when no `status()` result is at hand. */
  readonly status: PlatformSecretProtectionState | null;
}

export function mapVaultKeySlotOutcome(
  input: VaultKeySlotOutcomeInput,
): VaultKeySlotOutcome {
  const { backend, observation, status } = input;
  const unavailable = (
    reason: PlatformSecretProtectionUnavailableReason,
  ): VaultKeySlotOutcome => ({
    protection: { state: 'unavailable', backend, reason },
    entryBlock: 'unavailable',
  });
  const locked = (evidence: 'reported' | 'inferred'): VaultKeySlotOutcome => ({
    protection: { state: 'locked', backend, evidence },
    entryBlock: 'locked',
  });
  const keyMissing: VaultKeySlotOutcome = {
    protection: { state: 'key_missing', backend },
    entryBlock: 'key_missing',
  };

  switch (observation.kind) {
    case 'not_probed':
      return {
        protection: { state: 'unknown', backend },
        entryBlock: 'unavailable',
      };
    case 'unwrapped':
      return { protection: { state: 'available', backend }, entryBlock: null };
    // Absent, and every integrity step alike; `step` only explains the cause.
    case 'absent':
    case 'corrupt':
      return keyMissing;
    case 'rejected':
      return unavailable('backend_failed');
    case 'blocked':
      switch (observation.reason) {
        case 'locked':
          // A locked `status()` keeps its own evidence; anything else means
          // only the failed read implied the lock.
          return locked(
            status?.state === 'locked' ? status.evidence : 'inferred',
          );
        case 'interaction_required':
          return locked('inferred');
        case 'denied':
          return {
            protection: { state: 'denied', backend },
            entryBlock: 'denied',
          };
        case 'unavailable':
          return unavailable(
            status?.state === 'unavailable' ? status.reason : 'backend_failed',
          );
        default: {
          const unreachable: never = observation.reason;
          void unreachable;
          return unavailable('backend_failed');
        }
      }
    default: {
      const unreachable: never = observation;
      void unreachable;
      return unavailable('backend_failed');
    }
  }
}
