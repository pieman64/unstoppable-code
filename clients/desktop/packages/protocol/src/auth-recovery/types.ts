/** Which class of dependency failed to authenticate. */
export type AuthDependencyClass = 'provider' | 'mcp' | 'integration';

/**
 * Why a dependency is unusable.
 *
 * Only the first four are authentication failures the user can recover from
 * inline. The rest are represented so the UI can explain the real problem
 * instead of showing a misleading login prompt (CAN-1814).
 */
export type AuthFailureClass =
  | 'unauthenticated'
  | 'expired'
  | 'revoked'
  | 'reauthorization_required'
  | 'quota_exceeded'
  | 'insufficient_scope'
  | 'misconfigured'
  | 'provider_outage'
  | 'network_error'
  | 'unsupported_auth_method';

/** Focused configuration surface to open when inline recovery is impossible. */
export type AuthSettingsTarget =
  | { page: 'mcp-servers'; serverId?: string }
  | { page: 'integrations'; integration: 'github' | 'linear' }
  | { page: 'provider-accounts'; provider: 'claude' | 'codex' };

/** How the user recovers, or an explicit statement that they cannot inline. */
export type AuthRecoveryMethod =
  | { kind: 'provider_terminal'; provider: 'claude' | 'codex' }
  | { kind: 'mcp_oauth'; serverId: string; configId: string }
  | { kind: 'github_login' }
  | { kind: 'linear_login' }
  | { kind: 'settings_deeplink'; target: AuthSettingsTarget }
  | { kind: 'none' };

/**
 * One dependency that could not authenticate, as carried on the transcript.
 *
 * This shape crosses into the web Portal when a shared run replays, so it must
 * stay serializable and must never carry credential material.
 */
export interface AuthDependencyFailure {
  dependencyClass: AuthDependencyClass;
  /** Stable identity used for checklist keying and dedupe. */
  dependencyId: string;
  /** User-facing name, e.g. 'Prod MCP server', 'Linear', 'Claude'. */
  displayName: string;
  failureClass: AuthFailureClass;
  recovery: AuthRecoveryMethod;
  /** Redacted diagnostic detail. Never contains credentials. */
  detail?: string;
}

/**
 * The only failure classes that may carry a recovery action.
 *
 * This is the invariant that makes 'show a login button for a quota error'
 * unrepresentable rather than a copywriting rule.
 */
export const RECOVERABLE_AUTH_FAILURE_CLASSES: readonly AuthFailureClass[] = [
  'unauthenticated',
  'expired',
  'revoked',
  'reauthorization_required',
];

export function isRecoverableAuthFailureClass(
  value: AuthFailureClass,
): boolean {
  return RECOVERABLE_AUTH_FAILURE_CLASSES.includes(value);
}

/** Enforce the recoverable-class/recovery-method pairing invariant. */
export function isValidAuthDependencyFailure(
  value: AuthDependencyFailure,
): boolean {
  if (value.recovery.kind === 'none') {
    return true;
  }
  return isRecoverableAuthFailureClass(value.failureClass);
}

/**
 * Synthetic chat event carrying a structured authentication failure so the
 * transcript reducer can attach it to the block it explains (CAN-1814).
 *
 * Main cannot write transcript blocks directly — they are reduced from streamed
 * provider events — so this rides the existing chat-event envelope like
 * `turn_diff`. It lives here rather than in a desktop package because the same
 * envelope replays on the web Portal.
 */
export const CANOPY_AUTH_FAILURE_EVENT_TYPE = 'canopy_auth_failure';

export interface CanopyAuthFailureEventData {
  type: typeof CANOPY_AUTH_FAILURE_EVENT_TYPE;
  /**
   * Errored MCP `tool_use` this failure explains. Absent for provider-level
   * failures, which attach to the turn's text block instead.
   */
  toolUseId?: string;
  /**
   * The dependency this event is primarily about, and the one a consumer that
   * predates {@link CanopyAuthFailureEventData.failures} will render.
   *
   * Kept required rather than replaced by the array: transcripts persisted
   * before the checklist shipped carry only the singular block field, so every
   * reader has to understand this shape anyway.
   */
  failure: AuthDependencyFailure;
  /**
   * EVERY dependency blocked in this turn, deduplicated by `dependencyId` with
   * {@link CanopyAuthFailureEventData.failure} first (CAN-1814 PR 2).
   *
   * One event carries the whole set rather than one event per dependency
   * because the checklist is a single card with a row per dependency, and the
   * per-dependency alternative would need a distinct attachment target for each
   * — which a turn does not necessarily have. Claiming a pending failure is
   * destructive, so anything not carried here is lost, not deferred.
   */
  failures?: AuthDependencyFailure[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `Array.isArray` narrows `unknown` to `any[]`, which would smuggle `any` into
 * every element read. This keeps elements typed as `unknown`.
 */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isAuthDependencyClass(value: unknown): value is AuthDependencyClass {
  return value === 'provider' || value === 'mcp' || value === 'integration';
}

function isAuthFailureClass(value: unknown): value is AuthFailureClass {
  return (
    value === 'unauthenticated' ||
    value === 'expired' ||
    value === 'revoked' ||
    value === 'reauthorization_required' ||
    value === 'quota_exceeded' ||
    value === 'insufficient_scope' ||
    value === 'misconfigured' ||
    value === 'provider_outage' ||
    value === 'network_error' ||
    value === 'unsupported_auth_method'
  );
}

function isAuthSettingsTarget(value: unknown): value is AuthSettingsTarget {
  if (!isRecord(value)) return false;
  switch (value.page) {
    case 'mcp-servers':
      return value.serverId === undefined || typeof value.serverId === 'string';
    case 'integrations':
      return value.integration === 'github' || value.integration === 'linear';
    case 'provider-accounts':
      return value.provider === 'claude' || value.provider === 'codex';
    default:
      return false;
  }
}

function isAuthRecoveryMethod(value: unknown): value is AuthRecoveryMethod {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'provider_terminal':
      return value.provider === 'claude' || value.provider === 'codex';
    case 'mcp_oauth':
      return (
        typeof value.serverId === 'string' && typeof value.configId === 'string'
      );
    case 'github_login':
    case 'linear_login':
    case 'none':
      return true;
    case 'settings_deeplink':
      return isAuthSettingsTarget(value.target);
    default:
      return false;
  }
}

/**
 * Runtime shape guard for an untrusted `AuthDependencyFailure`, followed by the
 * semantic `isValidAuthDependencyFailure` invariant above.
 *
 * This lives in `@canopy/protocol` rather than in a consumer so the desktop
 * renderer, the transcript reducer, and (in a later PR) the web Portal all
 * deserialize the same wire value through one implementation. A shape-valid but
 * semantically-invalid payload — e.g. `failureClass: 'quota_exceeded'` paired
 * with an `mcp_oauth` recovery — is rejected here so it can never render a
 * login prompt for a failure that logging in cannot fix.
 */
/**
 * Shape-only guard: does this look like an `AuthDependencyFailure`, regardless
 * of whether it satisfies the recoverable-class invariant?
 *
 * Consumers need this split because the two failure modes mean opposite things
 * when reading persisted data. A value that is shape-valid but semantically
 * invalid still carries a readable verdict from main (`failureClass`), which a
 * text heuristic must not overrule. A value that is not even shape-valid
 * carries no verdict at all, so there is nothing to defer to and independent
 * evidence (the tool output) should still be allowed to speak.
 */
export function isAuthDependencyFailureShape(
  value: unknown,
): value is AuthDependencyFailure {
  return (
    isRecord(value) &&
    isAuthDependencyClass(value.dependencyClass) &&
    typeof value.dependencyId === 'string' &&
    typeof value.displayName === 'string' &&
    isAuthFailureClass(value.failureClass) &&
    isAuthRecoveryMethod(value.recovery) &&
    (value.detail === undefined || typeof value.detail === 'string')
  );
}

export function isAuthDependencyFailure(
  value: unknown,
): value is AuthDependencyFailure {
  if (
    !isRecord(value) ||
    !isAuthDependencyClass(value.dependencyClass) ||
    typeof value.dependencyId !== 'string' ||
    typeof value.displayName !== 'string' ||
    !isAuthFailureClass(value.failureClass) ||
    !isAuthRecoveryMethod(value.recovery) ||
    (value.detail !== undefined && typeof value.detail !== 'string')
  ) {
    return false;
  }

  const candidate: AuthDependencyFailure = {
    dependencyClass: value.dependencyClass,
    dependencyId: value.dependencyId,
    displayName: value.displayName,
    failureClass: value.failureClass,
    recovery: value.recovery,
    ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
  };
  return isValidAuthDependencyFailure(candidate);
}

/**
 * Narrow an untrusted chat-event payload to the structured auth-failure event.
 */
export function isCanopyAuthFailureEventData(
  value: unknown,
): value is CanopyAuthFailureEventData {
  return (
    isRecord(value) &&
    value.type === CANOPY_AUTH_FAILURE_EVENT_TYPE &&
    (value.toolUseId === undefined || typeof value.toolUseId === 'string') &&
    isAuthDependencyFailure(value.failure) &&
    // Strict on the wire, unlike {@link readAuthDependencyFailures}: this
    // envelope is produced by main for this renderer, so a malformed entry is
    // a bug to surface rather than untrusted persisted data to salvage.
    (value.failures === undefined ||
      (isUnknownArray(value.failures) &&
        value.failures.every(isAuthDependencyFailure)))
  );
}

/**
 * Anything that may carry attached authentication failures: a persisted
 * `text` / `tool_result` block, or the display projection of one. Fields are
 * `unknown` because the persisted read path does not validate them.
 */
export interface AuthFailureCarrier {
  authFailure?: unknown;
  authFailures?: unknown;
}

export interface AuthDependencyFailureRead {
  /**
   * Failures that satisfy BOTH the shape guard and the recoverable-class
   * invariant, deduplicated by `dependencyId`, first occurrence winning.
   */
  failures: AuthDependencyFailure[];
  /**
   * True when at least one attached value was shape-valid, i.e. main reached a
   * readable verdict about this block — whether or not that verdict survived
   * the semantic invariant.
   *
   * Consumers need this separately from an empty `failures` list because the
   * two states mean opposite things. A shape-valid but semantically invalid
   * value is a verdict saying "reconnecting does not fix this", which a text
   * heuristic must not overrule. A value that is not shape-valid at all
   * (truncated, hand-edited) is no verdict, so independent evidence may still
   * speak. See `ToolCallBlock`.
   */
  hasVerdict: boolean;
}

/**
 * Read every authentication failure attached to a block, tolerating both the
 * singular `authFailure` written before the multi-blocker checklist and the
 * `authFailures` array written since (CAN-1814 PR 2).
 *
 * Lives here rather than in a consumer so the desktop renderer, the transcript
 * reducer, and the web Portal deserialize persisted blocks through one
 * implementation.
 */
export function readAuthDependencyFailures(
  carrier: AuthFailureCarrier,
): AuthDependencyFailureRead {
  const raw: unknown[] = [];
  if (isUnknownArray(carrier.authFailures)) {
    raw.push(...carrier.authFailures);
  }
  if (carrier.authFailure !== undefined && carrier.authFailure !== null) {
    raw.push(carrier.authFailure);
  }

  const failures: AuthDependencyFailure[] = [];
  const seen = new Set<string>();
  let hasVerdict = false;
  for (const entry of raw) {
    if (!isAuthDependencyFailureShape(entry)) continue;
    hasVerdict = true;
    if (!isValidAuthDependencyFailure(entry)) continue;
    if (seen.has(entry.dependencyId)) continue;
    seen.add(entry.dependencyId);
    failures.push(entry);
  }
  return { failures, hasVerdict };
}
