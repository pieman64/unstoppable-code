import { extractCanonicalAgentArtifacts } from '../lib/agent-artifacts';
/**
 * Desktop-shared portal chat projection.
 *
 * The projection now lives in the browser-safe `@canopy/agent-transcript`
 * package so the hosted web run viewer (CAN-396) can reuse it. This module is
 * the thin desktop adapter: it injects the desktop's full `getPortalChatToolFamily`
 * resolver so the desktop portal-sync output (with `toolFamily` stamped on
 * `tool_use` parts) is byte-for-byte unchanged, and re-exports the neutral
 * helpers at this path so existing importers are unaffected.
 */
import {
  getModelDisplayName,
  type PersistedChatMessage,
  type PersistedChatTab,
} from '../types';
import type {
  PortalChatMessage,
  PortalChatPart,
  PortalTurnTimerAutoRoutedModel,
} from '@canopy/protocol/portal';
import {
  PORTAL_CHAT_UNBOUNDED_LIMITS,
  isRecord,
  persistedMessageToPortalMessage as persistedMessageToPortalMessageCore,
  persistedParts as persistedPartsCore,
  delegationRootMessages,
  isVisiblePersistedChatMessage,
  type PortalChatProjectionLimits,
} from '@canopy/agent-transcript';
import { getPortalChatToolFamily } from '../lib/portal-tool-family';
import {
  PORTAL_DELEGATION_SUB_BLOCKS_MAX_COUNT,
  projectPortalDelegationPart,
} from './delegation-wire-projection';

export {
  PORTAL_CHAT_PART_TEXT_MAX_CHARS,
  PORTAL_CHAT_SEED_MAX_BYTES,
  PORTAL_CHAT_SEED_MESSAGE_LIMIT,
  PORTAL_CHAT_TEXT_MAX_CHARS,
  PORTAL_CHAT_TRANSCRIPT_MESSAGE_LIMIT,
  deriveRuntimeChatMessageId,
  isRecord,
  limitPortalChatTranscript,
  limitPortalChatTranscriptForSeed,
  limitPortalChatTranscriptForSeedWithMetadata,
  portalChatMessageAttachmentsFromPaths,
  type PortalChatTranscriptSeed,
  summarizeUnknown,
  truncateText,
  truncateToolInput,
} from '@canopy/agent-transcript';

/** Project a persisted message's blocks into portal parts, tool-family stamped. */
export function persistedParts(
  message: PersistedChatMessage,
): PortalChatPart[] {
  return persistedPartsCore(message, getPortalChatToolFamily, {
    includeAccountProxySwitches: true,
    extractAgentArtifacts: extractCanonicalAgentArtifacts,
  });
}

function hasUnboundedProjectionLimits(
  limits: PortalChatProjectionLimits | undefined,
): boolean {
  return (
    limits !== undefined &&
    limits.textMaxChars === Number.POSITIVE_INFINITY &&
    limits.partTextMaxChars === Number.POSITIVE_INFINITY &&
    limits.objectMaxDepth === Number.POSITIVE_INFINITY &&
    limits.objectMaxKeys === Number.POSITIVE_INFINITY &&
    limits.arrayMaxItems === Number.POSITIVE_INFINITY
  );
}

function projectedChildPartCount(message: PersistedChatMessage): number {
  const toolUseIds = new Set(
    message.blocks.flatMap((block) =>
      block.type === 'tool_use' ? [block.toolUseId] : [],
    ),
  );
  return message.blocks.reduce((count, block) => {
    if (block.type === 'tool_result' && toolUseIds.has(block.toolUseId)) {
      return count;
    }
    if (
      block.type === 'text' ||
      block.type === 'thinking' ||
      block.type === 'tool_use' ||
      block.type === 'tool_result' ||
      block.type === 'image' ||
      block.type === 'compaction_info' ||
      block.type === 'mcp_activation' ||
      block.type === 'account_proxy_switch' ||
      block.type === 'delegated_agent_call'
    ) {
      return count + 1;
    }
    if (
      block.type === 'file_references' &&
      block.references.some((reference) => reference.kind !== 'plugin')
    ) {
      return count + 1;
    }
    if (block.type === 'turn_timer' && typeof block.completedAt === 'number') {
      return count + 1;
    }
    return count;
  }, 0);
}

function boundDelegationRelatedMessages(
  message: PersistedChatMessage,
  relatedMessages: readonly PersistedChatMessage[] | undefined,
): {
  relatedMessages: readonly PersistedChatMessage[] | undefined;
  omittedByBlockId: ReadonlyMap<string, number>;
} {
  if (relatedMessages === undefined) {
    return { relatedMessages, omittedByBlockId: new Map() };
  }
  const agentBlockIds = new Set(
    message.blocks.flatMap((block) =>
      block.type === 'delegated_agent_call' ? [block.agentBlockId] : [],
    ),
  );
  if (agentBlockIds.size === 0) {
    return { relatedMessages, omittedByBlockId: new Map() };
  }

  const retainedCounts = new Map<string, number>();
  const omittedByBlockId = new Map<string, number>();
  const retainedIndexes = new Set<number>();
  for (let index = relatedMessages.length - 1; index >= 0; index -= 1) {
    const child = relatedMessages[index];
    const parentBlockId = child?.parentBlockId;
    if (child === undefined || parentBlockId === undefined) continue;
    if (!agentBlockIds.has(parentBlockId)) continue;
    const retainedCount = retainedCounts.get(parentBlockId) ?? 0;
    if (retainedCount < PORTAL_DELEGATION_SUB_BLOCKS_MAX_COUNT) {
      retainedCounts.set(parentBlockId, retainedCount + 1);
      retainedIndexes.add(index);
      continue;
    }
    omittedByBlockId.set(
      parentBlockId,
      (omittedByBlockId.get(parentBlockId) ?? 0) +
        projectedChildPartCount(child),
    );
  }

  return {
    relatedMessages: relatedMessages.filter((_, index) =>
      retainedIndexes.has(index),
    ),
    omittedByBlockId,
  };
}

function projectDelegationPartsOnWire(
  message: PortalChatMessage,
  omittedByBlockId: ReadonlyMap<string, number>,
): PortalChatMessage {
  if (!message.parts?.some((part) => part.kind === 'agent')) return message;
  let changed = false;
  const parts = message.parts.flatMap((part): PortalChatPart[] => {
    if (part.kind !== 'agent' || !isRecord(part.data)) return [part];
    const data = part.data;
    if (!isRecord(data.delegation)) return [part];
    const agentBlockId = data.delegation.agentBlockId;
    const omitted =
      typeof agentBlockId === 'string'
        ? (omittedByBlockId.get(agentBlockId) ?? 0)
        : 0;
    const prepared: PortalChatPart =
      omitted > 0
        ? {
            ...part,
            data: {
              ...data,
              subBlocksTruncated: true,
              omittedSubBlocks:
                (typeof data.omittedSubBlocks === 'number' &&
                Number.isSafeInteger(data.omittedSubBlocks) &&
                data.omittedSubBlocks >= 0
                  ? data.omittedSubBlocks
                  : 0) + omitted,
            },
          }
        : part;
    const projected = projectPortalDelegationPart(prepared);
    changed = true;
    return projected === null ? [part] : [projected];
  });
  return changed ? { ...message, parts } : message;
}

/**
 * Project a persisted message into a neutral portal message, stamping the
 * canonical tool family on each `tool_use` part via `getPortalChatToolFamily`.
 */
export function persistedMessageToPortalMessage(
  input: {
    scope: 'worktree' | 'standalone' | 'app_advisor';
    workspaceLocalId?: string;
    worktreeLocalId?: string;
    chatId: string;
    message: PersistedChatMessage;
    relatedMessages?: readonly PersistedChatMessage[];
  },
  limits?: PortalChatProjectionLimits,
): PortalChatMessage {
  const shouldProjectDelegations = !hasUnboundedProjectionLimits(limits);
  const boundedChildren = shouldProjectDelegations
    ? boundDelegationRelatedMessages(input.message, input.relatedMessages)
    : {
        relatedMessages: input.relatedMessages,
        omittedByBlockId: new Map<string, number>(),
      };
  const message = persistedMessageToPortalMessageCore(
    {
      ...input,
      relatedMessages: boundedChildren.relatedMessages,
      toolFamilyFor: getPortalChatToolFamily,
    },
    // The owner's Portal and transcript show the switch lines; only the
    // publish path, which calls the core projection, leaves them out.
    {
      ...limits,
      includeAccountProxySwitches: true,
      extractAgentArtifacts: extractCanonicalAgentArtifacts,
    },
  );
  return shouldProjectDelegations
    ? projectDelegationPartsOnWire(message, boundedChildren.omittedByBlockId)
    : message;
}

/**
 * The `turn_timer` data fields attributing a turn to the model Auto picked
 * (see {@link PortalTurnTimerAutoRoutedModel}), or `undefined` when the turn
 * was not routed by Auto. `autoRoutedModels` is the chat tab's map of
 * user message id to routed model.
 */
export function turnTimerAutoRoutedModelData(
  autoRoutedModels: Readonly<Record<string, string>> | undefined,
  userMessageId: string | undefined,
): PortalTurnTimerAutoRoutedModel | undefined {
  const model =
    userMessageId === undefined ? undefined : autoRoutedModels?.[userMessageId];
  return model === undefined
    ? undefined
    : {
        autoRoutedModel: model,
        autoRoutedModelLabel: getModelDisplayName(model),
      };
}

/** Stamp Auto-routing attribution onto a projected message's timer parts. */
function withAutoRoutedModel(
  message: PortalChatMessage,
  attribution: PortalTurnTimerAutoRoutedModel | undefined,
): PortalChatMessage {
  if (attribution === undefined || !message.parts) return message;
  return {
    ...message,
    parts: message.parts.map((part) =>
      part.kind === 'turn_timer' && isRecord(part.data)
        ? { ...part, data: { ...part.data, ...attribution } }
        : part,
    ),
  };
}

/**
 * True when a persisted message is a turn-timer carrier: the renderer persists
 * each turn's timer as its own `system` message holding a completed
 * `turn_timer` block. Used by {@link projectPersistedChatTranscript} to re-key
 * those rows into the wire timer namespace.
 */
function isCompletedTurnTimerMessage(message: PersistedChatMessage): boolean {
  return (
    message.role === 'system' &&
    message.blocks.some(
      (block) =>
        block.type === 'turn_timer' && typeof block.completedAt === 'number',
    )
  );
}

/**
 * Project a persisted transcript into neutral portal messages, converging each
 * turn's persisted timer row onto the LIVE wire timer id.
 *
 * The live turn timer (`createPortalTurnTimer` in the desktop main process) is
 * emitted under `` `${userMessageId}:turn-timer` ``, while the renderer
 * persists its own timer row under a renderer-minted message id. Projecting
 * the persisted row under that minted id put the SAME logical timer on the
 * wire under two different messageIds, so the browser's upsert-by-id could not
 * collapse them — a refreshed portal transcript showed both a stale
 * "Working…" row (the cached live streaming frame) and the completed row (the
 * snapshot projection). Re-keying the first completed timer row of each turn
 * to `` `${userMessageId}:turn-timer` `` makes snapshot/history re-pushes
 * supersede the cached live frames instead of duplicating them.
 *
 * Only the FIRST completed timer per turn converges (the live path emits at
 * most one timer per turn); later continuation timers keep their persisted ids
 * so they never collide with each other.
 */
export function projectPersistedChatTranscript(input: {
  scope: 'worktree' | 'standalone' | 'app_advisor';
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  chatId: string;
  messages: PersistedChatMessage[];
  /**
   * `wire` (default) keeps the portal caps. `local` is the projection a host
   * renders its own transcript from: nothing truncated, in-flight turn timers
   * (with their message marked streaming) and local image sources included,
   * so the shared transcript can stand in for the desktop's. Never publish a
   * `local` projection.
   */
  fidelity?: 'wire' | 'local';
  /**
   * The chat tab's `autoRoutedModels` (user message id → model Auto picked).
   * Each turn's timer carries its routed model so remote transcripts show the
   * same "Picked by model routing" chip as the desktop.
   */
  autoRoutedModels?: Readonly<Record<string, string>>;
  /** Main-owned outcomes, keyed by the turn's user message, retained on reload. */
  turnEnds?: PersistedChatTab['turnEnds'];
  unacceptedTurnEnds?: PersistedChatTab['unacceptedTurnEnds'];
}): PortalChatMessage[] {
  const limits: PortalChatProjectionLimits | undefined =
    input.fidelity === 'local'
      ? {
          ...PORTAL_CHAT_UNBOUNDED_LIMITS,
          includeInFlightTurnTimers: true,
          includeLocalImageSources: true,
        }
      : { includeAssetReferences: input.scope !== 'app_advisor' };
  // Only the LIVE turn — the messages after the last user message — may
  // carry an in-flight timer and read as streaming. A persisted timer that
  // never completed on an earlier turn (a crash, a killed process) is stale
  // evidence, not a running turn, so it projects like any completed message.
  const visibleMessages = input.messages.filter(isVisiblePersistedChatMessage);
  const rootMessages = delegationRootMessages(visibleMessages);
  const liveTurnStart = rootMessages.reduce(
    (start, message, index) => (message.role === 'user' ? index : start),
    0,
  );
  let turnUserMessageId: string | undefined;
  let turnTimerConverged = false;
  const projected = rootMessages.map((message, index) => {
    if (message.role === 'user') {
      turnUserMessageId = message.id;
      turnTimerConverged = false;
    }
    const messageLimits =
      limits === undefined || index >= liveTurnStart
        ? limits
        : { ...limits, includeInFlightTurnTimers: false };
    let projected = withAutoRoutedModel(
      persistedMessageToPortalMessage(
        {
          scope: input.scope,
          workspaceLocalId: input.workspaceLocalId,
          worktreeLocalId: input.worktreeLocalId,
          chatId: input.chatId,
          message,
          relatedMessages: visibleMessages,
        },
        messageLimits,
      ),
      // A window that opens mid-turn has no user row yet, so that partial
      // turn's timer carries no chip; the renderer-minted timer id cannot
      // name its user message.
      turnTimerAutoRoutedModelData(input.autoRoutedModels, turnUserMessageId),
    );
    const outcome =
      turnUserMessageId === undefined
        ? undefined
        : (input.turnEnds?.[turnUserMessageId]?.outcome ??
          input.unacceptedTurnEnds?.[turnUserMessageId]);
    if (
      isCompletedTurnTimerMessage(message) &&
      (outcome === 'failed' || outcome === 'cancelled')
    ) {
      projected = {
        ...projected,
        parts: projected.parts?.map((part) =>
          part.kind === 'turn_timer'
            ? {
                ...part,
                data: {
                  ...(isRecord(part.data) ? part.data : {}),
                  endReason: outcome,
                },
              }
            : part,
        ),
      };
    }
    if (
      turnUserMessageId !== undefined &&
      !turnTimerConverged &&
      isCompletedTurnTimerMessage(message)
    ) {
      turnTimerConverged = true;
      return {
        ...projected,
        messageId: `${turnUserMessageId}:turn-timer`,
      };
    }
    return projected;
  });
  return mergeSuffixedPersistedMessages(projected);
}

/**
 * Converge renderer-suffixed persisted ids back onto one wire row (CAN-2608).
 *
 * The Claude stream-json path can emit several `assistant` events sharing one
 * SDK `message.id` (one per content block). The wire projector upserts them
 * all onto ONE portal row, but the renderer persists each event as its own
 * message with `ensureUniqueMessageId` suffixes (`base`, `base:2`, …). A
 * snapshot seed that re-pushed both verbatim put the SAME logical message on
 * the wire under two ids, so the browser rendered it twice (most visibly: a
 * duplicated ask-user tool row). Merging a suffixed row into its present base
 * row — parts appended in order, non-empty texts joined, terminal fields from
 * the later event — yields the renderer's complete view under the live id.
 *
 * Only rows whose suffix is `:<digits>` AND whose base id exists in the same
 * projection with the same role merge; anything else (e.g. `:turn-timer`
 * rows) passes through untouched.
 */
function mergeSuffixedPersistedMessages(
  messages: PortalChatMessage[],
): PortalChatMessage[] {
  const byId = new Map<string, PortalChatMessage>();
  const out: PortalChatMessage[] = [];
  for (const message of messages) {
    const match = /^(.+):\d+$/.exec(message.messageId);
    const base = match ? byId.get(match[1]) : undefined;
    if (base !== undefined && base.role === message.role) {
      const parts = [...(base.parts ?? []), ...(message.parts ?? [])];
      const text = [base.text, message.text].filter(Boolean).join('\n\n');
      // Timestamps merge only across values that EXIST. Consumers resolve a
      // message's display time as `updatedAtMs ?? createdAtMs`, and `0` is not
      // nullish: folding absent timestamps into `Math.max(… ?? 0, … ?? 0)`
      // stamped `updatedAtMs: 0` on every converged row, so
      // `persistedMessageToPortalMessage` (which sets `createdAtMs` only) sent
      // each multi-block answer to the wire dated to the epoch. The cowork
      // transcript sorts by that time, so those answers jumped above the whole
      // conversation and read as missing.
      const createdCandidates = [base.createdAtMs, message.createdAtMs].filter(
        (value): value is number => typeof value === 'number',
      );
      const updatedCandidates = [base.updatedAtMs, message.updatedAtMs].filter(
        (value): value is number => typeof value === 'number',
      );
      Object.assign(base, {
        text,
        status: message.status,
        ...(createdCandidates.length > 0
          ? { createdAtMs: Math.min(...createdCandidates) }
          : {}),
        ...(updatedCandidates.length > 0
          ? { updatedAtMs: Math.max(...updatedCandidates) }
          : {}),
        ...(parts.length > 0 ? { parts } : {}),
      });
      continue;
    }
    byId.set(message.messageId, message);
    out.push(message);
  }
  return out;
}
