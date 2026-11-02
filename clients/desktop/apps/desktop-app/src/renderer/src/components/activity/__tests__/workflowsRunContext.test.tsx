/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PipelineData,
  PipelineInfo,
} from '@canopy/desktop-shared/types/pipeline';
import { PIPELINE_RUN_CONTEXT_COPY } from '@canopy/ui-app/workflows';
import { resolveWorkflowsRunContext } from '../workflowsRunContext';
import {
  usePipelineRunOwnerSelection,
  type PipelineRunOwnerChoices,
} from '../usePipelineRunOwnerChoices';

const ORG_A = 'org:11111111-1111-4111-8111-111111111111';
const ORG_B = 'org:22222222-2222-4222-8222-222222222222';

function pipeline(
  scopes: PipelineInfo['scopes'],
  extra: {
    source?: PipelineInfo['source'];
    localRunOwner?: string;
    localRunOwnerUnreadable?: true;
  } = {},
): PipelineData {
  return {
    info: {
      id: 'p',
      name: 'P',
      filename: 'p.yml',
      description: '',
      icon: '',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      triggerTypes: ['dispatch'],
      source: extra.source ?? 'user',
      readonly: false,
      scopes,
    },
    content: { name: 'P', on: 'dispatch', jobs: {} },
    ...(extra.localRunOwner !== undefined
      ? { localRunOwner: extra.localRunOwner }
      : {}),
    ...(extra.localRunOwnerUnreadable
      ? { localRunOwnerUnreadable: true as const }
      : {}),
  };
}

const LABELS: Record<string, string> = {
  personal: 'Personal',
  [ORG_A]: 'Acme',
  [ORG_B]: 'Globex',
};

function ready(
  overrides: Partial<
    Extract<PipelineRunOwnerChoices, { status: 'ready' }>
  > = {},
): PipelineRunOwnerChoices {
  return {
    status: 'ready',
    personalOnly: false,
    options: [
      { value: 'personal', label: 'Personal' },
      { value: ORG_A, label: 'Acme' },
      { value: ORG_B, label: 'Globex' },
    ],
    navigationOwner: ORG_A,
    labelFor: (owner) => LABELS[owner] ?? 'Unknown organization',
    ...overrides,
  };
}

const NO_SELECTION = { value: null, stale: false, choose: jest.fn() };

describe('resolveWorkflowsRunContext', () => {
  it("blocks a run with no project while the pipeline's owner can't be read", () => {
    const rereadPipeline = jest.fn();
    const context = resolveWorkflowsRunContext({
      pipeline: pipeline(['global'], { localRunOwnerUnreadable: true }),
      taskScope: undefined,
      chosenLocation: undefined,
      choices: ready(),
      selection: { ...NO_SELECTION, value: ORG_A },
      rereadPipeline,
    });
    // Never shown as unowned: the owner is an error with Retry, and Run waits.
    expect(context.owner).toMatchObject({ kind: 'error' });
    expect(context.requestedOwner).toBeUndefined();
    expect(context.runBlocked).toBe(true);
    if (context.owner?.kind === 'error') context.owner.onRetry();
    expect(rereadPipeline).toHaveBeenCalledTimes(1);
  });

  it('runs a global-only pipeline with no project and no location choice', () => {
    const context = resolveWorkflowsRunContext({
      pipeline: pipeline(['global']),
      taskScope: 'worktree',
      chosenLocation: undefined,
      choices: ready(),
      selection: { ...NO_SELECTION, value: ORG_A },
    });
    expect(context.location).toBe('global');
    expect(context.showLocation).toBe(false);
    expect(context.requestedOwner).toBe(ORG_A);
    expect(context.runBlocked).toBe(false);
  });

  it('offers Run in for a pipeline that runs either way, defaulting to No project', () => {
    const context = resolveWorkflowsRunContext({
      pipeline: pipeline(['global', 'worktree']),
      taskScope: 'worktree',
      chosenLocation: undefined,
      choices: ready(),
      selection: { ...NO_SELECTION, value: ORG_A },
    });
    expect(context.showLocation).toBe(true);
    expect(context.currentTaskUnavailable).toBe(false);
    expect(context.location).toBe('global');

    const task = resolveWorkflowsRunContext({
      pipeline: pipeline(['global', 'worktree']),
      taskScope: 'worktree',
      chosenLocation: 'current-task',
      choices: ready(),
      selection: { ...NO_SELECTION, value: ORG_A },
    });
    // A task run takes no owner; its project decides.
    expect(task.location).toBe('current-task');
    expect(task.owner).toBeNull();
    expect(task.requestedOwner).toBeUndefined();
  });

  it('turns off Current task with no compatible selected task', () => {
    const noTask = resolveWorkflowsRunContext({
      pipeline: pipeline(['global', 'worktree']),
      taskScope: undefined,
      chosenLocation: 'current-task',
      choices: ready(),
      selection: NO_SELECTION,
    });
    expect(noTask.currentTaskUnavailable).toBe(true);
    expect(noTask.location).toBe('global');

    // A cowork folder cannot run a worktree-only pipeline.
    const directory = resolveWorkflowsRunContext({
      pipeline: pipeline(['global', 'worktree']),
      taskScope: 'directory',
      chosenLocation: undefined,
      choices: ready(),
      selection: NO_SELECTION,
    });
    expect(directory.currentTaskUnavailable).toBe(true);
  });

  it('runs a project file and a task-only pipeline in the task', () => {
    for (const subject of [
      pipeline(['global'], { source: 'project' }),
      pipeline(['directory']),
    ]) {
      const context = resolveWorkflowsRunContext({
        pipeline: subject,
        taskScope: 'worktree',
        chosenLocation: 'global',
        choices: ready(),
        selection: NO_SELECTION,
      });
      expect(context.location).toBe('current-task');
      expect(context.showLocation).toBe(false);
    }
  });

  it('blocks a task-only pipeline with no compatible selected task', () => {
    for (const taskScope of [undefined, 'directory'] as const) {
      const context = resolveWorkflowsRunContext({
        pipeline: pipeline(['worktree']),
        taskScope,
        chosenLocation: undefined,
        choices: ready(),
        selection: NO_SELECTION,
      });
      expect(context.location).toBe('current-task');
      expect(context.currentTaskUnavailable).toBe(true);
      expect(context.runBlocked).toBe(true);
      // Run says why it is off instead of doing nothing.
      expect(context.blockedReason).toBe(
        PIPELINE_RUN_CONTEXT_COPY.currentTaskUnavailable,
      );
    }
    const inTask = resolveWorkflowsRunContext({
      pipeline: pipeline(['worktree']),
      taskScope: 'worktree',
      chosenLocation: undefined,
      choices: ready(),
      selection: NO_SELECTION,
    });
    expect(inTask.runBlocked).toBe(false);
    expect(inTask.blockedReason).toBeUndefined();
  });

  it('shows a saved owner read-only and never sends a requested owner', () => {
    const context = resolveWorkflowsRunContext({
      pipeline: pipeline(['global'], { localRunOwner: ORG_B }),
      taskScope: undefined,
      chosenLocation: undefined,
      choices: ready(),
      selection: { ...NO_SELECTION, value: ORG_A },
    });
    expect(context.owner).toEqual({ kind: 'fixed', label: 'Globex' });
    expect(context.requestedOwner).toBeUndefined();
    expect(context.ownerValue).toBe(ORG_B);
    expect(context.runBlocked).toBe(false);
  });

  it('blocks Run until an owner is chosen, and while owners load or fail', () => {
    const unchosen = resolveWorkflowsRunContext({
      pipeline: pipeline(['global']),
      taskScope: undefined,
      chosenLocation: undefined,
      choices: ready(),
      selection: { ...NO_SELECTION, stale: true },
    });
    expect(unchosen.runBlocked).toBe(true);
    expect(unchosen.owner).toMatchObject({ kind: 'choose', stale: true });

    const loading = resolveWorkflowsRunContext({
      pipeline: pipeline(['global'], { localRunOwner: ORG_A }),
      taskScope: undefined,
      chosenLocation: undefined,
      choices: { status: 'loading' },
      selection: NO_SELECTION,
    });
    expect(loading.owner).toEqual({ kind: 'loading' });
    expect(loading.runBlocked).toBe(true);

    const retry = jest.fn();
    const failed = resolveWorkflowsRunContext({
      pipeline: pipeline(['global']),
      taskScope: undefined,
      chosenLocation: undefined,
      choices: { status: 'error', retry },
      selection: NO_SELECTION,
    });
    expect(failed.owner).toEqual({ kind: 'error', onRetry: retry });
    expect(failed.runBlocked).toBe(true);
  });

  it('runs as Personal when organizations are unavailable', () => {
    const context = resolveWorkflowsRunContext({
      pipeline: pipeline(['global']),
      taskScope: undefined,
      chosenLocation: undefined,
      choices: ready({
        personalOnly: true,
        options: [{ value: 'personal', label: 'Personal' }],
        navigationOwner: 'personal',
      }),
      selection: NO_SELECTION,
    });
    expect(context.owner).toEqual({ kind: 'fixed', label: 'Personal' });
    expect(context.requestedOwner).toBe('personal');
    expect(context.runBlocked).toBe(false);
  });

  it('asks again instead of running as Personal when the chosen organization is gone', () => {
    // The person chose their last organization, which was removed while the
    // dialog was open, so only Personal remains.
    const context = resolveWorkflowsRunContext({
      pipeline: pipeline(['global']),
      taskScope: undefined,
      chosenLocation: undefined,
      choices: ready({
        personalOnly: true,
        options: [{ value: 'personal', label: 'Personal' }],
        navigationOwner: 'personal',
      }),
      selection: { value: null, stale: true, choose: jest.fn() },
    });
    expect(context.owner).toMatchObject({ kind: 'choose', stale: true });
    expect(context.requestedOwner).toBeUndefined();
    expect(context.runBlocked).toBe(true);
  });
});

describe('usePipelineRunOwnerSelection', () => {
  let container: HTMLDivElement;
  let root: Root;
  const probe: {
    current: ReturnType<typeof usePipelineRunOwnerSelection> | null;
  } = { current: null };

  function Harness({
    choices,
  }: {
    choices: PipelineRunOwnerChoices;
  }): JSX.Element | null {
    probe.current = usePipelineRunOwnerSelection(choices);
    return null;
  }

  function render(choices: PipelineRunOwnerChoices): void {
    act(() => {
      root.render(<Harness choices={choices} />);
    });
  }

  function selection(): ReturnType<typeof usePipelineRunOwnerSelection> {
    if (!probe.current) throw new Error('The hook has not rendered');
    return probe.current;
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('chooses nothing until owners load, then defaults to the navigation context', () => {
    render({ status: 'loading' });
    expect(selection().value).toBeNull();
    expect(selection().stale).toBe(false);

    render(ready());
    expect(selection().value).toBe(ORG_A);
  });

  it('keeps its default when navigation switches later', () => {
    render(ready());
    render(ready({ navigationOwner: ORG_B }));
    expect(selection().value).toBe(ORG_A);
  });

  it('keeps an explicit choice', () => {
    render(ready());
    act(() => selection().choose('personal'));
    render(ready({ navigationOwner: ORG_B }));
    expect(selection().value).toBe('personal');
  });

  it('clears a choice whose organization is gone, and says so', () => {
    render(ready());
    act(() => selection().choose(ORG_B));
    render(
      ready({
        options: [
          { value: 'personal', label: 'Personal' },
          { value: ORG_A, label: 'Acme' },
        ],
      }),
    );
    expect(selection().value).toBeNull();
    expect(selection().stale).toBe(true);
  });
});
