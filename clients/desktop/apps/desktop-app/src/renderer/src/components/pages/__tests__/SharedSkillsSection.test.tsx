/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, type ReactElement, type ReactNode } from 'react';
import type * as SharedComponents from '@canopy/ui-shared/components';
import { createRoot, type Root } from 'react-dom/client';
import type { SharedSkillSummary } from '@canopy/desktop-shared/types/skills';

jest.mock('../../shared', () => ({
  DialogModal: ({ children }: { children: ReactNode }): ReactElement => (
    <div>{children}</div>
  ),
  ErrorBanner: (): null => null,
  LoadingPlaceholder: ({ label }: { label: string }): ReactElement => (
    <p>{label}</p>
  ),
  EmptyState: jest.requireActual<typeof SharedComponents>(
    '@canopy/ui-shared/components',
  ).EmptyState,
  DeleteConfirmModal: (): null => null,
}));
jest.mock('@canopy/ui-app', () => ({
  MarkdownFrontmatterContent: (): null => null,
}));

const resolveSharedSkillUrl = jest.fn(() =>
  Promise.resolve('https://cloud.example.test/share/skills/skill-1'),
);
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

import { SharedSkillsSection } from '../SkillsTab';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

function makeSummary(
  overrides: Partial<SharedSkillSummary> = {},
): SharedSkillSummary {
  return {
    id: 'skill-1',
    name: 'Helper',
    description: '',
    contentHash: 'sha256:abc',
    shareScope: 'private',
    owner: { type: 'user', id: 'user-1', name: 'Alice' },
    createdBy: { id: 'user-1', name: 'Alice', email: 'alice@example.test' },
    createdAt: '2026-07-30T00:00:00Z',
    updatedAt: '2026-07-30T00:00:00Z',
    canUpdate: false,
    canDelete: false,
    publicShare: null,
    ...overrides,
  };
}

describe('SharedSkillsSection', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each([
    { enabled: true, empty: false },
    { enabled: true, empty: true },
    { enabled: false, empty: false },
    { enabled: false, empty: true },
  ])(
    'exposes stable selectors only with enforcement enabled ($enabled, empty $empty)',
    async ({ enabled, empty }): Promise<void> => {
      const previous = useFeatureFlagsStore.getState().snapshot;
      useFeatureFlagsStore.setState({
        snapshot: {
          ...previous,
          values: {
            ...previous.values,
            [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: enabled,
          },
        },
      });
      try {
        await act(async (): Promise<void> => {
          root.render(
            <SharedSkillsSection
              sharedSkills={{
                cloudAccount: {
                  hasApiKey: true,
                  authMode: 'api_key',
                  credentialSource: 'manual',
                  capabilities: ['skills-crud-v1'],
                  storageAvailable: true,
                  account: {
                    id: 'user-1',
                    name: 'Alice',
                    email: 'alice@example.test',
                    role: 'USER',
                  },
                },
                cloudLoading: false,
                skills: empty ? [] : [makeSummary()],
                loading: false,
                loadingMore: false,
                nextCursor: null,
                error: null,
                loaded: true,
                refreshShared: jest.fn(() => Promise.resolve()),
                loadMoreShared: jest.fn(() => Promise.resolve()),
                setFilters: jest.fn(),
                removeSharedRow: jest.fn(),
              }}
              search=""
              onSearchChange={jest.fn()}
              createdBy="anyone"
              onCreatedByChange={jest.fn()}
              flash={null}
              onView={jest.fn()}
              onEdit={jest.fn()}
              onImport={jest.fn(() => Promise.resolve())}
              onDelete={jest.fn(() => Promise.resolve())}
            />,
          );
          await Promise.resolve();
        });
        const selector = empty
          ? '[data-testid="shared-skills-empty-state"]'
          : '[data-testid="shared-skill-row-skill-1"]';
        expect(container.querySelector(selector) !== null).toBe(enabled);
        expect(container.textContent).toContain(
          empty ? 'No shared skills found.' : 'Helper',
        );
      } finally {
        useFeatureFlagsStore.setState({ snapshot: previous });
      }
    },
  );

  it('shows and copies public links only for shared skills that have one', async () => {
    const withShare = makeSummary({
      publicShare: {
        externalId: 'public-1',
        pinnedContentHash: 'sha256:abc',
        upToDate: true,
        sharePath: '/share/skills/skill-1',
        createdAt: '2026-07-30T00:00:00Z',
        updatedAt: '2026-07-30T00:00:00Z',
      },
    });
    const withoutShare = makeSummary({ id: 'skill-2', name: 'No link' });

    await act(async () => {
      root.render(
        <SharedSkillsSection
          sharedSkills={{
            cloudAccount: {
              hasApiKey: true,
              authMode: 'api_key',
              credentialSource: 'manual',
              capabilities: ['skills-crud-v1'],
              storageAvailable: true,
              account: {
                id: 'user-1',
                name: 'Alice',
                email: 'alice@example.test',
                role: 'USER',
              },
            },
            cloudLoading: false,
            skills: [withShare, withoutShare],
            loading: false,
            loadingMore: false,
            nextCursor: null,
            error: null,
            loaded: true,
            refreshShared: jest.fn(() => Promise.resolve()),
            loadMoreShared: jest.fn(() => Promise.resolve()),
            setFilters: jest.fn(),
            removeSharedRow: jest.fn(),
          }}
          search=""
          onSearchChange={jest.fn()}
          createdBy="anyone"
          onCreatedByChange={jest.fn()}
          flash={null}
          onView={jest.fn()}
          onEdit={jest.fn()}
          onImport={jest.fn(() => Promise.resolve())}
          onDelete={jest.fn(() => Promise.resolve())}
        />,
      );
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="shared-skill-copy-link-skill-1"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="shared-skill-copy-link-skill-2"]'),
    ).toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="shared-skill-copy-link-skill-1"]',
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(copyTextToClipboard).toHaveBeenCalledWith(
      'https://cloud.example.test/share/skills/skill-1',
    );
  });
});
