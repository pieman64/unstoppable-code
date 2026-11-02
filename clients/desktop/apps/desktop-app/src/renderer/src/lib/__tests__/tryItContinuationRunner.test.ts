/** @jest-environment jsdom */
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type { AccountMcpConnection } from '@canopy/protocol/mcp-servers';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  runDesktopTryItContinuation,
  queueDesktopTryItSelectionUpdate,
  type DesktopTryItRunnerPorts,
} from '../tryItContinuationRunner';
import {
  readTryItContinuation,
  writeTryItContinuation,
  type DesktopTryItContinuation,
} from '../tryItContinuation';

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

function setup(): {
  ports: DesktopTryItRunnerPorts;
  updateSelections: jest.Mock<
    Promise<void>,
    Parameters<DesktopTryItRunnerPorts['updateSelections']>
  >;
  connections: jest.Mock<Promise<AccountMcpConnection[]>, []>;
  account: { key: string | null };
  selections: { value: ChatTabPluginSelections | null };
} {
  const account = { key: 'account:1' as string | null };
  const selections: { value: ChatTabPluginSelections | null } = {
    value: {
      collectionIds: ['keep'],
      pluginRefs: [],
      skillRefs: [],
      unresolvedCapabilities: [
        capability,
        { ...capability, catalogId: 'other' },
      ],
    },
  };
  const updateSelections = jest.fn<
    Promise<void>,
    Parameters<DesktopTryItRunnerPorts['updateSelections']>
  >((resolve): Promise<void> => {
    if (selections.value) selections.value = resolve(selections.value);
    return Promise.resolve();
  });
  const connections = jest.fn<Promise<AccountMcpConnection[]>, []>(() =>
    Promise.resolve([connection]),
  );
  const ports: DesktopTryItRunnerPorts = {
    accountKey: () => Promise.resolve(account.key),
    selections: () => selections.value,
    connections,
    updateSelections,
    rebind: jest.fn(),
  };
  writeTryItContinuation(record());
  return { ports, updateSelections, connections, account, selections };
}
beforeEach(() => localStorage.clear());

it('orders picker intents after authorization and recovers from a rejected write', async () => {
  const target = { projectId: 'project', worktreeId: 'tree', chatId: 'queued' };
  const events: string[] = [];
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const authorization = queueDesktopTryItSelectionUpdate(target, async () => {
    events.push('authorization');
    await held;
    throw new Error('rejected');
  });
  const rejection = expect(authorization).rejects.toThrow('rejected');
  const picker = queueDesktopTryItSelectionUpdate(target, () => {
    events.push('picker');
    return Promise.resolve();
  });
  await queueDesktopTryItSelectionUpdate({ ...target, chatId: 'other' }, () => {
    events.push('other chat');
    return Promise.resolve();
  });
  expect(events).toEqual(['authorization', 'other chat']);
  release();
  await rejection;
  await picker;
  expect(events).toEqual(['authorization', 'other chat', 'picker']);
});

it('resolves only the target, keeps unrelated selections, and completes without a send port', async () => {
  const { ports, updateSelections, selections } = setup();
  await Promise.all([
    runDesktopTryItContinuation('chat', 'account:1', ports),
    runDesktopTryItContinuation('chat', 'account:1', ports),
  ]);
  expect(updateSelections).toHaveBeenCalledTimes(1);
  expect(selections.value).toMatchObject({
    collectionIds: ['keep'],
    unresolvedCapabilities: [{ catalogId: 'other' }],
    mcpServerRefs: [{ serverId: 'linear', configId: 'default' }],
  });
  expect(readTryItContinuation('chat')).toMatchObject({
    status: 'completed',
    selectionResolution: {
      accountKey: 'account:1',
      chatId: 'chat',
      requestId: 'continue',
    },
  });
  await runDesktopTryItContinuation('chat', 'account:1', ports);
  expect(updateSelections).toHaveBeenCalledTimes(1);
});

it.each(
  [
    [],
    [{ ...connection, serverKey: 'other' }],
    [connection, { ...connection, configId: 'ambiguous' }],
    [{ ...connection, status: 'DISCONNECTED' as const }],
  ].map((connections) => [connections] as const),
)('keeps unusable or ambiguous targets in setup %#', async (connections) => {
  const { ports, updateSelections } = setup();
  ports.connections = (): ReturnType<DesktopTryItRunnerPorts['connections']> =>
    Promise.resolve(connections);
  await runDesktopTryItContinuation('chat', 'account:1', ports);
  expect(readTryItContinuation('chat')?.status).toBe('setup-required');
  expect(updateSelections).not.toHaveBeenCalled();
});

it('fails retryably when the selections cannot be updated', async () => {
  const { ports, updateSelections } = setup();
  updateSelections.mockRejectedValueOnce(new Error('ipc'));
  await runDesktopTryItContinuation('chat', 'account:1', ports);
  expect(readTryItContinuation('chat')).toMatchObject({
    status: 'failed',
    failure: 'send-failed',
  });
  await runDesktopTryItContinuation('chat', 'account:1', ports);
  expect(readTryItContinuation('chat')?.status).toBe('completed');
});

it.each([
  { status: 'sending' as const },
  { status: 'failed' as const, failure: 'acceptance-uncertain' as const },
])('only resolves selections for a legacy %o record', async (overrides) => {
  const { ports, updateSelections } = setup();
  writeTryItContinuation({
    ...record(),
    destinationAccountKey: 'account:1',
    ...overrides,
  });
  await runDesktopTryItContinuation('chat', 'account:1', ports);
  expect(updateSelections).toHaveBeenCalledTimes(1);
  expect(readTryItContinuation('chat')?.status).toBe('completed');
});

it('reads the latest selections after the connection lookup', async () => {
  const { ports, selections } = setup();
  ports.connections = (): ReturnType<
    DesktopTryItRunnerPorts['connections']
  > => {
    selections.value = {
      collectionIds: ['added-during-auth'],
      pluginRefs: [],
      skillRefs: [],
      unresolvedCapabilities: [capability],
    };
    return Promise.resolve([connection]);
  };
  await runDesktopTryItContinuation('chat', 'account:1', ports);
  expect(selections.value?.collectionIds).toEqual(['added-during-auth']);
  expect(selections.value?.unresolvedCapabilities).toEqual([]);
});

it('does not bind a historical record without an activated authentication attempt', async () => {
  const { ports, updateSelections } = setup();
  writeTryItContinuation({
    ...record(),
    host: { projectId: 'cowork', worktreeId: 'entry' },
  });
  await runDesktopTryItContinuation('chat', 'account:1', ports);
  expect(readTryItContinuation('chat')?.destinationAccountKey).toBeUndefined();
  expect(updateSelections).not.toHaveBeenCalled();
});

it('fences an account switch during the connection read and a deleted tab', async () => {
  const { ports, updateSelections, account, selections } = setup();
  ports.connections = (): ReturnType<
    DesktopTryItRunnerPorts['connections']
  > => {
    account.key = 'account:2';
    return Promise.resolve([connection]);
  };
  await runDesktopTryItContinuation('chat', 'account:1', ports);
  expect(updateSelections).not.toHaveBeenCalled();
  account.key = 'account:1';
  selections.value = null;
  await runDesktopTryItContinuation('chat', 'account:1', ports);
  expect(updateSelections).not.toHaveBeenCalled();
});

it('invalidates a run when the account changes, even if it switches back', async () => {
  const { ports, updateSelections, connections } = setup();
  let release: (value: AccountMcpConnection[]) => void = () => undefined;
  connections.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const run = runDesktopTryItContinuation('chat', 'account:1', ports);
  await Promise.resolve();
  await Promise.resolve();
  window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
  release([connection]);
  await run;
  expect(updateSelections).not.toHaveBeenCalled();
});

it('never settles a record bound to another account', async () => {
  const { ports, updateSelections } = setup();
  writeTryItContinuation({ ...record(), destinationAccountKey: 'account:2' });
  await runDesktopTryItContinuation('chat', 'account:1', ports);
  expect(updateSelections).not.toHaveBeenCalled();
  expect(readTryItContinuation('chat')?.status).toBe('pending');
});
