/**
 * The shared definition of "focusable" used by `DialogModal` and
 * `FloatingMenu`.
 *
 * Not yet every focus-managing surface in the package — `WorktreeDialogs` still
 * carries its own selector with different rules. Folding it in is worthwhile
 * but is not this change's business.
 *
 * There used to be two: `FloatingMenu`'s and `DialogModal`'s, with quietly
 * different rules — one excluded `aria-disabled="true"`, the other did not; one
 * read the `tabindex` attribute, the other the `tabIndex` property (which
 * reports 0 for a `<button>` with no attribute, so the two disagree about
 * plain buttons the moment anything sets `tabindex="-1"` dynamically). Two
 * focus traps in one package that disagree about what is focusable will drift,
 * and the symptom is a surface that traps Tab onto nothing.
 *
 * Deliberately narrower than a full focusability check: this answers "what are
 * the Tab stops inside this surface", not "what could receive focus at all".
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[tabindex]',
].join(',');

/** Adopted elements retain their original realm's prototype. */
export function isFocusReturnTarget(
  target: Element | null,
): target is Element & Pick<HTMLElement, 'focus'> {
  return (
    target !== null && 'focus' in target && typeof target.focus === 'function'
  );
}

/**
 * Focusable descendants of `root`, in DOM order, excluding `root` itself.
 *
 * `root` is excluded because focus containers carry `tabindex="-1"` so they can
 * be focused programmatically; letting the container become a cycle target
 * would make Tab appear to do nothing.
 *
 * Cross-realm safe: elements are matched by selector rather than by
 * `instanceof`, so a surface rendered into an `ownerDocument` from another
 * window (an iframe, or a second Electron window) is handled correctly. A
 * global `instanceof HTMLElement` check silently returns nothing there.
 */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((item) => item !== root)
    .filter((item) => item.getAttribute('tabindex') !== '-1')
    .filter(
      (item) =>
        !item.hasAttribute('disabled') &&
        item.getAttribute('aria-disabled') !== 'true',
    );
}
