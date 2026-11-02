/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ArchivedChatSummary } from '@canopy/desktop-shared/types';
import { ArchivedChatRow } from '../ArchivedChatRow';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function makeSummary(
  overrides: Partial<ArchivedChatSummary> = {},
): ArchivedChatSummary {
  return {
    chatId: 'archived-1',
    title: 'Archived chat',
    description: 'A prior conversation',
    providerType: 'claude',
    model: 'claude-sonnet-4-5-20250514',
    turnCount: 3,
    archivedAt: '2026-06-20T00:00:00.000Z',
    createdAt: '2026-06-20T00:00:00.000Z',
    restorable: true,
    unread: false,
    ...overrides,
  };
}

describe('ArchivedChatRow', () => {
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

  function clickTestId(testId: string): void {
    const node = container.querySelector<HTMLElement>(
      `[data-testid="${testId}"]`,
    );
    if (!node) throw new Error(`missing node: ${testId}`);
    act(() => {
      node.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
  }

  function keyDownTestId(testId: string, key: string): void {
    const node = container.querySelector<HTMLElement>(
      `[data-testid="${testId}"]`,
    );
    if (!node) throw new Error(`missing node: ${testId}`);
    act(() => {
      node.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      );
    });
  }

  it('renders the chat label and the model line', () => {
    act(() => {
      root.render(
        createElement(ArchivedChatRow, {
          summary: makeSummary(),
          dataTestId: 'row',
          onOpen: jest.fn(),
          onRestore: jest.fn(),
          onSummarize: jest.fn(),
        }),
      );
    });

    const paragraphs = Array.from(container.querySelectorAll('p'));
    const label = paragraphs.find(
      (node) => node.textContent === 'A prior conversation',
    );
    expect(label).toBeDefined();
    const subLine = paragraphs.find((node) =>
      node.textContent?.includes('3 turns'),
    );
    expect(subLine).toBeDefined();
  });

  it('opens the viewer when the row body is clicked', () => {
    const onOpen = jest.fn();
    const onRestore = jest.fn();
    const onSummarize = jest.fn();
    act(() => {
      root.render(
        createElement(ArchivedChatRow, {
          summary: makeSummary(),
          dataTestId: 'row',
          onOpen,
          onRestore,
          onSummarize,
        }),
      );
    });

    clickTestId('row');
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onRestore).not.toHaveBeenCalled();
    expect(onSummarize).not.toHaveBeenCalled();
  });

  it('does not open the viewer when Restore is clicked', () => {
    const onOpen = jest.fn();
    const onRestore = jest.fn();
    act(() => {
      root.render(
        createElement(ArchivedChatRow, {
          summary: makeSummary(),
          dataTestId: 'row',
          onOpen,
          onRestore,
          onSummarize: jest.fn(),
        }),
      );
    });

    clickTestId('archived-chat-restore');
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('opens the viewer when Enter is pressed on the row', () => {
    const onOpen = jest.fn();
    act(() => {
      root.render(
        createElement(ArchivedChatRow, {
          summary: makeSummary(),
          dataTestId: 'row',
          onOpen,
          onRestore: jest.fn(),
          onSummarize: jest.fn(),
        }),
      );
    });

    keyDownTestId('row', 'Enter');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('does not open the viewer when action key events bubble to the row', () => {
    const onOpen = jest.fn();
    act(() => {
      root.render(
        createElement(ArchivedChatRow, {
          summary: makeSummary(),
          dataTestId: 'row',
          onOpen,
          onRestore: jest.fn(),
          onSummarize: jest.fn(),
        }),
      );
    });

    keyDownTestId('archived-chat-restore', 'Enter');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('does not open the viewer when Summarize is clicked', () => {
    const onOpen = jest.fn();
    const onSummarize = jest.fn();
    act(() => {
      root.render(
        createElement(ArchivedChatRow, {
          summary: makeSummary(),
          dataTestId: 'row',
          onOpen,
          onRestore: jest.fn(),
          onSummarize,
        }),
      );
    });

    clickTestId('archived-chat-summarize');
    expect(onSummarize).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('hides Restore for a non-restorable chat but still opens on row click', () => {
    const onOpen = jest.fn();
    act(() => {
      root.render(
        createElement(ArchivedChatRow, {
          summary: makeSummary({ restorable: false }),
          dataTestId: 'row',
          onOpen,
          onRestore: jest.fn(),
          onSummarize: jest.fn(),
        }),
      );
    });

    expect(
      container.querySelector('[data-testid="archived-chat-restore"]'),
    ).toBeNull();
    clickTestId('row');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('renders the generated description as the primary label and drops the raw title', () => {
    act(() => {
      root.render(
        createElement(ArchivedChatRow, {
          summary: makeSummary({
            title: '$builtin-gh:handle-pr-checks',
            description: 'Handle pull request checks',
          }),
          dataTestId: 'row',
          onOpen: jest.fn(),
          onRestore: jest.fn(),
          onSummarize: jest.fn(),
        }),
      );
    });

    const row = container.querySelector<HTMLElement>('[data-testid="row"]');
    const primary = row?.querySelector<HTMLElement>('p');
    expect(primary?.textContent).toBe('Handle pull request checks');
    expect(primary?.getAttribute('title')).toBe('Handle pull request checks');
    // The raw title is excluded entirely once a generated title exists.
    expect(row?.textContent).not.toContain('$builtin-gh:handle-pr-checks');
    // The description is no longer duplicated into the sub-line.
    expect(row?.textContent).toContain('3 turns');
    expect(row?.textContent?.match(/Handle pull request checks/g)?.length).toBe(
      1,
    );
  });

  it('falls back to the raw title when no description was generated', () => {
    act(() => {
      root.render(
        createElement(ArchivedChatRow, {
          summary: makeSummary({
            title: 'Archive Me',
            description: undefined,
          }),
          dataTestId: 'row',
          onOpen: jest.fn(),
          onRestore: jest.fn(),
          onSummarize: jest.fn(),
        }),
      );
    });

    const primary = container.querySelector<HTMLElement>(
      '[data-testid="row"] p',
    );
    expect(primary?.textContent).toBe('Archive Me');
  });

  it('uses the fixed amber unread color for a provider icon', () => {
    act(() => {
      root.render(
        createElement(ArchivedChatRow, {
          summary: makeSummary({ unread: true }),
          dataTestId: 'row',
          onOpen: jest.fn(),
          onRestore: jest.fn(),
          onSummarize: jest.fn(),
        }),
      );
    });

    const unreadIcon = container.querySelector<HTMLElement>(
      '[data-unread="true"]',
    );
    expect(unreadIcon).not.toBeNull();
    expect(unreadIcon?.classList.contains('text-amber-400')).toBe(true);
    expect(unreadIcon?.classList.contains('fg-warning')).toBe(false);
  });

  it('uses the fixed amber unread color for the fallback dot', () => {
    act(() => {
      root.render(
        createElement(ArchivedChatRow, {
          summary: makeSummary({ providerType: undefined, unread: true }),
          dataTestId: 'row',
          onOpen: jest.fn(),
          onRestore: jest.fn(),
          onSummarize: jest.fn(),
        }),
      );
    });

    const unreadIcon = container.querySelector<HTMLElement>(
      '[data-unread="true"]',
    );
    const unreadDot = unreadIcon?.querySelector<HTMLElement>('span');
    expect(unreadIcon).not.toBeNull();
    expect(unreadDot?.classList.contains('bg-amber-400')).toBe(true);
    expect(unreadDot?.classList.contains('bg-warning')).toBe(false);
  });

  it('does not open the row when a disabled Restore is clicked while busy', () => {
    const onOpen = jest.fn();
    const onRestore = jest.fn();
    act(() => {
      root.render(
        createElement(ArchivedChatRow, {
          summary: makeSummary(),
          dataTestId: 'row',
          onOpen,
          onRestore,
          onSummarize: jest.fn(),
          summarizing: true,
        }),
      );
    });

    const restore = container.querySelector<HTMLButtonElement>(
      '[data-testid="archived-chat-restore"]',
    );
    expect(restore?.disabled).toBe(true);
    clickTestId('archived-chat-restore');
    // A disabled control lets the pointer through (pointer-events: none), so
    // the browser delivers the click to whatever sits beneath the button.
    const beneath = restore?.parentElement;
    expect(beneath).toBeTruthy();
    act(() => {
      beneath?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });

    expect(onOpen).not.toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();
  });
});
