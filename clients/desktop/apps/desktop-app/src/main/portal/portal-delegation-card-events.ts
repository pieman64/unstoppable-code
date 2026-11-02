import { randomUUID } from 'node:crypto';
import {
  delegationBlockId,
  overlayStreamBackedDelegationCard,
} from '@canopy/agent-transcript';
import {
  isRecord,
  projectPersistedChatTranscript,
} from '@canopy/desktop-shared/portal/persisted-chat-projection';
import type {
  ChatStateChangedEvent,
  ChatStateChange,
  PortalEventEnvelope,
} from '@canopy/desktop-shared/types';
import type { ChatStateService } from '../services/chat-state-service';
import type { ChatScopeKey } from '../services/chat-state-contracts';

export interface PortalCardOwner {
  scope: ChatScopeKey;
  source: {
    scope: 'worktree' | 'standalone' | 'app_advisor';
    workspaceLocalId?: string;
    worktreeLocalId?: string;
    projectLocalId?: string;
    projectId?: string;
    workEntryId?: string;
  };
}
export interface PortalDelegationCardPort extends Pick<
  ChatStateService,
  'subscribe' | 'generation' | 'readStoredParentMessage'
> {
  resolveOwner(scope: ChatScopeKey): Promise<PortalCardOwner | undefined>;
}
export interface PortalCardEventAdapter {
  dispose(): void;
  stats(): {
    pending: number;
    active: number;
    dropped: number;
    retired: number;
  };
}
type CardChange = Extract<
  ChatStateChange,
  { type: 'delegation.card_state_updated' }
>;
interface Work {
  scope: ChatScopeKey;
  change: CardChange;
  revision: number;
  occurredAt: string;
  key: string;
  family: string;
  anchor: string;
  waiting: boolean;
  wakeRevision: number;
  token: number;
}
interface Frontier {
  generation: number;
  cardRevision: number;
  streamRevision: number;
  revision: number;
  key: string;
  token: number;
}
const MAX_PENDING = 64;
const MAX_LOOKUPS = 2;
const MAX_RETIRED = 256;
export const PORTAL_CARD_EVENT_MAX_BYTES = 256 * 1024;
function familyKey(
  scope: ChatScopeKey,
  chatId: string,
  delegationId: string,
): string {
  return JSON.stringify([
    scope.projectId,
    scope.worktreeId,
    chatId,
    delegationId,
  ]);
}
function safeRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** A session-owned, read-only compatibility projection. Commit listeners only queue work. */
export function subscribePortalDelegationCardEvents(
  port: PortalDelegationCardPort,
  sink: (event: PortalEventEnvelope) => void,
  isCurrent: () => boolean,
): PortalCardEventAdapter {
  const pending = new Map<string, Work>();
  // Includes completed/retired runs, preventing delayed generation and token rollback.
  const highest = new Map<string, Frontier>();
  let nextToken = 0;
  const running = new Set<string>();
  let disposed = false;
  let scheduled = false;
  let active = 0;
  let dropped = 0;
  function current(work: Work): boolean {
    return (
      !disposed &&
      isCurrent() &&
      pending.get(work.key) === work &&
      highest.get(work.family)?.token === work.token
    );
  }
  function prune(): void {
    for (const [family, work] of Array.from(highest.entries())) {
      if (highest.size <= MAX_RETIRED) break;
      if (!pending.has(work.key) && !running.has(work.key))
        highest.delete(family);
    }
  }
  function schedule(): void {
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      pump();
    });
  }
  async function reconcile(work: Work): Promise<void> {
    const owner = await port.resolveOwner(work.scope);
    if (!current(work)) return;
    if (!owner) {
      pending.delete(work.key);
      return;
    }
    const change = work.change;
    const generation = await port.generation(owner.scope, {
      chatId: change.chatId,
      delegationId: change.delegationId,
      runGeneration: change.runGeneration,
    });
    if (!current(work)) return;
    const entry = generation?.entry;
    if (
      !entry ||
      entry.store !== 'stream' ||
      entry.chatId !== change.chatId ||
      entry.delegationId !== change.delegationId ||
      entry.runGeneration !== change.runGeneration ||
      (generation?.stream?.cardState?.version === 2 &&
        generation.stream.cardState.cardRevision > change.cardRevision)
    ) {
      pending.delete(work.key);
      return;
    }
    work.anchor =
      entry.origin.anchorMessageId ??
      delegationBlockId(change.delegationId, change.runGeneration);
    const wakeRevision = work.wakeRevision;
    const row = await port.readStoredParentMessage(
      owner.scope,
      change.chatId,
      work.anchor,
    );
    if (!current(work)) return;
    if (!row) {
      work.waiting = wakeRevision === work.wakeRevision;
      return;
    }
    if (row.id !== work.anchor) {
      pending.delete(work.key);
      return;
    }
    const matching = row.blocks.find(
      (block) =>
        block.type === 'delegated_agent_call' &&
        block.delegationId === change.delegationId &&
        block.runGeneration === change.runGeneration &&
        block.transcriptStore === 'chat-stream-v2',
    );
    if (matching?.type !== 'delegated_agent_call') {
      pending.delete(work.key);
      return;
    }
    // Do not mutate the creation row or its unrelated blocks. Only the matching part
    // is sent, so the additive Portal merge cannot roll back unrelated live parts.
    const blocks = row.blocks.map((block) =>
      block === matching
        ? overlayStreamBackedDelegationCard(
            matching,
            change.cardState,
            change.streamRevision,
          )
        : block,
    );
    const message = projectPersistedChatTranscript({
      ...owner.source,
      chatId: change.chatId,
      messages: [{ ...row, blocks }],
    })[0];
    if (!message) {
      pending.delete(work.key);
      return;
    }
    const parts = message.parts?.filter(
      (part) =>
        part.kind === 'agent' &&
        isRecord(part.data) &&
        isRecord(part.data.delegation) &&
        part.data.delegation.delegationId === change.delegationId &&
        part.data.delegation.runGeneration === change.runGeneration,
    );
    if (!parts?.length) {
      pending.delete(work.key);
      return;
    }
    const eventId = randomUUID();
    const event: PortalEventEnvelope = {
      eventId,
      clientEventId: eventId,
      occurredAt: work.occurredAt,
      type: 'portal.chat.event',
      payload: {
        ...owner.source,
        chatId: change.chatId,
        message: { ...message, parts },
      },
    };
    if (
      Buffer.byteLength(JSON.stringify(event), 'utf8') >
      PORTAL_CARD_EVENT_MAX_BYTES
    ) {
      dropped++;
      pending.delete(work.key);
      return;
    }
    if (!current(work)) return;
    sink(event);
    pending.delete(work.key);
  }
  function pump(): void {
    if (disposed || !isCurrent()) return;
    for (const work of Array.from(pending.values())) {
      if (active >= MAX_LOOKUPS) break;
      if (work.waiting || running.has(work.key)) continue;
      active++;
      running.add(work.key);
      void reconcile(work)
        .catch(() => {
          // A read/projection/sink failure must never escape into commit publication.
          if (current(work)) work.waiting = true;
        })
        .finally(() => {
          active--;
          running.delete(work.key);
          prune();
          schedule();
        });
    }
  }
  function admit(event: ChatStateChangedEvent, change: CardChange): void {
    if (
      !safeRevision(event.revision) ||
      !safeRevision(change.cardRevision) ||
      !safeRevision(change.streamRevision) ||
      !Number.isSafeInteger(change.runGeneration) ||
      change.runGeneration < 1 ||
      change.cardState.cardRevision !== change.cardRevision
    )
      return;
    const scope = { projectId: event.projectId, worktreeId: event.worktreeId };
    const family = familyKey(scope, change.chatId, change.delegationId);
    const previous = highest.get(family);
    // Within a run, a newer card revision or a stream advance at the same card
    // revision (rows committed with settlement) refreshes; nothing regresses.
    if (
      previous &&
      (change.runGeneration < previous.generation ||
        (change.runGeneration === previous.generation &&
          (change.cardRevision < previous.cardRevision ||
            event.revision < previous.revision ||
            change.streamRevision < previous.streamRevision ||
            (change.cardRevision === previous.cardRevision &&
              change.streamRevision === previous.streamRevision))))
    )
      return;
    if (previous) pending.delete(previous.key);
    const key = JSON.stringify([family, change.runGeneration]);
    const work: Work = {
      scope,
      change,
      revision: event.revision,
      occurredAt: event.occurredAt,
      family,
      key,
      anchor: delegationBlockId(change.delegationId, change.runGeneration),
      waiting: false,
      wakeRevision: 0,
      token: ++nextToken,
    };
    highest.delete(family);
    highest.set(family, {
      generation: change.runGeneration,
      cardRevision: change.cardRevision,
      streamRevision: change.streamRevision,
      revision: event.revision,
      key,
      token: work.token,
    });
    pending.set(key, work);
    while (pending.size > MAX_PENDING) {
      const oldest = pending.keys().next().value;
      if (oldest === undefined) break;
      pending.delete(oldest);
      dropped++;
    }
    prune();
  }
  function wake(event: ChatStateChangedEvent, change: ChatStateChange): void {
    if (
      change.type !== 'message.upserted' &&
      change.type !== 'message.removed' &&
      change.type !== 'messages.replaced' &&
      change.type !== 'tab.removed'
    )
      return;
    for (const work of Array.from(pending.values())) {
      if (
        event.projectId !== work.scope.projectId ||
        event.worktreeId !== work.scope.worktreeId
      )
        continue;
      if (change.type === 'tab.removed') {
        if (change.tabId === work.change.chatId) pending.delete(work.key);
        continue;
      }
      if (change.chatId !== work.change.chatId) continue;
      if (change.type === 'message.removed' && change.messageId === work.anchor)
        pending.delete(work.key);
      if (
        change.type === 'message.upserted' &&
        change.message.id === work.anchor
      ) {
        work.waiting = false;
        work.wakeRevision++;
      }
      if (change.type === 'messages.replaced') {
        if (change.removedMessageIds.includes(work.anchor))
          pending.delete(work.key);
        else if (change.messages.some((row) => row.id === work.anchor)) {
          work.waiting = false;
          work.wakeRevision++;
        }
      }
    }
  }
  const unsubscribe = port.subscribe((event): void => {
    // Synchronous and queue-only: not even owner resolution runs on publishCommit.
    try {
      if (disposed || !isCurrent()) return;
      for (const change of event.changes)
        if (change.type === 'delegation.card_state_updated')
          admit(event, change);
      for (const change of event.changes) wake(event, change);
      schedule();
    } catch {
      /* Publication is not allowed to depend on this compatibility reader. */
    }
  });
  return {
    dispose: (): void => {
      disposed = true;
      unsubscribe();
      pending.clear();
      highest.clear();
    },
    stats: () => ({
      pending: pending.size,
      active,
      dropped,
      retired: highest.size,
    }),
  };
}
