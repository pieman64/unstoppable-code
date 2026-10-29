/**
 * Builder helpers for the per-feature `portal.*.event` envelopes
 * (transport plan Phase T2). The script, hook, and pipeline adapters all
 * publish the same discriminated `{ kind, entity }` / `{ kind, entityType,
 * localId, parentLocalId? }` payload — these helpers funnel the boilerplate
 * through {@link createPortalEvent} so adapters cannot accidentally:
 *
 * - omit `commandId` correlation,
 * - emit a stray `target` / `scope` field the server's `applyFeatureEntityEvent`
 *   does not consume (state-cache-service.ts:494), or
 * - drop `parentLocalId`, which is what the server's projection layer uses
 *   to roll runs up to their owning worktree.
 *
 * The helpers return a fully-formed {@link PortalEventEnvelope}; adapters are
 * expected to hand the result straight to `context.enqueueEvent(...)`.
 */
import type {
  PortalEntityEnvelope,
  PortalEntityType,
  PortalEventEnvelope,
  PortalHookEventPayload,
  PortalPipelineEventPayload,
  PortalPlanEventPayload,
  PortalScriptEventPayload,
} from '@canopy/desktop-shared/types';
import { createPortalEvent } from './portal-event-bus';

/**
 * Closed set of feature-event envelope types this module will mint.
 *
 * Transport plan §2 — `portal.plan.event` joins script / hook / pipeline as a
 * per-feature event channel so plan upserts/removals can travel over the same
 * helper-funneled path. General `portal.state.*` envelopes stay routed
 * through the snapshot/delta builders, which carry their own scope discipline.
 */
export type PortalFeatureEventType =
  | 'portal.script.event'
  | 'portal.hook.event'
  | 'portal.plan.event'
  | 'portal.pipeline.event';

/**
 * Discriminated union of the per-feature payloads this module emits. Pinned
 * here so callers can rely on `type ↔ payload` parity at compile time even
 * though the underlying `createPortalEvent` accepts `unknown`.
 */
export type PortalFeatureEventPayload =
  | PortalScriptEventPayload
  | PortalHookEventPayload
  | PortalPlanEventPayload
  | PortalPipelineEventPayload;

/**
 * Build a `portal.{script,hook,pipeline}.event` envelope carrying an
 * `{ kind: 'upsert', entity }` payload.
 *
 * The caller is responsible for assembling the {@link PortalEntityEnvelope}
 * (its `entityType` / `localId` / `parentLocalId` / `payload`); this helper
 * does not synthesise routing fields or coerce an entity shape — preserving
 * the contract that the server's `applyFeatureEntityEvent` only consumes
 * `kind` plus `entity` on upsert (state-cache-service.ts:494).
 */
export function createFeatureUpsertEvent(input: {
  type: PortalFeatureEventType;
  commandId?: string;
  entity: PortalEntityEnvelope;
}): PortalEventEnvelope<PortalFeatureEventPayload> {
  const payload: PortalFeatureEventPayload = {
    kind: 'upsert',
    entity: input.entity,
  };
  return createPortalEvent(
    input.type,
    payload,
    input.commandId ? { commandId: input.commandId } : {},
  ) as PortalEventEnvelope<PortalFeatureEventPayload>;
}

/**
 * Build a `portal.{script,hook,pipeline}.event` envelope carrying an
 * `{ kind: 'remove', entityType, localId, parentLocalId? }` payload.
 *
 * `parentLocalId` is forwarded so the server's projection layer can scope a
 * cascading remove (e.g. dropping all runs of a closed worktree) without
 * having to enumerate them client-side.
 */
export function createFeatureRemoveEvent(input: {
  type: PortalFeatureEventType;
  commandId?: string;
  entityType: PortalEntityType;
  localId: string;
  parentLocalId?: string;
}): PortalEventEnvelope<PortalFeatureEventPayload> {
  const payload: PortalFeatureEventPayload = {
    kind: 'remove',
    entityType: input.entityType,
    localId: input.localId,
    ...(input.parentLocalId ? { parentLocalId: input.parentLocalId } : {}),
  };
  return createPortalEvent(
    input.type,
    payload,
    input.commandId ? { commandId: input.commandId } : {},
  ) as PortalEventEnvelope<PortalFeatureEventPayload>;
}
