/** @jest-environment jsdom */
import {
  readTryItSendReceipt,
  tryItContinuationCommandId,
  type TryItSendReceiptRequest,
} from '../tryItSendReceipt';

const request: TryItSendReceiptRequest = {
  location: { projectId: 'cowork', worktreeId: 'entry' },
  chatId: 'chat-1',
  requestId: 'continue-1',
};
const receipt = {
  commandId: 'try-it-continue-1',
  revision: 3,
  outcome: 'applied',
  entityId: 'chat-1',
  messageId: 'continue-1',
};
const relayReturning = (
  value: unknown,
): { invoke: jest.Mock; relay: Pick<Window['canopyCore'], 'invoke'> } => {
  const invoke = jest.fn<Promise<{ ok: true; value: unknown }>, [unknown]>(() =>
    Promise.resolve({ ok: true as const, value }),
  );
  return { invoke, relay: { invoke } };
};

it('derives the stable continuation command ID', () => {
  expect(tryItContinuationCommandId('continue-1')).toBe('try-it-continue-1');
});

it('queries the existing receipt operation with the mapped scope and command ID', async () => {
  const { invoke, relay } = relayReturning({ outcome: 'missing' });
  await readTryItSendReceipt(request, relay);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith({
    kind: 'request',
    method: 'core.chat.send.receipt',
    params: {
      scope: { workspaceId: 'cowork', worktreeId: 'entry', chatId: 'chat-1' },
      commandId: 'try-it-continue-1',
    },
  });
});

it.each(['applied', 'already_applied'])(
  'accepts a matched %s receipt naming this command, chat and message',
  async (outcome) => {
    const { relay } = relayReturning({
      outcome: 'matched',
      receipt: { ...receipt, outcome },
    });
    await expect(readTryItSendReceipt(request, relay)).resolves.toBe(
      'accepted',
    );
  },
);

it('reports a missing receipt as missing', async () => {
  const { relay } = relayReturning({ outcome: 'missing' });
  await expect(readTryItSendReceipt(request, relay)).resolves.toBe('missing');
});

it('reports a conflicting receipt as not accepted', async () => {
  const { relay } = relayReturning({ outcome: 'conflict' });
  await expect(readTryItSendReceipt(request, relay)).resolves.toBe(
    'not-accepted',
  );
});

it.each([
  ['a conflict outcome', { outcome: 'conflict' }],
  ['a not_found outcome', { outcome: 'not_found' }],
  ['a rejected outcome', { outcome: 'rejected' }],
  ['another command', { commandId: 'try-it-other' }],
  ['another chat', { entityId: 'chat-2' }],
  ['another message', { messageId: 'other-request' }],
  ['no chat', { entityId: undefined }],
  ['no message', { messageId: undefined }],
])('does not accept a matched receipt with %s', async (_label, overrides) => {
  const { relay } = relayReturning({
    outcome: 'matched',
    receipt: { ...receipt, ...overrides },
  });
  await expect(readTryItSendReceipt(request, relay)).resolves.toBe(
    'not-accepted',
  );
});

it.each([
  ['a non-object value', 'matched'],
  ['an unknown outcome', { outcome: 'accepted' }],
  ['extra keys on missing', { outcome: 'missing', receipt }],
  ['a matched result without receipt', { outcome: 'matched' }],
  ['extra keys on matched', { outcome: 'matched', receipt, extra: true }],
  [
    'extra receipt keys',
    { outcome: 'matched', receipt: { ...receipt, chatId: 'chat-1' } },
  ],
  [
    'a missing command ID',
    { outcome: 'matched', receipt: { ...receipt, commandId: undefined } },
  ],
  [
    'a missing revision',
    { outcome: 'matched', receipt: { ...receipt, revision: undefined } },
  ],
  [
    'a negative revision',
    { outcome: 'matched', receipt: { ...receipt, revision: -1 } },
  ],
  [
    'a fractional revision',
    { outcome: 'matched', receipt: { ...receipt, revision: 1.5 } },
  ],
  [
    'an unsafe integer revision',
    {
      outcome: 'matched',
      receipt: { ...receipt, revision: Number.MAX_SAFE_INTEGER + 1 },
    },
  ],
  [
    'an unknown receipt outcome',
    { outcome: 'matched', receipt: { ...receipt, outcome: 'accepted' } },
  ],
  [
    'an invalid message ID',
    { outcome: 'matched', receipt: { ...receipt, messageId: 'Bad ID' } },
  ],
])('treats a malformed result with %s as unknown', async (_label, value) => {
  const { relay } = relayReturning(value);
  await expect(readTryItSendReceipt(request, relay)).resolves.toBe('unknown');
});

it('treats an error reply as unknown', async () => {
  const relay = {
    invoke: jest.fn(() =>
      Promise.resolve({
        ok: false as const,
        error: {
          kind: 'unavailable' as const,
          message: 'The relay is unavailable.',
          retry: { kind: 'never' as const },
        },
      }),
    ),
  };
  await expect(readTryItSendReceipt(request, relay)).resolves.toBe('unknown');
});

it('treats a malformed envelope as unknown', async () => {
  // An untyped bridge returning something outside the reply contract.
  const relay = {
    invoke: jest.fn().mockResolvedValue({ value: { outcome: 'missing' } }),
  };
  await expect(readTryItSendReceipt(request, relay)).resolves.toBe('unknown');
});

it('treats a thrown invocation as unknown', async () => {
  const relay = {
    invoke: jest.fn(() => Promise.reject(new Error('bridge gone'))),
  };
  await expect(readTryItSendReceipt(request, relay)).resolves.toBe('unknown');
});

it('treats an unavailable relay as unknown', async () => {
  await expect(readTryItSendReceipt(request, undefined)).resolves.toBe(
    'unknown',
  );
});

it.each([
  ['project', { location: { ...request.location, projectId: 'Cowork' } }],
  ['worktree', { location: { ...request.location, worktreeId: '' } }],
  ['chat', { chatId: 'chat/1' }],
  ['request', { requestId: '-continue' }],
])(
  'returns unknown without querying for an invalid %s identifier',
  async (_label, overrides) => {
    const { invoke, relay } = relayReturning({ outcome: 'missing' });
    await expect(
      readTryItSendReceipt({ ...request, ...overrides }, relay),
    ).resolves.toBe('unknown');
    expect(invoke).not.toHaveBeenCalled();
  },
);
