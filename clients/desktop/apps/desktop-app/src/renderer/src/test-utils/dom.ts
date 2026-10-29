/**
 * Small DOM helpers for jsdom component tests (no @testing-library/user-event
 * dependency). Kept here so individual test files stay free of non-null
 * assertions and unbound-method lint churn.
 */

/** Returns the element with `data-testid`, throwing when absent. */
export function requireByTestId(testId: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  if (!found) {
    throw new Error(`Element not found: ${testId}`);
  }
  return found;
}

/** Returns the first element matching `selector`, throwing when absent. */
export function requireSelector(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) {
    throw new Error(`Element not found: ${selector}`);
  }
  return found;
}

/**
 * Sets a controlled React input/textarea's value through the native
 * prototype setter (bypassing React's value tracking) and fires an `input`
 * event so React's onChange observes the change.
 */
export function setNativeInputValue(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  // The setter is invoked via `.call(input, ...)` below, so `this` is bound
  // explicitly.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const setter = descriptor ? descriptor.set : undefined;
  if (!setter) {
    throw new Error('Native value setter not found');
  }
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Keyboard-driven focus. The shared tooltips follow `:focus-visible`: a Tab
 * keydown reaches the document before focus moves, so the tooltip opens. A
 * bare `.focus()` is programmatic focus and keeps it closed.
 */
export function focusViaKeyboard(
  element: HTMLElement | null | undefined,
): void {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
  );
  element?.focus();
}

/**
 * An element's accessible label: the text of its `aria-labelledby` targets,
 * joined by spaces, or else its `aria-label`.
 */
export function accessibleLabel(
  element: Element | null | undefined,
): string | null {
  const ids = element?.getAttribute('aria-labelledby');
  if (!ids) return element?.getAttribute('aria-label') ?? null;
  return ids
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');
}
