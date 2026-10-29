import type {
  CanopyEvent,
  CanopySchemaInput,
  CanopySchemaOutput,
  CanopyStreamCursor,
  CanopyWorkspaceScope,
  CoreEventsAckParamsSchema,
  CoreEventsAckResultSchema,
  CoreEventsSubscribeEndSchema,
  CoreEventsSubscribeParamsSchema,
} from '@canopy/protocol/canopy-core';
import type {
  CanopyClientInstructionOptions,
  CanopyClientStreamFrame,
  CanopyClientStreamHandle,
  CanopyClientStreamOptions,
  CanopyEffectiveManifest,
  CanopyRuntimeIdentity,
} from '../types';

export type CanopyEventFrame = CanopyClientStreamFrame<
  CanopyEvent,
  CanopySchemaOutput<typeof CoreEventsSubscribeEndSchema>
>;
export type CanopyEventHandle = CanopyClientStreamHandle<
  CanopyEvent,
  CanopySchemaOutput<typeof CoreEventsSubscribeEndSchema>
>;

export interface CanopyEventsConnection {
  readonly identity: CanopyRuntimeIdentity;
  readonly manifest: CanopyEffectiveManifest;
  readonly signal: AbortSignal;
  openStream(
    name: 'core.events.subscribe',
    params: CanopySchemaInput<typeof CoreEventsSubscribeParamsSchema>,
    options?: CanopyClientStreamOptions<CanopyEventFrame>,
  ): Promise<CanopyEventHandle>;
  instruction(
    name: 'core.events.ack',
    params: CanopySchemaInput<typeof CoreEventsAckParamsSchema>,
    options?: CanopyClientInstructionOptions,
  ): Promise<CanopySchemaOutput<typeof CoreEventsAckResultSchema>>;
}

export type CanopyEventPriority = 'lifecycle' | 'output';
export type CanopyEventDelivery =
  | { kind: 'event'; event: CanopyEvent; priority: CanopyEventPriority }
  | {
      kind: 'gap';
      from: CanopyStreamCursor;
      to: CanopyStreamCursor;
      dropped: number;
    };

export interface CanopyEventContext {
  authorityId: string;
  daemonEpoch: string;
}

export interface CanopyEventCursorStore {
  load(
    authorityId: string,
    subscriptionKey: string,
  ): Promise<CanopyStreamCursor | null>;
  save(
    authorityId: string,
    subscriptionKey: string,
    cursor: CanopyStreamCursor | null,
  ): Promise<void>;
}

export interface CanopyEventSubscriptionOptions {
  families: readonly string[];
  scope?: CanopyWorkspaceScope;
  /** Resolve only after the event or output-gap recovery is durably handled. */
  handle(
    delivery: CanopyEventDelivery,
    context: CanopyEventContext,
  ): Promise<void>;
  /** Re-query canonical state; return its checkpoint, or null for retained replay. */
  snapshot(
    context: CanopyEventContext & {
      reason: 'initial' | 'snapshot_required' | 'epoch_changed';
    },
  ): Promise<CanopyStreamCursor | null>;
  /** Unclassified events are lifecycle events and are never coalesced. */
  classify?(event: CanopyEvent): CanopyEventPriority;
  store?: CanopyEventCursorStore;
  maxBufferedOutput?: number;
  maxBufferedOutputBytes?: number;
  /** Bounds all unacknowledged entries, including ones handled out of order. */
  maxPendingEvents?: number;
  maxSnapshotAttempts?: number;
  signal?: AbortSignal;
}

export interface CanopyEventSubscription {
  /** Reattach a newly connected client; replaces this authority's previous stream. */
  attach(client: CanopyEventsConnection): Promise<void>;
  cursor(authorityId: string): CanopyStreamCursor | null;
  state(authorityId: string): 'detached' | 'rehydrating' | 'open' | 'failed';
  error(authorityId: string): Error | null;
  close(): Promise<void>;
}
