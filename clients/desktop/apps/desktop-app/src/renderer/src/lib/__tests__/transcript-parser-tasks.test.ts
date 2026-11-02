import type { ChatMessage } from '@/stores/chatStore';
import {
  applyClaudeTranscriptEvent,
  createEmptyTranscriptReducerState,
  deriveCurrentTaskTodosFromMessages,
  deriveCurrentTodosFromMessages,
} from '../transcript-parser';

function message(blocks: ChatMessage['blocks']): ChatMessage {
  return {
    id: `message-${Math.random()}`,
    role: 'assistant',
    blocks,
    timestamp: 1,
  };
}

describe('transcript task projection', () => {
  it('derives TodoWrite and TaskCreate state independently from messages', () => {
    const messages: ChatMessage[] = [
      message([
        {
          type: 'tool_use',
          toolUseId: 'todo-1',
          toolName: 'TodoWrite',
          input: JSON.stringify({
            todos: [
              {
                id: '1',
                content: 'Todo item',
                status: 'in_progress',
              },
            ],
          }),
        },
      ]),
      message([
        {
          type: 'tool_use',
          toolUseId: 'task-create-1',
          toolName: 'TaskCreate',
          input: JSON.stringify({
            subject: 'Task item',
            description: 'Created by TaskCreate',
          }),
        },
        {
          type: 'tool_use',
          toolUseId: 'task-update-1',
          toolName: 'TaskUpdate',
          input: JSON.stringify({ taskId: '1', status: 'completed' }),
        },
      ]),
    ];

    expect(deriveCurrentTodosFromMessages(messages)).toEqual([
      { id: '1', content: 'Todo item', status: 'in_progress' },
    ]);
    expect(deriveCurrentTaskTodosFromMessages(messages)).toEqual([
      { id: 'task:1', content: 'Task item', status: 'completed' },
    ]);
  });

  it('updates task-tool state while preserving TodoWrite state', () => {
    let nextId = 0;
    const createMessageId = (): string => {
      nextId += 1;
      return `message-${nextId}`;
    };

    const withTodo = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'todo-1',
              name: 'TodoWrite',
              input: {
                todos: [
                  {
                    id: 'todo-a',
                    content: 'Existing todo',
                    status: 'pending',
                  },
                ],
              },
            },
          ],
        },
      },
      { now: 1, createMessageId, childToolLiveness: { kind: 'unknown' } },
    );

    const withTask = applyClaudeTranscriptEvent(
      withTodo,
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'task-create-1',
              name: 'TaskCreate',
              input: {
                subject: 'Created task',
                description: 'Task details',
              },
            },
          ],
        },
      },
      { now: 2, createMessageId, childToolLiveness: { kind: 'unknown' } },
    );

    expect(withTask.currentTodos).toEqual([
      { id: 'todo-a', content: 'Existing todo', status: 'pending' },
    ]);
    expect(withTask.currentTaskTodos).toEqual([
      { id: 'task:1', content: 'Created task', status: 'pending' },
    ]);
  });
});
