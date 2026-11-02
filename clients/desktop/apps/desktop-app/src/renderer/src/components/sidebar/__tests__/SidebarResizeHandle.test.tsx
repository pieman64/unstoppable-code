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
  it('publishes the latest drag position once per frame and flushes on release', () => {
    const frames = new Map<number, (time: number) => void>();
    let nextId = 0;
    const request = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb) => {
        frames.set(++nextId, cb);
        return nextId;
      });
    const cancel = jest
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation((id) => {
        frames.delete(id);
      });
    const onResize = jest.fn();
    const onDragStateChange = jest.fn();
    try {
      act(() =>
        root.render(
          <SidebarResizeHandle
            width={280}
            onResize={onResize}
            onDragStateChange={onDragStateChange}
          />,
        ),
      );
      const handle = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-resize-handle"]',
      );
      act(() => {
        handle?.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, clientX: 280 }),
        );
      });
      onResize.mockClear();
      act(() => {
        for (let x = 281; x <= 380; x++)
          window.dispatchEvent(new MouseEvent('mousemove', { clientX: x }));
      });
      expect(onResize).not.toHaveBeenCalled();
      expect(frames.size).toBe(1);
      act(() => {
        const pending: Array<(time: number) => void> = Array.from(
          frames.values(),
        );
        frames.clear();
        pending.forEach((cb) => {
          cb(16);
        });
      });
      expect(onResize.mock.calls).toEqual([[380]]);
      act(() => {
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 }));
        window.dispatchEvent(new MouseEvent('mouseup', { clientX: 410 }));
      });
      expect(onResize.mock.calls).toEqual([[380], [410]]);
      expect(frames.size).toBe(0);
      expect(onDragStateChange.mock.calls).toEqual([[true], [false]]);
    } finally {
      request.mockRestore();
      cancel.mockRestore();
    }
  });

  it('cancels queued resize work when unmounted', () => {
    const onResize = jest.fn();
    const request = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockReturnValue(42);
    const cancel = jest
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => {});
    try {
      act(() =>
        root.render(<SidebarResizeHandle width={280} onResize={onResize} />),
      );
      const handle = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-resize-handle"]',
      );
      act(() => {
        handle?.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, clientX: 280 }),
        );
      });
      onResize.mockClear();
      act(() => {
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 360 }));
      });
      act(() => root.render(null));
      expect(cancel).toHaveBeenCalledWith(42);
      expect(onResize).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
      cancel.mockRestore();
    }
  });
  it('flushes the latest position and releases drag state when the window loses focus', () => {
    const request = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockReturnValue(42);
    const cancel = jest
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => {});
    const onResize = jest.fn();
    const onDragStateChange = jest.fn();
    try {
      act(() =>
        root.render(
          <SidebarResizeHandle
            width={280}
            onResize={onResize}
            onDragStateChange={onDragStateChange}
          />,
        ),
      );
      const handle = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-resize-handle"]',
      );
      act(() => {
        handle?.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, clientX: 280 }),
        );
      });
      onResize.mockClear();
      act(() => {
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 355 }));
        window.dispatchEvent(new Event('blur'));
      });
      expect(onResize.mock.calls).toEqual([[355]]);
      expect(cancel).toHaveBeenCalledWith(42);
      expect(handle?.hasAttribute('data-resizing')).toBe(false);
      expect(onDragStateChange.mock.calls).toEqual([[true], [false]]);
      expect(document.body.style.cursor).not.toBe('col-resize');
    } finally {
      request.mockRestore();
      cancel.mockRestore();
    }
  });
});
