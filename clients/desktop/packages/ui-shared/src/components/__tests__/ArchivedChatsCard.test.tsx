/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { REPLAY_MASK_CLASS } from '../../lib/replay-privacy';
import {
  ArchivedChatsCard,
  type ArchivedChatsCardItem,
  type ArchivedChatsCardProps,
} from '../ArchivedChatsCard';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const RESTORABLE: ArchivedChatsCardItem = {
  id: 'a',
  title: 'Remove email under name in account menu',
  meta: 'Opus 5.5 · 10 turns',
  icon: <svg data-testid="provider-mark" />,
  restorable: true,
};

const ITEMS: ArchivedChatsCardItem[] = [
  RESTORABLE,
  {
    id: 'b',
    title: 'Audit the sidebar spacing',
    meta: 'Opus 5.5 · 7 turns',
    restorable: false,
    unread: true,
  },
];

describe('ArchivedChatsCard', () => {
  let container: HTMLDivElement;
  let root: Root;
  const calls: string[] = [];

  function render(overrides: Partial<ArchivedChatsCardProps> = {}): void {
    act(() => {
      root.render(
        <ArchivedChatsCard
          items={ITEMS}
          overflowCount={0}
          onOpen={(id) => calls.push(`open:${id}`)}
          onRestore={(id) => calls.push(`restore:${id}`)}
          onSummarize={(id) => calls.push(`summarize:${id}`)}
          onShowAll={() => calls.push('show-all')}
          {...overrides}
        />,
      );
    });
  }

  const rows = (): HTMLElement[] =>
    Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="chat-tab-archive-popover-row"]',
      ),
    );

  beforeEach(() => {
    calls.length = 0;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('labels the card in sentence case on the shared menu surface', () => {
    render();
    const surface = container.firstElementChild;
    expect(surface?.getAttribute('aria-label')).toBe('Archived chats');
    expect(surface?.className).toContain('rounded-lg');
    expect(surface?.className).toContain('bg-quaternary');
    expect(surface?.className).toContain('shadow-xl');
    expect(surface?.className).not.toContain('border');
    expect(container.textContent).toContain('Archived chats');
    expect(container.innerHTML).not.toContain('uppercase');
  });

  it('shows each chat with its title, facts and mark, with no title tooltip', () => {
    render();
    expect(rows()).toHaveLength(2);
    const [first, second] = rows();
    expect(first?.dataset.archivedChatId).toBe('a');
    expect(first?.textContent).toContain(
      'Remove email under name in account menu',
    );
    expect(first?.textContent).toContain('Opus 5.5 · 10 turns');
    expect(
      first?.querySelector('[data-testid="provider-mark"]'),
    ).toBeInstanceOf(Element);
    expect(first?.querySelector('[title]')).toBeNull();
    expect(first?.getElementsByClassName(REPLAY_MASK_CLASS)).toHaveLength(1);
    // The unread chat's mark takes the shared unread ink.
    expect(second?.querySelector('[data-unread="true"]')?.className).toContain(
      'fg-info',
    );
  });

  it('opens a chat from its row and acts from its icon buttons', () => {
    render();
    const [first] = rows();
    act(() => first?.querySelector('button')?.click());
    act(() =>
      first
        ?.querySelector<HTMLButtonElement>(
          '[data-testid="archived-chat-restore"]',
        )
        ?.click(),
    );
    act(() =>
      first
        ?.querySelector<HTMLButtonElement>(
          '[data-testid="archived-chat-summarize"]',
        )
        ?.click(),
    );
    expect(calls).toEqual(['open:a', 'restore:a', 'summarize:a']);
  });

  it('draws the actions as ghost icon buttons with 1.5px lines and names them', () => {
    render();
    const restore = rows()[0]?.querySelector<HTMLButtonElement>(
      '[data-testid="archived-chat-restore"]',
    );
    expect(restore?.getAttribute('aria-label')).toBe('Restore chat');
    expect(restore?.className).toContain('rounded-full');
    expect(restore?.className).toContain('hover:bg-subtle');
    expect(restore?.className).not.toContain('fg-accent');
    // 1.5px drawn on the 14px glyph: 1.5 × 24 / 14 viewBox units.
    expect(
      Number.parseFloat(restore?.querySelector('svg')?.style.strokeWidth ?? ''),
    ).toBeCloseTo((1.5 * 24) / 14);
  });

  it('offers Restore only while the chat is still restorable', () => {
    render();
    expect(rows()).toHaveLength(2);
    const [first, second] = rows();
    expect(
      first?.querySelector('[data-testid="archived-chat-restore"]'),
    ).toBeInstanceOf(Element);
    expect(
      second?.querySelector('[data-testid="archived-chat-restore"]'),
    ).toBeNull();
    expect(
      second?.querySelector('[data-testid="archived-chat-summarize"]'),
    ).toBeInstanceOf(Element);
  });

  it('marks both actions busy while a request runs and ignores presses', () => {
    render({ items: [{ ...RESTORABLE, restoring: true }] });
    const [first] = rows();
    const restore = first?.querySelector<HTMLButtonElement>(
      '[data-testid="archived-chat-restore"]',
    );
    const summarize = first?.querySelector<HTMLButtonElement>(
      '[data-testid="archived-chat-summarize"]',
    );
    expect(restore?.getAttribute('aria-disabled')).toBe('true');
    expect(summarize?.getAttribute('aria-disabled')).toBe('true');
    act(() => restore?.click());
    act(() => summarize?.click());
    expect(calls).toEqual([]);
  });

  it('opens the full list from the trailing row only when more are archived', () => {
    render();
    expect(
      container.querySelector('[data-testid="chat-tab-archive-more"]'),
    ).toBeNull();
    render({ overflowCount: 6 });
    const more = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-tab-archive-more"]',
    );
    expect(more?.textContent).toBe('6 more…');
    act(() => more?.click());
    expect(calls).toEqual(['show-all']);
  });
});
