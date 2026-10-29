/** @jest-environment jsdom */

/**
 * Which chats a window shows, from a plain sources snapshot: panel groups
 * (split, collapsed, maximized), the Code and Cowork pages, page switches,
 * the Pipeline Assistant drawer, App Advisor's grid and floating layout, and
 * pulled-out panel windows.
 */
import type {
  PanelGroupModel,
  PanelLayoutViewModel,
} from '@canopy/ui-shared/panels';
import {
  computeFocusedChats,
  layoutFocusedChatIds,
  type ChatInterestSources,
} from '../focused-chats';

const KEY = 'proj/wt';

function group(
  groupId: string,
  chatIds: readonly string[],
  active: string | null = chatIds[0] ?? null,
  options: { collapsed?: boolean; activeKind?: string } = {},
): PanelGroupModel {
  return {
    groupId,
    tabs: [
      ...chatIds.map((chatId) => ({
        panelId: `panel-chat-${chatId}`,
        kind: 'chat',
        title: chatId,
        instance: { chatTabId: chatId },
      })),
      { panelId: `panel-terminal-${groupId}`, kind: 'terminal', title: 't' },
    ],
    activePanelId:
      options.activeKind === 'terminal'
        ? `panel-terminal-${groupId}`
        : active === null
          ? null
          : `panel-chat-${active}`,
    ...(options.collapsed ? { collapsed: { edge: 'right' as const } } : {}),
  };
}

function layout(
  groups: readonly PanelGroupModel[],
  maximizedGroupId: string | null = null,
): PanelLayoutViewModel {
  return {
    groups,
    activeGroupId: groups[0]?.groupId ?? null,
    maximizedGroupId,
  };
}

function sources(
  overrides: Partial<ChatInterestSources> & {
    layouts?: Record<string, PanelLayoutViewModel>;
    activeTabs?: Record<string, string>;
  } = {},
): ChatInterestSources {
  const { layouts = {}, activeTabs = {}, ...rest } = overrides;
  return {
    surface: 'main',
    activePage: 'main',
    settingsOpen: false,
    selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
    workEntry: { projectId: 'standalone-chat', workEntryId: null },
    pipelineAssistantOpen: false,
    appAdvisorFloating: false,
    auxLayouts: [],
    layoutViewModel: (layoutKey) => layouts[layoutKey] ?? null,
    activeChatTabId: (scopeKey) => activeTabs[scopeKey] ?? null,
    ...rest,
  };
}

function chatIds(input: ChatInterestSources): string[] {
  return computeFocusedChats(input).map(
    (ref) => `${ref.projectId}/${ref.worktreeId}/${ref.chatId}`,
  );
}

describe('layoutFocusedChatIds', () => {
  it('returns the active chat of a single group', () => {
    expect(
      layoutFocusedChatIds(layout([group('g1', ['a', 'b'], 'b')])),
    ).toEqual(['b']);
  });

  it('returns the active chat of every group in a split', () => {
    expect(
      layoutFocusedChatIds(layout([group('g1', ['a']), group('g2', ['b'])])),
    ).toEqual(['a', 'b']);
  });

  it('skips collapsed groups and groups whose active tab is not a chat', () => {
    expect(
      layoutFocusedChatIds(
        layout([
          group('g1', ['a'], 'a', { collapsed: true }),
          group('g2', ['b'], 'b', { activeKind: 'terminal' }),
          group('g3', ['c']),
        ]),
      ),
    ).toEqual(['c']);
  });

  it('shows only the maximized group', () => {
    expect(
      layoutFocusedChatIds(
        layout([group('g1', ['a']), group('g2', ['b'])], 'g2'),
      ),
    ).toEqual(['b']);
  });
});

describe('computeFocusedChats', () => {
  it('reads the selected worktree layout on the Code and Kanban pages', () => {
    const layouts = { [KEY]: layout([group('g1', ['a']), group('g2', ['b'])]) };
    expect(chatIds(sources({ layouts }))).toEqual(['proj/wt/a', 'proj/wt/b']);
    expect(chatIds(sources({ layouts, activePage: 'kanban' }))).toEqual([
      'proj/wt/a',
      'proj/wt/b',
    ]);
  });

  it('shows no worktree chat on other pages or while Settings is open', () => {
    const layouts = { [KEY]: layout([group('g1', ['a'])]) };
    expect(chatIds(sources({ layouts, activePage: 'overview' }))).toEqual([]);
    expect(chatIds(sources({ layouts, settingsOpen: true }))).toEqual([]);
  });

  it('ignores a Cowork selection on the Code page', () => {
    const layouts = { 'standalone-chat/entry-1': layout([group('g', ['c'])]) };
    expect(
      chatIds(
        sources({
          layouts,
          selectedWorktree: {
            projectId: 'standalone-chat',
            worktreeId: 'entry-1',
          },
        }),
      ),
    ).toEqual([]);
  });

  it('reads the active work entry layout on the Cowork page', () => {
    const layouts = {
      [KEY]: layout([group('g1', ['a'])]),
      'standalone-chat/entry-1': layout([group('g', ['c'])]),
    };
    expect(
      chatIds(
        sources({
          layouts,
          activePage: 'chat',
          workEntry: { projectId: 'standalone-chat', workEntryId: 'entry-1' },
        }),
      ),
    ).toEqual(['standalone-chat/entry-1/c']);
    expect(chatIds(sources({ layouts, activePage: 'chat' }))).toEqual([]);
  });

  it('shows the Pipeline Assistant chat while its drawer is open', () => {
    const activeTabs = { 'pipeline-editor/pipeline-editor': 'assistant' };
    expect(
      chatIds(
        sources({
          activeTabs,
          activePage: 'workflows-library',
          pipelineAssistantOpen: true,
        }),
      ),
    ).toEqual(['pipeline-editor/pipeline-editor/assistant']);
    expect(
      chatIds(sources({ activeTabs, activePage: 'workflows-library' })),
    ).toEqual([]);
  });

  it('adds pulled-out windows regardless of page and selection', () => {
    const auxKey = `${KEY}#aux:w1`;
    const layouts = {
      [KEY]: layout([group('g1', ['a'])]),
      [auxKey]: layout([group('ga', ['x'])]),
    };
    const auxLayouts = [{ worktreeKey: KEY, layoutKey: auxKey }];
    expect(chatIds(sources({ layouts, auxLayouts }))).toEqual([
      'proj/wt/a',
      'proj/wt/x',
    ]);
    expect(
      chatIds(
        sources({
          layouts,
          auxLayouts,
          activePage: 'overview',
          selectedWorktree: null,
          settingsOpen: true,
        }),
      ),
    ).toEqual(['proj/wt/x']);
  });

  it('reads App Advisor grid or its floating chat, never the pages', () => {
    const entryKey = 'app-advisor/entry-1';
    const base = {
      surface: 'app-advisor' as const,
      activePage: 'overview' as const,
      workEntry: { projectId: 'app-advisor', workEntryId: 'entry-1' },
      layouts: {
        [KEY]: layout([group('g1', ['a'])]),
        [entryKey]: layout([group('g', ['p']), group('h', ['q'])]),
      },
      activeTabs: { [entryKey]: 'q' },
    };
    expect(chatIds(sources(base))).toEqual([
      'app-advisor/entry-1/p',
      'app-advisor/entry-1/q',
    ]);
    expect(chatIds(sources({ ...base, appAdvisorFloating: true }))).toEqual([
      'app-advisor/entry-1/q',
    ]);
  });
});
