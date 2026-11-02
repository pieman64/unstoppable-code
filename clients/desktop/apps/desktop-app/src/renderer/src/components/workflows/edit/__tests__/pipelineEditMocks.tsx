/**
 * Shared mock state for the pipeline edit shell suites (CAN-4072). The suites
 * mock `usePipelineEditor` through `useMockPipelineEditor`, so each test picks
 * the editor a target loads by its pipeline id, and Flow/List/Raw and the
 * settings panel switch for real.
 *
 *   jest.mock('@/hooks/usePipelineEditor', () => ({
 *     usePipelineEditor: (target: { pipelineId: string | null }) =>
 *       jest
 *         .requireActual<typeof PipelineEditMocks>('./pipelineEditMocks')
 *         .useMockPipelineEditor(target),
 *   }));
 *
 * It imports only React and types, so a mock factory can load it before the
 * components under test. It also holds the page API stubs the suites share.
 */
import { useCallback, useRef, useState } from 'react';
import type {
  ActivePanel,
  MainView,
  UsePipelineEditorReturn,
} from '@/hooks/usePipelineEditor';
import type { PipelineInfo } from '@canopy/desktop-shared/types/pipeline';
import type { AutomationScope } from '@/hooks/useAutomationScope';
import type { AutomationsPageBodyApi } from '../../../pages/AutomationsPage';
import type { PipelinesPageListApi } from '../../../pages/PipelinesPage';

/** The key a target's editor is registered under: its id, or `draft`. */
export const DRAFT_EDITOR_KEY = 'draft';

interface MockEditorRegistry {
  readonly editors: Map<string, UsePipelineEditorReturn>;
  /** Every target `usePipelineEditor` was called with, in order. */
  readonly targets: { pipelineId: string | null; draftKey?: string }[];
}

export const pipelineEditorMock: MockEditorRegistry = {
  editors: new Map(),
  targets: [],
};

export function pipelineInfo(
  overrides: Partial<PipelineInfo> = {},
): PipelineInfo {
  return {
    id: 'review',
    name: 'Review',
    filename: 'review.yaml',
    description: '',
    icon: '',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    source: 'user',
    readonly: false,
    triggerTypes: ['dispatch'],
    scopes: ['directory'],
    ...overrides,
  };
}

/**
 * An editable, dirty user pipeline named `Review`, unless overridden. Save
 * resolves the editor's `pipelineInfo`.
 */
export function makeMockEditor(
  overrides: Partial<UsePipelineEditorReturn> = {},
): UsePipelineEditorReturn {
  const info =
    overrides.pipelineInfo === undefined
      ? pipelineInfo()
      : overrides.pipelineInfo;
  return {
    pipeline: {
      name: 'Review',
      description: 'Review a change.',
      version: '1',
      on: 'dispatch',
      jobs: {
        review: {
          steps: [{ id: 'review-step', uses: 'builtin/agent-prompt' }],
        },
      },
    },
    pipelineInfo: info,
    loading: false,
    error: null,
    readonly: false,
    jobOrder: ['review'],
    validation: [],
    canSave: true,
    selection: { type: 'none' },
    setSelection: jest.fn(),
    activePanel: 'steps',
    setActivePanel: jest.fn(),
    mainView: 'flowchart',
    setMainView: jest.fn(),
    updatePipelineField: jest.fn(),
    updateDefaults: jest.fn(),
    updateEnv: jest.fn(),
    addJob: jest.fn(),
    removeJob: jest.fn(),
    updateJob: jest.fn(),
    renameJob: jest.fn(),
    addStep: jest.fn(),
    removeStep: jest.fn(),
    updateStep: jest.fn(),
    reorderSteps: jest.fn(),
    moveStepBetweenJobs: jest.fn(),
    replaceEntirePipeline: jest.fn(),
    canUndo: true,
    canRedo: false,
    undo: jest.fn(),
    redo: jest.fn(),
    isDirty: true,
    saving: false,
    save: jest.fn().mockResolvedValue(info),
    ...overrides,
  };
}

/** Registers the editor `pipelineId` loads; `null` registers the draft's. */
export function setMockEditor(
  pipelineId: string | null,
  overrides: Partial<UsePipelineEditorReturn> = {},
): UsePipelineEditorReturn {
  const editor = makeMockEditor(overrides);
  pipelineEditorMock.editors.set(pipelineId ?? DRAFT_EDITOR_KEY, editor);
  return editor;
}

export function resetMockEditors(): void {
  pipelineEditorMock.editors.clear();
  pipelineEditorMock.targets.length = 0;
}

const MISSING_EDITOR = makeMockEditor({
  pipeline: null,
  pipelineInfo: null,
  isDirty: false,
  canSave: false,
  error: 'Pipeline not found',
});

/**
 * `usePipelineEditor` over the registered editor. The view and the panel are
 * state, so the session's Raw text and the settings drawer behave as they do
 * in the app; the registered editor's own setters are still called.
 */
export function useMockPipelineEditor(target: {
  pipelineId: string | null;
  draftKey?: string;
}): UsePipelineEditorReturn {
  pipelineEditorMock.targets.push({ ...target });
  const base =
    pipelineEditorMock.editors.get(target.pipelineId ?? DRAFT_EDITOR_KEY) ??
    MISSING_EDITOR;
  const baseRef = useRef(base);
  baseRef.current = base;
  const [mainView, setMainViewState] = useState<MainView>(base.mainView);
  const [activePanel, setActivePanelState] = useState<ActivePanel>(
    base.activePanel,
  );
  const setMainView = useCallback((view: MainView): void => {
    baseRef.current.setMainView(view);
    setMainViewState(view);
  }, []);
  const setActivePanel = useCallback((panel: ActivePanel): void => {
    baseRef.current.setActivePanel(panel);
    setActivePanelState(panel);
  }, []);
  return { ...base, mainView, setMainView, activePanel, setActivePanel };
}

const SCOPE: AutomationScope = {
  context: undefined,
  inContext: () => true,
  watcherInContext: () => true,
  shareInContext: () => true,
  contextLabel: null,
  ownerLabel: () => 'Personal',
  runsInLabel: () => null,
  labelForWorkspace: () => 'Personal',
  memberOfWorkspace: () => true,
  projectsInContext: [],
};

export function pipelinesApi(
  overrides: Partial<PipelinesPageListApi> = {},
): PipelinesPageListApi {
  return {
    pipelines: [],
    loading: false,
    error: null,
    refresh: jest.fn(() => Promise.resolve()),
    shared: {
      cloudAccount: null,
      cloudLoading: false,
      rows: [],
      loading: false,
      loadingMore: false,
      nextCursor: null,
      error: null,
      loaded: false,
    },
    refreshSharedList: jest.fn(() => Promise.resolve()),
    loadMoreSharedList: jest.fn(() => Promise.resolve()),
    disabledPipelineIds: new Set<string>(),
    setPipelineEnabled: jest.fn(() => Promise.resolve()),
    createNew: jest.fn(),
    startInterview: jest.fn(),
    interviewPending: false,
    edit: jest.fn(),
    remove: jest.fn(() => Promise.resolve()),
    duplicate: jest.fn(() => Promise.resolve()),
    share: jest.fn(),
    sharePendingId: null,
    shareError: null,
    headerAction: null,
    assistant: { open: false, toggle: jest.fn() },
    projectId: undefined,
    projectContext: undefined,
    projectContextPending: false,
    openDuplicate: jest.fn(() => Promise.resolve()),
    ...overrides,
  };
}

export function automationsApi(
  overrides: Partial<AutomationsPageBodyApi> = {},
): AutomationsPageBodyApi {
  return {
    activities: [],
    scopedActivities: [],
    recentRuns: [],
    loading: false,
    error: null,
    reload: jest.fn(() => Promise.resolve()),
    mutationError: null,
    scope: SCOPE,
    describeAction: () => 'Run a pipeline',
    beginCreate: jest.fn(),
    beginEdit: jest.fn(),
    beginView: jest.fn(),
    runNow: jest.fn(() => Promise.resolve({ ok: true as const })),
    toggleEnabled: jest.fn(() => Promise.resolve({ ok: true as const })),
    share: jest.fn(),
    remove: jest.fn(() => Promise.resolve()),
    runningActivityId: null,
    revealedActivityId: null,
    revealNotice: null,
    endReveal: jest.fn(),
    ...overrides,
  };
}
