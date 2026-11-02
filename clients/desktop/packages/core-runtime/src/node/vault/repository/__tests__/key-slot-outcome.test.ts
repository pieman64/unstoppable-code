import {
  VaultEntryStateSchema,
  VaultProtectionStatusSchema,
  type VaultEntryState,
  type VaultProtectionStatus,
} from '@canopy/protocol/canopy-core';

import type {
  PlatformKeySlotReadResult,
  PlatformSecretProtectionState,
  PlatformSecretProtectionUnavailableReason,
} from '../../../../platform/secret-protection';
import {
  KEY_SLOT_NAME_PATTERN,
  type FakeSecretProtectionFault,
} from '../../../../platform/testing/fake-secret-protection';
import {
  vaultIntegrityFailure,
  type VaultIntegrityStep,
} from '../integrity-failure';
import {
  mapVaultKeySlotOutcome,
  observeVaultKeySlotRead,
  vaultKeySlot,
  type VaultKeySlotEntryBlock,
  type VaultKeySlotObservation,
  type VaultKeySlotOutcome,
  type VaultKeySlotProtection,
} from '../key-slot-outcome';
import type { VaultSealedBox } from '../record-format';
import { generateVaultKey, wrapDataKey } from '../vault-keys';
import {
  FIXTURE_BACKEND,
  KEY_SLOT_FIXTURES,
  runKeySlotFixture,
} from './key-slot-fixtures';

// Compile-time drift checks against the wire types D0 owns.
const protectionIsWire = (p: VaultKeySlotProtection): VaultProtectionStatus =>
  p;
const blockIsEntryState = (b: VaultKeySlotEntryBlock): VaultEntryState => b;

const backend = FIXTURE_BACKEND;
const REASONS: readonly PlatformSecretProtectionUnavailableReason[] = [
  'no_backend',
  'unsupported_session',
  'backend_failed',
  'authority_unavailable',
];
const STATUSES: readonly (PlatformSecretProtectionState | null)[] = [
  null,
  { state: 'available' },
  { state: 'unknown' },
  { state: 'locked', evidence: 'reported' },
  { state: 'locked', evidence: 'inferred' },
  { state: 'denied' },
  ...REASONS.map(
    (reason): PlatformSecretProtectionState => ({
      state: 'unavailable',
      reason,
    }),
  ),
];

function map(
  observation: VaultKeySlotObservation,
  status: PlatformSecretProtectionState | null,
): VaultKeySlotOutcome {
  return mapVaultKeySlotOutcome({ backend, observation, status });
}

function locked(evidence: 'reported' | 'inferred'): VaultKeySlotOutcome {
  return {
    protection: { state: 'locked', backend, evidence },
    entryBlock: 'locked',
  };
}

function unavailable(
  reason: PlatformSecretProtectionUnavailableReason,
): VaultKeySlotOutcome {
  return {
    protection: { state: 'unavailable', backend, reason },
    entryBlock: 'unavailable',
  };
}

const keyMissing: VaultKeySlotOutcome = {
  protection: { state: 'key_missing', backend },
  entryBlock: 'key_missing',
};

const STEPS = [
  'slot',
  'key',
  'vault_id',
  'fields',
  'box',
  'length',
  'tag',
] as const satisfies readonly VaultIntegrityStep[];
// A new step fails to compile until it is listed above.
const everyStepListed: [
  Exclude<VaultIntegrityStep, (typeof STEPS)[number]>,
] extends [never]
  ? true
  : never = true;
void everyStepListed;
const INTEGRITY_FAILURES = STEPS.map(vaultIntegrityFailure);

describe('mapVaultKeySlotOutcome (Q4)', () => {
  // Rows whose outcome no status() observation may change.
  const fixedRows: readonly [
    string,
    VaultKeySlotObservation,
    VaultKeySlotOutcome,
  ][] = [
    [
      'not probed yet',
      { kind: 'not_probed' },
      {
        protection: { state: 'unknown', backend },
        entryBlock: 'unavailable',
      },
    ],
    [
      'present, unwrap succeeds',
      { kind: 'unwrapped' },
      { protection: { state: 'available', backend }, entryBlock: null },
    ],
    ['absent', { kind: 'absent' }, keyMissing],
    ...INTEGRITY_FAILURES.map(
      (failure): [string, VaultKeySlotObservation, VaultKeySlotOutcome] => [
        `corrupt at step ${failure.step}`,
        failure,
        keyMissing,
      ],
    ),
    [
      'interaction_required (4a-1)',
      { kind: 'blocked', reason: 'interaction_required' },
      locked('inferred'),
    ],
    [
      'denied',
      { kind: 'blocked', reason: 'denied' },
      { protection: { state: 'denied', backend }, entryBlock: 'denied' },
    ],
    [
      'rejection, abort or timeout',
      { kind: 'rejected' },
      unavailable('backend_failed'),
    ],
  ];

  it.each(fixedRows)(
    '%s maps the same under every status()',
    (_, observation, expected) => {
      for (const status of STATUSES)
        expect(map(observation, status)).toEqual(expected);
    },
  );

  it('locked takes its evidence from a locked status(), otherwise inferred', () => {
    const observation: VaultKeySlotObservation = {
      kind: 'blocked',
      reason: 'locked',
    };
    for (const status of STATUSES) {
      const expected =
        status?.state === 'locked'
          ? locked(status.evidence)
          : locked('inferred');
      expect(map(observation, status)).toEqual(expected);
    }
    expect(map(observation, { state: 'locked', evidence: 'reported' })).toEqual(
      locked('reported'),
    );
    // A bare unknown is not a failed access and never sets evidence.
    expect(map(observation, { state: 'unknown' })).toEqual(locked('inferred'));
  });

  it('unavailable takes its reason from an unavailable status(), otherwise backend_failed', () => {
    const observation: VaultKeySlotObservation = {
      kind: 'blocked',
      reason: 'unavailable',
    };
    for (const reason of REASONS)
      expect(map(observation, { state: 'unavailable', reason })).toEqual(
        unavailable(reason),
      );
    for (const status of STATUSES.filter((s) => s?.state !== 'unavailable'))
      expect(map(observation, status)).toEqual(unavailable('backend_failed'));
  });

  it('never publishes available without a held key or derives a state from status() alone', () => {
    const observations: VaultKeySlotObservation[] = [
      { kind: 'not_probed' },
      { kind: 'absent' },
      ...INTEGRITY_FAILURES,
      { kind: 'blocked', reason: 'locked' },
      { kind: 'blocked', reason: 'interaction_required' },
      { kind: 'blocked', reason: 'denied' },
      { kind: 'blocked', reason: 'unavailable' },
      { kind: 'rejected' },
    ];
    for (const observation of observations)
      for (const status of STATUSES) {
        const result = map(observation, status);
        expect(result.protection.state).not.toBe('available');
        expect(result.entryBlock).not.toBeNull();
      }
  });

  it('fails closed on an observation it does not know', () => {
    for (const observation of [
      { kind: 'blocked', reason: 'later' },
      { kind: 'later' },
    ])
      expect(
        Reflect.apply(mapVaultKeySlotOutcome, undefined, [
          { backend, observation, status: null },
        ]),
      ).toEqual(unavailable('backend_failed'));
  });

  it('produces only valid wire protection and entry states', () => {
    for (const [, observation] of fixedRows)
      for (const status of STATUSES) {
        const result = map(observation, status);
        expect(
          VaultProtectionStatusSchema.parse(
            protectionIsWire(result.protection),
          ),
        ).toEqual(result.protection);
        if (result.entryBlock !== null)
          expect(
            VaultEntryStateSchema.parse(blockIsEntryState(result.entryBlock)),
          ).toBe(result.entryBlock);
      }
  });
});

describe('vaultKeySlot', () => {
  it('names the slot vault-<vaultId> within the slot name pattern', () => {
    expect(vaultKeySlot('abc')).toEqual({ name: 'vault-abc' });
    const longest = `a${'b'.repeat(57)}`;
    expect(vaultKeySlot(longest).name).toMatch(KEY_SLOT_NAME_PATTERN);
    expect(vaultKeySlot(longest).name).toHaveLength(64);
    expect(vaultKeySlot('0-x').name).toBe('vault-0-x');
  });

  it.each(['', `a${'b'.repeat(58)}`, 'ABC', '-abc', 'a_b', 'a.b', 'a/b', 'é'])(
    'rejects vault ID %p',
    (vaultId) => {
      expect(() => vaultKeySlot(vaultId)).toThrow(TypeError);
    },
  );
});

describe('observeVaultKeySlotRead', () => {
  const VAULT_ID = 'vault1';

  function presentRead(
    material: Uint8Array,
  ): Extract<PlatformKeySlotReadResult, { kind: 'present' }> {
    return { kind: 'present', material };
  }

  it('returns the unwrapped data key and zeroes the slot material', () => {
    const kek = generateVaultKey();
    const dataKey = generateVaultKey();
    const wrapped = wrapDataKey(kek, dataKey, VAULT_ID);
    const read = presentRead(Uint8Array.from(kek));
    const result = observeVaultKeySlotRead(read, wrapped, VAULT_ID);
    expect(result.observation).toEqual({ kind: 'unwrapped' });
    expect(result.dataKey).toEqual(dataKey);
    expect(read.material.every((byte) => byte === 0)).toBe(true);
  });

  it('reports a platform-corrupt slot and an unwrap failure through one failure value', () => {
    expect(
      observeVaultKeySlotRead({ kind: 'corrupt' }, wrapDataKeyFor(), VAULT_ID),
    ).toEqual({ observation: vaultIntegrityFailure('slot'), dataKey: null });
    const read = presentRead(generateVaultKey());
    expect(observeVaultKeySlotRead(read, wrapDataKeyFor(), VAULT_ID)).toEqual({
      observation: vaultIntegrityFailure('tag'),
      dataKey: null,
    });
    expect(read.material.every((byte) => byte === 0)).toBe(true);
  });

  it.each<PlatformKeySlotReadResult>([
    { kind: 'absent' },
    { kind: 'blocked', reason: 'locked' },
    { kind: 'blocked', reason: 'interaction_required' },
    { kind: 'blocked', reason: 'denied' },
    { kind: 'blocked', reason: 'unavailable' },
  ])('passes %p through', (read) => {
    expect(observeVaultKeySlotRead(read, wrapDataKeyFor(), VAULT_ID)).toEqual({
      observation: read,
      dataKey: null,
    });
  });

  function wrapDataKeyFor(): VaultSealedBox {
    return wrapDataKey(generateVaultKey(), generateVaultKey(), VAULT_ID);
  }
});

describe('fake key-slot fixtures', () => {
  it('cover every fake fault kind', () => {
    const kinds: Record<FakeSecretProtectionFault['kind'], true> = {
      locked: true,
      unknown: true,
      denied: true,
      unavailable: true,
      corrupt: true,
      key_missing: true,
      uncertain: true,
      write_failed: true,
      abort: true,
    };
    const covered = new Set(KEY_SLOT_FIXTURES.map((entry) => entry.covers));
    for (const kind of Object.keys(kinds)) expect(covered).toContain(kind);
  });

  it.each(KEY_SLOT_FIXTURES.map((entry) => [entry.name, entry] as const))(
    '%s',
    async (_, entry) => {
      const observed = await runKeySlotFixture(entry);
      expect(
        mapVaultKeySlotOutcome({
          backend,
          observation: observed.observation,
          status: observed.status,
        }),
      ).toEqual(entry.expected);
      const { observation } = observed;
      expect(observation.kind === 'corrupt' ? observation.step : null).toBe(
        entry.step ?? null,
      );
      // interaction: 'never' must not prompt.
      expect(observed.prompts).toBe(0);
    },
  );
});
