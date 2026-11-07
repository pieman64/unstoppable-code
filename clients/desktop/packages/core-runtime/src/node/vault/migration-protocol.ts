import {
  MIGRATION_RECEIPT_PATTERN,
  MIGRATION_SLOT_ID_PATTERN,
  type MigrationImportResult,
} from './migration-ports';
import type {
  MigrationDeclineReason,
  MigrationPresentationRefusal,
  MigrationSessionOffer,
  MigrationSessionOutcome,
} from './migration-sessions';

/*
 * Private, versioned migration frames (doc 07: a "separate, versioned,
 * one-time protocol"). VA-6b wraps these in core.vaultMigration.exchange on
 * the private launcher channel only. Frames carry no evidence or identity:
 * those come only from the admitted channel.
 */

export const MIGRATION_PROTOCOL_ID = 'canopy.vault.migration';
export const MIGRATION_PROTOCOL_VERSION = 1;
/** Largest plaintext one import frame carries. */
export const MIGRATION_MAX_VALUE_BYTES = 1_048_576;

const SESSION_ID = /^[0-9a-f]{32}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const TOKEN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REASON = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_VALUE_CHARS = Math.ceil((MIGRATION_MAX_VALUE_BYTES * 4) / 3);

const DECLINE_REASONS: readonly MigrationDeclineReason[] = [
  'absent',
  'unreadable',
  'malformed',
  'outcome_unknown',
];
const CLOSED_REASONS = [
  'unsupported-version',
  'protocol-error',
  'closed',
] as const;

export type MigrationClosedReason = (typeof CLOSED_REASONS)[number];

interface SessionFields {
  readonly sessionId: string;
  readonly challenge: string;
  readonly operation: string;
  readonly purpose: string;
}

/** Launcher to core. */
export type MigrationLauncherFrame =
  | { readonly type: 'hello' }
  | (SessionFields & { readonly type: 'import'; readonly value: Uint8Array })
  | (SessionFields & {
      readonly type: 'decline';
      readonly reason: MigrationDeclineReason;
    });

export type MigrationResultFrame =
  | {
      readonly type: 'result';
      readonly sessionId: string;
      readonly outcome: 'imported';
      readonly receipt: string;
    }
  | {
      readonly type: 'result';
      readonly sessionId: string;
      readonly outcome: 'exists';
    }
  | {
      readonly type: 'result';
      readonly sessionId: string;
      readonly outcome: 'refused' | 'revoked' | 'uncertain';
      readonly reason: string;
    };

/** Core to launcher. */
export type MigrationCoreFrame =
  | { readonly type: 'welcome' }
  | (MigrationSessionOffer & { readonly type: 'offer' })
  | MigrationResultFrame
  | { readonly type: 'closed'; readonly reason: MigrationClosedReason };

export type MigrationWireFrame = Readonly<Record<string, string | number>>;

export type MigrationFrameError =
  | 'not-an-object'
  | 'unsupported-protocol'
  | 'unsupported-version'
  | 'unknown-type'
  | 'unexpected-field'
  | 'missing-field'
  | `invalid-field:${string}`;

export type MigrationFrameParse<F> =
  | { readonly ok: true; readonly frame: F }
  | { readonly ok: false; readonly reason: MigrationFrameError };

const SESSION_KEYS = ['sessionId', 'challenge', 'operation', 'purpose'];
const LAUNCHER_KEYS: ReadonlyMap<string, readonly string[]> = new Map([
  ['hello', []],
  ['import', [...SESSION_KEYS, 'value']],
  ['decline', [...SESSION_KEYS, 'reason']],
]);
const CORE_KEYS: ReadonlyMap<string, readonly string[]> = new Map([
  ['welcome', []],
  ['offer', [...SESSION_KEYS, 'slot', 'expiresAt']],
  ['result', ['sessionId', 'outcome']],
  ['closed', ['reason']],
]);

class FrameError extends Error {
  constructor(readonly reason: MigrationFrameError) {
    super(reason);
  }
}

function encodeValue(value: Uint8Array): string {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString(
    'base64url',
  );
}

/**
 * Canonical, unpadded base64url only, so one value has one encoding.
 * Decodes into an unpooled buffer: zeroing the result erases the only copy.
 */
function decodeValue(text: unknown): Uint8Array {
  if (
    typeof text !== 'string' ||
    text.length > MAX_VALUE_CHARS ||
    !BASE64URL.test(text)
  )
    throw new FrameError('invalid-field:value');
  const bytes = Buffer.alloc(Buffer.byteLength(text, 'base64url'));
  bytes.write(text, 'base64url');
  if (
    bytes.length === 0 ||
    bytes.length > MIGRATION_MAX_VALUE_BYTES ||
    bytes.toString('base64url') !== text
  ) {
    bytes.fill(0);
    throw new FrameError('invalid-field:value');
  }
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function field(
  frame: Readonly<Record<string, unknown>>,
  name: string,
  pattern: RegExp,
): string {
  const value = frame[name];
  if (typeof value !== 'string' || !pattern.test(value))
    throw new FrameError(`invalid-field:${name}`);
  return value;
}

function oneOf<T extends string>(
  frame: Readonly<Record<string, unknown>>,
  name: string,
  values: readonly T[],
): T {
  const value = frame[name];
  const match = values.find((candidate) => candidate === value);
  if (match === undefined) throw new FrameError(`invalid-field:${name}`);
  return match;
}

function isoTime(frame: Readonly<Record<string, unknown>>): string {
  const value = frame.expiresAt;
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new FrameError('invalid-field:expiresAt');
  return value;
}

function sessionFields(
  frame: Readonly<Record<string, unknown>>,
): SessionFields {
  return {
    sessionId: field(frame, 'sessionId', SESSION_ID),
    challenge: field(frame, 'challenge', CHALLENGE),
    operation: field(frame, 'operation', TOKEN),
    purpose: field(frame, 'purpose', TOKEN),
  };
}

/** Checks the header and the exact key set; returns the frame type. */
function envelope(
  value: unknown,
  keysByType: ReadonlyMap<string, readonly string[]>,
  extraKeys: (frame: Readonly<Record<string, unknown>>) => readonly string[],
): {
  readonly type: string;
  readonly frame: Readonly<Record<string, unknown>>;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new FrameError('not-an-object');
  const frame: Readonly<Record<string, unknown>> = Object.fromEntries(
    Object.entries(value),
  );
  if (frame.protocol !== MIGRATION_PROTOCOL_ID)
    throw new FrameError('unsupported-protocol');
  if (frame.version !== MIGRATION_PROTOCOL_VERSION)
    throw new FrameError('unsupported-version');
  const type = frame.type;
  const keys = typeof type === 'string' ? keysByType.get(type) : undefined;
  if (typeof type !== 'string' || keys === undefined)
    throw new FrameError('unknown-type');
  const allowed = ['protocol', 'version', 'type', ...keys, ...extraKeys(frame)];
  const present = Object.keys(frame);
  if (present.some((key) => !allowed.includes(key)))
    throw new FrameError('unexpected-field');
  if (allowed.some((key) => !present.includes(key)))
    throw new FrameError('missing-field');
  return { type, frame };
}

function parse<F>(read: () => F): MigrationFrameParse<F> {
  try {
    return { ok: true, frame: read() };
  } catch (error) {
    if (error instanceof FrameError) return { ok: false, reason: error.reason };
    throw error;
  }
}

export function parseMigrationLauncherFrame(
  value: unknown,
): MigrationFrameParse<MigrationLauncherFrame> {
  return parse((): MigrationLauncherFrame => {
    const { type, frame } = envelope(value, LAUNCHER_KEYS, () => []);
    if (type === 'hello') return { type };
    const session = sessionFields(frame);
    if (type === 'import')
      return { type, ...session, value: decodeValue(frame.value) };
    return {
      type: 'decline',
      ...session,
      reason: oneOf(frame, 'reason', DECLINE_REASONS),
    };
  });
}

function resultExtraKeys(
  frame: Readonly<Record<string, unknown>>,
): readonly string[] {
  if (frame.type !== 'result') return [];
  if (frame.outcome === 'imported') return ['receipt'];
  return frame.outcome === 'exists' ? [] : ['reason'];
}

function resultFrame(
  frame: Readonly<Record<string, unknown>>,
): MigrationResultFrame {
  const sessionId = field(frame, 'sessionId', SESSION_ID);
  const outcome = oneOf(frame, 'outcome', [
    'imported',
    'exists',
    'refused',
    'revoked',
    'uncertain',
  ] as const);
  if (outcome === 'imported')
    return {
      type: 'result',
      sessionId,
      outcome,
      receipt: field(frame, 'receipt', MIGRATION_RECEIPT_PATTERN),
    };
  if (outcome === 'exists') return { type: 'result', sessionId, outcome };
  return {
    type: 'result',
    sessionId,
    outcome,
    reason: field(frame, 'reason', REASON),
  };
}

export function parseMigrationCoreFrame(
  value: unknown,
): MigrationFrameParse<MigrationCoreFrame> {
  return parse((): MigrationCoreFrame => {
    const { type, frame } = envelope(value, CORE_KEYS, resultExtraKeys);
    if (type === 'welcome') return { type };
    if (type === 'result') return resultFrame(frame);
    if (type === 'closed')
      return { type, reason: oneOf(frame, 'reason', CLOSED_REASONS) };
    return {
      type: 'offer',
      ...sessionFields(frame),
      slot: field(frame, 'slot', MIGRATION_SLOT_ID_PATTERN),
      expiresAt: isoTime(frame),
    };
  });
}

function sessionWire(frame: SessionFields): MigrationWireFrame {
  return {
    sessionId: frame.sessionId,
    challenge: frame.challenge,
    operation: frame.operation,
    purpose: frame.purpose,
  };
}

function bodyWire(
  frame: MigrationLauncherFrame | MigrationCoreFrame,
): MigrationWireFrame {
  switch (frame.type) {
    case 'hello':
    case 'welcome':
      return {};
    case 'import':
      return { ...sessionWire(frame), value: encodeValue(frame.value) };
    case 'decline':
      return { ...sessionWire(frame), reason: frame.reason };
    case 'offer':
      return {
        ...sessionWire(frame),
        slot: frame.slot,
        expiresAt: frame.expiresAt,
      };
    case 'closed':
      return { reason: frame.reason };
    case 'result':
      if (frame.outcome === 'imported')
        return {
          sessionId: frame.sessionId,
          outcome: frame.outcome,
          receipt: frame.receipt,
        };
      if (frame.outcome === 'exists')
        return { sessionId: frame.sessionId, outcome: frame.outcome };
      return {
        sessionId: frame.sessionId,
        outcome: frame.outcome,
        reason: frame.reason,
      };
  }
}

/** Builds the JSON body field by field, so nothing else reaches the wire. */
export function encodeMigrationFrame(
  frame: MigrationLauncherFrame | MigrationCoreFrame,
): MigrationWireFrame {
  return {
    protocol: MIGRATION_PROTOCOL_ID,
    version: MIGRATION_PROTOCOL_VERSION,
    type: frame.type,
    ...bodyWire(frame),
  };
}

export function migrationOfferFrame(
  offer: MigrationSessionOffer,
): MigrationCoreFrame {
  return {
    type: 'offer',
    sessionId: offer.sessionId,
    slot: offer.slot,
    challenge: offer.challenge,
    operation: offer.operation,
    purpose: offer.purpose,
    expiresAt: offer.expiresAt,
  };
}

/** Reasons that are not wire tokens (free-form revoke text) go out as `unspecified`. */
function wireReason(reason: string): string {
  return REASON.test(reason) ? reason : 'unspecified';
}

export function migrationResultFrame(
  sessionId: string,
  outcome: MigrationSessionOutcome<MigrationImportResult>,
): MigrationResultFrame {
  if (outcome.state !== 'completed')
    return {
      type: 'result',
      sessionId,
      outcome: outcome.state,
      reason: wireReason(outcome.reason),
    };
  if (outcome.value.kind === 'exists')
    return { type: 'result', sessionId, outcome: 'exists' };
  // The registry already settles these as uncertain; this guards other
  // outcome sources. Without a usable receipt the launcher keeps its copy.
  if (!MIGRATION_RECEIPT_PATTERN.test(outcome.value.receipt))
    return {
      type: 'result',
      sessionId,
      outcome: 'uncertain',
      reason: 'invalid-receipt',
    };
  return {
    type: 'result',
    sessionId,
    outcome: 'imported',
    receipt: outcome.value.receipt,
  };
}

export function migrationRefusedFrame(
  sessionId: string,
  reason: MigrationPresentationRefusal,
): MigrationResultFrame {
  return { type: 'result', sessionId, outcome: 'refused', reason };
}
