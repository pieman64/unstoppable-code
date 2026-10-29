/**
 * Longest a snapshot or inspect waits for a main-frame navigation's new
 * document (phase 04b E2). A hung navigation costs one bounded wait; the
 * read then proceeds with whatever document is there.
 */
export const READ_NAVIGATION_WAIT_MS = 2_000;

/** How a wait ended: the document is usable, the bound, or an interruption. */
export type NavigationWaitEnd = 'ready' | 'timeout' | 'interrupted';

/**
 * Whether the main frame's next document is still on its way, from the
 * navigation events Electron reports for the main frame: in flight from a
 * cross-document navigation start until the new document has committed and
 * fired DOMContentLoaded, or the navigation failed or stopped. A read that
 * arrives meanwhile would be answered by the document being replaced.
 *
 * DOMContentLoaded counts only after the commit: before it, it belongs to
 * the old document. A commit without a start (none was seen) opens nothing.
 */
export class MainFrameNavigationGate {
  private phase: 'idle' | 'navigating' | 'committed' = 'idle';

  private readonly waiters = new Set<() => void>();

  /** Whether a read now would race a navigation. */
  public get inFlight(): boolean {
    return this.phase !== 'idle';
  }

  /** `did-start-navigation` for the main frame, not same-document. */
  public started(): void {
    this.phase = 'navigating';
  }

  /** `did-navigate`: the new document committed. */
  public committed(): void {
    if (this.phase === 'navigating') this.phase = 'committed';
  }

  /** `dom-ready`: the main frame's document fired DOMContentLoaded. */
  public domContentLoaded(): void {
    if (this.phase === 'committed') this.settle();
  }

  /**
   * The navigation failed (`did-fail-load` for the main frame, other than
   * a superseded one) or loading stopped (`did-stop-loading`), or the view
   * went away.
   */
  public stopped(): void {
    this.settle();
  }

  /**
   * Resolves when no navigation is in flight, after `timeoutMs`, or when
   * `signal` aborts or `interrupt` calls back (it returns its own removal).
   */
  public wait(options: {
    timeoutMs: number;
    signal?: AbortSignal;
    interrupt?: (end: () => void) => () => void;
  }): Promise<NavigationWaitEnd> {
    if (!this.inFlight) return Promise.resolve('ready');
    if (options.signal?.aborted) return Promise.resolve('interrupted');
    return new Promise((resolve) => {
      const cleanups: Array<() => void> = [];
      let ended = false;
      const end = (how: NavigationWaitEnd): void => {
        if (ended) return;
        ended = true;
        for (const cleanup of cleanups) cleanup();
        resolve(how);
      };
      const ready = (): void => end('ready');
      this.waiters.add(ready);
      cleanups.push(() => this.waiters.delete(ready));
      const timer = setTimeout(() => end('timeout'), options.timeoutMs);
      cleanups.push(() => clearTimeout(timer));
      const signal = options.signal;
      if (signal) {
        const abort = (): void => end('interrupted');
        signal.addEventListener('abort', abort, { once: true });
        cleanups.push(() => signal.removeEventListener('abort', abort));
      }
      if (options.interrupt) {
        const remove = options.interrupt(() => end('interrupted'));
        if (ended) remove();
        else cleanups.push(remove);
      }
    });
  }

  private settle(): void {
    this.phase = 'idle';
    for (const waiter of Array.from(this.waiters)) waiter();
  }
}
