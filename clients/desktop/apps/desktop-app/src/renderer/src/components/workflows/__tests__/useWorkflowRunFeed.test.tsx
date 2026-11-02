/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import type { ExecutionSummary } from '@canopy/desktop-shared/types/pipeline';
import { NO_PROJECT_LABEL } from '@canopy/ui-app/workflows';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import type { AutomationScope } from '@/hooks/useAutomationScope';
import { useExecutionFeedStore } from '@/lib/workflows/execution-feed';
import {
  unprojectedExecutionInContext,
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
  ownerLabel: () => 'Personal',
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

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const PERSONAL: WorkspaceContext = { kind: 'personal' };
const ORGANIZATION_A: WorkspaceContext = {
  kind: 'organization',
  organizationId: ORG_A,
};
const ORGANIZATION_B: WorkspaceContext = {
  kind: 'organization',
  organizationId: ORG_B,
};

describe('unprojectedExecutionInContext', () => {
  it('files a run by the owner it recorded', () => {
    expect(unprojectedExecutionInContext(`org:${ORG_A}`, ORGANIZATION_A)).toBe(
      true,
    );
    expect(unprojectedExecutionInContext(`org:${ORG_A}`, ORGANIZATION_B)).toBe(
      false,
    );
    expect(unprojectedExecutionInContext(`org:${ORG_A}`, PERSONAL)).toBe(false);
    expect(unprojectedExecutionInContext('personal', PERSONAL)).toBe(true);
    expect(unprojectedExecutionInContext('personal', ORGANIZATION_A)).toBe(
      false,
    );
  });

  it('keeps a run that recorded no owner in Personal', () => {
    expect(unprojectedExecutionInContext(undefined, PERSONAL)).toBe(true);
    expect(unprojectedExecutionInContext(undefined, ORGANIZATION_A)).toBe(
      false,
    );
  });

  it('files a run with an unreadable owner under no context', () => {
    for (const context of [PERSONAL, ORGANIZATION_A, ORGANIZATION_B]) {
      expect(unprojectedExecutionInContext('org:not-a-uuid', context)).toBe(
        false,
      );
    }
  });

  it('lists every run when contexts are off', () => {
    expect(unprojectedExecutionInContext(undefined, undefined)).toBe(true);
    expect(unprojectedExecutionInContext('org:not-a-uuid', undefined)).toBe(
      true,
    );
  });
});

function execution(
  id: string,
  extra: Partial<ExecutionSummary> = {},
): ExecutionSummary {
  return {
    id,
    pipeline_id: 'global-pipeline',
    pipeline_name: `Run ${id}`,
    status: 'success',
    status_reasons: [],
    started_at: '2026-10-20T10:00:00.000Z',
    completed_at: '2026-10-20T10:05:00.000Z',
    cwd: '',
    ...extra,
  };
}

function scopeFor(context: WorkspaceContext | undefined): AutomationScope {
  return { ...SCOPE, context };
}

describe('useWorkflowRunFeed owner filing', () => {
  let container: HTMLDivElement;
  let root: Root;
  const probe: { current: WorkflowRunFeed | null } = { current: null };
  const executions: ExecutionSummary[] = [
    execution('personal-run', { execution_context: 'personal' }),
    execution('org-a-run', { execution_context: `org:${ORG_A}` }),
    execution('org-b-run', { execution_context: `org:${ORG_B}` }),
    execution('legacy-run'),
    execution('malformed-run', { execution_context: 'org:not-a-uuid' }),
    execution('deleted-project-run', {
      project_id: 'gone',
      worktree_id: 'gone-worktree',
      execution_context: `org:${ORG_B}`,
    }),
  ];

  function Harness({ scope }: { scope: AutomationScope }): null {
    probe.current = useWorkflowRunFeed({
      activities: [],
      recentRuns: [],
      scope,
      automationsLoading: false,
    });
    return null;
  }

  async function render(context: WorkspaceContext | undefined): Promise<void> {
    await act(async () => {
      root.render(<Harness scope={scopeFor(context)} />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function listedIds(): string[] {
    const feed = probe.current;
    if (!feed) throw new Error('The hook has not rendered');
    return feed.rows
      .flatMap((row) => (row.kind === 'pipeline' ? [row.summary.id] : []))
      .sort();
  }

  beforeEach(() => {
    useExecutionFeedStore.setState({
      executions: [],
      loaded: false,
      loading: false,
      error: null,
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { automations: { listRuns } },
    });
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      value: {
        onExecutionEvent: (): (() => void) => (): void => undefined,
        listExecutions: (): Promise<{
          success: true;
          data: ExecutionSummary[];
        }> => Promise.resolve({ success: true, data: executions }),
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

  it('lists each run with no live project only under its recorded owner', async () => {
    await render(PERSONAL);
    expect(listedIds()).toEqual(['legacy-run', 'personal-run']);

    await render(ORGANIZATION_A);
    expect(listedIds()).toEqual(['org-a-run']);

    // Organization B has no projects; its runs are still found there.
    await render(ORGANIZATION_B);
    expect(listedIds()).toEqual(['deleted-project-run', 'org-b-run']);

    // Switching back leaves the executions untouched.
    await render(PERSONAL);
    expect(listedIds()).toEqual(['legacy-run', 'personal-run']);
    expect(useExecutionFeedStore.getState().executions).toHaveLength(
      executions.length,
    );
  });

  it('lists every run when contexts are off', async () => {
    await render(undefined);
    expect(listedIds()).toEqual(executions.map((entry) => entry.id).sort());
  });

  it('shows No project only for a run that never had one', async () => {
    await render(ORGANIZATION_B);
    const where = new Map(
      probe.current?.rows.flatMap((row) =>
        row.kind === 'pipeline' ? [[row.summary.id, row.where]] : [],
      ),
    );
    expect(where.get('org-b-run')).toBe(NO_PROJECT_LABEL);
    expect(where.get('deleted-project-run')).not.toBe(NO_PROJECT_LABEL);
  });
});
