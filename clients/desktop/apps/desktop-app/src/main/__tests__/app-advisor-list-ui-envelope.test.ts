import type { AppAdvisorUiStateEnvelope } from '@canopy/desktop-shared/types';
import { withAppAdvisorListUiEnvelope } from '../app-advisor/list-ui-envelope';

function state(): AppAdvisorUiStateEnvelope {
  return {
    version: 1,
    revision: 12,
    capturedAt: '2026-10-18T00:00:00.000Z',
    digest: 'digest',
    snapshot: {
      activePage: 'main',
      archivedContainers: { count: 0, viewerOpen: false },
      overlays: {
        commandPaletteOpen: false,
        fileSearchPaletteOpen: false,
        prPickerOpen: false,
        canopyPortalOpen: false,
        appAdvisorOpen: true,
      },
      selectedWorktree: { projectId: 'project', worktreeId: 'task' },
      activeChat: { chatId: 'chat' },
      appAdvisor: {
        activeWorkEntryId: 'advisor-entry',
        activeChatId: 'advisor-chat',
      },
    },
  };
}

describe('withAppAdvisorListUiEnvelope', () => {
  it('joins full addresses and serializes keys in canonical order', () => {
    const selected = { chatId: 'chat', taskId: 'task', projectId: 'project' };
    const response = {
      ok: true,
      result: {
        items: [
          selected,
          { ...selected, taskId: 'other' },
          { ...selected, projectId: 'other' },
        ],
        revision: 'canonical',
        nextCursor: 'next',
        returned: 3,
        totalMatches: 5,
      },
    };
    expect(
      withAppAdvisorListUiEnvelope(
        'projects.list_task_chats',
        response,
        state(),
      ),
    ).toEqual({
      ...response,
      result: {
        ...response.result,
        ui: {
          revision: 12,
          selection: { projectId: 'project', taskId: 'task', chatId: 'chat' },
          items: {
            '{"projectId":"project","taskId":"task","chatId":"chat"}': {
              selected: true,
            },
          },
        },
      },
    });
    expect(response.result).not.toHaveProperty('ui');
  });

  it('does not confuse the main selection with the Advisor selection or public bot id', () => {
    const response = {
      ok: true,
      result: {
        items: [
          {
            botId: 'app_advisor',
            taskId: 'advisor-entry',
            chatId: 'advisor-chat',
          },
          { botId: 'app_advisor', taskId: 'other', chatId: 'advisor-chat' },
          {
            botId: 'app-advisor',
            taskId: 'advisor-entry',
            chatId: 'advisor-chat',
          },
        ],
      },
    };
    expect(
      withAppAdvisorListUiEnvelope('bots.list_task_chats', response, state())
        .result,
    ).toEqual(
      expect.objectContaining({
        ui: {
          revision: 12,
          selection: {
            botId: 'app_advisor',
            taskId: 'advisor-entry',
            chatId: 'advisor-chat',
          },
          items: {
            '{"botId":"app_advisor","taskId":"advisor-entry","chatId":"advisor-chat"}':
              { selected: true },
          },
        },
      }),
    );
  });

  it('retains off-page selection but annotates only the returned authorized page', () => {
    expect(
      withAppAdvisorListUiEnvelope(
        'projects.list',
        { ok: true, result: { items: [{ projectId: 'other' }] } },
        state(),
      ).result,
    ).toEqual(
      expect.objectContaining({
        ui: {
          revision: 12,
          selection: { projectId: 'project', taskId: 'task', chatId: 'chat' },
          items: {},
        },
      }),
    );
  });

  it('omits absent main IDs without borrowing Advisor IDs', () => {
    const envelope = state();
    delete envelope.snapshot.selectedWorktree;
    delete envelope.snapshot.activeChat;
    expect(
      withAppAdvisorListUiEnvelope(
        'projects.list',
        { ok: true, result: { items: [{ projectId: 'project' }] } },
        envelope,
      ).result,
    ).toEqual(
      expect.objectContaining({
        ui: { revision: 12, selection: {}, items: {} },
      }),
    );
  });

  it('omits null or absent Advisor IDs without borrowing main IDs', () => {
    const envelope = state();
    envelope.snapshot.appAdvisor = {
      activeWorkEntryId: null,
      activeChatId: null,
    };
    expect(
      withAppAdvisorListUiEnvelope(
        'bots.list',
        { ok: true, result: { items: [{ botId: 'app_advisor' }] } },
        envelope,
      ).result,
    ).toEqual(
      expect.objectContaining({
        ui: {
          revision: 12,
          selection: { botId: 'app_advisor' },
          items: { '{"botId":"app_advisor"}': { selected: true } },
        },
      }),
    );
    delete envelope.snapshot.appAdvisor;
    expect(
      withAppAdvisorListUiEnvelope(
        'bots.list_tasks',
        {
          ok: true,
          result: { items: [{ botId: 'app_advisor', taskId: 'task' }] },
        },
        envelope,
      ).result,
    ).toEqual(
      expect.objectContaining({
        ui: { revision: 12, selection: { botId: 'app_advisor' }, items: {} },
      }),
    );
  });

  it.each([undefined, { ...state(), revision: 0 }])(
    'uses the empty fallback for %p',
    (envelope) => {
      expect(
        withAppAdvisorListUiEnvelope(
          'bots.list',
          { ok: true, result: { items: [{ botId: 'app_advisor' }] } },
          envelope,
        ).result,
      ).toEqual(
        expect.objectContaining({
          ui: { revision: 0, selection: {}, items: {} },
        }),
      );
    },
  );

  it('returns errors unchanged, even when they contain a result', () => {
    const failure = {
      ok: false as const,
      result: { items: [] },
      error: { code: 'not_found' as const, message: 'missing' },
    };
    expect(
      withAppAdvisorListUiEnvelope('projects.list', failure, state()),
    ).toBe(failure);
  });
});
