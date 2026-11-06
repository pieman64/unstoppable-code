import { readMcpActivationRecord } from '@canopy/protocol/mcp-servers';
import {
  CANOPY_STREAM_DEFINITIONS,
  type CanopyStreamCursor,
  type CanopyStreamHandlerMap,
} from '@canopy/protocol/canopy-core';
import type {
  ChatStateChangedEvent,
  ChatStateCommandPort,
  ChatTabMetadataPatch,
  PersistedChatMessage,
  PersistedChatBlock,
} from '@canopy/desktop-shared/types';
import type { CanopyHandlerContext } from '@canopy/core-runtime';
import { projectChatRuntime } from '../services/chat-state-projection';

const LIVE_WINDOW = 128;
const MAX_CURSOR_ALIASES = 128;
type EventsHandler = Pick<
  CanopyStreamHandlerMap<CanopyHandlerContext>,
  'core.chat.events'
>;

function withoutField<T extends object, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> {
  const portable = { ...value };
  Reflect.deleteProperty(portable, key);
  return portable;
}

function projectBlock(block: PersistedChatBlock): object | null {
  if (block.type === 'mcp_activation') {
    const record = readMcpActivationRecord(block.record);
    return record ? { type: 'mcp_activation', record } : null;
  }
  if (block.type === 'image') return withoutField(block, 'path');
  if (block.type === 'file_references')
    return {
      ...block,
      references: block.references.map((reference) =>
        withoutField(withoutField(reference, 'absolutePath'), 'displayPath'),
      ),
    };
  if (block.type === 'compaction_info')
    return withoutField(block, 'transcriptPath');
  if (block.type === 'revert_info')
    return withoutField(block, 'attachmentPath');
  return block;
}

// Allowlist: host-neutral scalar tab metadata. Other tab fields can carry host
// paths or host-only state (approval rules, stale-session file references).
const PORTABLE_TAB_FIELDS = [
  'title',
  'customTitle',
  'description',
  'fileViewMode',
  'pinned',
  'planMode',
  'approvalMode',
  'thinkingLevel',
  'model',
  'modelSelectionMode',
  'modelExplicitlyChosen',
  'providerType',
  'codexFastModeEnabled',
  'modelConfig',
  'interfaceMode',
  'unread',
  'hasOutstandingProposal',
  'latestRevisionNumber',
  'proposalMode',
  'trackedPlanId',
  'trackedPlanReviewStatus',
  'autoArchive',
  'lastAcceptedUserMessageId',
] as const satisfies readonly (keyof ChatTabMetadataPatch)[];

function pickPortableTabFields(
  value: Partial<Record<(typeof PORTABLE_TAB_FIELDS)[number], unknown>>,
): Record<string, unknown> {
  const portable: Record<string, unknown> = {};
  for (const key of PORTABLE_TAB_FIELDS)
    if (Object.prototype.hasOwnProperty.call(value, key))
      portable[key] = value[key];
  return portable;
}

function projectMessage(
  message: PersistedChatMessage,
): Omit<PersistedChatMessage, 'blocks'> & { blocks: object[] } {
  const projected = { ...message };
  delete projected.attachmentPaths;
  delete projected.attachmentPromptContexts;
  // Hidden messages are host-only orchestration input; keep identity, drop content.
  if (message.hidden) return { ...projected, blocks: [] };
  return {
    ...projected,
    blocks: message.blocks.flatMap((block) => {
      const portable = projectBlock(block);
      return portable ? [portable] : [];
    }),
  };
}

function projectEvent(event: ChatStateChangedEvent): object {
  return {
    ...event,
    changes: event.changes.map((change) => {
      // Already portable; no host-path projection or synthetic message.
      if (change.type === 'delegation.card_state_updated') return change;
      if (change.type === 'tab.upserted')
        return {
          ...change,
          tab: {
            ...pickPortableTabFields(change.tab),
            id: change.tab.id,
            title: change.tab.title,
            createdAt: change.tab.createdAt,
            ...(change.tab.kind === undefined ? {} : { kind: change.tab.kind }),
            messages: change.tab.messages.map(projectMessage),
          },
        };
      if (change.type === 'tab.metadata_patched')
        return { ...change, patch: pickPortableTabFields(change.patch) };
      if (change.type === 'message.upserted')
        return { ...change, message: projectMessage(change.message) };
      if (change.type === 'messages.replaced')
        return {
          ...change,
          messages: change.messages.map(projectMessage),
        };
      if (change.type === 'runtime.patched') {
        const runtime = projectChatRuntime(change.runtime);
        delete runtime.queuedMessages;
        delete runtime.turn;
        return { ...change, runtime };
      }
      return change;
    }),
  };
}

export function createCoreChatEventsAdapter(
  getPort: () => ChatStateCommandPort | null,
  // Runs before emit so synchronous (onFrame) consumers can resolve the event;
  // the returned callback receives the assigned cursor, or null if not emitted.
  captureEvent: (
    event: ChatStateChangedEvent,
    context: CanopyHandlerContext,
  ) => ((cursor: CanopyStreamCursor | null) => void) | void,
): { handlers: EventsHandler; closeLegacy: () => void } {
  const history: Array<{
    cursors: Array<{
      daemonEpoch: string;
      sequence: number;
      scopeKey: string;
    }>;
    event: ChatStateChangedEvent;
  }> = [];
  let active = 0;
  let legacyActiveUnsubscribe: (() => void) | undefined;
  let legacyStrandedUnsubscribe: (() => void) | undefined;
  let legacyClosed = false;
  const legacyBacklog: ChatStateChangedEvent[] = [];
  return {
    closeLegacy: (): void => {
      legacyClosed = true;
      legacyActiveUnsubscribe?.();
      legacyStrandedUnsubscribe?.();
      legacyActiveUnsubscribe = undefined;
      legacyStrandedUnsubscribe = undefined;
      legacyBacklog.length = 0;
      if (active === 0) history.length = 0;
    },
    handlers: {
      'core.chat.events': (params, context, sink): Promise<() => void> => {
        const port = getPort();
        if (!port) throw new Error('Chat state service is unavailable.');
        const legacy =
          context.caller.clientInstanceId === 'electron-main-chat-push';
        const scopeKey =
          params.scope === 'all'
            ? 'all'
            : JSON.stringify([params.scope.projectId, params.scope.worktreeId]);
        const matchesScope = (event: ChatStateChangedEvent): boolean =>
          params.scope === 'all' ||
          (event.projectId === params.scope.projectId &&
            event.worktreeId === params.scope.worktreeId);
        if (legacy) {
          legacyStrandedUnsubscribe?.();
          legacyStrandedUnsubscribe = undefined;
        }
        active += 1;
        let replaying = true;
        const pending: ChatStateChangedEvent[] = [];
        const deliver = (
          event: ChatStateChangedEvent,
        ): CanopyStreamCursor | null => {
          const item = CANOPY_STREAM_DEFINITIONS['core.chat.events'].item.parse(
            projectEvent(event),
          );
          const settleCapture = captureEvent(event, context);
          const cursor = sink.emit(item, (assignedCursor) => {
            settleCapture?.(assignedCursor);
            const existing = history.find((entry) => entry.event === event);
            if (existing) {
              existing.cursors.push({ ...assignedCursor, scopeKey });
              if (existing.cursors.length > MAX_CURSOR_ALIASES)
                existing.cursors.shift();
            } else {
              history.push({
                cursors: [{ ...assignedCursor, scopeKey }],
                event,
              });
              if (history.length > LIVE_WINDOW) history.shift();
            }
          });
          if (!cursor) settleCapture?.(null);
          return cursor;
        };
        const unsubscribe = port.subscribe((event) => {
          if (!history.some((entry) => entry.event === event)) {
            history.push({ cursors: [], event });
            if (history.length > LIVE_WINDOW) history.shift();
          }
          if (!matchesScope(event)) return;
          if (replaying) pending.push(event);
          else if (deliver(event) === null && legacy) legacyBacklog.push(event);
        });
        if (legacy) legacyActiveUnsubscribe = unsubscribe;
        const cursor = params.cursor;
        if (cursor) {
          const index = history.findIndex((entry) =>
            entry.cursors.some(
              (issued) =>
                issued.daemonEpoch === cursor.daemonEpoch &&
                issued.sequence === cursor.sequence &&
                issued.scopeKey === scopeKey,
            ),
          );
          if (index < 0) {
            sink.end('error', {
              kind: 'failed_precondition',
              code: 'core.chat.snapshotRequired',
              message:
                'Read a chat snapshot before reopening the event stream.',
              retry: {
                kind: 'after_refresh',
                resource: 'core.chat.snapshot.get',
              },
            });
          } else {
            for (const entry of history.slice(index + 1))
              if (matchesScope(entry.event)) deliver(entry.event);
          }
        }
        replaying = false;
        const backlog = legacy ? legacyBacklog.splice(0) : [];
        for (const event of [...backlog, ...pending]) {
          if (deliver(event) === null && legacy) legacyBacklog.push(event);
        }
        return Promise.resolve(() => {
          if (legacy && !legacyClosed && !context.signal.aborted) {
            legacyActiveUnsubscribe = undefined;
            legacyStrandedUnsubscribe = unsubscribe;
          } else unsubscribe();
          active -= 1;
          if (active === 0 && !legacyStrandedUnsubscribe) history.length = 0;
        });
      },
    },
  };
}
