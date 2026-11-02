import { createEmptyTab } from '@/stores/chat/tab-utils';
import { useChatStore } from '@/stores/chatStore';
import { buildWorkEntryUnreadRows } from '@/components/sidebar/SidebarCoworkWorkspaceRow';
import { buildChatPreviewRows } from '../worktreeRowPreviewRows';

// Hosts set `markedUnread`; the shared popover owns the "Marked as unread" copy.
describe('markedUnread on unread preview rows', () => {
  const initial = useChatStore.getState();

  afterEach(() => {
    useChatStore.setState(initial, true);
  });

  function seedLoadedTabs(key: string): void {
    useChatStore.setState({
      worktreeChats: {
        [key]: {
          tabs: [
            {
              ...createEmptyTab(),
              id: 'manual',
              unread: true,
              unreadMarkedManually: true,
            },
            { ...createEmptyTab(), id: 'automatic', unread: true },
            {
              ...createEmptyTab(),
              id: 'stale',
              unread: false,
              unreadMarkedManually: true,
            },
          ],
          activeTabId: 'automatic',
        },
      },
    });
  }

  function markedIds(
    rows: { chatId: string; markedUnread?: boolean }[],
  ): string[] {
    return rows
      .filter((row) => row.markedUnread === true)
      .map((row) => row.chatId);
  }

  it('flags only manually marked unread chats from loaded tabs', () => {
    seedLoadedTabs('proj/wt');
    const rows = buildChatPreviewRows('proj/wt', 'unread');
    expect(rows.map((row) => row.chatId)).toEqual(['manual', 'automatic']);
    expect(markedIds(rows)).toEqual(['manual']);
  });

  it('flags persisted badge refs that carry markedUnread', () => {
    useChatStore.setState({
      persistedWorktreeBadges: {
        'proj/wt': {
          version: 2,
          approvalChats: [],
          needsHydration: true,
          updatedAt: '2026-10-26T00:00:00.000Z',
          unreadChats: [
            { chatId: 'manual', markedUnread: true, preview: 'Old reply' },
            { chatId: 'automatic', preview: 'New reply' },
          ],
        },
      },
    });
    expect(markedIds(buildChatPreviewRows('proj/wt', 'unread'))).toEqual([
      'manual',
    ]);
  });

  it('flags the Work Entry rows the same way', () => {
    seedLoadedTabs('ws/entry');
    const entry = {
      id: 'entry',
      title: 'Entry',
      createdAt: '2026-10-26T00:00:00.000Z',
      chatCount: 3,
      unreadChats: [{ chatId: 'persisted', markedUnread: true }],
    };
    expect(markedIds(buildWorkEntryUnreadRows('ws/entry', entry))).toEqual([
      'manual',
    ]);
    expect(markedIds(buildWorkEntryUnreadRows('ws/unloaded', entry))).toEqual([
      'persisted',
    ]);
  });
});
