/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StopAllBackgroundWorkControl } from '../StopAllBackgroundWorkControl';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('StopAllBackgroundWorkControl', () => {
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

  const byTestId = (id: string): HTMLElement | null =>
    container.querySelector(`[data-testid="${id}"]`);

  function render(
    ids: readonly string[],
    onStopAll: () => Promise<boolean>,
  ): void {
    act(() =>
      root.render(
        <StopAllBackgroundWorkControl
          liveTaskIds={ids}
          onStopAll={onStopAll}
        />,
      ),
    );
  }

  it('reads Stopping… once accepted, until the covered work has left', async () => {
    const onStopAll = jest.fn(() => Promise.resolve(true));
    render(['a', 'b'], onStopAll);
    act(() => byTestId('background-tray-stop-all-work')?.click());
    await act(async () => {
      byTestId('background-tray-stop-all-work-confirm')?.click();
      await Promise.resolve();
    });

    expect(onStopAll).toHaveBeenCalledTimes(1);
    const stopping = byTestId('background-tray-stop-all-work');
    expect(stopping?.textContent).toBe('Stopping…');
    expect(stopping?.hasAttribute('disabled')).toBe(true);
    render(['a', 'c'], onStopAll);
    expect(byTestId('background-tray-stop-all-work')?.textContent).toBe(
      'Stop all background work',
    );
  });

  it('offers Stop all again after the host refuses', async () => {
    render(['a', 'b'], () => Promise.resolve(false));
    act(() => byTestId('background-tray-stop-all-work')?.click());
    await act(async () => {
      byTestId('background-tray-stop-all-work-confirm')?.click();
      await Promise.resolve();
    });

    expect(byTestId('background-tray-stop-all-work-confirmation')).toBeNull();
    expect(byTestId('background-tray-stop-all-work')?.textContent).toBe(
      'Stop all background work',
    );
  });
});
