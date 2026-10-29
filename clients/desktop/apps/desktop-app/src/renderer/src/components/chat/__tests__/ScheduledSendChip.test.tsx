/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { focusViaKeyboard } from '@/test-utils/dom';
import { ScheduledSendChip } from '../ScheduledSendChip';
import { buildPlanModeChip } from '@canopy/ui-shared';
import { TerminalModeLabel } from '../ComposerLayout';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 9, 2, 11, 20);
const TOMORROW_9 = new Date(2026, 9, 3, 9, 0).toISOString();

describe('ScheduledSendChip', () => {
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

  function query(testId: string): HTMLElement {
    const element = container.querySelector<HTMLElement>(
      `[data-testid="${testId}"]`,
    );
    if (!element) throw new Error(`Missing ${testId}`);
    return element;
  }

  it('names when it goes out in a few words, in the Plan chip shape', () => {
    act(() => {
      root.render(
        <ScheduledSendChip
          runAt={TOMORROW_9}
          error={null}
          editable
          onEdit={jest.fn()}
          onClear={jest.fn()}
          now={NOW}
        />,
      );
    });
    const chip = query('chat-input-scheduled-send-chip');
    expect(chip.getAttribute('data-scheduled-send-state')).toBe('scheduled');
    for (const cls of [
      'h-8',
      'rounded-full',
      'text-xs',
      'bg-info-subtle',
      'fg-info',
    ]) {
      expect(chip.classList.contains(cls)).toBe(true);
    }
    const pill = query('chat-input-scheduled-send-pill');
    expect(pill.textContent).toMatch(/^Tomorrow 9:00\sAM$/);
    expect(pill.getAttribute('aria-label')).toMatch(/^Scheduled send, /);
  });

  it('edits from the body and clears from the x', () => {
    const onEdit = jest.fn();
    const onClear = jest.fn();
    act(() => {
      root.render(
        <ScheduledSendChip
          runAt={TOMORROW_9}
          error={null}
          editable
          onEdit={onEdit}
          onClear={onClear}
          now={NOW}
        />,
      );
    });
    act(() => query('chat-input-scheduled-send-pill').click());
    expect(onEdit).toHaveBeenCalledTimes(1);
    act(() => query('chat-input-scheduled-send-clear').click());
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('turns red and says it failed, keeping the reason for its tooltip', () => {
    const reason =
      'This harness does not support scheduled messages. Choose another model or clear the schedule.';
    act(() => {
      root.render(
        <ScheduledSendChip
          runAt={TOMORROW_9}
          error={reason}
          editable
          onEdit={jest.fn()}
          onClear={jest.fn()}
          now={NOW}
        />,
      );
    });
    const chip = query('chat-input-scheduled-send-chip');
    expect(chip.getAttribute('data-scheduled-send-state')).toBe('failed');
    expect(chip.classList.contains('bg-destructive-subtle')).toBe(true);
    expect(chip.classList.contains('fg-destructive')).toBe(true);
    const pill = query('chat-input-scheduled-send-pill');
    expect(pill.textContent).toBe("Couldn't schedule");
    expect(pill.getAttribute('aria-label')).toBe(
      `Scheduled send failed: ${reason}`,
    );
  });

  it('shows a failure reason in its portaled tooltip, then the schedule time', () => {
    const reason = "Couldn't schedule Secret nightly sync";
    act(() => {
      root.render(
        <ScheduledSendChip
          runAt={TOMORROW_9}
          error={reason}
          editable
          onEdit={jest.fn()}
          onClear={jest.fn()}
          now={NOW}
        />,
      );
    });
    act(() => {
      focusViaKeyboard(query('chat-input-scheduled-send-pill'));
    });
    const failed = Array.from(
      document.body.querySelectorAll('[role="tooltip"] span'),
    ).find((node) => node.textContent === reason);
    expect(failed).toBeDefined();

    act(() => {
      root.render(
        <ScheduledSendChip
          runAt={TOMORROW_9}
          error={null}
          editable
          onEdit={jest.fn()}
          onClear={jest.fn()}
          now={NOW}
        />,
      );
    });
    const scheduled = Array.from(
      document.body.querySelectorAll('[role="tooltip"] span'),
    ).find((node) => node.textContent?.startsWith('Sends '));
    expect(scheduled).toBeDefined();
  });

  it('shows only the time in a narrow box, and only the glyph when it failed', () => {
    act(() => {
      root.render(
        <ScheduledSendChip
          runAt={TOMORROW_9}
          error={null}
          editable
          compact
          onEdit={jest.fn()}
          onClear={jest.fn()}
          now={NOW}
        />,
      );
    });
    expect(query('chat-input-scheduled-send-pill').textContent).toMatch(
      /^9:00\sAM$/,
    );
    act(() => {
      root.render(
        <ScheduledSendChip
          runAt={TOMORROW_9}
          error="Could not schedule message."
          editable
          compact
          onEdit={jest.fn()}
          onClear={jest.fn()}
          now={NOW}
        />,
      );
    });
    const pill = query('chat-input-scheduled-send-pill');
    expect(pill.textContent).toBe('');
    expect(pill.getAttribute('aria-label')).toBe(
      'Scheduled send failed: Could not schedule message.',
    );
  });

  it('draws the same x glyph as the Plan chip', () => {
    act(() => {
      root.render(
        <ScheduledSendChip
          runAt={TOMORROW_9}
          error={null}
          editable
          onEdit={jest.fn()}
          onClear={jest.fn()}
          now={NOW}
        />,
      );
    });
    const cross = query('chat-input-scheduled-send-clear').querySelector('svg');
    const crossGlyph = cross?.getAttribute('data-glyph');
    expect(crossGlyph).toBe('x');
    const planCross = buildPlanModeChip({
      readOnly: false,
      disabled: false,
      onDisable: jest.fn(),
    }).trailing;
    act(() => root.render(<span>{planCross}</span>));
    expect(container.querySelector('svg')?.getAttribute('data-glyph')).toBe(
      crossGlyph,
    );
  });

  it('only clears when the model cannot schedule', () => {
    act(() => {
      root.render(
        <ScheduledSendChip
          runAt={TOMORROW_9}
          error={null}
          editable={false}
          onEdit={jest.fn()}
          onClear={jest.fn()}
          now={NOW}
        />,
      );
    });
    expect(
      (query('chat-input-scheduled-send-pill') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (query('chat-input-scheduled-send-clear') as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe('TerminalModeLabel', () => {
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

  it('names the mode in the composer text size and the warning ink', () => {
    act(() => root.render(<TerminalModeLabel />));
    const label = container.querySelector(
      '[data-testid="chat-input-terminal-mode-label"]',
    );
    expect(label?.textContent).toBe('Terminal mode');
    expect(label?.classList.contains('fg-warning')).toBe(true);
    // The draft's own size (text-s), and 12px to the run button: the row's
    // 8px gap plus 4px, as + keeps 12px to the text on the left.
    expect(label?.classList.contains('text-s')).toBe(true);
    expect(label?.classList.contains('mr-1')).toBe(true);
  });

  it('shows a failed send in the label’s place, as an alert', () => {
    act(() =>
      root.render(<TerminalModeLabel error="Couldn't send to terminal" />),
    );
    expect(
      container.querySelector('[data-testid="chat-input-terminal-mode-label"]'),
    ).toBeNull();
    const error = container.querySelector(
      '[data-testid="chat-input-terminal-mode-error"]',
    );
    expect(error?.getAttribute('role')).toBe('alert');
    expect(error?.textContent).toBe("Couldn't send to terminal");
    expect(error?.classList.contains('fg-destructive')).toBe(true);
  });
});
