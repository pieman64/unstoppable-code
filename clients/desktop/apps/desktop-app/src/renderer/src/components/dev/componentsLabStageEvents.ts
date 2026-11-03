/*
 * Reaching a real component's own handlers from a stage script, for state the
 * lab's hover and press mapping cannot cause (a tooltip opening, a copy
 * confirming). Target names are unique across the page.
 */

/**
 * The element a target names, or the first button inside it when the target
 * marks a wrapper around a component that takes no `data-target`.
 */
function stageTarget(name: string): HTMLElement | null {
  const el = document.querySelector<HTMLElement>(`[data-target="${name}"]`);
  if (!el || el.matches('button, input, textarea')) return el;
  return el.querySelector<HTMLElement>('button') ?? el;
}

/**
 * Points at a real component through its own handlers: the mouseover React
 * turns into `onMouseEnter`, for state the CSS mapping cannot reach (a
 * tooltip opening). Target names are unique across the page.
 */
export function pointAt(name: string): void {
  const el = stageTarget(name);
  el?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
}

/** The matching leave, so the component closes what pointing opened. */
export function pointAway(name: string): void {
  const el = stageTarget(name);
  el?.dispatchEvent(
    new MouseEvent('mouseout', {
      bubbles: true,
      relatedTarget: document.body,
    }),
  );
}

/** Clicks a real component, so its own onClick runs. */
export function press(name: string): void {
  stageTarget(name)?.click();
}
