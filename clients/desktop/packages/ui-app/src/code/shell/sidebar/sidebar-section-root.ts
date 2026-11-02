import { useEffect, useRef } from 'react';

/**
 * What an open section tells its host about returning to its root from the
 * current sidebar row.
 */
export interface SidebarSectionRootReset {
  /** The section shows its root: no detail, editor, category or source open. */
  readonly atRoot: () => boolean;
  /** Puts the root back as entered, in place: its first tab, at the top. */
  readonly resetInPlace: () => void;
}

export interface SidebarSectionRootReturn {
  /** The open section, when it has registered one. */
  readonly section: SidebarSectionRootReset | undefined;
  /** Enters the root fresh, the same as arriving from another page. */
  readonly enterRoot: () => void;
}

/**
 * One rule for the current row's click on desktop and web (QA, 2026-10-23):
 * from a deeper page the section enters its root fresh; on the root itself
 * only its tab and scroll reset, so the pane does not remount and flicker.
 * A section that reports nothing enters its root fresh.
 */
export function returnSidebarSectionToRoot({
  section,
  enterRoot,
}: SidebarSectionRootReturn): void {
  if (section?.atRoot() === true) {
    section.resetInPlace();
    return;
  }
  enterRoot();
}

/** Where the host finds the open section's {@link SidebarSectionRootReset}. */
export interface SidebarSectionRootRegistry {
  /** Registers the open section; the returned call unregisters it. */
  readonly register: (section: SidebarSectionRootReset) => () => void;
  readonly current: () => SidebarSectionRootReset | undefined;
}

export function createSidebarSectionRootRegistry(): SidebarSectionRootRegistry {
  let current: SidebarSectionRootReset | undefined;
  return {
    register: (section) => {
      current = section;
      return (): void => {
        // A late cleanup of an older section leaves the newer one in place.
        if (current === section) current = undefined;
      };
    },
    current: () => current,
  };
}

/**
 * Registers a mounted section with `registry`, reading `atRoot` and
 * `resetInPlace` from the latest render when the row is clicked.
 */
export function useSidebarSectionRoot(
  registry: SidebarSectionRootRegistry | null | undefined,
  atRoot: boolean,
  resetInPlace: () => void,
): void {
  const latest = useRef({ atRoot, resetInPlace });
  useEffect(() => {
    latest.current = { atRoot, resetInPlace };
  });
  useEffect(
    () =>
      registry?.register({
        atRoot: () => latest.current.atRoot,
        resetInPlace: () => latest.current.resetInPlace(),
      }),
    [registry],
  );
}

/**
 * Scrolls a section back to its top: `element`, the ancestors it scrolls in
 * and the lists scrolled inside it, so it works whichever of them the page
 * scrolls with.
 */
export function scrollSectionToTop(element: Element | null | undefined): void {
  if (!element) return;
  // Read every offset before writing any, so the writes force no layout
  // between reads.
  const scrolled: Element[] = [];
  for (
    let node: Element | null = element;
    node !== null;
    node = node.parentElement
  ) {
    if (node.scrollTop !== 0) scrolled.push(node);
  }
  for (const node of element.querySelectorAll('*')) {
    if (node.scrollTop !== 0) scrolled.push(node);
  }
  for (const node of scrolled) node.scrollTop = 0;
}
