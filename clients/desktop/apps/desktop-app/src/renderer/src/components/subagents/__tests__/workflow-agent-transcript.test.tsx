/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DisplayMessage } from '@/components/chat/types';
import { buildSubagentTree, type SubagentNode } from '@canopy/agent-transcript';
import {
  useWorkflowAgentTranscript,
  type WorkflowAgentTranscriptResult,
} from '../useWorkflowAgentTranscript';
import {
  buildWorkflowAgentTranscriptItems,
  WORKFLOW_AGENT_TRANSCRIPT_TRUNCATED_NOTICE,
} from '../workflow-agent-transcript';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function TranscriptProbe({
  onResult,
  live,
}: {
  readonly onResult: (result: WorkflowAgentTranscriptResult) => void;
  readonly live: boolean;
}): JSX.Element {
  const result = useWorkflowAgentTranscript({
    transcriptDir: '/tmp/workflow',
    agentId: 'agent-1',
    live,
    enabled: true,
  });
  onResult(result);
  return <div>{result.lines.join('\n')}</div>;
}

function workflowAgentNode(): SubagentNode {
  const tree = buildSubagentTree({
    root: { id: 'root-chat', title: 'Root chat' },
    managed: [],
    workflowRuns: [
      {
        runId: 'wf_1',
        name: 'Report review',
        status: 'running',
        phases: [{ title: 'Review' }],
        agents: [
          {
            agentId: 'agent-1',
            label: 'Fact-check the report',
            phaseTitle: 'Review',
            state: 'running',
            prompt: 'Fact-check the report.',
          },
        ],
      },
    ],
  });
  const node = Array.from(tree.nodes.values()).find(
    (candidate) => candidate.kind === 'workflow-agent',
  );
  if (!node) throw new Error('Expected a workflow-agent node');
  return node;
}

describe('buildWorkflowAgentTranscriptItems', () => {
  it('shows the task first and drops the duplicated initial user message', () => {
    const initialPrompt = 'Fact-check the report.';
    const messages: readonly DisplayMessage[] = [
      {
        id: 'user-1',
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: initialPrompt }],
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        timestamp: 2,
        blocks: [{ type: 'text', text: 'The report is accurate.' }],
      },
    ];
    const parse = (lines: readonly string[]): readonly DisplayMessage[] => {
      expect(lines).toEqual(['transcript line']);
      return messages;
    };

    const items = buildWorkflowAgentTranscriptItems({
      node: workflowAgentNode(),
      lines: ['transcript line'],
      initialPrompt,
      parse,
    });

    expect(WORKFLOW_AGENT_TRANSCRIPT_TRUNCATED_NOTICE).toBe(
      'Earlier messages are not shown.',
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: 'task',
      sender: 'Report review',
      text: initialPrompt,
    });
    expect(items[1]).toMatchObject({
      kind: 'blocks',
      key: 'workflow-agent-assistant-1',
    });
  });

  it('uses the tree prompt when no initial prompt was read and skips empty tasks', () => {
    const parse = (lines: readonly string[]): readonly DisplayMessage[] => {
      expect(lines).toEqual([]);
      return [];
    };
    const node = workflowAgentNode();

    expect(
      buildWorkflowAgentTranscriptItems({
        node,
        lines: [],
        initialPrompt: undefined,
        parse,
      }),
    ).toMatchObject([{ kind: 'task', text: 'Fact-check the report.' }]);
    expect(
      buildWorkflowAgentTranscriptItems({
        node: { ...node, prompt: '' },
        lines: [],
        initialPrompt: undefined,
        parse,
      }),
    ).toEqual([]);
  });
});

describe('useWorkflowAgentTranscript', () => {
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
    jest.useRealTimers();
  });

  it('refreshes live transcripts every two seconds without replacing unchanged state', async () => {
    jest.useFakeTimers();
    const readWorkflowAgentTranscript = jest.fn(() =>
      Promise.resolve({
        lines: ['latest line'],
        truncated: true,
        initialPrompt: 'Check this fact.',
      }),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { activity: { readWorkflowAgentTranscript } },
    });
    const results: WorkflowAgentTranscriptResult[] = [];
    const onResult = (result: WorkflowAgentTranscriptResult): void => {
      results.push(result);
    };

    await act(async () => {
      root.render(<TranscriptProbe onResult={onResult} live />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(readWorkflowAgentTranscript).toHaveBeenCalledTimes(1);
    expect(results[results.length - 1]?.lines).toEqual(['latest line']);
    const linesReference = results[results.length - 1]?.lines;

    await act(async () => {
      jest.advanceTimersByTime(2_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(readWorkflowAgentTranscript).toHaveBeenCalledTimes(2);
    expect(results[results.length - 1]?.lines).toBe(linesReference);
  });
});
