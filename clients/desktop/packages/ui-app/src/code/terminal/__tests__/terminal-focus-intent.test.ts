/** @jest-environment jsdom */
import {
  consumeTerminalFocusRequest,
  requestTerminalFocus,
  __resetTerminalFocusIntentForTests,
} from '../terminal-focus-intent';

describe('terminal focus intent owner-window tracking', () => {
  let iframe: HTMLIFrameElement;
  let ownerDocument: Document;
  let ownerWindow: Window;

  beforeEach(() => {
    __resetTerminalFocusIntentForTests();
    iframe = document.createElement('iframe');
    document.body.append(iframe);
    if (iframe.contentDocument === null || iframe.contentWindow === null) {
      throw new Error('Expected iframe document and window');
    }
    ownerDocument = iframe.contentDocument;
    ownerWindow = iframe.contentWindow;
    Object.defineProperty(ownerDocument, 'hasFocus', {
      configurable: true,
      value: (): boolean => true,
    });
  });

  afterEach(() => {
    iframe.remove();
  });

  it('lets an auxiliary-window pane consume only its own focus request', () => {
    requestTerminalFocus('terminal-aux', ownerDocument);

    expect(consumeTerminalFocusRequest('terminal-aux', ownerDocument)).toBe(
      true,
    );

    requestTerminalFocus('terminal-aux', ownerDocument);
    expect(consumeTerminalFocusRequest('terminal-aux', document)).toBe(false);
    expect(consumeTerminalFocusRequest('terminal-aux', ownerDocument)).toBe(
      true,
    );
  });

  it('invalidates an auxiliary-window request when that window blurs', () => {
    requestTerminalFocus('terminal-aux', ownerDocument);

    ownerWindow.dispatchEvent(new Event('blur'));

    expect(consumeTerminalFocusRequest('terminal-aux', ownerDocument)).toBe(
      false,
    );
  });

  it('drops an auxiliary window request and its listeners when it closes', () => {
    requestTerminalFocus('terminal-aux', ownerDocument);

    ownerWindow.dispatchEvent(new Event('pagehide'));

    expect(consumeTerminalFocusRequest('terminal-aux', ownerDocument)).toBe(
      false,
    );
  });

  it('stops tracking a closed auxiliary window instead of leaking listeners', () => {
    const removeSpy = jest.spyOn(ownerWindow, 'removeEventListener');
    requestTerminalFocus('terminal-aux', ownerDocument);

    ownerWindow.dispatchEvent(new Event('pagehide'));

    const removedEvents = removeSpy.mock.calls.map(([type]) => type);
    expect(removedEvents).toEqual(
      expect.arrayContaining(['blur', 'focus', 'pagehide']),
    );

    // A window that closed and is somehow used again re-installs tracking
    // rather than silently running without it.
    const addSpy = jest.spyOn(ownerWindow, 'addEventListener');
    requestTerminalFocus('terminal-aux', ownerDocument);
    expect(addSpy.mock.calls.map(([type]) => type)).toEqual(
      expect.arrayContaining(['blur', 'focus', 'pagehide']),
    );

    removeSpy.mockRestore();
    addSpy.mockRestore();
  });

  // `focusOnSpawn` records a request from an async setup/launch script event,
  // which can land while the user is in a different worktree. No pane is
  // mounted to consume or clear it, so without a TTL the request would sit
  // here and be redeemed by a later PASSIVE switch back — the exact leak this
  // module exists to prevent.
  it('voids a request that no pane consumed within the TTL', () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    requestTerminalFocus('terminal-script', ownerDocument);

    nowSpy.mockReturnValue(1_000 + 10_000);

    expect(consumeTerminalFocusRequest('terminal-script', ownerDocument)).toBe(
      false,
    );
    nowSpy.mockRestore();
  });

  it('still honors a request consumed inside the TTL', () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    requestTerminalFocus('terminal-script', ownerDocument);

    nowSpy.mockReturnValue(1_000 + 9_999);

    expect(consumeTerminalFocusRequest('terminal-script', ownerDocument)).toBe(
      true,
    );
    nowSpy.mockRestore();
  });

  it('does not let an expired request survive to be redeemed later', () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    requestTerminalFocus('terminal-script', ownerDocument);

    // Lapse, attempt a consume (which voids it), then return to "now".
    nowSpy.mockReturnValue(1_000 + 20_000);
    expect(consumeTerminalFocusRequest('terminal-script', ownerDocument)).toBe(
      false,
    );
    expect(consumeTerminalFocusRequest('terminal-script', ownerDocument)).toBe(
      false,
    );
    nowSpy.mockRestore();
  });

  // `focus` fires only on a TRANSITION. A window that was already focused when
  // tracking was installed never receives one, so a seeded `false` would drop
  // every request for the rest of the session. Absent state must therefore
  // defer to the live reading, while an observed blur still wins.
  it('falls back to the live focus reading before any transition is observed', () => {
    // Models the real failure: tracking is installed while the window is not
    // yet reported focused (the main window installs at module evaluation),
    // the window becomes focused WITHOUT a `focus` event — which only fires on
    // a transition — and every later request must still be honored.
    //
    // The document must be WINDOW-BACKED. `createHTMLDocument()` has a null
    // `defaultView`, so both entry points short-circuit before
    // `isWindowFocused` is consulted and the test could not fail.
    const second = document.createElement('iframe');
    document.body.append(second);
    const neverTracked = second.contentDocument;
    if (neverTracked === null || second.contentWindow === null) {
      throw new Error('Expected a window-backed document');
    }
    expect(neverTracked.defaultView).not.toBeNull();

    let focused = false;
    Object.defineProperty(neverTracked, 'hasFocus', {
      configurable: true,
      value: (): boolean => focused,
    });

    // Installs tracking while unfocused. A seeded snapshot would store `false`
    // here and never be corrected.
    requestTerminalFocus('terminal-early', neverTracked);
    expect(consumeTerminalFocusRequest('terminal-early', neverTracked)).toBe(
      false,
    );

    // The window is focused now, but no `focus` event ever fires.
    focused = true;

    requestTerminalFocus('terminal-fresh', neverTracked);
    expect(consumeTerminalFocusRequest('terminal-fresh', neverTracked)).toBe(
      true,
    );
    second.remove();
  });

  it('keeps refusing after an observed blur rather than re-reading hasFocus', () => {
    // jsdom reports `hasFocus() === true` unconditionally, so a live-only
    // check would wrongly re-admit the request that the blur just voided.
    requestTerminalFocus('terminal-aux', ownerDocument);
    ownerWindow.dispatchEvent(new Event('blur'));

    requestTerminalFocus('terminal-aux', ownerDocument);

    expect(consumeTerminalFocusRequest('terminal-aux', ownerDocument)).toBe(
      false,
    );
  });

  it('refuses a request made before an auxiliary window has been focused', () => {
    Object.defineProperty(ownerDocument, 'hasFocus', {
      configurable: true,
      value: (): boolean => false,
    });

    requestTerminalFocus('terminal-aux', ownerDocument);

    expect(consumeTerminalFocusRequest('terminal-aux', ownerDocument)).toBe(
      false,
    );

    // ...and accepts one made after the user actually lands in that window.
    ownerWindow.dispatchEvent(new Event('focus'));
    requestTerminalFocus('terminal-aux', ownerDocument);
    expect(consumeTerminalFocusRequest('terminal-aux', ownerDocument)).toBe(
      true,
    );
  });
});
