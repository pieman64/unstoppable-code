/**
 * @jest-environment jsdom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LinearProgress } from '../LinearProgress';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(node: ReactNode): HTMLElement | null {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(node);
  });
  return container.querySelector<HTMLElement>('[role="progressbar"]');
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe('LinearProgress', () => {
  it('omits aria-valuetext by default', () => {
    const bar = render(<LinearProgress percentage={40} label="Window" />);
    expect(bar?.hasAttribute('aria-valuetext')).toBe(false);
    expect(bar?.getAttribute('aria-valuenow')).toBe('40');
  });

  it('forwards value text for determinate progress', () => {
    const bar = render(
      <LinearProgress
        percentage={120}
        valueText="120.0% used, Limit reached"
      />,
    );
    expect(bar?.getAttribute('aria-valuetext')).toBe(
      '120.0% used, Limit reached',
    );
    expect(bar?.getAttribute('aria-valuenow')).toBe('100');
  });

  it('ignores value text while indeterminate', () => {
    const bar = render(
      <LinearProgress percentage={0} indeterminate valueText="Loading" />,
    );
    expect(bar?.hasAttribute('aria-valuetext')).toBe(false);
    expect(bar?.hasAttribute('aria-valuenow')).toBe(false);
  });
});
