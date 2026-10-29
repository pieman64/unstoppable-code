/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WorktreeRow, WorktreeRowActionChip } from '../WorktreeRow';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

/**
 * Keyboard-driven focus. The shared tooltips follow `:focus-visible`: a Tab
 * keydown reaches the document before focus moves, so the tooltip opens. A
 * bare `.focus()` is programmatic focus and keeps it closed.
 */
function focusViaKeyboard(element: HTMLElement | null | undefined): void {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
  );
  element?.focus();
}

describe('WorktreeRow focus interactions', () => {
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
    document
      .querySelectorAll('[role="tooltip"]')
      .forEach((tooltip) => tooltip.remove());
  });

  it('keeps a keyboard-focused status control visible above hover actions', () => {
    act(() => {
      root.render(
        <WorktreeRow
          branchLabel="Awaiting approval"
          branchName="awaiting-approval"
          uiStatus="idle"
          awaitingApproval
          actionChipSlot={
            <WorktreeRowActionChip>
              <button type="button">Actions</button>
            </WorktreeRowActionChip>
          }
        />,
      );
    });

    const rail = container.querySelector(
      '[data-testid="worktree-row-status-rail"]',
    );
    const status = container.querySelector(
      '[data-testid="worktree-row-awaiting-approval"]',
    );
    if (
      !(rail instanceof HTMLSpanElement) ||
      !(status instanceof HTMLElement)
    ) {
      throw new Error('compact status rail was not rendered');
    }

    expect(rail.className).toContain('group-focus-within:opacity-0');

    act(() => {
      status.focus();
    });

    expect(rail.dataset.statusRailFocused).toBe('true');
    expect(rail.className).toContain('z-10 opacity-100');
    expect(rail.className).not.toContain('group-focus-within:opacity-0');

    act(() => {
      status.blur();
    });

    expect(rail.dataset.statusRailFocused).toBeUndefined();
    expect(rail.className).toContain('group-focus-within:opacity-0');
  });

  it('opens a rich tooltip from a compact status dot without a host popover (CAN-2799)', () => {
    act(() => {
      root.render(
        <WorktreeRow
          branchLabel="Question"
          branchName="question"
          uiStatus="idle"
          hasPendingQuestion
        />,
      );
    });

    const dot = container.querySelector<HTMLElement>(
      '[data-testid="worktree-row-question"]',
    );
    expect(dot?.hasAttribute('title')).toBe(false);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    act(() => {
      focusViaKeyboard(dot);
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Question waiting',
    );
  });

  it('explains the health warning reason in a rich tooltip on focus (CAN-2799)', () => {
    act(() => {
      root.render(
        <WorktreeRow
          branchLabel="Broken"
          branchName="broken"
          uiStatus="idle"
          textScale="sidebar"
          healthIssue={{ status: 'broken', reason: 'Worktree missing on disk' }}
        />,
      );
    });

    const warning = container.querySelector<HTMLElement>(
      '[aria-label="Worktree issue - click for details"]',
    );
    expect(warning?.hasAttribute('title')).toBe(false);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    act(() => {
      focusViaKeyboard(warning);
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Worktree missing on disk',
    );
  });

  it('opens a rich tooltip from the streaming loader on hover (CAN-2799)', () => {
    act(() => {
      root.render(
        <WorktreeRow
          branchLabel="Working"
          branchName="working"
          uiStatus="idle"
          isStreaming
        />,
      );
    });

    const loader = container.querySelector<HTMLElement>(
      '[aria-label="Working"]',
    );
    expect(loader?.hasAttribute('title')).toBe(false);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    act(() => {
      loader?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Working',
    );
  });

  it('opens the depth tooltip from its expanded hover and focus target without displacing row controls', () => {
    const onDragPointerDown = jest.fn();
    act(() => {
      root.render(
        <WorktreeRow
          branchLabel="Nested worktree"
          branchName="dev-ibex"
          worktreeId="dev-ibex"
          uiStatus="idle"
          textScale="sidebar"
          depthBadge={{
            depth: 1,
            topMost: { branchName: 'dev-starfish', animalName: 'starfish' },
          }}
          onDragPointerDown={onDragPointerDown}
          actionChipSlot={
            <WorktreeRowActionChip>
              <button type="button">Actions</button>
            </WorktreeRowActionChip>
          }
          dataTestId="depth-row"
        />,
      );
    });

    const row = container.querySelector('[data-testid="depth-row"]');
    const trigger = container.querySelector(
      '[data-testid="worktree-row-depth-badge"]',
    );
    const action = container.querySelector('button');
    if (
      !(row instanceof HTMLDivElement) ||
      !(trigger instanceof HTMLElement) ||
      !(action instanceof HTMLButtonElement)
    ) {
      throw new Error('depth row controls were not rendered');
    }

    expect(trigger.className).toContain('-mx-2.25');
    expect(trigger.className).toContain('inline-flex');
    expect(trigger.className).toContain('h-4');
    expect(trigger.className).toContain('min-w-6');
    expect(trigger.className).toContain('px-2.25');
    expect(trigger.className).toContain('justify-center');
    expect(trigger.className).not.toContain('-my-');
    expect(trigger.tabIndex).toBe(0);
    expect(row.className).toContain('cursor-default');
    expect(row.className).not.toContain('cursor-grab');
    expect(row.className).not.toContain('active:cursor-grabbing');
    expect(action.textContent).toBe('Actions');
    expect(action.disabled).toBe(false);

    act(() => {
      trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(
      document.body.querySelector('[role="tooltip"]')?.textContent,
    ).toContain('Depth 1 under the top-most parent');

    act(() => {
      trigger.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      trigger.focus();
    });
    expect(document.activeElement).toBe(trigger);
    expect(
      document.body.querySelector('[role="tooltip"]')?.textContent,
    ).toContain('Top-most parent: dev-starfish (starfish)');

    act(() => {
      trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      action.focus();
    });
    expect(onDragPointerDown).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(action);

    act(() => {
      trigger.focus();
      trigger.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
    });
    expect(trigger.tabIndex).toBe(0);
    expect(action.tabIndex).toBe(0);
  });

  it('uses the grouped child depth as the depth tooltip trigger', () => {
    const onDragPointerDown = jest.fn();
    act(() => {
      root.render(
        <WorktreeRow
          branchLabel="Nested worktree"
          branchName="dev-ibex"
          worktreeId="dev-ibex"
          uiStatus="idle"
          textScale="sidebar"
          nested
          nestedChildDepth={1}
          depthBadge={{
            depth: 1,
            topMost: { branchName: 'dev-starfish', animalName: 'starfish' },
          }}
          onDragPointerDown={onDragPointerDown}
          actionChipSlot={
            <WorktreeRowActionChip>
              <button type="button">Actions</button>
            </WorktreeRowActionChip>
          }
          dataTestId="grouped-depth-row"
        />,
      );
    });

    const row = container.querySelector('[data-testid="grouped-depth-row"]');
    const trigger = container.querySelector(
      '[data-testid="worktree-row-nested-child-depth"]',
    );
    const action = container.querySelector('button');
    if (
      !(row instanceof HTMLDivElement) ||
      !(trigger instanceof HTMLElement) ||
      !(action instanceof HTMLButtonElement)
    ) {
      throw new Error('grouped depth row controls were not rendered');
    }

    expect(trigger.textContent).toBe('1');
    expect(trigger.dataset.depth).toBe('1');
    expect(trigger.className).toContain('-mx-2.25');
    expect(trigger.className).toContain('h-4');
    expect(trigger.className).toContain('min-w-6');
    expect(
      container.querySelector('[data-testid="worktree-row-depth-badge"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="worktree-row-subtitle"]')
        ?.textContent,
    ).toContain('1·dev-ibex');

    act(() => {
      trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(
      document.body.querySelector('[role="tooltip"]')?.textContent,
    ).toContain('Depth 1 under the top-most parent');

    act(() => {
      trigger.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      focusViaKeyboard(trigger);
    });
    expect(document.activeElement).toBe(trigger);
    expect(
      document.body.querySelector('[role="tooltip"]')?.textContent,
    ).toContain('Top-most parent: dev-starfish (starfish)');

    act(() => {
      trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      action.focus();
    });
    expect(onDragPointerDown).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(action);
  });
});
