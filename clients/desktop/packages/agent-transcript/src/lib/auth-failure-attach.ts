import type { AuthDependencyFailure } from '@canopy/protocol/auth-recovery';
import type { PersistedChatBlock, PersistedChatMessage } from '../types';
import { isClaudeAuthenticationFailureMessage } from './provider-errors';

/** The subset of `CanopyAuthFailureEventData` the attach needs. */
export interface AuthFailureAttachment {
  toolUseId?: string;
  failure: AuthDependencyFailure;
  /**
   * Every dependency the turn is blocked on, when the producer knows more than
   * one (CAN-1814 PR 2). Omitted by producers that only ever have a single
   * failure, e.g. the provider-terminal path.
   */
  failures?: readonly AuthDependencyFailure[];
}

/**
 * The failure fields written onto a block.
 *
 * BOTH are written, always. `authFailure` alone is what every reader that
 * predates the checklist understands, and `authFailures` is the complete set
 * the checklist renders; writing only the array would silently drop the card
 * for a stale reader, and writing only the scalar is the overwrite bug the
 * checklist exists to fix.
 */
function authFailureFields(event: AuthFailureAttachment): {
  authFailure: AuthDependencyFailure;
  authFailures: AuthDependencyFailure[];
} {
  const failures =
    event.failures !== undefined && event.failures.length > 0
      ? [...event.failures]
      : [event.failure];
  return { authFailure: event.failure, authFailures: failures };
}

/**
 * Attach a structured authentication failure to a block inside ONE message.
 *
 * MCP failures carry a `toolUseId` and attach to that tool result. A provider
 * failure carries none and attaches to the last text block of the blocks it is
 * given — this function has no message role and no turn boundary, so it cannot
 * decide *which* message should carry a provider failure. That choice belongs
 * to {@link attachAuthFailureToMessages}, which is the guarded entry point;
 * do not use this helper to pick a provider failure's anchor.
 *
 * Returns the input array by reference when nothing matched, so callers can use
 * identity to decide whether any state actually changed. That matters on the
 * renderer's memoization-sensitive `applyTabEvent` path, where a fresh array for
 * a non-matching event would invalidate cached turn groups for nothing.
 */
export function attachAuthFailureToBlocks(
  blocks: PersistedChatBlock[],
  event: AuthFailureAttachment,
): PersistedChatBlock[] {
  if (event.toolUseId !== undefined) {
    const target = event.toolUseId;
    let changed = false;
    const next = blocks.map((block) => {
      if (block.type !== 'tool_result' || block.toolUseId !== target) {
        return block;
      }
      changed = true;
      return { ...block, ...authFailureFields(event) };
    });
    return changed ? next : blocks;
  }

  let lastTextIndex = -1;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i].type === 'text') {
      lastTextIndex = i;
      break;
    }
  }
  if (lastTextIndex === -1) return blocks;

  return blocks.map((block, index) =>
    index === lastTextIndex && block.type === 'text'
      ? { ...block, ...authFailureFields(event) }
      : block,
  );
}

/**
 * Index of the message that opens the turn the failure belongs to: the newest
 * user message. Everything after it is this turn's output.
 *
 * `-1` when the transcript has no user message at all (a restored fragment, or
 * a surface that never persisted the prompt), in which case there is no turn to
 * bound and the whole transcript is searched.
 */
function findCurrentTurnStart(messages: PersistedChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return i;
  }
  return -1;
}

/**
 * Text the transcript reducer itself authors for a terminal failure, and so the
 * only text a provider auth failure may attach to.
 *
 * The INTENDED writers (CAN-1814 review round 2):
 *   - `Error: <message>` — `handleClaudeErrorEvent` (a Claude `{ type:
 *     'error' }` event), `handleCodexTurnFailed`, and `handleCodexError`.
 *   - the recognized Claude auth text verbatim — `handleClaudeResultEvent`
 *     writes `data.result` unchanged, and only when
 *     `isClaudeAuthenticationFailureMessage` accepts it, including the branch
 *     that promotes a duplicate trailing assistant message to `system`.
 *
 * This was previously described as exhaustive against the reducer. It is not
 * (CAN-1814 review round 3). A FOURTH writer produces qualifying text:
 * `upsertCodexItem`'s `case 'error'` writes a `role: 'system'` block reading
 * `Error: <item.message>` for a MID-TURN Codex `item.completed` of type
 * `error`, and {@link findProviderFailureAnchor} would match it.
 *
 * It is not gated out, because what keeps it from winning is ordering, and
 * ordering is the property actually worth relying on: the anchor walk is
 * newest-first, and every Codex terminal failure (`turn.failed`, `error`)
 * writes its own notice AFTER any mid-turn item error, so an intended anchor
 * always shadows it. The shapes that write no terminal notice at all —
 * `{ type: 'assistant', error: 'authentication_failed' }` and a 401 read off
 * buffered statuses on an unrecognized `result` — are Claude-only, and a Claude
 * turn cannot contain a Codex item error. Both halves are pinned by tests in
 * `__tests__/auth-failure-reducer.test.ts`.
 *
 * Narrowing the provider branch to the transcript's LAST message would exclude
 * it, but at the cost of false negatives: any message appended after an
 * intended notice would then drop the CTA entirely, which is a worse trade than
 * a fourth anchor that is itself an authored error notice inside the failing
 * turn. Revisit if a Codex terminal shape that writes no notice is ever
 * classified as an auth failure — that is the case where this becomes
 * reachable.
 *
 * Nothing else the reducer writes as a `system` text block qualifies: helper
 * diagnostics, model-change notes, hook/check output, and tool-result carriers
 * are all failure-agnostic.
 */
function isAuthoredFailureNoticeText(text: string): boolean {
  return (
    text.startsWith('Error: ') || isClaudeAuthenticationFailureMessage(text)
  );
}

/** Text of the last text block, matching where the block-level attach lands. */
function readLastTextBlockText(
  blocks: PersistedChatBlock[],
): string | undefined {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block.type === 'text') return block.text;
  }
  return undefined;
}

/**
 * Newest message in the failing turn that Canopy itself wrote as an error
 * notice: a `system` message whose LAST text block reads like a notice the
 * reducer authored for this failure (see {@link isAuthoredFailureNoticeText}).
 * "Last" because that is the block {@link attachAuthFailureToBlocks} writes to,
 * so the block that matched is the block that receives the failure.
 *
 * Deliberately narrow (CAN-1814 review). The provider failure event is emitted
 * immediately after the terminal provider event, and only SOME terminal shapes
 * cause the reducer to write a block for it: a `result` whose text
 * `isClaudeAuthenticationFailureMessage` recognizes, a Claude `{ type: 'error' }`
 * event, and Codex's `turn.failed` / `error`. The other shapes
 * `classifyAgentFailure` accepts — `{ type: 'assistant', error:
 * 'authentication_failed' }`, and a 401 read off buffered statuses on a
 * `result` whose body is unrecognized — create no block at all.
 *
 * Anchoring on "the last text block" landed the failure on the USER'S OWN
 * PROMPT bubble (the only text block in the transcript when the turn produced
 * no assistant text) or on an unrelated mid-turn assistant message. Anchoring
 * on "any `system` message with a text block" still landed it on an earlier
 * helper-diagnostic, model-change, or tool-result system message in the same
 * turn. Both anchors are durably persisted, and PR 2 renders from them.
 *
 * The trade is explicit: for a blockless shape there is now no anchor at all,
 * so no CTA renders for that turn. Attaching nothing beats attaching to the
 * wrong block.
 */
function findProviderFailureAnchor(messages: PersistedChatMessage[]): number {
  const turnStart = findCurrentTurnStart(messages);
  for (let i = messages.length - 1; i > turnStart; i -= 1) {
    const message = messages[i];
    if (message.role !== 'system') continue;
    const text = readLastTextBlockText(message.blocks);
    if (text === undefined || !isAuthoredFailureNoticeText(text)) continue;
    return i;
  }
  return -1;
}

/**
 * Message-level counterpart of {@link attachAuthFailureToBlocks}: an MCP failure
 * attaches to the message holding the matching `tool_result`, a provider failure
 * to the failing turn's `system` error notice (see
 * {@link findProviderFailureAnchor}) or to nothing at all.
 *
 * Also identity-preserving when nothing matched.
 */
export function attachAuthFailureToMessages(
  messages: PersistedChatMessage[],
  event: AuthFailureAttachment,
): PersistedChatMessage[] {
  if (event.toolUseId !== undefined) {
    const target = event.toolUseId;
    let changed = false;
    const next = messages.map((message) => {
      const hasMatch = message.blocks.some(
        (block) => block.type === 'tool_result' && block.toolUseId === target,
      );
      if (!hasMatch) return message;
      changed = true;
      return {
        ...message,
        blocks: attachAuthFailureToBlocks(message.blocks, event),
      };
    });
    return changed ? next : messages;
  }

  const anchorIndex = findProviderFailureAnchor(messages);
  if (anchorIndex === -1) return messages;

  return messages.map((message, index) =>
    index === anchorIndex
      ? {
          ...message,
          blocks: attachAuthFailureToBlocks(message.blocks, event),
        }
      : message,
  );
}
