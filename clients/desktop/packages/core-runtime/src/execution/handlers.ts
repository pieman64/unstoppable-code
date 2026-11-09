import {
  CORE_EXECUTION_LIMITS,
  CoreExecutionItemSchema,
  type CANOPY_STREAM_DEFINITIONS,
  type CanopyQueryHandlerMap,
  type CoreExecutionFamilyStatus,
  type CoreExecutionItem,
  type CoreExecutionStatus,
  type CoreExecutionStatusGetResult,
} from '@canopy/protocol/canopy-core';

import type {
  CanopyDispatcherStreamHandlerMap,
  CanopyHandlerContext,
} from '../runtime/types';
import type { ExecutionAccounting } from './accounting';
import type {
  ExecutionAccountingSnapshot,
  ExecutionFamily,
  ExecutionFamilyStatus,
  ExecutionResourceItem,
} from './types';

type ExecutionQueryHandlers = Pick<
  CanopyQueryHandlerMap<CanopyHandlerContext>,
  'core.execution.status.get'
>;
type ExecutionStreamHandlers = Pick<
  CanopyDispatcherStreamHandlerMap<typeof CANOPY_STREAM_DEFINITIONS>,
  'core.execution.status.events'
>;

export interface CoreExecutionHandlers {
  queries: ExecutionQueryHandlers;
  streams: ExecutionStreamHandlers;
}

/**
 * What a host adds to its own accounting before clients read it, such as
 * work another execution host on the machine reports.
 */
export interface ExecutionStatusView<TMetadata extends { type: string }> {
  project(
    snapshot: ExecutionAccountingSnapshot<TMetadata>,
  ): ExecutionAccountingSnapshot<TMetadata>;
  /** Notes each change to what `project` adds between samples. */
  subscribe(onChange: () => void): () => void;
}

export interface CoreExecutionHandlerOptions<
  TMetadata extends { type: string },
> {
  /**
   * Sees the host snapshot each `core.execution.status.get` projects, before
   * the view, so an in-process host can keep its own metadata for a
   * compatibility payload.
   */
  readonly observeRead?: (
    snapshot: ExecutionAccountingSnapshot<TMetadata>,
  ) => void;
  readonly view?: ExecutionStatusView<TMetadata>;
}

/** Host strings such as process command lines can exceed the wire bounds. */
function bounded(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

// FNV-1a, twice with different offsets: a stable suffix that keeps two long
// IDs sharing a prefix apart without a platform hash.
function fingerprint(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x01000193;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x811c9dc5) >>> 0;
  }
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

/** Composite host IDs can exceed the wire bound; parent links map the same way. */
function boundedId(value: string): string {
  if (value.length <= CORE_EXECUTION_LIMITS.id) return value;
  const suffix = `~${fingerprint(value)}`;
  return `${value.slice(0, CORE_EXECUTION_LIMITS.id - suffix.length)}${suffix}`;
}

/** Host metrics are finite and non-negative on the wire. */
function metric(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function count(value: number): number {
  return Math.round(metric(value));
}

function isWireTimestamp(value: string): boolean {
  return CoreExecutionItemSchema.shape.startedAt.safeParse(value).success;
}

function flattenItems<TMetadata extends { type: string }>(
  items: readonly ExecutionResourceItem<TMetadata>[],
  parentId: string | undefined,
  into: CoreExecutionItem[],
): CoreExecutionItem[] {
  for (const item of items) {
    into.push({
      id: boundedId(item.id),
      ...(parentId !== undefined ? { parentId: boundedId(parentId) } : {}),
      kind: item.kind,
      groupId: item.groupId,
      label: bounded(item.label, CORE_EXECUTION_LIMITS.label),
      ...(item.pid !== undefined ? { pid: item.pid } : {}),
      ...(item.ppid !== undefined ? { ppid: item.ppid } : {}),
      ...(item.processGroupId !== undefined
        ? { processGroupId: item.processGroupId }
        : {}),
      cpuPercent: metric(item.cpuPercent),
      memoryRssBytes: metric(item.memoryRssBytes),
      processCount: count(item.processCount),
      ...(item.startedAt !== undefined && isWireTimestamp(item.startedAt)
        ? { startedAt: item.startedAt }
        : {}),
      status: item.status,
      ...(item.metadata?.type
        ? {
            metadataType: bounded(
              item.metadata.type,
              CORE_EXECUTION_LIMITS.metadataType,
            ),
          }
        : {}),
    });
    flattenItems(item.children ?? [], item.id, into);
  }
  return into;
}

function familyStatusOf(
  status: ExecutionFamilyStatus,
): CoreExecutionFamilyStatus {
  return {
    active: count(status.active),
    pending: count(status.pending),
    maxActive: status.maxActive === null ? null : count(status.maxActive),
    blocked: status.blocked,
  };
}

/**
 * The portable execution status: the sample's process tree, flattened with
 * parent links, and family counts. Host metadata stays with the host; only
 * its kind crosses the wire.
 */
export function coreExecutionStatus<TMetadata extends { type: string }>(
  snapshot: ExecutionAccountingSnapshot<TMetadata>,
  families: Readonly<Record<ExecutionFamily, ExecutionFamilyStatus>>,
  memoryGuardBlocked: boolean,
): CoreExecutionStatus {
  return {
    sampledAt: snapshot.sampledAt,
    cpuPercent: metric(snapshot.cpuPercent),
    memoryRssBytes: metric(snapshot.memoryRssBytes),
    processCount: count(snapshot.processCount),
    pressure: {
      level: snapshot.pressure.level,
      reasons: snapshot.pressure.reasons.map((reason) =>
        bounded(reason, CORE_EXECUTION_LIMITS.reason),
      ),
      warningMemoryBytes: metric(snapshot.pressure.warningMemoryBytes),
      criticalMemoryBytes: metric(snapshot.pressure.criticalMemoryBytes),
    },
    groups: snapshot.groups.map((group) => ({
      id: group.id,
      label: bounded(group.label, CORE_EXECUTION_LIMITS.label),
      cpuPercent: metric(group.cpuPercent),
      memoryRssBytes: metric(group.memoryRssBytes),
      processCount: count(group.processCount),
      items: flattenItems(group.items, undefined, []),
    })),
    families: {
      pipeline: familyStatusOf(families.pipeline),
      script: familyStatusOf(families.script),
      terminal: familyStatusOf(families.terminal),
      codeGraph: familyStatusOf(families.codeGraph),
    },
    memoryGuardBlocked,
    ...(snapshot.error !== undefined
      ? { error: bounded(snapshot.error, CORE_EXECUTION_LIMITS.error) }
      : {}),
  };
}

/**
 * `core.execution.*` over one host's execution accounting. Every client of
 * that host reads the same accounting, through the host's view when it has
 * one: a read returns the last sample with live family counts, sampling
 * again first when processes were registered or unregistered since, and the
 * events stream sends the current status on open and then each sample,
 * whoever asked for it, and each change the view notes. Closing a stream
 * only unsubscribes; it never releases work.
 */
export function createCoreExecutionHandlers<TMetadata extends { type: string }>(
  accounting: ExecutionAccounting<TMetadata>,
  options: CoreExecutionHandlerOptions<TMetadata> = {},
): CoreExecutionHandlers {
  const view = (
    snapshot: ExecutionAccountingSnapshot<TMetadata>,
  ): ExecutionAccountingSnapshot<TMetadata> =>
    options.view ? options.view.project(snapshot) : snapshot;
  return {
    queries: {
      'core.execution.status.get':
        async (): Promise<CoreExecutionStatusGetResult> => {
          const snapshot = await accounting.currentSnapshot();
          options.observeRead?.(snapshot);
          return {
            status: coreExecutionStatus(
              view(snapshot),
              accounting.familyStatus(),
              accounting.isMemoryGuardBlocked(),
            ),
          };
        },
    },
    streams: {
      'core.execution.status.events': (
        _params,
        _context,
        sink,
      ): Promise<(() => void) | void> => {
        const opened = sink.emit({
          status: coreExecutionStatus(
            view(accounting.getSnapshot()),
            accounting.familyStatus(),
            accounting.isMemoryGuardBlocked(),
          ),
        });
        if (opened === null) return Promise.resolve();
        let unsubscribeSamples = (): void => undefined;
        let unsubscribeView = (): void => undefined;
        const unsubscribe = (): void => {
          unsubscribeSamples();
          unsubscribeView();
        };
        const send = (
          snapshot: ExecutionAccountingSnapshot<TMetadata>,
          live = false,
        ): void => {
          const status = coreExecutionStatus(
            view(snapshot),
            live ? accounting.familyStatus() : snapshot.families,
            live
              ? accounting.isMemoryGuardBlocked()
              : snapshot.memoryGuardBlocked,
          );
          // The sink refuses items once the stream has ended, including when
          // a slow client overflows its buffer.
          if (sink.emit({ status }) === null) unsubscribe();
        };
        unsubscribeSamples = accounting.subscribe(send);
        if (options.view)
          // A view change has no new sample; the guard may read the view too.
          unsubscribeView = options.view.subscribe((): void =>
            send(accounting.getSnapshot(), true),
          );
        return Promise.resolve(unsubscribe);
      },
    },
  };
}
