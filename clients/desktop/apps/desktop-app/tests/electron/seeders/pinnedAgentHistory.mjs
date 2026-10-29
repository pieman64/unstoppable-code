// Shared deterministic history for pinned-agent behavior and visual evidence.
export function pinnedAgentHistory(kind, completed = false) {
  const timestamp = 1789490000000;
  const delegationId = 'managed-child';
  const id =
    kind === 'managed' ? `delegated-agent-${delegationId}` : `${kind}-child`;
  const prompt = `Review ${kind} source`;
  const block =
    kind === 'managed'
      ? {
          type: 'delegated_agent_call',
          agentBlockId: id,
          delegationId,
          parentTurnId: 'request',
          sequence: 1,
          createdAt: timestamp,
          selectedModelId: 'sonnet',
          runtimeModelId: 'claude-sonnet-4-6',
          targetHarnessId: 'claude',
          parentToolCallId: 'delegate-call',
          parentHarnessId: 'codex',
          description: prompt,
          prompt,
          executionMode: 'background',
          status: completed ? 'completed' : 'running',
          runGeneration: 1,
          outputTruncated: false,
          ...(completed ? { finalText: 'Finished reviewing source.' } : {}),
          routeSnapshot: {
            selectedModelId: 'sonnet',
            selectedModelLabel: 'Claude Sonnet',
            runtimeModelId: 'claude-sonnet-4-6',
            harnessId: 'claude',
          },
        }
      : kind === 'claude'
        ? {
            type: 'tool_use',
            toolUseId: id,
            toolName: 'Agent',
            input: JSON.stringify({
              description: prompt,
              prompt,
              subagent_type: 'Explore',
              run_in_background: true,
            }),
          }
        : {
            type: 'codex_agent_call',
            agentBlockId: id,
            callId: id,
            tool: 'spawnAgent',
            status: 'completed',
            senderThreadId: 'parent',
            receiverThreadIds: ['native-child'],
            prompt,
            agentsStates: {
              'native-child': { status: completed ? 'completed' : 'running' },
            },
          };
  return [
    {
      id: 'request',
      role: 'user',
      timestamp,
      blocks: [{ type: 'text', text: 'Review the source in the background.' }],
    },
    {
      id: kind === 'managed' ? id : 'dispatch',
      role: 'assistant',
      timestamp: timestamp + 1,
      blocks: [block],
    },
    ...(kind === 'claude'
      ? [
          {
            id: 'launch-receipt',
            role: 'assistant',
            timestamp: timestamp + 2,
            blocks: [
              {
                type: 'tool_result',
                toolUseId: id,
                toolName: 'Agent',
                output: 'Async agent launched successfully. agentId: abc123',
                isError: false,
              },
            ],
          },
        ]
      : []),
    {
      id: 'child-read',
      role: 'assistant',
      timestamp: timestamp + 3,
      ...(kind === 'claude' ? { parentToolUseId: id } : { parentBlockId: id }),
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'read-source',
          toolName: 'Read',
          input: '{"file_path":"src/index.ts"}',
        },
        {
          type: 'tool_result',
          toolUseId: 'read-source',
          toolName: 'Read',
          output: 'export const answer = 42;',
          isError: false,
        },
        {
          type: 'text',
          text: `Child transcript for ${kind}: the original cause is preserved.`,
        },
      ],
    },
    {
      id: 'parent-answer',
      role: 'assistant',
      timestamp: timestamp + 4,
      blocks: [
        { type: 'text', text: 'The review continues in the background.' },
      ],
    },
    {
      id: 'timer',
      role: 'system',
      timestamp: timestamp + 5,
      blocks: [
        {
          type: 'turn_timer',
          startedAt: timestamp,
          completedAt: timestamp + 5,
        },
      ],
    },
  ];
}

export function pinnedPatchHistory(matching = true) {
  const messages = pinnedAgentHistory('managed');
  const block = messages[1].blocks[0];
  Object.assign(block, {
    selectedModelId: 'gpt-5.6-luna',
    runtimeModelId: matching ? 'gpt-5.6-luna' : 'gpt-5.6-sol',
    targetHarnessId: 'codex',
    requestedThinkingLevel: 'medium',
    effectiveThinkingLevel: matching ? 'medium' : 'high',
  });
  Object.assign(block.routeSnapshot, {
    selectedModelId: block.selectedModelId,
    selectedModelLabel: 'GPT 5.6 Luna',
    runtimeModelId: block.runtimeModelId,
    runtimeModelLabel: matching ? 'GPT 5.6 Luna' : 'GPT 5.6 Sol',
    harnessId: 'codex',
    requestedThinkingLevel: block.requestedThinkingLevel,
    effectiveThinkingLevel: block.effectiveThinkingLevel,
  });
  messages[2].blocks = [
    {
      type: 'tool_use',
      toolUseId: 'legacy-patch',
      toolName: 'apply_patch',
      input: '',
    },
    {
      type: 'tool_result',
      toolUseId: 'legacy-patch',
      toolName: 'apply_patch',
      output: 'completed',
      isError: false,
    },
    {
      type: 'tool_use',
      toolUseId: 'new-patch',
      toolName: 'file_change',
      input: 'update: src/index.ts',
    },
    {
      type: 'tool_result',
      toolUseId: 'new-patch',
      toolName: 'file_change',
      output: 'completed',
      isError: false,
    },
  ];
  return messages;
}

export function pinnedShellHistory() {
  const messages = pinnedAgentHistory('managed');
  const child = messages.find((message) => message.id === 'child-read');
  const commands = [
    ['posix-shell', 'Bash', '/bin/zsh -c "printf hello && pwd"'],
    [
      'windows-shell',
      'Bash',
      String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command "Get-ChildItem -Force"`,
    ],
    [
      'windows-native-shell',
      'PowerShell',
      String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'Get-Content README.md'`,
    ],
  ];
  child.blocks = commands.flatMap(([toolUseId, toolName, command]) => [
    {
      type: 'tool_use',
      toolUseId,
      toolName,
      input: JSON.stringify({ command }),
    },
    {
      type: 'tool_result',
      toolUseId,
      toolName,
      output: 'Command completed.',
      isError: false,
    },
  ]);
  return messages;
}
