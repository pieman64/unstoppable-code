import type { ChatAgentSentInfo } from '@canopy/protocol/portal';
import type { SubagentNode, SubagentTree } from '../../subagent-tree';
import type { PersistedChatMessage as ChatMessage } from '../../../types';
import { buildSubagentChatTranscript } from '../message-transcript';

function node(
  runs: SubagentNode['runs'],
  prompt = 'Initial task',
): SubagentNode {
  return {
    id: 'delegate',
    kind: 'managed',
    parentId: null,
    depth: 1,
    title: 'Delegate',
    status: 'completed',
    childIds: [],
    liveDescendantCount: 0,
    approvalPending: false,
    prompt,
    runs,
  };
}

function tree(selected: SubagentNode): SubagentTree {
  return {
    root: { id: 'root-chat', title: 'Root chat' },
    nodes: new Map([[selected.id, selected]]),
    rootChildIds: [selected.id],
    complete: true,
  };
}

function message(
  value: Omit<ChatMessage, 'timestamp'> & { readonly timestamp?: number },
): ChatMessage {
  return { timestamp: 0, ...value };
}

describe('buildSubagentChatTranscript', () => {
  it('labels task, follow-up, user and steering messages', () => {
    const selected = node([{ runGeneration: 1, agentBlockId: 'run-1' }]);
    const messages: ChatMessage[] = [
      message({
        id: 'agent-follow-up',
        role: 'user',
        parentBlockId: 'run-1',
        delegationSequence: 1,
        delegationAuthor: { kind: 'agent', depth: 0, description: 'Parent' },
        blocks: [{ type: 'text', text: 'Keep the existing response.' }],
      }),
      message({
        id: 'user-steer',
        role: 'user',
        parentBlockId: 'run-1',
        delegationSequence: 2,
        delegationAuthor: { kind: 'user' },
        delegationDelivery: 'steer',
        blocks: [{ type: 'text', text: 'Keep the direct call.' }],
      }),
      message({
        id: 'agent-output',
        role: 'assistant',
        parentBlockId: 'run-1',
        delegationSequence: 3,
        blocks: [{ type: 'text', text: 'Working on the task.' }],
      }),
    ];

    const transcript = buildSubagentChatTranscript({
      tree: tree(selected),
      node: selected,
      rootMessages: messages,
    });

    expect(transcript.items).toEqual([
      {
        kind: 'task',
        key: 'task-1',
        sender: 'Root chat',
        text: 'Initial task',
      },
      {
        kind: 'follow_up',
        key: 'agent-follow-up',
        sender: 'Parent',
        text: 'Keep the existing response.',
      },
      {
        kind: 'user',
        key: 'user-steer',
        text: 'Keep the direct call.',
        steering: true,
      },
      expect.objectContaining({ kind: 'blocks', key: 'agent-output' }),
    ]);
    expect(transcript.missingBeginning).toBe(false);
  });

  it('preserves structured agent-sent metadata on authored user rows', () => {
    const selected = node([{ runGeneration: 1, agentBlockId: 'run-1' }]);
    const agentSent: ChatAgentSentInfo = {
      sender: {
        kind: 'project',
        projectType: 'code',
        projectId: 'sender-project',
        taskId: 'sender-task',
        chatId: 'sender-chat',
      },
      chatTitle: 'Origin chat',
      projectLabel: 'Source project',
    };
    const transcript = buildSubagentChatTranscript({
      tree: tree(selected),
      node: selected,
      rootMessages: [
        message({
          id: 'agent-sent-steer',
          role: 'user',
          parentBlockId: 'run-1',
          delegationSequence: 1,
          delegationAuthor: { kind: 'user' },
          delegationDelivery: 'steer',
          blocks: [{ type: 'text', text: 'Continue the review.' }],
          agentSent,
        }),
      ],
    });

    expect(transcript.items).toContainEqual({
      kind: 'user',
      key: 'agent-sent-steer',
      text: 'Continue the review.',
      steering: true,
      agentSent,
    });
    expect(
      transcript.items
        .filter((item) => item.kind === 'task' || item.kind === 'follow_up')
        .every((item) => !('agentSent' in item)),
    ).toBe(true);
  });

  it('shows run dividers and pages a run absent from the loaded root chat', () => {
    const selected = node([
      { runGeneration: 1, agentBlockId: 'run-1' },
      { runGeneration: 2, agentBlockId: 'run-2' },
    ]);
    const pagedMessage = message({
      id: 'paged-output',
      role: 'assistant',
      parentBlockId: 'run-1',
      delegationSequence: 0,
      blocks: [{ type: 'text', text: 'First run output.' }],
    });
    const liveMessage = message({
      id: 'live-output',
      role: 'assistant',
      parentBlockId: 'run-2',
      delegationSequence: 0,
      blocks: [{ type: 'text', text: 'Second run output.' }],
    });

    const transcript = buildSubagentChatTranscript({
      tree: tree(selected),
      node: selected,
      rootMessages: [liveMessage],
      runs: [
        {
          runGeneration: 1,
          agentBlockId: 'run-1',
          prompt: 'First task',
          pagedMessages: [pagedMessage],
        },
        { runGeneration: 2, agentBlockId: 'run-2', prompt: 'Second task' },
      ],
    });

    expect(transcript.items.map((item) => item.kind)).toEqual([
      'task',
      'blocks',
      'divider',
      'task',
      'blocks',
    ]);
    expect(transcript.items[2]).toEqual({
      kind: 'divider',
      key: 'run-2',
      runGeneration: 2,
    });
    expect(transcript.items[1]).toEqual(
      expect.objectContaining({ key: 'paged-output' }),
    );
  });

  it("shows a run's page instead of the root chat's copy when the page replaces it", () => {
    const selected = node([{ runGeneration: 1, agentBlockId: 'run-1' }]);
    const rootRow = message({
      id: 'run-1:turn0:hash',
      role: 'assistant',
      parentBlockId: 'run-1',
      delegationSequence: 1,
      blocks: [{ type: 'text', text: 'Started.' }],
    });
    const pagedMessages = [
      message({
        id: 'run-1:item-1',
        role: 'assistant',
        parentBlockId: 'run-1',
        delegationSequence: 1,
        blocks: [{ type: 'text', text: 'Started.' }],
      }),
      message({
        id: 'run-1:item-2',
        role: 'assistant',
        parentBlockId: 'run-1',
        delegationSequence: 2,
        blocks: [{ type: 'text', text: 'Finished.' }],
      }),
    ];

    const text = (replacesRootRows: boolean): string[] =>
      buildSubagentChatTranscript({
        tree: tree(selected),
        node: selected,
        rootMessages: [rootRow],
        runs: [
          {
            runGeneration: 1,
            agentBlockId: 'run-1',
            pagedMessages,
            replacesRootRows,
          },
        ],
      }).items.flatMap((item) =>
        item.kind === 'blocks'
          ? item.blocks.flatMap((block) =>
              block.type === 'text' ? [block.text] : [],
            )
          : [],
      );

    expect(text(true)).toEqual(['Started.', 'Finished.']);
  });

  it('merges nested agent rows into the owning display block', () => {
    const selected = node([{ runGeneration: 1, agentBlockId: 'run-1' }]);
    const messages: ChatMessage[] = [
      message({
        id: 'tool-use',
        role: 'assistant',
        parentBlockId: 'run-1',
        delegationSequence: 0,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'nested-task',
            toolName: 'Task',
            input: JSON.stringify({
              subagent_type: 'Explore',
              description: 'Nested scout',
              prompt: 'Find the test helper.',
            }),
          },
        ],
      }),
      message({
        id: 'nested-output',
        role: 'assistant',
        parentToolUseId: 'nested-task',
        delegationSequence: 0,
        blocks: [{ type: 'text', text: 'The helper is in test-utils.ts.' }],
      }),
    ];

    const transcript = buildSubagentChatTranscript({
      tree: tree(selected),
      node: selected,
      rootMessages: messages,
    });
    const displayItem = transcript.items.find((item) => item.kind === 'blocks');
    if (!displayItem || displayItem.kind !== 'blocks') {
      throw new Error('nested agent message was not rendered');
    }
    const nestedAgent = displayItem.blocks[0];

    expect(nestedAgent?.type).toBe('agent');
    if (!nestedAgent || nestedAgent.type !== 'agent') {
      throw new Error('nested agent call was not merged');
    }
    expect(nestedAgent.subBlocks).toEqual([
      { type: 'text', text: 'The helper is in test-utils.ts.' },
    ]);
  });

  it('shows a watcher folded into a user follow-up after the follow-up', () => {
    const selected = node([
      { runGeneration: 1, agentBlockId: 'run-1' },
      { runGeneration: 2, agentBlockId: 'run-2' },
    ]);
    const watcher = [
      '<system_instruction>',
      '<canopy_watcher_event>',
      JSON.stringify({
        label: 'Delegate completion',
        target: { kind: 'managed_delegation', outcome: 'completed' },
      }),
      '</canopy_watcher_event>',
      '</system_instruction>',
    ].join('\n');
    const transcript = buildSubagentChatTranscript({
      tree: tree(selected),
      node: selected,
      rootMessages: [
        message({
          id: 'user-hi',
          role: 'user',
          parentBlockId: 'run-2',
          delegationSequence: 1,
          delegationAuthor: { kind: 'user' },
          delegationDelivery: 'follow_up',
          blocks: [{ type: 'text', text: 'hi' }],
        }),
        message({
          id: 'answer',
          role: 'assistant',
          parentBlockId: 'run-2',
          delegationSequence: 2,
          blocks: [{ type: 'text', text: 'Both children finished.' }],
        }),
      ],
      runs: [
        { runGeneration: 1, agentBlockId: 'run-1', prompt: 'Initial task' },
        {
          runGeneration: 2,
          agentBlockId: 'run-2',
          prompt: `hi\n\n${watcher}`,
        },
      ],
    });

    const run2 = transcript.items.slice(
      transcript.items.findIndex((item) => item.kind === 'divider'),
    );
    expect(run2.map((item) => item.kind)).toEqual([
      'divider',
      'user',
      'task',
      'blocks',
    ]);
    expect(run2[2]).toMatchObject({
      kind: 'task',
      text: `hi\n\n${watcher}`,
      shownTexts: ['hi'],
    });
  });

  it('marks loaded runs with nonzero first sequence as missing their beginning', () => {
    const selected = node([{ runGeneration: 1, agentBlockId: 'run-1' }]);
    const transcript = buildSubagentChatTranscript({
      tree: tree(selected),
      node: selected,
      rootMessages: [
        message({
          id: 'later-message',
          role: 'assistant',
          parentBlockId: 'run-1',
          delegationSequence: 5,
          blocks: [{ type: 'text', text: 'Later output.' }],
        }),
      ],
    });

    expect(transcript.missingBeginning).toBe(true);
  });
  it('shows a user follow-up once, as the user message that started its run', () => {
    const selected = node([
      { runGeneration: 1, agentBlockId: 'run-1' },
      { runGeneration: 2, agentBlockId: 'run-2' },
    ]);
    const followUp = message({
      id: 'user-follow-up',
      role: 'user',
      parentBlockId: 'run-2',
      delegationSequence: 1,
      delegationAuthor: { kind: 'user' },
      delegationDelivery: 'follow_up',
      blocks: [{ type: 'text', text: 'Check the edge case.' }],
    });

    const transcript = buildSubagentChatTranscript({
      tree: tree(selected),
      node: selected,
      rootMessages: [followUp],
      runs: [
        { runGeneration: 1, agentBlockId: 'run-1', prompt: 'First task' },
        {
          runGeneration: 2,
          agentBlockId: 'run-2',
          prompt: 'Check the edge case.',
        },
      ],
    });

    expect(transcript.items.map((item) => item.kind)).toEqual([
      'task',
      'divider',
      'user',
    ]);
  });

  it("shows a finished native Claude agent's answer when it streamed no transcript", () => {
    const selected: SubagentNode = {
      ...node([]),
      id: 'native-task',
      kind: 'claude-native',
      prompt: undefined,
    };
    const transcript = buildSubagentChatTranscript({
      tree: tree(selected),
      node: selected,
      rootMessages: [
        message({
          id: 'task-call',
          role: 'assistant',
          blocks: [
            {
              type: 'tool_use',
              toolUseId: 'native-task',
              toolName: 'Task',
              input: JSON.stringify({
                description: 'Check the parser',
                prompt: 'Find the parser bug.',
                subagent_type: 'general-purpose',
              }),
            },
          ],
        }),
        message({
          id: 'task-result',
          role: 'user',
          blocks: [
            {
              type: 'tool_result',
              toolUseId: 'native-task',
              output: 'The bug is in the tokenizer.',
              isError: false,
            },
          ],
        }),
      ],
    });

    expect(transcript.items).toEqual([
      expect.objectContaining({ kind: 'task', text: 'Find the parser bug.' }),
      expect.objectContaining({
        kind: 'blocks',
        blocks: [{ type: 'text', text: 'The bug is in the tokenizer.' }],
      }),
    ]);
  });

  it('builds the transcript of a native Claude agent nested in another', () => {
    const selected: SubagentNode = {
      ...node([]),
      id: 'inner-task',
      kind: 'claude-native',
      parentId: 'outer-task',
      depth: 2,
      prompt: undefined,
    };
    const taskCall = (
      toolUseId: string,
      prompt: string,
    ): ChatMessage['blocks'][number] => ({
      type: 'tool_use',
      toolUseId,
      toolName: 'Task',
      input: JSON.stringify({
        description: prompt,
        prompt,
        subagent_type: 'general-purpose',
      }),
    });
    const transcript = buildSubagentChatTranscript({
      tree: tree(selected),
      node: selected,
      rootMessages: [
        message({
          id: 'outer-call',
          role: 'assistant',
          blocks: [taskCall('outer-task', 'Outer task')],
        }),
        message({
          id: 'inner-call',
          role: 'assistant',
          parentToolUseId: 'outer-task',
          blocks: [taskCall('inner-task', 'Inner task')],
        }),
        message({
          id: 'inner-work',
          role: 'assistant',
          parentToolUseId: 'inner-task',
          blocks: [{ type: 'text', text: 'Inner work.' }],
        }),
      ],
    });

    expect(transcript.items[0]).toEqual(
      expect.objectContaining({ kind: 'task', text: 'Inner task' }),
    );
    expect(JSON.stringify(transcript.items.slice(1))).toContain('Inner work.');
  });
  it("shows only the selected Codex receiver's rows when receivers share a call", () => {
    const selected: SubagentNode = {
      ...node([]),
      id: 'thread-a',
      kind: 'codex-native',
      prompt: undefined,
    };
    const transcript = buildSubagentChatTranscript({
      tree: tree(selected),
      node: selected,
      rootMessages: [
        message({
          id: 'spawn-call',
          role: 'assistant',
          blocks: [
            {
              type: 'codex_agent_call',
              agentBlockId: 'shared-block',
              callId: 'shared-call',
              tool: 'spawnAgent',
              status: 'completed',
              senderThreadId: 'root-thread',
              receiverThreadIds: ['thread-a', 'thread-b'],
              prompt: 'Review both halves.',
              agentsStates: {},
            },
          ],
        }),
        message({
          id: 'a-output',
          role: 'assistant',
          parentBlockId: 'shared-block',
          codexThreadId: 'thread-a',
          blocks: [{ type: 'text', text: 'First half reviewed.' }],
        }),
        message({
          id: 'b-output',
          role: 'assistant',
          parentBlockId: 'shared-block',
          codexThreadId: 'thread-b',
          blocks: [{ type: 'text', text: 'Second half reviewed.' }],
        }),
      ],
    });

    const rendered = JSON.stringify(transcript.items);
    expect(transcript.items[0]).toEqual(
      expect.objectContaining({ kind: 'task', text: 'Review both halves.' }),
    );
    expect(rendered).toContain('First half reviewed.');
    expect(rendered).not.toContain('Second half reviewed.');
  });

  it('keeps sibling Codex receivers apart when their item ids repeat', () => {
    // Codex item ids are unique only per thread, so both receivers' rows are
    // persisted as `codex-item_1`.
    const command = (
      threadId: string,
      input: string,
      output: string,
    ): ChatMessage =>
      message({
        id: 'codex-item_1',
        role: 'system',
        parentBlockId: 'shared-block',
        codexThreadId: threadId,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'codex-item_1',
            toolName: 'command',
            input,
          },
          {
            type: 'tool_result',
            toolUseId: 'codex-item_1',
            toolName: 'command',
            output,
            isError: false,
          },
        ],
      });
    const transcriptFor = (threadId: string): string => {
      const selected: SubagentNode = {
        ...node([]),
        id: threadId,
        kind: 'codex-native',
        prompt: undefined,
      };
      return JSON.stringify(
        buildSubagentChatTranscript({
          tree: tree(selected),
          node: selected,
          rootMessages: [
            message({
              id: 'spawn-call',
              role: 'assistant',
              blocks: [
                {
                  type: 'codex_agent_call',
                  agentBlockId: 'shared-block',
                  callId: 'shared-call',
                  tool: 'spawnAgent',
                  status: 'completed',
                  senderThreadId: 'root-thread',
                  receiverThreadIds: ['thread-a', 'thread-b'],
                  prompt: 'Check both.',
                  agentsStates: {},
                },
              ],
            }),
            command('thread-a', 'npm run lint', '0 problems'),
            command('thread-b', 'npm test', '1 failing'),
          ],
        }).items,
      );
    };

    const lint = transcriptFor('thread-a');
    expect(lint).toContain('npm run lint');
    expect(lint).toContain('0 problems');
    expect(lint).not.toContain('npm test');
    expect(lint).not.toContain('1 failing');
    const tests = transcriptFor('thread-b');
    expect(tests).toContain('npm test');
    expect(tests).toContain('1 failing');
    expect(tests).not.toContain('npm run lint');
    expect(tests).not.toContain('0 problems');
  });
});
