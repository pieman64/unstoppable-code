/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  InstalledSkillInfo,
  SharedSkillDetail,
  SharedSkillInstallOrigin,
} from '@canopy/protocol/skills';
import type * as Zustand from 'zustand';
import type { InstalledShareProvenanceOptions } from '@canopy/ui-app/capability';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const openSkillViewer = jest.fn();
jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: {
    getState: (): { openSkillViewer: jest.Mock } => ({ openSkillViewer }),
  },
}));
jest.mock('@/stores/workspaceContextStore', (): object => {
  const { create } = jest.requireActual<typeof Zustand>('zustand');
  return {
    useWorkspaceContextStore: create(() => ({
      accountEpoch: 0,
      state: {
        context: { kind: 'personal' },
        revision: 0,
        organizations: [
          { id: '11111111-1111-4111-8111-111111111111', name: 'Acme Org' },
        ],
      },
    })),
  };
});

import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useInstalledShareProvenance } from '../useInstalledShareProvenance';

const getShared = jest.fn<Promise<SharedSkillDetail>, [string]>();
Object.defineProperty(window, 'skills', {
  configurable: true,
  value: { getShared },
});

function sharedDetail(
  overrides: Partial<SharedSkillDetail> = {},
): SharedSkillDetail {
  return {
    id: 'share-1',
    name: 'review',
    description: '',
    contentHash: HASH_A,
    shareScope: 'organization',
    owner: { type: 'organization', id: ORG_ID, name: 'Acme' },
    createdBy: { id: 'u1', name: 'Lena Park', email: null },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    canUpdate: false,
    canDelete: false,
    publicShare: null,
    rawSkill: '',
    ...overrides,
  };
}

const origin: SharedSkillInstallOrigin = {
  remoteId: 'share-1',
  shareScope: 'organization',
  ownerContext: { kind: 'organization', organizationId: ORG_ID },
  contentHash: HASH_A,
  authorizedAt: '2026-10-01T00:00:00.000Z',
  ownerName: 'Acme',
  teamName: 'Platform',
  sharedByName: 'Lena Park',
};

let latest: InstalledShareProvenanceOptions | undefined;
function Probe({
  skill,
  name,
}: {
  skill: Pick<InstalledSkillInfo, 'installedFromShare'> | undefined;
  name: string;
}): ReactElement | null {
  const installed = skill
    ? { ...skill, name, sourceId: 'custom:app' }
    : undefined;
  latest = useInstalledShareProvenance(installed);
  return null;
}

let root: Root | null = null;
function render(
  skill: Pick<InstalledSkillInfo, 'installedFromShare'> | undefined,
  name = 'first-copy',
): void {
  act(() => {
    root ??= createRoot(document.createElement('div'));
    root.render(<Probe skill={skill} name={name} />);
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  getShared.mockReset();
  openSkillViewer.mockReset();
  latest = undefined;
  useWorkspaceContextStore.setState({ accountEpoch: 0 });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe('useInstalledShareProvenance (CAN-5018)', () => {
  it('makes no request without a receipted origin', () => {
    render({});
    render(undefined);
    expect(getShared).not.toHaveBeenCalled();
    expect(latest).toBeUndefined();
  });

  it('shows the receipt while reading, then live names and hash state', async () => {
    getShared.mockResolvedValue(
      sharedDetail({
        contentHash: HASH_B,
        owner: {
          type: 'team',
          id: 't1',
          name: 'Platform Eng',
          organization: { id: ORG_ID, name: 'Acme Corp' },
        },
      }),
    );
    render({ installedFromShare: origin });
    expect(latest?.names).toEqual({
      ownerName: 'Acme',
      teamName: 'Platform',
      sharedByName: 'Lena Park',
    });
    expect(latest?.updateAvailable).toBeUndefined();
    await flush();
    expect(getShared).toHaveBeenCalledWith('share-1');
    expect(latest?.names).toEqual({
      ownerName: 'Acme Corp',
      teamName: 'Platform Eng',
      sharedByName: 'Lena Park',
    });
    expect(latest?.updateAvailable).toBe(true);
  });

  it('reports no update for an equal hash and keeps live absences', async () => {
    getShared.mockResolvedValue(
      sharedDetail({ createdBy: { id: 'u1', name: null, email: null } }),
    );
    render({ installedFromShare: origin });
    await flush();
    expect(latest?.updateAvailable).toBe(false);
    expect(latest?.names).toEqual({ ownerName: 'Acme' });
  });

  it('suppresses the badge when the installed hash is missing', async () => {
    getShared.mockResolvedValue(sharedDetail({ contentHash: HASH_B }));
    render({ installedFromShare: { remoteId: 'share-1' } });
    await flush();
    expect(latest?.updateAvailable).toBe(false);
  });

  it('falls back to the receipt, then the exact organization, on failure', async () => {
    getShared.mockRejectedValue(new Error('403'));
    render({
      installedFromShare: {
        ...origin,
        ownerName: undefined,
        teamName: undefined,
      },
    });
    await flush();
    expect(latest?.updateAvailable).toBeUndefined();
    expect(latest?.names).toEqual({
      ownerName: 'Acme Org',
      sharedByName: 'Lena Park',
    });
  });

  it('ignores a late result for a skill no longer shown', async () => {
    const first = deferred<SharedSkillDetail>();
    getShared.mockReturnValueOnce(first.promise);
    getShared.mockResolvedValueOnce(
      sharedDetail({
        id: 'share-2',
        owner: { type: 'organization', id: ORG_ID, name: 'Beta' },
      }),
    );
    render({ installedFromShare: origin });
    render({
      installedFromShare: { ...origin, remoteId: 'share-2', ownerName: 'Old' },
    });
    await flush();
    expect(latest?.names?.ownerName).toBe('Beta');
    first.resolve(
      sharedDetail({
        owner: { type: 'organization', id: ORG_ID, name: 'Stale' },
      }),
    );
    await flush();
    expect(latest?.names?.ownerName).toBe('Beta');
  });

  it('reads again when the account changes or the installed hash advances', async () => {
    getShared.mockResolvedValue(sharedDetail({ contentHash: HASH_B }));
    render({ installedFromShare: origin });
    await flush();
    expect(latest?.updateAvailable).toBe(true);
    // A committed update advances the receipt's hash.
    render({ installedFromShare: { ...origin, contentHash: HASH_B } });
    await flush();
    expect(getShared).toHaveBeenCalledTimes(2);
    expect(latest?.updateAvailable).toBe(false);
    act(() => useWorkspaceContextStore.setState({ accountEpoch: 1 }));
    // The previous account's result is not shown while the new read runs.
    expect(latest?.updateAvailable).toBeUndefined();
    await flush();
    expect(getShared).toHaveBeenCalledTimes(3);
  });

  it('opens the shared skill through the navigation store', () => {
    getShared.mockReturnValue(new Promise(() => {}));
    render({ installedFromShare: origin });
    const source = latest?.source;
    expect(source?.kind).toBe('action');
    if (source?.kind === 'action') source.onSelect();
    expect(openSkillViewer).toHaveBeenCalledWith({
      kind: 'shared',
      skillId: 'share-1',
    });
  });

  it('refreshes when switching between copies of the same share', async () => {
    getShared.mockResolvedValueOnce(sharedDetail({ contentHash: HASH_B }));
    render({ installedFromShare: origin });
    await flush();
    expect(latest?.updateAvailable).toBe(true);
    getShared.mockReturnValueOnce(new Promise(() => {}));
    render({ installedFromShare: origin }, 'second-copy');
    expect(getShared).toHaveBeenCalledTimes(2);
    expect(latest?.updateAvailable).toBeUndefined();
    expect(latest?.names?.ownerName).toBe('Acme');
  });

  it('does not revive an old result after leaving and returning to the same origin', async () => {
    getShared.mockResolvedValueOnce(sharedDetail({ contentHash: HASH_B }));
    render({ installedFromShare: origin });
    await flush();
    expect(latest?.updateAvailable).toBe(true);
    render(undefined);
    getShared.mockReturnValueOnce(new Promise(() => {}));
    render({ installedFromShare: origin });
    expect(getShared).toHaveBeenCalledTimes(2);
    expect(latest?.updateAvailable).toBeUndefined();
  });

  it('refreshes a new authorization snapshot even when the content hash is unchanged', async () => {
    getShared.mockResolvedValueOnce(sharedDetail({ contentHash: HASH_B }));
    render({ installedFromShare: origin });
    await flush();
    getShared.mockReturnValueOnce(new Promise(() => {}));
    render({
      installedFromShare: { ...origin, authorizedAt: '2026-10-27T00:00:00Z' },
    });
    expect(getShared).toHaveBeenCalledTimes(2);
    expect(latest?.updateAvailable).toBeUndefined();
  });

  it.each(['offline', '403', '404'])(
    'keeps recorded attribution and navigation on %s',
    async (error) => {
      getShared.mockRejectedValue(new Error(error));
      render({ installedFromShare: origin });
      await flush();
      expect(latest?.names).toEqual({
        ownerName: 'Acme',
        teamName: 'Platform',
        sharedByName: 'Lena Park',
      });
      expect(latest?.updateAvailable).toBeUndefined();
      expect(latest?.source?.kind).toBe('action');
    },
  );

  it('does not multiply source reads on ordinary rerenders', async () => {
    getShared.mockResolvedValue(sharedDetail());
    render({ installedFromShare: origin });
    await flush();
    render({ installedFromShare: { ...origin } });
    render({ installedFromShare: { ...origin } });
    expect(getShared).toHaveBeenCalledTimes(1);
  });

  it('drops a pending result after an account change', async () => {
    const previous = deferred<SharedSkillDetail>();
    getShared.mockReturnValueOnce(previous.promise);
    render({ installedFromShare: origin });
    getShared.mockRejectedValueOnce(new Error('403'));
    act(() => useWorkspaceContextStore.setState({ accountEpoch: 1 }));
    await flush();
    previous.resolve(sharedDetail({ contentHash: HASH_B }));
    await flush();
    expect(latest?.updateAvailable).toBeUndefined();
    expect(latest?.names?.teamName).toBe('Platform');
  });

  it('refreshes on a context round trip without showing the earlier result', async () => {
    getShared.mockResolvedValueOnce(sharedDetail({ contentHash: HASH_B }));
    render({ installedFromShare: origin });
    await flush();
    expect(latest?.updateAvailable).toBe(true);
    getShared.mockReturnValue(new Promise(() => {}));
    act(() =>
      useWorkspaceContextStore.setState((current) => ({
        state: {
          ...current.state,
          context: { kind: 'organization', organizationId: ORG_ID },
        },
      })),
    );
    expect(latest?.updateAvailable).toBeUndefined();
    act(() =>
      useWorkspaceContextStore.setState((current) => ({
        state: { ...current.state, context: { kind: 'personal' } },
      })),
    );
    expect(latest?.updateAvailable).toBeUndefined();
    expect(getShared).toHaveBeenCalledTimes(3);
  });
});
