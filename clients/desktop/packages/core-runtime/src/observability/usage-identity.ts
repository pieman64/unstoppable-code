// Usage aggregation keyed by persisted event identity (CAN-5078). A duplicate
// finalization, a replay after restart or a second ingesting host produces an
// event with an id that is already stored, so it folds into what was counted
// instead of being counted again.
import type {
  AgentAuditEntry,
  PlanUsageEvent,
  UsageMetricEvent,
} from '@canopy/protocol/observability';

/**
 * Keeps one usage event per id. The latest timestamp wins and a tie goes to
 * the event added last, so a re-recorded event replaces its earlier copy.
 */
export function upsertUsageEventById(
  eventsById: Map<string, UsageMetricEvent>,
  event: UsageMetricEvent,
): void {
  const previous = eventsById.get(event.id);
  if (!previous || previous.timestamp <= event.timestamp) {
    eventsById.set(event.id, event);
  }
}

function hasCountedPlanUsageEvent(
  entry: AgentAuditEntry,
  eventId: string,
): boolean {
  return entry.planEvents?.eventIds?.includes(eventId) === true;
}

/**
 * Counts a plan lifecycle event on its audit entry and records the event id
 * with the counts, so the entry stays idempotent wherever it is reloaded.
 * Returns false when the event is not counted or was already counted.
 */
export function countPlanUsageEvent(
  entry: AgentAuditEntry,
  event: PlanUsageEvent,
): boolean {
  if (
    event.type === 'plan_updated' ||
    hasCountedPlanUsageEvent(entry, event.id)
  ) {
    return false;
  }
  const prior = entry.planEvents;
  entry.planEvents = {
    created: (prior?.created ?? 0) + (event.type === 'plan_created' ? 1 : 0),
    approved: (prior?.approved ?? 0) + (event.type === 'plan_approved' ? 1 : 0),
    eventIds: [...(prior?.eventIds ?? []), event.id],
  };
  return true;
}
