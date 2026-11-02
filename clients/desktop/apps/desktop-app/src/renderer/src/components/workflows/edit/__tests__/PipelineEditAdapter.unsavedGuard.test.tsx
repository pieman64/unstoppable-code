/**
 * @jest-environment jsdom
 *
 * CAN-3981, CAN-4072: leaving a pipeline with unsaved edits asks first. The
 * edit shell registers the navigation guard, so Back, the sidebar, another
 * item and history all wait for Save, Discard or Keep editing.
 */
import type { JSX } from 'react';
import type * as PipelineEditMocks from './pipelineEditMocks';

const mockRelatedNavigateContinuation = jest.fn();
const mockAssistantDraft = { present: false, discard: jest.fn() };

jest.mock('@/components/pipeline/pipelineAssistantDraft', () => ({
  usePipelineAssistantDraft: (): typeof mockAssistantDraft =>
    mockAssistantDraft,
}));

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
  useShareAccess: (): { requestShare: jest.Mock; shareGateModal: null } => ({
    requestShare: jest.fn(),
    shareGateModal: null,
  }),
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
    openWorkflowsRunModal: jest.Mock;
    dispatchPipelineModal: null;
  } => ({ openWorkflowsRunModal: jest.fn(), dispatchPipelineModal: null }),
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
  registerNavigationGuard,
  useNavigationStore,
} from '@/stores/navigationStore';
import {
  byTestId,
  click,
  flush,
  renderShell,
  shownTarget,
  unmountShell,
} from './pipelineEditHarness';
import { resetMockEditors, setMockEditor } from './pipelineEditMocks';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const REVIEW = { kind: 'pipeline', pipelineId: 'review' } as const;

function navigateHome(): void {
  act(() => {
    useNavigationStore.getState().navigate('home');
  });
}

function pressEscape(): void {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAssistantDraft.present = false;
  resetMockEditors();
  // Nothing is left from an earlier suite's shell.
  registerNavigationGuard(() => true)();
});

afterEach(() => {
  unmountShell();
  useNavigationStore.setState({ workflowEdit: undefined });
});

describe('PipelineEditAdapter unsaved-changes guard', () => {
  it('lets a clean pipeline navigate at once', () => {
    setMockEditor('review', { isDirty: false });
    renderShell(REVIEW);
    navigateHome();

    expect(useNavigationStore.getState().activePage).toBe('home');
    expect(shownTarget()).toBeUndefined();
    expect(byTestId('workflows-unsaved-dialog')).toBeNull();
  });

  it('lets a read-only pipeline navigate at once', () => {
    setMockEditor('review', { readonly: true });
    renderShell(REVIEW);
    navigateHome();

    expect(useNavigationStore.getState().activePage).toBe('home');
    expect(byTestId('workflows-unsaved-dialog')).toBeNull();
  });

  it('asks before leaving a dirty pipeline and stays when the prompt is closed', async () => {
    const editor = setMockEditor('review');
    renderShell(REVIEW);
    navigateHome();

    expect(useNavigationStore.getState().activePage).toBe('workflows-library');
    expect(byTestId('workflows-unsaved-dialog')?.textContent).toContain(
      'Review',
    );

    pressEscape();
    await flush();
    expect(byTestId('workflows-unsaved-dialog')).toBeNull();
    expect(useNavigationStore.getState().activePage).toBe('workflows-library');
    expect(shownTarget()).toMatchObject({ pipelineId: 'review' });
    expect(editor.save).not.toHaveBeenCalled();
  });

  it('leaves without saving on Discard', async () => {
    const editor = setMockEditor('review');
    renderShell(REVIEW);
    navigateHome();
    click(byTestId('workflows-unsaved-discard'));
    await flush();

    expect(useNavigationStore.getState().activePage).toBe('home');
    expect(shownTarget()).toBeUndefined();
    expect(editor.save).not.toHaveBeenCalled();
  });

  it('saves, then leaves, on Save changes', async () => {
    const editor = setMockEditor('review');
    renderShell(REVIEW);
    navigateHome();
    click(byTestId('workflows-unsaved-save'));
    await flush();

    expect(editor.save).toHaveBeenCalledTimes(1);
    expect(useNavigationStore.getState().activePage).toBe('home');
  });

  it('stays in the pipeline and shows why when the save fails', async () => {
    const editor = setMockEditor('review', {
      save: jest.fn().mockResolvedValue(null),
    });
    renderShell({ ...REVIEW, section: 'trigger' });
    navigateHome();
    click(byTestId('workflows-unsaved-save'));
    await flush();

    expect(editor.save).toHaveBeenCalledTimes(1);
    expect(byTestId('workflows-unsaved-dialog')).toBeNull();
    expect(useNavigationStore.getState().activePage).toBe('workflows-library');
    expect(byTestId('workflow-edit-shell')?.dataset.dirty).toBe('true');
    // The error is in the shell, and the shell moved to the section it is in.
    expect(byTestId('pipeline-editor-save-error')?.textContent).toContain(
      'The workflow could not be saved.',
    );
    expect(shownTarget()?.section).toBe('definition');
    expect(byTestId('workflow-edit-section-definition')?.hidden).toBe(false);
  });

  it('asks before another pipeline replaces a dirty one', async () => {
    setMockEditor('review');
    setMockEditor('other', { isDirty: false });
    renderShell(REVIEW);
    act(() => {
      useNavigationStore.getState().openPipelineEdit({ pipelineId: 'other' });
    });

    expect(byTestId('workflows-unsaved-dialog')).not.toBeNull();
    expect(shownTarget()).toMatchObject({ pipelineId: 'review' });

    click(byTestId('workflows-unsaved-discard'));
    await flush();
    expect(shownTarget()).toMatchObject({ pipelineId: 'other' });
  });

  it('asks on Back, and Back goes on once discarded', async () => {
    setMockEditor('review');
    renderShell(REVIEW);
    click(byTestId('pipeline-editor-back'));

    expect(byTestId('workflows-unsaved-dialog')).not.toBeNull();
    expect(shownTarget()).toMatchObject({ pipelineId: 'review' });

    click(byTestId('workflows-unsaved-discard'));
    await flush();
    expect(shownTarget()).toBeUndefined();
    expect(byTestId('harness-library')).not.toBeNull();
  });

  it('keeps the pipeline open when Back is answered with Keep editing', async () => {
    setMockEditor('review');
    renderShell(REVIEW);
    click(byTestId('pipeline-editor-back'));
    pressEscape();
    await flush();

    expect(byTestId('workflows-unsaved-dialog')).toBeNull();
    expect(shownTarget()).toMatchObject({ pipelineId: 'review' });
    expect(byTestId('workflow-edit-shell')).not.toBeNull();
  });

  it('goes Back without asking when there is nothing to save', () => {
    setMockEditor('review', { isDirty: false });
    renderShell(REVIEW);
    click(byTestId('pipeline-editor-back'));

    expect(byTestId('workflows-unsaved-dialog')).toBeNull();
    expect(shownTarget()).toBeUndefined();
  });

  it('lets a related-pipeline link through once it has saved', async () => {
    const editor = setMockEditor('review', { activePanel: 'settings' });
    setMockEditor('other', { isDirty: false });
    mockRelatedNavigateContinuation.mockImplementation(() =>
      useNavigationStore.getState().openPipelineEdit({ pipelineId: 'other' }),
    );
    renderShell(REVIEW);
    click(byTestId('mock-related-navigation'));
    await flush();

    // The mocked draft still reads dirty after the save, as a real one does
    // until it renders again.
    expect(editor.save).toHaveBeenCalledTimes(1);
    expect(byTestId('workflows-unsaved-dialog')).toBeNull();
    expect(shownTarget()).toMatchObject({ pipelineId: 'other' });
  });

  // Sergii's QA (2026-10-23): text typed into the Pipeline Assistant but not
  // sent is unsaved work, on a saved pipeline and a new one alike.
  it('unsent assistant draft triggers the unsaved-changes dialog; Discard drops it', async () => {
    const editor = setMockEditor('review', { isDirty: false });
    mockAssistantDraft.present = true;
    renderShell(REVIEW);
    act(() => {
      useNavigationStore.getState().returnToSectionRoot('plugins');
    });

    expect(byTestId('workflows-unsaved-dialog')?.textContent).toContain(
      'Review',
    );
    expect(useNavigationStore.getState().activePage).toBe('workflows-library');

    click(byTestId('workflows-unsaved-discard'));
    await flush();
    expect(mockAssistantDraft.discard).toHaveBeenCalledTimes(1);
    expect(editor.save).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().activePage).toBe('plugins');
  });

  it('leaves without writing a clean pipeline when only the assistant draft is unsaved', async () => {
    const editor = setMockEditor('review', { isDirty: false });
    mockAssistantDraft.present = true;
    renderShell(REVIEW);
    navigateHome();
    click(byTestId('workflows-unsaved-save'));
    await flush();

    expect(editor.save).not.toHaveBeenCalled();
    expect(mockAssistantDraft.discard).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().activePage).toBe('home');
  });

  it('keeps the assistant draft when the prompt is closed', async () => {
    setMockEditor('review', { isDirty: false });
    mockAssistantDraft.present = true;
    renderShell(REVIEW);
    navigateHome();
    pressEscape();
    await flush();

    expect(mockAssistantDraft.discard).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().activePage).toBe('workflows-library');
  });

  it('stops guarding once the shell unmounts', () => {
    setMockEditor('review');
    renderShell(REVIEW);
    unmountShell();
    navigateHome();

    expect(useNavigationStore.getState().activePage).toBe('home');
  });
});
