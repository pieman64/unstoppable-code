/**
 * Per-panel controller for a pipeline run's collapsible job list.
 *
 * A run panel shows its job list expanded by default. Collapsing it releases
 * the list's width; the collapsed toggle then previews the list as an overlay
 * on hover or keyboard focus, without moving the run body. This controller
 * owns the transient preview state for ONE panel (never the app sidebar's
 * module-level singleton, `lib/sidebar-preview-controller.ts`), with the same
 * intent rules:
 *
 * | State / input                                  | Result                                           |
 * | ---------------------------------------------- | ------------------------------------------------ |
 * | Expanded; toggle click                          | Collapse (width released), no preview           |
 * | Collapsed; pointer enters or focus-visible      | Open the preview                                 |
 * | Preview; select Summary/job/variant             | Close it, stay collapsed, focus moves to content |
 * | Preview; expand a branch or use the filter      | Stay open (menus count as part of the preview)  |
 * | Preview; toggle click                           | Pin expanded without replaying the entry         |
 * | Preview; pointer and focus leave both surfaces  | Close, stay collapsed                            |
 * | Preview; Escape                                 | Close and focus the toggle without reopening     |
 * | Panel hidden or its owner document changes      | Close and release timers and observers          |
 *
 * The expanded preference itself is not state here: the host reads and
 * writes it (per-panel session store) through the injected callbacks.
 * Preview state is exposed through `subscribe`/`getSnapshot` so only the
 * navigation region re-renders when it changes.
 */

/** Delay before trusting a pointer leave that reported no destination. */
export const PIPELINE_NAV_PREVIEW_UNKNOWN_LEAVE_RECHECK_MS = 120;

/**
 * Marks a portalled element (a menu opened from inside the preview) as part
 * of one preview, so pointer travel into it does not close the preview.
 */
export const PIPELINE_NAV_PREVIEW_SCOPE_ATTRIBUTE =
  'data-pipeline-nav-preview-scope';

export interface PipelineNavPreviewSnapshot {
  readonly previewOpen: boolean;
}

export interface PipelineNavPreviewControllerOptions {
  /** The panel's current expanded preference. */
  isExpanded: () => boolean;
  /** Persists an explicit expanded/collapsed choice. */
  setExpanded: (expanded: boolean) => void;
  /** Scope id written on portalled menus that belong to this preview. */
  scopeId?: string;
  /** Whether keyboard-visible focus sits on `element` (test seam). */
  isFocusVisible?: (element: Element) => boolean;
}

const CLOSED: PipelineNavPreviewSnapshot = Object.freeze({
  previewOpen: false,
});
const OPEN: PipelineNavPreviewSnapshot = Object.freeze({ previewOpen: true });

/** Menus opened from inside the preview report themselves this way. */
const OPEN_MENU_SELECTOR = '[aria-haspopup][aria-expanded="true"]';

function defaultIsFocusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return false;
  }
}

function isNode(value: EventTarget | null): value is Node {
  return (
    value !== null &&
    typeof value === 'object' &&
    'nodeType' in value &&
    typeof value.nodeType === 'number'
  );
}

export class PipelineNavPreviewController {
  private snapshot: PipelineNavPreviewSnapshot = CLOSED;
  private readonly listeners = new Set<() => void>();
  private enabled = true;
  private pointerInTrigger = false;
  private pointerInOverlay = false;
  /** Set when a click collapsed the list under a resting pointer. */
  private suppressHoverUntilLeave = false;
  /** Set only around the programmatic toggle focus after Escape. */
  private suppressFocusOpen = false;
  private recheckTimer: ReturnType<typeof setTimeout> | null = null;
  private menuObserver: MutationObserver | null = null;
  private triggerElement: HTMLElement | null = null;
  private toggleElement: HTMLElement | null = null;
  private overlayElement: HTMLElement | null = null;
  private contentElement: HTMLElement | null = null;
  private readonly isFocusVisible: (element: Element) => boolean;

  constructor(private readonly options: PipelineNavPreviewControllerOptions) {
    this.isFocusVisible = options.isFocusVisible ?? defaultIsFocusVisible;
  }

  // ---------------------------------------------------------------------
  // Store surface
  // ---------------------------------------------------------------------

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): PipelineNavPreviewSnapshot => this.snapshot;

  get previewOpen(): boolean {
    return this.snapshot.previewOpen;
  }

  // ---------------------------------------------------------------------
  // Element registration (callback refs)
  // ---------------------------------------------------------------------

  /** The toggle's hit zone: the full-height toolbar cell around it. */
  readonly setTriggerElement = (element: HTMLElement | null): void => {
    this.triggerElement = element;
  };

  readonly setToggleElement = (element: HTMLElement | null): void => {
    this.toggleElement = element;
  };

  readonly setOverlayElement = (element: HTMLElement | null): void => {
    this.overlayElement = element;
    if (element === null) this.pointerInOverlay = false;
  };

  /** Where focus goes after a keyboard selection closes the preview. */
  readonly setContentElement = (element: HTMLElement | null): void => {
    this.contentElement = element;
  };

  // ---------------------------------------------------------------------
  // Inputs
  // ---------------------------------------------------------------------

  /** Click or keyboard activation of the toggle. */
  readonly toggleClick = (): void => {
    if (this.options.isExpanded()) {
      // The pointer still rests on the toggle; hovering must not reopen the
      // list the user just put away until it leaves and comes back.
      this.suppressHoverUntilLeave = this.pointerInTrigger;
      this.close();
      this.options.setExpanded(false);
      return;
    }
    // Pin first, then drop the preview, so the revealed list is never
    // unmounted in between and its entry is not replayed.
    this.options.setExpanded(true);
    this.close();
  };

  readonly pointerEnterTrigger = (): void => {
    this.pointerInTrigger = true;
    this.cancelPendingClose();
    if (this.suppressHoverUntilLeave) return;
    this.open();
  };

  readonly pointerEnterOverlay = (): void => {
    this.pointerInOverlay = true;
    this.cancelPendingClose();
  };

  /** The pointer left the trigger zone or the overlay. */
  readonly pointerLeave = (
    from: 'trigger' | 'overlay',
    relatedTarget: EventTarget | null,
  ): void => {
    if (from === 'trigger') {
      this.pointerInTrigger = false;
      this.suppressHoverUntilLeave = false;
    } else {
      this.pointerInOverlay = false;
    }
    // Travel between the toggle zone and the overlay (they share an edge),
    // or into a menu that belongs to the preview, is not leaving.
    if (this.isInsidePreviewSurfaces(relatedTarget)) return;
    this.requestClose({ unknownDestination: relatedTarget === null });
  };

  /** Focus arrived somewhere in the trigger zone. */
  readonly focusTrigger = (target: EventTarget | null): void => {
    if (this.suppressFocusOpen) return;
    if (!(target instanceof Element) || !this.isFocusVisible(target)) return;
    this.open();
  };

  /** Focus left the trigger zone or the overlay for `relatedTarget`. */
  readonly focusLeave = (relatedTarget: EventTarget | null): void => {
    if (this.isInsidePreviewSurfaces(relatedTarget)) return;
    this.requestClose({ unknownDestination: false, focusDeparted: true });
  };

  /**
   * Summary, a job, or a variant was selected. Closes the preview (the list
   * stays collapsed) and, when focus was inside it, moves focus to the
   * content so it is never left inside a list that is going away.
   */
  readonly navigate = (): void => {
    if (!this.snapshot.previewOpen) return;
    const focusWasInside = this.containsActiveElement(this.overlayElement);
    this.close();
    if (focusWasInside) this.focusContent();
  };

  /**
   * Escape while previewing: close and return focus to the toggle without
   * that focus reopening the preview. Returns whether it handled the key.
   */
  readonly escape = (): boolean => {
    if (!this.snapshot.previewOpen) return false;
    this.suppressHoverUntilLeave = this.pointerInTrigger;
    this.close();
    const toggle = this.toggleElement;
    if (toggle !== null) {
      this.suppressFocusOpen = true;
      try {
        toggle.focus();
      } finally {
        this.suppressFocusOpen = false;
      }
    }
    return true;
  };

  /**
   * Keyboard entry into an open preview from the toggle (Tab or ArrowDown).
   * The overlay follows the toolbar in DOM order, so this moves focus to its
   * first control. Returns whether focus moved.
   */
  readonly focusFirstPreviewItem = (): boolean => {
    if (!this.snapshot.previewOpen) return false;
    const first = this.firstFocusableInOverlay();
    if (first === null) return false;
    first.focus();
    return true;
  };

  /** Whether `element` is the first focusable control of the overlay. */
  isFirstPreviewItem(element: EventTarget | null): boolean {
    return element !== null && element === this.firstFocusableInOverlay();
  }

  /** Shift+Tab out of the overlay's first control returns to the toggle. */
  readonly focusToggle = (): void => {
    const toggle = this.toggleElement;
    if (toggle === null) return;
    this.suppressFocusOpen = true;
    try {
      toggle.focus();
    } finally {
      this.suppressFocusOpen = false;
    }
  };

  /**
   * Gate from the panel's visibility. A hidden panel closes its preview,
   * drops pointer state, and ignores open requests until visible again.
   */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.dismiss();
  }

  /**
   * Closes the preview at once and releases timers and observers: the panel
   * was hidden or moved to another window's document.
   */
  readonly dismiss = (): void => {
    this.pointerInTrigger = false;
    this.pointerInOverlay = false;
    this.suppressHoverUntilLeave = false;
    this.close();
  };

  /** Releases everything when the owning panel unmounts. */
  dispose(): void {
    this.dismiss();
    this.listeners.clear();
  }

  /** Whether a close timer or menu observer is live (test seam). */
  hasPendingWork(): boolean {
    return this.recheckTimer !== null || this.menuObserver !== null;
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private emit(next: PipelineNavPreviewSnapshot): void {
    if (this.snapshot === next) return;
    this.snapshot = next;
    for (const listener of Array.from(this.listeners)) listener();
  }

  private open(): void {
    if (!this.enabled || this.options.isExpanded()) return;
    this.emit(OPEN);
  }

  private close(): void {
    this.cancelPendingClose();
    this.emit(CLOSED);
  }

  private cancelPendingClose(): void {
    if (this.recheckTimer !== null) {
      clearTimeout(this.recheckTimer);
      this.recheckTimer = null;
    }
    if (this.menuObserver !== null) {
      this.menuObserver.disconnect();
      this.menuObserver = null;
    }
  }

  private requestClose(options: {
    unknownDestination: boolean;
    focusDeparted?: boolean;
  }): void {
    if (!this.snapshot.previewOpen) return;
    if (this.pointerInTrigger || this.pointerInOverlay) return;
    // A preview the keyboard is driving is not closed by incidental pointer
    // travel; it closes when focus itself leaves.
    if (options.focusDeparted !== true && this.keyboardFocusInside()) return;
    // A menu opened from inside the preview holds it open until the menu
    // closes, then the close is re-evaluated.
    if (this.menuOpenInside()) {
      this.deferUntilMenuCloses();
      return;
    }
    if (options.unknownDestination) {
      // OS drag regions and window edges report leaves with no destination
      // while the pointer may still be over the preview; re-check shortly.
      this.cancelPendingClose();
      this.recheckTimer = setTimeout((): void => {
        this.recheckTimer = null;
        if (this.pointerInTrigger || this.pointerInOverlay) return;
        if (this.keyboardFocusInside()) return;
        if (this.menuOpenInside()) {
          this.deferUntilMenuCloses();
          return;
        }
        this.close();
      }, PIPELINE_NAV_PREVIEW_UNKNOWN_LEAVE_RECHECK_MS);
      return;
    }
    this.close();
  }

  private deferUntilMenuCloses(): void {
    const overlay = this.overlayElement;
    const View = overlay?.ownerDocument.defaultView;
    if (
      overlay === null ||
      View === null ||
      View === undefined ||
      typeof View.MutationObserver !== 'function'
    ) {
      return;
    }
    this.cancelPendingClose();
    this.menuObserver = new View.MutationObserver((): void => {
      if (this.menuOpenInside()) return;
      this.menuObserver?.disconnect();
      this.menuObserver = null;
      this.requestClose({ unknownDestination: false });
    });
    this.menuObserver.observe(overlay, {
      attributes: true,
      attributeFilter: ['aria-expanded'],
      subtree: true,
    });
  }

  private menuOpenInside(): boolean {
    return this.overlayElement?.querySelector(OPEN_MENU_SELECTOR) != null;
  }

  private isInsidePreviewSurfaces(target: EventTarget | null): boolean {
    if (!isNode(target)) return false;
    if (this.triggerElement?.contains(target) === true) return true;
    if (this.overlayElement?.contains(target) === true) return true;
    const scopeId = this.options.scopeId;
    const ownerDocument = target.ownerDocument;
    if (scopeId === undefined || ownerDocument === null) return false;
    // Portalled menus live elsewhere in the document; they mark themselves
    // with this preview's scope.
    return Array.from(
      ownerDocument.querySelectorAll(
        `[${PIPELINE_NAV_PREVIEW_SCOPE_ATTRIBUTE}="${escapeAttributeValue(scopeId)}"]`,
      ),
    ).some((scoped) => scoped.contains(target));
  }

  private activeElement(): Element | null {
    const doc =
      this.overlayElement?.ownerDocument ??
      this.triggerElement?.ownerDocument ??
      null;
    return doc?.activeElement ?? null;
  }

  private containsActiveElement(container: HTMLElement | null): boolean {
    const active = this.activeElement();
    return container !== null && active !== null && container.contains(active);
  }

  private keyboardFocusInside(): boolean {
    const active = this.activeElement();
    if (active === null) return false;
    const inside =
      this.triggerElement?.contains(active) === true ||
      this.overlayElement?.contains(active) === true;
    return inside && this.isFocusVisible(active);
  }

  private firstFocusableInOverlay(): HTMLElement | null {
    return (
      this.overlayElement?.querySelector<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? null
    );
  }

  private focusContent(): void {
    this.contentElement?.focus({ preventScroll: true });
  }
}

/** Attribute-value escaping for the scope selector (ids are panel ids). */
function escapeAttributeValue(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
