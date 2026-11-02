/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  FailedPendingExecutionCard,
  FailedQueuedHookPipelineCard,
  PendingExecutionCard,
  QueuedHookPipelineCard,
} from '../pipeline/PipelineQueuedCards';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('PipelineQueuedCards', () => {
  it('renders queued cards and routes cancel callbacks', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onCancelQueued = jest.fn();
    const onCancelPending = jest.fn();
    const triggerSource = {
      kind: 'hook',
      hook_label: 'PR created',
      triggered_at: '2026-07-26T10:00:00.000Z',
    };

    act(() => {
      root.render(
        <>
          <QueuedHookPipelineCard
            entry={{
              queueId: 'queue-1',
              pipelineName: 'Hook pipeline',
              trigger_source: triggerSource,
            }}
            onCancel={onCancelQueued}
          />
          <PendingExecutionCard
            entry={{
              localId: 'pending-1',
              pipelineName: 'Setup pipeline',
              taskText: 'Prepare the worktree',
            }}
            onCancel={onCancelPending}
          />
        </>,
      );
    });

    expect(container.textContent).toContain(
      'Queued — waiting for active workflow runs to finish',
    );
    expect(container.textContent).toContain('Queued — waiting for setup');
    // The task prompt sits in a tooltip, which session replay blocks.
    expect(
      container
        .querySelector('[title="Prepare the worktree"]')
        ?.closest('.ph-no-capture'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label^="Triggered by hook: PR created"]'),
    ).not.toBeNull();

    const cancelButtons = container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Cancel queued workflow"]',
    );
    act(() => {
      cancelButtons[0]?.click();
      cancelButtons[1]?.click();
    });
    expect(onCancelQueued).toHaveBeenCalledWith('queue-1');
    expect(onCancelPending).toHaveBeenCalledWith('pending-1');

    act(() => root.unmount());
    container.remove();
  });

  it('renders failed cards and routes dismiss callbacks', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onDismissQueued = jest.fn();
    const onDismissPending = jest.fn();

    act(() => {
      root.render(
        <>
          <FailedQueuedHookPipelineCard
            entry={{
              queueId: 'queue-2',
              pipelineName: 'Failed hook pipeline',
              error: 'Queue unavailable',
            }}
            onDismiss={onDismissQueued}
          />
          <FailedPendingExecutionCard
            entry={{
              localId: 'pending-2',
              pipelineName: 'Failed setup pipeline',
              error: 'Setup unavailable',
            }}
            onDismiss={onDismissPending}
          />
        </>,
      );
    });

    expect(container.textContent).toContain('Queue failed: Queue unavailable');
    expect(container.textContent).toContain('Queue failed: Setup unavailable');

    const dismissButtons = container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Dismiss failed queued workflow"]',
    );
    act(() => {
      dismissButtons[0]?.click();
      dismissButtons[1]?.click();
    });
    expect(onDismissQueued).toHaveBeenCalledWith('queue-2');
    expect(onDismissPending).toHaveBeenCalledWith('pending-2');

    act(() => root.unmount());
    container.remove();
  });
});
