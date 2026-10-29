import { EventEmitter } from 'node:events';

export const app = {
  getAppPath: (): string => process.cwd(),
  getName: (): string => 'Canopy',
  getPath: (): string => process.cwd(),
  getVersion: (): string => '0.0.0-test',
  isPackaged: false,
  isReady: (): boolean => true,
  on: (): void => {},
  once: (): void => {},
  quit: (): void => {},
  setName: (): void => {},
  whenReady: (): Promise<void> => Promise.resolve(),
};

export class BrowserWindow extends EventEmitter {
  static getAllWindows(): BrowserWindow[] {
    return [];
  }

  static getFocusedWindow(): BrowserWindow | null {
    return null;
  }

  webContents = new EventEmitter() as EventEmitter & {
    closeDevTools: () => void;
    getZoomFactor: () => number;
    isDestroyed: () => boolean;
    isDevToolsOpened: () => boolean;
    openDevTools: () => void;
    send: () => void;
    setZoomFactor: (factor: number) => void;
  };

  constructor() {
    super();
    let zoomFactor = 1;
    this.webContents.closeDevTools = (): void => {};
    this.webContents.getZoomFactor = (): number => zoomFactor;
    this.webContents.isDestroyed = (): boolean => false;
    this.webContents.isDevToolsOpened = (): boolean => false;
    this.webContents.openDevTools = (): void => {};
    this.webContents.send = (): void => {};
    this.webContents.setZoomFactor = (factor: number): void => {
      zoomFactor = factor;
    };
  }

  private bounds = { x: 0, y: 0, width: 1400, height: 900 };
  private minimumSize: [number, number] = [0, 0];

  close(): void {}
  destroy(): void {}
  focus(): void {}
  getBounds(): { x: number; y: number; width: number; height: number } {
    return { ...this.bounds };
  }
  getMinimumSize(): [number, number] {
    return [...this.minimumSize];
  }
  isDestroyed(): boolean {
    return false;
  }
  isFullScreen(): boolean {
    return false;
  }
  isMaximized(): boolean {
    return false;
  }
  isMinimized(): boolean {
    return false;
  }
  loadFile(): Promise<void> {
    return Promise.resolve();
  }
  loadURL(): Promise<void> {
    return Promise.resolve();
  }
  restore(): void {}
  setBounds(
    bounds: Partial<{ x: number; y: number; width: number; height: number }>,
  ): void {
    this.bounds = { ...this.bounds, ...bounds };
  }
  setMinimumSize(width: number, height: number): void {
    this.minimumSize = [width, height];
  }
  show(): void {}
}

export class Notification extends EventEmitter {
  static isSupported(): boolean {
    return true;
  }

  show(): void {
    this.emit('show');
  }
}

export const ipcMain = {
  handle: (): void => {},
  on: (): void => {},
  removeHandler: (): void => {},
  removeListener: (): void => {},
};

export const dialog = {
  showMessageBox: (): Promise<{ response: number }> =>
    Promise.resolve({ response: 0 }),
  showMessageBoxSync: (): number => 0,
  showOpenDialog: (): Promise<{ canceled: boolean; filePaths: string[] }> =>
    Promise.resolve({ canceled: true, filePaths: [] }),
  showSaveDialog: (): Promise<{ canceled: boolean; filePath?: string }> =>
    Promise.resolve({ canceled: true }),
};

export const shell = {
  openExternal: (): Promise<void> => Promise.resolve(),
  openPath: (): Promise<string> => Promise.resolve(''),
  showItemInFolder: (): void => {},
};

export const Menu = {
  buildFromTemplate: (template: unknown): unknown => template,
  setApplicationMenu: (): void => {},
};

export const nativeImage = {
  createFromPath: (): {
    isEmpty: () => boolean;
    resize: () => { toDataURL: () => string };
    toDataURL: () => string;
  } => ({
    isEmpty: () => true,
    resize: () => ({ toDataURL: () => '' }),
    toDataURL: () => '',
  }),
};

export const screen = {
  getAllDisplays: (): Array<{
    workArea: { x: number; y: number; width: number; height: number };
  }> => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
  getDisplayMatching: (): {
    workArea: { x: number; y: number; width: number; height: number };
  } => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  getPrimaryDisplay: (): {
    workArea: { x: number; y: number; width: number; height: number };
  } => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
};

export const safeStorage = {
  getSelectedStorageBackend: (): string => 'gnome_libsecret',
  decryptString: (value: Buffer): string => value.toString('utf8'),
  encryptString: (value: string): Buffer => Buffer.from(value, 'utf8'),
  isEncryptionAvailable: (): boolean => true,
};

export const powerSaveBlocker = {
  isStarted: (): boolean => true,
  start: (): number => 1,
  stop: (): void => {},
};

export const globalShortcut = {
  register: (): boolean => true,
  unregister: (): void => {},
  unregisterAll: (): void => {},
  isRegistered: (): boolean => false,
};

export const systemPreferences = {
  askForMediaAccess: (): Promise<boolean> => Promise.resolve(true),
  getMediaAccessStatus: (): string => 'granted',
};

export const clipboard = {
  readText: (): string => '',
  writeText: (): void => {},
};

interface NativeThemeMock {
  shouldUseDarkColors: boolean;
  themeSource: 'light' | 'dark' | 'system';
}

export const nativeTheme: NativeThemeMock = {
  shouldUseDarkColors: false,
  themeSource: 'system',
};

export const session = {
  defaultSession: {
    setPermissionRequestHandler: (): void => {},
  },
};

export const protocol = {
  handle: (): void => {},
  registerFileProtocol: (): void => {},
};
