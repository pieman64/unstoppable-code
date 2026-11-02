/** @jest-environment jsdom */

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ActivityReadWorkflowRunRequest,
  WorkflowRunState,
} from '@canopy/desktop-shared/types';
import {
  useChatStore,
  type ChatMessage,
  type ChatTab,
} from '@/stores/chatStore';
import { hydratedKeys } from '@/stores/chat/hydration';
import { useActivityStore } from '@/stores/activityStore';
import { resetWorkflowRunCacheForTests } from '../workflow-run-cache';
import type { SubagentHostScope } from '../subagent-scope';
import {
  resetSubagentRootChatsForTests,
  useSubagentRootChats,
} from '../useSubagentRootChats';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SCOPE: SubagentHostScope = {
  projectId: 'root-workflow-project',
  worktreeId: 'root-workflow-worktree',
};
const SCOPE_KEY = `${SCOPE.projectId}/${SCOPE.worktreeId}`;
const NOW = 1_800_000_000_000;

interface RootChatsProbe {
  current: ReturnType<typeof useSubagentRootChats> | null;
}

type ReadWorkflowRun = (
  request: ActivityReadWorkflowRunRequest,
) => Promise<WorkflowRunState | null>;

let readWorkflowRun: jest.MockedFunction<ReadWorkflowRun>;
let rootsRead: jest.Mock;
let mountedRoot: Root | null = null;

function runState(runId: string, status: string): WorkflowRunState {
  return {
    runId,
    status,
    lastActivityAt: runId === 'wf_finished' ? NOW + 100 : NOW + 200,
    phases: [
      { title: 'Plan', detail: 'Private' },
      { title: 'Implement', detail: 'Private' },
    ],
    agents:
      runId === 'wf_running'
        ? [
            {
              index: 0,
              label: 'Queued agent',
              phaseIndex: 0,
              phaseTitle: 'Plan',
              agentId: 'queued_1',
              agentType: 'worker',
              state: 'queued',
            },
            {
              index: 1,
              label: 'Running agent',
              phaseIndex: 1,
              phaseTitle: 'Implement',
              agentId: 'running-2',
              agentType: 'worker',
              state: 'running',
            },
            {
              index: 2,
              label: 'Completed agent',
              phaseIndex: 1,
              phaseTitle: 'Implement',
              agentId: 'done_3',
              agentType: 'worker',
              state: 'completed',
            },
            {
              index: 3,
              label: 'Unsafe agent',
              phaseIndex: 1,
              phaseTitle: 'Implement',
              agentId: 'unsafe/4',
              agentType: 'worker',
              state: 'running',
            },
          ]
        : [
            {
              index: 0,
              label: 'Finished run agent still says running',
              phaseIndex: 0,
              phaseTitle: 'Plan',
              agentId: 'finished_1',
              agentType: 'worker',
              state: 'running',
            },
          ],
  };
}

function workflowMessages(): readonly ChatMessage[] {
  const launches = [
    {
      runId: 'wf_running',
      taskId: 'task-running',
      name: 'Running workflow',
      timestamp: NOW,
      transcriptDir: '/private/workflows/wf_running',
    },
    {
      runId: 'wf_finished',
      taskId: 'task-finished',
      name: 'Finished workflow',
      timestamp: NOW + 50,
      transcriptDir: '/private/workflows/wf_finished',
    },
  ];
  return launches.flatMap((launch) => [
    {
      id: `call-${launch.runId}`,
      role: 'assistant' as const,
      timestamp: launch.timestamp,
      blocks: [
        {
          type: 'tool_use' as const,
          toolUseId: `tool-${launch.runId}`,
          toolName: 'Workflow',
          input: JSON.stringify({
            script: `export const meta = { name: '${launch.name}' }`,
          }),
        },
      ],
    },
    {
      id: `receipt-${launch.runId}`,
      role: 'assistant' as const,
      timestamp: launch.timestamp + 1,
      blocks: [
        {
          type: 'tool_result' as const,
          toolUseId: `tool-${launch.runId}`,
          toolName: 'Workflow',
          output: `Workflow launched in background. Task ID: ${launch.taskId}\nSummary: ${launch.name}\nTranscript dir: ${launch.transcriptDir}\nScript file: /private/workflow.js\nRun ID: ${launch.runId}`,
          isError: false,
        },
      ],
    },
  ]);
}

function chatTab(id: string, messages: readonly ChatMessage[]): ChatTab {
  return {
    id,
    title: 'Workflow chat',
    description: 'Workflow chat description',
    createdAt: '2026-10-06T00:00:00.000Z',
    messages: [...messages],
    status: 'idle',
    error: null,
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
  };
}

function setOpenTabs(tabs: readonly ChatTab[]): void {
  hydratedKeys.add(SCOPE_KEY);
  useChatStore.setState({
    worktreeChats: {
      [SCOPE_KEY]: { tabs: [...tabs], activeTabId: tabs[0]?.id ?? '' },
    },
  });
}

function RootChatsProbe({
  enabled,
  probe,
}: {
  readonly enabled: boolean;
  readonly probe: RootChatsProbe;
}): JSX.Element {
  probe.current = useSubagentRootChats(SCOPE, { enabled });
  return <></>;
}

function mountProbe(enabled: boolean, probe: RootChatsProbe): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  mountedRoot = createRoot(container);
  act(() => {
    mountedRoot?.render(<RootChatsProbe enabled={enabled} probe={probe} />);
  });
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function installApi(): void {
  rootsRead = jest.fn(() => Promise.resolve([]));
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      managedDelegation: { roots: rootsRead },
      activity: { readWorkflowRun },
    },
  });
}

beforeEach(() => {
  resetSubagentRootChatsForTests();
  resetWorkflowRunCacheForTests();
  useChatStore.setState(useChatStore.getInitialState());
  useActivityStore.setState({ bgProcesses: {} });
  hydratedKeys.delete(SCOPE_KEY);
  readWorkflowRun = jest.fn((request) =>
    Promise.resolve(
      runState(
        request.runId,
        request.runId === 'wf_finished' ? 'completed' : 'running',
      ),
    ),
  );
  installApi();
});

afterEach(() => {
  if (mountedRoot !== null) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  hydratedKeys.delete(SCOPE_KEY);
  useChatStore.setState(useChatStore.getInitialState());
  useActivityStore.setState({ bgProcesses: {} });
  resetSubagentRootChatsForTests();
  resetWorkflowRunCacheForTests();
  document.body.replaceChildren();
});

describe('useSubagentRootChats workflow summaries', () => {
  it('lists workflow-only chats and counts safe agents, not runs or phases', async () => {
    setOpenTabs([chatTab('workflow-chat', workflowMessages())]);
    const probe: RootChatsProbe = { current: null };
    mountProbe(true, probe);
    await flushPromises();

    expect(readWorkflowRun).toHaveBeenCalledTimes(2);
    expect(probe.current?.rootChats).toHaveLength(1);
    expect(probe.current?.rootChats[0]).toMatchObject({
      id: 'workflow-chat',
      total: 4,
      live: 2,
      lastActivityAt: NOW + 200,
    });
    expect(probe.current?.rootChats[0]?.loading).toBeUndefined();
  });

  it('marks summaries loading until every launched run has loaded', async () => {
    let resolveRead: (state: WorkflowRunState | null) => void = (): void => {};
    readWorkflowRun.mockImplementation(
      (request): Promise<WorkflowRunState | null> =>
        request.runId === 'wf_running'
          ? new Promise((resolve) => {
              resolveRead = resolve;
            })
          : Promise.resolve(runState(request.runId, 'completed')),
    );
    setOpenTabs([chatTab('workflow-chat', workflowMessages())]);
    const probe: RootChatsProbe = { current: null };
    mountProbe(true, probe);
    await flushPromises();

    expect(probe.current?.rootChats[0]?.loading).toBe(true);
    resolveRead(runState('wf_running', 'running'));
    await flushPromises();
    expect(probe.current?.rootChats[0]?.loading).toBeUndefined();
  });

  it('does not read runs while disabled', async () => {
    setOpenTabs([chatTab('workflow-chat', workflowMessages())]);
    const probe: RootChatsProbe = { current: null };
    mountProbe(false, probe);
    await flushPromises();

    expect(readWorkflowRun).not.toHaveBeenCalled();
    expect(rootsRead).not.toHaveBeenCalled();
    expect(probe.current).toEqual({ rootChats: [], loading: false });
  });
});
