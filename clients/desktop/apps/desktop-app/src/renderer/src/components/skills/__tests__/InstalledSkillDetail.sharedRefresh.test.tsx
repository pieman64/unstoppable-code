/** @jest-environment jsdom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  InstalledSkillInfo,
  SharedSkillDetail,
} from '@canopy/protocol/skills';
import type * as CloudAccountHooks from '@/hooks/useCanopyCloudConnected';

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (): void => {},
}));
jest.mock('@/lib/editSkillWithAI', () => ({
  skillDetailEditWithAIState: (): undefined => undefined,
}));
jest.mock('../useEditSkillWithAI', () => ({
  useEditSkillWithAI: (): {
    start: jest.Mock;
    pending: boolean;
    error: null;
  } => ({ start: jest.fn(), pending: false, error: null }),
}));
jest.mock('@/hooks/useWorkspaceContextReset', () => ({
  useWorkspaceContextReset: (): void => {},
}));
jest.mock('@/hooks/useShareAccess', () => ({
  useShareAccess: (): { requestShare: jest.Mock; shareGateModal: null } => ({
    requestShare: jest.fn(),
    shareGateModal: null,
  }),
}));
jest.mock('../ShareSkillModal', () => ({ ShareSkillModal: (): null => null }));
jest.mock('@/hooks/useCanopyCloudConnected', () => ({
  ...jest.requireActual<typeof CloudAccountHooks>(
    '@/hooks/useCanopyCloudConnected',
  ),
  useTryItAccount: (): ReturnType<
    typeof CloudAccountHooks.useTryItAccount
  > => ({ status: 'guest', accountId: 'guest' }),
}));
const mockStartTryItChat = jest.fn<Promise<void>, unknown[]>();
jest.mock('@/lib/tryItChat', () => ({
  startTryItChat: (...args: unknown[]): Promise<void> =>
    mockStartTryItChat(...args),
  TryItStageCancelledError: class extends Error {},
}));
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: (): { addToast: jest.Mock } => ({ addToast: jest.fn() }),
  },
}));

import { InstalledSkillDetail } from '../InstalledSkillDetail';
import { recordSkillUpdateApplied } from '../skillUpdateStatus';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const readContent = jest.fn();
const getShared = jest.fn();

function source(contentHash: string): SharedSkillDetail {
  return {
    id: 'share-1',
    name: 'Shared instructions',
    description: '',
    rawSkill: '',
    contentHash,
    shareScope: 'team',
    owner: {
      type: 'team',
      id: 'team-1',
      name: 'Platform',
      organization: { id: 'org-1', name: 'Acme' },
    },
    createdBy: { id: 'user-1', name: 'Lena', email: null },
    createdAt: '2026-10-14T12:00:00Z',
    updatedAt: '2026-10-14T12:00:00Z',
    canUpdate: false,
    canDelete: false,
    publicShare: null,
  };
}

describe('installed shared copy body and provenance refresh', () => {
  let root: Root;
  let container: HTMLDivElement;
  let name: string;
  let serial = 0;

  beforeEach(() => {
    name = `shared-refresh-${++serial}`;
    readContent.mockReset();
    getShared.mockReset();
    mockStartTryItChat.mockReset();
    mockStartTryItChat.mockResolvedValue(undefined);
    Object.defineProperty(window, 'skills', {
      configurable: true,
      value: {
        readContent,
        getShared,
        listFiles: () =>
          Promise.resolve({
            success: true,
            data: { files: [], truncated: false },
          }),
        onUpdateProgress: (): (() => void) => (): void => {},
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function copy(contentHash: string): InstalledSkillInfo {
    return {
      sourceId: 'custom:app',
      name,
      description: '',
      source: 'Custom skills',
      installedAt: '2026-10-14T12:00:00Z',
      updatedAt: '2026-10-14T12:00:00Z',
      updateAvailable: false,
      custom: true,
      installedFromShare: {
        remoteId: 'share-1',
        shareScope: 'team',
        contentHash,
      },
    };
  }

  function bytes(body: string): object {
    return { success: true, data: { frontmatter: {}, body } };
  }

  async function show(hash: string, revision = false): Promise<void> {
    await act(async () => {
      if (revision) recordSkillUpdateApplied(`custom:app/${name}`);
      root.render(
        <InstalledSkillDetail
          skill={{ sourceId: 'custom:app', name }}
          installedSkill={copy(hash)}
          presentation="page"
          onClose={() => {}}
        />,
      );
      await Promise.resolve();
    });
  }

  function has(testId: string): boolean {
    return container.querySelector(`[data-testid="${testId}"]`) !== null;
  }

  it('reads replaced bytes once for combined signals and clears the stale action', async () => {
    readContent.mockResolvedValueOnce(bytes('Old instructions'));
    getShared.mockResolvedValue(source(HASH_B));
    await show(HASH_A);
    expect(container.textContent).toContain('Old instructions');
    expect(has('installed-share-update')).toBe(true);

    readContent.mockResolvedValue(bytes('New instructions'));
    await show(HASH_B, true);
    expect(readContent).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('New instructions');
    expect(container.textContent).not.toContain('Old instructions');
    expect(has('installed-share-update')).toBe(false);
    expect(has('installed-share-update-available')).toBe(false);
    expect(has('detail-primary-cta')).toBe(true);
    await show(HASH_B);
    expect(readContent).toHaveBeenCalledTimes(2);
  });

  it('shows a failed reload and recovers when a later replacement succeeds', async () => {
    readContent.mockResolvedValueOnce(bytes('Old instructions'));
    getShared.mockResolvedValue(source(HASH_C));
    await show(HASH_A);
    readContent.mockResolvedValueOnce({
      success: false,
      error: 'Read unavailable',
    });
    await show(HASH_B);
    expect(container.textContent).toContain('The skill was updated, but');
    expect(container.textContent).toContain('Read unavailable');
    expect(container.textContent).not.toContain('Old instructions');

    readContent.mockResolvedValueOnce(bytes('Recovered instructions'));
    await show(HASH_C);
    expect(container.textContent).toContain('Recovered instructions');
    expect(container.textContent).not.toContain('Read unavailable');
    expect(has('installed-share-update')).toBe(false);
  });

  it('keeps a menu launch busy when replacement moves Try it back to primary', async () => {
    readContent.mockResolvedValue(bytes('Old instructions'));
    getShared.mockResolvedValue(source(HASH_B));
    await show(HASH_A);
    let finish: () => void = () => {};
    mockStartTryItChat.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="skill-read-detail-more"]',
        )
        ?.click(),
    );
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="skill-read-detail-try-it"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(mockStartTryItChat).toHaveBeenCalledTimes(1);
    try {
      readContent.mockResolvedValue(bytes('New instructions'));
      await show(HASH_B);
      expect(container.textContent).toContain('New instructions');
      const primary = container.querySelector<HTMLButtonElement>(
        '[data-testid="detail-primary-cta"]',
      );
      expect(primary?.textContent).toBe('Opening chat…');
      expect(primary?.disabled).toBe(true);
      act(() => primary?.click());
      expect(mockStartTryItChat).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        finish();
        await Promise.resolve();
      });
    }
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="detail-primary-cta"]',
      )?.disabled,
    ).toBe(false);
  });
});
