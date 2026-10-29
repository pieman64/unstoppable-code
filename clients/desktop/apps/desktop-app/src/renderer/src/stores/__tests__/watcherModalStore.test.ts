import { useWatcherModalStore } from '@/stores/watcherModalStore';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';

const holdMock = jest.fn();
const releaseMock = jest.fn();

beforeEach(() => {
  holdMock.mockClear();
  releaseMock.mockClear();
  useAppAdvisorWatchersStore.setState({
    holdChatFiring: holdMock,
    releaseChatFiring: releaseMock,
  });
  useWatcherModalStore.setState({ target: null });
});

const target = { projectId: 'p', worktreeId: 'w', chatId: 'c' };

describe('watcherModalStore', () => {
  it('open holds firing for the chat and sets the target', () => {
    useWatcherModalStore.getState().open(target);
    expect(holdMock).toHaveBeenCalledWith({ scope: 'worktree', ...target });
    expect(useWatcherModalStore.getState().target).toEqual(target);
  });

  it('close releases firing and clears the target', () => {
    useWatcherModalStore.getState().open(target);
    releaseMock.mockClear();
    useWatcherModalStore.getState().close();
    expect(releaseMock).toHaveBeenCalledWith({ scope: 'worktree', ...target });
    expect(useWatcherModalStore.getState().target).toBeNull();
  });

  it('switching to another chat releases the prior hold then holds the new one', () => {
    useWatcherModalStore.getState().open(target);
    holdMock.mockClear();
    releaseMock.mockClear();

    const next = { projectId: 'p', worktreeId: 'w', chatId: 'c2' };
    useWatcherModalStore.getState().open(next);

    expect(releaseMock).toHaveBeenCalledWith({ scope: 'worktree', ...target });
    expect(holdMock).toHaveBeenCalledWith({ scope: 'worktree', ...next });
  });

  it('re-opening the same chat does not release its hold', () => {
    useWatcherModalStore.getState().open(target);
    releaseMock.mockClear();
    useWatcherModalStore.getState().open(target);
    expect(releaseMock).not.toHaveBeenCalled();
  });
});
