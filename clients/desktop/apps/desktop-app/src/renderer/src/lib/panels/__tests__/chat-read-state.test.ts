import {
  APP_ADVISOR_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { createEmptyTab } from '@/stores/chat/tab-utils';
import { useChatStore } from '@/stores/chatStore';
import { chatReadStateServices } from '../chat-read-state';

describe('chatReadStateServices', () => {
  const initial = useChatStore.getState();

  beforeEach(() => {
    const read = { ...createEmptyTab(), id: 'chat-read' };
    const unread = { ...createEmptyTab(), id: 'chat-unread', unread: true };
    useChatStore.setState({
      worktreeChats: {
        'proj/wt': { tabs: [read, unread], activeTabId: 'chat-read' },
      },
    });
  });

  afterEach(() => {
    useChatStore.setState(initial, true);
  });

  it('reports each chat tab’s read state, and nothing for unknown ids', () => {
    const services = chatReadStateServices('proj', 'wt');
    expect(services?.getChatReadState('chat-read')).toBe('read');
    expect(services?.getChatReadState('chat-unread')).toBe('unread');
    expect(services?.getChatReadState('missing')).toBeUndefined();
  });

  it('routes the menu choice to the store action', () => {
    const setChatUnread = jest.fn();
    useChatStore.setState({ setChatUnread });
    chatReadStateServices('proj', 'wt')?.onSetChatUnread('chat-read', true);
    expect(setChatUnread).toHaveBeenCalledWith('proj', 'wt', 'chat-read', true);
  });

  it('offers nothing for embedded chat scopes', () => {
    expect(chatReadStateServices(APP_ADVISOR_PROJECT_ID, 'wt')).toBeUndefined();
    expect(
      chatReadStateServices(PIPELINE_EDITOR_PROJECT_ID, 'wt'),
    ).toBeUndefined();
  });
});
