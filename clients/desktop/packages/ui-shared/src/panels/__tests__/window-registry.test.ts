/** @jest-environment jsdom */
import type { IDisposable } from '../disposable';
import {
  getActiveWindow,
  getDocument,
  getWindow,
  getWindows,
  onDidRegisterWindow,
  onDidUnregisterWindow,
  registerWindow,
  scheduleWindowAnimationFrame,
  scheduleWindowTimeout,
  type PanelWindow,
} from '../window-registry';

/**
 * A second "window" realm for jsdom tests: a real detached Document whose
 * `defaultView` is stubbed to a fake window object (jsdom's
 * `createHTMLDocument` documents have a `null` defaultView), mirroring how a
 * pulled-out child window would resolve.
 */
interface FakeWindowController {
  readonly win: PanelWindow;
  readonly doc: Document;
  /** Pending rAF callbacks, run manually. */
  readonly rafCallbacks: Array<() => void>;
  hasFocus: boolean;
}

function createFakeWindow(title: string): FakeWindowController {
  const doc = document.implementation.createHTMLDocument(title);
  const rafCallbacks: Array<() => void> = [];
  const controller: { hasFocus: boolean } = { hasFocus: false };

  const fake = {
    document: doc,
    setTimeout: (handler: () => void, delay?: number): number =>
      window.setTimeout(handler, delay),
    clearTimeout: (handle: number): void => {
      window.clearTimeout(handle);
    },
    requestAnimationFrame: (callback: FrameRequestCallback): number => {
      rafCallbacks.push(() => callback(0));
      return rafCallbacks.length;
    },
    cancelAnimationFrame: (handle: number): void => {
      rafCallbacks.splice(handle - 1, 1);
    },
  } as unknown as PanelWindow & {
    window: PanelWindow;
    self: PanelWindow;
  };
  fake.window = fake;
  fake.self = fake;

  Object.defineProperty(doc, 'defaultView', {
    value: fake,
    configurable: true,
  });
  Object.defineProperty(doc, 'hasFocus', {
    value: (): boolean => controller.hasFocus,
    configurable: true,
  });

  return {
    win: fake,
    doc,
    rafCallbacks,
    get hasFocus(): boolean {
      return controller.hasFocus;
    },
    set hasFocus(value: boolean) {
      controller.hasFocus = value;
    },
  };
}

describe('window-registry', () => {
  const registrations: IDisposable[] = [];

  const register = (win: Window): IDisposable => {
    const disposable = registerWindow(win);
    registrations.push(disposable);
    return disposable;
  };

  afterEach(() => {
    for (const registration of registrations.splice(0)) {
      registration.dispose();
    }
    jest.restoreAllMocks();
  });

  describe('main window auto-registration', () => {
    it('registers the jsdom main window at module load', () => {
      expect(getWindows()).toEqual([window]);
    });

    it('re-registering the main window is a no-op', () => {
      const disposable = registerWindow(window);
      disposable.dispose();

      expect(getWindows()).toEqual([window]);
    });
  });

  describe('registerWindow', () => {
    it('adds the window and removes it on dispose', () => {
      const aux = createFakeWindow('aux');

      const disposable = register(aux.win);
      expect(getWindows()).toEqual([window, aux.win]);

      disposable.dispose();
      expect(getWindows()).toEqual([window]);
    });

    it('registering an already-registered window returns a no-op disposable', () => {
      const aux = createFakeWindow('aux');

      register(aux.win);
      const second = registerWindow(aux.win);
      second.dispose();

      expect(getWindows()).toEqual([window, aux.win]);
    });

    it('fires onDidRegisterWindow and onDidUnregisterWindow exactly once', () => {
      const aux = createFakeWindow('aux');
      const registered: Window[] = [];
      const unregistered: Window[] = [];
      const registerListener = onDidRegisterWindow((win) => {
        registered.push(win);
      });
      const unregisterListener = onDidUnregisterWindow((win) => {
        unregistered.push(win);
      });

      const disposable = register(aux.win);
      disposable.dispose();
      disposable.dispose(); // double-dispose must not re-fire

      expect(registered).toEqual([aux.win]);
      expect(unregistered).toEqual([aux.win]);

      registerListener.dispose();
      unregisterListener.dispose();
    });
  });

  describe('getWindow / getDocument', () => {
    it('resolves nodes of the main document to the main window', () => {
      const element = document.createElement('div');

      expect(getWindow(element)).toBe(window);
      expect(getDocument(element)).toBe(document);
    });

    it('resolves nodes of a second document to that document window', () => {
      const aux = createFakeWindow('aux');
      const element = aux.doc.createElement('div');
      aux.doc.body.appendChild(element);

      expect(getWindow(element)).toBe(aux.win);
      expect(getDocument(element)).toBe(aux.doc);
    });

    it('resolves a Document node to its own window and document', () => {
      const aux = createFakeWindow('aux');

      expect(getWindow(aux.doc)).toBe(aux.win);
      expect(getDocument(aux.doc)).toBe(aux.doc);
    });

    it('falls back to the main window for null/undefined and detached-realm nodes', () => {
      const detachedDoc = document.implementation.createHTMLDocument('plain');
      const detachedElement = detachedDoc.createElement('div');

      expect(getWindow(null)).toBe(window);
      expect(getWindow(undefined)).toBe(window);
      // createHTMLDocument documents have no defaultView.
      expect(getWindow(detachedElement)).toBe(window);
      expect(getDocument(null)).toBe(document);
    });

    it('resolves a UIEvent through its view', () => {
      const event = new UIEvent('click', { view: window });

      expect(getWindow(event)).toBe(window);
    });
  });

  describe('getActiveWindow', () => {
    it('returns the main window when it is the only registered window', () => {
      expect(getActiveWindow()).toBe(window);
    });

    it('returns the focused registered window', () => {
      const aux = createFakeWindow('aux');
      aux.hasFocus = true;
      jest.spyOn(document, 'hasFocus').mockReturnValue(false);

      register(aux.win);

      expect(getActiveWindow()).toBe(aux.win);
    });

    it('falls back to the main window when no registered window has focus', () => {
      const aux = createFakeWindow('aux');
      aux.hasFocus = false;
      jest.spyOn(document, 'hasFocus').mockReturnValue(false);

      register(aux.win);

      expect(getActiveWindow()).toBe(window);
    });
  });

  describe('cross-document element adoption (Phase 8 contract)', () => {
    it('an opener-created leaf element adopted into a second document resolves to that window', async () => {
      const { createPanelLeafElement } = await import('../grid-leaf-adapter');
      const aux = createFakeWindow('aux');

      // Opener-realm rule (doc 13): the element is created via the OPENER
      // document, then adopted into the child document.
      const leafElement = createPanelLeafElement(document);
      aux.doc.body.appendChild(leafElement);

      // Adoption re-homes the node (ownerDocument follows the new tree) so
      // registry lookups route listeners/observers to the aux window, while
      // the prototype stays the opener realm's HTMLElement. NOTE: jsdom is
      // single-realm, so the instanceof assertion cannot fail here the way a
      // real cross-realm regression would — the realm split itself was
      // verified in the Phase 0 spike against real child windows (doc 13).
      expect(leafElement.ownerDocument).toBe(aux.doc);
      expect(leafElement instanceof HTMLElement).toBe(true);
      expect(getWindow(leafElement)).toBe(aux.win);
      expect(getDocument(leafElement)).toBe(aux.doc);
    });
  });

  describe('scheduleWindowAnimationFrame', () => {
    it('schedules on the window owning the target node', () => {
      const aux = createFakeWindow('aux');
      const element = aux.doc.createElement('div');
      const callback = jest.fn();

      scheduleWindowAnimationFrame(element, callback);

      expect(aux.rafCallbacks).toHaveLength(1);
      expect(callback).not.toHaveBeenCalled();

      aux.rafCallbacks[0]();
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('disposing cancels a not-yet-run frame', () => {
      const aux = createFakeWindow('aux');
      const callback = jest.fn();

      const disposable = scheduleWindowAnimationFrame(aux.win, callback);
      disposable.dispose();

      expect(aux.rafCallbacks).toHaveLength(0);
      expect(callback).not.toHaveBeenCalled();
    });

    it('runs synchronously when the window has no requestAnimationFrame', () => {
      const aux = createFakeWindow('aux');
      Object.defineProperty(aux.win, 'requestAnimationFrame', {
        value: undefined,
        configurable: true,
      });
      const callback = jest.fn();

      scheduleWindowAnimationFrame(aux.win, callback);

      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe('scheduleWindowTimeout', () => {
    it('schedules and fires on the resolved window timer queue', () => {
      jest.useFakeTimers();
      try {
        const callback = jest.fn();
        scheduleWindowTimeout(document.body, callback, 25);

        jest.advanceTimersByTime(24);
        expect(callback).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1);
        expect(callback).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('disposing clears a pending timeout', () => {
      jest.useFakeTimers();
      try {
        const callback = jest.fn();
        const disposable = scheduleWindowTimeout(document.body, callback, 25);
        disposable.dispose();

        jest.advanceTimersByTime(100);
        expect(callback).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
