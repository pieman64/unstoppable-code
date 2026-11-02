'use client';

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * The composer tray: what sits on a chat's composer and tucks under its top
 * edge, such as the compact queue's card.
 *
 * A chat surface stacks notices, approvals and other trays above its
 * composer box, and each host orders them differently. Content that tucks
 * under the composer has to sit right on it, below all of them; anywhere
 * else its tucked edge runs into whatever comes next. So the tray content
 * renders wherever its data lives (`ComposerTray`) and lands in a slot on
 * the composer the surface currently shows (`ComposerTraySlot`).
 *
 * - `ChatComposerShell` offers a slot just before its box, and a top
 *   `ComposerDrawer` (tips, background work) one just before itself; the
 *   earliest slot on the page wins, so the tray tucks under the drawer when
 *   one shows and under the box otherwise.
 * - Slots render only while there is tray content, so a composer with
 *   nothing to show keeps its markup unchanged.
 * - `ComposerTrayProvider` wraps the chat surface: the transcript, which
 *   owns the content, and the composer, which owns the slots.
 * - `ComposerTrayHost` marks the composer that shows; only slots inside an
 *   active host take the tray, so a hidden composer, or a composer-styled
 *   box elsewhere in the surface, never does.
 */

interface ComposerTrayState {
  /** The slot the tray lands in: the earliest on the page. */
  readonly target: HTMLElement | null;
  /** Some tray content wants a slot, so slots render. */
  readonly wanted: boolean;
  readonly register: (slot: HTMLElement) => void;
  readonly unregister: (slot: HTMLElement) => void;
  /** Marks content as wanting a slot; returns the release. */
  readonly want: () => () => void;
}

const ComposerTrayContext = createContext<ComposerTrayState | null>(null);
const ComposerTrayHostContext = createContext(false);

function documentOrder(a: HTMLElement, b: HTMLElement): number {
  if (a === b) return 0;
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
    ? -1
    : 1;
}

/**
 * Owns the tray for a chat surface. Off (`enabled={false}`), it passes the
 * enclosing surface's tray through: a view that draws no composer of its own
 * hands its tray content to the host's composer.
 */
export function ComposerTrayProvider({
  enabled = true,
  children,
}: {
  readonly enabled?: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  const enclosing = useContext(ComposerTrayContext);
  const [slots, setSlots] = useState<readonly HTMLElement[]>([]);
  const [wanters, setWanters] = useState(0);
  const register = useCallback((slot: HTMLElement): void => {
    setSlots((current) =>
      current.includes(slot) ? current : [...current, slot].sort(documentOrder),
    );
  }, []);
  const unregister = useCallback((slot: HTMLElement): void => {
    setSlots((current) =>
      current.includes(slot)
        ? current.filter((candidate) => candidate !== slot)
        : current,
    );
  }, []);
  const want = useCallback((): (() => void) => {
    setWanters((count) => count + 1);
    return (): void => setWanters((count) => count - 1);
  }, []);
  const own = useMemo(
    (): ComposerTrayState => ({
      target: slots[0] ?? null,
      wanted: wanters > 0,
      register,
      unregister,
      want,
    }),
    [slots, wanters, register, unregister, want],
  );
  return (
    <ComposerTrayContext.Provider value={enabled ? own : enclosing}>
      {children}
    </ComposerTrayContext.Provider>
  );
}

/** Lets the slots inside it take the tray while `active`. */
export function ComposerTrayHost({
  active,
  children,
}: {
  readonly active: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <ComposerTrayHostContext.Provider value={active}>
      {children}
    </ComposerTrayHostContext.Provider>
  );
}

/**
 * A place the tray can land: rendered just before the composer box, or a
 * top drawer above it. It takes no room of its own (`display: contents`), so
 * the tray content lays out as that element's previous sibling.
 */
export function ComposerTraySlot(): JSX.Element | null {
  const tray = useContext(ComposerTrayContext);
  const hosting = useContext(ComposerTrayHostContext);
  const register = tray?.register;
  const unregister = tray?.unregister;
  const mounted = useRef<HTMLElement | null>(null);
  const ref = useCallback(
    (node: HTMLDivElement | null): void => {
      if (node) {
        mounted.current = node;
        register?.(node);
        return;
      }
      const previous = mounted.current;
      mounted.current = null;
      if (previous) unregister?.(previous);
    },
    [register, unregister],
  );
  if (!tray || !hosting || !tray.wanted) return null;
  return <div ref={ref} className="contents" data-composer-tray-slot="" />;
}

/**
 * Renders `children` on the shown composer, under every notice above it.
 * With no slot to land in (no provider, or a host composer that draws
 * none), it renders in place.
 */
export function ComposerTray({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const tray = useContext(ComposerTrayContext);
  const want = tray?.want;
  // Before paint, so the slots render in the same frame as the content.
  useLayoutEffect(() => want?.(), [want]);
  const target = tray?.target;
  return target ? createPortal(children, target) : <>{children}</>;
}

/**
 * Wraps a composer box's own content so a box nested inside it never takes
 * the tray a second time.
 */
export function ComposerTrayBoundary({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <ComposerTrayHostContext.Provider value={false}>
      {children}
    </ComposerTrayHostContext.Provider>
  );
}
