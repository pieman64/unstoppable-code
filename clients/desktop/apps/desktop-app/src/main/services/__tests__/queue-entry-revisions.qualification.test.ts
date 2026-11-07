import type { HostQueuedMessageView } from '@canopy/desktop-shared/types';
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

function views(harness: QueueHarness): HostQueuedMessageView[] {
  return harness.service
    .getWorktreeSnapshots('ws-1', 'wt-1')
    .filter((event) => event.chatId === 'chat-1')
    .flatMap((event) => event.queue);
}

function view(
  harness: QueueHarness,
  id: string,
): HostQueuedMessageView | undefined {
  return views(harness).find((message) => message.id === id);
}

const edit = (
  text: string,
  entryId = 'row-1',
): Parameters<QueueHarness['service']['edit']>[0] => ({
  ...target,
  entryId,
  text,
});

describe('queued entry revisions (CAN-4112)', () => {
  it('a queued entry starts at revision 1 and each edit adds one', async () => {
    const harness = createQueueHarness();
    seed(harness, 1);
    // A running turn keeps the row queued while it is edited.
    harness.setProviderTurnActive(target, true);
    expect(view(harness, 'row-1')?.revision).toBe(1);

    await expect(
      harness.service.edit(edit('changed'), undefined, 'replace', {
        entryRevision: 1,
      }),
    ).resolves.toBe('applied');

    expect(view(harness, 'row-1')?.revision).toBe(2);
    const last = harness.persisted.at(-1);
    expect(
      last?.queuedMessages?.find((message) => message.id === 'row-1')?.revision,
    ).toBe(2);
  });

  it('a stale entry revision is refused and changes nothing', async () => {
    const harness = createQueueHarness();
    seed(harness, 2);
    harness.setProviderTurnActive(target, true);
    await harness.service.edit(edit('first edit'));
    expect(view(harness, 'row-1')?.revision).toBe(2);
    const persistedBefore = harness.persisted.length;

    await expect(
      harness.service.edit(edit('stale edit'), undefined, 'replace', {
        entryRevision: 1,
      }),
    ).resolves.toBe('conflict');
    expect(view(harness, 'row-1')?.text).toBe('first edit');
    expect(harness.persisted).toHaveLength(persistedBefore);

    await expect(
      harness.service.cancel(target, 'row-1', undefined, { entryRevision: 1 }),
    ).resolves.toBe('conflict');
    await expect(
      harness.service.move(target, 'row-1', null, undefined, {
        entryRevision: 1,
      }),
    ).resolves.toBe('conflict');
    await expect(
      harness.service.force(target, 'row-1', undefined, { entryRevision: 1 }),
    ).resolves.toBe('conflict');

    expect(views(harness).map((message) => message.id)).toEqual([
      'row-1',
      'row-2',
    ]);
    expect(harness.dispatches).toEqual([]);
    expect(harness.cancels).toEqual([]);
  });

  it('two edits with one revision: the second is refused', async () => {
    const harness = createQueueHarness();
    seed(harness, 1);

    const results = await Promise.all([
      harness.service.edit(edit('one'), undefined, 'replace', {
        entryRevision: 1,
      }),
      harness.service.edit(edit('two'), undefined, 'replace', {
        entryRevision: 1,
      }),
    ]);

    expect([...results].sort()).toEqual(['applied', 'conflict']);
  });

  it('a failed edit restores the revision', async () => {
    const harness = createQueueHarness();
    seed(harness, 1);
    harness.failNextPersistence(new Error('disk'));

    await expect(
      harness.service.edit(edit('lost'), undefined, 'replace', {
        entryRevision: 1,
      }),
    ).rejects.toThrow('disk');

    expect(view(harness, 'row-1')?.revision).toBe(1);
  });

  it('a hydrated row keeps its revision', async () => {
    const harness = createQueueHarness();
    harness.service.hydratePersistedInput(
      queuedRequest(target, 'm1'),
      'row-1',
      'desktop',
      1,
      undefined,
      undefined,
      { revision: 3 },
    );
    expect(view(harness, 'row-1')?.revision).toBe(3);

    await expect(
      harness.service.edit(edit('changed'), undefined, 'replace', {
        entryRevision: 3,
      }),
    ).resolves.toBe('applied');
  });
});
