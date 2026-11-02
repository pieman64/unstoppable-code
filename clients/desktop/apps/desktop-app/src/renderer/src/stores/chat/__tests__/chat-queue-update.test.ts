import type { ChatQueueUpdatedEvent } from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';
import { selectRestartHeldByBackgroundWork } from '../queue-mirror';
import { fromPersistedTab } from '../persisted-tabs';

const PROJECT_ID = 'background-work-held-project';
const WORKTREE_ID = 'background-work-held-worktree';
const CHAT_ID = 'background-work-held-chat';
const OTHER_CHAT_ID = 'background-work-held-other-chat';
const WORKTREE_KEY = `${PROJECT_ID}/${WORKTREE_ID}`;

function queueUpdate(
  chatId: string,
  restartHeldByBackgroundWork?: true,
): ChatQueueUpdatedEvent & { restartHeldByBackgroundWork?: true } {
  return {
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    chatId,
    queue: [],
    ...(restartHeldByBackgroundWork
      ? { restartHeldByBackgroundWork: true }
      : {}),
  };
}

describe('chat queue update host summary', () => {
  beforeEach(() => {
    const tabs = [CHAT_ID, OTHER_CHAT_ID].map((id) =>
      fromPersistedTab({
        id,
        title: `Chat ${id}`,
        messages: [],
        createdAt: '2026-10-16T00:00:00.000Z',
      }),
    );
    useChatStore.setState({
      worktreeChats: {
        [WORKTREE_KEY]: { tabs, activeTabId: CHAT_ID },
      },
    });
  });

  afterEach(() => {
    useChatStore.setState({ worktreeChats: {} });
  });

  it('sets and clears the restart-held summary for only the updated chat', () => {
    useChatStore.getState().handleChatQueueUpdated(queueUpdate(CHAT_ID, true));

    let tabs = useChatStore.getState().worktreeChats[WORKTREE_KEY]?.tabs;
    expect(tabs?.[0]).toEqual(
      expect.objectContaining({ restartHeldByBackgroundWork: true }),
    );
    expect(tabs?.[1]).not.toHaveProperty('restartHeldByBackgroundWork');
    expect(
      selectRestartHeldByBackgroundWork(
        useChatStore.getState(),
        PROJECT_ID,
        WORKTREE_ID,
        CHAT_ID,
      ),
    ).toBe(true);
    expect(
      selectRestartHeldByBackgroundWork(
        useChatStore.getState(),
        PROJECT_ID,
        WORKTREE_ID,
        OTHER_CHAT_ID,
      ),
    ).toBe(false);

    useChatStore.getState().handleChatQueueUpdated(queueUpdate(CHAT_ID));

    tabs = useChatStore.getState().worktreeChats[WORKTREE_KEY]?.tabs;
    expect(tabs?.[0]).not.toHaveProperty('restartHeldByBackgroundWork');
    expect(tabs?.[1]).not.toHaveProperty('restartHeldByBackgroundWork');
    expect(
      selectRestartHeldByBackgroundWork(
        useChatStore.getState(),
        PROJECT_ID,
        WORKTREE_ID,
        CHAT_ID,
      ),
    ).toBe(false);
  });
});
