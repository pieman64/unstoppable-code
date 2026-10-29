import type { TryItChatLocation } from './tryItChat';

/**
 * Durable acceptance evidence for a Try it continuation (CAN-4404): the main
 * process command receipt for the continuation's stable command ID, read
 * through the existing `core.chat.send.receipt` query.
 *
 * `not-accepted` cannot confirm the intended turn; it never authorizes a send
 * under a new ID. `missing` is only what was visible at read time: an
 * in-flight command can still commit afterwards.
 */
export type TryItSendReceiptRead =
  | 'accepted'
  | 'not-accepted'
  | 'missing'
  | 'unknown';

export interface TryItSendReceiptRequest {
  location: TryItChatLocation;
  chatId: string;
  requestId: string;
}

type TryItSendReceiptRelay = Pick<Window['canopyCore'], 'invoke'>;

/** Mirrors the receipt contract's identifier grammar. */
const ID = /^[a-z0-9][a-z0-9-]*$/;
const isId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  ID.test(value);

const RECEIPT_OUTCOMES: ReadonlySet<unknown> = new Set([
  'applied',
  'already_applied',
  'conflict',
  'not_found',
  'rejected',
]);
const RECEIPT_KEYS: ReadonlySet<string> = new Set([
  'commandId',
  'revision',
  'outcome',
  'entityId',
  'messageId',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: Record<string, unknown>,
  keys: ReadonlySet<string>,
): boolean => Object.keys(value).every((key) => keys.has(key));

/** The durable command ID for one continuation request; stable across replays. */
export function tryItContinuationCommandId(requestId: string): string {
  return `try-it-${requestId}`;
}

type ParsedReceipt =
  | { outcome: 'missing' }
  | { outcome: 'conflict' }
  | {
      outcome: 'matched';
      commandId: string;
      receiptOutcome: unknown;
      entityId: unknown;
      messageId: unknown;
    };

/** A runtime guard aligned with `CoreChatSendReceiptResultSchema`. */
function parseReceiptResult(value: unknown): ParsedReceipt | null {
  if (!isRecord(value)) return null;
  if (value.outcome === 'missing' || value.outcome === 'conflict')
    return hasOnlyKeys(value, new Set(['outcome']))
      ? { outcome: value.outcome }
      : null;
  if (
    value.outcome !== 'matched' ||
    !hasOnlyKeys(value, new Set(['outcome', 'receipt']))
  )
    return null;
  const receipt = value.receipt;
  if (
    !isRecord(receipt) ||
    !hasOnlyKeys(receipt, RECEIPT_KEYS) ||
    !isId(receipt.commandId) ||
    typeof receipt.revision !== 'number' ||
    !Number.isSafeInteger(receipt.revision) ||
    receipt.revision < 0 ||
    !RECEIPT_OUTCOMES.has(receipt.outcome) ||
    (receipt.entityId !== undefined && !isId(receipt.entityId)) ||
    (receipt.messageId !== undefined && !isId(receipt.messageId))
  )
    return null;
  return {
    outcome: 'matched',
    commandId: receipt.commandId,
    receiptOutcome: receipt.outcome,
    entityId: receipt.entityId,
    messageId: receipt.messageId,
  };
}

/** Reads whether main durably accepted this continuation's exact command. */
export async function readTryItSendReceipt(
  { location, chatId, requestId }: TryItSendReceiptRequest,
  relay: TryItSendReceiptRelay | undefined = window.canopyCore,
): Promise<TryItSendReceiptRead> {
  const commandId = tryItContinuationCommandId(requestId);
  if (
    !isId(location.projectId) ||
    !isId(location.worktreeId) ||
    !isId(chatId) ||
    !isId(requestId) ||
    !isId(commandId) ||
    typeof relay?.invoke !== 'function'
  )
    return 'unknown';
  let reply: Awaited<ReturnType<TryItSendReceiptRelay['invoke']>>;
  try {
    reply = await relay.invoke({
      kind: 'request',
      method: 'core.chat.send.receipt',
      params: {
        scope: {
          workspaceId: location.projectId,
          worktreeId: location.worktreeId,
          chatId,
        },
        commandId,
      },
    });
  } catch {
    return 'unknown';
  }
  if (!isRecord(reply) || reply.ok !== true) return 'unknown';
  const result = parseReceiptResult(reply.value);
  if (!result) return 'unknown';
  if (result.outcome === 'missing') return 'missing';
  if (result.outcome === 'conflict') return 'not-accepted';
  return result.commandId === commandId &&
    result.entityId === chatId &&
    result.messageId === requestId &&
    (result.receiptOutcome === 'applied' ||
      result.receiptOutcome === 'already_applied')
    ? 'accepted'
    : 'not-accepted';
}
