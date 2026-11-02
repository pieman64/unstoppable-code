/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { ContinueSection, type ContinueSectionProps } from '../ContinueSection';
import type { ContinueAttentionItem } from '../continue-attention';

/** Opens the section's ••• menu and picks Hide section. */
function clickHideSection(root: ParentNode = document): void {
  const trigger = root.querySelector<HTMLButtonElement>(
    '[data-testid^="home-section-more-"]',
  );
  if (!trigger) throw new Error('Missing section menu');
  trigger.focus();
  act(() => trigger.click());
  const menu = document.getElementById(
    trigger.getAttribute('aria-controls') ?? '',
  );
  const hide = menu?.querySelector<HTMLElement>(
    '[data-testid^="home-section-hide-"]',
  );
  if (!hide) throw new Error('Missing Hide section');
  act(() => hide.click());
}

const question: ContinueAttentionItem = {
  kind: 'question',
  target: {
    kind: 'chat',
    workspaceId: 'ws-1',
    worktreeId: 'wt-b',
    chatId: 'chat-b',
  },
  workspaceName: 'Secret Workspace',
  worktreeName: 'Worktree B',
  chatTitle: 'Question chat',
};

function unread(chatId: string, eventAt: number): ContinueAttentionItem {
  return {
    kind: 'unread',
    target: { kind: 'chat', workspaceId: 'ws-1', worktreeId: 'wt-c', chatId },
    workspaceName: 'Secret Workspace',
    worktreeName: 'Worktree C',
    chatTitle: `Result ${chatId}`,
    eventAt,
    completed: true,
  };
}

const fallback: ContinueAttentionItem = {
  kind: 'unread',
  target: { kind: 'worktree', workspaceId: 'ws-1', worktreeId: 'wt-d' },
  workspaceName: 'Secret Workspace',
  worktreeName: 'Worktree D',
};

const lastViewed = {
  workspaceId: 'ws-1',
  worktreeId: 'wt-a',
  destinationName: 'Worktree A',
  workspaceName: 'Secret Workspace',
};

describe('ContinueSection', () => {
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

  function render(element: JSX.Element): void {
    act(() => root.render(element));
  }

  function renderSection(props: Partial<ContinueSectionProps> = {}): void {
    render(
      <ContinueSection
        attention={[]}
        onOpenAttention={(): void => {}}
        {...props}
      />,
    );
  }

  function testIds(): string[] {
    return Array.from(container.querySelectorAll('[data-testid]')).map(
      (element) => element.getAttribute('data-testid') ?? '',
    );
  }

  it('renders nothing without visible content', () => {
    renderSection();

    expect(container.innerHTML).toBe('');
  });

  it('temporarily closes Continue without dismissing interrupted work and restores it', () => {
    const dismiss = jest.fn();
    renderSection({
      interrupted: { count: 2, onResume: jest.fn(), onDismiss: dismiss },
    });
    clickHideSection(container);
    expect(testIds()).not.toContain('home-resume-card');
    expect(dismiss).not.toHaveBeenCalled();
    const restore = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Show Continue',
    );
    expect(restore).toBeDefined();
    act(() => restore?.click());
    expect(testIds()).toContain('home-interrupted-sessions-banner');
  });

  it('orders interrupted, needs input, unread, then Last viewed', () => {
    renderSection({
      attention: [unread('chat-c', 2), question],
      lastViewed,
      onOpenLastViewed: (): void => {},
      interrupted: { count: 2, onResume: jest.fn(), onDismiss: jest.fn() },
    });

    const order = testIds().filter((id) =>
      [
        'home-interrupted-sessions-banner',
        'home-continue-question-row',
        'home-continue-unread-row',
        'home-resume-details',
      ].includes(id),
    );
    expect(order).toEqual([
      'home-interrupted-sessions-banner',
      'home-continue-question-row',
      'home-continue-unread-row',
      'home-resume-details',
    ]);
    expect(
      container.querySelector('[data-testid="home-resume-button"]')
        ?.textContent,
    ).toContain('Last viewed: Worktree A');
  });

  it('lets the icon say an unread row finished, with no summary heading', () => {
    renderSection({ attention: [unread('chat-c', 2), fallback] });

    expect(testIds()).not.toContain('home-continue-unread-summary');
    expect(container.textContent).not.toMatch(/\d+ chats? finished/);
    const statuses = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="home-continue-unread-row"] [data-testid="home-continue-attention-subject"] + span',
      ),
    );
    // Screen readers still hear "finished" / "has unread updates".
    expect(statuses.map((status) => status.textContent)).toEqual([
      'finished',
      'has unread updates',
    ]);
    expect(statuses.every((status) => status.className === 'sr-only')).toBe(
      true,
    );
  });

  it('sizes every row icon the same', () => {
    renderSection({
      attention: [question, unread('chat-c', 2), fallback],
      lastViewed,
      onOpenLastViewed: (): void => {},
      interrupted: { count: 2, onResume: jest.fn(), onDismiss: jest.fn() },
    });

    const icons = Array.from(
      container.querySelectorAll(
        [
          'home-interrupted-sessions-resume',
          'home-continue-attention-button',
          'home-resume-button',
        ]
          .map((id) => `[data-testid="${id}"] svg`)
          .join(', '),
      ),
    );
    expect(icons).toHaveLength(5);
    expect(
      new Set(
        icons.map(
          (icon) =>
            `${icon.getAttribute('width')}x${icon.getAttribute('height')}`,
        ),
      ),
    ).toEqual(new Set(['14pxx14px']));
  });

  it('names the chat and worktree and opens the exact item', () => {
    const onOpenAttention = jest.fn();
    renderSection({ attention: [question], onOpenAttention });

    const row = container.querySelector<HTMLElement>(
      '[data-testid="home-continue-question-row"]',
    );
    expect(row?.textContent).toContain(
      'Question chat is waiting for your answer',
    );
    expect(row?.textContent).toContain('Worktree B · Secret Workspace');
    expect(row?.dataset.chatId).toBe('chat-b');
    expect(row?.dataset.worktreeId).toBe('wt-b');

    act(() => {
      row
        ?.querySelector<HTMLButtonElement>('button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenAttention).toHaveBeenCalledWith(question);
  });

  it('does not advertise a chat id on worktree fallbacks', () => {
    renderSection({ attention: [fallback] });

    const row = container.querySelector<HTMLElement>(
      '[data-testid="home-continue-unread-row"]',
    );
    expect(row?.dataset.targetKind).toBe('worktree');
    expect(row?.hasAttribute('data-chat-id')).toBe(false);
    expect(row?.textContent).toContain('Worktree D has unread updates');
  });

  it('caps unread rows behind the overflow link and keeps them reachable', () => {
    const onOpenUnreadOverflow = jest.fn();
    const rows = [1, 2, 3, 4].map((n) => unread(`chat-${n}`, n));
    renderSection({ attention: rows, onOpenUnreadOverflow });

    expect(
      container.querySelectorAll('[data-testid="home-continue-unread-row"]'),
    ).toHaveLength(3);
    const overflow = container.querySelector<HTMLButtonElement>(
      '[data-testid="home-continue-unread-overflow"]',
    );
    expect(overflow?.textContent).toBe('See 1 more unread result');
    act(() => {
      overflow?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenUnreadOverflow).toHaveBeenCalledTimes(1);

    renderSection({ attention: rows });
    expect(
      container.querySelectorAll('[data-testid="home-continue-unread-row"]'),
    ).toHaveLength(4);
    expect(
      container.querySelector('[data-testid="home-continue-unread-overflow"]'),
    ).toBeNull();
  });

  it('hides Last viewed while attention leads to the same worktree', () => {
    renderSection({
      attention: [
        { ...question, target: { ...question.target, worktreeId: 'wt-a' } },
      ],
      lastViewed,
    });

    expect(
      container.querySelector('[data-testid="home-resume-details"]'),
    ).toBeNull();
  });

  it('names host-known activity on Last viewed only when supplied', () => {
    const activity = (): string | null | undefined =>
      container.querySelector('[data-testid="home-resume-activity"]')
        ?.textContent;
    renderSection({ attention: [], lastViewed });
    expect(activity()).toBeUndefined();

    renderSection({
      attention: [],
      lastViewed: { ...lastViewed, activity: 'Agent working' },
    });
    expect(activity()).toBe('· Agent working');
    expect(
      container.querySelector('[data-testid="home-resume-button"]')
        ?.textContent,
    ).toContain('Agent working');
  });

  it('masks user-authored names and labels the section by its heading', () => {
    renderSection({ attention: [question], lastViewed });

    const subject = container.querySelector(
      '[data-testid="home-continue-attention-subject"]',
    );
    const destination = container.querySelector(
      '[data-testid="home-resume-destination"]',
    );
    expect(subject?.classList.contains(REPLAY_MASK_CLASS)).toBe(true);
    expect(destination?.classList.contains(REPLAY_MASK_CLASS)).toBe(true);
    const buttons = Array.from(container.querySelectorAll('button')).filter(
      (button) => !button.dataset.testid?.startsWith('home-section-more-'),
    );
    expect(buttons.every((button) => !button.hasAttribute('aria-label'))).toBe(
      true,
    );

    const section = container.querySelector('section');
    const headingId = section?.getAttribute('aria-labelledby') ?? '';
    expect(document.getElementById(headingId)?.textContent).toBe('Continue');
  });

  it('gives simultaneous mounts unique heading ids', () => {
    render(
      <>
        <ContinueSection attention={[question]} onOpenAttention={jest.fn()} />
        <ContinueSection attention={[question]} onOpenAttention={jest.fn()} />
      </>,
    );

    const labels = Array.from(container.querySelectorAll('section')).map(
      (section) => section.getAttribute('aria-labelledby'),
    );
    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
  });

  it('dismisses the interrupted row through the host', () => {
    const onDismiss = jest.fn();
    renderSection({
      interrupted: { count: 1, onResume: jest.fn(), onDismiss },
    });

    expect(container.textContent).toContain('Resume 1 interrupted session');
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="home-interrupted-sessions-dismiss"]',
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  describe('named interrupted session', () => {
    function click(testId: string): void {
      act(() => {
        container
          .querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    }

    function named(
      overrides: Partial<
        NonNullable<NonNullable<ContinueSectionProps['interrupted']>['session']>
      > = {},
      handlers: { onResume?: () => void; onDismiss?: () => void } = {},
    ): ContinueSectionProps['interrupted'] {
      return {
        count: 1,
        label: 'Resume 1 interrupted session',
        accessibleLabel: 'Resume 1 interrupted session',
        onResume: handlers.onResume ?? jest.fn(),
        onDismiss: handlers.onDismiss ?? jest.fn(),
        session: {
          title: 'Fix checkout',
          prefix: 'Resume',
          worktreeName: 'Worktree A',
          workspaceName: 'Secret Workspace',
          mergeTarget: { workspaceId: 'ws-1', worktreeId: 'wt-a' },
          onOpen: jest.fn(),
          ...overrides,
        },
      };
    }

    function text(testId: string): string | null | undefined {
      return container.querySelector(`[data-testid="${testId}"]`)?.textContent;
    }

    it('names the chat and its context, masked, with its text as the name', () => {
      renderSection({ interrupted: named() });
      expect(text('home-interrupted-sessions-title')).toBe('Fix checkout');
      expect(text('home-interrupted-sessions-context')).toBe(
        'Interrupted · Worktree A · Secret Workspace',
      );
      expect(text('home-interrupted-sessions-details')).toBe(
        'Resume Fix checkout Interrupted · Worktree A · Secret Workspace',
      );
      for (const testId of [
        'home-interrupted-sessions-title',
        'home-interrupted-sessions-context',
      ]) {
        expect(
          container
            .querySelector(`[data-testid="${testId}"]`)
            ?.classList.contains(REPLAY_MASK_CLASS),
        ).toBe(true);
      }
      expect(
        container
          .querySelector('[data-testid="home-interrupted-sessions-resume"]')
          ?.hasAttribute('aria-label'),
      ).toBe(false);
    });

    it('reads a waiting entry without claiming it can resume now', () => {
      renderSection({
        interrupted: named({
          prefix: undefined,
          suffix: 'waiting for Codex reset (Mon 6:13 PM)',
        }),
      });
      expect(text('home-interrupted-sessions-details')).toMatch(
        /^Fix checkout waiting for Codex reset \(Mon 6:13 PM\) Interrupted/,
      );
    });

    it('labels a pipeline and leaves out missing context segments', () => {
      renderSection({
        interrupted: named({
          title: 'Release',
          kindLabel: 'Workflow',
          worktreeName: undefined,
          mergeTarget: undefined,
          onOpen: undefined,
        }),
      });
      expect(text('home-interrupted-sessions-context')).toBe(
        'Interrupted · Workflow · Secret Workspace',
      );
      expect(testIds()).not.toContain('home-interrupted-sessions-open');
    });

    it('keeps the count copy without a named session', () => {
      renderSection({ interrupted: named(), lastViewed });
      renderSection({
        interrupted: {
          count: 1,
          label: 'Resume 1 interrupted session',
          accessibleLabel: 'Resume 1 interrupted session',
          onResume: jest.fn(),
          onDismiss: jest.fn(),
          session: null,
        },
        lastViewed,
      });
      expect(text('home-interrupted-sessions-details')).toBe(
        'Resume 1 interrupted session',
      );
      expect(testIds()).not.toContain('home-interrupted-sessions-title');
      expect(testIds()).toContain('home-resume-details');
    });

    it('replaces a Last viewed row for the same worktree only', () => {
      renderSection({ interrupted: named(), lastViewed });
      expect(testIds()).not.toContain('home-resume-details');

      renderSection({
        interrupted: named({
          mergeTarget: { workspaceId: 'ws-2', worktreeId: 'wt-a' },
        }),
        lastViewed,
      });
      expect(testIds()).toContain('home-resume-details');
    });

    it('opens, resumes, and dismisses through separate sibling controls', () => {
      const onOpen = jest.fn();
      const onResume = jest.fn();
      const onDismiss = jest.fn();
      renderSection({
        interrupted: named({ onOpen }, { onResume, onDismiss }),
      });
      const open = container.querySelector(
        '[data-testid="home-interrupted-sessions-open"]',
      );
      expect(open?.textContent).toBe('Open');
      expect(
        open?.closest('[data-testid="home-interrupted-sessions-resume"]'),
      ).toBeNull();
      expect(
        container
          .querySelector('[data-testid="home-interrupted-sessions-resume"]')
          ?.className.split(' '),
      ).toContain('pr-28');

      click('home-interrupted-sessions-open');
      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(onResume).not.toHaveBeenCalled();

      click('home-interrupted-sessions-dismiss');
      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(onResume).not.toHaveBeenCalled();

      click('home-interrupted-sessions-resume');
      expect(onResume).toHaveBeenCalledTimes(1);
      expect(onOpen).toHaveBeenCalledTimes(1);
    });
  });

  it('shows a Last viewed chat title as secondary text, never twice', () => {
    renderSection({ lastViewed: { ...lastViewed, chatTitle: 'Fix checkout' } });
    const title = container.querySelector(
      '[data-testid="home-resume-chat-title"]',
    );
    expect(title?.textContent).toBe('Fix checkout');
    expect(title?.parentElement?.classList.contains(REPLAY_MASK_CLASS)).toBe(
      true,
    );
    expect(title?.parentElement?.textContent).toBe(
      'Fix checkout · Secret Workspace',
    );

    renderSection({
      lastViewed: { ...lastViewed, chatTitle: lastViewed.destinationName },
    });
    expect(testIds()).not.toContain('home-resume-chat-title');
  });

  it('shows a branch after the chat title and before the workspace', () => {
    renderSection({
      lastViewed: {
        ...lastViewed,
        destinationName: 'Label checkout form inputs',
        worktreeName: 'checkout-form-labels',
      },
    });
    const branch = container.querySelector(
      '[data-testid="home-resume-worktree-name"]',
    );
    expect(branch?.textContent).toBe('checkout-form-labels');
    expect(branch?.parentElement?.classList.contains(REPLAY_MASK_CLASS)).toBe(
      true,
    );
    expect(branch?.parentElement?.textContent).toBe(
      'checkout-form-labels · Secret Workspace',
    );

    renderSection({
      lastViewed: {
        ...lastViewed,
        chatTitle: 'Fix checkout',
        worktreeName: 'checkout-form-labels',
      },
    });
    expect(
      container.querySelector('[data-testid="home-resume-chat-title"]')
        ?.parentElement?.textContent,
    ).toBe('Fix checkout · checkout-form-labels · Secret Workspace');
  });

  it('leaves out blank and repeated secondary names without stray separators', () => {
    renderSection({
      lastViewed: {
        ...lastViewed,
        chatTitle: '  ',
        worktreeName: lastViewed.destinationName,
      },
    });
    expect(testIds()).not.toContain('home-resume-chat-title');
    expect(testIds()).not.toContain('home-resume-worktree-name');
    expect(
      container.querySelector('[data-testid="home-resume-destination"]')
        ?.nextElementSibling?.textContent,
    ).toBe('Secret Workspace');

    renderSection({
      lastViewed: {
        ...lastViewed,
        chatTitle: 'Fix checkout',
        worktreeName: ' Fix checkout ',
      },
    });
    expect(testIds()).not.toContain('home-resume-worktree-name');
    expect(
      container.querySelector('[data-testid="home-resume-chat-title"]')
        ?.parentElement?.textContent,
    ).toBe('Fix checkout · Secret Workspace');
  });
});
