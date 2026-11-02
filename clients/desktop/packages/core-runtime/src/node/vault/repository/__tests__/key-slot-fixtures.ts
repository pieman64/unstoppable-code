import type {
  PlatformKeySlotReadResult,
  PlatformSecretProtectionBackend,
  PlatformSecretProtectionServices,
  PlatformSecretProtectionState,
  PlatformSecretProtectionUnavailableReason,
} from '../../../../platform/secret-protection';
import {
  createFakeSecretProtection,
  type FakeSecretProtection,
  type FakeSecretProtectionFault,
} from '../../../../platform/testing/fake-secret-protection';
import type { VaultIntegrityStep } from '../integrity-failure';
import {
  observeVaultKeySlotRead,
  vaultKeySlot,
  type VaultKeySlotObservation,
  type VaultKeySlotOutcome,
} from '../key-slot-outcome';
import type { VaultSealedBox } from '../record-format';
import { generateVaultKey, wrapDataKey } from '../vault-keys';
import { zeroBytes } from '../zero-bytes';

/*
 * One fixture per fake key-slot outcome: every fake fault kind, every read
 * result, unwrap failures, rejection, abort and timeout. Each drives the
 * fake through one prompt-free read and states the Q4 outcome it maps to.
 */

export const FIXTURE_VAULT_ID = 'v1a2b3c4';
export const FIXTURE_BACKEND: PlatformSecretProtectionBackend =
  'macos_keychain';
const SLOT_NAME = vaultKeySlot(FIXTURE_VAULT_ID).name;

export interface KeySlotFixtureEnv {
  readonly fake: FakeSecretProtection;
  /** The KEK stored in the slot. */
  readonly kek: Uint8Array;
  /** The header wrapped under `kek` for the fixture vault. */
  readonly wrapped: VaultSealedBox;
}

export interface KeySlotFixture {
  readonly name: string;
  /** The fake fault kind exercised, or `read` for a read-side condition. */
  readonly covers: FakeSecretProtectionFault['kind'] | 'read';
  /** False: the slot is never read (`not_probed`). */
  readonly probe: boolean;
  /** Overrides the stored KEK, for slot material that is not a key. */
  readonly slotMaterial?: () => Uint8Array;
  /** Injects faults; may return a replacement header. */
  arrange(env: KeySlotFixtureEnv): VaultSealedBox | void;
  signal(): AbortSignal;
  readonly expected: VaultKeySlotOutcome;
  /** The integrity step behind a `corrupt` observation. */
  readonly step?: VaultIntegrityStep;
}

export interface KeySlotObserved {
  readonly observation: VaultKeySlotObservation;
  readonly status: PlatformSecretProtectionState | null;
  readonly prompts: number;
}

const live = (): AbortSignal => new AbortController().signal;
const noop = (): void => undefined;

function abortSoon(): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 0);
  return controller.signal;
}

const available: VaultKeySlotOutcome = {
  protection: { state: 'available', backend: FIXTURE_BACKEND },
  entryBlock: null,
};
const keyMissing: VaultKeySlotOutcome = {
  protection: { state: 'key_missing', backend: FIXTURE_BACKEND },
  entryBlock: 'key_missing',
};

function locked(evidence: 'reported' | 'inferred'): VaultKeySlotOutcome {
  return {
    protection: { state: 'locked', backend: FIXTURE_BACKEND, evidence },
    entryBlock: 'locked',
  };
}

function unavailable(
  reason: PlatformSecretProtectionUnavailableReason,
): VaultKeySlotOutcome {
  return {
    protection: { state: 'unavailable', backend: FIXTURE_BACKEND, reason },
    entryBlock: 'unavailable',
  };
}

const UNAVAILABLE_REASONS: readonly PlatformSecretProtectionUnavailableReason[] =
  [
    'no_backend',
    'unsupported_session',
    'backend_failed',
    'authority_unavailable',
  ];

function fixture(
  name: string,
  covers: KeySlotFixture['covers'],
  expected: VaultKeySlotOutcome,
  arrange: KeySlotFixture['arrange'] = noop,
  signal: () => AbortSignal = live,
): KeySlotFixture {
  return { name, covers, probe: true, arrange, signal, expected };
}

function inject(
  fault: FakeSecretProtectionFault,
): (env: KeySlotFixtureEnv) => void {
  return (env) => env.fake.inject(fault);
}

export const KEY_SLOT_FIXTURES: readonly KeySlotFixture[] = [
  {
    name: 'not probed yet',
    covers: 'read',
    probe: false,
    arrange: noop,
    signal: live,
    expected: {
      protection: { state: 'unknown', backend: FIXTURE_BACKEND },
      entryBlock: 'unavailable',
    },
  },
  fixture('present, the data key unwraps', 'read', available),
  {
    ...fixture(
      'present, header wrapped under another KEK',
      'read',
      keyMissing,
      () =>
        wrapDataKey(generateVaultKey(), generateVaultKey(), FIXTURE_VAULT_ID),
    ),
    step: 'tag',
  },
  {
    ...fixture(
      'present, header wrapped for another vault',
      'read',
      keyMissing,
      (env) => wrapDataKey(env.kek, generateVaultKey(), 'v-other'),
    ),
    step: 'tag',
  },
  {
    ...fixture('present, header tag tampered', 'read', keyMissing, (env) => {
      const tag = Uint8Array.from(env.wrapped.tag);
      tag[0] ^= 1;
      return { ...env.wrapped, tag };
    }),
    step: 'tag',
  },
  {
    ...fixture(
      'present, header nonce truncated',
      'read',
      keyMissing,
      (env) => ({ ...env.wrapped, nonce: env.wrapped.nonce.subarray(0, 8) }),
    ),
    step: 'box',
  },
  {
    ...fixture(
      'present, slot material is not a 32-byte key',
      'read',
      keyMissing,
    ),
    slotMaterial: () => Uint8Array.from({ length: 16 }, (_, i) => i + 1),
    step: 'key',
  },
  fixture(
    'absent',
    'key_missing',
    keyMissing,
    inject({ kind: 'key_missing', slot: SLOT_NAME }),
  ),
  {
    ...fixture(
      'corrupt',
      'corrupt',
      keyMissing,
      inject({ kind: 'corrupt', slot: SLOT_NAME }),
    ),
    step: 'slot',
  },
  fixture(
    'locked, reported by status()',
    'locked',
    locked('reported'),
    inject({ kind: 'locked', evidence: 'reported' }),
  ),
  fixture(
    'locked, inferred by status()',
    'locked',
    locked('inferred'),
    inject({ kind: 'locked', evidence: 'inferred' }),
  ),
  fixture(
    'unknown status: the read needs a prompt',
    'unknown',
    locked('inferred'),
    inject({ kind: 'unknown' }),
  ),
  fixture(
    'denied',
    'denied',
    {
      protection: { state: 'denied', backend: FIXTURE_BACKEND },
      entryBlock: 'denied',
    },
    inject({ kind: 'denied' }),
  ),
  ...UNAVAILABLE_REASONS.map((reason) =>
    fixture(
      `unavailable: ${reason}`,
      'unavailable',
      unavailable(reason),
      inject({ kind: 'unavailable', reason }),
    ),
  ),
  fixture(
    'read aborted while pending',
    'abort',
    unavailable('backend_failed'),
    inject({ kind: 'abort' }),
    abortSoon,
  ),
  fixture(
    'read timed out',
    'abort',
    unavailable('backend_failed'),
    inject({ kind: 'abort' }),
    () => AbortSignal.timeout(5),
  ),
  fixture(
    'read rejected: signal already aborted',
    'read',
    unavailable('backend_failed'),
    noop,
    () => AbortSignal.abort(),
  ),
  fixture(
    'uncertain write armed: reads unaffected',
    'uncertain',
    available,
    inject({ kind: 'uncertain', operation: 'write', applied: true }),
  ),
  fixture(
    'uncertain delete armed: reads unaffected',
    'uncertain',
    available,
    inject({ kind: 'uncertain', operation: 'delete', applied: true }),
  ),
  fixture(
    'write failure armed: reads unaffected',
    'write_failed',
    available,
    inject({ kind: 'write_failed' }),
  ),
];

/** The prompt-free read unit C will run, reduced to mapper input. */
export async function observeKeySlot(
  port: PlatformSecretProtectionServices,
  wrapped: VaultSealedBox,
  signal: AbortSignal,
): Promise<VaultKeySlotObservation> {
  let read: PlatformKeySlotReadResult;
  try {
    read = await port.readKeySlot(vaultKeySlot(FIXTURE_VAULT_ID), {
      interaction: 'never',
      signal,
    });
  } catch {
    return { kind: 'rejected' };
  }
  const { observation, dataKey } = observeVaultKeySlotRead(
    read,
    wrapped,
    FIXTURE_VAULT_ID,
  );
  if (dataKey !== null) zeroBytes(dataKey);
  return observation;
}

export async function runKeySlotFixture(
  entry: KeySlotFixture,
): Promise<KeySlotObserved> {
  const kek = generateVaultKey();
  const dataKey = generateVaultKey();
  const slotMaterial = entry.slotMaterial?.() ?? kek;
  const fake = createFakeSecretProtection({
    backend: FIXTURE_BACKEND,
    slots: { [SLOT_NAME]: slotMaterial },
  });
  const env: KeySlotFixtureEnv = {
    fake,
    kek,
    wrapped: wrapDataKey(kek, dataKey, FIXTURE_VAULT_ID),
  };
  const wrapped = entry.arrange(env) ?? env.wrapped;
  zeroBytes(kek, dataKey, slotMaterial);
  const observation: VaultKeySlotObservation = entry.probe
    ? await observeKeySlot(fake.port, wrapped, entry.signal())
    : { kind: 'not_probed' };
  let status: PlatformSecretProtectionState | null;
  try {
    status = await fake.port.status({ signal: live() });
  } catch {
    status = null;
  }
  return { observation, status, prompts: fake.prompts };
}
