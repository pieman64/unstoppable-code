import {
  APP_ADVISOR_BOT_ID,
  BOT_ACTION_TYPES,
  isBotActionType,
  parseBotAction,
} from '../bot-discovery';
import {
  PROJECT_DISCOVERY_PAGE_SIZE_DEFAULT,
  PROJECT_DISCOVERY_PAGE_SIZE_MAX,
} from '../project-discovery';
import { PROJECT_READ_PAGE_SIZE_DEFAULT } from '../project-reads';

const address = { botId: APP_ADVISOR_BOT_ID, taskId: 'task', chatId: 'chat' };

function parsed(value: unknown): unknown {
  const result = parseBotAction(value);
  if (!result.ok) throw new Error(result.message);
  return result.action;
}

function message(value: unknown): string {
  const result = parseBotAction(value);
  if (result.ok) throw new Error('Expected a parse failure');
  return result.message;
}

describe('bot discovery contracts', () => {
  it('exports the six bot action types and the public App Advisor bot ID', () => {
    expect(BOT_ACTION_TYPES).toEqual([
      'bots.list',
      'bots.list_tasks',
      'bots.list_task_chats',
      'bots.get_last_user_message',
      'bots.get_last_agent_response',
      'bots.read_history',
    ]);
    expect(APP_ADVISOR_BOT_ID).toBe('app_advisor');
    expect(BOT_ACTION_TYPES.every(isBotActionType)).toBe(true);
    expect(isBotActionType('projects.list')).toBe(false);
  });

  it('defaults bots.list to name order and validates its filters', () => {
    expect(parsed({ type: 'bots.list' })).toEqual({
      type: 'bots.list',
      pageSize: PROJECT_DISCOVERY_PAGE_SIZE_DEFAULT,
      sort: 'name',
      order: 'asc',
    });
    expect(
      parsed({
        type: 'bots.list',
        botIds: ['app_advisor'],
        availability: ['available'],
        order: 'desc',
      }),
    ).toMatchObject({ botIds: ['app_advisor'], availability: ['available'] });
    expect(message({ type: 'bots.list', botIds: ['a', 'a'] })).toMatch(
      /^botIds: /,
    );
    expect(message({ type: 'bots.list', sort: 'created_at' })).toMatch(
      /^sort: /,
    );
    expect(
      message({
        type: 'bots.list',
        pageSize: PROJECT_DISCOVERY_PAGE_SIZE_MAX + 1,
      }),
    ).toMatch(/^pageSize: /);
  });

  it('takes a botId instead of a projectId and has no branch filter for tasks', () => {
    expect(
      parsed({ type: 'bots.list_tasks', botId: ' app_advisor ', pinned: true }),
    ).toEqual({
      type: 'bots.list_tasks',
      botId: 'app_advisor',
      pinned: true,
      pageSize: PROJECT_DISCOVERY_PAGE_SIZE_DEFAULT,
      retentionStates: ['retained'],
      sort: 'last_activity',
      order: 'desc',
    });
    expect(message({ type: 'bots.list_tasks' })).toMatch(/^botId: /);
    expect(
      parseBotAction({ type: 'bots.list_tasks', ...address, projectId: 'p' })
        .ok,
    ).toBe(false);
    expect(
      parseBotAction({
        type: 'bots.list_tasks',
        botId: 'app_advisor',
        branchName: 'main',
      }).ok,
    ).toBe(false);
  });

  it('lists chats for one or every bot task', () => {
    expect(
      parsed({ type: 'bots.list_task_chats', botId: 'app_advisor' }),
    ).toMatchObject({ type: 'bots.list_task_chats', botId: 'app_advisor' });
    expect(
      parsed({
        type: 'bots.list_task_chats',
        botId: 'app_advisor',
        taskId: 'task',
        includeLastUserMessage: true,
      }),
    ).toMatchObject({ taskId: 'task', includeLastUserMessage: true });
    expect(
      parseBotAction({
        type: 'bots.list_task_chats',
        botId: 'app_advisor',
        projectId: 'p',
      }).ok,
    ).toBe(false);
  });

  it('reads an explicit bot chat address with the project read defaults', () => {
    expect(parsed({ type: 'bots.get_last_user_message', ...address })).toEqual({
      type: 'bots.get_last_user_message',
      ...address,
    });
    expect(
      parsed({ type: 'bots.get_last_agent_response', ...address }),
    ).toEqual({ type: 'bots.get_last_agent_response', ...address });
    expect(parsed({ type: 'bots.read_history', ...address })).toEqual({
      type: 'bots.read_history',
      ...address,
      pageSize: PROJECT_READ_PAGE_SIZE_DEFAULT,
      order: 'desc',
    });
    expect(
      message({ type: 'bots.read_history', botId: 'app_advisor' }),
    ).toMatch(/^taskId: /);
    expect(
      parseBotAction({
        type: 'bots.read_history',
        ...address,
        projectId: 'project',
      }).ok,
    ).toBe(false);
  });

  it('rejects non-bot actions', () => {
    expect(message({ type: 'projects.list' })).toMatch(/^type: /);
  });
});
