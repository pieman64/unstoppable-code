import type { ChatMessage } from '@/stores/chatStore';
import {
  collectWorkflowRunLocations,
  hasWorkflowLaunches,
} from '../workflow-run-launches';

function workflowCall(
  toolUseId: string,
  timestamp: number,
  name: string,
): ChatMessage {
  return {
    id: `call-${toolUseId}`,
    role: 'assistant',
    timestamp,
    blocks: [
      {
        type: 'tool_use',
        toolUseId,
        toolName: 'Workflow',
        input: JSON.stringify({
          script: `export const meta = { name: '${name}' }`,
        }),
      },
    ],
  };
}

function receipt(
  toolUseId: string,
  runId: string,
  transcriptDir: string,
  taskId: string,
): ChatMessage {
  return {
    id: `receipt-${toolUseId}`,
    role: 'assistant',
    timestamp: 100,
    blocks: [
      {
        type: 'tool_result',
        toolUseId,
        toolName: 'Workflow',
        output: `Workflow launched in background. Task ID: ${taskId}\nSummary: Run ${runId}\nTranscript dir: ${transcriptDir}\nScript file: /abs/x.js\nRun ID: ${runId}`,
        isError: false,
      },
    ],
  };
}

describe('collectWorkflowRunLocations', () => {
  it('maps receipts to workflow calls in launch order and caches by messages array', () => {
    const messages: readonly ChatMessage[] = [
      workflowCall('tool-1', 10, 'billing-plan-write'),
      workflowCall('tool-2', 20, 'release-notes'),
      receipt('tool-2', 'wf_2', '/abs/dir/wf_2', 'task-2'),
      receipt('tool-1', 'wf_1', '/abs/dir/wf_1', 'task-1'),
    ];

    const locations = collectWorkflowRunLocations(messages);

    expect(locations).toEqual([
      {
        runId: 'wf_1',
        transcriptDir: '/abs/dir/wf_1',
        toolUseId: 'tool-1',
        name: 'billing-plan-write',
        launchedAt: 10,
        taskId: 'task-1',
      },
      {
        runId: 'wf_2',
        transcriptDir: '/abs/dir/wf_2',
        toolUseId: 'tool-2',
        name: 'release-notes',
        launchedAt: 20,
        taskId: 'task-2',
      },
    ]);
    expect(collectWorkflowRunLocations(messages)).toBe(locations);
  });

  it('ignores launches without a receipt and non-receipt tool results', () => {
    const messages: readonly ChatMessage[] = [
      workflowCall('missing-receipt', 10, 'unreported'),
      workflowCall('wrong-result', 20, 'not-a-receipt'),
      {
        id: 'result-wrong-result',
        role: 'assistant',
        timestamp: 30,
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'wrong-result',
            toolName: 'Workflow',
            output: 'Workflow finished successfully.',
            isError: false,
          },
        ],
      },
    ];

    expect(hasWorkflowLaunches(messages)).toBe(true);
    expect(collectWorkflowRunLocations(messages)).toEqual([]);
  });

  it('keeps the first launch when receipts repeat a run id', () => {
    const messages: readonly ChatMessage[] = [
      workflowCall('first', 10, 'first-name'),
      receipt('first', 'wf_repeat', '/abs/dir/first', 'task-first'),
      workflowCall('second', 20, 'second-name'),
      receipt('second', 'wf_repeat', '/abs/dir/second', 'task-second'),
    ];

    expect(collectWorkflowRunLocations(messages)).toEqual([
      {
        runId: 'wf_repeat',
        transcriptDir: '/abs/dir/first',
        toolUseId: 'first',
        name: 'first-name',
        launchedAt: 10,
        taskId: 'task-first',
      },
    ]);
  });
});
