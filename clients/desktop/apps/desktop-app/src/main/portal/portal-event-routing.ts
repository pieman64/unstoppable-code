import type { PortalEventEnvelope } from '@canopy/desktop-shared/types';

export interface PortalWorktreeIdentity {
  workspaceLocalId: string;
  worktreeLocalId: string;
}

export interface PortalCoworkIdentity {
  coworkWorkspaceLocalId: string;
  workEntryId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function portalWorktreeKey(identity: PortalWorktreeIdentity): string {
  return `${identity.workspaceLocalId}\0${identity.worktreeLocalId}`;
}

export function portalCoworkKey(identity: PortalCoworkIdentity): string {
  return `${identity.coworkWorkspaceLocalId}\0${identity.workEntryId}`;
}

function parseCompositeParentLocalId(
  value: unknown,
): PortalWorktreeIdentity | null {
  if (typeof value !== 'string') {
    return null;
  }
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) {
    return null;
  }
  return {
    workspaceLocalId: value.slice(0, separator),
    worktreeLocalId: value.slice(separator + 1),
  };
}

function getParentScopedWorktreeIdentity(
  payload: Record<string, unknown>,
): PortalWorktreeIdentity | null {
  const candidates: unknown[] = [];
  if (isRecord(payload.entity)) {
    candidates.push(payload.entity.parentLocalId);
  }
  for (const listKey of ['entities', 'removed'] as const) {
    const list = payload[listKey];
    if (Array.isArray(list)) {
      for (const entry of list) {
        if (isRecord(entry)) {
          candidates.push(entry.parentLocalId);
        }
      }
    }
  }
  candidates.push(payload.parentLocalId);
  let resolved: PortalWorktreeIdentity | null = null;
  for (const candidate of candidates) {
    const identity = parseCompositeParentLocalId(candidate);
    if (!identity) {
      continue;
    }
    if (resolved === null) {
      resolved = identity;
      continue;
    }
    if (
      resolved.workspaceLocalId !== identity.workspaceLocalId ||
      resolved.worktreeLocalId !== identity.worktreeLocalId
    ) {
      return null;
    }
  }
  return resolved;
}

export function getPortalEventWorktreeIdentity(
  event: PortalEventEnvelope,
): PortalWorktreeIdentity | null {
  if (!isRecord(event.payload)) {
    return null;
  }
  const target = isRecord(event.payload.target) ? event.payload.target : null;
  const workspaceLocalId =
    typeof event.payload.workspaceLocalId === 'string'
      ? event.payload.workspaceLocalId
      : typeof target?.workspaceLocalId === 'string'
        ? target.workspaceLocalId
        : undefined;
  const worktreeLocalId =
    typeof event.payload.worktreeLocalId === 'string'
      ? event.payload.worktreeLocalId
      : typeof target?.worktreeLocalId === 'string'
        ? target.worktreeLocalId
        : undefined;
  if (workspaceLocalId && worktreeLocalId) {
    return { workspaceLocalId, worktreeLocalId };
  }
  return getParentScopedWorktreeIdentity(event.payload);
}

export function getPortalEventCoworkIdentity(
  event: PortalEventEnvelope,
): PortalCoworkIdentity | null {
  if (
    event.type !== 'portal.chat.event' ||
    !isRecord(event.payload) ||
    event.payload.scope !== 'standalone'
  ) {
    return null;
  }
  const coworkWorkspaceLocalId =
    typeof event.payload.projectLocalId === 'string'
      ? event.payload.projectLocalId
      : typeof event.payload.projectId === 'string'
        ? event.payload.projectId
        : undefined;
  const workEntryId = event.payload.workEntryId;
  return coworkWorkspaceLocalId &&
    typeof workEntryId === 'string' &&
    workEntryId
    ? { coworkWorkspaceLocalId, workEntryId }
    : null;
}

/**
 * Session-wide routing key for App Advisor traffic (CAN-2569). App Advisor
 * events carry no workspace/worktree fields, so without a lane they were
 * never stamped: overflow trims dropped them first (background bucket) AND
 * produced no gap marker, leaving the browser stale with no resync signal.
 * The constant can never collide with a worktree wire key — those always
 * contain the `workspace:worktree` separator with non-empty halves.
 */
export const PORTAL_APP_ADVISOR_ROUTING_KEY = 'app-advisor';

/**
 * App Advisor traffic that belongs on the {@link
 * PORTAL_APP_ADVISOR_ROUTING_KEY} lane: the chat event stream plus
 * state envelopes whose payload scope is `app_advisor`.
 */
export function isAppAdvisorPortalEvent(event: PortalEventEnvelope): boolean {
  if (event.type === 'portal.app_advisor.event') {
    return true;
  }
  if (
    event.type !== 'portal.state.delta' &&
    event.type !== 'portal.state.snapshot'
  ) {
    return false;
  }
  return isRecord(event.payload) && event.payload.scope === 'app_advisor';
}

export interface PortalEventLane {
  /** Wire routing key stamped into `payload.routing.key`. */
  key: string;
  /**
   * Internal sequence-counter key. Worktree and cowork lanes use the `\0`
   * composite (distinct from the `:` wire key so pathological local ids
   * cannot alias two lanes onto one counter); the App Advisor lane has no
   * identity halves, so its counter key IS the wire key.
   */
  counterKey: string;
  /** Owning worktree, when the lane is worktree-scoped. */
  identity: PortalWorktreeIdentity | null;
}

export function getPortalEventLane(
  event: PortalEventEnvelope,
): PortalEventLane | null {
  const identity = getPortalEventWorktreeIdentity(event);
  if (identity) {
    return {
      key: `${identity.workspaceLocalId}:${identity.worktreeLocalId}`,
      counterKey: portalWorktreeKey(identity),
      identity,
    };
  }
  const coworkIdentity = getPortalEventCoworkIdentity(event);
  if (coworkIdentity) {
    return {
      key: `${coworkIdentity.coworkWorkspaceLocalId}:${coworkIdentity.workEntryId}`,
      counterKey: portalCoworkKey(coworkIdentity),
      identity: null,
    };
  }
  if (isAppAdvisorPortalEvent(event)) {
    return {
      key: PORTAL_APP_ADVISOR_ROUTING_KEY,
      counterKey: PORTAL_APP_ADVISOR_ROUTING_KEY,
      identity: null,
    };
  }
  return null;
}

export function isPortalEventForeground(
  event: PortalEventEnvelope,
  foregroundWorktreeKey: string | null,
): boolean {
  return isPortalWorktreeIdentityForeground(
    getPortalEventWorktreeIdentity(event),
    foregroundWorktreeKey,
  );
}

export function isPortalWorktreeIdentityForeground(
  identity: PortalWorktreeIdentity | null,
  foregroundWorktreeKey: string | null,
): boolean {
  return (
    identity !== null &&
    foregroundWorktreeKey !== null &&
    portalWorktreeKey(identity) === foregroundWorktreeKey
  );
}
