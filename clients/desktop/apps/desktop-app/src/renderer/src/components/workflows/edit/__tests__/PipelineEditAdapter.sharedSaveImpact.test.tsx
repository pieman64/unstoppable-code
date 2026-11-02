/**
 * @jest-environment jsdom
 *
 * CAN-3354, CAN-4072: saving a shared pipeline that this desktop knows pinned
 * automations use asks the publisher once, in one plain sentence, before the
 * save lands. No affected automations saves directly; an unknown impact
 * fails toward asking.
 */
import type { JSX } from 'react';
import type * as PipelineEditMocks from './pipelineEditMocks';

const mockRelatedNavigateContinuation = jest.fn();

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

import type {
  IPCResult,
  SharedPipelineSaveImpact,
} from '@canopy/desktop-shared/types/pipeline';
import { act } from 'react';
import { SHARED_PIPELINE_SAVE_IMPACT_MESSAGE } from '@/components/pipeline/usePipelineEditorSession';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  byTestId,
  click,
  flush,
  renderShell,
  unmountShell,
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

const SHARED = pipelineInfo({
  id: 'shared:canopy-cloud:remote-1',
  name: 'Bundled review',
  source: 'shared',
  remoteId: 'remote-1',
});

const TARGET = {
  kind: 'pipeline',
  pipelineId: SHARED.id,
  sharedRemoteId: 'remote-1',
} as const;

const getSharedUpdateImpact = jest.fn<
  Promise<IPCResult<SharedPipelineSaveImpact>>,
  [string]
>();

function sharedEditor(
  overrides: Parameters<typeof setMockEditor>[1] = {},
): ReturnType<typeof setMockEditor> {
  return setMockEditor(SHARED.id, { pipelineInfo: SHARED, ...overrides });
}

async function clickSave(): Promise<void> {
  click(byTestId('pipeline-save'));
  await flush();
}

beforeEach(() => {
  jest.clearAllMocks();
  resetMockEditors();
  Object.defineProperty(window, 'pipelines', {
    configurable: true,
    value: { getSharedUpdateImpact },
  });
});

afterEach(() => {
  unmountShell();
  useNavigationStore.setState({ workflowEdit: undefined });
});

describe('PipelineEditAdapter shared save impact confirm', () => {
  it('saves directly when no automations are affected', async () => {
    getSharedUpdateImpact.mockResolvedValue({
      success: true,
      data: { automations: [] },
    });
    const editor = sharedEditor();
    renderShell(TARGET);
    await clickSave();

    expect(getSharedUpdateImpact).toHaveBeenCalledWith('remote-1');
    expect(byTestId('shared-pipeline-save-impact-dialog')).toBeNull();
    expect(editor.save).toHaveBeenCalledTimes(1);
  });

  it('asks once in one plain sentence, then saves on confirm', async () => {
    getSharedUpdateImpact.mockResolvedValue({
      success: true,
      data: {
        automations: [
          { id: 'automation-1', name: 'Nightly checks', kind: 'installed' },
        ],
      },
    });
    const editor = sharedEditor();
    renderShell(TARGET);
    await clickSave();

    const dialog = byTestId('shared-pipeline-save-impact-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain(SHARED_PIPELINE_SAVE_IMPACT_MESSAGE);
    // The dialog names no automations and uses no technical terms.
    expect(dialog?.textContent).not.toContain('Nightly checks');
    expect(dialog?.textContent).not.toMatch(/pin|hash/i);
    expect(editor.save).not.toHaveBeenCalled();

    // A second save request while the dialog is open does not stack.
    await clickSave();
    expect(
      document.querySelectorAll(
        '[data-testid="shared-pipeline-save-impact-dialog"]',
      ),
    ).toHaveLength(1);

    click(byTestId('shared-pipeline-save-impact-confirm'));
    await flush();
    expect(byTestId('shared-pipeline-save-impact-dialog')).toBeNull();
    expect(editor.save).toHaveBeenCalledTimes(1);
  });

  it('coalesces save requests and resumes navigation after a pending impact query', async () => {
    let resolveImpact: (
      result: IPCResult<SharedPipelineSaveImpact>,
    ) => void = () => undefined;
    getSharedUpdateImpact.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveImpact = resolve;
        }),
    );
    const editor = sharedEditor({ activePanel: 'settings' });
    renderShell(TARGET);

    // The App Advisor save action and a related-pipeline link at once.
    act(() => {
      window.dispatchEvent(new Event('canopy:pipeline-save-active'));
    });
    await flush();
    click(byTestId('mock-related-navigation'));
    await flush();

    expect(getSharedUpdateImpact).toHaveBeenCalledTimes(1);
    expect(editor.save).not.toHaveBeenCalled();

    resolveImpact({
      success: true,
      data: {
        automations: [
          { id: 'automation-1', name: 'Nightly checks', kind: 'installed' },
        ],
      },
    });
    await flush();
    expect(byTestId('shared-pipeline-save-impact-dialog')).not.toBeNull();

    click(byTestId('shared-pipeline-save-impact-confirm'));
    await flush();
    expect(editor.save).toHaveBeenCalledTimes(1);
    expect(mockRelatedNavigateContinuation).toHaveBeenCalledWith(SHARED);
  });

  it('leaves the pipeline unsaved on cancel, with no error', async () => {
    getSharedUpdateImpact.mockResolvedValue({
      success: true,
      data: {
        automations: [
          { id: 'automation-1', name: 'Nightly checks', kind: 'shared' },
        ],
      },
    });
    const editor = sharedEditor();
    renderShell(TARGET);
    await clickSave();

    const cancel = Array.from(
      byTestId('shared-pipeline-save-impact-dialog')?.querySelectorAll(
        'button',
      ) ?? [],
    ).find((button) => button.firstChild?.textContent === 'Cancel');
    expect(cancel).toBeDefined();
    click(cancel);
    await flush();
    expect(byTestId('shared-pipeline-save-impact-dialog')).toBeNull();
    expect(editor.save).not.toHaveBeenCalled();
    expect(byTestId('workflow-edit-shell')?.dataset.dirty).toBe('true');
    expect(byTestId('pipeline-editor-save-error')).toBeNull();
  });

  it('asks when the impact cannot be determined', async () => {
    getSharedUpdateImpact.mockResolvedValue({
      success: false,
      error: 'Offline',
    });
    const editor = sharedEditor();
    renderShell(TARGET);
    await clickSave();

    expect(byTestId('shared-pipeline-save-impact-dialog')).not.toBeNull();
    expect(editor.save).not.toHaveBeenCalled();
  });
});
