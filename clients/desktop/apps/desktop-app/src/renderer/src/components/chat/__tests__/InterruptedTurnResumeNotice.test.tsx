/**
 * @jest-environment jsdom
 *
 * CAN-5177 — the in-chat Resume offer for a turn the app closed on.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatAppNameProvider } from '@canopy/ui-shared/components';
import {
  InterruptedTurnResumeNotice,
  type InterruptedTurnResumeNoticeProps,
} from '../InterruptedTurnResumeNotice';

describe('InterruptedTurnResumeNotice', () => {
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
    overrides: Partial<InterruptedTurnResumeNoticeProps> = {},
  ): HTMLElement {
    act(() => {
      root.render(
        <ChatAppNameProvider value="Canopy">
          <InterruptedTurnResumeNotice
            busy={false}
            onResume={() => undefined}
            onDismiss={() => undefined}
            {...overrides}
          />
        </ChatAppNameProvider>,
      );
    });
    const notice = container.querySelector<HTMLElement>(
      '[data-testid="interrupted-turn-resume"]',
    );
    if (!notice) throw new Error('Missing notice');
    return notice;
  }

  it('names the app and says Resume sends "Continue" after agent progress', () => {
    const notice = render({ promptKind: 'continue' });
    expect(notice.textContent).toContain(
      'Canopy closed before this chat finished',
    );
    expect(notice.textContent).toContain(
      'Resuming sends "Continue" in this chat, so the agent picks up where it stopped without sending your original request again.',
    );
  });

  it('says Resume re-sends the unanswered message', () => {
    const notice = render({ promptKind: 'resend_user_message' });
    expect(notice.textContent).toContain(
      'Resuming re-sends your last message in this chat.',
    );
  });

  it('offers Dismiss and Resume chat, and shows Resuming… while busy', () => {
    const onResume = jest.fn();
    const onDismiss = jest.fn();
    render({ promptKind: 'continue', onResume, onDismiss });
    const resume = container.querySelector<HTMLButtonElement>(
      '[data-testid="interrupted-turn-resume-button"]',
    );
    const dismiss = container.querySelector<HTMLButtonElement>(
      '[data-testid="interrupted-turn-resume-dismiss"]',
    );
    expect(resume?.textContent).toBe('Resume chat');
    expect(dismiss?.textContent).toBe('Dismiss');
    act(() => resume?.click());
    act(() => dismiss?.click());
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    render({ promptKind: 'continue', busy: true });
    expect(
      container.querySelector('[data-testid="interrupted-turn-resume-button"]')
        ?.textContent,
    ).toContain('Resuming…');
  });
});
