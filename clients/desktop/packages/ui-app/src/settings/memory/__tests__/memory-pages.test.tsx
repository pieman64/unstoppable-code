/**
 * @jest-environment jsdom
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ExplorerEntityGraph,
  ExplorerFact,
  ExplorerFactDetail,
  ExplorerSourceTranscript,
} from '@canopy/protocol/settings/organization-memory';
import type { SettingsRoute } from '@canopy/protocol/settings';
import {
  TestSettingsHost,
  createFakeSettingsClient,
  createTestSettingsHost,
  type FakeSettingsHandler,
  type TestSettingsHostOptions,
} from '../../__tests__/helpers/test-settings-host';
import { MemorySettingsSlotsProvider } from '../memory-settings-slots';
import { OrganizationMemoryFactPage } from '../OrganizationMemoryFactPage';
import { OrganizationMemoryFactsPage } from '../OrganizationMemoryFactsPage';
import { OrganizationMemoryGraphPage } from '../OrganizationMemoryGraphPage';
import { OrganizationMemoryOpsPage } from '../OrganizationMemoryOpsPage';
import {
  SettingsOperationError,
  type SettingsOperationName,
} from '@canopy/protocol/settings';

// The force graph draws on a canvas jsdom does not have; the pages only need
// to prove it mounts lazily with the loaded graph.
jest.mock('../EntityForceGraph', () => ({
  EntityForceGraph: ({
    graph,
  }: {
    graph: ExplorerEntityGraph;
  }): JSX.Element => (
    <div data-testid="force-graph">{graph.nodes.length} nodes</div>
  ),
}));

const ORG_ID = 'org-1';
/** Server text that must reach logs only, never the page. */
const SENTINEL = 'SENTINEL server body: stack at db.query';
const LOAD_COPY = "Couldn't load this. Try again.";

function serverFailure(status = 500): SettingsOperationError {
  return new SettingsOperationError({
    code: 'failed',
    status,
    message: SENTINEL,
  });
}

function buttonNamed(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`No ${label} button`);
  return button;
}
const BLOCK = 'ph-no-capture';

function memoryRoute(
  extra: Partial<Extract<SettingsRoute, { scope: 'organization' }>> = {},
): SettingsRoute {
  return {
    scope: 'organization',
    organizationId: ORG_ID,
    page: 'memory',
    ...extra,
  };
}

const FACT: ExplorerFact = {
  id: 'fact-1',
  factText: 'Deploys go out on Tuesdays',
  evidenceType: 'OBSERVED',
  evidenceQuote: 'we deploy on Tuesdays',
  validAt: null,
  invalidAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  expiredAt: null,
  invalidatedById: null,
  liveness: 'live',
  entities: [
    { id: 'entity-1', canonicalName: 'deploy-bot', entityType: 'TOOL' },
  ],
};

const DETAIL: ExplorerFactDetail = {
  ...FACT,
  sources: [
    {
      id: 'source-1',
      transcriptTurnId: 'turn-1',
      referenceTime: '2026-08-01T00:00:00.000Z',
      actor: { id: 'user-1', name: 'Ada Lovelace', email: 'ada@example.test' },
    },
    {
      id: 'source-2',
      transcriptTurnId: 'turn-2',
      referenceTime: '2026-08-02T00:00:00.000Z',
      actor: null,
    },
  ],
  supersessionChain: [],
};

function transcript(
  sourceIndex: number,
  content: string,
): ExplorerSourceTranscript {
  const source = DETAIL.sources[sourceIndex];
  if (source === undefined) throw new Error('unknown source');
  return {
    restricted: false,
    evidenceQuote: 'we deploy on Tuesdays',
    source,
    messages: [
      {
        scope: 'worktree',
        localChatId: 'chat-1',
        localMessageId: `message-${sourceIndex}`,
        role: 'user',
        status: 'complete',
        content,
        occurredAt: '2026-08-01T00:00:00.000Z',
      },
    ],
  };
}

const GRAPH: ExplorerEntityGraph = {
  nodes: [
    {
      id: 'entity-1',
      canonicalName: 'deploy-bot',
      entityType: 'TOOL',
      factCount: 1,
      factIds: ['fact-1'],
    },
  ],
  edges: [],
  truncated: false,
};

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  // jsdom has no scrollIntoView; the transcript view scrolls to its evidence.
  Element.prototype.scrollIntoView = (): void => undefined;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function setup(
  handlers: Partial<Record<SettingsOperationName, FakeSettingsHandler>> = {},
  options: Omit<TestSettingsHostOptions, 'client'> = {},
): ReturnType<typeof createTestSettingsHost> & {
  client: ReturnType<typeof createFakeSettingsClient>;
} {
  const client = createFakeSettingsClient(handlers);
  return { ...createTestSettingsHost({ ...options, client }), client };
}

async function render(
  host: ReturnType<typeof createTestSettingsHost>['host'],
  page: ReactNode,
): Promise<void> {
  await act(async () => {
    root.render(<TestSettingsHost host={host}>{page}</TestSettingsHost>);
    await Promise.resolve();
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function blocked(text: string): boolean {
  return Array.from(container.querySelectorAll(`.${BLOCK}`)).some((element) =>
    element.textContent?.includes(text),
  );
}

describe('OrganizationMemoryFactsPage', () => {
  it('renders the first page of facts from page data without a read', async () => {
    const { host, client } = setup();
    await render(
      host,
      <OrganizationMemoryFactsPage
        route={memoryRoute()}
        page={{
          kind: 'organization.memory.facts',
          data: {
            enabled: true,
            initialFacts: [FACT],
            initialNextCursor: 'cursor-2',
          },
        }}
      />,
    );

    expect(
      container.querySelector('[data-testid="memory-fact-fact-1"]')
        ?.textContent,
    ).toContain('Deploys go out on Tuesdays');
    expect(container.textContent).toContain('Load more');
    expect(
      container
        .querySelector('[data-testid="memory-views-tab-facts"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(client.calls).toEqual([]);
  });

  it('pages through organization.memory.facts with the current filters', async () => {
    const { host, client } = setup({
      'organization.memory.facts': () => ({
        facts: [{ ...FACT, id: 'fact-2', factText: 'Second fact' }],
        nextCursor: null,
      }),
    });
    await render(
      host,
      <OrganizationMemoryFactsPage
        route={memoryRoute()}
        page={{
          kind: 'organization.memory.facts',
          data: {
            enabled: true,
            initialFacts: [FACT],
            initialNextCursor: 'cursor-2',
          },
        }}
      />,
    );

    const loadMore = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Load more',
    );
    await act(async () => {
      loadMore?.click();
      await Promise.resolve();
    });
    await flush();

    expect(client.calls).toEqual([
      {
        operation: 'organization.memory.facts',
        input: {
          organizationId: ORG_ID,
          cursor: 'cursor-2',
          liveness: 'live',
          evidenceType: undefined,
          from: undefined,
          to: undefined,
        },
      },
    ]);
    expect(container.textContent).toContain('Second fact');
    expect(container.textContent).not.toContain('Load more');
  });

  it('shows load copy, never the server text, and Retry reads the page again', async () => {
    let attempts = 0;
    const { host, client } = setup({
      'organization.memory.facts': () => {
        attempts += 1;
        if (attempts === 1) throw serverFailure();
        return {
          facts: [{ ...FACT, id: 'fact-2', factText: 'Second fact' }],
          nextCursor: null,
        };
      },
    });
    await render(
      host,
      <OrganizationMemoryFactsPage
        route={memoryRoute()}
        page={{
          kind: 'organization.memory.facts',
          data: {
            enabled: true,
            initialFacts: [FACT],
            initialNextCursor: 'cursor-2',
          },
        }}
      />,
    );

    await act(async () => {
      buttonNamed('Load more').click();
      await Promise.resolve();
    });
    await flush();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(LOAD_COPY);
    expect(container.textContent).not.toContain('SENTINEL');
    expect(container.textContent).not.toContain('500');

    await act(async () => {
      buttonNamed('Retry').click();
      await Promise.resolve();
    });
    await flush();

    expect(client.calls).toHaveLength(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('Second fact');
  });

  it('keeps the rate-limit copy for a 429', async () => {
    const { host } = setup({
      'organization.memory.facts': () => {
        throw serverFailure(429);
      },
    });
    await render(
      host,
      <OrganizationMemoryFactsPage
        route={memoryRoute()}
        page={{
          kind: 'organization.memory.facts',
          data: {
            enabled: true,
            initialFacts: [FACT],
            initialNextCursor: 'cursor-2',
          },
        }}
      />,
    );
    await act(async () => {
      buttonNamed('Load more').click();
      await Promise.resolve();
    });
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Rate limit reached — try again in a moment.',
    );
    expect(container.textContent).not.toContain('SENTINEL');
  });

  it('renders the not-enabled state when the rollout is off', async () => {
    const { host, client } = setup();
    await render(
      host,
      <OrganizationMemoryFactsPage
        route={memoryRoute()}
        page={{ kind: 'organization.memory.facts', data: { enabled: false } }}
      />,
    );

    expect(
      container.querySelector('[data-testid="memory-not-enabled"]')
        ?.textContent,
    ).toBe(
      'Memory not enabledOrganization memory is not enabled for this organization.',
    );
    expect(
      container.querySelector('[data-testid="memory-views-tabs"]'),
    ).toBeNull();
    expect(client.calls).toEqual([]);
  });

  it('blocks fact text and entity names from session replay', async () => {
    const { host } = setup(
      {},
      { privacy: { blockClassName: BLOCK, maskClassName: 'mask' } },
    );
    await render(
      host,
      <OrganizationMemoryFactsPage
        route={memoryRoute()}
        page={{
          kind: 'organization.memory.facts',
          data: {
            enabled: true,
            initialFacts: [FACT],
            initialNextCursor: null,
          },
        }}
      />,
    );

    expect(blocked('Deploys go out on Tuesdays')).toBe(true);
    expect(blocked('we deploy on Tuesdays')).toBe(true);
    expect(blocked('deploy-bot')).toBe(true);
  });

  it('keeps web markup free of empty privacy class tokens', async () => {
    const { host } = setup();
    await render(
      host,
      <OrganizationMemoryFactsPage
        route={memoryRoute()}
        page={{
          kind: 'organization.memory.facts',
          data: {
            enabled: true,
            initialFacts: [FACT],
            initialNextCursor: null,
          },
        }}
      />,
    );

    const text = container.querySelector(
      '[data-testid="memory-fact-fact-1"] p',
    );
    expect(text?.getAttribute('class')).toBe(
      'mt-3 line-clamp-4 text-s leading-6 fg-primary',
    );
  });
});

describe('OrganizationMemoryGraphPage', () => {
  it('reads the graph for the URL filters and mounts the force graph lazily', async () => {
    const graphRead = jest.fn(() => GRAPH);
    const { host, client } = setup(
      { 'organization.memory.graph': graphRead },
      {
        pathname: '/organization/org-1/memory/graph',
        search: 'liveness=all&q=deploy',
      },
    );
    await render(
      host,
      <OrganizationMemoryGraphPage
        route={memoryRoute({ memoryView: 'graph' })}
        page={{ kind: 'organization.memory.graph', data: { enabled: true } }}
      />,
    );
    await flush();
    await flush();

    expect(client.calls[0]).toEqual({
      operation: 'organization.memory.graph',
      input: {
        organizationId: ORG_ID,
        liveness: 'all',
        from: undefined,
        to: undefined,
        q: 'deploy',
      },
    });
    expect(
      container.querySelector('[data-testid="force-graph"]')?.textContent,
    ).toBe('1 nodes');
  });

  it('writes filter changes to the URL with the settings router', async () => {
    const replace = jest.fn();
    const { host } = setup(
      { 'organization.memory.graph': () => GRAPH },
      {
        pathname: '/organization/org-1/memory/graph',
        search: 'q=deploy&tab=keep',
        router: { replace },
      },
    );
    await render(
      host,
      <OrganizationMemoryGraphPage
        route={memoryRoute({ memoryView: 'graph' })}
        page={{ kind: 'organization.memory.graph', data: { enabled: true } }}
      />,
    );
    await flush();

    const select = container.querySelector(
      'select[aria-label="Fact liveness"]',
    );
    if (!(select instanceof HTMLSelectElement)) throw new Error('no select');
    await act(async () => {
      select.value = 'superseded';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(replace).toHaveBeenCalledWith(
      '/organization/org-1/memory/graph?tab=keep&liveness=superseded&q=deploy',
      { scroll: false },
    );
  });

  it('shows load copy for a failed graph read and Retry reads it again', async () => {
    let attempts = 0;
    const { host, client } = setup(
      {
        'organization.memory.graph': () => {
          attempts += 1;
          if (attempts === 1) throw serverFailure();
          return GRAPH;
        },
      },
      {
        pathname: '/organization/org-1/memory/graph',
        search: 'q=retry-case',
      },
    );
    await render(
      host,
      <OrganizationMemoryGraphPage
        route={memoryRoute({ memoryView: 'graph' })}
        page={{ kind: 'organization.memory.graph', data: { enabled: true } }}
      />,
    );
    await flush();
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      LOAD_COPY,
    );
    expect(container.textContent).not.toContain('SENTINEL');

    await act(async () => {
      buttonNamed('Retry').click();
      await Promise.resolve();
    });
    await flush();
    await flush();

    expect(client.calls).toHaveLength(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="force-graph"]')?.textContent,
    ).toBe('1 nodes');
  });

  it('renders the not-enabled state without reading the graph', async () => {
    const { host, client } = setup();
    await render(
      host,
      <OrganizationMemoryGraphPage
        route={memoryRoute({ memoryView: 'graph' })}
        page={{ kind: 'organization.memory.graph', data: { enabled: false } }}
      />,
    );

    expect(container.textContent).toContain('Memory not enabled');
    expect(client.calls).toEqual([]);
  });
});

describe('OrganizationMemoryOpsPage', () => {
  it('renders jobs, the search log, and configuration from page data', async () => {
    const { host } = setup(
      {},
      { privacy: { blockClassName: BLOCK, maskClassName: 'mask' } },
    );
    await render(
      host,
      <OrganizationMemoryOpsPage
        route={memoryRoute({ memoryView: 'ops' })}
        page={{
          kind: 'organization.memory.ops',
          data: {
            enabled: true,
            jobs: [
              {
                id: 'job-1',
                status: 'FAILED',
                attempts: 3,
                notBefore: '2026-08-01T00:00:00.000Z',
                lockedBy: null,
                lockedAt: null,
                lastHeartbeatAt: null,
                heartbeatStale: false,
                lastError: 'embedder timeout',
                createdAt: '2026-08-01T00:00:00.000Z',
                updatedAt: '2026-08-01T00:00:00.000Z',
              },
            ],
            counts: { PENDING: 0, RUNNING: 0, DONE: 4, FAILED: 1, DEAD: 0 },
            searchEntries: [
              {
                id: 'search-1',
                query: 'when do we deploy',
                queryDecryptFailed: false,
                topScores: null,
                injectedFacts: [{ id: 'fact-1', factText: FACT.factText }],
                gatePassed: true,
                truncated: false,
                latencyMs: 42,
                createdAt: '2026-08-01T00:00:00.000Z',
                user: {
                  id: 'user-1',
                  name: 'Ada Lovelace',
                  email: 'ada@example.test',
                },
              },
            ],
            config: {
              embedderId: 'embedder-v1',
              rerankerId: 'reranker-v1',
              tauRerank: 0.5,
              tauCosine: null,
              efSearch: 64,
              triageModel: 'triage',
              distillModel: 'distill',
              judgeModel: 'judge',
            },
          },
        }}
      />,
    );

    expect(container.textContent).toContain('embedder timeout');
    expect(container.textContent).toContain('FAILED (1)');
    expect(container.textContent).toContain('Ada Lovelace · 1 facts injected');
    expect(container.textContent).toContain('embedder-v1');
    expect(blocked('when do we deploy')).toBe(true);
    expect(blocked('Ada Lovelace')).toBe(true);
    expect(blocked(FACT.factText)).toBe(true);
  });

  it('refetches jobs for a status through organization.memory.jobs', async () => {
    const { host, client } = setup({
      'organization.memory.jobs': () => ({
        jobs: [],
        counts: { PENDING: 0, RUNNING: 0, DONE: 0, FAILED: 0, DEAD: 0 },
        nextCursor: null,
      }),
    });
    await render(
      host,
      <OrganizationMemoryOpsPage
        route={memoryRoute({ memoryView: 'ops' })}
        page={{
          kind: 'organization.memory.ops',
          data: {
            enabled: true,
            jobs: [],
            counts: { PENDING: 0, RUNNING: 0, DONE: 0, FAILED: 0, DEAD: 0 },
            searchEntries: [],
            config: {
              embedderId: 'e',
              rerankerId: 'r',
              tauRerank: null,
              tauCosine: null,
              efSearch: 1,
              triageModel: 't',
              distillModel: 'd',
              judgeModel: 'j',
            },
          },
        }}
      />,
    );
    const select = container.querySelector(
      'select[aria-label="Filter ingest jobs"]',
    );
    if (!(select instanceof HTMLSelectElement)) throw new Error('no select');
    await act(async () => {
      select.value = 'DEAD';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    await flush();

    expect(client.calls).toEqual([
      {
        operation: 'organization.memory.jobs',
        input: { organizationId: ORG_ID, status: 'DEAD' },
      },
    ]);
  });

  it('renders the not-enabled state', async () => {
    const { host } = setup();
    await render(
      host,
      <OrganizationMemoryOpsPage
        route={memoryRoute({ memoryView: 'ops' })}
        page={{ kind: 'organization.memory.ops', data: { enabled: false } }}
      />,
    );
    expect(container.textContent).toContain('Memory not enabled');
  });
});

describe('OrganizationMemoryFactPage', () => {
  function factPage(
    pageTranscript: ExplorerSourceTranscript | null,
  ): JSX.Element {
    return (
      <OrganizationMemoryFactPage
        route={memoryRoute({ factId: 'fact-1' })}
        page={{
          kind: 'organization.memory.fact',
          data: { enabled: true, detail: DETAIL, transcript: pageTranscript },
        }}
      />
    );
  }

  it('renders the detail and the page transcript as Markdown without a slot', async () => {
    const { host, client } = setup(
      {},
      { privacy: { blockClassName: BLOCK, maskClassName: 'mask' } },
    );
    await render(host, factPage(transcript(0, 'We **deploy** on Tuesdays')));

    expect(container.textContent).toContain('Provenance');
    expect(
      Array.from(container.querySelectorAll('a'))
        .find((link) => link.textContent === 'View source')
        ?.getAttribute('href'),
    ).toBe('/organization/org-1/memory/fact/fact-1?source=source-1');
    expect(container.querySelector('strong')?.textContent).toBe('deploy');
    expect(blocked('We deploy on Tuesdays')).toBe(true);
    expect(blocked('Ada Lovelace')).toBe(true);
    expect(blocked(FACT.factText)).toBe(true);
    expect(client.calls).toEqual([]);
  });

  it('renders transcript messages through the host slot when supplied', async () => {
    const { host } = setup();
    await act(async () => {
      root.render(
        <TestSettingsHost host={host}>
          <MemorySettingsSlotsProvider
            slots={{
              TranscriptMessage: ({ message }) => (
                <p data-testid="slot-message">{message.content}</p>
              ),
            }}
          >
            {factPage(transcript(0, 'Slot rendered'))}
          </MemorySettingsSlotsProvider>
        </TestSettingsHost>,
      );
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="slot-message"]')?.textContent,
    ).toBe('Slot rendered');
  });

  it('uses the page transcript when it already matches ?source=', async () => {
    const { host, client } = setup({}, { search: 'source=source-1' });
    await render(host, factPage(transcript(0, 'First source')));

    expect(container.textContent).toContain('First source');
    expect(client.calls).toEqual([]);
  });

  it('reads another selected source through organization.memory.factSource', async () => {
    const { host, client } = setup(
      {
        'organization.memory.factSource': () => transcript(1, 'Second source'),
      },
      { search: 'source=source-2' },
    );
    await render(host, factPage(transcript(0, 'First source')));
    await flush();

    expect(client.calls).toEqual([
      {
        operation: 'organization.memory.factSource',
        input: {
          organizationId: ORG_ID,
          factId: 'fact-1',
          sourceId: 'source-2',
        },
      },
    ]);
    expect(container.textContent).toContain('Second source');
    expect(container.textContent).not.toContain('First source');
  });

  it('shows load copy for a failed source read and Retry reads it again', async () => {
    let attempts = 0;
    const { host, client } = setup(
      {
        'organization.memory.factSource': () => {
          attempts += 1;
          if (attempts === 1) throw serverFailure(404);
          return transcript(1, 'Second source');
        },
      },
      { search: 'source=source-2' },
    );
    await render(host, factPage(transcript(0, 'First source')));
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      LOAD_COPY,
    );
    expect(container.textContent).not.toContain('SENTINEL');
    expect(container.textContent).not.toContain('404');

    await act(async () => {
      buttonNamed('Retry').click();
      await Promise.resolve();
    });
    await flush();

    expect(client.calls).toHaveLength(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('Second source');
  });

  it('asks the host to re-check access when a source read is forbidden', async () => {
    const refresh = jest.fn();
    const { host } = setup(
      {
        'organization.memory.factSource': () => {
          throw serverFailure(403);
        },
      },
      { search: 'source=source-2', router: { refresh } },
    );
    await render(host, factPage(transcript(0, 'First source')));
    await flush();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('SENTINEL');
  });

  it('says when no transcript source is attached', async () => {
    const { host } = setup();
    await render(host, factPage(null));
    expect(container.textContent).toContain(
      'No transcript source is attached to this fact.',
    );
  });

  it('renders the not-enabled state', async () => {
    const { host } = setup();
    await render(
      host,
      <OrganizationMemoryFactPage
        route={memoryRoute({ factId: 'fact-1' })}
        page={{ kind: 'organization.memory.fact', data: { enabled: false } }}
      />,
    );
    expect(container.textContent).toContain('Memory not enabled');
  });
});

describe('memory loading placeholders', () => {
  /** A read that never settles, so the view stays in its loading state. */
  const pending = (): Promise<never> => new Promise<never>(() => undefined);

  function testId(id: string): Element | null {
    return container.querySelector(`[data-testid="${id}"]`);
  }

  it('holds the graph area with the graph skeleton, never loading copy', async () => {
    const { host } = setup({ 'organization.memory.graph': pending });
    await render(
      host,
      <OrganizationMemoryGraphPage
        route={memoryRoute({ memoryView: 'graph' })}
        page={{ kind: 'organization.memory.graph', data: { enabled: true } }}
      />,
    );

    expect(testId('settings-skeleton-chart-graph')?.getAttribute('role')).toBe(
      'status',
    );
    expect(container.textContent).not.toContain('Loading graph');
    expect(container.textContent).not.toContain('Loading entity graph');
  });

  it('holds the jobs table with the table skeleton while a status loads', async () => {
    const { host } = setup({ 'organization.memory.jobs': pending });
    await render(
      host,
      <OrganizationMemoryOpsPage
        route={memoryRoute({ memoryView: 'ops' })}
        page={{
          kind: 'organization.memory.ops',
          data: {
            enabled: true,
            jobs: [],
            counts: { PENDING: 0, RUNNING: 0, DONE: 0, FAILED: 0, DEAD: 0 },
            searchEntries: [],
            config: {
              embedderId: 'e',
              rerankerId: 'r',
              tauRerank: null,
              tauCosine: null,
              efSearch: 1,
              triageModel: 't',
              distillModel: 'd',
              judgeModel: 'j',
            },
          },
        }}
      />,
    );
    expect(testId('settings-skeleton-table')).toBeNull();

    const select = container.querySelector(
      'select[aria-label="Filter ingest jobs"]',
    );
    if (!(select instanceof HTMLSelectElement)) throw new Error('no select');
    await act(async () => {
      select.value = 'DEAD';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(testId('settings-skeleton-table')?.getAttribute('role')).toBe(
      'status',
    );
    expect(container.textContent).not.toContain('Loading jobs');
  });

  it('keeps the facts on screen while more load, with no skeleton', async () => {
    const { host } = setup({ 'organization.memory.facts': pending });
    await render(
      host,
      <OrganizationMemoryFactsPage
        route={memoryRoute()}
        page={{
          kind: 'organization.memory.facts',
          data: {
            enabled: true,
            initialFacts: [FACT],
            initialNextCursor: 'cursor-2',
          },
        }}
      />,
    );
    const loadMore = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Load more',
    );
    await act(async () => {
      loadMore?.click();
      await Promise.resolve();
    });

    expect(testId('memory-fact-fact-1')).not.toBeNull();
    expect(testId('settings-skeleton-list')).toBeNull();
  });

  it('centers a spinner while another source transcript loads', async () => {
    const { host } = setup(
      { 'organization.memory.factSource': pending },
      { search: 'source=source-2' },
    );
    await render(
      host,
      <OrganizationMemoryFactPage
        route={memoryRoute({ factId: 'fact-1' })}
        page={{
          kind: 'organization.memory.fact',
          data: {
            enabled: true,
            detail: DETAIL,
            transcript: transcript(0, 'First source'),
          },
        }}
      />,
    );

    expect(testId('centered-loading-spinner')?.getAttribute('role')).toBe(
      'status',
    );
    expect(container.textContent).not.toContain('Loading source transcript');
  });
});
