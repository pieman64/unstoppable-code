/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { UsageLimitedSessionGroup } from '@canopy/desktop-shared/types';
import type { InterruptedSessionsSummary } from '@/lib/interruptedSessions';
import { useInterruptedSessions } from '../useInterruptedSessions';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function chatGroup(workspaceId: string): UsageLimitedSessionGroup {
  return {
    groupId: workspaceId,
    groupKind: 'workspace',
    workspaceId,
    workspaceName: workspaceId,
    sessions: [
      {
        kind: 'chat',
        projectId: workspaceId,
        worktreeId: 'wt',
        chatId: `${workspaceId}-chat`,
        provider: 'claude',
        detectedAt: 1,
        workspaceName: workspaceId,
        chatTitle: 'Chat',
        worktreeName: 'wt',
      },
    ],
  };
}

function SummaryProbe({
  isInContext,
  onSummary,
}: {
  isInContext: (workspaceId: string) => boolean;
  onSummary: (summary: InterruptedSessionsSummary) => void;
}): JSX.Element {
  onSummary(useInterruptedSessions(true, isInContext));
  return <></>;
}

describe('useInterruptedSessions', () => {
  let root: Root;
  const summaries: InterruptedSessionsSummary[] = [];

  beforeEach(() => {
    summaries.length = 0;
    root = createRoot(document.createElement('div'));
  });

  afterEach(() => {
    act(() => root.unmount());
    Reflect.deleteProperty(window, 'api');
  });

  it('scopes the summary to the current workspace context', async () => {
    const listUsageLimitedIdleSessions = jest.fn(() =>
      Promise.resolve([chatGroup('ws-a'), chatGroup('ws-b')]),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { listUsageLimitedIdleSessions },
    });
    const render = async (
      isInContext: (workspaceId: string) => boolean,
    ): Promise<void> => {
      await act(async () => {
        root.render(
          <SummaryProbe
            isInContext={isInContext}
            onSummary={(summary) => summaries.push(summary)}
          />,
        );
        await Promise.resolve();
      });
    };

    await render(() => true);
    expect(summaries.at(-1)?.count).toBe(2);

    await render((workspaceId) => workspaceId === 'ws-a');
    expect(summaries.at(-1)?.count).toBe(1);
    await render(() => true);
    expect(summaries.at(-1)?.count).toBe(2);
  });

  it('folds refresh requests made during a listing into one follow-up listing', async () => {
    const pending: Array<(groups: UsageLimitedSessionGroup[]) => void> = [];
    const listUsageLimitedIdleSessions = jest.fn(
      () =>
        new Promise<UsageLimitedSessionGroup[]>((resolve) => {
          pending.push(resolve);
        }),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { listUsageLimitedIdleSessions },
    });
    const isInContext = (): boolean => true;

    await act(async () => {
      root.render(
        <SummaryProbe
          isInContext={isInContext}
          onSummary={(summary) => summaries.push(summary)}
        />,
      );
      await Promise.resolve();
    });
    expect(listUsageLimitedIdleSessions).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(listUsageLimitedIdleSessions).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.shift()?.([chatGroup('ws-a')]);
      await Promise.resolve();
    });
    expect(listUsageLimitedIdleSessions).toHaveBeenCalledTimes(2);

    await act(async () => {
      pending.shift()?.([chatGroup('ws-a'), chatGroup('ws-b')]);
      await Promise.resolve();
    });
    expect(listUsageLimitedIdleSessions).toHaveBeenCalledTimes(2);
    expect(summaries.at(-1)?.count).toBe(2);
  });

  it('waits for a pending listing when the context changes, then lists once for the new context', async () => {
    const pending: Array<(groups: UsageLimitedSessionGroup[]) => void> = [];
    const listUsageLimitedIdleSessions = jest.fn(
      () =>
        new Promise<UsageLimitedSessionGroup[]>((resolve) => {
          pending.push(resolve);
        }),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { listUsageLimitedIdleSessions },
    });
    const render = async (
      isInContext: (workspaceId: string) => boolean,
    ): Promise<void> => {
      await act(async () => {
        root.render(
          <SummaryProbe
            isInContext={isInContext}
            onSummary={(summary) => summaries.push(summary)}
          />,
        );
        await Promise.resolve();
      });
    };

    await render(() => true);
    await render((workspaceId) => workspaceId === 'ws-a');
    await render((workspaceId) => workspaceId === 'ws-b');
    expect(listUsageLimitedIdleSessions).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.shift()?.([chatGroup('ws-a'), chatGroup('ws-b')]);
      await Promise.resolve();
    });
    expect(listUsageLimitedIdleSessions).toHaveBeenCalledTimes(2);

    await act(async () => {
      pending.shift()?.([
        chatGroup('ws-a'),
        chatGroup('ws-b'),
        chatGroup('ws-c'),
      ]);
      await Promise.resolve();
    });
    expect(listUsageLimitedIdleSessions).toHaveBeenCalledTimes(2);
    expect(summaries.at(-1)?.count).toBe(1);
  });
});
