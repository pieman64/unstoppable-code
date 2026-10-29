/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatStateRecoveryBanner } from '../ChatStateRecoveryBanner';

const mockState = {
  chatStateSync: {},
  chatStateNotices: {
    'project-1/worktree-1': {
      kind: 'command_failed',
      message: 'Could not read /Users/me/secret-repo/.canopy/chat.json',
    },
  },
  retryChatStateRefresh: jest.fn(),
  dismissChatStateNotice: jest.fn(),
};

jest.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: typeof mockState) => unknown): unknown =>
    selector(mockState),
}));

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));

describe('ChatStateRecoveryBanner', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows the recovery error message in the command-failed notice', () => {
    act(() => {
      root.render(
        <ChatStateRecoveryBanner
          projectId="project-1"
          worktreeId="worktree-1"
        />,
      );
    });

    const message = Array.from(container.querySelectorAll('*')).find(
      (node) =>
        node.children.length === 0 &&
        node.textContent ===
          'Could not read /Users/me/secret-repo/.canopy/chat.json',
    );
    expect(message).toBeDefined();
    const notice = container.querySelector(
      '[data-testid="chat-state-command-failed-notice"]',
    );
    expect(notice).not.toBeNull();
  });
});
