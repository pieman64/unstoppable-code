/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  TurnResumeNotice,
  type TurnResumeNoticeProps,
} from '../TurnResumeNotice';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('TurnResumeNotice', () => {
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

  function render(overrides: Partial<TurnResumeNoticeProps> = {}): void {
    const props: TurnResumeNoticeProps = {
      title: 'Canopy closed before this chat finished',
      message: 'The agent picks up where it stopped.',
      resumeLabel: 'Resume chat',
      onResume: () => undefined,
      'data-testid': 'interrupted-turn-resume',
      ...overrides,
    };
    act(() => root.render(<TurnResumeNotice {...props} />));
  }

  function button(suffix: 'button' | 'dismiss'): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      `[data-testid="interrupted-turn-resume-${suffix}"]`,
    );
  }

  it('renders the copy with Resume as the last, named action', () => {
    const onResume = jest.fn();
    const onDismiss = jest.fn();
    render({ onResume, onDismiss });
    const notice = container.querySelector(
      '[data-testid="interrupted-turn-resume"]',
    );
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.getAttribute('aria-live')).toBe('polite');
    expect(notice?.textContent).toContain(
      'Canopy closed before this chat finished',
    );
    expect(notice?.textContent).toContain(
      'The agent picks up where it stopped.',
    );
    const buttons = Array.from(notice?.querySelectorAll('button') ?? []);
    expect(buttons.map((entry) => entry.textContent)).toEqual([
      'Dismiss',
      'Resume chat',
    ]);
    act(() => button('button')?.click());
    act(() => button('dismiss')?.click());
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('omits Dismiss when the host offers none', () => {
    render();
    expect(button('dismiss')).toBeNull();
    expect(button('button')?.textContent).toBe('Resume chat');
  });

  it('stops both actions and announces busy while a resume is in flight', () => {
    const onResume = jest.fn();
    const onDismiss = jest.fn();
    render({ onResume, onDismiss, busy: true, busyLabel: 'Resuming…' });
    expect(
      container
        .querySelector('[data-testid="interrupted-turn-resume"]')
        ?.getAttribute('aria-busy'),
    ).toBe('true');
    expect(button('button')?.textContent).toContain('Resuming…');
    expect(button('dismiss')?.disabled).toBe(true);
    act(() => button('button')?.click());
    act(() => button('dismiss')?.click());
    expect(onResume).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('shows the failure and keeps Resume available to retry', () => {
    const onResume = jest.fn();
    render({ onResume, error: 'Could not resume this chat. Try again.' });
    expect(container.textContent).toContain(
      'Could not resume this chat. Try again.',
    );
    expect(button('button')?.disabled).toBe(false);
    act(() => button('button')?.click());
    expect(onResume).toHaveBeenCalledTimes(1);
  });
});
