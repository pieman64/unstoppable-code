/**
 * @jest-environment jsdom
 *
 * The flow diagram fits its container, not just the size it first rendered
 * at: it fits again whenever React Flow reports a new size (a panel resized,
 * its job list collapsed), never on a same-size run update (so a user's own
 * zoom survives live runs), and every fit reserves the zoom controls' column
 * so no node sits under them.
 */
import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ExecutionState } from '@canopy/desktop-shared/types/pipeline';

const mockFitView = jest.fn((): Promise<boolean> => Promise.resolve(true));
const mockFlow = { width: 0, height: 0 };

interface MockFitViewProps {
  children?: ReactNode;
  fitViewOptions?: { padding?: unknown };
}

jest.mock('@xyflow/react', () => ({
  ReactFlow: ({ children, fitViewOptions }: MockFitViewProps): JSX.Element => (
    <div
      data-testid="flow"
      data-fit-padding={JSON.stringify(fitViewOptions?.padding)}
    >
      {children}
    </div>
  ),
  Background: (): null => null,
  Controls: ({ fitViewOptions }: MockFitViewProps): JSX.Element => (
    <div
      data-testid="flow-controls"
      data-fit-padding={JSON.stringify(fitViewOptions?.padding)}
    />
  ),
  Handle: (): null => null,
  Position: { Top: 'top', Bottom: 'bottom' },
  useStore: <T,>(
    selector: (state: { width: number; height: number }) => T,
  ): T => selector({ width: mockFlow.width, height: mockFlow.height }),
  useReactFlow: (): { fitView: typeof mockFitView } => ({
    fitView: mockFitView,
  }),
}));

// The fit behavior lives in the view; the lazy wrapper is covered by
// PipelineFlowDiagram.lazy.test.tsx.
import { PipelineFlowDiagram } from '../flow/PipelineFlowDiagramView';

/** Top, right, and bottom insets, plus the controls' column on the left. */
const FIT_VIEW_OPTIONS = {
  padding: { top: '16px', right: '16px', bottom: '16px', left: '56px' },
};

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function runState(status: ExecutionState['status']): ExecutionState {
  return {
    version: 8,
    id: 'exec-1',
    pipeline_id: 'pipeline-1',
    pipeline_snapshot: {
      name: 'Release check',
      jobs: {
        build: {
          name: 'Build',
          needs: [],
          timeout_minutes: 60,
          max_retries: 0,
          continue_on_error: false,
          steps: [],
        },
      },
    },
    status,
    jobs: {},
    job_definitions: {},
    job_groups: {},
    pending_pauses: [],
    status_reasons: [],
    started_at: '2026-09-29T21:02:02.000Z',
    cwd: '/repo',
    env: {},
    inputs: {},
    event_name: 'manual',
  };
}

describe('PipelineFlowDiagram', () => {
  let container: HTMLDivElement;
  let root: Root;

  function render(state: ExecutionState): void {
    act(() => {
      root.render(
        <PipelineFlowDiagram
          source={{ kind: 'execution', state, jobOrder: ['build'] }}
        />,
      );
    });
  }

  beforeEach(() => {
    mockFitView.mockClear();
    mockFlow.width = 0;
    mockFlow.height = 0;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('reserves the zoom controls’ column in every fit', () => {
    render(runState('running'));
    const padding = JSON.stringify(FIT_VIEW_OPTIONS.padding);
    // The initial fit and the fit-view control use the same reservation.
    expect(
      container
        .querySelector('[data-testid="flow"]')
        ?.getAttribute('data-fit-padding'),
    ).toBe(padding);
    expect(
      container
        .querySelector('[data-testid="flow-controls"]')
        ?.getAttribute('data-fit-padding'),
    ).toBe(padding);
  });

  it('fits again when its size changes, and only then', () => {
    // Not yet laid out: nothing to fit.
    render(runState('running'));
    expect(mockFitView).not.toHaveBeenCalled();

    // Measured (React Flow applies a queued fit once nodes are measured).
    mockFlow.width = 245;
    mockFlow.height = 320;
    render(runState('running'));
    expect(mockFitView).toHaveBeenCalledTimes(1);
    expect(mockFitView).toHaveBeenLastCalledWith(FIT_VIEW_OPTIONS);

    // A live update at the same size keeps the user's viewport.
    render(runState('success'));
    expect(mockFitView).toHaveBeenCalledTimes(1);

    // The job list collapsed: the diagram widened.
    mockFlow.width = 496;
    render(runState('success'));
    expect(mockFitView).toHaveBeenCalledTimes(2);

    // Hidden (0 x 0), then shown again at the same size: no refit needed.
    mockFlow.width = 0;
    mockFlow.height = 0;
    render(runState('success'));
    mockFlow.width = 496;
    mockFlow.height = 320;
    render(runState('success'));
    expect(mockFitView).toHaveBeenCalledTimes(2);
  });
});
