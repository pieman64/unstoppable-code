/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SidebarResizeHandle } from '../SidebarResizeHandle';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('SidebarResizeHandle', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('exposes drag state without painting a second divider', () => {
    const onResize = jest.fn();
    act(() => {
      root.render(<SidebarResizeHandle width={280} onResize={onResize} />);
    });

    const handle = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-resize-handle"]',
    );
    expect(handle).not.toBeNull();
    expect(handle?.childElementCount).toBe(0);
    expect(handle?.className).toContain('-right-1');
    expect(handle?.className).toContain('w-2');

    act(() => {
      handle?.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, clientX: 320 }),
      );
    });
    expect(handle?.getAttribute('data-resizing')).toBe('true');
    expect(onResize).toHaveBeenCalledWith(320);

    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup'));
    });
    expect(handle?.hasAttribute('data-resizing')).toBe(false);
  });
});
