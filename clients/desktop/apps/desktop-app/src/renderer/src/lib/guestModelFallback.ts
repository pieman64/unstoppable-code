import type { ChatModel } from '@canopy/desktop-shared/types';
import {
  resolveGatewayModelEntry,
  resolveModelIdForGatewayId,
} from '@canopy/desktop-shared/lib/gateway-model-availability';
import { resolveGuestAllowedModelForGatewayId } from '@canopy/protocol/models';
import type { GuestModelFallbackAccess } from '@canopy/ui-shared';
import type { ModelRecovery, VisibleModelRowGate } from './modelPickerRowGate';

/**
 * CAN-4703 — the guest model the gate offers instead of the one it refused.
 *
 * Snapshotted when the gated row is clicked, so the dialog never swaps the
 * model it names while it is open. Holds identities only: the commit and
 * focus bindings stay with the recovery session that owns this snapshot.
 */
export interface GuestModelFallback {
  /** What committing the fallback selects (the row's selection identity). */
  readonly model: ChatModel;
  /** Canonical gateway identity, used to find the same route again. */
  readonly gatewayId: string;
  /** Allowlist label, shown in the gate copy. */
  readonly label: string;
  /**
   * `now` — the row was available at the click. `daily-credits` (CAN-5211) —
   * the row was recoverable by credits alone: a candidate only, since credits
   * could fund it but nothing here proves the guest can turn them on. The
   * recovery modal decides that from its own account read.
   */
  readonly access: GuestModelFallbackAccess;
}

/** The parts of a picker row the fallback reads. */
export interface GuestFallbackRow {
  readonly model: ChatModel;
  readonly runtimeModel: ChatModel;
  readonly selectionModel?: ChatModel;
  readonly gate: VisibleModelRowGate;
}

function rowSelection(row: GuestFallbackRow): ChatModel {
  return row.selectionModel ?? row.runtimeModel;
}

function gatewayIdOf(model: ChatModel | undefined): string | undefined {
  return resolveGatewayModelEntry(model)?.gatewayId.trim().toLowerCase();
}

/**
 * The single row that carries the candidate's canonical gateway route, or
 * `undefined` when none does or the listed rows disagree on what it selects.
 */
function findCandidateRow(
  gatewayId: string,
  rows: readonly GuestFallbackRow[],
): GuestFallbackRow | undefined {
  const canonicalModel = resolveModelIdForGatewayId(gatewayId);
  if (canonicalModel === undefined) return undefined;
  const matches = rows.filter(
    (row) =>
      row.model === canonicalModel || row.runtimeModel === canonicalModel,
  );
  // Multiple routes can share a selection while disagreeing on entitlement
  // or execution host. Never choose a gate by collection order.
  return matches.length === 1 ? matches[0] : undefined;
}

/** How a candidate row can be reached, or `undefined` when it cannot. */
function fallbackAccessOf(
  gate: VisibleModelRowGate,
): GuestModelFallbackAccess | undefined {
  if (gate.kind === 'available') return 'now';
  if (
    gate.kind === 'recoverable' &&
    (gate.recovery.kind === 'needs-credits' ||
      gate.recovery.kind === 'needs-billing-source')
  )
    return 'daily-credits';
  return undefined;
}

/**
 * The fallback to offer for a gated model, or `undefined` when the host has no
 * honest one-click alternative.
 *
 * Same vendor, first allowlist entry (see
 * `resolveGuestAllowedModelForGatewayId`). Offered only when that entry maps
 * to exactly one listed row that is not what the chat already uses, and that
 * row is `available` right now or recoverable by credits alone (CAN-5211).
 * Any other recovery, or a blocked preferred entry, offers nothing: later
 * allowlist entries are never searched.
 */
export function resolveGuestModelFallback({
  gatedModel,
  currentModel,
  rows,
}: {
  readonly gatedModel: ChatModel;
  readonly currentModel: ChatModel | undefined;
  readonly rows: readonly GuestFallbackRow[];
}): GuestModelFallback | undefined {
  const gatedGatewayId = gatewayIdOf(gatedModel);
  if (gatedGatewayId === undefined) return undefined;
  const candidate = resolveGuestAllowedModelForGatewayId(gatedGatewayId);
  if (candidate === undefined || candidate.gatewayId === gatedGatewayId)
    return undefined;

  const row = findCandidateRow(candidate.gatewayId, rows);
  if (row === undefined) return undefined;
  const access = fallbackAccessOf(row.gate);
  if (access === undefined) return undefined;

  const model = rowSelection(row);
  if (
    currentModel !== undefined &&
    (currentModel === model ||
      currentModel === row.model ||
      currentModel === row.runtimeModel ||
      gatewayIdOf(currentModel) === candidate.gatewayId)
  )
    return undefined;

  return {
    model,
    gatewayId: candidate.gatewayId,
    label: candidate.label,
    access,
  };
}

/** What the current rows say about an offered fallback at activation time. */
export type GuestModelFallbackCheck =
  | { readonly kind: 'available'; readonly model: ChatModel }
  | {
      readonly kind: 'recoverable';
      readonly model: ChatModel;
      readonly recovery: ModelRecovery;
    }
  | { readonly kind: 'blocked'; readonly reason?: string };

/**
 * Re-check a snapshotted fallback against the rows as they are now. The row
 * gate is never bypassed: a row that became recoverable hands over to its own
 * recovery, and one that vanished, was disabled, or now selects a different
 * identity is blocked.
 */
export function revalidateGuestModelFallback(
  fallback: GuestModelFallback,
  rows: readonly GuestFallbackRow[],
): GuestModelFallbackCheck {
  const row = findCandidateRow(fallback.gatewayId, rows);
  if (row === undefined) return { kind: 'blocked' };
  if (rowSelection(row) !== fallback.model) return { kind: 'blocked' };
  if (row.gate.kind === 'recoverable')
    return {
      kind: 'recoverable',
      model: row.runtimeModel,
      recovery: row.gate.recovery,
    };
  if (row.gate.kind === 'hard-disabled')
    return { kind: 'blocked', reason: row.gate.reason };
  return { kind: 'available', model: fallback.model };
}
