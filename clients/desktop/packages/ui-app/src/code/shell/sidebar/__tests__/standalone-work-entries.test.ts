import {
  groupStandaloneChatsIntoWorkEntries,
  type GroupableStandaloneChat,
} from '../standalone-work-entries';

function chat(
  overrides: Partial<GroupableStandaloneChat> & { localId: string },
): GroupableStandaloneChat {
  return {
    projectLocalId: 'project-1',
    title: `Chat ${overrides.localId}`,
    ...overrides,
  };
}

const DAY = (day: number): string =>
  `2026-03-${String(day).padStart(2, '0')}T00:00:00.000Z`;

describe('groupStandaloneChatsIntoWorkEntries', () => {
  it('drops empty Work Entries the way desktop does, unless pinned or open', () => {
    // Desktop lists an entry only once it has a message, while it is pinned,
    // or while it is the one open; the wire marks a message by
    // `workEntryLastMessageAt`.
    const chats = [
      chat({
        localId: 'used',
        workEntryId: 'e1',
        workEntryLastMessageAt: DAY(2),
      }),
      chat({ localId: 'empty', workEntryId: 'e2' }),
      chat({ localId: 'pinned', workEntryId: 'e3', workEntryPinned: true }),
      chat({ localId: 'open', workEntryId: 'e4' }),
      chat({ localId: 'legacy' }),
    ];
    const ids = groupStandaloneChatsIntoWorkEntries(chats, {
      hideEmptyWorkEntries: { openChatId: 'open' },
    })
      .map((row) => row.workEntryId)
      .sort();
    expect(ids).toEqual(['e1', 'e3', 'e4', 'legacy']);
  });

  it('returns no rows for no chats', () => {
    expect(groupStandaloneChatsIntoWorkEntries([])).toEqual([]);
  });

  it('groups sibling chats of one Work Entry into a single row', () => {
    const rows = groupStandaloneChatsIntoWorkEntries([
      chat({ localId: 'a', workEntryId: 'entry-1', workEntryTitle: 'Plan' }),
      chat({ localId: 'b', workEntryId: 'entry-1', workEntryTitle: 'Plan' }),
      chat({ localId: 'c', workEntryId: 'entry-2', workEntryTitle: 'Ship' }),
    ]);

    expect(rows).toHaveLength(2);
    const plan = rows.find((row) => row.workEntryId === 'entry-1');
    expect(plan?.title).toBe('Plan');
    expect(plan?.hasWorkEntry).toBe(true);
    expect(plan?.chats.map((entry) => entry.localId)).toEqual(['a', 'b']);
  });

  it('keys entries per project so equal entry ids in two projects stay apart', () => {
    const rows = groupStandaloneChatsIntoWorkEntries([
      chat({ localId: 'a', projectLocalId: 'p1', workEntryId: 'entry' }),
      chat({ localId: 'b', projectLocalId: 'p2', workEntryId: 'entry' }),
    ]);

    expect(rows.map((row) => row.key).sort()).toEqual([
      'p1:entry:entry',
      'p2:entry:entry',
    ]);
  });

  it('falls back to the chat id when a chat carries no Work Entry', () => {
    const rows = groupStandaloneChatsIntoWorkEntries([
      chat({ localId: 'legacy-1', title: 'Old chat' }),
      chat({ localId: 'legacy-2', workEntryId: '' }),
    ]);

    expect(rows.map((row) => row.workEntryId).sort()).toEqual([
      'legacy-1',
      'legacy-2',
    ]);
    const legacy = rows.find((row) => row.workEntryId === 'legacy-1');
    expect(legacy?.hasWorkEntry).toBe(false);
    expect(legacy?.title).toBe('Old chat');
    expect(legacy?.targetChat.localId).toBe('legacy-1');
  });

  it('does not merge an entry id with an equal chat id', () => {
    const rows = groupStandaloneChatsIntoWorkEntries([
      chat({ localId: 'same' }),
      chat({ localId: 'other', workEntryId: 'same' }),
    ]);

    expect(rows).toHaveLength(2);
  });

  it('leaves archived chats out', () => {
    const rows = groupStandaloneChatsIntoWorkEntries([
      chat({ localId: 'a', workEntryId: 'e1', archived: true }),
      chat({ localId: 'b', workEntryId: 'e1' }),
      chat({ localId: 'c', workEntryId: 'e2', archived: true }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.chats.map((entry) => entry.localId)).toEqual(['b']);
  });

  it('ORs activity and unread across siblings and collects unread chats', () => {
    const [row] = groupStandaloneChatsIntoWorkEntries([
      chat({ localId: 'a', workEntryId: 'e1', hasUnread: true }),
      chat({ localId: 'b', workEntryId: 'e1', hasActiveChat: true }),
      chat({ localId: 'c', workEntryId: 'e1', hasUnread: true }),
    ]);

    expect(row?.hasActiveChat).toBe(true);
    expect(row?.hasUnread).toBe(true);
    expect(row?.unreadChats.map((entry) => entry.localId)).toEqual(['a', 'c']);
  });

  it('reports no activity and no unread when no sibling has them', () => {
    const [row] = groupStandaloneChatsIntoWorkEntries([
      chat({ localId: 'a', workEntryId: 'e1', hasUnread: false }),
    ]);

    expect(row?.hasActiveChat).toBe(false);
    expect(row?.hasUnread).toBe(false);
    expect(row?.unreadChats).toEqual([]);
  });

  it('targets the sibling with the newest activity', () => {
    const [row] = groupStandaloneChatsIntoWorkEntries([
      chat({ localId: 'a', workEntryId: 'e1', lastMessageAt: DAY(2) }),
      chat({ localId: 'b', workEntryId: 'e1', lastMessageAt: DAY(5) }),
      chat({ localId: 'c', workEntryId: 'e1', createdAt: DAY(4) }),
    ]);

    expect(row?.targetChat.localId).toBe('b');
  });

  it('targets the first sibling when none has a usable timestamp', () => {
    const [row] = groupStandaloneChatsIntoWorkEntries([
      chat({ localId: 'a', workEntryId: 'e1' }),
      chat({ localId: 'b', workEntryId: 'e1', lastMessageAt: 'garbage' }),
    ]);

    expect(row?.targetChat.localId).toBe('a');
  });

  it('titles an entry without a resolved title after its target chat', () => {
    const [row] = groupStandaloneChatsIntoWorkEntries([
      chat({ localId: 'a', workEntryId: 'e1', title: 'First' }),
      chat({
        localId: 'b',
        workEntryId: 'e1',
        title: 'Latest',
        lastMessageAt: DAY(3),
      }),
    ]);

    expect(row?.title).toBe('Latest');
  });

  it('takes the newest recency across the entry and its chats', () => {
    const [row] = groupStandaloneChatsIntoWorkEntries([
      chat({
        localId: 'a',
        workEntryId: 'e1',
        workEntryCreatedAt: DAY(1),
        workEntryLastMessageAt: DAY(3),
        workEntryLastTouchedAt: DAY(2),
        lastMessageAt: DAY(3),
      }),
      chat({ localId: 'b', workEntryId: 'e1', lastMessageAt: DAY(6) }),
    ]);

    expect(row?.createdAt).toBe(DAY(1));
    expect(row?.lastMessageAt).toBe(DAY(6));
    expect(row?.lastTouchedAt).toBe(DAY(2));
  });

  it('folds entry timestamps across siblings, not from the first chat', () => {
    const [row] = groupStandaloneChatsIntoWorkEntries([
      chat({
        localId: 'stale',
        workEntryId: 'e1',
        workEntryLastMessageAt: DAY(1),
        workEntryLastTouchedAt: DAY(1),
      }),
      chat({
        localId: 'fresh',
        workEntryId: 'e1',
        workEntryLastMessageAt: DAY(7),
        workEntryLastTouchedAt: DAY(8),
      }),
    ]);

    expect(row?.lastMessageAt).toBe(DAY(7));
    expect(row?.lastTouchedAt).toBe(DAY(8));
  });

  it('does not let a stale first sibling sink a recently active entry', () => {
    const rows = groupStandaloneChatsIntoWorkEntries(
      [
        chat({
          localId: 'other',
          workEntryId: 'other',
          workEntryOrder: 0,
          workEntryLastTouchedAt: DAY(5),
        }),
        chat({
          localId: 'stale',
          workEntryId: 'active',
          workEntryOrder: 1,
          workEntryLastTouchedAt: DAY(1),
        }),
        chat({
          localId: 'fresh',
          workEntryId: 'active',
          workEntryOrder: 1,
          workEntryLastTouchedAt: DAY(9),
        }),
      ],
      { mode: 'last-updated' },
    );

    expect(rows.map((row) => row.workEntryId)).toEqual(['active', 'other']);
  });

  it('floors a legacy entry at its earliest chat creation time', () => {
    const [row] = groupStandaloneChatsIntoWorkEntries([
      chat({ localId: 'a', createdAt: DAY(4) }),
    ]);

    expect(row?.createdAt).toBe(DAY(4));
    expect(row?.lastMessageAt).toBeUndefined();
  });

  it('carries the entry pin, done status, and order', () => {
    const [row] = groupStandaloneChatsIntoWorkEntries([
      chat({ localId: 'a', workEntryId: 'e1' }),
      chat({
        localId: 'b',
        workEntryId: 'e1',
        workEntryPinned: true,
        workEntryStatus: 'done',
        workEntryOrder: 4,
      }),
    ]);

    expect(row?.pinned).toBe(true);
    expect(row?.status).toBe('done');
    expect(row?.order).toBe(4);
  });

  it('defaults an entry to unpinned and active', () => {
    const [row] = groupStandaloneChatsIntoWorkEntries([
      chat({ localId: 'a', workEntryId: 'e1' }),
    ]);

    expect(row?.pinned).toBe(false);
    expect(row?.status).toBe('active');
  });

  describe('ordering', () => {
    const chats: GroupableStandaloneChat[] = [
      chat({
        localId: 'old-chat',
        workEntryId: 'old',
        workEntryOrder: 0,
        workEntryCreatedAt: DAY(1),
        lastMessageAt: DAY(2),
      }),
      chat({
        localId: 'recent-chat',
        workEntryId: 'recent',
        workEntryOrder: 2,
        workEntryCreatedAt: DAY(1),
        lastMessageAt: DAY(9),
      }),
      chat({
        localId: 'pinned-chat',
        workEntryId: 'pinned',
        workEntryOrder: 1,
        workEntryPinned: true,
        workEntryCreatedAt: DAY(1),
        lastMessageAt: DAY(1),
      }),
    ];

    it('defaults to pinned first, then the persisted manual order', () => {
      expect(
        groupStandaloneChatsIntoWorkEntries(chats).map(
          (row) => row.workEntryId,
        ),
      ).toEqual(['pinned', 'old', 'recent']);
    });

    it('orders pinned first, then most recent first in last-updated mode', () => {
      expect(
        groupStandaloneChatsIntoWorkEntries(chats, {
          mode: 'last-updated',
        }).map((row) => row.workEntryId),
      ).toEqual(['pinned', 'recent', 'old']);
    });

    it('orders by the persisted order in manual mode, pinned first', () => {
      expect(
        groupStandaloneChatsIntoWorkEntries(chats, { mode: 'manual' }).map(
          (row) => row.workEntryId,
        ),
      ).toEqual(['pinned', 'old', 'recent']);
    });

    it('breaks manual order ties toward the newer entry', () => {
      const rows = groupStandaloneChatsIntoWorkEntries(
        [
          chat({
            localId: 'a',
            workEntryId: 'older',
            workEntryOrder: 0,
            workEntryCreatedAt: DAY(1),
          }),
          chat({
            localId: 'b',
            workEntryId: 'newer',
            workEntryOrder: 0,
            workEntryCreatedAt: DAY(5),
          }),
        ],
        { mode: 'manual' },
      );

      expect(rows.map((row) => row.workEntryId)).toEqual(['newer', 'older']);
    });

    it('places entries without an order after ordered ones, in input order', () => {
      const rows = groupStandaloneChatsIntoWorkEntries(
        [
          chat({ localId: 'x' }),
          chat({ localId: 'y' }),
          chat({ localId: 'z', workEntryId: 'ordered', workEntryOrder: 3 }),
        ],
        { mode: 'manual' },
      );

      expect(rows.map((row) => row.workEntryId)).toEqual(['ordered', 'x', 'y']);
    });

    it('falls back to manual order for equal recency', () => {
      const rows = groupStandaloneChatsIntoWorkEntries([
        chat({
          localId: 'a',
          workEntryId: 'second',
          workEntryOrder: 1,
          lastMessageAt: DAY(3),
        }),
        chat({
          localId: 'b',
          workEntryId: 'first',
          workEntryOrder: 0,
          lastMessageAt: DAY(3),
        }),
      ]);

      expect(rows.map((row) => row.workEntryId)).toEqual(['first', 'second']);
    });
  });
});
