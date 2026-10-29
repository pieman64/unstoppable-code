/**
 * @jest-environment jsdom
 */
import katex from 'katex';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MarkdownMath } from '../MarkdownMath';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('MarkdownMath', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    jest.restoreAllMocks();
  });

  it('does not rerender unchanged admitted formulas', () => {
    const renderToString = jest.spyOn(katex, 'renderToString');

    act(() => {
      root.render(<MarkdownMath source="x + y" display={false} />);
    });
    expect(renderToString).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role=group]')).toBeNull();

    act(() => {
      root.render(<MarkdownMath source="x + y" display={false} />);
    });
    expect(renderToString).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(<MarkdownMath source="x + y" display />);
    });
    expect(renderToString).toHaveBeenCalledTimes(2);
    const region = container.querySelector('[role=group]');
    expect(region?.getAttribute('aria-label')).toBe('Formula');
    expect(region?.getAttribute('tabindex')).toBe('0');
    expect(region?.querySelector('math')).not.toBeNull();
  });
});
