/**
 * @jest-environment jsdom
 *
 * CAN-1521. Two properties this dialog has to keep:
 *
 * 1. **Submit never posts an empty detail.** "Send feedback" with no reason and
 *    no comment produces an `onSubmit({})` the IPC handler short-circuits into a
 *    no-op, so the button reads as working while doing nothing. "Skip" is the
 *    affordance for sending nothing.
 * 2. **The reason chips are a toggle group, not a radio group.** They deselect
 *    on re-click, which ARIA radios cannot do, so they expose `aria-pressed`
 *    and each chip stays independently tabbable.
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TurnFeedbackDialog } from '../TurnFeedbackDialog';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function render(node: JSX.Element): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

function byTestId<T extends HTMLElement>(testId: string): T {
  const found = document.body.querySelector<T>(`[data-testid="${testId}"]`);
  if (!found) {
    throw new Error(`missing [data-testid="${testId}"]`);
  }
  return found;
}

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function input(element: HTMLTextAreaElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function noop(): void {
  return undefined;
}

describe('TurnFeedbackDialog', () => {
  it('returns keyboard focus to the footer trigger when dismissed', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const { root } = render(
      <TurnFeedbackDialog onClose={noop} onSubmit={noop} />,
    );
    expect(document.activeElement).toBe(byTestId('turn-feedback-comment'));
    act(() => root.unmount());
    expect(document.activeElement).toBe(trigger);
  });
  afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
  });

  it('disables submit until there is a reason or a comment', () => {
    render(<TurnFeedbackDialog onClose={noop} onSubmit={noop} />);

    const submit = byTestId<HTMLButtonElement>('turn-feedback-submit');
    expect(submit.disabled).toBe(true);

    click(byTestId('turn-feedback-reason-got-stuck'));
    expect(submit.disabled).toBe(false);
  });

  it('enables submit on a comment alone, with no reason selected', () => {
    render(<TurnFeedbackDialog onClose={noop} onSubmit={noop} />);

    const comment = byTestId<HTMLTextAreaElement>('turn-feedback-comment');
    input(comment, 'it looped over the same file');

    expect(byTestId<HTMLButtonElement>('turn-feedback-submit').disabled).toBe(
      false,
    );
  });

  it('treats whitespace as empty, so spaces alone cannot submit', () => {
    render(<TurnFeedbackDialog onClose={noop} onSubmit={noop} />);

    const comment = byTestId<HTMLTextAreaElement>('turn-feedback-comment');
    input(comment, '   ');

    expect(byTestId<HTMLButtonElement>('turn-feedback-submit').disabled).toBe(
      true,
    );
  });

  it('exposes the reasons as a toggle group that deselects on re-click', () => {
    render(<TurnFeedbackDialog onClose={noop} onSubmit={noop} />);

    // A group, not a radiogroup: ARIA radios cannot be deselected.
    expect(byTestId('turn-feedback-reasons').getAttribute('role')).toBe(
      'group',
    );

    const chip = byTestId<HTMLButtonElement>('turn-feedback-reason-got-stuck');
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    expect(chip.getAttribute('role')).not.toBe('radio');

    click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('true');

    click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    expect(byTestId<HTMLButtonElement>('turn-feedback-submit').disabled).toBe(
      true,
    );
  });

  it('submits the trimmed comment and the selected reason', () => {
    const onSubmit = jest.fn();
    render(<TurnFeedbackDialog onClose={noop} onSubmit={onSubmit} />);

    click(byTestId('turn-feedback-reason-got-stuck'));
    const comment = byTestId<HTMLTextAreaElement>('turn-feedback-comment');
    input(comment, '  it looped  ');

    click(byTestId('turn-feedback-submit'));

    expect(onSubmit).toHaveBeenCalledWith({
      reason: 'got-stuck',
      comment: 'it looped',
    });
  });
});
