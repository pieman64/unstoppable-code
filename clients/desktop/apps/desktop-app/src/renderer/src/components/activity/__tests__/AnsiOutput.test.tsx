/**
 * @jest-environment jsdom
 */

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnsiUp } from 'ansi_up';
import { AnsiOutput } from '../AnsiOutput';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function render(node: JSX.Element): {
  container: HTMLDivElement;
  cleanup: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(node));
  return {
    container,
    cleanup: (): void => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('AnsiOutput', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('bounds ANSI conversion to the rendered tail for inline output', () => {
    const convert = jest.spyOn(AnsiUp.prototype, 'ansi_to_html');
    const lines = Array.from({ length: 1_000 }, (_, index) => `line ${index}`);

    const view = render(
      <AnsiOutput lines={lines} maxRenderLines={12} truncateLines />,
    );

    expect(convert).toHaveBeenCalledTimes(12);
    expect(
      view.container.querySelectorAll('[class*="text-ellipsis"]'),
    ).toHaveLength(12);

    view.cleanup();
  });

  it('preserves ANSI state established before the rendered tail', () => {
    const convert = jest.spyOn(AnsiUp.prototype, 'ansi_to_html');
    const lines = ['\u001b[31mred starts', 'still red', 'visible red'];

    const view = render(<AnsiOutput lines={lines} maxRenderLines={1} />);

    expect(convert).toHaveBeenCalledTimes(1);
    expect(convert).toHaveBeenCalledWith('\u001b[31mvisible red');
    expect(view.container.textContent).toContain('visible red');
    expect(view.container.textContent).not.toContain('red starts');

    view.cleanup();
  });
});
