import { createHash } from 'node:crypto';
import { clampId } from '@canopy/desktop-shared/lib/telemetry-mapping';
import type {
  AgentAuditEntry,
  AgentAuditEventType,
} from '@canopy/desktop-shared/types/observability';
import { MAX_TELEMETRY_CLIENT_ID_LENGTH } from '@canopy/protocol/telemetry';
import {
  clearProductActivityRetryTimers,
  reportDesktopChatTurnActivity,
} from '../canopy-cloud/product-activity-events';
import {
  ambientWorkOwnerContext,
  resolveWorkOwnerOrganization,
} from '../lib/work-owner';
import { getObservabilityService } from '../observability';

/**
 * Reports each observed chat-turn start as desktop product activity
 * (CAN-3561). This is basic usage analytics, separate from activity sharing:
 * it is deliberately not gated on the sharing scopes or an organization's
 * sharing policy.
 *
 * Automation, hook, and Remote Control turns arrive as the same audit entry
 * types as interactive turns, so they are counted too.
 */

const COUNTED_EVENT_TYPES: ReadonlySet<AgentAuditEventType> =
  new Set<AgentAuditEventType>([
    'worktree_chat',
    'standalone_chat',
    'app_advisor',
    'worktree_plan_chat',
  ]);

/**
 * Observability re-emits a running entry as it updates. The seen set keeps
 * those repeats from re-sending within a session; the server's dedupe key is
 * what makes the count authoritative across restarts and evictions.
 */
const MAX_SEEN_TURN_IDS = 2_000;

interface ReporterLifecycle {
  readonly seen: Set<string>;
  unsubscribe: () => void;
}

let lifecycle: ReporterLifecycle | null = null;

function turnKeyFor(entryId: string): string {
  return createHash('sha256')
    .update(clampId(entryId, MAX_TELEMETRY_CLIENT_ID_LENGTH), 'utf8')
    .digest('hex');
}

/**
 * The owning organization's ID, or undefined when the work is ungoverned, the
 * owner is unknown, or it cannot be resolved. Ownership never blocks the count.
 */
async function ownerOrganizationFor(
  entry: AgentAuditEntry,
): Promise<string | undefined> {
  if (!entry.projectId || !entry.worktreeId) return undefined;
  try {
    const owner = await resolveWorkOwnerOrganization(
      { projectId: entry.projectId, worktreeId: entry.worktreeId },
      ambientWorkOwnerContext,
    );
    return owner.kind === 'organization' ? owner.organizationId : undefined;
  } catch {
    return undefined;
  }
}

async function reportTurn(
  current: ReporterLifecycle,
  entry: AgentAuditEntry,
): Promise<void> {
  const organizationExternalId = await ownerOrganizationFor(entry);
  // Disposed, or disposed and re-initialized, while the owner resolved.
  if (lifecycle !== current) return;
  await reportDesktopChatTurnActivity({
    turnKey: turnKeyFor(entry.id),
    organizationExternalId,
  });
}

function observeEntry(
  current: ReporterLifecycle,
  entry: AgentAuditEntry,
): void {
  if (entry.status !== 'running') return;
  if (!COUNTED_EVENT_TYPES.has(entry.eventType)) return;
  // A wake is the chat's own turn, not new usage someone started.
  if (entry.autonomous === true) return;
  if (current.seen.has(entry.id)) return;

  // Recorded before any await so a repeat emitted during owner resolution is
  // already known.
  current.seen.add(entry.id);
  if (current.seen.size > MAX_SEEN_TURN_IDS) {
    // A Set iterates in insertion order, so the first value is the oldest.
    const oldest = current.seen.values().next().value;
    if (oldest !== undefined) current.seen.delete(oldest);
  }

  // Detached: the observability callback never waits on ownership or network.
  void reportTurn(current, entry).catch(() => undefined);
}

export function initializeProductActivityReporter(): void {
  if (lifecycle) return;
  const current: ReporterLifecycle = {
    seen: new Set(),
    unsubscribe: (): void => undefined,
  };
  lifecycle = current;
  current.unsubscribe = getObservabilityService().subscribe((event) => {
    if (event.type !== 'entries') return;
    for (const entry of event.entries) observeEntry(current, entry);
  });
}

export function disposeProductActivityReporter(): void {
  const current = lifecycle;
  // Cleared first: this is what invalidates in-flight owner resolutions.
  lifecycle = null;
  if (current) {
    current.unsubscribe();
    current.seen.clear();
  }
  clearProductActivityRetryTimers();
}
