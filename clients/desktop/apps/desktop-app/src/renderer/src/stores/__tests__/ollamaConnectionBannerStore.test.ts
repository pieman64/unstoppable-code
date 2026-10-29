import {
  useOllamaConnectionBannerStore,
  useOllamaConnectionUnavailable,
} from '../ollamaConnectionBannerStore';

const TARGET = { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' };

describe('ollamaConnectionBannerStore', () => {
  beforeEach(() => {
    useOllamaConnectionBannerStore.setState({ unavailableByChat: {} });
  });

  it('tracks unavailable state independently by chat target', () => {
    useOllamaConnectionBannerStore.getState().showUnavailable(TARGET);

    expect(
      useOllamaConnectionBannerStore.getState().unavailableByChat[
        'project/worktree/chat'
      ],
    ).toBe(true);
    expect(
      useOllamaConnectionBannerStore.getState().unavailableByChat[
        'project/worktree/other'
      ],
    ).toBeUndefined();
  });

  it('clears the warning for the next send attempt', () => {
    useOllamaConnectionBannerStore.getState().showUnavailable(TARGET);
    useOllamaConnectionBannerStore.getState().clearUnavailable(TARGET);

    expect(
      useOllamaConnectionBannerStore.getState().unavailableByChat[
        'project/worktree/chat'
      ],
    ).toBeUndefined();
  });

  it('exports the reactive selector hook', () => {
    expect(typeof useOllamaConnectionUnavailable).toBe('function');
  });
});
