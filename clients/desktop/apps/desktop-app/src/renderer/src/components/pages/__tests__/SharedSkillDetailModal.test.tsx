/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockTryItAccount = {
  status: 'signed-in' as 'signed-in' | 'guest' | 'loading',
  accountId: 'account-1',
};
jest.mock('@/hooks/useCanopyCloudConnected', () => ({
  useTryItAccount: (): typeof mockTryItAccount => mockTryItAccount,
}));
jest.mock('@/lib/tryItChat', () => ({
  startTryItChat: jest.fn(() => Promise.resolve()),
}));

import { act, type ReactElement, type ReactNode } from 'react';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { createRoot, type Root } from 'react-dom/client';
import type {
  SharedSkillDetail,
  SharedSkillSummary,
} from '@canopy/desktop-shared/types/skills';

jest.mock('../../shared', () => ({
  DialogModal: ({
    children,
    title,
    topRightActions,
  }: {
    children: ReactNode;
    title?: string;
    topRightActions?: ReactNode;
  }): ReactElement => (
    <div role="dialog">
      {title && <h2>{title}</h2>}
      {topRightActions}
      {children}
    </div>
  ),
  ErrorBanner: ({ error }: { error?: string | null }): ReactElement | null =>
    error ? <div role="alert">{error}</div> : null,
  LoadingPlaceholder: ({ label }: { label: string }): ReactElement => (
    <p>{label}</p>
  ),
  EmptyState: (): ReactElement | null => null,
  DeleteConfirmModal: (): ReactElement | null => null,
}));

jest.mock('@canopy/ui-app', () => ({
  ...jest.requireActual<Record<string, unknown>>('@canopy/ui-app'),
  MarkdownFrontmatterContent: (): ReactElement => (
    <div data-testid="markdown-content" />
  ),
  SkillReadDetail: ({
    skill,
    content,
    hostHeader,
  }: {
    skill: { name: string };
    content: { body: string } | null;
    hostHeader?: { title: string; description?: string };
  }): ReactElement => (
    <div
      data-testid="skill-read-detail"
      data-skill-name={skill.name}
      data-body={content?.body ?? ''}
      data-host-title={hostHeader?.title ?? ''}
    />
  ),
}));

const resolveSharedSkillUrl: jest.Mock<
  Promise<string | null>,
  [string]
> = jest.fn<Promise<string | null>, [sharePath: string]>(() =>
  Promise.resolve(null),
);
jest.mock('@/lib/share-links', () => ({
  ...jest.requireActual<Record<string, unknown>>('@/lib/share-links'),
  resolveSharedSkillUrl: (sharePath: string): Promise<string | null> =>
    resolveSharedSkillUrl(sharePath),
}));

const copyTextToClipboard = jest.fn<Promise<boolean>, [value: string]>(() =>
  Promise.resolve(true),
);
jest.mock('@/lib/clipboard', () => ({
  copyTextToClipboard: (value: string): Promise<boolean> =>
    copyTextToClipboard(value),
}));

const ABSENT: SharedSkillInstallLookup = { status: 'absent' };
/** A receipted copy under `skillName`; stale when `updateAvailable`. */
function installedAs(
  skillName: string,
  updateAvailable = false,
): SharedSkillInstallLookup {
  return {
    status: 'installed',
    skillId: `custom:app/${skillName}`,
    sourceId: 'custom:app',
    skillName,
    updateAvailable,
    locallyEdited: false,
    localContentHash: 'b'.repeat(64),
    sourceContentHash: 'a'.repeat(64),
  };
}
const lookupInstalledSharedSkill: jest.Mock<
  Promise<SharedSkillInstallLookup>,
  [Pick<SharedSkillDetail, 'id' | 'contentHash' | 'package'>]
> = jest.fn<
  Promise<SharedSkillInstallLookup>,
  [detail: Pick<SharedSkillDetail, 'id' | 'contentHash' | 'package'>]
>(() => Promise.resolve(ABSENT));
jest.mock('@/lib/sharedSkillImport', () => ({
  ...jest.requireActual<Record<string, unknown>>('@/lib/sharedSkillImport'),
  lookupInstalledSharedSkill: (
    detail: Pick<SharedSkillDetail, 'id' | 'contentHash' | 'package'>,
  ): Promise<SharedSkillInstallLookup> => lookupInstalledSharedSkill(detail),
}));

import type { SharedSkillInstallLookup } from '@/lib/sharedSkillImport';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { SharedSkillDetailModal } from '../SkillsTab';

const PUBLIC_SHARE = {
  externalId: 'share-1',
  pinnedContentHash: 'sha256:abc',
  upToDate: true,
  sharePath: '/s/skills/skill-1',
  createdAt: '2026-07-30T00:00:00Z',
  updatedAt: '2026-07-30T00:00:00Z',
};

function makeSummary(
  overrides: Partial<SharedSkillSummary> = {},
): SharedSkillSummary {
  return {
    id: 'skill-1',
    name: 'helper',
    description: 'A helper skill',
    contentHash: 'sha256:abc',
    shareScope: 'private',
    owner: { type: 'user', id: 'user-1', name: 'Alice' },
    createdBy: { id: 'user-1', name: 'Alice', email: 'alice@example.test' },
    createdAt: '2026-07-30T00:00:00Z',
    updatedAt: '2026-07-30T00:00:00Z',
    canUpdate: true,
    canDelete: true,
    publicShare: null,
    ...overrides,
  };
}

function makeDetail(
  overrides: Partial<SharedSkillDetail> = {},
): SharedSkillDetail {
  return {
    ...makeSummary(),
    rawSkill: '---\nname: helper\n---\n\n# Helper body',
    ...overrides,
  };
}

describe('SharedSkillDetailModal public link section', () => {
  let container: HTMLElement;
  let root: Root;
  const getShared = jest.fn();
  const publishPublicShare = jest.fn();
  const revokePublicShare = jest.fn();

  beforeEach(() => {
    mockTryItAccount.status = 'signed-in';
    getShared.mockReset();
    publishPublicShare.mockReset();
    revokePublicShare.mockReset();
    resolveSharedSkillUrl.mockReset();
    copyTextToClipboard.mockClear();
    lookupInstalledSharedSkill.mockReset();
    lookupInstalledSharedSkill.mockResolvedValue(ABSENT);
    resolveSharedSkillUrl.mockResolvedValue(
      'https://cloud.example.test/s/skills/skill-1',
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    Object.assign(window, {
      skills: { getShared, publishPublicShare, revokePublicShare },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  async function renderModal(
    onUpdated: jest.Mock = jest.fn(),
    summary: SharedSkillSummary = makeSummary(),
    onAdd?: () => void,
    onOpenInstalled?: (skillName: string) => void,
  ): Promise<void> {
    await act(async () => {
      root.render(
        <SharedSkillDetailModal
          mode="view"
          summary={summary}
          onClose={() => {}}
          onUpdated={onUpdated}
          onSwitchToEdit={() => {}}
          onAdd={onAdd}
          onOpenInstalled={onOpenInstalled}
        />,
      );
      await Promise.resolve();
    });
  }

  function byTestId(testId: string): Element | null {
    if (testId === 'shared-skill-detail-add')
      return document.querySelector(
        '[data-testid="detail-primary-cta"][data-state="install"], [data-testid="detail-primary-cta"][data-state="busy"]',
      );
    return document.querySelector(`[data-testid="${testId}"]`);
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  // CAN-4263: the loaded detail's own verdict decides Unshare, so a stale
  // list summary can neither grant nor withhold it.
  it('asks the host for Unshare with the loaded detail, ahead of Edit', async () => {
    getShared.mockResolvedValue(makeDetail({ canDelete: false }));
    const renderUnshare = jest.fn((detail: SharedSkillDetail) =>
      detail.canDelete ? (
        <button type="button" data-testid="host-unshare">
          Unshare
        </button>
      ) : null,
    );
    await act(async () => {
      root.render(
        <SharedSkillDetailModal
          mode="view"
          summary={makeSummary({ canDelete: true })}
          onClose={() => {}}
          onUpdated={jest.fn()}
          onSwitchToEdit={() => {}}
          renderUnshare={renderUnshare}
        />,
      );
      await Promise.resolve();
    });
    await settle();
    expect(renderUnshare).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'skill-1', canDelete: false }),
    );
    expect(byTestId('host-unshare')).toBeNull();

    getShared.mockResolvedValue(makeDetail({ canDelete: true }));
    await act(async () => {
      root.render(
        <SharedSkillDetailModal
          key="reload"
          mode="view"
          summary={makeSummary({ canDelete: false })}
          onClose={() => {}}
          onUpdated={jest.fn()}
          onSwitchToEdit={() => {}}
          renderUnshare={renderUnshare}
        />,
      );
      await Promise.resolve();
    });
    await settle();
    const bar = byTestId('detail-action-bar');
    const first = bar?.querySelector('button');
    expect(first?.getAttribute('data-testid')).toBe('host-unshare');
    expect(bar?.textContent).toContain('Edit');
  });

  // Add opens the shared install review (CAN-3710); the review installs the
  // skill and lands on it, so this page writes nothing itself.
  it('opens the install review from Add without writing anything', async () => {
    getShared.mockResolvedValue(makeDetail());
    const onAdd = jest.fn();
    await renderModal(jest.fn(), makeSummary(), onAdd, jest.fn());
    await settle();

    await click('shared-skill-detail-add');
    await settle();

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(byTestId('shared-skill-detail-installed-status')).toBeNull();
    expect(byTestId('shared-skill-detail-add')?.textContent).toBe('Install');
  });

  it('keeps the install review available beside Try it for guests', async () => {
    mockTryItAccount.status = 'guest';
    getShared.mockResolvedValue(makeDetail());
    const onAdd = jest.fn();
    await renderModal(jest.fn(), makeSummary(), onAdd, jest.fn());
    await settle();

    expect(byTestId('detail-primary-cta')?.textContent).toBe('Try it');
    const install = document.querySelector(
      '[data-testid="shared-skill-detail-add"]',
    );
    expect(install?.textContent).toBe('Install');
    act(() => {
      install?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(byTestId('shared-skill-detail-installed-status')).toBeNull();
  });

  it('opens on the installed outcome when this share is already installed', async () => {
    const detail = makeDetail();
    getShared.mockResolvedValue(detail);
    lookupInstalledSharedSkill.mockResolvedValue(installedAs('helper'));
    const onAdd = jest.fn();
    const onOpenInstalled = jest.fn();
    await renderModal(jest.fn(), makeSummary(), onAdd, onOpenInstalled);
    await settle();

    expect(lookupInstalledSharedSkill).toHaveBeenCalledWith(detail);
    expect(byTestId('shared-skill-detail-add')).toBeNull();
    expect(byTestId('shared-skill-detail-installed-status')?.textContent).toBe(
      'Installed on this device as “helper”.',
    );
    // The installed name is session-replay blocked; the copy is not.
    expect(
      byTestId('shared-skill-detail-installed-status')?.querySelector(
        `.${POSTHOG_REPLAY_BLOCK_CLASS}`,
      )?.textContent,
    ).toBe('helper');
    expect(byTestId('shared-skill-detail-open')).not.toBeNull();
    act(() => {
      byTestId('shared-skill-detail-open')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(onOpenInstalled).toHaveBeenCalledWith('helper');
    expect(byTestId('detail-primary-cta')?.textContent).toBe('Try it');
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('offers only a retry when the installed check fails (CAN-5307)', async () => {
    getShared.mockResolvedValue(makeDetail());
    lookupInstalledSharedSkill.mockRejectedValueOnce(new Error('read failed'));
    lookupInstalledSharedSkill.mockResolvedValueOnce({ status: 'unverified' });
    lookupInstalledSharedSkill.mockResolvedValueOnce({
      status: 'missing-copy',
    });
    await renderModal(jest.fn(), makeSummary(), jest.fn(), jest.fn());
    await settle();

    // Install could duplicate a receipted copy that was not verified.
    expect(byTestId('shared-skill-detail-add')).toBeNull();
    expect(byTestId('shared-skill-detail-installed-status')).toBeNull();
    expect(
      byTestId('shared-skill-detail-install-check-error')?.textContent,
    ).toBe(
      'Your installed copy of this skill could not be checked. Try again.',
    );

    await click('shared-skill-detail-retry');
    await settle();
    expect(lookupInstalledSharedSkill).toHaveBeenCalledTimes(2);
    expect(byTestId('shared-skill-detail-add')).toBeNull();

    await click('shared-skill-detail-retry');
    await settle();
    expect(
      byTestId('shared-skill-detail-install-check-error')?.textContent,
    ).toBe(
      'Your installed copy of this skill is missing. Restore it, then try again.',
    );
    expect(byTestId('shared-skill-detail-add')).toBeNull();
  });

  it('offers Update through the review for a stale receipted copy (CAN-5307)', async () => {
    getShared.mockResolvedValue(makeDetail());
    lookupInstalledSharedSkill.mockResolvedValue(installedAs('helper', true));
    const onAdd = jest.fn();
    await renderModal(jest.fn(), makeSummary(), onAdd, jest.fn());
    await settle();

    expect(byTestId('shared-skill-detail-add')).toBeNull();
    expect(byTestId('shared-skill-detail-installed-status')?.textContent).toBe(
      'Installed on this device as “helper”. An update is available.',
    );
    expect(byTestId('shared-skill-detail-open')).not.toBeNull();
    expect(byTestId('shared-skill-detail-uninstall')).not.toBeNull();
    await click('shared-skill-detail-update');
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('uninstalls the installed copy behind a confirm and rechecks', async () => {
    const removeSkill = jest.fn(() => Promise.resolve({ success: true }));
    Object.assign(window.skills, { removeSkill });
    getShared.mockResolvedValue(makeDetail());
    lookupInstalledSharedSkill
      .mockResolvedValueOnce(installedAs('helper'))
      .mockResolvedValue(ABSENT);
    await renderModal(jest.fn(), makeSummary(), jest.fn(), jest.fn());
    await settle();

    await click('shared-skill-detail-uninstall');
    expect(byTestId('shared-skill-detail-uninstall-dialog')).not.toBeNull();
    expect(removeSkill).not.toHaveBeenCalled();
    await click('shared-skill-detail-uninstall-confirm');
    await settle();

    expect(removeSkill).toHaveBeenCalledWith('custom:app', 'helper');
    expect(lookupInstalledSharedSkill).toHaveBeenCalledTimes(2);
    expect(byTestId('shared-skill-detail-installed-status')).toBeNull();
    expect(byTestId('shared-skill-detail-add')?.textContent).toBe('Install');
  });

  it('rechecks when a skill install or update lands elsewhere', async () => {
    getShared.mockResolvedValue(makeDetail());
    lookupInstalledSharedSkill
      .mockResolvedValueOnce(installedAs('helper', true))
      .mockResolvedValue(installedAs('helper'));
    await renderModal(jest.fn(), makeSummary(), jest.fn(), jest.fn());
    await settle();
    expect(byTestId('shared-skill-detail-update')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new Event('canopy:skills-changed'));
      await Promise.resolve();
    });
    await settle();

    expect(byTestId('shared-skill-detail-update')).toBeNull();
    expect(byTestId('shared-skill-detail-installed-status')?.textContent).toBe(
      'Installed on this device as “helper”.',
    );
  });

  it('reloads package-only source changes on skill events and rechecks context changes', async () => {
    const current = makeDetail();
    getShared.mockResolvedValue(current);
    lookupInstalledSharedSkill.mockImplementation((source) =>
      Promise.resolve(installedAs('helper', source.package !== undefined)),
    );
    await renderModal(jest.fn(), makeSummary(), jest.fn(), jest.fn());
    await settle();
    expect(byTestId('shared-skill-detail-update')).toBeNull();
    getShared.mockResolvedValue({
      ...current,
      distributionMode: 'package',
      package: { digest: 'pp:v1:' + 'B'.repeat(43) },
    });
    act(() => {
      window.dispatchEvent(new Event('canopy:skills-changed'));
    });
    await settle();
    expect(byTestId('shared-skill-detail-update')).not.toBeNull();
    getShared.mockRejectedValue(new Error('access removed in new context'));
    act(() => {
      useWorkspaceContextStore.setState((state) => ({
        appliedGeneration: state.appliedGeneration + 1,
      }));
    });
    await settle();
    expect(byTestId('shared-skill-detail-update')).toBeNull();
    expect(byTestId('shared-skill-detail-retry')).not.toBeNull();
    expect(byTestId('shared-skill-detail-add')).toBeNull();
  });

  it('offers Retry when the shared skill cannot be read to check it', async () => {
    getShared.mockRejectedValue(new Error('initial load failed'));
    await renderModal(jest.fn(), makeSummary(), jest.fn(), jest.fn());
    await settle();

    expect(lookupInstalledSharedSkill).not.toHaveBeenCalled();
    expect(byTestId('shared-skill-detail-add')).toBeNull();
    expect(byTestId('shared-skill-detail-retry')?.textContent).toBe(
      'Try again',
    );
  });

  it('ignores an installed check that finishes after the share changed', async () => {
    let resolveFirst: (found: SharedSkillInstallLookup) => void = () => {};
    lookupInstalledSharedSkill
      .mockImplementationOnce(
        () =>
          new Promise<SharedSkillInstallLookup>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue(ABSENT);
    getShared
      .mockResolvedValueOnce(makeDetail())
      .mockResolvedValueOnce(makeDetail({ id: 'skill-2', name: 'other' }));
    const onAdd = jest.fn();
    await renderModal(jest.fn(), makeSummary(), onAdd, jest.fn());
    await settle();
    await renderModal(
      jest.fn(),
      makeSummary({ id: 'skill-2', name: 'other' }),
      onAdd,
      jest.fn(),
    );
    await settle();

    await act(async () => {
      resolveFirst(installedAs('helper'));
      await Promise.resolve();
    });

    expect(byTestId('shared-skill-detail-installed-status')).toBeNull();
    expect(byTestId('shared-skill-detail-add')?.textContent).toBe('Install');
  });

  it('offers Retry when the next share cannot be read after a share change', async () => {
    getShared
      .mockResolvedValueOnce(makeDetail())
      .mockRejectedValueOnce(new Error('next load failed'));
    lookupInstalledSharedSkill.mockResolvedValue(installedAs('helper'));
    const onAdd = jest.fn();
    await renderModal(jest.fn(), makeSummary(), onAdd, jest.fn());
    await settle();
    expect(byTestId('shared-skill-detail-installed-status')).not.toBeNull();

    await renderModal(
      jest.fn(),
      makeSummary({ id: 'skill-2', name: 'other' }),
      onAdd,
      jest.fn(),
    );
    await settle();

    // The previous share's installed copy says nothing about this one.
    expect(lookupInstalledSharedSkill).toHaveBeenCalledTimes(1);
    expect(byTestId('shared-skill-detail-installed-status')).toBeNull();
    expect(byTestId('shared-skill-detail-add')).toBeNull();
    expect(byTestId('shared-skill-detail-retry')).not.toBeNull();
  });

  it('does not check installed state where the detail offers no Add', async () => {
    getShared.mockResolvedValue(makeDetail());
    await renderModal(jest.fn(), makeSummary());
    await settle();

    expect(lookupInstalledSharedSkill).not.toHaveBeenCalled();
    expect(byTestId('shared-skill-detail-installed-status')).toBeNull();
  });

  function click(testId: string): Promise<void> {
    return act(async () => {
      byTestId(testId)?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('publishes and applies the mutation result even when refresh fails', async () => {
    getShared
      .mockResolvedValueOnce(makeDetail())
      .mockRejectedValue(new Error('transient refresh failure'));
    publishPublicShare.mockResolvedValue(PUBLIC_SHARE);
    const onUpdated = jest.fn();
    await renderModal(onUpdated);

    expect(
      document.querySelector(
        '[data-testid="shared-skill-publish-public-link"]',
      ),
    ).not.toBeNull();

    await click('shared-skill-publish-public-link');

    expect(publishPublicShare).toHaveBeenCalledWith('skill-1');
    // The mutation result is applied locally despite the refresh failure, and
    // no error banner appears for the failed best-effort refresh.
    expect(document.body.textContent).toContain(
      'https://cloud.example.test/s/skills/skill-1',
    );
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(onUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ publicShare: PUBLIC_SHARE }),
    );
    expect(
      document.querySelector('[data-testid="shared-skill-copy-public-link"]'),
    ).not.toBeNull();
  });

  it('shows the stale-pin update action and re-pins through publish', async () => {
    getShared.mockResolvedValue(
      makeDetail({
        contentHash: 'sha256:new',
        publicShare: { ...PUBLIC_SHARE, upToDate: false },
      }),
    );
    publishPublicShare.mockResolvedValue({ ...PUBLIC_SHARE, upToDate: true });
    await renderModal();

    await click('shared-skill-update-public-link');

    expect(publishPublicShare).toHaveBeenCalledWith('skill-1');
  });

  it('revokes and clears the link locally', async () => {
    getShared
      .mockResolvedValueOnce(makeDetail({ publicShare: PUBLIC_SHARE }))
      .mockRejectedValue(new Error('transient refresh failure'));
    revokePublicShare.mockResolvedValue(undefined);
    await renderModal();

    expect(document.body.textContent).toContain(
      'https://cloud.example.test/s/skills/skill-1',
    );

    await click('shared-skill-remove-public-link');

    expect(revokePublicShare).toHaveBeenCalledWith('skill-1');
    expect(
      document.querySelector(
        '[data-testid="shared-skill-publish-public-link"]',
      ),
    ).not.toBeNull();
    expect(document.body.textContent).not.toContain(
      'https://cloud.example.test/s/skills/skill-1',
    );
  });

  it('falls back to the relative sharePath when no base URL resolves', async () => {
    resolveSharedSkillUrl.mockResolvedValue(null);
    getShared.mockResolvedValue(makeDetail({ publicShare: PUBLIC_SHARE }));
    await renderModal();

    expect(document.body.textContent).toContain('/s/skills/skill-1');

    await click('shared-skill-copy-public-link');
    expect(copyTextToClipboard).toHaveBeenCalledWith('/s/skills/skill-1');
  });

  it('lets non-owners copy the resolved public link without management controls', async () => {
    getShared.mockResolvedValue(
      makeDetail({
        canUpdate: false,
        canDelete: false,
        publicShare: { ...PUBLIC_SHARE, upToDate: false },
      }),
    );
    await renderModal(
      jest.fn(),
      makeSummary({
        canUpdate: false,
        canDelete: false,
        publicShare: { ...PUBLIC_SHARE, upToDate: false },
      }),
    );

    expect(document.body.textContent).toContain(
      'https://cloud.example.test/s/skills/skill-1',
    );
    await click('shared-skill-copy-public-link');
    expect(copyTextToClipboard).toHaveBeenCalledWith(
      'https://cloud.example.test/s/skills/skill-1',
    );
    expect(
      document.querySelector(
        '[data-testid="shared-skill-publish-public-link"]',
      ),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="shared-skill-update-public-link"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="shared-skill-remove-public-link"]'),
    ).toBeNull();
  });

  it('lets non-owners copy the raw share path when URL resolution fails', async () => {
    resolveSharedSkillUrl.mockResolvedValue(null);
    const summary = makeSummary({
      canUpdate: false,
      canDelete: false,
      publicShare: PUBLIC_SHARE,
    });
    getShared.mockResolvedValue(
      makeDetail({
        canUpdate: false,
        canDelete: false,
        publicShare: PUBLIC_SHARE,
      }),
    );
    await renderModal(jest.fn(), summary);

    await click('shared-skill-copy-public-link');
    expect(copyTextToClipboard).toHaveBeenCalledWith('/s/skills/skill-1');
  });

  it('surfaces publish failures as an error banner', async () => {
    getShared.mockResolvedValue(makeDetail());
    publishPublicShare.mockRejectedValue(new Error('boom'));
    await renderModal();

    await click('shared-skill-publish-public-link');

    expect(document.body.textContent).toContain(
      'Failed to publish public link.',
    );
    expect(
      document.querySelector(
        '[data-testid="shared-skill-publish-public-link"]',
      ),
    ).not.toBeNull();
  });

  it('shows saved-copy provenance in the detail header area', async () => {
    getShared.mockResolvedValue(
      makeDetail({
        savedFrom: {
          id: 'source-skill-1',
          name: 'original-helper',
          createdByName: 'Source Author',
        },
      }),
    );
    await renderModal();

    const provenance = document.querySelector(
      '[data-testid="shared-skill-detail-saved-from"]',
    );
    expect(provenance?.textContent).toBe(
      'Saved from original-helper by Source Author',
    );
  });

  it('renders the shared skill through the shared read core', async () => {
    getShared.mockResolvedValue(makeDetail());
    await renderModal();

    const readDetail = document.querySelector(
      '[data-testid="skill-read-detail"]',
    );
    expect(readDetail).not.toBeNull();
    expect(readDetail?.getAttribute('data-skill-name')).toBe('helper');
    expect(readDetail?.getAttribute('data-body')).toContain('# Helper body');
    expect(
      document.querySelector('[data-testid="markdown-content"]'),
    ).toBeNull();
  });
});

// CAN-4261: the page presentation uses the shared detail header like every
// other Customize detail: title, description and meta, at most three visible
// actions and one ⋯ menu, with no Name/Description card or repeated title.
describe('SharedSkillDetailModal page', () => {
  let container: HTMLElement;
  let root: Root;
  const getShared = jest.fn();
  const publishPublicShare = jest.fn();
  const revokePublicShare = jest.fn();

  beforeEach(() => {
    mockTryItAccount.status = 'signed-in';
    getShared.mockReset();
    publishPublicShare.mockReset();
    revokePublicShare.mockReset();
    lookupInstalledSharedSkill.mockReset();
    lookupInstalledSharedSkill.mockResolvedValue(ABSENT);
    resolveSharedSkillUrl.mockReset();
    resolveSharedSkillUrl.mockResolvedValue(null);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    Object.assign(window, {
      skills: { getShared, publishPublicShare, revokePublicShare },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  async function renderPage(
    props: Partial<Parameters<typeof SharedSkillDetailModal>[0]> = {},
  ): Promise<void> {
    await act(async () => {
      root.render(
        <SharedSkillDetailModal
          mode="view"
          presentation="page"
          summary={makeSummary()}
          onClose={() => {}}
          onUpdated={jest.fn()}
          onSwitchToEdit={() => {}}
          onAdd={jest.fn()}
          {...props}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function q(testId: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  }

  function openMore(): string[] {
    act(() => q('plugins-entry-detail-more')?.click());
    return Array.from(
      document.querySelectorAll(
        '[data-testid="plugins-entry-detail-menu"] [role="menuitem"]',
      ),
    ).map((item) => item.textContent ?? '');
  }

  it('renders the shared header and hands the title to the read core', async () => {
    getShared.mockResolvedValue(makeDetail());
    await renderPage();
    expect(q('plugins-entry-detail-header-title')?.textContent).toBe('helper');
    expect(q('plugins-entry-detail-header-description')?.textContent).toBe(
      'A helper skill',
    );
    // The read core drops the frontmatter card and repeated title.
    expect(q('skill-read-detail')?.getAttribute('data-host-title')).toBe(
      'helper',
    );
    expect(document.querySelectorAll('h1')).toHaveLength(1);
  });

  // CAN-5016: who shared it, the owning organization and the audience lead
  // the meta, before the installed and public-link facts.
  const LENA_ACME: Partial<SharedSkillSummary> = {
    shareScope: 'organization',
    owner: { type: 'organization', id: 'org-acme', name: 'Acme' },
    createdBy: { id: 'user-lena', name: 'Lena Park', email: 'lena@acme.test' },
  };

  /** The meta facts present, in document order. */
  function metaFacts(): string[] {
    const meta = q('plugins-entry-detail-header-meta');
    const facts = [
      q('shared-skill-detail-audience-author'),
      q('shared-skill-detail-audience-organization'),
      q('shared-skill-detail-audience'),
      q('shared-skill-detail-installed-status'),
    ].filter((node): node is HTMLElement => node !== null);
    facts.forEach((node) => expect(meta?.contains(node)).toBe(true));
    facts.slice(1).forEach((next, index) => {
      expect(
        (facts[index]?.compareDocumentPosition(next) ?? 0) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
    return facts.map((node) => node.textContent ?? '');
  }

  it('names the author, owning organization and audience before install', async () => {
    getShared.mockResolvedValue(makeDetail(LENA_ACME));
    await renderPage({ summary: makeSummary(LENA_ACME) });
    expect(q('plugins-entry-detail-header-description')?.textContent).toBe(
      'A helper skill',
    );
    expect(metaFacts()).toEqual(['By Lena Park', 'Acme', 'Organization']);
    expect(q('plugins-entry-detail-header-meta')?.textContent).not.toContain(
      'lena@acme.test',
    );
    expect(q('plugins-entry-detail-header-meta')?.textContent).not.toContain(
      'Public link',
    );
  });

  it('names a team skill’s parent organization and team audience', async () => {
    const team: Partial<SharedSkillSummary> = {
      ...LENA_ACME,
      shareScope: 'team',
      owner: {
        type: 'team',
        id: 'team-platform',
        name: 'Platform',
        organization: { id: 'org-acme', name: 'Acme' },
      },
    };
    getShared.mockResolvedValue(makeDetail(team));
    await renderPage({ summary: makeSummary(team) });
    expect(metaFacts()).toEqual(['By Lena Park', 'Acme', 'Team: Platform']);
  });

  it('refreshes provenance after loading without replacing the summary description', async () => {
    let resolveDetail: (detail: SharedSkillDetail) => void = () => {
      throw new Error('The detail request was not started.');
    };
    getShared.mockImplementation(
      () =>
        new Promise<SharedSkillDetail>((resolve) => {
          resolveDetail = resolve;
        }),
    );
    await renderPage({ summary: makeSummary(LENA_ACME) });
    expect(metaFacts()).toEqual(['By Lena Park', 'Acme', 'Organization']);
    expect(q('plugins-entry-detail-header-meta')?.textContent).not.toContain(
      'Public link',
    );

    await act(async () => {
      resolveDetail(
        makeDetail({
          ...LENA_ACME,
          createdBy: {
            id: 'other-author',
            name: 'Updated Author',
            email: 'author@example.com',
          },
          description: 'A different loaded description',
          publicShare: PUBLIC_SHARE,
        }),
      );
      await Promise.resolve();
    });
    expect(q('plugins-entry-detail-header-description')?.textContent).toBe(
      'A helper skill',
    );
    expect(metaFacts()).toEqual(['By Updated Author', 'Acme', 'Public']);
    const meta = q('plugins-entry-detail-header-meta')?.textContent ?? '';
    expect(meta.match(/By Updated Author/g)).toHaveLength(1);
    expect(meta).not.toContain('By Lena Park');
    expect(meta).toContain('Public link');
  });

  it('keeps provenance once installed, followed by the installed status', async () => {
    getShared.mockResolvedValue(makeDetail(LENA_ACME));
    lookupInstalledSharedSkill.mockResolvedValue(installedAs('helper'));
    await renderPage({ summary: makeSummary(LENA_ACME) });
    expect(metaFacts()).toEqual([
      'By Lena Park',
      'Acme',
      'Organization',
      'Installed on this device as “helper”',
    ]);
  });

  it('keeps ownership beside the public link once the detail loads', async () => {
    const linked = { ...LENA_ACME, publicShare: PUBLIC_SHARE };
    getShared.mockResolvedValue(makeDetail(linked));
    lookupInstalledSharedSkill.mockResolvedValue(installedAs('helper'));
    await renderPage({ summary: makeSummary(linked) });
    expect(metaFacts()).toEqual([
      'By Lena Park',
      'Acme',
      'Public',
      'Installed on this device as “helper”',
    ]);
    const meta = q('plugins-entry-detail-header-meta')?.textContent ?? '';
    expect(meta.indexOf('Installed on this device as')).toBeLessThan(
      meta.indexOf('Public link'),
    );
    expect(meta.match(/By Lena Park/g)).toHaveLength(1);
  });

  it('shows no provenance facts for a private skill and no bare By', async () => {
    getShared.mockResolvedValue(
      makeDetail({ createdBy: { id: 'u', name: null, email: 'a@b.test' } }),
    );
    await renderPage({
      summary: makeSummary({
        createdBy: { id: 'u', name: null, email: 'a@b.test' },
      }),
    });
    expect(metaFacts()).toEqual([]);
    expect(
      q('plugins-entry-detail-header-meta')?.textContent ?? '',
    ).not.toMatch(/\bBy\b/);
  });

  it('keeps Unshare and the public link in ⋯, not in the bar or body', async () => {
    getShared.mockResolvedValue(makeDetail({ canDelete: true }));
    await renderPage({
      unshareOptions: () => ({
        kind: 'skill',
        name: 'helper',
        onUnshare: (): Promise<void> => Promise.resolve(),
        onUnshared: (): void => {},
      }),
    });
    expect(q('shared-skill-publish-public-link')).toBeNull();
    const bar = q('plugins-entry-detail-header-actions');
    expect(bar?.textContent).not.toContain('Unshare');
    const items = openMore();
    expect(items).toContain('Publish public link');
    expect(items[items.length - 1]).toBe('Unshare');
  });

  it('hides a Share it cannot use instead of showing it disabled', async () => {
    getShared.mockResolvedValue(makeDetail());
    await renderPage({
      shareAction: { status: 'blocked', reason: 'Only the owner can share.' },
    });
    expect(q('plugins-entry-detail-share')).toBeNull();
  });

  it('shows at most three visible actions beside one ⋯', async () => {
    getShared.mockResolvedValue(makeDetail());
    lookupInstalledSharedSkill.mockResolvedValue(installedAs('helper'));
    await renderPage({
      onOpenInstalled: jest.fn(),
      shareAction: { status: 'shareable', onShare: () => {} },
    });
    const bar = q('plugins-entry-detail-header-actions');
    const visible = Array.from(bar?.querySelectorAll('button') ?? []).filter(
      (button) =>
        button.getAttribute('data-testid') !== 'plugins-entry-detail-more',
    );
    expect(visible.length).toBeLessThanOrEqual(3);
    expect(
      bar?.querySelectorAll('[data-testid="plugins-entry-detail-more"]'),
    ).toHaveLength(1);
    expect(openMore()).toContain('Open installed skill');
  });

  // CAN-5018: the installed copy is named and one visible click away.
  it('says where it is installed and opens the current installed name', async () => {
    getShared.mockResolvedValue(makeDetail());
    lookupInstalledSharedSkill.mockResolvedValue(
      installedAs('helper (renamed)'),
    );
    const onOpenInstalled = jest.fn();
    await renderPage({ onOpenInstalled });
    const status = q('shared-skill-detail-installed-status');
    expect(status?.textContent).toBe(
      'Installed on this device as “helper (renamed)”',
    );
    expect(
      status?.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)?.textContent,
    ).toBe('helper (renamed)');
    const open = q('shared-skill-detail-open-installed');
    expect(open?.tagName).toBe('BUTTON');
    expect(open?.textContent).toBe('Open');
    act(() => open?.click());
    expect(onOpenInstalled).toHaveBeenCalledWith('helper (renamed)');
    // The ⋯ menu keeps its own Open installed skill.
    expect(openMore()).toContain('Open installed skill');
  });

  it('shows no installed status or Open without an installed copy', async () => {
    getShared.mockResolvedValue(makeDetail());
    await renderPage({ onOpenInstalled: jest.fn() });
    expect(q('shared-skill-detail-installed-status')).toBeNull();
    expect(q('shared-skill-detail-open-installed')).toBeNull();
  });

  // CAN-5224: where Shared by you lists the owner's audiences, the header
  // keeps who shared it and the owning organization, and drops the audience
  // and its Public link fact instead of repeating them.
  describe('header audience beside Shared by you (CAN-5224)', () => {
    const ORG_LINKED: Partial<SharedSkillSummary> = {
      ...LENA_ACME,
      canDelete: true,
      publicShare: PUBLIC_SHARE,
    };
    const renderSharedByYou = (): ReactElement => (
      <section data-testid="t-shared-by-you" />
    );

    function metaText(): string {
      return q('plugins-entry-detail-header-meta')?.textContent ?? '';
    }

    function expectAudienceDeferred(): void {
      expect(metaFacts()).toEqual(['By Lena Park', 'Acme']);
      expect(q('shared-skill-detail-audience')).toBeNull();
      expect(metaText()).not.toContain('Public');
      expect(metaText()).not.toContain('Organization');
    }

    it('keeps author and organization and drops the audience and Public link', async () => {
      getShared.mockResolvedValue(makeDetail(ORG_LINKED));
      await renderPage({ summary: makeSummary(ORG_LINKED), renderSharedByYou });
      expect(q('t-shared-by-you')).not.toBeNull();
      expectAudienceDeferred();
    });

    it('stays deferred after the public link is removed and the detail refreshes', async () => {
      getShared.mockResolvedValue(makeDetail(ORG_LINKED));
      let refresh: () => Promise<void> = () => Promise.resolve();
      await renderPage({
        summary: makeSummary(ORG_LINKED),
        renderSharedByYou: (_detail, nextRefresh) => {
          refresh = nextRefresh;
          return <section data-testid="t-shared-by-you" />;
        },
      });
      getShared.mockResolvedValue(
        makeDetail({ ...ORG_LINKED, publicShare: null }),
      );
      await act(async () => {
        await refresh();
      });
      expectAudienceDeferred();
    });

    it('defers while the detail loads for an owner summary', async () => {
      getShared.mockReturnValue(new Promise<SharedSkillDetail>(() => {}));
      await renderPage({ summary: makeSummary(ORG_LINKED), renderSharedByYou });
      expect(q('t-shared-by-you')).toBeNull();
      expectAudienceDeferred();
    });

    it('restores the audience when the loaded detail is not the owner’s', async () => {
      getShared.mockResolvedValue(
        makeDetail({ ...ORG_LINKED, canDelete: false }),
      );
      await renderPage({ summary: makeSummary(ORG_LINKED), renderSharedByYou });
      expect(metaFacts()).toEqual(['By Lena Park', 'Acme', 'Public']);
      expect(metaText()).toContain('Public link');
    });

    it('defers once the loaded detail shows a recipient summary was stale', async () => {
      getShared.mockResolvedValue(makeDetail(ORG_LINKED));
      await renderPage({
        summary: makeSummary({ ...ORG_LINKED, canDelete: false }),
        renderSharedByYou,
      });
      expectAudienceDeferred();
    });

    it('keeps the audience for a recipient', async () => {
      const recipient = { ...LENA_ACME, canDelete: false };
      getShared.mockResolvedValue(makeDetail(recipient));
      await renderPage({ summary: makeSummary(recipient), renderSharedByYou });
      expect(metaFacts()).toEqual(['By Lena Park', 'Acme', 'Organization']);
    });

    it('keeps the audience in edit mode, where the section is hidden', async () => {
      getShared.mockResolvedValue(makeDetail(ORG_LINKED));
      await renderPage({
        mode: 'edit',
        summary: makeSummary(ORG_LINKED),
        renderSharedByYou,
      });
      expect(q('t-shared-by-you')).toBeNull();
      expect(metaFacts()).toEqual(['By Lena Park', 'Acme', 'Public']);
    });

    it('keeps the header unchanged when the owner has no audience to list', async () => {
      const unlisted: Partial<SharedSkillSummary> = {
        ...LENA_ACME,
        shareScope: 'private',
        canDelete: true,
      };
      getShared.mockResolvedValue(makeDetail(unlisted));
      await renderPage({ summary: makeSummary(unlisted) });
      const withoutSection = metaFacts();

      await renderPage({ summary: makeSummary(unlisted), renderSharedByYou });
      expect(metaFacts()).toEqual(withoutSection);
    });

    it('restores the audience when the detail fails to load', async () => {
      getShared.mockRejectedValue(new Error('offline'));
      await renderPage({ summary: makeSummary(ORG_LINKED), renderSharedByYou });
      expect(q('t-shared-by-you')).toBeNull();
      expect(metaFacts()).toEqual(['By Lena Park', 'Acme', 'Public']);
    });
  });

  describe('Shared by you (CAN-4842)', () => {
    const ORG_LINKED = {
      shareScope: 'organization' as const,
      owner: { type: 'organization' as const, id: 'org-1', name: 'Acme' },
      canDelete: true,
      publicShare: PUBLIC_SHARE,
    };
    const unshareOptions = (): {
      kind: 'skill';
      name: string;
      onUnshare: () => Promise<void>;
      onUnshared: () => void;
    } => ({
      kind: 'skill',
      name: 'helper',
      onUnshare: (): Promise<void> => Promise.resolve(),
      onUnshared: (): void => {},
    });

    it('renders the section after load and drops the legacy Remove public link', async () => {
      getShared.mockResolvedValue(makeDetail(ORG_LINKED));
      const renderSharedByYou = jest.fn(() => (
        <section data-testid="t-shared-by-you" />
      ));
      await renderPage({ unshareOptions, renderSharedByYou });
      expect(q('t-shared-by-you')).not.toBeNull();
      expect(renderSharedByYou).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'skill-1' }),
        expect.any(Function),
      );
      const items = openMore();
      expect(items).not.toContain('Remove public link');
      expect(items[items.length - 1]).toBe('Unshare all');
    });

    it('keeps the legacy Remove public link without the section', async () => {
      getShared.mockResolvedValue(makeDetail(ORG_LINKED));
      await renderPage({ unshareOptions });
      expect(openMore()).toContain('Remove public link');
    });

    it('names the ⋯ item Unshare for a single audience', async () => {
      getShared.mockResolvedValue(
        makeDetail({ ...ORG_LINKED, publicShare: null }),
      );
      await renderPage({
        unshareOptions,
        renderSharedByYou: () => null,
      });
      const items = openMore();
      expect(items[items.length - 1]).toBe('Unshare');
    });

    it('drops the dialog Remove public link button when the section is supplied', async () => {
      getShared.mockResolvedValue(makeDetail(ORG_LINKED));
      await act(async () => {
        root.render(
          <SharedSkillDetailModal
            mode="view"
            summary={makeSummary(ORG_LINKED)}
            onClose={() => {}}
            onUpdated={jest.fn()}
            onSwitchToEdit={() => {}}
            renderSharedByYou={() => <section data-testid="t-shared-by-you" />}
          />,
        );
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(q('t-shared-by-you')).not.toBeNull();
      expect(q('shared-skill-remove-public-link')).toBeNull();
    });

    it('keeps the legacy Remove public link when the section has no public row to offer', async () => {
      // canUpdate without canDelete: Shared by you renders no rows.
      getShared.mockResolvedValue(
        makeDetail({ ...ORG_LINKED, canDelete: false }),
      );
      await renderPage({ unshareOptions, renderSharedByYou: () => null });
      expect(openMore()).toContain('Remove public link');
    });

    it('keeps the dialog Remove public link when the section has no public row to offer', async () => {
      getShared.mockResolvedValue(
        makeDetail({ ...ORG_LINKED, canDelete: false }),
      );
      await act(async () => {
        root.render(
          <SharedSkillDetailModal
            mode="view"
            summary={makeSummary({ ...ORG_LINKED, canDelete: false })}
            onClose={() => {}}
            onUpdated={jest.fn()}
            onSwitchToEdit={() => {}}
            renderSharedByYou={() => null}
          />,
        );
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(q('shared-skill-remove-public-link')).not.toBeNull();
    });

    it('keeps the dialog Remove public link in edit mode, where the section is hidden', async () => {
      getShared.mockResolvedValue(makeDetail(ORG_LINKED));
      const renderSharedByYou = jest.fn(() => (
        <section data-testid="t-shared-by-you" />
      ));
      await act(async () => {
        root.render(
          <SharedSkillDetailModal
            mode="edit"
            summary={makeSummary(ORG_LINKED)}
            onClose={() => {}}
            onUpdated={jest.fn()}
            onSwitchToEdit={() => {}}
            renderSharedByYou={renderSharedByYou}
          />,
        );
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(q('t-shared-by-you')).toBeNull();
      expect(q('shared-skill-remove-public-link')).not.toBeNull();
    });
  });
});
