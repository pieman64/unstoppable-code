/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ActionTooltip } from '@/components/shared/ActionTooltip';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('ActionTooltip', () => {
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
    // Remove any portaled tooltip nodes that may linger after unmount.
    document
      .querySelectorAll('[role="tooltip"]')
      .forEach((node) => node.remove());
  });

  it('preserves caller classes without changing the cursor', () => {
    act(() => {
      root.render(
        createElement(ActionTooltip, {
          title: 'Fork chat',
          description: 'Duplicate this chat.',
          children: createElement(
            'button',
            { type: 'button', className: 'base-class' },
            'F',
          ),
        }),
      );
    });

    const button = container.querySelector('button');
    expect(button?.className).toContain('base-class');
    expect(button?.className).not.toContain('cursor-help');
  });

  it('portals the rich tooltip on hover and wires aria-describedby', () => {
    act(() => {
      root.render(
        createElement(ActionTooltip, {
          title: 'Fork chat',
          description: 'Duplicate this chat.',
          children: createElement(
            'button',
            {
              type: 'button',
              className: undefined,
              'aria-describedby': undefined,
            },
            'F',
          ),
        }),
      );
    });

    // Closed by default — tooltip is not in the DOM.
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();

    const button = container.querySelector('button');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('Trigger button not found');
    }

    // Hover the trigger: React synthesizes onMouseEnter from mouseover.
    act(() => {
      button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    const tooltip = document.body.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toContain('Fork chat');
    expect(tooltip?.textContent).toContain('Duplicate this chat.');
    expect(button.getAttribute('aria-describedby')).toBe(
      tooltip?.getAttribute('id'),
    );
  });

  it('suppresses the tooltip entirely when disabled is true', () => {
    act(() => {
      root.render(
        createElement(ActionTooltip, {
          title: 'Scheduling unavailable',
          description: 'Attachments are not supported yet.',
          disabled: true,
          children: createElement(
            'button',
            {
              type: 'button',
              className: undefined,
              'aria-describedby': undefined,
            },
            'S',
          ),
        }),
      );
    });

    const button = container.querySelector('button');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('Trigger button not found');
    }

    act(() => {
      button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('preserves caller classes when disabled', () => {
    act(() => {
      root.render(
        createElement(ActionTooltip, {
          title: 'Scheduling unavailable',
          description: 'Attachments are not supported yet.',
          disabled: true,
          children: createElement(
            'button',
            { type: 'button', className: 'base-class' },
            'S',
          ),
        }),
      );
    });

    const button = container.querySelector('button');
    expect(button?.className).toContain('base-class');
    expect(button?.className).not.toContain('cursor-help');
  });
});
