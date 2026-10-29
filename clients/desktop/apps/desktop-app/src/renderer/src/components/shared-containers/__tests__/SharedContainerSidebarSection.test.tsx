/**
 * @jest-environment jsdom
 *
 * "Shared with you" sidebar section (CAN-2551).
 *
 * Covers the distinction the section used to collapse: a genuine transport
 * failure is retryable and shows an error row, while an all-lapsed account is
 * a benign block that renders nothing at all. Also pins the retry unmount
 * hazard — `loadSharedWithMe` sets `listStatus: 'loading'`, which satisfies the
 * section's "nothing to show" guard and would otherwise unmount the Retry
 * button mid-click.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (): void => undefined,
}));
jest.mock('@/hooks/useSharedContainerEntryPointVisible', () => ({
  useSharedContainerEntryPointVisible: (): boolean => true,
}));

jest.mock('@/lib/shared-containers/open-forked-container', () => ({
  openForkedContainer: (): Promise<void> => Promise.resolve(),
}));
jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: (selector: (state: unknown) => unknown): unknown =>
    selector({ projects: [] }),
}));

import { SharedContainerSidebarSection } from '../SharedContainerSidebarSection';
import {
  useSharedContainerReplicasStore,
  type SharedContainerListEntry,
} from '../../../stores/sharedContainerReplicasStore';
import { useWorkspaceContextStore } from '../../../stores/workspaceContextStore';
import { useFeatureFlagsStore } from '../../../stores/featureFlagsStore';
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { outermostReplayBlock } from '@/test-utils/replay';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function render({ expanded = true }: { expanded?: boolean } = {}): void {
  act(() => {
    root.render(
      <SharedContainerSidebarSection
        expanded={expanded}
        onExpandedChange={(): void => undefined}
      />,
    );
  });
}

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

/** The innermost element under `scope` whose whole text is `text`. */
function textElement(scope: Element | null, text: string): Element {
  const match = Array.from(scope?.querySelectorAll('*') ?? [])
    .reverse()
    .find((element) => element.textContent === text);
  if (match === undefined) throw new Error(`Missing ${text}`);
  return match;
}

const ENTRY = {
  organizationId: 'org-1',
  ownerName: 'Dana',
  container: {
    id: 'container-1',
    organizationId: 'org-1',
    ownerUserId: 'user-1',
    worktreeId: 'worktree-1',
    containerType: 'CODE_WORKTREE' as const,
    title: 'Checkout flow',
    revision: 3,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    capabilities: ['VIEW' as const],
  },
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  useSharedContainerReplicasStore.getState().reset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SharedContainerSidebarSection', () => {
  it('renders a retry affordance when every organization failed to load', () => {
    useSharedContainerReplicasStore.setState({
      entries: [],
      listStatus: 'error',
    });

    render();

    expect(query('shared-container-list-error')).not.toBeNull();
    expect(query('shared-container-list-retry')).not.toBeNull();
  });

  it('offers Retry as an icon-only control after the unchanged copy', () => {
    // CAN-3551. Retry moved from a text button to an icon in the row's
    // trailing column. The glyph carries no text, so the label is the whole
    // accessible name; the copy itself is unchanged and leads the row.
    useSharedContainerReplicasStore.setState({
      entries: [],
      listStatus: 'error',
    });

    render();

    const row = query('shared-container-list-error');
    const message = query('shared-container-list-message');
    const retry = query('shared-container-list-retry');
    expect(message?.textContent).toBe('Could not load shared containers.');
    expect(retry?.tagName).toBe('BUTTON');
    expect(retry?.getAttribute('aria-label')).toBe('Retry');
    expect(retry?.querySelector('svg')).not.toBeNull();
    expect(retry?.textContent).toBe('');
    // Copy first, control last: the control is the row's trailing column.
    expect(row?.firstElementChild).toBe(message);
    expect(row?.lastElementChild?.contains(retry)).toBe(true);
    expect(row?.textContent).toBe('Could not load shared containers.');
  });

  it('keeps Retry labeled and disabled while its retry is in flight', () => {
    // The icon has no text to swap for a spinner, so the in-flight state is
    // the disabled control plus the row's own "Loading" copy. The label must
    // survive it, or the disabled control is unnamed for a screen reader.
    useSharedContainerReplicasStore.setState({
      entries: [],
      listStatus: 'error',
      loadSharedWithMe: jest.fn(() => {
        useSharedContainerReplicasStore.setState({
          listStatus: 'loading',
          entries: [],
        });
        return new Promise<void>(() => undefined);
      }),
    });

    render();
    act(() => {
      query('shared-container-list-retry')?.click();
    });

    const retry = query('shared-container-list-retry');
    expect(retry?.getAttribute('aria-label')).toBe('Retry');
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    expect(query('shared-container-list-message')?.textContent).toBe(
      'Loading shared containers…',
    );
  });

  it('calls loadSharedWithMe again when Retry is clicked', async () => {
    const loadSharedWithMe = jest.fn().mockResolvedValue(undefined);
    useSharedContainerReplicasStore.setState({
      entries: [],
      listStatus: 'error',
      loadSharedWithMe,
    });

    render();
    await act(async () => {
      query('shared-container-list-retry')?.click();
      await Promise.resolve();
    });

    expect(loadSharedWithMe).toHaveBeenCalledTimes(1);
  });

  it('keeps the error row mounted while a retry is in flight', async () => {
    // The real store sets `listStatus: 'loading'` the moment the retry starts,
    // which makes the "nothing to show" guard true. Without the local retrying
    // flag the section unmounts its own button on click.
    let resolveLoad: (() => void) | undefined;
    const loadSharedWithMe = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = (): void => resolve();
          useSharedContainerReplicasStore.setState({
            listStatus: 'loading',
            entries: [],
          });
        }),
    );
    useSharedContainerReplicasStore.setState({
      entries: [],
      listStatus: 'error',
      loadSharedWithMe,
    });

    render();
    act(() => {
      query('shared-container-list-retry')?.click();
    });

    expect(useSharedContainerReplicasStore.getState().listStatus).toBe(
      'loading',
    );
    expect(query('shared-container-list-error')).not.toBeNull();
    expect(query('shared-container-list-retry')).not.toBeNull();

    await act(async () => {
      resolveLoad?.();
      await Promise.resolve();
    });
  });

  it('leaves Retry usable after a rejected load instead of latching it disabled', async () => {
    // CAN-2551 regression guard. The click handler used a bare
    // `void loadSharedWithMe().finally(...)`. `.finally` RE-THROWS, so a
    // rejection became an unhandled renderer rejection and, because the
    // rejected promise was only `void`-ed, `setRetrying(false)` still ran but
    // the rejection escaped. Catch before finally so the button always resets
    // and nothing escapes.
    const rejection = new Error('bridge is unavailable');
    const loadSharedWithMe = jest.fn(() => Promise.reject(rejection));
    const unhandled: unknown[] = [];
    const onUnhandled = (event: PromiseRejectionEvent): void => {
      event.preventDefault();
      unhandled.push(event.reason);
    };
    window.addEventListener('unhandledrejection', onUnhandled);
    useSharedContainerReplicasStore.setState({
      entries: [],
      listStatus: 'error',
      loadSharedWithMe,
    });

    try {
      render();
      await act(async () => {
        query('shared-container-list-retry')?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      const retry = query('shared-container-list-retry');
      expect(retry).not.toBeNull();
      // The button must not stay latched disabled — otherwise a single
      // structural failure permanently removes the only recovery affordance.
      expect((retry as HTMLButtonElement).disabled).toBe(false);
      expect(unhandled).toEqual([]);
    } finally {
      window.removeEventListener('unhandledrejection', onUnhandled);
    }
  });

  it('renders nothing when a retry resolves into a billing block', () => {
    // The store status and the local `retrying` flag reset in separate render
    // passes, so keying the "nothing to show" guard only on `!retrying` flashed
    // the section for one frame in a state meant to render nothing.
    useSharedContainerReplicasStore.setState({
      entries: [],
      listStatus: 'error',
      loadSharedWithMe: jest.fn(() => {
        useSharedContainerReplicasStore.setState({
          listStatus: 'blocked-by-org-billing',
          entries: [],
        });
        return new Promise<void>(() => undefined);
      }),
    });

    render();
    act(() => {
      query('shared-container-list-retry')?.click();
    });

    // `retrying` is still true here; the refusal must hide the section anyway.
    expect(query('sidebar-section-shared-with-me')).toBeNull();
    expect(query('shared-container-list-error')).toBeNull();
  });

  it('renders nothing when a retry succeeds with no remaining shares', () => {
    // The same one-frame flash as the billing case, on the MORE reachable path:
    // a retry that succeeds after the last share was revoked or dismissed. The
    // guard must key on leaving `'loading'`, not on one specific terminal
    // status, or `'success'` with zero rows still flashes an empty section.
    useSharedContainerReplicasStore.setState({
      entries: [],
      listStatus: 'error',
      loadSharedWithMe: jest.fn(() => {
        useSharedContainerReplicasStore.setState({
          listStatus: 'success',
          entries: [],
        });
        return new Promise<void>(() => undefined);
      }),
    });

    render();
    act(() => {
      query('shared-container-list-retry')?.click();
    });

    // `retrying` is still true here; the settled status must hide it anyway.
    expect(query('sidebar-section-shared-with-me')).toBeNull();
    expect(query('shared-container-list-error')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('reports a transient outage as reconnecting, without a Retry button', () => {
    useSharedContainerReplicasStore.setState({
      entries: [],
      listStatus: 'unavailable',
    });

    render();

    expect(query('sidebar-section-shared-with-me')).not.toBeNull();
    const row = query('shared-container-list-unavailable');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('Reconnecting to shared containers');
    // The store is already retrying on a backoff ladder; a button here would
    // read as the reconnect not working.
    expect(query('shared-container-list-retry')).toBeNull();
    expect(row?.querySelector('button')).toBeNull();
    // The copy still leads the row, as it does in the retryable state.
    expect(row?.firstElementChild).toBe(query('shared-container-list-message'));
    // A transient outage is not the genuine-failure row.
    expect(query('shared-container-list-error')).toBeNull();
  });

  it('shows reconnecting status alongside rows from healthy organizations', () => {
    useSharedContainerReplicasStore.setState({
      entries: [ENTRY],
      acceptedIds: ['container-1'],
      listStatus: 'unavailable',
    });

    render();

    expect(query('shared-container-list-unavailable')).not.toBeNull();
    expect(query('shared-container-row-container-1')).not.toBeNull();
  });

  it('renders nothing when every organization is blocked by billing', () => {
    useSharedContainerReplicasStore.setState({
      entries: [],
      listStatus: 'blocked-by-org-billing',
    });

    render();

    expect(query('sidebar-section-shared-with-me')).toBeNull();
    expect(query('shared-container-list-error')).toBeNull();
    expect(container.textContent).toBe('');
  });
});

describe('SharedContainerSidebarSection context scoping (CAN-2954)', () => {
  const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  function entry(id: string, organizationId: string): SharedContainerListEntry {
    return {
      organizationId,
      container: {
        id,
        organizationId,
        ownerUserId: 'owner',
        worktreeId: 'wt',
        containerType: 'worktree' as const,
        title: id,
        revision: 1,
        createdAt: '2026-09-10T00:00:00.000Z',
        updatedAt: '2026-09-10T00:00:00.000Z',
        capabilities: ['VIEW' as const],
      },
    };
  }

  function seed(
    flag: boolean,
    context:
      | { kind: 'personal' }
      | { kind: 'organization'; organizationId: string },
    hydrated = true,
  ): void {
    const snapshot = getDefaultFeatureFlagSnapshot();
    snapshot.values['canopy-shared-org-projects-enabled'] = flag;
    useFeatureFlagsStore.setState({ snapshot });
    useWorkspaceContextStore.setState({
      state: {
        context,
        revision: 1,
        organizations: [
          { id: ORG_A, name: 'Acme', role: 'MEMBER' },
          { id: ORG_B, name: 'Zen', role: 'MEMBER' },
        ],
      },
      hydrated,
    });
    useSharedContainerReplicasStore.setState({
      entries: [entry('share-a', ORG_A), entry('share-b', ORG_B)],
      listStatus: 'success',
      acceptedIds: ['share-a', 'share-b'],
    });
  }

  afterEach(() => {
    seed(false, { kind: 'personal' });
  });

  it('keeps every share until the workspace context has hydrated, like the rest of the sidebar', () => {
    seed(true, { kind: 'organization', organizationId: ORG_A }, false);
    render();
    expect(query('shared-container-row-share-a')).not.toBeNull();
    expect(query('shared-container-row-share-b')).not.toBeNull();
  });

  it('renders nothing under Personal even while the listing is in an error state', () => {
    seed(true, { kind: 'personal' });
    useSharedContainerReplicasStore.setState({
      entries: [],
      listStatus: 'error',
    });
    render();
    expect(query('sidebar-section-shared-with-me')).toBeNull();
    expect(query('shared-container-list-retry')).toBeNull();
  });

  it('keeps every share while the flag is off', () => {
    seed(false, { kind: 'personal' });
    render();
    expect(query('shared-container-row-share-a')).not.toBeNull();
    expect(query('shared-container-row-share-b')).not.toBeNull();
  });

  it('lists a direct share under Personal, never under an organization, and names where it came from', () => {
    seed(true, { kind: 'personal' });
    const direct = entry('share-direct', ORG_A);
    useSharedContainerReplicasStore.setState({
      entries: [
        entry('share-a', ORG_A),
        {
          ...direct,
          access: 'direct',
          ownerName: 'Dana',
          container: { ...direct.container, organizationName: 'Acme' },
        },
      ],
      acceptedIds: ['share-a', 'share-direct'],
    });
    render();
    expect(query('shared-container-row-share-direct')).not.toBeNull();
    expect(query('shared-container-row-share-a')).toBeNull();
    expect(query('shared-container-owner-share-direct')?.textContent).toBe(
      'From Dana \u00B7 Acme',
    );

    // The owning organization's context is not where a direct share lives:
    // the recipient reached it from outside that organization.
    seed(true, { kind: 'organization', organizationId: ORG_A });
    useSharedContainerReplicasStore.setState({
      entries: [
        entry('share-a', ORG_A),
        { ...direct, access: 'direct', ownerName: 'Dana' },
      ],
      acceptedIds: ['share-a', 'share-direct'],
    });
    render();
    expect(query('shared-container-row-share-a')).not.toBeNull();
    expect(query('shared-container-row-share-direct')).toBeNull();
  });

  it("blocks the owner's name from session replay, not the line or its organization", () => {
    seed(true, { kind: 'personal' });
    const direct = entry('share-direct', ORG_A);
    useSharedContainerReplicasStore.setState({
      entries: [
        {
          ...direct,
          access: 'direct',
          ownerName: 'Dana',
          container: { ...direct.container, organizationName: 'Acme' },
        },
      ],
      acceptedIds: ['share-direct'],
    });
    render();
    const line = query('shared-container-owner-share-direct');
    expect(line?.textContent).toBe('From Dana \u00B7 Acme');
    expect(outermostReplayBlock(line)).toBeNull();
    const block = outermostReplayBlock(textElement(line, 'Dana'));
    // Only the person's name: the organization stays recorded.
    expect(block?.textContent).toBe('Dana');
    expect(
      outermostReplayBlock(query('shared-container-row-share-direct')),
    ).toBeNull();
  });

  it('labels a personal direct share by its owner alone', () => {
    seed(false, { kind: 'personal' });
    const direct = entry('share-personal', ORG_A);
    useSharedContainerReplicasStore.setState({
      entries: [
        {
          access: 'direct',
          ownerName: 'Dana',
          container: { ...direct.container, organizationId: undefined },
        },
      ],
      acceptedIds: ['share-personal'],
    });
    render();
    expect(query('shared-container-owner-share-personal')?.textContent).toBe(
      'From Dana',
    );
  });

  describe('accepted shares follow their acceptance record (CAN-3554)', () => {
    const ORG_LEFT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    /**
     * A row the latest listing round classified as `direct` or organization.
     * `null` omits the organization name; `undefined` would select the default.
     */
    function listed(
      access: 'direct' | undefined,
      organizationName: string | null = 'Acme',
    ): SharedContainerListEntry {
      const share = entry('share-a', ORG_A);
      return {
        ...share,
        ...(access ? { access } : {}),
        ownerName: 'Dana',
        container: {
          ...share.container,
          ...(organizationName ? { organizationName } : {}),
        },
      };
    }

    function seedShare(
      context:
        | { kind: 'personal' }
        | { kind: 'organization'; organizationId: string },
      row: SharedContainerListEntry,
      record: { organizationId?: string; access?: 'organization' | 'direct' },
    ): void {
      seed(true, context);
      useSharedContainerReplicasStore.setState({
        entries: [row],
        acceptedIds: ['share-a'],
        acceptedRecords: { 'share-a': record },
      });
    }

    it('keeps a share accepted in an organization there when a round classifies it as direct', () => {
      seedShare(
        { kind: 'organization', organizationId: ORG_A },
        listed('direct'),
        { organizationId: ORG_A },
      );
      render();
      expect(query('shared-container-row-share-a')).not.toBeNull();
      // It still reads as an organization share, not as one from outside.
      expect(query('shared-container-owner-share-a')?.textContent).toBe(
        'Shared by Dana',
      );

      seedShare({ kind: 'personal' }, listed('direct'), {
        organizationId: ORG_A,
      });
      render();
      expect(query('shared-container-row-share-a')).toBeNull();
      expect(query('sidebar-section-shared-with-me')).toBeNull();
    });

    it('keeps a share accepted as direct under Personal when a round classifies it as an organization share', () => {
      seedShare({ kind: 'personal' }, listed(undefined), { access: 'direct' });
      render();
      expect(query('shared-container-row-share-a')).not.toBeNull();
      expect(query('shared-container-owner-share-a')?.textContent).toBe(
        'From Dana \u00B7 Acme',
      );

      seedShare(
        { kind: 'organization', organizationId: ORG_A },
        listed(undefined),
        { access: 'direct' },
      );
      render();
      expect(query('shared-container-row-share-a')).toBeNull();
    });

    it('falls back to the plain owner label when that organization listing carries no organization name', () => {
      seedShare({ kind: 'personal' }, listed(undefined, null), {
        access: 'direct',
      });
      render();
      expect(query('shared-container-owner-share-a')?.textContent).toBe(
        'Shared by Dana',
      );
    });

    it('follows the listing again once the account has left the recorded organization', () => {
      seedShare({ kind: 'personal' }, listed('direct'), {
        organizationId: ORG_LEFT,
      });
      render();
      expect(query('shared-container-row-share-a')).not.toBeNull();
      expect(query('shared-container-owner-share-a')?.textContent).toBe(
        'From Dana \u00B7 Acme',
      );
    });

    it('leaves an invitation where the listing classifies it', () => {
      seed(true, { kind: 'personal' });
      useSharedContainerReplicasStore.setState({
        entries: [listed('direct')],
        acceptedIds: [],
        acceptedRecords: {},
      });
      render();
      expect(query('shared-container-invitation-share-a')).not.toBeNull();
      expect(query('shared-container-owner-share-a')?.textContent).toBe(
        'From Dana \u00B7 Acme',
      );

      seed(true, { kind: 'organization', organizationId: ORG_A });
      useSharedContainerReplicasStore.setState({
        entries: [listed('direct')],
        acceptedIds: [],
        acceptedRecords: {},
      });
      render();
      expect(query('shared-container-invitation-share-a')).toBeNull();
    });
  });

  it('shows only the selected organization, and nothing in Personal, once the flag is on', () => {
    seed(true, { kind: 'organization', organizationId: ORG_A });
    render();
    expect(query('shared-container-row-share-a')).not.toBeNull();
    expect(query('shared-container-row-share-b')).toBeNull();

    seed(true, { kind: 'personal' });
    render();
    expect(query('shared-container-row-share-a')).toBeNull();
    expect(query('shared-container-row-share-b')).toBeNull();
  });
});

describe('SharedContainerSidebarSection pending count', () => {
  function secondEntry(): typeof ENTRY {
    return {
      ...ENTRY,
      container: { ...ENTRY.container, id: 'container-2', title: 'Billing' },
    };
  }

  it('counts invitations in the header so a collapsed section still announces one', () => {
    useSharedContainerReplicasStore.setState({
      entries: [ENTRY, secondEntry()],
      listStatus: 'success',
      // Neither has been accepted, so both are invitations awaiting a decision.
      acceptedIds: [],
    });

    render();

    const badge = query('sidebar-shared-with-me-pending-count');
    expect(badge?.textContent).toBe('2');
    expect(badge?.getAttribute('aria-label')).toBe('2 pending invitations');
  });

  it('renders the count as the plain sidebar counter, after the chevron', () => {
    useSharedContainerReplicasStore.setState({
      entries: [ENTRY],
      listStatus: 'success',
      acceptedIds: [],
    });

    render();

    const badge = query('sidebar-shared-with-me-pending-count');
    const tokens = Array.from(badge?.classList ?? []);
    expect(tokens).toEqual(
      expect.arrayContaining(['ml-auto', 'text-2xs', 'fg-quaternary']),
    );
    for (const pill of ['bg-accent', 'rounded-full', 'fg-emphasis']) {
      expect(tokens).not.toContain(pill);
    }
    const chevron = query('sidebar-shared-with-me-chevron');
    expect(
      chevron !== null &&
        badge !== null &&
        (chevron.compareDocumentPosition(badge) &
          Node.DOCUMENT_POSITION_FOLLOWING) !==
          0,
    ).toBe(true);
  });

  it('uses the singular label for one invitation', () => {
    useSharedContainerReplicasStore.setState({
      entries: [ENTRY],
      listStatus: 'success',
      acceptedIds: [],
    });

    render();

    expect(
      query('sidebar-shared-with-me-pending-count')?.getAttribute('aria-label'),
    ).toBe('1 pending invitation');
  });

  it('omits the count once every share has been accepted', () => {
    useSharedContainerReplicasStore.setState({
      entries: [ENTRY],
      listStatus: 'success',
      acceptedIds: ['container-1'],
    });

    render();

    // An accepted share is reachable from wherever it was last opened; only a
    // row still needing a decision is worth counting.
    expect(query('sidebar-shared-with-me-pending-count')).toBeNull();
  });
});

describe('SharedContainerSidebarSection row grid (CAN-3612)', () => {
  function classes(testId: string): string[] {
    return Array.from(query(testId)?.classList ?? []);
  }

  function expectLeadingSlot(
    rowTestId: string,
    { pendingDot = false }: { pendingDot?: boolean } = {},
  ): void {
    const slot = query(`${rowTestId}-leading-slot`);
    expect(slot).not.toBeNull();
    // Hidden from assistive technology: empty for an accepted share, and
    // only the pending dot for an invitation, which is named in text instead.
    expect(slot?.getAttribute('aria-hidden')).toBe('true');
    expect(slot?.childElementCount).toBe(pendingDot ? 1 : 0);
    if (pendingDot) {
      expect(slot?.firstElementChild).toBe(query(`${rowTestId}-pending`));
    }
    expect(slot?.textContent).toBe('');
    for (const className of ['h-5', 'w-5', 'shrink-0']) {
      expect(slot?.classList.contains(className)).toBe(true);
    }
    // The slot leads the row, so the title starts after it.
    expect(query(rowTestId)?.firstElementChild).toBe(slot);
  }

  it('puts an invitation on the standard row grid', () => {
    useSharedContainerReplicasStore.setState({
      entries: [ENTRY],
      listStatus: 'success',
      acceptedIds: [],
    });

    render();

    const row = classes('shared-container-invitation-container-1');
    expect(row).toEqual(
      expect.arrayContaining(['gap-1.5', 'pl-1.5', 'pr-1', 'py-1']),
    );
    expect(row).toContain('rounded-row');
    expect(row).not.toContain('px-2');
    expect(row).not.toContain('gap-2');
    expectLeadingSlot('shared-container-invitation-container-1', {
      pendingDot: true,
    });
    expect(
      query('shared-container-invitation-container-1-title')?.textContent,
    ).toBe('Checkout flow');
  });

  it('makes the invitation row a dialog trigger named as pending', () => {
    useSharedContainerReplicasStore.setState({
      entries: [ENTRY],
      listStatus: 'success',
      acceptedIds: [],
    });

    render();

    const row = query('shared-container-invitation-container-1');
    expect(row?.tagName).toBe('BUTTON');
    expect(row?.getAttribute('aria-haspopup')).toBe('dialog');
    expect(row?.textContent).toContain('Pending invitation');
    // The inline accept and decline controls are gone.
    expect(query('shared-container-accept-container-1')).toBeNull();
    expect(query('shared-container-decline-container-1')).toBeNull();
  });

  it("blocks an invitation owner's name in its row and dialog, not the controls", () => {
    useSharedContainerReplicasStore.setState({
      entries: [ENTRY],
      listStatus: 'success',
      acceptedIds: [],
    });

    render();

    const line = query('shared-container-owner-container-1');
    expect(line?.textContent).toBe('Shared by Dana');
    expect(outermostReplayBlock(line)).toBeNull();
    expect(outermostReplayBlock(textElement(line, 'Dana'))?.textContent).toBe(
      'Dana',
    );

    act(() => {
      query('shared-container-invitation-container-1')?.click();
    });
    const dialog = document.body.querySelector(
      '[data-testid="shared-container-invitation-dialog"]',
    );
    expect(dialog).not.toBeNull();
    expect(outermostReplayBlock(dialog)).toBeNull();
    expect(outermostReplayBlock(textElement(dialog, 'Dana'))?.textContent).toBe(
      'Dana',
    );
    expect(
      outermostReplayBlock(
        document.body.querySelector(
          '[data-testid="shared-container-invitation-dialog-accept"]',
        ),
      ),
    ).toBeNull();
  });

  it('puts an accepted share on the standard row grid and keeps room for its menu', () => {
    useSharedContainerReplicasStore.setState({
      entries: [ENTRY],
      listStatus: 'success',
      acceptedIds: ['container-1'],
    });

    render();

    const row = classes('shared-container-row-container-1');
    expect(row).toEqual(
      expect.arrayContaining(['gap-1.5', 'pl-1.5', 'pr-8', 'py-1']),
    );
    expect(row).toContain('rounded-row');
    expect(row).not.toContain('px-2');
    expect(row).not.toContain('gap-2');
    expectLeadingSlot('shared-container-row-container-1');
    expect(query('shared-container-row-container-1-title')?.textContent).toBe(
      'Checkout flow',
    );
  });

  it.each([
    ['error', 'shared-container-list-error'],
    ['unavailable', 'shared-container-list-unavailable'],
  ] as const)(
    'starts the %s status copy on the title column',
    (listStatus, testId) => {
      useSharedContainerReplicasStore.setState({ entries: [], listStatus });

      render();

      const row = classes(testId);
      expect(row).toContain('pl-8');
      expect(row).not.toContain('px-2');
    },
  );
});

describe('SharedContainerSidebarSection fork action', () => {
  function seedAccepted(): void {
    useSharedContainerReplicasStore.setState({
      entries: [ENTRY],
      acceptedIds: ['container-1'],
      listStatus: 'success',
    });
  }

  function portalQuery(testId: string): HTMLElement | null {
    return document.body.querySelector(`[data-testid="${testId}"]`);
  }

  function setReplicaState(state: unknown): jest.Mock {
    const getReplicaState = jest.fn(() => Promise.resolve(state));
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { sharedContainers: { getReplicaState } },
    });
    return getReplicaState;
  }

  async function openRowMenu(): Promise<void> {
    render();
    await act(async () => {
      portalQuery('shared-container-row-container-1-actions')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('enables the copy action for a readable replica', async () => {
    // The row menu asks main for the replica state rather than reading the
    // store: the store only tracks the mounted viewer's replica, so an
    // unopened row would otherwise have no basis for the decision at all.
    const getReplicaState = setReplicaState({
      status: 'available',
      revisionId: 'revision-1',
    });
    seedAccepted();

    await openRowMenu();

    expect(getReplicaState).toHaveBeenCalledWith({
      containerId: 'container-1',
    });
    const item = portalQuery('shared-container-row-container-1-fork');
    expect(item).not.toBeNull();
    expect(item?.getAttribute('aria-disabled')).not.toBe('true');
    expect((item as HTMLButtonElement).disabled).toBe(false);
  });

  it('puts Remove share in its own last group, in the action-menu look', async () => {
    setReplicaState({ status: 'available', revisionId: 'revision-1' });
    seedAccepted();

    await openRowMenu();

    const fork = portalQuery('shared-container-row-container-1-fork');
    const remove = portalQuery('shared-container-row-container-1-remove');
    const separator = remove?.previousElementSibling;
    expect(separator?.getAttribute('role')).toBe('separator');
    expect(separator?.previousElementSibling).toBe(fork);
    expect(fork?.className).toContain('text-xs');
    expect(
      fork?.querySelector('span[aria-hidden="true"]')?.className,
    ).toContain('fg-tertiary');
    expect(remove?.className).toContain('fg-destructive');
  });

  it('hides the copy action while the replica is not readable', async () => {
    // A blocked or mid-promotion replica has no revision to copy from. Main
    // refuses either way; offering the action anyway spends a dialog and a
    // destination choice to arrive at the same no.
    setReplicaState({ status: 'blocked', reason: 'ACCESS_DENIED' });
    seedAccepted();

    await openRowMenu();

    const item = portalQuery('shared-container-row-container-1-fork');
    expect(item).toBeNull();
  });
});

describe('SharedContainerSidebarSection header affordances (CAN-3552)', () => {
  // The header must reveal its chevron and brighten its label the same way the
  // Projects and Hidden headers do. SVG `className` is an SVGAnimatedString,
  // so read tokens through `classList`; a substring check would also let a
  // variant like `group-hover/...:opacity-100` satisfy a base `opacity-100`.
  function seedPending(): void {
    useSharedContainerReplicasStore.setState({
      entries: [ENTRY],
      listStatus: 'success',
      acceptedIds: [],
    });
  }

  function requireElement(testId: string): Element {
    const element = query(testId);
    expect(element).not.toBeNull();
    if (!element) throw new Error(`Missing ${testId}`);
    return element;
  }

  function headerLabel(): Element {
    const toggle = requireElement('sidebar-section-shared-with-me-toggle');
    const label = Array.from(toggle.querySelectorAll('span')).find(
      (span) => span.textContent === 'Shared with you',
    );
    expect(label).toBeDefined();
    if (!label) throw new Error('Missing header label');
    return label;
  }

  function tokens(element: Element): string[] {
    return Array.from(element.classList);
  }

  it('reveals the expanded chevron on hover and keyboard focus', () => {
    seedPending();
    render();

    const chevron = tokens(requireElement('sidebar-shared-with-me-chevron'));
    expect(chevron).toEqual(
      expect.arrayContaining([
        'opacity-0',
        'fg-quaternary',
        'transition-[color,opacity]',
        'group-hover/shared-containers:fg-secondary',
        'group-hover/shared-containers:opacity-100',
        'group-focus-within/shared-containers:fg-secondary',
        'group-focus-within/shared-containers:opacity-100',
      ]),
    );
    // Rotation stays instantaneous and the expanded chevron is not rotated.
    expect(chevron).not.toContain('-rotate-90');
    expect(chevron).not.toContain('opacity-100');
    expect(chevron.some((token) => token.includes('transform'))).toBe(false);
    expect(chevron.some((token) => token.startsWith('transition-all'))).toBe(
      false,
    );
    // No coarse-pointer override: touch users get the same rest state as
    // the sibling headers.
    expect(chevron.some((token) => token.startsWith('pointer-coarse:'))).toBe(
      false,
    );
  });

  it('brightens the label on hover and keyboard focus', () => {
    seedPending();
    render();

    expect(tokens(headerLabel())).toEqual(
      expect.arrayContaining([
        'fg-quaternary',
        'transition-colors',
        'group-hover/shared-containers:fg-secondary',
        'group-focus-within/shared-containers:fg-secondary',
      ]),
    );
  });

  it('keeps the collapsed chevron visible and pointing right', () => {
    seedPending();
    render({ expanded: false });

    const chevron = tokens(requireElement('sidebar-shared-with-me-chevron'));
    expect(chevron).toContain('-rotate-90');
    expect(chevron).toContain('opacity-100');
    expect(chevron).not.toContain('opacity-0');
    expect(
      requireElement('sidebar-section-shared-with-me-toggle').getAttribute(
        'aria-expanded',
      ),
    ).toBe('false');
  });

  it('keeps the pending badge and row metrics alongside the disclosure', () => {
    seedPending();
    render();

    const badge = requireElement('sidebar-shared-with-me-pending-count');
    expect(badge.textContent).toBe('1');
    expect(badge.getAttribute('role')).toBe('status');
    expect(badge.getAttribute('aria-label')).toBe('1 pending invitation');
    expect(
      requireElement('sidebar-section-shared-with-me-toggle').getAttribute(
        'aria-expanded',
      ),
    ).toBe('true');
    const row = headerLabel().parentElement;
    expect(row).not.toBeNull();
    if (!row) throw new Error('Missing header row');
    expect(tokens(row)).toEqual(
      expect.arrayContaining(['h-8', 'px-1', 'text-s', 'font-normal']),
    );
  });
});

describe('SharedContainerSidebarSection invitation dialog (CAN-4052)', () => {
  function bodyQuery(testId: string): HTMLElement | null {
    return document.body.querySelector(`[data-testid="${testId}"]`);
  }

  function seedInvitation(): void {
    useSharedContainerReplicasStore.setState({
      entries: [ENTRY],
      listStatus: 'success',
      acceptedIds: [],
      removedStatus: 'success',
    });
  }

  function openDialog(): void {
    render();
    act(() => {
      query('shared-container-invitation-container-1')?.focus();
      query('shared-container-invitation-container-1')?.click();
    });
    expect(bodyQuery('shared-container-invitation-dialog')).not.toBeNull();
  }

  it('opens from the row with the share, its owner, and its kind', () => {
    seedInvitation();
    openDialog();

    const dialog = bodyQuery('shared-container-invitation-dialog');
    expect(dialog?.textContent).toContain('Checkout flow');
    expect(dialog?.textContent).toContain('Shared by Dana');
    expect(
      bodyQuery('shared-container-invitation-dialog-kind')?.textContent,
    ).toBe('Code project');
    expect(
      bodyQuery('shared-container-invitation-dialog-consent'),
    ).not.toBeNull();
  });

  it('offers no Cancel, closes from X, and returns focus to the row', () => {
    seedInvitation();
    openDialog();

    expect(bodyQuery('shared-container-invitation-dialog-cancel')).toBeNull();
    act(() => {
      bodyQuery('shared-container-invitation-dialog')
        ?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
        ?.click();
    });

    expect(bodyQuery('shared-container-invitation-dialog')).toBeNull();
    expect(document.activeElement).toBe(
      query('shared-container-invitation-container-1'),
    );
  });

  it('accepts through the store and closes once the share is accepted', async () => {
    seedInvitation();
    const acceptContainer = jest.fn((): Promise<void> => {
      useSharedContainerReplicasStore.setState({
        acceptedIds: ['container-1'],
      });
      return Promise.resolve();
    });
    useSharedContainerReplicasStore.setState({ acceptContainer });
    openDialog();

    await act(async () => {
      bodyQuery('shared-container-invitation-dialog-accept')?.click();
      await Promise.resolve();
    });

    expect(acceptContainer).toHaveBeenCalledWith({
      containerId: 'container-1',
      organizationId: 'org-1',
    });
    expect(bodyQuery('shared-container-invitation-dialog')).toBeNull();
    // The row is gone, so focus lands on the section header.
    expect(document.activeElement).toBe(
      query('sidebar-section-shared-with-me-toggle'),
    );
  });

  it('stays open with an error when accepting fails', () => {
    seedInvitation();
    openDialog();

    act(() => {
      useSharedContainerReplicasStore.setState({
        acceptFailedId: 'container-1',
      });
    });

    expect(
      bodyQuery('shared-container-invitation-dialog-error')?.textContent,
    ).toBe("Couldn't accept this share. Try again.");
    expect(bodyQuery('shared-container-invitation-dialog')).not.toBeNull();
  });

  it('disables every action while the accept is in flight', () => {
    seedInvitation();
    openDialog();

    act(() => {
      useSharedContainerReplicasStore.setState({ acceptingId: 'container-1' });
    });

    for (const control of ['accept', 'remove']) {
      expect(
        bodyQuery(
          `shared-container-invitation-dialog-${control}`,
        )?.hasAttribute('disabled'),
      ).toBe(true);
    }
    expect(
      bodyQuery('shared-container-invitation-dialog-accept')?.textContent,
    ).toBe('Opening\u2026');
  });

  it('removes without a second confirmation and closes when the removal settles', async () => {
    seedInvitation();
    let settle: (removed: boolean) => void = () => undefined;
    const dismissContainer = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          // The store drops the row before the server answers.
          useSharedContainerReplicasStore.setState({ entries: [] });
          settle = resolve;
        }),
    );
    useSharedContainerReplicasStore.setState({ dismissContainer });
    openDialog();

    await act(async () => {
      bodyQuery('shared-container-invitation-dialog-remove')?.click();
      await Promise.resolve();
    });

    expect(dismissContainer).toHaveBeenCalledWith('container-1', 'org-1');
    // Still open, and saying so, while the removal is in flight.
    expect(
      bodyQuery('shared-container-invitation-dialog-remove')?.textContent,
    ).toBe('Removing\u2026');

    await act(async () => {
      settle(true);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(bodyQuery('shared-container-invitation-dialog')).toBeNull();
  });

  it('closes when the owner revokes the invitation while it is open', () => {
    seedInvitation();
    openDialog();

    act(() => {
      useSharedContainerReplicasStore.setState({ entries: [] });
    });

    expect(bodyQuery('shared-container-invitation-dialog')).toBeNull();
  });
});

describe('SharedContainerSidebarSection Past shares row (CAN-4052)', () => {
  const REMOVED = {
    ...ENTRY,
    container: { ...ENTRY.container, id: 'container-9', title: 'Old plan' },
    dismissedAt: '2026-10-01T00:00:00.000Z',
  };

  it('counts accepted and removed shares', () => {
    useSharedContainerReplicasStore.setState({
      entries: [ENTRY],
      listStatus: 'success',
      acceptedIds: ['container-1'],
      removedEntries: [REMOVED],
      removedStatus: 'success',
    });

    render();

    expect(query('sidebar-shared-with-me-past-shares-label')?.textContent).toBe(
      'Past shares',
    );
    expect(query('sidebar-shared-with-me-past-shares-count')?.textContent).toBe(
      '2',
    );
  });

  it('is absent while there is nothing accepted or removed', () => {
    useSharedContainerReplicasStore.setState({
      entries: [ENTRY],
      listStatus: 'success',
      acceptedIds: [],
      removedEntries: [],
      removedStatus: 'success',
    });

    render();

    expect(query('sidebar-shared-with-me-past-shares')).toBeNull();
  });

  it('keeps the section after the only share was removed', () => {
    useSharedContainerReplicasStore.setState({
      entries: [],
      listStatus: 'success',
      removedEntries: [REMOVED],
      removedStatus: 'success',
    });

    render();

    expect(query('sidebar-section-shared-with-me')).not.toBeNull();
    expect(query('sidebar-shared-with-me-past-shares-count')?.textContent).toBe(
      '1',
    );
    expect(query('shared-container-list-error')).toBeNull();
  });

  it('is absent against a server that cannot restore', () => {
    useSharedContainerReplicasStore.setState({
      entries: [ENTRY],
      listStatus: 'success',
      acceptedIds: ['container-1'],
      removedEntries: [],
      removedStatus: 'unsupported',
    });

    render();

    expect(query('sidebar-shared-with-me-past-shares')).toBeNull();
  });

  it('opens the Past shares page', () => {
    useSharedContainerReplicasStore.setState({
      entries: [],
      listStatus: 'success',
      removedEntries: [REMOVED],
      removedStatus: 'success',
    });

    render();
    act(() => {
      query('sidebar-shared-with-me-past-shares')?.click();
    });

    expect(useSharedContainerReplicasStore.getState().pastSharesOpen).toBe(
      true,
    );
    expect(
      query('sidebar-shared-with-me-past-shares')?.getAttribute('aria-current'),
    ).toBe('page');
  });
});
