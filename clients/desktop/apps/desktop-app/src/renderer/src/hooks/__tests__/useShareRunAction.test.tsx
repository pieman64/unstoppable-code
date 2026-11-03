/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ShareRunActionController } from '../useShareRunAction';

const shareRunMock = jest.fn();
const unshareRunMock = jest.fn();
const addToastMock = jest.fn();
const setSharedRunMock = jest.fn();
const refreshWorkEntriesMock = jest.fn();
let scopingContext:
  | { kind: 'personal' }
  | { kind: 'organization'; organizationId: string }
  | undefined;

jest.mock('@/components/sidebar/useSidebarScopingContext', () => ({
  useSidebarScopingContext: (): typeof scopingContext => scopingContext,
}));

jest.mock('@/stores/activityStore', () => {
  const useActivityStore = Object.assign(
    (
      selector: (state: {
        shareRun: typeof shareRunMock;
        unshareRun: typeof unshareRunMock;
      }) => unknown,
    ): unknown =>
      selector({ shareRun: shareRunMock, unshareRun: unshareRunMock }),
    {
      getState: (): { worktreeSummaries: Record<string, never> } => ({
        worktreeSummaries: {},
      }),
    },
  );
  return { useActivityStore };
});

jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: (): { setSharedRun: typeof setSharedRunMock } => ({
      setSharedRun: setSharedRunMock,
    }),
  },
}));

jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: (
    selector: (state: { addToast: typeof addToastMock }) => unknown,
  ): unknown => selector({ addToast: addToastMock }),
}));

jest.mock('@/stores/standaloneChatStore', () => ({
  useStandaloneChatStore: {
    getState: (): { refreshWorkEntries: typeof refreshWorkEntriesMock } => ({
      refreshWorkEntries: refreshWorkEntriesMock,
    }),
  },
}));

jest.mock('@/lib/cowork', () => ({
  isCoworkChatTarget: (): boolean => false,
}));

const resolveSharedRunUrlMock = jest.fn<
  Promise<string | undefined>,
  [string]
>();

jest.mock('@/lib/share-links', () => ({
  resolveSharedRunUrl: (externalId: string): Promise<string | undefined> =>
    resolveSharedRunUrlMock(externalId),
}));

import { useShareRunAction } from '../useShareRunAction';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface Probe {
  current: ShareRunActionController | null;
}

function Harness({ probe }: { probe: Probe }): JSX.Element {
  probe.current = useShareRunAction('project-1', 'worktree-1');
  return <></>;
}

async function renderHook(): Promise<{ probe: Probe; cleanup: () => void }> {
  const probe: Probe = { current: null };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(<Harness probe={probe} />);
  });
  await Promise.resolve();
  return {
    probe,
    cleanup: (): void => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('useShareRunAction', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    resolveSharedRunUrlMock.mockResolvedValue(undefined);
    setSharedRunMock.mockRejectedValue(new Error('canonical write failed'));
    unshareRunMock.mockResolvedValue({ unshared: true });
    scopingContext = undefined;
  });

  it('hides a new share in Personal but keeps an existing share manageable', async () => {
    scopingContext = { kind: 'personal' };
    const { probe, cleanup } = await renderHook();

    expect(probe.current?.entryVisible()).toBe(false);
    expect(
      probe.current?.entryVisible({
        externalId: 'shared-run',
        shareScope: 'team',
        teamId: 'team-1',
        sharedAt: '2026-09-24T20:00:00.000Z',
      }),
    ).toBe(true);
    cleanup();
  });

  it('leaves modal submission failures to the inline error notice', async () => {
    shareRunMock.mockRejectedValueOnce(new Error('cloud unavailable'));
    const { probe, cleanup } = await renderHook();

    act(() => {
      probe.current?.open('chat-1', 'Chat one');
    });
    await act(async () => {
      await expect(
        probe.current?.submit({ shareScope: 'team', teamId: 'team-1' }),
      ).rejects.toThrow('cloud unavailable');
    });

    expect(addToastMock).not.toHaveBeenCalled();
    expect(probe.current?.target?.chatId).toBe('chat-1');
    cleanup();
  });

  it('clears an existing share after local persistence fails and revocation succeeds', async () => {
    const existingShare = {
      externalId: 'shared-run-old',
      shareScope: 'team' as const,
      teamId: 'team-1',
      teamName: 'Platform',
      sharedAt: '2026-09-24T20:00:00.000Z',
    };
    setSharedRunMock
      .mockRejectedValueOnce(new Error('canonical write failed'))
      .mockResolvedValue(undefined);
    const { probe, cleanup } = await renderHook();

    act(() => {
      probe.current?.open('chat-1', 'Chat one', undefined, existingShare);
    });
    await act(async () => {
      await expect(
        probe.current?.onShared({
          externalId: 'shared-run-1',
          shareScope: 'team',
          teamId: 'team-1',
          teamName: 'Platform',
        }),
      ).rejects.toMatchObject({
        message:
          'Session share state could not be saved. The share was revoked; retry sharing.',
        shareCompletionRolledBack: true,
      });
    });

    expect(unshareRunMock).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'chat-1',
    );
    expect(setSharedRunMock).toHaveBeenLastCalledWith(
      'project-1',
      'worktree-1',
      'chat-1',
      undefined,
    );
    expect(addToastMock).not.toHaveBeenCalled();
    expect(probe.current?.target?.chatId).toBe('chat-1');
    expect(probe.current?.target?.existingShare).toBeUndefined();
    cleanup();
  });

  it('retries only canonical cleanup when an existing-share rollback cannot be cleared', async () => {
    const existingShare = {
      externalId: 'shared-run-old',
      shareScope: 'team' as const,
      teamId: 'team-1',
      teamName: 'Platform',
      sharedAt: '2026-09-24T20:00:00.000Z',
    };
    setSharedRunMock
      .mockRejectedValueOnce(new Error('canonical update failed'))
      .mockRejectedValueOnce(new Error('canonical cleanup failed'))
      .mockResolvedValueOnce(undefined);
    const { probe, cleanup } = await renderHook();

    act(() => {
      probe.current?.open('chat-1', 'Chat one', undefined, existingShare);
    });
    const result = {
      externalId: 'shared-run-1',
      shareScope: 'team' as const,
      teamId: 'team-1',
      teamName: 'Platform',
    };
    await act(async () => {
      await expect(probe.current?.onShared(result)).rejects.toThrow(
        'Session share was revoked, but its local status could not be cleared. Try again to finish cleaning up.',
      );
    });

    expect(unshareRunMock).toHaveBeenCalledTimes(1);
    expect(probe.current?.target?.chatId).toBe('chat-1');
    expect(probe.current?.target?.existingShare).toBeUndefined();
    act(() => {
      probe.current?.close();
      probe.current?.open('chat-2', 'Chat two');
    });
    expect(probe.current?.target?.chatId).toBe('chat-1');

    await act(async () => {
      await expect(probe.current?.onShared(result)).rejects.toMatchObject({
        message:
          'Session share state could not be saved. The share was revoked; retry sharing.',
        shareCompletionRolledBack: true,
      });
    });

    expect(unshareRunMock).toHaveBeenCalledTimes(1);
    expect(setSharedRunMock).toHaveBeenLastCalledWith(
      'project-1',
      'worktree-1',
      'chat-1',
      undefined,
    );
    expect(probe.current?.target?.chatId).toBe('chat-1');
    cleanup();
  });

  it('keeps the share target recoverable when remote revocation also fails', async () => {
    unshareRunMock.mockRejectedValueOnce(new Error('revoke failed'));
    const { probe, cleanup } = await renderHook();

    act(() => {
      probe.current?.open('chat-1', 'Chat one');
    });
    await act(async () => {
      await expect(
        probe.current?.onShared({
          externalId: 'shared-run-1',
          shareScope: 'team',
          teamId: 'team-1',
          teamName: 'Platform',
        }),
      ).rejects.toThrow(
        'Session shared, but its local status could not be saved or revoked. Try sharing again to restore local control.',
      );
    });

    expect(probe.current?.target?.chatId).toBe('chat-1');
    expect(addToastMock).not.toHaveBeenCalled();
    cleanup();
  });

  it('records the team share and keeps the target until the dialog closes', async () => {
    setSharedRunMock.mockResolvedValue(undefined);
    resolveSharedRunUrlMock.mockResolvedValue(
      'https://cloud.example.test/share/runs/shared-run-1',
    );
    const { probe, cleanup } = await renderHook();

    act(() => {
      probe.current?.open('chat-1', 'Chat one');
    });
    await act(async () => {
      await probe.current?.onShared({
        externalId: 'shared-run-1',
        shareScope: 'team',
        teamId: 'team-1',
        teamName: 'Platform',
      });
    });

    expect(setSharedRunMock).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'chat-1',
      expect.objectContaining({
        externalId: 'shared-run-1',
        shareScope: 'team',
        teamId: 'team-1',
        teamName: 'Platform',
      }),
    );
    // The common share dialog stays open on its success notice (with the
    // link) once this completion hook returns, so no toast is raised here.
    expect(addToastMock).not.toHaveBeenCalled();
    expect(unshareRunMock).not.toHaveBeenCalled();
    expect(probe.current?.target?.chatId).toBe('chat-1');

    // Done closes the dialog through `close`.
    act(() => {
      probe.current?.close();
    });
    expect(probe.current?.target).toBeNull();
    expect(addToastMock).not.toHaveBeenCalled();
    cleanup();
  });
});
