/** @jest-environment jsdom */
import {
  getAgentVisualTheme,
  observeAgentVisualFrame,
  subscribeAgentVisualTheme,
} from '../agent-visual-frame-runtime';

type IntersectionCallback = (entries: IntersectionObserverEntry[]) => void;
type Entry = {
  element: HTMLDivElement;
  current: { intersecting: boolean; allowed: boolean };
  cleanup: () => void;
};

it('shares one observer and caps visible frames at six with expanded priority', () => {
  let callback: IntersectionCallback = (): void => {};
  const observe = jest.fn();
  const unobserve = jest.fn();
  const disconnect = jest.fn();
  const factory = jest.fn().mockImplementation((next: IntersectionCallback) => {
    callback = next;
    return { observe, unobserve, disconnect };
  });
  Reflect.set(window, 'IntersectionObserver', factory);
  const entries: Entry[] = Array.from({ length: 7 }, (): Entry => {
    const element = document.createElement('div');
    document.body.append(element);
    return {
      element,
      current: { intersecting: false, allowed: false },
      cleanup: (): void => {},
    };
  });
  entries.forEach((entry: Entry, index: number): void => {
    entry.cleanup = observeAgentVisualFrame(
      document,
      entry.element,
      index === 6,
      (intersecting, allowed) => {
        entry.current = { intersecting, allowed };
      },
    );
  });
  expect(factory).toHaveBeenCalledTimes(1);
  for (const entry of entries) {
    callback([
      {
        target: entry.element,
        isIntersecting: true,
        boundingClientRect: entry.element.getBoundingClientRect(),
        intersectionRect: entry.element.getBoundingClientRect(),
        rootBounds: null,
        intersectionRatio: 1,
        time: 0,
      },
    ]);
  }
  expect(entries.filter((entry) => entry.current.allowed)).toHaveLength(6);
  expect(entries[6]?.current.allowed).toBe(true);
  entries.forEach((entry) => {
    entry.cleanup();
    entry.element.remove();
  });
  expect(disconnect).toHaveBeenCalledTimes(1);
  Reflect.deleteProperty(window, 'IntersectionObserver');
});

it('reads allowlisted variables and updates through one document observer', async () => {
  const first = jest.fn();
  const second = jest.fn();
  const stopFirst = subscribeAgentVisualTheme(document, first);
  const stopSecond = subscribeAgentVisualTheme(document, second);
  document.documentElement.style.setProperty('--bg-base', '#123456');
  await Promise.resolve();
  expect(getAgentVisualTheme(document).variables['--bg-base']).toBe('#123456');
  expect(first).toHaveBeenCalled();
  expect(second).toHaveBeenCalled();
  stopFirst();
  stopSecond();
  document.documentElement.style.removeProperty('--bg-base');
});

it("follows the app's dark class, not the system preference", async () => {
  // The system reports dark throughout; only the app's class may decide.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('dark'),
      media: query,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    }),
  });
  const listener = jest.fn();
  const stop = subscribeAgentVisualTheme(document, listener);
  expect(getAgentVisualTheme(document).appearance).toBe('light');
  document.documentElement.classList.add('dark');
  await Promise.resolve();
  expect(getAgentVisualTheme(document).appearance).toBe('dark');
  expect(listener).toHaveBeenCalled();
  document.documentElement.classList.remove('dark');
  await Promise.resolve();
  expect(getAgentVisualTheme(document).appearance).toBe('light');
  stop();
  Reflect.deleteProperty(window, 'matchMedia');
});

it('observes visuals mounted after the last one unmounted', () => {
  const observe = jest.fn();
  const factory = jest.fn().mockImplementation(() => ({
    observe,
    unobserve: jest.fn(),
    disconnect: jest.fn(),
  }));
  Reflect.set(window, 'IntersectionObserver', factory);
  const first = document.createElement('div');
  const second = document.createElement('div');
  document.body.append(first, second);
  observeAgentVisualFrame(document, first, false, () => {})();
  const states: Array<[boolean, boolean]> = [];
  const stop = observeAgentVisualFrame(document, second, false, (...state) =>
    states.push(state),
  );
  // A fresh observer watches the new visual, which is not assumed visible.
  expect(factory).toHaveBeenCalledTimes(2);
  expect(observe).toHaveBeenLastCalledWith(second);
  expect(states.at(-1)).toEqual([false, false]);
  stop();
  first.remove();
  second.remove();
  Reflect.deleteProperty(window, 'IntersectionObserver');
});

it('reads the current theme when a subscription starts again', () => {
  const stop = subscribeAgentVisualTheme(document, () => {});
  stop();
  // Changed while nothing was subscribed, so no observer saw it.
  document.documentElement.classList.add('dark');
  const restart = subscribeAgentVisualTheme(document, () => {});
  expect(getAgentVisualTheme(document).appearance).toBe('dark');
  restart();
  document.documentElement.classList.remove('dark');
});
