/**
 * @jest-environment jsdom
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

import { act, type JSX, type ReactNode } from 'react';

jest.mock('@/lib/chat-enrichment-modes', () => ({
  useChatEnrichmentModes: (): { linear: 'replace'; github: 'hover' } => ({
    linear: 'replace',
    github: 'hover',
  }),
}));

jest.mock('@/lib/terminal-instances', () => ({
  getOrCreateInstance: jest.fn(),
  peekInstance: jest.fn(() => undefined),
  TERMINAL_BG_COLOR: '#0b0c10',
}));
jest.mock('@xterm/xterm', () => ({ Terminal: jest.fn() }));
jest.mock('@xterm/addon-fit', () => ({ FitAddon: jest.fn() }));
// Render agent sub-blocks inline so nested decoration is observable.
jest.mock('../AgentBlock', () => ({
  __esModule: true,
  AgentBlock: ({
    subBlocks,
    renderSubBlock,
  }: {
    subBlocks: DisplayBlock[];
    renderSubBlock: (block: DisplayBlock, index: number) => ReactNode;
  }): JSX.Element => (
    <>{subBlocks.map((block, index) => renderSubBlock(block, index))}</>
  ),
}));

// Count whole-text scans so rerenders can be checked for rescanning.
jest.mock('@canopy/desktop-shared/lib/create-from-reference', () => {
  const actual: typeof CreateFromReference = jest.requireActual(
    '@canopy/desktop-shared/lib/create-from-reference',
  );
  return {
    ...actual,
    scanReferenceOccurrences: jest.fn(actual.scanReferenceOccurrences),
  };
});

import { createRoot, type Root } from 'react-dom/client';
import type * as CreateFromReference from '@canopy/desktop-shared/lib/create-from-reference';
import { scanReferenceOccurrences } from '@canopy/desktop-shared/lib/create-from-reference';
import type { CanopyClient } from '@canopy/app-core';
import {
  CanopyClientProvider,
  invalidateReferencePreviews,
  LINEAR_PREVIEW_CACHE_LIMITS,
} from '@canopy/app-state';
import { ChatBlockRenderer } from '../ChatBlockRenderer';
import type { DisplayBlock } from '../types';
import { resetExperimentalFeaturesStoreForTest } from '@/stores/experimentalFeaturesStore';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const query = jest.fn<Promise<unknown>, [string, unknown?]>();
const client: CanopyClient = {
  capabilities: {
    localExecution: true,
    terminalPty: true,
    fileSystemAccess: 'read-write',
    voice: false,
    settingsScope: 'full',
    pipelines: 'execute',
    routing: 'in-memory',
    referencePreviews: true,
  },
  query,
  command: jest.fn(),
  subscribe: () => () => undefined,
};

let container: HTMLDivElement;
let root: Root;
let teams: unknown;

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  });
}

async function render(
  text: string,
  props: { streaming?: boolean; settled?: boolean } = {},
): Promise<void> {
  act(() =>
    root.render(
      <CanopyClientProvider client={client}>
        <ChatBlockRenderer block={{ type: 'text', text }} {...props} />
      </CanopyClientProvider>,
    ),
  );
  await flush();
}

const references = (): string[] =>
  Array.from(
    container.querySelectorAll('[data-testid="linear-reference"]'),
    (node) => node.textContent ?? '',
  );

const calls = (name: string): unknown[][] =>
  query.mock.calls.filter(([called]) => called === name);

beforeEach(() => {
  // Each test starts as a fresh install: no saved titles or team catalog.
  localStorage.clear();
  resetExperimentalFeaturesStoreForTest();
  teams = {
    status: 'ok',
    scope: 'scope-a',
    keys: ['CAN', 'ECW'],
    fetchedAt: Date.now(),
  };
  query.mockReset();
  query.mockImplementation((name: string) =>
    Promise.resolve(
      name === 'referencePreview.linearScope'
        ? { scope: 'scope-a' }
        : name === 'referencePreview.linearTeams'
          ? teams
          : {
              status: 'ok',
              scope: 'scope-a',
              preview: {
                identifier: 'CAN-12',
                title: 'Preview tickets',
                url: 'https://linear.app/acme/issue/CAN-12/preview-tickets',
                description: 'Short excerpt',
                status: 'In Progress',
                assignee: null,
                project: 'Canopy',
                updatedAt: '2026-10-01T00:00:00.000Z',
              },
            },
    ),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  jest.useRealTimers();
});

describe('ChatBlockRenderer Linear reference previews', () => {
  it('decorates only accessible team keys on the plain-paragraph path', async () => {
    const text =
      'Fixes CAN-12, then CAN-12 again and ECW-9; FOO-1, utf-8 and GPT-4 stay prose.';
    await render(text);
    expect(references()).toEqual(['CAN-12', 'CAN-12', 'ECW-9']);
    expect(container.textContent).toBe(text);
    expect(calls('referencePreview.linearTeams')).toHaveLength(1);
    expect(calls('referencePreview.linearIssue')).toEqual([]);
  });

  it('never loads preview state for prose without Linear candidates', async () => {
    await render('Ordinary prose with **emphasis** and utf-8.');
    expect(query).not.toHaveBeenCalled();
  });

  it('keeps bare IDs plain until a complete catalog arrives', async () => {
    teams = { status: 'failed', scope: 'scope-a' };
    await render('Fixes CAN-12.');
    expect(references()).toEqual([]);
    expect(container.textContent).toBe('Fixes CAN-12.');
  });

  it('keeps bare IDs decorated through catalog refreshes until one drops a key', async () => {
    jest.useFakeTimers();
    const advance = async (ms: number): Promise<void> => {
      act(() => {
        jest.advanceTimersByTime(ms);
      });
      await flush();
    };
    let answer: (result: unknown) => void = () => undefined;
    const pendingTeams = (): Promise<unknown> =>
      new Promise((resolve) => {
        answer = resolve;
      });
    await render('CAN-1 and REG-2');
    expect(references()).toEqual(['CAN-1']);

    teams = { status: 'failed', scope: 'scope-a' };
    await advance(LINEAR_PREVIEW_CACHE_LIMITS.freshMs);
    expect(calls('referencePreview.linearTeams')).toHaveLength(2);
    expect(references()).toEqual(['CAN-1']);

    teams = pendingTeams();
    await advance(LINEAR_PREVIEW_CACHE_LIMITS.negativeMs);
    expect(calls('referencePreview.linearTeams')).toHaveLength(3);
    expect(references()).toEqual(['CAN-1']);
    act(() => {
      answer({
        status: 'ok',
        scope: 'scope-a',
        keys: ['REG'],
        fetchedAt: Date.now(),
      });
    });
    await flush();
    expect(references()).toEqual(['REG-2']);
    expect(container.querySelectorAll('svg')).toHaveLength(1);

    // A credential change still un-decorates until the new catalog arrives.
    teams = pendingTeams();
    act(() => invalidateReferencePreviews());
    await flush();
    expect(references()).toEqual([]);
    act(() => {
      answer({
        status: 'ok',
        scope: 'scope-a',
        keys: ['CAN'],
        fetchedAt: Date.now(),
      });
    });
    await flush();
    expect(references()).toEqual(['CAN-1']);
  });

  it('decorates Markdown prose but not code, and wraps a Linear anchor once', async () => {
    await render(
      [
        '**See CAN-1** first.',
        '',
        '- item CAN-2',
        '',
        '| Ticket |',
        '| --- |',
        '| CAN-3 |',
        '',
        'Inline `CAN-4` and [the ticket](https://linear.app/acme/issue/CAN-6/x).',
        '',
        '```',
        'CAN-5',
        '```',
      ].join('\n'),
    );
    expect(references()).toEqual(['CAN-1', 'CAN-2', 'CAN-3', 'the ticket']);
    expect(container.querySelector('code')?.textContent).toBe('CAN-4');
    expect(container.querySelector('pre')?.textContent).toContain('CAN-5');
    const anchors = container.querySelectorAll('a');
    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute('href')).toBe(
      'https://linear.app/acme/issue/CAN-6/x',
    );
    expect(anchors[0].querySelector('a, [role="link"]')).toBeNull();
    expect(anchors[0].querySelector('svg')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  it('keeps explicit Linear URLs previewable when the catalog is unavailable', async () => {
    teams = { status: 'rate-limited', scope: 'scope-a', retryAfterMs: null };
    await render(
      'CAN-12 and [the ticket](https://linear.app/acme/issue/CAN-6/x).',
    );
    expect(references()).toEqual(['the ticket']);
  });

  it('leaves Linear URLs ordinary while Linear is disconnected', async () => {
    teams = { status: 'disconnected' };
    await render('See [the ticket](https://linear.app/acme/issue/CAN-6/x).');
    expect(references()).toEqual([]);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      'https://linear.app/acme/issue/CAN-6/x',
    );
  });

  it('never nests a reference trigger inside link label emphasis', async () => {
    await render(
      [
        'See [**CAN-12** fix](https://github.com/o/r/pull/7) and',
        '[*CAN-6* ticket](https://linear.app/acme/issue/CAN-6).',
      ].join('\n'),
    );
    expect(references()).toEqual(['CAN-6 ticket']);
    const anchors = container.querySelectorAll('a');
    expect(anchors).toHaveLength(2);
    for (const anchor of Array.from(anchors)) {
      expect(anchor.querySelector('a, [role="link"]')).toBeNull();
    }
  });

  it('decorates settled nested agent prose during a streaming turn', async () => {
    const agent: DisplayBlock = {
      type: 'agent',
      toolUseId: 'tool-1',
      subagentType: 'general-purpose',
      description: 'Investigate',
      prompt: 'Look',
      runInBackground: false,
      subBlocks: [{ type: 'text', text: 'Nested CAN-12 finding' }],
    };
    act(() =>
      root.render(
        <CanopyClientProvider client={client}>
          <ChatBlockRenderer block={agent} streaming settled />
        </CanopyClientProvider>,
      ),
    );
    await flush();
    expect(references()).toEqual(['CAN-12']);
  });

  it('only decorates references the host request validator accepts', async () => {
    teams = {
      status: 'ok',
      scope: 'scope-a',
      keys: ['CAN', 'ABCDEFGHIJKLMNOPQ'.slice(0, 16)],
      fetchedAt: Date.now(),
    };
    await render(
      [
        'Valid CAN-12, too long ABCDEFGHIJKLMNOPQ-1 and CAN-1234567890.',
        '',
        'See [bad slug](https://linear.app/-bad/issue/CAN-6).',
      ].join('\n'),
    );
    expect(references()).toEqual(['CAN-12']);
    expect(container.textContent).toContain('ABCDEFGHIJKLMNOPQ-1');
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe(
      'https://linear.app/-bad/issue/CAN-6',
    );
  });

  it('leaves a streaming block alone until it settles', async () => {
    await render('Working on CAN-12', { streaming: true });
    expect(references()).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    await render('Working on CAN-12', { streaming: true, settled: true });
    expect(references()).toEqual(['CAN-12']);
  });

  it.each([false, true])(
    'ignores Early access (enabled: %s)',
    async (earlyAccess) => {
      setTestEarlyAccessFeatures({
        enabled: earlyAccess,
        hydrated: true,
      });
      await render('Fixes CAN-12 and [x](https://linear.app/acme/issue/CAN-6)');
      expect(references()).toEqual(['CAN-12', 'x']);
    },
  );

  it('reads once on deliberate hover and opens the canonical URL on click', async () => {
    jest.useFakeTimers();
    const open = jest.spyOn(window, 'open').mockReturnValue(null);
    await render('Fixes CAN-12.');
    const reference = container.querySelector<HTMLElement>(
      '[data-testid="linear-reference"]',
    );
    act(() => {
      reference?.dispatchEvent(
        new MouseEvent('mouseover', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });
    expect(calls('referencePreview.linearIssue')).toEqual([]);
    await act(async () => {
      jest.advanceTimersByTime(250);
      await Promise.resolve();
    });
    await flush();
    expect(
      document.body.querySelector('[data-testid="linear-issue-preview-card"]')
        ?.textContent,
    ).toContain('Preview tickets');
    expect(calls('referencePreview.linearIssue')).toEqual([
      ['referencePreview.linearIssue', { identifier: 'CAN-12' }],
    ]);
    // The resolved title now labels the reference inline as well.
    expect(reference?.textContent).toBe('CAN-12: Preview tickets');

    await act(async () => {
      reference?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(open).toHaveBeenCalledWith(
      'https://linear.app/acme/issue/CAN-12/preview-tickets',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('never rescans a settled block for streamed chunks or title arrivals', async () => {
    jest.useFakeTimers();
    const scans = jest.mocked(scanReferenceOccurrences);
    // The transcript store keeps a settled block's identity while a later
    // block streams.
    const settled: DisplayBlock = {
      type: 'text',
      text: 'Settled CAN-12 note.',
    };
    const renderTurn = (streamed: string): void =>
      act(() =>
        root.render(
          <CanopyClientProvider client={client}>
            <ChatBlockRenderer block={settled} />
            <ChatBlockRenderer
              block={{ type: 'text', text: streamed }}
              streaming
            />
          </CanopyClientProvider>,
        ),
      );
    renderTurn('Streaming CAN');
    await flush();
    expect(references()).toEqual(['CAN-12']);
    const settledScans = (): number =>
      scans.mock.calls.filter(([text]) => text.includes('Settled CAN-12'))
        .length;
    const before = settledScans();
    for (const chunk of ['-1', '-13', '-134', '-1345 done']) {
      renderTurn(`Streaming CAN${chunk}`);
    }
    // A hover resolves the title; the label changes, the text is not rescanned.
    const reference = container.querySelector<HTMLElement>(
      '[data-testid="linear-reference"]',
    );
    act(() => {
      reference?.dispatchEvent(
        new MouseEvent('mouseover', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });
    await act(async () => {
      jest.advanceTimersByTime(250);
      await Promise.resolve();
    });
    await flush();
    expect(reference?.textContent).toBe('CAN-12: Preview tickets');
    expect(settledScans()).toBe(before);
    expect(
      scans.mock.calls.filter(([text]) => text.startsWith('Streaming')),
    ).toEqual([]);
  });
});
