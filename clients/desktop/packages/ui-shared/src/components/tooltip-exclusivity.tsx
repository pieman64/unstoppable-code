import {
  createContext,
  useContext,
  useEffect,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';

/**
 * Whether shared tooltips may stack. `stack` keeps each tooltip independent.
 * `single` shows one at a time per window: the tooltip or card that opens
 * closes the one already open, so a row's preview card can never sit over
 * another row's card or an unrelated control's tooltip. A row's card and the
 * tooltips of controls inside that row show together. Hosts choose it once at
 * their root; desktop picks `single` under early access.
 */
export type TooltipStacking = 'stack' | 'single';

const TooltipStackingContext = createContext<TooltipStacking>('stack');

export function TooltipStackingProvider({
  value,
  children,
}: {
  readonly value: TooltipStacking;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <TooltipStackingContext.Provider value={value}>
      {children}
    </TooltipStackingContext.Provider>
  );
}

interface OpenTooltip {
  readonly close: () => void;
  readonly triggerRef: RefObject<HTMLElement | null>;
  readonly surfaceRef: RefObject<HTMLElement | null>;
}

const openTooltips = new WeakMap<Document, Set<OpenTooltip>>();

/**
 * Whether a tooltip on `trigger` belongs with an open one instead of
 * replacing it: its trigger sits inside the open tooltip's surface (a control
 * inside an interactive card), inside the open tooltip's trigger (a control
 * inside a row whose card is open), or around it (the row's card opening
 * while one of its controls shows a tooltip).
 */
function belongsWith(open: OpenTooltip, trigger: HTMLElement): boolean {
  const openTrigger = open.triggerRef.current;
  return (
    open.surfaceRef.current?.contains(trigger) === true ||
    openTrigger?.contains(trigger) === true ||
    (openTrigger !== null && trigger.contains(openTrigger))
  );
}

/**
 * Claims the window's open-tooltip slot while `open`, closing every open
 * tooltip it does not belong with (see `belongsWith`), so unrelated tooltips
 * never stack while a row's card and its controls' tooltips can show together.
 */
export function useSingleOpenTooltip({
  open,
  close,
  triggerRef,
  surfaceRef,
}: {
  readonly open: boolean;
  readonly close: () => void;
  readonly triggerRef: RefObject<HTMLElement | null>;
  readonly surfaceRef: RefObject<HTMLElement | null>;
}): void {
  const stacking = useContext(TooltipStackingContext);
  useEffect((): (() => void) | undefined => {
    if (stacking !== 'single' || !open) return undefined;
    const trigger = triggerRef.current;
    if (!trigger) return undefined;
    const doc = trigger.ownerDocument;
    let entries = openTooltips.get(doc);
    if (!entries) {
      entries = new Set();
      openTooltips.set(doc, entries);
    }
    for (const other of [...entries]) {
      if (other.close === close || belongsWith(other, trigger)) continue;
      entries.delete(other);
      other.close();
    }
    const entry: OpenTooltip = { close, triggerRef, surfaceRef };
    entries.add(entry);
    const openEntries = entries;
    return (): void => {
      openEntries.delete(entry);
    };
  }, [stacking, open, close, triggerRef, surfaceRef]);
}
