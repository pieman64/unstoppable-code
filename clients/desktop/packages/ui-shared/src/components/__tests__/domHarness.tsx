import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

/**
 * A mounted React root for jsdom component tests, with the lookups and user
 * gestures those tests repeat. `cleanup` unmounts and removes the container.
 */
export interface DomHarness {
  readonly container: HTMLElement;
  render(element: ReactElement): void;
  cleanup(): void;
  /** The first element with `data-testid` anywhere in the document (menus portal out). */
  byTestId(testId: string): HTMLElement;
  queryTestId(testId: string): HTMLElement | null;
  /** The first element matching `selector` anywhere in the document. */
  select(selector: string): HTMLElement;
  /** The first button in the document whose accessible name or text is `name`. */
  button(name: string): HTMLButtonElement;
  click(element: Element): void;
  key(element: Element, key: string): void;
}

export function createDomHarness(): DomHarness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const queryTestId = (testId: string): HTMLElement | null =>
    document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  const select = (selector: string): HTMLElement => {
    const found = document.querySelector<HTMLElement>(selector);
    if (!found) throw new Error(`Nothing matches ${selector}`);
    return found;
  };
  return {
    container,
    render: (element) => {
      act(() => root.render(element));
    },
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
    queryTestId,
    byTestId: (testId) => {
      const found = queryTestId(testId);
      if (!found) throw new Error(`No element with data-testid ${testId}`);
      return found;
    },
    select,
    button: (name) => {
      const found = Array.from(
        document.querySelectorAll<HTMLButtonElement>('button'),
      ).find(
        (button) =>
          button.getAttribute('aria-label') === name ||
          button.textContent?.trim() === name,
      );
      if (!found) throw new Error(`No button named ${name}`);
      return found;
    },
    click: (element) => {
      act(() => {
        element.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
      });
    },
    key: (element, key) => {
      act(() => {
        element.dispatchEvent(
          new KeyboardEvent('keydown', {
            key,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    },
  };
}
