/**
 * Body-level "a menu is open" flag, reference-counted across every open menu
 * surface (FloatingMenu, AnchoredMenu, bespoke dropdown portals). While set,
 * the app suppresses hover feedback on inert background surfaces (see the
 * `data-sidebar-menu-open` rules in the desktop globals.css). One shared
 * counter per document keeps overlapping menus from clearing each other's
 * flag.
 */
const countsByDocument = new WeakMap<Document, number>();

/**
 * Whether any menu surface currently holds the flag.
 *
 * A closed menu's trigger reads this to tell "the user is switching from
 * another open menu" from "the user is opening the first menu". That matters
 * because the open menu dismisses on `pointerdown` and swallows the click that
 * press would otherwise complete (see `suppressNextClick`), so a trigger that
 * only opens on `click` would need a second press to take over.
 */
export function isMenuOpenBodyFlagSet(doc: Document): boolean {
  return doc.body.dataset.sidebarMenuOpen === 'true';
}

export function pushMenuOpenBodyFlag(doc: Document): () => void {
  countsByDocument.set(doc, (countsByDocument.get(doc) ?? 0) + 1);
  doc.body.dataset.sidebarMenuOpen = 'true';
  let released = false;
  return (): void => {
    if (released) {
      return;
    }
    released = true;
    const next = Math.max(0, (countsByDocument.get(doc) ?? 1) - 1);
    countsByDocument.set(doc, next);
    if (next === 0) {
      delete doc.body.dataset.sidebarMenuOpen;
    }
  };
}
