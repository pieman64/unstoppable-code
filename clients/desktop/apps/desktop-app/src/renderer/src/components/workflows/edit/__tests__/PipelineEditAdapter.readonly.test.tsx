/**
 * @jest-environment jsdom
 *
 * CAN-4072: a read-only pipeline in the edit shell shows its definition as
 * Details or Flow, and Duplicate is the header's primary action. The copy
 * opens editable in its place.
 */
import type { JSX } from 'react';
import type * as PipelineEditMocks from './pipelineEditMocks';

const mockCurrentUiStateReporter = jest.fn();

jest.mock('@/hooks/usePipelineEditor', () => ({
  usePipelineEditor: (target: {
    pipelineId: string | null;
  }): ReturnType<typeof PipelineEditMocks.useMockPipelineEditor> =>
    jest
      .requireActual<typeof PipelineEditMocks>('./pipelineEditMocks')
      .useMockPipelineEditor(target),
}));
jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (slice: string, state: unknown): void => {
    mockCurrentUiStateReporter(slice, state);
  },
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
    openDispatchPipelineModal: jest.Mock;
    dispatchPipelineModal: null;
  } => ({ openDispatchPipelineModal: jest.fn(), dispatchPipelineModal: null }),
}));
jest.mock('@/components/pipeline/flow/PipelineFlowDiagram', () => ({
  PipelineFlowDiagram: (): JSX.Element => (
    <div data-testid="mock-pipeline-flow-diagram" />
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

import type { PipelineInfo } from '@canopy/desktop-shared/types/pipeline';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  byTestId,
  click,
  flush,
  pipelinesApi,
  renderShell,
  shownTarget,
  unmountShell,
} from './pipelineEditHarness';
import {
  pipelineEditorMock,
  pipelineInfo,
  resetMockEditors,
  setMockEditor,
} from './pipelineEditMocks';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const BUNDLED = pipelineInfo({
  id: 'bundled-review',
  name: 'Bundled review',
  source: 'bundled',
  readonly: true,
});

function setBundledEditor(): void {
  setMockEditor('bundled-review', {
    pipelineInfo: BUNDLED,
    pipeline: {
      name: 'Bundled review',
      description: 'Review a change.',
      version: '1',
      on: 'dispatch',
      jobs: {
        review: {
          steps: [{ id: 'review-step', uses: 'builtin/agent-prompt' }],
        },
      },
    },
    readonly: true,
    canSave: false,
    isDirty: false,
  });
}

const TARGET = {
  kind: 'pipeline',
  pipelineId: 'bundled-review',
  source: 'bundled',
} as const;

beforeEach(() => {
  jest.clearAllMocks();
  resetMockEditors();
  setBundledEditor();
});

afterEach(() => {
  unmountShell();
  useNavigationStore.setState({ workflowEdit: undefined });
});

describe('PipelineEditAdapter read-only pipeline', () => {
  it('defaults to Details and toggles to the inert flow view', () => {
    renderShell(TARGET);

    expect(byTestId('workflow-edit-shell')?.dataset.readonly).toBe('true');
    expect(byTestId('workflow-edit-save-state')?.textContent).toBe('Read-only');
    expect(byTestId('pipeline-editor-back')).not.toBeNull();
    expect(byTestId('pipeline-read-detail')).not.toBeNull();
    expect(byTestId('pipeline-read-detail-job')?.textContent).toContain(
      'review',
    );
    expect(mockCurrentUiStateReporter).toHaveBeenLastCalledWith(
      'workflows.editShell',
      expect.objectContaining({ readonly: true, section: 'definition' }),
    );
    expect(mockCurrentUiStateReporter).toHaveBeenCalledWith(
      'pipelines.activeEditor',
      expect.objectContaining({ readonly: true, activeView: 'details' }),
    );
    expect(byTestId('pipeline-mode-flow')).not.toBeNull();
    expect(byTestId('pipeline-mode-details')).not.toBeNull();
    expect(byTestId('pipeline-mode-visual')).toBeNull();
    expect(byTestId('pipeline-mode-raw')).toBeNull();

    click(byTestId('pipeline-mode-flow'));
    expect(byTestId('pipeline-read-detail')).toBeNull();
    expect(byTestId('pipeline-read-flow')).not.toBeNull();
    expect(byTestId('mock-pipeline-flow-diagram')).not.toBeNull();
    expect(mockCurrentUiStateReporter).toHaveBeenCalledWith(
      'pipelines.activeEditor',
      expect.objectContaining({ readonly: true, activeView: 'flow' }),
    );

    click(byTestId('pipeline-mode-details'));
    expect(byTestId('pipeline-read-detail')).not.toBeNull();
    expect(byTestId('pipeline-read-flow')).toBeNull();
  });

  it('offers Duplicate as the only header action', () => {
    renderShell(TARGET);

    const duplicates = document.querySelectorAll(
      '[data-testid="pipeline-editor-duplicate"]',
    );
    // In the header only: the read-only notice no longer carries one.
    expect(duplicates).toHaveLength(1);
    expect(
      byTestId('workflow-edit-actions')?.contains(duplicates[0] ?? null),
    ).toBe(true);
    expect(duplicates[0]?.textContent).toBe('Duplicate');
    expect(byTestId('pipeline-save')).toBeNull();
    expect(byTestId('pipeline-editor-delete')).toBeNull();
    expect(byTestId('pipeline-editor-enabled')).toBeNull();
    expect(byTestId('workflow-edit-run')).toBeNull();
    expect(document.body.textContent).toContain(
      'Duplicate it to make changes.',
    );
  });

  it('shows definition errors but suppresses warnings', () => {
    setMockEditor('bundled-review', {
      pipelineInfo: BUNDLED,
      readonly: true,
      canSave: false,
      isDirty: false,
      validation: [
        {
          type: 'error',
          path: 'jobs.review.needs',
          message: 'Unknown dependency "missing".',
        },
        {
          type: 'warning',
          path: 'jobs.review.steps[0].with.model',
          message: 'Model aliases are resolved at runtime.',
        },
      ],
    });
    renderShell(TARGET);

    const text = document.body.textContent ?? '';
    expect(text).toContain('jobs.review.needs:');
    expect(text).toContain('Unknown dependency "missing".');
    expect(text).not.toContain('Model aliases are resolved at runtime.');
  });

  it('opens the copy, editable, in place of the original', async () => {
    const copy = pipelineInfo({ id: 'bundled-review-copy', name: 'Copy' });
    setMockEditor('bundled-review-copy', {
      pipelineInfo: copy,
      isDirty: false,
    });
    const openDuplicate = jest.fn<Promise<void>, [PipelineInfo]>(() => {
      // What `PipelinesPage.openDuplicate` does once the copy is made.
      useNavigationStore.getState().replaceWorkflowEdit({
        kind: 'pipeline',
        pipelineId: copy.id,
        source: 'user',
      });
      return Promise.resolve();
    });
    renderShell(TARGET, { pipelines: pipelinesApi({ openDuplicate }) });

    click(byTestId('pipeline-editor-duplicate'));
    await flush();

    expect(openDuplicate).toHaveBeenCalledWith(BUNDLED);
    expect(shownTarget()).toMatchObject({
      pipelineId: 'bundled-review-copy',
      source: 'user',
    });
    expect(pipelineEditorMock.targets.at(-1)).toMatchObject({
      pipelineId: 'bundled-review-copy',
    });
    expect(byTestId('workflow-edit-shell')?.dataset.readonly).toBe('false');
    expect(byTestId('pipeline-save')).not.toBeNull();
    // The user's own copy has nothing to duplicate from.
    expect(byTestId('pipeline-editor-duplicate')).toBeNull();
    expect(byTestId('workflows-unsaved-dialog')).toBeNull();
  });

  it('reports a failed Duplicate and lets it be tried again', async () => {
    const openDuplicate = jest
      .fn<Promise<void>, [PipelineInfo]>()
      .mockRejectedValue(new Error('The pipeline could not be duplicated.'));
    renderShell(TARGET, { pipelines: pipelinesApi({ openDuplicate }) });

    click(byTestId('pipeline-editor-duplicate'));
    await flush();

    expect(byTestId('pipeline-editor-duplicate-error')?.textContent).toContain(
      'The pipeline could not be duplicated.',
    );
    expect(shownTarget()).toMatchObject({ pipelineId: 'bundled-review' });
    const duplicate = byTestId('pipeline-editor-duplicate');
    expect(duplicate?.hasAttribute('disabled')).toBe(false);
    expect(duplicate?.getAttribute('aria-disabled')).toBeNull();
  });
});
