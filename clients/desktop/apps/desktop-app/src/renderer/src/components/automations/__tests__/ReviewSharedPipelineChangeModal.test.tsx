/**
 * @jest-environment jsdom
 *
 * CAN-3354: recipient review for a shared pipeline whose publisher saved a new
 * version. Uses the repo's createRoot + act jsdom convention.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ApproveAutomationSharedPipelineReviewRequest,
  ApproveAutomationSharedPipelineReviewResponse,
  ResolveAutomationSharedPipelinePinRequest,
  ResolvedAutomationSharedPipelinePin,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import { ReviewSharedPipelineChangeModal } from '../ReviewSharedPipelineChangeModal';
import { useAutomationsStore } from '@/stores/automationsStore';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
  writable: true,
});

const resolvePin = jest.fn<
  Promise<ResolvedAutomationSharedPipelinePin>,
  [ResolveAutomationSharedPipelinePinRequest]
>();
const approve = jest.fn<
  Promise<ApproveAutomationSharedPipelineReviewResponse>,
  [ApproveAutomationSharedPipelineReviewRequest]
>();

const PIN_V2 = {
  pipelineContentHash: 'b'.repeat(64),
  distributionMode: 'self_contained' as const,
};
const PIN_V3 = {
  pipelineContentHash: 'c'.repeat(64),
  distributionMode: 'self_contained' as const,
};

let root: Root | null = null;

function activityFixture(): ScheduledActivity {
  return {
    version: 1,
    id: 'activity-1',
    name: 'Nightly checks',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
    action: {
      type: 'worktree_pipeline',
      workspaceId: 'workspace-1',
      pipelineId: 'shared:canopy-cloud:remote-1',
      pipelineName: 'Lint and test',
      pipelineSource: 'shared',
      sharedPipeline: {
        serverId: 'canopy-cloud',
        remoteId: 'remote-1',
        installPin: {
          pipelineContentHash: 'a'.repeat(64),
          distributionMode: 'self_contained',
        },
      },
    },
    sharedPipelineReview: {
      detectedAt: '2026-09-11T02:00:01.000Z',
      remoteId: 'remote-1',
      pipelineName: 'Lint and test',
    },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    failureCount: 1,
  };
}

function byTestId(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function isDisabled(testId: string): boolean {
  const element = byTestId(testId);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`expected button ${testId}`);
  }
  return element.disabled;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function click(element: HTMLElement | null): Promise<void> {
  if (!element) throw new Error('expected element');
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

function render(
  props: Partial<Parameters<typeof ReviewSharedPipelineChangeModal>[0]> = {},
): { onClose: jest.Mock; onApproved: jest.Mock } {
  const onClose = jest.fn();
  const onApproved = jest.fn();
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(ReviewSharedPipelineChangeModal, {
        activity: activityFixture(),
        onClose,
        onApproved,
        ...props,
      }),
    );
  });
  return { onClose, onApproved };
}

beforeEach(() => {
  jest.clearAllMocks();
  resolvePin.mockResolvedValue({
    installPin: PIN_V2,
    rawPipeline: 'name: Lint and test\njobs:\n  lint: {}\n',
  });
  approve.mockResolvedValue({ ok: true, activity: activityFixture() });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      automations: {
        resolveSharedPipelineInstallPin: resolvePin,
        approveSharedPipelineReview: approve,
      },
    },
  });
  useAutomationsStore.setState({ mutationError: null });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = '';
});

describe('ReviewSharedPipelineChangeModal', () => {
  it('previews the current version with calm, non-technical copy', async () => {
    render();
    await settle();

    expect(resolvePin).toHaveBeenCalledWith({ remoteId: 'remote-1' });
    expect(byTestId('shared-pipeline-review-name')?.textContent).toBe(
      'Lint and test',
    );
    const modalText = byTestId('shared-pipeline-review-modal')?.textContent;
    expect(modalText).toContain(
      'This pipeline was updated. Take a look and approve it to keep your automation running.',
    );
    expect(modalText).not.toMatch(/pin|hash|could not be verified/i);
    expect(byTestId('shared-pipeline-review-yaml')?.textContent).toContain(
      'jobs:',
    );
    expect(byTestId('shared-pipeline-review-footer-separator')).not.toBeNull();
  });

  it('keeps approval disabled until the preview loads', () => {
    resolvePin.mockReturnValue(new Promise(() => undefined));
    render();
    expect(isDisabled('shared-pipeline-review-approve')).toBe(true);
    expect(byTestId('shared-pipeline-review-yaml')).toBeNull();
  });

  it('approves the exact previewed pin without running', async () => {
    const { onClose, onApproved } = render();
    await settle();
    await click(byTestId('shared-pipeline-review-approve'));

    expect(approve).toHaveBeenCalledWith({
      id: 'activity-1',
      installPin: PIN_V2,
    });
    expect(onApproved).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('approves and runs when asked', async () => {
    render();
    await settle();
    await click(byTestId('shared-pipeline-review-approve-run'));

    expect(approve).toHaveBeenCalledWith({
      id: 'activity-1',
      installPin: PIN_V2,
      runNow: true,
    });
  });

  it('keeps an approved-but-not-run outcome visible in the modal', async () => {
    approve.mockResolvedValueOnce({
      ok: true,
      activity: activityFixture(),
      runError: 'Target is busy.',
    });
    const { onClose, onApproved } = render();
    await settle();
    await click(byTestId('shared-pipeline-review-approve-run'));

    expect(onApproved).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(
      byTestId('shared-pipeline-review-approved-run-error')?.textContent,
    ).toBe(
      'Pipeline approved, but the automation could not run: Target is busy.',
    );
    expect(byTestId('shared-pipeline-review-approve-run')).toBeNull();
    await click(byTestId('shared-pipeline-review-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('stays open and reloads the preview when the pipeline changed again', async () => {
    approve.mockResolvedValueOnce({
      ok: false,
      error: 'This pipeline was updated again, so take another look.',
    });
    const { onClose } = render();
    await settle();
    resolvePin.mockResolvedValueOnce({
      installPin: PIN_V3,
      rawPipeline: 'name: Lint and test\njobs:\n  test: {}\n',
    });
    await click(byTestId('shared-pipeline-review-approve'));

    expect(onClose).not.toHaveBeenCalled();
    expect(byTestId('shared-pipeline-review-error')?.textContent).toBe(
      'This pipeline was updated again, so take another look.',
    );
    expect(resolvePin).toHaveBeenCalledTimes(2);
    expect(byTestId('shared-pipeline-review-yaml')?.textContent).toContain(
      'test: {}',
    );

    await click(byTestId('shared-pipeline-review-approve'));
    expect(approve).toHaveBeenLastCalledWith({
      id: 'activity-1',
      installPin: PIN_V3,
    });
    // The modal reports failures inline, never through the page banner.
    expect(useAutomationsStore.getState().mutationError).toBeNull();
  });

  it('shows a load error and keeps approval disabled', async () => {
    resolvePin.mockRejectedValueOnce(new Error('Could not reach the server.'));
    render();
    await settle();
    expect(byTestId('shared-pipeline-review-load-error')?.textContent).toBe(
      'Could not reach the server.',
    );
    expect(isDisabled('shared-pipeline-review-approve-run')).toBe(true);
  });
});
