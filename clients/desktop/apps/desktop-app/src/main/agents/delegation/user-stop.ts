import type { DelegationParentContext } from '@canopy/desktop-shared/node/delegation';
import type {
  AgentDelegationResult,
  AgentDelegationSnapshot,
} from '@canopy/protocol/delegation';

/** The broker calls a user stop makes. */
export interface UserStopBroker {
  inspect(
    parent: DelegationParentContext,
    id: string,
  ): AgentDelegationSnapshot | undefined;
  list(
    parent: DelegationParentContext,
    filter: { underDelegationId: string },
  ): readonly AgentDelegationSnapshot[];
  stop(
    parent: DelegationParentContext,
    id: string,
    reason: 'user_cancelled',
    options?: { readonly expectedRunGeneration?: number },
  ): Promise<AgentDelegationResult<AgentDelegationSnapshot>>;
}

/**
 * Stop a delegation and its subtree for the user, retiring their watchers.
 * With `expectedRunGeneration`, a delegation that has moved to another
 * generation is left running and the stop answers success (CAN-4112); the
 * broker stop is bound to that generation too, so a continuation that starts
 * during the stop's waits keeps running (CAN-5867).
 */
export async function stopDelegationForUser(options: {
  broker: UserStopBroker;
  parent: DelegationParentContext;
  delegationId: string;
  expectedRunGeneration?: number;
  retireWatchers: (delegationIds: ReadonlySet<string>) => Promise<void>;
}): Promise<AgentDelegationResult<AgentDelegationSnapshot>> {
  const { broker, parent, delegationId, expectedRunGeneration } = options;
  const moved = (): AgentDelegationSnapshot | undefined => {
    if (expectedRunGeneration === undefined) return undefined;
    const current = broker.inspect(parent, delegationId);
    return current?.runGeneration !== undefined &&
      current.runGeneration !== expectedRunGeneration
      ? current
      : undefined;
  };
  const subtree = (): ReadonlySet<string> =>
    new Set([
      delegationId,
      ...broker
        .list(parent, { underDelegationId: delegationId })
        .map((snapshot) => snapshot.delegationId),
    ]);
  /** Each subtree member's run generation and parent, as the broker reports. */
  const members = (): ReadonlyMap<
    string,
    { readonly runGeneration?: number; readonly parentId?: string }
  > =>
    new Map([
      [
        delegationId,
        { runGeneration: broker.inspect(parent, delegationId)?.runGeneration },
      ],
      ...broker
        .list(parent, { underDelegationId: delegationId })
        .map(
          (
            snapshot,
          ): [string, { runGeneration?: number; parentId?: string }] => [
            snapshot.delegationId,
            {
              runGeneration: snapshot.runGeneration,
              parentId: snapshot.parentDelegationId,
            },
          ],
        ),
    ]);
  const before = moved();
  if (before) return { ok: true, value: before };
  const known = broker.inspect(parent, delegationId) !== undefined;
  // Before the stop, so no task it ends wakes the subtree; after, for any
  // watch registered while it was being stopped.
  if (known) await options.retireWatchers(subtree());
  // No await between this check and the stop, so the generation cannot move.
  const after = moved();
  if (after) return { ok: true, value: after };
  if (expectedRunGeneration === undefined) {
    const result = await broker.stop(
      parent,
      delegationId,
      'user_cancelled',
      {},
    );
    if (result.ok) await options.retireWatchers(subtree());
    return result;
  }
  const stopped = members();
  const result = await broker.stop(parent, delegationId, 'user_cancelled', {
    expectedRunGeneration,
  });
  if (!result.ok) return result;
  // The bound stop leaves running any delegation whose generation moved
  // during it, so only the others lose their watchers (CAN-5867). One that
  // appeared meanwhile follows its nearest ancestor that existed before.
  const current = members();
  const unmoved = (id: string, depth = 0): boolean => {
    const before = stopped.get(id);
    if (before) return before.runGeneration === current.get(id)?.runGeneration;
    const parentId = current.get(id)?.parentId;
    return (
      parentId !== undefined &&
      depth < current.size &&
      unmoved(parentId, depth + 1)
    );
  };
  const settled = new Set(
    Array.from(current.keys()).filter((id) => unmoved(id)),
  );
  if (settled.size > 0) await options.retireWatchers(settled);
  return result;
}
