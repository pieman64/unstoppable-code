/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TaskStopButton } from '../TaskStopButton';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('TaskStopButton', () => {
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

  function button(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      '[data-testid="agent-task-stop"]',
    );
  }

  it('reads Stop with its accessible label and fires onStop', () => {
    const onStop = jest.fn();
    act(() => {
      root.render(
        <TaskStopButton
          stopping={false}
          onStop={onStop}
          accessibleLabel="Stop agent"
          dataTestId="agent-task-stop"
        />,
      );
    });
    expect(button()?.textContent).toBe('Stop');
    expect(button()?.getAttribute('aria-label')).toBe('Stop agent');
    expect(button()?.disabled).toBe(false);
    act(() => button()?.click());
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('reads Stopping… and is disabled while stopping', () => {
    const onStop = jest.fn();
    act(() => {
      root.render(
        <TaskStopButton
          stopping
          onStop={onStop}
          accessibleLabel="Stop agent"
          title="Ends this agent"
          dataTestId="agent-task-stop"
        />,
      );
    });
    expect(button()?.textContent).toBe('Stopping…');
    expect(button()?.getAttribute('aria-label')).toBe('Stopping…');
    expect(button()?.disabled).toBe(true);
    act(() => button()?.click());
    expect(onStop).not.toHaveBeenCalled();
  });

  it('does not propagate the click to an enclosing row', () => {
    const onRow = jest.fn();
    act(() => {
      root.render(
        <div onClick={onRow}>
          <TaskStopButton
            stopping={false}
            onStop={jest.fn()}
            accessibleLabel="Stop agent"
            dataTestId="agent-task-stop"
          />
        </div>,
      );
    });
    act(() => button()?.click());
    expect(onRow).not.toHaveBeenCalled();
  });
});
