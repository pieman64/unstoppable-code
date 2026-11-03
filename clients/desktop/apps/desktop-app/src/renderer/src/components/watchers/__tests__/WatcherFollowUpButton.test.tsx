/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WatcherFollowUpButton } from '@/components/watchers/WatcherFollowUpButton';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('WatcherFollowUpButton', () => {
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
    document
      .querySelectorAll('[data-testid="watcher-followup-popover"]')
      .forEach((node) => node.remove());
  });

  function trigger(): HTMLButtonElement {
    const el = container.querySelector<HTMLButtonElement>(
      '[data-testid="watcher-followup-trigger"]',
    );
    if (!el) throw new Error('trigger not found');
    return el;
  }

  it('reflects whether an instruction is set via data-has-instruction', () => {
    act(() => {
      root.render(
        createElement(WatcherFollowUpButton, {
          value: '',
          onChange: jest.fn(),
        }),
      );
    });
    expect(trigger().getAttribute('data-has-instruction')).toBe('false');

    act(() => {
      root.render(
        createElement(WatcherFollowUpButton, {
          value: 'ping me',
          onChange: jest.fn(),
        }),
      );
    });
    expect(trigger().getAttribute('data-has-instruction')).toBe('true');
  });

  it('opens an anchored popover with a textarea and reports edits', () => {
    const onChange = jest.fn<void, [string]>();
    act(() => {
      root.render(
        createElement(WatcherFollowUpButton, { value: '', onChange }),
      );
    });

    // Closed by default.
    expect(
      document.body.querySelector('[data-testid="watcher-followup-popover"]'),
    ).toBeNull();

    act(() => {
      trigger().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const textarea = document.body.querySelector<HTMLTextAreaElement>(
      '[data-testid="watcher-followup-textarea"]',
    );
    expect(textarea).not.toBeNull();

    act(() => {
      if (!textarea) throw new Error('textarea missing');
      // React tracks the controlled value via a private setter, so set through
      // the native prototype setter before dispatching `input`.
      // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked via .call, not stored as a method reference
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      nativeSetter?.call(textarea, 'notify the chat');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith('notify the chat');
  });

  it('closes the popover on outside pointer down', () => {
    act(() => {
      root.render(
        createElement(WatcherFollowUpButton, {
          value: 'x',
          onChange: jest.fn(),
        }),
      );
    });
    act(() => {
      trigger().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      document.body.querySelector('[data-testid="watcher-followup-popover"]'),
    ).not.toBeNull();

    act(() => {
      document.body.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true }),
      );
    });
    expect(
      document.body.querySelector('[data-testid="watcher-followup-popover"]'),
    ).toBeNull();
  });
});
