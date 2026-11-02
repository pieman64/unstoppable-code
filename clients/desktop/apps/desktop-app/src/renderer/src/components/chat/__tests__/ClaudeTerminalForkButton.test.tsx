/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyApi } from '@canopy/desktop-shared/types';
import { ClaudeTerminalForkButton } from '../ClaudeTerminalForkButton';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';

type ForkOptions = {
  includeActiveTurn: boolean;
  sourceSdkSessionId: string;
  syncWarning?: string;
};

const forkTabMock = jest.fn<
  void,
  [string, { projectId: string; worktreeId: string }, ForkOptions]
>();
const handleChatEventMock = jest.fn<void, [unknown]>();

jest.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: unknown) => unknown): unknown =>
    selector({
      forkTab: forkTabMock,
      handleChatEvent: handleChatEventMock,
    }),
}));

jest.mock('@/lib/renderer-error-logging', () => ({
  reportRendererConsoleError: jest.fn(),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('ClaudeTerminalForkButton', () => {
  let root: Root;
  let container: HTMLDivElement;
  let syncTranscriptMock: jest.Mock;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    forkTabMock.mockReset();
    handleChatEventMock.mockReset();
    jest.mocked(reportRendererConsoleError).mockReset();
    syncTranscriptMock = jest.fn().mockResolvedValue({
      chatId: 'chat-1',
      importedEventCount: 1,
      event: {
        type: 'claude_terminal_transcript_sync',
        messages: [],
        importedEventCount: 1,
      },
    });
    const partialApi: Partial<CanopyApi> = {};
    Object.assign(partialApi, {
      claudeTerminal: {
        syncTranscript: syncTranscriptMock,
      },
    });
    // This surface only calls claudeTerminal.syncTranscript; the remaining
    // CanopyApi methods are intentionally absent from the test double.
    window.api = partialApi as CanopyApi;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('syncs the terminal transcript before opening the forked chat', async () => {
    act(() => {
      root.render(
        createElement(ClaudeTerminalForkButton, {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          sdkSessionId: 'session-1',
        }),
      );
    });

    await act(async () => {
      container
        .querySelector('button')
        ?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
      await Promise.resolve();
    });

    expect(syncTranscriptMock).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    });
    expect(handleChatEventMock).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      data: {
        type: 'claude_terminal_transcript_sync',
        messages: [],
        importedEventCount: 1,
      },
    });
    expect(forkTabMock).toHaveBeenCalledWith(
      'chat-1',
      { projectId: 'project-1', worktreeId: 'worktree-1' },
      { includeActiveTurn: true, sourceSdkSessionId: 'session-1' },
    );
    expect(syncTranscriptMock.mock.invocationCallOrder[0]).toBeLessThan(
      forkTabMock.mock.invocationCallOrder[0],
    );
  });

  it('still forks with a warning when transcript sync rejects', async () => {
    syncTranscriptMock.mockRejectedValue(new Error('sync failed'));
    act(() => {
      root.render(
        createElement(ClaudeTerminalForkButton, {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          sdkSessionId: 'session-1',
        }),
      );
    });

    await act(async () => {
      container
        .querySelector('button')
        ?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
      await Promise.resolve();
    });

    expect(handleChatEventMock).not.toHaveBeenCalled();
    const errorCall = jest.mocked(reportRendererConsoleError).mock.calls[0];
    expect(errorCall?.[0]).toBe(
      'Claude terminal pre-fork transcript sync failed',
    );
    expect(
      (errorCall?.[1] as { error?: unknown } | undefined)?.error,
    ).toBeInstanceOf(Error);
    const forkCall = forkTabMock.mock.calls[0];
    expect(forkCall?.[0]).toBe('chat-1');
    expect(forkCall?.[1]).toEqual({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    expect(forkCall?.[2].includeActiveTurn).toBe(true);
    expect(forkCall?.[2].sourceSdkSessionId).toBe('session-1');
    expect(forkCall?.[2].syncWarning).toContain('Transcript sync failed');
  });

  it('applies returned sync events before forking when sync returns errors', async () => {
    syncTranscriptMock.mockResolvedValue({
      chatId: 'chat-1',
      importedEventCount: 1,
      errors: ['Claude Code terminal session is not running.'],
      event: {
        type: 'claude_terminal_transcript_sync',
        messages: [
          {
            id: 'message-1',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Synced output' }],
            timestamp: 1,
          },
        ],
        importedEventCount: 1,
      },
    });
    act(() => {
      root.render(
        createElement(ClaudeTerminalForkButton, {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          sdkSessionId: 'session-1',
        }),
      );
    });

    await act(async () => {
      container
        .querySelector('button')
        ?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
      await Promise.resolve();
    });

    expect(handleChatEventMock).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      data: {
        type: 'claude_terminal_transcript_sync',
        messages: [
          {
            id: 'message-1',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Synced output' }],
            timestamp: 1,
          },
        ],
        importedEventCount: 1,
      },
    });
    expect(jest.mocked(reportRendererConsoleError)).toHaveBeenCalledWith(
      'Claude terminal pre-fork transcript sync returned errors',
      { errors: ['Claude Code terminal session is not running.'] },
    );
    const forkCall = forkTabMock.mock.calls[0];
    expect(forkCall?.[0]).toBe('chat-1');
    expect(forkCall?.[1]).toEqual({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    expect(forkCall?.[2].includeActiveTurn).toBe(true);
    expect(forkCall?.[2].sourceSdkSessionId).toBe('session-1');
    expect(forkCall?.[2].syncWarning).toContain('Transcript sync failed');
  });

  it('forks without handling a chat event when sync returns no event', async () => {
    syncTranscriptMock.mockResolvedValue({
      chatId: 'chat-1',
      importedEventCount: 0,
    });
    act(() => {
      root.render(
        createElement(ClaudeTerminalForkButton, {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          sdkSessionId: 'session-1',
        }),
      );
    });

    await act(async () => {
      container
        .querySelector('button')
        ?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
      await Promise.resolve();
    });

    expect(handleChatEventMock).not.toHaveBeenCalled();
    expect(forkTabMock).toHaveBeenCalledWith(
      'chat-1',
      { projectId: 'project-1', worktreeId: 'worktree-1' },
      { includeActiveTurn: true, sourceSdkSessionId: 'session-1' },
    );
  });

  it('ignores a rapid second click before busy state renders', async () => {
    let resolveSync:
      | ((value: { chatId: string; importedEventCount: number }) => void)
      | undefined;
    syncTranscriptMock.mockReturnValue(
      new Promise((resolve) => {
        resolveSync = resolve;
      }),
    );
    act(() => {
      root.render(
        createElement(ClaudeTerminalForkButton, {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          sdkSessionId: 'session-1',
        }),
      );
    });

    const button = container.querySelector('button');
    act(() => {
      button?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      button?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });

    expect(syncTranscriptMock).toHaveBeenCalledTimes(1);
    expect(forkTabMock).not.toHaveBeenCalled();

    await act(async () => {
      resolveSync?.({ chatId: 'chat-1', importedEventCount: 0 });
      await Promise.resolve();
    });

    expect(forkTabMock).toHaveBeenCalledTimes(1);
  });

  it('clears busy state even when forkTab throws', async () => {
    forkTabMock
      .mockImplementationOnce(() => {
        throw new Error('fork failed');
      })
      .mockImplementationOnce(() => undefined);
    syncTranscriptMock.mockResolvedValue({
      chatId: 'chat-1',
      importedEventCount: 0,
    });
    act(() => {
      root.render(
        createElement(ClaudeTerminalForkButton, {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          sdkSessionId: 'session-1',
        }),
      );
    });

    await act(async () => {
      container
        .querySelector('button')
        ?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector('button')
        ?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
      await Promise.resolve();
    });

    expect(forkTabMock).toHaveBeenCalledTimes(2);
    const errorCall = jest
      .mocked(reportRendererConsoleError)
      .mock.calls.find(
        ([message]) => message === 'Claude terminal fork failed',
      );
    expect(
      (errorCall?.[1] as { error?: unknown } | undefined)?.error,
    ).toBeInstanceOf(Error);
  });
});
