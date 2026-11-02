/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyCapabilities, CanopyClient } from '@canopy/app-core';
import type {
  GitHubPreviewTarget,
  GitHubReferenceOrigin,
  ReferenceEnrichmentMode,
} from '@canopy/protocol/reference-previews';
import {
  CanopyClientProvider,
  invalidateReferencePreviews,
  LINEAR_PREVIEW_CACHE_LIMITS,
} from '@canopy/app-state';
import { PrHoverCardsProvider } from '@canopy/ui-shared/components';
import { useWordBoundaryTruncation } from '@canopy/ui-shared/lib/useWordBoundaryTruncation';
import {
  GitHubReferencePreview,
  useGitHubOriginRepository,
  useGitHubPreviewConnected,
} from '../GitHubReferencePreview';

jest.mock('@canopy/ui-shared/lib/useWordBoundaryTruncation', () => ({
  useWordBoundaryTruncation: jest.fn(),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const BASE_CAPABILITIES: CanopyCapabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'read',
  voice: false,
  settingsScope: 'api-keys-only',
  pipelines: 'crud-only',
  routing: 'url',
  overviewNotifications: false,
};
const SUPPORTED: CanopyCapabilities = {
  ...BASE_CAPABILITIES,
  referencePreviews: true,
};

const LONG_TITLE =
  'Hydrate GitHub references in desktop chat transcripts with whole titles 🚀';

const ITEM: GitHubPreviewTarget = {
  kind: 'item',
  owner: 'acme',
  repository: 'canopy',
  number: 12,
};
const OTHER_ITEM: GitHubPreviewTarget = {
  kind: 'item',
  owner: 'acme',
  repository: 'website',
  number: 12,
};
const REPO: GitHubPreviewTarget = {
  kind: 'repository',
  owner: 'acme',
  repository: 'canopy',
};

function itemResult(target: GitHubPreviewTarget, title: string): object {
  return {
    status: 'ok',
    scope: 'github-a',
    preview:
      target.kind === 'item'
        ? {
            kind: 'item',
            owner: target.owner,
            repository: target.repository,
            number: target.number,
            itemType: 'pull',
            title,
            url: `https://github.com/${target.owner}/${target.repository}/pull/${target.number}`,
            description: null,
            state: 'open',
            draft: false,
            author: 'octocat',
            updatedAt: '2026-10-06T11:00:00.000Z',
          }
        : {
            kind: 'repository',
            owner: target.owner,
            repository: target.repository,
            fullName: `Acme/${target.repository}`,
            url: `https://github.com/${target.owner}/${target.repository}`,
            description: title === '' ? null : title,
            private: false,
            archived: false,
            updatedAt: '2026-10-06T11:00:00.000Z',
          },
  };
}

type Answer = (target: GitHubPreviewTarget) => Promise<unknown>;

function githubQuery(
  answer: Answer = (target) =>
    Promise.resolve(
      itemResult(
        target,
        target.kind === 'repository'
          ? 'Agentic desktop'
          : target.repository === 'canopy'
            ? LONG_TITLE
            : 'Website item',
      ),
    ),
  scope: string | null = 'github-a',
): jest.Mock<Promise<unknown>, [string, GitHubPreviewTarget]> {
  return jest.fn((name: string, args: GitHubPreviewTarget) => {
    if (name === 'referencePreview.githubScope') {
      return Promise.resolve({ scope });
    }
    if (name === 'referencePreview.githubOrigin') {
      return Promise.resolve({
        repository: { owner: 'acme', repository: 'canopy' },
      });
    }
    return answer(args);
  });
}

const reads = (query: jest.Mock): unknown[] =>
  query.mock.calls
    .filter(([name]) => name === 'referencePreview.github')
    .map(([, args]): unknown => args);

let container: HTMLDivElement;
let root: Root;

type Observed = { element: Element; callback: IntersectionObserverCallback };
let observed: Observed[] = [];

class FakeIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(element: Element): void {
    observed.push({ element, callback: this.callback });
  }
  unobserve(element: Element): void {
    observed = observed.filter((entry) => entry.element !== element);
  }
  disconnect(): void {}
}

beforeEach(() => {
  jest.useFakeTimers();
  observed = [];
  Object.assign(window, { IntersectionObserver: FakeIntersectionObserver });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
  Reflect.deleteProperty(window, 'IntersectionObserver');
  jest.useRealTimers();
});

function clientFor(
  capabilities: CanopyCapabilities,
  query: jest.Mock,
): CanopyClient {
  return {
    capabilities,
    query,
    command: jest.fn(),
    subscribe: () => () => undefined,
  };
}

function renderWith(
  capabilities: CanopyCapabilities,
  query: jest.Mock,
  content: JSX.Element,
): void {
  act(() =>
    root.render(
      <CanopyClientProvider client={clientFor(capabilities, query)}>
        <p>{content}</p>
      </CanopyClientProvider>,
    ),
  );
}

function renderReferences(
  capabilities: CanopyCapabilities,
  query: jest.Mock,
  mode?: ReferenceEnrichmentMode,
): void {
  renderWith(
    capabilities,
    query,
    <>
      <GitHubReferencePreview target={ITEM} label="#12" mode={mode}>
        #12
      </GitHubReferencePreview>{' '}
      <GitHubReferencePreview
        target={OTHER_ITEM}
        label="acme/website#12"
        href="https://github.com/acme/website/pull/12/files?diff=split#r1"
        mode={mode}
      >
        https://github.com/acme/website/pull/12/files?diff=split#r1
      </GitHubReferencePreview>{' '}
      <GitHubReferencePreview
        target={ITEM}
        label="acme/canopy#12"
        href="https://github.com/acme/canopy/pull/12"
        expandTitle={false}
        mode={mode}
      >
        the pull request
      </GitHubReferencePreview>
    </>,
  );
}

describe('GitHubReferencePreview enrichment modes', () => {
  it('keeps original labels and raw URLs in Hover, and removes enrichment in Off', () => {
    const query = githubQuery();
    renderReferences(SUPPORTED, query, 'hover');
    expect(references().map((reference) => reference.textContent)).toEqual([
      '#12',
      'https://github.com/acme/website/pull/12/files?diff=split#r1',
      'the pull request',
    ]);
    expect(container.querySelector('svg')).toBeNull();
    expect(placeholderIn(references()[0])).toBeNull();
    expect(
      query.mock.calls.some(([name]) => name === 'referencePreview.github'),
    ).toBe(false);
    query.mockClear();
    renderReferences(SUPPORTED, query, 'off');
    expect(references()).toHaveLength(0);
    expect(container.textContent).toContain('#12');
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      'https://github.com/acme/website/pull/12/files?diff=split#r1',
    );
    expect(query).not.toHaveBeenCalled();
  });
});

const references = (): HTMLElement[] =>
  Array.from(
    container.querySelectorAll<HTMLElement>('[data-testid="github-reference"]'),
  );

const setVisible = (element: Element, visible: boolean): void => {
  act(() => {
    for (const entry of observed.filter((item) => item.element === element)) {
      entry.callback(
        [
          {
            target: element,
            isIntersecting: visible,
          } as unknown as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );
    }
  });
};

async function settle(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
}

const placeholderIn = (reference: Element): Element | null =>
  reference.querySelector('[data-testid="github-reference-title-placeholder"]');
const titleIn = (reference: Element): Element | null =>
  reference.querySelector('[data-testid="github-reference-title"]');

describe('GitHubReferencePreview without the capability', () => {
  it('renders plain text and an ordinary link, and never reads', () => {
    const query = githubQuery();
    renderReferences(BASE_CAPABILITIES, query);
    expect(container.textContent).toBe(
      '#12 https://github.com/acme/website/pull/12/files?diff=split#r1 the pull request',
    );
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('[role="link"]')).toBeNull();
    // Nothing declares a link URL for the message menu (CAN-2632).
    expect(container.querySelector('[data-link-url]')).toBeNull();
    expect(
      Array.from(container.querySelectorAll('a')).map((a) =>
        a.getAttribute('href'),
      ),
    ).toEqual([
      'https://github.com/acme/website/pull/12/files?diff=split#r1',
      'https://github.com/acme/canopy/pull/12',
    ]);
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    expect(query).not.toHaveBeenCalled();
    expect(observed).toEqual([]);
  });
});

describe('GitHubReferencePreview inline titles', () => {
  async function connected(query: jest.Mock): Promise<void> {
    renderReferences(SUPPORTED, query);
    await settle(0);
  }

  it('adds an aria-hidden icon and reserves an inert title slot before resolution', async () => {
    const query = githubQuery();
    await connected(query);
    const [bare, url, custom] = references();
    for (const reference of [bare, url, custom]) {
      expect(reference.querySelector('svg')?.getAttribute('aria-hidden')).toBe(
        'true',
      );
    }
    // A raw URL label shortens to the generated label.
    expect(url.textContent).toBe('acme/website#12');
    expect(bare.textContent).toBe('#12');
    expect(custom.textContent).toBe('the pull request');
    for (const reference of [bare, url]) {
      const placeholder = placeholderIn(reference);
      expect(placeholder?.getAttribute('aria-hidden')).toBe('true');
      expect(placeholder?.hasAttribute('data-active')).toBe(false);
    }
    expect(placeholderIn(custom)).toBeNull();
    expect(reads(query)).toEqual([]);
  });

  it('reads only references that stay on screen through the debounce', async () => {
    const query = githubQuery();
    await connected(query);
    const [bare, url] = references();
    setVisible(url, true);
    await settle(100);
    setVisible(url, false);
    await settle(1_000);
    expect(reads(query)).toEqual([]);
    setVisible(bare, true);
    await settle(149);
    expect(reads(query)).toEqual([]);
    await settle(1);
    await settle(0);
    expect(reads(query)).toEqual([ITEM]);
  });

  it('expands generated labels with the full title, cropped at five words', async () => {
    const query = githubQuery();
    await connected(query);
    const [bare, url, custom] = references();
    setVisible(bare, true);
    setVisible(url, true);
    setVisible(custom, true);
    await settle(150);
    await settle(0);
    expect(bare.textContent).toBe(`#12: ${LONG_TITLE}`);
    expect(url.textContent).toBe('acme/website#12: Website item');
    expect(custom.textContent).toBe('the pull request');
    expect(titleIn(custom)).toBeNull();
    const title = titleIn(bare);
    expect(title?.className).toContain('truncate');
    expect(title?.className).toContain('max-w-[min(40ch,100%)]');
    // One whole text node keeps copy and the accessible name on the full title.
    expect(title?.childNodes).toHaveLength(1);
    expect(title?.firstChild?.textContent).toBe(LONG_TITLE);
    expect(jest.mocked(useWordBoundaryTruncation)).toHaveBeenCalledWith(
      expect.anything(),
      LONG_TITLE,
      expect.objectContaining({ maxWords: 5 }),
    );
    expect(placeholderIn(bare)).toBeNull();
    // Two repositories that share a number read separately.
    expect(reads(query)).toEqual([ITEM, OTHER_ITEM]);
  });

  it('declares the canonical URL once the item has resolved', async () => {
    const query = githubQuery();
    await connected(query);
    const [bare, url, custom] = references();
    expect(bare.hasAttribute('data-link-url')).toBe(false);
    setVisible(bare, true);
    setVisible(url, true);
    await settle(150);
    await settle(0);
    expect(titleIn(bare)).not.toBeNull();
    expect(bare.getAttribute('data-link-url')).toBe(
      'https://github.com/acme/canopy/pull/12',
    );
    // URL-authored references stay anchors and declare nothing.
    for (const anchor of [url, custom]) {
      expect(anchor.tagName).toBe('A');
      expect(anchor.hasAttribute('data-link-url')).toBe(false);
    }
  });

  it('keeps the explicit URL, including path suffix, query and fragment', async () => {
    const query = githubQuery();
    await connected(query);
    const [, url, custom] = references();
    setVisible(url, true);
    await settle(150);
    await settle(0);
    expect(url.tagName).toBe('A');
    expect(url.getAttribute('href')).toBe(
      'https://github.com/acme/website/pull/12/files?diff=split#r1',
    );
    expect(url.getAttribute('target')).toBe('_blank');
    expect(url.getAttribute('rel')).toBe('noopener noreferrer');
    expect(custom.getAttribute('href')).toBe(
      'https://github.com/acme/canopy/pull/12',
    );
  });

  it('opens the canonical URL from a generated item on Enter and click', async () => {
    const query = githubQuery();
    await connected(query);
    const open = jest.spyOn(window, 'open').mockReturnValue(null);
    try {
      const [bare] = references();
      expect(bare.getAttribute('role')).toBe('link');
      expect(bare.getAttribute('tabindex')).toBe('0');
      await act(async () => {
        bare.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
        for (let index = 0; index < 12; index += 1) await Promise.resolve();
      });
      expect(open).toHaveBeenCalledWith(
        'https://github.com/acme/canopy/pull/12',
        '_blank',
        'noopener,noreferrer',
      );
      await act(async () => {
        bare.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        for (let index = 0; index < 12; index += 1) await Promise.resolve();
      });
      expect(open).toHaveBeenCalledTimes(2);
      expect(reads(query)).toEqual([ITEM]);
    } finally {
      open.mockRestore();
    }
  });

  it('animates the placeholder while reading and collapses it when unavailable', async () => {
    let answer: ((value: unknown) => void) | null = null;
    const query = githubQuery(
      () =>
        new Promise<unknown>((resolve) => {
          answer = resolve;
        }),
    );
    await connected(query);
    const [bare] = references();
    setVisible(bare, true);
    await settle(150);
    await settle(0);
    expect(placeholderIn(bare)?.getAttribute('data-active')).toBe('true');
    await act(async () => {
      answer?.({ status: 'unavailable', scope: 'github-a' });
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
    expect(placeholderIn(bare)).toBeNull();
    expect(bare.textContent).toBe('#12');
    expect(bare.querySelector('svg')).not.toBeNull();
  });

  it('keeps the original URL text, icon and no placeholder when GitHub is disconnected', async () => {
    const query = githubQuery(
      () => Promise.resolve({ status: 'disconnected' }),
      null,
    );
    await connected(query);
    const [bare, url] = references();
    for (const reference of [bare, url]) {
      expect(placeholderIn(reference)).toBeNull();
      expect(reference.querySelector('svg')).not.toBeNull();
    }
    expect(url.textContent).toBe(
      'https://github.com/acme/website/pull/12/files?diff=split#r1',
    );
    // Disconnected references never queue reads.
    setVisible(bare, true);
    await settle(1_000);
    expect(reads(query)).toEqual([]);
    expect(bare.hasAttribute('data-link-url')).toBe(false);
  });

  it('removes the placeholder after a disconnect result', async () => {
    let scope: string | null = 'github-a';
    const query = jest.fn((name: string) => {
      if (name === 'referencePreview.githubScope') {
        return Promise.resolve({ scope });
      }
      scope = null;
      return Promise.resolve({ status: 'disconnected' });
    });
    await connected(query);
    const [bare, url] = references();
    expect(placeholderIn(bare)).not.toBeNull();
    setVisible(bare, true);
    setVisible(url, true);
    await settle(150);
    await settle(0);
    await settle(0);
    for (const reference of [bare, url]) {
      expect(placeholderIn(reference)).toBeNull();
      expect(reference.querySelector('svg')).not.toBeNull();
    }
    expect(bare.textContent).toBe('#12');
  });

  it('shows a repository description as its title, and the label alone without one', async () => {
    const query = githubQuery((target) =>
      Promise.resolve(
        itemResult(
          target,
          target.repository === 'canopy' ? 'Agentic desktop' : '',
        ),
      ),
    );
    renderWith(
      SUPPORTED,
      query,
      <>
        <GitHubReferencePreview
          target={REPO}
          label="acme/canopy"
          href="https://github.com/acme/canopy"
        >
          https://github.com/acme/canopy
        </GitHubReferencePreview>{' '}
        <GitHubReferencePreview
          target={{ kind: 'repository', owner: 'acme', repository: 'bare' }}
          label="acme/bare"
          href="https://github.com/acme/bare"
        >
          https://github.com/acme/bare
        </GitHubReferencePreview>
      </>,
    );
    await settle(0);
    const [described, plain] = references();
    setVisible(described, true);
    setVisible(plain, true);
    await settle(150);
    await settle(0);
    expect(described.textContent).toBe('acme/canopy: Agentic desktop');
    expect(plain.textContent).toBe('acme/bare');
    expect(placeholderIn(plain)).toBeNull();
    expect(titleIn(plain)).toBeNull();
  });

  it('reverts to the original text when the GitHub identity resets', async () => {
    const query = githubQuery();
    await connected(query);
    const [bare] = references();
    setVisible(bare, true);
    await settle(150);
    await settle(0);
    expect(bare.textContent).toBe(`#12: ${LONG_TITLE}`);
    expect(bare.hasAttribute('data-link-url')).toBe(true);
    act(() => invalidateReferencePreviews(window.localStorage, 'github'));
    expect(bare.textContent).toBe('#12');
    expect(bare.hasAttribute('data-link-url')).toBe(false);
  });

  it('opens a focused card with the label and title', async () => {
    const query = githubQuery();
    await connected(query);
    const [bare] = references();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
      bare.focus();
    });
    await settle(0);
    const tooltip = document.body.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toContain('#12');
    expect(tooltip?.textContent).toContain(LONG_TITLE);
    expect(bare.getAttribute('aria-describedby')).toBe(tooltip?.id);
  });
});

describe('GitHubReferencePreview with Pull request cards', () => {
  async function openCard(prHoverCards: boolean | null): Promise<Element> {
    const query = githubQuery();
    const reference = (
      <GitHubReferencePreview target={ITEM} label="#12">
        #12
      </GitHubReferencePreview>
    );
    renderWith(
      SUPPORTED,
      query,
      prHoverCards === null ? (
        reference
      ) : (
        <PrHoverCardsProvider value={prHoverCards}>
          {reference}
        </PrHoverCardsProvider>
      ),
    );
    await settle(0);
    const [link] = Array.from(
      container.querySelectorAll('[data-testid="github-reference"]'),
    );
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
      (link as HTMLElement).focus();
    });
    await settle(0);
    const tooltip = document.body.querySelector('[role="tooltip"]');
    expect(tooltip).toBeInstanceOf(Element);
    return tooltip as Element;
  }

  it('keeps the classic card on the tooltip surface by default and when off', async () => {
    for (const value of [null, false]) {
      const tooltip = await openCard(value);
      const card = tooltip.querySelector(
        '[data-testid="github-reference-preview-card"]',
      );
      expect(card).toBeInstanceOf(Element);
      expect(card?.getAttribute('data-layout')).toBeNull();
      expect(tooltip.className).toContain('shadow-tooltip');
      act(() => root.unmount());
      root = createRoot(container);
    }
  });

  it('shows the status card on the shared preview card surface when on', async () => {
    const tooltip = await openCard(true);
    const card = tooltip.querySelector(
      '[data-testid="github-reference-preview-card"]',
    );
    expect(card?.getAttribute('data-layout')).toBe('status');
    expect(
      tooltip.querySelector('[data-testid="github-reference-preview-status"]')
        ?.textContent,
    ).toBe('Open');
    // The sidebar worktree card's surface: menu corners and shadow.
    expect(tooltip.className).toContain('rounded-lg');
    expect(tooltip.className).toContain('shadow-xl');
    expect(tooltip.className).not.toContain('shadow-tooltip');
    // The worktree card's fixed width.
    expect(tooltip.className).toContain('w-70');
    expect(tooltip.className).not.toContain('w-80');
  });
});

describe('GitHub preview hooks', () => {
  function Probe({
    origin,
    enabled = true,
  }: {
    origin: GitHubReferenceOrigin | null;
    enabled?: boolean;
  }): JSX.Element {
    const connected = useGitHubPreviewConnected(enabled);
    const repository = useGitHubOriginRepository(origin);
    return (
      <span data-testid="probe">
        {`${String(connected)}|${
          repository === undefined
            ? 'resolving'
            : repository === null
              ? 'none'
              : `${repository.owner}/${repository.repository}`
        }`}
      </span>
    );
  }
  const probe = (): string | null =>
    container.querySelector('[data-testid="probe"]')?.textContent ?? null;

  it('does no connection work while disabled and resumes on the same mounted store', async () => {
    const query = githubQuery();
    const client = clientFor(SUPPORTED, query);
    const show = (enabled: boolean): void => {
      act(() =>
        root.render(
          <CanopyClientProvider client={client}>
            <Probe origin={null} enabled={enabled} />
          </CanopyClientProvider>,
        ),
      );
    };
    show(false);
    expect(probe()).toBe('null|none');
    expect(query).not.toHaveBeenCalled();
    show(true);
    await settle(0);
    expect(probe()).toBe('true|none');
    expect(query).toHaveBeenCalledWith('referencePreview.githubScope', {});
  });

  it('reports connection and the origin repository once resolved', async () => {
    const query = githubQuery();
    renderWith(
      SUPPORTED,
      query,
      <Probe origin={{ kind: 'worktree', projectId: 'p', worktreeId: 'w' }} />,
    );
    expect(probe()).toBe('false|resolving');
    await settle(0);
    expect(probe()).toBe('true|acme/canopy');
    expect(
      query.mock.calls.filter(
        ([name]) => name === 'referencePreview.githubOrigin',
      ),
    ).toHaveLength(1);
  });

  it('treats an expired resolved origin as absent while a new origin still resolves', async () => {
    const query = githubQuery();
    const client = clientFor(SUPPORTED, query);
    const show = (worktreeId: string): void => {
      act(() =>
        root.render(
          <CanopyClientProvider client={client}>
            <Probe origin={{ kind: 'worktree', projectId: 'p', worktreeId }} />
          </CanopyClientProvider>,
        ),
      );
    };
    show('a');
    await settle(0);
    expect(probe()).toBe('true|acme/canopy');
    await settle(LINEAR_PREVIEW_CACHE_LIMITS.retentionMs + 1);
    expect(probe()).toBe('true|none');
    show('b');
    expect(probe()).toBe('true|resolving');
    await settle(0);
    expect(probe()).toBe('true|acme/canopy');
  });

  it('never resolves a cowork origin', async () => {
    const query = githubQuery();
    renderWith(SUPPORTED, query, <Probe origin={{ kind: 'cowork' }} />);
    await settle(0);
    expect(probe()).toBe('true|none');
    expect(
      query.mock.calls.filter(
        ([name]) => name === 'referencePreview.githubOrigin',
      ),
    ).toHaveLength(0);
  });

  it('does no work without the capability', async () => {
    const query = githubQuery();
    renderWith(
      BASE_CAPABILITIES,
      query,
      <Probe origin={{ kind: 'worktree', projectId: 'p', worktreeId: 'w' }} />,
    );
    await settle(0);
    expect(probe()).toBe('null|none');
    expect(query).not.toHaveBeenCalled();
  });
});
