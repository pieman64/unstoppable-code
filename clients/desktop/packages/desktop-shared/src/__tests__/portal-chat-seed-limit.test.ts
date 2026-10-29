import {
  PORTAL_CHAT_SEED_MAX_BYTES,
  PORTAL_CHAT_SEED_MESSAGE_LIMIT,
  PORTAL_CHAT_TRANSCRIPT_MESSAGE_LIMIT,
  limitPortalChatTranscript,
  limitPortalChatTranscriptForSeed,
  limitPortalChatTranscriptForSeedWithMetadata,
} from '../portal/persisted-chat-projection';
import type { PortalChatMessage } from '@canopy/protocol/portal';

function message(index: number, text = `message ${index}`): PortalChatMessage {
  return {
    messageId: `msg-${index}`,
    chatId: 'chat-1',
    role: 'assistant',
    status: 'complete',
    text,
    createdAtMs: 1_000_000 + index,
  };
}

describe('limitPortalChatTranscript', () => {
  it('keeps the newest messages up to the default limit', () => {
    const messages = Array.from({ length: 100 }, (_, i) => message(i));
    const limited = limitPortalChatTranscript(messages);
    expect(limited).toHaveLength(PORTAL_CHAT_TRANSCRIPT_MESSAGE_LIMIT);
    expect(limited[0].messageId).toBe('msg-20');
    expect(limited[limited.length - 1].messageId).toBe('msg-99');
  });

  it('honors an explicit limit', () => {
    const messages = Array.from({ length: 10 }, (_, i) => message(i));
    expect(limitPortalChatTranscript(messages, 3)).toHaveLength(3);
    expect(limitPortalChatTranscript(messages, 3)[0].messageId).toBe('msg-7');
  });
});

describe('limitPortalChatTranscriptForSeed', () => {
  it('keeps up to the seed message limit for small messages', () => {
    const messages = Array.from(
      { length: PORTAL_CHAT_SEED_MESSAGE_LIMIT + 50 },
      (_, i) => message(i),
    );
    const limited = limitPortalChatTranscriptForSeed(messages);
    expect(limited).toHaveLength(PORTAL_CHAT_SEED_MESSAGE_LIMIT);
    expect(limited[limited.length - 1].messageId).toBe(
      `msg-${PORTAL_CHAT_SEED_MESSAGE_LIMIT + 49}`,
    );
  });

  it('drops oldest messages once the byte budget is exhausted', () => {
    // ~100KB each: only the newest handful fit inside the 600KB budget.
    const big = 'x'.repeat(100_000);
    const messages = Array.from({ length: 20 }, (_, i) => message(i, big));
    const limited = limitPortalChatTranscriptForSeed(messages);
    expect(limited.length).toBeLessThan(20);
    expect(limited.length).toBeGreaterThan(0);
    // Newest messages are the ones kept.
    expect(limited[limited.length - 1].messageId).toBe('msg-19');
    const serialized = limited.reduce(
      (total, m) => total + Buffer.byteLength(JSON.stringify(m), 'utf8'),
      0,
    );
    expect(serialized).toBeLessThanOrEqual(PORTAL_CHAT_SEED_MAX_BYTES);
  });

  it('counts multibyte text against the byte budget', () => {
    const multibyte = '😀'.repeat(100_000);
    const messages = Array.from({ length: 3 }, (_, i) => message(i, multibyte));
    const limited = limitPortalChatTranscriptForSeed(messages);

    expect(limited).toHaveLength(1);
    expect(limited[0].messageId).toBe('msg-2');
    expect(Buffer.byteLength(JSON.stringify(limited[0]), 'utf8')).toBeLessThan(
      PORTAL_CHAT_SEED_MAX_BYTES,
    );
  });

  it('always keeps the newest message even when it alone exceeds the budget', () => {
    const oversized = message(0, 'y'.repeat(PORTAL_CHAT_SEED_MAX_BYTES + 100));
    expect(limitPortalChatTranscriptForSeed([oversized])).toHaveLength(1);
  });

  it('returns short transcripts unchanged', () => {
    const messages = Array.from({ length: 5 }, (_, i) => message(i));
    expect(limitPortalChatTranscriptForSeed(messages)).toEqual(messages);
  });

  it('reports whether count or byte limiting truncated the transcript', () => {
    const complete = Array.from({ length: 5 }, (_, i) => message(i));
    expect(limitPortalChatTranscriptForSeedWithMetadata(complete)).toEqual({
      messages: complete,
      truncated: false,
    });

    const byteLimited = Array.from({ length: 20 }, (_, i) =>
      message(i, 'x'.repeat(100_000)),
    );
    const result = limitPortalChatTranscriptForSeedWithMetadata(byteLimited);
    expect(result.messages.length).toBeLessThan(byteLimited.length);
    expect(result.truncated).toBe(true);
  });
});
