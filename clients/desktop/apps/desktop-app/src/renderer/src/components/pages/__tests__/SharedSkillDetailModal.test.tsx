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
> = jest.fn((): Promise<string | null> => Promise.resolve(null));
jest.mock('@/lib/share-links', () => ({
  ...jest.requireActual<Record<string, unknown>>('@/lib/share-links'),
  resolveSharedSkillUrl: (sharePath: string): Promise<string | null> =>
    resolveSharedSkillUrl(sharePath),
}));

const copyTextToClipboard = jest.fn(() => Promise.resolve(true));
jest.mock('@/lib/clipboard', () => ({
  copyTextToClipboard: (value: string): Promise<boolean> =>
    copyTextToClipboard(value),
}));

const findInstalledSharedSkill: jest.Mock<
  Promise<string | null>,
  [Pick<SharedSkillDetail, 'id' | 'contentHash'>]
> = jest.fn((): Promise<string | null> => Promise.resolve(null));
jest.mock('@/lib/sharedSkillImport', () => ({
  ...jest.requireActual<Record<string, unknown>>('@/lib/sharedSkillImport'),
  findInstalledSharedSkill: (
    detail: Pick<SharedSkillDetail, 'id' | 'contentHash'>,
  ): Promise<string | null> => findInstalledSharedSkill(detail),
}));

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
    findInstalledSharedSkill.mockReset();
    findInstalledSharedSkill.mockResolvedValue(null);
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
    getShared.mockRejectedValue(new Error('initial load failed'));
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
    findInstalledSharedSkill.mockResolvedValue('helper');
    const onAdd = jest.fn();
    await renderModal(jest.fn(), makeSummary(), onAdd, jest.fn());
    await settle();

    expect(findInstalledSharedSkill).toHaveBeenCalledWith(detail);
    expect(byTestId('shared-skill-detail-add')).toBeNull();
    expect(byTestId('shared-skill-detail-installed-status')?.textContent).toBe(
      'Added as “helper”.',
    );
    expect(byTestId('shared-skill-detail-open')).not.toBeNull();
    expect(byTestId('detail-primary-cta')?.textContent).toBe('Try it');
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('offers Add when the installed check fails', async () => {
    getShared.mockResolvedValue(makeDetail());
    findInstalledSharedSkill.mockRejectedValue(new Error('read failed'));
    await renderModal(jest.fn(), makeSummary(), jest.fn(), jest.fn());
    await settle();

    expect(byTestId('shared-skill-detail-add')?.textContent).toBe('Install');
    expect(byTestId('shared-skill-detail-installed-status')).toBeNull();
  });

  it('offers Add when the shared skill cannot be read to check it', async () => {
    getShared.mockRejectedValue(new Error('initial load failed'));
    await renderModal(jest.fn(), makeSummary(), jest.fn(), jest.fn());
    await settle();

    expect(findInstalledSharedSkill).not.toHaveBeenCalled();
    expect(byTestId('shared-skill-detail-add')?.textContent).toBe('Install');
  });

  it('ignores an installed check that finishes after the share changed', async () => {
    let resolveFirst: (name: string | null) => void = () => {};
    findInstalledSharedSkill
      .mockImplementationOnce(
        () =>
          new Promise<string | null>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue(null);
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
      resolveFirst('helper');
      await Promise.resolve();
    });

    expect(byTestId('shared-skill-detail-installed-status')).toBeNull();
    expect(byTestId('shared-skill-detail-add')?.textContent).toBe('Install');
  });

  it('offers Add when the next share cannot be read after a share change', async () => {
    getShared
      .mockResolvedValueOnce(makeDetail())
      .mockRejectedValueOnce(new Error('next load failed'));
    findInstalledSharedSkill.mockResolvedValue('helper');
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
    expect(findInstalledSharedSkill).toHaveBeenCalledTimes(1);
    expect(byTestId('shared-skill-detail-installed-status')).toBeNull();
    expect(byTestId('shared-skill-detail-add')?.textContent).toBe('Install');
  });

  it('does not check installed state where the detail offers no Add', async () => {
    getShared.mockResolvedValue(makeDetail());
    await renderModal(jest.fn(), makeSummary());
    await settle();

    expect(findInstalledSharedSkill).not.toHaveBeenCalled();
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
    findInstalledSharedSkill.mockReset();
    findInstalledSharedSkill.mockResolvedValue(null);
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
    findInstalledSharedSkill.mockResolvedValue('helper');
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
});
