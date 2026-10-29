/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  OpenTurnFileRequest,
  ShowFilesRendererResult,
} from '@canopy/desktop-shared/types';
import { TurnFileChip } from '../TurnFiles';
import { showFilesInRenderer } from '@/lib/show-files';

jest.mock('@/lib/show-files', () => ({ showFilesInRenderer: jest.fn() }));
jest.mock('@/stores/chat/surface', () => ({
  detectChatStoreSurface: (): string => 'app-advisor',
}));
jest.mock('@/stores/chatStore', () => ({
  useChatStore: { subscribe: jest.fn(() => jest.fn()) },
}));
jest.mock('@/stores/browserStore', () => ({
  useBrowserStore: { subscribe: jest.fn(() => jest.fn()) },
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

async function flush(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

it.each(['md', 'html'])(
  'opens an App Advisor %s deliverable in the explicitly selected workspace',
  async (extension) => {
    let closed: (requestId: string) => void = () => {};
    const dispose = jest.fn();
    const openWindow = jest
      .fn()
      .mockResolvedValue({ open: true, focused: true });
    const openTurnFile = jest
      .fn<Promise<ShowFilesRendererResult>, [OpenTurnFileRequest]>()
      .mockResolvedValue({
        opened: 1,
        failed: 0,
        files: [
          {
            path: `/project/report.${extension}`,
            ok: true,
            ...(extension === 'html'
              ? { browserId: 'browser-page' }
              : { tabId: 'file-tab' }),
          },
        ],
      });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        appAdvisor: {
          openTurnFile,
          openWindow,
          onTurnFileClosed: (listener: typeof closed) => {
            closed = listener;
            return dispose;
          },
        },
      },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await flush(() =>
      root.render(
        <TurnFileChip
          path={`/project/report.${extension}`}
          target={{ projectId: 'project', worktreeId: 'worktree' }}
          projectId="app-advisor"
          worktreeId="global"
          chatId="chat"
        />,
      ),
    );
    const button = container.querySelector<HTMLButtonElement>(
      `[aria-label="Open report.${extension}"]`,
    );
    if (!button) throw new Error('Missing file tile');
    button.focus();
    await flush(() => button.click());

    expect(openTurnFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: `/project/report.${extension}`,
        target: { projectId: 'project', worktreeId: 'worktree' },
        origin: {
          projectId: 'app-advisor',
          worktreeId: 'global',
          chatTabId: 'chat',
        },
      }),
    );
    await flush(() => button.click());
    expect(openTurnFile).toHaveBeenLastCalledWith(
      expect.objectContaining(
        extension === 'html'
          ? { reuseBrowserId: 'browser-page' }
          : { path: `/project/report.${extension}` },
      ),
    );
    expect(showFilesInRenderer).not.toHaveBeenCalled();
    const other = document.createElement('button');
    document.body.append(other);
    other.focus();
    await flush(() => closed('unrelated-viewer'));
    expect(openWindow).not.toHaveBeenCalled();
    const request: unknown = openTurnFile.mock.calls[0]?.[0];
    if (
      typeof request !== 'object' ||
      request === null ||
      !('focusReturnId' in request) ||
      typeof request.focusReturnId !== 'string'
    )
      throw new Error('Missing cross-window focus return identity');
    const focusReturnId = request.focusReturnId;
    await flush(() => closed(focusReturnId));
    expect(openWindow).toHaveBeenCalledWith({ focus: true });
    expect(document.activeElement).toBe(button);
    expect(dispose).toHaveBeenCalled();
    other.remove();
    await flush(() => root.unmount());
    container.remove();
  },
);

it('marks an in-window file tile open as explicit user intent', async () => {
  // A pending browser handoff backgrounds agent presentation; a click on a
  // file tile is the user's own choice and must still open in front.
  jest.mocked(showFilesInRenderer).mockResolvedValue({
    opened: 1,
    failed: 0,
    files: [{ path: '/advisor/report.md', ok: true, tabId: 'file-tab' }],
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await flush(() =>
    root.render(
      <TurnFileChip
        path="/advisor/report.md"
        projectId="app-advisor"
        worktreeId="global"
        chatId="chat"
      />,
    ),
  );
  const button = container.querySelector<HTMLButtonElement>(
    '[aria-label="Open report.md"]',
  );
  if (!button) throw new Error('Missing file tile');
  await flush(() => button.click());

  expect(showFilesInRenderer).toHaveBeenCalledWith(
    expect.objectContaining({ intent: 'user' }),
    'app-advisor',
    expect.anything(),
  );
  await flush(() => root.unmount());
  container.remove();
});
