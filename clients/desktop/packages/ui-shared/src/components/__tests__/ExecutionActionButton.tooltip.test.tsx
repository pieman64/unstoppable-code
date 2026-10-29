/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ExecutionActionButton } from '../ExecutionActionButton';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('ExecutionActionButton tooltip (CAN-2799)', () => {
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
  });

  it('renders `title` as a rich tooltip on hover, never as a native title', () => {
    act(() => {
      root.render(
        <ExecutionActionButton
          label="Launch"
          ariaLabel="Launch scripts"
          title="Launch in progress"
          disabled
          onClick={jest.fn()}
        />,
      );
    });
    const button = container.querySelector<HTMLButtonElement>('button');
    expect(button?.hasAttribute('title')).toBe(false);
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    // The wrapper owns the hover handlers, so a disabled button still explains
    // itself.
    act(() => {
      button?.parentElement?.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Launch in progress',
    );
  });

  it('renders the bare button when no title is given', () => {
    act(() => {
      root.render(
        <ExecutionActionButton
          label="Launch"
          ariaLabel="Launch scripts"
          onClick={jest.fn()}
        />,
      );
    });
    const button = container.querySelector<HTMLButtonElement>('button');
    expect(button?.parentElement).toBe(container);
    act(() => {
      button?.focus();
    });
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
  });
});
