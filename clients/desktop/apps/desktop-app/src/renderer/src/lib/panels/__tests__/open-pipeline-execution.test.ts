/** @jest-environment jsdom */

/**
 * The single live pipeline-run opener, exercised against the REAL panel
 * layout store, placement helper, reveal primitive, and per-panel session
 * store. Only the host operations the opener injects (reading the run,
 * classifying and navigating to its owner, awaiting the owner's layout, and
 * the ownerless compatibility host) are fakes, so each test controls when an
 * await resolves and can race requests deterministically.
 */
import type { SingleRepoSidebarItem } from '@canopy/desktop-shared/types';
import type { ExecutionState } from '@canopy/desktop-shared/types/pipeline';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  findPanelByInstanceKey,
  makeAuxPanelLayoutKey,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '@/stores/panelLayoutStore';
import { usePanelWindowsStore } from '@/stores/panelWindowsStore';
import {
  pipelinePanelUiKey,
  resetPipelinePanelUiStoreForTests,
  usePipelinePanelUiStore,
} from '@/stores/pipelinePanelUiStore';
import { useChatStore } from '@/stores/chatStore';
import {
  registerNavigationGuard,
  useNavigationStore,
} from '@/stores/navigationStore';
import {
  classifyPipelineExecutionOwner,
  createPipelineExecutionOpener,
  navigateToPipelineExecutionOwner,
  PIPELINE_RUN_OPEN_ERROR_MESSAGES,
  waitForPipelineExecutionOwnerDirectory,
  type OpenPipelineExecutionResult,
  type PipelineExecutionNavigationOutcome,
  type PipelineExecutionOpenerEnvironment,
  type PipelineExecutionOwner,
  type PipelineExecutionOwnerClassification,
} from '../open-pipeline-execution';

jest.mock('../persistence-bridge', () => ({
  ensureWorktreePanelLayout: jest.fn(() => Promise.resolve()),
}));

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';
const OWNER: PipelineExecutionOwner = {
  projectId: PROJECT_ID,
  worktreeId: WORKTREE_ID,
};
const KEY = `${PROJECT_ID}/${WORKTREE_ID}`;
const OTHER_OWNER: PipelineExecutionOwner = {
  projectId: PROJECT_ID,
  worktreeId: 'worktree-2',
};
const OTHER_KEY = `${PROJECT_ID}/worktree-2`;
const COWORK_OWNER: PipelineExecutionOwner = {
  projectId: 'cowork-1',
  worktreeId: 'entry-1',
};
const COWORK_KEY = 'cowork-1/entry-1';

function layoutWithChat(chatTabId: string): DefaultLayoutDescriptor {
  return {
    orientation: 'horizontal',
    groups: [
      {
        kind: 'chat',
        groupId: 'group-chat',
        panelId: `panel-chat-${chatTabId}`,
        instance: { chatTabId },
      },
      {
        kind: 'terminal',
        groupId: 'group-terminal',
        panelId: 'panel-terminal',
      },
    ],
    containerSize: { width: 1200, height: 800 },
  };
}

function execution(
  id: string,
  owner: Partial<PipelineExecutionOwner> | null = OWNER,
): ExecutionState {
  return {
    version: 9,
    id,
    pipeline_id: 'pipeline-1',
    pipeline_snapshot: { name: 'Build', jobs: {} },
    status: 'running',
    jobs: {},
    job_definitions: {},
    job_groups: {},
    pending_pauses: [],
    status_reasons: [],
    started_at: '2026-09-29T00:00:00.000Z',
    cwd: '/repo',
    env: {},
    inputs: {},
    ...(owner?.projectId !== undefined ? { project_id: owner.projectId } : {}),
    ...(owner?.worktreeId !== undefined
      ? { worktree_id: owner.worktreeId }
      : {}),
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

/** Drains microtasks until `condition` holds (a request reached an await). */
async function flushUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !condition(); attempt += 1) {
    await Promise.resolve();
  }
  if (!condition()) throw new Error('condition never held');
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface FakeHost {
  env: PipelineExecutionOpenerEnvironment;
  executions: Map<string, ExecutionState>;
  /** The owner the fake main window currently shows. */
  shown: { owner: PipelineExecutionOwner | null };
  classification: Map<string, PipelineExecutionOwnerClassification>;
  navigateToOwner: jest.Mock<
    Promise<PipelineExecutionNavigationOutcome>,
    [PipelineExecutionOwner, 'code' | 'cowork']
  >;
  readExecution: jest.Mock<Promise<ExecutionState | null>, [string]>;
  ensureLayout: jest.Mock<Promise<void>, [string]>;
  openCompatibility: jest.Mock;
}

function panelStore(): ReturnType<typeof usePanelLayoutStore.getState> {
  return usePanelLayoutStore.getState();
}

function makeHost(): FakeHost {
  const executions = new Map<string, ExecutionState>();
  const shown: { owner: PipelineExecutionOwner | null } = { owner: null };
  const classification = new Map<
    string,
    PipelineExecutionOwnerClassification
  >();
  const readExecution = jest.fn(
    (executionId: string): Promise<ExecutionState | null> =>
      Promise.resolve(executions.get(executionId) ?? null),
  );
  const navigateToOwner = jest.fn(
    (
      owner: PipelineExecutionOwner,
    ): Promise<PipelineExecutionNavigationOutcome> => {
      shown.owner = owner;
      return Promise.resolve('shown');
    },
  );
  const ensureLayout = jest.fn((ownerKey: string): Promise<void> => {
    if (panelStore().layouts[ownerKey] === undefined) {
      panelStore().initializeLayout(ownerKey, layoutWithChat('chat-restored'));
    }
    return Promise.resolve();
  });
  const openCompatibility = jest.fn();
  const env: PipelineExecutionOpenerEnvironment = {
    readExecution,
    classifyOwner: (owner) =>
      classification.get(`${owner.projectId}/${owner.worktreeId}`) ?? 'code',
    navigateToOwner,
    isOwnerShown: (owner) =>
      shown.owner?.projectId === owner.projectId &&
      shown.owner.worktreeId === owner.worktreeId,
    ensureLayout,
    openCompatibility,
  };
  return {
    env,
    executions,
    shown,
    classification,
    navigateToOwner,
    readExecution,
    ensureLayout,
    openCompatibility,
  };
}

function runTabs(layoutKey: string): string[] {
  const layout = panelStore().layouts[layoutKey];
  return Object.values(layout?.groups ?? {}).flatMap((group) =>
    group.tabs
      .filter((tab) => tab.kind === 'pipeline-execution')
      .map((tab) => tab.instance?.executionId ?? ''),
  );
}

function applied(
  result: OpenPipelineExecutionResult,
): Extract<OpenPipelineExecutionResult, { status: 'applied' }> {
  if (result.status !== 'applied') {
    throw new Error(`expected applied, got ${JSON.stringify(result)}`);
  }
  return result;
}

const initialWindowsState = usePanelWindowsStore.getState();
const focusAuxWindow = jest.fn<boolean, [string]>(() => true);

beforeEach(() => {
  resetPipelinePanelUiStoreForTests();
  usePanelWindowsStore.setState({ focusAuxWindowForLayout: focusAuxWindow });
});

afterEach(() => {
  const state = panelStore();
  for (const key of Object.keys(state.layouts)) {
    state.disposeLayout(key);
  }
  usePanelWindowsStore.setState(initialWindowsState, true);
  focusAuxWindow.mockClear();
});

describe('navigating to the owner from a guarded editor', () => {
  it('asks first and changes nothing when the user keeps editing', async () => {
    useNavigationStore.setState({ activePage: 'workflows-library' });
    const unregister = registerNavigationGuard(() => Promise.resolve(false));
    const selectWorktree = jest.spyOn(
      useChatStore.getState(),
      'selectWorktree',
    );
    try {
      await expect(
        navigateToPipelineExecutionOwner(OWNER, 'code'),
      ).resolves.toBe('superseded');
      expect(selectWorktree).not.toHaveBeenCalled();
      expect(useNavigationStore.getState().activePage).toBe(
        'workflows-library',
      );
    } finally {
      selectWorktree.mockRestore();
      unregister();
    }
  });

  it('does not ask again once the user saved from the prompt', async () => {
    useNavigationStore.setState({ activePage: 'workflows-library' });
    // A save from the prompt settles before the editor re-renders clean, so
    // the guard would ask again if it were consulted a second time.
    const guard = jest.fn(() => Promise.resolve(true));
    const unregister = registerNavigationGuard(guard);
    const selectWorktree = jest
      .spyOn(useChatStore.getState(), 'selectWorktree')
      .mockImplementation(() => undefined);
    try {
      await navigateToPipelineExecutionOwner(OWNER, 'code');
      expect(guard).toHaveBeenCalledTimes(1);
      expect(useNavigationStore.getState().activePage).toBe('main');
      expect(selectWorktree).toHaveBeenCalledWith(PROJECT_ID, WORKTREE_ID);
    } finally {
      selectWorktree.mockRestore();
      unregister();
    }
  });
});

describe('owner resolution', () => {
  test('opens the run in the owner recorded on the run, validating the hint', async () => {
    const host = makeHost();
    host.executions.set('run-1', execution('run-1'));
    const opener = createPipelineExecutionOpener(host.env);

    const result = applied(
      await opener.open({ executionId: 'run-1', owner: OWNER }),
    );

    expect(host.navigateToOwner).toHaveBeenCalledWith(OWNER, 'code');
    expect(host.ensureLayout).toHaveBeenCalledWith(KEY);
    expect(result).toEqual({
      status: 'applied',
      ownerKey: KEY,
      layoutKey: KEY,
      panelId: 'panel-pipeline-run-1',
      outcome: 'placed',
    });
    expect(runTabs(KEY)).toEqual(['run-1']);
  });

  test('takes the owner from the run when the caller has none, never the shown worktree', async () => {
    const host = makeHost();
    host.shown.owner = OTHER_OWNER;
    panelStore().initializeLayout(OTHER_KEY, layoutWithChat('chat-other'));
    host.executions.set('run-1', execution('run-1'));
    const opener = createPipelineExecutionOpener(host.env);

    const result = applied(await opener.open({ executionId: 'run-1' }));

    expect(result.ownerKey).toBe(KEY);
    expect(host.navigateToOwner).toHaveBeenCalledWith(OWNER, 'code');
    expect(runTabs(OTHER_KEY)).toEqual([]);
    expect(runTabs(KEY)).toEqual(['run-1']);
  });

  test('refuses an owner hint the run disagrees with', async () => {
    const host = makeHost();
    host.executions.set('run-1', execution('run-1'));
    const opener = createPipelineExecutionOpener(host.env);

    const result = await opener.open({
      executionId: 'run-1',
      owner: OTHER_OWNER,
    });

    expect(result).toEqual({
      status: 'error',
      code: 'owner_mismatch',
      message: PIPELINE_RUN_OPEN_ERROR_MESSAGES.owner_mismatch,
    });
    expect(host.navigateToOwner).not.toHaveBeenCalled();
    expect(runTabs(KEY)).toEqual([]);
    expect(runTabs(OTHER_KEY)).toEqual([]);
  });

  test('uses the run record the renderer already has instead of reading it', async () => {
    const host = makeHost();
    const opener = createPipelineExecutionOpener({
      ...host.env,
      peekExecution: (executionId) =>
        executionId === 'run-listed'
          ? { project_id: PROJECT_ID, worktree_id: WORKTREE_ID }
          : null,
    });

    const result = applied(
      await opener.open({ executionId: 'run-listed', owner: OWNER }),
    );

    expect(result.ownerKey).toBe(KEY);
    expect(host.readExecution).not.toHaveBeenCalled();
    // A listed record is validated like a read one.
    await expect(
      opener.open({ executionId: 'run-listed', owner: OTHER_OWNER }),
    ).resolves.toMatchObject({ status: 'error', code: 'owner_mismatch' });
  });

  test('reports a missing run without navigating or creating a tab', async () => {
    const host = makeHost();
    const opener = createPipelineExecutionOpener(host.env);

    const result = await opener.open({ executionId: 'gone', owner: OWNER });

    expect(result).toMatchObject({ status: 'error', code: 'not_found' });
    expect(host.navigateToOwner).not.toHaveBeenCalled();
    expect(Object.keys(panelStore().layouts)).toEqual([]);
  });

  test('reports a failed read as a retryable navigation failure', async () => {
    const host = makeHost();
    host.readExecution.mockRejectedValueOnce(new Error('ipc down'));
    const opener = createPipelineExecutionOpener(host.env);

    await expect(opener.open({ executionId: 'run-1' })).resolves.toMatchObject({
      status: 'error',
      code: 'navigation_failed',
    });
  });

  test('reports an owner removed while the run was read', async () => {
    const host = makeHost();
    const read = deferred<ExecutionState | null>();
    host.readExecution.mockReturnValueOnce(read.promise);
    const opener = createPipelineExecutionOpener(host.env);

    const pending = opener.open({ executionId: 'run-1' });
    // The worktree is deleted before the read returns.
    host.classification.set(KEY, 'missing');
    read.resolve(execution('run-1'));

    await expect(pending).resolves.toMatchObject({
      status: 'error',
      code: 'owner_missing',
    });
    expect(host.navigateToOwner).not.toHaveBeenCalled();
    expect(Object.keys(panelStore().layouts)).toEqual([]);
  });

  test('reports a Cowork task that no longer exists', async () => {
    const host = makeHost();
    host.executions.set('run-1', execution('run-1', COWORK_OWNER));
    host.classification.set(COWORK_KEY, 'cowork');
    host.navigateToOwner.mockResolvedValueOnce('missing');
    const opener = createPipelineExecutionOpener(host.env);

    await expect(opener.open({ executionId: 'run-1' })).resolves.toMatchObject({
      status: 'error',
      code: 'owner_missing',
    });
    expect(host.ensureLayout).not.toHaveBeenCalled();
  });

  test('opens a Cowork run in its exact Work Entry layout', async () => {
    const host = makeHost();
    host.executions.set('run-1', execution('run-1', COWORK_OWNER));
    host.classification.set(COWORK_KEY, 'cowork');
    const opener = createPipelineExecutionOpener(host.env);

    const result = applied(
      await opener.open({ executionId: 'run-1', owner: COWORK_OWNER }),
    );

    expect(host.navigateToOwner).toHaveBeenCalledWith(COWORK_OWNER, 'cowork');
    expect(result.ownerKey).toBe(COWORK_KEY);
    expect(runTabs(COWORK_KEY)).toEqual(['run-1']);
  });

  test('a run without an owner opens in the compatibility host, even with a hint', async () => {
    const host = makeHost();
    host.executions.set('run-1', execution('run-1', null));
    const opener = createPipelineExecutionOpener(host.env);

    const result = await opener.open({
      executionId: 'run-1',
      owner: OWNER,
      target: { jobId: 'build' },
    });

    expect(result).toEqual({
      status: 'ownerless',
      executionId: 'run-1',
      reason: 'no-owner',
    });
    expect(host.openCompatibility).toHaveBeenCalledWith('run-1', {
      jobId: 'build',
    });
    expect(host.navigateToOwner).not.toHaveBeenCalled();
    expect(Object.keys(panelStore().layouts)).toEqual([]);
  });

  test('a project-only run (Cowork pipeline automation) is ownerless', async () => {
    const host = makeHost();
    host.executions.set('run-1', execution('run-1', { projectId: 'cowork-1' }));
    const opener = createPipelineExecutionOpener(host.env);

    await expect(opener.open({ executionId: 'run-1' })).resolves.toEqual({
      status: 'ownerless',
      executionId: 'run-1',
      reason: 'no-owner',
    });
  });

  test('an App Advisor-owned run opens in the compatibility host', async () => {
    const host = makeHost();
    const appAdvisorOwner = { projectId: 'app-advisor', worktreeId: 'entry-9' };
    host.executions.set('run-1', execution('run-1', appAdvisorOwner));
    host.classification.set('app-advisor/entry-9', 'unsupported');
    const opener = createPipelineExecutionOpener(host.env);

    await expect(opener.open({ executionId: 'run-1' })).resolves.toEqual({
      status: 'ownerless',
      executionId: 'run-1',
      reason: 'unsupported-owner',
    });
    expect(host.openCompatibility).toHaveBeenCalledWith('run-1', undefined);
  });
});

describe('placement and reveal', () => {
  test('opens beside the origin chat of the same owner', async () => {
    const host = makeHost();
    panelStore().initializeLayout(KEY, layoutWithChat('chat-1'));
    host.executions.set('run-1', execution('run-1'));
    const opener = createPipelineExecutionOpener(host.env);

    const result = applied(
      await opener.open({
        executionId: 'run-1',
        origin: { chatTabId: 'chat-1', ownerKey: KEY },
      }),
    );

    expect(result.outcome).toBe('placed');
    expect(
      findPanelByInstanceKey(KEY, 'pipeline-execution:run-1')?.groupId,
    ).not.toBe('group-chat');
  });

  test('a cross-owner origin never receives the run and stays untouched', async () => {
    const host = makeHost();
    panelStore().initializeLayout(KEY, layoutWithChat('chat-1'));
    panelStore().initializeLayout(OTHER_KEY, layoutWithChat('chat-other'));
    const otherBefore = panelStore().layouts[OTHER_KEY];
    host.executions.set('run-1', execution('run-1'));
    const opener = createPipelineExecutionOpener(host.env);

    const result = applied(
      await opener.open({
        executionId: 'run-1',
        origin: { chatTabId: 'chat-other', ownerKey: OTHER_KEY },
      }),
    );

    expect(result.ownerKey).toBe(KEY);
    expect(runTabs(KEY)).toEqual(['run-1']);
    expect(panelStore().layouts[OTHER_KEY]).toBe(otherBefore);
  });

  test('reveals an existing tab in place, leaving a conflicting maximize, without moving it', async () => {
    const host = makeHost();
    panelStore().initializeLayout(KEY, layoutWithChat('chat-1'));
    panelStore().addTab(KEY, 'group-terminal', 'pipeline-execution', {
      panelId: 'panel-pipeline-run-1',
      instance: { executionId: 'run-1' },
    });
    panelStore().selectTab(KEY, 'group-terminal', 'panel-terminal');
    panelStore().maximizeGroup(KEY, 'group-chat', true);
    const groupsBefore = Object.keys(panelStore().layouts[KEY].groups);
    host.executions.set('run-1', execution('run-1'));
    const opener = createPipelineExecutionOpener(host.env);

    const result = applied(
      await opener.open({
        executionId: 'run-1',
        origin: { chatTabId: 'chat-1', ownerKey: KEY },
      }),
    );

    expect(result).toMatchObject({
      outcome: 'revealed',
      layoutKey: KEY,
      panelId: 'panel-pipeline-run-1',
    });
    const layout = panelStore().layouts[KEY];
    expect(Object.keys(layout.groups)).toEqual(groupsBefore);
    expect(layout.groups['group-terminal']?.activePanelId).toBe(
      'panel-pipeline-run-1',
    );
    expect(layout.maximizedGroupId ?? null).toBeNull();
    expect(runTabs(KEY)).toEqual(['run-1']);
  });

  test('reveals a tab in an auxiliary window without navigating the main window', async () => {
    const host = makeHost();
    panelStore().initializeLayout(KEY, layoutWithChat('chat-1'));
    panelStore().addTab(KEY, 'group-terminal', 'pipeline-execution', {
      panelId: 'panel-pipeline-run-1',
      instance: { executionId: 'run-1' },
    });
    const auxKey = makeAuxPanelLayoutKey(KEY, 'aux-runs');
    expect(
      panelStore().extractGroupToLayout(KEY, 'group-terminal', auxKey),
    ).toBe(true);
    host.executions.set('run-1', execution('run-1'));
    const opener = createPipelineExecutionOpener(host.env);

    const result = applied(await opener.open({ executionId: 'run-1' }));

    expect(result).toMatchObject({ outcome: 'revealed', layoutKey: auxKey });
    expect(host.navigateToOwner).not.toHaveBeenCalled();
    expect(focusAuxWindow).toHaveBeenCalledWith(auxKey);
  });

  test('applies an explicit target to an already-open panel', async () => {
    const host = makeHost();
    host.executions.set('run-1', execution('run-1'));
    const opener = createPipelineExecutionOpener(host.env);
    const first = applied(
      await opener.open({ executionId: 'run-1', target: { jobId: 'build' } }),
    );
    const uiKey = pipelinePanelUiKey(KEY, first.panelId);
    expect(usePipelinePanelUiStore.getState().entries[uiKey]).toMatchObject({
      selection: { jobId: 'build' },
      revealNonce: 1,
    });

    const second = applied(
      await opener.open({
        executionId: 'run-1',
        target: {
          viewStack: [{ executionId: 'child-1', label: 'Child' }],
          jobId: 'deploy',
          variantJobId: 'deploy__1',
        },
      }),
    );

    expect(second).toMatchObject({
      outcome: 'revealed',
      panelId: first.panelId,
    });
    expect(usePipelinePanelUiStore.getState().entries[uiKey]).toMatchObject({
      executionId: 'run-1',
      viewStack: [{ executionId: 'child-1', label: 'Child' }],
      selection: { jobId: 'deploy', variantJobId: 'deploy__1' },
      revealNonce: 2,
    });
    expect(runTabs(KEY)).toEqual(['run-1']);
  });

  test('a plain open keeps the panel on its current view', async () => {
    const host = makeHost();
    host.executions.set('run-1', execution('run-1'));
    const opener = createPipelineExecutionOpener(host.env);
    const first = applied(
      await opener.open({ executionId: 'run-1', target: { jobId: 'build' } }),
    );

    await opener.open({ executionId: 'run-1' });

    expect(
      usePipelinePanelUiStore.getState().entries[
        pipelinePanelUiKey(KEY, first.panelId)
      ],
    ).toMatchObject({ selection: { jobId: 'build' }, revealNonce: 1 });
  });

  test('reports an owner whose layout could not be built', async () => {
    const host = makeHost();
    host.ensureLayout.mockResolvedValueOnce(undefined);
    host.executions.set('run-1', execution('run-1'));
    const opener = createPipelineExecutionOpener(host.env);

    await expect(opener.open({ executionId: 'run-1' })).resolves.toMatchObject({
      status: 'error',
      code: 'layout_unavailable',
    });
  });
});

describe('owners resolved against hydrated projects', () => {
  const initialProjects = useProjectsStore.getState();

  function codeProject(
    projectId: string,
    worktreeIds: readonly string[],
  ): SingleRepoSidebarItem {
    return {
      type: 'single-repo',
      id: projectId,
      name: projectId,
      repoPath: `/repos/${projectId}`,
      color: '#111111',
      worktrees: worktreeIds.map((id) => ({
        id,
        branchName: `branch/${id}`,
        createdAt: new Date(0).toISOString(),
      })),
      collapsed: false,
      order: 0,
    };
  }

  /** The fake host, with the production owner directory and classifier. */
  function openerWithProjects(timeoutMs: number): {
    host: FakeHost;
    open: (executionId: string) => Promise<OpenPipelineExecutionResult>;
  } {
    const host = makeHost();
    const opener = createPipelineExecutionOpener({
      ...host.env,
      classifyOwner: classifyPipelineExecutionOwner,
      waitForOwnerDirectory: () =>
        waitForPipelineExecutionOwnerDirectory(timeoutMs),
    });
    return {
      host,
      open: (executionId) => opener.open({ executionId }),
    };
  }

  /** Lets any request that is not blocked on hydration run to completion. */
  async function drainMicrotasks(): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await Promise.resolve();
    }
  }

  beforeEach(() => {
    // Startup: the sidebar has not listed any project yet.
    useProjectsStore.setState({ projects: [], hasHydratedProjects: false });
  });

  afterEach(() => {
    useProjectsStore.setState({
      projects: initialProjects.projects,
      hasHydratedProjects: initialProjects.hasHydratedProjects,
    });
  });

  test('an early open for a deleted owner waits for hydration, then reports it missing', async () => {
    const { host, open } = openerWithProjects(10_000);
    host.executions.set('run-1', execution('run-1'));

    const pending = open('run-1');
    await drainMicrotasks();
    expect(host.navigateToOwner).not.toHaveBeenCalled();

    // Hydration lands without the run's worktree: it was deleted.
    useProjectsStore.setState({
      projects: [codeProject(PROJECT_ID, ['worktree-other'])],
      hasHydratedProjects: true,
    });

    await expect(pending).resolves.toEqual({
      status: 'error',
      code: 'owner_missing',
      message: PIPELINE_RUN_OPEN_ERROR_MESSAGES.owner_missing,
    });
    expect(host.navigateToOwner).not.toHaveBeenCalled();
    expect(host.ensureLayout).not.toHaveBeenCalled();
    expect(Object.keys(panelStore().layouts)).toEqual([]);
  });

  test('an early open for a deleted project reports it missing after hydration', async () => {
    const { host, open } = openerWithProjects(10_000);
    host.executions.set('run-1', execution('run-1'));

    const pending = open('run-1');
    await drainMicrotasks();
    useProjectsStore.setState({
      projects: [codeProject('project-other', ['worktree-other'])],
      hasHydratedProjects: true,
    });

    await expect(pending).resolves.toMatchObject({ code: 'owner_missing' });
    expect(host.ensureLayout).not.toHaveBeenCalled();
    expect(Object.keys(panelStore().layouts)).toEqual([]);
  });

  test('an early open for a live owner waits for hydration, then applies', async () => {
    const { host, open } = openerWithProjects(10_000);
    host.executions.set('run-1', execution('run-1'));

    const pending = open('run-1');
    await drainMicrotasks();
    expect(host.navigateToOwner).not.toHaveBeenCalled();
    expect(host.ensureLayout).not.toHaveBeenCalled();

    useProjectsStore.setState({
      projects: [codeProject(PROJECT_ID, [WORKTREE_ID])],
      hasHydratedProjects: true,
    });

    expect(applied(await pending)).toMatchObject({
      ownerKey: KEY,
      outcome: 'placed',
    });
    expect(host.navigateToOwner).toHaveBeenCalledWith(OWNER, 'code');
    expect(runTabs(KEY)).toEqual(['run-1']);
  });

  test('projects that never hydrate end the open with a bounded, retryable error', async () => {
    const { host, open } = openerWithProjects(25);
    host.executions.set('run-1', execution('run-1'));

    await expect(open('run-1')).resolves.toEqual({
      status: 'error',
      code: 'navigation_failed',
      message: PIPELINE_RUN_OPEN_ERROR_MESSAGES.navigation_failed,
    });
    expect(host.navigateToOwner).not.toHaveBeenCalled();
    expect(host.ensureLayout).not.toHaveBeenCalled();
    expect(Object.keys(panelStore().layouts)).toEqual([]);
  });

  test('an owner deleted while its layout loads is reported missing, not placed', async () => {
    useProjectsStore.setState({
      projects: [codeProject(PROJECT_ID, [WORKTREE_ID])],
      hasHydratedProjects: true,
    });
    const { host, open } = openerWithProjects(10_000);
    host.executions.set('run-1', execution('run-1'));
    const layoutReady = deferred<undefined>();
    host.ensureLayout.mockImplementationOnce((ownerKey) =>
      layoutReady.promise.then(() => {
        panelStore().initializeLayout(ownerKey, layoutWithChat('chat-1'));
      }),
    );

    const pending = open('run-1');
    await flushUntil(() => host.ensureLayout.mock.calls.length === 1);
    // The worktree is removed while its layout restores.
    useProjectsStore.setState({
      projects: [codeProject(PROJECT_ID, [])],
    });
    layoutReady.resolve(undefined);

    await expect(pending).resolves.toMatchObject({
      status: 'error',
      code: 'owner_missing',
    });
    expect(runTabs(KEY)).toEqual([]);
  });
});

describe('coalescing and stale focus', () => {
  test('concurrent opens of one run coalesce into one navigation and one tab', async () => {
    const host = makeHost();
    const read = deferred<ExecutionState | null>();
    host.readExecution.mockReturnValue(read.promise);
    const opener = createPipelineExecutionOpener(host.env);

    const first = opener.open({ executionId: 'run-1' });
    const second = opener.open({
      executionId: 'run-1',
      target: { jobId: 'deploy' },
    });
    read.resolve(execution('run-1'));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(host.readExecution).toHaveBeenCalledTimes(1);
    expect(host.navigateToOwner).toHaveBeenCalledTimes(1);
    expect(firstResult).toEqual(secondResult);
    expect(applied(secondResult).outcome).toBe('placed');
    expect(runTabs(KEY)).toEqual(['run-1']);
    expect(
      usePipelinePanelUiStore.getState().entries[
        pipelinePanelUiKey(KEY, 'panel-pipeline-run-1')
      ]?.selection,
    ).toEqual({ jobId: 'deploy' });
  });

  test('an open superseded by another run never navigates or reveals', async () => {
    const host = makeHost();
    host.executions.set('run-2', execution('run-2', OTHER_OWNER));
    const slowRead = deferred<ExecutionState | null>();
    host.readExecution.mockImplementation((executionId) =>
      executionId === 'run-1'
        ? slowRead.promise
        : Promise.resolve(host.executions.get(executionId) ?? null),
    );
    const opener = createPipelineExecutionOpener(host.env);

    const stale = opener.open({ executionId: 'run-1' });
    const latest = await opener.open({ executionId: 'run-2' });
    slowRead.resolve(execution('run-1'));

    await expect(stale).resolves.toMatchObject({
      status: 'error',
      code: 'superseded',
    });
    expect(applied(latest).ownerKey).toBe(OTHER_KEY);
    expect(host.navigateToOwner).toHaveBeenCalledTimes(1);
    expect(host.navigateToOwner).toHaveBeenCalledWith(OTHER_OWNER, 'code');
    expect(host.shown.owner).toEqual(OTHER_OWNER);
    expect(runTabs(KEY)).toEqual([]);
  });

  test('a navigation superseded mid-flight does not place or steal focus back', async () => {
    const host = makeHost();
    host.executions.set('run-1', execution('run-1'));
    host.executions.set('run-2', execution('run-2', OTHER_OWNER));
    const slowNavigation = deferred<PipelineExecutionNavigationOutcome>();
    host.navigateToOwner.mockImplementationOnce((owner) => {
      host.shown.owner = owner;
      return slowNavigation.promise;
    });
    const opener = createPipelineExecutionOpener(host.env);

    const stale = opener.open({ executionId: 'run-1' });
    await flushUntil(() => host.navigateToOwner.mock.calls.length === 1);
    const latest = await opener.open({ executionId: 'run-2' });
    slowNavigation.resolve('shown');

    await expect(stale).resolves.toMatchObject({ code: 'superseded' });
    expect(applied(latest).ownerKey).toBe(OTHER_KEY);
    expect(host.shown.owner).toEqual(OTHER_OWNER);
    expect(runTabs(KEY)).toEqual([]);
  });

  test('never pulls the user back after they navigate away while the layout loads', async () => {
    const host = makeHost();
    host.executions.set('run-1', execution('run-1'));
    const layoutReady = deferred<undefined>();
    host.ensureLayout.mockImplementationOnce((ownerKey) =>
      layoutReady.promise.then(() => {
        panelStore().initializeLayout(ownerKey, layoutWithChat('chat-1'));
      }),
    );
    const opener = createPipelineExecutionOpener(host.env);

    const pending = opener.open({ executionId: 'run-1' });
    await flushUntil(() => host.ensureLayout.mock.calls.length === 1);
    // The user picks another worktree before the owner's layout is ready.
    host.shown.owner = OTHER_OWNER;
    layoutReady.resolve(undefined);

    await expect(pending).resolves.toMatchObject({ code: 'superseded' });
    expect(runTabs(KEY)).toEqual([]);
    expect(host.shown.owner).toEqual(OTHER_OWNER);
  });
});
