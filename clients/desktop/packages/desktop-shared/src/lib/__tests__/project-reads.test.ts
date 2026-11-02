import type { ChatAgentSentInfo } from '@canopy/protocol/portal';
import {
  PROJECT_READ_ACTION_TYPES,
  PROJECT_READ_MESSAGE_MAX_CHARS,
  PROJECT_READ_PAGE_SIZE_DEFAULT,
  PROJECT_READ_PAGE_SIZE_MAX,
  isProjectReadActionType,
  parseProjectReadAction,
  projectReadActionSchema,
} from '../project-reads';
import type { HistoryResult, VisibleMessage } from '../project-reads';
import type { PageResult } from '../project-discovery';
import {
  PROJECT_DISCOVERY_CURSOR_MAX,
  PROJECT_DISCOVERY_ID_MAX,
} from '../project-discovery';

const address = { projectId: 'project', taskId: 'task', chatId: 'chat' };
const history = { type: 'projects.read_history', ...address };

describe('project read contracts', () => {
  it('exports action types and bounded constants', () => {
    expect(PROJECT_READ_ACTION_TYPES).toEqual([
      'projects.get_last_user_message',
      'projects.get_last_agent_response',
      'projects.read_history',
    ]);
    expect(PROJECT_READ_PAGE_SIZE_DEFAULT).toBe(20);
    expect(PROJECT_READ_PAGE_SIZE_MAX).toBe(100);
    expect(PROJECT_READ_MESSAGE_MAX_CHARS).toBe(8000);
  });
  it.each(PROJECT_READ_ACTION_TYPES)(
    'accepts %s and only applies history defaults',
    (type) => {
      const action = { type, ...address };
      expect(parseProjectReadAction(action)).toEqual({
        ok: true,
        action:
          type === 'projects.read_history'
            ? { ...action, pageSize: 20, order: 'desc' }
            : action,
      });
      expect(isProjectReadActionType(type)).toBe(true);
    },
  );
  it('trims opaque IDs and query without rewriting cursor bytes', () => {
    expect(
      projectReadActionSchema.parse({
        ...history,
        projectId: ' project ',
        taskId: ' task ',
        chatId: ' chat ',
        query: ' Hello ',
        roles: ['assistant', 'user'],
        cursor: ' opaque ',
        pageSize: 100,
        order: 'asc',
      }),
    ).toEqual({
      ...history,
      query: 'Hello',
      roles: ['assistant', 'user'],
      cursor: ' opaque ',
      pageSize: 100,
      order: 'asc',
    });
  });
  it.each(['projectId', 'taskId', 'chatId'] as const)(
    'shares discovery bounds for %s',
    (key) => {
      for (const type of PROJECT_READ_ACTION_TYPES) {
        for (const value of [
          '',
          '   ',
          'x'.repeat(PROJECT_DISCOVERY_ID_MAX + 1),
          1,
          null,
        ]) {
          expect(
            parseProjectReadAction({ type, ...address, [key]: value }).ok,
          ).toBe(false);
        }
        expect(
          parseProjectReadAction({
            type,
            ...address,
            [key]: 'X:/opaque'.padEnd(PROJECT_DISCOVERY_ID_MAX, 'x'),
          }).ok,
        ).toBe(true);
        expect(address[key]).toBeDefined();
        const missing = Object.fromEntries(
          Object.entries(address).filter(([addressKey]) => addressKey !== key),
        );
        expect(parseProjectReadAction({ type, ...missing }).ok).toBe(false);
      }
    },
  );
  it.each([
    'unexpected',
    'expectedRevision',
    'worktreeId',
    'tabId',
    'sessionId',
    'projectPath',
    'owner',
    'hiddenContext',
  ])('rejects unknown/UI field %s on every action', (key) => {
    for (const type of PROJECT_READ_ACTION_TYPES)
      expect(
        parseProjectReadAction({ type, ...address, [key]: 'not allowed' }).ok,
      ).toBe(false);
  });
  it.each(['', '   ', 'x'.repeat(501), 1])(
    'rejects invalid query %p',
    (query) => {
      expect(parseProjectReadAction({ ...history, query }).ok).toBe(false);
    },
  );
  it.each([
    [],
    ['user', 'user'],
    ['assistant', 'assistant'],
    ['system'],
    ['user', 'invalid'],
    'user',
  ])('rejects invalid roles %p', (roles) => {
    expect(parseProjectReadAction({ ...history, roles }).ok).toBe(false);
  });
  it.each([0, 101, 1.5, '20', null])(
    'rejects invalid page size %p',
    (pageSize) => {
      expect(parseProjectReadAction({ ...history, pageSize }).ok).toBe(false);
    },
  );
  it.each(['', '  ', 'x'.repeat(PROJECT_DISCOVERY_CURSOR_MAX + 1), 1, null])(
    'rejects invalid cursor %p',
    (cursor) => {
      expect(parseProjectReadAction({ ...history, cursor }).ok).toBe(false);
    },
  );
  it.each([1, 100])(
    'accepts page size boundary %i and query/cursor boundaries',
    (pageSize) => {
      expect(
        parseProjectReadAction({
          ...history,
          pageSize,
          query: 'x'.repeat(500),
          cursor: 'x'.repeat(PROJECT_DISCOVERY_CURSOR_MAX),
          roles: ['user'],
        }).ok,
      ).toBe(true);
      expect(
        parseProjectReadAction({ ...history, query: 'x', roles: ['assistant'] })
          .ok,
      ).toBe(true);
    },
  );
  it('rejects non-actions, unknown discriminants, unsupported order and history-only last-message fields', () => {
    for (const value of [
      null,
      {},
      [],
      'projects.read_history',
      { ...history, type: 'projects.other' },
      { ...history, order: 'newest' },
    ])
      expect(parseProjectReadAction(value).ok).toBe(false);
    for (const type of PROJECT_READ_ACTION_TYPES.slice(0, 2)) {
      for (const field of ['query', 'roles', 'pageSize', 'cursor', 'order'])
        expect(
          parseProjectReadAction({ type, ...address, [field]: 'no' }).ok,
        ).toBe(false);
    }
    expect(isProjectReadActionType('projects.list')).toBe(false);
    expect(isProjectReadActionType('projects.read_history.extra')).toBe(false);
    const rejected = parseProjectReadAction({ ...history, pageSize: 0 });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.message).toMatch(/^pageSize:/);
  });
  it('allows bounded-history nullable totals without widening discovery totals', () => {
    const bounded: HistoryResult = {
      items: [],
      returned: 0,
      totalMatches: null,
      totalMessages: null,
      countsExact: false,
      nextCursor: 'continue',
      generatedAt: 'now',
      revision: 'revision',
      address,
    };
    const exact: PageResult<string> = {
      items: [],
      returned: 0,
      totalMatches: 0,
      nextCursor: null,
      generatedAt: 'now',
      revision: 'revision',
    };
    expect(bounded.totalMatches).toBeNull();
    expect(exact.totalMatches).toBe(0);
  });

  it('keeps agent-sent attribution optional on visible read DTOs', () => {
    const agentSent = {
      sender: {
        kind: 'bot',
        botId: 'app_advisor',
        taskId: 'advisor-task',
        chatId: 'advisor-chat',
      },
      chatTitle: 'Weekly summary',
      projectLabel: 'App Advisor',
    } satisfies ChatAgentSentInfo;
    const marked: VisibleMessage = {
      messageId: 'marked-message',
      role: 'user',
      text: 'A message from another agent.',
      truncated: false,
      agentSent,
    };
    const legacy: VisibleMessage = {
      messageId: 'legacy-message',
      role: 'user',
      text: 'A message from an older row.',
      truncated: false,
    };

    expect(marked.agentSent).toEqual(agentSent);
    expect(legacy.agentSent).toBeUndefined();
  });
});
