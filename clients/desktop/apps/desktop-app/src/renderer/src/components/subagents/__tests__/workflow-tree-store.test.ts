/** @jest-environment jsdom */

import { buildSubagentTree } from '@canopy/agent-transcript';
import type {
  ActivityReadWorkflowRunRequest,
  WorkflowRunState,
} from '@canopy/desktop-shared/types';
import type { ChatMessage } from '@/stores/chatStore';
import { useActivityStore } from '@/stores/activityStore';
import {
  acquireSubagentTree,
  getSubagentTreeSnapshot,
  resetSubagentTreeStoreForTests,
  subscribeSubagentTree,
  updateSubagentTreeRootChat,
} from '../subagent-tree-store';
import {
  buildDesktopSubagentTreeInput,
  subagentTreeInputFingerprint,
} from '../subagent-tree-input';
import type { LoadedSubagentInputs } from '@canopy/agent-transcript/lib/subagent-tree/native-inputs';
import { resetWorkflowRunCacheForTests } from '../workflow-run-cache';
import type { SubagentHostScope } from '../subagent-scope';

const NOW = 1_800_000_000_000;
const SCOPE: SubagentHostScope = {
  projectId: 'workflow-project',
  worktreeId: 'workflow-worktree',
};
const ROOT_ID = 'workflow-root';
const TRANSCRIPT_DIR = '/private/session/workflows/wf_1';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = (): void => {};
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function workflowMessages(): readonly ChatMessage[] {
  return [
    {
      id: 'workflow-call',
      role: 'assistant',
      timestamp: NOW - 10_000,
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'workflow-tool',
          toolName: 'Workflow',
          input: JSON.stringify({
            script: "export const meta = { name: 'Tree workflow' }",
          }),
        },
      ],
    },
    {
      id: 'workflow-receipt',
      role: 'assistant',
      timestamp: NOW - 9_000,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'workflow-tool',
          toolName: 'Workflow',
          output: `Workflow launched in background. Task ID: task-wf-1\nSummary: Build the feature\nTranscript dir: ${TRANSCRIPT_DIR}\nScript file: /private/script.js\nRun ID: wf_1`,
          isError: false,
        },
      ],
    },
  ];
}

function runState(status: string): WorkflowRunState {
  return {
    runId: 'wf_1',
    status,
    workflowName: 'Tree workflow',
    startedAt: NOW - 9_000,
    lastActivityAt: NOW,
    phases: [{ title: 'Build', detail: 'Private phase detail' }],
    agents: [
      {
        index: 0,
        label: 'Implementer',
        phaseIndex: 0,
        phaseTitle: 'Build',
        agentId: 'agent_7',
        agentType: 'worker',
        state: status === 'completed' ? 'done' : 'running',
        startedAt: NOW - 8_000,
        settledAt: status === 'completed' ? NOW - 1_000 : undefined,
      },
    ],
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function updateRootChat(messages: readonly ChatMessage[] | null): void {
  updateSubagentTreeRootChat(SCOPE, ROOT_ID, {
    hydrated: true,
    rootChatOpen: true,
    title: 'Workflow root',
    messages,
  });
}

type ReadWorkflowRun = (
  request: ActivityReadWorkflowRunRequest,
) => Promise<WorkflowRunState | null>;

let readWorkflowRun: jest.MockedFunction<ReadWorkflowRun>;
let treeRead: jest.Mock;

function installApi(): void {
  treeRead = jest.fn(() => Promise.resolve({ ok: true, entries: [] }));
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      managedDelegation: { tree: treeRead },
      activity: { readWorkflowRun },
    },
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  resetSubagentTreeStoreForTests();
  resetWorkflowRunCacheForTests();
  useActivityStore.setState({ bgProcesses: {} });
  readWorkflowRun = jest.fn<
    Promise<WorkflowRunState | null>,
    [request: ActivityReadWorkflowRunRequest]
  >(() => Promise.resolve(null));
  installApi();
});

afterEach(() => {
  resetSubagentTreeStoreForTests();
  resetWorkflowRunCacheForTests();
  useActivityStore.setState({ bgProcesses: {} });
  jest.useRealTimers();
});

describe('workflow runs in the desktop subagent tree store', () => {
  it('keeps a run out of the tree until its first read resolves', async () => {
    const pending = deferred<WorkflowRunState | null>();
    readWorkflowRun.mockReturnValue(pending.promise);
    const release = acquireSubagentTree(SCOPE, ROOT_ID);
    updateRootChat(workflowMessages());

    await flushPromises();
    expect(readWorkflowRun).toHaveBeenCalledTimes(1);
    expect(
      getSubagentTreeSnapshot(SCOPE, ROOT_ID).tree?.nodes.has(
        'workflow-run:wf_1',
      ),
    ).toBe(false);

    pending.resolve(runState('running'));
    await flushPromises();

    expect(
      getSubagentTreeSnapshot(SCOPE, ROOT_ID).tree?.nodes.has(
        'workflow-run:wf_1',
      ),
    ).toBe(true);
    release();
  });

  it('reports the tree as loading until its first workflow reads settle', async () => {
    const pending = deferred<WorkflowRunState | null>();
    readWorkflowRun.mockReturnValue(pending.promise);
    const release = acquireSubagentTree(SCOPE, ROOT_ID);
    updateRootChat(workflowMessages());

    await flushPromises();
    // The managed read has settled, but the run is still unknown: a saved
    // focus on it must not be treated as gone.
    expect(treeRead).toHaveBeenCalled();
    expect(getSubagentTreeSnapshot(SCOPE, ROOT_ID).treeState.status).toBe(
      'loading',
    );

    pending.resolve(runState('running'));
    await flushPromises();
    expect(getSubagentTreeSnapshot(SCOPE, ROOT_ID).treeState.status).toBe(
      'ready',
    );
    release();
  });

  it('publishes finished runs only as completed, with phases and safe agents', async () => {
    readWorkflowRun.mockResolvedValue(runState('completed'));
    const publishedTrees: NonNullable<
      ReturnType<typeof getSubagentTreeSnapshot>['tree']
    >[] = [];
    const unsubscribe = subscribeSubagentTree(SCOPE, ROOT_ID, () => {
      const tree = getSubagentTreeSnapshot(SCOPE, ROOT_ID).tree;
      if (tree) publishedTrees.push(tree);
    });
    const release = acquireSubagentTree(SCOPE, ROOT_ID);
    updateRootChat(workflowMessages());
    await flushPromises();

    const runNodes = publishedTrees.flatMap((tree) =>
      Array.from(tree.nodes.values()).filter(
        (node) => node.id === 'workflow-run:wf_1',
      ),
    );
    expect(runNodes.length).toBeGreaterThan(0);
    expect(runNodes[0]?.status).toBe('completed');
    expect(runNodes.every((node) => node.status === 'completed')).toBe(true);

    const tree = getSubagentTreeSnapshot(SCOPE, ROOT_ID).tree;
    expect(tree?.nodes.has('workflow-phase:wf_1:Build')).toBe(true);
    expect(tree?.nodes.has('workflow-agent:wf_1:agent_7')).toBe(true);
    expect(
      JSON.stringify(Array.from(tree?.nodes.values() ?? [])),
    ).not.toContain(TRANSCRIPT_DIR);
    expect(
      JSON.stringify(Array.from(tree?.nodes.values() ?? [])),
    ).not.toContain('Private phase detail');

    unsubscribe();
    release();
  });

  it('stops polling after the final tree consumer releases the run', async () => {
    readWorkflowRun.mockResolvedValue(runState('running'));
    const release = acquireSubagentTree(SCOPE, ROOT_ID);
    updateRootChat(workflowMessages());
    await flushPromises();
    expect(readWorkflowRun).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(2_000);
    await flushPromises();
    expect(readWorkflowRun).toHaveBeenCalledTimes(2);

    release();
    await jest.advanceTimersByTimeAsync(8_000);
    await flushPromises();
    expect(readWorkflowRun).toHaveBeenCalledTimes(2);
  });

  it('does not notify tree listeners when a running poll returns identical data', async () => {
    readWorkflowRun.mockResolvedValue(runState('running'));
    const release = acquireSubagentTree(SCOPE, ROOT_ID);
    updateRootChat(workflowMessages());
    await flushPromises();
    let publications = 0;
    const unsubscribe = subscribeSubagentTree(SCOPE, ROOT_ID, () => {
      publications += 1;
    });

    await jest.advanceTimersByTimeAsync(2_000);
    await flushPromises();

    expect(readWorkflowRun).toHaveBeenCalledTimes(2);
    expect(publications).toBe(0);
    unsubscribe();
    release();
  });

  it('counts loaded workflow runs as fallback data after a managed read failure', async () => {
    treeRead.mockRejectedValue(new Error('managed tree unavailable'));
    readWorkflowRun.mockResolvedValue(runState('completed'));
    const release = acquireSubagentTree(SCOPE, ROOT_ID);
    updateRootChat(workflowMessages());
    await flushPromises();

    expect(getSubagentTreeSnapshot(SCOPE, ROOT_ID).treeState.status).toBe(
      'ready',
    );
    release();
  });
});

describe('desktop subagent workflow fingerprints', () => {
  const loaded: LoadedSubagentInputs = {
    managed: [],
    claudeNative: [],
    codexNative: [],
  };

  it('passes workflow inputs and fingerprints run and agent details', () => {
    const workflowRun = {
      runId: 'wf_1',
      name: 'Build',
      status: 'running' as const,
      startedAt: NOW,
      phases: [{ title: 'Implement' }],
      agents: [
        {
          agentId: 'agent_1',
          label: 'Builder',
          phaseTitle: 'Implement',
          state: 'running' as const,
          modelLabel: 'Claude Opus',
          prompt: 'Implement the task',
          startedAt: NOW + 1,
          tokens: 12,
          toolCalls: 3,
          durationMs: 500,
        },
      ],
    };
    const input = buildDesktopSubagentTreeInput({
      root: { id: ROOT_ID, title: 'Root' },
      managedEntries: [],
      loaded,
      workflowRuns: [workflowRun],
    });

    expect(input.workflowRuns).toEqual([workflowRun]);
    expect(
      buildDesktopSubagentTreeInput({
        root: { id: ROOT_ID, title: 'Root' },
        managedEntries: [],
        loaded,
        workflowRuns: [],
      }),
    ).not.toHaveProperty('workflowRuns');

    const fingerprint = subagentTreeInputFingerprint(input);
    expect(
      subagentTreeInputFingerprint({
        ...input,
        workflowRuns: [
          {
            ...workflowRun,
            agents: [{ ...workflowRun.agents[0], prompt: 'Updated prompt' }],
          },
        ],
      }),
    ).not.toBe(fingerprint);
    expect(
      buildSubagentTree(input).nodes.has('workflow-agent:wf_1:agent_1'),
    ).toBe(true);
  });
});
