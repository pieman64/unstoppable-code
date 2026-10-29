/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { registerCoworkWorkspaceIds } from '@/lib/cowork-registry';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { ForkedFromLink } from '../ForkedFromLink';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('ForkedFromLink', () => {
  let container: HTMLDivElement;
  let root: Root;
  const initialStandaloneState = useStandaloneChatStore.getState();

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    registerCoworkWorkspaceIds(['cowork-workspace-1']);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    registerCoworkWorkspaceIds([]);
    useStandaloneChatStore.setState(initialStandaloneState, true);
  });

  it('switches with the Cowork project id and resolves live or archived chats', async () => {
    const switchChatProject = jest.fn(() => Promise.resolve(true));
    const selectChat = jest.fn(() => Promise.resolve());
    useStandaloneChatStore.setState({
      activeChatProjectId: 'another-workspace',
      switchChatProject,
      selectChat,
    });

    act(() => {
      root.render(
        <ForkedFromLink
          forkedFrom={{
            projectId: 'cowork-workspace-1',
            worktreeId: 'entry-1',
            chatId: 'chat-1',
          }}
        />,
      );
    });
    await act(async () => {
      container.querySelector('button')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(switchChatProject).toHaveBeenCalledWith('cowork-workspace-1');
    expect(selectChat).toHaveBeenCalledWith('chat-1');
  });

  it('labels a same-harness fork as a plain fork', () => {
    act(() => {
      root.render(
        <ForkedFromLink
          forkedFrom={{
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'chat-1',
          }}
        />,
      );
    });

    expect(container.textContent).toBe('Forked from conversation');
  });

  it('discloses a cross-harness continue as summary-only', () => {
    // This divider IS the disclosure that everything above it reached the new
    // provider as a summary rather than verbatim, so the copy is load-bearing.
    act(() => {
      root.render(
        <ForkedFromLink
          forkedFrom={{
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'chat-1',
            continuedFromProvider: 'claude',
          }}
        />,
      );
    });

    expect(container.textContent).toBe('Continued from Claude, summary only');
  });

  it('discloses a fork that could not carry the provider session', () => {
    // A fork taken at an earlier turn of a legacy transcript has no chain
    // entry to resume at, so the agent really does start with no context.
    // Nothing else in the transcript says so.
    act(() => {
      root.render(
        <ForkedFromLink
          forkedFrom={{
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'chat-1',
            modelContext: 'fresh',
          }}
        />,
      );
    });

    const notice = container.querySelector(
      '[data-testid="fork-fresh-context-notice"]',
    );
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain(
      "The agent can't see the messages above",
    );
  });

  it('renders no fresh-context notice on an ordinary fork', () => {
    act(() => {
      root.render(
        <ForkedFromLink
          forkedFrom={{
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'chat-1',
          }}
        />,
      );
    });

    expect(
      container.querySelector('[data-testid="fork-fresh-context-notice"]'),
    ).toBeNull();
  });
});
