import {
  AppAdvisorViewHost,
  type HostRect,
  type HostWindow,
  type HostedView,
} from '../advisor-host';

class FakeView implements HostedView {
  bounds: HostRect | null = null;
  visible = false;
  focused = false;
  readonly webContents = {
    focus: (): void => {
      this.focused = true;
    },
    isFocused: (): boolean => this.focused,
    isDestroyed: (): boolean => false,
  };
  setBounds(bounds: HostRect): void {
    this.bounds = bounds;
  }
  setVisible(visible: boolean): void {
    this.visible = visible;
  }
}

type WindowEvent = 'resize' | 'closed' | 'focus' | 'blur';

class FakeWindow implements HostWindow<FakeView> {
  children: unknown[] = [];
  width: number;
  height: number;
  visible = true;
  minimized = false;
  focused = true;
  destroyed = false;
  pageFocused = false;
  readonly webContents = {
    focus: (): void => {
      this.pageFocused = true;
    },
  };
  private readonly listeners = new Map<string, Set<() => void>>();
  readonly contentView = {
    addChildView: (view: FakeView, index?: number): void => {
      const others = this.children.filter((c) => c !== view);
      this.children =
        index === undefined
          ? [...others, view]
          : [...others.slice(0, index), view, ...others.slice(index)];
    },
    removeChildView: (view: FakeView): void => {
      this.children = this.children.filter((c) => c !== view);
    },
    get children(): readonly unknown[] {
      return [];
    },
  };

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    Object.defineProperty(this.contentView, 'children', {
      get: (): readonly unknown[] => this.children,
    });
  }

  getContentBounds(): HostRect {
    return { x: 100, y: 50, width: this.width, height: this.height };
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  isVisible(): boolean {
    return this.visible;
  }
  isMinimized(): boolean {
    return this.minimized;
  }
  isFocused(): boolean {
    return this.focused;
  }
  on(event: WindowEvent, listener: () => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
  }
  removeListener(event: WindowEvent, listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }
  emit(event: WindowEvent): void {
    const listeners = this.listeners.get(event) ?? new Set<() => void>();
    listeners.forEach((listener) => listener());
  }
  listenerCount(event: WindowEvent): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

function setup(
  whenPainted?: (
    layout: 'floating' | 'full',
    size: { width: number; height: number },
  ) => Promise<void>,
): {
  host: AppAdvisorViewHost<FakeView, FakeWindow>;
  view: FakeView;
  main: FakeWindow;
  shell: FakeWindow;
  changes: jest.Mock;
} {
  const view = new FakeView();
  const main = new FakeWindow(1400, 900);
  const shell = new FakeWindow(1000, 700);
  const changes = jest.fn();
  const host = new AppAdvisorViewHost<FakeView, FakeWindow>({
    view,
    shell,
    getMainWindow: (): FakeWindow => main,
    floatingBounds: (content): HostRect => ({
      x: content.width - 416,
      y: content.height - 656,
      width: Math.min(400, content.width - 32),
      height: 640,
    }),
    onPlacementChange: changes,
    ...(whenPainted ? { whenPainted } : {}),
  });
  return { host, view, main, shell, changes };
}

/** A paint wait the test finishes itself. */
function deferredPaint(): {
  whenPainted: jest.Mock<
    Promise<void>,
    ['floating' | 'full', { width: number; height: number }]
  >;
  finish: () => Promise<void>;
} {
  let resolvePaint: (() => void) | null = null;
  const whenPainted = jest.fn(
    (): Promise<void> =>
      new Promise<void>((resolve) => {
        resolvePaint = resolve;
      }),
  );
  return {
    whenPainted,
    finish: async (): Promise<void> => {
      resolvePaint?.();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

describe('AppAdvisorViewHost', () => {
  it('shows the view as a rounded panel in the main window corner', async () => {
    const { host, view, main, shell, changes } = setup();

    expect(await host.showFloating()).toBe('shown');

    expect(host.placement).toBe('floating');
    expect(main.children).toEqual([view]);
    expect(shell.children).toEqual([]);
    expect(view.bounds).toEqual({ x: 984, y: 244, width: 400, height: 640 });
    expect(view.visible).toBe(true);
    expect(host.isVisible()).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('follows the main window as it resizes', () => {
    const { host, view, main } = setup();
    void host.showFloating();

    main.width = 1000;
    main.height = 700;
    main.emit('resize');

    expect(view.bounds).toEqual({ x: 584, y: 44, width: 400, height: 640 });
  });

  it('moves the same view into the full window and back, filling it', () => {
    const { host, view, main, shell } = setup();
    void host.showFloating();

    host.showFull();
    expect(host.placement).toBe('full');
    expect(main.children).toEqual([]);
    expect(shell.children).toEqual([view]);
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1000, height: 700 });
    // The main window no longer drives its geometry.
    expect(main.listenerCount('resize')).toBe(0);

    void host.showFloating();
    expect(shell.children).toEqual([]);
    expect(main.children).toEqual([view]);
  });

  it('hides the floating panel in place, still in the main window', () => {
    const { host, view, main, shell } = setup();
    void host.showFloating();
    shell.visible = false;

    host.hide();

    expect(host.placement).toBe('hidden');
    // Parked where it showed, at the size it last painted, so showing it
    // again shows that frame: never the full window's layout cropped.
    expect(main.children).toEqual([view]);
    expect(shell.children).toEqual([]);
    expect(view.visible).toBe(false);
    expect(view.bounds).toEqual({ x: 984, y: 244, width: 400, height: 640 });
    expect(host.isVisible()).toBe(false);
    expect(host.isFocused()).toBe(false);

    // Still follows the main window, at the panel's place.
    main.width = 1000;
    main.height = 700;
    main.emit('resize');
    expect(view.bounds).toEqual({ x: 584, y: 44, width: 400, height: 640 });
  });

  it('keeps the layout it last showed while hidden', () => {
    const { host } = setup();
    void host.showFloating();
    host.hide();
    expect(host.layout).toBe('floating');

    host.showFull();
    expect(host.layout).toBe('full');
    host.hide();
    expect(host.layout).toBe('full');
  });

  it('parks a new page hidden at the panel place, in the floating layout', () => {
    const { host, view, main, shell } = setup();

    expect(host.park()).toBe(true);

    expect(host.placement).toBe('hidden');
    expect(host.layout).toBe('floating');
    expect(main.children).toEqual([view]);
    expect(shell.children).toEqual([]);
    expect(view.visible).toBe(false);
    expect(view.bounds).toEqual({ x: 984, y: 244, width: 400, height: 640 });
  });

  it('reopens a hidden panel where it was, without waiting for a paint', async () => {
    const { whenPainted, finish } = deferredPaint();
    const { host, view } = setup(whenPainted);
    const first = host.showFloating();
    await finish();
    await first;
    host.hide();
    whenPainted.mockClear();

    expect(await host.showFloating()).toBe('shown');

    expect(whenPainted).not.toHaveBeenCalled();
    expect(view.visible).toBe(true);
    expect(view.bounds).toEqual({ x: 984, y: 244, width: 400, height: 640 });
  });

  it('paints the floating layout out of sight before first showing it', async () => {
    const { whenPainted, finish } = deferredPaint();
    const { host, view, changes } = setup(whenPainted);
    host.park();
    changes.mockClear();

    const shown = host.showFloating();

    // Visible to the page (so it paints) but past the window's bottom-right
    // corner, at the panel's size; the page learns its layout meanwhile.
    expect(whenPainted).toHaveBeenCalledWith('floating', {
      width: 400,
      height: 640,
    });
    expect(view.visible).toBe(true);
    expect(view.bounds).toEqual({ x: 1399, y: 899, width: 400, height: 640 });
    expect(host.layout).toBe('floating');
    expect(changes).toHaveBeenCalled();
    // Not open yet, so the main window draws no panel shadow alone.
    expect(host.isVisible()).toBe(false);

    await finish();
    expect(await shown).toBe('shown');
    expect(view.bounds).toEqual({ x: 984, y: 244, width: 400, height: 640 });
    expect(host.isVisible()).toBe(true);
  });

  it('paints first when the panel size changed while it was hidden', async () => {
    const { whenPainted, finish } = deferredPaint();
    const { host, main } = setup(whenPainted);
    const first = host.showFloating();
    await finish();
    await first;
    host.hide();
    main.width = 300;
    main.emit('resize');
    whenPainted.mockClear();

    const shown = host.showFloating();
    expect(whenPainted).toHaveBeenCalledWith('floating', {
      width: 268,
      height: 640,
    });
    await finish();
    await shown;
  });

  it('paints first when it last showed the full layout', async () => {
    const { whenPainted, finish } = deferredPaint();
    const { host } = setup(whenPainted);
    host.showFull();
    host.hide();

    const shown = host.showFloating();
    expect(whenPainted).toHaveBeenCalledTimes(1);
    await finish();
    await shown;
  });

  it('shows directly when the main window cannot paint it', async () => {
    const { whenPainted } = deferredPaint();
    const { host, view, main } = setup(whenPainted);
    main.visible = false;

    expect(await host.showFloating()).toBe('shown');

    expect(whenPainted).not.toHaveBeenCalled();
    expect(view.visible).toBe(true);
    expect(view.bounds).toEqual({ x: 984, y: 244, width: 400, height: 640 });
  });

  it('stays hidden when hidden while it paints', async () => {
    const { whenPainted, finish } = deferredPaint();
    const { host, view } = setup(whenPainted);
    const shown = host.showFloating();

    host.hide();
    await finish();
    // The caller learns it was replaced, not that there is no main window
    // (which would show the full window instead).
    expect(await shown).toBe('superseded');

    expect(host.placement).toBe('hidden');
    expect(view.visible).toBe(false);
    expect(view.bounds).toEqual({ x: 984, y: 244, width: 400, height: 640 });
  });

  it('moves a hidden panel into the full window', () => {
    const { host, view, main, shell } = setup();
    void host.showFloating();
    host.hide();

    host.showFull();

    expect(host.placement).toBe('full');
    expect(main.children).toEqual([]);
    expect(shell.children).toEqual([view]);
    expect(view.visible).toBe(true);
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1000, height: 700 });
    expect(main.listenerCount('resize')).toBe(0);
    expect(main.listenerCount('closed')).toBe(0);
  });

  it('gives keyboard focus back to the main window page it hides from', () => {
    const { host, main } = setup();
    void host.showFloating();
    host.focus();

    host.hide();

    expect(main.pageFocused).toBe(true);
  });

  it('leaves focus alone when the panel did not have it', () => {
    const { host, main } = setup();
    void host.showFloating();

    host.hide();

    expect(main.pageFocused).toBe(false);
  });

  it('keeps the panel above native views added to the main window later', () => {
    const { host, view, main } = setup();
    void host.showFloating();
    const browserPanel = new FakeView();
    main.contentView.addChildView(browserPanel);
    expect(main.children).toEqual([view, browserPanel]);

    host.raise(main);

    expect(main.children).toEqual([browserPanel, view]);
  });

  it('does not raise a panel that is not floating in that window', () => {
    const { host, main, shell } = setup();
    host.showFull();
    const browserPanel = new FakeView();
    main.contentView.addChildView(browserPanel);

    host.raise(main);
    host.raise(shell);

    expect(main.children).toEqual([browserPanel]);
  });

  it('reads as hidden once its host window closes', () => {
    const { host, main, changes } = setup();
    void host.showFloating();
    changes.mockClear();

    main.destroyed = true;
    main.emit('closed');

    expect(host.placement).toBe('hidden');
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('counts as focused only while its window and its page both are', () => {
    const { host, main } = setup();
    void host.showFloating();
    expect(host.isFocused()).toBe(false);

    host.focus();
    expect(host.isFocused()).toBe(true);

    main.focused = false;
    expect(host.isFocused()).toBe(false);
  });

  it('keeps the full window page under the browser panels', () => {
    const { host, view, shell } = setup();
    host.showFull();
    // A browser panel joins the full window after the page.
    const browserPanel = { id: 'browser-panel' };
    shell.children = [...shell.children, browserPanel];

    // Reopening or expanding into the full window again must not raise the
    // page over that panel.
    host.showFull();
    expect(shell.children).toEqual([view, browserPanel]);

    // Coming back from the panel puts the page under it too.
    void host.showFloating();
    host.showFull();
    expect(shell.children).toEqual([view, browserPanel]);
  });

  it('broadcasts when its host window gains or loses focus', () => {
    const { host, main, changes } = setup();
    void host.showFloating();
    changes.mockClear();

    main.emit('blur');
    main.emit('focus');
    expect(changes).toHaveBeenCalledTimes(2);

    // It stops following a window it left.
    host.showFull();
    changes.mockClear();
    main.emit('blur');
    expect(changes).not.toHaveBeenCalled();
    expect(main.listenerCount('focus')).toBe(0);
  });

  it('cannot float without a main window', async () => {
    const view = new FakeView();
    const host = new AppAdvisorViewHost<FakeView, FakeWindow>({
      view,
      shell: new FakeWindow(1000, 700),
      getMainWindow: (): null => null,
      floatingBounds: (): HostRect => ({ x: 0, y: 0, width: 1, height: 1 }),
      onPlacementChange: jest.fn(),
    });

    expect(await host.showFloating()).toBe('unavailable');
    expect(host.park()).toBe(false);
    expect(host.placement).toBe('hidden');
  });
});
