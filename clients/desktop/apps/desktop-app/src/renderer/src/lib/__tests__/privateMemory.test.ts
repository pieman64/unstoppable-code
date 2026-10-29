import { saveWorkspacePrivateMemory } from '@/lib/privateMemory';

const loadProjects = jest.fn();
const loadChatProjects = jest.fn();

jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: {
    getState: (): { loadProjects: jest.Mock } => ({ loadProjects }),
  },
}));

jest.mock('@/stores/standaloneChatStore', () => ({
  useStandaloneChatStore: {
    getState: (): { loadChatProjects: jest.Mock } => ({ loadChatProjects }),
  },
}));

describe('saveWorkspacePrivateMemory', () => {
  let setWorkspacePrivateMemory: jest.Mock;

  beforeEach(() => {
    loadProjects.mockReset().mockResolvedValue(undefined);
    loadChatProjects.mockReset().mockResolvedValue(undefined);
    setWorkspacePrivateMemory = jest.fn().mockResolvedValue({ id: 'alpha' });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { api: { setWorkspacePrivateMemory } },
    });
  });

  it.each([true, false])(
    'saves %s through the one IPC path, then reloads every projecting row',
    async (privateMemory) => {
      await saveWorkspacePrivateMemory('alpha', privateMemory);

      expect(setWorkspacePrivateMemory).toHaveBeenCalledTimes(1);
      expect(setWorkspacePrivateMemory).toHaveBeenCalledWith({
        workspaceId: 'alpha',
        privateMemory,
      });
      expect(loadProjects).toHaveBeenCalledWith({ silent: true });
      expect(loadChatProjects).toHaveBeenCalledTimes(1);
      expect(
        setWorkspacePrivateMemory.mock.invocationCallOrder[0],
      ).toBeLessThan(loadProjects.mock.invocationCallOrder[0] ?? 0);
    },
  );

  it('reloads the authoritative rows before reporting a managed refusal', async () => {
    setWorkspacePrivateMemory.mockRejectedValue(
      new Error(
        "Error invoking remote method 'workspace:set-private-memory': Error: Private memory is managed by your organization",
      ),
    );
    const events: string[] = [];
    loadProjects.mockImplementation((): Promise<void> => {
      events.push('reloaded');
      return Promise.resolve();
    });

    await expect(
      saveWorkspacePrivateMemory('alpha', true).catch((cause: unknown) => {
        events.push('reported');
        throw cause;
      }),
    ).rejects.toThrow(
      new Error('Private memory is managed by your organization'),
    );

    expect(events).toEqual(['reloaded', 'reported']);
    expect(loadChatProjects).toHaveBeenCalledTimes(1);
  });

  it('still reports the refusal when the reload fails too', async () => {
    setWorkspacePrivateMemory.mockRejectedValue(
      new Error('Project configuration is unavailable'),
    );
    loadProjects.mockRejectedValue(new Error('offline'));

    await expect(saveWorkspacePrivateMemory('alpha', true)).rejects.toThrow(
      'Project configuration is unavailable',
    );
  });

  it('does not turn a saved value into a failure when only the reload fails', async () => {
    loadChatProjects.mockRejectedValue(new Error('offline'));

    await expect(
      saveWorkspacePrivateMemory('alpha', true),
    ).resolves.toBeUndefined();
  });
});
