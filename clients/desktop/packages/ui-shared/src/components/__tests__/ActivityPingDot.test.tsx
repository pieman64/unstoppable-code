/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ActivityPingDot } from '../ActivityPingDot';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('ActivityPingDot', () => {
  it('renders the testid, aria-label, and native tooltip from props', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(<ActivityPingDot label="Running" testId="dot-running" />);
    });

    const dot = container.querySelector('[data-testid="dot-running"]');
    expect(dot).not.toBeNull();
    // ARIA 1.2 prohibits naming a generic span, so the dot is an image for
    // its aria-label to name it.
    expect(dot?.getAttribute('role')).toBe('img');
    expect(dot?.getAttribute('aria-label')).toBe('Running');
    expect(dot?.getAttribute('title')).toBe('Running');

    act(() => root.unmount());
    container.remove();
  });

  it('keeps the solid dot and animate-ping ring classes desktop shipped', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(<ActivityPingDot label="Loading" testId="dot-loading" />);
    });

    const dot = container.querySelector('[data-testid="dot-loading"]');
    const ring = dot?.firstElementChild;
    const solid = dot?.lastElementChild;
    expect(ring?.className).toContain('animate-ping');
    expect(ring?.className).toContain('bg-fg-info/60');
    expect(solid?.className).toContain('bg-fg-info');
    expect(solid?.className).not.toContain('animate-ping');

    act(() => root.unmount());
    container.remove();
  });

  it('freezes the ping ring under prefers-reduced-motion, additively', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(<ActivityPingDot label="Running" testId="dot-reduced" />);
    });

    const dot = container.querySelector('[data-testid="dot-reduced"]');
    const ring = dot?.firstElementChild;
    expect(ring?.className).toContain('motion-reduce:animate-none');
    // Additive: the ping animation itself is still declared for users who
    // do not have reduced motion enabled.
    expect(ring?.className).toContain('animate-ping');

    act(() => root.unmount());
    container.remove();
  });
});
