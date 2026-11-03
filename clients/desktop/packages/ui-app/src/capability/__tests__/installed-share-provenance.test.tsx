/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  InstalledSkillInfo,
  SharedSkillInstallOrigin,
} from '@canopy/protocol';
import type { DetailMoreMenuItem } from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import type * as SkillReadDetailModule from '../SkillReadDetail';

// The header constructs its formatter when the module loads. Pin only that
// input, then restore Intl; the tests still render the production header.
jest.mock('../SkillReadDetail', () => {
  const NativeDateTimeFormat = Intl.DateTimeFormat;
  const formatter = jest
    .spyOn(Intl, 'DateTimeFormat')
    .mockImplementation(
      (_locales, options) =>
        new NativeDateTimeFormat('en-US', { ...options, timeZone: 'UTC' }),
    );
  try {
    return jest.requireActual<typeof SkillReadDetailModule>(
      '../SkillReadDetail',
    );
  } finally {
    formatter.mockRestore();
  }
});

import {
  SkillReadDetail,
  installedSkillDetailHeader,
} from '../SkillReadDetail';
import {
  InstalledShareUpdateButton,
  shareSourceHashChanged,
  sharedSkillDisplayNames,
  type InstalledShareProvenanceOptions,
} from '../installed-share-provenance';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

let mounted: Root | null = null;
afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

function mount(element: JSX.Element): HTMLDivElement {
  const container = document.createElement('div');
  document.body.append(container);
  mounted = createRoot(container);
  act(() => mounted?.render(element));
  return container;
}

type HeaderInstalled = Parameters<typeof installedSkillDetailHeader>[2];

function installed(
  overrides: Partial<InstalledSkillInfo> = {},
): NonNullable<HeaderInstalled> {
  return {
    source: 'Custom skills',
    installedAt: '2026-10-14T12:00:00.000Z',
    updatedAt: '2026-10-20T12:00:00.000Z',
    custom: true,
    description: 'Reviews code',
    ...overrides,
  };
}

const orgOrigin: SharedSkillInstallOrigin = {
  remoteId: 'share-1',
  shareScope: 'organization',
  ownerContext: {
    kind: 'organization',
    organizationId: '11111111-1111-4111-8111-111111111111',
  },
  contentHash: HASH_A,
  authorizedAt: '2026-10-20T12:00:00.000Z',
  ownerName: 'Acme',
  sharedByName: 'Lena Park',
};

function renderHeader(
  skill: HeaderInstalled,
  provenance?: InstalledShareProvenanceOptions,
): HTMLDivElement {
  const header = installedSkillDetailHeader(
    'review',
    null,
    skill,
    undefined,
    undefined,
    provenance,
  );
  return mount(
    <SkillReadDetail
      skill={{ sourceId: 'custom:app', name: 'review' }}
      header={header}
      content={null}
      files={[]}
      loading={false}
      error=""
      readFile={() =>
        Promise.resolve({ content: '', truncated: false, binary: false })
      }
    />,
  );
}

function metaFacts(container: HTMLElement): string[] {
  const meta = container.querySelector(
    '[data-testid="skill-read-detail-header-meta"]',
  );
  return Array.from(meta?.children ?? []).map((fact) =>
    (fact.textContent ?? '').replace(/^·/, ''),
  );
}

describe('installedSkillDetailHeader shared provenance (CAN-5018)', () => {
  it('keeps Custom, Built-in and marketplace sources without a receipt', () => {
    expect(installedSkillDetailHeader('a', null, installed()).meta).toEqual([
      'Custom',
      'Updated Oct 20, 2026',
    ]);
    expect(
      installedSkillDetailHeader(
        'a',
        null,
        installed({ builtIn: true, installedFromShare: orgOrigin }),
      ).meta?.[0],
    ).toBe('Built-in');
    expect(
      installedSkillDetailHeader(
        'a',
        null,
        installed({ custom: false, source: 'acme/skills' }),
      ).meta?.[0],
    ).toBe('acme/skills');
  });

  it('orders organization, team, sharer, copy, status and link', () => {
    const onSelect = jest.fn();
    const container = renderHeader(
      installed({
        installedFromShare: { ...orgOrigin, teamName: 'Platform' },
      }),
      { updateAvailable: true, source: { kind: 'action', onSelect } },
    );
    expect(metaFacts(container)).toEqual([
      'From Acme',
      'Team: Platform',
      'Shared by Lena Park',
      'One-time copy',
      'Update available·Installed Oct 14, 2026',
      'View shared skill',
    ]);
    expect(container.textContent).not.toContain('Custom');
    expect(container.textContent).not.toContain('Updated');
    const link = container.querySelector<HTMLButtonElement>(
      '[data-testid="installed-share-source-link"]',
    );
    expect(link?.tagName).toBe('BUTTON');
    act(() => link?.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('replay-blocks every name but not the static copy', () => {
    const container = renderHeader(
      installed({
        installedFromShare: { ...orgOrigin, teamName: 'Platform' },
      }),
    );
    const blocked = Array.from(
      container.querySelectorAll(
        `[data-testid="skill-read-detail-header-meta"] .${REPLAY_BLOCK_CLASS}`,
      ),
    ).map((node) => node.textContent);
    expect(blocked).toEqual(['Acme', 'Platform', 'Lena Park']);
    expect(
      container
        .querySelector('[data-testid="installed-share-copy"]')
        ?.classList.contains(REPLAY_BLOCK_CLASS),
    ).toBe(false);
  });

  it('shows only the sharer for a private share and drops blank names', () => {
    const container = renderHeader(
      installed({
        installedFromShare: {
          remoteId: 'share-2',
          shareScope: 'private',
          ownerName: '  ',
          sharedByName: ' Sam ',
        },
      }),
    );
    expect(metaFacts(container)).toEqual([
      'Shared by Sam',
      'One-time copy',
      'Installed Oct 14, 2026',
    ]);
  });

  it('keeps One-time copy for a legacy origin with only its id', () => {
    const container = renderHeader(
      installed({ installedFromShare: { remoteId: 'share-3' } }),
      { source: { kind: 'link', href: '/portal/plugins/skills/shared/s3' } },
    );
    expect(metaFacts(container)).toEqual([
      'One-time copy',
      'Installed Oct 14, 2026',
      'View shared skill',
    ]);
    expect(
      container
        .querySelector('[data-testid="installed-share-source-link"]')
        ?.getAttribute('href'),
    ).toBe('/portal/plugins/skills/shared/s3');
  });

  it('uses live names in place of the receipt, absences included', () => {
    const container = renderHeader(
      installed({
        installedFromShare: { ...orgOrigin, teamName: 'Platform' },
      }),
      { names: { ownerName: 'Acme Corp' } },
    );
    expect(metaFacts(container)).toEqual([
      'From Acme Corp',
      'One-time copy',
      'Installed Oct 14, 2026',
    ]);
  });

  it('routes an ordinary link click through onNavigate only', () => {
    const onNavigate = jest.fn();
    const container = renderHeader(
      installed({ installedFromShare: orgOrigin }),
      { source: { kind: 'link', href: '/shared/share-1', onNavigate } },
    );
    const link = container.querySelector<HTMLAnchorElement>(
      '[data-testid="installed-share-source-link"]',
    );
    const plain = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => {
      link?.dispatchEvent(plain);
    });
    expect(plain.defaultPrevented).toBe(true);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    const modified = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      metaKey: true,
    });
    act(() => {
      link?.dispatchEvent(modified);
    });
    expect(modified.defaultPrevented).toBe(false);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});

describe('installedSkillDetailHeader status and date (CAN-5306)', () => {
  const shared = (
    overrides: Partial<InstalledSkillInfo> = {},
  ): NonNullable<HeaderInstalled> =>
    installed({ installedFromShare: { remoteId: 'share-3' }, ...overrides });

  it.each([undefined, '', 'not a date'])(
    'falls back from an absent or invalid install date (%s) to the update date',
    (installedAt) => {
      expect(metaFacts(renderHeader(shared({ installedAt })))).toEqual([
        'One-time copy',
        'Installed Oct 20, 2026',
      ]);
    },
  );

  it('uses the valid install date even when the update date is invalid', () => {
    expect(
      metaFacts(renderHeader(shared({ updatedAt: 'not a date' }))),
    ).toEqual(['One-time copy', 'Installed Oct 14, 2026']);
  });

  it('keeps the badge alone when neither date parses', () => {
    const container = renderHeader(
      shared({ installedAt: '', updatedAt: 'nope' }),
      { updateAvailable: true },
    );
    expect(metaFacts(container)).toEqual(['One-time copy', 'Update available']);
    const status = container.querySelector(
      '[data-testid="installed-share-status"]',
    );
    expect(status?.textContent).toBe('Update available');
  });

  it('leaves out the status fact when it has nothing to say', () => {
    const container = renderHeader(
      shared({ installedAt: '', updatedAt: 'nope' }),
    );
    expect(metaFacts(container)).toEqual(['One-time copy']);
    expect(
      container.querySelector('[data-testid="installed-share-status"]'),
    ).toBeNull();
  });

  it('shows the update as an info badge with an icon, outside replay blocks', () => {
    const container = renderHeader(shared(), { updateAvailable: true });
    const statuses = container.querySelectorAll(
      '[data-testid="installed-share-status"]',
    );
    expect(statuses).toHaveLength(1);
    const badge = statuses[0]?.querySelector(
      '[data-testid="installed-share-update-available"]',
    );
    expect(badge?.getAttribute('data-badge-tone')).toBe('info');
    expect(badge?.querySelector('svg')).not.toBeNull();
    expect(statuses[0]?.closest(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
    expect(statuses[0]?.querySelector(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
  });

  it('keeps Updated for a skill that is not a shared copy', () => {
    expect(metaFacts(renderHeader(installed()))).toEqual([
      'Custom',
      'Updated Oct 20, 2026',
    ]);
  });
});

describe('SkillReadDetail host menu items and Update (CAN-5306)', () => {
  function renderDetail(
    props: Partial<Parameters<typeof SkillReadDetail>[0]>,
  ): HTMLDivElement {
    return mount(
      <SkillReadDetail
        skill={{ sourceId: 'custom:app', name: 'review' }}
        content={null}
        files={[]}
        loading={false}
        error=""
        readFile={() =>
          Promise.resolve({ content: '', truncated: false, binary: false })
        }
        {...props}
      />,
    );
  }

  function openMenu(container: HTMLElement): string[] {
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="skill-read-detail-more"]',
    );
    act(() => trigger?.click());
    return Array.from(
      document.querySelectorAll(
        '[data-testid="skill-read-detail-menu"] [data-testid^="skill-read-detail-"]',
      ),
    ).map((item) => item.getAttribute('data-testid') ?? '');
  }

  const tryItItem = (onSelect: () => void): DetailMoreMenuItem => ({
    id: 'try-it',
    label: 'Try it',
    icon: null,
    testId: 'skill-read-detail-try-it',
    onSelect,
  });

  it.each([
    ['header', { title: 'Review' }],
    ['dialog', undefined],
  ])('puts host items first in the %s layout', (_layout, header) => {
    const onSelect = jest.fn();
    const container = renderDetail({
      ...(header ? { header } : {}),
      leadingMenuItems: [tryItItem(onSelect)],
      onRemove: jest.fn(),
      updateAction: {
        status: 'ready',
        updateAvailable: false,
        pending: 'none',
        onCheck: jest.fn(),
        onApply: jest.fn(),
      },
    });
    const items = openMenu(container);
    expect(items[0]).toBe('skill-read-detail-try-it');
    expect(items).toContain('skill-read-detail-check-updates');
    act(() =>
      document
        .querySelector<HTMLElement>('[data-testid="skill-read-detail-try-it"]')
        ?.click(),
    );
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('activates Update with its name and respects a host-disabled state', () => {
    const onUpdate = jest.fn();
    const container = renderDetail({
      header: { title: 'Review' },
      primaryAction: (
        <InstalledShareUpdateButton name="Review" onUpdate={onUpdate} />
      ),
    });
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="installed-share-update"]',
    );
    expect(button?.textContent).toBe('Update');
    expect(button?.getAttribute('aria-label')).toBe('Update Review');
    act(() => button?.click());
    expect(onUpdate).toHaveBeenCalledTimes(1);

    act(() =>
      mounted?.render(
        <InstalledShareUpdateButton
          name="Review"
          onUpdate={onUpdate}
          disabled
        />,
      ),
    );
    const disabled = container.querySelector<HTMLButtonElement>(
      '[data-testid="installed-share-update"]',
    );
    expect(disabled?.disabled).toBe(true);
    act(() => disabled?.click());
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('shareSourceHashChanged', () => {
  it('reports only a valid, different SHA-256', () => {
    expect(shareSourceHashChanged(HASH_A, HASH_B)).toBe(true);
    expect(shareSourceHashChanged(HASH_A, HASH_A.toUpperCase())).toBe(false);
    expect(shareSourceHashChanged(HASH_A, HASH_A)).toBe(false);
    expect(shareSourceHashChanged(undefined, HASH_B)).toBe(false);
    expect(shareSourceHashChanged(HASH_A, '')).toBe(false);
    expect(shareSourceHashChanged(HASH_A, 'sha256:abc')).toBe(false);
  });
});

describe('sharedSkillDisplayNames', () => {
  const createdBy = { id: 'u1', name: 'Lena Park', email: null };
  it('names a team share by its organization and team', () => {
    expect(
      sharedSkillDisplayNames({
        createdBy,
        owner: {
          type: 'team',
          id: 't1',
          name: 'Platform',
          organization: { id: 'o1', name: 'Acme' },
        },
      }),
    ).toEqual({
      ownerName: 'Acme',
      teamName: 'Platform',
      sharedByName: 'Lena Park',
    });
  });

  it('never names a personal owner as an organization', () => {
    expect(
      sharedSkillDisplayNames({
        createdBy: { ...createdBy, name: null },
        owner: { type: 'user', id: 'u1', name: 'Lena Park' },
      }),
    ).toEqual({});
  });
});
