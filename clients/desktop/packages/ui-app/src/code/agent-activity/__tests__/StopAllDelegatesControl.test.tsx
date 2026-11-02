/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StopAllDelegatesControl } from '../StopAllDelegatesControl';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('StopAllDelegatesControl', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function stopAllClasses(): string[] {
    act(() =>
      root.render(
        <StopAllDelegatesControl
          liveDelegationIds={['delegation-1']}
          onStopAll={(): Promise<boolean> => Promise.resolve(true)}
        />,
      ),
    );
    return (
      container
        .querySelector('[data-testid="agent-activity-stop-all"]')
        ?.className.split(/\s+/) ?? []
    );
  }

  it('keeps the classic small destructive action while the view is off', () => {
    const classes = stopAllClasses();
    expect(classes).toEqual(
      expect.arrayContaining(['fg-destructive', 'text-2xs']),
    );
    expect(classes).not.toContain('h-7');
  });

  it('requires confirmation and prevents repeated stops in the section action', async () => {
    const stop = jest.fn((): Promise<boolean> => Promise.resolve(true));
    act(() =>
      root.render(
        <StopAllDelegatesControl
          appearance="section"
          liveDelegationIds={['one', 'two']}
          onStopAll={stop}
        />,
      ),
    );
    const button = (suffix = ''): HTMLButtonElement | null =>
      document.querySelector(
        `[data-testid="agent-activity-stop-all${suffix}"]`,
      );
    expect(button()?.className).toContain('text-xs');
    expect(button()?.className).toContain('fg-tertiary');
    act(() => button()?.click());
    expect(stop).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(button()?.textContent).toBe('Stop all delegates');
    act(() => button('-cancel')?.click());
    expect(stop).not.toHaveBeenCalled();
    act(() => button()?.click());
    await act(async () => {
      button('-confirm')?.click();
      await Promise.resolve();
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(button()?.disabled).toBe(true);
    act(() => button()?.click());
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
