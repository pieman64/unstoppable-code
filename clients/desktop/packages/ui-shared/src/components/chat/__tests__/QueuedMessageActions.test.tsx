/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  QUEUED_MESSAGE_CAPABILITY_CHANGE_TOOLTIP,
  QUEUED_MESSAGE_RETRY_BLOCKED_TOOLTIPS,
  QueuedMessageActions,
  type QueuedMessageActionsProps,
} from '../QueuedMessageActions';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const noop = (): void => undefined;

function markup(props: QueuedMessageActionsProps): string {
  return renderToStaticMarkup(<QueuedMessageActions {...props} />);
}

function testIds(html: string): string[] {
  return html
    .split('data-testid="')
    .slice(1)
    .map((part) => part.slice(0, part.indexOf('"')))
    .filter((id) => id.startsWith('queued-message-'));
}

describe('QueuedMessageActions footer', () => {
  it('renders Steer before Interrupt with their icons and labels', () => {
    const html = markup({
      placement: 'footer',
      onSteer: noop,
      onInterrupt: noop,
    });

    expect(testIds(html)).toEqual([
      'queued-message-steer',
      'queued-message-steer-icon',
      'queued-message-interrupt',
      'queued-message-interrupt-icon',
    ]);
    expect(html).toContain('Steer</button>');
    expect(html).toContain('Interrupt</button>');
    expect(html).toContain('class="mt-1 flex justify-end gap-2"');
  });

  it('warns before Steer and Interrupt while new settings wait for background work', () => {
    const held = (props: Partial<QueuedMessageActionsProps>): string =>
      markup({ placement: 'footer', settingsHeld: [], ...props });

    expect(
      testIds(
        held({ onSteer: noop, onInterrupt: noop, turnPhase: 'foreground' }),
      )[0],
    ).toBe('queued-message-settings-held-warning');
    expect(held({ onSteer: noop, onInterrupt: noop })).toContain(
      'Steer adds this message to the current reply without them. Interrupt stops the reply',
    );
    expect(held({ onInterrupt: noop, settingsHeld: ['model'] })).toContain(
      'Changed: model.',
    );
    // A disabled Steer does nothing now, so only Interrupt is explained.
    const capability = held({
      onInterrupt: noop,
      steeringSupported: true,
      steerBlockedByCapabilityChange: true,
    });
    expect(capability).toContain('Interrupt stops the current reply');
    expect(capability).not.toContain('Steer adds');
    // Without Steer or Interrupt (a held row's Run now), nothing to warn about.
    expect(testIds(held({ onRunNow: noop }))).not.toContain(
      'queued-message-settings-held-warning',
    );
    expect(
      testIds(
        markup({ placement: 'footer', onSteer: noop, onInterrupt: noop }),
      ),
    ).not.toContain('queued-message-settings-held-warning');
  });

  it('wraps the footer row in the badge variant', () => {
    expect(
      markup({ placement: 'footer', variant: 'badge', onInterrupt: noop }),
    ).toContain('class="mt-1 flex flex-wrap justify-end gap-2"');
  });

  it('renders nothing when no footer action is offered', () => {
    expect(markup({ placement: 'footer' })).toBe('');
    expect(markup({ placement: 'footer', onEdit: noop, onCancel: noop })).toBe(
      '',
    );
  });

  it('shows a disabled Steer with its explanation when capabilities change', () => {
    const html = markup({
      placement: 'footer',
      steeringSupported: true,
      steerBlockedByCapabilityChange: true,
      onInterrupt: noop,
    });

    expect(html).toMatch(/disabled=""[^>]*data-testid="queued-message-steer"/);
    expect(html).toContain(
      `aria-description="${QUEUED_MESSAGE_CAPABILITY_CHANGE_TOOLTIP}"`,
    );
    expect(html).toContain('data-testid="queued-message-interrupt"');
  });

  it('does not offer the disabled Steer without steering support', () => {
    const html = markup({
      placement: 'footer',
      steerBlockedByCapabilityChange: true,
      onInterrupt: noop,
    });

    expect(testIds(html)).toEqual([
      'queued-message-interrupt',
      'queued-message-interrupt-icon',
    ]);
  });

  it('hides Steer and Interrupt for an edit-locked message', () => {
    expect(
      markup({
        placement: 'footer',
        onSteer: noop,
        onInterrupt: noop,
        editLocked: true,
      }),
    ).toBe('');
  });

  it('keeps Interrupt when the force lock is lifted for an edit-locked message', () => {
    const html = markup({
      placement: 'footer',
      onSteer: noop,
      onInterrupt: noop,
      editLocked: true,
      forceLocked: false,
    });

    expect(testIds(html)).toEqual([
      'queued-message-interrupt',
      'queued-message-interrupt-icon',
    ]);
  });

  it('hides Interrupt while the message is being sent', () => {
    const html = markup({
      placement: 'footer',
      onSteer: noop,
      onInterrupt: noop,
      pending: true,
    });

    expect(testIds(html)).toEqual([
      'queued-message-steer',
      'queued-message-steer-icon',
    ]);
  });

  it('hides Steer and Interrupt while another message is being edited', () => {
    const html = markup({
      placement: 'footer',
      onSteer: noop,
      onInterrupt: noop,
      anyEditing: true,
    });

    expect(testIds(html)).toEqual([]);
  });

  it('disables Interrupt when asked', () => {
    expect(
      markup({
        placement: 'footer',
        onInterrupt: noop,
        interruptDisabled: true,
      }),
    ).toMatch(/data-testid="queued-message-interrupt"[^>]*disabled=""/);
  });
});

describe('QueuedMessageActions turn phase', () => {
  const STEER_AND_INTERRUPT = [
    'queued-message-steer',
    'queued-message-steer-icon',
    'queued-message-interrupt',
    'queued-message-interrupt-icon',
  ];

  it.each([undefined, 'foreground'] as const)(
    'offers Steer and Interrupt when the phase is %s',
    (turnPhase) => {
      expect(
        testIds(
          markup({
            placement: 'footer',
            turnPhase,
            onSteer: noop,
            onInterrupt: noop,
          }),
        ),
      ).toEqual(STEER_AND_INTERRUPT);
    },
  );

  it.each(['idle', 'background'] as const)(
    'renders no Steer or Interrupt row when the chat is %s',
    (turnPhase) => {
      expect(
        markup({
          placement: 'footer',
          turnPhase,
          onSteer: noop,
          onInterrupt: noop,
        }),
      ).toBe('');
    },
  );

  it.each(['idle', 'background'] as const)(
    'hides the disabled capability-change Steer when the chat is %s',
    (turnPhase) => {
      expect(
        markup({
          placement: 'footer',
          turnPhase,
          steeringSupported: true,
          steerBlockedByCapabilityChange: true,
        }),
      ).toBe('');
    },
  );

  it('keeps the disabled capability-change Steer in a foreground turn', () => {
    expect(
      markup({
        placement: 'footer',
        turnPhase: 'foreground',
        steeringSupported: true,
        steerBlockedByCapabilityChange: true,
      }),
    ).toMatch(/disabled=""[^>]*data-testid="queued-message-steer"/);
  });

  it('withholds Steer when the host marks the row ineligible', () => {
    expect(
      testIds(
        markup({
          placement: 'footer',
          turnPhase: 'foreground',
          onSteer: noop,
          canSteer: false,
          onInterrupt: noop,
        }),
      ),
    ).toEqual(['queued-message-interrupt', 'queued-message-interrupt-icon']);
  });

  it.each([undefined, 'idle', 'background', 'foreground'] as const)(
    'renders Retry and Run now in any phase (%s)',
    (turnPhase) => {
      const html = markup({
        placement: 'footer',
        turnPhase,
        onRetry: noop,
        onRunNow: noop,
      });

      expect(testIds(html)).toEqual([
        'queued-message-retry',
        'queued-message-retry-icon',
        'queued-message-run-now',
        'queued-message-run-now-icon',
      ]);
      expect(html).toContain('Retry</button>');
      expect(html).toContain('Run now</button>');
    },
  );

  it('orders Steer, Interrupt, Retry and Run now', () => {
    expect(
      testIds(
        markup({
          placement: 'footer',
          turnPhase: 'foreground',
          onSteer: noop,
          onInterrupt: noop,
          onRetry: noop,
          onRunNow: noop,
        }),
      ).filter((id) => !id.endsWith('-icon')),
    ).toEqual([
      'queued-message-steer',
      'queued-message-interrupt',
      'queued-message-retry',
      'queued-message-run-now',
    ]);
  });

  it('applies the head-row locks to Retry and Run now', () => {
    for (const locks of [
      { pending: true },
      { anyEditing: true },
      { editLocked: true },
      { forceLocked: true },
    ]) {
      expect(
        markup({
          placement: 'footer',
          onRetry: noop,
          onRunNow: noop,
          ...locks,
        }),
      ).toBe('');
    }
  });

  it('keeps the editing spacer only where the phase still offers Steer', () => {
    expect(
      markup({
        placement: 'footer',
        turnPhase: 'foreground',
        onSteer: noop,
        anyEditing: true,
      }),
    ).toBe('<div class="mt-1 flex justify-end gap-2"></div>');
    expect(
      markup({
        placement: 'footer',
        turnPhase: 'background',
        onSteer: noop,
        anyEditing: true,
      }),
    ).toBe('');
  });
});

describe('QueuedMessageActions corner', () => {
  it('renders a text Edit and a Clear button in the popover variant', () => {
    const html = markup({ placement: 'corner', onEdit: noop, onCancel: noop });

    expect(testIds(html)).toEqual([
      'queued-message-edit',
      'queued-message-cancel',
    ]);
    expect(html).toContain('Edit</button>');
    expect(html).toContain('aria-label="Clear queued message"');
    expect(html).not.toContain('disabled=""');
  });

  it('renders host controls first and icon badges in the badge variant', () => {
    const html = markup({
      placement: 'corner',
      variant: 'badge',
      cornerLeading: <span data-testid="queued-message-copy-stub" />,
      onEdit: noop,
      onCancel: noop,
      editLabel: 'Edit scheduled message',
      cancelLabel: 'Clear scheduled message',
    });

    expect(testIds(html)).toEqual([
      'queued-message-copy-stub',
      'queued-message-edit',
      'queued-message-cancel',
    ]);
    expect(html).toContain('aria-label="Edit scheduled message"');
    expect(html).toContain('aria-label="Clear scheduled message"');
    expect(html).not.toContain('Edit</button>');
  });

  it('hides Edit and disables Clear while the message is being sent', () => {
    const html = markup({
      placement: 'corner',
      onEdit: noop,
      onCancel: noop,
      pending: true,
    });

    expect(testIds(html)).toEqual(['queued-message-cancel']);
    expect(html).toMatch(/data-testid="queued-message-cancel"[^>]*disabled=""/);
  });

  it('hides Edit when locked or while another message is being edited', () => {
    expect(
      testIds(
        markup({
          placement: 'corner',
          onEdit: noop,
          onCancel: noop,
          editLocked: true,
        }),
      ),
    ).toEqual(['queued-message-cancel']);
    expect(
      testIds(
        markup({
          placement: 'corner',
          onEdit: noop,
          onCancel: noop,
          anyEditing: true,
        }),
      ),
    ).toEqual(['queued-message-cancel']);
  });

  it('renders nothing without corner actions', () => {
    expect(markup({ placement: 'corner', onSteer: noop })).toBe('');
  });
});

describe('QueuedMessageActions callbacks', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function click(testId: string): void {
    const button = container.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`,
    );
    if (!button) throw new Error(`Missing ${testId}`);
    act(() => {
      button.click();
    });
  }

  it('routes each control to its callback', () => {
    const onSteer = jest.fn();
    const onInterrupt = jest.fn();
    const onRetry = jest.fn();
    const onRunNow = jest.fn();
    const onEdit = jest.fn();
    const onCancel = jest.fn();
    act(() => {
      root.render(
        <>
          <QueuedMessageActions
            placement="corner"
            onEdit={onEdit}
            onCancel={onCancel}
          />
          <QueuedMessageActions
            placement="footer"
            onSteer={onSteer}
            onInterrupt={onInterrupt}
            onRetry={onRetry}
            onRunNow={onRunNow}
          />
        </>,
      );
    });

    click('queued-message-steer');
    click('queued-message-interrupt');
    click('queued-message-retry');
    click('queued-message-run-now');
    click('queued-message-edit');
    click('queued-message-cancel');

    expect(onSteer).toHaveBeenCalledTimes(1);
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRunNow).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('QueuedMessageActions credit-held retry', () => {
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

  function retryButton(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      '[data-testid="queued-message-retry"]',
    );
  }

  it('offers only a disabled Retry that explains the hold and never sends', () => {
    const onRetry = jest.fn();
    const onInterrupt = jest.fn();
    const onSteer = jest.fn();
    const onRunNow = jest.fn();
    act(() =>
      root.render(
        <QueuedMessageActions
          placement="footer"
          turnPhase="foreground"
          retryBlockedReason="insufficient_credits"
          onRetry={onRetry}
          onInterrupt={onInterrupt}
          onSteer={onSteer}
          onRunNow={onRunNow}
        />,
      ),
    );

    expect(testIds(container.innerHTML)).toEqual([
      'queued-message-retry',
      'queued-message-retry-icon',
    ]);
    const retry = retryButton();
    expect(retry?.textContent).toBe('Retry');
    expect(retry?.getAttribute('aria-disabled')).toBe('true');
    // Focusable, so the explanation is reachable from the keyboard.
    expect(retry?.disabled).toBe(false);
    expect(retry?.getAttribute('aria-description')).toBe(
      QUEUED_MESSAGE_RETRY_BLOCKED_TOOLTIPS.insufficient_credits.description,
    );
    act(() => retry?.click());
    expect(onRetry).not.toHaveBeenCalled();
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(onSteer).not.toHaveBeenCalled();
    expect(onRunNow).not.toHaveBeenCalled();
  });

  it('keeps the held Retry focusable inside its explanation tooltip', () => {
    act(() =>
      root.render(
        <QueuedMessageActions
          placement="footer"
          retryBlockedReason="insufficient_credits"
        />,
      ),
    );
    const retry = retryButton();
    act(() => retry?.focus());

    expect(document.activeElement).toBe(retry);
    // The tooltip trigger wrapper owns the hover and focus-visible handlers.
    expect(retry?.parentElement?.tagName).toBe('SPAN');
    expect(retry?.parentElement?.className).toContain('relative inline-flex');
  });

  it('enables the host callback once the hold lifts, and only then', () => {
    const onRetry = jest.fn();
    act(() =>
      root.render(
        <QueuedMessageActions
          placement="footer"
          retryBlockedReason="insufficient_credits"
          onRetry={onRetry}
        />,
      ),
    );
    act(() => retryButton()?.click());
    expect(onRetry).not.toHaveBeenCalled();

    act(() =>
      root.render(
        <QueuedMessageActions placement="footer" onRetry={onRetry} />,
      ),
    );
    expect(retryButton()?.hasAttribute('aria-disabled')).toBe(false);
    act(() => retryButton()?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('does not become actionable when a hold lifts from a row without a callback', () => {
    act(() =>
      root.render(
        <QueuedMessageActions
          placement="footer"
          retryBlockedReason="insufficient_credits"
        />,
      ),
    );
    expect(retryButton()).not.toBeNull();

    act(() => root.render(<QueuedMessageActions placement="footer" />));
    expect(retryButton()).toBeNull();
  });

  it.each([
    ['pending', { pending: true }],
    ['editing another row', { anyEditing: true }],
    ['force-locked', { forceLocked: true }],
    ['edit-locked', { editLocked: true }],
  ] as const)('lets the %s lock hide a held Retry', (_label, lock) => {
    expect(
      markup({
        placement: 'footer',
        retryBlockedReason: 'insufficient_credits',
        onRetry: noop,
        ...lock,
      }),
    ).toBe('');
  });

  it('leaves an unheld Retry unchanged', () => {
    const html = markup({ placement: 'footer', onRetry: noop });
    expect(html).not.toContain('aria-disabled=');
    expect(html).not.toContain('aria-description=');
    expect(html).not.toContain('Add credits first');
  });
});
