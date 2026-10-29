/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  AgentVisualFrame,
  type AgentVisualFrameProps,
} from '../AgentVisualFrame';
import { resetAgentVisualFocusForTests } from '../agent-visual-frame-focus';
import { REPLAY_BLOCK_CLASS } from '../../../lib/replay-privacy';
import {
  AGENT_VISUAL_FONTS_METHOD,
  type AgentVisualFontFace,
} from '../../../lib/agent-visual-fonts';
import {
  AGENT_VISUAL_GESTURE_METHOD,
  AGENT_VISUAL_GESTURE_WATCH_METHOD,
  AGENT_VISUAL_LOAD_METHOD,
  AGENT_VISUAL_STATUS_METHOD,
  buildAgentVisualHostContextMessage,
  buildAgentVisualSrcDoc,
} from '../../../lib/agent-visual-html';

let hostFonts: AgentVisualFontFace[] = [];
let fontLoadListeners: Array<() => void> = [];
jest.mock('../agent-visual-frame-fonts', () => ({
  loadAgentVisualFonts: (): Promise<AgentVisualFontFace[]> =>
    Promise.resolve(hostFonts),
  watchAgentVisualFontLoads: (
    _ownerDocument: Document,
    listener: () => void,
  ): (() => void) => {
    fontLoadListeners.push(listener);
    return (): void => {
      fontLoadListeners = fontLoadListeners.filter(
        (candidate) => candidate !== listener,
      );
    };
  },
}));

const testIds = {
  frame: 'visual-frame',
  interactButton: 'interact',
  expandButton: 'expand',
  saveButton: 'save',
  unavailableState: 'unavailable',
  errorState: 'error',
  retryButton: 'retry',
};
const onOpenLink = jest.fn();
const baseProps: AgentVisualFrameProps = {
  document: '<p>hello</p>',
  title: 'Chart',
  maxHeight: 1200,
  theme: { appearance: 'light', variables: { '--bg-base': '#fff' } },
  variant: 'inline',
  testIds,
  onOpenLink,
};

function send(data: unknown, source?: MessageEventSource | null): void {
  const frame = byId<HTMLIFrameElement>(testIds.frame);
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data,
        source: source === undefined ? frame.contentWindow : source,
      }),
    );
  });
}

let host: HTMLDivElement;
let root: Root;
let frameWidth = 600;
const originalClientWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'clientWidth',
);
function byId<T extends HTMLElement>(id: string): T {
  const element = host.querySelector<T>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`Missing ${id}`);
  return element;
}
function render(props: AgentVisualFrameProps = baseProps): void {
  act(() => root.render(<AgentVisualFrame {...props} />));
}
function click(element: HTMLElement): void {
  act(() => element.click());
}
function query(id: string): HTMLElement | null {
  return host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}
/** One pointer movement over the visual, as the host sees it. */
function movePointer(x: number, y: number, pointerType = 'mouse'): void {
  const event = new MouseEvent('pointermove', {
    bubbles: true,
    clientX: x,
    clientY: y,
  });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  act(() => {
    byId(testIds.interactButton).dispatchEvent(event);
  });
}
/** The pointer arrives on the app outside the visual and moves there. */
function movePointerOnHost(x: number, y: number): void {
  const events = ['pointerover', 'pointermove'].map((type) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      clientX: x,
      clientY: y,
    });
    Object.defineProperty(event, 'pointerType', { value: 'mouse' });
    return event;
  });
  act(() => {
    for (const event of events) document.body.dispatchEvent(event);
  });
}
/** Moves the pointer from the app onto the visual, which is what lets it in. */
function hover(): void {
  movePointerOnHost(300, 10);
  movePointer(10, 10);
}
function pressKey(key: string): void {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true }),
    );
  });
}
function hostButton(): HTMLButtonElement {
  const button = document.createElement('button');
  document.body.append(button);
  return button;
}
/** The gesture checks the host has sent to the frame's wrapper, by id. */
function gestureChecks(post: jest.SpyInstance): number[] {
  return post.mock.calls.flatMap(([message]: [unknown, ...unknown[]]) => {
    if (
      typeof message !== 'object' ||
      message === null ||
      Reflect.get(message, 'method') !== AGENT_VISUAL_GESTURE_METHOD
    )
      return [];
    const params: unknown = Reflect.get(message, 'params');
    const id: unknown =
      typeof params === 'object' && params !== null
        ? Reflect.get(params, 'id')
        : undefined;
    return typeof id === 'number' ? [id] : [];
  });
}
function answerGesture(
  id: number,
  gesture: 'inside' | 'none' | 'unclear',
): void {
  send({
    jsonrpc: '2.0',
    method: AGENT_VISUAL_GESTURE_METHOD,
    params: { id, gesture },
  });
}
/** What the host has told the frame's wrapper about watching for gestures. */
function watchMessages(post: jest.SpyInstance): boolean[] {
  return post.mock.calls.flatMap(([message]: [unknown, ...unknown[]]) => {
    if (
      typeof message !== 'object' ||
      message === null ||
      Reflect.get(message, 'method') !== AGENT_VISUAL_GESTURE_WATCH_METHOD
    )
      return [];
    const params: unknown = Reflect.get(message, 'params');
    const watching: unknown =
      typeof params === 'object' && params !== null
        ? Reflect.get(params, 'watching')
        : undefined;
    return typeof watching === 'boolean' ? [watching] : [];
  });
}
function spyOnFrame(): jest.SpyInstance {
  const frameWindow = byId<HTMLIFrameElement>(testIds.frame).contentWindow;
  if (!frameWindow) throw new Error('Missing frame window');
  return jest.spyOn(frameWindow, 'postMessage');
}

let windowFocus: jest.SpyInstance;
beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom has no window to focus; the host asks for it when it takes focus back.
  windowFocus = jest.spyOn(window, 'focus').mockImplementation(() => {});
  resetAgentVisualFocusForTests(document);
  hostFonts = [];
  fontLoadListeners = [];
  jest.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  frameWidth = 600;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: (): number => frameWidth,
  });
});
afterEach(() => {
  windowFocus.mockRestore();
  act(() => root.unmount());
  host.remove();
  jest.useRealTimers();
  if (originalClientWidth)
    Object.defineProperty(
      HTMLElement.prototype,
      'clientWidth',
      originalClientWidth,
    );
  else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
});

it.each([
  [400, '900px'],
  [900, '420px'],
])('reserves the nearest measured height at %i px', (width, expected) => {
  frameWidth = width;
  render({
    ...baseProps,
    heights: [
      [360, 900],
      [520, 700],
      [720, 550],
      [960, 420],
    ],
  });
  expect((host.firstElementChild as HTMLElement).style.height).toBe(expected);
  send({
    jsonrpc: '2.0',
    method: 'ui/notifications/size-changed',
    params: { height: 333 },
  });
  expect((host.firstElementChild as HTMLElement).style.height).toBe('333px');
  render({
    ...baseProps,
    heights: [
      [360, 900],
      [520, 700],
      [720, 550],
      [960, 420],
    ],
  });
  expect((host.firstElementChild as HTMLElement).style.height).toBe('333px');
});

it('reserves maxHeight when there are no measured pairs', () => {
  frameWidth = 400;
  render({ ...baseProps, heights: [] });
  expect((host.firstElementChild as HTMLElement).style.height).toBe('1200px');
});

it('blocks the frame from session replay wherever it is mounted', () => {
  render({ ...baseProps, heights: [[600, 400]] });
  expect(
    byId<HTMLIFrameElement>(testIds.frame).classList.contains(
      REPLAY_BLOCK_CLASS,
    ),
  ).toBe(true);
});

it('uses an opaque wrapper and ignores forged messages while clamping height', () => {
  render({ ...baseProps, heights: [[600, 400]] });
  const frame = byId<HTMLIFrameElement>(testIds.frame);
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
  expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(frame.hasAttribute('inert')).toBe(true);
  send(
    {
      jsonrpc: '2.0',
      method: 'ui/notifications/size-changed',
      params: { height: 100000 },
    },
    window,
  );
  expect((host.firstElementChild as HTMLElement).style.height).toBe('400px');
  send({
    jsonrpc: '2.0',
    method: 'ui/notifications/size-changed',
    params: { height: 100000 },
  });
  expect((host.firstElementChild as HTMLElement).style.height).toBe('1200px');
  send({
    jsonrpc: '2.0',
    method: 'ui/notifications/size-changed',
    params: { height: 100000 },
  });
  expect(byId(testIds.frame)).toBe(frame);
  send({
    jsonrpc: '2.0',
    method: 'ui/notifications/size-changed',
    params: { height: 1000000 },
  });
  expect((host.firstElementChild as HTMLElement).style.height).toBe('1200px');
});

it('keeps srcdoc stable through theme changes and opens no link for a visual at rest', () => {
  render();
  const frame = byId<HTMLIFrameElement>(testIds.frame);
  const srcDoc = frame.srcdoc;
  render({ ...baseProps, theme: { appearance: 'dark', variables: {} } });
  expect(byId<HTMLIFrameElement>(testIds.frame).srcdoc).toBe(srcDoc);
  send({
    jsonrpc: '2.0',
    method: 'ui/open-link',
    params: { url: 'https://example.com/' },
  });
  expect(onOpenLink).not.toHaveBeenCalled();
  expect(frame.hasAttribute('inert')).toBe(true);
});

it('lets the pointer in once it moves over the visual, without moving focus', () => {
  const composer = hostButton();
  composer.focus();
  render();
  const frame = byId<HTMLIFrameElement>(testIds.frame);
  expect(frame.hasAttribute('inert')).toBe(true);
  // The first sighting only places the pointer.
  movePointer(10, 10);
  expect(frame.hasAttribute('inert')).toBe(true);
  movePointer(12, 10);
  expect(frame.hasAttribute('inert')).toBe(false);
  expect(query(testIds.interactButton)).toBeNull();
  expect(document.activeElement).toBe(composer);
  composer.remove();
});

it('does not let in a pointer that rests where a layout change left it', () => {
  render();
  movePointer(10, 10);
  movePointer(10, 10);
  expect(byId(testIds.frame).hasAttribute('inert')).toBe(true);
});

it('lets the pointer in on its first move onto the visual from the app', () => {
  render();
  const frame = byId<HTMLIFrameElement>(testIds.frame);
  movePointerOnHost(300, 10);
  // A quick flick that stops just inside the visual is a single move there.
  movePointer(10, 10);
  expect(frame.hasAttribute('inert')).toBe(false);
});

it('does not let in a move replayed where the app last saw the pointer', () => {
  render();
  movePointerOnHost(10, 10);
  movePointer(10, 10);
  expect(byId(testIds.frame).hasAttribute('inert')).toBe(true);
});

it('waits for a move on a visual the pointer may still be inside', () => {
  render();
  const frame = byId<HTMLIFrameElement>(testIds.frame);
  hover();
  pressKey('a');
  act(() => jest.advanceTimersByTime(1000));
  // The pointer moved inside the frame, where the app does not see it, so a
  // move replayed under it now is no sign of movement.
  movePointer(50, 50);
  expect(frame.hasAttribute('inert')).toBe(true);
  movePointer(52, 50);
  expect(frame.hasAttribute('inert')).toBe(false);
});

it('does not let in a touch that moves across the visual', () => {
  render();
  movePointer(10, 10, 'touch');
  movePointer(40, 80, 'touch');
  expect(byId(testIds.frame).hasAttribute('inert')).toBe(true);
});

it('lets in a pointer that comes to rest on the visual after scrolling', () => {
  render();
  const frame = byId<HTMLIFrameElement>(testIds.frame);
  const control = byId(testIds.interactButton);
  const hovered = jest.spyOn(control, 'matches').mockReturnValue(true);
  const wheel = (): void => {
    act(() => {
      control.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    });
  };
  wheel();
  act(() => jest.advanceTimersByTime(100));
  wheel();
  // Still scrolling: letting the pointer in now could trap the scroll.
  act(() => jest.advanceTimersByTime(149));
  expect(frame.hasAttribute('inert')).toBe(true);
  act(() => jest.advanceTimersByTime(1));
  expect(frame.hasAttribute('inert')).toBe(false);
  hovered.mockRestore();
});

it('does not let in a visual that scrolled out from under the pointer', () => {
  render();
  const control = byId(testIds.interactButton);
  const hovered = jest.spyOn(control, 'matches').mockReturnValue(false);
  act(() => {
    control.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
  });
  act(() => jest.advanceTimersByTime(500));
  expect(byId(testIds.frame).hasAttribute('inert')).toBe(true);
  hovered.mockRestore();
});

it('closes the visual to the pointer while the user types in the app', () => {
  render();
  hover();
  const frame = byId<HTMLIFrameElement>(testIds.frame);
  // A modifier alone types nothing.
  pressKey('Shift');
  expect(frame.hasAttribute('inert')).toBe(false);
  pressKey('a');
  expect(frame.hasAttribute('inert')).toBe(true);
});

it('holds a visual closed to a pointer that moves over it while the user is typing', () => {
  render();
  const frame = byId<HTMLIFrameElement>(testIds.frame);
  const control = byId(testIds.interactButton);
  const hovered = jest.spyOn(control, 'matches').mockReturnValue(true);
  pressKey('a');
  hover();
  // A hand that brushes the mouse mid-sentence does not open the visual.
  act(() => jest.advanceTimersByTime(999));
  expect(frame.hasAttribute('inert')).toBe(true);
  // Once the typing has stopped for a moment, a pointer still there is let in.
  act(() => jest.advanceTimersByTime(1));
  expect(frame.hasAttribute('inert')).toBe(false);
  hovered.mockRestore();
});

it('does not open a visual the pointer left during that wait', () => {
  render();
  const control = byId(testIds.interactButton);
  const hovered = jest.spyOn(control, 'matches').mockReturnValue(false);
  pressKey('a');
  hover();
  act(() => jest.advanceTimersByTime(2000));
  expect(byId(testIds.frame).hasAttribute('inert')).toBe(true);
  hovered.mockRestore();
});

it('keeps focus in a visual when its wrapper confirms a gesture inside it', () => {
  render();
  hover();
  const frame = byId<HTMLIFrameElement>(testIds.frame);
  const post = spyOnFrame();
  act(() => frame.focus());
  expect(gestureChecks(post)).toEqual([1]);
  answerGesture(1, 'inside');
  expect(frame.hasAttribute('inert')).toBe(false);
  expect(document.activeElement).toBe(frame);
  expect(query(testIds.errorState)).toBeNull();
  // One answer covers this stay; the wrapper is not asked again.
  act(() => jest.advanceTimersByTime(1000));
  expect(gestureChecks(post)).toEqual([1]);
});

it('takes focus back from a visual that took it with no gesture, and then needs a click', () => {
  const composer = hostButton();
  composer.focus();
  render();
  hover();
  const frame = byId<HTMLIFrameElement>(testIds.frame);
  const post = spyOnFrame();
  act(() => frame.focus());
  answerGesture(1, 'none');
  expect(frame.hasAttribute('inert')).toBe(true);
  expect(windowFocus).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(composer);
  expect(query(testIds.errorState)).toBeNull();
  // Moving the pointer no longer opens this visual.
  movePointer(20, 20);
  movePointer(30, 30);
  expect(frame.hasAttribute('inert')).toBe(true);
  // A click the host can see still does, and needs no confirmation.
  click(byId(testIds.interactButton));
  expect(frame.hasAttribute('inert')).toBe(false);
  expect(document.activeElement).toBe(frame);
  act(() => jest.advanceTimersByTime(1000));
  expect(gestureChecks(post)).toEqual([1]);
  expect(frame.hasAttribute('inert')).toBe(false);
  composer.remove();
});

it('takes focus back when the wrapper is slow to answer, and stays open to the pointer', () => {
  const composer = hostButton();
  composer.focus();
  render();
  hover();
  const frame = byId<HTMLIFrameElement>(testIds.frame);
  act(() => frame.focus());
  act(() => jest.advanceTimersByTime(149));
  expect(document.activeElement).toBe(frame);
  act(() => jest.advanceTimersByTime(1));
  expect(frame.hasAttribute('inert')).toBe(true);
  expect(document.activeElement).toBe(composer);
  // A page too busy to answer is not a hostile one, and a late confirmation
  // changes nothing.
  answerGesture(1, 'inside');
  expect(document.activeElement).toBe(composer);
  hover();
  expect(frame.hasAttribute('inert')).toBe(false);
  composer.remove();
});

it('believes a refusal that arrives late', () => {
  const composer = hostButton();
  composer.focus();
  render();
  hover();
  const frame = byId<HTMLIFrameElement>(testIds.frame);
  act(() => frame.focus());
  act(() => jest.advanceTimersByTime(150));
  hover();
  expect(frame.hasAttribute('inert')).toBe(false);
  answerGesture(1, 'none');
  expect(frame.hasAttribute('inert')).toBe(true);
  hover();
  expect(frame.hasAttribute('inert')).toBe(true);
  composer.remove();
});

it('takes focus back without blame when the wrapper cannot tell the order', () => {
  // Focus and the gesture were first seen together, as when the visual's
  // thread was busy: a key typed into a field the page focused itself would
  // look the same, so the focus goes back, but the visual is not marked.
  const composer = hostButton();
  composer.focus();
  render();
  hover();
  const frame = byId<HTMLIFrameElement>(testIds.frame);
  act(() => frame.focus());
  answerGesture(1, 'unclear');
  expect(frame.hasAttribute('inert')).toBe(true);
  expect(document.activeElement).toBe(composer);
  hover();
  expect(frame.hasAttribute('inert')).toBe(false);
  composer.remove();
});

it('asks the wrapper to watch for gestures only while the pointer has the visual open', () => {
  render();
  const post = spyOnFrame();
  hover();
  expect(watchMessages(post)).toEqual([true]);
  pressKey('a');
  expect(watchMessages(post).at(-1)).toBe(false);
  // A click on the host control needs no watching.
  click(byId(testIds.interactButton));
  expect(watchMessages(post).filter((watching) => watching)).toHaveLength(1);
});

it('ignores a gesture answer that is stale or comes from another window', () => {
  const composer = hostButton();
  composer.focus();
  render();
  hover();
  const frame = byId<HTMLIFrameElement>(testIds.frame);
  act(() => frame.focus());
  send(
    {
      jsonrpc: '2.0',
      method: AGENT_VISUAL_GESTURE_METHOD,
      params: { id: 1, gesture: 'inside' },
    },
    window,
  );
  answerGesture(41, 'inside');
  act(() => jest.advanceTimersByTime(150));
  expect(frame.hasAttribute('inert')).toBe(true);
  expect(document.activeElement).toBe(composer);
  composer.remove();
});

it('remembers a visual that took focus, wherever it is shown next', () => {
  render();
  hover();
  act(() => byId<HTMLIFrameElement>(testIds.frame).focus());
  answerGesture(1, 'none');
  act(() => root.unmount());
  root = createRoot(host);
  render();
  hover();
  expect(byId(testIds.frame).hasAttribute('inert')).toBe(true);
  // Another visual is judged on its own.
  render({ ...baseProps, document: '<p>another</p>' });
  act(() => root.unmount());
  root = createRoot(host);
  render({ ...baseProps, document: '<p>another</p>' });
  hover();
  expect(byId(testIds.frame).hasAttribute('inert')).toBe(false);
});

it('keeps every copy of a refused visual closed to the pointer', () => {
  // The same visual can be in the transcript and in the Chat visuals panel.
  const otherNode = document.createElement('div');
  document.body.append(otherNode);
  const otherRoot = createRoot(otherNode);
  act(() => otherRoot.render(<AgentVisualFrame {...baseProps} />));
  const otherFrame = otherNode.querySelector<HTMLIFrameElement>(
    `[data-testid="${testIds.frame}"]`,
  );
  const otherControl = otherNode.querySelector<HTMLElement>(
    `[data-testid="${testIds.interactButton}"]`,
  );
  if (!otherFrame || !otherControl) throw new Error('Missing the other copy');
  render();
  hover();
  act(() => byId<HTMLIFrameElement>(testIds.frame).focus());
  answerGesture(1, 'none');
  const move = (x: number): void => {
    const event = new MouseEvent('pointermove', {
      bubbles: true,
      clientX: x,
      clientY: 10,
    });
    Object.defineProperty(event, 'pointerType', { value: 'mouse' });
    act(() => {
      otherControl.dispatchEvent(event);
    });
  };
  move(10);
  move(20);
  expect(otherFrame.hasAttribute('inert')).toBe(true);
  expect(otherControl.className.split(/\s+/)).toContain('cursor-pointer');
  act(() => otherRoot.unmount());
  otherNode.remove();
});

it('notices focus that enters a pointer-opened visual without any event', () => {
  // Some engines fire neither focusin nor a window blur for this.
  render();
  hover();
  const frame = byId<HTMLIFrameElement>(testIds.frame);
  const post = spyOnFrame();
  Object.defineProperty(document, 'activeElement', {
    configurable: true,
    get: (): Element => frame,
  });
  try {
    act(() => jest.advanceTimersByTime(100));
    expect(gestureChecks(post)).toEqual([1]);
  } finally {
    Reflect.deleteProperty(document, 'activeElement');
  }
});

it('moves focus into the visual only after it stops being inert', () => {
  render();
  const frame = byId<HTMLIFrameElement>(testIds.frame);
  // Browsers refuse focus to an inert element, so record inert at the call.
  const inertAtFocus: boolean[] = [];
  const focus = frame.focus.bind(frame);
  frame.focus = (): void => {
    inertAtFocus.push(frame.hasAttribute('inert'));
    focus();
  };
  click(byId(testIds.interactButton));
  expect(inertAtFocus).toEqual([false]);
  expect(document.activeElement).toBe(frame);
});

it('times out without ready, tears down, and retries with a fresh frame', () => {
  render();
  const first = byId(testIds.frame);
  act(() => jest.advanceTimersByTime(10000));
  expect(byId(testIds.errorState).textContent).toContain("couldn't be shown");
  expect(host.querySelector(`[data-testid="${testIds.frame}"]`)).toBeNull();
  click(byId(testIds.retryButton));
  expect(byId(testIds.frame)).not.toBe(first);
});

it('pauses the liveness clock when hidden', () => {
  const original = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  render();
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'hidden',
  });
  act(() => jest.advanceTimersByTime(30000));
  expect(
    host.querySelector(`[data-testid="${testIds.errorState}"]`),
  ).toBeNull();
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  act(() => jest.advanceTimersByTime(8000));
  expect(
    host.querySelector(`[data-testid="${testIds.errorState}"]`),
  ).toBeNull();
  if (original) Object.defineProperty(document, 'visibilityState', original);
});

it('opens only external http links with host activation and frame focus', () => {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'userActivation');
  Object.defineProperty(navigator, 'userActivation', {
    configurable: true,
    value: { isActive: true },
  });
  render();
  const frame = byId<HTMLIFrameElement>(testIds.frame);
  click(byId(testIds.interactButton));
  frame.focus();
  const link = (url: string): void =>
    send({ jsonrpc: '2.0', method: 'ui/open-link', params: { url } });
  link(window.location.origin + '/api/private');
  link('file:///private/report');
  link('app-renderer://private/');
  expect(onOpenLink).not.toHaveBeenCalled();
  link('https://example.com/chart');
  expect(onOpenLink).toHaveBeenCalledWith('https://example.com/chart');
  if (previous) Object.defineProperty(navigator, 'userActivation', previous);
  else Reflect.deleteProperty(navigator, 'userActivation');
  onOpenLink.mockClear();
});

it('never mounts a frame into another owner document', () => {
  const foreign = document.implementation.createHTMLDocument('Auxiliary');
  const node = foreign.createElement('div');
  foreign.body.append(node);
  const foreignRoot = createRoot(node);
  act(() =>
    foreignRoot.render(
      <AgentVisualFrame
        {...baseProps}
        onExpand={jest.fn()}
        onSave={jest.fn()}
      />,
    ),
  );
  expect(
    node.querySelector(`[data-testid="${testIds.unavailableState}"]`)
      ?.textContent,
  ).toContain('main window');
  expect(node.querySelector('iframe')).toBeNull();
  // Its panel could not show it either; the file can still be saved.
  expect(
    node.querySelector(`[data-testid="${testIds.expandButton}"]`),
  ).toBeNull();
  expect(
    node.querySelector(`[data-testid="${testIds.saveButton}"]`),
  ).not.toBeNull();
  act(() => foreignRoot.unmount());
});

it('deactivates when focus returns to the host or Escape is pressed there', () => {
  const outside = hostButton();
  render();
  const frame = byId<HTMLIFrameElement>(testIds.frame);
  click(byId(testIds.interactButton));
  expect(frame.hasAttribute('inert')).toBe(false);
  act(() => outside.focus());
  expect(frame.hasAttribute('inert')).toBe(true);
  click(byId(testIds.interactButton));
  act(() => frame.blur());
  expect(frame.hasAttribute('inert')).toBe(false);
  pressKey('Escape');
  expect(frame.hasAttribute('inert')).toBe(true);
  outside.remove();
});

it('does not activate from a forged bridge method and tears down a view-only focus steal', () => {
  render();
  const frame = byId<HTMLIFrameElement>(testIds.frame);
  send({ jsonrpc: '2.0', method: 'canopy/visual/activate', params: {} });
  expect(frame.hasAttribute('inert')).toBe(true);
  act(() => frame.focus());
  expect(host.querySelector(`[data-testid="${testIds.frame}"]`)).toBeNull();
  expect(byId(testIds.errorState).getAttribute('role')).toBe('status');
});

it('tears down a view-only visual that takes focus without a host focusin', () => {
  // Focus moving into an out-of-process frame blurs the host window but does
  // not always dispatch focusin on the host document.
  render();
  const frame = byId<HTMLIFrameElement>(testIds.frame);
  Object.defineProperty(document, 'activeElement', {
    configurable: true,
    get: (): Element => frame,
  });
  try {
    act(() => {
      window.dispatchEvent(new Event('blur'));
      jest.advanceTimersByTime(0);
    });
    expect(host.querySelector(`[data-testid="${testIds.frame}"]`)).toBeNull();
    expect(byId(testIds.errorState).textContent).toContain("couldn't be shown");
  } finally {
    // Restores the inherited Document.prototype getter.
    Reflect.deleteProperty(document, 'activeElement');
  }
});

/** Six expanded visuals take every live-frame slot ahead of an inline one. */
function occupyEveryFrameSlot(): () => void {
  const others = Array.from({ length: 6 }, () => {
    const node = document.createElement('div');
    document.body.append(node);
    const otherRoot = createRoot(node);
    act(() =>
      otherRoot.render(<AgentVisualFrame {...baseProps} variant="expanded" />),
    );
    return { node, otherRoot };
  });
  return (): void => {
    for (const { node, otherRoot } of others) {
      act(() => otherRoot.unmount());
      node.remove();
    }
  };
}

it('stays view-only after losing and regaining its frame slot on screen', () => {
  render();
  click(byId(testIds.interactButton));
  expect(byId<HTMLIFrameElement>(testIds.frame).hasAttribute('inert')).toBe(
    false,
  );
  const release = occupyEveryFrameSlot();
  expect(host.querySelector(`[data-testid="${testIds.frame}"]`)).toBeNull();
  release();
  // The new frame needs a new host activation.
  expect(byId<HTMLIFrameElement>(testIds.frame).hasAttribute('inert')).toBe(
    true,
  );
  expect(byId(testIds.interactButton)).toBeTruthy();
});

it('gives a prioritized visual a frame ahead of six transcript visuals', () => {
  const others = Array.from({ length: 6 }, () => {
    const node = document.createElement('div');
    document.body.append(node);
    const otherRoot = createRoot(node);
    act(() => otherRoot.render(<AgentVisualFrame {...baseProps} />));
    return { node, otherRoot };
  });
  try {
    render({ ...baseProps, prioritized: true });
    expect(query(testIds.frame)).not.toBeNull();
    // Without the priority it waits for a slot like any other inline visual.
    render({ ...baseProps, prioritized: false });
    expect(query(testIds.frame)).toBeNull();
  } finally {
    for (const { node, otherRoot } of others) {
      act(() => otherRoot.unmount());
      node.remove();
    }
  }
});

it('builds a remounted frame with the theme current at remount', () => {
  render();
  expect(byId<HTMLIFrameElement>(testIds.frame).srcdoc).toContain(
    'color-scheme:light',
  );
  const release = occupyEveryFrameSlot();
  render({ ...baseProps, theme: { appearance: 'dark', variables: {} } });
  release();
  expect(byId<HTMLIFrameElement>(testIds.frame).srcdoc).toContain(
    'color-scheme:dark',
  );
});

it('sends the current theme when a new frame reports ready', () => {
  const theme = { appearance: 'dark' as const, variables: {} };
  render({ ...baseProps, theme });
  const frameWindow = byId<HTMLIFrameElement>(testIds.frame).contentWindow;
  if (!frameWindow) throw new Error('Missing frame window');
  const post = jest.spyOn(frameWindow, 'postMessage');
  // A message posted before the relay listens is lost, so ready re-sends it.
  send({
    jsonrpc: '2.0',
    method: AGENT_VISUAL_STATUS_METHOD,
    params: { state: 'ready' },
  });
  expect(post).toHaveBeenCalledWith(
    buildAgentVisualHostContextMessage(theme),
    '*',
  );
});

it('deactivates when the pointer reaches the host outside the visual with focus outside', () => {
  // Chromium and WebKit report the pointer as having left the container once
  // it enters the iframe, so leaving the visual later fires no pointerleave;
  // arriving on a host element is the signal every engine reports.
  render();
  click(byId(testIds.interactButton));
  const frame = byId<HTMLIFrameElement>(testIds.frame);
  expect(frame.hasAttribute('inert')).toBe(false);
  act(() => frame.blur());
  const outside = document.createElement('button');
  document.body.append(outside);
  act(() => {
    outside.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
  });
  expect(frame.hasAttribute('inert')).toBe(true);
  outside.remove();
});

it('stays active while the pointer moves over host elements with focus in the visual', () => {
  render();
  click(byId(testIds.interactButton));
  const frame = byId<HTMLIFrameElement>(testIds.frame);
  expect(document.activeElement).toBe(frame);
  act(() => {
    document.body.dispatchEvent(
      new MouseEvent('pointerover', { bubbles: true }),
    );
  });
  expect(frame.hasAttribute('inert')).toBe(false);
});

it('has no border, rounded corners, or label, and names what activating the visual does', () => {
  render();
  const frame = byId<HTMLIFrameElement>(testIds.frame);
  for (
    let element: HTMLElement | null = frame;
    element && element !== host;
    element = element.parentElement
  ) {
    const classes = element.className.split(/\s+/);
    expect(classes).not.toContain('border');
    // A rounded box would cut off whatever the visual draws in its corners.
    expect(classes.filter((name) => name.startsWith('rounded'))).toEqual([]);
  }
  expect(host.textContent).toBe('');
  expect(byId(testIds.interactButton).getAttribute('aria-label')).toBe(
    'Interact with Chart',
  );
});

it('offers expand and save as named corner actions that leave the visual view-only', () => {
  const onExpand = jest.fn();
  const onSave = jest.fn();
  render({ ...baseProps, onExpand, onSave });
  const frame = byId<HTMLIFrameElement>(testIds.frame);
  const expand = byId(testIds.expandButton);
  const save = byId(testIds.saveButton);
  expect(expand.getAttribute('aria-label')).toBe('Open in Chat visuals');
  expect(save.getAttribute('aria-label')).toBe('Save as HTML');
  click(expand);
  click(save);
  expect(onExpand).toHaveBeenCalledTimes(1);
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(frame.hasAttribute('inert')).toBe(true);
  // Tab leaves the visual toward its actions, never back into the page first.
  for (const action of [expand, save]) {
    expect(
      frame.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  }
});

it('shows no outline and no control of its own while the pointer is in the visual', () => {
  render({ ...baseProps, onSave: jest.fn() });
  const actions = byId(testIds.saveButton).closest('div');
  if (!actions) throw new Error('Missing corner actions');
  expect(actions.className.split(/\s+/)).toContain('opacity-0');
  hover();
  expect(host.querySelectorAll('button')).toHaveLength(1);
  expect(host.innerHTML).not.toContain('ring-line-focus');
  // An out-of-process frame takes the hover with it, so the corner actions
  // stay up for as long as the pointer is let in.
  expect(actions.className.split(/\s+/)).not.toContain('opacity-0');
  expect(actions.className.split(/\s+/)).toContain('opacity-100');
});

it('has no expand action in the expanded view', () => {
  render({ ...baseProps, variant: 'expanded', onExpand: jest.fn() });
  expect(query(testIds.expandButton)).toBeNull();
});

it('posts the app font faces that finish loading after the frame is ready', async () => {
  const face: AgentVisualFontFace = {
    family: 'Inter',
    style: 'normal',
    weight: '400 500',
    stretch: 'normal',
    unicodeRange: 'U+0-10FFFF',
    data: new ArrayBuffer(8),
  };
  render();
  const post = spyOnFrame();
  const fontMessages = (): unknown[] =>
    post.mock.calls
      .map(([message]: [unknown, ...unknown[]]) => message)
      .filter(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          Reflect.get(message, 'method') === AGENT_VISUAL_FONTS_METHOD,
      );
  // The app is still loading its faces when the visual is ready.
  send({
    jsonrpc: '2.0',
    method: AGENT_VISUAL_STATUS_METHOD,
    params: { state: 'ready' },
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(fontMessages()).toEqual([]);
  // They finish loading.
  hostFonts = [face];
  await act(async () => {
    for (const listener of fontLoadListeners) listener();
    await Promise.resolve();
  });
  expect(fontMessages()).toHaveLength(1);
  // A later load that brings nothing new sends nothing again.
  await act(async () => {
    for (const listener of fontLoadListeners) listener();
    await Promise.resolve();
  });
  expect(fontMessages()).toHaveLength(1);
  act(() => root.unmount());
  root = createRoot(host);
  expect(fontLoadListeners).toEqual([]);
});

it('posts the app font faces once the frame is ready, and not before', async () => {
  hostFonts = [
    {
      family: 'Inter',
      style: 'normal',
      weight: '400 500',
      stretch: 'normal',
      unicodeRange: 'U+0-10FFFF',
      data: new ArrayBuffer(8),
    },
  ];
  render();
  const frameWindow = byId<HTMLIFrameElement>(testIds.frame).contentWindow;
  if (!frameWindow) throw new Error('Missing frame window');
  const post = jest.spyOn(frameWindow, 'postMessage');
  const fontMessages = (): unknown[] =>
    post.mock.calls
      .map(([message]: [unknown, ...unknown[]]) => message)
      .filter(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          Reflect.get(message, 'method') === AGENT_VISUAL_FONTS_METHOD,
      );
  await act(async () => {
    await Promise.resolve();
  });
  expect(fontMessages()).toEqual([]);
  send({
    jsonrpc: '2.0',
    method: AGENT_VISUAL_STATUS_METHOD,
    params: { state: 'ready' },
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(fontMessages()).toEqual([
    {
      jsonrpc: '2.0',
      method: AGENT_VISUAL_FONTS_METHOD,
      params: { faces: hostFonts },
    },
  ]);
});

describe('a frame the host serves', () => {
  const FRAME_URL = '/api/v1/chat-visual-frame';
  const awaitingDocument = {
    jsonrpc: '2.0',
    method: AGENT_VISUAL_STATUS_METHOD,
    params: { state: 'awaiting-document' },
  };
  /** The documents the host has handed to the frame, with their target. */
  function loadMessages(post: jest.SpyInstance): unknown[] {
    return post.mock.calls.flatMap(
      ([message, target]: [unknown, ...unknown[]]) => {
        if (
          typeof message !== 'object' ||
          message === null ||
          Reflect.get(message, 'method') !== AGENT_VISUAL_LOAD_METHOD
        )
          return [];
        const params: unknown = Reflect.get(message, 'params');
        return [{ params, target }];
      },
    );
  }

  it('frames the host document by URL, with the same sandbox and no inline document', () => {
    render({ ...baseProps, frameUrl: FRAME_URL });
    const frame = byId<HTMLIFrameElement>(testIds.frame);
    expect(frame.getAttribute('src')).toBe(FRAME_URL);
    expect(frame.hasAttribute('srcdoc')).toBe(false);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.hasAttribute('inert')).toBe(true);
  });

  it('hands the agent document over when the frame asks for it', () => {
    render({ ...baseProps, frameUrl: FRAME_URL });
    const post = spyOnFrame();
    send(awaitingDocument);
    expect(loadMessages(post)).toEqual([
      {
        params: {
          srcdoc: buildAgentVisualSrcDoc(baseProps.document, baseProps.theme),
          title: 'Chart',
          appearance: 'light',
        },
        target: '*',
      },
    ]);
  });

  it('answers only its own frame', () => {
    render({ ...baseProps, frameUrl: FRAME_URL });
    const post = spyOnFrame();
    send(awaitingDocument, window);
    expect(loadMessages(post)).toEqual([]);
  });

  it('hands nothing to an inline frame, which is built around its document', () => {
    render();
    const post = spyOnFrame();
    send(awaitingDocument);
    expect(loadMessages(post)).toEqual([]);
  });

  it('loads the frame again for a new document', () => {
    render({ ...baseProps, frameUrl: FRAME_URL });
    const first = byId<HTMLIFrameElement>(testIds.frame);
    render({ ...baseProps, frameUrl: FRAME_URL, document: '<p>next</p>' });
    const second = byId<HTMLIFrameElement>(testIds.frame);
    // A served frame takes one document, so a new one needs a new frame.
    expect(second).not.toBe(first);
    const post = spyOnFrame();
    send(awaitingDocument);
    expect(loadMessages(post)).toEqual([
      {
        params: {
          srcdoc: buildAgentVisualSrcDoc('<p>next</p>', baseProps.theme),
          title: 'Chart',
          appearance: 'light',
        },
        target: '*',
      },
    ]);
  });
});
