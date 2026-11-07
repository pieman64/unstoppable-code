import {
  MIGRATION_MAX_VALUE_BYTES,
  MIGRATION_PROTOCOL_ID,
  MIGRATION_PROTOCOL_VERSION,
  encodeMigrationFrame,
  migrationOfferFrame,
  migrationRefusedFrame,
  migrationResultFrame,
  parseMigrationCoreFrame,
  parseMigrationLauncherFrame,
  type MigrationCoreFrame,
  type MigrationLauncherFrame,
} from '../migration-protocol';
import { isMigrationImportResult } from '../migration-ports';
import { MIGRATION_OPERATION, MIGRATION_PURPOSE } from '../migration-sessions';

const SESSION = '0123456789abcdef0123456789abcdef';
const CHALLENGE = 'A'.repeat(42) + 'g';
const HEADER = {
  protocol: MIGRATION_PROTOCOL_ID,
  version: MIGRATION_PROTOCOL_VERSION,
};

function wire(frame: MigrationLauncherFrame | MigrationCoreFrame): unknown {
  return JSON.parse(JSON.stringify(encodeMigrationFrame(frame)));
}

function importWire(overrides: Record<string, unknown> = {}): unknown {
  return {
    ...HEADER,
    type: 'import',
    sessionId: SESSION,
    challenge: CHALLENGE,
    operation: MIGRATION_OPERATION,
    purpose: MIGRATION_PURPOSE,
    value: Buffer.from('ghp_secret').toString('base64url'),
    ...overrides,
  };
}

const launcherFrames: MigrationLauncherFrame[] = [
  { type: 'hello' },
  {
    type: 'import',
    sessionId: SESSION,
    challenge: CHALLENGE,
    operation: MIGRATION_OPERATION,
    purpose: MIGRATION_PURPOSE,
    value: new TextEncoder().encode('ghp_secret'),
  },
  {
    type: 'decline',
    sessionId: SESSION,
    challenge: CHALLENGE,
    operation: MIGRATION_OPERATION,
    purpose: MIGRATION_PURPOSE,
    reason: 'absent',
  },
];

const coreFrames: MigrationCoreFrame[] = [
  { type: 'welcome' },
  {
    type: 'offer',
    sessionId: SESSION,
    slot: 'github-pat',
    challenge: CHALLENGE,
    operation: MIGRATION_OPERATION,
    purpose: MIGRATION_PURPOSE,
    expiresAt: '2026-10-23T12:00:00.000Z',
  },
  { type: 'result', sessionId: SESSION, outcome: 'imported', receipt: 'r-1' },
  { type: 'result', sessionId: SESSION, outcome: 'exists' },
  {
    type: 'result',
    sessionId: SESSION,
    outcome: 'uncertain',
    reason: 'settlement-deadline',
  },
  { type: 'closed', reason: 'unsupported-version' },
];

describe('migration protocol frames', () => {
  it('round-trips every frame through JSON in its own direction only', () => {
    for (const frame of launcherFrames) {
      expect(parseMigrationLauncherFrame(wire(frame))).toEqual({
        ok: true,
        frame,
      });
      expect(parseMigrationCoreFrame(wire(frame)).ok).toBe(false);
    }
    for (const frame of coreFrames) {
      expect(parseMigrationCoreFrame(wire(frame))).toEqual({ ok: true, frame });
      expect(parseMigrationLauncherFrame(wire(frame)).ok).toBe(false);
    }
  });

  it('stamps the private protocol id and version on every frame', () => {
    for (const frame of [...launcherFrames, ...coreFrames])
      expect(encodeMigrationFrame(frame)).toMatchObject(HEADER);
  });

  it('refuses other protocols and versions', () => {
    expect(parseMigrationLauncherFrame(importWire({ version: 2 }))).toEqual({
      ok: false,
      reason: 'unsupported-version',
    });
    expect(parseMigrationLauncherFrame(importWire({ version: '1' }))).toEqual({
      ok: false,
      reason: 'unsupported-version',
    });
    expect(
      parseMigrationLauncherFrame(importWire({ protocol: 'canopy.core' })),
    ).toEqual({ ok: false, reason: 'unsupported-protocol' });
    expect(parseMigrationLauncherFrame(importWire({ type: 'put' }))).toEqual({
      ok: false,
      reason: 'unknown-type',
    });
    for (const value of [null, [], 'hello', 1])
      expect(parseMigrationLauncherFrame(value)).toEqual({
        ok: false,
        reason: 'not-an-object',
      });
  });

  it('never accepts evidence, identity or slot fields from a frame', () => {
    for (const field of [
      'evidence',
      'pid',
      'pidversion',
      'connectionId',
      'channelId',
      'interfaceKind',
      'token',
      'source',
      'slot',
      'generation',
      'cdhash',
      '__proto__',
    ]) {
      const frame: unknown = JSON.parse(
        JSON.stringify(importWire()).replace(
          /^\{/,
          `{${JSON.stringify(field)}:"x",`,
        ),
      );
      expect([field, parseMigrationLauncherFrame(frame)]).toEqual([
        field,
        { ok: false, reason: 'unexpected-field' },
      ]);
    }
  });

  it('requires every field of a frame', () => {
    const missing = {
      ...HEADER,
      type: 'import',
      sessionId: SESSION,
      operation: MIGRATION_OPERATION,
      purpose: MIGRATION_PURPOSE,
      value: 'eA',
    };
    expect(parseMigrationLauncherFrame(missing)).toEqual({
      ok: false,
      reason: 'missing-field',
    });
  });

  it('bounds and validates field formats', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ sessionId: 'S'.repeat(32) }, 'invalid-field:sessionId'],
      [{ sessionId: SESSION + '0' }, 'invalid-field:sessionId'],
      [{ challenge: 'short' }, 'invalid-field:challenge'],
      [{ challenge: 'A'.repeat(42) + '=' }, 'invalid-field:challenge'],
      [{ operation: 'Import!' }, 'invalid-field:operation'],
      [{ purpose: 'p'.repeat(65) }, 'invalid-field:purpose'],
      [{ value: '' }, 'invalid-field:value'],
      [{ value: 'eA==' }, 'invalid-field:value'],
      [{ value: 'eB' }, 'invalid-field:value'],
      [{ value: 'e+A' }, 'invalid-field:value'],
      [{ value: 7 }, 'invalid-field:value'],
      [
        {
          value: Buffer.alloc(MIGRATION_MAX_VALUE_BYTES + 1).toString(
            'base64url',
          ),
        },
        'invalid-field:value',
      ],
    ];
    for (const [overrides, reason] of cases)
      expect([
        reason,
        parseMigrationLauncherFrame(importWire(overrides)),
      ]).toEqual([reason, { ok: false, reason }]);
    const largest = parseMigrationLauncherFrame(
      importWire({
        value: Buffer.alloc(MIGRATION_MAX_VALUE_BYTES, 1).toString('base64url'),
      }),
    );
    expect(
      largest.ok &&
        largest.frame.type === 'import' &&
        largest.frame.value.length,
    ).toBe(MIGRATION_MAX_VALUE_BYTES);
  });

  it('validates core frames, including result shapes', () => {
    const bad: unknown[] = [
      { ...HEADER, type: 'result', sessionId: SESSION, outcome: 'imported' },
      {
        ...HEADER,
        type: 'result',
        sessionId: SESSION,
        outcome: 'exists',
        receipt: 'r-1',
      },
      {
        ...HEADER,
        type: 'result',
        sessionId: SESSION,
        outcome: 'revoked',
        reason: 'Has spaces',
      },
      {
        ...HEADER,
        type: 'offer',
        sessionId: SESSION,
        slot: '../secure',
        challenge: CHALLENGE,
        operation: MIGRATION_OPERATION,
        purpose: MIGRATION_PURPOSE,
        expiresAt: '2026-10-23T12:00:00.000Z',
      },
      {
        ...HEADER,
        type: 'offer',
        sessionId: SESSION,
        slot: 'github-pat',
        challenge: CHALLENGE,
        operation: MIGRATION_OPERATION,
        purpose: MIGRATION_PURPOSE,
        expiresAt: 'tomorrow',
      },
      { ...HEADER, type: 'closed', reason: 'because' },
    ];
    for (const frame of bad)
      expect(parseMigrationCoreFrame(frame).ok).toBe(false);
  });

  it('leaves no plaintext copy in the shared Buffer pool once the value is zeroed', () => {
    // Buffer.alloc never uses the pool, so only the parser could put it there.
    const secret = Buffer.alloc(41);
    secret.write('ghp_pool_residue_' + 'q'.repeat(24));
    const encoded = secret.toString('base64url');
    // Accepted, then a non-canonical encoding refused after decoding.
    for (const value of [encoded, encoded + 'AB']) {
      const result = parseMigrationLauncherFrame(importWire({ value }));
      if (result.ok && result.frame.type === 'import')
        result.frame.value.fill(0);
      const pool = Buffer.from(Buffer.allocUnsafe(1).buffer);
      expect(pool.includes(secret)).toBe(false);
    }
  });

  it('never echoes frame content in a parse failure', () => {
    const secret = 'ghp_' + 'z'.repeat(40);
    const result = parseMigrationLauncherFrame(
      importWire({ value: secret + '=' }),
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('builds offer, result and refusal frames from session values', () => {
    expect(
      migrationOfferFrame({
        sessionId: SESSION,
        slot: 'github-pat',
        challenge: CHALLENGE,
        operation: MIGRATION_OPERATION,
        purpose: MIGRATION_PURPOSE,
        expiresAt: '2026-10-23T12:00:00.000Z',
      }),
    ).toEqual(coreFrames[1]);
    expect(
      migrationResultFrame(SESSION, {
        state: 'completed',
        value: { kind: 'created', receipt: 'r-1' },
      }),
    ).toEqual(coreFrames[2]);
    expect(
      migrationResultFrame(SESSION, {
        state: 'completed',
        value: { kind: 'exists' },
      }),
    ).toEqual(coreFrames[3]);
    expect(
      migrationResultFrame(SESSION, {
        state: 'revoked',
        reason: 'not-initiated:launcher-exit',
      }),
    ).toEqual({
      type: 'result',
      sessionId: SESSION,
      outcome: 'revoked',
      reason: 'not-initiated:launcher-exit',
    });
    expect(
      migrationResultFrame(SESSION, {
        state: 'revoked',
        reason: 'operator said "no"',
      }),
    ).toMatchObject({ outcome: 'revoked', reason: 'unspecified' });
    expect(
      migrationResultFrame(SESSION, {
        state: 'completed',
        value: { kind: 'created', receipt: 'not a receipt' },
      }),
    ).toEqual({
      type: 'result',
      sessionId: SESSION,
      outcome: 'uncertain',
      reason: 'invalid-receipt',
    });
    expect(migrationRefusedFrame(SESSION, 'binding:challenge')).toEqual({
      type: 'result',
      sessionId: SESSION,
      outcome: 'refused',
      reason: 'binding:challenge',
    });
    for (const frame of [
      migrationResultFrame(SESSION, {
        state: 'revoked',
        reason: 'operator said "no"',
      }),
      migrationRefusedFrame(SESSION, 'binding:channel:launcher.pid'),
    ])
      expect(parseMigrationCoreFrame(wire(frame))).toEqual({ ok: true, frame });
  });

  it('the import-result check accepts exactly the receipts the wire carries', () => {
    for (const receipt of [
      'r-1',
      'vault:entry.7_a',
      'x'.repeat(256),
      '',
      'not a receipt',
      'x'.repeat(257),
      'r\n1',
      'r/1',
    ]) {
      const parsed = parseMigrationCoreFrame({
        ...HEADER,
        type: 'result',
        sessionId: SESSION,
        outcome: 'imported',
        receipt,
      });
      expect(isMigrationImportResult({ kind: 'created', receipt })).toBe(
        parsed.ok,
      );
    }
  });
});
