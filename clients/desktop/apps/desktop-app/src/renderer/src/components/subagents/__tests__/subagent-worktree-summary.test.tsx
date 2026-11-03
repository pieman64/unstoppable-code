/** @jest-environment jsdom */

import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type { SubagentNode } from '@canopy/agent-transcript';
import type { SubagentViewerCapabilities } from '@canopy/ui-app/subagents';
import { readSubagentWorktreeSummary } from '../subagent-commands';
import {
  useSubagentWorktreeSummary,
  type SubagentWorktreeSummaryResult,
} from '../useSubagentWorktreeSummary';

jest.mock('../subagent-commands', () => ({
  readSubagentWorktreeSummary: jest.fn(),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const scope = { projectId: 'project-1', worktreeId: 'worktree-1' };
const capabilities: SubagentViewerCapabilities = {
  stop: true,
  messaging: true,
  worktreeDetails: true,
  nativeInterrupt: true,
  openWorkflow: true,
  stopWorkflow: true,
};
const summary = {
  checkout: 'retained' as const,
  startingRevision: 'abc1234',
  filesChanged: 2,
  additions: 10,
  deletions: 3,
  commitsAhead: 1,
  untrackedFiles: 0,
  applyState: 'not_applied' as const,
  topFiles: [],
  truncated: false,
};

function node(
  status: SubagentNode['status'] = 'running',
  workspaceDiscarded = false,
): SubagentNode {
  return {
    id: 'delegate-1',
    kind: 'managed',
    parentId: null,
    depth: 1,
    title: 'Delegate',
    status,
    childIds: [],
    liveDescendantCount: 0,
    approvalPending: false,
    workspace: 'isolated',
    isolatedRevision: 'abc1234',
    workspaceDiscarded,
    runs: [{ runGeneration: 1, agentBlockId: 'run-1' }],
  };
}

interface ProbeProps {
  readonly selectedNode: SubagentNode;
  readonly expanded: boolean;
  readonly viewerCapabilities?: SubagentViewerCapabilities;
  readonly onResult: (result: SubagentWorktreeSummaryResult) => void;
}

function Probe({
  selectedNode,
  expanded,
  viewerCapabilities = capabilities,
  onResult,
}: ProbeProps): JSX.Element {
  const result = useSubagentWorktreeSummary(
    scope,
    selectedNode,
    expanded,
    viewerCapabilities,
  );
  onResult(result);
  return (
    <div data-testid="worktree-state">
      {result.state?.status ?? 'closed'}
      {result.state?.status === 'ready'
        ? `:${result.changeTotals?.filesChanged}`
        : ''}
      {result.state?.status === 'error' && result.state.onRetry ? (
        <button type="button" onClick={result.state.onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

describe('useSubagentWorktreeSummary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads the summary again after a follow-up run with the same status', async () => {
    jest.mocked(readSubagentWorktreeSummary).mockResolvedValue({
      ok: true,
      summary,
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    const onResult = jest.fn<void, [SubagentWorktreeSummaryResult]>();
    const firstRun = node('completed');

    await act(async () => {
      root.render(
        <Probe selectedNode={firstRun} expanded onResult={onResult} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(readSubagentWorktreeSummary).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <Probe
          selectedNode={{
            ...firstRun,
            runs: [...firstRun.runs, { runGeneration: 2 }],
          }}
          expanded
          onResult={onResult}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(readSubagentWorktreeSummary).toHaveBeenCalledTimes(2);
    act((): void => root.unmount());
  });

  it('reads only while details are open and refreshes when status changes', async () => {
    jest.mocked(readSubagentWorktreeSummary).mockResolvedValue({
      ok: true,
      summary,
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    const onResult = jest.fn<void, [SubagentWorktreeSummaryResult]>();

    await act(async () => {
      root.render(
        <Probe selectedNode={node()} expanded={false} onResult={onResult} />,
      );
      await Promise.resolve();
    });
    expect(readSubagentWorktreeSummary).not.toHaveBeenCalled();

    await act(async () => {
      root.render(<Probe selectedNode={node()} expanded onResult={onResult} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(readSubagentWorktreeSummary).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('ready:2');
    expect(onResult.mock.calls.at(-1)?.[0].changeTotals).toEqual({
      filesChanged: 2,
      additions: 10,
      deletions: 3,
    });

    await act(async () => {
      root.render(
        <Probe selectedNode={node('completed')} expanded onResult={onResult} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(readSubagentWorktreeSummary).toHaveBeenCalledTimes(2);
    act((): void => root.unmount());
  });

  it('returns unavailable states without reading unsupported or discarded worktrees', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onResult = jest.fn<void, [SubagentWorktreeSummaryResult]>();

    await act(async () => {
      root.render(
        <Probe
          selectedNode={node()}
          expanded
          viewerCapabilities={{ ...capabilities, worktreeDetails: false }}
          onResult={onResult}
        />,
      );
      await Promise.resolve();
    });
    expect(container.textContent).toContain('unavailable');
    expect(readSubagentWorktreeSummary).not.toHaveBeenCalled();

    await act(async () => {
      root.render(
        <Probe
          selectedNode={node('completed', true)}
          expanded
          onResult={onResult}
        />,
      );
      await Promise.resolve();
    });
    expect(container.textContent).toContain('unavailable');
    expect(readSubagentWorktreeSummary).not.toHaveBeenCalled();
    act((): void => root.unmount());
  });

  it('exposes retry after a read error', async () => {
    jest.mocked(readSubagentWorktreeSummary).mockResolvedValue({
      ok: false,
      error: 'Checkout is unavailable.',
    });
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <Probe selectedNode={node()} expanded onResult={(): void => {}} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('error');
    const retry = container.querySelector<HTMLButtonElement>('button');
    if (!retry) throw new Error('retry action was not rendered');

    await act(async () => {
      retry.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(readSubagentWorktreeSummary).toHaveBeenCalledTimes(2);
    act((): void => root.unmount());
  });
});
