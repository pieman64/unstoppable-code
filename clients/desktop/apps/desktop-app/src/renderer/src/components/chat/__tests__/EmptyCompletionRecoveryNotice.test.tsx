/**
 * @jest-environment jsdom
 *
 * CAN-2307 — the recovery state a completed-but-empty turn shows instead of a
 * bare "Completed in M:SS" row.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EmptyCompletionRecoveryNotice } from '../EmptyCompletionRecoveryNotice';
import type { EmptyCompletionRecoveryView } from '@/stores/chat/empty-completion';

jest.mock('../../feedback/FeedbackModal', () => ({
  FeedbackModal: ({
    initialReportType,
  }: {
    initialReportType?: string;
  }): JSX.Element => (
    <div
      data-testid="mock-feedback-modal"
      data-report-type={initialReportType}
    />
  ),
}));

const BASE: EmptyCompletionRecoveryView = {
  turnUserMessageId: 'u1',
  repeatsToolActivity: false,
  canRetryPrompt: true,
};

describe('EmptyCompletionRecoveryNotice', () => {
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
  });

  function render(
    props: Partial<
      React.ComponentProps<typeof EmptyCompletionRecoveryNotice>
    > = {},
  ): { onResume: jest.Mock; onRetry: jest.Mock } {
    const onResume = jest.fn();
    const onRetry = jest.fn();
    act(() => {
      root.render(
        <EmptyCompletionRecoveryNotice
          recovery={BASE}
          onResume={onResume}
          onRetry={onRetry}
          {...props}
        />,
      );
    });
    return { onResume, onRetry };
  }

  function click(testId: string): void {
    const button = container.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`,
    );
    if (!button) throw new Error(`Missing ${testId}`);
    act(() => button.click());
  }

  it('offers all three recovery actions on an empty turn', () => {
    render();
    expect(
      container.querySelector('[data-testid="empty-completion-recovery"]'),
    ).not.toBeNull();
    for (const testId of [
      'empty-completion-recovery-resume',
      'empty-completion-recovery-retry',
      'empty-completion-recovery-report',
    ]) {
      expect(
        container.querySelector(`[data-testid="${testId}"]`),
      ).not.toBeNull();
    }
  });

  it('dispatches resume and retry only when clicked — nothing fires on its own', () => {
    const { onResume, onRetry } = render();
    expect(onResume).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();

    click('empty-completion-recovery-resume');
    expect(onResume).toHaveBeenCalledTimes(1);

    click('empty-completion-recovery-retry');
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('blocks retry when the empty turn already ran tools', () => {
    const { onRetry } = render({
      recovery: { ...BASE, repeatsToolActivity: true },
    });
    expect(container.textContent).toContain('may repeat what it already did');
    const retry = container.querySelector<HTMLButtonElement>(
      '[data-testid="empty-completion-recovery-retry"]',
    );
    expect(retry?.disabled).toBe(true);
    if (!retry) throw new Error('Missing empty-completion retry action');
    act(() => retry.click());
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('does not warn about repeated work when the turn did nothing', () => {
    render();
    expect(container.textContent).not.toContain('may repeat');
    expect(container.textContent).toContain('finished without a response');
  });

  it('hides Try again when the original prompt cannot be recovered', () => {
    render({ recovery: { ...BASE, canRetryPrompt: false } });
    expect(
      container.querySelector(
        '[data-testid="empty-completion-recovery-retry"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="empty-completion-recovery-resume"]',
      ),
    ).not.toBeNull();
  });

  it('disables the send actions while one is in flight', () => {
    render({ busy: true });
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="empty-completion-recovery-resume"]',
      )?.disabled,
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="empty-completion-recovery-retry"]',
      )?.disabled,
    ).toBe(true);
    // Reporting the bug is still possible when a recovery attempt is stuck.
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="empty-completion-recovery-report"]',
      )?.disabled,
    ).toBe(false);
  });

  it('surfaces a failed recovery attempt without hiding the actions', () => {
    render({ error: 'Could not resume this chat.' });
    expect(container.textContent).toContain('Could not resume this chat.');
    expect(
      container.querySelector(
        '[data-testid="empty-completion-recovery-resume"]',
      ),
    ).not.toBeNull();
  });

  it('opens the feedback form pre-set to Bug', () => {
    render();
    expect(
      container.querySelector('[data-testid="mock-feedback-modal"]'),
    ).toBeNull();
    click('empty-completion-recovery-report');
    expect(
      container
        .querySelector('[data-testid="mock-feedback-modal"]')
        ?.getAttribute('data-report-type'),
    ).toBe('bug');
  });
});
