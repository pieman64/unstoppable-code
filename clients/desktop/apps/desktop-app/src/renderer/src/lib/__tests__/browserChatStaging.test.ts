/**
 * @jest-environment jsdom
 */
import {
  stageBrowserRecording,
  stageBrowserDownload,
  stageBrowserScreenshot,
} from '../browserChatStaging';
import {
  addPendingAttachmentsAndRefreshIndex,
  importChatAttachments,
  resolveActiveEditableChatTarget,
} from '@/lib/chatAttachments';
import { useGitHubStore } from '@/stores/githubStore';

jest.mock('@/lib/chatAttachments', () => ({
  addPendingAttachmentsAndRefreshIndex: jest.fn(),
  importChatAttachments: jest.fn(),
  resolveActiveEditableChatTarget: jest.fn(),
}));

jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: jest.fn(),
  },
}));

const addPendingAttachmentsAndRefreshIndexMock = jest.mocked(
  addPendingAttachmentsAndRefreshIndex,
);
const importChatAttachmentsMock = jest.mocked(importChatAttachments);
const resolveActiveEditableChatTargetMock = jest.mocked(
  resolveActiveEditableChatTarget,
);
const useGitHubStoreMock = jest.mocked(useGitHubStore.getState);

class TestTextEncoder {
  encode(value: string): Uint8Array {
    return Uint8Array.from(
      Array.from(value, (char: string) => char.charCodeAt(0)),
    );
  }
}

Object.assign(globalThis, { TextEncoder: TestTextEncoder });

describe('browserChatStaging', () => {
  const addToast = jest.fn();
  const pendingTarget = {
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    tabId: 'tab-1',
  };
  const target = {
    projectId: 'project-1',
    worktreeId: 'worktree-1',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    useGitHubStoreMock.mockReturnValue({ addToast } as unknown as ReturnType<
      typeof useGitHubStore.getState
    >);
    resolveActiveEditableChatTargetMock.mockReturnValue(pendingTarget);
  });

  it('imports screenshots into chat-owned storage before staging', async () => {
    importChatAttachmentsMock.mockResolvedValue([
      {
        filename: 'browser-screenshot-chat-copy.png',
        absolutePath:
          '/tmp/worktree/.canopy/attachments/browser-screenshot-chat-copy.png',
      },
    ]);

    const result = await stageBrowserScreenshot(
      '/tmp/worktree/.canopy/attachments/browser-screenshot.png',
    );

    expect(result).toBe(true);
    expect(importChatAttachmentsMock).toHaveBeenCalledWith(target, [
      '/tmp/worktree/.canopy/attachments/browser-screenshot.png',
    ]);
    expect(addPendingAttachmentsAndRefreshIndexMock).toHaveBeenCalledWith(
      target,
      [
        {
          filename: 'browser-screenshot-chat-copy.png',
          absolutePath:
            '/tmp/worktree/.canopy/attachments/browser-screenshot-chat-copy.png',
          promptKind: 'in-app-browser-resource',
        },
      ],
      undefined,
      pendingTarget,
    );
  });

  it('imports a finished download into chat-owned storage and stages it', async () => {
    importChatAttachmentsMock.mockResolvedValue([
      {
        filename: 'report.csv',
        absolutePath: '/tmp/worktree/.canopy/attachments/report.csv',
      },
    ]);

    const result = await stageBrowserDownload(
      '/data/browser-files/downloads/report.csv',
      'report.csv',
    );

    expect(result).toBe(true);
    expect(importChatAttachmentsMock).toHaveBeenCalledWith(target, [
      '/data/browser-files/downloads/report.csv',
    ]);
    expect(addPendingAttachmentsAndRefreshIndexMock).toHaveBeenCalledWith(
      target,
      [
        {
          filename: 'report.csv',
          absolutePath: '/tmp/worktree/.canopy/attachments/report.csv',
          promptKind: 'in-app-browser-resource',
        },
      ],
      undefined,
      pendingTarget,
    );
    expect(addToast).toHaveBeenCalledWith(
      'report.csv attached to chat draft.',
      'success',
    );
  });

  it('says so when no chat can take the download', async () => {
    resolveActiveEditableChatTargetMock.mockReturnValue(null);

    await expect(
      stageBrowserDownload('/data/report.csv', 'report.csv'),
    ).resolves.toBe(false);
    expect(importChatAttachmentsMock).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith(
      'Unable to attach to this chat.',
      'error',
    );
  });

  it('marks staged browser markdown attachments as in-app browser resources', async () => {
    importChatAttachmentsMock.mockResolvedValue([
      {
        filename: 'browser-recording-20260602-120000.md',
        absolutePath:
          '/tmp/worktree/.canopy/attachments/browser-recording-20260602-120000.md',
      },
    ]);

    const result = await stageBrowserRecording({
      browserId: 'browser-1',
      recording: false,
      steps: [],
      playwrightScript: "await page.goto('http://localhost:3000');",
    });

    expect(result).toBe(true);
    expect(addPendingAttachmentsAndRefreshIndexMock).toHaveBeenCalledWith(
      target,
      [
        {
          filename: 'browser-recording-20260602-120000.md',
          absolutePath:
            '/tmp/worktree/.canopy/attachments/browser-recording-20260602-120000.md',
          promptKind: 'in-app-browser-resource',
        },
      ],
      undefined,
      pendingTarget,
    );
  });
});
