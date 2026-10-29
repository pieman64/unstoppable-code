/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BackgroundTask } from '@canopy/protocol/background-tasks';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { AgentActivitySection } from '../AgentActivitySection';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const artifactItem = <div key="artifact" data-testid="artifact-card" />;

const backgroundTask: BackgroundTask = {
  id: 'bash-1',
  kind: 'bash',
  status: 'running',
  title: 'npm run dev',
  ownerToolUseId: 'bash-1',
  parentTaskId: null,
  startedAt: 1,
  settledAt: null,
  updatedAt: 2,
  lastDescription: null,
  summary: null,
  outputLines: ['listening on 5173'],
  canStop: true,
};

const stopBackgroundTask = jest.fn().mockResolvedValue(undefined);

describe('AgentActivitySection', () => {
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

  it('renders expanded active activity with count and collapses accessibly', () => {
    act(() =>
      root.render(
        <AgentActivitySection
          artifactItems={[artifactItem]}
          variant="active"
        />,
      ),
    );
    expect(container.textContent).toContain('Agent activity');
    expect(container.textContent).toContain('1 item');
    expect(
      container.querySelector('[data-testid="agent-activity-artifact-items"]')
        ?.className,
    ).toContain('@[880px]:grid-cols-4');
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse agent activity"]',
    );
    if (!toggle) throw new Error('Expected collapse toggle');
    act(() => toggle.click());
    expect(
      container.querySelector('[data-testid="agent-activity-items"]'),
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label="Expand agent activity"]'),
    ).not.toBeNull();
  });

  it.each(['active', 'completed'] as const)(
    'records the %s section header and blocks its agent items from session replay',
    (variant) => {
      act(() =>
        root.render(
          <AgentActivitySection
            artifactItems={[artifactItem]}
            agentItems={[<div key="agent" data-testid="agent-item" />]}
            variant={variant}
          />,
        ),
      );
      const section = container.querySelector(
        `[data-testid="agent-activity-${variant}"]`,
      );
      expect(section?.closest(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
      const items = container.querySelector(
        '[data-testid="agent-activity-items"]',
      );
      expect(items?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
      expect(
        container
          .querySelector('[data-testid="agent-item"]')
          ?.closest(`.${REPLAY_BLOCK_CLASS}`),
      ).toBe(items);
      const heading = Array.from(section?.querySelectorAll('span') ?? []).find(
        (span) => span.textContent === 'Agent activity',
      );
      expect(heading).toBeDefined();
      expect(heading?.closest(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
    },
  );

  it('keeps historical sections collapsed when requested', () => {
    act(() =>
      root.render(
        <AgentActivitySection
          artifactItems={[artifactItem]}
          variant="completed"
          defaultExpanded={false}
        />,
      ),
    );
    expect(
      container.querySelector('[data-testid="agent-activity-items"]'),
    ).toBeNull();
  });

  it('collapses an existing completed section when a newer turn starts', () => {
    act(() =>
      root.render(
        <AgentActivitySection
          artifactItems={[artifactItem]}
          variant="completed"
          defaultExpanded
        />,
      ),
    );
    expect(
      container.querySelector('[data-testid="agent-activity-items"]'),
    ).not.toBeNull();

    act(() =>
      root.render(
        <AgentActivitySection
          artifactItems={[artifactItem]}
          variant="completed"
          defaultExpanded={false}
        />,
      ),
    );
    expect(
      container.querySelector('[data-testid="agent-activity-items"]'),
    ).toBeNull();
  });

  it('renders a section for a turn whose only activity is a background task', () => {
    act(() =>
      root.render(
        <AgentActivitySection
          backgroundTasks={[backgroundTask]}
          backgroundTaskActions={{ stop: stopBackgroundTask }}
          variant="completed"
        />,
      ),
    );
    expect(container.textContent).toContain('Agent activity');
    expect(container.textContent).toContain('1 item');
    expect(
      container.querySelector('[data-testid="agent-activity-artifact-items"]'),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="agent-activity-background-process-items"]',
      )?.textContent,
    ).toContain('npm run dev');
  });
  it('counts background tasks without listing them when host actions are absent', () => {
    act(() =>
      root.render(
        <AgentActivitySection
          backgroundTasks={[backgroundTask]}
          variant="completed"
        />,
      ),
    );
    expect(container.textContent).toContain('1 item');
    expect(
      container.querySelector(
        '[data-testid="agent-activity-background-process-items"]',
      ),
    ).toBeNull();
  });
});

describe('AgentActivitySection Stop all delegates', () => {
  let container: HTMLDivElement;
  let root: Root;
  const delegateItems = [
    <div key="delegate-1" data-testid="delegate-row-1" />,
    <div key="delegate-2" data-testid="delegate-row-2" />,
  ];

  beforeEach(() => {
    stopBackgroundTask.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderSection(
    liveDelegationIds: readonly string[] | undefined,
    onStopAllDelegations?: jest.Mock,
    showOtherActivity = true,
  ): void {
    act(() =>
      root.render(
        <AgentActivitySection
          agentItems={showOtherActivity ? delegateItems : []}
          backgroundTasks={showOtherActivity ? [backgroundTask] : []}
          backgroundTaskActions={{ stop: stopBackgroundTask }}
          variant="active"
          liveDelegationIds={liveDelegationIds}
          onStopAllDelegations={onStopAllDelegations}
        />,
      ),
    );
  }

  function byTestId(testId: string): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`,
    );
  }

  function toggle(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      'button[aria-label$="agent activity"]',
    );
  }

  it('is absent without a live managed delegation', () => {
    renderSection([], jest.fn());
    expect(byTestId('agent-activity-stop-all')).toBeNull();
    // Background tasks alone never offer it.
    expect(
      container.querySelector('[data-testid="activity-bg-stop"]'),
    ).not.toBeNull();
    renderSection(undefined, jest.fn());
    expect(byTestId('agent-activity-stop-all')).toBeNull();
  });

  it('shows Stop all for a foreground-only delegation without an empty item list', () => {
    renderSection(['delegation-1'], jest.fn(), false);

    expect(byTestId('agent-activity-stop-all')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="agent-activity-active"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain('0 items');
    expect(
      container.querySelector('[data-testid="agent-activity-items"]'),
    ).toBeNull();
  });

  it('is absent when the host cannot stop delegations', () => {
    renderSection(['delegation-1']);
    expect(byTestId('agent-activity-stop-all')).toBeNull();
  });

  it('sits beside the collapse toggle, independent of it', () => {
    const onStopAll = jest.fn().mockResolvedValue(true);
    renderSection(['delegation-1', 'delegation-2'], onStopAll);
    const stopAll = byTestId('agent-activity-stop-all');
    expect(stopAll?.textContent).toBe('Stop all delegates');
    expect(stopAll?.closest('button[aria-expanded]')).toBeNull();
    expect(toggle()?.contains(stopAll ?? null)).toBe(false);

    act(() => stopAll?.click());
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    expect(
      container.querySelector('[data-testid="agent-activity-items"]'),
    ).not.toBeNull();

    act(() => byTestId('agent-activity-stop-all-cancel')?.click());
    act(() => toggle()?.click());
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    expect(
      container.querySelector(
        '[data-testid="agent-activity-stop-all-confirmation"]',
      ),
    ).toBeNull();
    expect(byTestId('agent-activity-stop-all')).not.toBeNull();
    expect(onStopAll).not.toHaveBeenCalled();
  });

  it('rests as the classic small destructive action and keeps the destructive chip for the confirm', () => {
    renderSection(['delegation-1'], jest.fn().mockResolvedValue(true));
    const stopAll = byTestId('agent-activity-stop-all');
    const classes = stopAll?.className.split(/\s+/) ?? [];
    expect(classes).toContain('fg-destructive');
    expect(classes).toContain('text-2xs');
    expect(classes).not.toContain('h-7');

    act(() => stopAll?.click());
    expect(byTestId('agent-activity-stop-all-confirm')?.className).toContain(
      'destructive',
    );
  });

  it('asks inline and keeps running on Keep running', () => {
    const onStopAll = jest.fn().mockResolvedValue(true);
    renderSection(['delegation-1', 'delegation-2'], onStopAll);
    act(() => byTestId('agent-activity-stop-all')?.click());
    const confirmation = container.querySelector(
      '[data-testid="agent-activity-stop-all-confirmation"]',
    );
    expect(confirmation?.textContent).toContain('Stop 2 delegations?');
    expect(byTestId('agent-activity-stop-all-confirm')?.textContent).toBe(
      'Stop all',
    );
    expect(byTestId('agent-activity-stop-all-cancel')?.textContent).toBe(
      'Keep running',
    );
    expect(document.activeElement).toBe(
      byTestId('agent-activity-stop-all-cancel'),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    act(() => byTestId('agent-activity-stop-all-cancel')?.click());
    expect(onStopAll).not.toHaveBeenCalled();
    expect(byTestId('agent-activity-stop-all')).not.toBeNull();
    expect(document.activeElement).toBe(byTestId('agent-activity-stop-all'));
  });

  it('uses the singular question for one delegation', () => {
    renderSection(['delegation-1'], jest.fn().mockResolvedValue(true));
    act(() => byTestId('agent-activity-stop-all')?.click());
    expect(
      container.querySelector(
        '[data-testid="agent-activity-stop-all-confirmation"]',
      )?.textContent,
    ).toContain('Stop 1 delegation?');
  });

  it('closes the question on Escape', () => {
    const onStopAll = jest.fn().mockResolvedValue(true);
    renderSection(['delegation-1'], onStopAll);
    act(() => byTestId('agent-activity-stop-all')?.click());
    act(() => {
      byTestId('agent-activity-stop-all-cancel')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(byTestId('agent-activity-stop-all-confirm')).toBeNull();
    expect(onStopAll).not.toHaveBeenCalled();
  });

  it('stops the chat delegations, and only them, on Stop all', async () => {
    let resolveStop: (accepted: boolean) => void = () => undefined;
    const onStopAll = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveStop = resolve;
        }),
    );
    renderSection(['delegation-1', 'delegation-2'], onStopAll);
    act(() => byTestId('agent-activity-stop-all')?.click());
    act(() => byTestId('agent-activity-stop-all-confirm')?.click());
    expect(onStopAll).toHaveBeenCalledTimes(1);
    expect(byTestId('agent-activity-stop-all-confirm')?.textContent).toBe(
      'Stopping…',
    );
    expect(byTestId('agent-activity-stop-all-confirm')?.disabled).toBe(true);
    act(() => byTestId('agent-activity-stop-all-confirm')?.click());
    expect(onStopAll).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveStop(true);
      await Promise.resolve();
    });
    // Accepted: the rows stay until they settle, without offering the same
    // stop again.
    expect(byTestId('agent-activity-stop-all')?.textContent).toBe('Stopping…');
    expect(byTestId('agent-activity-stop-all')?.disabled).toBe(true);
    expect(stopBackgroundTask).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="activity-bg-stop"]'),
    ).not.toBeNull();

    // A delegate started afterwards can be stopped again.
    renderSection(['delegation-1', 'delegation-3'], onStopAll);
    expect(byTestId('agent-activity-stop-all')?.textContent).toBe(
      'Stop all delegates',
    );

    renderSection([], onStopAll);
    expect(byTestId('agent-activity-stop-all')).toBeNull();
  });

  it('offers Stop all again when the stop fails', async () => {
    const onStopAll = jest.fn().mockResolvedValue(false);
    renderSection(['delegation-1'], onStopAll);
    act(() => byTestId('agent-activity-stop-all')?.click());
    await act(async () => {
      byTestId('agent-activity-stop-all-confirm')?.click();
      await Promise.resolve();
    });
    expect(byTestId('agent-activity-stop-all-confirm')).toBeNull();
    expect(byTestId('agent-activity-stop-all')?.textContent).toBe(
      'Stop all delegates',
    );
    expect(byTestId('agent-activity-stop-all')?.disabled).toBe(false);
    expect(document.activeElement).toBe(byTestId('agent-activity-stop-all'));
  });
});
