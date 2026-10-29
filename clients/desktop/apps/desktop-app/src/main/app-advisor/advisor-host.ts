/**
 * Early access: App Advisor's renderer lives in a `WebContentsView` that this
 * host moves between two places without reloading it:
 *
 * - `floating`: a panel inside the main Canopy window, in the bottom-right of
 *   its content area (rounded, kept above the window's other native views,
 *   following the window's resizes);
 * - `full`: the full App Advisor window (the shell), filling its content.
 *
 * The renderer stays the single App Advisor surface either way; only where
 * it is shown changes. The host owns attachment and geometry. Showing,
 * focusing, and hiding the full window stay with its caller.
 *
 * A hidden page does not paint (or even resize), so showing it again first
 * shows the last frame it painted. The host therefore hides the floating
 * panel in place, keeping its layout and size, and before showing a page
 * whose last frame was a different layout or size, has it paint the right
 * one out of sight first (see {@link AppAdvisorViewHost.showFloating}).
 */

export type AppAdvisorViewPlacement = 'hidden' | 'floating' | 'full';

/** The layout the page renders: the floating panel or the full window. */
export type AppAdvisorViewLayout = 'floating' | 'full';

/**
 * What {@link AppAdvisorViewHost.showFloating} did: showed the panel, was
 * replaced by a newer move (hide, full, another show) while the panel
 * painted, or had no main window to show it in.
 */
export type AppAdvisorFloatingShowResult =
  | 'shown'
  | 'superseded'
  | 'unavailable';

export interface HostRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface HostSize {
  readonly width: number;
  readonly height: number;
}

/** The parts of a `WebContentsView` the host drives. */
export interface HostedView {
  setBounds(bounds: HostRect): void;
  setVisible(visible: boolean): void;
  readonly webContents: {
    focus(): void;
    isFocused(): boolean;
    isDestroyed(): boolean;
  };
}

/** The host window events the view host follows. */
type HostWindowEvent = 'resize' | 'closed' | 'focus' | 'blur';

/** The parts of a `BrowserWindow` the host attaches the view to. */
export interface HostWindow<View> {
  readonly contentView: {
    /** `index` 0 puts the view below the window's other native views. */
    addChildView(view: View, index?: number): void;
    removeChildView(view: View): void;
    readonly children: readonly unknown[];
  };
  /** The window's own page, which gets focus back from a hidden panel. */
  readonly webContents: { focus(): void };
  getContentBounds(): HostRect;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  isFocused(): boolean;
  on(event: HostWindowEvent, listener: () => void): unknown;
  removeListener(event: HostWindowEvent, listener: () => void): unknown;
}

export interface AppAdvisorViewHostOptions<View, Window> {
  readonly view: View;
  /** The full App Advisor window. */
  readonly shell: Window;
  readonly getMainWindow: () => Window | null;
  /** The floating panel's bounds inside the main window's content area. */
  readonly floatingBounds: (content: HostSize) => HostRect;
  /**
   * Called after the view moves, and when its host window gains or loses
   * focus, so the window state can be broadcast.
   */
  readonly onPlacementChange: () => void;
  /**
   * Resolves once the page has painted `layout` at `size` (DIP), or the
   * caller stopped waiting. Asked while the view is visible to the page but
   * out of sight; without it, the view is shown right away.
   */
  readonly whenPainted?: (
    layout: AppAdvisorViewLayout,
    size: HostSize,
  ) => Promise<void>;
}

/** The layout and size of the last frame the page painted on screen. */
interface PaintedFrame {
  readonly layout: AppAdvisorViewLayout;
  readonly width: number;
  readonly height: number;
}

export class AppAdvisorViewHost<
  View extends HostedView,
  Window extends HostWindow<View>,
> {
  private placementValue: AppAdvisorViewPlacement = 'hidden';
  private layoutValue: AppAdvisorViewLayout = 'floating';
  private painted: PaintedFrame | null = null;
  /** Set while the page paints out of sight, before the panel shows. */
  private painting = false;
  /** Bumped by each move, so a superseded paint wait does not show it. */
  private generation = 0;
  private hostWindow: Window | null = null;
  private readonly fitToHost = (): void => this.fit();
  // The page's own focus events miss the host window losing focus (another
  // app comes forward), which App Advisor's read state depends on.
  private readonly onHostFocusChange = (): void =>
    this.options.onPlacementChange();
  private readonly onHostClosed = (): void => {
    this.generation += 1;
    this.painting = false;
    this.detach();
    this.placementValue = 'hidden';
    this.painted = null;
    this.options.onPlacementChange();
  };

  constructor(
    private readonly options: AppAdvisorViewHostOptions<View, Window>,
  ) {}

  get placement(): AppAdvisorViewPlacement {
    return this.placementValue;
  }

  /**
   * The layout the page renders: where it shows, or, hidden, where it last
   * showed. The page keeps it while hidden, so showing it again needs no
   * re-render.
   */
  get layout(): AppAdvisorViewLayout {
    return this.layoutValue;
  }

  /**
   * Parks a new page hidden at the floating panel's place in the main
   * window, in the floating layout, ready to show. False without a main
   * window.
   */
  park(): boolean {
    const main = this.options.getMainWindow();
    if (!main || main.isDestroyed()) return false;
    this.generation += 1;
    this.attach(main, 'top');
    this.placementValue = 'hidden';
    this.layoutValue = 'floating';
    this.options.view.setVisible(false);
    this.fit();
    return true;
  }

  /**
   * Shows the view as a panel in the main window (see
   * {@link AppAdvisorFloatingShowResult}).
   *
   * When the page last painted another layout or size (its first show, or
   * after the full window), it first paints the panel past the window's
   * bottom-right corner, visible to the page but not to the user, and the
   * panel shows once {@link AppAdvisorViewHostOptions.whenPainted} resolves,
   * so its first frame is already the panel. A window that cannot paint
   * (hidden, minimized) shows it right away.
   */
  async showFloating(): Promise<AppAdvisorFloatingShowResult> {
    const main = this.options.getMainWindow();
    if (!main || main.isDestroyed()) return 'unavailable';
    this.generation += 1;
    const generation = this.generation;
    this.attach(main, 'top');
    this.placementValue = 'floating';
    this.layoutValue = 'floating';
    const whenPainted = this.options.whenPainted;
    const target = this.floatingRect(main);
    if (
      whenPainted &&
      !this.paintedAt('floating', target) &&
      main.isVisible() &&
      !main.isMinimized()
    ) {
      this.painting = true;
      this.fit();
      this.options.view.setVisible(true);
      this.options.onPlacementChange();
      await whenPainted('floating', {
        width: target.width,
        height: target.height,
      });
      if (generation !== this.generation) return 'superseded';
      this.painting = false;
    }
    this.fit();
    this.options.view.setVisible(true);
    this.options.onPlacementChange();
    return 'shown';
  }

  /** Moves the view into the full window. Showing that window is the caller's. */
  showFull(): void {
    if (this.options.shell.isDestroyed()) return;
    this.generation += 1;
    this.painting = false;
    this.attach(this.options.shell, 'bottom');
    this.placementValue = 'full';
    this.layoutValue = 'full';
    this.fit();
    this.options.view.setVisible(true);
    this.options.onPlacementChange();
  }

  /**
   * Hides the floating panel in place: the page stays in the main window at
   * the panel's place and size, in the floating layout, and keeps running
   * like a hidden App Advisor window does. Keyboard focus it had goes back
   * to the main window's page. A view already in the full window stays
   * there; hiding that window is the caller's.
   */
  hide(): void {
    this.generation += 1;
    this.painting = false;
    const wasFloating = this.placementValue === 'floating';
    this.placementValue = 'hidden';
    if (wasFloating) {
      const contents = this.options.view.webContents;
      const hadFocus = !contents.isDestroyed() && contents.isFocused();
      this.options.view.setVisible(false);
      this.fit();
      const window = this.hostWindow;
      if (hadFocus && window && !window.isDestroyed()) {
        window.webContents.focus();
      }
    }
    this.options.onPlacementChange();
  }

  /**
   * Keeps the floating panel above native views added to the same window
   * after it (browser panels): re-adding a child view puts it on top.
   */
  raise(window: Window): void {
    if (this.placementValue !== 'floating' || this.hostWindow !== window) {
      return;
    }
    if (window.isDestroyed()) return;
    window.contentView.addChildView(this.options.view);
  }

  isVisible(): boolean {
    if (this.placementValue === 'floating') {
      // Painting out of sight is not open yet: the main window would draw
      // the panel's shadow without it.
      return !this.painting && this.hostWindow?.isVisible() === true;
    }
    if (this.placementValue === 'full') {
      return this.options.shell.isVisible();
    }
    return false;
  }

  isFocused(): boolean {
    if (this.placementValue === 'hidden' || !this.hostWindow) return false;
    const contents = this.options.view.webContents;
    return (
      !contents.isDestroyed() &&
      this.hostWindow.isFocused() &&
      contents.isFocused()
    );
  }

  /** Refits the view to its host (after an interface-scale change). */
  refit(): void {
    this.fit();
  }

  focus(): void {
    const contents = this.options.view.webContents;
    if (!contents.isDestroyed()) contents.focus();
  }

  /** Detaches the view and stops following its host window. */
  dispose(): void {
    this.generation += 1;
    this.painting = false;
    this.detach();
    this.placementValue = 'hidden';
  }

  /**
   * Attaches the view to `window`. Floating, it goes on `top` of the
   * window's other native views (re-adding a child raises it). In the full
   * window it goes to the `bottom`, under App Advisor's own browser panels,
   * which sit over its page; there it is never re-added, since re-adding
   * would raise it over them.
   */
  private attach(window: Window, layer: 'top' | 'bottom'): void {
    if (this.hostWindow === window) {
      if (layer === 'top') {
        window.contentView.addChildView(this.options.view);
      }
      return;
    }
    this.detach();
    if (layer === 'top') {
      window.contentView.addChildView(this.options.view);
    } else {
      window.contentView.addChildView(this.options.view, 0);
    }
    window.on('resize', this.fitToHost);
    window.on('closed', this.onHostClosed);
    window.on('focus', this.onHostFocusChange);
    window.on('blur', this.onHostFocusChange);
    this.hostWindow = window;
  }

  private detach(): void {
    const window = this.hostWindow;
    this.hostWindow = null;
    if (!window) return;
    window.removeListener('resize', this.fitToHost);
    window.removeListener('closed', this.onHostClosed);
    window.removeListener('focus', this.onHostFocusChange);
    window.removeListener('blur', this.onHostFocusChange);
    if (!window.isDestroyed()) {
      window.contentView.removeChildView(this.options.view);
    }
  }

  /** The floating panel's bounds in `window`'s content. */
  private floatingRect(window: Window): HostRect {
    const content = window.getContentBounds();
    return this.options.floatingBounds({
      width: content.width,
      height: content.height,
    });
  }

  /** Whether the page's last frame on screen was `layout` at `rect`'s size. */
  private paintedAt(layout: AppAdvisorViewLayout, rect: HostRect): boolean {
    const painted = this.painted;
    return (
      painted !== null &&
      painted.layout === layout &&
      painted.width === rect.width &&
      painted.height === rect.height
    );
  }

  /**
   * Fits the view to its host: the full window's content, or the floating
   * panel's place in the main window (hidden there too, so it shows again
   * where it was). Painting out of sight, the panel sits past the content's
   * bottom-right corner, overlapping it by one pixel: a view entirely
   * outside its window counts as hidden and does not paint.
   */
  private fit(): void {
    const window = this.hostWindow;
    if (!window || window.isDestroyed()) return;
    const content = window.getContentBounds();
    if (window === this.options.shell) {
      this.options.view.setBounds({
        x: 0,
        y: 0,
        width: content.width,
        height: content.height,
      });
      if (this.placementValue === 'full') {
        this.painted = {
          layout: 'full',
          width: content.width,
          height: content.height,
        };
      }
      return;
    }
    const panel = this.floatingRect(window);
    if (this.painting) {
      this.options.view.setBounds({
        x: content.width - 1,
        y: content.height - 1,
        width: panel.width,
        height: panel.height,
      });
      return;
    }
    this.options.view.setBounds(panel);
    if (this.placementValue === 'floating') {
      this.painted = {
        layout: 'floating',
        width: panel.width,
        height: panel.height,
      };
    }
  }
}
