/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  InstalledSkillInfo,
  SharedSkillInstallOrigin,
} from '@canopy/protocol';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  SkillReadDetail,
  installedSkillDetailHeader,
} from '../SkillReadDetail';
import {
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

  it('orders organization, team, sharer, copy, update, date and link', () => {
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
      'Update available',
      'Updated Oct 20, 2026',
      'View shared skill',
    ]);
    expect(container.textContent).not.toContain('Custom');
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
      'Updated Oct 20, 2026',
    ]);
  });

  it('keeps One-time copy for a legacy origin with only its id', () => {
    const container = renderHeader(
      installed({ installedFromShare: { remoteId: 'share-3' } }),
      { source: { kind: 'link', href: '/portal/plugins/skills/shared/s3' } },
    );
    expect(metaFacts(container)).toEqual([
      'One-time copy',
      'Updated Oct 20, 2026',
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
      'Updated Oct 20, 2026',
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
