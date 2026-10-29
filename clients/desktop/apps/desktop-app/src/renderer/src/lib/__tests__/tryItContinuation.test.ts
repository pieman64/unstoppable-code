/**
 * @jest-environment jsdom
 */
import { TRY_IT_CONTINUATION_TTL_MS } from '@canopy/protocol/try-it/continuation';
import {
  readTryItContinuation,
  settleTryItContinuationReceipt,
  subscribeTryItContinuation,
  tryItContinuationStorageKey,
  updateTryItContinuation,
  writeTryItContinuation,
  type DesktopTryItContinuation,
} from '../tryItContinuation';

function record(
  overrides: Partial<DesktopTryItContinuation> = {},
): DesktopTryItContinuation {
  return {
    version: 1,
    sourceChatId: 'chat-1',
    sourceSessionId: 'chat-1',
    sourceAccountKey: 'guest',
    capability: {
      kind: 'mcp',
      sourceId: 'curated-mcp',
      catalogId: 'linear',
      name: 'Linear',
    },
    sourceRequestId: 'launch-request',
    requestId: 'continuation-request',
    prompt: 'List my open issues',
    createdAtMs: Date.now() - 1000,
    status: 'pending',
    host: { projectId: 'cowork', worktreeId: 'entry-1' },
    ...overrides,
  };
}

describe('desktop try-it continuation store', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips and notifies only its chat', () => {
    const listener = jest.fn();
    const other = jest.fn();
    const unsubscribe = subscribeTryItContinuation('chat-1', listener);
    subscribeTryItContinuation('chat-2', other);
    const saved = record();
    expect(writeTryItContinuation(saved)).toBe(true);
    expect(readTryItContinuation('chat-1')).toEqual(saved);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('requires a valid location and rejects expired or misplaced records', () => {
    expect(
      writeTryItContinuation(
        record({ host: { projectId: ' ', worktreeId: 'entry-1' } }),
      ),
    ).toBe(false);
    const key = tryItContinuationStorageKey('chat-1');
    localStorage.setItem(key, JSON.stringify({ ...record(), host: undefined }));
    expect(readTryItContinuation('chat-1')).toBeNull();
    localStorage.setItem(
      key,
      JSON.stringify({ ...record(), host: { projectId: 'p', path: '/tmp' } }),
    );
    expect(readTryItContinuation('chat-1')).toBeNull();
    localStorage.setItem(
      key,
      JSON.stringify(
        record({ createdAtMs: Date.now() - TRY_IT_CONTINUATION_TTL_MS }),
      ),
    );
    expect(readTryItContinuation('chat-1')).toBeNull();
    localStorage.setItem(
      tryItContinuationStorageKey('chat-2'),
      JSON.stringify(record()),
    );
    expect(readTryItContinuation('chat-2')).toBeNull();
  });

  it('updates only the matching request with a valid result', () => {
    writeTryItContinuation(record());
    expect(
      updateTryItContinuation('chat-1', 'other', (current) => current),
    ).toBeNull();
    expect(
      updateTryItContinuation('chat-1', 'continuation-request', (current) => ({
        ...current,
        status: 'setup-required',
      })),
    ).toBeNull();
    expect(
      updateTryItContinuation('chat-1', 'continuation-request', (current) => ({
        ...current,
        status: 'setup-required',
        destinationAccountKey: 'account:1',
      }))?.status,
    ).toBe('setup-required');
  });

  describe('settling an accepted-turn receipt', () => {
    const sending = (
      overrides: Partial<DesktopTryItContinuation> = {},
    ): DesktopTryItContinuation =>
      record({
        status: 'sending',
        destinationAccountKey: 'account:1',
        ...overrides,
      });
    const receipt = {
      accountKey: 'account:1',
      chatId: 'chat-1',
      requestId: 'continuation-request',
    };

    it('completes a record matching account, destination chat and request', () => {
      writeTryItContinuation(
        sending({ status: 'failed', failure: 'acceptance-uncertain' }),
      );
      settleTryItContinuationReceipt(receipt);
      expect(readTryItContinuation('chat-1')).toMatchObject({
        status: 'completed',
        receipt,
      });
      expect(readTryItContinuation('chat-1')?.failure).toBeUndefined();
    });

    it.each([
      ['account', { accountKey: 'account:2' }],
      ['chat', { chatId: 'chat-2' }],
      ['request', { requestId: 'other-request' }],
    ])('rejects a receipt for another %s', (_label, overrides) => {
      writeTryItContinuation(sending());
      settleTryItContinuationReceipt({ ...receipt, ...overrides });
      expect(readTryItContinuation('chat-1')?.status).toBe('sending');
    });

    it('matches the destination chat, not the source chat, when they differ', () => {
      writeTryItContinuation(sending({ destinationChatId: 'chat-2' }));
      settleTryItContinuationReceipt(receipt);
      expect(readTryItContinuation('chat-1')?.status).toBe('sending');
      settleTryItContinuationReceipt({ ...receipt, chatId: 'chat-2' });
      expect(readTryItContinuation('chat-1')).toMatchObject({
        status: 'completed',
        receipt: { ...receipt, chatId: 'chat-2' },
      });
    });
  });
});
