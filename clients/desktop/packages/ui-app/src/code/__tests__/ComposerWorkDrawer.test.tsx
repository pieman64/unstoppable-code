/** @jest-environment jsdom */
import { act, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { DialogModal } from '@canopy/ui-shared/components';
import { createRoot, type Root } from 'react-dom/client';
import {
  ComposerWorkDrawer,
  type ComposerWorkDrawerBackground,
} from '../ComposerWorkDrawer';
import { StopAllDelegatesControl } from '../agent-activity/StopAllDelegatesControl';
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});
describe('ComposerWorkDrawer', () => {
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
  const background: ComposerWorkDrawerBackground = {
    count: 5,
    needsYou: 1,
    running: 2,
    watching: 1,
    sections: {
      needsYou: <p>Plan review</p>,
      running: <p>Test runner</p>,
      watching: <p>GitHub CI</p>,
      completed: <button>View completed 1</button>,
    },
  };
  const toggle = (): HTMLButtonElement | null =>
    container.querySelector('[data-testid="composer-work-drawer-toggle"]');
  it('draws nothing without queued or background work', () => {
    act(() => root.render(<ComposerWorkDrawer queuedCount={0} />));
    expect(container.textContent).toBe('');
  });
  it('shows all groups together in priority order with separate watching counts', () => {
    act(() =>
      root.render(
        <ComposerWorkDrawer
          queuedCount={4}
          background={background}
          queuedPanel={<p>Queued prompt</p>}
        />,
      ),
    );
    expect(
      Array.from(container.querySelectorAll('[data-work-group]')).map((node) =>
        node.getAttribute('data-work-group'),
      ),
    ).toEqual(['Needs you', 'Queued', 'Running', 'Watching']);
    expect(toggle()?.textContent).toContain('Queued4');
    expect(toggle()?.textContent).toContain('Running2');
    expect(toggle()?.textContent).toContain('Watching1');
    expect(toggle()?.textContent).toContain('Needs you 1');
    expect(container.textContent).toContain('Queued prompt');
    expect(container.textContent).toContain('Test runner');
  });
  it('announces visible counts, attention-only work, and later updates', () => {
    act(() =>
      root.render(
        <ComposerWorkDrawer
          queuedCount={4}
          background={{ ...background, pullRequests: 3 }}
        />,
      ),
    );
    expect(toggle()?.getAttribute('aria-label')).toBe(
      'Hide work: Queued 4, Running 2, Pull requests 3, Watching 1, Needs you 1',
    );
    act(() => toggle()?.click());
    act(() =>
      root.render(
        <ComposerWorkDrawer
          queuedCount={0}
          background={{ count: 2, running: 0, needsYou: 2 }}
        />,
      ),
    );
    expect(toggle()?.getAttribute('aria-label')).toBe('Show work: Needs you 2');
  });
  it('puts Needs you beside its glyph when it is the only work, and at the end otherwise', () => {
    const attention = (): string | null | undefined =>
      container.querySelector('[data-testid="composer-work-summary-attention"]')
        ?.textContent;
    act(() =>
      root.render(
        <ComposerWorkDrawer
          queuedCount={0}
          background={{ count: 1, running: 0, needsYou: 1 }}
        />,
      ),
    );
    expect(attention()).not.toContain('Needs you');
    expect(toggle()?.textContent).toContain('Needs you 1');
    act(() =>
      root.render(
        <ComposerWorkDrawer queuedCount={0} background={background} />,
      ),
    );
    expect(attention()).toContain('Needs you 1');
  });
  it('dismisses from the resting Stop all control but leaves its confirmation first', () => {
    act(() =>
      root.render(
        <ComposerWorkDrawer
          queuedCount={0}
          defaultExpanded
          background={{
            ...background,
            sections: {
              needsYou: null,
              running: null,
              watching: null,
              completed: null,
              controls: (
                <StopAllDelegatesControl
                  appearance="section"
                  liveDelegationIds={['one', 'two']}
                  onStopAll={() => Promise.resolve(true)}
                  testId="stop-all"
                />
              ),
            },
          }}
        />,
      ),
    );
    const action = container.querySelector<HTMLButtonElement>(
      '[data-testid="stop-all"]',
    );
    act(() => action?.click());
    act(() => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="stop-all-cancel"]')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    action?.focus();
    act(() => {
      action?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle());
  });
  it('keeps delegate controls available beside Needs you when no work is running', () => {
    act(() =>
      root.render(
        <ComposerWorkDrawer
          queuedCount={0}
          background={{
            count: 2,
            needsYou: 2,
            running: 0,
            sections: {
              needsYou: <p>Awaiting approvals</p>,
              running: null,
              watching: null,
              completed: null,
              controls: <button>View tree</button>,
            },
          }}
        />,
      ),
    );
    act(() => toggle()?.click());
    expect(
      container.querySelector('[data-work-group="Needs you"]')?.textContent,
    ).toContain('View tree');
  });
  it('keeps the queue slot mounted while collapsed and makes the content inert', () => {
    const slot = jest.fn();
    act(() =>
      root.render(
        <ComposerWorkDrawer
          queuedCount={1}
          queuedPanelRef={slot}
          background={background}
        />,
      ),
    );
    const before = container.querySelector(
      '[data-testid="composer-work-drawer-queued"]',
    );
    act(() => toggle()?.click());
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    expect(
      container.querySelector('[data-testid="composer-work-drawer-queued"]'),
    ).toBe(before);
    expect(before?.closest('[inert]')).not.toBeNull();
    act(() => toggle()?.click());
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
  });
  it.each(['confirming', 'sending'] as const)(
    'preserves a %s Stop all action when delegates move between headings',
    async (phase) => {
      let accept: (accepted: boolean) => void = (): void => {};
      const onStopAll = jest.fn(
        () =>
          new Promise<boolean>((resolve) => {
            accept = resolve;
          }),
      );
      const render = (running: number): void => {
        act(() =>
          root.render(
            <ComposerWorkDrawer
              queuedCount={1}
              queuedPanel={<p>Queued prompt</p>}
              background={{
                count: 2,
                running,
                needsYou: 2 - running,
                sections: {
                  needsYou: <p>Awaiting approval</p>,
                  running: running > 0 ? <p>Running delegate</p> : null,
                  watching: null,
                  completed: <button>View completed 1</button>,
                  controls: (
                    <StopAllDelegatesControl
                      appearance="section"
                      liveDelegationIds={['one', 'two']}
                      onStopAll={onStopAll}
                      testId="stop-all"
                    />
                  ),
                },
              }}
            />,
          ),
        );
      };
      const click = (id: string): void => {
        act(() =>
          document
            .querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)
            ?.click(),
        );
      };
      render(1);
      click('stop-all');
      if (phase === 'sending') click('stop-all-confirm');
      render(0);
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(
        container.querySelector(
          '[data-work-group="Needs you"] [data-testid="stop-all"]',
        ),
      ).not.toBeNull();
      render(1);
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      if (phase === 'confirming') click('stop-all-confirm');
      click('stop-all-confirm');
      expect(onStopAll).toHaveBeenCalledTimes(1);
      await act(async () => {
        accept(true);
        await Promise.resolve();
      });
      render(0);
      const action = container.querySelector<HTMLButtonElement>(
        '[data-testid="stop-all"]',
      );
      expect(action?.disabled).toBe(true);
      expect(action?.textContent).toContain('Stopping');
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    },
  );
  it('opens on the first queued message but not on background updates', () => {
    act(() =>
      root.render(
        <ComposerWorkDrawer queuedCount={0} background={background} />,
      ),
    );
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    act(() =>
      root.render(
        <ComposerWorkDrawer queuedCount={1} background={background} />,
      ),
    );
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    act(() => toggle()?.click());
    act(() =>
      root.render(
        <ComposerWorkDrawer
          queuedCount={2}
          background={{ ...background, running: 3 }}
        />,
      ),
    );
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
  });
  it('leaves Escape to an open dialog even when focus remains on a drawer action', () => {
    const onClose = jest.fn();
    act(() =>
      root.render(
        <>
          <ComposerWorkDrawer
            queuedCount={1}
            queuedPanel={<button data-testid="row">Open output</button>}
          />
          <DialogModal title="Task output" onClose={onClose}>
            <p>Output</p>
          </DialogModal>
        </>,
      ),
    );
    const row = container.querySelector<HTMLButtonElement>(
      '[data-testid="row"]',
    );
    row?.focus();
    act(() => {
      row?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
  });

  it('closes with Escape and returns focus to the summary', () => {
    act(() =>
      root.render(
        <ComposerWorkDrawer
          queuedCount={1}
          queuedPanel={<button data-testid="row">Steer</button>}
        />,
      ),
    );
    const row = container.querySelector<HTMLButtonElement>(
      '[data-testid="row"]',
    );
    row?.focus();
    act(() => {
      row?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle());
  });

  it.each(['plain', 'claimed', 'dragging'] as const)(
    'handles Escape from a %s portaled queue without stealing nested cancellation',
    (mode) => {
      function PortalQueue(): JSX.Element {
        const [slot, setSlot] = useState<HTMLDivElement | null>(null);
        return (
          <>
            <ComposerWorkDrawer queuedCount={1} queuedPanelRef={setSlot} />
            {slot &&
              createPortal(
                <div data-dragging={mode === 'dragging' ? '' : undefined}>
                  <button
                    data-testid="portaled-queue-action"
                    onKeyDown={(event): void => {
                      if (mode === 'claimed') event.preventDefault();
                    }}
                  >
                    Queue action
                  </button>
                </div>,
                slot,
              )}
          </>
        );
      }
      act(() => root.render(<PortalQueue />));
      const action = container.querySelector<HTMLButtonElement>(
        '[data-testid="portaled-queue-action"]',
      );
      action?.focus();
      act(() => {
        action?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(toggle()?.getAttribute('aria-expanded')).toBe(
        mode === 'plain' ? 'false' : 'true',
      );
      expect(document.activeElement).toBe(mode === 'plain' ? toggle() : action);
    },
  );
});
