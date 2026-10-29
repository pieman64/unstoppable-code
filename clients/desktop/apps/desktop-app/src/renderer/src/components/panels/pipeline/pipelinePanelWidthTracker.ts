/**
 * Measures a pipeline run panel's width class (see
 * `classifyPipelinePanelWidth`) so its job list can present collapsed when
 * the panel is too narrow to dock it.
 *
 * - The observer comes from the element's own window, so measurement keeps
 *   working after the panel moves into an auxiliary window (the host calls
 *   {@link PipelinePanelWidthTracker.observe} again when its document
 *   changes).
 * - A hidden panel measures 0 and changes nothing: the last class stays until
 *   the panel is shown again.
 * - Listeners fire only when the class flips, never per pixel, and collapsing
 *   the list changes nothing outside the panel root, so there is no resize
 *   loop.
 * - It is an external store (`subscribe`/`getSnapshot`): a flip seen by the
 *   observer re-renders before the frame paints, so the list never flashes
 *   docked in a narrow panel.
 *
 * Until a first measurement the class is `wide` (the list's default
 * presentation).
 */
import {
  classifyPipelinePanelWidth,
  type PipelinePanelWidthClass,
} from '@/stores/pipelinePanelUiStore';

export class PipelinePanelWidthTracker {
  private widthClass: PipelinePanelWidthClass = 'wide';
  private readonly listeners = new Set<() => void>();
  private observer: ResizeObserver | null = null;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): PipelinePanelWidthClass => this.widthClass;

  /**
   * Observes `element` with its own window's `ResizeObserver`, replacing any
   * previous observation. `null`, or a window without the API, observes
   * nothing and keeps the current class.
   */
  observe(element: HTMLElement | null): void {
    this.disconnect();
    const view = element?.ownerDocument.defaultView;
    if (
      element === null ||
      view === null ||
      view === undefined ||
      typeof view.ResizeObserver !== 'function'
    ) {
      return;
    }
    const observer = new view.ResizeObserver(
      (entries: ResizeObserverEntry[]): void => {
        const entry = entries[entries.length - 1];
        if (entry !== undefined) this.measure(entry.contentRect.width);
      },
    );
    observer.observe(element);
    this.observer = observer;
  }

  /** Applies one measured width (CSS px). */
  measure(width: number): void {
    const next = classifyPipelinePanelWidth(width);
    if (next === null || next === this.widthClass) return;
    this.widthClass = next;
    for (const listener of Array.from(this.listeners)) listener();
  }

  /** Stops observing; the current class is kept. */
  disconnect(): void {
    this.observer?.disconnect();
    this.observer = null;
  }
}
