/**
 * Pattern for opaque IDs returned by deferred capability catalogs:
 * `deferred:v1:` followed by an unpadded base64url sha256 (43 characters).
 */
export const DELEGATION_CAPABILITY_ID_PATTERN =
  /^deferred:v1:[A-Za-z0-9_-]{43}$/;

/** Bounds explicit grants and Portal-safe capability summaries. */
export const DELEGATION_CAPABILITY_LIMITS = Object.freeze({
  explicit: 64,
  summaryItems: 128,
  summarySkipped: 64,
  nameCharacters: 200,
});

/** Capability kinds that may be granted to a delegate. */
export const DELEGATION_CAPABILITY_KINDS = ['skill', 'plugin', 'mcp'] as const;

/** Sources recorded for a delegate's effective capabilities. */
export const DELEGATION_CAPABILITY_SOURCES = [
  'agent',
  'inherited',
  'explicit',
  'loaded',
] as const;

/** Kind of a deferred capability. */
export type DelegationCapabilityKind =
  (typeof DELEGATION_CAPABILITY_KINDS)[number];

/** Provenance of a capability in a delegate's effective set. */
export type DelegationCapabilitySource =
  (typeof DELEGATION_CAPABILITY_SOURCES)[number];

/** Reasons an attempted capability grant may be omitted. */
export const DELEGATION_CAPABILITY_SKIP_REASONS = [
  'missing_selection',
  'unsupported_capability',
  'unsupported_hooks',
  'unsupported_lsp',
  'unsupported_skill_execution',
  'unavailable_asset',
] as const;

/** Reason a requested capability was skipped. */
export type DelegationCapabilitySkipReason =
  (typeof DELEGATION_CAPABILITY_SKIP_REASONS)[number];

/**
 * Names only: never paths, config digests, or credentials. Portal-safe.
 */
export interface DelegationCapabilitySummary {
  /** Whether the child inherits the caller's effective capabilities. */
  readonly inherit: boolean;
  /** Whether the child receives spawn-time capability discovery. */
  readonly discovery: boolean;
  /** Bounded names and sources for capabilities available to the child. */
  readonly items: readonly {
    readonly kind: DelegationCapabilityKind;
    readonly name: string;
    readonly source: DelegationCapabilitySource;
  }[];
  /** Bounded capability names and reasons for skipped grants. */
  readonly skipped: readonly {
    readonly kind: DelegationCapabilityKind;
    readonly name: string;
    readonly reason: DelegationCapabilitySkipReason;
  }[];
  /** Entries omitted from items to stay within the summary bound. */
  readonly omittedItems?: number;
  /** Entries omitted from skipped to stay within the summary bound. */
  readonly omittedSkipped?: number;
}

/** One row in a delegate capability catalog. */
export interface DelegationCapabilityChoice {
  /** Opaque identity matching a deferred-tools catalog reference. */
  readonly id: string;
  /** Kind of capability represented by this choice. */
  readonly kind: DelegationCapabilityKind;
  /** Safe display name for the capability. */
  readonly name: string;
  /** Optional safe display description. */
  readonly description?: string;
  /** Whether this capability is already in the caller's effective set. */
  readonly inherited: boolean;
  /** Whether this capability may be assigned to the child. */
  readonly assignable: boolean;
  /** Optional safe explanation when the choice cannot be assigned. */
  readonly disabledReason?: string;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMemberOf<const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): value is Values[number] {
  return (
    typeof value === 'string' && values.some((candidate) => candidate === value)
  );
}

function isCapabilityKind(value: unknown): value is DelegationCapabilityKind {
  return isMemberOf(DELEGATION_CAPABILITY_KINDS, value);
}

function isCapabilitySource(
  value: unknown,
): value is DelegationCapabilitySource {
  return isMemberOf(DELEGATION_CAPABILITY_SOURCES, value);
}

function isSkipReason(value: unknown): value is DelegationCapabilitySkipReason {
  return isMemberOf(DELEGATION_CAPABILITY_SKIP_REASONS, value);
}

function isCapabilityName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= DELEGATION_CAPABILITY_LIMITS.nameCharacters &&
    !/[\0\r\n]/.test(value)
  );
}

function isSummaryItem(value: unknown): boolean {
  return (
    plainRecord(value) &&
    isCapabilityKind(value.kind) &&
    isCapabilityName(value.name) &&
    isCapabilitySource(value.source)
  );
}

function isSkippedItem(value: unknown): boolean {
  return (
    plainRecord(value) &&
    isCapabilityKind(value.kind) &&
    isCapabilityName(value.name) &&
    isSkipReason(value.reason)
  );
}

function isOmittedCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Validates a bounded Portal-safe summary while tolerating future fields. */
export function isDelegationCapabilitySummary(
  value: unknown,
): value is DelegationCapabilitySummary {
  return (
    plainRecord(value) &&
    typeof value.inherit === 'boolean' &&
    typeof value.discovery === 'boolean' &&
    Array.isArray(value.items) &&
    value.items.length <= DELEGATION_CAPABILITY_LIMITS.summaryItems &&
    Array.from(value.items).every(isSummaryItem) &&
    Array.isArray(value.skipped) &&
    value.skipped.length <= DELEGATION_CAPABILITY_LIMITS.summarySkipped &&
    Array.from(value.skipped).every(isSkippedItem) &&
    (value.omittedItems === undefined || isOmittedCount(value.omittedItems)) &&
    (value.omittedSkipped === undefined || isOmittedCount(value.omittedSkipped))
  );
}
