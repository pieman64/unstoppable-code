/** @jest-environment jsdom */

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ToastStackActivatableCard } from '../ToastStack';

type TestWindow = Window & typeof globalThis;

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('ToastStackActivatableCard across documents', (): void => {
  let container: HTMLDivElement;
  let root: Root;
  let iframe: HTMLIFrameElement;
  let childDocument: Document = document;
  let childWindow: TestWindow = window;

  beforeEach((): void => {
    jest.useFakeTimers();
    container = document.createElement('div');
    iframe = document.createElement('iframe');
    document.body.appendChild(container);
    document.body.appendChild(iframe);
    const iframeDocument = iframe.contentDocument;
    const iframeWindow = iframe.contentWindow;
    if (iframeDocument === null || iframeWindow === null) {
      throw new Error('iframe document unavailable');
    }
    childDocument = iframeDocument;
    // `window` is the full global surface of the iframe's realm.
    childWindow = iframeWindow.window;
    root = createRoot(container);
  });

  afterEach((): void => {
    act(() => root.unmount());
    act(() => jest.runOnlyPendingTimers());
    jest.useRealTimers();
    document.body.replaceChildren();
  });

  function render(children: ReactNode, onActivate: () => void): void {
    act(() =>
      root.render(
        <ToastStackActivatableCard
          onActivate={onActivate}
          activateLabel="Read full notification"
          blurFocusBeforeActivate
          toastType="error"
        >
          {children}
        </ToastStackActivatableCard>,
      ),
    );
  }

  function requiredElement(selector: string): Element {
    const element = container.querySelector(selector);
    if (element === null) throw new Error(`no element matches ${selector}`);
    return element;
  }

  function requiredHTMLElement(selector: string): HTMLElement {
    const element = container.querySelector<HTMLElement>(selector);
    if (element === null) throw new Error(`no element matches ${selector}`);
    return element;
  }

  function pointerEvent(
    eventWindow: TestWindow,
    type: string,
    clientX: number,
    clientY: number,
    pointerId = 1,
  ): Event {
    if (typeof eventWindow.PointerEvent === 'function') {
      return new eventWindow.PointerEvent(type, {
        bubbles: true,
        button: 0,
        cancelable: true,
        clientX,
        clientY,
        pointerId,
      });
    }
    const event = new eventWindow.MouseEvent(type, {
      bubbles: true,
      button: 0,
      cancelable: true,
      clientX,
      clientY,
    });
    Object.defineProperty(event, 'pointerId', { value: pointerId });
    return event;
  }

  function dispatchPointerDownAndUp(
    target: Element,
    ownerDocument: Document,
    eventWindow: TestWindow,
  ): void {
    act(() => {
      target.dispatchEvent(pointerEvent(eventWindow, 'pointerdown', 0, 0));
      ownerDocument.dispatchEvent(pointerEvent(eventWindow, 'pointerup', 0, 0));
    });
  }

  function dispatchClick(target: Element, eventWindow: TestWindow): void {
    act(() => {
      target.dispatchEvent(
        new eventWindow.MouseEvent('click', { bubbles: true }),
      );
    });
  }

  it('activates once for adopted and fresh nodes in both documents', (): void => {
    const onActivate = jest.fn<void, []>();
    render(<p data-testid="adopted">Adopted opener node</p>, onActivate);
    const adopted = requiredElement('[data-testid="adopted"]');

    childDocument.body.appendChild(container);
    render(
      <>
        <p data-testid="adopted">Adopted opener node</p>
        <p data-testid="child-created">Fresh child node</p>
      </>,
      onActivate,
    );
    const childCreated = requiredElement('[data-testid="child-created"]');
    requiredElement('[data-testid="toast-card"]').appendChild(adopted);

    expect(childWindow.Element).not.toBe(window.Element);
    expect(adopted.ownerDocument).toBe(childDocument);
    expect(adopted.isConnected).toBe(true);
    expect(adopted instanceof window.Element).toBe(true);
    expect(childCreated instanceof childWindow.Element).toBe(true);

    dispatchPointerDownAndUp(adopted, childDocument, childWindow);
    expect(onActivate).toHaveBeenCalledTimes(1);
    dispatchClick(adopted, childWindow);
    expect(onActivate).toHaveBeenCalledTimes(1);

    dispatchPointerDownAndUp(childCreated, childDocument, childWindow);
    expect(onActivate).toHaveBeenCalledTimes(2);
    dispatchClick(childCreated, childWindow);
    expect(onActivate).toHaveBeenCalledTimes(2);

    adopted.remove();
    document.body.appendChild(container);
    render(
      <>
        <p data-testid="adopted">Adopted opener node</p>
        <p data-testid="child-created">Fresh child node</p>
        <p data-testid="opener-created">Fresh opener node</p>
      </>,
      onActivate,
    );
    const openerCreated = requiredElement('[data-testid="opener-created"]');
    expect(openerCreated instanceof window.Element).toBe(true);
    dispatchPointerDownAndUp(openerCreated, document, window);
    expect(onActivate).toHaveBeenCalledTimes(3);
    dispatchClick(openerCreated, window);
    expect(onActivate).toHaveBeenCalledTimes(3);
  });

  it('does not activate a swipe or let an opener pointerup finish it', (): void => {
    const onActivate = jest.fn<void, []>();
    render(<p data-testid="body">Body</p>, onActivate);
    childDocument.body.appendChild(container);
    render(<p data-testid="body">Fresh child body</p>, onActivate);
    const body = requiredElement('[data-testid="body"]');

    act(() => {
      body.dispatchEvent(pointerEvent(childWindow, 'pointerdown', 0, 0));
      childDocument.dispatchEvent(pointerEvent(childWindow, 'pointerup', 9, 0));
    });
    expect(onActivate).not.toHaveBeenCalled();

    // A stale listener on the opener document must not complete the swipe.
    act(() => {
      document.dispatchEvent(pointerEvent(window, 'pointerup', 0, 0));
    });
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('does not activate a child-realm button on pointer or click', (): void => {
    const onActivate = jest.fn<void, []>();
    render(<p>Initial</p>, onActivate);
    childDocument.body.appendChild(container);
    render(
      <button type="button" data-testid="child-button">
        Dismiss
      </button>,
      onActivate,
    );
    const button = requiredElement('[data-testid="child-button"]');

    act(() => {
      button.dispatchEvent(pointerEvent(childWindow, 'pointerdown', 0, 0));
      childDocument.dispatchEvent(pointerEvent(childWindow, 'pointerup', 0, 0));
      button.dispatchEvent(
        new childWindow.MouseEvent('click', { bubbles: true }),
      );
    });

    expect(button instanceof childWindow.Element).toBe(true);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('blurs focus in the card owner document before pointer activation', (): void => {
    const onActivate = jest.fn<void, []>();
    render(<p data-testid="body">Initial</p>, onActivate);
    childDocument.body.appendChild(container);
    render(
      <>
        <input data-testid="focused" />
        <p data-testid="body">Fresh child body</p>
      </>,
      onActivate,
    );
    const focused = requiredHTMLElement('[data-testid="focused"]');
    const body = requiredElement('[data-testid="body"]');
    act(() => {
      focused.focus();
    });
    expect(childDocument.activeElement).toBe(focused);

    dispatchPointerDownAndUp(body, childDocument, childWindow);

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(childDocument.activeElement).not.toBe(focused);
    dispatchClick(body, childWindow);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('keeps pointer activation working in the main document', (): void => {
    const onActivate = jest.fn<void, []>();
    render(<p data-testid="body">Body</p>, onActivate);

    dispatchPointerDownAndUp(
      requiredElement('[data-testid="body"]'),
      document,
      window,
    );

    expect(onActivate).toHaveBeenCalledTimes(1);
    dispatchClick(requiredElement('[data-testid="body"]'), window);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});
