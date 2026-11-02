import type { PersistedChatMessage } from '@canopy/agent-transcript/types';
import {
  isHumanAuthoredUserMessage,
  TRANSCRIPT_PAGE_SIZE,
  type TranscriptPage,
  type TranscriptTurnSummary,
  type TranscriptViewRequest,
} from '@canopy/agent-transcript/transcript-storage';
import {
  buildTurnIndex,
  type IndexedTurn,
} from '../../lib/chat-transcript-turn-index';
import {
  validateActiveRowAnchors,
  type ActiveRowAnchor,
} from '../../lib/chat-transcript-live-positions';

export interface LogicalTranscriptOracleInput {
  committed: readonly PersistedChatMessage[];
  active: readonly PersistedChatMessage[];
  anchors: ReadonlyMap<string, ActiveRowAnchor>;
  /** Copied into each page; defaults to revision zero for small fixtures. */
  revision?: number;
}

export interface LogicalTranscriptOracle {
  /** Complete logical order, including active rows anchored into history. */
  messages: PersistedChatMessage[];
  /** Logical history before the ordinary active tail. */
  body: PersistedChatMessage[];
  /** Ordinary active followers and anything anchored after those followers. */
  tail: PersistedChatMessage[];
  /** Complete in-memory turn index over `messages`. */
  turns: IndexedTurn[];
  /** Logical ordinal for every row in `messages`. */
  messageOrdinals: Record<string, number>;
  revision: number;
  rawPage(before?: number): TranscriptPage;
  turnPage(before?: number, options?: TranscriptViewRequest): TranscriptPage;
}

interface AnchoredMessage {
  id: string;
  message: PersistedChatMessage;
  anchor: ActiveRowAnchor;
}

/**
 * Deliberately simple, complete-in-memory transcript oracle for test contracts.
 * It validates the anchor graph but resolves it independently: anchored rows
 * are emitted depth-first after their predecessor, while the committed rows
 * and unanchored active rows form the stable spine.
 */
export async function logicalTranscriptOracle(
  input: LogicalTranscriptOracleInput,
): Promise<LogicalTranscriptOracle> {
  const revision = input.revision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new Error('Invalid transcript revision');

  const committedById = new Map<string, PersistedChatMessage>();
  for (const message of input.committed) {
    if (committedById.has(message.id))
      throw new Error(`Duplicate committed message ID: ${message.id}`);
    committedById.set(message.id, message);
  }

  const activeById = new Map<string, PersistedChatMessage>();
  const activeRows: PersistedChatMessage[] = [];
  for (const message of input.active) {
    if (activeById.has(message.id))
      throw new Error(`Duplicate active message ID: ${message.id}`);
    activeById.set(message.id, message);
    const committedMessage = committedById.get(message.id);
    if (committedMessage) {
      if (JSON.stringify(committedMessage) !== JSON.stringify(message))
        throw new Error('Active message conflicts with committed history');
      // An identical active echo is not a second logical row.
      continue;
    }
    activeRows.push(message);
  }

  const knownRunCardIds = new Set<string>();
  const runIdForMessage = (
    message: PersistedChatMessage | undefined,
  ): string | undefined => {
    if (!message) return undefined;
    if (message.blocks.some((block) => block.type === 'delegated_agent_call'))
      return message.id;
    return message.parentBlockId;
  };
  for (const message of [...input.committed, ...input.active])
    if (message.blocks.some((block) => block.type === 'delegated_agent_call'))
      knownRunCardIds.add(message.id);

  const anchorValidation = validateActiveRowAnchors(input.anchors, {
    isCommittedMessage: (id) => committedById.has(id),
    activeIds: new Set(activeById.keys()),
    runIdForMessage: (id) =>
      runIdForMessage(activeById.get(id) ?? committedById.get(id)),
    knownRunCardIds,
  });
  if (!anchorValidation.valid)
    throw new Error(`Invalid active row anchors: ${anchorValidation.reason}`);

  // A committed echo can have an active-sidecar anchor record in an input
  // fixture, but it is still emitted only once at its committed position.
  const orderedAnchors = new Map<string, AnchoredMessage>();
  const children = new Map<string | null, AnchoredMessage[]>();
  input.anchors.forEach((anchor: ActiveRowAnchor, id: string) => {
    if (committedById.has(id)) return;
    const message = activeById.get(id);
    if (!message) throw new Error(`Anchored active row is missing: ${id}`);
    const child: AnchoredMessage = { id, message, anchor };
    orderedAnchors.set(id, child);
    const siblings = children.get(anchor.after) ?? [];
    siblings.push(child);
    children.set(anchor.after, siblings);
  });
  children.forEach((siblings: AnchoredMessage[]) =>
    siblings.sort((left, right) => left.anchor.tie - right.anchor.tie),
  );

  const tailFollowerIds = new Set(
    activeRows
      .filter((message) => !orderedAnchors.has(message.id))
      .map((message) => message.id),
  );
  const spine = [
    ...input.committed,
    ...activeRows.filter((message) => !orderedAnchors.has(message.id)),
  ];
  const emitted = new Set<string>();
  const logicalRows: Array<{
    message: PersistedChatMessage;
    tailFollower: boolean;
  }> = [];
  const emitChildren = (predecessor: string | null): void => {
    // A stack retains DFS order without consuming the JS call stack on a long
    // chain of anchored rows.
    const pending = [...(children.get(predecessor) ?? [])].reverse();
    while (pending.length > 0) {
      const child = pending.pop();
      if (!child) continue;
      if (emitted.has(child.id))
        throw new Error(`Anchor cycle or duplicate row: ${child.id}`);
      emitted.add(child.id);
      logicalRows.push({ message: child.message, tailFollower: false });
      const descendants = children.get(child.id) ?? [];
      for (let index = descendants.length - 1; index >= 0; index -= 1) {
        const descendant = descendants[index];
        if (descendant) pending.push(descendant);
      }
    }
  };

  emitChildren(null);
  for (const message of spine) {
    if (emitted.has(message.id))
      throw new Error(`Duplicate logical row: ${message.id}`);
    emitted.add(message.id);
    logicalRows.push({
      message,
      tailFollower: tailFollowerIds.has(message.id),
    });
    emitChildren(message.id);
  }
  if (emitted.size !== committedById.size + activeRows.length)
    throw new Error(
      'Anchor resolution lost rows or found an unreachable cycle',
    );

  const messages = logicalRows.map((row) => row.message);
  const firstTailFollower = logicalRows.findIndex((row) => row.tailFollower);
  const bodyEnd = firstTailFollower < 0 ? messages.length : firstTailFollower;
  const body = messages.slice(0, bodyEnd);
  const tail = messages.slice(bodyEnd);
  const messageOrdinals: Record<string, number> = {};
  messages.forEach((message, ordinal) => {
    Object.defineProperty(messageOrdinals, message.id, {
      value: ordinal,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  });

  const turns = await buildTurnIndex(messages);
  // Keep the active delegation card visible as its durable parent context,
  // without pinning every child transcript row into a page.
  orderedAnchors.forEach((_child: AnchoredMessage, id: string) => {
    const message = activeById.get(id);
    if (
      !message ||
      !message.blocks.some((block) => block.type === 'delegated_agent_call')
    )
      return;
    const ordinal = messageOrdinals[id];
    const owner = turns.find(
      (turn) => turn.start <= ordinal && ordinal < turn.end,
    );
    if (!owner) throw new Error(`No turn owns delegated agent card: ${id}`);
    const retainedOrdinals = new Set<number>(owner.retained);
    retainedOrdinals.add(ordinal);
    owner.retained = Array.from(retainedOrdinals).sort(
      (left, right) => left - right,
    );
  });

  const latestHumanMessage = [...messages]
    .reverse()
    .find(isHumanAuthoredUserMessage);
  const stickyHumanMessage =
    orderedAnchors.size === 0
      ? [...input.committed].reverse().find(isHumanAuthoredUserMessage)
      : latestHumanMessage;

  const rawPage = (before?: number): TranscriptPage => {
    let start: number;
    let pageMessages: PersistedChatMessage[];
    if (before === undefined) {
      start = Math.max(0, body.length - TRANSCRIPT_PAGE_SIZE);
      pageMessages = [...body.slice(start), ...tail];
    } else {
      if (!Number.isSafeInteger(before) || before < 0 || before > body.length)
        throw new Error('Invalid transcript page cursor');
      start = Math.max(0, before - TRANSCRIPT_PAGE_SIZE);
      pageMessages = body.slice(start, before);
    }
    return {
      messages: pageMessages,
      totalMessages: messages.length,
      transcriptRevision: revision,
      ...(start > 0 ? { before: start } : {}),
      ...(latestHumanMessage &&
      !pageMessages.some((message) => message.id === latestHumanMessage.id)
        ? { latestHumanMessage }
        : {}),
    };
  };

  const turnPage = (
    before?: number,
    options: TranscriptViewRequest = {},
  ): TranscriptPage => {
    const end = before ?? messages.length;
    if (!Number.isSafeInteger(end) || end < 0 || end > messages.length)
      throw new Error('Invalid transcript page cursor');
    const owner = options.turnId
      ? turns.find((turn) => turn.id === options.turnId)
      : undefined;
    if (options.turnId && !owner) throw new Error('Unknown transcript turn');
    if (owner && (end <= owner.start || end > owner.end))
      throw new Error('Invalid turn page cursor');

    const selected = owner
      ? [owner]
      : turns.filter((turn) => turn.start < end).slice(-100);
    const historyBefore = selected[0]?.start;
    if (
      !owner &&
      stickyHumanMessage &&
      historyBefore !== undefined &&
      messageOrdinals[stickyHumanMessage.id] < historyBefore
    ) {
      const ordinal = messageOrdinals[stickyHumanMessage.id];
      const context = turns.find(
        (turn) => turn.start <= ordinal && ordinal < turn.end,
      );
      if (context) selected.unshift(context);
    }

    const ordinals = new Set<number>();
    const pageTurns: TranscriptTurnSummary[] = [];
    for (const turn of selected) {
      const newest = turn === turns[turns.length - 1];
      const tailStart = owner
        ? Math.max(turn.start, end - TRANSCRIPT_PAGE_SIZE)
        : newest || !turn.complete
          ? Math.max(turn.start, turn.end - 1000)
          : Math.max(turn.start, turn.end - 16);
      const tailEnd = owner ? end : turn.end;
      for (let ordinal = tailStart; ordinal < tailEnd; ordinal += 1)
        ordinals.add(ordinal);
      for (const ordinal of [...turn.frame, ...turn.retained])
        ordinals.add(ordinal);

      let gapEnd = tailStart;
      while (gapEnd > turn.start && ordinals.has(gapEnd - 1)) gapEnd -= 1;
      let gapStart = turn.start;
      while (gapStart < gapEnd && ordinals.has(gapStart)) gapStart += 1;
      pageTurns.push({
        id: turn.id,
        start: turn.start,
        end: turn.end,
        complete: turn.complete,
        summary: turn.summary,
        outcomes: turn.outcomes,
        deniedToolUseIds: turn.deniedToolUseIds,
        finalMessageIds: turn.finalMessageIds,
        files: turn.files,
        ...(turn.frameTimer ? { frameTimer: turn.frameTimer } : {}),
        ...(gapEnd > gapStart ? { before: gapEnd } : {}),
      });
    }

    const ordered: number[] = Array.from(ordinals).sort(
      (left, right) => left - right,
    );
    const pageMessages: PersistedChatMessage[] = [];
    for (const ordinal of ordered) {
      const message = messages[ordinal];
      if (!message)
        throw new Error(`Logical message ordinal is missing: ${ordinal}`);
      pageMessages.push(message);
    }
    const pageMessageOrdinals: Record<string, number> = {};
    pageMessages.forEach((message, index) => {
      Object.defineProperty(pageMessageOrdinals, message.id, {
        value: ordered[index],
        enumerable: true,
        configurable: true,
        writable: true,
      });
    });
    return {
      messages: pageMessages,
      view: 'turns',
      turns: pageTurns,
      totalMessages: messages.length,
      ...(options.turnId ? { turnId: options.turnId } : {}),
      messageOrdinals: pageMessageOrdinals,
      transcriptRevision: revision,
      ...(!owner && historyBefore !== undefined && historyBefore > 0
        ? { before: historyBefore }
        : {}),
    };
  };

  return {
    messages,
    body,
    tail,
    turns,
    messageOrdinals,
    revision,
    rawPage,
    turnPage,
  };
}
