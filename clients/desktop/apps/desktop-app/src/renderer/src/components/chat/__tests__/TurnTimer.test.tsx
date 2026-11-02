/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TurnFeedbackControl } from '@canopy/ui-shared';
import { TurnTimer } from '../TurnTimer';
import { ChatLookProvider } from '@canopy/ui-shared/components/chat-look';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function renderTimer(node: JSX.Element): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<ChatLookProvider value="classic">{node}</ChatLookProvider>);
  });
  return { container, root };
}

function timerLabel(container: HTMLElement): string | null | undefined {
  return container.querySelector('[data-testid="turn-timer-label"]')
    ?.textContent;
}

describe('TurnTimer', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const pendingWorkingLabelCases: Array<{
    name: string;
    workingLabel?: string;
    expectedLabel: string;
  }> = [
    // Auto model routing runs inside main's send, before the turn is accepted,
    // so the whole routing phase is rendered through the pending branch. The
    // label must survive it or "Choosing a model…" never reaches the user.
    {
      name: 'shows the working label while the send is still pending',
      workingLabel: 'Choosing a model…',
      expectedLabel: 'Choosing a model…',
    },
    {
      name: 'keeps the default working label for a pending send without one',
      expectedLabel: 'Working…',
    },
  ];

  it.each(pendingWorkingLabelCases)(
    '$name',
    ({ workingLabel, expectedLabel }): void => {
      const timerProps = workingLabel === undefined ? {} : { workingLabel };
      const { container, root } = renderTimer(
        <TurnTimer pending completedAt={null} {...timerProps} />,
      );

      expect(timerLabel(container)).toBe(expectedLabel);
      act(() => root.unmount());
    },
  );

  it.each(['failed', 'cancelled'] as const)(
    'shows the %s completion outcome in the Clean footer',
    (completionStatus) => {
      const { container, root } = renderTimer(
        <ChatLookProvider value="clean">
          <TurnTimer
            startedAt={0}
            completedAt={60_000}
            {...{ completionStatus }}
          />
        </ChatLookProvider>,
      );
      expect(timerLabel(container)).toBe(
        completionStatus === 'failed'
          ? 'Failed after 1:00'
          : 'Cancelled after 1:00',
      );
      act(() => root.unmount());
    },
  );

  // CAN-4278: desktop timer blocks carry no outcome, so a completed desktop
  // row takes the shared successful-completion default: its timestamp and
  // thumbs stay visible and the rest of the row fades in with its turn.
  describe('row reveal', () => {
    interface Parts {
      row: string[];
      stamp: string[];
      label: string[];
      pinned: string[];
      order: (string | null)[];
    }

    function classesOf(element: Element | null | undefined): string[] {
      return element?.className.split(/\s+/) ?? [];
    }

    function parts(node: JSX.Element): Parts {
      const { container, root } = renderTimer(node);
      const row = container.querySelector('[data-testid="turn-timer"]');
      const pinned = container.querySelector('[data-testid="pinned"]');
      const result = {
        row: classesOf(row),
        stamp: classesOf(
          container.querySelector('[data-testid="turn-timer-relative"]'),
        ),
        label: classesOf(
          container.querySelector('[data-testid="turn-timer-label"]'),
        ),
        pinned: classesOf(pinned?.parentElement),
        order: Array.from(row?.children ?? []).map((child) =>
          child.getAttribute('data-testid'),
        ),
      };
      act(() => root.unmount());
      expect(row).not.toBeNull();
      return result;
    }

    it('keeps the timestamp and fades the rest of a completed row', () => {
      const result = parts(<TurnTimer startedAt={0} completedAt={60_000} />);
      expect(result.row).not.toContain('opacity-0');
      expect(result.stamp).not.toContain('opacity-0');
      expect(result.label).toContain('opacity-0');
      expect(result.label).toContain('group-hover/turn:opacity-100');
      expect(result.label).toContain('group-data-[hover]/turn:opacity-100');
      expect(result.label).toContain('group-focus-within/turn:opacity-100');
    });

    it('keeps the thumbs visible right after the timestamp', () => {
      const result = parts(
        <TurnTimer
          startedAt={0}
          completedAt={60_000}
          showForkAction
          onFork={(): void => undefined}
          feedbackControl={
            <span data-testid="pinned">
              <TurnFeedbackControl onRate={(): void => undefined} />
            </span>
          }
        />,
      );
      expect(result.row).not.toContain('opacity-0');
      expect(result.pinned).not.toContain('opacity-0');
      expect(result.order.slice(0, 3)).toEqual([
        'turn-timer-relative',
        'turn-timer-stamp-accessory',
        'turn-timer-label',
      ]);
      expect(result.label).toContain('opacity-0');
    });

    it('keeps the row visible when alwaysVisible is set', () => {
      const result = parts(
        <TurnTimer startedAt={0} completedAt={60_000} alwaysVisible />,
      );
      expect(result.row).not.toContain('opacity-0');
      expect(result.label).not.toContain('opacity-0');
    });

    it('keeps pending and live rows visible', () => {
      expect(
        parts(<TurnTimer pending completedAt={null} />).label,
      ).not.toContain('opacity-0');
      expect(
        parts(<TurnTimer startedAt={Date.now()} completedAt={null} />).label,
      ).not.toContain('opacity-0');
    });
  });
});
