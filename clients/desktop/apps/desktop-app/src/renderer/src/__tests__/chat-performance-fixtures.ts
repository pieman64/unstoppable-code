import type { ChatBlock, ChatMessage } from '@/stores/chatStore';

export interface BuildLongChatMessagesOptions {
  turns: number;
  toolsPerTurn: number;
  includeSubagents?: boolean;
  commandOutputChars?: number;
}

function textBlock(text: string): ChatBlock {
  return { type: 'text', text };
}

function toolUseBlock(
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
): ChatBlock {
  return {
    type: 'tool_use',
    toolUseId,
    toolName,
    input: JSON.stringify(input),
  };
}

function toolResultBlock(
  toolUseId: string,
  toolName: string,
  output: string,
  isError: boolean,
): ChatBlock {
  return {
    type: 'tool_result',
    toolUseId,
    toolName,
    output,
    isError,
  };
}

export function buildLongChatMessages(
  options: BuildLongChatMessagesOptions,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const includeSubagents = options.includeSubagents === true;
  let timestamp = 1_710_000_000_000;

  for (let turnIndex = 0; turnIndex < options.turns; turnIndex += 1) {
    const userId = `user-${String(turnIndex)}`;
    const timerId = `timer-${String(turnIndex)}`;
    const assistantId = `assistant-${String(turnIndex)}`;
    const primaryAgentToolUseId = `agent-${String(turnIndex)}-0`;
    const assistantBlocks: ChatBlock[] = [];

    messages.push({
      id: userId,
      role: 'user',
      blocks: [textBlock(`Question ${String(turnIndex)}`)],
      timestamp,
    });
    timestamp += 1;

    messages.push({
      id: timerId,
      role: 'system',
      blocks: [
        {
          type: 'turn_timer',
          startedAt: timestamp,
          completedAt: timestamp + 1,
        },
      ],
      timestamp,
    });
    timestamp += 1;

    for (let toolIndex = 0; toolIndex < options.toolsPerTurn; toolIndex += 1) {
      const toolUseId =
        includeSubagents && toolIndex === 0
          ? primaryAgentToolUseId
          : `tool-${String(turnIndex)}-${String(toolIndex)}`;
      const toolName = includeSubagents && toolIndex === 0 ? 'Agent' : 'Bash';
      const toolInput =
        includeSubagents && toolIndex === 0
          ? {
              subagent_type: 'worker',
              description: `Handle turn ${String(turnIndex)}`,
              prompt: `Investigate turn ${String(turnIndex)}`,
            }
          : {
              command: `echo turn-${String(turnIndex)}-tool-${String(toolIndex)}`,
            };
      const toolOutput =
        turnIndex === 0 &&
        toolIndex === options.toolsPerTurn - 1 &&
        options.commandOutputChars !== undefined
          ? 'x'.repeat(options.commandOutputChars)
          : includeSubagents && toolIndex === 0
            ? `agentId: subagent-${String(turnIndex)}`
            : `output-${String(turnIndex)}-${String(toolIndex)}`;

      assistantBlocks.push(toolUseBlock(toolUseId, toolName, toolInput));
      assistantBlocks.push(
        toolResultBlock(toolUseId, toolName, toolOutput, false),
      );
    }

    assistantBlocks.push(textBlock(`Answer ${String(turnIndex)}`));

    messages.push({
      id: assistantId,
      role: 'assistant',
      blocks: assistantBlocks,
      timestamp,
    });
    timestamp += 1;

    if (includeSubagents) {
      const subToolUseId = `subagent-tool-${String(turnIndex)}`;
      messages.push({
        id: `subagent-${String(turnIndex)}`,
        role: 'assistant',
        parentToolUseId: primaryAgentToolUseId,
        blocks: [
          { type: 'thinking', text: `Working on turn ${String(turnIndex)}` },
          toolUseBlock(subToolUseId, 'Bash', {
            command: `printf subagent-${String(turnIndex)}`,
          }),
          toolResultBlock(
            subToolUseId,
            'Bash',
            `subagent-output-${String(turnIndex)}`,
            false,
          ),
          textBlock(`Subagent completed ${String(turnIndex)}`),
        ],
        timestamp,
      });
      timestamp += 1;
    }
  }

  return messages;
}
