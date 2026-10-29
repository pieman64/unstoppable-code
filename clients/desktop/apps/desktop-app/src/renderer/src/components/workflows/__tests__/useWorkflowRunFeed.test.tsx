/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import type { AutomationScope } from '@/hooks/useAutomationScope';
import {
  useWorkflowRunFeed,
  type WorkflowRunFeed,
} from '../runs/useWorkflowRunFeed';

const listRuns = jest.fn();

function activity(id: string, ran: boolean): ScheduledActivity {
  return {
    version: 1,
    id,
    name: `Activity ${id}`,
    enabled: true,
    schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
    action: { type: 'app_advisor_prompt', prompt: 'x' },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    failureCount: 0,
    ...(ran
      ? {
          lastResult: {
            status: 'success',
            completedAt: '2026-10-12T02:00:00.000Z',
          },
        }
      : {}),
  };
}

const SCOPE: AutomationScope = {
  context: undefined,
  inContext: () => true,
  watcherInContext: () => true,
  shareInContext: () => true,
  contextLabel: null,
  runsInLabel: () => null,
  labelForWorkspace: () => '',
  memberOfWorkspace: () => true,
  projectsInContext: [],
};

describe('useWorkflowRunFeed Load more', () => {
  let container: HTMLDivElement;
  let root: Root;
  const probe: { current: WorkflowRunFeed | null } = { current: null };

  function Harness({
    activities,
  }: {
    activities: readonly ScheduledActivity[];
  }): null {
    probe.current = useWorkflowRunFeed({
      activities,
      recentRuns: [],
      scope: SCOPE,
      automationsLoading: false,
    });
    return null;
  }

  function render(activities: readonly ScheduledActivity[]): void {
    act(() => {
      root.render(<Harness activities={activities} />);
    });
  }

  function feed(): WorkflowRunFeed {
    if (!probe.current) throw new Error('The hook has not rendered');
    return probe.current;
  }

  async function loadMore(): Promise<void> {
    await act(async () => {
      feed().loadMore();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    listRuns.mockReset();
    listRuns.mockResolvedValue({ runs: [], nextCursor: null });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { automations: { listRuns } },
    });
    // The pipeline bridge the feed listens on; it reports no runs here.
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      value: {
        onExecutionEvent: (): (() => void) => (): void => undefined,
        listExecutions: (): Promise<{ success: true; executions: [] }> =>
          Promise.resolve({ success: true, executions: [] }),
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, 'api');
    Reflect.deleteProperty(window, 'pipelines');
  });

  it('stays finished when an automation leaves, and is offered again when one first runs', async () => {
    const a = activity('a', true);
    const b = activity('b', true);
    render([a, b]);
    expect(feed().hasMore).toBe(true);

    // Both histories are read to the end.
    await loadMore();
    expect(listRuns).toHaveBeenCalledTimes(2);
    expect(feed().hasMore).toBe(false);

    // One automation is deleted: nothing new to read.
    render([a]);
    expect(feed().hasMore).toBe(false);

    // Another runs for the first time: its history can be read.
    render([a, activity('c', true)]);
    expect(feed().hasMore).toBe(true);
    await loadMore();
    expect(listRuns).toHaveBeenLastCalledWith(
      expect.objectContaining({ activityId: 'c' }),
    );
    expect(feed().hasMore).toBe(false);
  });

  it('stays offered for an automation that first runs while a load is in flight', async () => {
    let finish: (page: { runs: []; nextCursor: null }) => void = () =>
      undefined;
    listRuns.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const a = activity('a', true);
    render([a]);
    act(() => feed().loadMore());

    render([a, activity('b', true)]);
    await act(async () => {
      finish({ runs: [], nextCursor: null });
      await Promise.resolve();
      await Promise.resolve();
    });

    // The finished load read only the first automation's history.
    expect(listRuns).toHaveBeenCalledTimes(1);
    expect(feed().hasMore).toBe(true);
  });

  it('leaves out an automation that has never run', () => {
    render([activity('a', false)]);
    expect(feed().hasMore).toBe(false);
  });
});
