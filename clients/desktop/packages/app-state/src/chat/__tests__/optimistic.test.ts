import type { PortalChatMessage } from '@canopy/protocol/portal';
import {
  hasAuthoritativeMatch,
  isOptimisticMessage,
  makeOptimisticUserMessage,
  reconcileOptimistic,
  OPTIMISTIC_ID_PREFIX,
} from '../optimistic';

function authoritativeUser(
  text: string,
  createdAtMs: number,
): PortalChatMessage {
  return {
    messageId: `srv-${createdAtMs}`,
    chatId: 'c1',
    role: 'user',
    status: 'complete',
    text,
    createdAtMs,
  };
}

describe('optimistic', () => {
  it('marks store-generated echoes via the id prefix', () => {
    const optimistic = makeOptimisticUserMessage({
      chatId: 'c1',
      text: 'hi',
      createdAtMs: 100,
    });
    expect(optimistic.messageId.startsWith(OPTIMISTIC_ID_PREFIX)).toBe(true);
    expect(isOptimisticMessage(optimistic)).toBe(true);
    expect(isOptimisticMessage(authoritativeUser('hi', 100))).toBe(false);
  });

  it('honors a caller-supplied localId that already carries the prefix', () => {
    const optimistic = makeOptimisticUserMessage({
      chatId: 'c1',
      text: 'hi',
      createdAtMs: 100,
      localId: 'optimistic-custom',
    });
    expect(optimistic.messageId).toBe('optimistic-custom');
  });

  it('normalizes a non-prefixed localId so reconciliation still recognizes it', () => {
    const optimistic = makeOptimisticUserMessage({
      chatId: 'c1',
      text: 'hi',
      createdAtMs: 100,
      localId: 'send-123',
    });
    expect(optimistic.messageId).toBe('optimistic-send-123');
    expect(isOptimisticMessage(optimistic)).toBe(true);
  });

  it('detects when an authoritative message already covers a would-be echo', () => {
    const echo = makeOptimisticUserMessage({
      chatId: 'c1',
      text: 'hello',
      createdAtMs: 100,
    });
    // Authoritative frame already present within skew → covered.
    expect(hasAuthoritativeMatch([authoritativeUser('hello', 300)], echo)).toBe(
      true,
    );
    // Different text / no authoritative frame → not covered.
    expect(
      hasAuthoritativeMatch([authoritativeUser('different', 300)], echo),
    ).toBe(false);
    expect(hasAuthoritativeMatch([], echo)).toBe(false);
    // Another optimistic message does not count as authoritative coverage.
    expect(hasAuthoritativeMatch([echo], echo)).toBe(false);
  });

  it('prunes an optimistic echo superseded by a matching authoritative frame', () => {
    const optimistic = makeOptimisticUserMessage({
      chatId: 'c1',
      text: 'hello',
      createdAtMs: 100,
    });
    const authoritative = authoritativeUser('hello', 400); // within 1000ms skew
    const result = reconcileOptimistic(
      [optimistic, authoritative],
      authoritative,
    );
    expect(result.map((m) => m.messageId)).toEqual([authoritative.messageId]);
  });

  it('keeps an optimistic echo when text differs or the skew is exceeded', () => {
    const optimistic = makeOptimisticUserMessage({
      chatId: 'c1',
      text: 'hello',
      createdAtMs: 100,
    });
    // Different text → not superseded.
    const differentText = authoritativeUser('different', 200);
    expect(
      reconcileOptimistic([optimistic, differentText], differentText),
    ).toHaveLength(2);
    // Same text but beyond skew → not superseded.
    const lateEcho = authoritativeUser('hello', 2000);
    expect(reconcileOptimistic([optimistic, lateEcho], lateEcho)).toHaveLength(
      2,
    );
  });

  it('is a no-op when the incoming message is itself optimistic', () => {
    const optimistic = makeOptimisticUserMessage({
      chatId: 'c1',
      text: 'hello',
      createdAtMs: 100,
    });
    expect(reconcileOptimistic([optimistic], optimistic)).toHaveLength(1);
  });
});

it('carries attachments on the optimistic echo', () => {
  const attachments = [
    {
      attachmentId: '11111111-1111-4111-8111-111111111111',
      filename: 'shot.png',
      mediaType: 'image/png',
      size: 10,
    },
  ];
  expect(
    makeOptimisticUserMessage({
      chatId: 'c1',
      text: 'hi',
      createdAtMs: 100,
      attachments,
    }).attachments,
  ).toEqual(attachments);
  expect(
    makeOptimisticUserMessage({ chatId: 'c1', text: 'hi', createdAtMs: 100 }),
  ).not.toHaveProperty('attachments');
});
