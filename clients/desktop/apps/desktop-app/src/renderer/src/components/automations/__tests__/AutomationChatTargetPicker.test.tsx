/**
 * @jest-environment jsdom
 *
 * CAN-2937 — the "Existing chat" destination picker. Uses the repo's
 * createRoot + act jsdom convention; @testing-library/react is not installed.
 *
 * Covers every destination kind (code worktrees from the projects store,
 * cowork and App Advisor Work Entries from `workEntries.list`), the default
 * "New chat" option, the archived-tab exclusion that keeps a
 * guaranteed-failing destination out of the list, and the stale-target
 * explanation that blocks save.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  APP_ADVISOR_PROJECT_ID,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import { useProjectsStore } from '@/stores/projectsStore';
import { openAutomationRunDestination } from '../resolveAutomationRunDestination';
import { AutomationChatTargetPicker } from '../AutomationChatTargetPicker';

jest.mock('../resolveAutomationRunDestination', () => ({
  openAutomationRunDestination: jest.fn().mockResolvedValue({ ok: true }),
}));

const mockedOpenDestination = jest.mocked(openAutomationRunDestination);

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
  writable: true,
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const loadTabs = jest.fn();
const listWorkEntries = jest.fn();

function codeProject(): SidebarItem {
  const project = {
    id: 'ws-1',
    name: 'Canopy',
    type: 'single-repo',
    repoPath: '/repo',
    color: 'blue',
    worktrees: [
      { id: 'wt-1', branchName: 'feature/one', createdAt: '2026-09-01' },
      { id: 'wt-2', branchName: 'feature/two', createdAt: '2026-09-01' },
    ],
  };
  return project as unknown as SidebarItem;
}

function coworkProject(): SidebarItem {
  const project = {
    id: 'cowork-1',
    name: 'Notes',
    type: 'cowork',
    color: 'green',
  };
  return project as unknown as SidebarItem;
}

function render(
  props: Partial<Parameters<typeof AutomationChatTargetPicker>[0]> = {},
): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(AutomationChatTargetPicker, {
        workspaceId: 'ws-1',
        value: undefined,
        onChange: jest.fn(),
        ...props,
      }),
    );
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function byTestId(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function click(element: HTMLElement | null): void {
  if (!element) throw new Error('expected element');
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/**
 * Open a SearchableSelect, read its option labels, then close it again. The
 * menu portals into `document.body`, so leaving one open would pollute the
 * next read.
 */
function optionLabels(testId: string): string[] {
  const trigger = byTestId(testId);
  click(trigger);
  const labels = Array.from(document.querySelectorAll('[role="option"]')).map(
    (node) => node.textContent ?? '',
  );
  click(trigger);
  return labels;
}

const NEW_CHAT_OPTION = 'New chatStart a new chat each run';

beforeEach(() => {
  jest.clearAllMocks();
  mockedOpenDestination.mockResolvedValue({ ok: true });
  loadTabs.mockResolvedValue({ version: 1, tabs: [], activeTabId: '' });
  listWorkEntries.mockResolvedValue({ entries: [] });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      chat: { loadTabs },
      workEntries: { list: listWorkEntries },
    },
  });
  useProjectsStore.setState({ projects: [codeProject(), coworkProject()] });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('AutomationChatTargetPicker', () => {
  it('lists the code workspace worktrees and excludes unsupported chats', async () => {
    loadTabs.mockResolvedValue({
      version: 1,
      activeTabId: 'chat-1',
      tabs: [
        { id: 'chat-1', title: 'Implementation chat' },
        { id: 'file-tab', title: 'README.md', kind: 'file' },
        { id: 'chat-archived', title: 'Old chat', readOnly: true },
        {
          id: 'chat-cursor-provider',
          title: 'Cursor provider chat',
          providerType: 'cursor',
        },
        {
          id: 'chat-cursor-harness',
          title: 'Cursor harness chat',
          executionHarness: 'cursor',
        },
        {
          id: 'chat-cursor-model',
          title: 'Cursor model chat',
          model: 'cursor-default',
        },
      ],
    });
    const onChange = jest.fn();
    render({
      onChange,
      value: {
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: '',
      },
    });
    await settle();

    expect(optionLabels('automations-form-chat-target-worktree')).toEqual([
      'feature/one',
      'feature/two',
    ]);
    expect(loadTabs).toHaveBeenCalledWith({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });

    const chatOptions = optionLabels('automations-form-chat-target-chat');
    expect(chatOptions).toEqual([NEW_CHAT_OPTION, 'Implementation chat']);
    expect(chatOptions).not.toContain('README.md');
    expect(chatOptions).not.toContain('Old chat');
    expect(chatOptions).not.toContain('Cursor provider chat');
    expect(chatOptions).not.toContain('Cursor harness chat');
    expect(chatOptions).not.toContain('Cursor model chat');
  });

  it('emits the full target with display names when a chat is picked', async () => {
    loadTabs.mockResolvedValue({
      version: 1,
      activeTabId: 'chat-1',
      tabs: [{ id: 'chat-1', title: 'Implementation chat' }],
    });
    const onChange = jest.fn();
    render({
      onChange,
      value: { workspaceId: 'ws-1', worktreeId: 'wt-1', chatId: '' },
    });
    await settle();

    click(byTestId('automations-form-chat-target-chat'));
    const option = Array.from(
      document.querySelectorAll('[role="option"]'),
    ).find((node) => node.textContent?.includes('Implementation chat'));
    click(option as HTMLElement);

    expect(onChange).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      workspaceName: 'Canopy',
      worktreeName: 'feature/one',
      chatTitle: 'Implementation chat',
    });
  });

  /**
   * A chat's generated summary title lives on `description`; `title` stays the
   * literal 'New Chat' it was created with. `ChatTabBar` renders
   * `description ?? title`, so reading `title` alone showed every named chat
   * in this picker as 'New Chat'.
   */
  it('labels chats with the generated summary title, matching the tab strip', async () => {
    loadTabs.mockResolvedValue({
      version: 1,
      activeTabId: 'chat-1',
      tabs: [
        {
          id: 'chat-1',
          title: 'New Chat',
          description: 'Claude Agent Capabilities and Skills',
        },
        { id: 'chat-2', title: 'Renamed by hand' },
        { id: 'chat-3', title: 'New Chat', description: '   ' },
      ],
    });
    const onChange = jest.fn();
    render({
      onChange,
      value: { workspaceId: 'ws-1', worktreeId: 'wt-1', chatId: '' },
    });
    await settle();

    expect(optionLabels('automations-form-chat-target-chat')).toEqual([
      NEW_CHAT_OPTION,
      'Claude Agent Capabilities and Skills',
      'Renamed by hand',
      'New Chat',
    ]);
  });

  it('emits the generated summary title as the stored chatTitle', async () => {
    loadTabs.mockResolvedValue({
      version: 1,
      activeTabId: 'chat-1',
      tabs: [
        {
          id: 'chat-1',
          title: 'New Chat',
          description: 'Claude Agent Capabilities and Skills',
        },
      ],
    });
    const onChange = jest.fn();
    render({
      onChange,
      value: { workspaceId: 'ws-1', worktreeId: 'wt-1', chatId: '' },
    });
    await settle();

    click(byTestId('automations-form-chat-target-chat'));
    const option = Array.from(
      document.querySelectorAll('[role="option"]'),
    ).find((node) =>
      node.textContent?.includes('Claude Agent Capabilities and Skills'),
    );
    click(option as HTMLElement);

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        chatTitle: 'Claude Agent Capabilities and Skills',
      }),
    );
  });

  it('applies the anchored viewport height cap to destination menus', async () => {
    const onChange = jest.fn();
    loadTabs.mockResolvedValue({
      version: 1,
      activeTabId: 'chat-1',
      tabs: Array.from({ length: 12 }, (_, index) => ({
        id: `chat-${index + 1}`,
        title: `Chat ${index + 1}`,
      })),
    });
    render({
      onChange,
      value: { workspaceId: 'ws-1', worktreeId: 'wt-1', chatId: '' },
    });
    await settle();

    click(byTestId('automations-form-chat-target-chat'));

    const menu = document.querySelector<HTMLElement>('[role="listbox"]');
    expect(Number.parseFloat(menu?.style.maxHeight ?? '')).toBeGreaterThan(0);
    expect(menu?.classList.contains('flex')).toBe(true);
    expect(menu?.classList.contains('flex-col')).toBe(true);
    const scrollRegion = menu?.querySelector('ul');
    expect(scrollRegion?.classList.contains('min-h-0')).toBe(true);
    expect(scrollRegion?.classList.contains('flex-1')).toBe(true);

    const lastOption = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((option) => option.textContent?.includes('Chat 12'));
    click(lastOption ?? null);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-12', chatTitle: 'Chat 12' }),
    );
  });

  it('hydrates cowork Work Entries into the worktree slot', async () => {
    listWorkEntries.mockResolvedValue({
      entries: [
        { id: 'entry-1', title: 'Weekly notes', createdAt: '2026-09-01' },
      ],
    });
    loadTabs.mockResolvedValue({
      version: 1,
      activeTabId: 'chat-9',
      tabs: [{ id: 'chat-9', title: 'Notes chat' }],
    });
    render({
      workspaceId: 'cowork-1',
      value: { workspaceId: 'cowork-1', worktreeId: 'entry-1', chatId: '' },
    });
    await settle();

    expect(listWorkEntries).toHaveBeenCalledWith({ projectId: 'cowork-1' });
    // The Work Entry id occupies the `worktreeId` slot, so the same chat read
    // serves both workspace kinds.
    expect(loadTabs).toHaveBeenCalledWith({
      projectId: 'cowork-1',
      worktreeId: 'entry-1',
    });
    expect(optionLabels('automations-form-chat-target-worktree')).toEqual([
      'Weekly notes',
    ]);
    expect(optionLabels('automations-form-chat-target-chat')).toEqual([
      NEW_CHAT_OPTION,
      'Notes chat',
    ]);
  });

  it('defaults to a valid "New chat" destination once a worktree is picked', async () => {
    loadTabs.mockResolvedValue({
      version: 1,
      activeTabId: 'chat-1',
      tabs: [{ id: 'chat-1', title: 'Implementation chat' }],
    });
    const onChange = jest.fn();
    const onStatusChange = jest.fn();
    render({
      onChange,
      onStatusChange,
      value: { workspaceId: 'ws-1', worktreeId: '', chatId: '' },
    });
    await settle();
    expect(onStatusChange).toHaveBeenLastCalledWith('incomplete');

    click(byTestId('automations-form-chat-target-worktree'));
    const worktreeOption = Array.from(
      document.querySelectorAll('[role="option"]'),
    ).find((node) => node.textContent?.includes('feature/two'));
    click(worktreeOption as HTMLElement);
    expect(onChange).toHaveBeenLastCalledWith({
      workspaceId: 'ws-1',
      worktreeId: 'wt-2',
      chatId: '',
      workspaceName: 'Canopy',
      worktreeName: 'feature/two',
    });

    act(() => {
      root?.render(
        createElement(AutomationChatTargetPicker, {
          workspaceId: 'ws-1',
          value: { workspaceId: 'ws-1', worktreeId: 'wt-2', chatId: '' },
          onChange,
          onStatusChange,
        }),
      );
    });
    await settle();

    expect(
      byTestId('automations-form-chat-target-chat')?.textContent,
    ).toContain('New chat');
    expect(onStatusChange).toHaveBeenLastCalledWith('ready');
    expect(byTestId('automations-form-open-chat')).toBeNull();
    expect(container?.textContent).toContain(
      'Each run starts a new chat in this worktree.',
    );
  });

  it('switches back to "New chat" from a specific chat', async () => {
    loadTabs.mockResolvedValue({
      version: 1,
      activeTabId: 'chat-1',
      tabs: [{ id: 'chat-1', title: 'Implementation chat' }],
    });
    const onChange = jest.fn();
    render({
      onChange,
      value: {
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        worktreeName: 'feature/one',
        chatTitle: 'Implementation chat',
      },
    });
    await settle();

    click(byTestId('automations-form-chat-target-chat'));
    const newChat = Array.from(
      document.querySelectorAll('[role="option"]'),
    ).find((node) => node.textContent === NEW_CHAT_OPTION);
    click(newChat as HTMLElement);

    expect(onChange).toHaveBeenLastCalledWith({
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      chatId: '',
      workspaceName: 'Canopy',
      worktreeName: 'feature/one',
    });
  });

  it('keeps a "New chat" destination ready when the chat list cannot load', async () => {
    loadTabs.mockRejectedValue(new Error('offline'));
    const onStatusChange = jest.fn();
    render({
      onStatusChange,
      value: { workspaceId: 'ws-1', worktreeId: 'wt-1', chatId: '' },
    });
    await settle();

    expect(byTestId('automations-form-chat-target-unavailable')).toBeNull();
    expect(onStatusChange).toHaveBeenLastCalledWith('ready');
  });

  it('reports a "New chat" destination whose worktree is gone as unavailable', async () => {
    const onStatusChange = jest.fn();
    render({
      onStatusChange,
      value: { workspaceId: 'ws-1', worktreeId: 'wt-deleted', chatId: '' },
    });
    await settle();

    expect(byTestId('automations-form-chat-target-unavailable')).not.toBeNull();
    expect(onStatusChange).toHaveBeenLastCalledWith('unavailable');
  });

  it('lists App Advisor Work Entries and opens an App Advisor chat', async () => {
    listWorkEntries.mockResolvedValue({
      entries: [
        { id: 'aa-entry-1', title: 'Release prep', createdAt: '2026-09-01' },
      ],
    });
    loadTabs.mockResolvedValue({
      version: 1,
      activeTabId: 'aa-chat-1',
      tabs: [{ id: 'aa-chat-1', title: 'Checklist' }],
    });
    const onStatusChange = jest.fn();
    render({
      workspaceId: APP_ADVISOR_PROJECT_ID,
      onStatusChange,
      value: {
        workspaceId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'aa-entry-1',
        chatId: 'aa-chat-1',
      },
    });
    await settle();

    expect(listWorkEntries).toHaveBeenCalledWith({
      projectId: APP_ADVISOR_PROJECT_ID,
    });
    expect(loadTabs).toHaveBeenCalledWith({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'aa-entry-1',
    });
    expect(optionLabels('automations-form-chat-target-worktree')).toEqual([
      'Release prep',
    ]);
    expect(optionLabels('automations-form-chat-target-chat')).toEqual([
      NEW_CHAT_OPTION,
      'Checklist',
    ]);
    expect(onStatusChange).toHaveBeenLastCalledWith('ready');

    click(byTestId('automations-form-open-chat'));
    expect(mockedOpenDestination).toHaveBeenLastCalledWith({
      kind: 'app-advisor-chat',
      chatId: 'aa-chat-1',
    });
  });

  it('explains a saved target whose chat is gone and reports it unavailable', async () => {
    loadTabs.mockResolvedValue({
      version: 1,
      activeTabId: '',
      tabs: [{ id: 'chat-other', title: 'Different chat' }],
    });
    const onStatusChange = jest.fn();
    render({
      onStatusChange,
      value: {
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: 'chat-deleted',
      },
    });
    await settle();

    expect(byTestId('automations-form-chat-target-unavailable')).not.toBeNull();
    expect(onStatusChange).toHaveBeenLastCalledWith('unavailable');
    expect(byTestId('automations-form-open-chat')).toBeNull();
    expect(
      byTestId('automations-form-chat-target-chat')?.textContent,
    ).toContain('chat-deleted');
  });

  it('does not report a complete saved target ready before its chat probe resolves', async () => {
    let resolveTabs:
      | ((value: {
          version: 1;
          activeTabId: string;
          tabs: Array<{ id: string; title: string }>;
        }) => void)
      | undefined;
    loadTabs.mockReturnValue(
      new Promise((resolve) => {
        resolveTabs = resolve;
      }),
    );
    const onStatusChange = jest.fn();
    render({
      onStatusChange,
      value: { workspaceId: 'ws-1', worktreeId: 'wt-1', chatId: 'chat-1' },
    });
    await settle();

    expect(onStatusChange).toHaveBeenLastCalledWith('incomplete');

    await act(async () => {
      resolveTabs?.({
        version: 1,
        activeTabId: 'chat-1',
        tabs: [{ id: 'chat-1', title: 'Implementation chat' }],
      });
      await Promise.resolve();
    });
    expect(onStatusChange).toHaveBeenLastCalledWith('ready');
  });

  it('reports a live target as available and offers to open it', async () => {
    loadTabs.mockResolvedValue({
      version: 1,
      activeTabId: 'chat-1',
      tabs: [{ id: 'chat-1', title: 'Implementation chat' }],
    });
    const onStatusChange = jest.fn();
    render({
      onStatusChange,
      value: { workspaceId: 'ws-1', worktreeId: 'wt-1', chatId: 'chat-1' },
    });
    await settle();

    expect(byTestId('automations-form-chat-target-unavailable')).toBeNull();
    expect(onStatusChange).toHaveBeenLastCalledWith('ready');
    expect(byTestId('automations-form-open-chat')).not.toBeNull();
  });

  it('reports a freshly switched, unpicked destination as incomplete rather than unavailable', async () => {
    const onStatusChange = jest.fn();
    render({
      onStatusChange,
      // The shape `applyChatRunModeSelection` seeds on a New -> Existing flip:
      // the workspace is known, nothing else is picked yet.
      value: { workspaceId: 'ws-1', worktreeId: '', chatId: '' },
    });
    await settle();

    expect(byTestId('automations-form-chat-target-unavailable')).toBeNull();
    expect(onStatusChange).toHaveBeenLastCalledWith('incomplete');
  });

  it('opens a code destination as a worktree chat and a cowork destination as a cowork chat', async () => {
    loadTabs.mockResolvedValue({
      version: 1,
      activeTabId: 'chat-1',
      tabs: [{ id: 'chat-1', title: 'Implementation chat' }],
    });
    render({
      value: { workspaceId: 'ws-1', worktreeId: 'wt-1', chatId: 'chat-1' },
    });
    await settle();
    click(byTestId('automations-form-open-chat'));
    expect(mockedOpenDestination).toHaveBeenLastCalledWith({
      kind: 'worktree-chat',
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
    });

    act(() => root?.unmount());
    container?.remove();

    listWorkEntries.mockResolvedValue({
      entries: [
        { id: 'entry-1', title: 'Weekly notes', createdAt: '2026-09-01' },
      ],
    });
    loadTabs.mockResolvedValue({
      version: 1,
      activeTabId: 'chat-9',
      tabs: [{ id: 'chat-9', title: 'Notes chat' }],
    });
    render({
      workspaceId: 'cowork-1',
      value: {
        workspaceId: 'cowork-1',
        worktreeId: 'entry-1',
        chatId: 'chat-9',
      },
    });
    await settle();
    click(byTestId('automations-form-open-chat'));
    // Cowork chats are not worktree chats: routing them through the worktree
    // opener would fail closed for every cowork destination the picker offers.
    expect(mockedOpenDestination).toHaveBeenLastCalledWith({
      kind: 'cowork-chat',
      workspaceId: 'cowork-1',
      chatId: 'chat-9',
    });
  });

  it('reports a target whose worktree no longer exists as unavailable', async () => {
    const onStatusChange = jest.fn();
    render({
      onStatusChange,
      value: {
        workspaceId: 'ws-1',
        worktreeId: 'wt-deleted',
        chatId: 'chat-1',
      },
    });
    await settle();

    expect(byTestId('automations-form-chat-target-unavailable')).not.toBeNull();
    expect(onStatusChange).toHaveBeenLastCalledWith('unavailable');
  });
});
