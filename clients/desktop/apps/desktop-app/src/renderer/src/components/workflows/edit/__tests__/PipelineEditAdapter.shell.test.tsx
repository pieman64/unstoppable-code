/**
 * @jest-environment jsdom
 *
 * CAN-4072: the pipeline's header actions in the edit shell. Delete
 * confirms in a dialog but never asks about unsaved edits, actions on the
 * saved version wait for a save, ⌘S belongs to the
 * shell, a saved draft becomes its pipeline without asking, a missing
 * pipeline says so, and visited sections keep their state.
 */
import type { JSX } from 'react';
import type * as PipelineEditMocks from './pipelineEditMocks';

const mockRelatedNavigateContinuation = jest.fn();
let mockOnShared: ((detail: { id: string }) => void) | undefined;
const mockOpenDispatchPipelineModal = jest.fn();

jest.mock('@/hooks/usePipelineEditor', () => ({
  usePipelineEditor: (target: {
    pipelineId: string | null;
  }): ReturnType<typeof PipelineEditMocks.useMockPipelineEditor> =>
    jest
      .requireActual<typeof PipelineEditMocks>('./pipelineEditMocks')
      .useMockPipelineEditor(target),
}));
jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (): void => undefined,
}));
jest.mock('@/hooks/useShareAccess', () => ({
  // Access is granted: Share opens its dialog at once.
  useShareAccess: (): {
    requestShare: (context: string, proceed: () => void) => void;
    shareGateModal: null;
  } => ({
    requestShare: (_context, proceed): void => proceed(),
    shareGateModal: null,
  }),
}));
jest.mock('@/components/pipeline/SharePipelineModal', () => ({
  SharePipelineModal: ({
    worktree,
    onShared,
  }: {
    worktree?: { projectId: string; worktreeId: string };
    onShared?: (detail: { id: string }) => void;
  }): JSX.Element => {
    mockOnShared = onShared;
    return (
      <div
        data-testid="mock-share-modal"
        data-project-id={worktree?.projectId ?? ''}
        data-worktree-id={worktree?.worktreeId ?? ''}
      >
        <button
          type="button"
          data-testid="mock-share-complete"
          onClick={(): void => onShared?.({ id: 'remote-9' })}
        />
      </div>
    );
  },
}));
jest.mock('@canopy/app-state', () => ({
  ...jest.requireActual<object>('@canopy/app-state'),
  useCapabilities: (): { pipelines: 'execute'; automations: boolean } => ({
    pipelines: 'execute',
    automations: true,
  }),
}));
jest.mock('@/components/activity/useDispatchPipelineModal', () => ({
  useDispatchPipelineModal: (): {
    openDispatchPipelineModal: jest.Mock;
    dispatchPipelineModal: null;
  } => ({
    openDispatchPipelineModal: mockOpenDispatchPipelineModal,
    dispatchPipelineModal: null,
  }),
}));
jest.mock('@/components/pipeline/flow/PipelineFlowDiagram', () => ({
  PipelineFlowDiagram: (): JSX.Element => (
    <div data-testid="mock-pipeline-flow-diagram" />
  ),
}));
jest.mock('@/components/pipeline/PipelineSettingsPanel', () => ({
  PipelineSettingsPanel: ({
    onRelatedNavigate,
  }: {
    onRelatedNavigate: (
      navigate: (savedPipelineInfo?: unknown) => void,
    ) => void;
  }): JSX.Element => (
    <button
      type="button"
      data-testid="mock-related-navigation"
      onClick={(): void => onRelatedNavigate(mockRelatedNavigateContinuation)}
    >
      Open related pipeline
    </button>
  ),
}));
jest.mock('@/components/shared/PageTitlebar', () => ({
  PageTitlebar: (): null => null,
}));
jest.mock('../AutomationEditAdapter', () => ({
  AutomationEditAdapter: (): null => null,
}));
jest.mock('../SharedAutomationEditAdapter', () => ({
  SharedAutomationEditAdapter: (): null => null,
}));
jest.mock('../PipelineEditSections', () => ({
  PipelineTriggerSection: (): JSX.Element => (
    <div data-testid="mock-trigger-section" />
  ),
  PipelineRunsSection: (): JSX.Element => (
    <div data-testid="mock-runs-section" />
  ),
}));

import { act } from 'react';
import {
  WORKFLOW_EDIT_DUPLICATE_DIRTY_REASON,
  WORKFLOW_EDIT_RUN_DIRTY_REASON,
  WORKFLOW_EDIT_SHARE_DIRTY_REASON,
} from '@canopy/ui-app/workflows';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { setNativeInputValue } from '@/test-utils/dom';
import {
  byTestId,
  click,
  flush,
  flushTimers,
  pipelinesApi,
  pressMod,
  renderShell,
  shownTarget,
  unmountShell,
  openMoreMenu,
} from './pipelineEditHarness';
import {
  pipelineInfo,
  resetMockEditors,
  setMockEditor,
} from './pipelineEditMocks';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const REVIEW = { kind: 'pipeline', pipelineId: 'review' } as const;
const SHARED = pipelineInfo({
  id: 'shared:canopy-cloud:remote-1',
  name: 'Team review',
  source: 'shared',
  remoteId: 'remote-1',
  canUpdate: true,
});
const SHARED_TARGET = {
  kind: 'pipeline',
  pipelineId: SHARED.id,
  sharedRemoteId: 'remote-1',
} as const;

function navigateHome(): void {
  act(() => {
    useNavigationStore.getState().navigate('home');
  });
}

function expectExplainedDisabled(testId: string, reason: string): void {
  const action = byTestId(testId);
  expect(action).not.toBeNull();
  expect(action?.getAttribute('aria-disabled')).toBe('true');
  expect(action?.getAttribute('aria-description')).toBe(reason);
}

beforeEach(() => {
  jest.clearAllMocks();
  resetMockEditors();
  useChatStore.setState({ selectedWorktree: null });
  Object.defineProperty(window, 'pipelines', {
    configurable: true,
    value: {
      getSharedUpdateImpact: jest.fn(() =>
        Promise.resolve({ success: true, data: { automations: [] } }),
      ),
    },
  });
});

afterEach(() => {
  unmountShell();
  useNavigationStore.setState({ workflowEdit: undefined });
});

describe('PipelineEditAdapter delete', () => {
  it('confirms in a dialog and leaves without asking, even when dirty', async () => {
    const editor = setMockEditor('review');
    const { pipelines } = renderShell(REVIEW);

    openMoreMenu();
    click(byTestId('pipeline-editor-delete'));
    expect(byTestId('workflow-edit-delete-dialog')).not.toBeNull();
    expect(pipelines.remove).not.toHaveBeenCalled();

    click(byTestId('pipeline-editor-delete-confirm'));
    await flush();

    expect(pipelines.remove).toHaveBeenCalledWith(editor.pipelineInfo);
    expect(byTestId('workflows-unsaved-dialog')).toBeNull();
    expect(editor.save).not.toHaveBeenCalled();
    expect(shownTarget()).toBeUndefined();
    expect(byTestId('harness-library')).not.toBeNull();
  });

  it('stays, with the failure in the confirmation, when the delete fails', async () => {
    setMockEditor('review', { isDirty: false });
    const pipelines = pipelinesApi({
      remove: jest.fn(() =>
        Promise.reject(new Error('The pipeline could not be deleted.')),
      ),
    });
    renderShell(REVIEW, { pipelines });

    openMoreMenu();
    click(byTestId('pipeline-editor-delete'));
    click(byTestId('pipeline-editor-delete-confirm'));
    await flush();

    expect(shownTarget()).toMatchObject({ pipelineId: 'review' });
    expect(byTestId('confirm-dialog-error')?.textContent).toBe(
      'The pipeline could not be deleted.',
    );
    expect(
      byTestId('pipeline-editor-delete-confirm')?.hasAttribute('disabled'),
    ).toBe(false);
  });

  it('keeps Delete off while a save runs', () => {
    setMockEditor('review', { saving: true });
    renderShell(REVIEW);

    openMoreMenu();
    expect(byTestId('pipeline-editor-delete')?.hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('hides Delete on a shared pipeline the user may edit but not delete', () => {
    setMockEditor(SHARED.id, { pipelineInfo: SHARED, isDirty: false });
    renderShell(SHARED_TARGET);

    expect(byTestId('pipeline-save')).not.toBeNull();
    openMoreMenu();
    expect(byTestId('workflow-edit-menu')).not.toBeNull();
    expect(byTestId('pipeline-editor-delete')).toBeNull();
  });
});

describe('PipelineEditAdapter actions on the saved version', () => {
  it('disables Run, Share and Duplicate while dirty, saying why', () => {
    setMockEditor(SHARED.id, { pipelineInfo: SHARED });
    renderShell(SHARED_TARGET);

    expectExplainedDisabled(
      'workflow-edit-run',
      WORKFLOW_EDIT_RUN_DIRTY_REASON,
    );
    expectExplainedDisabled('pipeline-share', WORKFLOW_EDIT_SHARE_DIRTY_REASON);
    click(byTestId('workflow-edit-run'));
    expect(mockOpenDispatchPipelineModal).not.toHaveBeenCalled();

    // Duplicate waits in the More menu, with its reason beneath it.
    openMoreMenu();
    const duplicate = byTestId('pipeline-editor-duplicate');
    expect(duplicate?.hasAttribute('disabled')).toBe(true);
    const reasonId = duplicate?.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(reasonId)?.textContent).toBe(
      WORKFLOW_EDIT_DUPLICATE_DIRTY_REASON,
    );
  });

  it('runs the saved pipeline in the selected worktree once clean', () => {
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-a', worktreeId: 'worktree-a' },
    });
    setMockEditor('review', { isDirty: false });
    renderShell(REVIEW);

    expect(byTestId('workflow-edit-run')?.getAttribute('aria-disabled')).toBe(
      null,
    );
    click(byTestId('workflow-edit-run'));

    expect(mockOpenDispatchPipelineModal).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      initialPipelineId: 'review',
    });
  });

  it('shows the pipeline assistant as an Assistant action in the bar', () => {
    setMockEditor('review', { isDirty: false });
    const { pipelines } = renderShell(REVIEW);

    const assistant = byTestId('workflow-edit-assistant');
    expect(
      assistant?.closest('[data-testid="workflow-edit-actions"]'),
    ).not.toBeNull();
    expect(assistant?.textContent).toBe('Assistant');
    click(assistant);

    expect(pipelines.assistant.toggle).toHaveBeenCalledTimes(1);
  });

  it('turns the pipeline off through the page', () => {
    setMockEditor('review', { isDirty: false });
    const { pipelines } = renderShell(REVIEW);

    expect(byTestId('workflow-edit-enabled-state')).toBeNull();
    openMoreMenu();
    const toggle = byTestId('pipeline-editor-enabled');
    expect(toggle?.textContent).toBe('Turn off');
    click(toggle);

    expect(pipelines.setPipelineEnabled).toHaveBeenCalledWith('review', false);
  });
});

describe('PipelineEditAdapter project pipelines', () => {
  const PROJECT = pipelineInfo({
    id: 'project-review',
    source: 'project',
    filePath: '/repo-a/.canopy/pipelines/review.yml',
  });
  const TARGET = {
    kind: 'pipeline',
    pipelineId: 'project-review',
    cwd: '/repo-a',
    filePath: '/repo-a/.canopy/pipelines/review.yml',
  } as const;
  const WORKTREE_A = { projectId: 'project-a', worktreeId: 'worktree-a' };

  it('shares with the worktree whose checkout the pipeline came from', () => {
    setMockEditor('project-review', { pipelineInfo: PROJECT, isDirty: false });
    renderShell(TARGET, {
      pipelines: pipelinesApi({
        projectContext: { cwd: '/repo-a', worktree: WORKTREE_A },
      }),
    });

    click(byTestId('pipeline-share'));

    expect(byTestId('mock-share-modal')?.dataset).toMatchObject({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
    });
  });

  it('keeps editing the local pipeline, section and Back target after a share', async () => {
    setMockEditor('project-review', { pipelineInfo: PROJECT, isDirty: false });
    const returnTo = { kind: 'automation', activityId: 'a-1' } as const;
    renderShell(
      { ...TARGET, section: 'trigger', returnTo },
      {
        pipelines: pipelinesApi({
          projectContext: { cwd: '/repo-a', worktree: WORKTREE_A },
        }),
      },
    );

    click(byTestId('pipeline-share'));
    click(byTestId('mock-share-complete'));
    await flushTimers();

    // Sharing keeps the local pipeline, so the editor never swaps to the
    // shared copy.
    expect(shownTarget()).toMatchObject({
      kind: 'pipeline',
      pipelineId: 'project-review',
      section: 'trigger',
      returnTo,
    });
    expect(shownTarget()).not.toHaveProperty('sharedRemoteId');
  });

  it('does not pull the user back when a share finishes after they left', async () => {
    setMockEditor('project-review', { pipelineInfo: PROJECT, isDirty: false });
    renderShell(TARGET, {
      pipelines: pipelinesApi({
        projectContext: { cwd: '/repo-a', worktree: WORKTREE_A },
      }),
    });
    click(byTestId('pipeline-share'));
    const onShared = mockOnShared;

    navigateHome();
    act(() => {
      onShared?.({ id: 'remote-9' });
    });
    await flushTimers();

    expect(shownTarget()).toBeUndefined();
    expect(useNavigationStore.getState().activePage).toBe('home');
  });

  it('keeps the worktree it opened with after another worktree is selected', () => {
    setMockEditor('project-review', { pipelineInfo: PROJECT, isDirty: false });
    const pipelines = pipelinesApi({
      projectContext: { cwd: '/repo-a', worktree: WORKTREE_A },
    });
    const shell = renderShell(TARGET, { pipelines });
    Object.assign(pipelines, {
      projectContext: {
        cwd: '/repo-b',
        worktree: { projectId: 'project-b', worktreeId: 'worktree-b' },
      },
    });
    shell.rerender();

    click(byTestId('pipeline-share'));

    expect(byTestId('mock-share-modal')?.dataset).toMatchObject({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
    });
  });

  it('shares without a worktree once another checkout is selected', () => {
    setMockEditor('project-review', { pipelineInfo: PROJECT, isDirty: false });
    renderShell(TARGET, {
      pipelines: pipelinesApi({
        projectContext: {
          cwd: '/repo-b',
          worktree: { projectId: 'project-b', worktreeId: 'worktree-b' },
        },
      }),
    });

    click(byTestId('pipeline-share'));

    expect(byTestId('mock-share-modal')?.dataset).toMatchObject({
      projectId: '',
      worktreeId: '',
    });
  });
});

describe('PipelineEditAdapter shortcuts', () => {
  it('saves once on ⌘S through the shell', async () => {
    const editor = setMockEditor('review');
    renderShell(REVIEW);

    expect(pressMod('s').defaultPrevented).toBe(true);
    await flush();

    expect(editor.save).toHaveBeenCalledTimes(1);
  });

  it('keeps ⌘S from the browser but saves nothing while Save is off', async () => {
    const editor = setMockEditor('review', { isDirty: false });
    renderShell(REVIEW);

    expect(pressMod('s').defaultPrevented).toBe(true);
    await flush();

    expect(editor.save).not.toHaveBeenCalled();
  });

  it('leaves ⌘S alone on a read-only pipeline', async () => {
    const editor = setMockEditor('review', {
      readonly: true,
      isDirty: false,
      canSave: false,
    });
    renderShell(REVIEW);

    expect(pressMod('s').defaultPrevented).toBe(false);
    await flush();

    expect(editor.save).not.toHaveBeenCalled();
  });

  it('still undoes and redoes with ⌘Z and ⇧⌘Z', () => {
    const editor = setMockEditor('review');
    renderShell(REVIEW);

    expect(pressMod('z').defaultPrevented).toBe(true);
    pressMod('z', { shiftKey: true });

    expect(editor.undo).toHaveBeenCalledTimes(1);
    expect(editor.redo).toHaveBeenCalledTimes(1);
    expect(editor.save).not.toHaveBeenCalled();
  });

  it('leaves ⌘Z to the page while Definition is hidden', () => {
    const editor = setMockEditor('review');
    renderShell({ ...REVIEW, section: 'runs' });

    // Undo in the Runs search must not revert a pipeline edit out of sight.
    expect(pressMod('z').defaultPrevented).toBe(false);
    expect(editor.undo).not.toHaveBeenCalled();
  });
});

describe('PipelineEditAdapter drafts', () => {
  const DRAFT = {
    kind: 'pipeline',
    pipelineId: null,
    draftKey: 'draft-a',
  } as const;
  const SAVED = pipelineInfo({ id: 'new-pipeline', name: 'New pipeline' });

  it('becomes the saved pipeline without asking', async () => {
    const draft = setMockEditor(null, {
      pipelineInfo: null,
      save: jest.fn().mockResolvedValue(SAVED),
    });
    setMockEditor('new-pipeline', { pipelineInfo: SAVED, isDirty: false });
    renderShell({ ...DRAFT, section: 'definition' });
    const replaces = useNavigationStore.getState().workflowEditReplaceCount;

    expect(byTestId('workflow-edit-save-state')?.textContent).toBe('New');
    // A draft has nothing for the More menu yet.
    expect(byTestId('workflow-edit-more')).toBeNull();
    click(byTestId('pipeline-save'));
    await flushTimers();

    expect(draft.save).toHaveBeenCalledTimes(1);
    expect(byTestId('workflows-unsaved-dialog')).toBeNull();
    expect(shownTarget()).toEqual({
      kind: 'pipeline',
      pipelineId: 'new-pipeline',
      source: 'user',
      section: 'definition',
    });
    expect(useNavigationStore.getState().workflowEditReplaceCount).toBe(
      replaces + 1,
    );
    expect(byTestId('workflow-edit-save-state')).toBeNull();
  });

  it('lets a save from the prompt leave instead of reopening the draft', async () => {
    setMockEditor(null, {
      pipelineInfo: null,
      save: jest.fn().mockResolvedValue(SAVED),
    });
    renderShell(DRAFT);
    navigateHome();
    click(byTestId('workflows-unsaved-save'));
    await flushTimers();

    expect(useNavigationStore.getState().activePage).toBe('home');
    expect(shownTarget()).toBeUndefined();
  });
});

describe('PipelineEditAdapter missing pipeline', () => {
  it('says the pipeline is gone and leaves without asking', () => {
    renderShell({ kind: 'pipeline', pipelineId: 'deleted' });

    expect(byTestId('workflow-edit-not-found')?.textContent).toContain(
      'This pipeline no longer exists.',
    );
    expect(byTestId('workflow-edit-shell')).toBeNull();

    click(byTestId('workflow-edit-back'));
    expect(byTestId('workflows-unsaved-dialog')).toBeNull();
    expect(shownTarget()).toBeUndefined();
  });
});

describe('PipelineEditAdapter sections', () => {
  it('keeps unsaved Raw text across a Trigger round trip', () => {
    setMockEditor('review', { isDirty: false });
    renderShell(REVIEW);

    click(byTestId('pipeline-mode-raw'));
    const textarea = document.querySelector('textarea');
    if (!textarea) throw new Error('No Raw editor');
    expect(textarea.value).toContain('name: Review');
    act(() => {
      setNativeInputValue(textarea, 'pipeline:\n  name: Edited in Raw\n');
    });
    expect(byTestId('workflow-edit-shell')?.dataset.dirty).toBe('true');

    click(byTestId('workflow-edit-tab-trigger'));
    expect(shownTarget()?.section).toBe('trigger');
    expect(byTestId('workflow-edit-section-definition')?.hidden).toBe(true);
    expect(byTestId('mock-trigger-section')).not.toBeNull();

    click(byTestId('workflow-edit-tab-definition'));
    expect(byTestId('workflow-edit-section-definition')?.hidden).toBe(false);
    expect(document.querySelector('textarea')).toBe(textarea);
    expect(textarea.value).toBe('pipeline:\n  name: Edited in Raw\n');
    expect(byTestId('workflow-edit-shell')?.dataset.dirty).toBe('true');
  });
});
