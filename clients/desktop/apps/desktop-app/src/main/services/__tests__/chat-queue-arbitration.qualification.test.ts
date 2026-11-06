import {
  createQueueHarness,
  queuedRequest,
  type QueueHarness,
} from './helpers/queue-harness';

jest.mock('../chat-state-service', () => ({
  getChatStateService: (): Record<string, jest.Mock> => ({
    cancelRetainedTerminalAgentInput: jest.fn(() =>
      Promise.resolve('not_found'),
    ),
    editRetainedTerminalAgentInput: jest.fn(() => Promise.resolve('not_found')),
  }),
}));

const target = { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'chat-1' };

function seed(harness: QueueHarness, count: number): void {
  for (let n = 1; n <= count; n += 1)
    harness.service.hydratePersistedInput(
      queuedRequest(target, `m${n}`),
      `row-${n}`,
      'desktop',
      n,
    );
}

function queuedRowIds(harness: QueueHarness): string[] {
  return harness.service
    .getWorktreeSnapshots('ws-1', 'wt-1')
    .filter((event) => event.chatId === 'chat-1')
    .flatMap((event) => event.queue.map((message) => message.id));
}

describe('chat queue arbitration (CAN-4112)', () => {
  it('only one admitted turn executes per chat', async () => {
    const harness = createQueueHarness();
    seed(harness, 3);
    const held = harness.holdNextDispatch();
    harness.service.releaseInputOwnership(target);
    await harness.flush();
    expect(harness.dispatches).toHaveLength(1);
    expect(harness.dispatches[0]?.request.userMessageId).toBe('m1');

    await expect(harness.service.force(target, 'row-2')).resolves.toBe('busy');
    await harness.flush();
    expect(harness.dispatches).toHaveLength(1);

    held.release();
    await harness.flush();
    expect(harness.dispatches).toHaveLength(1);

    harness.finishTurn(target);
    await harness.flush();
    expect(harness.dispatches).toHaveLength(2);
    expect(harness.dispatches[1]?.request.userMessageId).toBe('m2');
  });

  it('force stops the running turn before it sends', async () => {
    const harness = createQueueHarness();
    seed(harness, 2);
    harness.service.releaseInputOwnership(target);
    await harness.flush();
    harness.setProviderTurnActive(target, true);

    await expect(harness.service.force(target, 'row-2')).resolves.toBe(
      'applied',
    );

    expect(harness.events).toEqual([
      'dispatch:m1',
      'cancel:chat-1',
      'dispatch:m2',
    ]);
  });

  it('force and cancel never resend a dispatching message', async () => {
    const harness = createQueueHarness();
    seed(harness, 1);
    const held = harness.holdNextDispatch();
    harness.service.releaseInputOwnership(target);
    await harness.flush();

    await expect(harness.service.cancel(target, 'row-1')).resolves.toBe(
      'not_found',
    );
    await expect(harness.service.force(target, 'row-1')).resolves.toBe(
      'not_found',
    );
    held.release();
    await harness.flush();

    expect(harness.dispatches).toHaveLength(1);
  });

  it('a dispatching message stays durable until its prompt commits', async () => {
    const harness = createQueueHarness();
    seed(harness, 1);
    harness.holdNextDispatch();
    harness.service.releaseInputOwnership(target);
    await harness.flush();

    const last = harness.persisted.at(-1);
    expect(last?.inFlight?.id).toBe('row-1');
    expect(last?.queuedMessageIds).not.toContain('row-1');
  });

  it('an acknowledged send is queued exactly once across a restart', async () => {
    const harness = createQueueHarness();
    const request = queuedRequest(target, 'm1');
    harness.service.hydratePersistedInput(request, 'row-1', 'desktop', 1);
    harness.service.hydratePersistedInput(request, 'row-1', 'desktop', 1);
    harness.service.hydratePersistedInput(
      request,
      'row-1',
      'desktop',
      1,
      undefined,
      undefined,
      { atHead: true },
    );
    harness.service.releaseInputOwnership(target);
    await harness.flush();
    harness.finishTurn(target);
    await harness.flush();

    expect(
      harness.dispatches.filter(
        (dispatch) => dispatch.request.userMessageId === 'm1',
      ),
    ).toHaveLength(1);
    expect(harness.dispatches).toHaveLength(1);
  });

  it('a move commits the whole order before it is published', async () => {
    const harness = createQueueHarness();
    seed(harness, 3);
    harness.service.releaseInputOwnership(target);
    await harness.flush();
    expect(queuedRowIds(harness)).toEqual(['row-2', 'row-3']);

    harness.failNextPersistence(new Error('disk'));
    await expect(
      harness.service.move(target, 'row-3', 'row-2'),
    ).rejects.toThrow('disk');
    expect(queuedRowIds(harness)).toEqual(['row-2', 'row-3']);

    await expect(harness.service.move(target, 'row-3', 'row-2')).resolves.toBe(
      'applied',
    );
    const last = harness.persisted.at(-1);
    expect(last?.mutation?.type).toBe('move');
    expect(last?.queuedMessageIds).toEqual(['row-3', 'row-2']);
    const published = harness.broadcasts.at(-1);
    expect(published?.queue.map((message) => message.id)).toEqual([
      'row-3',
      'row-2',
    ]);
  });

  it('a failed cancel puts the row back in its place', async () => {
    const harness = createQueueHarness();
    seed(harness, 3);
    harness.service.releaseInputOwnership(target);
    await harness.flush();

    harness.failNextPersistence(new Error('disk'));
    await expect(harness.service.cancel(target, 'row-2')).rejects.toThrow(
      'disk',
    );

    expect(queuedRowIds(harness)).toEqual(['row-2', 'row-3']);
  });
});
