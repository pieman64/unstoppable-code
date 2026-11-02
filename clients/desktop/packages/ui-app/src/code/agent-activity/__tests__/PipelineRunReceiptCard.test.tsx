/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PipelineRunArtifactReceiptV1 } from '@canopy/protocol/agent-artifacts';
import type { PipelineRunSummary } from '../../activity/pipeline/PipelineRunRows';
import {
  PipelineRunReceiptCard,
  type PipelineRunReceiptCardProps,
} from '../PipelineRunReceiptCard';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'CSS', {
  configurable: true,
  value: { escape: (value: string): string => value },
});
Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
  configurable: true,
  value: (): void => undefined,
});

const CREATED_AT = '2026-10-16T12:00:00.000Z';

const RECEIPT: PipelineRunArtifactReceiptV1 = {
  version: 1,
  kind: 'pipeline_run',
  operation: 'pipeline.run',
  dedupeKey: 'canopy:pipeline_run:local:e1',
  createdAt: CREATED_AT,
  executionId: 'e1',
  pipelineId: 'p1',
  pipelineName: 'Ship',
  initialStatus: 'running',
  queuedAt: CREATED_AT,
  projectId: 'proj',
  worktreeId: 'wt',
  navigationTarget: {
    kind: 'pipeline_execution',
    executionId: 'e1',
    projectId: 'proj',
    worktreeId: 'wt',
  },
};

function summary(
  overrides: Partial<PipelineRunSummary> & { id: string },
): PipelineRunSummary {
  return {
    pipeline_id: 'p1',
    pipeline_name: 'Ship',
    status: 'success',
    status_reasons: [],
    started_at: CREATED_AT,
    ...overrides,
  };
}

describe('PipelineRunReceiptCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(props: Partial<PipelineRunReceiptCardProps> = {}): void {
    act(() => {
      root.render(<PipelineRunReceiptCard receipt={RECEIPT} {...props} />);
    });
  }

  function byTestId(id: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${id}"]`);
  }

  it('renders the receipt snapshot with no host data', () => {
    render();
    const card = byTestId('pipeline-run-card-e1');
    expect(card?.textContent).toContain('Ship');
    expect(card?.textContent).toContain('running');
    expect(byTestId('pipeline-run-cancel-e1')).toBeNull();
  });

  it('offers Cancel on an active run when the host can cancel', () => {
    const onCancel = jest.fn();
    render({ actions: { onCancel } });
    const cancel = byTestId('pipeline-run-cancel-e1');
    expect(cancel?.textContent).toBe('Cancel');
    act(() => cancel?.click());
    expect(onCancel).toHaveBeenCalledWith('e1');
  });

  it('shows the pending cancel state', () => {
    render({
      actions: { onCancel: jest.fn() },
      pending: { cancellingId: 'e1' },
    });
    expect(byTestId('pipeline-run-cancel-e1')?.textContent).toBe('Cancelling…');
  });

  it('opens the run detail from the row', () => {
    const onOpenDetail = jest.fn();
    render({ actions: { onOpenDetail } });
    act(() => byTestId('pipeline-run-card-e1')?.click());
    expect(onOpenDetail).toHaveBeenCalledWith('e1', []);
  });

  it('ignores a row click when the host cannot open the detail', () => {
    render();
    expect(() =>
      act(() => byTestId('pipeline-run-card-e1')?.click()),
    ).not.toThrow();
  });

  it('expands and collapses sub-workflows on its own when uncontrolled', () => {
    const summaries = [
      summary({ id: 'e1', status: 'success' }),
      summary({
        id: 'child',
        pipeline_name: 'Child',
        parent_execution_id: 'e1',
      }),
    ];
    render({ summaries });
    const toggle = (): HTMLButtonElement | undefined =>
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('sub-workflow'),
      );
    expect(byTestId('pipeline-run-card-child')).toBeNull();
    act(() => toggle()?.click());
    expect(byTestId('pipeline-run-card-child')).not.toBeNull();
    act(() => toggle()?.click());
    expect(byTestId('pipeline-run-card-child')).toBeNull();
  });

  it('defers expansion to the host when controlled', () => {
    const onToggleExpand = jest.fn();
    const summaries = [
      summary({ id: 'e1', status: 'success' }),
      summary({ id: 'child', parent_execution_id: 'e1' }),
    ];
    render({ summaries, expandedIds: new Set(), onToggleExpand });
    const toggle = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('sub-workflow'),
    );
    act(() => toggle?.click());
    expect(onToggleExpand).toHaveBeenCalledWith('e1');
    expect(byTestId('pipeline-run-card-child')).toBeNull();
  });
});
