/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  UsageLimitedSessionsControl,
  formatUsageLimitedWaitingDetail,
  formatUsageLimitedWaitingTitle,
  type UsageLimitedSessionsControlState,
  type UsageLimitedWaitingSession,
} from '../UsageLimitedSessionsControl';
import { REPLAY_MASK_CLASS } from '../../lib/replay-privacy';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
  writable: true,
});

const CHAT: UsageLimitedWaitingSession = {
  id: 'chat-1',
  kind: 'chat',
  title: 'Refactor billing',
  subtitle: 'Workspace · main',
};
const PIPELINE: UsageLimitedWaitingSession = {
  id: 'pipeline-1',
  kind: 'pipeline',
  title: 'Nightly review',
};

describe('UsageLimitedSessionsControl', () => {
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
    document.body.innerHTML = '';
  });

  function render(state: UsageLimitedSessionsControlState): void {
    act(() => {
      root.render(
        <UsageLimitedSessionsControl state={state} testIdPrefix="usage-x" />,
      );
    });
  }

  function byTestId(id: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  }

  it('formats singular, plural, and unknown-reset copy', () => {
    expect(formatUsageLimitedWaitingTitle(1)).toBe('1 interrupted session');
    expect(formatUsageLimitedWaitingTitle(2)).toBe('2 interrupted sessions');
    expect(formatUsageLimitedWaitingDetail('Mon 6:13 PM')).toBe(
      'Limit resets at Mon 6:13 PM',
    );
    expect(formatUsageLimitedWaitingDetail(null)).toBe(
      'Reset time unavailable',
    );
  });

  it('opens the single waiting session directly', () => {
    const onOpenSession = jest.fn();
    render({
      kind: 'waiting',
      sessions: [CHAT],
      resetLabel: '6:13 PM',
      onOpenSession,
    });
    // One row: the count, the reset as its quiet line, one action.
    const row = byTestId('usage-x-waiting');
    expect(row?.textContent).toContain('1 interrupted session');
    expect(row?.textContent).toContain('Limit resets at 6:13 PM');
    expect(row?.querySelectorAll('button')).toHaveLength(1);
    // Static prose, not a live region.
    expect(byTestId('usage-x-waiting')?.getAttribute('aria-live')).toBeNull();
    const open = byTestId('usage-x-waiting-open');
    expect(open?.textContent).toBe('Open chat');
    act(() => open?.click());
    expect(onOpenSession).toHaveBeenCalledWith(CHAT);
  });

  it('labels a single pipeline action', () => {
    render({
      kind: 'waiting',
      sessions: [PIPELINE],
      resetLabel: null,
      onOpenSession: jest.fn(),
    });
    expect(byTestId('usage-x-waiting-open')?.textContent).toBe('Open pipeline');
  });

  it('lists every waiting session in a focus-trapped chooser', () => {
    const onOpenSession = jest.fn();
    render({
      kind: 'waiting',
      sessions: [CHAT, PIPELINE],
      resetLabel: null,
      onOpenSession,
    });
    const view = byTestId('usage-x-waiting-view');
    expect(view?.textContent).toBe('View…');
    expect(
      byTestId('usage-x-waiting')?.querySelectorAll('button'),
    ).toHaveLength(1);
    act(() => view?.click());

    expect(byTestId('usage-x-waiting-chooser')).not.toBeNull();
    const chatRow = byTestId('usage-x-waiting-session-chat-1');
    const pipelineRow = byTestId('usage-x-waiting-session-pipeline-1');
    expect(chatRow?.textContent).toContain('Open chat');
    expect(pipelineRow?.textContent).toContain('Open pipeline');
    // Initial focus lands on the first session.
    expect(document.activeElement).toBe(chatRow);
    // User-authored titles are replay-masked.
    expect(chatRow?.querySelector(`.${REPLAY_MASK_CLASS}`)?.textContent).toBe(
      'Refactor billing',
    );

    act(() => pipelineRow?.click());
    expect(onOpenSession).toHaveBeenCalledWith(PIPELINE);
    expect(byTestId('usage-x-waiting-chooser')).toBeNull();
  });

  it('closes the chooser on Escape without opening a session', () => {
    const onOpenSession = jest.fn();
    render({
      kind: 'waiting',
      sessions: [CHAT, PIPELINE],
      resetLabel: null,
      onOpenSession,
    });
    act(() => byTestId('usage-x-waiting-view')?.click());
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(byTestId('usage-x-waiting-chooser')).toBeNull();
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it('contains keyboard focus and restores the trigger on dismissal', () => {
    render({
      kind: 'waiting',
      sessions: [CHAT, PIPELINE],
      resetLabel: null,
      onOpenSession: jest.fn(),
    });
    const trigger = byTestId('usage-x-waiting-view');
    trigger?.focus();
    act(() => trigger?.click());
    const dialog = byTestId('usage-x-waiting-chooser');
    const buttons = dialog?.querySelectorAll<HTMLButtonElement>('button');
    const first = buttons?.[0];
    const last = buttons?.[buttons.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    last?.focus();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(document.activeElement).toBe(first);
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(document.activeElement).toBe(last);
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(trigger);
  });

  it('restores the trigger when opening a session leaves no focused destination', () => {
    const onOpenSession = jest.fn();
    render({
      kind: 'waiting',
      sessions: [CHAT, PIPELINE],
      resetLabel: null,
      onOpenSession,
    });
    const trigger = byTestId('usage-x-waiting-view');
    trigger?.focus();
    act(() => trigger?.click());
    act(() => byTestId('usage-x-waiting-session-chat-1')?.click());
    expect(onOpenSession).toHaveBeenCalledWith(CHAT);
    expect(byTestId('usage-x-waiting-chooser')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
