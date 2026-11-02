import type {
  TurnEnded,
  TurnOrigin,
  TurnStarted,
} from '@canopy/protocol/canopy-core';
import type { ChatStateService } from '../../services/chat-state-service';
import { ChatTurnStateHandoff } from '../../services/chat-turn-state-handoff';

/** The chat a provider adapter reports lifecycle events for. */
export interface TurnLifecycleChat {
  projectId: string;
  worktreeId: string;
  chatId: string;
  provider?: TurnStarted['provider'];
}

export interface TurnLifecycleFields {
  sequence: number;
  turnId: string;
  atMs: number;
  /** The prompts the turn binds; an autonomous wake binds none. */
  userMessageIds?: string[];
  origin?: TurnOrigin;
}

function binding(
  chat: TurnLifecycleChat,
  fields: TurnLifecycleFields,
): Omit<TurnStarted, 'eventId' | 'type' | 'phase' | 'startedAtMs'> {
  const userMessageIds = fields.userMessageIds ?? [];
  return {
    version: 1 as const,
    provider: chat.provider ?? 'claude',
    projectId: chat.projectId,
    worktreeId: chat.worktreeId,
    chatId: chat.chatId,
    sequence: fields.sequence,
    observedAtMs: fields.atMs,
    turnId: fields.turnId,
    origin: fields.origin ?? (userMessageIds.length ? 'user' : 'autonomous'),
    binding: userMessageIds.length ? ('bound' as const) : ('unbound' as const),
    submissionIds: [],
    userMessageIds,
    providerUserMessageUuids: [],
  };
}

/** A turn's canonical start, as its provider adapter reports it. */
export function turnStarted(
  chat: TurnLifecycleChat,
  fields: TurnLifecycleFields,
): TurnStarted {
  return {
    ...binding(chat, fields),
    eventId: `${fields.turnId}:started:${String(fields.sequence)}`,
    type: 'TurnStarted',
    phase: 'start',
    startedAtMs: fields.atMs,
  };
}

/** A turn's canonical end, as its provider adapter reports it. */
export function turnEnded(
  chat: TurnLifecycleChat,
  fields: TurnLifecycleFields & {
    outcome?: TurnEnded['outcome'];
    source?: TurnEnded['source'];
  },
): TurnEnded {
  return {
    ...binding(chat, fields),
    eventId: `${fields.turnId}:ended:${String(fields.sequence)}`,
    type: 'TurnEnded',
    endedAtMs: fields.atMs,
    outcome: fields.outcome ?? 'completed',
    source: fields.source ?? 'result',
  };
}

/** Commit every turn state the service's handoff has observed. */
export async function flushTurnState(service: ChatStateService): Promise<void> {
  const handoff: unknown = Reflect.get(service, 'turnHandoff');
  if (!(handoff instanceof ChatTurnStateHandoff))
    throw new Error('Chat state service did not create its turn handoff');
  await handoff.flushAll();
}

/** Observe a lifecycle event and commit the turn state it produces. */
export async function observeTurn(
  service: ChatStateService,
  event: TurnStarted | TurnEnded,
): Promise<void> {
  service.observeTurnLifecycle(event);
  await flushTurnState(service);
}
