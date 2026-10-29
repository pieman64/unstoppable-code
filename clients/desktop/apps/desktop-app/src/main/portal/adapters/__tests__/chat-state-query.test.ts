import type {
  ChatStateCommandPort,
  ChatStateSnapshot,
} from '@canopy/desktop-shared/types';
import { createDesktopRuntime } from '../../../canopy-runtime/desktop-runtime';
import { queryPortalChatState } from '../chat-state-query';
import type { PortalAdapterContext } from '../types';

const snapshot: ChatStateSnapshot = {
  schemaVersion: 1,
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  revision: 3,
  tabsFile: { version: 1, activeTabId: '', tabs: [] },
  archives: [],
  runtimeByChatId: {},
  queue: [],
};

describe('Portal chat snapshot query', () => {
  it('uses the active dispatcher and preserves the legacy snapshot', async () => {
    const getState = jest.fn().mockResolvedValue(snapshot);
    const port: ChatStateCommandPort = {
      getState,
      getTranscriptPage: jest.fn(),
      searchTranscript: jest.fn(),
      readToolOutput: jest.fn(),
      command: jest.fn(),
      subscribe: jest.fn().mockReturnValue(() => undefined),
    };
    const runtime = createDesktopRuntime({ getChatStatePort: () => port });
    const context: PortalAdapterContext = {
      sessionId: 'session-1',
      getWindow: () => null,
      enqueueEvent: jest.fn(),
      complete: jest.fn(),
      fail: jest.fn(),
    };
    await expect(
      queryPortalChatState(context, {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      }),
    ).resolves.toBe(snapshot);
    expect(getState).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    await runtime.shutdown();
  });
});
