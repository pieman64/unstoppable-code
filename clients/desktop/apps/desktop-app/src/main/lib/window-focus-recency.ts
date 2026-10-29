import type { BrowserWindow } from 'electron';

/** The slice of `BrowserWindow` the tracker needs. */
export interface FocusTrackedWindow {
  on(event: 'focus', listener: () => void): unknown;
  on(event: 'closed', listener: () => void): unknown;
}

/** Focus order of a set of windows; a larger value is a more recent focus. */
export class WindowFocusRecency<TWindow extends FocusTrackedWindow> {
  private readonly focusedAt = new Map<TWindow, number>();
  private sequence = 0;

  track(window: TWindow): void {
    window.on('focus', () => {
      this.sequence += 1;
      this.focusedAt.set(window, this.sequence);
    });
    window.on('closed', () => {
      this.focusedAt.delete(window);
    });
  }

  lastFocusedAt(window: TWindow): number | undefined {
    return this.focusedAt.get(window);
  }
}

/**
 * Focus order of the app's primary windows: the main window and the windows
 * showing a paired computer (CAN-4247). Auxiliary windows such as App Advisor
 * are deliberately not tracked.
 */
export const primaryWindowFocus = new WindowFocusRecency<BrowserWindow>();
