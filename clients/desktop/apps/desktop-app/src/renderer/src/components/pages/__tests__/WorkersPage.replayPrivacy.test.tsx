/**
 * @jest-environment jsdom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WorkerCardData } from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';
import { useWorkersStore } from '@/stores/workersStore';
import { WorkersPage } from '../WorkersPage';

jest.mock('@/components/terminal/TerminalPane', () => ({
  TerminalPane: (): ReactNode => (
    <div data-testid="mock-terminal">worker prompt output</div>
  ),
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
  label: 'Summarize the acquisition memo',
  status: 'running',
  terminalId: 'terminal-1',
  startedAt: Date.parse('2026-09-29T00:00:00.000Z'),
  pipelineExecutionId: 'pipeline-execution-1',
  stepId: 'draft-acquisition-reply',
  linkTarget: {
    page: 'main',
    kind: 'pipeline-execution',
    pipelineExecutionId: 'pipeline-execution-1',
  },
};

describe('WorkersPage session replay privacy', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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

  it('blocks the terminal', async () => {
    await act(async () => {
      root.render(<WorkersPage />);
      await Promise.resolve();
    });

    expect(
      container
        .querySelector('[data-testid="mock-terminal"]')
        ?.closest('.ph-no-capture') ?? null,
    ).not.toBeNull();
  });
});
