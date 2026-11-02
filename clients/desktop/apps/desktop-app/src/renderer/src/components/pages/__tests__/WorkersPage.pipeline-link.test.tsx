/**
 * @jest-environment jsdom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WorkerCardData } from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';
import { useWorkersStore } from '@/stores/workersStore';
import { WorkersPage } from '../WorkersPage';

const openPipelineExecutionFromUi = jest.fn<
  Promise<{ status: string }>,
  [request: unknown]
>(() => Promise.resolve({ status: 'applied' }));

jest.mock('@/lib/panels/open-pipeline-execution', () => ({
  openPipelineExecutionFromUi: (request: unknown): Promise<unknown> =>
    openPipelineExecutionFromUi(request),
}));
jest.mock('@/components/terminal/TerminalPane', () => ({
  TerminalPane: (): ReactNode => null,
}));
jest.mock('@canopy/ui-app/terminal', () => ({
  TERMINAL_BG_COLOR: '#000000',
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const worker: WorkerCardData = {
  workerId: 'worker-1',
  kind: 'pipeline_agent_prompt',
  label: 'Pipeline agent prompt',
  status: 'success',
  terminalId: 'terminal-1',
  startedAt: Date.parse('2026-09-29T00:00:00.000Z'),
  projectId: 'standalone-chat',
  worktreeId: 'cowork-workspace',
  pipelineExecutionId: 'child-run-1',
  linkTarget: {
    page: 'main',
    kind: 'pipeline-execution',
    pipelineExecutionId: 'child-run-1',
  },
};

describe('WorkersPage pipeline Inspect', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    openPipelineExecutionFromUi.mockClear();
    useWorkersStore.setState({
      workers: new Map([[worker.workerId, worker]]),
      initialize: jest.fn(() => Promise.resolve()),
    });
    useChatStore.setState({ selectedWorktree: null });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("opens the worker's run from the run's own owner, never selecting a worktree", async () => {
    await act(async () => {
      root.render(<WorkersPage />);
      await Promise.resolve();
    });

    const inspect = container.querySelector<HTMLButtonElement>(
      '[data-testid="worker-inspect-worker-1"]',
    );
    expect(inspect).not.toBeNull();
    await act(async () => {
      inspect?.click();
      await Promise.resolve();
    });

    // The worker's scope (here the legacy Cowork shape) is not an owner hint;
    // the child run opens as its own panel.
    expect(openPipelineExecutionFromUi).toHaveBeenCalledWith({
      executionId: 'child-run-1',
    });
    expect(useChatStore.getState().selectedWorktree).toBeNull();
  });
});
