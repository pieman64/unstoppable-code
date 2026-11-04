/** @jest-environment jsdom */
import type { JSX } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { Skeleton, SKELETON_KEEP } from '../Skeleton';
import { SkeletonBlock } from '../SkeletonBlock';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(element: JSX.Element): void {
  act(() => {
    root.render(element);
  });
}

function Card(): JSX.Element {
  return (
    <div>
      <h3 {...SKELETON_KEEP}>Connected agents</h3>
      <p>Release notes writer</p>
    </div>
  );
}

describe('Skeleton', () => {
  it('while loading, is a status region over the content measured by skullet', () => {
    render(
      <Skeleton
        loading
        label="Loading agents"
        testId="agents-skeleton"
        className="mt-4"
      >
        <Card />
      </Skeleton>,
    );
    const region = container.querySelector('[data-testid="agents-skeleton"]');
    expect(region?.getAttribute('role')).toBe('status');
    expect(region?.className).toBe('mt-4');
    expect(region?.querySelector('.sr-only')?.textContent).toBe(
      'Loading agents',
    );

    const measured = region?.querySelector('[skullet-loading]');
    expect(measured?.getAttribute('aria-hidden')).toBe('true');
    expect(measured?.hasAttribute('inert')).toBe(true);
    expect(measured?.querySelector('h3')?.hasAttribute('skullet-own')).toBe(
      true,
    );
    expect(measured?.textContent).toContain('Release notes writer');
  });

  // skullet keeps a shape memory of content it reveals, observing it and
  // writing to localStorage; content never stays inside skullet.
  it('once loaded, renders the content directly, outside skullet', () => {
    render(
      <Skeleton loading={false} testId="agents-skeleton" className="mt-4">
        <Card />
      </Skeleton>,
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="agents-skeleton"]'),
    ).toBeNull();
    expect(
      container.querySelector('[skullet-reveal], [skullet-pane]'),
    ).toBeNull();
    expect(container.firstElementChild?.className).toBe('mt-4');
    expect(container.textContent).toContain('Release notes writer');
  });

  // The server render cannot measure, and skullet's server form carries an
  // inline script the web policy's nonce would refuse.
  it('renders no script on the server, holding the content’s space unseen', () => {
    const html = renderToString(
      <Skeleton loading testId="agents-skeleton">
        <Card />
      </Skeleton>,
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('skullet-loading');
    expect(html).toContain('class="invisible"');
    expect(html).toContain('role="status"');
  });
});

/**
 * A reduced-motion query the test can flip, and the Web Animations API jsdom
 * lacks: each element keeps the pulses started on it until they are cancelled.
 */
function stubLiveMotion(): {
  readonly setReduced: (reduced: boolean) => void;
  readonly running: (element: Element) => number;
} {
  let reduced = false;
  const listeners = new Set<() => void>();
  const pulses = new WeakMap<Element, Set<{ cancel: () => void }>>();
  const mediaQuery = {
    get matches(): boolean {
      return reduced;
    },
    addEventListener: (_type: string, listener: () => void): void => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void): void => {
      listeners.delete(listener);
    },
  };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => mediaQuery,
  });
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value(this: Element) {
      const set = pulses.get(this) ?? new Set();
      pulses.set(this, set);
      const pulse = {
        startTime: null,
        cancel: (): void => {
          set.delete(pulse);
        },
      };
      set.add(pulse);
      return pulse;
    },
  });
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value(this: Element) {
      return [...(pulses.get(this) ?? [])];
    },
  });
  return {
    setReduced: (next: boolean): void => {
      reduced = next;
      act(() => {
        for (const listener of [...listeners]) listener();
      });
    },
    running: (element: Element): number => pulses.get(element)?.size ?? 0,
  };
}

describe('SkeletonBlock motion', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'matchMedia');
    Reflect.deleteProperty(Element.prototype, 'animate');
    Reflect.deleteProperty(Element.prototype, 'getAnimations');
  });

  it('stops pulsing when reduced motion turns on while mounted, and resumes when it turns off', () => {
    const motion = stubLiveMotion();
    render(<SkeletonBlock width="1/2" />);
    const block = container.querySelector('[skullet-bar]');
    if (!block) throw new Error('missing block');
    expect(motion.running(block)).toBe(1);

    motion.setReduced(true);
    expect(motion.running(block)).toBe(0);

    motion.setReduced(false);
    expect(motion.running(block)).toBe(1);
  });

  it('stops listening once unmounted', () => {
    const motion = stubLiveMotion();
    render(<SkeletonBlock width="1/2" />);
    const block = container.querySelector('[skullet-bar]');
    if (!block) throw new Error('missing block');
    act(() => root.render(<span />));
    motion.setReduced(true);
    motion.setReduced(false);
    expect(motion.running(block)).toBe(1);
  });
});
