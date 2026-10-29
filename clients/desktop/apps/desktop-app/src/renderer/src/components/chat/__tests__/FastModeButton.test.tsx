/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { focusViaKeyboard } from '@/test-utils/dom';
import { FastModeButton } from '../FastModeButton';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('FastModeButton', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
  });

  // Pipeline hook inputs keep their boolean: Use default → Fast → Regular.
  it('cycles Use default → Fast → Regular → Use default', () => {
    const onChange = jest.fn();
    act(() => {
      root.render(<FastModeButton value={undefined} onChange={onChange} />);
    });
    const button = host.querySelector<HTMLButtonElement>('button');
    expect(button?.textContent).toBe('Use default');
    act(() => {
      button?.click();
    });
    expect(onChange).toHaveBeenLastCalledWith(true);

    act(() => {
      root.render(<FastModeButton value onChange={onChange} />);
    });
    expect(host.querySelector('button')?.textContent).toBe('Fast');
    act(() => {
      host.querySelector('button')?.click();
    });
    expect(onChange).toHaveBeenLastCalledWith(false);

    act(() => {
      root.render(<FastModeButton value={false} onChange={onChange} />);
    });
    expect(host.querySelector('button')?.textContent).toBe('Regular');
    act(() => {
      host.querySelector('button')?.click();
    });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('announces the current and next speed without a pressed state', () => {
    act(() => {
      root.render(<FastModeButton value={false} onChange={jest.fn()} />);
    });
    const button = host.querySelector<HTMLButtonElement>('button');
    expect(button?.getAttribute('aria-label')).toBe(
      'Speed: Regular. Select to use the default speed.',
    );
    expect(button?.hasAttribute('aria-pressed')).toBe(false);
  });

  it('uses the shared app speed glyph', () => {
    act(() => {
      root.render(<FastModeButton value onChange={jest.fn()} />);
    });
    // The retired local glyph drew this exact path.
    expect(host.querySelector('svg path[d^="M13 2 4 14"]')).toBeNull();
    expect(host.querySelector('svg')).not.toBeNull();
  });

  it('explains usage with a rich tooltip and no fixed multiplier (CAN-2799)', () => {
    act(() => {
      root.render(<FastModeButton value={undefined} onChange={jest.fn()} />);
    });
    const button = host.querySelector<HTMLButtonElement>('button');
    expect(button?.hasAttribute('title')).toBe(false);
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    act(() => {
      focusViaKeyboard(button);
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Higher speeds may use more of your subscription allowance.',
    );
  });
});
