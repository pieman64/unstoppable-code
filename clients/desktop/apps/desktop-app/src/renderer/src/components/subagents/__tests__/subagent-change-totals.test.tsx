/** @jest-environment jsdom */

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SubagentNode } from '@canopy/agent-transcript';
import type { SubagentChangeTotalsLookup } from '@canopy/ui-app/subagents';
import {
  readSubagentWorktreeSummary,
  type SubagentWorktreeSummaryReadResult,
} from '../subagent-commands';
import {
  resetSubagentChangeTotalsForTests,
  useSubagentChangeTotals,
} from '../subagent-change-totals';

jest.mock('../subagent-commands', () => ({
  readSubagentWorktreeSummary: jest.fn(),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const scope = { projectId: 'project-1', worktreeId: 'worktree-1' };
const options = {
  enabled: true,
  worktreeDetails: true,
  showWorkspaceDetails: true,
};

function summary(filesChanged: number): SubagentWorktreeSummaryReadResult {
  return {
    ok: true,
    summary: {
      checkout: 'retained',
      startingRevision: 'abc1234',
      filesChanged,
      additions: filesChanged * 10,
      deletions: 1,
      commitsAhead: 0,
      untrackedFiles: 0,
      applyState: 'not_applied',
      topFiles: [],
      truncated: false,
    },
  };
}

function node(generations: readonly number[]): SubagentNode {
  return {
    id: 'delegate-1',
    kind: 'managed',
    parentId: null,
    depth: 1,
    title: 'Delegate',
    status: 'completed',
    childIds: [],
    liveDescendantCount: 0,
    approvalPending: false,
    workspace: 'isolated',
    isolatedRevision: 'abc1234',
    runs: generations.map((runGeneration) => ({ runGeneration })),
  };
}

let lookup: SubagentChangeTotalsLookup | undefined;

function Probe({ selected }: { readonly selected: SubagentNode }): JSX.Element {
  lookup = useSubagentChangeTotals(scope, selected, options);
  return <div />;
}

describe('useSubagentChangeTotals', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetSubagentChangeTotalsForTests();
    jest.mocked(readSubagentWorktreeSummary).mockReset();
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it('reads the totals again when a follow-up run settles with the same status', async () => {
    jest
      .mocked(readSubagentWorktreeSummary)
      .mockResolvedValueOnce(summary(1))
      .mockResolvedValueOnce(summary(4));
    const firstRun = node([1]);
    const followUp = node([1, 2]);

    await act(async () => {
      root.render(<Probe selected={firstRun} />);
      await Promise.resolve();
    });
    expect(lookup?.(firstRun)?.filesChanged).toBe(1);

    await act(async () => {
      root.render(<Probe selected={followUp} />);
      await Promise.resolve();
    });

    expect(readSubagentWorktreeSummary).toHaveBeenCalledTimes(2);
    expect(lookup?.(followUp)?.filesChanged).toBe(4);
  });
});
