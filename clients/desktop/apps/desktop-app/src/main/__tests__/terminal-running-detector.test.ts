import {
  RUNNING_DETECTOR_INTERVAL_MS,
  TerminalRunningDetector,
  type RunningDetectorTerminalSnapshot,
} from '../terminal/running-detector';

interface CreateStoreResult {
  terminals: Map<string, RunningDetectorTerminalSnapshot>;
  store: {
    getTerminalSnapshots(): Iterable<RunningDetectorTerminalSnapshot>;
    setTerminalStatus(
      id: string,
      running: boolean,
      processName: string | null,
    ): void;
  };
  setTerminalStatus: jest.Mock<void, [string, boolean, string | null]>;
}

function createStore(): CreateStoreResult {
  const terminals = new Map<string, RunningDetectorTerminalSnapshot>();
  const setTerminalStatus = jest.fn(
    (id: string, running: boolean, processName: string | null): void => {
      const terminal = terminals.get(id);
      if (terminal) {
        terminal.running = running;
        terminal.lastProcessName = processName;
      }
    },
  );

  return {
    terminals,
    store: {
      getTerminalSnapshots(): Iterable<RunningDetectorTerminalSnapshot> {
        return Array.from(terminals.values());
      },
      setTerminalStatus,
    },
    setTerminalStatus,
  };
}

function setPlatform(platform: NodeJS.Platform): () => void {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  );
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });

  return (): void => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  };
}

describe('TerminalRunningDetector', () => {
  it('flips to running and reports the foreground process name', () => {
    const { terminals, store, setTerminalStatus } = createStore();
    terminals.set('term-1', {
      id: 'term-1',
      shellBasename: 'zsh',
      processName: 'sleep',
      running: false,
      lastProcessName: null,
    });

    const detector = new TerminalRunningDetector({ store });

    detector.tick();

    expect(setTerminalStatus).toHaveBeenCalledWith('term-1', true, 'sleep');
  });

  it('stays idle when only the shell is the foreground process', () => {
    const { terminals, store, setTerminalStatus } = createStore();
    terminals.set('term-1', {
      id: 'term-1',
      shellBasename: 'zsh',
      processName: 'zsh',
      running: false,
      lastProcessName: null,
    });

    const detector = new TerminalRunningDetector({ store });

    detector.tick();

    expect(setTerminalStatus).not.toHaveBeenCalled();
  });

  it('treats a missing PTY process name as idle', () => {
    const { terminals, store, setTerminalStatus } = createStore();
    terminals.set('term-1', {
      id: 'term-1',
      shellBasename: 'zsh',
      processName: undefined,
      running: true,
      lastProcessName: 'sleep',
    });

    const detector = new TerminalRunningDetector({ store });

    expect(() => detector.tick()).not.toThrow();
    expect(setTerminalStatus).toHaveBeenCalledWith('term-1', false, null);
  });

  it('treats Windows shell basename variants as idle', () => {
    const { terminals, store, setTerminalStatus } = createStore();
    terminals.set('term-1', {
      id: 'term-1',
      shellBasename: 'pwsh.exe',
      processName: 'pwsh',
      running: false,
      lastProcessName: null,
    });
    terminals.set('term-2', {
      id: 'term-2',
      shellBasename: 'powershell.exe',
      processName: 'PowerShell',
      running: false,
      lastProcessName: null,
    });

    const detector = new TerminalRunningDetector({ store });

    detector.tick();

    expect(setTerminalStatus).not.toHaveBeenCalled();
  });

  it('treats Windows shell process paths as idle', () => {
    const { terminals, store, setTerminalStatus } = createStore();
    terminals.set('term-1', {
      id: 'term-1',
      shellBasename: 'pwsh.exe',
      processName: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      running: false,
      lastProcessName: null,
    });
    terminals.set('term-2', {
      id: 'term-2',
      shellBasename: 'powershell.exe',
      processName: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      running: false,
      lastProcessName: null,
    });
    terminals.set('term-3', {
      id: 'term-3',
      shellBasename: 'cmd.exe',
      processName: 'C:\\Windows\\System32\\cmd.exe',
      running: false,
      lastProcessName: null,
    });

    const detector = new TerminalRunningDetector({ store });

    detector.tick();

    expect(setTerminalStatus).not.toHaveBeenCalled();
  });

  it('treats terminal type names reported by Windows PTYs as idle', () => {
    const restorePlatform = setPlatform('win32');
    const { terminals, store, setTerminalStatus } = createStore();
    terminals.set('term-1', {
      id: 'term-1',
      shellBasename: 'pwsh.exe',
      processName: 'xterm-256color',
      running: true,
      lastProcessName: 'sleep',
    });

    const detector = new TerminalRunningDetector({ store });

    try {
      detector.tick();
    } finally {
      restorePlatform();
    }

    expect(setTerminalStatus).toHaveBeenCalledWith('term-1', false, null);
  });

  it('treats terminal type names as real foreground processes outside Windows', () => {
    const restorePlatform = setPlatform('darwin');
    const { terminals, store, setTerminalStatus } = createStore();
    terminals.set('term-1', {
      id: 'term-1',
      shellBasename: 'zsh',
      processName: 'xterm',
      running: false,
      lastProcessName: null,
    });

    const detector = new TerminalRunningDetector({ store });

    try {
      detector.tick();
    } finally {
      restorePlatform();
    }

    expect(setTerminalStatus).toHaveBeenCalledWith('term-1', true, 'xterm');
  });

  it('returns to idle and clears processName once the shell is back in the foreground', () => {
    const { terminals, store, setTerminalStatus } = createStore();
    terminals.set('term-1', {
      id: 'term-1',
      shellBasename: 'zsh',
      processName: 'zsh',
      running: true,
      lastProcessName: 'sleep',
    });

    const detector = new TerminalRunningDetector({ store });

    detector.tick();

    expect(setTerminalStatus).toHaveBeenCalledWith('term-1', false, null);
  });

  it('re-emits when the foreground process name changes while still running', () => {
    const { terminals, store, setTerminalStatus } = createStore();
    terminals.set('term-1', {
      id: 'term-1',
      shellBasename: 'zsh',
      processName: 'node',
      running: true,
      lastProcessName: 'sleep',
    });

    const detector = new TerminalRunningDetector({ store });

    detector.tick();

    expect(setTerminalStatus).toHaveBeenCalledWith('term-1', true, 'node');
  });

  it('emits only on transitions', () => {
    const { terminals, store, setTerminalStatus } = createStore();
    terminals.set('term-1', {
      id: 'term-1',
      shellBasename: 'zsh',
      processName: 'sleep',
      running: false,
      lastProcessName: null,
    });

    const detector = new TerminalRunningDetector({ store });

    detector.tick();
    detector.tick();

    expect(setTerminalStatus).toHaveBeenCalledTimes(1);
    expect(setTerminalStatus).toHaveBeenCalledWith('term-1', true, 'sleep');
  });

  it('starts with the first terminal and stops after the last terminal exits', () => {
    const { terminals, store } = createStore();
    const timer = setInterval((): void => {}, RUNNING_DETECTOR_INTERVAL_MS);
    clearInterval(timer);

    const setIntervalFn = jest.fn((): ReturnType<typeof setInterval> => timer);
    const clearIntervalFn = jest.fn();

    const detector = new TerminalRunningDetector({
      store,
      setIntervalFn,
      clearIntervalFn,
    });

    detector.syncLifecycle();
    expect(detector.isRunning()).toBe(false);
    expect(setIntervalFn).not.toHaveBeenCalled();

    terminals.set('term-1', {
      id: 'term-1',
      shellBasename: 'zsh',
      processName: 'zsh',
      running: false,
      lastProcessName: null,
    });

    detector.syncLifecycle();
    expect(detector.isRunning()).toBe(true);
    expect(setIntervalFn).toHaveBeenCalledTimes(1);

    terminals.clear();
    detector.syncLifecycle();

    expect(detector.isRunning()).toBe(false);
    expect(clearIntervalFn).toHaveBeenCalledWith(timer);
  });
});
