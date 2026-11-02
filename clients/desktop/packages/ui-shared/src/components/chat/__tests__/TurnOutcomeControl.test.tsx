/** @jest-environment jsdom */
/**
 * DOM tests for the turn outcome control and its tooltip (CAN-5056): the
 * warning beside a finished turn's toggle that names its blocked and errored
 * steps on hover and jumps to them on click.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TurnOutcomeStepDetail } from '@canopy/protocol/portal';
import { USER_DENIED_MESSAGE } from '@canopy/protocol/approvals';
import { resetInputModality } from '../../../lib/input-modality';
import { REPLAY_BLOCK_CLASS } from '../../../lib/replay-privacy';
import { ChatAppNameProvider, ChatLookProvider } from '../../chat-look';
import {
  CollapsedTurnSummary,
  TurnOutcomeControl,
} from '../CollapsedTurnSummary';
import { formatTurnOutcomeLabel } from '../turn-outcome-label';
import { TurnWorkHeader } from '../TurnWorkHeader';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  resetInputModality(document);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

function render(node: ReactNode): void {
  act(() => root.render(node));
}

const bashError: TurnOutcomeStepDetail = {
  toolUseId: 'bash-1',
  outcome: 'failed',
  toolName: 'Bash',
  input: JSON.stringify({
    command: 'ls ~/.claude/mcp-*.json',
    description: 'List MCP connection files',
  }),
  output: 'Exit code 1\nzsh: no matches found: ~/.claude/mcp-*.json',
};

const deniedRead: TurnOutcomeStepDetail = {
  toolUseId: 'read-1',
  outcome: 'blocked',
  toolName: 'Read',
  input: JSON.stringify({ file_path: '/repo/secret.env' }),
  output: USER_DENIED_MESSAGE,
};

const interruptedEdit: TurnOutcomeStepDetail = {
  toolUseId: 'edit-1',
  outcome: 'interrupted',
  toolName: 'Edit',
  input: JSON.stringify({ file_path: '/repo/src/app.ts' }),
  output: 'Interrupted',
  interruption: { reason: 'app_restart', at: 1_700_000_000_000 },
};

function control(): HTMLElement {
  const element = host.querySelector<HTMLElement>(
    '[data-testid="turn-outcome-control"]',
  );
  if (!element) throw new Error('Missing outcome control');
  return element;
}

function surface(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-testid="turn-outcome-tooltip-surface"]',
  );
}

function hover(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(
      new MouseEvent('mouseover', {
        bubbles: true,
        relatedTarget: document.body,
      }),
    );
  });
}

function keyboardFocus(element: HTMLElement): void {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
    );
    element.focus();
  });
}

function press(element: HTMLElement, key: string): void {
  act(() => {
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  });
}

describe('formatTurnOutcomeLabel', () => {
  it('says errors, never failed, and keeps blocked as is', () => {
    expect(formatTurnOutcomeLabel('failed', 1)).toBe('1 error');
    expect(formatTurnOutcomeLabel('failed', 2)).toBe('2 errors');
    expect(formatTurnOutcomeLabel('blocked', 1)).toBe('1 blocked');
    expect(formatTurnOutcomeLabel('blocked', 3)).toBe('3 blocked');
    expect(formatTurnOutcomeLabel('interrupted', 1)).toBe('1 interrupted');
    expect(formatTurnOutcomeLabel('interrupted', 2)).toBe('2 interrupted');
  });
});

describe('TurnOutcomeControl interrupted steps (CAN-5178)', () => {
  it('says interrupted last, in neutral ink, without a failed count', () => {
    render(
      <ChatLookProvider value="classic">
        <TurnOutcomeControl
          outcomes={{ blocked: 1, failed: 2, interrupted: 1 }}
          onJumpToOutcome={jest.fn()}
        />
      </ChatLookProvider>,
    );
    const trigger = control();
    expect(trigger.textContent).toBe('1 blocked·2 errors·1 interrupted');
    expect(trigger.getAttribute('aria-label')).toBe(
      '1 blocked, 2 errors, 1 interrupted, show steps',
    );
    expect(trigger.dataset.turnInterrupted).toBe('1');
    const interrupted = trigger.querySelector<HTMLElement>(
      '[data-turn-outcome="interrupted"]',
    );
    expect(interrupted?.className).toContain('fg-secondary');
    expect(interrupted?.className).not.toContain('fg-warning');
    // Real problems keep their warning ink.
    expect(
      trigger.querySelector('[data-turn-outcome="failed"]')?.className,
    ).toContain('fg-warning-strong');
    expect(
      trigger.querySelector('[data-turn-outcome="blocked"]')?.className,
    ).toContain('fg-warning-strong');
  });

  it('has no failed attribute for an interruption-only turn', () => {
    render(
      <ChatLookProvider value="classic">
        <TurnOutcomeControl
          outcomes={{ blocked: 0, failed: 0, interrupted: 1 }}
          outcomeSteps={[interruptedEdit]}
          onJumpToOutcome={jest.fn()}
        />
      </ChatLookProvider>,
    );
    const trigger = control();
    expect(trigger.textContent).toBe('1 interrupted');
    expect(trigger.hasAttribute('data-turn-failed')).toBe(false);
    expect(trigger.hasAttribute('data-turn-blocked')).toBe(false);
  });

  it('names the app for a restart and lists interrupted steps last', () => {
    render(
      <ChatAppNameProvider value="Canopy">
        <ChatLookProvider value="classic">
          <TurnOutcomeControl
            outcomes={{ blocked: 1, failed: 1, interrupted: 1 }}
            outcomeSteps={[interruptedEdit, bashError, deniedRead]}
            onJumpToOutcome={jest.fn()}
          />
        </ChatLookProvider>
      </ChatAppNameProvider>,
    );
    hover(control());
    const entries = Array.from(
      surface()?.querySelectorAll<HTMLElement>('[data-turn-outcome-step]') ??
        [],
    );
    expect(entries.map((entry) => entry.dataset.turnOutcomeStep)).toEqual([
      'read-1',
      'bash-1',
      'edit-1',
    ]);
    expect(
      entries[2]?.querySelector('[data-turn-outcome-step-reason]')?.textContent,
    ).toBe('Interrupted when Canopy closed');
    expect(
      entries[2]?.querySelector('[aria-hidden="true"]')?.className,
    ).toContain('fg-secondary');
  });

  it('says a generic reason for other interruptions', () => {
    render(
      <ChatAppNameProvider value="Canopy">
        <ChatLookProvider value="classic">
          <TurnOutcomeControl
            outcomes={{ blocked: 0, failed: 0, interrupted: 1 }}
            outcomeSteps={[
              {
                ...interruptedEdit,
                interruption: { reason: 'fork', at: 1 },
              },
            ]}
          />
        </ChatLookProvider>
      </ChatAppNameProvider>,
    );
    hover(control());
    expect(
      surface()?.querySelector('[data-turn-outcome-step-reason]')?.textContent,
    ).toBe('Interrupted');
  });

  it('says interrupted counts in a sentence when rows are not loaded', () => {
    render(
      <ChatLookProvider value="classic">
        <TurnOutcomeControl
          outcomes={{ blocked: 0, failed: 1, interrupted: 2 }}
        />
      </ChatLookProvider>,
    );
    hover(control());
    expect(
      Array.from(surface()?.querySelectorAll('p') ?? []).map(
        (line) => line.textContent,
      ),
    ).toEqual([
      '1 step ran into an error',
      'Effect on the result is unknown',
      '2 steps were interrupted',
    ]);
  });

  it('counts interrupted steps the rows cannot name in +N more', () => {
    render(
      <ChatLookProvider value="classic">
        <TurnOutcomeControl
          outcomes={{ blocked: 0, failed: 5, interrupted: 2 }}
          outcomeSteps={Array.from(
            { length: 5 },
            (_, index): TurnOutcomeStepDetail => ({
              ...bashError,
              toolUseId: `bash-${String(index)}`,
            }),
          )}
        />
      </ChatLookProvider>,
    );
    hover(control());
    expect(
      surface()?.querySelector<HTMLElement>('[data-turn-outcome-more]')?.dataset
        .turnOutcomeMore,
    ).toBe('2');
  });
});

describe('TurnOutcomeControl error impact (CAN-5355)', () => {
  it('names the failing step and says its effect on the result is unknown', () => {
    render(
      <ChatLookProvider value="classic">
        <TurnOutcomeControl
          outcomes={{ blocked: 1, failed: 1, interrupted: 1 }}
          outcomeSteps={[bashError, deniedRead, interruptedEdit]}
        />
      </ChatLookProvider>,
    );
    hover(control());
    const failed = surface()?.querySelector(
      '[data-turn-outcome-step="bash-1"]',
    );
    expect(
      failed?.querySelector('[data-turn-outcome-step-label]')?.textContent,
    ).toBeTruthy();
    expect(
      failed?.querySelector('[data-turn-outcome-step-impact]')?.textContent,
    ).toBe('Effect on the result is unknown');
    // Blocked and interrupted steps never ran to an error: no impact line.
    expect(
      surface()?.querySelectorAll('[data-turn-outcome-step-impact]'),
    ).toHaveLength(1);
  });

  it('keeps blocked and interrupted counts free of the impact sentence', () => {
    render(
      <ChatLookProvider value="classic">
        <TurnOutcomeControl
          outcomes={{ blocked: 1, failed: 0, interrupted: 1 }}
        />
      </ChatLookProvider>,
    );
    hover(control());
    expect(surface()?.textContent).not.toContain('Effect on the result');
  });
});

describe('TurnOutcomeControl', () => {
  it('renders nothing for a turn with no outcome', () => {
    render(
      <ChatLookProvider value="classic">
        <TurnOutcomeControl
          outcomes={{ blocked: 0, failed: 0, interrupted: 0 }}
          onJumpToOutcome={jest.fn()}
        />
      </ChatLookProvider>,
    );
    expect(host.innerHTML).toBe('');
  });

  it('is a button named by its words that jumps to the first step', () => {
    const onJump = jest.fn();
    render(
      <ChatLookProvider value="classic">
        <TurnOutcomeControl
          outcomes={{ blocked: 1, failed: 2, interrupted: 0 }}
          outcomeSteps={[bashError, deniedRead]}
          onJumpToOutcome={onJump}
        />
      </ChatLookProvider>,
    );
    const trigger = control();
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('aria-label')).toBe(
      '1 blocked, 2 errors, show steps',
    );
    expect(trigger.textContent).toBe('1 blocked·2 errors');
    expect(trigger.dataset.turnBlocked).toBe('1');
    expect(trigger.dataset.turnFailed).toBe('2');
    expect(trigger.hasAttribute('data-turn-outcomes')).toBe(true);
    expect(trigger.querySelectorAll('[data-turn-outcome]')).toHaveLength(2);

    act(() => trigger.click());

    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith(undefined);
  });

  it('is a focusable span with only its words without a jump handler', () => {
    render(
      <ChatLookProvider value="classic">
        <TurnOutcomeControl
          outcomes={{ blocked: 0, failed: 1, interrupted: 0 }}
          outcomeSteps={[bashError]}
        />
      </ChatLookProvider>,
    );
    const trigger = control();
    expect(trigger.tagName).toBe('SPAN');
    expect(trigger.tabIndex).toBe(0);
    expect(trigger.hasAttribute('aria-label')).toBe(false);

    hover(trigger);

    expect(surface()?.querySelector('button')).toBeNull();
    expect(surface()?.textContent).toContain('zsh: no matches found');
    // Nothing inside to move to: a description, not an expandable control.
    expect(trigger.hasAttribute('aria-expanded')).toBe(false);
    expect(trigger.hasAttribute('aria-controls')).toBe(false);
    expect(trigger.getAttribute('aria-describedby')).toBe(surface()?.id);
  });

  it('lists each step with its label and reason, blocked first, never an exit code', () => {
    render(
      <ChatLookProvider value="classic">
        <TurnOutcomeControl
          outcomes={{ blocked: 1, failed: 1, interrupted: 0 }}
          outcomeSteps={[bashError, deniedRead]}
          onJumpToOutcome={jest.fn()}
        />
      </ChatLookProvider>,
    );
    hover(control());

    const entries = Array.from(
      surface()?.querySelectorAll<HTMLElement>('[data-turn-outcome-step]') ??
        [],
    );
    expect(entries.map((entry) => entry.dataset.turnOutcomeStep)).toEqual([
      'read-1',
      'bash-1',
    ]);
    expect(entries[0]?.textContent).toContain('Denied by you');
    expect(entries[1]?.textContent).toContain('List MCP connection files');
    expect(entries[1]?.textContent).toContain(
      'zsh: no matches found: ~/.claude/mcp-*.json',
    );
    expect(surface()?.textContent).not.toMatch(/exit code/i);
  });

  it('caps the list at five with a count of the rest', () => {
    const steps = Array.from(
      { length: 7 },
      (_, index): TurnOutcomeStepDetail => ({
        ...bashError,
        toolUseId: `bash-${String(index)}`,
      }),
    );
    render(
      <ChatLookProvider value="classic">
        <TurnOutcomeControl
          outcomes={{ blocked: 0, failed: 7, interrupted: 0 }}
          outcomeSteps={steps}
        />
      </ChatLookProvider>,
    );
    hover(control());

    expect(
      surface()?.querySelectorAll('[data-turn-outcome-step]'),
    ).toHaveLength(5);
    expect(surface()?.textContent).toContain('+2 more');
  });

  it('counts the steps it cannot list in the rest', () => {
    render(
      <ChatLookProvider value="classic">
        <TurnOutcomeControl
          outcomes={{ blocked: 0, failed: 3, interrupted: 0 }}
          outcomeSteps={[bashError]}
        />
      </ChatLookProvider>,
    );
    hover(control());

    expect(
      surface()?.querySelectorAll('[data-turn-outcome-step]'),
    ).toHaveLength(1);
    expect(surface()?.textContent).toContain('+2 more');
  });

  it.each([undefined, []])(
    'says the counts in a sentence when the steps are %p',
    (outcomeSteps) => {
      render(
        <ChatLookProvider value="classic">
          <TurnOutcomeControl
            outcomes={{ blocked: 2, failed: 1, interrupted: 0 }}
            outcomeSteps={outcomeSteps}
            onJumpToOutcome={jest.fn()}
          />
        </ChatLookProvider>,
      );
      hover(control());

      expect(surface()?.textContent).toBe(
        '2 steps were blocked1 step ran into an errorEffect on the result is unknown',
      );
      expect(surface()?.querySelector('[data-turn-outcome-step]')).toBeNull();
    },
  );

  it('blocks replay of labels and reasons in the portaled content only', () => {
    render(
      <ChatLookProvider value="classic">
        <TurnOutcomeControl
          outcomes={{ blocked: 0, failed: 1, interrupted: 0 }}
          outcomeSteps={[bashError]}
          onJumpToOutcome={jest.fn()}
        />
      </ChatLookProvider>,
    );
    hover(control());

    for (const selector of [
      '[data-turn-outcome-step-label]',
      '[data-turn-outcome-step-reason]',
    ]) {
      expect(
        surface()
          ?.querySelector(selector)
          ?.classList.contains(REPLAY_BLOCK_CLASS),
      ).toBe(true);
    }
    expect(control().closest(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
  });

  it('jumps to an entry and closes the tooltip', () => {
    const onJump = jest.fn();
    render(
      <ChatLookProvider value="classic">
        <TurnOutcomeControl
          outcomes={{ blocked: 1, failed: 1, interrupted: 0 }}
          outcomeSteps={[bashError, deniedRead]}
          onJumpToOutcome={onJump}
        />
      </ChatLookProvider>,
    );
    hover(control());
    const entry = surface()?.querySelector<HTMLElement>(
      '[data-turn-outcome-step="bash-1"]',
    );

    act(() => entry?.click());

    expect(onJump).toHaveBeenCalledWith('bash-1');
    expect(surface()).toBeNull();
  });

  it('closes on its own click and opens again when the pointer comes back', () => {
    render(
      <ChatLookProvider value="classic">
        <TurnOutcomeControl
          outcomes={{ blocked: 0, failed: 1, interrupted: 0 }}
          outcomeSteps={[bashError]}
          onJumpToOutcome={jest.fn()}
        />
      </ChatLookProvider>,
    );
    hover(control());
    expect(surface()).not.toBeNull();

    act(() => control().click());
    expect(surface()).toBeNull();

    hover(control());
    expect(surface()).not.toBeNull();
  });

  it('opens on keyboard focus and closes on Escape with focus kept', () => {
    render(
      <ChatLookProvider value="classic">
        <TurnOutcomeControl
          outcomes={{ blocked: 0, failed: 1, interrupted: 0 }}
          outcomeSteps={[bashError]}
          onJumpToOutcome={jest.fn()}
        />
      </ChatLookProvider>,
    );
    const trigger = control();
    keyboardFocus(trigger);
    expect(surface()).not.toBeNull();

    press(trigger, 'Escape');

    expect(surface()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('jumps but only describes the counts when the steps are not loaded', () => {
    const onJump = jest.fn();
    render(
      <ChatLookProvider value="classic">
        <TurnOutcomeControl
          outcomes={{ blocked: 0, failed: 2, interrupted: 0 }}
          onJumpToOutcome={onJump}
        />
      </ChatLookProvider>,
    );
    const trigger = control();
    expect(trigger.tagName).toBe('BUTTON');
    hover(trigger);

    // Nothing in the count sentences to move into.
    expect(trigger.hasAttribute('aria-expanded')).toBe(false);
    expect(trigger.getAttribute('aria-describedby')).toBe(surface()?.id);

    act(() => trigger.click());
    expect(onJump).toHaveBeenCalledWith(undefined);
  });

  it('lets a second Escape through once the tooltip is closed', () => {
    render(
      <ChatLookProvider value="classic">
        <TurnOutcomeControl
          outcomes={{ blocked: 0, failed: 1, interrupted: 0 }}
          outcomeSteps={[bashError]}
          onJumpToOutcome={jest.fn()}
        />
      </ChatLookProvider>,
    );
    const trigger = control();
    keyboardFocus(trigger);
    press(trigger, 'Escape');
    expect(surface()).toBeNull();

    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      trigger.dispatchEvent(escape);
    });

    expect(escape.defaultPrevented).toBe(false);
  });

  it('opens again on ArrowDown after Escape closed it', () => {
    render(
      <ChatLookProvider value="classic">
        <TurnOutcomeControl
          outcomes={{ blocked: 0, failed: 1, interrupted: 0 }}
          outcomeSteps={[bashError]}
          onJumpToOutcome={jest.fn()}
        />
      </ChatLookProvider>,
    );
    const trigger = control();
    keyboardFocus(trigger);
    press(trigger, 'Escape');
    expect(surface()).toBeNull();

    press(trigger, 'ArrowDown');

    expect(surface()).not.toBeNull();
  });
});

describe('outcome control in the turn headers', () => {
  it('keeps the classic toggle whole and puts the outcome beside it', () => {
    const onToggle = jest.fn();
    const onJump = jest.fn();
    render(
      <ChatLookProvider value="classic">
        <CollapsedTurnSummary
          summary={{ bash: 4 }}
          outcomes={{ blocked: 1, failed: 2, interrupted: 0 }}
          outcomeSteps={[bashError]}
          onJumpToOutcome={onJump}
          isExpanded={false}
          onToggle={onToggle}
          dataTestId="chat-turn-summary"
        />
      </ChatLookProvider>,
    );
    const toggle = host.querySelector<HTMLElement>(
      '[data-testid="chat-turn-summary"]',
    );
    expect(toggle?.tagName).toBe('BUTTON');
    expect(toggle?.getAttribute('aria-label')).toBe(
      'Agent steps: Ran 4 commands, 1 blocked, 2 errors',
    );
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle?.querySelector('[data-turn-step-count="4"]')).not.toBeNull();
    expect(toggle?.querySelector('[data-turn-outcomes]')).toBeNull();
    expect(toggle?.contains(control())).toBe(false);

    act(() => control().click());
    expect(onJump).toHaveBeenCalledWith(undefined);
    expect(onToggle).not.toHaveBeenCalled();

    act(() =>
      host.querySelector<HTMLElement>('[data-tool-chip="bash"]')?.click(),
    );
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('renders no outcome slot for a clean turn', () => {
    render(
      <ChatLookProvider value="classic">
        <CollapsedTurnSummary
          summary={{ bash: 2 }}
          outcomes={{ blocked: 0, failed: 0, interrupted: 0 }}
          onJumpToOutcome={jest.fn()}
          isExpanded={false}
        />
      </ChatLookProvider>,
    );
    expect(host.querySelector('[data-turn-outcomes]')).toBeNull();
  });

  it('puts the clean header outcome after the toggle and its chevron', () => {
    const onToggle = jest.fn();
    const onJump = jest.fn();
    render(
      <ChatLookProvider value="clean">
        <CollapsedTurnSummary
          summary={{ bash: 4 }}
          outcomes={{ blocked: 0, failed: 1, interrupted: 0 }}
          outcomeSteps={[bashError]}
          onJumpToOutcome={onJump}
          elapsedMs={204_000}
          isExpanded={false}
          onToggle={onToggle}
        />
      </ChatLookProvider>,
    );
    const toggle = host.querySelector<HTMLElement>('button[aria-expanded]');
    expect(toggle?.textContent).toBe('Worked for 3m 24s');
    expect(toggle?.contains(control())).toBe(false);
    expect(control().textContent).toBe('1 error');

    act(() => control().click());
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('still renders a caller-supplied detail inside the clean toggle', () => {
    render(
      <ChatLookProvider value="classic">
        <TurnWorkHeader
          elapsedMs={31_000}
          expandable
          detail={<span data-testid="detail">extra</span>}
        />
      </ChatLookProvider>,
    );
    const toggle = host.querySelector<HTMLElement>('button[aria-expanded]');
    expect(toggle?.querySelector('[data-testid="detail"]')).not.toBeNull();
    expect(host.querySelector('[data-turn-work-header-outcome]')).toBeNull();
  });
});
