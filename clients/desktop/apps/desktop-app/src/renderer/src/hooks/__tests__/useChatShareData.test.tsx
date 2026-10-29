/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  loadChatShareLocalData,
  refreshChatShareData,
  resetChatShareDataForTests,
  useChatMentionIndex,
  useChatShareData,
  type ChatShareData,
} from '../useChatShareData';
import { SHARED_PLUGINS_CHANGED_EVENT } from '../useSharedMarketplaceShares';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const SKILL = {
  name: 'release-notes',
  sourceId: 'custom:app',
  description: '',
  source: 'custom',
  installedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  updateAvailable: false,
  custom: true,
};

function account(id: string | null): Record<string, unknown> {
  return id
    ? { hasApiKey: true, capabilities: [], account: { id } }
    : { hasApiKey: false, capabilities: [] };
}

function sharedList(externalId: string): Record<string, unknown> {
  return { success: true, data: { data: [{ externalId }] } };
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
  });
}

describe('useChatShareData', () => {
  let container: HTMLElement;
  let root: Root;
  let latest: ChatShareData[] = [];
  let inventoryChanged: (() => void) | null = null;
  const loadSkills = jest.fn();
  const loadMarketplaces = jest.fn();
  const listShared = jest.fn();
  const loadAccount = jest.fn();
  const listInventory = jest.fn();

  function Probe({
    slot,
    active,
    retryKey,
  }: {
    slot: number;
    active: boolean;
    retryKey?: string;
  }): null {
    latest[slot] = useChatShareData(active, retryKey);
    return null;
  }

  function render(actives: boolean[], retryKey?: string): void {
    act(() => {
      root.render(
        <>
          {actives.map((active, slot) => (
            <Probe key={slot} slot={slot} active={active} retryKey={retryKey} />
          ))}
        </>,
      );
    });
  }

  beforeEach(() => {
    resetChatShareDataForTests();
    latest = [];
    inventoryChanged = null;
    loadSkills.mockReset().mockResolvedValue({ success: true, data: [SKILL] });
    loadMarketplaces.mockReset().mockResolvedValue({
      success: true,
      data: { marketplaces: [{ id: 'acme-market', plugins: [] }] },
    });
    listShared.mockReset().mockResolvedValue(sharedList('share-1'));
    loadAccount.mockReset().mockResolvedValue(account('me'));
    listInventory.mockReset().mockResolvedValue({
      success: true,
      data: { entries: [], stale: false, rebuilding: false },
    });
    Object.assign(window, {
      skills: { loadSkills },
      plugins: { loadMarketplacesCacheOnly: loadMarketplaces, listShared },
      api: { loadCanopyCloudAccount: loadAccount },
      invocableInventory: {
        list: listInventory,
        onChanged: (callback: () => void): (() => void) => {
          inventoryChanged = callback;
          return (): void => {
            inventoryChanged = null;
          };
        },
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetChatShareDataForTests();
  });

  it('loads nothing until a surface is active', async () => {
    render([false, false]);
    await flush();
    expect(loadSkills).not.toHaveBeenCalled();
    expect(loadMarketplaces).not.toHaveBeenCalled();
    expect(loadAccount).not.toHaveBeenCalled();
    expect(latest[0]?.installedSkills).toBeNull();
  });

  it('loads once for every active surface and shares the result', async () => {
    render([true, true, true]);
    await flush();
    expect(loadSkills).toHaveBeenCalledTimes(1);
    expect(loadMarketplaces).toHaveBeenCalledTimes(1);
    expect(listShared).toHaveBeenCalledTimes(1);
    expect(latest[0]).toBe(latest[2]);
    expect(latest[0]).toMatchObject({
      installedSkills: [SKILL],
      localSettled: true,
      accountId: 'me',
      sharedPlugins: [{ externalId: 'share-1' }],
    });
  });

  it('keeps local resolution usable when the audience request fails', async () => {
    listShared.mockResolvedValue({ success: false, error: 'offline' });
    render([true]);
    await flush();
    expect(latest[0]?.installedSkills).toEqual([SKILL]);
    expect(latest[0]?.marketplaces).toHaveLength(1);
    expect(latest[0]?.sharedPlugins).toBeNull();
  });

  it('treats a failed local load as unknown, not empty', async () => {
    loadSkills.mockRejectedValue(new Error('ipc failed'));
    render([true]);
    await flush();
    expect(latest[0]?.installedSkills).toBeNull();
    expect(latest[0]?.localSettled).toBe(true);
    expect(latest[0]?.marketplaces).toHaveLength(1);
  });

  it('does not list shared plugins while signed out', async () => {
    loadAccount.mockResolvedValue(account(null));
    render([true]);
    await flush();
    expect(listShared).not.toHaveBeenCalled();
    expect(latest[0]?.accountId).toBeNull();
    expect(latest[0]?.sharedPlugins).toBeNull();
  });

  it.each([{ credentialSource: 'guest' }, { authMode: 'guest' }])(
    'keeps guest audience unknown until real sign-in (%j)',
    async (guest) => {
      loadAccount.mockResolvedValue({ ...account('guest'), ...guest });
      render([true]);
      await flush();
      expect(latest[0]?.accountId).toBeNull();
      expect(listShared).not.toHaveBeenCalled();
      loadAccount.mockResolvedValue(account('me'));
      act(() => {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      });
      await flush();
      expect(latest[0]?.accountId).toBe('me');
    },
  );

  it.each(['skills', 'marketplaces', 'account', 'pluginAudience'])(
    'retries failed %s data on surface reactivation',
    async (kind) => {
      const loader =
        kind === 'skills'
          ? loadSkills
          : kind === 'marketplaces'
            ? loadMarketplaces
            : kind === 'account'
              ? loadAccount
              : listShared;
      loader.mockRejectedValueOnce(new Error('temporary failure'));
      render([true]);
      await flush();
      expect(loader).toHaveBeenCalledTimes(1);
      render([false]);
      render([true, true]);
      await flush();
      expect(loader).toHaveBeenCalledTimes(2);
      expect(latest[0]?.installedSkills).toEqual([SKILL]);
      expect(latest[0]?.marketplaces).toHaveLength(1);
      expect(latest[0]?.accountId).toBe('me');
      expect(latest[0]?.sharedPlugins).toEqual([{ externalId: 'share-1' }]);
    },
  );

  it('retries an unknown audience when a later eligible use supplies a new pending identity', async () => {
    listShared.mockRejectedValueOnce(new Error('offline'));
    render([true], 'pending-1');
    await flush();
    expect(latest[0]?.sharedPlugins).toBeNull();
    render([true], 'pending-2');
    await flush();
    expect(listShared).toHaveBeenCalledTimes(2);
    expect(latest[0]?.sharedPlugins).toEqual([{ externalId: 'share-1' }]);
    expect(loadSkills).toHaveBeenCalledTimes(1);
  });

  it.each([
    { hasApiKey: true, capabilities: [] },
    { hasApiKey: false, capabilities: [], read: 'error' },
  ])(
    'retries an inconclusive account snapshot on a later use',
    async (snapshot) => {
      loadAccount.mockResolvedValueOnce(snapshot);
      render([true], 'pending-1');
      await flush();
      expect(latest[0]?.accountId).toBeNull();
      render([true], 'pending-2');
      await flush();
      expect(loadAccount).toHaveBeenCalledTimes(2);
      expect(latest[0]?.accountId).toBe('me');
    },
  );

  it('refreshes on inventory, share and completed-share changes', async () => {
    render([true]);
    await flush();
    act(() => inventoryChanged?.());
    await flush();
    expect(loadSkills).toHaveBeenCalledTimes(2);

    listShared.mockResolvedValue(sharedList('share-2'));
    act(() => {
      window.dispatchEvent(new Event(SHARED_PLUGINS_CHANGED_EVENT));
    });
    await flush();
    expect(listShared).toHaveBeenCalledTimes(2);
    expect(latest[0]?.sharedPlugins).toEqual([{ externalId: 'share-2' }]);

    act(() => refreshChatShareData());
    await flush();
    expect(loadSkills).toHaveBeenCalledTimes(3);
    expect(listShared).toHaveBeenCalledTimes(3);
  });

  it('clears the audience at once on an identity change and ignores the old answer', async () => {
    render([true]);
    await flush();
    expect(latest[0]?.accountId).toBe('me');

    // The previous identity's list is still in flight when the account changes.
    let releaseOld: (value: unknown) => void = () => {};
    listShared.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseOld = resolve;
        }),
    );
    act(() => {
      window.dispatchEvent(new Event(SHARED_PLUGINS_CHANGED_EVENT));
    });
    await flush();

    loadAccount.mockResolvedValue(account('someone-else'));
    listShared.mockResolvedValue(sharedList('their-share'));
    act(() => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    });
    // Cleared synchronously, before any response arrives.
    expect(latest[0]?.accountId).toBeNull();
    expect(latest[0]?.sharedPlugins).toBeNull();

    await flush();
    expect(latest[0]?.accountId).toBe('someone-else');
    expect(latest[0]?.sharedPlugins).toEqual([{ externalId: 'their-share' }]);

    await act(async () => {
      releaseOld(sharedList('stale-share'));
      await Promise.resolve();
    });
    await flush();
    expect(latest[0]?.sharedPlugins).toEqual([{ externalId: 'their-share' }]);
  });

  it('resolves the local load for callers outside React', async () => {
    const data = await loadChatShareLocalData();
    expect(data.installedSkills).toEqual([SKILL]);
    expect(data.localSettled).toBe(true);
    expect(loadSkills).toHaveBeenCalledTimes(1);
  });

  it('publishes skill readiness without waiting for marketplaces', async () => {
    loadMarketplaces.mockReturnValueOnce(new Promise(() => {}));
    render([true]);
    await flush();
    expect(latest[0]?.installedSkills).toEqual([SKILL]);
    expect(latest[0]?.marketplaces).toBeNull();
    await expect(loadChatShareLocalData('skill')).resolves.toMatchObject({
      installedSkills: [SKILL],
    });
  });

  it('clears skill audience immediately on account change while retaining local resolution', async () => {
    loadSkills.mockResolvedValueOnce({
      success: true,
      data: [
        {
          ...SKILL,
          remote: {
            remoteId: 'old-share',
            contentHash: 'hash',
            shareScope: 'team',
            sharedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      ],
    });
    render([true]);
    await flush();
    loadSkills.mockReturnValueOnce(new Promise(() => {}));
    loadAccount.mockReturnValueOnce(new Promise(() => {}));
    act(() => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    });
    expect(latest[0]?.installedSkills?.[0]?.remote).toBeUndefined();
    expect(latest[0]?.installedSkills?.[0]?.name).toBe(SKILL.name);
  });

  it('loads only the inventory for the mention index', async () => {
    let index: ReturnType<typeof useChatMentionIndex> = null;
    function IndexProbe(): null {
      index = useChatMentionIndex();
      return null;
    }
    listInventory.mockResolvedValue({
      success: true,
      data: {
        entries: [
          {
            id: 'claude-notes',
            provider: 'claude',
            kind: 'skill',
            name: 'release-notes',
            displayName: '/release-notes',
            description: '',
            insertText: '/release-notes ',
            invocationKey: '/release-notes',
            enableRef: {
              kind: 'skill',
              sourceId: 'custom:app',
              skillName: 'release-notes',
            },
          },
        ],
        stale: false,
        rebuilding: false,
      },
    });
    act(() => {
      root.render(<IndexProbe />);
    });
    await flush();
    expect(listInventory).toHaveBeenCalledTimes(1);
    expect(listInventory).toHaveBeenCalledWith({ providerType: null });
    expect(
      (index as ReturnType<typeof useChatMentionIndex>)?.aliases.has(
        '/release-notes',
      ),
    ).toBe(true);
    // The rail's index never triggers skills, marketplaces or the account.
    expect(loadSkills).not.toHaveBeenCalled();
    expect(loadAccount).not.toHaveBeenCalled();
  });
});
