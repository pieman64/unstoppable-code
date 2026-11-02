/**
 * @jest-environment jsdom
 */
jest.mock('@/components/settings/AuthLoginModal', () => ({
  AuthLoginModal: (): null => null,
}));

// Static source-level coverage keeps this focused on the Automations page
// contract without mounting its project/chat/pipeline store dependencies.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';
import { act, createElement, type ReactElement } from 'react';
import type { ConfigurationChatComposerProps } from '@/components/shared/ConfigurationChatComposer.types';
import { createRoot, type Root } from 'react-dom/client';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  type AutomationMutationResponse,
  type AutomationUpdateRequest,
  type AppAdvisorWatcherSummary,
  type ScheduledActivity,
  type ScheduledActivityRun,
} from '@canopy/desktop-shared/types';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useAutomationsStore } from '@/stores/automationsStore';
import { AutomationAuthorTargetRequirement } from '@/components/automations/AutomationAuthorTargetRequirement';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useSidebarItemGroupsStore } from '@/stores/sidebarItemGroupsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useLinkedPersonalWorkspacesStore } from '@/stores/linkedPersonalWorkspacesStore';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { getAutomationChatRunMode } from '@canopy/desktop-shared/lib/automations';
import {
  AutomationsPage,
  actionCategoryForType,
  activityToFormState,
  applyAppAdvisorActionCategorySelection,
  applyAppAdvisorRunModeSelection,
  applyChatRunModeSelection,
  applyChatTargetSelection,
  applyWorkspaceActionSelection,
  automationFormActionCategory,
  automationFormChatRunMode,
  automationFormChatTarget,
  automationFormSidebarGroupScope,
  buildAction,
  hasChatAuthoredPayload,
  isAppAdvisorSessionPrompt,
  emptyFormState,
  isPreviouslyTriggeredOneTime,
  resolveRepickedSharedPipeline,
  selectedAutomationWorkspaceId,
  workspaceActionModeForType,
} from '../AutomationsPage';
import { WorkflowsTabContext } from '@/components/workflows/workflowsTabContext';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Renders the page's own list inside the Workflows tab context it reads its
 * header from. The Workflows tabs now draw their own surfaces through
 * `renderBody` (CAN-3981); these tests pin the dialogs and the list the page
 * still renders without it, and that New, Edit and row clicks open the
 * Workflows edit shell (CAN-4072), whose form has its own suites under
 * `workflows/edit/__tests__/`.
 */
function WorkflowsAutomationsHarness(): ReactElement {
  return createElement(
    WorkflowsTabContext.Provider,
    {
      value: {
        tab: 'workflows-library',
        keyboardTarget: { current: null },
      },
    },
    createElement(AutomationsPage),
  );
}

beforeEach(() => {
  useNavigationStore.setState({ activePage: 'workflows-library' });
});

// The page no longer mounts the form (the Workflows edit shell does,
// CAN-4072); the composer stays mocked so nothing here pulls in its editor.
jest.mock('@/components/shared/ConfigurationChatComposer', () => ({
  ConfigurationChatComposer: (
    props: ConfigurationChatComposerProps,
  ): ReactElement => {
    return createElement('textarea', {
      'data-testid': props.dataTestId,
      'data-context': JSON.stringify(props.context),
      'data-additional-plugins': JSON.stringify(props.value.plugins),
      value: props.value.prompt,
      readOnly: props.readOnly,
      onChange: (event: { target: { value: string } }) =>
        props.onChange({ ...props.value, prompt: event.target.value }),
    });
  },
}));

// The page's form state and fields live in `automations/form/`; the source
// contract covers the page together with them.
const AUTOMATIONS_PAGE_SOURCE = [
  join(__dirname, '..', 'AutomationsPage.tsx'),
  join(__dirname, '..', '..', 'automations', 'form', 'automationFormState.ts'),
  join(__dirname, '..', '..', 'automations', 'form', 'ActivityFormBody.tsx'),
  join(__dirname, '..', '..', 'workflows', 'edit', 'AutomationEditAdapter.tsx'),
]
  .map((path) => readFileSync(path, 'utf-8'))
  .join('\n');

describe('configuration composer payload', () => {
  it('retains chat-authored reference kinds and offsets when changing its destination', () => {
    const result = buildAction({
      ...emptyFormState(),
      actionType: 'worktree_session_prompt',
      prompt: 'Read plugin',
      chatAuthoredPayload: true,
      worktreeSessionTarget: { workspaceId: 'p', worktreeId: 'w', chatId: 'c' },
      fileReferences: [
        {
          displayPath: 'plugin',
          absolutePath: 'plugin://market/plugin',
          kind: 'plugin',
          textStart: 5,
        },
      ],
    });
    expect(result.action).toMatchObject({
      fileReferences: [
        {
          displayPath: 'plugin',
          absolutePath: 'plugin://market/plugin',
          kind: 'plugin',
          textStart: 5,
        },
      ],
    });
  });

  it('shifts repeated reference occurrences on save and preserves them on reopen', () => {
    const promptReferences = [2, 15].map((textStart) => ({
      kind: 'file' as const,
      root: { kind: 'workspace' as const },
      relativePath: 'README.md',
      displayText: '@README.md',
      textStart,
    }));
    const result = buildAction({
      ...emptyFormState(),
      actionType: 'worktree_prompt',
      workspaceId: 'project',
      prompt: '  @README.md + @README.md  ',
      promptReferences,
      approvalMode: 'ask',
      planMode: false,
    });
    expect(result.error).toBeUndefined();
    if (!result.action) throw new Error('Expected a saved action');
    const saved = result.action;
    expect(saved).toMatchObject({
      prompt: '@README.md + @README.md',
      promptReferences: promptReferences.map((ref) => ({
        ...ref,
        textStart: ref.textStart - 2,
      })),
      planMode: false,
      approvalMode: 'ask',
    });
    const reopened = activityToFormState(activity({ action: saved }));
    expect(buildAction(reopened).action).toEqual(saved);
  });

  it('saves and reopens every Codex speed with its derived boolean', () => {
    const speeds = [
      ['standard', false],
      ['fast', true],
      ['ultrafast', false],
    ] as const;
    for (const [speed, fastMode] of speeds) {
      const result = buildAction({
        ...emptyFormState(),
        actionType: 'worktree_prompt',
        workspaceId: 'project',
        prompt: 'Run',
        chatModelConfig: { thinkingLevel: 'high', speed, fastMode },
        thinkingLevel: 'high',
        fastMode,
      });
      if (!result.action) throw new Error('Expected a saved action');
      expect(result.action).toMatchObject({
        modelConfig: { thinkingLevel: 'high', speed, fastMode },
      });
      const reopened = activityToFormState(activity({ action: result.action }));
      expect(buildAction(reopened).action).toEqual(result.action);
    }
  });

  it('never serializes an exact speed beside a contradictory legacy boolean', () => {
    const result = buildAction({
      ...emptyFormState(),
      actionType: 'worktree_prompt',
      workspaceId: 'project',
      prompt: 'Run',
      chatModelConfig: { speed: 'ultrafast', fastMode: false },
      fastMode: true,
    });
    expect(result.action).toMatchObject({
      modelConfig: { speed: 'ultrafast', fastMode: false },
    });
  });

  it('blocks stale reference spans but ignores parked chat references in pipeline mode', () => {
    const state = {
      ...emptyFormState(),
      prompt: 'Changed',
      promptReferences: [
        {
          kind: 'file' as const,
          root: { kind: 'workspace' as const },
          relativePath: 'README.md',
          displayText: '@README.md',
          textStart: 0,
        },
      ],
    };
    expect(buildAction(state).error).toContain('does not match');
    expect(
      buildAction({
        ...state,
        actionType: 'worktree_pipeline',
        workspaceId: 'p',
        pipelineId: 'review',
      }).action?.type,
    ).toBe('worktree_pipeline');
  });

  it('leaves inherited settings absent on an untouched existing-chat configuration', () => {
    const result = buildAction({
      ...emptyFormState(),
      actionType: 'worktree_session_prompt',
      prompt: 'Continue',
      worktreeSessionTarget: {
        workspaceId: 'project',
        worktreeId: 'work',
        chatId: 'chat',
      },
    });
    expect(result.action).toEqual({
      type: 'worktree_session_prompt',
      workspaceId: 'project',
      worktreeId: 'work',
      chatId: 'chat',
      prompt: 'Continue',
    });
  });

  it('preserves explicit existing-chat settings and logical references', () => {
    const state = {
      ...emptyFormState(),
      actionType: 'worktree_session_prompt' as const,
      prompt: 'Read @README.md',
      worktreeSessionTarget: {
        workspaceId: 'project',
        worktreeId: 'work',
        chatId: 'chat',
      },
      model: 'gpt-6-sol',
      thinkingLevel: 'high' as const,
      fastMode: false,
      planMode: false,
      approvalMode: 'full-access' as const,
      promptReferences: [
        {
          kind: 'file' as const,
          root: { kind: 'workspace' as const },
          relativePath: 'README.md',
          displayText: '@README.md',
          textStart: 5,
        },
      ],
    };
    expect(buildAction(state).action).toMatchObject({
      model: 'gpt-6-sol',
      modelConfig: { thinkingLevel: 'high', fastMode: false },
      planMode: false,
      approvalMode: 'full-access',
      promptReferences: state.promptReferences,
    });
  });
});

function watcher(
  overrides: Partial<AppAdvisorWatcherSummary> = {},
): AppAdvisorWatcherSummary {
  return {
    id: overrides.id ?? 'watcher-1',
    trigger: overrides.trigger ?? 'worktree_chat_completion',
    status: overrides.status ?? 'active',
    label: overrides.label ?? 'Release watcher',
    target: overrides.target ?? {
      kind: 'worktree_chat',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'watched-chat',
      workspaceName: 'Canopy',
      worktreeBranchName: 'feature/automations',
      chatTitle: 'Watched chat',
    },
    destination: overrides.destination ?? {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      chatId: 'advisor-chat',
    },
    createdAt: overrides.createdAt ?? '2026-05-27T00:00:00.000Z',
    ...(overrides.failureKind ? { failureKind: overrides.failureKind } : {}),
    ...(overrides.ownerDelegate
      ? { ownerDelegate: overrides.ownerDelegate }
      : {}),
  };
}

function activity(
  overrides: Partial<ScheduledActivity> = {},
): ScheduledActivity {
  return {
    version: 1,
    id: overrides.id ?? 'activity-1',
    name: overrides.name ?? 'Morning review',
    enabled: overrides.enabled ?? true,
    schedule: overrides.schedule ?? {
      kind: 'cron',
      expression: '0 9 * * *',
      timezone: 'local',
    },
    action: overrides.action ?? {
      type: 'app_advisor_prompt',
      prompt: 'Summarize the plan.',
    },
    createdAt: overrides.createdAt ?? '2026-05-27T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-05-27T00:00:00.000Z',
    failureCount: overrides.failureCount ?? 0,
    ...(overrides.nextRunAt ? { nextRunAt: overrides.nextRunAt } : {}),
    ...(overrides.lastResult ? { lastResult: overrides.lastResult } : {}),
    ...(overrides.ifCommand ? { ifCommand: overrides.ifCommand } : {}),
    ...(overrides.sharedPipelineReview
      ? { sharedPipelineReview: overrides.sharedPipelineReview }
      : {}),
  };
}

function run(
  overrides: Partial<ScheduledActivityRun> = {},
): ScheduledActivityRun {
  return {
    id: overrides.id ?? 'run-1',
    activityId: overrides.activityId ?? 'activity-1',
    activityName: overrides.activityName ?? 'Morning review',
    scheduledFor: overrides.scheduledFor ?? '2026-05-27T00:00:00.000Z',
    manual: overrides.manual ?? false,
    status: overrides.status ?? 'success',
    startedAt: overrides.startedAt ?? '2026-05-27T00:00:00.000Z',
    ...(overrides.completedAt ? { completedAt: overrides.completedAt } : {}),
    ...(overrides.error ? { error: overrides.error } : {}),
    ...(overrides.result ? { result: overrides.result } : {}),
  };
}

describe('AutomationsPage triggered activity coverage', () => {
  it('hydrates automations and watcher stores and reports the Automations UI slice', () => {
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('useAutomationsStore');
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('subscribeBridge();');
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('void store.hydrate();');
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      'const store = useAutomationsStore.getState();',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      'validateAutomationTrigger(trigger)',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      'const store = useAppAdvisorWatchersStore.getState();',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      'if (!store.hydrated && !store.loading)',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      "useCurrentUiStateReporter('automations.page'",
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('activeTab');
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('activityCount');
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('enabledActivityCount');
    // The form and run-history flags derive from the edit shell's slice.
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      "useCurrentUiStateReporter('workflows.editShell'",
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('sharedPipelineReviewModalOpen');
  });

  it('renders the planned page frame, triggered/watchers tabs, empty state, and activity row controls', () => {
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      '<PageContent className="flex flex-1 flex-col">',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('Automations');
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('New automation');
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('Triggered');
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('Watchers');
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('No triggered activities');
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      'Create a scheduled or one-time trigger.',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      'testId={`automations-run-now-${activity.id}`}',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      'data-testid={`automations-toggle-${activity.id}`}',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      'testId={`automations-edit-${activity.id}`}',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      'testId={`automations-delete-${activity.id}`}',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('Confirm delete');
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      'data-testid="automations-empty-new"',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toMatch(
      /<Button\s+variant="primary"\s+size="compact"\s+onClick=\{onBeginCreate\}/,
    );
    expect(AUTOMATIONS_PAGE_SOURCE).not.toMatch(
      /text-(?:sky|amber|emerald|red)-(?:100|200|300)/,
    );
  });

  it('splits successfully triggered one-time activities into a collapsed Previously Triggered section', () => {
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('isPreviouslyTriggeredOneTime');
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('Date.parse(activity.nextRunAt)');
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('Previously triggered');
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      'data-testid="automations-previously-triggered-toggle"',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      'No upcoming triggered activities.',
    );
  });

  it('keeps a successful one-time activity active while its next run is still upcoming', () => {
    const oneTime = activity({
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-27T12:00:00.000Z',
        timezone: 'local',
      },
      nextRunAt: '2026-05-27T12:00:00.000Z',
      lastResult: {
        status: 'success',
        completedAt: '2026-05-27T10:00:00.000Z',
      },
    });

    expect(
      isPreviouslyTriggeredOneTime(
        oneTime,
        Date.parse('2026-05-27T11:00:00.000Z'),
      ),
    ).toBe(false);
    expect(
      isPreviouslyTriggeredOneTime(
        oneTime,
        Date.parse('2026-05-27T12:00:00.000Z'),
      ),
    ).toBe(true);
  });

  it('supports scheduled and one-time triggers with validation and next-trigger previews', () => {
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('validateAutomationTrigger');
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('formatCronValidationError');
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('getNextAutomationTriggerRun');
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('Choose a future time.');
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('Next trigger:');
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('Triggers at');
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      'testId="automations-form-schedule-kind"',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      'data-testid="automations-form-cron"',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      'data-testid="automations-form-date"',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      'data-testid="automations-form-time"',
    );
  });

  it('renders all planned action-specific form fields and submits create/update payloads through the store', () => {
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      'await createActivity(built.request)',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      'await updateActivity(built.request)',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain("'app_advisor_prompt'");
    expect(AUTOMATIONS_PAGE_SOURCE).toContain("'worktree_prompt'");
    expect(AUTOMATIONS_PAGE_SOURCE).toContain("'worktree_pipeline'");
    expect(AUTOMATIONS_PAGE_SOURCE).toContain("'standalone_prompt'");
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      'dataTestId="automations-form-prompt"',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      'testId="automations-form-workspace"',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      'testId="automations-form-base-worktree"',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('<ConfigurationChatComposer');
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('<InterfaceModePill');
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      'dataTestId="automations-form-interface-mode"',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      'data-testid="automations-form-pipeline"',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('PipelineTriggerModal');
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('runLabel="Use workflow"');
    // The overlay layer is DialogModal's own; the page no longer names it.
    expect(AUTOMATIONS_PAGE_SOURCE).not.toContain('overlayClassName');
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('pipelineSource: info.source');
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      'dataTestId="automations-form-workspace-action-mode"',
    );
    // The legacy standalone chat-project select is gone — cowork targets are
    // picked from the unified workspace list instead.
    expect(AUTOMATIONS_PAGE_SOURCE).not.toContain(
      'testId="automations-form-chat-project"',
    );
  });

  it('covers the Worktree Session prompt form contract', () => {
    expect(AUTOMATIONS_PAGE_SOURCE).toContain("'worktree_session_prompt'");
    // App Advisor session prompts use the shared destination picker rather
    // than a read-only target card.
    expect(AUTOMATIONS_PAGE_SOURCE).not.toContain(
      'data-testid="automations-form-worktree-session-target"',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('<AutomationChatTargetPicker');
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      '{isAppAdvisorTarget && runInControls}',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      'data-testid="automations-form-enabled"',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      'data-testid="automations-form-schedule-readonly"',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain('readOnly={formReadOnly}');
    expect(AUTOMATIONS_PAGE_SOURCE).not.toContain(
      'data-testid="automations-form-session-payload"',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).not.toContain(
      'testId="automations-form-session-input-mode"',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      "{ label: ORCHESTRATOR_LABEL, value: 'app_advisor' }",
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      "{ label: 'Project', value: 'workspace' }",
    );
    expect(AUTOMATIONS_PAGE_SOURCE).toContain(
      'label: getAutomationWorktreeLabel(worktree)',
    );
    expect(AUTOMATIONS_PAGE_SOURCE).not.toContain(
      "label: 'Worktree Session prompt', value: 'worktree_session_prompt'",
    );
  });
});

describe('AutomationsPage triggered activity interactions', () => {
  let container: HTMLDivElement;
  let root: Root;
  const createMock = jest.fn<Promise<AutomationMutationResponse>, [unknown]>();
  const updateMock = jest.fn<
    Promise<AutomationMutationResponse>,
    [AutomationUpdateRequest]
  >();
  const deleteMock = jest.fn<Promise<AutomationMutationResponse>, [unknown]>();
  const runNowMock = jest.fn<Promise<AutomationMutationResponse>, [unknown]>();
  const generateCronMock = jest.fn<
    Promise<{ ok: true; expression: string } | { ok: false; error: string }>,
    [unknown]
  >();
  const generateIfCommandMock = jest.fn<
    Promise<{ ok: true; command: string } | { ok: false; error: string }>,
    [unknown]
  >();

  beforeEach(() => {
    jest.clearAllMocks();
    useFeatureFlagsStore.setState({
      snapshot: getDefaultFeatureFlagSnapshot(),
    });
    createMock.mockResolvedValue({ ok: true, activity: activity() });
    updateMock.mockResolvedValue({ ok: true, activity: activity() });
    deleteMock.mockResolvedValue({ ok: true });
    generateCronMock.mockResolvedValue({ ok: true, expression: '30 14 * * 1' });
    generateIfCommandMock.mockResolvedValue({
      ok: true,
      command: 'test -f ~/ready-to-run.txt',
    });
    runNowMock.mockResolvedValue({
      ok: true,
      run: {
        id: 'run-1',
        activityId: 'activity-1',
        activityName: 'Morning review',
        scheduledFor: '2026-05-27T00:00:00.000Z',
        manual: true,
        status: 'success',
        startedAt: '2026-05-27T00:00:00.000Z',
      },
    });

    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        automations: {
          list: jest.fn().mockResolvedValue({ activities: [], recentRuns: [] }),
          listRuns: jest
            .fn()
            .mockResolvedValue({ runs: [], nextCursor: null, totalCount: 0 }),
          cancelRun: jest.fn().mockResolvedValue({ ok: true }),
          create: createMock,
          update: updateMock,
          delete: deleteMock,
          runNow: runNowMock,
          generateCron: generateCronMock,
          generateIfCommand: generateIfCommandMock,
          onChanged: jest.fn(() => (): void => undefined),
        },
        appAdvisor: {
          listWatchers: jest.fn().mockResolvedValue([]),
          deleteWatcher: jest.fn().mockResolvedValue({ ok: true }),
          onWatchersChanged: jest.fn(() => (): void => undefined),
          openWindow: jest.fn(),
        },
        sidebarItemGroups: {
          list: jest.fn().mockResolvedValue([]),
          onChanged: jest.fn(() => (): void => undefined),
        },
        getWorktreePath: jest
          .fn()
          .mockResolvedValue('/worktrees/base-worktree'),
        homeGetCoworkRoot: jest.fn().mockResolvedValue('/cowork/notes-root'),
      },
    });
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      writable: true,
      value: {
        list: jest.fn().mockResolvedValue({
          success: true,
          data: [{ id: 'stored-pipeline', name: 'Stored pipeline' }],
        }),
        discoverProject: jest.fn().mockResolvedValue({
          success: true,
          data: [{ id: 'pipeline-1', name: 'Release pipeline' }],
        }),
      },
    });

    useAutomationsStore.setState({
      activities: [],
      recentRuns: [],
      loading: false,
      hydrated: true,
      error: null,
      mutationError: null,
    });
    useAppAdvisorWatchersStore.setState({
      watchers: [],
      loading: false,
      hydrated: true,
      error: null,
      deleteErrors: {},
    });
    useStandaloneChatStore.setState({
      chatProjects: [
        {
          id: 'default',
          name: 'Default',
          createdAt: '2024-04-20T00:00:00.000Z',
        },
      ],
      chatProjectsLoaded: true,
    });
    useSidebarItemGroupsStore.setState({ byScope: {}, errors: {} });
    useProjectsStore.setState({
      projects: [
        {
          id: 'workspace-1',
          name: 'Canopy',
          type: 'single-repo',
          repoPath: '/repo/workspace-1',
          color: '#6366f1',
          worktrees: [
            {
              id: 'base-worktree',
              branchName: 'main',
              createdAt: '2024-04-20T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
        {
          id: 'cowork-1',
          name: 'Notes',
          type: 'cowork',
          color: '',
          collapsed: false,
          order: 0,
        },
      ],
    });
    useNavigationStore.setState({
      workflowEdit: undefined,
      pendingAutomationSharedPipelineReview: undefined,
    });
    // The Triggered list sort is sticky in localStorage; clear it so a sort
    // saved by one test cannot reorder rows in another.
    localStorage.removeItem('canopy.automations.triggeredSort');

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = '';
    localStorage.removeItem('canopy.automations.triggeredSort');
  });

  function renderPage(): void {
    act(() => {
      root.render(createElement(WorkflowsAutomationsHarness));
    });
  }

  async function clickTestId(testId: string): Promise<void> {
    await act(async () => {
      container
        .querySelector(`[data-testid="${testId}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
  }

  /** The item the Workflows edit shell (CAN-4072) was asked to show. */
  function shellTarget(): unknown {
    return useNavigationStore.getState().workflowEdit;
  }

  it('does not offer a reset for an installed declaration', async () => {
    const onChange = jest.fn();
    await act(async () => {
      root.render(
        createElement(AutomationAuthorTargetRequirement, {
          action: { type: 'app_advisor_prompt', prompt: 'Review today.' },
          requirement: { contexts: ['worktree'] },
          installed: true,
          onChange,
        }),
      );
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="automations-form-target-reset"]'),
    ).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders the triggered empty state and opens a new draft in the edit shell', async () => {
    useAutomationsStore.setState({ mutationError: 'Earlier failure.' });
    renderPage();

    expect(container.textContent).toContain('No triggered activities');
    expect(container.textContent).toContain(
      'Create a scheduled or one-time trigger.',
    );

    await clickTestId('automations-new-activity');
    expect(useNavigationStore.getState().activePage).toBe('workflows-library');
    expect(shellTarget()).toEqual({
      kind: 'automation-draft',
      draftKey: expect.any(String) as unknown,
    });
    // The form is the shell's now; the page draws no form of its own.
    expect(
      container.querySelector('[data-testid="automations-form-body"]'),
    ).toBeNull();
    expect(useAutomationsStore.getState().mutationError).toBeNull();

    // The empty state's own New does the same, with a fresh draft.
    const first = useNavigationStore.getState().workflowEdit;
    act(() => {
      useNavigationStore.setState({ workflowEdit: undefined });
    });
    await clickTestId('automations-empty-new');
    const second = useNavigationStore.getState().workflowEdit;
    expect(second?.kind).toBe('automation-draft');
    if (
      first?.kind !== 'automation-draft' ||
      second?.kind !== 'automation-draft'
    ) {
      throw new Error('expected two drafts');
    }
    expect(second.draftKey).not.toBe(first.draftKey);
  });

  it('reflects persisted running rows and hides disabled next runs', () => {
    useAutomationsStore.setState({
      activities: [
        activity({ id: 'activity-running', name: 'Background run' }),
        activity({
          id: 'activity-disabled',
          name: 'Disabled schedule',
          enabled: false,
          nextRunAt: '2099-01-01T00:00:00.000Z',
        }),
      ],
      recentRuns: [
        run({
          id: 'run-running',
          activityId: 'activity-running',
          activityName: 'Background run',
          status: 'running',
        }),
      ],
      loading: false,
      hydrated: true,
      error: null,
      mutationError: null,
    });
    renderPage();

    expect(
      (
        container.querySelector(
          '[data-testid="automations-run-now-activity-running"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      container.querySelector(
        '[data-testid="automations-toggle-activity-running"]',
      )?.textContent,
    ).toContain('Running');
    expect(
      container.querySelector(
        '[data-testid="automations-activity-row-activity-disabled"]',
      )?.textContent,
    ).not.toContain('2099');
  });

  it('moves successfully triggered one-time activities into the collapsed Previously Triggered section', async () => {
    useAutomationsStore.setState({
      activities: [
        activity({ id: 'cron-activity', name: 'Daily digest' }),
        activity({
          id: 'pending-one-time',
          name: 'Future send',
          schedule: {
            kind: 'one_time',
            runAt: '2099-05-27T10:00:00.000Z',
            timezone: 'local',
          },
          nextRunAt: '2099-05-27T10:00:00.000Z',
        }),
        activity({
          id: 'fired-one-time',
          name: 'One-time send',
          enabled: false,
          schedule: {
            kind: 'one_time',
            runAt: '2026-05-27T10:00:00.000Z',
            timezone: 'local',
          },
          lastResult: {
            status: 'success',
            completedAt: '2026-05-27T10:00:01.000Z',
          },
        }),
      ],
      recentRuns: [],
      loading: false,
      hydrated: true,
      error: null,
      mutationError: null,
    });
    renderPage();

    // The active table keeps the recurring row and the still-pending one-time row.
    expect(
      container.querySelector(
        '[data-testid="automations-activity-row-cron-activity"]',
      ),
    ).toBeInstanceOf(HTMLTableRowElement);
    expect(
      container.querySelector(
        '[data-testid="automations-activity-row-pending-one-time"]',
      ),
    ).toBeInstanceOf(HTMLTableRowElement);

    // The already-fired one-time activity is hidden until the section expands.
    expect(
      container.querySelector(
        '[data-testid="automations-activity-row-fired-one-time"]',
      ),
    ).toBeNull();
    const toggle = container.querySelector(
      '[data-testid="automations-previously-triggered-toggle"]',
    );
    expect(toggle).toBeInstanceOf(HTMLButtonElement);
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle?.textContent).toContain('Previously triggered');

    await act(async () => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(
      container.querySelector(
        '[data-testid="automations-previously-triggered-table"]',
      ),
    ).toBeInstanceOf(HTMLDivElement);
    expect(
      container.querySelector(
        '[data-testid="automations-activity-row-fired-one-time"]',
      ),
    ).toBeInstanceOf(HTMLTableRowElement);
  });

  it('disarms the activity delete when focus leaves the action group or Escape is pressed', async () => {
    useAutomationsStore.setState({
      activities: [activity({ id: 'activity-1', name: 'Morning review' })],
      recentRuns: [],
      loading: false,
      hydrated: true,
      mutationError: null,
    });
    renderPage();

    const armed = (): string | null | undefined =>
      container
        .querySelector('[data-testid="automations-delete-activity-1"]')
        ?.getAttribute('aria-label');

    // Arm, then move focus out of the action group entirely.
    const deleteButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="automations-delete-activity-1"]',
    );
    await act(async () => {
      deleteButton?.focus();
      deleteButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(armed()).toBe('Confirm delete');

    const outside = document.createElement('button');
    document.body.appendChild(outside);
    await act(async () => {
      outside.focus();
      await Promise.resolve();
    });
    expect(armed()).toBe('Delete');
    outside.remove();

    // Arm again, then press Escape from inside the group.
    const rearm = container.querySelector<HTMLButtonElement>(
      '[data-testid="automations-delete-activity-1"]',
    );
    await act(async () => {
      rearm?.focus();
      rearm?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(armed()).toBe('Confirm delete');

    await act(async () => {
      container
        .querySelector('[data-testid="automations-delete-activity-1"]')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      await Promise.resolve();
    });
    expect(armed()).toBe('Delete');
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('hides Share on usage-limit resume rows and keeps it everywhere else', () => {
    useAutomationsStore.setState({
      activities: [
        activity({ id: 'activity-1', name: 'Morning review' }),
        activity({
          id: 'activity-resume',
          name: 'Resume nightly build',
          action: {
            type: 'pipeline_execution_resume',
            executionId: 'execution-1',
            statusReasonIds: [],
            provider: 'claude',
            purpose: 'usage_limit_resume',
            pipelineName: 'Nightly build',
          },
        }),
      ],
      recentRuns: [],
      loading: false,
      hydrated: true,
      error: null,
      mutationError: null,
    });
    renderPage();

    // The resume row is generated by the usage-limit banner and binds to a
    // local execution, so it can never be shared.
    expect(
      container.querySelector('[data-testid="automations-share-activity-1"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="automations-share-activity-resume"]',
      ),
    ).toBeNull();
    // Every other row control stays on the resume row.
    expect(
      container.querySelector(
        '[data-testid="automations-edit-activity-resume"]',
      ),
    ).not.toBeNull();
  });

  it('shows Review needed and routes Run now to the pipeline review (CAN-3354)', async () => {
    const resolveSharedPipelineInstallPin = jest.fn().mockResolvedValue({
      installPin: {
        pipelineContentHash: 'b'.repeat(64),
        distributionMode: 'self_contained',
      },
      rawPipeline: 'name: Lint\njobs: {}\n',
    });
    Object.assign(window.api.automations, { resolveSharedPipelineInstallPin });
    useAutomationsStore.setState({
      activities: [
        activity({
          id: 'activity-1',
          name: 'Morning review',
          action: {
            type: 'worktree_pipeline',
            workspaceId: 'workspace-1',
            pipelineId: 'shared:canopy-cloud:remote-1',
            pipelineName: 'Lint',
            pipelineSource: 'shared',
            sharedPipeline: { serverId: 'canopy-cloud', remoteId: 'remote-1' },
          },
          sharedPipelineReview: {
            detectedAt: '2026-05-27T00:00:00.000Z',
            remoteId: 'remote-1',
          },
        }),
      ],
      recentRuns: [],
      loading: false,
      hydrated: true,
      error: null,
      mutationError: null,
    });
    renderPage();

    expect(
      container.querySelector('[data-testid="automations-toggle-activity-1"]')
        ?.textContent,
    ).toContain('Review needed');
    expect(
      container.querySelector('[data-testid="automations-review-activity-1"]'),
    ).not.toBeNull();

    await act(async () => {
      container
        .querySelector('[data-testid="automations-run-now-activity-1"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(runNowMock).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="shared-pipeline-review-modal"]'),
    ).not.toBeNull();
    expect(resolveSharedPipelineInstallPin).toHaveBeenCalledWith({
      remoteId: 'remote-1',
    });
  });

  it('runs and deletes from the row controls, and opens the shell from Edit', async () => {
    useAutomationsStore.setState({
      activities: [activity({ id: 'activity-1', name: 'Morning review' })],
      recentRuns: [],
      loading: false,
      hydrated: true,
      error: null,
      mutationError: null,
    });
    renderPage();

    await clickTestId('automations-run-now-activity-1');
    expect(runNowMock).toHaveBeenCalledWith({ id: 'activity-1' });

    await clickTestId('automations-delete-activity-1');
    await clickTestId('automations-delete-activity-1');
    expect(deleteMock).toHaveBeenCalledWith({ id: 'activity-1' });

    await clickTestId('automations-edit-activity-1');
    expect(shellTarget()).toEqual({
      kind: 'automation',
      activityId: 'activity-1',
    });
    // Saving happens in the shell; nothing is written from the page.
    expect(updateMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('opens the runs in the edit shell on row click', async () => {
    useAutomationsStore.setState({
      activities: [
        activity({
          id: 'activity-1',
          name: 'Morning review',
          schedule: {
            kind: 'one_time',
            runAt: '2099-06-01T15:00:00.000Z',
            timezone: 'local',
          },
          nextRunAt: '2000-01-01T00:00:00.000Z',
        }),
      ],
      recentRuns: [
        run({
          id: 'run-history-1',
          activityId: 'activity-1',
          status: 'success',
          completedAt: '2026-05-27T00:00:05.000Z',
        }),
      ],
      loading: false,
      hydrated: true,
      error: null,
      mutationError: null,
    });
    renderPage();

    const activityRow = container.querySelector(
      '[data-testid="automations-activity-row-activity-1"]',
    );
    const rowNextRun = activityRow?.querySelectorAll('td').item(3);
    expect(rowNextRun?.textContent).toContain('2099');
    expect(rowNextRun?.textContent).not.toContain('2000');

    // Row click opens the Runs section, not the Definition.
    await act(async () => {
      activityRow?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(shellTarget()).toEqual({
      kind: 'automation',
      activityId: 'activity-1',
      section: 'runs',
    });
    expect(
      container.querySelector('[data-testid="automation-details-modal"]'),
    ).toBeNull();
  });

  it('opens the Definition in the edit shell from the row Edit icon', async () => {
    useAutomationsStore.setState({
      activities: [activity({ id: 'activity-1', name: 'Morning review' })],
      recentRuns: [],
      loading: false,
      hydrated: true,
      error: null,
      mutationError: 'Earlier failure.',
    });
    renderPage();

    await clickTestId('automations-edit-activity-1');
    expect(shellTarget()).toEqual({
      kind: 'automation',
      activityId: 'activity-1',
    });
    expect(useAutomationsStore.getState().mutationError).toBeNull();
    expect(
      container.querySelector('[data-testid="automation-details-modal"]'),
    ).toBeNull();
  });

  it('uses chat and project display names in triggered action labels', () => {
    useProjectsStore.setState({
      projects: [
        {
          id: 'workspace-1',
          name: 'Canopy',
          type: 'single-repo',
          repoPath: '/repo/workspace-1',
          color: '#6366f1',
          worktrees: [
            {
              id: 'base-worktree',
              branchName: 'base-worktree-1713571200123',
              createdAt: '2024-04-20T00:00:00.123Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
    });
    useAutomationsStore.setState({
      activities: [
        activity({
          id: 'standalone-activity',
          action: {
            type: 'standalone_prompt',
            chatProjectId: 'default',
            prompt: 'Summarize today.',
          },
        }),
        activity({
          id: 'worktree-activity',
          action: {
            type: 'worktree_prompt',
            workspaceId: 'workspace-1',
            prompt: 'Review this branch.',
          },
        }),
        activity({
          id: 'worktree-session-activity',
          action: {
            type: 'worktree_session_prompt',
            workspaceId: 'workspace-1',
            worktreeId: 'base-worktree',
            chatId: 'chat-1',
            prompt: 'Continue this branch.',
            workspaceName: 'Canopy',
            chatTitle: 'Implementation chat',
          },
        }),
      ],
      recentRuns: [],
      loading: false,
      hydrated: true,
      error: null,
      mutationError: null,
    });

    renderPage();

    expect(container.textContent).toContain('Standalone chat (Default)');
    expect(container.textContent).toContain('Worktree chat (Canopy)');
    expect(container.textContent).toContain(
      'Existing chat (Canopy / New Task / Implementation chat)',
    );
    expect(container.textContent).not.toContain('Standalone chat (default)');
    expect(container.textContent).not.toContain('Worktree chat (workspace-1)');
    expect(container.textContent).not.toContain('base-worktree-1713571200123');
  });

  it('labels a chat-authored session prompt by its destination and opens it in the shell (CAN-2937)', async () => {
    useAutomationsStore.setState({
      activities: [
        activity({
          id: 'session-activity',
          name: 'Triggered chat follow-up',
          enabled: true,
          schedule: {
            kind: 'one_time',
            runAt: '2099-01-01T10:00:00.000Z',
            timezone: 'local',
          },
          nextRunAt: '2099-01-01T10:00:00.000Z',
          action: {
            type: 'worktree_session_prompt',
            workspaceId: 'workspace-1',
            worktreeId: 'base-worktree',
            chatId: 'chat-1',
            prompt: 'Follow up later.',
            inputMode: 'voice',
            purpose: 'scheduled_send',
            workspaceName: 'Canopy',
            worktreeName: 'main',
            chatTitle: 'Implementation chat',
          },
        }),
      ],
      recentRuns: [],
      loading: false,
      hydrated: true,
      error: null,
      mutationError: null,
    });

    renderPage();

    expect(container.textContent).toContain('Existing chat (Canopy / main');
    // Its read-only payload and editable destination are pinned in the
    // shell's form suite (`AutomationEditAdapter.form.test`).
    await clickTestId('automations-edit-session-activity');
    expect(shellTarget()).toEqual({
      kind: 'automation',
      activityId: 'session-activity',
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('opens an automation edit link in the edit shell on the Library', async () => {
    useNavigationStore.setState({ activePage: 'home' });
    useAutomationsStore.setState({
      activities: [activity({ id: 'activity-1', name: 'Morning review' })],
      recentRuns: [],
      loading: false,
      hydrated: true,
      error: null,
      mutationError: null,
    });

    renderPage();

    await act(async () => {
      useNavigationStore.getState().openAutomationEdit({
        activityId: 'activity-1',
      });
      await Promise.resolve();
    });

    expect(useNavigationStore.getState().activePage).toBe('workflows-library');
    expect(shellTarget()).toEqual({
      kind: 'automation',
      activityId: 'activity-1',
    });
  });

  it('hands a link to a missing automation to the shell, which says it is gone', async () => {
    useAutomationsStore.setState({
      activities: [],
      recentRuns: [],
      loading: false,
      hydrated: true,
      error: null,
      mutationError: null,
    });

    renderPage();

    await act(async () => {
      useNavigationStore.getState().openAutomationEdit({
        activityId: 'missing-activity',
        section: 'runs',
      });
      await Promise.resolve();
    });

    // The not-found state is the shell's (`AutomationEditAdapter.test`).
    expect(shellTarget()).toEqual({
      kind: 'automation',
      activityId: 'missing-activity',
      section: 'runs',
    });
    expect(container.textContent).toContain('No triggered activities');
  });

  describe('triggered list sorting', () => {
    const SEEDED_ORDER = ['bravo', 'alpha', 'charlie'];

    function seedSortableActivities(extra: ScheduledActivity[] = []): void {
      useAutomationsStore.setState({
        activities: [
          activity({ id: 'bravo', name: 'Bravo' }),
          activity({ id: 'alpha', name: 'alpha' }),
          activity({ id: 'charlie', name: 'Charlie' }),
          ...extra,
        ],
        recentRuns: [],
        loading: false,
        hydrated: true,
        error: null,
        mutationError: null,
      });
    }

    function rowOrder(scope: ParentNode = container): string[] {
      return Array.from(
        scope.querySelectorAll('[data-testid^="automations-activity-row-"]'),
      ).map((element) =>
        (element.getAttribute('data-testid') ?? '').replace(
          'automations-activity-row-',
          '',
        ),
      );
    }

    function sortButton(
      column: string,
      scope: ParentNode = container,
    ): HTMLElement {
      const element = scope.querySelector(
        `[data-testid="automations-sort-${column}"]`,
      );
      if (!(element instanceof HTMLElement)) {
        throw new Error(`Missing sort header button for ${column}`);
      }
      return element;
    }

    function ariaSort(column: string, scope: ParentNode = container): string {
      return (
        sortButton(column, scope).closest('th')?.getAttribute('aria-sort') ?? ''
      );
    }

    function click(element: Element): void {
      act(() => {
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    }

    it('cycles the Name header through ascending, descending, and the default order', () => {
      seedSortableActivities();
      renderPage();

      // Default order first: this must hold before and after the feature.
      expect(rowOrder()).toEqual(SEEDED_ORDER);

      click(sortButton('name'));
      expect(rowOrder()).toEqual(['alpha', 'bravo', 'charlie']);
      expect(ariaSort('name')).toBe('ascending');

      click(sortButton('name'));
      expect(rowOrder()).toEqual(['charlie', 'bravo', 'alpha']);
      expect(ariaSort('name')).toBe('descending');

      click(sortButton('name'));
      expect(rowOrder()).toEqual(SEEDED_ORDER);
      expect(ariaSort('name')).toBe('none');
      expect(
        localStorage.getItem('canopy.automations.triggeredSort'),
      ).toBeNull();
    });

    it('restores the saved sort when the page is mounted again', () => {
      seedSortableActivities();
      renderPage();
      expect(rowOrder()).toEqual(SEEDED_ORDER);

      click(sortButton('name'));
      click(sortButton('name'));
      expect(rowOrder()).toEqual(['charlie', 'bravo', 'alpha']);

      act(() => {
        root.unmount();
      });
      expect(rowOrder()).toEqual([]);
      root = createRoot(container);
      renderPage();

      expect(rowOrder()).toEqual(['charlie', 'bravo', 'alpha']);
      expect(ariaSort('name')).toBe('descending');
    });

    it('falls back to the default order when the saved sort is corrupt', () => {
      localStorage.setItem('canopy.automations.triggeredSort', '{not json');
      seedSortableActivities();
      renderPage();

      expect(rowOrder()).toEqual(SEEDED_ORDER);
      expect(ariaSort('name')).toBe('none');
    });

    it('shares one sort between the active and Previously Triggered tables', () => {
      seedSortableActivities([
        activity({
          id: 'finished',
          name: 'Finished',
          schedule: {
            kind: 'one_time',
            runAt: '2026-05-27T00:00:00.000Z',
            timezone: 'local',
          },
          lastResult: {
            status: 'success',
            completedAt: '2026-05-27T00:00:05.000Z',
          },
        }),
      ]);
      renderPage();
      expect(rowOrder()).toEqual(SEEDED_ORDER);

      const toggle = container.querySelector(
        '[data-testid="automations-previously-triggered-toggle"]',
      );
      expect(toggle).not.toBeNull();
      if (toggle !== null) {
        click(toggle);
      }
      const previousTable = container.querySelector(
        '[data-testid="automations-previously-triggered-table"]',
      );
      expect(previousTable).not.toBeNull();
      const activeTable = container.querySelector(
        '[data-testid="automations-active-table"]',
      );
      expect(activeTable).not.toBeNull();
      if (activeTable === null || previousTable === null) {
        return;
      }
      expect(rowOrder(previousTable)).toEqual(['finished']);

      click(sortButton('name', activeTable));

      expect(rowOrder(activeTable)).toEqual(['alpha', 'bravo', 'charlie']);
      expect(ariaSort('name', activeTable)).toBe('ascending');
      expect(ariaSort('name', previousTable)).toBe('ascending');
    });
  });

  it('consumes a pending shared-pipeline review link by opening the review modal', async () => {
    const reviewActivity = activity({
      id: 'activity-review',
      name: 'Nightly review',
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'shared:canopy-cloud:remote-1',
        pipelineSource: 'shared',
        sharedPipeline: { serverId: 'canopy-cloud', remoteId: 'remote-1' },
      },
      sharedPipelineReview: {
        detectedAt: '2026-09-26T12:00:00.000Z',
        remoteId: 'remote-1',
      },
    });
    useAutomationsStore.setState({
      activities: [reviewActivity],
      recentRuns: [],
      loading: false,
      hydrated: true,
      error: null,
      mutationError: null,
    });
    Object.assign(window.api.automations, {
      resolveSharedPipelineInstallPin: jest.fn().mockResolvedValue({
        installPin: {
          pipelineContentHash: 'b'.repeat(64),
          distributionMode: 'definition_only',
        },
        rawPipeline: 'pipeline:\n  name: Nightly review\n',
      }),
    });

    renderPage();
    await act(async () => {
      useNavigationStore.getState().openAutomationSharedPipelineReview({
        activityId: reviewActivity.id,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="shared-pipeline-review-modal"]'),
    ).not.toBeNull();
    expect(
      useNavigationStore.getState().pendingAutomationSharedPipelineReview,
    ).toBeUndefined();
  });
});

describe('AutomationsPage — full plugin selections', () => {
  const pluginSelections = {
    collectionIds: ['team-tools'],
    skillRefs: [{ sourceId: 'custom:local', skillName: 'automation-helper' }],
    pluginRefs: [],
    mcpServerRefs: [{ serverId: 'linear', configId: 'work' }],
  };

  it('persists and hydrates the same full picker selection shape as chats', () => {
    const { action } = buildAction({
      ...emptyFormState(),
      prompt: 'Run the scheduled review.',
      pluginSelections,
    });
    expect(action).toMatchObject({
      type: 'app_advisor_prompt',
      pluginSelections,
    });

    const state = activityToFormState(
      activity({
        action: {
          type: 'app_advisor_prompt',
          prompt: 'Run the scheduled review.',
          pluginSelections,
        },
      }),
    );
    expect(state.pluginSelections).toEqual(pluginSelections);
  });
});

describe('AutomationsPage — model alias preferences threading', () => {
  const aliasPrefs = {
    reviewer: { mode: 'inline', base: 'claude-sonnet-4-6' },
  };

  it('persists modelAliasPreferences on a saved worktree_pipeline action', () => {
    const state = {
      ...emptyFormState(),
      actionType: 'worktree_pipeline' as const,
      workspaceId: 'ws-1',
      pipelineId: 'pipe-1',
      pipelineName: 'Pipe',
      modelAliasPreferences: aliasPrefs,
    };
    const { action } = buildAction(state);
    expect(action).toMatchObject({
      type: 'worktree_pipeline',
      modelAliasPreferences: aliasPrefs,
    });
  });

  it('omits modelAliasPreferences when unset', () => {
    const state = {
      ...emptyFormState(),
      actionType: 'worktree_pipeline' as const,
      workspaceId: 'ws-1',
      pipelineId: 'pipe-1',
    };
    const { action } = buildAction(state);
    expect(action && 'modelAliasPreferences' in action).toBe(false);
  });

  it('reloads saved alias preferences when editing an automation', () => {
    const state = activityToFormState(
      activity({
        action: {
          type: 'worktree_pipeline',
          workspaceId: 'ws-1',
          pipelineId: 'pipe-1',
          modelAliasPreferences: aliasPrefs,
        } as ScheduledActivity['action'],
      }),
    );
    expect(state.modelAliasPreferences).toEqual(aliasPrefs);
  });

  it('blocks saving a worktree_pipeline automation when a required alias is unconfigured', () => {
    const { action, error } = buildAction({
      ...emptyFormState(),
      actionType: 'worktree_pipeline' as const,
      workspaceId: 'ws-1',
      pipelineId: 'pipe-1',
      pipelineName: 'Pipe',
      pipelineModelAliases: [{ id: 'reviewer', name: 'Reviewer' }],
    });

    expect(action).toBeUndefined();
    expect(error).toBe(
      'Configure the Reviewer model alias before saving this automation.',
    );
  });

  it('omits preferences for aliases removed from the selected pipeline on save', () => {
    const { action } = buildAction({
      ...emptyFormState(),
      actionType: 'worktree_pipeline' as const,
      workspaceId: 'ws-1',
      pipelineId: 'pipe-1',
      pipelineName: 'Pipe',
      pipelineModelAliases: [{ id: 'reviewer', name: 'Reviewer' }],
      modelAliasPreferences: {
        reviewer: { mode: 'inline', base: 'claude-sonnet-4-6' },
        stale_reviewer: { mode: 'inline', base: 'claude-sonnet-4-6' },
      },
    });

    expect(action).toMatchObject({
      type: 'worktree_pipeline',
      modelAliasPreferences: {
        reviewer: { mode: 'inline', base: 'claude-sonnet-4-6' },
      },
    });
    expect(
      (
        action as Extract<
          ScheduledActivity['action'],
          { type: 'worktree_pipeline' }
        >
      ).modelAliasPreferences,
    ).not.toHaveProperty('stale_reviewer');
  });
});

describe('AutomationsPage — existing-worktree prompt round-trip (REG-2830)', () => {
  it('hydrates and re-emits existingWorktreeId when editing', () => {
    const state = activityToFormState(
      activity({
        action: {
          type: 'worktree_prompt',
          workspaceId: 'ws-1',
          existingWorktreeId: 'wt-1',
          prompt: 'Implement leg 2 in place.',
        },
      }),
    );
    expect(state.existingWorktreeId).toBe('wt-1');

    const { action } = buildAction(state);
    expect(action).toMatchObject({
      type: 'worktree_prompt',
      workspaceId: 'ws-1',
      existingWorktreeId: 'wt-1',
    });
    expect(action && 'baseWorktreeId' in action).toBe(false);
  });

  it('clears existingWorktreeId when the project changes', () => {
    // A worktree id is workspace-scoped: carrying it across a workspace
    // switch would save an automation that deterministically fails at
    // dispatch ("Worktree ... was not found in project ...").
    const next = applyWorkspaceActionSelection(
      {
        ...emptyFormState(),
        actionType: 'worktree_prompt' as const,
        workspaceId: 'ws-1',
        existingWorktreeId: 'wt-1',
        prompt: 'Implement leg 2 in place.',
      },
      'chat',
      { id: 'ws-2', isCowork: false },
    );
    expect(selectedAutomationWorkspaceId(next)).toBe('ws-2');
    expect(next.existingWorktreeId).toBe('');
    // Still an Existing-chat destination, now waiting for a worktree.
    expect(automationFormChatRunMode(next)).toBe('existing_chat');
    expect(buildAction(next).action).toBeUndefined();
  });

  it('preserves existingWorktreeId when the project selection is unchanged', () => {
    const next = applyWorkspaceActionSelection(
      {
        ...emptyFormState(),
        actionType: 'worktree_prompt' as const,
        workspaceId: 'ws-1',
        existingWorktreeId: 'wt-1',
        prompt: 'Implement leg 2 in place.',
      },
      'chat',
      { id: 'ws-1', isCowork: false },
    );
    expect(next.existingWorktreeId).toBe('wt-1');
  });

  it('never emits baseWorktreeId alongside an existing-worktree target', () => {
    const { action } = buildAction({
      ...emptyFormState(),
      actionType: 'worktree_prompt' as const,
      workspaceId: 'ws-1',
      prompt: 'Implement leg 2 in place.',
      existingWorktreeId: 'wt-1',
      baseWorktreeId: 'wt-stale',
    });
    expect(action).toMatchObject({
      type: 'worktree_prompt',
      existingWorktreeId: 'wt-1',
    });
    expect(action && 'baseWorktreeId' in action).toBe(false);
  });
});

describe('AutomationsPage — App Advisor / Project action mapping', () => {
  it('maps wire action types onto the two-option selector and Chat/Pipeline pill', () => {
    expect(actionCategoryForType('app_advisor_prompt')).toBe('app_advisor');
    expect(actionCategoryForType('worktree_prompt')).toBe('workspace');
    expect(actionCategoryForType('worktree_pipeline')).toBe('workspace');
    expect(actionCategoryForType('standalone_prompt')).toBe('workspace');
    expect(actionCategoryForType('worktree_session_prompt')).toBeUndefined();
    expect(actionCategoryForType('pipeline_execution_resume')).toBeUndefined();

    expect(workspaceActionModeForType('worktree_pipeline')).toBe('pipeline');
    expect(workspaceActionModeForType('worktree_prompt')).toBe('chat');
    expect(workspaceActionModeForType('standalone_prompt')).toBe('chat');
  });

  it('derives the wire action type from project kind plus Chat/Pipeline mode', () => {
    const base = emptyFormState();

    const codeChat = applyWorkspaceActionSelection(base, 'chat', {
      id: 'ws-1',
      isCowork: false,
    });
    expect(codeChat.actionType).toBe('worktree_prompt');
    expect(codeChat.workspaceId).toBe('ws-1');
    expect(codeChat.chatProjectId).toBe('');
    expect(selectedAutomationWorkspaceId(codeChat)).toBe('ws-1');

    const codePipeline = applyWorkspaceActionSelection(codeChat, 'pipeline', {
      id: 'ws-1',
      isCowork: false,
    });
    expect(codePipeline.actionType).toBe('worktree_pipeline');
    expect(codePipeline.workspaceId).toBe('ws-1');

    const coworkChat = applyWorkspaceActionSelection(base, 'chat', {
      id: 'cowork-1',
      isCowork: true,
    });
    expect(coworkChat.actionType).toBe('standalone_prompt');
    expect(coworkChat.workspaceId).toBe('');
    expect(coworkChat.chatProjectId).toBe('cowork-1');
    expect(selectedAutomationWorkspaceId(coworkChat)).toBe('cowork-1');

    const coworkPipeline = applyWorkspaceActionSelection(
      coworkChat,
      'pipeline',
      {
        id: 'cowork-1',
        isCowork: true,
      },
    );
    expect(coworkPipeline.actionType).toBe('worktree_pipeline');
    expect(coworkPipeline.workspaceId).toBe('cowork-1');
    expect(coworkPipeline.chatProjectId).toBe('');

    const cleared = applyWorkspaceActionSelection(coworkPipeline, 'chat', null);
    expect(cleared.actionType).toBe('worktree_prompt');
    expect(cleared.workspaceId).toBe('');
    expect(cleared.chatProjectId).toBe('');
  });

  it('clears base worktree and pipeline config on project change but not on mode toggles', () => {
    const configured = {
      ...emptyFormState(),
      actionType: 'worktree_pipeline' as const,
      workspaceId: 'ws-1',
      baseWorktreeId: 'wt-1',
      pipelineId: 'pipe-1',
      pipelineName: 'Pipe',
    };

    const toggled = applyWorkspaceActionSelection(configured, 'chat', {
      id: 'ws-1',
      isCowork: false,
    });
    expect(toggled.baseWorktreeId).toBe('wt-1');
    expect(toggled.pipelineId).toBe('pipe-1');

    const switched = applyWorkspaceActionSelection(configured, 'pipeline', {
      id: 'cowork-1',
      isCowork: true,
    });
    expect(switched.baseWorktreeId).toBe('');
    expect(switched.pipelineId).toBe('');
    expect(switched.repoId).toBe('');
  });

  it('serializes only the selected worktree when stale baseBranch state remains', () => {
    const { action } = buildAction({
      ...emptyFormState(),
      actionType: 'worktree_prompt',
      workspaceId: 'ws-1',
      prompt: 'Plan the release',
      baseWorktreeId: 'wt-1',
      baseBranch: 'main',
    });

    expect(action).toEqual({
      type: 'worktree_prompt',
      workspaceId: 'ws-1',
      baseWorktreeId: 'wt-1',
      prompt: 'Plan the release',
    });
  });

  it('builds a standalone_prompt action from a cowork project chat selection', () => {
    const state = applyWorkspaceActionSelection(
      { ...emptyFormState(), prompt: 'Summarize the folder.' },
      'chat',
      { id: 'cowork-1', isCowork: true },
    );
    const { action } = buildAction(state);
    expect(action).toEqual({
      type: 'standalone_prompt',
      chatProjectId: 'cowork-1',
      prompt: 'Summarize the folder.',
    });
  });

  it('builds a worktree_pipeline action targeting a cowork project without base worktree or repo', () => {
    const state = applyWorkspaceActionSelection(
      {
        ...emptyFormState(),
        pipelineId: 'pipe-1',
        pipelineName: 'Pipe',
      },
      'pipeline',
      { id: 'cowork-1', isCowork: true },
    );
    const { action } = buildAction({
      ...state,
      pipelineId: 'pipe-1',
      pipelineName: 'Pipe',
      pipelineSource: 'user',
    });
    expect(action).toEqual({
      type: 'worktree_pipeline',
      workspaceId: 'cowork-1',
      pipelineId: 'pipe-1',
      pipelineName: 'Pipe',
      pipelineSource: 'user',
    });
  });
});

describe('AutomationsPage — Run in mode derivation and transitions (CAN-2937)', () => {
  it('derives the Run-in mode and target from form state', () => {
    const codeNew = {
      ...emptyFormState(),
      actionType: 'worktree_prompt' as const,
      workspaceId: 'ws-1',
    };
    expect(automationFormChatRunMode(codeNew)).toBe('new_chat');
    expect(automationFormActionCategory(codeNew)).toBe('workspace');

    const coworkNew = {
      ...emptyFormState(),
      actionType: 'standalone_prompt' as const,
      chatProjectId: 'cowork-1',
    };
    expect(automationFormChatRunMode(coworkNew)).toBe('new_chat');

    const existing = {
      ...emptyFormState(),
      actionType: 'worktree_session_prompt' as const,
      worktreeSessionTarget: {
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
      },
    };
    expect(automationFormChatRunMode(existing)).toBe('existing_chat');
    expect(automationFormActionCategory(existing)).toBe('workspace');
    expect(selectedAutomationWorkspaceId(existing)).toBe('ws-1');

    // A new chat in an existing worktree is the Existing-chat mode with
    // "New chat" picked; a provisioning source still creates a new worktree.
    const codeExistingWorktree = { ...codeNew, existingWorktreeId: 'wt-9' };
    expect(automationFormChatRunMode(codeExistingWorktree)).toBe(
      'existing_chat',
    );
    expect(automationFormChatTarget(codeExistingWorktree)).toEqual({
      workspaceId: 'ws-1',
      worktreeId: 'wt-9',
      chatId: '',
    });
    expect(
      automationFormChatRunMode({ ...codeNew, baseWorktreeId: 'wt-9' }),
    ).toBe('new_chat');

    const coworkExistingEntry = { ...coworkNew, workEntryId: 'entry-1' };
    expect(automationFormChatRunMode(coworkExistingEntry)).toBe(
      'existing_chat',
    );
    expect(automationFormChatTarget(coworkExistingEntry)).toEqual({
      workspaceId: 'cowork-1',
      worktreeId: 'entry-1',
      chatId: '',
    });

    const appAdvisorSession = {
      ...existing,
      worktreeSessionTarget: {
        workspaceId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'aa-entry-1',
        chatId: 'advisor-chat',
      },
    };
    expect(isAppAdvisorSessionPrompt(appAdvisorSession)).toBe(true);
    expect(automationFormChatRunMode(appAdvisorSession)).toBe('existing_chat');
    expect(automationFormActionCategory(appAdvisorSession)).toBe('app_advisor');

    const appAdvisorExistingEntry = {
      ...emptyFormState(),
      actionType: 'app_advisor_prompt' as const,
      workEntryId: 'aa-entry-1',
    };
    expect(automationFormChatRunMode(appAdvisorExistingEntry)).toBe(
      'existing_chat',
    );
    expect(automationFormActionCategory(appAdvisorExistingEntry)).toBe(
      'app_advisor',
    );
    expect(automationFormChatTarget(appAdvisorExistingEntry)).toEqual({
      workspaceId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'aa-entry-1',
      chatId: '',
    });

    expect(
      automationFormChatRunMode({
        ...emptyFormState(),
        actionType: 'worktree_pipeline',
        workspaceId: 'ws-1',
      }),
    ).toBeUndefined();
    expect(
      automationFormChatRunMode({
        ...emptyFormState(),
        actionType: 'app_advisor_prompt',
      }),
    ).toBe('new_chat');
  });

  it('keeps name, trigger, ifCommand and prompt across a code-workspace mode flip', () => {
    const base = {
      ...activityToFormState(
        activity({
          name: 'Nightly catch-up',
          ifCommand: 'test -f ready.txt',
          action: {
            type: 'worktree_prompt',
            workspaceId: 'ws-1',
            prompt: 'Catch up on the branch.',
          },
        }),
      ),
      model: 'sonnet' as never,
      planMode: true,
    };
    expect(automationFormChatRunMode(base)).toBe('new_chat');

    const existing = applyChatRunModeSelection(base, 'existing_chat', {
      id: 'ws-1',
      isCowork: false,
    });
    expect(existing.actionType).toBe('worktree_session_prompt');
    expect(existing.name).toBe('Nightly catch-up');
    expect(existing.cronExpression).toBe(base.cronExpression);
    expect(existing.ifCommand).toBe('test -f ready.txt');
    expect(existing.prompt).toBe('Catch up on the branch.');
    // The workspace survives so the Project select stays populated while the
    // worktree + chat are picked.
    expect(selectedAutomationWorkspaceId(existing)).toBe('ws-1');
    // Incomplete target: Save is blocked rather than serialized.
    expect(buildAction(existing).action).toBeUndefined();
    expect(buildAction(existing).error).toMatch(/Pick a destination/);

    const targeted = {
      ...existing,
      worktreeSessionTarget: {
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        chatTitle: 'Implementation chat',
      },
    };
    expect(buildAction(targeted).action).toMatchObject({
      type: 'worktree_session_prompt',
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      prompt: 'Catch up on the branch.',
    });

    // ...and flipping back restores the chat customization the existing-chat
    // wire type cannot carry.
    const backToNew = applyChatRunModeSelection(targeted, 'new_chat', {
      id: 'ws-1',
      isCowork: false,
    });
    expect(backToNew.actionType).toBe('worktree_prompt');
    expect(backToNew.workspaceId).toBe('ws-1');
    expect(backToNew.worktreeSessionTarget).toBeUndefined();
    expect(backToNew.model).toBe('sonnet');
    expect(backToNew.planMode).toBe(true);
    expect(backToNew.pluginSelections).toEqual(base.pluginSelections);
    expect(backToNew.name).toBe('Nightly catch-up');
    expect(backToNew.prompt).toBe('Catch up on the branch.');
    expect(buildAction(backToNew).action).toMatchObject({
      type: 'worktree_prompt',
      workspaceId: 'ws-1',
    });
  });

  it('flips a cowork workspace between standalone_prompt and the shared session wire type', () => {
    const coworkNew = applyWorkspaceActionSelection(
      { ...emptyFormState(), prompt: 'Summarize the folder.' },
      'chat',
      { id: 'cowork-1', isCowork: true },
    );
    expect(coworkNew.actionType).toBe('standalone_prompt');

    const existing = applyChatRunModeSelection(coworkNew, 'existing_chat', {
      id: 'cowork-1',
      isCowork: true,
    });
    // Cowork reuses the same triple — the Work Entry id occupies the
    // `worktreeId` slot.
    expect(existing.actionType).toBe('worktree_session_prompt');
    expect(selectedAutomationWorkspaceId(existing)).toBe('cowork-1');
    expect(
      buildAction({
        ...existing,
        worktreeSessionTarget: {
          workspaceId: 'cowork-1',
          worktreeId: 'entry-1',
          chatId: 'chat-1',
        },
      }).action,
    ).toMatchObject({
      type: 'worktree_session_prompt',
      workspaceId: 'cowork-1',
      worktreeId: 'entry-1',
      chatId: 'chat-1',
    });

    const backToNew = applyChatRunModeSelection(existing, 'new_chat', {
      id: 'cowork-1',
      isCowork: true,
    });
    expect(backToNew.actionType).toBe('standalone_prompt');
    expect(backToNew.chatProjectId).toBe('cowork-1');
  });

  it('drops a session target that would cross a workspace boundary', () => {
    const existing = {
      ...emptyFormState(),
      actionType: 'worktree_session_prompt' as const,
      prompt: 'Continue',
      worktreeSessionTarget: {
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
      },
    };
    const moved = applyWorkspaceActionSelection(existing, 'chat', {
      id: 'ws-2',
      isCowork: false,
    });
    expect(moved.worktreeSessionTarget).toEqual({
      workspaceId: 'ws-2',
      worktreeId: '',
      chatId: '',
    });
    expect(buildAction(moved).action).toBeUndefined();
  });

  it('drops chat-authored attachments when returning to New chat each run', () => {
    const composerAuthored = activityToFormState(
      activity({
        action: {
          type: 'worktree_session_prompt',
          workspaceId: 'ws-1',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
          prompt: 'Follow up.',
          attachmentPaths: ['/tmp/shot.png'],
          purpose: 'scheduled_send',
        },
      }),
    );
    expect(hasChatAuthoredPayload(composerAuthored)).toBe(true);

    const backToNew = applyChatRunModeSelection(composerAuthored, 'new_chat', {
      id: 'ws-1',
      isCowork: false,
    });
    expect(backToNew.attachmentPaths).toEqual(['/tmp/shot.png']);
    expect(backToNew.purpose).toBe('scheduled_send');
    expect(hasChatAuthoredPayload(backToNew)).toBe(true);
    expect(buildAction(backToNew).action).toEqual({
      type: 'worktree_prompt',
      workspaceId: 'ws-1',
      prompt: 'Follow up.',
    });
  });

  it('treats a form-authored existing-chat automation as fully editable', () => {
    const formAuthored = activityToFormState(
      activity({
        action: {
          type: 'worktree_session_prompt',
          workspaceId: 'ws-1',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
          prompt: 'Continue',
        },
      }),
    );
    expect(hasChatAuthoredPayload(formAuthored)).toBe(false);
    expect(isAppAdvisorSessionPrompt(formAuthored)).toBe(false);
    // Round-trips unchanged through the form contract.
    expect(buildAction(formAuthored).action).toEqual({
      type: 'worktree_session_prompt',
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      prompt: 'Continue',
      inputMode: 'typed',
    });
  });
});

describe('AutomationsPage — form run-mode mirror stays in step with the shared derivation', () => {
  // `automationFormChatRunMode` reads form state rather than an assembled
  // action, so it is a second copy of the same rule. Pin them together.
  const variants: Array<ScheduledActivity['action']> = [
    { type: 'app_advisor_prompt', prompt: 'Summarize' },
    {
      type: 'app_advisor_prompt',
      workEntryId: 'aa-entry-1',
      prompt: 'Summarize',
    },
    { type: 'standalone_prompt', chatProjectId: 'cowork-1', prompt: 'Sum' },
    {
      type: 'standalone_prompt',
      chatProjectId: 'cowork-1',
      workEntryId: 'entry-1',
      prompt: 'Sum',
    },
    { type: 'worktree_prompt', workspaceId: 'ws-1', prompt: 'Go' },
    {
      type: 'worktree_prompt',
      workspaceId: 'ws-1',
      existingWorktreeId: 'wt-1',
      prompt: 'Go',
    },
    {
      type: 'worktree_session_prompt',
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      prompt: 'Continue',
    },
    { type: 'worktree_pipeline', workspaceId: 'ws-1', pipelineId: 'pipe-1' },
  ];

  it.each(variants)('agrees for $type', (action) => {
    const state = activityToFormState(activity({ action }));
    expect(automationFormChatRunMode(state)).toBe(
      getAutomationChatRunMode(action),
    );
  });

  it('agrees for App Advisor session prompts', () => {
    const action: ScheduledActivity['action'] = {
      type: 'worktree_session_prompt',
      workspaceId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'aa-entry-1',
      chatId: 'advisor-chat',
      prompt: 'Continue',
    };
    expect(
      automationFormChatRunMode(activityToFormState(activity({ action }))),
    ).toBe(getAutomationChatRunMode(action));
  });

  it.each(variants.filter((action) => action.type !== 'worktree_pipeline'))(
    'round-trips $type through the form unchanged',
    (action) => {
      const state = activityToFormState(activity({ action }));
      expect(buildAction(state).action).toMatchObject(action);
    },
  );
});

describe('AutomationsPage — "New chat" in an existing destination', () => {
  const codeExisting = (): ReturnType<typeof emptyFormState> =>
    applyChatRunModeSelection(
      {
        ...emptyFormState(),
        actionType: 'worktree_prompt',
        workspaceId: 'ws-1',
        baseWorktreeId: 'wt-base',
        prompt: 'Catch up.',
      },
      'existing_chat',
      { id: 'ws-1', isCowork: false },
    );

  it('opens a new chat each run in a picked code worktree', () => {
    const picked = applyChatTargetSelection(codeExisting(), 'ws-1', false, {
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      chatId: '',
    });
    expect(automationFormChatRunMode(picked)).toBe('existing_chat');
    expect(buildAction(picked).action).toEqual({
      type: 'worktree_prompt',
      workspaceId: 'ws-1',
      existingWorktreeId: 'wt-1',
      prompt: 'Catch up.',
    });

    // Picking a specific chat switches to continuing it...
    const chat = applyChatTargetSelection(picked, 'ws-1', false, {
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
    });
    expect(buildAction(chat).action).toMatchObject({
      type: 'worktree_session_prompt',
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
    });
    // ...and "New chat" switches back without losing the worktree.
    const again = applyChatTargetSelection(chat, 'ws-1', false, {
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      chatId: '',
    });
    expect(buildAction(again).action).toMatchObject({
      type: 'worktree_prompt',
      existingWorktreeId: 'wt-1',
    });
  });

  it('opens a new chat each run in a picked cowork Work Entry', () => {
    const coworkExisting = applyChatRunModeSelection(
      { ...emptyFormState(), prompt: 'Summarize.' },
      'existing_chat',
      { id: 'cowork-1', isCowork: true },
    );
    const picked = applyChatTargetSelection(coworkExisting, 'cowork-1', true, {
      workspaceId: 'cowork-1',
      worktreeId: 'entry-1',
      chatId: '',
    });
    expect(selectedAutomationWorkspaceId(picked)).toBe('cowork-1');
    expect(buildAction(picked).action).toEqual({
      type: 'standalone_prompt',
      chatProjectId: 'cowork-1',
      workEntryId: 'entry-1',
      prompt: 'Summarize.',
    });

    const backToNew = applyChatRunModeSelection(picked, 'new_chat', {
      id: 'cowork-1',
      isCowork: true,
    });
    expect(buildAction(backToNew).action).toEqual({
      type: 'standalone_prompt',
      chatProjectId: 'cowork-1',
      prompt: 'Summarize.',
    });
  });

  it('supports App Advisor Work Entries and specific App Advisor chats', () => {
    const base = { ...emptyFormState(), prompt: 'Summarize standup.' };
    expect(automationFormActionCategory(base)).toBe('app_advisor');
    expect(automationFormChatRunMode(base)).toBe('new_chat');

    const existing = applyAppAdvisorRunModeSelection(base, 'existing_chat');
    expect(automationFormActionCategory(existing)).toBe('app_advisor');
    expect(automationFormChatRunMode(existing)).toBe('existing_chat');
    expect(automationFormChatTarget(existing)).toEqual({
      workspaceId: APP_ADVISOR_PROJECT_ID,
      worktreeId: '',
      chatId: '',
    });
    expect(buildAction(existing).action).toBeUndefined();

    const entry = applyChatTargetSelection(
      existing,
      APP_ADVISOR_PROJECT_ID,
      false,
      {
        workspaceId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'aa-entry-1',
        chatId: '',
      },
    );
    expect(automationFormActionCategory(entry)).toBe('app_advisor');
    expect(buildAction(entry).action).toEqual({
      type: 'app_advisor_prompt',
      workEntryId: 'aa-entry-1',
      prompt: 'Summarize standup.',
    });

    const chat = applyChatTargetSelection(
      entry,
      APP_ADVISOR_PROJECT_ID,
      false,
      {
        workspaceId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'aa-entry-1',
        chatId: 'aa-chat-1',
      },
    );
    expect(automationFormActionCategory(chat)).toBe('app_advisor');
    expect(buildAction(chat).action).toMatchObject({
      type: 'worktree_session_prompt',
      workspaceId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'aa-entry-1',
      chatId: 'aa-chat-1',
      prompt: 'Summarize standup.',
    });

    const backToNew = applyAppAdvisorRunModeSelection(chat, 'new_chat');
    expect(buildAction(backToNew).action).toEqual({
      type: 'app_advisor_prompt',
      prompt: 'Summarize standup.',
    });
  });

  it('keeps the selected project across a round trip through App Advisor', () => {
    const project = applyWorkspaceActionSelection(
      { ...emptyFormState(), prompt: 'Go.' },
      'chat',
      { id: 'ws-1', isCowork: false },
    );
    const advisor = applyAppAdvisorRunModeSelection(
      { ...project, actionType: 'app_advisor_prompt' },
      'existing_chat',
    );
    expect(automationFormActionCategory(advisor)).toBe('app_advisor');
    expect(advisor.workspaceId).toBe('ws-1');
  });

  it('makes form-authored App Advisor session prompts editable', () => {
    const state = activityToFormState(
      activity({
        action: {
          type: 'worktree_session_prompt',
          workspaceId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'aa-entry-1',
          chatId: 'aa-chat-1',
          prompt: 'Continue',
        },
      }),
    );
    expect(hasChatAuthoredPayload(state)).toBe(false);
    expect(automationFormActionCategory(state)).toBe('app_advisor');
    expect(buildAction(state).action).toMatchObject({
      type: 'worktree_session_prompt',
      workspaceId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'aa-entry-1',
      chatId: 'aa-chat-1',
    });
  });
});

describe('resolveRepickedSharedPipeline (CAN-3354 edit-form pin)', () => {
  const installPin = {
    pipelineContentHash: 'a'.repeat(64),
    distributionMode: 'package' as const,
  };
  const previous = {
    serverId: 'canopy-cloud',
    remoteId: 'remote-1',
    installPin,
  };

  it('keeps the pin when the same shared pipeline is re-picked', () => {
    expect(
      resolveRepickedSharedPipeline(previous, {
        source: 'shared',
        serverId: 'canopy-cloud',
        remoteId: 'remote-1',
      }),
    ).toEqual(previous);
  });

  it('starts unpinned for a different shared pipeline', () => {
    expect(
      resolveRepickedSharedPipeline(previous, {
        source: 'shared',
        serverId: 'canopy-cloud',
        remoteId: 'remote-2',
      }),
    ).toEqual({ serverId: 'canopy-cloud', remoteId: 'remote-2' });
  });

  it('drops the shared binding for a non-shared pipeline', () => {
    expect(
      resolveRepickedSharedPipeline(previous, { source: 'global' }),
    ).toBeUndefined();
  });
});

describe('AutomationsPage — sidebar group for new containers', () => {
  const roundTripActions = [
    {
      action: {
        type: 'app_advisor_prompt',
        prompt: 'Review the release.',
        sidebarGroupName: '  Advisor follow-up  ',
      },
      groupName: 'Advisor follow-up',
    },
    {
      action: {
        type: 'standalone_prompt',
        chatProjectId: 'cowork-1',
        prompt: 'Review the release.',
        sidebarGroupName: '  Cowork follow-up  ',
      },
      groupName: 'Cowork follow-up',
    },
    {
      action: {
        type: 'worktree_prompt',
        workspaceId: 'ws-1',
        prompt: 'Review the release.',
        sidebarGroupName: '  Project follow-up  ',
      },
      groupName: 'Project follow-up',
    },
  ] as const;

  it.each(roundTripActions)(
    'hydrates and serializes $action.type sidebar group names',
    ({ action, groupName }) => {
      const state = activityToFormState(activity({ action }));
      expect(state).toHaveProperty('sidebarGroupName', action.sidebarGroupName);
      expect(buildAction(state).action).toMatchObject({
        type: action.type,
        sidebarGroupName: groupName,
      });
    },
  );

  it('starts with an empty group name and hydrates no group for other action types', () => {
    expect(emptyFormState()).toHaveProperty('sidebarGroupName', '');
    const state = activityToFormState(
      activity({
        action: {
          type: 'worktree_pipeline',
          workspaceId: 'ws-1',
          pipelineId: 'pipe-1',
        },
      }),
    );
    expect(state).toHaveProperty('sidebarGroupName', '');
  });

  it.each([
    { type: 'app_advisor_prompt', prompt: 'Review.' },
    {
      type: 'standalone_prompt',
      chatProjectId: 'cowork-1',
      prompt: 'Review.',
    },
    { type: 'worktree_prompt', workspaceId: 'ws-1', prompt: 'Review.' },
  ] satisfies Array<ScheduledActivity['action']>)(
    'omits a blank group name for $type',
    (action) => {
      const state = {
        ...activityToFormState(activity({ action })),
        sidebarGroupName: ' \n\t ',
      };
      expect(buildAction(state).action).not.toHaveProperty('sidebarGroupName');
    },
  );

  it('clamps the serialized group name to 80 characters', () => {
    const state = {
      ...emptyFormState(),
      prompt: 'Review.',
      sidebarGroupName: 'x'.repeat(100),
    };
    const action = buildAction(state).action;
    expect(action).toHaveProperty('sidebarGroupName', 'x'.repeat(80));
  });

  it.each([
    {
      type: 'app_advisor_prompt',
      prompt: 'Review.',
      workEntryId: 'advisor-entry-1',
    },
    {
      type: 'standalone_prompt',
      chatProjectId: 'cowork-1',
      prompt: 'Review.',
      workEntryId: 'cowork-entry-1',
    },
    {
      type: 'worktree_prompt',
      workspaceId: 'ws-1',
      prompt: 'Review.',
      existingWorktreeId: 'wt-1',
    },
  ] satisfies Array<ScheduledActivity['action']>)(
    'omits the group when $type targets an existing container',
    (action) => {
      const state = {
        ...activityToFormState(activity({ action })),
        sidebarGroupName: 'Existing destination group',
      };
      expect(buildAction(state).action).not.toHaveProperty('sidebarGroupName');
    },
  );

  it('does not serialize a sidebar group on pipeline actions', () => {
    const action = buildAction({
      ...emptyFormState(),
      actionType: 'worktree_pipeline',
      workspaceId: 'ws-1',
      pipelineId: 'pipe-1',
      sidebarGroupName: 'Pipeline group',
    }).action;
    expect(action).not.toHaveProperty('sidebarGroupName');
  });

  it('clears the group on workspace changes and on Project ↔ App Advisor switches', () => {
    const project = {
      ...emptyFormState(),
      actionType: 'worktree_prompt' as const,
      workspaceId: 'ws-1',
      prompt: 'Review.',
      sidebarGroupName: 'Project group',
    };
    const moved = applyWorkspaceActionSelection(project, 'chat', {
      id: 'ws-2',
      isCowork: false,
    });
    expect(moved).toHaveProperty('sidebarGroupName', '');

    const advisor = applyAppAdvisorActionCategorySelection(project, 'new_chat');
    expect(advisor).toMatchObject({
      actionType: 'app_advisor_prompt',
      sidebarGroupName: '',
    });

    const returnedToProject = applyWorkspaceActionSelection(
      {
        ...project,
        actionType: 'app_advisor_prompt',
        sidebarGroupName: 'Advisor group',
      },
      'chat',
      { id: 'ws-1', isCowork: false },
    );
    expect(returnedToProject).toHaveProperty('sidebarGroupName', '');
  });

  it('preserves the group across Chat ↔ Pipeline and Run-in toggles in one scope', () => {
    const projectChat = {
      ...emptyFormState(),
      actionType: 'worktree_prompt' as const,
      workspaceId: 'ws-1',
      prompt: 'Review.',
      sidebarGroupName: 'Project group',
    };
    const pipeline = applyWorkspaceActionSelection(projectChat, 'pipeline', {
      id: 'ws-1',
      isCowork: false,
    });
    const chatAgain = applyWorkspaceActionSelection(pipeline, 'chat', {
      id: 'ws-1',
      isCowork: false,
    });
    expect(pipeline).toHaveProperty('sidebarGroupName', 'Project group');
    expect(chatAgain).toHaveProperty('sidebarGroupName', 'Project group');

    const existingChat = applyChatRunModeSelection(
      projectChat,
      'existing_chat',
      { id: 'ws-1', isCowork: false },
    );
    const newChat = applyChatRunModeSelection(existingChat, 'new_chat', {
      id: 'ws-1',
      isCowork: false,
    });
    expect(existingChat).toHaveProperty('sidebarGroupName', 'Project group');
    expect(newChat).toHaveProperty('sidebarGroupName', 'Project group');

    const advisorNew = {
      ...emptyFormState(),
      sidebarGroupName: 'Advisor group',
    };
    const advisorExisting = applyAppAdvisorRunModeSelection(
      advisorNew,
      'existing_chat',
    );
    const advisorAgain = applyAppAdvisorRunModeSelection(
      advisorExisting,
      'new_chat',
    );
    expect(advisorExisting).toHaveProperty('sidebarGroupName', 'Advisor group');
    expect(advisorAgain).toHaveProperty('sidebarGroupName', 'Advisor group');
  });

  it('derives only the scopes for new-container prompt actions', () => {
    expect(
      automationFormSidebarGroupScope({
        ...emptyFormState(),
        actionType: 'app_advisor_prompt',
      }),
    ).toEqual({ appAdvisor: true });
    expect(
      automationFormSidebarGroupScope({
        ...emptyFormState(),
        actionType: 'app_advisor_prompt',
        workEntryId: 'advisor-entry-1',
      }),
    ).toBeUndefined();
    expect(
      automationFormSidebarGroupScope({
        ...emptyFormState(),
        actionType: 'worktree_prompt',
        workspaceId: 'ws-1',
      }),
    ).toEqual({ workspaceLocalId: 'ws-1' });
    expect(
      automationFormSidebarGroupScope({
        ...emptyFormState(),
        actionType: 'worktree_prompt',
      }),
    ).toBeUndefined();
    expect(
      automationFormSidebarGroupScope({
        ...emptyFormState(),
        actionType: 'worktree_prompt',
        workspaceId: 'ws-1',
        existingWorktreeId: 'wt-1',
      }),
    ).toBeUndefined();
    // A worktree branched from a base worktree is a stack child, which cannot
    // join a group on its own.
    expect(
      automationFormSidebarGroupScope({
        ...emptyFormState(),
        actionType: 'worktree_prompt',
        workspaceId: 'ws-1',
        baseWorktreeId: 'wt-base',
      }),
    ).toBeUndefined();
    expect(
      buildAction({
        ...emptyFormState(),
        actionType: 'worktree_prompt',
        workspaceId: 'ws-1',
        baseWorktreeId: 'wt-base',
        sidebarGroupName: 'Stacked group',
        prompt: 'Stacked',
      }).action,
    ).not.toHaveProperty('sidebarGroupName');
    expect(
      automationFormSidebarGroupScope({
        ...emptyFormState(),
        actionType: 'standalone_prompt',
        chatProjectId: 'cowork-1',
      }),
    ).toEqual({ workspaceLocalId: 'cowork-1' });
    expect(
      automationFormSidebarGroupScope({
        ...emptyFormState(),
        actionType: 'standalone_prompt',
      }),
    ).toBeUndefined();
    expect(
      automationFormSidebarGroupScope({
        ...emptyFormState(),
        actionType: 'standalone_prompt',
        chatProjectId: 'cowork-1',
        workEntryId: 'cowork-entry-1',
      }),
    ).toBeUndefined();
    expect(
      automationFormSidebarGroupScope({
        ...emptyFormState(),
        actionType: 'worktree_session_prompt',
        worktreeSessionTarget: {
          workspaceId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'advisor-entry-1',
          chatId: 'advisor-chat-1',
        },
      }),
    ).toBeUndefined();
    expect(
      automationFormSidebarGroupScope({
        ...emptyFormState(),
        actionType: 'worktree_pipeline',
        workspaceId: 'ws-1',
      }),
    ).toBeUndefined();
  });
});

describe('AutomationsPage — Personal/organization scoping (CAN-3448)', () => {
  const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ORG_OWNER = {
    type: 'organization' as const,
    organizationId: ORG,
    projectId: '11111111-1111-4111-8111-111111111111',
    instanceId: '22222222-2222-4222-8222-222222222222',
    bindingGeneration: 0,
  };
  let container: HTMLDivElement;
  let root: Root;
  const updateMock = jest.fn<
    Promise<AutomationMutationResponse>,
    [AutomationUpdateRequest]
  >();

  const personalChatsActivity = activity({
    id: 'personal-chats',
    name: 'Personal digest',
    enabled: false,
    action: {
      type: 'standalone_prompt',
      chatProjectId: 'chats',
      prompt: 'Digest my notes.',
    },
  });
  const orgActivity = activity({
    id: 'org-release',
    name: 'Org release check',
    action: {
      type: 'worktree_prompt',
      workspaceId: 'org-project',
      prompt: 'Check the release.',
    },
  });
  const advisorActivity = activity({
    id: 'advisor',
    name: 'Advisor summary',
  });

  function seedContext(
    flag: boolean,
    context:
      | { kind: 'personal' }
      | { kind: 'organization'; organizationId: string },
  ): void {
    const snapshot = getDefaultFeatureFlagSnapshot();
    snapshot.values[CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key] = flag;
    useFeatureFlagsStore.setState({ snapshot });
    useWorkspaceContextStore.setState({
      state: {
        context,
        revision: 1,
        organizations: [{ id: ORG, name: 'Acme', role: 'MEMBER' }],
      },
      hydrated: true,
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    updateMock.mockResolvedValue({ ok: true, activity: personalChatsActivity });
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        automations: {
          list: jest.fn().mockResolvedValue({ activities: [], recentRuns: [] }),
          listRuns: jest
            .fn()
            .mockResolvedValue({ runs: [], nextCursor: null, totalCount: 0 }),
          update: updateMock,
          onChanged: jest.fn(() => (): void => undefined),
        },
        appAdvisor: {
          listWatchers: jest.fn().mockResolvedValue([]),
          deleteWatcher: jest.fn().mockResolvedValue({ ok: true }),
          onWatchersChanged: jest.fn(() => (): void => undefined),
          openWindow: jest.fn(),
        },
        getWorktreePath: jest.fn().mockResolvedValue('/worktrees/base'),
        homeGetCoworkRoot: jest.fn().mockResolvedValue('/cowork/chats'),
      },
    });
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      writable: true,
      value: {
        list: jest.fn().mockResolvedValue({ success: true, data: [] }),
        discoverProject: jest.fn().mockResolvedValue({
          success: true,
          data: [],
        }),
      },
    });
    useAutomationsStore.setState({
      activities: [personalChatsActivity, orgActivity, advisorActivity],
      recentRuns: [],
      loading: false,
      hydrated: true,
      error: null,
      mutationError: null,
    });
    useAppAdvisorWatchersStore.setState({
      watchers: [
        watcher({
          id: 'personal-watcher',
          label: 'Personal watcher',
          destination: {
            projectId: 'chats',
            worktreeId: 'entry',
            chatId: 'chat',
          },
        }),
        watcher({
          id: 'org-watcher',
          label: 'Org watcher',
          destination: {
            projectId: 'org-project',
            worktreeId: 'base-worktree',
            chatId: 'chat',
          },
        }),
        watcher({ id: 'advisor-watcher', label: 'Advisor watcher' }),
      ],
      loading: false,
      hydrated: true,
      error: null,
      deleteErrors: {},
    });
    useStandaloneChatStore.setState({
      chatProjects: [
        {
          id: 'chats',
          name: 'Chats',
          createdAt: '2024-04-20T00:00:00.000Z',
        },
      ],
      chatProjectsLoaded: true,
    });
    useProjectsStore.setState({
      projects: [
        {
          id: 'chats',
          name: 'Chats',
          type: 'cowork',
          color: '',
          collapsed: false,
          order: 0,
        },
        {
          id: 'org-project',
          name: 'Org Project',
          type: 'single-repo',
          repoPath: '/repo/org-project',
          color: '#6366f1',
          owner: ORG_OWNER,
          worktrees: [
            {
              id: 'base-worktree',
              branchName: 'main',
              createdAt: '2024-04-20T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
    });
    useLinkedPersonalWorkspacesStore.setState({ ids: [] });
    useNavigationStore.setState({
      workflowEdit: undefined,
      pendingAutomationSharedPipelineReview: undefined,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = '';
    useWorkspaceContextStore.setState({ hydrated: false });
    useFeatureFlagsStore.setState({
      snapshot: getDefaultFeatureFlagSnapshot(),
    });
  });

  function renderPage(): void {
    act(() => {
      root.render(createElement(WorkflowsAutomationsHarness));
    });
  }

  it('lists only organization and App Advisor automations in an organization', () => {
    seedContext(true, { kind: 'organization', organizationId: ORG });
    renderPage();
    const text = container.textContent ?? '';
    expect(text).toContain('Org release check');
    expect(text).toContain('Advisor summary');
    expect(text).not.toContain('Personal digest');
  });

  it('lists Personal and App Advisor automations under Personal', () => {
    seedContext(true, { kind: 'personal' });
    renderPage();
    const text = container.textContent ?? '';
    expect(text).toContain('Personal digest');
    expect(text).toContain('Advisor summary');
    expect(text).not.toContain('Org release check');
  });

  it('leaves every list unchanged while org projects are off', () => {
    seedContext(false, { kind: 'organization', organizationId: ORG });
    renderPage();
    const text = container.textContent ?? '';
    expect(text).toContain('Personal digest');
    expect(text).toContain('Org release check');
    expect(text).toContain('Advisor summary');
  });

  it('shows where each automation runs on its row (CAN-3543)', () => {
    seedContext(true, { kind: 'organization', organizationId: ORG });
    useAutomationsStore.setState({
      activities: [
        { ...orgActivity, executionContext: `org:${ORG}` },
        // Its project moved to Acme after it was turned on in Personal.
        activity({
          id: 'moved',
          name: 'Moved check',
          executionContext: 'personal',
          action: {
            type: 'worktree_prompt',
            workspaceId: 'org-project',
            prompt: 'Check.',
          },
        }),
      ],
    });
    renderPage();
    const runsIn = (id: string): string | null | undefined =>
      container.querySelector(
        `[data-testid="automations-activity-runs-in-${id}"]`,
      )?.textContent;
    expect(runsIn('org-release')).toBe('Runs in Acme');
    expect(runsIn('moved')).toBe('Runs in Personal');
  });

  it('hides where automations run while org projects are off', () => {
    seedContext(false, { kind: 'personal' });
    useAutomationsStore.setState({
      activities: [{ ...orgActivity, executionContext: `org:${ORG}` }],
    });
    renderPage();
    expect(
      container.querySelector(
        '[data-testid="automations-activity-runs-in-org-release"]',
      ),
    ).toBeNull();
  });

  it('names the context when it hides every automation', () => {
    seedContext(true, { kind: 'organization', organizationId: ORG });
    useAutomationsStore.setState({ activities: [personalChatsActivity] });
    renderPage();
    expect(
      container.querySelector('[data-testid="automations-empty-title"]')
        ?.textContent,
    ).toBe('No triggered activities in Acme');
  });
});

describe('AutomationsPage — reveal an installed automation (CAN-3651)', () => {
  const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let container: HTMLDivElement;
  let root: Root;
  let listMock: jest.Mock<
    Promise<{ activities: ScheduledActivity[]; recentRuns: [] }>,
    []
  >;
  const updateMock = jest.fn<
    Promise<AutomationMutationResponse>,
    [AutomationUpdateRequest]
  >();
  const runNowMock = jest.fn<Promise<AutomationMutationResponse>, [unknown]>();
  const scrollIntoViewMock = jest.fn();
  let focusSpy: jest.SpyInstance;
  let rafSpy: jest.SpyInstance;
  const originalMatchMedia = window.matchMedia;
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(
    Element.prototype,
    'scrollIntoView',
  );

  const shareOrigin = {
    remoteId: 'share-1',
    contentHash: 'a'.repeat(64),
    installedAt: '2026-05-27T00:00:00.000Z',
  };
  const firstCopy = activity({
    id: 'copy-1',
    name: 'Nightly digest',
    enabled: false,
    installedFrom: shareOrigin,
  });
  const secondCopy = activity({
    id: 'copy-2',
    name: 'Nightly digest',
    enabled: false,
    installedFrom: shareOrigin,
  });

  function withProvenance(
    base: ScheduledActivity,
    overrides: Partial<ScheduledActivity> = {},
  ): ScheduledActivity {
    return { ...base, ...overrides };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    useFeatureFlagsStore.setState({
      snapshot: getDefaultFeatureFlagSnapshot(),
    });
    listMock = jest
      .fn<Promise<{ activities: ScheduledActivity[]; recentRuns: [] }>, []>()
      .mockResolvedValue({ activities: [], recentRuns: [] });
    updateMock.mockResolvedValue({ ok: true, activity: firstCopy });
    runNowMock.mockResolvedValue({ ok: true });
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        automations: {
          list: listMock,
          listRuns: jest
            .fn()
            .mockResolvedValue({ runs: [], nextCursor: null, totalCount: 0 }),
          update: updateMock,
          runNow: runNowMock,
          delete: jest.fn().mockResolvedValue({ ok: true }),
          onChanged: jest.fn(() => (): void => undefined),
        },
        appAdvisor: {
          listWatchers: jest.fn().mockResolvedValue([]),
          deleteWatcher: jest.fn().mockResolvedValue({ ok: true }),
          onWatchersChanged: jest.fn(() => (): void => undefined),
          openWindow: jest.fn(),
        },
        getWorktreePath: jest.fn().mockResolvedValue('/worktrees/base'),
        homeGetCoworkRoot: jest.fn().mockResolvedValue('/cowork/notes-root'),
      },
    });
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      writable: true,
      value: {
        list: jest.fn().mockResolvedValue({ success: true, data: [] }),
        discoverProject: jest
          .fn()
          .mockResolvedValue({ success: true, data: [] }),
      },
    });
    useAutomationsStore.setState({
      activities: [firstCopy, secondCopy],
      recentRuns: [],
      loading: false,
      hydrated: true,
      error: null,
      mutationError: null,
    });
    useAppAdvisorWatchersStore.setState({
      watchers: [],
      loading: false,
      hydrated: true,
      error: null,
      deleteErrors: {},
    });
    useStandaloneChatStore.setState({
      chatProjects: [
        {
          id: 'chats',
          name: 'Chats',
          createdAt: '2024-04-20T00:00:00.000Z',
        },
      ],
      chatProjectsLoaded: true,
    });
    useProjectsStore.setState({
      projects: [
        {
          id: 'chats',
          name: 'Chats',
          type: 'cowork',
          color: '',
          collapsed: false,
          order: 0,
        },
      ],
    });
    useLinkedPersonalWorkspacesStore.setState({ ids: [] });
    useNavigationStore.setState({
      activePage: 'automations',
      workflowEdit: undefined,
      pendingAutomationReveal: undefined,
      pendingAutomationSharedPipelineReview: undefined,
    });
    localStorage.removeItem('canopy.automations.triggeredSort');
    localStorage.removeItem('canopy.automations.viewMode');

    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoViewMock,
    });
    focusSpy = jest.spyOn(HTMLElement.prototype, 'focus');
    rafSpy = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback): number => {
        callback(0);
        return 0;
      });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = '';
    focusSpy.mockRestore();
    rafSpy.mockRestore();
    if (originalScrollIntoView) {
      Object.defineProperty(
        Element.prototype,
        'scrollIntoView',
        originalScrollIntoView,
      );
    } else {
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }
    window.matchMedia = originalMatchMedia;
    localStorage.removeItem('canopy.automations.triggeredSort');
    localStorage.removeItem('canopy.automations.viewMode');
    useWorkspaceContextStore.setState({ hydrated: false });
    useFeatureFlagsStore.setState({
      snapshot: getDefaultFeatureFlagSnapshot(),
    });
  });

  function renderPage(): void {
    act(() => {
      root.render(createElement(WorkflowsAutomationsHarness));
    });
  }

  async function settle(): Promise<void> {
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
  }

  async function reveal(
    activityId: string,
    outcome: 'installed' | 'updated' = 'installed',
  ): Promise<void> {
    await act(async () => {
      useNavigationStore.getState().openAutomationReveal({
        activityId,
        outcome,
      });
      await Promise.resolve();
    });
    await settle();
  }

  function byTestId(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${testId}"]`);
  }

  function noticeText(): string | null {
    return byTestId('automations-installed-notice')?.textContent ?? null;
  }

  function row(id: string): HTMLElement | null {
    return byTestId(`automations-activity-row-${id}`);
  }

  function click(element: Element | null): void {
    act(() => {
      element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  it('reveals the exact installed copy on Triggered with a status notice', async () => {
    renderPage();
    await reveal('copy-2');

    expect(useNavigationStore.getState().activePage).toBe('workflows-library');
    const notice = byTestId('automations-installed-notice');
    expect(notice?.getAttribute('role')).toBe('status');
    expect(noticeText()).toContain('Automation installed');
    expect(noticeText()).toContain("It's turned off until you enable it.");
    expect(
      container.querySelector(
        '[aria-label="Dismiss installed automation notice"]',
      ),
    ).not.toBeNull();

    // Exact-id match: the other copy of the same share is untouched.
    expect(row('copy-2')?.getAttribute('data-revealed')).toBe('true');
    expect(row('copy-2')?.getAttribute('tabindex')).toBe('-1');
    expect(row('copy-2')?.className).toContain('bg-accent-subtle');
    expect(
      byTestId('automations-activity-newly-installed-copy-2')?.textContent,
    ).toBe('Newly installed');
    expect(row('copy-1')?.hasAttribute('data-revealed')).toBe(false);
    expect(byTestId('automations-activity-newly-installed-copy-1')).toBeNull();

    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      block: 'center',
      behavior: 'smooth',
    });
    expect(scrollIntoViewMock.mock.contexts[0]).toBe(row('copy-2'));
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    expect(focusSpy.mock.contexts.at(-1)).toBe(row('copy-2'));
    expect(document.activeElement).toBe(row('copy-2'));

    // Completion never enables or runs the automation, and needs no reload.
    expect(updateMock).not.toHaveBeenCalled();
    expect(runNowMock).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().pendingAutomationReveal).toBe(
      undefined,
    );
  });

  it('scrolls and focuses once across later activity updates', async () => {
    renderPage();
    await reveal('copy-1');
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    const focusCalls = focusSpy.mock.calls.length;

    await act(async () => {
      useAutomationsStore.setState({
        activities: [
          withProvenance(firstCopy, { updatedAt: '2026-05-28T00:00:00.000Z' }),
          secondCopy,
        ],
      });
      await Promise.resolve();
    });
    await settle();

    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    expect(focusSpy.mock.calls.length).toBe(focusCalls);
    expect(row('copy-1')?.getAttribute('data-revealed')).toBe('true');
  });

  it('scrolls without animation when reduced motion is requested', async () => {
    window.matchMedia = jest.fn((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(() => false),
    }));
    renderPage();
    await reveal('copy-1');

    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      block: 'center',
      behavior: 'auto',
    });
  });

  it('describes an update from the live enabled state', async () => {
    useAutomationsStore.setState({
      activities: [withProvenance(firstCopy, { enabled: true }), secondCopy],
    });
    renderPage();
    await reveal('copy-1', 'updated');

    expect(noticeText()).toContain('Automation updated');
    expect(noticeText()).toContain("It's still on.");
    expect(
      byTestId('automations-activity-newly-installed-copy-1')?.textContent,
    ).toBe('Just updated');
    expect(
      container.querySelector(
        '[aria-label="Dismiss updated automation notice"]',
      ),
    ).not.toBeNull();

    await act(async () => {
      useAutomationsStore.setState({ activities: [firstCopy, secondCopy] });
      await Promise.resolve();
    });

    expect(noticeText()).toContain("It's turned off until you enable it.");
    expect(row('copy-1')?.getAttribute('data-revealed')).toBe('true');
  });

  it('says an installed automation is on once it is enabled', async () => {
    renderPage();
    await reveal('copy-1');
    await act(async () => {
      useAutomationsStore.setState({
        activities: [withProvenance(firstCopy, { enabled: true }), secondCopy],
      });
      await Promise.resolve();
    });

    expect(noticeText()).toContain("It's on.");
  });

  it('requests one refresh when the id is not loaded yet, then reveals it', async () => {
    const installed = activity({ id: 'fresh', name: 'Fresh', enabled: false });
    listMock.mockResolvedValue({
      activities: [firstCopy, secondCopy, installed],
      recentRuns: [],
    });
    renderPage();
    await reveal('fresh');

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(row('fresh')?.getAttribute('data-revealed')).toBe('true');
    expect(noticeText()).toContain('Automation installed');
  });

  it('reveals the id when a broadcast delivers it during the refresh', async () => {
    const installed = activity({ id: 'fresh', name: 'Fresh', enabled: false });
    let resolveList: (value: {
      activities: ScheduledActivity[];
      recentRuns: [];
    }) => void = () => {};
    listMock.mockReturnValue(
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    );
    renderPage();
    await reveal('fresh');
    expect(noticeText()).toBeNull();

    await act(async () => {
      useAutomationsStore.setState({
        activities: [firstCopy, secondCopy, installed],
      });
      await Promise.resolve();
    });
    expect(row('fresh')?.getAttribute('data-revealed')).toBe('true');

    await act(async () => {
      resolveList({
        activities: [firstCopy, secondCopy, installed],
        recentRuns: [],
      });
      await Promise.resolve();
    });
    await settle();
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(row('fresh')?.getAttribute('data-revealed')).toBe('true');
  });

  it('ends honestly when the refresh finishes without the id', async () => {
    renderPage();
    await reveal('missing');

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(noticeText()).toContain('Automation installed');
    expect(noticeText()).toContain(
      "The automation couldn't be shown. Refresh the list to find it.",
    );
    expect(container.querySelector('[data-revealed="true"]')).toBeNull();
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it('waits for an existing refresh without requesting another list', async () => {
    let finish: (value: {
      activities: ScheduledActivity[];
      recentRuns: [];
    }) => void = () => {};
    listMock.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const refresh = useAutomationsStore.getState().hydrate();
    renderPage();
    await reveal('fresh');
    const calls = listMock.mock.calls.length;
    expect(noticeText()).toBeNull();
    await act(async () => {
      finish({
        activities: [activity({ id: 'fresh', enabled: false })],
        recentRuns: [],
      });
      await refresh;
    });
    await settle();
    expect(calls).toBe(1);
    expect(row('fresh')?.getAttribute('data-revealed')).toBe('true');
  });

  it('keeps the newest reveal when an older refresh completes', async () => {
    let finish: (value: {
      activities: ScheduledActivity[];
      recentRuns: [];
    }) => void = () => {};
    listMock.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    renderPage();
    await reveal('older');
    await reveal('copy-2', 'updated');
    await act(async () => {
      finish({
        activities: [firstCopy, secondCopy, activity({ id: 'older' })],
        recentRuns: [],
      });
      await Promise.resolve();
    });
    await settle();
    expect(noticeText()).toContain('Automation updated');
    expect(row('copy-2')?.getAttribute('data-revealed')).toBe('true');
    expect(row('older')?.hasAttribute('data-revealed')).toBe(false);
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
  });

  it('ends honestly when the refresh fails', async () => {
    listMock.mockRejectedValue(new Error('IPC down'));
    renderPage();
    await reveal('missing', 'updated');

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(noticeText()).toContain('Automation updated');
    expect(noticeText()).toContain("The automation couldn't be shown.");
  });

  it('waits for hydration that has not finished yet', async () => {
    useAutomationsStore.setState({
      activities: [],
      hydrated: false,
      loading: true,
    });
    listMock.mockResolvedValue({
      activities: [firstCopy, secondCopy],
      recentRuns: [],
    });
    renderPage();
    await reveal('copy-1');

    expect(row('copy-1')?.getAttribute('data-revealed')).toBe('true');
  });

  it('drops a refresh that finishes after the page unmounts', async () => {
    let resolveList: (value: {
      activities: ScheduledActivity[];
      recentRuns: [];
    }) => void = () => {};
    listMock.mockReturnValue(
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    );
    renderPage();
    await reveal('missing');
    act(() => {
      root.unmount();
    });
    await act(async () => {
      resolveList({ activities: [], recentRuns: [] });
      await Promise.resolve();
    });

    root = createRoot(container);
    renderPage();
    await settle();
    expect(noticeText()).toBeNull();
    expect(useNavigationStore.getState().pendingAutomationReveal).toBe(
      undefined,
    );
  });

  it('shows the list over a saved calendar preference without overwriting it', async () => {
    localStorage.setItem('canopy.automations.viewMode', 'calendar');
    renderPage();
    expect(byTestId('automations-active-table')).toBeNull();

    await reveal('copy-1');
    expect(byTestId('automations-active-table')).not.toBeNull();
    expect(localStorage.getItem('canopy.automations.viewMode')).toBe(
      'calendar',
    );

    click(byTestId('automations-installed-notice-dismiss'));
    expect(noticeText()).toBeNull();
    expect(byTestId('automations-active-table')).toBeNull();
  });

  it('expands Previously Triggered when it holds the target', async () => {
    const past = activity({
      id: 'past',
      name: 'Launch reminder',
      enabled: false,
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-27T12:00:00.000Z',
        timezone: 'local',
      },
      lastResult: {
        status: 'success',
        completedAt: '2026-05-27T12:00:00.000Z',
      },
    });
    useAutomationsStore.setState({ activities: [firstCopy, past] });
    renderPage();
    expect(byTestId('automations-previously-triggered-table')).toBeNull();

    await reveal('past', 'updated');

    expect(byTestId('automations-previously-triggered-table')).not.toBeNull();
    expect(row('past')?.getAttribute('data-revealed')).toBe('true');
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
  });

  it('ends the list override on an explicit view change', async () => {
    localStorage.setItem('canopy.automations.viewMode', 'calendar');
    renderPage();
    await reveal('copy-1');
    click(byTestId('automations-viewmode-list'));
    expect(noticeText()).toBeNull();
    expect(row('copy-1')?.hasAttribute('data-revealed')).toBe(false);
    expect(localStorage.getItem('canopy.automations.viewMode')).toBe('list');
  });

  it('preserves the saved sort while revealing an off-screen long name', async () => {
    localStorage.setItem(
      'canopy.automations.triggeredSort',
      JSON.stringify({ column: 'name', direction: 'asc' }),
    );
    const longName = 'Z'.repeat(200);
    useAutomationsStore.setState({
      activities: [
        withProvenance(firstCopy, { name: 'A' }),
        withProvenance(secondCopy, { name: longName }),
      ],
    });
    renderPage();
    const savedSort = localStorage.getItem('canopy.automations.triggeredSort');
    await reveal('copy-2');
    expect(row('copy-2')?.textContent).toContain(longName);
    expect(localStorage.getItem('canopy.automations.triggeredSort')).toBe(
      savedSort,
    );
    expect(scrollIntoViewMock.mock.contexts[0]).toBe(row('copy-2'));
  });

  it('keeps hidden targets in calendar mode and reacts to context changes without refocusing', async () => {
    const snapshot = getDefaultFeatureFlagSnapshot();
    snapshot.values[CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key] = true;
    useFeatureFlagsStore.setState({ snapshot });
    useAutomationsStore.setState({
      activities: [
        withProvenance(firstCopy, {
          action: {
            type: 'standalone_prompt',
            chatProjectId: 'chats',
            prompt: 'Personal digest',
          },
        }),
      ],
    });
    useWorkspaceContextStore.setState({
      state: {
        context: { kind: 'organization', organizationId: ORG },
        revision: 1,
        organizations: [{ id: ORG, name: 'Acme', role: 'MEMBER' }],
      },
      hydrated: true,
    });
    localStorage.setItem('canopy.automations.viewMode', 'calendar');
    renderPage();
    await reveal('copy-1');
    expect(row('copy-1')).toBeNull();
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
    expect(noticeText()).toContain('Runs in Personal');
    await act(async () => {
      useWorkspaceContextStore.setState({
        state: {
          context: { kind: 'personal' },
          revision: 2,
          organizations: [],
        },
      });
      await Promise.resolve();
    });
    await settle();
    expect(row('copy-1')?.getAttribute('data-revealed')).toBe('true');
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      useWorkspaceContextStore.setState({
        state: {
          context: { kind: 'organization', organizationId: ORG },
          revision: 3,
          organizations: [{ id: ORG, name: 'Acme', role: 'MEMBER' }],
        },
      });
      await Promise.resolve();
    });
    expect(row('copy-1')).toBeNull();
    expect(localStorage.getItem('canopy.automations.viewMode')).toBe(
      'calendar',
    );
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
  });

  it('ends the reveal when the notice is dismissed', async () => {
    renderPage();
    await reveal('copy-1');
    click(byTestId('automations-installed-notice-dismiss'));

    expect(noticeText()).toBeNull();
    expect(container.querySelector('[data-revealed="true"]')).toBeNull();
  });

  it('ends the reveal when another row is selected, but not for its own details', async () => {
    renderPage();
    await reveal('copy-1');

    click(row('copy-1'));
    expect(byTestId('automations-activity-newly-installed-copy-1')).not.toBe(
      null,
    );
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    expect(useNavigationStore.getState().workflowEdit).toEqual({
      kind: 'automation',
      activityId: 'copy-1',
      section: 'runs',
    });

    click(row('copy-2'));
    expect(noticeText()).toBeNull();
    expect(container.querySelector('[data-revealed="true"]')).toBeNull();
  });

  it.each([
    ['review', 'copy-2'],
    ['run-now', 'copy-2'],
    ['review', 'copy-1'],
    ['run-now', 'copy-1'],
  ])(
    'cleans up a reveal according to the row selected through %s on %s',
    async (entryPoint, targetId) => {
      localStorage.setItem('canopy.automations.viewMode', 'calendar');
      useAutomationsStore.setState({
        activities: [firstCopy, secondCopy].map((copy) => ({
          ...copy,
          action: {
            type: 'worktree_pipeline',
            workspaceId: 'chats',
            pipelineId: 'shared:canopy-cloud:remote-1',
            pipelineSource: 'shared',
            sharedPipeline: { serverId: 'canopy-cloud', remoteId: 'remote-1' },
          },
          sharedPipelineReview: {
            detectedAt: '2026-09-26T12:00:00.000Z',
            remoteId: 'remote-1',
          },
        })),
      });
      Object.assign(window.api.automations, {
        resolveSharedPipelineInstallPin: jest.fn().mockResolvedValue({
          installPin: {
            pipelineContentHash: 'b'.repeat(64),
            distributionMode: 'definition_only',
          },
          rawPipeline: 'name: Nightly digest\non: dispatch\n',
        }),
      });
      renderPage();
      await reveal('copy-1');
      const action = byTestId(`automations-${entryPoint}-${targetId}`);
      expect(action).not.toBeNull();
      click(action);
      await settle();

      expect(
        document.querySelector('[data-testid="shared-pipeline-review-modal"]'),
      ).not.toBeNull();
      expect(runNowMock).not.toHaveBeenCalled();
      if (targetId === 'copy-2') {
        expect(noticeText()).toBeNull();
        expect(container.querySelector('[data-revealed="true"]')).toBeNull();
        expect(
          byTestId('automations-viewmode-calendar')?.getAttribute(
            'aria-pressed',
          ),
        ).toBe('true');
      } else {
        expect(noticeText()).toContain('Automation installed');
        expect(row('copy-1')?.getAttribute('data-revealed')).toBe('true');
        expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
      }
      expect(localStorage.getItem('canopy.automations.viewMode')).toBe(
        'calendar',
      );
    },
  );

  it('ends the reveal when the target is deleted', async () => {
    renderPage();
    await reveal('copy-1');
    await act(async () => {
      useAutomationsStore.setState({ activities: [secondCopy] });
      await Promise.resolve();
    });

    expect(noticeText()).toBeNull();
  });

  it('lets a later edit request supersede the reveal', async () => {
    renderPage();
    await reveal('copy-1');
    await act(async () => {
      useNavigationStore.getState().openAutomationEdit({
        activityId: 'copy-2',
      });
      await Promise.resolve();
    });

    expect(noticeText()).toBeNull();
    expect(useNavigationStore.getState().workflowEdit).toEqual({
      kind: 'automation',
      activityId: 'copy-2',
    });
  });

  it('reveals again for a repeated same-id request', async () => {
    renderPage();
    await reveal('copy-1');
    click(byTestId('automations-installed-notice-dismiss'));
    await reveal('copy-1');

    expect(noticeText()).toContain('Automation installed');
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the selected context and names it for an out-of-context target', async () => {
    const snapshot = getDefaultFeatureFlagSnapshot();
    snapshot.values[CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key] = true;
    useFeatureFlagsStore.setState({ snapshot });
    useWorkspaceContextStore.setState({
      state: {
        context: { kind: 'organization', organizationId: ORG },
        revision: 1,
        organizations: [{ id: ORG, name: 'Acme', role: 'MEMBER' }],
      },
      hydrated: true,
    });
    const personal = activity({
      id: 'personal',
      name: 'Personal digest',
      enabled: true,
      action: {
        type: 'standalone_prompt',
        chatProjectId: 'chats',
        prompt: 'Digest my notes.',
      },
    });
    useAutomationsStore.setState({ activities: [personal] });
    renderPage();
    await reveal('personal');

    expect(noticeText()).toContain("It's on. Runs in Personal.");
    expect(row('personal')).toBeNull();
    expect(container.querySelector('[data-revealed="true"]')).toBeNull();
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
    expect(useWorkspaceContextStore.getState().state?.context).toEqual({
      kind: 'organization',
      organizationId: ORG,
    });
  });
});
