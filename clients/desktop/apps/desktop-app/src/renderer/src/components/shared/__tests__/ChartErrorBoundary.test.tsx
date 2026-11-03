/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChartErrorBoundary } from '../ChartErrorBoundary';

function render(node: ReactNode): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

describe('ChartErrorBoundary', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  test('shows a chart-scoped fallback and remounts on reload', () => {
    let shouldThrow = true;

    function FlakyChart(): JSX.Element {
      if (shouldThrow) {
        throw new Error('chart exploded');
      }
      return <div data-testid="chart-ok">Chart rendered</div>;
    }

    const { container } = render(
      <ChartErrorBoundary label="Usage chart">
        <FlakyChart />
      </ChartErrorBoundary>,
    );

    expect(container.textContent).toContain(
      'Usage chart could not be rendered',
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Usage chart could not be rendered.',
    );
    expect(container.querySelector('[data-testid="chart-ok"]')).toBeNull();

    shouldThrow = false;
    act(() => {
      container.querySelector<HTMLButtonElement>('button')?.click();
    });

    expect(container.querySelector('[data-testid="chart-ok"]')).not.toBeNull();
    expect(container.textContent).not.toContain(
      'Usage chart could not be rendered',
    );
  });
});
