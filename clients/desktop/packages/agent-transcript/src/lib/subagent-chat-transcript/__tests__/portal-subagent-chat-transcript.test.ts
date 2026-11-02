import type { PortalChatPart } from '@canopy/protocol/portal';
import type { SubagentNode, SubagentTree } from '../../subagent-tree';
import { buildPortalSubagentChatTranscript } from '../part-transcript';

const node: SubagentNode = {
  id: 'delegate',
  kind: 'managed',
  parentId: null,
  depth: 1,
  title: 'Delegate',
  status: 'completed',
  prompt: 'Node prompt',
  childIds: [],
  liveDescendantCount: 0,
  approvalPending: false,
  runs: [],
};
const tree: SubagentTree = {
  root: { id: 'root-chat', title: 'Root chat' },
  nodes: new Map([[node.id, node]]),
  rootChildIds: [node.id],
  complete: false,
};

function text(value: string): PortalChatPart {
  return { kind: 'text', data: { text: value } };
}

describe('buildPortalSubagentChatTranscript', () => {
  it('orders runs by generation, keeps the latest observation and appends an unshown final answer', () => {
    const { items } = buildPortalSubagentChatTranscript({
      tree,
      node,
      runs: [
        {
          runGeneration: 2,
          prompt: 'Second task',
          subBlocks: [text('Done again')],
          subBlocksTruncated: true,
          omittedSubBlocks: 3,
          finalText: 'Done again',
        },
        {
          runGeneration: 1,
          prompt: 'Stale task',
          subBlocks: [text('Stale')],
          subBlocksTruncated: false,
          omittedSubBlocks: 0,
        },
        {
          runGeneration: 1,
          prompt: 'First task',
          subBlocks: [text('Working')],
          subBlocksTruncated: false,
          omittedSubBlocks: 0,
          finalText: 'Done',
        },
      ],
    });
    expect(items.map((item) => [item.kind, item.key])).toEqual([
      ['task', 'run-1-task'],
      ['part', 'run-1-text-0'],
      ['part', 'run-1-final-text'],
      ['divider', 'run-2-divider'],
      ['task', 'run-2-task'],
      ['truncated', 'run-2-truncated'],
      ['part', 'run-2-text-0'],
    ]);
    expect(items[0]).toMatchObject({ sender: 'Root chat', text: 'First task' });
    expect(items.find((item) => item.key === 'run-1-final-text')).toMatchObject(
      {
        part: text('Done'),
      },
    );
    expect(items.find((item) => item.kind === 'truncated')).toMatchObject({
      omittedSubBlocks: 3,
    });
  });

  it('shows the node prompt when no run was observed', () => {
    expect(
      buildPortalSubagentChatTranscript({ tree, node, runs: [] }).items,
    ).toEqual([
      {
        kind: 'task',
        key: 'task-delegate',
        sender: 'Root chat',
        text: 'Node prompt',
      },
    ]);
  });

  it('validates agent-sent attribution from compact wire fields on authored user parts', () => {
    const wire = {
      agentSentSenderKind: 'project',
      agentSentProjectType: 'code',
      agentSentProjectId: 'sender-project',
      agentSentTaskId: 'sender-task',
      agentSentChatId: 'sender-chat',
      agentSentChatTitle: 'Captured sender chat',
      agentSentProjectLabel: 'Source project',
    };
    const { items } = buildPortalSubagentChatTranscript({
      tree,
      node,
      runs: [
        {
          runGeneration: 1,
          subBlocks: [
            {
              kind: 'text',
              data: {
                text: 'Continue the review.',
                delegationAuthorKind: 'user',
                delegationDelivery: 'steer',
                ...wire,
              },
            },
            {
              kind: 'text',
              data: {
                text: 'Malformed marker',
                delegationAuthorKind: 'user',
                ...wire,
                agentSentProjectType: 'invalid',
                // The nested shape is not the compact wire contract.
                agentSent: {
                  sender: {
                    kind: 'project',
                    projectType: 'code',
                    projectId: 'sender-project',
                    taskId: 'sender-task',
                    chatId: 'sender-chat',
                  },
                  chatTitle: 'Nested spoof',
                  projectLabel: 'Nested spoof project',
                },
              },
            },
            {
              kind: 'text',
              data: {
                text: 'Bot sender',
                delegationAuthorKind: 'user',
                agentSentSenderKind: 'bot',
                agentSentBotId: 'app_advisor',
                agentSentTaskId: 'advisor-task',
                agentSentChatId: 'advisor-chat',
                agentSentChatTitle: 'Advisor chat',
                agentSentProjectLabel: 'App Advisor',
              },
            },
          ],
          subBlocksTruncated: false,
          omittedSubBlocks: 0,
        },
      ],
    });
    const users = items.filter((item) => item.kind === 'user');
    expect(users).toEqual([
      {
        kind: 'user',
        key: 'run-1-text-0',
        text: 'Continue the review.',
        steering: true,
        agentSent: {
          sender: {
            kind: 'project',
            projectType: 'code',
            projectId: 'sender-project',
            taskId: 'sender-task',
            chatId: 'sender-chat',
          },
          chatTitle: 'Captured sender chat',
          projectLabel: 'Source project',
        },
      },
      {
        kind: 'user',
        key: 'run-1-text-1',
        text: 'Malformed marker',
        steering: false,
      },
      {
        kind: 'user',
        key: 'run-1-text-2',
        text: 'Bot sender',
        steering: false,
        agentSent: {
          sender: {
            kind: 'bot',
            botId: 'app_advisor',
            taskId: 'advisor-task',
            chatId: 'advisor-chat',
          },
          chatTitle: 'Advisor chat',
          projectLabel: 'App Advisor',
        },
      },
    ]);
  });

  it('rebuilds pipeline agent-sent attribution and refuses mixed wire fields', () => {
    const step = {
      agentSentSenderKind: 'pipeline',
      agentSentExecutionId: 'exec-1',
      agentSentPipelineId: 'pipeline-1',
      agentSentStepId: 'notify',
      agentSentAutomationId: 'automation-1',
      agentSentChatTitle: 'Nightly triage',
      agentSentProjectLabel: '',
    };
    const part = (
      value: string,
      wire: Record<string, string>,
    ): PortalChatPart => ({
      kind: 'text',
      data: { text: value, delegationAuthorKind: 'user', ...wire },
    });
    const { items } = buildPortalSubagentChatTranscript({
      tree,
      node,
      runs: [
        {
          runGeneration: 1,
          subBlocks: [
            part('Step send', step),
            part('Automation send', {
              agentSentSenderKind: 'pipeline',
              agentSentAutomationId: 'automation-1',
              agentSentChatTitle: 'Nightly triage',
              agentSentProjectLabel: '',
            }),
            part('Mixed', { ...step, agentSentChatId: 'chat-1' }),
            part('Partial', {
              agentSentSenderKind: 'pipeline',
              agentSentExecutionId: 'exec-1',
              agentSentChatTitle: 'Nightly triage',
              agentSentProjectLabel: '',
            }),
          ],
          subBlocksTruncated: false,
          omittedSubBlocks: 0,
        },
      ],
    });
    const users = items.filter((item) => item.kind === 'user');
    expect(users.map((item) => item.agentSent)).toEqual([
      {
        sender: {
          kind: 'pipeline',
          executionId: 'exec-1',
          pipelineId: 'pipeline-1',
          stepId: 'notify',
          automationId: 'automation-1',
        },
        chatTitle: 'Nightly triage',
        projectLabel: '',
      },
      {
        sender: { kind: 'pipeline', automationId: 'automation-1' },
        chatTitle: 'Nightly triage',
        projectLabel: '',
      },
      undefined,
      undefined,
    ]);
  });
});
