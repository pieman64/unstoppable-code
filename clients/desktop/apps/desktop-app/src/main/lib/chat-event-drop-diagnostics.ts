import { isRecord } from './type-guards';
import { buildChatSessionKey } from '../agents/session-key';
import type { SessionDiagnosticRecord } from '../observability/service';

/** Why a provider event was not delivered (audit §7 step 0.2). */
export type ChatEventDropGate = NonNullable<
  SessionDiagnosticRecord['chatEventDropGate']
>;

export interface ChatEventDrop {
  projectId: string;
  worktreeId: string;
  chatId: string;
  providerType?: SessionDiagnosticRecord['providerType'];
  gate: ChatEventDropGate;
  /** A short fixed reason code; never provider text. */
  reason: string;
  /** The dropped event, as the gate received it. */
  data: unknown;
  /** The route's, gate owner's or active turn, when it is not the event's. */
  turnUserMessageId?: string;
  providerThreadId?: string;
  providerTurnId?: string;
  nowMs?: number;
}

const MAX_FIELD_LENGTH = 200;

function bounded(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, MAX_FIELD_LENGTH)
    : undefined;
}

/** `type/subtype`, or a Codex envelope's type with its native event type. */
export function chatEventTypeForDiagnostic(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const type = bounded(data.type) ?? bounded(data.method);
  const detail =
    bounded(data.subtype) ??
    (isRecord(data.event)
      ? (bounded(data.event.type) ?? bounded(data.event.method))
      : undefined);
  return type && detail ? `${type}/${detail}` : (type ?? detail);
}

export function chatEventDroppedDiagnostic(
  drop: ChatEventDrop,
): SessionDiagnosticRecord {
  const data = isRecord(drop.data) ? drop.data : undefined;
  const eventType = chatEventTypeForDiagnostic(drop.data);
  const eventTurnUserMessageId = bounded(data?.canopy_turn_user_message_id);
  const turnUserMessageId = bounded(drop.turnUserMessageId);
  const providerThreadId = bounded(drop.providerThreadId);
  const providerTurnId = bounded(drop.providerTurnId);
  return {
    version: 1,
    timestamp: new Date(drop.nowMs ?? Date.now()).toISOString(),
    kind: 'chat_event_dropped',
    sessionKey: buildChatSessionKey(
      drop.projectId,
      drop.worktreeId,
      drop.chatId,
    ),
    projectId: drop.projectId,
    worktreeId: drop.worktreeId,
    chatId: drop.chatId,
    providerType: drop.providerType ?? 'unknown',
    chatEventDropGate: drop.gate,
    chatEventDropReason: drop.reason.slice(0, MAX_FIELD_LENGTH),
    ...(eventType ? { eventType } : {}),
    ...(eventTurnUserMessageId ? { eventTurnUserMessageId } : {}),
    ...(turnUserMessageId ? { turnUserMessageId } : {}),
    ...(providerThreadId ? { providerThreadId } : {}),
    ...(providerTurnId ? { providerTurnId } : {}),
  };
}

function recordLazily(record: SessionDiagnosticRecord): void {
  // Lazy: observability pulls in the Codex runtime graph, which imports
  // callers of this module; a static import would create a cycle.
  void import('../observability')
    .then(({ getObservabilityService }) => {
      getObservabilityService().recordSessionDiagnostic(record);
    })
    .catch(() => undefined);
}

/** Records a drop. A diagnostic that cannot be recorded never changes delivery. */
export function recordChatEventDropped(
  drop: ChatEventDrop,
  record: (diagnostic: SessionDiagnosticRecord) => void = recordLazily,
): void {
  try {
    record(chatEventDroppedDiagnostic(drop));
  } catch {
    // Delivery decisions never depend on diagnostics.
  }
}
