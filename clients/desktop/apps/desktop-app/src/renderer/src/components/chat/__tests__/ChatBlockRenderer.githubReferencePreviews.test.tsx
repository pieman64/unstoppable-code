/**
 * @jest-environment jsdom
 */
import { act, type JSX, type ReactNode } from 'react';

let mockModes = { linear: 'replace', github: 'replace' };
jest.mock('@/lib/chat-enrichment-modes', () => ({
  useChatEnrichmentModes: (): typeof mockModes => mockModes,
}));

jest.mock('@/lib/terminal-instances', () => ({
  getOrCreateInstance: jest.fn(),
  peekInstance: jest.fn(() => undefined),
  TERMINAL_BG_COLOR: '#0b0c10',
}));
jest.mock('@xterm/xterm', () => ({ Terminal: jest.fn() }));
jest.mock('@xterm/addon-fit', () => ({ FitAddon: jest.fn() }));
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

import { createRoot, type Root } from 'react-dom/client';
import type { CanopyClient } from '@canopy/app-core';
import { createFakeClient } from '@canopy/app-state/__tests__/fake-org-projects-client';
import { CanopyClientProvider } from '@canopy/app-state';
import type {
  GitHubPreviewTarget,
  GitHubReferenceOrigin,
} from '@canopy/protocol/reference-previews';
import { ChatBlockRenderer } from '../ChatBlockRenderer';
import {
  ChatMarkdownFileTargetContext,
  type ChatMarkdownFileTarget,
} from '../chat-markdown-file-target';
import type { DisplayBlock } from '../types';
import { resetExperimentalFeaturesStoreForTest } from '@/stores/experimentalFeaturesStore';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const fakeClient = createFakeClient();
const query = fakeClient.query;
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
    overviewNotifications: false,
  },
  query,
  command: fakeClient.command,
  subscribe: fakeClient.client.subscribe.bind(fakeClient.client),
};

const WORKTREE_A: ChatMarkdownFileTarget = {
  projectId: 'canopy',
  worktreeId: 'lemur',
};
const WORKTREE_B: ChatMarkdownFileTarget = {
  projectId: 'canopy',
  worktreeId: 'fly',
};

let container: HTMLDivElement;
let root: Root;
let githubScope: string | null;
let origins: Record<string, unknown>;

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  });
}

async function render(
  text: string,
  {
    target = WORKTREE_A,
    settled,
    streaming,
  }: {
    target?: ChatMarkdownFileTarget | null;
    settled?: boolean;
    streaming?: boolean;
  } = {},
): Promise<void> {
  act(() =>
    root.render(
      <CanopyClientProvider client={client}>
        <ChatMarkdownFileTargetContext.Provider value={target}>
          <ChatBlockRenderer
            block={{ type: 'text', text }}
            settled={settled}
            streaming={streaming}
          />
        </ChatMarkdownFileTargetContext.Provider>
      </CanopyClientProvider>,
    ),
  );
  await flush();
}

const references = (): Element[] =>
  Array.from(container.querySelectorAll('[data-testid="github-reference"]'));

const referenceTexts = (): string[] =>
  references().map((node) => node.textContent ?? '');

const calls = (name: string): unknown[][] =>
  query.mock.calls
    .map((call: unknown[]) => call)
    .filter(([called]) => called === name);

const originKey = (origin: unknown): string => {
  if (typeof origin !== 'object' || origin === null) return '';
  const value: Partial<GitHubReferenceOrigin> & {
    projectId?: string;
    worktreeId?: string;
  } = { ...origin };
  return `${value.projectId ?? ''}/${value.worktreeId ?? ''}`;
};

function itemResult(target: GitHubPreviewTarget): unknown {
  if (target.kind !== 'item') return { status: 'unavailable', scope: 'gh-a' };
  return {
    status: 'ok',
    scope: 'gh-a',
    preview: {
      kind: 'item',
      owner: target.owner,
      repository: target.repository,
      number: target.number,
      itemType: 'pull',
      title: `Title for ${target.owner}/${target.repository}`,
      url: `https://github.com/${target.owner}/${target.repository}/pull/${target.number}`,
      description: null,
      state: 'open',
      draft: false,
      author: 'octocat',
      updatedAt: '2026-10-01T00:00:00.000Z',
    },
  };
}

beforeEach(() => {
  mockModes = { linear: 'replace', github: 'replace' };
  localStorage.clear();
  resetExperimentalFeaturesStoreForTest();
  githubScope = 'gh-a';
  origins = {
    'canopy/lemur': { repository: { owner: 'acme', repository: 'app' } },
    'canopy/fly': { repository: null },
  };
  query.mockReset();
  query.mockImplementation((name: string, args?: unknown) => {
    switch (name) {
      case 'referencePreview.githubScope':
        return Promise.resolve({ scope: githubScope });
      case 'referencePreview.githubOrigin':
        return Promise.resolve(
          origins[originKey(args)] ?? { repository: null },
        );
      case 'referencePreview.github': {
        const target: GitHubPreviewTarget = {
          kind: 'item',
          owner: '',
          repository: '',
          number: 1,
          ...(typeof args === 'object' && args !== null ? args : {}),
        };
        return Promise.resolve(itemResult(target));
      }
      case 'referencePreview.linearScope':
        return Promise.resolve({ scope: null });
      case 'referencePreview.linearTeams':
        return Promise.resolve({ status: 'disconnected' });
      default:
        return Promise.reject(new Error(`unexpected ${name}`));
    }
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

describe('ChatBlockRenderer GitHub reference previews', () => {
  it('preserves raw URL and custom labels in Hover without icons or passive title reads', async () => {
    mockModes.github = 'hover';
    const url = 'https://github.com/acme/app/pull/12/files?w=1#diff';
    await render(`acme/app#12 ${url} [my label](${url})`);
    expect(referenceTexts()).toEqual(['acme/app#12', url, 'my label']);
    expect(container.querySelector('svg')).toBeNull();
    expect(calls('referencePreview.github')).toEqual([]);
  });

  it('does not validate provider connections or decorate original links while Off', async () => {
    mockModes = { linear: 'off', github: 'off' };
    const url = 'https://github.com/acme/app/issues/12';
    await render(`CAN-42 acme/app#12 ${url}`);
    expect(references()).toEqual([]);
    expect(container.querySelectorAll(`a[href="${url}"]`)).toHaveLength(1);
    expect(query).not.toHaveBeenCalled();
  });

  it('decorates explicit, qualified and own-repository bare references in a single-repo worktree', async () => {
    const text =
      'See #12, acme/app#12, other/lib#12 and https://github.com/acme/app/pull/7; bare acme/app stays prose.';
    await render(text);
    // A raw URL label becomes the generated ID, short in its own repository,
    // while its title is expected.
    expect(referenceTexts()).toEqual([
      '#12',
      'acme/app#12',
      'other/lib#12',
      '#7',
    ]);
    expect(references()[3].getAttribute('href')).toBe(
      'https://github.com/acme/app/pull/7',
    );
    expect(container.textContent).toBe(
      text.replace('https://github.com/acme/app/pull/7', '#7'),
    );
    expect(calls('referencePreview.githubOrigin')).toEqual([
      [
        'referencePreview.githubOrigin',
        { kind: 'worktree', projectId: 'canopy', worktreeId: 'lemur' },
      ],
    ]);
    // Title reads wait for visibility; nothing reads provider data yet.
    expect(calls('referencePreview.github')).toEqual([]);
  });

  it('keeps bare numbers plain for an ambiguous or cowork origin and without an origin', async () => {
    await render('Fixes #12 and acme/app#12.', { target: WORKTREE_B });
    expect(referenceTexts()).toEqual(['acme/app#12']);
    act(() => root.unmount());
    root = createRoot(container);
    await render('Fixes #12 and acme/app#12.', { target: null });
    expect(referenceTexts()).toEqual(['acme/app#12']);
  });

  it('never shares a lookup between repositories that use the same number', async () => {
    await render('acme/app#1234 and other/lib#1234');
    for (const reference of references()) {
      act(() => {
        reference.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
      });
    }
    await flush();
    expect(calls('referencePreview.github')).toEqual([
      [
        'referencePreview.github',
        { kind: 'item', owner: 'acme', repository: 'app', number: 1234 },
      ],
      [
        'referencePreview.github',
        { kind: 'item', owner: 'other', repository: 'lib', number: 1234 },
      ],
    ]);
  });

  it('decorates nothing and resolves no origin while GitHub is disconnected', async () => {
    githubScope = null;
    await render('See #12, acme/app#12 and https://github.com/acme/app.');
    expect(references()).toEqual([]);
    expect(calls('referencePreview.githubOrigin')).toEqual([]);
    expect(calls('referencePreview.github')).toEqual([]);
  });

  it('never loads preview state for prose without GitHub candidates', async () => {
    await render('Ordinary prose with **emphasis**, owner/repo and C#1.');
    expect(query).not.toHaveBeenCalled();
  });

  it('leaves streaming prose undecorated', async () => {
    await render('Fixes acme/app#12', { streaming: true });
    expect(references()).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('decorates Markdown prose and links but not code, and keeps an author label', async () => {
    await render(
      [
        'Fixes **acme/app#12** in [my explanation](https://github.com/acme/app/pull/12#discussion_r1) and [https://github.com/acme/app/issues/3](https://github.com/acme/app/issues/3).',
        '',
        'Inline `acme/app#13` stays code.',
        '',
        '```',
        'acme/app#14',
        '```',
      ].join('\n'),
    );
    expect(referenceTexts()).toEqual(['acme/app#12', 'my explanation', '#3']);
    const links = references().filter((node) => node.tagName === 'A');
    expect(links.map((node) => node.getAttribute('href'))).toEqual([
      'https://github.com/acme/app/pull/12#discussion_r1',
      'https://github.com/acme/app/issues/3',
    ]);
    expect(container.querySelector('code')?.textContent).toBe('acme/app#13');
  });

  it('interleaves Linear and GitHub references without overlap', async () => {
    query.mockImplementation((name: string, args?: unknown) => {
      if (name === 'referencePreview.linearScope') {
        return Promise.resolve({ scope: 'linear-a' });
      }
      if (name === 'referencePreview.linearTeams') {
        return Promise.resolve({
          status: 'ok',
          scope: 'linear-a',
          keys: ['CAN'],
          fetchedAt: Date.now(),
        });
      }
      if (name === 'referencePreview.githubScope') {
        return Promise.resolve({ scope: 'gh-a' });
      }
      if (name === 'referencePreview.githubOrigin') {
        return Promise.resolve(origins[originKey(args)]);
      }
      return Promise.reject(new Error(`unexpected ${name}`));
    });
    const text = 'CAN-12 closes acme/app#12 and #13.';
    await render(text);
    expect(
      Array.from(
        container.querySelectorAll('[data-testid="linear-reference"]'),
        (node) => node.textContent,
      ),
    ).toEqual(['CAN-12']);
    expect(referenceTexts()).toEqual(['acme/app#12', '#13']);
    expect(container.textContent).toBe(text);
  });

  it('binds bare numbers to the origin they were resolved for, despite a late origin answer', async () => {
    let answerA: (value: unknown) => void = () => undefined;
    query.mockImplementation((name: string, args?: unknown) => {
      if (name === 'referencePreview.githubScope') {
        return Promise.resolve({ scope: 'gh-a' });
      }
      if (name === 'referencePreview.githubOrigin') {
        if (originKey(args) === 'canopy/lemur') {
          return new Promise((resolve) => {
            answerA = resolve;
          });
        }
        return Promise.resolve({
          repository: { owner: 'other', repository: 'lib' },
        });
      }
      if (name === 'referencePreview.github') {
        return Promise.resolve({ status: 'unavailable', scope: 'gh-a' });
      }
      return Promise.reject(new Error(`unexpected ${name}`));
    });
    await render('Fixes #12.', { target: WORKTREE_A });
    expect(references()).toEqual([]);
    await render('Fixes #12.', { target: WORKTREE_B });
    expect(referenceTexts()).toEqual(['#12']);
    act(() => {
      answerA({ repository: { owner: 'acme', repository: 'app' } });
    });
    await flush();
    const [reference] = references();
    act(() => {
      reference.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    await flush();
    expect(calls('referencePreview.github')).toEqual([
      [
        'referencePreview.github',
        { kind: 'item', owner: 'other', repository: 'lib', number: 12 },
      ],
    ]);
  });
});
