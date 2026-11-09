import type {
  InterfaceToolDeliveredEvent,
  InterfaceToolSettledEvent,
} from '@canopy/core-runtime/node/client';
import type { AgentObservabilityIngest } from '@canopy/core-runtime/observability';

export type InterfaceToolProvenanceIngest = Pick<
  AgentObservabilityIngest,
  'noteInterfaceToolCallDelivered' | 'recordInterfaceToolCall'
>;

export interface InterfaceToolProvenanceHooks {
  onDelivered(event: InterfaceToolDeliveredEvent): void;
  onSettled(event: InterfaceToolSettledEvent): void;
}

/**
 * CAN-5828: the registry hooks that record which lease answered each call
 * on its turn's audit entry. The ingest loads deferred, so loading starts
 * at once, and a delivery binds its call to the chat's open entry
 * synchronously: a turn that starts later can never receive the binding.
 * A call delivered before the ingest loaded stays unbound, so its
 * settlement is dropped rather than credited to a later turn.
 */
export function createInterfaceToolProvenance(options: {
  load: () => Promise<InterfaceToolProvenanceIngest>;
  onError: (error: unknown, context: string) => void;
}): InterfaceToolProvenanceHooks {
  let loaded: InterfaceToolProvenanceIngest | undefined;
  const ingest = options.load().then((value) => {
    loaded = value;
    return value;
  });
  ingest.catch((error: unknown) =>
    options.onError(error, 'provenance ingest load'),
  );
  return {
    onDelivered: (event): void => {
      if (!loaded) return;
      try {
        loaded.noteInterfaceToolCallDelivered(
          event.scope.workspaceId,
          event.scope.worktreeId,
          event.scope.chatId,
          event.callId,
        );
      } catch (error) {
        options.onError(error, 'provenance binding');
      }
    },
    onSettled: (event): void => {
      void ingest
        .then((value) =>
          value.recordInterfaceToolCall(
            event.scope.workspaceId,
            event.scope.worktreeId,
            event.scope.chatId,
            {
              callId: event.callId,
              toolName: event.toolName,
              leaseId: event.leaseId,
              surface: event.surface,
              interfaceKind: event.interfaceKind,
              ...(event.audience === undefined
                ? {}
                : { audience: event.audience }),
              outcome: event.outcome,
              deliveredAt: new Date(event.deliveredAt).toISOString(),
              settledAt: new Date(event.settledAt).toISOString(),
            },
          ),
        )
        .catch((error: unknown) => options.onError(error, 'provenance record'));
    },
  };
}
