/** @jest-environment jsdom */
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type { AccountMcpConnection } from '@canopy/protocol/mcp-servers';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  runDesktopTryItContinuation,
  type DesktopTryItRunnerPorts,
} from '../tryItContinuationRunner';
import {
  readTryItContinuation,
  writeTryItContinuation,
  type DesktopTryItContinuation,
} from '../tryItContinuation';
import type {
  TryItSendReceiptRead,
  TryItSendReceiptRequest,
} from '../tryItSendReceipt';

const capability = {
  kind: 'mcp',
  sourceId: 'curated-mcp',
  catalogId: 'linear',
  name: 'Linear',
} as const;
const record = (): DesktopTryItContinuation => ({
  version: 1,
  sourceChatId: 'chat',
  sourceSessionId: 'chat',
  sourceAccountKey: 'guest',
  sourceRequestId: 'launch',
  requestId: 'continue',
  prompt: 'Exact prompt',
  capability,
  createdAtMs: Date.now(),
  status: 'pending',
  host: {
    projectId: 'cowork',
    worktreeId: 'entry',
    authIntentAtMs: Date.now(),
    model: { model: 'sonnet', thinkingLevel: 'high' },
  },
});
const connection: AccountMcpConnection = {
  id: 'c',
  serverKey: 'linear',
  configId: 'default',
  kind: 'CURATED',
  status: 'CONNECTED',
  displayName: 'Linear',
  routeId: 'r',
  enabledTools: null,
};

function setup({ write = true }: { write?: boolean } = {}): {
  ports: DesktopTryItRunnerPorts;
  send: jest.Mock;
  receipt: jest.Mock<Promise<TryItSendReceiptRead>, [TryItSendReceiptRequest]>;
  connections: jest.Mock<Promise<AccountMcpConnection[]>, []>;
  account: { key: string | null };
  selections: { value: ChatTabPluginSelections | null };
} {
  const account = { key: 'account:1' as string | null };
  const selections = {
    value: {
      collectionIds: ['keep'],
      pluginRefs: [],
      skillRefs: [],
      unresolvedCapabilities: [
        capability,
        { ...capability, catalogId: 'other' },
      ],
    } as ChatTabPluginSelections | null,
  };
  const send = jest.fn(() => Promise.resolve());
  // Nothing is visible yet unless a test supplies durable evidence.
  const receipt = jest.fn<
    Promise<TryItSendReceiptRead>,
    [TryItSendReceiptRequest]
  >(() => Promise.resolve('missing'));
  const connections = jest.fn<Promise<AccountMcpConnection[]>, []>(() =>
    Promise.resolve([connection]),
  );
  const ports: DesktopTryItRunnerPorts = {
    accountKey: () => Promise.resolve(account.key),
    selections: () => selections.value,
    connections,
    updateSelections: (next) => {
      selections.value = next;
      return Promise.resolve();
    },
    continueChat: send,
    rebind: jest.fn(),
    receipt,
  };
  if (write) writeTryItContinuation(record());
  return { ports, send, receipt, connections, account, selections };
}
beforeEach(() => localStorage.clear());

it('resolves only the target, preserves unrelated selections/model, and completes on acknowledged dispatch', async () => {
  const { ports, send, selections } = setup();
  await Promise.all([
    runDesktopTryItContinuation('chat', 'account:1', ports),
    runDesktopTryItContinuation('chat', 'account:1', ports),
  ]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      requestId: 'continue',
      message: 'Exact prompt',
      model: { model: 'sonnet', thinkingLevel: 'high' },
    }),
  );
  expect(selections.value).toMatchObject({
    collectionIds: ['keep'],
    unresolvedCapabilities: [{ catalogId: 'other' }],
    mcpServerRefs: [{ serverId: 'linear', configId: 'default' }],
  });
  expect(readTryItContinuation('chat')?.status).toBe('completed');
  await runDesktopTryItContinuation('chat', 'account:1', ports);
  expect(send).toHaveBeenCalledTimes(1);
});

it.each(
  [
    [],
    [{ ...connection, serverKey: 'other' }],
    [connection, { ...connection, configId: 'ambiguous' }],
    [{ ...connection, status: 'DISCONNECTED' as const }],
  ].map((connections) => [connections] as const),
)(
  'keeps unusable or ambiguous targets in setup without replay %#',
  async (connections) => {
    const { ports, send } = setup();
    ports.connections = (): ReturnType<
      DesktopTryItRunnerPorts['connections']
    > => Promise.resolve(connections);
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    expect(readTryItContinuation('chat')?.status).toBe('setup-required');
    expect(send).not.toHaveBeenCalled();
  },
);

it('retains uncertain acceptance and never treats an optimistic row as completion', async () => {
  const { ports, send } = setup();
  send.mockRejectedValue(new Error('response lost'));
  await runDesktopTryItContinuation('chat', 'account:1', ports);
  expect(readTryItContinuation('chat')).toMatchObject({
    status: 'failed',
    failure: 'acceptance-uncertain',
    requestId: 'continue',
  });
});

it('does not bind a historical record without an activated authentication attempt', async () => {
  const { ports, send } = setup();
  writeTryItContinuation({
    ...record(),
    host: { projectId: 'cowork', worktreeId: 'entry' },
  });
  await runDesktopTryItContinuation('chat', 'account:1', ports);
  expect(readTryItContinuation('chat')?.destinationAccountKey).toBeUndefined();
  expect(send).not.toHaveBeenCalled();
});

it('fences an account switch during the connection read and a deleted tab', async () => {
  const { ports, send, account, selections } = setup();
  ports.connections = (): ReturnType<
    DesktopTryItRunnerPorts['connections']
  > => {
    account.key = 'account:2';
    return Promise.resolve([connection]);
  };
  await runDesktopTryItContinuation('chat', 'account:1', ports);
  expect(send).not.toHaveBeenCalled();
  account.key = 'account:1';
  selections.value = null;
  await runDesktopTryItContinuation('chat', 'account:1', ports);
  expect(send).not.toHaveBeenCalled();
});

// CAN-4396 AC3 evidence on unchanged production code: a replayed attempt
// reuses the original request, so main's command/message dedupe applies.
describe('replay keeps the original request', () => {
  const bound = (
    overrides: Partial<DesktopTryItContinuation> = {},
  ): DesktopTryItContinuation => ({
    ...record(),
    destinationAccountKey: 'account:1',
    ...overrides,
  });

  it('resumes a persisted sending record with the same IDs and never resends after completion', async () => {
    const { ports, send } = setup();
    writeTryItContinuation(bound({ status: 'sending' }));
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat', requestId: 'continue' }),
    );
    expect(readTryItContinuation('chat')).toMatchObject({
      status: 'completed',
      receipt: {
        accountKey: 'account:1',
        chatId: 'chat',
        requestId: 'continue',
      },
    });
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('joins concurrent retries of an uncertain acceptance into one attempt', async () => {
    const { ports, send } = setup();
    writeTryItContinuation(
      bound({ status: 'failed', failure: 'acceptance-uncertain' }),
    );
    let acknowledge: () => void = () => undefined;
    send.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const retries = Promise.all([
      runDesktopTryItContinuation('chat', 'account:1', ports),
      runDesktopTryItContinuation('chat', 'account:1', ports),
      runDesktopTryItContinuation('chat', 'account:1', ports),
    ]);
    await Promise.resolve();
    for (let index = 0; index < 20 && send.mock.calls.length === 0; index += 1)
      await Promise.resolve();
    acknowledge();
    await retries;
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat', requestId: 'continue' }),
    );
    expect(readTryItContinuation('chat')).toMatchObject({
      status: 'completed',
      requestId: 'continue',
    });
  });

  it('keeps an unacknowledged retry uncertain under the same request', async () => {
    const { ports, send } = setup();
    writeTryItContinuation(
      bound({ status: 'failed', failure: 'acceptance-uncertain' }),
    );
    send.mockRejectedValue(new Error('not been acknowledged'));
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    expect(send).toHaveBeenCalledTimes(2);
    for (const [request] of send.mock.calls)
      expect(request).toMatchObject({ chatId: 'chat', requestId: 'continue' });
    expect(readTryItContinuation('chat')).toMatchObject({
      status: 'failed',
      failure: 'acceptance-uncertain',
      requestId: 'continue',
    });
  });

  it('stays recoverable without minting IDs when no usable connection remains', async () => {
    const { ports, send, receipt } = setup();
    writeTryItContinuation(
      bound({ status: 'failed', failure: 'acceptance-uncertain' }),
    );
    ports.connections = (): ReturnType<
      DesktopTryItRunnerPorts['connections']
    > => Promise.resolve([]);
    // CAN-4404: an unreadable receipt keeps the uncertain record as it is.
    receipt.mockResolvedValueOnce('unknown');
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    expect(send).not.toHaveBeenCalled();
    expect(readTryItContinuation('chat')).toMatchObject({
      status: 'failed',
      failure: 'acceptance-uncertain',
      requestId: 'continue',
    });
    // A missing receipt reaches setup with the same identity and no stale
    // failure metadata.
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    expect(send).not.toHaveBeenCalled();
    const saved = readTryItContinuation('chat');
    expect(saved).toMatchObject({
      status: 'setup-required',
      requestId: 'continue',
      destinationAccountKey: 'account:1',
    });
    expect(saved?.failure).toBeUndefined();
  });
});

// CAN-4404: durable command receipts reconcile a continuation before any
// connection lookup or send.
describe('receipt reconciliation', () => {
  const bound = (
    overrides: Partial<DesktopTryItContinuation> = {},
  ): DesktopTryItContinuation => ({
    ...record(),
    destinationAccountKey: 'account:1',
    ...overrides,
  });
  const completedFor = (accountKey: string): Record<string, unknown> => ({
    status: 'completed',
    requestId: 'continue',
    receipt: { accountKey, chatId: 'chat', requestId: 'continue' },
  });
  const receiptRequest: TryItSendReceiptRequest = {
    location: { projectId: 'cowork', worktreeId: 'entry' },
    chatId: 'chat',
    requestId: 'continue',
  };

  it.each([
    ['sending', bound({ status: 'sending' })],
    [
      'acceptance-uncertain',
      bound({ status: 'failed', failure: 'acceptance-uncertain' }),
    ],
  ])(
    'settles an accepted %s record without connection lookup or dispatch',
    async (_label, saved) => {
      const { ports, send, receipt, connections } = setup();
      writeTryItContinuation(saved);
      connections.mockRejectedValue(new Error('no connections available'));
      receipt.mockResolvedValue('accepted');
      await runDesktopTryItContinuation('chat', 'account:1', ports);
      expect(receipt).toHaveBeenCalledWith(receiptRequest);
      expect(connections).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(readTryItContinuation('chat')).toMatchObject(
        completedFor('account:1'),
      );
    },
  );

  it('never queries or sends for a record bound to another account', async () => {
    const { ports, send, receipt } = setup();
    writeTryItContinuation(bound({ destinationAccountKey: 'account:2' }));
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    expect(receipt).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(readTryItContinuation('chat')?.status).toBe('pending');
  });

  it('discards a receipt read that outlives an account switch', async () => {
    const { ports, send, receipt, connections, account } = setup();
    writeTryItContinuation(bound({ status: 'sending' }));
    receipt.mockImplementation(() => {
      account.key = 'account:2';
      return Promise.resolve('accepted');
    });
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    expect(connections).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(readTryItContinuation('chat')?.status).toBe('sending');
  });

  it('discards a receipt read after the tab closes or the record is replaced', async () => {
    const { ports, send, receipt, selections } = setup();
    writeTryItContinuation(bound({ status: 'sending' }));
    const saved = selections.value;
    receipt.mockImplementationOnce(() => {
      selections.value = null;
      return Promise.resolve('accepted');
    });
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    expect(readTryItContinuation('chat')?.status).toBe('sending');

    selections.value = saved;
    receipt.mockImplementationOnce(() => {
      writeTryItContinuation(
        bound({ status: 'sending', requestId: 'replacement' }),
      );
      return Promise.resolve('not-accepted');
    });
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    expect(send).not.toHaveBeenCalled();
    expect(readTryItContinuation('chat')).toMatchObject({
      status: 'sending',
      requestId: 'replacement',
    });
  });

  it('stops when another run completed the record during the read', async () => {
    const { ports, send, receipt, connections } = setup();
    writeTryItContinuation(bound({ status: 'sending' }));
    receipt.mockImplementation(() => {
      writeTryItContinuation(
        bound({
          status: 'completed',
          receipt: {
            accountKey: 'account:1',
            chatId: 'chat',
            requestId: 'continue',
          },
        }),
      );
      return Promise.resolve('unknown');
    });
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    expect(connections).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(readTryItContinuation('chat')).toMatchObject(
      completedFor('account:1'),
    );
  });

  it.each([
    ['sending', bound({ status: 'sending' })],
    [
      'acceptance-uncertain',
      bound({ status: 'failed', failure: 'acceptance-uncertain' }),
    ],
  ])(
    'replays a missing %s receipt with the exact original identity',
    async (_label, saved) => {
      const { ports, send, receipt } = setup();
      writeTryItContinuation(saved);
      await runDesktopTryItContinuation('chat', 'account:1', ports);
      expect(receipt).toHaveBeenCalledWith(receiptRequest);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          location: { projectId: 'cowork', worktreeId: 'entry' },
          chatId: 'chat',
          requestId: 'continue',
        }),
      );
      expect(readTryItContinuation('chat')).toMatchObject(
        completedFor('account:1'),
      );
    },
  );

  it('reads the receipt at the exact scope the replay dispatches to', async () => {
    const { ports, send, receipt } = setup();
    const saved = bound({ status: 'sending' });
    writeTryItContinuation({
      ...saved,
      host: { ...saved.host, projectId: 'moved', worktreeId: 'elsewhere' },
    });
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    const location = { projectId: 'moved', worktreeId: 'elsewhere' };
    expect(receipt).toHaveBeenCalledWith({ ...receiptRequest, location });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        location,
        chatId: 'chat',
        requestId: 'continue',
      }),
    );
  });

  it.each([
    ['sending', bound({ status: 'sending' })],
    [
      'acceptance-uncertain',
      bound({ status: 'failed', failure: 'acceptance-uncertain' }),
    ],
    ['send-failed', bound({ status: 'failed', failure: 'send-failed' })],
  ])(
    'keeps an unreadable %s receipt uncertain without lookup or send',
    async (_label, saved) => {
      const { ports, send, receipt, connections } = setup();
      writeTryItContinuation(saved);
      receipt.mockResolvedValue('unknown');
      await runDesktopTryItContinuation('chat', 'account:1', ports);
      expect(connections).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(readTryItContinuation('chat')).toMatchObject({
        status: 'failed',
        failure: 'acceptance-uncertain',
        requestId: 'continue',
      });
    },
  );

  it('treats a throwing receipt port as unreadable', async () => {
    const { ports, send, receipt } = setup();
    writeTryItContinuation(bound({ status: 'sending' }));
    receipt.mockRejectedValue(new Error('relay gone'));
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    expect(send).not.toHaveBeenCalled();
    expect(readTryItContinuation('chat')).toMatchObject({
      status: 'failed',
      failure: 'acceptance-uncertain',
    });
  });

  it('keeps first-send behavior for an unreadable receipt on a fresh pending record', async () => {
    const { ports, send, receipt } = setup();
    receipt.mockResolvedValue('unknown');
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    expect(send).toHaveBeenCalledTimes(1);
    expect(readTryItContinuation('chat')).toMatchObject(
      completedFor('account:1'),
    );
  });

  it('fails a non-accepting receipt without sending, including on retry', async () => {
    const { ports, send, receipt, connections } = setup();
    writeTryItContinuation(bound({ status: 'sending' }));
    receipt.mockResolvedValue('not-accepted');
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    expect(receipt).toHaveBeenCalledTimes(2);
    expect(connections).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(readTryItContinuation('chat')).toMatchObject({
      status: 'failed',
      failure: 'send-failed',
      requestId: 'continue',
    });
  });

  it('recovers an immediate lost response from the post-send receipt', async () => {
    const { ports, send, receipt } = setup();
    receipt.mockResolvedValueOnce('missing').mockResolvedValueOnce('accepted');
    send.mockRejectedValue(new Error('response lost after commit'));
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    expect(send).toHaveBeenCalledTimes(1);
    expect(receipt).toHaveBeenCalledTimes(2);
    expect(readTryItContinuation('chat')).toMatchObject(
      completedFor('account:1'),
    );
  });

  it.each(['unknown', 'missing'] as const)(
    'recovers a lost response after refresh when the post-send read is %s',
    async (afterSend) => {
      const first = setup();
      first.receipt
        .mockResolvedValueOnce('missing')
        .mockResolvedValueOnce(afterSend);
      first.send.mockRejectedValue(new Error('response lost after commit'));
      await runDesktopTryItContinuation('chat', 'account:1', first.ports);
      expect(first.send).toHaveBeenCalledTimes(1);
      expect(readTryItContinuation('chat')).toMatchObject({
        status: 'failed',
        failure: 'acceptance-uncertain',
        requestId: 'continue',
      });

      // A refreshed renderer reads the persisted record with fresh ports.
      await jest.isolateModulesAsync(async () => {
        const refreshed = setup({ write: false });
        refreshed.receipt.mockResolvedValue('accepted');
        const runner = await import('../tryItContinuationRunner');
        const store = await import('../tryItContinuation');
        await runner.runDesktopTryItContinuation(
          'chat',
          'account:1',
          refreshed.ports,
        );
        expect(refreshed.connections).not.toHaveBeenCalled();
        expect(refreshed.send).not.toHaveBeenCalled();
        expect(store.readTryItContinuation('chat')).toMatchObject(
          completedFor('account:1'),
        );
      });
      expect(first.send).toHaveBeenCalledTimes(1);
    },
  );

  it('cannot settle for the old run when the account changes during dispatch', async () => {
    const { ports, send, receipt, account } = setup();
    send.mockImplementation(() => {
      account.key = 'account:2';
      return Promise.resolve();
    });
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    expect(receipt).toHaveBeenCalledTimes(1);
    expect(readTryItContinuation('chat')?.status).toBe('sending');
  });

  it('cannot settle or overwrite from a post-send read after the account changes', async () => {
    const { ports, send, receipt, account } = setup();
    send.mockRejectedValue(new Error('response lost'));
    receipt.mockResolvedValueOnce('missing').mockImplementationOnce(() => {
      account.key = 'account:2';
      return Promise.resolve('accepted');
    });
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    expect(readTryItContinuation('chat')).toMatchObject({
      status: 'sending',
      requestId: 'continue',
    });
  });

  it('never overwrites a newer record from a post-send read', async () => {
    const { ports, send, receipt } = setup();
    send.mockRejectedValue(new Error('response lost'));
    receipt.mockResolvedValueOnce('missing').mockImplementationOnce(() => {
      writeTryItContinuation(bound({ requestId: 'newer' }));
      return Promise.resolve('accepted');
    });
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    expect(readTryItContinuation('chat')).toMatchObject({
      status: 'pending',
      requestId: 'newer',
    });
  });

  it('leaves a replacement-chat record to its own resume path', async () => {
    const { ports, send, receipt } = setup();
    writeTryItContinuation(
      bound({ status: 'sending', destinationChatId: 'replacement' }),
    );
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    expect(receipt).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['before-send', 'after-throw', 'acknowledged'] as const)(
    'invalidates an account switch away and back during %s',
    async (phase) => {
      const { ports, send, receipt, connections, account } = setup();
      writeTryItContinuation(bound({ status: 'sending' }));
      const switchBack = (): void => {
        account.key = 'account:2';
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        account.key = 'account:1';
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      };
      if (phase === 'before-send') {
        receipt.mockImplementationOnce(() => {
          switchBack();
          return Promise.resolve('accepted');
        });
      } else if (phase === 'after-throw') {
        send.mockRejectedValue(new Error('lost response'));
        receipt.mockResolvedValueOnce('missing').mockImplementationOnce(() => {
          switchBack();
          return Promise.resolve('accepted');
        });
      } else {
        send.mockImplementation(() => {
          switchBack();
          return Promise.resolve();
        });
      }
      await runDesktopTryItContinuation('chat', 'account:1', ports);
      expect(readTryItContinuation('chat')?.status).toBe('sending');
      if (phase === 'before-send') {
        expect(connections).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
      }
      // An explicit retry belongs to the new session, not the invalid run.
      receipt.mockResolvedValue('accepted');
      await runDesktopTryItContinuation('chat', 'account:1', ports);
      expect(readTryItContinuation('chat')?.status).toBe('completed');
    },
  );

  it('rechecks record completion after the asynchronous account read', async () => {
    const { ports, receipt, connections, send } = setup();
    writeTryItContinuation(bound({ status: 'sending' }));
    receipt.mockResolvedValue('not-accepted');
    let reads = 0;
    ports.accountKey = (): Promise<string | null> => {
      if (++reads === 2) {
        writeTryItContinuation(
          bound({
            status: 'completed',
            receipt: {
              accountKey: 'account:1',
              chatId: 'chat',
              requestId: 'continue',
            },
          }),
        );
      }
      return Promise.resolve('account:1');
    };
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    expect(readTryItContinuation('chat')?.status).toBe('completed');
    expect(connections).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not look up connections after a replacement during the account read', async () => {
    const { ports, receipt, connections, send } = setup();
    writeTryItContinuation(bound({ status: 'sending' }));
    receipt.mockResolvedValue('missing');
    let reads = 0;
    ports.accountKey = (): Promise<string | null> => {
      if (++reads === 2) writeTryItContinuation(bound({ requestId: 'newer' }));
      return Promise.resolve('account:1');
    };
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    expect(connections).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(readTryItContinuation('chat')?.requestId).toBe('newer');
  });

  it('does not settle an acknowledgement after the tab closes', async () => {
    const { ports, send, selections } = setup();
    send.mockImplementation(() => {
      selections.value = null;
      return Promise.resolve();
    });
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    expect(readTryItContinuation('chat')?.status).toBe('sending');
  });

  it('rejects changed scope while the receipt read is pending', async () => {
    const { ports, receipt, connections, send } = setup();
    writeTryItContinuation(bound({ status: 'sending' }));
    receipt.mockImplementationOnce(() => {
      const saved = bound({ status: 'sending' });
      writeTryItContinuation({
        ...saved,
        host: { ...saved.host, worktreeId: 'other' },
      });
      return Promise.resolve('accepted');
    });
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    expect(readTryItContinuation('chat')?.status).toBe('sending');
    expect(connections).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not query a post-send receipt for a connection failure', async () => {
    const { ports, receipt, connections, send } = setup();
    connections.mockRejectedValue(new Error('connection lookup failed'));
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    expect(receipt).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(readTryItContinuation('chat')?.failure).toBe('send-failed');
  });

  it('does not treat a pending attempt as fresh after another run starts dispatch', async () => {
    const { ports, receipt, connections, send } = setup();
    receipt.mockImplementationOnce(() => {
      writeTryItContinuation(bound({ status: 'sending' }));
      return Promise.resolve('unknown');
    });
    await runDesktopTryItContinuation('chat', 'account:1', ports);
    expect(connections).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(readTryItContinuation('chat')?.status).toBe('sending');
  });
});
