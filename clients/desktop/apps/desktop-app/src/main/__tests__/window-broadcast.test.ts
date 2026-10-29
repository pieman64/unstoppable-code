import type { SendableBrowserWindow } from '../lib/window-send';

const windows: SendableBrowserWindow[] = [];

jest.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: (): SendableBrowserWindow[] => windows,
  },
}));

import { sendToAllWindows } from '../lib/window-send';

function makeWindow(): {
  window: SendableBrowserWindow;
  send: jest.Mock<void, [string, ...unknown[]]>;
} {
  const send = jest.fn<void, [string, ...unknown[]]>();
  return {
    window: {
      isDestroyed: () => false,
      webContents: {
        isCrashed: () => false,
        isDestroyed: () => false,
        mainFrame: {
          detached: false,
          isDestroyed: () => false,
        },
        send,
      },
    },
    send,
  };
}

describe('sendToAllWindows', () => {
  beforeEach(() => {
    windows.length = 0;
  });

  it('delivers the same target-keyed event to two independent renderers', () => {
    const main = makeWindow();
    const appAdvisor = makeWindow();
    windows.push(main.window, appAdvisor.window);
    const payload = {
      projectId: 'app-advisor',
      worktreeId: 'entry-1',
      generating: true,
    };

    sendToAllWindows('worktree-summary:generating', payload);

    expect(main.send).toHaveBeenCalledWith(
      'worktree-summary:generating',
      payload,
    );
    expect(appAdvisor.send).toHaveBeenCalledWith(
      'worktree-summary:generating',
      payload,
    );
  });

  it('skips an unavailable renderer while continuing to safe windows', () => {
    const destroyed = makeWindow();
    destroyed.window.isDestroyed = (): boolean => true;
    const live = makeWindow();
    windows.push(destroyed.window, live.window);

    sendToAllWindows('pipeline:execution-event', { executionId: 'run-1' });

    expect(destroyed.send).not.toHaveBeenCalled();
    expect(live.send).toHaveBeenCalledTimes(1);
  });
});
