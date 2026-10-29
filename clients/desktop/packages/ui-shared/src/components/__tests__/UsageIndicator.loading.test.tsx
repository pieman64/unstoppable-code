/** @jest-environment jsdom */
import { act, type ComponentProps, type JSX } from 'react';
import type * as React from 'react';
import { createRoot } from 'react-dom/client';
import { UsageIndicator } from '../UsageIndicator';
import type UsagePopover from '../UsageIndicatorPopover';

let mockResolvePopover: () => void = () => {};
const mockPopoverPending = new Promise<void>((resolve) => {
  mockResolvePopover = resolve;
});

jest.mock('../UsageIndicatorPopover', () => {
  const actual = jest.requireActual<{ default: typeof UsagePopover }>(
    '../UsageIndicatorPopover',
  );
  const react = jest.requireActual<typeof React>('react');
  return {
    __esModule: true,
    default: function DeferredUsagePopover(
      props: ComponentProps<typeof UsagePopover>,
    ): JSX.Element {
      react.use(mockPopoverPending);
      return <actual.default {...props} />;
    },
  };
});

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

it('dismisses pending usage details without reopening when they finish loading', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onOpenChange = jest.fn();
  const accountMounted = jest.fn();
  function Account(): JSX.Element {
    accountMounted();
    return <span>Account limits</span>;
  }
  const popover = (): Element | null =>
    document.body.querySelector('[data-testid="usage-indicator-popover"]');
  try {
    await act(async () => {
      root.render(
        <UsageIndicator
          usage={undefined}
          isCodex={false}
          accountUsage={<Account />}
          onOpenChange={onOpenChange}
        />,
      );

      await Promise.resolve();
    });
    const trigger = container.querySelector('button');
    if (!trigger) throw new Error('Missing usage trigger');
    expect(accountMounted).not.toHaveBeenCalled();
    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(popover()).toBeNull();
    expect(accountMounted).not.toHaveBeenCalled();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);

    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });
    act(() => {
      document.body.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true }),
      );
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      mockResolvePopover();
      await mockPopoverPending;
    });
    expect(popover()).toBeNull();
    expect(accountMounted).not.toHaveBeenCalled();
    expect(container.querySelector('button')).toBe(trigger);
    expect(document.activeElement).toBe(trigger);
    expect(onOpenChange.mock.calls).toEqual([
      [false],
      [true],
      [false],
      [true],
      [false],
    ]);

    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });
    expect(popover()?.textContent).toContain(
      'Usage appears after the first reply.',
    );
    expect(popover()?.textContent).toContain('Account limits');
    expect(accountMounted).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
