/** @jest-environment jsdom */
import {
  AGENT_VISUAL_FONT_FACES_PROPERTY,
  AGENT_VISUAL_FONT_MAX_FACES,
  AGENT_VISUAL_FONTS_METHOD,
} from '../agent-visual-fonts';
import {
  AGENT_VISUAL_BRIDGE_SCRIPT,
  AGENT_VISUAL_GESTURE_METHOD,
  AGENT_VISUAL_GESTURE_WATCH_METHOD,
  AGENT_VISUAL_HEARTBEAT_INTERVAL_MS,
  AGENT_VISUAL_HEARTBEAT_MISSES,
  AGENT_VISUAL_HOST_CONTEXT_CHANGED_METHOD,
  AGENT_VISUAL_HELLO_METHOD,
  AGENT_VISUAL_OPEN_LINK_METHOD,
  AGENT_VISUAL_PING_METHOD,
  AGENT_VISUAL_PONG_METHOD,
  AGENT_VISUAL_RELAY_SCRIPT,
  AGENT_VISUAL_SIZE_CHANGED_METHOD,
  AGENT_VISUAL_STATUS_METHOD,
} from '../agent-visual-html';

type EventHandler = (event: unknown) => void;
type FakeEventTarget = {
  listeners: Map<string, EventHandler[]>;
  addEventListener: (type: string, listener: EventHandler) => void;
};
type PostedRecord = Record<string, unknown>;
type LinkElement = {
  getAttribute: (name: string) => string | null;
  scrollIntoView: () => void;
};

function createEventTarget(): FakeEventTarget {
  const listeners = new Map<string, EventHandler[]>();
  return {
    listeners,
    addEventListener(type, listener): void {
      const handlers = listeners.get(type) ?? [];
      handlers.push(listener);
      listeners.set(type, handlers);
    },
  };
}

function dispatch(target: FakeEventTarget, type: string, event: unknown): void {
  for (const listener of target.listeners.get(type) ?? []) listener(event);
}

function isPostedRecord(value: unknown): value is PostedRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function methodMessages(messages: unknown[], method: string): PostedRecord[] {
  return messages.filter(
    (message): message is PostedRecord =>
      isPostedRecord(message) && message.method === method,
  );
}

function statusState(message: PostedRecord): unknown {
  return isPostedRecord(message.params) ? message.params.state : undefined;
}

function protocolMessage(method: string, params?: unknown): unknown {
  const message: PostedRecord = { jsonrpc: '2.0', method };
  if (params !== undefined) message.params = params;
  return message;
}

function dispatchWindowMessage(
  target: FakeEventTarget,
  source: unknown,
  data: unknown,
): void {
  dispatch(target, 'message', { source, data });
}

let nextRunnerId = 0;

/**
 * Run an in-frame script the way the frames do, as an inline script element,
 * with fakes standing in for the frame's globals.
 */
function executeSource(
  source: string,
  window: unknown,
  document: unknown,
  resizeObserver: unknown,
  requestFrame: unknown,
): void {
  const runnerName = `agentVisualRunner${nextRunnerId++}`;
  const element = globalThis.document.createElement('script');
  element.textContent =
    `window[${JSON.stringify(runnerName)}] = function(window, document, ` +
    'ResizeObserver, requestAnimationFrame, setInterval, clearInterval, navigator, ' +
    `setTimeout, clearTimeout, URL){${source}\n};`;
  globalThis.document.head.append(element);
  element.remove();
  const runner: unknown = Reflect.get(globalThis, runnerName);
  if (typeof runner !== 'function') {
    throw new Error('The in-frame script did not compile');
  }
  Reflect.apply(runner, undefined, [
    window,
    document,
    resizeObserver,
    requestFrame,
    setInterval,
    clearInterval,
    isPostedRecord(window) && isPostedRecord(window.navigator)
      ? window.navigator
      : globalThis.navigator,
    setTimeout,
    clearTimeout,
    URL,
  ]);
}

function createBridgeHarness(): {
  window: FakeEventTarget & {
    parent: { postMessage: (data: unknown, targetOrigin: string) => void };
    scrollTo: (x: number, y: number) => void;
  };
  document: FakeEventTarget & {
    documentElement: {
      scrollHeight: number;
      clientHeight: number;
      contentHeight: number;
      getBoundingClientRect: () => { height: number };
      style: {
        colorScheme: string;
        setProperty: (name: string, value: string) => void;
      };
    };
    body: Record<string, never>;
    baseURI: string;
    getElementById: (id: string) => LinkElement | null;
    querySelectorAll: (selector: string) => LinkElement[];
  };
  parent: { postMessage: (data: unknown, targetOrigin: string) => void };
  parentMessages: unknown[];
  rafCallbacks: Array<() => void>;
  resizeCallbacks: Array<() => void>;
  observedElements: unknown[];
  styles: Array<[string, string]>;
  scrollTo: jest.Mock;
} {
  const parentMessages: unknown[] = [];
  const parent = {
    postMessage(data: unknown, targetOrigin: string): void {
      parentMessages.push({ data, targetOrigin });
    },
  };
  const scrollTo = jest.fn();
  const windowTarget = createEventTarget();
  const window = {
    ...windowTarget,
    parent,
    scrollTo,
  };
  const styles: Array<[string, string]> = [];
  const root = {
    scrollHeight: 0,
    clientHeight: 0,
    contentHeight: 0,
    getBoundingClientRect(): { height: number } {
      return { height: root.contentHeight };
    },
    style: {
      colorScheme: '',
      setProperty(name: string, value: string): void {
        styles.push([name, value]);
      },
    },
  };
  const documentTarget = createEventTarget();
  const document = {
    ...documentTarget,
    documentElement: root,
    body: {},
    baseURI: 'https://host.example/chat',
    getElementById: (): LinkElement | null => null,
    querySelectorAll: (): LinkElement[] => [],
  };
  const rafCallbacks: Array<() => void> = [];
  const resizeCallbacks: Array<() => void> = [];
  const observedElements: unknown[] = [];
  class FakeResizeObserver {
    constructor(callback: () => void) {
      resizeCallbacks.push(callback);
    }

    observe(element: unknown): void {
      observedElements.push(element);
    }
  }
  executeSource(
    AGENT_VISUAL_BRIDGE_SCRIPT,
    window,
    document,
    FakeResizeObserver,
    (callback: () => void): number => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    },
  );
  return {
    window,
    document,
    parent,
    parentMessages,
    rafCallbacks,
    resizeCallbacks,
    observedElements,
    styles,
    scrollTo,
  };
}

function createTrustedClick(
  anchor: LinkElement,
  trusted: boolean,
  type: 'click' | 'auxclick',
  button: number,
): {
  isTrusted: boolean;
  type: 'click' | 'auxclick';
  button: number;
  target: unknown;
  preventDefault: jest.Mock;
} {
  return {
    isTrusted: trusted,
    type,
    button,
    target: {
      nodeType: 1,
      closest: (): LinkElement => anchor,
    },
    preventDefault: jest.fn(),
  };
}

function createRelayHarness(): {
  window: FakeEventTarget & {
    navigator: { userActivation: { isActive: boolean } };
  };
  document: FakeEventTarget & {
    documentElement: { style: { colorScheme: string } };
    querySelector: (selector: string) => {
      contentWindow: {
        postMessage: (data: unknown, targetOrigin: string) => void;
      };
      addEventListener: (type: string, listener: EventHandler) => void;
      listeners: Map<string, EventHandler[]>;
    };
  };
  parent: { postMessage: (data: unknown, targetOrigin: string) => void };
  parentMessages: unknown[];
  childMessages: unknown[];
  childWindow: { postMessage: (data: unknown, targetOrigin: string) => void };
  iframe: FakeEventTarget & {
    contentWindow: {
      postMessage: (data: unknown, targetOrigin: string) => void;
    };
  };
} {
  const parentMessages: unknown[] = [];
  const childMessages: unknown[] = [];
  const parent = {
    postMessage(data: unknown, targetOrigin: string): void {
      parentMessages.push({ data, targetOrigin });
    },
  };
  const childWindow = {
    postMessage(data: unknown, targetOrigin: string): void {
      childMessages.push({ data, targetOrigin });
    },
  };
  const iframeTarget = createEventTarget();
  const iframe = { ...iframeTarget, contentWindow: childWindow };
  const window = {
    ...createEventTarget(),
    navigator: { userActivation: { isActive: false } },
  };
  const documentTarget = createEventTarget();
  const document = {
    ...documentTarget,
    documentElement: { style: { colorScheme: '' } },
    querySelector: (): typeof iframe => iframe,
  };
  executeSource(
    AGENT_VISUAL_RELAY_SCRIPT,
    { ...window, parent },
    document,
    null,
    null,
  );
  return {
    window,
    document,
    parent,
    parentMessages,
    childMessages,
    childWindow,
    iframe,
  };
}

describe('agent visual bridge script', () => {
  it('accepts theme and ping messages only from the parent and posts hello on install', () => {
    const harness = createBridgeHarness();
    const otherSource = {};
    dispatchWindowMessage(
      harness.window,
      otherSource,
      protocolMessage(AGENT_VISUAL_HOST_CONTEXT_CHANGED_METHOD, {
        theme: { appearance: 'dark', variables: { '--bg-base': 'black' } },
      }),
    );
    dispatchWindowMessage(
      harness.window,
      otherSource,
      protocolMessage(AGENT_VISUAL_PING_METHOD, { id: 5 }),
    );
    expect(harness.parentMessages).toHaveLength(1);
    expect(
      harness.parentMessages.every(
        (entry) => isPostedRecord(entry) && entry.targetOrigin === '*',
      ),
    ).toBe(true);
    expect(
      methodMessages(
        harness.parentMessages.map((entry) => {
          if (!isPostedRecord(entry)) return null;
          return entry.data;
        }),
        AGENT_VISUAL_HELLO_METHOD,
      ),
    ).toHaveLength(1);

    dispatchWindowMessage(
      harness.window,
      harness.parent,
      protocolMessage(AGENT_VISUAL_HOST_CONTEXT_CHANGED_METHOD, {
        theme: {
          appearance: 'dark',
          variables: {
            '--bg-base': '#111',
            '--unknown': 'red',
            '--fg-primary': 7,
          },
        },
      }),
    );
    dispatchWindowMessage(
      harness.window,
      harness.parent,
      protocolMessage(AGENT_VISUAL_PING_METHOD, { id: 13 }),
    );
    expect(harness.document.documentElement.style.colorScheme).toBe('dark');
    expect(harness.styles).toEqual([['--bg-base', '#111']]);
    const messages = harness.parentMessages.flatMap((entry) =>
      isPostedRecord(entry) ? [entry.data] : [],
    );
    expect(methodMessages(messages, AGENT_VISUAL_PONG_METHOD)).toHaveLength(1);
    expect(
      methodMessages(messages, AGENT_VISUAL_PONG_METHOD)[0]?.params,
    ).toEqual({
      id: 13,
    });
  });

  it('intercepts trusted same-document and absolute links, but ignores untrusted clicks', (): void => {
    const harness = createBridgeHarness();
    const scrollIntoView = jest.fn();
    const fragmentAnchor: LinkElement = {
      getAttribute: (name) => (name === 'href' ? '#target' : null),
      scrollIntoView,
    };
    const idTarget: LinkElement = {
      getAttribute: () => null,
      scrollIntoView,
    };
    harness.document.getElementById = (id): LinkElement | null =>
      id === 'target' ? idTarget : null;

    const untrusted = createTrustedClick(fragmentAnchor, false, 'click', 0);
    dispatch(harness.document, 'click', untrusted);
    expect(untrusted.preventDefault).not.toHaveBeenCalled();

    const fragment = createTrustedClick(fragmentAnchor, true, 'click', 0);
    dispatch(harness.document, 'click', fragment);
    expect(fragment.preventDefault).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    const externalAnchor: LinkElement = {
      getAttribute: (name) =>
        name === 'href' ? 'HTTPS://Example.COM:443/path/../page' : null,
      scrollIntoView: jest.fn(),
    };
    const external = createTrustedClick(externalAnchor, true, 'auxclick', 1);
    dispatch(harness.document, 'auxclick', external);
    expect(external.preventDefault).toHaveBeenCalledTimes(1);
    const posted = harness.parentMessages.flatMap((entry) =>
      isPostedRecord(entry) ? [entry.data] : [],
    );
    expect(methodMessages(posted, AGENT_VISUAL_OPEN_LINK_METHOD)).toHaveLength(
      1,
    );
    expect(
      methodMessages(posted, AGENT_VISUAL_OPEN_LINK_METHOD)[0]?.params,
    ).toEqual({
      url: 'https://example.com/page',
    });
  });

  it('only treats middle-button auxclicks as link activations', (): void => {
    const harness = createBridgeHarness();
    const scrollIntoView = jest.fn();
    const fragmentTarget: LinkElement = {
      getAttribute: (): null => null,
      scrollIntoView,
    };
    const fragmentAnchor: LinkElement = {
      getAttribute: (name: string): string | null =>
        name === 'href' ? '#target' : null,
      scrollIntoView: jest.fn(),
    };
    harness.document.getElementById = (id): LinkElement | null =>
      id === 'target' ? fragmentTarget : null;

    const externalAnchor: LinkElement = {
      getAttribute: (name: string): string | null =>
        name === 'href' ? 'https://example.com/path' : null,
      scrollIntoView: jest.fn(),
    };
    const rightExternal = createTrustedClick(
      externalAnchor,
      true,
      'auxclick',
      2,
    );
    dispatch(harness.document, 'auxclick', rightExternal);
    expect(rightExternal.preventDefault).not.toHaveBeenCalled();

    const rightFragment = createTrustedClick(
      fragmentAnchor,
      true,
      'auxclick',
      2,
    );
    dispatch(harness.document, 'auxclick', rightFragment);
    expect(rightFragment.preventDefault).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();

    const middleExternal = createTrustedClick(
      externalAnchor,
      true,
      'auxclick',
      1,
    );
    dispatch(harness.document, 'auxclick', middleExternal);
    expect(middleExternal.preventDefault).toHaveBeenCalledTimes(1);
    const posted: unknown[] = [];
    for (const entry of harness.parentMessages) {
      if (isPostedRecord(entry)) posted.push(entry.data);
    }
    expect(methodMessages(posted, AGENT_VISUAL_OPEN_LINK_METHOD)).toHaveLength(
      1,
    );
  });

  it('prevents navigation for unsupported schemes and reports de-duplicated heights', (): void => {
    const harness = createBridgeHarness();
    for (const href of [
      'javascript:alert(1)',
      'file:///tmp/visual.html',
      'data:text/html,hello',
      'relative/path',
    ]) {
      const anchor: LinkElement = {
        getAttribute: (name) => (name === 'href' ? href : null),
        scrollIntoView: jest.fn(),
      };
      const click = createTrustedClick(anchor, true, 'click', 0);
      dispatch(harness.document, 'click', click);
      expect(click.preventDefault).toHaveBeenCalledTimes(1);
    }

    const root = harness.document.documentElement;
    // Content shorter than the frame: the root box is the height.
    root.clientHeight = 400;
    root.scrollHeight = 400;
    root.contentHeight = 150.2;
    dispatch(harness.document, 'DOMContentLoaded', {});
    expect(harness.observedElements).toEqual([
      harness.document.documentElement,
      harness.document.body,
    ]);
    for (const callback of harness.rafCallbacks.splice(0)) callback();
    dispatch(harness.window, 'load', {});
    for (const callback of harness.rafCallbacks.splice(0)) callback();
    expect(harness.resizeCallbacks).toHaveLength(1);
    // Content overflowing the frame: the scroll height is the height.
    root.clientHeight = 151;
    root.scrollHeight = 155;
    harness.resizeCallbacks[0]?.();
    harness.resizeCallbacks[0]?.();
    expect(harness.rafCallbacks).toHaveLength(1);
    for (const callback of harness.rafCallbacks.splice(0)) callback();
    // Content shrinks below the frame again, and an empty document reports nothing.
    root.clientHeight = 155;
    root.scrollHeight = 155;
    root.contentHeight = 90;
    harness.resizeCallbacks[0]?.();
    for (const callback of harness.rafCallbacks.splice(0)) callback();
    root.contentHeight = 0;
    harness.resizeCallbacks[0]?.();
    for (const callback of harness.rafCallbacks.splice(0)) callback();

    const posted = harness.parentMessages.flatMap((entry) =>
      isPostedRecord(entry) ? [entry.data] : [],
    );
    expect(methodMessages(posted, AGENT_VISUAL_OPEN_LINK_METHOD)).toHaveLength(
      0,
    );
    expect(
      methodMessages(posted, AGENT_VISUAL_SIZE_CHANGED_METHOD).map(
        (entry) => entry.params,
      ),
    ).toEqual([{ height: 151 }, { height: 155 }, { height: 90 }]);
  });
});

describe('agent visual relay script', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('forwards only validated messages from the correct source and rebuilds them', () => {
    const harness = createRelayHarness();
    const initialPing = harness.childMessages.flatMap((entry) =>
      isPostedRecord(entry) ? [entry.data] : [],
    )[0];
    expect(initialPing).toEqual({
      jsonrpc: '2.0',
      method: AGENT_VISUAL_PING_METHOD,
      params: { id: 1 },
    });

    const sizeMessage = protocolMessage(AGENT_VISUAL_SIZE_CHANGED_METHOD, {
      height: 123.5,
    });
    dispatchWindowMessage(harness.window, {}, sizeMessage);
    dispatchWindowMessage(
      harness.window,
      harness.parent,
      protocolMessage(AGENT_VISUAL_SIZE_CHANGED_METHOD, { height: 123.5 }),
    );
    dispatchWindowMessage(
      harness.window,
      harness.childWindow,
      protocolMessage(AGENT_VISUAL_HOST_CONTEXT_CHANGED_METHOD, {
        theme: { appearance: 'dark', variables: { '--bg-base': 'black' } },
      }),
    );
    expect(harness.parentMessages).toHaveLength(0);
    expect(harness.childMessages).toHaveLength(1);
    expect(
      harness.childMessages.every(
        (entry) => isPostedRecord(entry) && entry.targetOrigin === '*',
      ),
    ).toBe(true);

    dispatchWindowMessage(harness.window, harness.childWindow, sizeMessage);
    const forwardedSize = harness.parentMessages.flatMap((entry) =>
      isPostedRecord(entry) ? [entry.data] : [],
    )[0];
    expect(forwardedSize).not.toBe(sizeMessage);
    expect(forwardedSize).toEqual({
      jsonrpc: '2.0',
      method: AGENT_VISUAL_SIZE_CHANGED_METHOD,
      params: { height: 123.5 },
    });
    dispatchWindowMessage(
      harness.window,
      harness.childWindow,
      protocolMessage(AGENT_VISUAL_OPEN_LINK_METHOD, {
        url: 'https://example.com/not-activated',
      }),
    );
    expect(
      methodMessages(
        harness.parentMessages.flatMap((entry) =>
          isPostedRecord(entry) ? [entry.data] : [],
        ),
        AGENT_VISUAL_OPEN_LINK_METHOD,
      ),
    ).toHaveLength(0);
    harness.window.navigator.userActivation.isActive = true;
    dispatchWindowMessage(
      harness.window,
      harness.childWindow,
      protocolMessage(AGENT_VISUAL_OPEN_LINK_METHOD, {
        url: 'HTTPS://Example.COM:443/a/../b',
      }),
    );
    dispatchWindowMessage(
      harness.window,
      harness.childWindow,
      protocolMessage(AGENT_VISUAL_OPEN_LINK_METHOD, {
        url: 'https://user:pass@example.com/',
      }),
    );
    const forwardedLinks = methodMessages(
      harness.parentMessages.flatMap((entry) =>
        isPostedRecord(entry) ? [entry.data] : [],
      ),
      AGENT_VISUAL_OPEN_LINK_METHOD,
    );
    expect(forwardedLinks).toHaveLength(1);
    expect(forwardedLinks[0]?.params).toEqual({ url: 'https://example.com/b' });

    dispatchWindowMessage(
      harness.window,
      harness.parent,
      protocolMessage(AGENT_VISUAL_HOST_CONTEXT_CHANGED_METHOD, {
        theme: {
          appearance: 'dark',
          variables: {
            '--bg-base': '#101010',
            '--untrusted': 'value',
            '--fg-primary': 10,
          },
        },
      }),
    );
    expect(harness.document.documentElement.style.colorScheme).toBe('dark');
    const forwardedTheme = harness.childMessages.flatMap((entry) =>
      isPostedRecord(entry) ? [entry.data] : [],
    )[1];
    expect(forwardedTheme).toEqual({
      jsonrpc: '2.0',
      method: AGENT_VISUAL_HOST_CONTEXT_CHANGED_METHOD,
      params: {
        theme: { appearance: 'dark', variables: { '--bg-base': '#101010' } },
      },
    });
  });

  describe('gesture checks', () => {
    function setup(): {
      harness: ReturnType<typeof createRelayHarness>;
      answers: () => unknown[];
      ask: (id: unknown) => void;
      watch: (watching: boolean) => void;
      focusIn: (focused: boolean) => void;
      activate: (active: boolean) => void;
    } {
      const harness = createRelayHarness();
      const activeElement: { current: unknown } = { current: null };
      Object.defineProperty(harness.document, 'activeElement', {
        configurable: true,
        get: () => activeElement.current,
      });
      return {
        harness,
        answers: (): unknown[] =>
          harness.parentMessages.flatMap((entry) =>
            isPostedRecord(entry) &&
            isPostedRecord(entry.data) &&
            entry.data.method === AGENT_VISUAL_GESTURE_METHOD
              ? [entry.data.params]
              : [],
          ),
        ask: (id): void =>
          dispatchWindowMessage(
            harness.window,
            harness.parent,
            protocolMessage(AGENT_VISUAL_GESTURE_METHOD, { id }),
          ),
        watch: (watching): void =>
          dispatchWindowMessage(
            harness.window,
            harness.parent,
            protocolMessage(AGENT_VISUAL_GESTURE_WATCH_METHOD, { watching }),
          ),
        focusIn: (focused): void => {
          activeElement.current = focused ? harness.iframe : null;
        },
        activate: (active): void => {
          harness.window.navigator.userActivation.isActive = active;
        },
      };
    }

    it('confirms a gesture that came before focus entered the visual', () => {
      const relay = setup();
      relay.watch(true);
      // A press inside the agent frame activates it and its ancestors first;
      // focus follows as the press's default action.
      relay.activate(true);
      jest.advanceTimersByTime(10);
      relay.focusIn(true);
      relay.ask(1);
      expect(relay.answers()).toEqual([{ id: 1, gesture: 'inside' }]);
    });

    it('does not count an activation already in effect when watching began', () => {
      // An earlier press in this visual keeps its activation alive for a few
      // seconds; when the pointer opens the visual again in that time, the
      // page could focus itself and look as if it had been pressed.
      const relay = setup();
      relay.activate(true);
      relay.watch(true);
      jest.advanceTimersByTime(10);
      relay.focusIn(true);
      relay.ask(10);
      expect(relay.answers()).toEqual([{ id: 10, gesture: 'unclear' }]);
    });

    it('counts a press made after an earlier activation has lapsed', () => {
      const relay = setup();
      relay.activate(true);
      relay.watch(true);
      jest.advanceTimersByTime(10);
      relay.activate(false);
      jest.advanceTimersByTime(10);
      relay.activate(true);
      jest.advanceTimersByTime(10);
      relay.focusIn(true);
      relay.ask(11);
      expect(relay.answers()).toEqual([{ id: 11, gesture: 'inside' }]);
    });

    it('refuses a gesture that came only after the page focused itself', () => {
      const relay = setup();
      relay.watch(true);
      relay.focusIn(true);
      jest.advanceTimersByTime(10);
      // A key typed into the field the page focused activates the frame too.
      relay.activate(true);
      relay.ask(2);
      expect(relay.answers()).toEqual([{ id: 2, gesture: 'none' }]);
    });

    it('refuses when nothing inside the visual was pressed', () => {
      const relay = setup();
      relay.watch(true);
      relay.focusIn(true);
      relay.ask(3);
      expect(relay.answers()).toEqual([{ id: 3, gesture: 'none' }]);
    });

    it('confirms a press and its focus first seen together in a prompt sample', () => {
      // In one renderer process the press and the focus it moves arrive in
      // the same task, so the sampler sees them together, on time.
      const relay = setup();
      relay.watch(true);
      jest.advanceTimersByTime(10);
      relay.activate(true);
      relay.focusIn(true);
      relay.ask(4);
      expect(relay.answers()).toEqual([{ id: 4, gesture: 'inside' }]);
    });

    it('cannot tell the order when both first appear after a stalled sample', () => {
      // A page that focuses a field and holds its thread lets a key in before
      // the sampler runs again; the late sample cannot order the two.
      const relay = setup();
      relay.watch(true);
      jest.advanceTimersByTime(10);
      jest.setSystemTime(Date.now() + 200);
      relay.activate(true);
      relay.focusIn(true);
      relay.ask(5);
      // Unwatched, it has no earlier sample to compare with either.
      const unwatched = setup();
      unwatched.activate(true);
      unwatched.focusIn(true);
      unwatched.ask(6);
      expect(relay.answers()).toEqual([{ id: 5, gesture: 'unclear' }]);
      expect(unwatched.answers()).toEqual([{ id: 6, gesture: 'unclear' }]);
    });

    it('samples only while watching', () => {
      const relay = setup();
      relay.watch(true);
      relay.watch(false);
      relay.activate(true);
      jest.advanceTimersByTime(50);
      relay.focusIn(true);
      relay.ask(7);
      expect(relay.answers()).toEqual([{ id: 7, gesture: 'unclear' }]);
    });

    it('takes questions only from the host, never forwards them, and ignores bad ids', () => {
      const relay = setup();
      const toAgent = (): unknown[] =>
        relay.harness.childMessages.flatMap((entry) =>
          isPostedRecord(entry) &&
          isPostedRecord(entry.data) &&
          (entry.data.method === AGENT_VISUAL_GESTURE_METHOD ||
            entry.data.method === AGENT_VISUAL_GESTURE_WATCH_METHOD)
            ? [entry.data]
            : [],
        );
      relay.watch(true);
      dispatchWindowMessage(
        relay.harness.window,
        relay.harness.childWindow,
        protocolMessage(AGENT_VISUAL_GESTURE_METHOD, { id: 9 }),
      );
      dispatchWindowMessage(
        relay.harness.window,
        relay.harness.childWindow,
        protocolMessage(AGENT_VISUAL_GESTURE_METHOD, {
          id: 9,
          gesture: 'inside',
        }),
      );
      relay.ask('nine');
      expect(relay.answers()).toEqual([]);
      expect(toAgent()).toEqual([]);
    });
  });

  it('reports liveness after exactly the configured unanswered heartbeat count and recovers', () => {
    const harness = createRelayHarness();
    const statuses = (): PostedRecord[] =>
      methodMessages(
        harness.parentMessages.flatMap((entry) =>
          isPostedRecord(entry) ? [entry.data] : [],
        ),
        AGENT_VISUAL_STATUS_METHOD,
      );

    for (let miss = 1; miss < AGENT_VISUAL_HEARTBEAT_MISSES; miss += 1) {
      jest.advanceTimersByTime(AGENT_VISUAL_HEARTBEAT_INTERVAL_MS);
      expect(
        statuses().filter((status) => statusState(status) === 'unresponsive'),
      ).toHaveLength(0);
    }
    jest.advanceTimersByTime(AGENT_VISUAL_HEARTBEAT_INTERVAL_MS);
    expect(
      statuses().filter((status) => statusState(status) === 'unresponsive'),
    ).toHaveLength(1);

    dispatchWindowMessage(
      harness.window,
      harness.childWindow,
      protocolMessage(AGENT_VISUAL_PONG_METHOD, {
        id: AGENT_VISUAL_HEARTBEAT_MISSES + 1,
      }),
    );
    expect(statuses().map((status) => status.params)).toEqual([
      { state: 'unresponsive' },
      { state: 'alive' },
    ]);
    jest.advanceTimersByTime(AGENT_VISUAL_HEARTBEAT_INTERVAL_MS);
    dispatchWindowMessage(
      harness.window,
      harness.childWindow,
      protocolMessage(AGENT_VISUAL_PONG_METHOD, {
        id: AGENT_VISUAL_HEARTBEAT_MISSES + 2,
      }),
    );
    expect(
      statuses().filter((status) => statusState(status) === 'alive'),
    ).toHaveLength(2);
  });

  it('sends ready once and detects blocked navigation without continuing heartbeats', () => {
    const harness = createRelayHarness();
    dispatchWindowMessage(
      harness.window,
      harness.childWindow,
      protocolMessage(AGENT_VISUAL_HELLO_METHOD),
    );
    dispatchWindowMessage(
      harness.window,
      harness.childWindow,
      protocolMessage(AGENT_VISUAL_HELLO_METHOD),
    );
    const statuses = (): PostedRecord[] =>
      methodMessages(
        harness.parentMessages.flatMap((entry) =>
          isPostedRecord(entry) ? [entry.data] : [],
        ),
        AGENT_VISUAL_STATUS_METHOD,
      );
    expect(statuses().map((status) => status.params)).toEqual([
      { state: 'ready' },
    ]);

    dispatch(harness.iframe, 'load', {});
    dispatch(harness.iframe, 'load', {});
    const pingCountBeforeNavigationTimeout = harness.childMessages.length;
    jest.advanceTimersByTime(AGENT_VISUAL_HEARTBEAT_INTERVAL_MS);
    expect(
      statuses().some((status) => statusState(status) === 'navigated'),
    ).toBe(true);
    const pingCountAfterNavigation = harness.childMessages.length;
    expect(pingCountAfterNavigation).toBeGreaterThan(
      pingCountBeforeNavigationTimeout,
    );
    jest.advanceTimersByTime(AGENT_VISUAL_HEARTBEAT_INTERVAL_MS * 2);
    expect(harness.childMessages).toHaveLength(pingCountAfterNavigation);
  });

  it('does not report navigation when a fresh bridge hello accompanies the new document', () => {
    const harness = createRelayHarness();
    dispatch(harness.iframe, 'load', {});
    dispatchWindowMessage(
      harness.window,
      harness.childWindow,
      protocolMessage(AGENT_VISUAL_HELLO_METHOD),
    );
    dispatch(harness.iframe, 'load', {});
    jest.advanceTimersByTime(AGENT_VISUAL_HEARTBEAT_INTERVAL_MS);
    const statuses = methodMessages(
      harness.parentMessages.flatMap((entry) =>
        isPostedRecord(entry) ? [entry.data] : [],
      ),
      AGENT_VISUAL_STATUS_METHOD,
    );
    expect(statuses.some((status) => statusState(status) === 'navigated')).toBe(
      false,
    );
  });
});

function fontFace(overrides: Record<string, unknown> = {}): PostedRecord {
  return {
    family: 'Inter',
    style: 'normal',
    weight: '400 500',
    stretch: 'normal',
    unicodeRange: 'U+0-10FFFF',
    data: new ArrayBuffer(8),
    ...overrides,
  };
}

describe('app fonts in the frame', () => {
  type RegisteredFace = {
    family: string;
    data: unknown;
    descriptors: unknown;
  };
  let registered: RegisteredFace[];
  const originalFontFace: unknown = Reflect.get(globalThis, 'FontFace');

  beforeEach(() => {
    // The relay starts its heartbeat on install.
    jest.useFakeTimers();
    registered = [];
    class FakeFontFace {
      loaded = Promise.resolve();
      constructor(
        readonly family: string,
        readonly data: unknown,
        readonly descriptors: unknown,
      ) {}
    }
    Reflect.set(globalThis, 'FontFace', FakeFontFace);
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalFontFace === undefined)
      Reflect.deleteProperty(globalThis, 'FontFace');
    else Reflect.set(globalThis, 'FontFace', originalFontFace);
  });

  function bridgeWithFonts(): ReturnType<typeof createBridgeHarness> {
    const harness = createBridgeHarness();
    Reflect.set(harness.document, 'fonts', {
      add(face: RegisteredFace): void {
        registered.push(face);
      },
    });
    return harness;
  }

  it('registers each face from the parent once, under its quoted family name', async () => {
    const harness = bridgeWithFonts();
    const inter = fontFace();
    const generated = fontFace({ family: '__Inter_4b1f2c', style: 'italic' });
    const message = protocolMessage(AGENT_VISUAL_FONTS_METHOD, {
      faces: [inter, generated, fontFace({ family: 'Bad</style>' })],
    });
    dispatchWindowMessage(harness.window, {}, message);
    expect(registered).toEqual([]);
    dispatchWindowMessage(harness.window, harness.parent, message);
    // The host sends the faces again whenever the frame reports ready.
    dispatchWindowMessage(harness.window, harness.parent, message);
    expect(
      registered.map(({ family, data, descriptors }) => ({
        family,
        data,
        descriptors,
      })),
    ).toEqual([
      {
        family: '"Inter"',
        data: inter.data,
        descriptors: {
          style: 'normal',
          weight: '400 500',
          stretch: 'normal',
          unicodeRange: 'U+0-10FFFF',
        },
      },
      {
        family: '"__Inter_4b1f2c"',
        data: generated.data,
        descriptors: {
          style: 'italic',
          weight: '400 500',
          stretch: 'normal',
          unicodeRange: 'U+0-10FFFF',
        },
      },
    ]);
    // Once the faces have loaded, the root's style changes, which is what a
    // page that redraws canvas text listens for.
    expect(harness.styles).toEqual([]);
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    expect(harness.styles).toEqual([[AGENT_VISUAL_FONT_FACES_PROPERTY, '2']]);
  });

  it('ignores the message where the Font Loading API is missing', () => {
    const harness = createBridgeHarness();
    expect(() =>
      dispatchWindowMessage(
        harness.window,
        harness.parent,
        protocolMessage(AGENT_VISUAL_FONTS_METHOD, { faces: [fontFace()] }),
      ),
    ).not.toThrow();
    expect(registered).toEqual([]);
  });

  it('relays only validated faces from the host, rebuilt, and nothing when none are valid', () => {
    const harness = createRelayHarness();
    const valid = fontFace({ extra: 'dropped' });
    const hostMessage = protocolMessage(AGENT_VISUAL_FONTS_METHOD, {
      faces: [
        valid,
        fontFace({ weight: 'url(x)' }),
        fontFace({ data: 'AAAA' }),
        fontFace({ data: new ArrayBuffer(0) }),
        'Inter',
      ],
    });
    dispatchWindowMessage(harness.window, harness.childWindow, hostMessage);
    dispatchWindowMessage(harness.window, {}, hostMessage);
    const fontMessages = (): PostedRecord[] =>
      methodMessages(
        harness.childMessages.flatMap((entry) =>
          isPostedRecord(entry) ? [entry.data] : [],
        ),
        AGENT_VISUAL_FONTS_METHOD,
      );
    expect(fontMessages()).toEqual([]);
    dispatchWindowMessage(harness.window, harness.parent, hostMessage);
    expect(fontMessages()).toEqual([
      {
        jsonrpc: '2.0',
        method: AGENT_VISUAL_FONTS_METHOD,
        params: {
          faces: [
            {
              family: 'Inter',
              style: 'normal',
              weight: '400 500',
              stretch: 'normal',
              unicodeRange: 'U+0-10FFFF',
              data: valid.data,
            },
          ],
        },
      },
    ]);
    dispatchWindowMessage(
      harness.window,
      harness.parent,
      protocolMessage(AGENT_VISUAL_FONTS_METHOD, {
        faces: [fontFace({ family: '' })],
      }),
    );
    expect(fontMessages()).toHaveLength(1);
  });

  it('relays at most the face limit', () => {
    const harness = createRelayHarness();
    dispatchWindowMessage(
      harness.window,
      harness.parent,
      protocolMessage(AGENT_VISUAL_FONTS_METHOD, {
        faces: Array.from({ length: AGENT_VISUAL_FONT_MAX_FACES + 4 }, () =>
          fontFace(),
        ),
      }),
    );
    const [message] = methodMessages(
      harness.childMessages.flatMap((entry) =>
        isPostedRecord(entry) ? [entry.data] : [],
      ),
      AGENT_VISUAL_FONTS_METHOD,
    );
    const params = message?.params;
    expect(
      isPostedRecord(params) && Array.isArray(params.faces)
        ? params.faces.length
        : -1,
    ).toBe(AGENT_VISUAL_FONT_MAX_FACES);
  });
});
