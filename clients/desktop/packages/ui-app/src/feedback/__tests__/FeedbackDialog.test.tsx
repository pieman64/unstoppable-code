/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FeedbackDialog } from '../FeedbackDialog';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The desktop feedback modal's form, extracted so the web portal opens the same
// dialog from its account row (CAN-2829, Sergii: the feedback dialog is
// missing in the portal). Hosts own submission and any extra attachment block.
describe('FeedbackDialog', () => {
  let container: HTMLElement;
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

  function setValue(
    el: HTMLTextAreaElement | HTMLInputElement | null,
    value: string,
  ): void {
    const proto =
      el instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
    el?.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // CAN-2307: opened from a failure the user just hit, the form should already
  // agree it is a bug. The default stays `idea` (CAN-2682) for every other
  // entry point.
  it('defaults to Idea, and seeds Bug when the host opens it from a failure', () => {
    act(() => {
      root.render(
        <FeedbackDialog
          appName="Canopy"
          onSubmit={jest.fn()}
          onClose={jest.fn()}
        />,
      );
    });
    expect(
      document.body
        .querySelector('[data-testid="feedback-modal-type-idea"]')
        ?.getAttribute('aria-checked'),
    ).toBe('true');

    act(() => {
      root.render(
        // A distinct key so the seeded initial state is read on a fresh
        // mount rather than an update of the instance above.
        <FeedbackDialog
          key="seeded"
          appName="Canopy"
          initialReportType="bug"
          onSubmit={jest.fn()}
          onClose={jest.fn()}
        />,
      );
    });
    expect(
      document.body
        .querySelector('[data-testid="feedback-modal-type-bug"]')
        ?.getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('submits the trimmed description, type and optional title, then shows the success state', async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    const onClose = jest.fn();
    act(() => {
      root.render(
        <FeedbackDialog
          appName="Canopy"
          onSubmit={onSubmit}
          onClose={onClose}
        />,
      );
    });
    expect(
      document.body.querySelector('[data-testid="feedback-modal"]'),
    ).not.toBeNull();
    const submit = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="feedback-modal-submit"]',
    );
    expect(submit?.disabled).toBe(true);
    act(() => {
      document.body
        .querySelector<HTMLButtonElement>(
          '[data-testid="feedback-modal-type-bug"]',
        )
        ?.click();
    });
    act(() => {
      setValue(
        document.body.querySelector<HTMLTextAreaElement>(
          '[data-testid="feedback-modal-description"]',
        ),
        '  The sidebar badge looks off  ',
      );
      setValue(
        document.body.querySelector<HTMLInputElement>(
          '[data-testid="feedback-modal-title"]',
        ),
        'Badge',
      );
    });
    expect(submit?.disabled).toBe(false);
    await act(async () => {
      submit?.click();
      await Promise.resolve();
    });
    expect(onSubmit).toHaveBeenCalledWith({
      type: 'bug',
      description: 'The sidebar badge looks off',
      title: 'Badge',
    });
    expect(
      document.body.querySelector('[data-testid="feedback-modal-success"]')
        ?.textContent,
    ).toContain('Canopy team');
    act(() => {
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="feedback-modal-done"]')
        ?.click();
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the host error and keeps the form when submission rejects', async () => {
    const onSubmit = jest.fn().mockRejectedValue(new Error('Network down'));
    act(() => {
      root.render(
        <FeedbackDialog
          appName="Canopy"
          onSubmit={onSubmit}
          onClose={jest.fn()}
        />,
      );
    });
    act(() => {
      setValue(
        document.body.querySelector<HTMLTextAreaElement>(
          '[data-testid="feedback-modal-description"]',
        ),
        'Broken',
      );
    });
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>(
          '[data-testid="feedback-modal-submit"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(
      document.body.querySelector('[data-testid="feedback-modal-error"]')
        ?.textContent,
    ).toContain('Network down');
    expect(
      document.body.querySelector('[data-testid="feedback-modal-description"]'),
    ).not.toBeNull();
  });

  it('renders a host attachments block and an error-slot inside the form', () => {
    act(() => {
      root.render(
        <FeedbackDialog
          appName="Canopy"
          onSubmit={jest.fn()}
          onClose={jest.fn()}
          attachments={<div data-testid="host-attachments">diagnostics</div>}
          errorActions={
            <button type="button" data-testid="host-error-action">
              Save
            </button>
          }
        />,
      );
    });
    expect(
      document.body.querySelector('[data-testid="host-attachments"]'),
    ).not.toBeNull();
    // Error actions render only alongside an error.
    expect(
      document.body.querySelector('[data-testid="host-error-action"]'),
    ).toBeNull();
  });
});
