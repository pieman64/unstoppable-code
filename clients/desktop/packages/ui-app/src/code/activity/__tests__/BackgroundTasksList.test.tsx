/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BackgroundTask } from '@canopy/protocol/background-tasks';
import { BackgroundTasksList } from '../BackgroundTasksList';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const RUNNING_TASK: BackgroundTask = {
  id: 'bash-1',
  kind: 'bash',
  status: 'running',
  title: 'npm run dev',
  ownerToolUseId: 'bash-1',
  parentTaskId: null,
  startedAt: 1,
  settledAt: null,
  updatedAt: 2,
  lastDescription: null,
  summary: null,
  outputLines: [],
  canStop: true,
};

describe('BackgroundTasksList', () => {
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

  it('is memoized for stable transcript props', () => {
    expect(BackgroundTasksList).toHaveProperty(
      '$$typeof',
      Symbol.for('react.memo'),
    );
  });

  it('disables Stop until the host stop settles', async () => {
    let resolveStop: () => void = () => undefined;
    const stop = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStop = resolve;
        }),
    );
    act(() =>
      root.render(
        <BackgroundTasksList tasks={[RUNNING_TASK]} actions={{ stop }} />,
      ),
    );
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-bg-stop"]',
    );
    if (!button) throw new Error('Expected a stop button');
    act(() => button.click());
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(RUNNING_TASK);
    expect(button.textContent).toBe('Stopping…');
    expect(button.disabled).toBe(true);
    await act(async () => {
      resolveStop();
      await Promise.resolve();
    });
    expect(button.textContent).toBe('Stop');
    expect(button.disabled).toBe(false);
  });

  it('reports selection and closes the modal when the selected task disappears', () => {
    const onSelectedTaskChange = jest.fn();
    const actions = { onSelectedTaskChange };
    act(() =>
      root.render(
        <BackgroundTasksList tasks={[RUNNING_TASK]} actions={actions} />,
      ),
    );
    act(() =>
      container
        .querySelector<HTMLElement>('[data-testid="activity-bg-item"]')
        ?.click(),
    );
    expect(onSelectedTaskChange).toHaveBeenCalledWith(RUNNING_TASK);
    expect(
      document.querySelector('[data-testid="bg-process-detail-modal"]'),
    ).not.toBeNull();
    act(() =>
      root.render(<BackgroundTasksList tasks={[]} actions={actions} />),
    );
    expect(onSelectedTaskChange).toHaveBeenLastCalledWith(null);
    expect(
      document.querySelector('[data-testid="bg-process-detail-modal"]'),
    ).toBeNull();
  });
});
