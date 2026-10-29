/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  PLAN_APPROVAL_TEXT_ROW_CLASS,
  PlanApprovalPrompt,
  type PlanApprovalOption,
} from '../PlanApprovalPrompt';
import { buildPlanReadyChip } from '../ComposerLayout';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('PlanApprovalPrompt', () => {
  let container: HTMLDivElement;
  let root: Root;
  let implement: jest.Mock;
  let pipeline: jest.Mock;
  let close: jest.Mock;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    implement = jest.fn();
    pipeline = jest.fn();
    close = jest.fn();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function options(disabled = false): PlanApprovalOption[] {
    return [
      {
        label: 'Yes, implement this plan',
        onSelect: implement,
        disabled,
        testId: 'chat-plan-implement',
      },
      {
        label: 'Run it as a pipeline',
        onSelect: pipeline,
        disabled,
        testId: 'chat-plan-pipeline',
      },
    ];
  }

  function render({
    onOpenPlan,
    disabled = false,
  }: { onOpenPlan?: () => void; disabled?: boolean } = {}): void {
    act(() => {
      root.render(
        <PlanApprovalPrompt
          options={options(disabled)}
          {...(onOpenPlan ? { onOpenPlan } : {})}
          onClose={close}
        >
          <textarea data-testid="note" />
        </PlanApprovalPrompt>,
      );
    });
  }

  function byTestId(id: string): HTMLElement {
    const element = container.querySelector<HTMLElement>(
      `[data-testid="${id}"]`,
    );
    if (!element) throw new Error(`Missing ${id}`);
    return element;
  }

  function key(target: HTMLElement, value: string): void {
    act(() => {
      target.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: value,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  }

  it('asks, numbers its answers, and holds the text row last', () => {
    render();
    const prompt = byTestId('chat-plan-approval');
    expect(prompt.textContent).toContain('Implement this plan?');
    const implementRow = byTestId('chat-plan-implement');
    const pipelineRow = byTestId('chat-plan-pipeline');
    expect(implementRow.textContent).toBe('1Yes, implement this plan');
    expect(pipelineRow.textContent).toBe('2Run it as a pipeline');
    // The group is named by the question.
    const group = prompt.querySelector('[role="group"]');
    const titleId = group?.getAttribute('aria-labelledby') ?? '';
    expect(document.getElementById(titleId)?.textContent).toBe(
      'Implement this plan?',
    );
    // The host's text row sits last, in the text row's layout.
    const note = byTestId('note');
    expect(note.parentElement?.className).toBe(PLAN_APPROVAL_TEXT_ROW_CLASS);
    expect(prompt.lastElementChild).toBe(note.parentElement);
    // A pen in the numbers' column marks the note as one more answer.
    expect(
      note.parentElement?.querySelector('[data-testid="composer-prompt-pen"]'),
    ).not.toBeNull();
  });

  it('acts on click, so no answer reads as selected beforehand', () => {
    render();
    for (const id of ['chat-plan-implement', 'chat-plan-pipeline']) {
      const row = byTestId(id);
      // Lit only under the pointer or keyboard focus; never pre-selected.
      expect(row.className).toContain('hover:bg-subtle');
      expect(row.className).toContain('focus-visible:bg-subtle');
      expect(row.className).not.toMatch(/(^|\s)bg-subtle/);
      expect(row.hasAttribute('data-active')).toBe(false);
    }
  });

  it('answers from a click, a number key, and moves with the arrows', () => {
    render();
    act(() => byTestId('chat-plan-implement').click());
    expect(implement).toHaveBeenCalledTimes(1);

    const implementRow = byTestId('chat-plan-implement');
    act(() => implementRow.focus());
    key(implementRow, '2');
    expect(pipeline).toHaveBeenCalledTimes(1);

    key(implementRow, 'ArrowDown');
    expect(document.activeElement).toBe(byTestId('chat-plan-pipeline'));
    key(byTestId('chat-plan-pipeline'), 'ArrowDown');
    expect(document.activeElement).toBe(implementRow);
  });

  it('closes on Escape and from x, keeping the plan for the host', () => {
    render();
    key(byTestId('note'), 'Escape');
    expect(close).toHaveBeenCalledTimes(1);
    act(() => byTestId('chat-plan-approval-close').click());
    expect(close).toHaveBeenCalledTimes(2);
    expect(implement).not.toHaveBeenCalled();
  });

  it('offers Open plan only once the plan can be opened', () => {
    render();
    expect(
      container.querySelector('[data-testid="chat-plan-explore"]'),
    ).toBeNull();
    const openPlan = jest.fn();
    render({ onOpenPlan: openPlan });
    // Both header actions are composer controls in the primary ink.
    for (const id of ['chat-plan-explore', 'chat-plan-approval-close']) {
      const action = byTestId(id);
      expect(action.getAttribute('data-composer-icon-button')).toBe('true');
      expect(action.classList.contains('fg-primary')).toBe(true);
      expect(action.classList.contains('h-8')).toBe(true);
    }
    act(() => byTestId('chat-plan-explore').click());
    expect(openPlan).toHaveBeenCalledTimes(1);
  });

  it('cannot answer a plan that was already reviewed', () => {
    render({ disabled: true });
    const implementRow = byTestId('chat-plan-implement');
    expect((implementRow as HTMLButtonElement).disabled).toBe(true);
    key(implementRow, '1');
    expect(implement).not.toHaveBeenCalled();
  });
});

describe('buildPlanReadyChip', () => {
  it('names the waiting plan and reopens the prompt', () => {
    const onOpen = jest.fn();
    const chip = buildPlanReadyChip({ onOpen });
    expect(chip.label).toBe('Plan ready');
    expect(chip.activeTone).toBe('warning');
    expect(chip.trailing).toBeUndefined();
    expect(chip.dataTestId).toBe('chat-input-plan-ready-chip');
    chip.onClick?.();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('draws the glyph alone in a narrow box', () => {
    const chip = buildPlanReadyChip({ onOpen: jest.fn(), compact: true });
    expect(chip.label).toBeUndefined();
    expect(chip.ariaLabel).toBe('Plan ready, review it');
  });
});
