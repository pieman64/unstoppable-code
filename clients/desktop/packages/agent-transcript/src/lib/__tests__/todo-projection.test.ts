import { projectTodoItems, type PersistedChatMessage } from '../../index';

function assistantMessage(
  id: string,
  blocks: PersistedChatMessage['blocks'],
): PersistedChatMessage {
  return { id, role: 'assistant', blocks, timestamp: 1 };
}

function toolUse(
  toolUseId: string,
  toolName: string,
  input: unknown,
): PersistedChatMessage['blocks'][number] {
  return {
    type: 'tool_use',
    toolUseId,
    toolName,
    input: JSON.stringify(input),
  };
}

describe('projectTodoItems', () => {
  it('uses the last TodoWrite list', () => {
    const messages = [
      assistantMessage('first', [
        toolUse('todo-1', 'TodoWrite', {
          todos: [{ id: 'old', content: 'Old', status: 'pending' }],
        }),
      ]),
      assistantMessage('second', [
        toolUse('todo-2', 'TodoWrite', {
          todos: [{ id: 'new', content: 'New', status: 'completed' }],
        }),
      ]),
    ];

    expect(projectTodoItems(messages)).toEqual([
      { id: 'todo:new', content: 'New', status: 'completed' },
    ]);
  });

  it('folds TaskCreate and TaskUpdate independently of TodoWrite', () => {
    const messages = [
      assistantMessage('create', [
        toolUse('task-create', 'TaskCreate', {
          taskId: '7',
          subject: 'Investigate',
        }),
      ]),
      assistantMessage('update', [
        toolUse('task-update', 'TaskUpdate', {
          taskId: '7',
          subject: 'Ship fix',
          status: 'in_progress',
        }),
      ]),
    ];

    expect(projectTodoItems(messages)).toEqual([
      { id: 'task:7', content: 'Ship fix', status: 'in_progress' },
    ]);
  });

  it('namespaces TodoWrite ids so they cannot collide with task ids', () => {
    const messages = [
      assistantMessage('both', [
        toolUse('todo', 'TodoWrite', {
          todos: [{ id: 'task:1', content: 'Todo', status: 'pending' }],
        }),
        toolUse('task', 'TaskCreate', { taskId: '1', subject: 'Task' }),
      ]),
    ];

    expect(projectTodoItems(messages)).toEqual([
      { id: 'todo:task:1', content: 'Todo', status: 'pending' },
      { id: 'task:1', content: 'Task', status: 'pending' },
    ]);
  });

  it('returns an empty list for empty and malformed tool input', () => {
    expect(projectTodoItems([])).toEqual([]);
    expect(
      projectTodoItems([
        assistantMessage('malformed', [
          {
            type: 'tool_use',
            toolUseId: 'bad',
            toolName: 'TodoWrite',
            input: '{not json',
          },
          toolUse('invalid-task', 'TaskCreate', { status: 'pending' }),
        ]),
      ]),
    ).toEqual([]);
  });

  it('keeps projections isolated between chat transcripts', () => {
    const chatOne = [
      assistantMessage('one', [
        toolUse('todo-one', 'TodoWrite', {
          todos: [{ id: '1', content: 'One', status: 'pending' }],
        }),
      ]),
    ];
    const chatTwo = [
      assistantMessage('two', [
        toolUse('todo-two', 'TodoWrite', {
          todos: [{ id: '2', content: 'Two', status: 'completed' }],
        }),
      ]),
    ];

    expect(projectTodoItems(chatOne)).toEqual([
      { id: 'todo:1', content: 'One', status: 'pending' },
    ]);
    expect(projectTodoItems(chatTwo)).toEqual([
      { id: 'todo:2', content: 'Two', status: 'completed' },
    ]);
  });
});
