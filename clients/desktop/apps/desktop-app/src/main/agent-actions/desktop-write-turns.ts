import { createHash } from 'node:crypto';

/**
 * A stable id derived from a write's idempotency key, formatted as a UUID,
 * so a retried write addresses the same chat and message.
 */
export function idFromWriteKey(idempotencyKey: string, role: string): string {
  const hex = createHash('sha256')
    .update(`${role}\u0000${idempotencyKey}`)
    .digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/** The user message id an agent write submits its message under. */
export function agentWriteMessageId(idempotencyKey: string): string {
  return idFromWriteKey(idempotencyKey, 'message');
}
