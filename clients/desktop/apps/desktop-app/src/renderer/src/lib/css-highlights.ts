/**
 * Named highlights over the CSS Custom Highlight API (Chromium 105+), for
 * decorating `Range` objects without mutating the DOM. Highlight appearance is
 * defined in globals.css via `::highlight(<name>)`.
 *
 * Decorating arbitrary ranges this way (rather than wrapping text in elements)
 * keeps the underlying markup intact, so it survives React re-renders.
 *
 * A highlight registry (`CSS.highlights`) is global to one window, but several
 * views can paint the same highlight name in it at once (two plan panels, or a
 * panel beside the plan takeover), and a popped-out panel lives in another
 * window's document. Each view therefore registers through its own
 * {@link HighlightContributor}: ranges are kept per contributor, the window's
 * named highlight is the union of every live contributor's ranges, and one
 * view clearing or unmounting never erases another view's ranges.
 */

/** One view's handle on the named highlights of its owning window. */
export interface HighlightContributor {
  /** Document whose window registry this contributor paints into. */
  readonly ownerDocument: Document;
  /** Replace this contributor's ranges for `name` (empty clears them). */
  set: (name: string, ranges: readonly Range[]) => void;
  /** Remove this contributor's ranges for `name`. */
  clear: (name: string) => void;
  /** Remove every range this contributor registered, in every name. */
  dispose: () => void;
}

type HighlightWindow = NonNullable<Document['defaultView']>;

/** Ranges per contributor, per highlight name, for one window. */
type WindowHighlightRanges = Map<string, Map<number, readonly Range[]>>;

const rangesByWindow = new WeakMap<HighlightWindow, WindowHighlightRanges>();
let nextContributorId = 0;

function highlightsSupported(view: HighlightWindow): boolean {
  return (
    typeof view.CSS !== 'undefined' &&
    typeof view.Highlight === 'function' &&
    view.CSS.highlights !== undefined
  );
}

function windowRanges(view: HighlightWindow): WindowHighlightRanges {
  const existing = rangesByWindow.get(view);
  if (existing) {
    return existing;
  }
  const created: WindowHighlightRanges = new Map();
  rangesByWindow.set(view, created);
  return created;
}

/** Write the union of every contributor's ranges for `name` into `view`. */
function paint(view: HighlightWindow, name: string): void {
  if (!highlightsSupported(view)) {
    return;
  }
  const union: Range[] = [];
  windowRanges(view)
    .get(name)
    ?.forEach((ranges) => {
      union.push(...ranges);
    });
  if (union.length === 0) {
    view.CSS.highlights.delete(name);
    return;
  }
  view.CSS.highlights.set(name, new view.Highlight(...union));
}

/**
 * Create a contributor that paints named highlights into `ownerDocument`'s
 * window. Every method is a no-op when that window lacks the Custom Highlight
 * API or the document has no window.
 */
export function createHighlightContributor(
  ownerDocument: Document,
): HighlightContributor {
  nextContributorId += 1;
  const id = nextContributorId;
  const names = new Set<string>();

  const set = (name: string, ranges: readonly Range[]): void => {
    const view = ownerDocument.defaultView;
    if (!view) {
      return;
    }
    const byName = windowRanges(view);
    const contributors =
      byName.get(name) ?? new Map<number, readonly Range[]>();
    if (ranges.length === 0) {
      contributors.delete(id);
      names.delete(name);
    } else {
      contributors.set(id, [...ranges]);
      names.add(name);
    }
    if (contributors.size === 0) {
      byName.delete(name);
    } else {
      byName.set(name, contributors);
    }
    paint(view, name);
  };

  const clear = (name: string): void => {
    set(name, []);
  };

  const dispose = (): void => {
    for (const name of Array.from(names)) {
      clear(name);
    }
  };

  return { ownerDocument, set, clear, dispose };
}
