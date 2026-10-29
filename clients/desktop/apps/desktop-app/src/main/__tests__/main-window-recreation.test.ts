import {
  createMainWindowRecreation,
  type RecreatableWindow,
} from '../lifecycle/main-window-recreation';

interface Preferences {
  marker: number;
}

class FakeWindow implements RecreatableWindow {
  destroyed = false;
  visible = false;
  private readyListeners: Array<() => void> = [];

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isVisible(): boolean {
    return this.visible;
  }

  once(_event: 'ready-to-show', listener: () => void): this {
    this.readyListeners.push(listener);
    return this;
  }

  emitReadyToShow(): void {
    const listeners = this.readyListeners;
    this.readyListeners = [];
    this.visible = true;
    for (const listener of listeners) listener();
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

function harness(options?: {
  window?: FakeWindow | null;
  handleTrigger?: boolean;
  createVisible?: boolean;
}): {
  ensureMainWindow: () => Promise<void>;
  showMainWindow: (focus: () => void) => void;
  trigger: () => void;
  preferences: Deferred<Preferences>;
  readPreferences: jest.Mock<Promise<Preferences>, []>;
  createWindow: jest.Mock<void, [Preferences]>;
  focus: jest.Mock<void, []>;
  onFailure: jest.Mock<void, [unknown]>;
  getWindow: () => FakeWindow | null;
  setWindow: (next: FakeWindow | null) => void;
} {
  let window: FakeWindow | null = options?.window ?? null;
  const preferences = deferred<Preferences>();
  const readPreferences = jest.fn<Promise<Preferences>, []>(
    () => preferences.promise,
  );
  const createWindow = jest.fn<void, [Preferences]>(() => {
    const created = new FakeWindow();
    created.visible = options?.createVisible ?? false;
    window = created;
  });
  const focus = jest.fn<void, []>();
  const onFailure = jest.fn<void, [unknown]>();
  const recreation = createMainWindowRecreation<Preferences>({
    getMainWindow: (): FakeWindow | null => window,
    readPreferences,
    createWindow,
    focusMainWindow: focus,
    shouldHandleTrigger: (): boolean => options?.handleTrigger ?? true,
    onRecreationFailure: onFailure,
  });
  return {
    ensureMainWindow: recreation.ensureMainWindow,
    showMainWindow: recreation.showMainWindow,
    trigger: recreation.handleFocusShortcutTrigger,
    preferences,
    readPreferences,
    createWindow,
    focus,
    onFailure,
    getWindow: (): FakeWindow | null => window,
    setWindow: (next): void => {
      window = next;
    },
  };
}

describe('createMainWindowRecreation', () => {
  it('creates one window when two triggers race the preferences read', async () => {
    const h = harness();

    h.trigger();
    h.trigger();
    expect(h.readPreferences).toHaveBeenCalledTimes(1);

    h.preferences.resolve({ marker: 1 });
    await flush();

    expect(h.createWindow).toHaveBeenCalledTimes(1);
    expect(h.createWindow).toHaveBeenCalledWith({ marker: 1 });
    // The new window is not shown yet, so focus waits for ready-to-show.
    expect(h.focus).not.toHaveBeenCalled();
    h.getWindow()?.emitReadyToShow();
    expect(h.focus).toHaveBeenCalled();
  });

  it('focuses a live window immediately without reading preferences', () => {
    const existing = new FakeWindow();
    existing.visible = true;
    const h = harness({ window: existing });

    h.trigger();

    expect(h.focus).toHaveBeenCalledTimes(1);
    expect(h.readPreferences).not.toHaveBeenCalled();
  });

  it('focuses right away when the recreated window is already visible', async () => {
    const h = harness({ createVisible: true });

    h.trigger();
    h.preferences.resolve({ marker: 2 });
    await flush();

    expect(h.createWindow).toHaveBeenCalledTimes(1);
    expect(h.focus).toHaveBeenCalledTimes(1);
  });

  it('skips creation when a window appeared during the preferences read', async () => {
    const h = harness();

    const pending = h.ensureMainWindow();
    h.setWindow(new FakeWindow());
    h.preferences.resolve({ marker: 3 });
    await pending;

    expect(h.createWindow).not.toHaveBeenCalled();
  });

  it('starts a fresh recreation once the previous one has settled', async () => {
    const h = harness();

    h.trigger();
    h.preferences.resolve({ marker: 4 });
    await flush();
    expect(h.createWindow).toHaveBeenCalledTimes(1);

    const created = h.getWindow();
    if (created !== null) created.destroyed = true;
    h.trigger();

    expect(h.readPreferences).toHaveBeenCalledTimes(2);
  });

  it('reports a failed recreation instead of rejecting', async () => {
    const h = harness();
    const failure = new Error('preferences unreadable');

    h.trigger();
    h.preferences.reject(failure);
    await flush();

    expect(h.onFailure).toHaveBeenCalledWith(failure);
    expect(h.focus).not.toHaveBeenCalled();
  });

  it("recreates a closed window for an explicit show and focuses it with the caller's focus", async () => {
    const h = harness();
    const focus = jest.fn<void, []>();

    h.showMainWindow(focus);
    h.preferences.resolve({ marker: 5 });
    await flush();
    expect(h.createWindow).toHaveBeenCalledTimes(1);
    h.getWindow()?.emitReadyToShow();

    expect(focus).toHaveBeenCalledTimes(1);
    expect(h.focus).not.toHaveBeenCalled();
  });

  it('ignores the trigger when the build opts out', () => {
    const h = harness({ handleTrigger: false });

    h.trigger();

    expect(h.readPreferences).not.toHaveBeenCalled();
    expect(h.focus).not.toHaveBeenCalled();
  });
});
