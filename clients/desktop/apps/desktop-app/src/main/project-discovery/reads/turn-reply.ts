/**
 * One turn's final assistant reply, read by turn ID for an authorized caller:
 * the same binding, owner policy and bot gate as `projects.read_history` and
 * `bots.read_history`, through the core transcript turn view. Host-internal;
 * not an agent action. `fullText` is uncapped for `reply_file`.
 *
 * The turn is located by ID on the turn-view overview pages, newest first,
 * whose summaries always carry their final rows; a later turn never replaces
 * the watched one. (An explicit `turnId` page only pages a turn's interior.)
 */
import type { PersistedChatMessage } from '@canopy/agent-transcript';
import type {
  TranscriptPage,
  TranscriptTurnSummary,
} from '@canopy/agent-transcript/transcript-storage';
import type { BotChatAddress } from '@canopy/desktop-shared/lib/bot-discovery';
import {
  serializeVisibleReadMessage,
  visibleMessageRawText,
} from '@canopy/desktop-shared/lib/chat-history-serialization';
import type { ProjectChatAddress } from '@canopy/desktop-shared/lib/project-discovery';
import { resolveBotReadBinding } from '../bots/target';
import type { ChatReadContext } from '../chat-target';
import { DiscoveryError } from '../errors';
import type { ProjectDiscoveryCaller } from '../index';
import { resolveReadBinding } from './binding';
import {
  finalAssistantMessageInTurn,
  nextBefore,
  scanBudgetExceeded,
} from './last-message';
import { RAW_PAGE_BUDGET, TranscriptReader } from './transcript';

export interface TurnReply {
  messageId: string;
  /** Capped exactly as read_history serializes it (8,000 characters). */
  text: string;
  truncated: boolean;
  /** The same message's visible text with no cap. */
  fullText: string;
}

export type TurnReplyRead =
  | { kind: 'reply'; reply: TurnReply }
  | { kind: 'no_reply' }
  /** The transcript doesn't hold the turn complete yet; read again. */
  | { kind: 'not_settled' };

function resolveBinding(
  address: ProjectChatAddress | BotChatAddress,
  caller: ProjectDiscoveryCaller,
): Promise<{ binding: string; context: ChatReadContext }> {
  return 'botId' in address
    ? resolveBotReadBinding(
        { type: 'bots.get_last_agent_response', ...address },
        caller,
      )
    : resolveReadBinding(
        { type: 'projects.get_last_agent_response', ...address },
        caller,
      );
}

/** The page holding the turn's summary and final rows, or undefined when the transcript has none. */
async function findTurn(
  reader: TranscriptReader,
  turnId: string,
): Promise<{ page: TranscriptPage; turn: TranscriptTurnSummary } | undefined> {
  let before: number | undefined;
  for (let pageIndex = 0; pageIndex < RAW_PAGE_BUDGET; pageIndex += 1) {
    const page = await reader.readPage({
      ...(before !== undefined ? { before } : {}),
      view: 'turns',
    });
    // A sticky context row older than the page window is read from its own
    // page, as `getLastAgentResponse` does.
    const windowStart = page.before ?? 0;
    const turn = page.turns?.find(
      (candidate) => candidate.id === turnId && candidate.start >= windowStart,
    );
    if (turn) return { page, turn };
    if (page.before === undefined) return undefined;
    before = nextBefore(page, before, before ?? page.totalMessages);
  }
  await reader.verifyRevision();
  throw scanBudgetExceeded();
}

export async function readTurnReply(
  address: ProjectChatAddress | BotChatAddress,
  turnId: string,
  caller: ProjectDiscoveryCaller,
): Promise<TurnReplyRead> {
  const { binding, context } = await resolveBinding(address, caller);
  const reader = new TranscriptReader(context);
  const found = await findTurn(reader, turnId);
  const complete = found?.turn.complete === true;
  const message: PersistedChatMessage | undefined =
    found && complete
      ? finalAssistantMessageInTurn(found.page, found.turn)
      : undefined;
  await reader.verifyRevision();
  if ((await resolveBinding(address, caller)).binding !== binding)
    throw new DiscoveryError(
      'cursor_context_changed',
      'This history context changed. Restart the read.',
    );
  if (!complete) return { kind: 'not_settled' };
  const visible = message ? serializeVisibleReadMessage(message, turnId) : null;
  if (!message || !visible) return { kind: 'no_reply' };
  return {
    kind: 'reply',
    reply: {
      messageId: message.id,
      text: visible.text,
      truncated: visible.truncated,
      fullText: visibleMessageRawText(message),
    },
  };
}
