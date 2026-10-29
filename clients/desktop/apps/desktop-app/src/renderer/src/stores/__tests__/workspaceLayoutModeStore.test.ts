/** @jest-environment jsdom */
import { useWorkspaceLayoutModeStore } from '../workspaceLayoutModeStore';
import { useStandaloneChatStore } from '../standaloneChatStore';

const loadWorktreeMode = jest.fn();
const saveWorktreeMode = jest.fn();

beforeEach(() => {
  useWorkspaceLayoutModeStore.setState({ entries: {} });
  loadWorktreeMode.mockReset();
  saveWorktreeMode.mockReset();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { panelLayout: { loadWorktreeMode, saveWorktreeMode } },
  });
});

it('fails safely to Advanced when mode loading rejects', async () => {
  loadWorktreeMode.mockRejectedValue(new Error('corrupt'));
  await expect(
    useWorkspaceLayoutModeStore.getState().load('project/tree'),
  ).resolves.toBe('advanced');
  expect(
    useWorkspaceLayoutModeStore.getState().entries['project/tree'],
  ).toMatchObject({
    mode: 'advanced',
    status: 'error',
  });
});

it('changes renderer state only after a durable save succeeds', async () => {
  loadWorktreeMode.mockResolvedValue({ mode: 'advanced' });
  saveWorktreeMode.mockRejectedValue(new Error('disk'));
  await useWorkspaceLayoutModeStore.getState().load('project/tree');
  await expect(
    useWorkspaceLayoutModeStore.getState().save('project/tree', 'minimal'),
  ).rejects.toThrow('disk');
  expect(
    useWorkspaceLayoutModeStore.getState().entries['project/tree']?.mode,
  ).toBe('advanced');
});

it('marks an empty entry customized after a mode save succeeds', async () => {
  useStandaloneChatStore.setState({
    activeChatProjectId: 'project',
    workEntries: [
      {
        id: 'tree',
        createdAt: '2026-01-01T00:00:00.000Z',
        status: 'active',
        pinned: false,
        chatCount: 0,
        hasActiveChat: false,
        unreadChats: [],
      },
    ],
  });
  saveWorktreeMode.mockResolvedValue(undefined);

  await useWorkspaceLayoutModeStore.getState().save('project/tree', 'minimal');

  expect(useStandaloneChatStore.getState().workEntries[0].hasUserChanges).toBe(
    true,
  );
});
