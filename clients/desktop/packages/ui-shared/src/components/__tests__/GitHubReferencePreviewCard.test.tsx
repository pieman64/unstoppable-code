/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  GitHubItemPreview,
  GitHubRepositoryPreview,
} from '@canopy/protocol/reference-previews';
import {
  GitHubReferencePreviewCard,
  type GitHubReferencePreviewCardView,
} from '../GitHubReferencePreviewCard';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const NOW = Date.parse('2026-10-10T12:00:00Z');
const LONG_TITLE =
  'Hydrate GitHub pull request, issue, and repository references in desktop chat transcripts without truncating the title';

const PULL: GitHubItemPreview = {
  kind: 'item',
  owner: 'acme',
  repository: 'tower',
  number: 1234,
  itemType: 'pull',
  title: LONG_TITLE,
  url: 'https://github.com/acme/tower/pull/1234',
  description: 'Adds hover previews for GitHub references.',
  state: 'open',
  draft: false,
  author: 'octocat',
  updatedAt: '2026-10-10T09:00:00Z',
};

const REPOSITORY: GitHubRepositoryPreview = {
  kind: 'repository',
  owner: 'acme',
  repository: 'tower',
  fullName: 'Acme/Tower',
  url: 'https://github.com/Acme/Tower',
  description: 'Tower defense, but for merge queues.',
  private: false,
  archived: false,
  updatedAt: '2026-10-08T12:00:00Z',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.restoreAllMocks();
});

function render(label: string, view: GitHubReferencePreviewCardView): void {
  act(() => {
    root.render(<GitHubReferencePreviewCard label={label} view={view} />);
  });
}

function ready(
  preview: GitHubItemPreview | GitHubRepositoryPreview,
  stale = false,
): GitHubReferencePreviewCardView {
  return {
    status: 'ready',
    preview,
    checkedAt: NOW - 5 * 60_000,
    stale,
  };
}

function card(): HTMLElement {
  const element = container.querySelector<HTMLElement>(
    '[data-testid="github-reference-preview-card"]',
  );
  if (!element) throw new Error('missing card');
  return element;
}

/** The card's text lines, in order. */
function lines(): string[] {
  return Array.from(card().children, (child) => child.textContent ?? '');
}

describe('GitHubReferencePreviewCard', () => {
  it('shows a pull request with its full title, description, facts, and freshness', () => {
    render('acme/tower#1234', ready(PULL));
    expect(lines()).toEqual([
      `acme/tower#1234${LONG_TITLE}`,
      'Adds hover previews for GitHub references.',
      'Pull request · Open · by octocat',
      'Updated 3h ago',
    ]);
    const label = card().querySelector('.font-mono');
    expect(label?.textContent).toBe('acme/tower#1234');
    const heading = card().firstElementChild;
    expect(heading?.className).toContain('break-words');
    expect(heading?.className).not.toContain('truncate');
    expect(heading?.lastElementChild?.textContent).toBe(LONG_TITLE);
    expect(heading?.lastElementChild?.className ?? '').not.toContain(
      'truncate',
    );
    expect(card().querySelector('p')?.className).toContain('line-clamp-3');
    expect(container.querySelector('[aria-live]')).toBeNull();
  });

  it.each<[string, Partial<GitHubItemPreview>, string]>([
    ['open pull request', {}, 'Pull request · Open'],
    ['draft pull request', { draft: true }, 'Pull request · Draft'],
    ['merged pull request', { state: 'merged' }, 'Pull request · Merged'],
    ['closed pull request', { state: 'closed' }, 'Pull request · Closed'],
    [
      'closed draft pull request',
      { state: 'closed', draft: true },
      'Pull request · Closed',
    ],
    ['open issue', { itemType: 'issue' }, 'Issue · Open'],
    ['closed issue', { itemType: 'issue', state: 'closed' }, 'Issue · Closed'],
  ])('describes a %s', (_name, overrides, facts) => {
    render('#1234', ready({ ...PULL, author: null, ...overrides }));
    expect(lines()[2]).toBe(facts);
  });

  it('labels a bare item reference and omits an absent description and author', () => {
    render('#1234', ready({ ...PULL, description: null, author: null }));
    expect(lines()).toEqual([
      `#1234${LONG_TITLE}`,
      'Pull request · Open',
      'Updated 3h ago',
    ]);
    expect(card().querySelector('p')).toBeNull();
  });

  it('says when a stale item was last checked', () => {
    render('#1234', ready(PULL, true));
    expect(lines().at(-1)).toBe('Checked 5m ago');
  });

  it('shows a public repository under its full name without a separate label', () => {
    render('acme/tower', ready(REPOSITORY));
    expect(lines()).toEqual([
      'Acme/Tower',
      'Tower defense, but for merge queues.',
      'Repository · Public',
      'Updated 2d ago',
    ]);
    expect(card().querySelector('.font-mono')).toBeNull();
    expect(card().firstElementChild?.className).toContain('break-words');
    expect(card().querySelector('p')?.className).toContain('line-clamp-3');
  });

  it('marks a private, archived repository and omits an absent description', () => {
    render(
      'acme/tower',
      ready({
        ...REPOSITORY,
        private: true,
        archived: true,
        description: null,
      }),
    );
    expect(lines()).toEqual([
      'Acme/Tower',
      'Repository · Private · Archived',
      'Updated 2d ago',
    ]);
  });

  it('says when a stale repository was last checked', () => {
    render('acme/tower', ready(REPOSITORY, true));
    expect(lines().at(-1)).toBe('Checked 5m ago');
  });

  it.each<[string, GitHubReferencePreviewCardView, string]>([
    ['loading', { status: 'loading' }, 'Loading preview…'],
    [
      'disconnected',
      { status: 'unavailable', reason: 'disconnected' },
      'Connect GitHub in Settings to preview this',
    ],
    [
      'unavailable',
      { status: 'unavailable', reason: 'unavailable' },
      'Preview unavailable',
    ],
    [
      'failed',
      { status: 'unavailable', reason: 'failed' },
      "Couldn't reach GitHub",
    ],
  ])('announces the %s state under the label', (_name, view, copy) => {
    render('acme/tower#1234', view);
    expect(
      container.querySelector('[data-testid="github-reference-preview-card"]'),
    ).toBeNull();
    const status = container.querySelector<HTMLElement>('[aria-live="polite"]');
    expect(
      Array.from(status?.children ?? [], (child) => child.textContent),
    ).toEqual(['acme/tower#1234', copy]);
    expect(status?.firstElementChild?.className).toContain('font-mono');
  });
});

describe('GitHubReferencePreviewCard replay privacy', () => {
  it('blocks the label, provider content and the author login, but not the state', () => {
    act(() =>
      root.render(
        <GitHubReferencePreviewCard
          label="acme/tower#1234"
          view={{
            status: 'ready',
            preview: PULL,
            checkedAt: NOW,
            stale: false,
          }}
        />,
      ),
    );
    const blocked = Array.from(
      container.querySelectorAll(`.${REPLAY_BLOCK_CLASS}`),
      (node) => node.textContent,
    );
    expect(blocked).toEqual([
      'acme/tower#1234',
      LONG_TITLE,
      'Adds hover previews for GitHub references.',
      'octocat',
    ]);
    expect(container.textContent).toContain('Pull request · Open · by octocat');
  });

  it('blocks the repository name and description', () => {
    act(() =>
      root.render(
        <GitHubReferencePreviewCard
          label="acme/tower"
          view={{
            status: 'ready',
            preview: REPOSITORY,
            checkedAt: NOW,
            stale: false,
          }}
        />,
      ),
    );
    expect(
      Array.from(
        container.querySelectorAll(`.${REPLAY_BLOCK_CLASS}`),
        (node) => node.textContent,
      ),
    ).toEqual(['Acme/Tower', 'Tower defense, but for merge queues.']);
  });

  it('blocks the label while loading or unavailable', () => {
    act(() =>
      root.render(
        <GitHubReferencePreviewCard
          label="private-org/private-repo#7"
          view={{ status: 'unavailable', reason: 'unavailable' }}
        />,
      ),
    );
    expect(
      Array.from(
        container.querySelectorAll(`.${REPLAY_BLOCK_CLASS}`),
        (node) => node.textContent,
      ),
    ).toEqual(['private-org/private-repo#7']);
    expect(container.textContent).toContain('Preview unavailable');
  });
});

describe('GitHubReferencePreviewCard status layout', () => {
  const FACTS: NonNullable<GitHubItemPreview['pull']> = {
    additions: 2674,
    deletions: 963,
    changedFiles: 42,
    mergeable: 'mergeable',
    checks: 'none',
    reviewDecision: null,
    inMergeQueue: false,
  };
  const STATUS_PULL: GitHubItemPreview = {
    ...PULL,
    authorAvatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
    pull: FACTS,
  };

  function renderStatus(preview: GitHubItemPreview): void {
    act(() => {
      root.render(
        <GitHubReferencePreviewCard
          label={`#${preview.number}`}
          layout="status"
          view={ready(preview)}
        />,
      );
    });
  }

  function byTestId(id: string): HTMLElement {
    const element = container.querySelector<HTMLElement>(
      `[data-testid="${id}"]`,
    );
    if (!element) throw new Error(`missing ${id}`);
    return element;
  }

  it('leads with the status, then the title, then the author and size', () => {
    renderStatus(STATUS_PULL);
    expect(card().getAttribute('data-layout')).toBe('status');
    expect(byTestId('github-reference-preview-status').textContent).toBe(
      'Open',
    );
    expect(byTestId('github-reference-preview-repository').textContent).toBe(
      'tower',
    );
    expect(lines()[0]).toBe('Opentower#12343h ago');
    expect(lines()[1]).toBe(LONG_TITLE);
    expect(byTestId('github-reference-preview-diff').textContent).toBe(
      '+2,674-963',
    );
    expect(byTestId('github-reference-preview-files').textContent).toBe(
      '42 files',
    );
    // Proportional figures throughout.
    expect(card().outerHTML).not.toContain('tabular-nums');
    const avatar = card().querySelector('img');
    expect(avatar).toBeInstanceOf(HTMLImageElement);
    expect(avatar?.getAttribute('src')).toBe(STATUS_PULL.authorAvatarUrl);
  });

  it.each<[string, Partial<GitHubItemPreview>, Partial<typeof FACTS>, string]>([
    ['Open', {}, {}, 'open'],
    ['Draft', { draft: true }, {}, 'draft'],
    ['Merged', { state: 'merged' }, {}, 'merged'],
    ['Closed', { state: 'closed' }, {}, 'closed'],
    ['Merge conflicts', {}, { mergeable: 'conflicting' }, 'merge-conflict'],
    ['Checks failing', {}, { checks: 'failing' }, 'checks-failing'],
    [
      'Changes requested',
      {},
      { reviewDecision: 'changes_requested' },
      'changes-requested',
    ],
    ['Checks running', {}, { checks: 'pending' }, 'checks-running'],
    ['Checks passing', {}, { checks: 'passing' }, 'checks-passing'],
    ['In merge queue', {}, { inMergeQueue: true }, 'merge-queue'],
  ])('names %s with its own glyph', (label, overrides, facts, kind) => {
    renderStatus({
      ...STATUS_PULL,
      ...overrides,
      pull: { ...FACTS, ...facts },
    });
    const status = byTestId('github-reference-preview-status');
    expect(status.textContent).toBe(label);
    expect(status.getAttribute('data-status')).toBe(kind);
  });

  it('draws every status with a different glyph', () => {
    const glyphs = new Set<string>();
    const cases: [Partial<GitHubItemPreview>, Partial<typeof FACTS>][] = [
      [{}, {}],
      [{ draft: true }, {}],
      [{ state: 'merged' }, {}],
      [{ state: 'closed' }, {}],
      [{}, { mergeable: 'conflicting' }],
      [{}, { checks: 'failing' }],
      [{}, { reviewDecision: 'changes_requested' }],
      [{}, { checks: 'passing' }],
      [{}, { inMergeQueue: true }],
    ];
    for (const [overrides, facts] of cases) {
      renderStatus({
        ...STATUS_PULL,
        ...overrides,
        pull: { ...FACTS, ...facts },
      });
      const svg = byTestId('github-reference-preview-status').querySelector(
        'svg',
      );
      expect(svg).toBeInstanceOf(SVGElement);
      glyphs.add(svg?.getAttribute('data-glyph') ?? '');
    }
    expect(glyphs.size).toBe(cases.length);
  });

  it('shows a person glyph without an avatar picture, and only the author for an older read', () => {
    renderStatus({ ...STATUS_PULL, authorAvatarUrl: null, pull: undefined });
    expect(card().querySelector('img')).toBeNull();
    expect(card().textContent).not.toContain('OC');
    expect(card().querySelector('svg[data-glyph="user-round"]')).toBeInstanceOf(
      SVGElement,
    );
    expect(
      container.querySelector('[data-testid="github-reference-preview-files"]'),
    ).toBeNull();
  });

  it('draws line icons with a 1.5px line at 14px', () => {
    renderStatus({
      ...STATUS_PULL,
      authorAvatarUrl: null,
      pull: { ...FACTS, checks: 'failing' },
    });
    for (const glyph of ['circle-x', 'user-round']) {
      const svg = card().querySelector<SVGElement>(
        `svg[data-glyph="${glyph}"]`,
      );
      expect(svg).toBeInstanceOf(SVGElement);
      // 1.5px of a 14px box is 1.5 × 24 / 14 units of the 24-unit artwork.
      expect(Number(svg?.style.strokeWidth)).toBeCloseTo((1.5 * 24) / 14, 3);
    }
  });

  it('marks stale cached facts with when they were last checked', () => {
    act(() => {
      root.render(
        <GitHubReferencePreviewCard
          label="#1234"
          layout="status"
          view={ready(STATUS_PULL, true)}
        />,
      );
    });
    // On its own line: the header keeps the status, number and update age.
    expect(byTestId('github-reference-preview-checked').textContent).toBe(
      'Checked 5m ago',
    );
    expect(byTestId('github-reference-preview-age').textContent).toBe('3h ago');
    renderStatus(STATUS_PULL);
    expect(
      container.querySelector(
        '[data-testid="github-reference-preview-checked"]',
      ),
    ).toBeNull();
  });

  it('counts one file in the singular', () => {
    renderStatus({ ...STATUS_PULL, pull: { ...FACTS, changedFiles: 1 } });
    expect(byTestId('github-reference-preview-files').textContent).toBe(
      '1 file',
    );
  });

  it('names an issue state as text alone', () => {
    renderStatus({ ...PULL, itemType: 'issue', state: 'closed' });
    const status = byTestId('github-reference-preview-status');
    expect(status.textContent).toBe('Closed');
    expect(status.querySelector('svg')).toBeNull();
  });

  it('keeps the classic layout for a repository', () => {
    act(() => {
      root.render(
        <GitHubReferencePreviewCard
          label="acme/tower"
          layout="status"
          view={ready(REPOSITORY)}
        />,
      );
    });
    expect(card().getAttribute('data-layout')).toBeNull();
    expect(card().textContent).toContain('Acme/Tower');
  });
});
