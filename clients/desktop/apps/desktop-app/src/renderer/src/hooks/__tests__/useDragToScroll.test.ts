import type * as DragToScrollModule from '../useDragToScroll';

type DragToScrollOptions = Parameters<
  typeof DragToScrollModule.useDragToScroll
>[0];
type DragToScrollHookResult = ReturnType<
  typeof DragToScrollModule.useDragToScroll
>;
type EffectCleanup = () => void;
type EffectCallback = () => void | EffectCleanup;
type Callback = (...args: never[]) => unknown;
type RefValue =
  | TestElement
  | boolean
  | number
  | string
  | ReturnType<typeof setTimeout>
  | null;
type StateValue = TestElement | null;
type StateSetter<T> = (value: T | ((previous: T) => T)) => void;
type EventListener = (event: TestMouseEvent) => void;

interface ReactMockExports {
  useCallback: <T extends Callback>(callback: T) => T;
  useEffect: (effect: EffectCallback) => void;
  useRef: (initialValue: RefValue) => { current: RefValue };
  useState: (initialValue: StateValue) => [StateValue, StateSetter<StateValue>];
}

interface StyleState {
  cursor: string;
  userSelect: string;
}

interface TestEventInit {
  button?: number;
  clientX?: number;
  clientY?: number;
  path?: unknown[];
  target?: unknown;
}

class TestMouseEvent {
  button: number;
  clientX: number;
  clientY: number;
  defaultPrevented = false;
  propagationStopped = false;
  target: unknown;

  private readonly path: unknown[];

  constructor({
    button = 0,
    clientX = 0,
    clientY = 0,
    path,
    target,
  }: TestEventInit = {}) {
    this.button = button;
    this.clientX = clientX;
    this.clientY = clientY;
    this.path = path ?? [];
    this.target = target ?? this.path[0] ?? null;
  }

  composedPath(): unknown[] {
    return this.path;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }
}

class TestEventTarget {
  private readonly listeners = new Map<string, EventListener[]>();

  addEventListener(type: string, listener: EventListener): void {
    const existing = this.listeners.get(type);
    if (existing) {
      existing.push(listener);
      return;
    }

    this.listeners.set(type, [listener]);
  }

  removeEventListener(type: string, listener: EventListener): void {
    const existing = this.listeners.get(type);
    if (!existing) {
      return;
    }

    this.listeners.set(
      type,
      existing.filter((candidate): boolean => candidate !== listener),
    );
  }

  dispatchEvent(type: string, event: TestMouseEvent): void {
    const listeners = this.listeners.get(type) ?? [];
    for (const listener of listeners) {
      listener(event);
    }
  }
}

class TestElement extends TestEventTarget {
  parentElement: TestElement | null;
  role: string | null;
  scrollLeft = 0;
  scrollTop = 0;
  style: StyleState = { cursor: '', userSelect: '' };
  tagName: string;

  constructor(tagName: string, parentElement: TestElement | null = null) {
    super();
    this.parentElement = parentElement;
    this.role = null;
    this.tagName = tagName.toUpperCase();
  }

  closest(selectorList: string): TestElement | null {
    const selectors = selectorList.split(',').map((selector): string => {
      return selector.trim();
    });

    for (const selector of selectors) {
      if (this.matchesSelector(selector)) {
        return this;
      }
    }

    let parent: TestElement | null = this.parentElement;
    while (parent) {
      const currentParent: TestElement = parent;
      for (const selector of selectors) {
        if (currentParent.matchesSelector(selector)) {
          return currentParent;
        }
      }
      parent = currentParent.parentElement;
    }

    return null;
  }

  private matchesSelector(selector: string): boolean {
    if (selector === '[role="button"]') {
      return this.role === 'button';
    }

    return this.tagName === selector.toUpperCase();
  }
}

class TestDocument extends TestEventTarget {
  body = new TestElement('body');
}

class HookHarness {
  private effectCleanups: EffectCleanup[] = [];
  private refIndex = 0;
  private refs: Array<{ current: RefValue } | undefined> = [];
  private stateIndex = 0;
  private states: Array<StateValue | undefined> = [];

  beginRender(): void {
    this.refIndex = 0;
    this.stateIndex = 0;
  }

  unmount(): void {
    for (const cleanup of this.effectCleanups) {
      cleanup();
    }
    this.effectCleanups = [];
  }

  readonly useCallback = <T extends Callback>(callback: T): T => callback;

  readonly useEffect = (effect: EffectCallback): void => {
    const cleanup = effect();
    if (cleanup) {
      this.effectCleanups.push(cleanup);
    }
  };

  readonly useRef = (initialValue: RefValue): { current: RefValue } => {
    const index = this.refIndex;
    this.refIndex += 1;

    const existingRef = this.refs[index];
    if (existingRef) {
      return existingRef;
    }

    const ref = { current: initialValue };
    this.refs[index] = ref;
    return ref;
  };

  readonly useState = (
    initialValue: StateValue,
  ): [StateValue, StateSetter<StateValue>] => {
    const index = this.stateIndex;
    this.stateIndex += 1;

    if (typeof this.states[index] === 'undefined') {
      this.states[index] = initialValue;
    }

    const setState: StateSetter<StateValue> = (value): void => {
      const previousValue =
        typeof this.states[index] === 'undefined' ? null : this.states[index];
      this.states[index] =
        typeof value === 'function' ? value(previousValue) : value;
    };

    return [
      typeof this.states[index] === 'undefined' ? null : this.states[index],
      setState,
    ];
  };
}

interface LoadedHook {
  render: (options?: DragToScrollOptions) => DragToScrollHookResult;
  unmount: () => void;
}

interface MountedHook {
  element: TestElement;
  hook: LoadedHook;
}

async function loadHook(): Promise<LoadedHook> {
  jest.resetModules();

  const harness = new HookHarness();
  jest.doMock('react', (): ReactMockExports => {
    return {
      useCallback: harness.useCallback,
      useEffect: harness.useEffect,
      useRef: harness.useRef,
      useState: harness.useState,
    };
  });

  const module = await import('../useDragToScroll');

  return {
    render: (options?: DragToScrollOptions): DragToScrollHookResult => {
      harness.beginRender();
      return module.useDragToScroll(options);
    },
    unmount: (): void => {
      harness.unmount();
    },
  };
}

function getTestDocument(): TestDocument {
  const document = Reflect.get(global, 'document');
  if (!(document instanceof TestDocument)) {
    throw new Error('Expected test document to be installed.');
  }

  return document;
}

async function mountHook(
  options?: DragToScrollOptions,
  element?: TestElement,
): Promise<MountedHook> {
  const hook = await loadHook();
  const mountedElement = element ?? new TestElement('div');
  const result = hook.render(options);
  Reflect.apply(result.ref, undefined, [mountedElement]);
  hook.render(options);
  return { element: mountedElement, hook };
}

describe('useDragToScroll', () => {
  const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(
    global,
    'document',
  );
  const originalElementDescriptor = Object.getOwnPropertyDescriptor(
    global,
    'Element',
  );

  beforeEach(() => {
    jest.useFakeTimers();

    const document = new TestDocument();
    document.body.style.cursor = 'context-menu';

    Object.defineProperty(global, 'document', {
      configurable: true,
      value: document,
    });
    Object.defineProperty(global, 'Element', {
      configurable: true,
      value: TestElement,
    });
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.resetModules();

    if (originalDocumentDescriptor) {
      Object.defineProperty(global, 'document', originalDocumentDescriptor);
    } else {
      Reflect.deleteProperty(global, 'document');
    }

    if (originalElementDescriptor) {
      Object.defineProperty(global, 'Element', originalElementDescriptor);
    } else {
      Reflect.deleteProperty(global, 'Element');
    }
  });

  it('ignores interactive descendants found through the composed path', async () => {
    const button = new TestElement('button');
    const icon = { kind: 'text-node' };
    const { element, hook } = await mountHook();

    const document = getTestDocument();
    const mouseDownEvent = new TestMouseEvent({
      button: 0,
      clientX: 20,
      clientY: 15,
      path: [icon, button, element, document.body],
      target: icon,
    });

    element.dispatchEvent('mousedown', mouseDownEvent);
    document.dispatchEvent(
      'mousemove',
      new TestMouseEvent({
        clientX: 90,
        clientY: 60,
        path: [document.body],
      }),
    );
    document.dispatchEvent(
      'mouseup',
      new TestMouseEvent({
        path: [document.body],
      }),
    );

    expect(element.scrollLeft).toBe(0);
    expect(element.scrollTop).toBe(0);
    expect(element.style.cursor).toBe('grab');
    expect(document.body.style.cursor).toBe('context-menu');

    hook.unmount();
  });

  it('suppresses clicks after an active drag and restores prior styles', async () => {
    const element = new TestElement('div');
    element.style.cursor = 'alias';
    element.style.userSelect = 'text';
    const { hook } = await mountHook(
      { dragThreshold: 5, draggingCursor: 'grabbing', hoverCursor: 'grab' },
      element,
    );

    const document = getTestDocument();

    element.dispatchEvent(
      'mousedown',
      new TestMouseEvent({
        button: 0,
        clientX: 10,
        clientY: 15,
        path: [element, document.body],
        target: element,
      }),
    );

    document.dispatchEvent(
      'mousemove',
      new TestMouseEvent({
        clientX: 30,
        clientY: 45,
        path: [document.body],
      }),
    );

    expect(element.scrollLeft).toBe(-20);
    expect(element.scrollTop).toBe(-30);
    expect(element.style.cursor).toBe('grabbing');
    expect(element.style.userSelect).toBe('none');
    expect(document.body.style.cursor).toBe('grabbing');

    document.dispatchEvent(
      'mouseup',
      new TestMouseEvent({
        path: [document.body],
      }),
    );

    expect(element.style.cursor).toBe('grab');
    expect(element.style.userSelect).toBe('text');
    expect(document.body.style.cursor).toBe('context-menu');

    const clickEvent = new TestMouseEvent({
      path: [element, document.body],
      target: element,
    });
    element.dispatchEvent('click', clickEvent);

    expect(clickEvent.defaultPrevented).toBe(true);
    expect(clickEvent.propagationStopped).toBe(true);

    const secondClickEvent = new TestMouseEvent({
      path: [element, document.body],
      target: element,
    });
    element.dispatchEvent('click', secondClickEvent);

    expect(secondClickEvent.defaultPrevented).toBe(false);
    expect(secondClickEvent.propagationStopped).toBe(false);

    hook.unmount();
    expect(element.style.cursor).toBe('alias');
    expect(element.style.userSelect).toBe('text');
  });

  it('does not activate drag behavior below the threshold', async () => {
    const { element, hook } = await mountHook({ dragThreshold: 10 });
    const document = getTestDocument();

    element.dispatchEvent(
      'mousedown',
      new TestMouseEvent({
        button: 0,
        clientX: 10,
        clientY: 10,
        path: [element, document.body],
        target: element,
      }),
    );

    document.dispatchEvent(
      'mousemove',
      new TestMouseEvent({
        clientX: 14,
        clientY: 13,
        path: [document.body],
      }),
    );
    document.dispatchEvent(
      'mouseup',
      new TestMouseEvent({
        path: [document.body],
      }),
    );

    const clickEvent = new TestMouseEvent({
      path: [element, document.body],
      target: element,
    });
    element.dispatchEvent('click', clickEvent);

    expect(element.scrollLeft).toBe(0);
    expect(element.scrollTop).toBe(0);
    expect(clickEvent.defaultPrevented).toBe(false);
    expect(clickEvent.propagationStopped).toBe(false);

    hook.unmount();
  });
});
