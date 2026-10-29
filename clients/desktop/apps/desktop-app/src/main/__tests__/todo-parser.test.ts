import {
  applyTaskUpdateItem,
  parseTaskCreateItem,
  parseTodoItems,
} from '@canopy/desktop-shared/todo-parser';

describe('parseTodoItems', () => {
  it('parses valid todo items with ids', () => {
    const input = JSON.stringify({
      todos: [
        { id: '1', content: 'Read config', status: 'completed' },
        { id: '2', content: 'Update handler', status: 'in_progress' },
        { id: '3', content: 'Write tests', status: 'pending' },
      ],
    });
    const result = parseTodoItems(input);
    expect(result).toEqual([
      { id: '1', content: 'Read config', status: 'completed' },
      { id: '2', content: 'Update handler', status: 'in_progress' },
      { id: '3', content: 'Write tests', status: 'pending' },
    ]);
  });

  it('parses items without ids (SDK format) and assigns index-based ids', () => {
    const input = JSON.stringify({
      todos: [
        {
          content: 'Validate input',
          activeForm: 'Validating',
          status: 'in_progress',
        },
        { content: 'Run migrations', activeForm: 'Running', status: 'pending' },
      ],
    });
    const result = parseTodoItems(input);
    expect(result).toEqual([
      { id: '_idx:0', content: 'Validate input', status: 'in_progress' },
      { id: '_idx:1', content: 'Run migrations', status: 'pending' },
    ]);
  });

  it('returns empty array for invalid JSON', () => {
    expect(parseTodoItems('not json')).toEqual([]);
  });

  it('returns empty array when todos is not an array', () => {
    expect(parseTodoItems(JSON.stringify({ todos: 'nope' }))).toEqual([]);
  });

  it('returns empty array when input has no todos key', () => {
    expect(parseTodoItems(JSON.stringify({ other: [] }))).toEqual([]);
  });

  it('filters out items with missing required fields', () => {
    const input = JSON.stringify({
      todos: [
        { id: '1', content: 'Valid', status: 'pending' },
        { id: '2', status: 'pending' },
        { content: 'No id is ok', status: 'pending' },
        { id: '4', content: 'No status' },
        { id: '5', content: 'Bad status', status: 'unknown' },
        null,
        42,
      ],
    });
    const result = parseTodoItems(input);
    expect(result).toEqual([
      { id: '1', content: 'Valid', status: 'pending' },
      { id: '_idx:1', content: 'No id is ok', status: 'pending' },
    ]);
  });

  it('returns empty array for empty todos array', () => {
    expect(parseTodoItems(JSON.stringify({ todos: [] }))).toEqual([]);
  });

  it('parses TaskCreate input into a prefixed todo item', () => {
    const input = JSON.stringify({
      subject: 'Task 1: Add settings',
      description: 'Wire settings through the app',
      activeForm: 'Adding settings',
    });

    expect(parseTaskCreateItem(input, '1')).toEqual({
      id: 'task:1',
      content: 'Task 1: Add settings',
      status: 'pending',
    });
  });

  it('applies TaskUpdate status changes without replacing other items', () => {
    const items = [
      { id: 'task:1', content: 'First task', status: 'pending' as const },
      { id: 'task:2', content: 'Second task', status: 'pending' as const },
    ];

    expect(
      applyTaskUpdateItem(
        items,
        JSON.stringify({ taskId: '2', status: 'completed' }),
      ),
    ).toEqual([
      { id: 'task:1', content: 'First task', status: 'pending' },
      { id: 'task:2', content: 'Second task', status: 'completed' },
    ]);
  });
});
