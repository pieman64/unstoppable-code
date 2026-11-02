/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyCapabilities,
  CanopyClient,
  QueryMap,
  QueryName,
} from '@canopy/app-core';
import type {
  LinearIssuePreviewResult,
  ReferenceEnrichmentMode,
} from '@canopy/protocol/reference-previews';
import {
  CanopyClientProvider,
  invalidateReferencePreviews,
} from '@canopy/app-state';
import * as tooltipHandoff from '../../../../ui-shared/src/components/tooltip-handoff';
import {
  LinearReferencePreview,
  useLinearTeamCatalog,
} from '../LinearReferencePreview';

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

let container: HTMLDivElement;
let root: Root;

function render(
  capabilities: CanopyCapabilities,
  query: jest.Mock,
  mode?: ReferenceEnrichmentMode,
): void {
  const client: CanopyClient = {
    capabilities,
    query,
    command: jest.fn(),
    subscribe: () => () => undefined,
  };
  act(() =>
    root.render(
      <CanopyClientProvider client={client}>
        <p>
          See{' '}
          <LinearReferencePreview identifier="CAN-1" mode={mode}>
            CAN-1
          </LinearReferencePreview>{' '}
          and{' '}
          <LinearReferencePreview
            identifier="CAN-2"
            workspaceSlug="acme"
            href="https://linear.app/acme/issue/CAN-2"
            mode={mode}
          >
            the ticket
          </LinearReferencePreview>
        </p>
      </CanopyClientProvider>,
    ),
  );
}

describe('LinearReferencePreview enrichment modes', () => {
  it('keeps exact author text in Hover and plain text/anchors in Off', () => {
    const query = jest.fn();
    const supported = { ...BASE_CAPABILITIES, referencePreviews: true };
    render(supported, query, 'hover');
    expect(container.textContent).toBe('See CAN-1 and the ticket');
    expect(
      container.querySelectorAll('[data-testid="linear-reference"]'),
    ).toHaveLength(2);
    expect(container.querySelector('svg')).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="linear-reference-title-placeholder"]',
      ),
    ).toBeNull();
    render(supported, query, 'off');
    expect(container.textContent).toBe('See CAN-1 and the ticket');
    expect(container.querySelector('[role="link"]')).toBeNull();
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      'https://linear.app/acme/issue/CAN-2',
    );
    expect(query).not.toHaveBeenCalled();
  });
});

beforeEach(() => {
  jest.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  // Stores hydrate saved titles on creation; keep each test's cache its own.
  window.localStorage.clear();
  jest.useRealTimers();
});

describe('LinearReferencePreview on a host without the capability', () => {
  it('renders plain text and an ordinary link, and never reads', () => {
    const query = jest.fn();
    render(BASE_CAPABILITIES, query);
    expect(container.textContent).toBe('See CAN-1 and the ticket');
    expect(container.querySelector('[role="link"]')).toBeNull();
    expect(container.querySelector('svg')).toBeNull();
    // Nothing declares a link URL for the message menu (CAN-2632).
    expect(container.querySelector('[data-link-url]')).toBeNull();
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe(
      'https://linear.app/acme/issue/CAN-2',
    );
    act(() => {
      anchor?.dispatchEvent(
        new MouseEvent('mouseover', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
      jest.advanceTimersByTime(1_000);
    });
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('LinearReferencePreview on a supporting host', () => {
  const disconnectedQuery = (): jest.Mock =>
    jest.fn((name: string) =>
      Promise.resolve(
        name === 'referencePreview.linearScope'
          ? { scope: null }
          : { status: 'disconnected' },
      ),
    );

  const hover = (target: Element, type: string): void => {
    act(() => {
      target.dispatchEvent(
        new MouseEvent(type, { bubbles: true, relatedTarget: document.body }),
      );
    });
  };

  // Settle the open card's read inside act so it can't land in a later test.
  const settleOpenCard = async (): Promise<void> => {
    await act(async () => {
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
  };

  it('preserves the first trigger, selection and 250ms pointer delay', async () => {
    render(
      { ...BASE_CAPABILITIES, referencePreviews: true },
      disconnectedQuery(),
    );
    const reference = container.querySelector('[role="link"]');
    if (!reference) throw new Error('reference missing');
    const text = Array.from(reference.childNodes).find(
      (node) => node.nodeType === Node.TEXT_NODE,
    );
    if (!text) throw new Error('label missing');
    const range = document.createRange();
    range.selectNodeContents(text);
    document.getSelection()?.addRange(range);
    hover(reference, 'mouseover');
    expect(container.querySelector('[role="link"]')).toBe(reference);
    expect(document.getSelection()?.toString()).toBe('CAN-1');
    act(() => jest.advanceTimersByTime(249));
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    act(() => jest.advanceTimersByTime(1));
    expect(document.body.querySelector('[role="tooltip"]')).not.toBeNull();
    expect(document.getSelection()?.toString()).toBe('CAN-1');
    document.getSelection()?.removeAllRanges();
    await settleOpenCard();
  });

  it('cancels the first pending open on leave and unmount', () => {
    const query = disconnectedQuery();
    render({ ...BASE_CAPABILITIES, referencePreviews: true }, query);
    const reference = container.querySelector('[role="link"]');
    if (!reference) throw new Error('reference missing');
    hover(reference, 'mouseover');
    act(() => jest.advanceTimersByTime(100));
    hover(reference, 'mouseout');
    act(() => jest.advanceTimersByTime(500));
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    expect(query).not.toHaveBeenCalled();
    hover(reference, 'mouseover');
    act(() => root.render(<span>navigated</span>));
    act(() => jest.advanceTimersByTime(500));
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('cancels a pending tooltip when the account identity resets', () => {
    const query = disconnectedQuery();
    render({ ...BASE_CAPABILITIES, referencePreviews: true }, query);
    const reference = container.querySelector('[role="link"]');
    if (!reference) throw new Error('reference missing');
    hover(reference, 'mouseover');
    act(() => {
      jest.advanceTimersByTime(100);
      invalidateReferencePreviews();
    });
    expect(container.querySelector('[role="link"]')).toBe(reference);
    act(() => jest.advanceTimersByTime(500));
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('retires an open controller before an account reset can reload its card', async () => {
    const query = disconnectedQuery();
    render({ ...BASE_CAPABILITIES, referencePreviews: true }, query);
    const reference = container.querySelector('[role="link"]');
    if (!reference) throw new Error('reference missing');
    hover(reference, 'mouseover');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(250);
    });
    expect(document.body.querySelector('[role="tooltip"]')).not.toBeNull();
    const reads = query.mock.calls.length;
    await act(async () => {
      invalidateReferencePreviews();
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector('[role="link"]')).toBe(reference);
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    expect(query).toHaveBeenCalledTimes(reads);
  });

  it('keeps Escape dismissed until pointer re-entry', async () => {
    render(
      { ...BASE_CAPABILITIES, referencePreviews: true },
      disconnectedQuery(),
    );
    const reference = container.querySelector('[role="link"]');
    if (!reference) throw new Error('reference missing');
    hover(reference, 'mouseover');
    act(() => {
      jest.advanceTimersByTime(100);
      reference.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    hover(reference, 'mousemove');
    act(() => jest.advanceTimersByTime(500));
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    hover(reference, 'mouseout');
    hover(reference, 'mouseover');
    act(() => jest.advanceTimersByTime(250));
    expect(document.body.querySelector('[role="tooltip"]')).not.toBeNull();
    await settleOpenCard();
  });

  it('does not mount full tooltip controllers until a reference is touched', () => {
    const controller = jest.spyOn(tooltipHandoff, 'useTooltipHandoff');
    try {
      render(
        { ...BASE_CAPABILITIES, referencePreviews: true },
        disconnectedQuery(),
      );
      expect(controller).not.toHaveBeenCalled();
      const reference = container.querySelector('[role="link"]');
      act(() => {
        reference?.dispatchEvent(
          new MouseEvent('mouseover', {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });
      expect(controller).toHaveBeenCalledTimes(1);
    } finally {
      controller.mockRestore();
    }
  });

  it('opens a keyboard-focused card promptly and dismisses it with Escape', async () => {
    const query = jest.fn((name: string) =>
      Promise.resolve(
        name === 'referencePreview.linearScope'
          ? { scope: null }
          : { status: 'disconnected' },
      ),
    );
    render({ ...BASE_CAPABILITIES, referencePreviews: true }, query);
    const reference = container.querySelector<HTMLElement>('[role="link"]');
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
      reference?.focus();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const tooltip = document.body.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toContain('Connect Linear in Settings');
    expect(reference?.getAttribute('aria-describedby')).toBe(tooltip?.id);
    act(() => {
      reference?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    expect(document.activeElement).toBe(reference);
    expect(query).not.toHaveBeenCalledWith(
      'referencePreview.linearIssue',
      expect.anything(),
    );
  });
});

describe('LinearReferencePreview reopening', () => {
  const hover = (target: Element | null, type: string): void => {
    act(() => {
      target?.dispatchEvent(
        new MouseEvent(type, { bubbles: true, relatedTarget: document.body }),
      );
    });
  };

  async function open(target: Element | null): Promise<void> {
    hover(target, 'mouseover');
    await act(async () => {
      jest.advanceTimersByTime(250);
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('refreshes a stale card and retries an expired failure on later opens', async () => {
    jest.setSystemTime(new Date('2026-10-06T12:00:00.000Z'));
    let fail = true;
    const query = jest.fn((name: string) =>
      Promise.resolve(
        name === 'referencePreview.linearScope'
          ? { scope: 'scope-a' }
          : fail
            ? { status: 'failed' }
            : {
                status: 'ok',
                scope: 'scope-a',
                preview: {
                  identifier: 'CAN-1',
                  title: 'Fresh title',
                  url: 'https://linear.app/acme/issue/CAN-1',
                  description: null,
                  status: null,
                  assignee: null,
                  project: null,
                  updatedAt: '2026-10-06T11:00:00.000Z',
                },
              },
      ),
    );
    const issueReads = (): number =>
      query.mock.calls.filter(
        ([name]) => name === 'referencePreview.linearIssue',
      ).length;
    render({ ...BASE_CAPABILITIES, referencePreviews: true }, query);
    const reference = container.querySelector('[role="link"]');

    await open(reference);
    expect(
      document.body.querySelector('[role="tooltip"]')?.textContent,
    ).toContain('Couldn’t reach Linear');
    hover(reference, 'mouseout');
    await open(reference);
    expect(issueReads()).toBe(1);

    fail = false;
    hover(reference, 'mouseout');
    jest.setSystemTime(new Date('2026-10-06T12:01:01.000Z'));
    await open(reference);
    expect(issueReads()).toBe(2);
    expect(
      document.body.querySelector('[role="tooltip"]')?.textContent,
    ).toContain('Fresh title');

    hover(reference, 'mouseout');
    jest.setSystemTime(new Date('2026-10-06T12:06:02.000Z'));
    await open(reference);
    expect(issueReads()).toBe(3);
  });
});

describe('LinearReferencePreview inline titles', () => {
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
    observed = [];
    Object.assign(window, { IntersectionObserver: FakeIntersectionObserver });
  });
  afterEach(() => {
    Reflect.deleteProperty(window, 'IntersectionObserver');
  });

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

  const LONG_TITLE =
    'Résumé: 日本語 tickets render whole in the DOM even when they are far longer than forty characters 🚀';

  type QueryHandlers = Partial<{
    [K in QueryName]: (
      args: QueryMap[K]['args'],
    ) => Promise<QueryMap[K]['result']>;
  }>;

  type QuerySpy = jest.Mock<
    Promise<unknown>,
    [QueryName, QueryMap[QueryName]['args']]
  >;

  function makeQueryFixture(handlers: QueryHandlers): {
    query: <K extends QueryName>(
      name: K,
      args: QueryMap[K]['args'],
    ) => Promise<QueryMap[K]['result']>;
    spy: QuerySpy;
  } {
    const spy = jest.fn<
      Promise<unknown>,
      [QueryName, QueryMap[QueryName]['args']]
    >();
    const queryClient = {
      query<K extends QueryName>(
        name: K,
        args: QueryMap[K]['args'],
      ): Promise<QueryMap[K]['result']> {
        void spy(name, args);
        const handler = handlers[name];
        if (handler === undefined) {
          return Promise.reject(new Error(`Unexpected query: ${name}`));
        }
        return handler(args);
      },
    };
    return { query: queryClient.query.bind(queryClient), spy };
  }

  function issue(identifier: string, title: string): LinearIssuePreviewResult {
    return {
      status: 'ok',
      scope: 'scope-a',
      preview: {
        identifier,
        title,
        url: `https://linear.app/acme/issue/${identifier}`,
        description: null,
        status: null,
        assignee: null,
        project: null,
        updatedAt: '2026-10-06T11:00:00.000Z',
      },
    };
  }

  function supportedQuery(
    issueAnswer: (
      args: QueryMap['referencePreview.linearIssue']['args'],
    ) => Promise<LinearIssuePreviewResult> = (args) =>
      Promise.resolve(
        issue(
          args.identifier,
          args.identifier === 'CAN-1' ? LONG_TITLE : 'Second issue',
        ),
      ),
  ): ReturnType<typeof makeQueryFixture> {
    return makeQueryFixture({
      'referencePreview.linearScope': () =>
        Promise.resolve({ scope: 'scope-a' }),
      'referencePreview.linearIssue': issueAnswer,
    });
  }

  function renderLabels(query: ReturnType<typeof supportedQuery>): void {
    const client: CanopyClient = {
      capabilities: { ...BASE_CAPABILITIES, referencePreviews: true },
      query: query.query,
      command: jest.fn(),
      subscribe: () => () => undefined,
    };
    act(() =>
      root.render(
        <CanopyClientProvider client={client}>
          <p>
            <LinearReferencePreview identifier="CAN-1">
              CAN-1
            </LinearReferencePreview>{' '}
            <LinearReferencePreview
              identifier="CAN-2"
              workspaceSlug="acme"
              href="https://linear.app/acme/issue/CAN-2"
              expandTitle
            >
              https://linear.app/acme/issue/CAN-2
            </LinearReferencePreview>{' '}
            <LinearReferencePreview
              identifier="CAN-2"
              workspaceSlug="acme"
              href="https://linear.app/acme/issue/CAN-2"
              expandTitle={false}
            >
              the ticket
            </LinearReferencePreview>
          </p>
        </CanopyClientProvider>,
      ),
    );
  }

  async function settle(ms: number): Promise<void> {
    await act(async () => {
      jest.advanceTimersByTime(ms);
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
  }

  it('adds an aria-hidden icon and keeps the identifier before resolution', () => {
    const query = supportedQuery();
    renderLabels(query);
    const references = container.querySelectorAll(
      '[data-testid="linear-reference"]',
    );
    expect(references).toHaveLength(3);
    for (const reference of Array.from(references)) {
      const icon = reference.querySelector('svg');
      expect(icon?.getAttribute('aria-hidden')).toBe('true');
      expect(reference.querySelectorAll('a, button, [tabindex]')).toHaveLength(
        0,
      );
    }
    // A raw URL label shortens to its identifier, so the title lands in place.
    expect(references[1].textContent).toBe('CAN-2');
    expect(container.textContent).toBe('CAN-1 CAN-2 the ticket');
    expect(query.spy).not.toHaveBeenCalled();
  });

  it('expands visible generated labels to ID and full title, keeping custom labels', async () => {
    const query = supportedQuery();
    renderLabels(query);
    const [bare, rawUrl, custom] = Array.from(
      container.querySelectorAll('[data-testid="linear-reference"]'),
    );
    setVisible(bare, true);
    setVisible(rawUrl, true);
    setVisible(custom, true);
    await settle(149);
    expect(query.spy).not.toHaveBeenCalled();
    await settle(1);
    await settle(0);
    expect(bare.textContent).toBe(`CAN-1: ${LONG_TITLE}`);
    expect(rawUrl.textContent).toBe('CAN-2: Second issue');
    expect(rawUrl.getAttribute('href')).toBe(
      'https://linear.app/acme/issue/CAN-2',
    );
    expect(custom.textContent).toBe('the ticket');
    const title = bare.querySelector('[data-testid="linear-reference-title"]');
    expect(title?.className).toContain('truncate');
    expect(title?.className).toContain('max-w-[min(40ch,100%)]');
    // One whole text node keeps copy and the accessible name on the full title.
    expect(title?.childNodes).toHaveLength(1);
    expect(title?.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(title?.firstChild?.textContent).toBe(LONG_TITLE);
    const issueReads = query.spy.mock.calls.filter(
      ([name]) => name === 'referencePreview.linearIssue',
    );
    // The raw URL and custom label share one identity and one read.
    expect(issueReads.map(([, args]) => args)).toEqual([
      { identifier: 'CAN-1' },
      { identifier: 'CAN-2', workspaceSlug: 'acme' },
    ]);
  });

  it('never reads a reference that leaves the screen within the debounce', async () => {
    const query = supportedQuery();
    renderLabels(query);
    const [bare] = Array.from(
      container.querySelectorAll('[data-testid="linear-reference"]'),
    );
    setVisible(bare, true);
    await settle(100);
    setVisible(bare, false);
    await settle(1_000);
    expect(query.spy).not.toHaveBeenCalled();
    expect(bare.textContent).toBe('CAN-1');
  });

  it('reverts to the original text when the identity resets', async () => {
    const query = supportedQuery();
    renderLabels(query);
    const [bare] = Array.from(
      container.querySelectorAll('[data-testid="linear-reference"]'),
    );
    setVisible(bare, true);
    await settle(150);
    await settle(0);
    expect(bare.textContent).toBe(`CAN-1: ${LONG_TITLE}`);
    act(() => invalidateReferencePreviews());
    expect(bare.textContent).toBe('CAN-1');
  });

  it('declares the canonical URL once the title has resolved', async () => {
    const query = supportedQuery();
    renderLabels(query);
    const [bare, rawUrl] = Array.from(
      container.querySelectorAll('[data-testid="linear-reference"]'),
    );
    expect(bare.hasAttribute('data-link-url')).toBe(false);
    setVisible(bare, true);
    setVisible(rawUrl, true);
    await settle(150);
    await settle(0);
    expect(
      bare.querySelector('[data-testid="linear-reference-title"]'),
    ).not.toBeNull();
    expect(bare.getAttribute('data-link-url')).toBe(
      'https://linear.app/acme/issue/CAN-1',
    );
    // A URL-authored reference stays an anchor and declares nothing.
    expect(rawUrl.getAttribute('href')).toBe(
      'https://linear.app/acme/issue/CAN-2',
    );
    expect(rawUrl.hasAttribute('data-link-url')).toBe(false);
    act(() => invalidateReferencePreviews());
    expect(bare.hasAttribute('data-link-url')).toBe(false);
  });

  const placeholderIn = (reference: Element): Element | null =>
    reference.querySelector(
      '[data-testid="linear-reference-title-placeholder"]',
    );

  it('reserves the title slot with an inert placeholder until the title arrives', async () => {
    const query = supportedQuery();
    renderLabels(query);
    const [bare, rawUrl, custom] = Array.from(
      container.querySelectorAll('[data-testid="linear-reference"]'),
    );
    for (const reference of [bare, rawUrl]) {
      const placeholder = placeholderIn(reference);
      expect(placeholder?.getAttribute('aria-hidden')).toBe('true');
      expect(placeholder?.textContent).toBe('');
      expect(placeholder?.className).toContain('select-none');
      expect(placeholder?.className).toContain('w-[min(36ch,100%)]');
      // Waiting on visibility is not a read: the bar stays still.
      expect(placeholder?.hasAttribute('data-active')).toBe(false);
    }
    // Author-written labels never expand, so they reserve nothing.
    expect(placeholderIn(custom)).toBeNull();
    // Copy yields only the identifier while the title is pending.
    expect(bare.textContent).toBe('CAN-1');
    // A raw URL label shortens to its identifier, so the title lands in place.
    expect(rawUrl.textContent).toBe('CAN-2');
    expect(container.textContent).toBe('CAN-1 CAN-2 the ticket');

    setVisible(bare, true);
    setVisible(rawUrl, true);
    await settle(150);
    await settle(0);
    expect(placeholderIn(bare)).toBeNull();
    expect(placeholderIn(rawUrl)).toBeNull();
    expect(
      bare.querySelector('[data-testid="linear-reference-title"]')?.textContent,
    ).toBe(LONG_TITLE);
    expect(bare.textContent).toBe(`CAN-1: ${LONG_TITLE}`);
  });

  it('animates the placeholder only while a read is in flight', async () => {
    let answer: (() => void) | null = null;
    const query = supportedQuery(
      (args) =>
        new Promise<LinearIssuePreviewResult>((resolve) => {
          answer = (): void => resolve(issue(args.identifier, 'Slow title'));
        }),
    );
    renderLabels(query);
    const [bare] = Array.from(
      container.querySelectorAll('[data-testid="linear-reference"]'),
    );
    setVisible(bare, true);
    await settle(149);
    expect(placeholderIn(bare)?.hasAttribute('data-active')).toBe(false);
    await settle(1);
    await settle(0);
    expect(placeholderIn(bare)?.getAttribute('data-active')).toBe('true');
    expect(bare.textContent).toBe('CAN-1');
    await act(async () => {
      answer?.();
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
    expect(placeholderIn(bare)).toBeNull();
    expect(bare.textContent).toBe('CAN-1: Slow title');
  });

  it('collapses the slot when no title can load', async () => {
    const query = supportedQuery(() => Promise.resolve({ status: 'failed' }));
    renderLabels(query);
    const [bare] = Array.from(
      container.querySelectorAll('[data-testid="linear-reference"]'),
    );
    setVisible(bare, true);
    await settle(150);
    await settle(0);
    expect(query.spy).toHaveBeenCalledWith('referencePreview.linearIssue', {
      identifier: 'CAN-1',
    });
    expect(placeholderIn(bare)).toBeNull();
    expect(bare.textContent).toBe('CAN-1');
    expect(bare.hasAttribute('data-link-url')).toBe(false);
  });
});

describe('useLinearTeamCatalog in a mounted transcript', () => {
  function TeamKeys({ enabled = true }: { enabled?: boolean }): JSX.Element {
    const catalog = useLinearTeamCatalog(enabled);
    return (
      <span data-testid="team-keys">
        {catalog?.keys ? Array.from(catalog.keys).join(',') : 'none'}
      </span>
    );
  }

  it('does no metadata work while disabled and resumes on the same mounted store', async () => {
    const query = jest.fn((name: string) =>
      Promise.resolve(
        name === 'referencePreview.linearScope'
          ? { scope: 'scope-a' }
          : {
              status: 'ok',
              scope: 'scope-a',
              keys: ['CAN'],
              fetchedAt: Date.now(),
            },
      ),
    );
    const client: CanopyClient = {
      capabilities: { ...BASE_CAPABILITIES, referencePreviews: true },
      query,
      command: jest.fn(),
      subscribe: () => () => undefined,
    };
    const show = (enabled: boolean): void => {
      act(() =>
        root.render(
          <CanopyClientProvider client={client}>
            <TeamKeys enabled={enabled} />
          </CanopyClientProvider>,
        ),
      );
    };
    show(false);
    expect(query).not.toHaveBeenCalled();
    show(true);
    await act(async () => {
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
    expect(query).toHaveBeenCalledWith('referencePreview.linearTeams', {});
    expect(
      container.querySelector('[data-testid="team-keys"]')?.textContent,
    ).toBe('CAN');
  });

  it('loads the catalog again once a failure cooldown ends, without remounting', async () => {
    let teamReads = 0;
    const query = jest.fn((name: string) => {
      if (name === 'referencePreview.linearScope') {
        return Promise.resolve({ scope: 'scope-a' });
      }
      teamReads += 1;
      return Promise.resolve(
        teamReads === 1
          ? { status: 'rate-limited', scope: 'scope-a', retryAfterMs: 60_000 }
          : {
              status: 'ok',
              scope: 'scope-a',
              keys: ['CAN'],
              fetchedAt: Date.now(),
            },
      );
    });
    const client: CanopyClient = {
      capabilities: { ...BASE_CAPABILITIES, referencePreviews: true },
      query,
      command: jest.fn(),
      subscribe: () => () => undefined,
    };
    const settle = async (ms: number): Promise<void> => {
      await act(async () => {
        jest.advanceTimersByTime(ms);
        for (let index = 0; index < 10; index += 1) await Promise.resolve();
      });
    };
    act(() =>
      root.render(
        <CanopyClientProvider client={client}>
          <TeamKeys />
        </CanopyClientProvider>,
      ),
    );
    await settle(0);
    const keys = (): string | null =>
      container.querySelector('[data-testid="team-keys"]')?.textContent ?? null;
    expect(keys()).toBe('none');
    await settle(60_000);
    expect(teamReads).toBe(2);
    expect(keys()).toBe('CAN');
  });

  it('keeps the team keys published while an expired catalog refreshes', async () => {
    let teamReads = 0;
    type FailedRefresh = { status: 'failed'; scope: string };
    let answerRefresh: ((value: FailedRefresh) => void) | null = null;
    const query = jest.fn((name: string) => {
      if (name === 'referencePreview.linearScope') {
        return Promise.resolve({ scope: 'scope-a' });
      }
      teamReads += 1;
      if (teamReads === 1) {
        return Promise.resolve({
          status: 'ok',
          scope: 'scope-a',
          keys: ['CAN'],
          fetchedAt: Date.now(),
        });
      }
      return new Promise<FailedRefresh>((resolve) => {
        answerRefresh = resolve;
      });
    });
    const client: CanopyClient = {
      capabilities: { ...BASE_CAPABILITIES, referencePreviews: true },
      query,
      command: jest.fn(),
      subscribe: () => () => undefined,
    };
    const settle = async (ms: number): Promise<void> => {
      await act(async () => {
        jest.advanceTimersByTime(ms);
        for (let index = 0; index < 10; index += 1) await Promise.resolve();
      });
    };
    act(() =>
      root.render(
        <CanopyClientProvider client={client}>
          <TeamKeys />
        </CanopyClientProvider>,
      ),
    );
    await settle(0);
    const keys = (): string | null =>
      container.querySelector('[data-testid="team-keys"]')?.textContent ?? null;
    expect(keys()).toBe('CAN');
    // Past the 5-minute freshness window the catalog refreshes, and bare
    // references stay decorated until Linear answers.
    await settle(5 * 60_000 + 1);
    expect(teamReads).toBe(2);
    expect(keys()).toBe('CAN');
    await act(async () => {
      answerRefresh?.({ status: 'failed', scope: 'scope-a' });
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
    expect(keys()).toBe('CAN');
  });
});
