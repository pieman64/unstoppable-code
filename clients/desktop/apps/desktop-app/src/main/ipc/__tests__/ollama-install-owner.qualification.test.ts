/**
 * CAN-6008: the window's ollama:install handler and App Advisor's install
 * share installOllamaForWindow, unchanged: progress goes to the main window,
 * and a changed executable ends Ollama sessions.
 */
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
jest.mock('../register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));
jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: (): string => '/tmp' },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

const mockDestroyed: string[] = [];
jest.mock('../../agents/session-manager', () => ({
  destroySessionsByModel: (): Promise<void> => Promise.resolve(),
  destroySessionsByProvider: (provider: string): Promise<void> => {
    mockDestroyed.push(provider);
    return Promise.resolve();
  },
}));
const mockSent: Array<[string, unknown]> = [];
jest.mock('../../lib/web-contents-send', () => ({
  sendToWebContents: (
    _contents: unknown,
    channel: string,
    data: unknown,
  ): void => {
    mockSent.push([channel, data]);
  },
}));
let mockPaths: [string, string] = ['/old/ollama', '/new/ollama'];
jest.mock('../../ollama', () => ({
  getOllamaService: (): object => ({
    setBroadcastHandlers: (): void => undefined,
    getState: (): Promise<object> =>
      Promise.resolve({ installation: { path: mockPaths[0] } }),
    install: (progress: (value: object) => void): Promise<object> => {
      progress({ percent: 50 });
      return Promise.resolve({
        installation: { path: mockPaths[1], ready: true },
      });
    },
  }),
}));

import { installOllamaForWindow, registerOllamaHandlers } from '../ollama';

const window = { isDestroyed: (): boolean => false, webContents: {} };
const getWindow = (): Electron.BrowserWindow =>
  window as unknown as Electron.BrowserWindow;

beforeAll(() => registerOllamaHandlers(getWindow));
beforeEach(() => {
  mockDestroyed.length = 0;
  mockSent.length = 0;
});

describe('Ollama install owner (CAN-6008)', () => {
  it('ollama:install and the shared owner install, report progress to the window, and end sessions when the executable changes', async () => {
    const install = handlers.get(IPC_CHANNELS.ollamaInstall);
    if (!install) throw new Error('ollama:install is not registered.');
    for (const run of [
      (): unknown => install({}),
      (): unknown => installOllamaForWindow(getWindow),
    ]) {
      mockDestroyed.length = 0;
      mockSent.length = 0;
      await expect(Promise.resolve(run())).resolves.toEqual({
        installation: { path: '/new/ollama', ready: true },
      });
      expect(mockSent).toEqual([
        [IPC_CHANNELS.ollamaInstallProgress, { percent: 50 }],
      ]);
      expect(mockDestroyed).toEqual(['ollama']);
    }
  });

  it('keeps sessions when the executable is unchanged', async () => {
    mockPaths = ['/same/ollama', '/same/ollama'];
    await installOllamaForWindow(getWindow);
    expect(mockDestroyed).toEqual([]);
  });
});
