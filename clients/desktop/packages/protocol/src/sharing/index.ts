/**
 * The audience vocabulary every share surface offers.
 *
 * `private`, `team` and `organization` are server share scopes; `public` is a
 * renderer-level layer over a private share (the dialog publishes a public link
 * after the private share lands). The per-domain `*_SHARE_SCOPES` constants
 * stay three values because they describe what the server stores; this list is
 * what a share dialog can offer the author.
 */
export const SHARE_AUDIENCES = [
  'private',
  'team',
  'organization',
  'public',
] as const;

export type ShareAudience = (typeof SHARE_AUDIENCES)[number];

/** Server-persisted audience; Public remains a link over a Private share. */
export type ShareScope = Exclude<ShareAudience, 'public'>;

/** Display state for an entry on a host with Marketplace sharing capability. */
export type MarketplaceEntryShareState =
  | { status: 'shareable' }
  | { status: 'blocked'; reason: string };

/** Existing share command identity, resolved by the inventory authority. */
export type MarketplaceEntryShareTarget =
  | {
      kind: 'plugin';
      marketplaceId: string;
      pluginName: string;
      displayName: string;
      sourceLabel: string;
      /** Canonical portable reference identity for matching an owned share. */
      refKey?: string;
    }
  | { kind: 'skill'; sourceId: string; skillName: string };

/** State and target travel together; blocked entries never carry a target. */
export type MarketplaceEntryShareResolution =
  | { status: 'shareable'; target: MarketplaceEntryShareTarget }
  | Extract<MarketplaceEntryShareState, { status: 'blocked' }>;

export const MARKETPLACE_SHARE_BLOCKED_REASONS = {
  noPublicSource: 'This plugin has no public source to share.',
  standaloneMcp: 'MCP server connections cannot be shared.',
  skillOwner: 'Only the owner can share this skill.',
  pluginOwner: 'Only the owner can share this plugin.',
  alreadyPublic: 'This item is already public.',
  unavailable: 'Sharing is unavailable for this item.',
} as const;

/** Version of a public link observed before an atomic audience transition. */
export interface PublicShareVersion {
  readonly externalId: string;
  readonly updatedAt: string;
}

/** Author-side link from a local resource to its current cloud share. */
export interface ShareRemoteMetadata {
  /** Cloud account that owns this author-side link. */
  readonly accountId?: string;
  readonly remoteId: string;
  readonly contentHash: string;
  readonly shareScope: ShareScope;
  readonly sharedAt: string;
  readonly publicLink?: string;
  readonly ownerName?: string;
}

/** A local row's author-side link, as desktop (`remote`) or web (`shareRemoteId`) carries it. */
export interface AuthorShareLink {
  readonly remote?: Pick<ShareRemoteMetadata, 'remoteId' | 'accountId'>;
  readonly shareRemoteId?: string;
}

function authorShareLinkId(
  local: AuthorShareLink,
  viewerId: string,
): string | undefined {
  if (local.remote) {
    const { accountId, remoteId } = local.remote;
    return accountId === undefined || accountId === viewerId
      ? remoteId
      : undefined;
  }
  return local.shareRemoteId;
}

/**
 * Share ids the viewer's own local copies link to. Uses `remote.remoteId`,
 * else `shareRemoteId`. Drops a link whose `accountId` names another
 * account, and any id claimed by more than one local copy (an ambiguous
 * identity proves no single status to follow). Empty when `viewerId` is
 * absent.
 *
 * Callers filtering a share list must also check the share's `createdBy.id`
 * against the viewer; never fold on this set alone.
 */
export function authorShareRemoteIds(
  locals: readonly AuthorShareLink[],
  viewerId: string | null | undefined,
): ReadonlySet<string> {
  if (!viewerId) {
    return new Set();
  }
  const claims = new Map<string, number>();
  for (const local of locals) {
    const id = authorShareLinkId(local, viewerId);
    if (id) {
      claims.set(id, (claims.get(id) ?? 0) + 1);
    }
  }
  const ids = new Set<string>();
  for (const [id, count] of claims) {
    if (count === 1) {
      ids.add(id);
    }
  }
  return ids;
}

/** The one local copy a share folds into, by index, or undefined. */
export function authorLinkedLocalIndex(
  share: { id: string; createdBy?: { id: string } | null },
  locals: readonly AuthorShareLink[],
  viewerId: string | null | undefined,
): number | undefined {
  if (!viewerId || share.createdBy?.id !== viewerId) {
    return undefined;
  }
  let match: number | undefined;
  for (const [index, local] of locals.entries()) {
    if (authorShareLinkId(local, viewerId) !== share.id) {
      continue;
    }
    if (match !== undefined) {
      return undefined;
    }
    match = index;
  }
  return match;
}

/** Parse persisted author metadata without trusting an unchecked JSON cast. */
export function parseShareRemoteMetadata(
  value: unknown,
): ShareRemoteMetadata | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record: Record<string, unknown> = Object.fromEntries(
    Object.entries(value),
  );
  if (
    (record.accountId !== undefined &&
      (typeof record.accountId !== 'string' ||
        record.accountId.length === 0)) ||
    typeof record.remoteId !== 'string' ||
    record.remoteId.length === 0 ||
    typeof record.contentHash !== 'string' ||
    record.contentHash.length === 0 ||
    (record.shareScope !== 'private' &&
      record.shareScope !== 'team' &&
      record.shareScope !== 'organization') ||
    typeof record.sharedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.sharedAt)) ||
    (record.publicLink !== undefined &&
      typeof record.publicLink !== 'string') ||
    (record.ownerName !== undefined && typeof record.ownerName !== 'string')
  ) {
    return undefined;
  }
  return {
    ...(typeof record.accountId === 'string' && record.accountId.length > 0
      ? { accountId: record.accountId }
      : {}),
    remoteId: record.remoteId,
    contentHash: record.contentHash,
    shareScope: record.shareScope,
    sharedAt: record.sharedAt,
    ...(typeof record.publicLink === 'string'
      ? { publicLink: record.publicLink }
      : {}),
    ...(typeof record.ownerName === 'string'
      ? { ownerName: record.ownerName }
      : {}),
  };
}

/** True for any value in {@link SHARE_AUDIENCES}. */
export function isShareAudience(value: unknown): value is ShareAudience {
  return (
    typeof value === 'string' &&
    SHARE_AUDIENCES.some((audience) => audience === value)
  );
}

/**
 * Why a share attempt failed, in terms a share dialog can present.
 *
 * Unknown values fail {@link parseShareFailure}, so an older client never
 * renders an unrecognized category as something specific.
 */
export const SHARE_FAILURE_KINDS = [
  'authentication',
  'organization-plan',
  'permission',
  'conflict',
  'dependency-review',
  'connection',
  'unavailable',
  'unknown',
] as const;

export type ShareFailureKind = (typeof SHARE_FAILURE_KINDS)[number];

/** `commit` is the package upload commit (idempotent). `publish` is resource publication (not idempotent). */
export const SHARE_FAILURE_STAGES = [
  'access',
  'prepare',
  'upload',
  'commit',
  'publish',
  'finish',
] as const;

export type ShareFailureStage = (typeof SHARE_FAILURE_STAGES)[number];

export const SHARE_FAILURE_COMMIT_STATES = [
  'not-committed',
  'committed',
  'unknown',
] as const;

export type ShareFailureCommitState =
  (typeof SHARE_FAILURE_COMMIT_STATES)[number];

/**
 * The server's machine-readable cause, when it named one. Unknown values are
 * dropped by {@link parseShareFailure}; the failure still parses.
 */
export const SHARE_FAILURE_REASONS = [
  'org_teams_lapsed',
  'publisher_role_required',
] as const;

export type ShareFailureReason = (typeof SHARE_FAILURE_REASONS)[number];

/** Longest `message` a share failure carries; longer text is truncated. */
export const SHARE_FAILURE_MESSAGE_MAX_LENGTH = 240;

export interface ShareFailure {
  readonly version: 1;
  readonly kind: ShareFailureKind;
  readonly stage: ShareFailureStage;
  readonly message: string;
  /** Resource-publication certainty, independent of package upload completion. */
  readonly commitState: ShareFailureCommitState;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly serverCode?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  /** Set for `organization-plan`; the external organization id the server refused. */
  readonly organizationId?: string;
  /** The server's named cause, e.g. `publisher_role_required` for a viewer. */
  readonly reason?: ShareFailureReason;
}

/** Envelope for share operations whose rejection would otherwise lose structure. */
export type ShareOperationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ShareFailure };

/** Advisory access facts for one organization a share could target. */
export interface ShareOrganizationAccess {
  readonly organizationId: string;
  readonly organizationName?: string;
  /** Known to hold the teams capability; absent means unknown. */
  readonly teamsEntitled?: boolean;
  /** Whether the current account can choose a plan for this organization. */
  readonly canChoosePlan?: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toRecord(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value));
}

function findListed<T extends string>(
  list: readonly T[],
  value: unknown,
): T | undefined {
  return list.find((entry) => entry === value);
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** Truncate a share failure message to {@link SHARE_FAILURE_MESSAGE_MAX_LENGTH}. */
export function boundShareFailureMessage(message: string): string {
  return message.length > SHARE_FAILURE_MESSAGE_MAX_LENGTH
    ? `${message.slice(0, SHARE_FAILURE_MESSAGE_MAX_LENGTH - 1)}…`
    : message;
}

/** Parse a share failure without trusting an unchecked cast. */
export function parseShareFailure(value: unknown): ShareFailure | undefined {
  if (!isPlainRecord(value)) return undefined;
  const record = toRecord(value);
  const kind = findListed(SHARE_FAILURE_KINDS, record.kind);
  const stage = findListed(SHARE_FAILURE_STAGES, record.stage);
  const commitState = findListed(
    SHARE_FAILURE_COMMIT_STATES,
    record.commitState,
  );
  if (
    record.version !== 1 ||
    kind === undefined ||
    stage === undefined ||
    commitState === undefined ||
    typeof record.message !== 'string' ||
    typeof record.retryable !== 'boolean'
  ) {
    return undefined;
  }
  const httpStatus =
    typeof record.httpStatus === 'number' &&
    Number.isInteger(record.httpStatus) &&
    record.httpStatus >= 100 &&
    record.httpStatus <= 599
      ? record.httpStatus
      : undefined;
  const serverCode = optionalNonEmptyString(record.serverCode);
  const requestId = optionalNonEmptyString(record.requestId);
  const retryAfterMs = optionalNonNegativeNumber(record.retryAfterMs);
  const organizationId = optionalNonEmptyString(record.organizationId);
  const reason = findListed(SHARE_FAILURE_REASONS, record.reason);
  return {
    version: 1,
    kind,
    stage,
    message: boundShareFailureMessage(record.message),
    commitState,
    retryable: record.retryable,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(serverCode !== undefined ? { serverCode } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(organizationId !== undefined ? { organizationId } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

/**
 * True for a well-formed {@link ShareOperationResult}. The `value` of a
 * success is not inspected; the failure branch must parse.
 */
export function isShareOperationResult(
  value: unknown,
): value is ShareOperationResult<unknown> {
  if (!isPlainRecord(value)) return false;
  if (value.ok === true) return 'value' in value;
  if (value.ok === false) return parseShareFailure(value.failure) !== undefined;
  return false;
}

/** Parse advisory organization access facts, dropping malformed entries. */
export function parseShareOrganizationAccessList(
  value: unknown,
): ShareOrganizationAccess[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: ShareOrganizationAccess[] = [];
  for (const item of value) {
    if (!isPlainRecord(item)) continue;
    const organizationId = optionalNonEmptyString(item.organizationId);
    if (organizationId === undefined) continue;
    const organizationName = optionalNonEmptyString(item.organizationName);
    entries.push({
      organizationId,
      ...(organizationName !== undefined ? { organizationName } : {}),
      ...(typeof item.teamsEntitled === 'boolean'
        ? { teamsEntitled: item.teamsEntitled }
        : {}),
      ...(typeof item.canChoosePlan === 'boolean'
        ? { canChoosePlan: item.canChoosePlan }
        : {}),
    });
  }
  return entries;
}

/**
 * Build advisory organization access facts from an account's organizations
 * and billing states. A billing state is the only source of `teamsEntitled`;
 * an organization without one stays unknown, never denied. Only an `OWNER`
 * can choose a plan.
 */
export function buildShareOrganizationAccess(
  organizations: readonly {
    readonly id: string;
    readonly name?: string;
    readonly role?: string;
  }[],
  billingStates: readonly {
    readonly organizationId: string;
    readonly organizationName?: string;
    readonly teamsEntitled: boolean;
  }[],
): ShareOrganizationAccess[] {
  const billingById = new Map(
    billingStates.map((state) => [state.organizationId, state]),
  );
  const access = organizations.map((organization) => {
    const billing = billingById.get(organization.id);
    const organizationName = organization.name ?? billing?.organizationName;
    return {
      organizationId: organization.id,
      ...(organizationName ? { organizationName } : {}),
      ...(billing ? { teamsEntitled: billing.teamsEntitled } : {}),
      ...(organization.role !== undefined
        ? { canChoosePlan: organization.role === 'OWNER' }
        : {}),
    };
  });
  const listed = new Set(organizations.map((organization) => organization.id));
  for (const state of billingStates) {
    if (listed.has(state.organizationId)) continue;
    access.push({
      organizationId: state.organizationId,
      ...(state.organizationName
        ? { organizationName: state.organizationName }
        : {}),
      teamsEntitled: state.teamsEntitled,
    });
  }
  return access;
}
