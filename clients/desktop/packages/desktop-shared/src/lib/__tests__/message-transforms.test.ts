import type {
  PersistedChatBlock,
  PersistedChatMessage,
} from '@canopy/agent-transcript/types';
import { reorderMessagesForDisplay } from '../message-transforms';
import {
  groupIntoTurns,
  type TurnBlock,
  type TurnMessage,
} from '../turn-utils';

function message(
  id: string,
  role: PersistedChatMessage['role'],
  blocks: PersistedChatBlock[],
): PersistedChatMessage {
  return { id, role, blocks, timestamp: 1 };
}

function toolCall(
  toolUseId: string,
  toolName: string,
  input: object,
): PersistedChatMessage {
  return message(`a-${toolUseId}`, 'assistant', [
    { type: 'tool_use', toolUseId, toolName, input: JSON.stringify(input) },
  ]);
}

function timer(
  id: string,
  turnId: string,
  fields: {
    userMessageId?: string;
    spawnedBy?: {
      taskId?: string;
      toolUseId?: string;
      event?: true;
      scheduled?: true;
      toolsLoaded?: true;
    };
    completedAt?: number | null;
  },
): PersistedChatMessage {
  return message(id, 'system', [
    { type: 'turn_timer', turnId, startedAt: 1, completedAt: 2, ...fields },
  ]);
}

/** Each turn as [head id, its timer id], and a standalone row as its id. */
function toTurnMessages(
  messages: PersistedChatMessage[],
  preserveTimer = false,
  alreadyReordered = false,
): TurnMessage[] {
  return (
    alreadyReordered ? messages : reorderMessagesForDisplay(messages)
  ).map((message) => ({
    id: message.id,
    role: message.role,
    timestamp: message.timestamp,
    blocks: message.blocks.map((block): TurnBlock => {
      switch (block.type) {
        case 'text':
          return block;
        case 'tool_use':
          return {
            type: 'tool_use',
            toolUseId: block.toolUseId,
            toolName: block.toolName,
            input: block.input,
          };
        case 'turn_timer':
          if (preserveTimer) return block;
          return {
            type: 'turn_timer',
            ...(block.startedAt !== undefined
              ? { startedAt: block.startedAt }
              : {}),
            completedAt: block.completedAt ?? null,
          };
        case 'wake_boundary':
          return block;
        default:
          throw new Error(
            `Unexpected persisted block for turn-shape fixture: ${block.type}`,
          );
      }
    }),
    ...(message.watcherFired ? { watcherFired: message.watcherFired } : {}),
    ...(message.agentSent ? { agentSent: message.agentSent } : {}),
    ...(message.userMessageSource
      ? { userMessageSource: message.userMessageSource }
      : {}),
  }));
}

function turnShape(
  messages: PersistedChatMessage[],
): Array<string | [string, string]> {
  return groupIntoTurns(toTurnMessages(messages)).map((group) =>
    group.kind === 'turn-group'
      ? [group.userMessage.id, group.timerMessage.id]
      : group.message.id,
  );
}

describe('reorderMessagesForDisplay event wakes', () => {
  const prompt = message('u1', 'user', [
    { type: 'text', text: 'watch the build and run the tests' },
  ]);
  const monitor = toolCall('tool-monitor', 'Monitor', {
    command: 'tail -f build.log',
    description: 'build log errors',
  });
  const bash = toolCall('tool-bash', 'Bash', {
    command: 'npm test',
    description: 'Run the tests',
  });
  const promptTimer = timer('t1', 'turn-1', { userMessageId: 'u1' });

  it('heads an event wake with its own turn, named from the Monitor call', () => {
    const result = reorderMessagesForDisplay([
      prompt,
      monitor,
      promptTimer,
      timer('t-event', 'event-turn', {
        spawnedBy: {
          taskId: 'task-monitor',
          toolUseId: 'tool-monitor',
          event: true,
        },
      }),
      message('a-event', 'assistant', [
        { type: 'text', text: 'The build logged an error.' },
      ]),
    ]);

    expect(result.map((m) => m.id)).toEqual([
      'u1',
      'a-tool-monitor',
      't1',
      't-event:wake',
      'a-event',
      't-event',
    ]);
    expect(result[3]?.blocks).toEqual([
      {
        type: 'wake_boundary',
        turnId: 'event-turn',
        taskLabel: 'build log errors',
        spawningUserMessageId: 'u1',
        spawningToolUseId: 'tool-monitor',
        taskEvent: true,
      },
    ]);
  });

  it('heads a cron fire with its own turn, named from the scheduled prompt', () => {
    const cron = toolCall('tool-cron', 'CronCreate', {
      cron: '0 9 * * *',
      prompt: 'Check the deploy\nand report back',
    });
    const result = reorderMessagesForDisplay([
      prompt,
      cron,
      promptTimer,
      timer('t-cron', 'cron-turn', {
        spawnedBy: { toolUseId: 'tool-cron', scheduled: true },
      }),
      message('a-cron', 'assistant', [{ type: 'text', text: 'Deployed.' }]),
    ]);

    expect(result.map((m) => m.id)).toEqual([
      'u1',
      'a-tool-cron',
      't1',
      't-cron:wake',
      'a-cron',
      't-cron',
    ]);
    expect(result[3]?.blocks).toEqual([
      {
        type: 'wake_boundary',
        turnId: 'cron-turn',
        taskLabel: 'Check the deploy',
        spawningUserMessageId: 'u1',
        spawningToolUseId: 'tool-cron',
        scheduled: true,
      },
    ]);
  });

  it("heads a tools-loaded continuation with its own turn, though it shares the prompt's anchor", () => {
    const load = toolCall('tool-load', 'mcp__canopy__LoadDeferredTools', {
      items: [{ ref: 'deferred:v1:slack' }],
    });
    // Storage order: each execution's timer is appended when it opens.
    const messages = [
      prompt,
      promptTimer,
      load,
      timer('t-resume', 'resume-turn', {
        userMessageId: 'u1',
        spawnedBy: { toolUseId: 'tool-load', toolsLoaded: true },
        completedAt: null,
      }),
      message('a-resume', 'assistant', [
        { type: 'text', text: 'Slack is loaded.' },
      ]),
    ];

    const result = reorderMessagesForDisplay(messages);
    expect(result.map((m) => m.id)).toEqual([
      'u1',
      'a-tool-load',
      't1',
      't-resume:wake',
      'a-resume',
      't-resume',
    ]);
    expect(result[3]?.blocks).toEqual([
      {
        type: 'wake_boundary',
        turnId: 'resume-turn',
        spawningUserMessageId: 'u1',
        spawningToolUseId: 'tool-load',
        toolsLoaded: true,
      },
    ]);
    const groups = groupIntoTurns(toTurnMessages(result, true, true));
    expect(
      groups.map((group) =>
        group.kind === 'turn-group'
          ? [group.userMessage.id, group.timerMessage.id, group.isComplete]
          : group.message.id,
      ),
    ).toEqual([
      ['u1', 't1', true],
      ['t-resume:wake', 't-resume', false],
    ]);
  });

  it('keeps a resumed execution of a tools-loaded continuation in the continuation turn', () => {
    // Stop and Resume after the reload: the resumed execution binds to the
    // prompt with no cause, and its output follows the continuation's.
    const messages = [
      prompt,
      promptTimer,
      toolCall('tool-load', 'mcp__canopy__LoadDeferredTools', {}),
      timer('t-resume', 'resume-turn', {
        userMessageId: 'u1',
        spawnedBy: { toolUseId: 'tool-load', toolsLoaded: true },
      }),
      message('a-stopped', 'assistant', [{ type: 'text', text: 'Working…' }]),
      timer('t-again', 'again-turn', {
        userMessageId: 'u1',
        completedAt: null,
      }),
      message('a-again', 'assistant', [{ type: 'text', text: 'Done.' }]),
    ];

    const groups = groupIntoTurns(toTurnMessages(messages, true));
    expect(
      groups.map((group) =>
        group.kind === 'turn-group'
          ? [
              group.userMessage.id,
              group.assistantMessages.map((m) => m.id),
              group.timerMessage.id,
              group.isComplete,
            ]
          : group.message.id,
      ),
    ).toEqual([
      ['u1', ['a-tool-load'], 't1', true],
      ['t-resume:wake', ['a-stopped', 'a-again'], 't-again', false],
      // The stopped execution's timer shows as its own row (40b).
      't-resume',
    ]);
  });

  it("links a tools-loaded continuation to its prompt when the load call's id is not the transcript's", () => {
    const result = reorderMessagesForDisplay([
      prompt,
      promptTimer,
      timer('t-resume', 'resume-turn', {
        userMessageId: 'u1',
        // The worktree MCP route names the call by its JSON-RPC request id.
        spawnedBy: { toolUseId: '3', toolsLoaded: true },
      }),
    ]);

    expect(result.find((m) => m.id === 't-resume:wake')?.blocks).toEqual([
      {
        type: 'wake_boundary',
        turnId: 'resume-turn',
        spawningUserMessageId: 'u1',
        toolsLoaded: true,
      },
    ]);
  });

  it('names no spawning call when the call is not in the transcript', () => {
    const result = reorderMessagesForDisplay([
      prompt,
      promptTimer,
      timer('t-event', 'event-turn', {
        spawnedBy: { taskId: 'task-1', toolUseId: 'missing', event: true },
      }),
    ]);

    expect(result.find((m) => m.id === 't-event:wake')?.blocks).toEqual([
      { type: 'wake_boundary', turnId: 'event-turn', taskEvent: true },
    ]);
  });

  it('closes a finished-task wake and the event wake after it each with its own single timer', () => {
    const messages = [
      prompt,
      monitor,
      bash,
      promptTimer,
      timer('t-done', 'done-turn', {
        spawnedBy: { taskId: 'task-bash', toolUseId: 'tool-bash' },
      }),
      message('a-done', 'assistant', [
        { type: 'text', text: 'The tests passed.' },
      ]),
      timer('t-event', 'event-turn', {
        spawnedBy: {
          taskId: 'task-monitor',
          toolUseId: 'tool-monitor',
          event: true,
        },
      }),
      message('a-event', 'assistant', [
        { type: 'text', text: 'The build logged an error.' },
      ]),
    ];

    expect(turnShape(messages)).toEqual([
      ['u1', 't1'],
      ['t-done:wake', 't-done'],
      ['t-event:wake', 't-event'],
    ]);
    const boundaries = reorderMessagesForDisplay(messages).flatMap((m) =>
      m.blocks[0]?.type === 'wake_boundary' ? [m.blocks[0]] : [],
    );
    expect(boundaries).toEqual([
      expect.objectContaining({
        taskLabel: 'Run the tests',
        spawningToolUseId: 'tool-bash',
      }),
      expect.objectContaining({
        taskLabel: 'build log errors',
        spawningToolUseId: 'tool-monitor',
        taskEvent: true,
      }),
    ]);
    expect(boundaries[0]).not.toHaveProperty('taskEvent');
  });

  it("keeps an uncaused timer in its turn rather than splitting the prompt's turn", () => {
    expect(
      turnShape([
        prompt,
        message('a1', 'assistant', [{ type: 'text', text: 'Done.' }]),
        timer('t-unbound', 'unbound-turn', {}),
      ]),
    ).toEqual([['u1', 't-unbound']]);
  });
});
