/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  ModelUnlockPendingNotice,
  type ModelUnlockPendingNoticeProps,
} from '../ModelUnlockPendingNotice';
import {
  modelLibraryPendingBody,
  modelLibraryWaitingInBrowserBody,
} from '../modelLibraryLock';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('ModelUnlockPendingNotice', () => {
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

  function render(props: ModelUnlockPendingNoticeProps): void {
    act(() => root.render(<ModelUnlockPendingNotice {...props} />));
  }

  function byTestId(id: string): HTMLElement | null {
    return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  }

  it('narrates waiting as the shared checkout step, with the model and Check again (CAN-5160)', () => {
    render({ phase: 'waiting', modelLabel: 'Opus 4', onCheckNow: jest.fn() });

    const notice = byTestId('model-unlock-pending-notice');
    expect(notice?.dataset.phase).toBe('waiting');
    expect(notice?.dataset.noticeIntent).toBe('neutral');
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.getAttribute('aria-live')).toBe('polite');
    expect(notice?.textContent).toContain('Finish checkout in your browser');
    expect(notice?.textContent).toContain(
      "We'll switch to Opus 4 once the payment goes through.",
    );
    // The same clock as every other purchase in the browser, not a spinner.
    expect(byTestId('model-unlock-pending-spinner')).toBeNull();
    expect(notice?.querySelector('[data-glyph]')).not.toBeNull();
    expect(byTestId('model-unlock-pending-check-now')?.textContent).toBe(
      'Check again',
    );
    // Exactly one live region: the notice's own.
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(1);
  });

  it('falls back to advanced models when no model is named', () => {
    render({ phase: 'waiting', onCheckNow: jest.fn() });

    expect(byTestId('model-unlock-pending-notice')?.textContent).toContain(
      "We'll unlock advanced models once the payment goes through.",
    );
  });

  it('never offers Dismiss while waiting, even with a callback', () => {
    render({ phase: 'waiting', onCheckNow: jest.fn(), onDismiss: jest.fn() });

    expect(byTestId('model-unlock-pending-dismiss')).toBeNull();
    expect(byTestId('model-unlock-pending-notice')?.textContent).not.toContain(
      'Dismissing this notice',
    );
  });

  it('narrates timed-out with the warning glyph, Check again, and Dismiss', () => {
    const onCheckNow = jest.fn();
    const onDismiss = jest.fn();
    render({ phase: 'timed-out', modelLabel: 'Opus 4', onCheckNow, onDismiss });

    const notice = byTestId('model-unlock-pending-notice');
    expect(notice?.dataset.phase).toBe('timed-out');
    expect(notice?.dataset.noticeIntent).toBe('attention');
    expect(byTestId('model-unlock-pending-spinner')).toBeNull();
    expect(notice?.textContent).toContain(
      'Automatic payment checks have stopped',
    );
    expect(notice?.textContent).toContain(
      "Your purchase may still be in progress. Check again once it's complete.",
    );
    expect(notice?.textContent).toContain(
      "Dismissing this notice stops tracking this purchase. It won't cancel your purchase.",
    );
    const dismiss = byTestId('model-unlock-pending-dismiss');
    expect(dismiss?.getAttribute('aria-label')).toBe('Dismiss payment notice');

    act(() => byTestId('model-unlock-pending-check-now')?.click());
    act(() => dismiss?.click());
    expect(onCheckNow).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('omits Dismiss after a timeout when the host offers none', () => {
    render({ phase: 'timed-out', onCheckNow: jest.fn() });

    expect(byTestId('model-unlock-pending-dismiss')).toBeNull();
  });

  it('disables a busy Check again and announces it as busy', () => {
    const onCheckNow = jest.fn();
    render({ phase: 'waiting', checking: true, onCheckNow });

    const button = byTestId('model-unlock-pending-check-now');
    expect(button).toBeInstanceOf(HTMLButtonElement);
    expect(button?.hasAttribute('disabled')).toBe(true);
    expect(button?.getAttribute('aria-busy')).toBe('true');
    expect(button?.textContent).toBe('Checking…');
    act(() => button?.click());
    expect(onCheckNow).not.toHaveBeenCalled();
  });
});

describe('model unlock pending copy', () => {
  it('says Close does not cancel and names the originating chat', () => {
    expect(modelLibraryWaitingInBrowserBody('Opus 4')).toBe(
      "Finish checkout in your browser. Closing this dialog won't cancel your purchase. We'll switch to Opus 4 in the chat where you started the purchase once the payment goes through.",
    );
    expect(modelLibraryWaitingInBrowserBody()).toBe(
      "Finish checkout in your browser. Closing this dialog won't cancel your purchase. We'll unlock advanced models once the payment goes through.",
    );
  });

  it('names the model in the pending body only when known', () => {
    expect(modelLibraryPendingBody('Opus 4')).toBe(
      "We'll switch to Opus 4 once the payment goes through.",
    );
    expect(modelLibraryPendingBody()).toBe(
      "We'll unlock advanced models once the payment goes through.",
    );
  });
});
