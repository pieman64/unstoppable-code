import type { LegacyDelegateWatcher } from '../agents/delegation/notice-migration';

/** Migration evidence only. Never a supported watcher or a delivery input. */
export interface LegacyDelegateWatcherRow {
  readonly id: string;
  readonly projectId: string;
  readonly worktreeId: string;
  readonly status: string;
  readonly targets: LegacyDelegateWatcher['targets'];
  readonly pendingDelivery?: { readonly eventId: string };
  readonly pendingLocalDelivery?: { readonly deliveryId: string };
  readonly chatDeliveryId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Decode only the facts notice migration needs; callers round-trip the raw row. */
export function decodeLegacyDelegateWatcher(
  raw: unknown,
): LegacyDelegateWatcherRow | undefined {
  if (
    !isRecord(raw) ||
    raw.trigger !== 'managed_delegation_completion' ||
    !isRecord(raw.target) ||
    raw.target.kind !== 'managed_delegation' ||
    !isRecord(raw.runtimeState) ||
    raw.runtimeState.kind !== 'managed_delegation' ||
    !nonBlank(raw.id) ||
    !nonBlank(raw.target.projectId) ||
    !nonBlank(raw.target.worktreeId) ||
    !nonBlank(raw.status) ||
    !Array.isArray(raw.runtimeState.targets)
  )
    return undefined;
  const targets: Array<LegacyDelegateWatcher['targets'][number]> = [];
  for (const target of raw.runtimeState.targets) {
    if (
      !isRecord(target) ||
      !nonBlank(target.delegationId) ||
      !positiveInteger(target.runGeneration) ||
      !(target.resultIndex === null || positiveInteger(target.resultIndex))
    )
      return undefined;
    targets.push({
      delegationId: target.delegationId,
      runGeneration: target.runGeneration,
      resultIndex: target.resultIndex,
    });
  }
  const pending = raw.runtimeState.pendingDelivery;
  const local = raw.pendingLocalDelivery;
  return {
    id: raw.id,
    projectId: raw.target.projectId,
    worktreeId: raw.target.worktreeId,
    status: raw.status,
    targets,
    ...(isRecord(pending) && nonBlank(pending.eventId)
      ? { pendingDelivery: { eventId: pending.eventId } }
      : {}),
    ...(isRecord(local) && nonBlank(local.deliveryId)
      ? { pendingLocalDelivery: { deliveryId: local.deliveryId } }
      : {}),
    ...(nonBlank(raw.chatDeliveryId)
      ? { chatDeliveryId: raw.chatDeliveryId }
      : {}),
  };
}
