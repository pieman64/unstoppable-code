/**
 * @jest-environment jsdom
 */
import { act, type JSX, type ReactNode } from 'react';
import { DelegationTranscriptSourceContext } from '../delegated-agent-transcript';
import {
  DELEGATION_TRANSCRIPT_RUN_LIMIT,
  useDelegationTranscriptStore,
} from '@/stores/delegationTranscriptStore';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type MarkdownToJsx from 'markdown-to-jsx';
import type * as FilePathMentionIndexModule from '@/lib/filePathMentionIndex';
import { TrashIcon } from '@canopy/ui-shared/icons';
import { ChatLookProvider } from '@canopy/ui-shared/components';
import type { NativeAiCreditsAvailability } from '@canopy/desktop-shared/types';

const mockMarkdownRender = jest.fn(
  ({ children }: { children?: ReactNode }): JSX.Element => <>{children}</>,
);
let mockUseRealMarkdownRenderer = false;

// Spy on the parser boundary so the fast-path assertions can distinguish
// plain paragraphs from markdown that requires a full parse.
jest.mock('markdown-to-jsx', () => {
  const actual = jest.requireActual<{ default: typeof MarkdownToJsx }>(
    'markdown-to-jsx',
  );
  const ActualMarkdown = actual.default;
  return {
    __esModule: true,
    ...actual,
    default: (props: { children?: ReactNode }): JSX.Element => {
      mockMarkdownRender(props);
      return mockUseRealMarkdownRenderer ? (
        <ActualMarkdown {...props} />
      ) : (
        <>{props.children}</>
      );
    },
  };
});

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

jest.mock('@/lib/terminal-instances', () => ({
  getOrCreateInstance: jest.fn(),
  peekInstance: jest.fn(() => undefined),
  TERMINAL_BG_COLOR: '#0b0c10',
}));

jest.mock('@xterm/xterm', () => ({ Terminal: jest.fn() }));
const mockOpenFileInBrowserPanel = jest.fn();
jest.mock('@/lib/openFileInBrowserPanel', () => ({
  isBrowserRenderedFile: (filename: string): boolean =>
    /\.html?$/i.test(filename),
  openFileInBrowserPanel: (...args: unknown[]): unknown =>
    mockOpenFileInBrowserPanel(...args),
}));
jest.mock('@xterm/addon-fit', () => ({ FitAddon: jest.fn() }));
// Counts the file-path mention scans; delegates to the real implementation.
jest.mock('@/lib/filePathMentionIndex', () => {
  const actual = jest.requireActual<typeof FilePathMentionIndexModule>(
    '@/lib/filePathMentionIndex',
  );
  return {
    ...actual,
    splitTextByFilePathMentions: jest.fn(actual.splitTextByFilePathMentions),
  };
});

import { ChatBlockRenderer } from '../ChatBlockRenderer';
import { invalidateSharedAiCreditsRead } from '@/lib/openBillingPage';
import { resetModelLibraryAccessForTests } from '@/lib/modelLibraryAccess';
import {
  resetModelUnlockIntentForTests,
  useModelUnlockIntentStore,
} from '@/lib/modelUnlockIntent';
import {
  buildFilePathMentionIndex,
  splitTextByFilePathMentions,
} from '@/lib/filePathMentionIndex';
import { ChatMarkdownLink } from '../ChatMarkdownLink';
import { useAgentFilePresentationStore } from '@/stores/agentFilePresentationStore';
import { AuthRecoveryCard } from '../AuthRecoveryCard';
import {
  ChatMarkdownFileTargetContext,
  type ChatMarkdownFileTarget,
} from '../chat-markdown-file-target';
import {
  getHarnessConnectionProvider,
  isMcpConnectionError,
  parseCanopyProxyError,
} from '../chatConnectionErrors';
import type { DisplayBlock } from '../types';
import { ManagedDelegationStopContext } from '../managed-delegation-stop';
import { useGitHubStore } from '@/stores/githubStore';
import {
  useChatStore,
  type ChatTab,
  type PendingQuestion,
} from '@/stores/chatStore';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function render(
  block: DisplayBlock,
  chatPendingQuestions?: PendingQuestion[],
  stripAgentCitations = false,
  isSystemMessage = false,
): string {
  return renderToStaticMarkup(
    <ChatBlockRenderer
      block={block}
      chatPendingQuestions={chatPendingQuestions}
      stripAgentCitations={stripAgentCitations}
      isSystemMessage={isSystemMessage}
    />,
  );
}

describe('ChatBlockRenderer clean chat look', () => {
  const block: DisplayBlock = {
    type: 'text',
    text: 'The agent stopped: the connection to the model was lost.',
  };
  function renderIn(
    look: 'classic' | 'clean',
    isSystemMessage: boolean,
  ): string {
    return renderToStaticMarkup(
      <ChatLookProvider value={look}>
        <ChatBlockRenderer
          block={block}
          chatPendingQuestions={[]}
          isSystemMessage={isSystemMessage}
        />
      </ChatLookProvider>,
    );
  }

  it('draws an app message as a quiet note only under the clean look', () => {
    expect(renderIn('classic', true)).not.toContain('chat-app-note');
    expect(renderIn('clean', true)).toContain('data-testid="chat-app-note"');
  });

  it('keeps agent text as prose under the clean look', () => {
    expect(renderIn('clean', false)).not.toContain('chat-app-note');
  });
});

describe('ChatBlockRenderer banner spacing', () => {
  const timestamp = Date.parse('2026-10-06T09:00:00Z');
  const localTime = new Date(timestamp).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });

  it.each<[DisplayBlock, string]>([
    [
      { type: 'hook_info', triggerName: 'pr:create', timestamp },
      `Chat initiated by PR Created hook at ${localTime}`,
    ],
    [
      {
        type: 'automation_info',
        activityName: 'Nightly code review',
        timestamp,
      },
      `Chat initiated by automation Nightly code review at ${localTime}`,
    ],
    [
      { type: 'automation_info', timestamp },
      `Chat initiated by automation at ${localTime}`,
    ],
    [
      { type: 'claude_terminal_sync_warning', timestamp },
      `Claude Code transcript sync failed at ${localTime}`,
    ],
  ])('keeps words separated in %j', (block, expected) => {
    const host = document.createElement('div');
    host.innerHTML = render(block);
    expect(host.textContent).toContain(expected);
  });
});

describe('ChatBlockRenderer builtin_gh_chat_info', () => {
  const timestamp = Date.parse('2026-10-06T09:00:00Z');

  function bannerText(block: DisplayBlock): string {
    const host = document.createElement('div');
    host.innerHTML = render(block);
    return host.textContent ?? '';
  }

  it('explains a merge queue chat', () => {
    const text = bannerText({
      type: 'builtin_gh_chat_info',
      kind: 'merge_queue',
      repoName: 'app',
      branchName: 'feature',
      timestamp,
    });

    expect(text).toContain('Chat initiated by Merge queue at');
    expect(text).toContain(
      'The base branch for app (branch "feature") uses a merge queue. This chat can add the pull request to the queue, watch it, and help resolve failures.',
    );
    expect(text).not.toContain('CI check fix');
  });

  it('falls back to the pull request when the repo is unknown', () => {
    expect(
      bannerText({
        type: 'builtin_gh_chat_info',
        kind: 'merge_queue',
        timestamp,
      }),
    ).toContain('The base branch for this pull request uses a merge queue.');
  });

  it('keeps the CI check fix banner', () => {
    const text = bannerText({
      type: 'builtin_gh_chat_info',
      kind: 'ci_check_fix',
      repoName: 'app',
      timestamp,
    });

    expect(text).toContain('Chat initiated by CI check fix at');
    expect(text).toContain('GitHub reported failing CI checks on app.');
  });
});

describe('ChatBlockRenderer connection recovery', () => {
  it.each([
    ['Claude is not authenticated.', 'claude'],
    [
      'Please run /login - API Error: 401 Invalid authentication credentials',
      'claude',
    ],
    ["You're not signed in to Codex and have no credits.", 'codex'],
    ['Error: Unauthorized', 'codex'],
  ] as const)('classifies the harness auth failure %s', (message, provider) => {
    expect(getHarnessConnectionProvider(message)).toBe(provider);
  });

  it.each([
    'MCP error -32001: MCP server authorization required',
    'OAuth token expired',
  ])('classifies the MCP auth failure %s', (message) => {
    expect(isMcpConnectionError(message)).toBe(true);
  });

  it('leaves unrelated errors alone', () => {
    expect(getHarnessConnectionProvider('The request timed out.')).toBeNull();
    expect(isMcpConnectionError('HTTP 504 gateway timeout')).toBe(false);
  });

  it('still recognizes a real 401 status line, but not a bare 401 (CAN-1814)', () => {
    // Structured `authFailure` data is preferred for new turns, but it only
    // exists for HTTP MCP servers that completed OAuth through Canopy's proxy,
    // so the status line is still the only signal for Codex, stdio servers,
    // and static-header HTTP servers. Adjacency to an unauthorized/
    // invalid_token marker is what keeps non-auth prose out.
    expect(
      isMcpConnectionError(
        'app.log:42: GET /health returned HTTP 401 Unauthorized',
      ),
    ).toBe(true);
    expect(isMcpConnectionError('app.log:42: processed 401 events')).toBe(
      false,
    );
  });

  it('offers the matching provider login from a harness authentication error', () => {
    const html = render(
      { type: 'text', text: 'Claude is not authenticated.' },
      undefined,
      false,
      true,
    );

    expect(html).toContain('data-testid="chat-connection-cta-claude"');
    expect(html).toContain('Reconnect Claude');
    // The recovery card names the dependency; the raw host message is kept as
    // the card's detail line rather than dropped (CAN-1814 PR 2).
    expect(html).toContain('Claude is not authenticated.');
  });

  it('offers Codex login for the Codex harness authentication error', () => {
    const html = render(
      { type: 'text', text: 'Codex is not authenticated.' },
      undefined,
      false,
      true,
    );

    expect(html).toContain('data-testid="chat-connection-cta-codex"');
    expect(html).toContain('Reconnect Codex');
  });

  it('offers Codex login for a trusted nested authentication error', () => {
    const html = render({
      type: 'codex_agent',
      agentBlockId: 'codex-agent-auth',
      callId: 'call-auth',
      status: 'failed',
      senderThreadId: 'root-thread',
      receiverThreadIds: ['sub-auth'],
      prompt: 'Continue the task',
      description: 'Continue the task',
      displayName: 'Subagent',
      agentsStates: {
        'sub-auth': { status: 'failed', message: 'Unauthorized' },
      },
      subBlocks: [
        {
          type: 'text',
          text: 'Error: Unauthorized',
          isSystemMessage: true,
        },
      ],
    });

    expect(html).toContain('data-testid="chat-connection-cta-codex"');
    expect(html).toContain('Reconnect Codex');
  });

  it('does not turn ordinary assistant guidance into a connection CTA', () => {
    const html = render({
      type: 'text',
      text: 'Claude is not authenticated in this hypothetical example.',
    });

    expect(html).not.toContain('data-testid="chat-connection-cta-claude"');
  });

  it('memoizes the recovery card rendered in the streaming message list', () => {
    expect(AuthRecoveryCard).toHaveProperty(
      '$$typeof',
      Symbol.for('react.memo'),
    );
  });

  it('prefers a structured authFailure over the text heuristic (CAN-1814)', () => {
    // Not gated on `isSystemMessage`: main attached this verdict to the block,
    // so there is nothing left to infer from the prose.
    const html = render({
      type: 'text',
      text: 'The request could not be completed.',
      authFailure: {
        dependencyClass: 'mcp',
        dependencyId: 'srv-1:cfg-1',
        displayName: 'Prod MCP server',
        failureClass: 'expired',
        recovery: { kind: 'mcp_oauth', serverId: 'srv-1', configId: 'cfg-1' },
      },
    });

    expect(html).toContain('data-testid="auth-recovery-card"');
    expect(html).toContain('Reconnect Prod MCP server');
  });

  it('renders an explanation but no login for a non-recoverable structured failure', () => {
    const html = render({
      type: 'text',
      text: 'The request could not be completed.',
      authFailure: {
        dependencyClass: 'provider',
        dependencyId: 'claude',
        displayName: 'Claude',
        failureClass: 'quota_exceeded',
        recovery: { kind: 'none' },
      },
    });

    // The display name renders inside <strong>, so assert the fragments.
    expect(html).toContain('<strong class="font-medium">Claude</strong>');
    expect(html).toContain('is over its usage limit.');
    expect(html).not.toContain('data-testid="chat-connection-cta-claude"');
  });

  // CAN-1814 PR 7. This is the exact block a REFUSED send writes: a `system`
  // message whose text block carries the whole `authFailures` array the send
  // IPC returned. It renders one checklist card, not one card per blocker, and
  // the non-recoverable row still gets no login affordance.
  it("renders a refused send's authFailures array as one checklist card", () => {
    const html = render(
      {
        type: 'text',
        text: 'Prod MCP server and Claude need to be reconnected before this message can run.',
        authFailures: [
          {
            dependencyClass: 'mcp',
            dependencyId: 'srv-prod:cfg-1',
            displayName: 'Prod MCP server',
            failureClass: 'expired',
            recovery: {
              kind: 'mcp_oauth',
              serverId: 'srv-prod',
              configId: 'cfg-1',
            },
          },
          {
            dependencyClass: 'provider',
            dependencyId: 'claude',
            displayName: 'Claude',
            failureClass: 'quota_exceeded',
            recovery: { kind: 'none' },
          },
        ],
      },
      undefined,
      false,
      true,
    );

    expect(html).toContain('data-blocker-count="2"');
    expect(html).toContain('2 connections need attention');
    expect(html).toContain('Reconnect Prod MCP server');
    expect(html).toContain('is over its usage limit.');
    expect(html).not.toContain('data-testid="chat-connection-cta-claude"');
    // One card, not one per blocker.
    expect(html.split('data-testid="auth-recovery-card"')).toHaveLength(2);
  });
});

describe('ChatBlockRenderer plain text fast path', () => {
  it('renders provider-controlled verbatim output without Markdown parsing', () => {
    const html = render({
      type: 'text',
      text: 'Tool output (tests)\n\n![Tracking](https://attacker.example/pixel)',
      verbatim: true,
    });

    expect(mockMarkdownRender).not.toHaveBeenCalled();
    expect(html).toContain('data-testid="chat-verbatim-text"');
    expect(html).not.toContain('<img');
  });

  beforeEach(() => {
    mockMarkdownRender.mockClear();
    mockUseRealMarkdownRenderer = false;
  });

  it('renders ordinary single-line text without invoking Markdown', () => {
    const html = render({
      type: 'text',
      text: 'A plain transcript response with punctuation.',
    });

    expect(html).toContain(
      '<p>A plain transcript response with punctuation.</p>',
    );
    expect(mockMarkdownRender).not.toHaveBeenCalled();
  });

  it.each([
    '## Heading',
    '- list item',
    '    indented code',
    '\tindented code',
    ' \tindented code',
    '  \tindented code',
    '   \tindented code',
    '---',
    '-',
    '+',
    '1.',
    '   ',
    '**strong text**',
    '$$E = mc^2$$',
    '[Open docs](https://example.com)',
    '![Managed image](/workspace/.canopy/attachments/image.png)',
    'https://example.com/autolink',
    'first paragraph\n\nsecond paragraph',
  ])('keeps Markdown parsing for semantic input: %s', (text) => {
    render({ type: 'text', text });

    expect(mockMarkdownRender).toHaveBeenCalledTimes(1);
  });

  it.each([
    '/workspace/report.md:12',
    'C:/workspace/report.md:12',
    './docs/report.md#L12',
    'README.md:12-20',
    'README.md:12:4-20:9',
    'README.md#L12-L20',
    'README.md#L12-20',
    'README.md#L12C4',
  ])('keeps a custom local Markdown label interactive: %s', (href) => {
    mockUseRealMarkdownRenderer = true;
    const html = renderToStaticMarkup(
      <ChatMarkdownFileTargetContext.Provider
        value={{ projectId: 'project', worktreeId: 'worktree' }}
      >
        <ChatBlockRenderer
          block={{
            type: 'text',
            text: `[Fixes, evidence, and remaining checks](${href})`,
          }}
          settled={false}
        />
      </ChatMarkdownFileTargetContext.Provider>,
    );
    expect(html).toContain('data-testid="chat-local-file-link"');
    expect(html).toContain('Fixes, evidence, and remaining checks');
  });

  it('does not render a remote image for an untrusted transcript target', () => {
    mockUseRealMarkdownRenderer = true;
    const target: ChatMarkdownFileTarget = {
      projectId: 'shared-container-viewer',
      worktreeId: 'shared-container-id',
      allowRemoteImages: false,
    };

    const html = renderToStaticMarkup(
      <ChatMarkdownFileTargetContext.Provider value={target}>
        <ChatBlockRenderer
          block={{
            type: 'text',
            text: '![Tracking pixel](https://attacker.example/open/token)',
          }}
        />
      </ChatMarkdownFileTargetContext.Provider>,
    );

    expect(html).not.toContain('<img');
    expect(html).not.toContain('https://attacker.example/open/token');
    expect(html).toContain('Tracking pixel');
  });

  it('blocks browser-normalized backslash URLs for an untrusted transcript target', () => {
    mockUseRealMarkdownRenderer = true;
    const target: ChatMarkdownFileTarget = {
      projectId: 'shared-container-viewer',
      worktreeId: 'shared-container-id',
      allowRemoteImages: false,
    };

    const html = renderToStaticMarkup(
      <ChatMarkdownFileTargetContext.Provider value={target}>
        <ChatBlockRenderer
          block={{
            type: 'text',
            text: String.raw`![Backslash tracking pixel](https:\\attacker.example\open)`,
          }}
        />
      </ChatMarkdownFileTargetContext.Provider>,
    );

    expect(html).not.toContain('<img');
    expect(html).not.toContain('attacker.example');
    expect(html).toContain('Backslash tracking pixel');
  });
});

describe('ChatBlockRenderer mention decoration', () => {
  afterEach(() => {
    mockUseRealMarkdownRenderer = false;
  });

  it('decorates rendered Markdown in place when a mention index arrives', () => {
    mockUseRealMarkdownRenderer = true;
    const text = [
      '### Findings',
      '',
      '| Check | Evidence |',
      '| --- | --- |',
      '| Reopen | see docs/report.md |',
      '',
      'Compare docs/report.md with the visible transcript.',
    ].join('\n');
    const filePathMentionIndex = buildFilePathMentionIndex(
      [
        {
          repoId: 'repo',
          repoName: 'repo',
          absolutePath: '/workspace/repo',
          rootKind: 'git-repo',
          files: [
            {
              relativePath: 'docs/report.md',
              filename: 'report.md',
              absolutePath: '/workspace/repo/docs/report.md',
              isIgnored: false,
            },
          ],
        },
      ],
      '/workspace/repo',
    );
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      act(() =>
        root.render(
          <ChatBlockRenderer
            block={{ type: 'text', text }}
            filePathMentionIndex={null}
            originChatTabId="chat-1"
          />,
        ),
      );
      const heading = container.querySelector('h3');
      const cell = container.querySelector('tbody td:last-child');
      const paragraph = container.querySelector('p');
      expect(cell?.textContent).toBe('see docs/report.md');

      // The file index loads after the transcript is on screen. Swapping the
      // Markdown component overrides would rebuild every element of the
      // message; the existing elements are decorated instead.
      act(() =>
        root.render(
          <ChatBlockRenderer
            block={{ type: 'text', text }}
            filePathMentionIndex={filePathMentionIndex}
            originChatTabId="chat-1"
          />,
        ),
      );

      expect(container.querySelector('h3')).toBe(heading);
      expect(container.querySelector('tbody td:last-child')).toBe(cell);
      expect(container.querySelector('p')).toBe(paragraph);
      expect(
        cell?.querySelector('button[aria-label="Open docs/report.md"]'),
      ).not.toBeNull();
      expect(
        paragraph?.querySelector('button[aria-label="Open docs/report.md"]'),
      ).not.toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('leaves fenced code unscanned while a mention index is loaded', () => {
    mockUseRealMarkdownRenderer = true;
    const text = ['```ts', "const report = 'docs/report.md';", '```'].join(
      '\n',
    );
    const filePathMentionIndex = buildFilePathMentionIndex(
      [
        {
          repoId: 'repo',
          repoName: 'repo',
          absolutePath: '/workspace/repo',
          rootKind: 'git-repo',
          files: [
            {
              relativePath: 'docs/report.md',
              filename: 'report.md',
              absolutePath: '/workspace/repo/docs/report.md',
              isIgnored: false,
            },
          ],
        },
      ],
      '/workspace/repo',
    );
    const scans = jest.mocked(splitTextByFilePathMentions);
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      scans.mockClear();
      act(() =>
        root.render(
          <ChatBlockRenderer
            block={{ type: 'text', text }}
            filePathMentionIndex={filePathMentionIndex}
            originChatTabId="chat-1"
          />,
        ),
      );

      const code = container.querySelector('pre code');
      expect(code?.textContent).toContain("const report = 'docs/report.md';");
      expect(code?.querySelector('button')).toBeNull();
      // Fenced code renders literally. Scanning it for mentions would cost a
      // large generated block a full decoration pass only to drop the result.
      expect(scans).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});

describe('ChatBlockRenderer image blocks', () => {
  it('opens a scoped file and forwards its line to the existing presentation store', async () => {
    const originalApi = Object.getOwnPropertyDescriptor(window, 'api');
    const resolved = {
      absolutePath: '/workspace/report.md',
      filename: 'report.md',
    };
    const resolveFileReference = jest.fn().mockResolvedValue(resolved);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { resolveFileReference },
    });
    const openFileTab = jest
      .spyOn(useChatStore.getState(), 'openFileTab')
      .mockReturnValue('file-report');
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(() =>
        Promise.resolve(
          root.render(
            <ChatMarkdownFileTargetContext.Provider
              value={{ projectId: 'project', worktreeId: 'worktree' }}
            >
              <ChatMarkdownLink href="/workspace/report.md:12">
                Evidence
              </ChatMarkdownLink>
            </ChatMarkdownFileTargetContext.Provider>,
          ),
        ),
      );
      await act(() =>
        Promise.resolve(container.querySelector('button')?.click()),
      );
      expect(resolveFileReference).toHaveBeenCalledWith({
        projectId: 'project',
        worktreeId: 'worktree',
        baseFilePath: '/workspace/report.md',
        href: '/workspace/report.md',
      });
      expect(openFileTab).toHaveBeenCalledWith(
        { ...resolved, initialViewMode: 'preview' },
        {
          projectId: 'project',
          worktreeId: 'worktree',
        },
      );
      expect(
        useAgentFilePresentationStore.getState().byTabId['file-report'].line,
      ).toBe(12);
    } finally {
      act(() => root.unmount());
      openFileTab.mockRestore();
      if (originalApi) Object.defineProperty(window, 'api', originalApi);
      else Reflect.deleteProperty(window, 'api');
    }
  });

  it.each([
    ['/workspace/rows.csv', 'rows.csv', 'table'],
    ['/workspace/page.html:3', 'page.html', 'preview'],
    ['/workspace/src/index.ts', 'index.ts', undefined],
  ])(
    'opens %s in its rendered view when the file type has one',
    async (absolutePath, filename, initialViewMode) => {
      const originalApi = Object.getOwnPropertyDescriptor(window, 'api');
      const resolved = { absolutePath, filename };
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { resolveFileReference: jest.fn().mockResolvedValue(resolved) },
      });
      const openFileTab = jest
        .spyOn(useChatStore.getState(), 'openFileTab')
        .mockReturnValue('file-tab');
      const container = document.createElement('div');
      const root = createRoot(container);
      try {
        await act(() =>
          Promise.resolve(
            root.render(
              <ChatMarkdownFileTargetContext.Provider
                value={{ projectId: 'project', worktreeId: 'worktree' }}
              >
                <ChatMarkdownLink href={absolutePath}>
                  Evidence
                </ChatMarkdownLink>
              </ChatMarkdownFileTargetContext.Provider>,
            ),
          ),
        );
        await act(() =>
          Promise.resolve(container.querySelector('button')?.click()),
        );
        expect(openFileTab).toHaveBeenCalledWith(
          { ...resolved, initialViewMode },
          { projectId: 'project', worktreeId: 'worktree' },
        );
      } finally {
        act(() => root.unmount());
        openFileTab.mockRestore();
        if (originalApi) Object.defineProperty(window, 'api', originalApi);
        else Reflect.deleteProperty(window, 'api');
      }
    },
  );

  it.each([
    ['/workspace/site/index.html', 'index.html'],
    ['./site/legacy.HTM', 'legacy.HTM'],
  ])(
    'opens the linked page %s rendered in the browser beside the chat',
    async (href, filename) => {
      const originalApi = Object.getOwnPropertyDescriptor(window, 'api');
      const resolved = {
        absolutePath: `/workspace/site/${filename}`,
        filename,
      };
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          resolveFileReference: jest.fn().mockResolvedValue(resolved),
          getFileTreeRoots: jest.fn().mockResolvedValue({
            roots: [{ repoId: 'repo', absolutePath: '/workspace' }],
          }),
        },
      });
      mockOpenFileInBrowserPanel.mockReset().mockResolvedValue('browser-1');
      const openFileTab = jest
        .spyOn(useChatStore.getState(), 'openFileTab')
        .mockReturnValue('file-tab');
      const container = document.createElement('div');
      const root = createRoot(container);
      try {
        await act(() =>
          Promise.resolve(
            root.render(
              <ChatMarkdownFileTargetContext.Provider
                value={{ projectId: 'project', worktreeId: 'worktree' }}
              >
                <ChatMarkdownLink href={href} originChatTabId="chat-1">
                  The page
                </ChatMarkdownLink>
              </ChatMarkdownFileTargetContext.Provider>,
            ),
          ),
        );
        await act(() =>
          Promise.resolve(container.querySelector('button')?.click()),
        );
        expect(mockOpenFileInBrowserPanel).toHaveBeenCalledWith(
          'project',
          'worktree',
          resolved.absolutePath,
          { originChatTabId: 'chat-1' },
        );
        expect(openFileTab).not.toHaveBeenCalled();
        expect(container.textContent).not.toContain("Couldn't open file");
      } finally {
        act(() => root.unmount());
        openFileTab.mockRestore();
        if (originalApi) Object.defineProperty(window, 'api', originalApi);
        else Reflect.deleteProperty(window, 'api');
      }
    },
  );

  it('reports a linked page the browser could not open', async () => {
    const originalApi = Object.getOwnPropertyDescriptor(window, 'api');
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        resolveFileReference: jest.fn().mockResolvedValue({
          absolutePath: '/workspace/index.html',
          filename: 'index.html',
        }),
      },
    });
    mockOpenFileInBrowserPanel.mockReset().mockResolvedValue(null);
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(() =>
        Promise.resolve(
          root.render(
            <ChatMarkdownFileTargetContext.Provider
              value={{ projectId: 'project', worktreeId: 'worktree' }}
            >
              <ChatMarkdownLink href="/workspace/index.html">
                The page
              </ChatMarkdownLink>
            </ChatMarkdownFileTargetContext.Provider>,
          ),
        ),
      );
      await act(() =>
        Promise.resolve(container.querySelector('button')?.click()),
      );
      await act(() => Promise.resolve());
      expect(container.textContent).toContain("Couldn't open file");
    } finally {
      act(() => root.unmount());
      if (originalApi) Object.defineProperty(window, 'api', originalApi);
      else Reflect.deleteProperty(window, 'api');
    }
  });

  it('opens a page mention rendered in the browser beside the chat', async () => {
    const filePathMentionIndex = buildFilePathMentionIndex(
      [
        {
          repoId: 'repo',
          repoName: 'repo',
          absolutePath: '/workspace/repo',
          rootKind: 'git-repo',
          files: [
            {
              relativePath: 'site/index.html',
              filename: 'index.html',
              absolutePath: '/workspace/repo/site/index.html',
              isIgnored: false,
            },
          ],
        },
      ],
      '/workspace/repo',
    );
    mockOpenFileInBrowserPanel.mockReset().mockResolvedValue('browser-1');
    const openFileTab = jest
      .spyOn(useChatStore.getState(), 'openFileTab')
      .mockReturnValue('file-tab');
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(() =>
        Promise.resolve(
          root.render(
            <ChatMarkdownFileTargetContext.Provider
              value={{ projectId: 'project', worktreeId: 'worktree' }}
            >
              <ChatBlockRenderer
                block={{ type: 'text', text: 'see site/index.html' }}
                filePathMentionIndex={filePathMentionIndex}
                originChatTabId="chat-1"
              />
            </ChatMarkdownFileTargetContext.Provider>,
          ),
        ),
      );
      const mention = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Open site/index.html"]',
      );
      expect(mention).not.toBeNull();
      await act(() => Promise.resolve(mention?.click()));
      expect(mockOpenFileInBrowserPanel).toHaveBeenCalledWith(
        'project',
        'worktree',
        '/workspace/repo/site/index.html',
        { originChatTabId: 'chat-1' },
      );
      expect(openFileTab).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      openFileTab.mockRestore();
    }
  });

  it('opens a file-path mention in its rendered view', async () => {
    const filePathMentionIndex = buildFilePathMentionIndex(
      [
        {
          repoId: 'repo',
          repoName: 'repo',
          absolutePath: '/workspace/repo',
          rootKind: 'git-repo',
          files: [
            {
              relativePath: 'docs/report.md',
              filename: 'report.md',
              absolutePath: '/workspace/repo/docs/report.md',
              isIgnored: false,
            },
          ],
        },
      ],
      '/workspace/repo',
    );
    const openFileTab = jest
      .spyOn(useChatStore.getState(), 'openFileTab')
      .mockReturnValue('file-tab');
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(() =>
        Promise.resolve(
          root.render(
            <ChatBlockRenderer
              block={{ type: 'text', text: 'see docs/report.md' }}
              filePathMentionIndex={filePathMentionIndex}
            />,
          ),
        ),
      );
      const mention = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Open docs/report.md"]',
      );
      expect(mention).not.toBeNull();
      await act(() => Promise.resolve(mention?.click()));
      expect(openFileTab).toHaveBeenCalledWith({
        absolutePath: '/workspace/repo/docs/report.md',
        filename: 'report.md',
        initialViewMode: 'preview',
      });
    } finally {
      act(() => root.unmount());
      openFileTab.mockRestore();
    }
  });

  it.each([
    'javascript:alert(1)',
    'javascript:12',
    'data:text/plain:12',
    'file:///etc/passwd#L12',
    'file:///etc/passwd',
    '//host/share/file.md',
    '\\\\host\\share\\file.md',
  ])('does not turn unsafe local link %s into a file action', (href) => {
    expect(
      renderToStaticMarkup(
        <ChatMarkdownFileTargetContext.Provider
          value={{ projectId: 'project', worktreeId: 'worktree' }}
        >
          <ChatMarkdownLink href={href}>Evidence</ChatMarkdownLink>
        </ChatMarkdownFileTargetContext.Provider>,
      ),
    ).not.toContain('<button');
  });

  it('renders inline raster output without file IPC and rejects corrupt decoding', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(() =>
        Promise.resolve(
          root.render(
            <ChatBlockRenderer
              block={{
                type: 'image',
                path: '',
                dataUrl: 'data:image/png;base64,aGVsbG8=',
                alt: 'Preview',
              }}
            />,
          ),
        ),
      );
      const image = container.querySelector('img');
      expect(image?.getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=');
      await act(() =>
        Promise.resolve(image?.dispatchEvent(new Event('error'))),
      );
      expect(container.textContent).toContain('Image unavailable');
    } finally {
      act(() => root.unmount());
    }
  });

  it('loads a local image through IPC and renders the resulting data URL', async () => {
    const originalApi = Object.getOwnPropertyDescriptor(window, 'api');
    const readFileContent = jest.fn().mockResolvedValue({
      kind: 'image',
      content: 'data:image/png;base64,abc',
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { readFileContent },
    });

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <ChatBlockRenderer
            block={{
              type: 'image',
              path: '/Users/example/.codex/generated_images/art.png',
              alt: 'Generated artwork',
            }}
          />,
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(readFileContent).toHaveBeenCalledWith({
        absolutePath: '/Users/example/.codex/generated_images/art.png',
        allowedRoot: 'codex-generated-images',
      });
      const image = container.querySelector<HTMLImageElement>(
        '[data-testid="chat-generated-image"]',
      );
      expect(image?.src).toBe('data:image/png;base64,abc');
      expect(image?.alt).toBe('Generated artwork');
    } finally {
      act(() => root.unmount());
      container.remove();
      if (originalApi) {
        Object.defineProperty(window, 'api', originalApi);
      } else {
        Reflect.deleteProperty(window, 'api');
      }
    }
  });

  it('rejects network image paths before invoking file-read IPC', async () => {
    const originalApi = Object.getOwnPropertyDescriptor(window, 'api');
    const readFileContent = jest.fn();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { readFileContent },
    });

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <ChatBlockRenderer
            block={{
              type: 'image',
              path: '\\\\attacker.example\\share\\image.png',
              alt: 'Generated artwork',
            }}
          />,
        );
        await Promise.resolve();
      });

      expect(readFileContent).not.toHaveBeenCalled();
      expect(
        container.querySelector(
          '[data-testid="chat-generated-image-unavailable"]',
        ),
      ).not.toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
      if (originalApi) {
        Object.defineProperty(window, 'api', originalApi);
      } else {
        Reflect.deleteProperty(window, 'api');
      }
    }
  });
});

describe('ChatBlockRenderer account_proxy_switch', () => {
  it('renders the shared switch line', () => {
    const block: DisplayBlock = {
      type: 'account_proxy_switch',
      timestamp: 0,
      account: 'sam@example.com',
      previousAccount: 'ops@example.com',
      previousAtLimit: true,
    };
    const html = render(block);
    expect(html).toContain('data-testid="account-proxy-switch-line"');
    expect(html).toContain('reached its usage limit');
    expect(html).toContain('ph-no-capture');
  });
});

describe('ChatBlockRenderer compaction_info', () => {
  it('renders the Claude Code copy when interfaceMode is claude-code', () => {
    const block: DisplayBlock = {
      type: 'compaction_info',
      timestamp: 0,
      provider: 'claude',
      interfaceMode: 'claude-code',
    };
    const html = render(block);
    expect(html).toContain('Claude Code compacted this session');
    expect(html).not.toContain('Claude compacted this session');
  });

  it('renders the Canopy-native copy when interfaceMode is canopy', () => {
    const block: DisplayBlock = {
      type: 'compaction_info',
      timestamp: 0,
      provider: 'claude',
      interfaceMode: 'canopy',
    };
    const html = render(block);
    expect(html).toContain('Claude compacted this session');
    expect(html).not.toContain('Claude Code compacted this session');
  });

  it('renders provider-correct copy for native Codex compaction', () => {
    const block: DisplayBlock = {
      type: 'compaction_info',
      timestamp: 0,
      provider: 'codex',
      interfaceMode: 'canopy',
    };
    const html = render(block);
    expect(html).toContain('Codex compacted this session');
    expect(html).not.toContain('Claude compacted this session');
  });

  it('renders the summary line when a summary is present', () => {
    const block: DisplayBlock = {
      type: 'compaction_info',
      timestamp: 0,
      provider: 'claude',
      interfaceMode: 'canopy',
      summary: 'Older turns folded into context.',
    };
    const html = render(block);
    expect(html).toContain('Older turns folded into context.');
  });

  it('omits the summary row when summary is missing or empty', () => {
    const noSummary: DisplayBlock = {
      type: 'compaction_info',
      timestamp: 0,
      provider: 'claude',
      interfaceMode: 'canopy',
    };
    const emptySummary: DisplayBlock = {
      type: 'compaction_info',
      timestamp: 0,
      provider: 'claude',
      interfaceMode: 'canopy',
      summary: '',
    };
    // The summary row is the only secondary div inside the testid wrapper, so
    // its absence is detectable by counting child <div> elements rather than
    // poking at classnames.
    expect((render(noSummary).match(/<div /g) ?? []).length).toBe(2);
    expect((render(emptySummary).match(/<div /g) ?? []).length).toBe(2);
  });
});

describe('ChatBlockRenderer provider citations', () => {
  const citationText = 'Sunny and 78°F. \uE200cite\uE202turn0forecast0\uE201';

  it('does not render opaque citation markers in assistant text', () => {
    const html = render(
      {
        type: 'text',
        text: citationText,
      },
      undefined,
      true,
    );

    expect(html).toContain('Sunny and 78°F.');
    expect(html).not.toContain('turn0forecast0');
    expect(html).not.toContain('\uE200');
  });

  it('preserves opaque citation-like characters in user text', () => {
    const html = render({
      type: 'text',
      text: citationText,
    });

    expect(html).toContain('turn0forecast0');
    expect(html).toContain('\uE200');
  });
});

describe('ChatBlockRenderer soft line breaks (CAN-2811)', () => {
  beforeEach(() => {
    mockUseRealMarkdownRenderer = true;
  });

  afterEach(() => {
    mockUseRealMarkdownRenderer = false;
  });

  it('renders single newlines as line breaks when asked to preserve them', () => {
    const html = renderToStaticMarkup(
      <ChatBlockRenderer
        block={{ type: 'text', text: 'line one\nline two\nline three' }}
        preserveLineBreaks
      />,
    );

    expect(html).toContain('<p>line one<br/>line two<br/>line three</p>');
  });

  it('keeps default markdown soft breaks for assistant text', () => {
    const html = render({ type: 'text', text: 'line one\nline two' });

    expect(html).toContain('<p>line one\nline two</p>');
  });

  it('still decorates mentions on every line of a multiline user bubble', () => {
    // The line-break rule must hand the mention decorator plain strings: a
    // fragment per line would hide `src/app.ts` from `decorateMentionChildren`,
    // which only transforms direct string children.
    const filePathMentionIndex = buildFilePathMentionIndex(
      [
        {
          repoId: 'repo',
          repoName: 'repo',
          absolutePath: '/workspace/repo',
          rootKind: 'git-repo',
          files: [
            {
              relativePath: 'src/app.ts',
              filename: 'app.ts',
              absolutePath: '/workspace/repo/src/app.ts',
              isIgnored: false,
            },
          ],
        },
      ],
      '/workspace/repo',
    );

    const html = renderToStaticMarkup(
      <ChatBlockRenderer
        block={{ type: 'text', text: 'first line\nthen open src/app.ts' }}
        filePathMentionIndex={filePathMentionIndex}
        preserveLineBreaks
      />,
    );

    expect(html).toContain('first line<br/>');
    expect(html).toContain('aria-label="Open src/app.ts"');
  });
});

describe('ChatBlockRenderer claude_terminal_sync_warning', () => {
  it('renders the warning copy', () => {
    const block: DisplayBlock = {
      type: 'claude_terminal_sync_warning',
      timestamp: 0,
      message: 'Transcript sync failed before fork.',
    };

    const html = render(block);

    expect(html).toContain('Claude Code transcript sync failed');
    expect(html).toContain('Transcript sync failed before fork.');
  });
});

describe('ChatBlockRenderer answered AskUserQuestion', () => {
  it('leaves pending Pipeline Editor questions to the composer dock', () => {
    const block: DisplayBlock = {
      type: 'tool_use',
      toolUseId: 'codex-call-1',
      toolName: 'canopy_pipeline_editor_ask_user_question',
      input: JSON.stringify({
        questions: [{ question: 'Which pipeline?', options: ['Build'] }],
      }),
    };
    const pending: PendingQuestion = {
      requestId: 'question-1',
      projectId: 'pipeline-editor',
      worktreeId: 'pipeline-editor',
      chatId: 'chat-1',
      toolUseId: 'codex-call-1',
      questions: [{ question: 'Which pipeline?', options: ['Build'] }],
    };

    const html = render(block, [pending]);

    expect(html).not.toContain('data-testid="ask-user-question-card"');
    expect(html).not.toContain('Preparing question');
  });

  it('renders an async submission once with the existing User Questions result presentation', () => {
    const block: DisplayBlock = {
      type: 'text',
      text: 'Q: Which scope?\nA: Full',
      ...{
        asyncQuestionAnswer: {
          requestId: 'request',
          startsTurn: false,
          answers: [{ question: 'Which scope?', selectedOptions: ['Full'] }],
        },
      },
    };
    const html = render(block);
    expect(html).toContain('User questions');
    expect(html).toContain('data-testid="answered-questions"');
    expect(html).not.toContain('Q: Which scope?');
  });

  it('removes the old async form once the answer has its own timeline entry', () => {
    const html = render(
      {
        type: 'text',
        text: 'Which scope?',
        asyncQuestion: {
          requestId: 'request',
          questions: [{ title: 'Which scope?', options: ['Full'] }],
        },
      },
      [
        {
          requestId: 'request',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          delivery: 'async',
          questions: [{ question: 'Which scope?', options: ['Full'] }],
          answeredAt: 20,
          answers: [{ question: 'Which scope?', selectedOptions: ['Full'] }],
        },
      ],
    );
    expect(html).toBe('');
  });

  it('keeps the original tool row and appends answers inline below it', () => {
    const block: DisplayBlock = {
      type: 'tool_use',
      toolUseId: 'ask-1',
      toolName: 'AskUserQuestion',
      input: JSON.stringify({
        questions: [{ question: 'Which color?', options: ['Blue', 'Green'] }],
      }),
      result: { output: 'Q: Which color?\nA: Blue', isError: false },
    };

    const html = render(block);

    // Previous collapsed tool block is preserved...
    expect(html).toContain('User questions');
    // ...and the new answer bubbles render after it.
    expect(html).toContain('data-testid="answered-questions"');
    expect(html).toContain('Which color?');
    expect(html).toContain('Blue');
    // The tool row appears before the answer bubbles in the DOM.
    expect(html.indexOf('User questions')).toBeLessThan(
      html.indexOf('data-testid="answered-questions"'),
    );
  });

  it('includes free-form Additional text in the answer body', () => {
    const block: DisplayBlock = {
      type: 'tool_use',
      toolUseId: 'ask-2',
      toolName: 'AskUserQuestion',
      input: JSON.stringify({
        questions: [{ question: 'Anything else?', options: ['No'] }],
      }),
      result: {
        output: 'Q: Anything else?\nA: Other\nAdditional: A custom reply',
        isError: false,
      },
    };

    const html = render(block);

    expect(html).toContain('data-testid="answered-questions"');
    expect(html).toContain('A custom reply');
  });

  it('renders standalone Additional text as the answer body', () => {
    const block: DisplayBlock = {
      type: 'tool_use',
      toolUseId: 'ask-empty-additional',
      toolName: 'AskUserQuestion',
      input: JSON.stringify({
        questions: [{ question: 'Anything else?' }],
      }),
      result: {
        output: 'Q: Anything else?\nA: \nAdditional: Just this',
        isError: false,
      },
    };

    const html = render(block);

    expect(html).toContain('Just this');
    expect(html).not.toContain('No selection');
    expect(html).not.toContain(' — Just this');
    expect(html).not.toContain('No selectionJust this');
  });

  it('falls back to the generic tool card when the answer errored', () => {
    const block: DisplayBlock = {
      type: 'tool_use',
      toolUseId: 'ask-3',
      toolName: 'AskUserQuestion',
      input: JSON.stringify({
        questions: [{ question: 'Which color?', options: ['Blue'] }],
      }),
      result: { output: 'User dismissed the question.', isError: true },
    };

    const html = render(block);

    expect(html).not.toContain('data-testid="answered-questions"');
    expect(html).toContain('User questions');
  });
});

describe('ChatBlockRenderer tool icons', () => {
  it('renders Codex file delete tool calls with the trash icon', () => {
    const block: DisplayBlock = {
      type: 'tool_use',
      toolUseId: 'codex-delete-1',
      toolName: 'file_change',
      input: 'delete: src/old-file.ts',
      result: { output: 'completed', isError: false },
    };

    const html = render(block);

    expect(html).toContain('Delete');
    expect(html).toContain('old-file.ts');
    expect(html).toContain(renderToStaticMarkup(<TrashIcon />));
  });
});

describe('parseCanopyProxyError', () => {
  // Mirrors the field order `writeProxyError` actually serializes: marker,
  // code, and correlation id first so they survive Codex truncating the body.
  const proxyBody = (code: string, correlationId = 'corr-abc-123'): string =>
    `unexpected status 502 Bad Gateway: ${JSON.stringify({
      error: {
        canopy_proxy: 'CANOPY_AI_CREDITS_PROXY',
        code,
        correlation_id: correlationId,
        message: 'AI Credits proxy could not reach the gateway.',
        attempts: 4,
        elapsed_ms: 3120,
      },
    })}`;

  it.each([
    'credentials_unavailable',
    'invalid_request',
    'proxy_internal_error',
    'upstream_unavailable',
    'work_owner_not_member',
  ])('parses the %s code with its correlation id', (code) => {
    expect(parseCanopyProxyError(proxyBody(code))).toEqual({
      code,
      message: 'AI Credits proxy could not reach the gateway.',
      correlationId: 'corr-abc-123',
    });
  });

  // The correlation id is the only actionable detail the user is asked to
  // report, and for `invalid_request`/`proxy_internal_error` it is the notice's
  // sole action — so it must survive truncation, not just the code. This is
  // what pins the field order in `writeProxyError`.
  it('recovers code and correlation id from a body truncated mid-message', () => {
    const truncated =
      'unexpected status 502 Bad Gateway: {"error":{"canopy_proxy":"CANOPY_AI_CREDITS_PROXY","code":"upstream_unavailable","correlation_id":"corr-abc-123","message":"AI Credits proxy could not rea';

    expect(parseCanopyProxyError(truncated)).toEqual({
      code: 'upstream_unavailable',
      message: null,
      correlationId: 'corr-abc-123',
    });
  });

  // Truncation before the id still degrades gracefully to a code-only notice.
  it('still recovers the code when the body is truncated before the id', () => {
    const truncated =
      'unexpected status 502 Bad Gateway: {"error":{"canopy_proxy":"CANOPY_AI_CREDITS_PROXY","code":"upstream_unavailable","correlation_i';

    expect(parseCanopyProxyError(truncated)).toEqual({
      code: 'upstream_unavailable',
      message: null,
      correlationId: null,
    });
  });

  it.each([
    ['a passed-through upstream 5xx', 'unexpected status 503: upstream busy'],
    [
      'the concurrency guard 503',
      'unexpected status 503: {"error":"Another request is already in flight"}',
    ],
    ['a plain message', 'Codex is not authenticated.'],
  ])('returns null for %s', (_label, message) => {
    expect(parseCanopyProxyError(message)).toBeNull();
  });

  // A marker-bearing body whose `code` we do not recognize must NOT fall back
  // to the plain-text path: that path renders the raw JSON, which is exactly
  // what the marker contract forbids. The codes are a closed set maintained
  // alongside the proxy, so an unknown one means the proxy grew a code the
  // renderer has not learned yet — degrade to the generic notice rather than
  // failing open and putting `{"error":{"canopy_proxy":...}}` in front of a user.
  it('degrades an unrecognized proxy code to the generic notice', () => {
    expect(
      parseCanopyProxyError(
        'CANOPY_AI_CREDITS_PROXY {"error":{"code":"something_else","correlation_id":"corr-9"}}',
      ),
    ).toEqual({
      code: 'proxy_internal_error',
      message: null,
      correlationId: 'corr-9',
    });
  });
});

describe('ChatBlockRenderer AI Credits proxy notice', () => {
  const proxyFailureText = (code: string): string =>
    `unexpected status 502 Bad Gateway: ${JSON.stringify({
      error: {
        canopy_proxy: 'CANOPY_AI_CREDITS_PROXY',
        code,
        message: 'AI Credits proxy could not reach the gateway.',
        attempts: 4,
        elapsed_ms: 3120,
        correlation_id: 'corr-abc-123',
      },
    })}`;

  const systemBlock = (code: string): DisplayBlock => ({
    type: 'text',
    text: proxyFailureText(code),
  });

  /**
   * The failure as it actually lands in the transcript: a `system` message
   * carrying the structured body. Retry is gated on this still being the last
   * message, so fixtures that omit it are not modelling the real surface.
   */
  const proxyFailureMessage = (
    code: string,
    timestamp: number,
  ): ChatTab['messages'][number] => ({
    id: `system-proxy-${String(timestamp)}`,
    role: 'system',
    blocks: [{ type: 'text', text: proxyFailureText(code) }],
    timestamp,
  });

  it('renders the clean notice with the correlation id instead of raw JSON', () => {
    const html = render(
      systemBlock('upstream_unavailable'),
      undefined,
      false,
      true,
    );

    expect(html).toContain('data-testid="chat-canopy-proxy-error"');
    expect(html).toContain('The AI provider didn&#x27;t respond');
    expect(html).toContain('corr-abc-123');
    expect(html).toContain('data-testid="chat-canopy-proxy-error-retry"');
    expect(html).not.toContain('CANOPY_AI_CREDITS_PROXY');
    expect(html).not.toContain('elapsed_ms');
    expect(html).not.toContain('502');
  });

  it('offers the account settings CTA rather than a provider sign-in CTA', () => {
    const html = render(
      systemBlock('credentials_unavailable'),
      undefined,
      false,
      true,
    );

    expect(html).toContain(
      'data-testid="chat-canopy-proxy-error-open-settings"',
    );
    expect(html).not.toContain('data-testid="chat-connection-cta-codex"');
  });

  it.each(['invalid_request', 'proxy_internal_error'])(
    'offers only the copy-id action for %s',
    (code) => {
      const html = render(systemBlock(code), undefined, false, true);

      expect(html).toContain('data-testid="chat-canopy-proxy-error-copy-id"');
      expect(html).not.toContain('data-testid="chat-canopy-proxy-error-retry"');
      expect(html).not.toContain(
        'data-testid="chat-canopy-proxy-error-open-settings"',
      );
    },
  );

  // CAN-3462: the hosted proxy refuses work owned by an organization the user
  // has left. Retrying hits the same refusal, so the notice offers the
  // Organizations list beside the id.
  it('explains an organization owner refusal with View organizations and the id', () => {
    const html = render(
      systemBlock('work_owner_not_member'),
      undefined,
      false,
      true,
    );

    expect(html).toContain('data-testid="chat-canopy-proxy-error"');
    expect(html).toContain('You&#x27;re no longer in this organization');
    expect(html).toContain('data-testid="chat-canopy-proxy-error-copy-id"');
    expect(html).toContain(
      'data-testid="chat-canopy-proxy-error-view-organizations"',
    );
    expect(html).not.toContain('data-testid="chat-canopy-proxy-error-retry"');
    expect(html).not.toContain(
      'data-testid="chat-canopy-proxy-error-open-settings"',
    );
    expect(html).not.toContain(
      'data-testid="chat-canopy-proxy-error-get-credits"',
    );
    expect(html).not.toContain('CANOPY_AI_CREDITS_PROXY');
    expect(html).not.toContain('work_owner_not_member');
  });

  // CAN-2413: the reported failure. A marked 402 used to fall through to the
  // raw Markdown renderer, so the user saw `{"error":"no_billing_source"}` and
  // a loopback URL with no way to act on either.
  it('offers the credits CTA and no Retry for a spent credit balance', () => {
    const html = render(
      systemBlock('no_billing_source'),
      undefined,
      false,
      true,
    );

    expect(html).toContain('data-testid="chat-canopy-proxy-error"');
    expect(html).toContain('data-testid="chat-canopy-proxy-error-get-credits"');
    expect(html).toContain('Get AI Credits');
    expect(html).toContain('This message needed AI Credits');
    // Retry would fail identically until credits exist, and each click bills a
    // fresh non-idempotent turn against the same wall.
    expect(html).not.toContain('data-testid="chat-canopy-proxy-error-retry"');
    expect(html).not.toContain('CANOPY_AI_CREDITS_PROXY');
    expect(html).not.toContain('no_billing_source');
    expect(html).not.toContain('402');
  });

  // CAN-4028: a signed-in account that has not made a card purchase. The
  // remedy is the purchase, so this is neither the credits CTA nor Retry.
  it('offers the purchase and no Retry for a locked model', () => {
    const html = render(systemBlock('model_locked'), undefined, false, true);

    expect(html).toContain('data-testid="chat-canopy-proxy-error"');
    expect(html).toContain('This model needs an AI Credit purchase');
    expect(html).toContain(
      'Purchase AI Credits to unlock advanced models, then send your message again.',
    );
    expect(html).toContain('data-testid="chat-canopy-proxy-error-unlock"');
    expect(html).toContain('Purchase AI Credits');
    expect(html).not.toContain('data-testid="chat-canopy-proxy-error-retry"');
    // Not the coverage flow: that one reports success on any spendable credit.
    expect(html).not.toContain(
      'data-testid="chat-canopy-proxy-error-get-credits"',
    );
    expect(html).not.toContain('CANOPY_AI_CREDITS_PROXY');
    expect(html).not.toContain('model_locked');
  });

  // The account here HOLDS spendable credits (the daily free ones), which is
  // exactly the state the `no_billing_source` flow would report as "your
  // credits are available again". For a locked model that would be false, so
  // the click must go to checkout instead.
  it('opens purchase recovery for a locked model even when credits are spendable', async () => {
    const originalApi = Object.getOwnPropertyDescriptor(window, 'api');
    const loadNativeAiCreditsAvailability = jest.fn().mockResolvedValue({
      personalEligible: true,
      inOrg: false,
      orgCreditPoolCovered: false,
      orgSpendable: false,
      pricingUrl: 'https://cloud.example.com/pricing',
    });
    const openAuthenticatedPortalPage = jest
      .fn<Promise<boolean>, [string]>()
      .mockResolvedValue(true);
    const openExternal = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadNativeAiCreditsAvailability,
        loadCanopyCloudAccount: jest.fn().mockResolvedValue({
          hasApiKey: true,
          account: { id: 'acct_1' },
          authMode: 'oauth',
          credentialSource: 'oauth',
        }),
        loadCanopyCloudEntitlements: jest.fn().mockResolvedValue({
          resolved: true,
          modelLibrary: { status: 'reported', access: 'needs_purchase' },
          modelLibraryAccountKey: 'account:acct_1',
          modelLibraryOwnerKey: 'personal',
          workModelLibrary: { status: 'reported', access: 'needs_purchase' },
        }),
        openAuthenticatedPortalPage,
        browser: { openExternal },
      },
    });
    invalidateSharedAiCreditsRead();
    resetModelLibraryAccessForTests();
    resetModelUnlockIntentForTests();

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const query = (testId: string): HTMLElement | null =>
      container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

    try {
      await act(async () => {
        root.render(
          <ChatBlockRenderer
            block={systemBlock('model_locked')}
            isSystemMessage
          />,
        );
        await Promise.resolve();
      });

      // Like the billing branch, nothing is read until the user asks.
      expect(loadNativeAiCreditsAvailability).not.toHaveBeenCalled();
      expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();

      await act(async () => {
        query('chat-canopy-proxy-error-unlock')?.click();
        for (let i = 0; i < 12; i += 1) {
          await Promise.resolve();
        }
      });

      expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
      const url = new URL(
        openAuthenticatedPortalPage.mock.calls[0][0],
        'https://billing.invalid',
      );
      expect(url.pathname).toBe('/account/billing');
      expect(url.searchParams.get('topUp')).toBe('1');
      expect(url.searchParams.get('reason')).toBe('unlock_models');
      expect(url.searchParams.get('source')).toBe('desktop');
      // The chat is already on the refused model, so none is named to apply.
      expect(url.searchParams.has('modelId')).toBe(false);
      expect(openExternal).not.toHaveBeenCalled();

      expect(query('chat-canopy-proxy-error-unlock-waiting')?.textContent).toBe(
        "Finish in your browser. We'll check when your payment completes.",
      );
      expect(query('chat-canopy-proxy-error-credits-recovered')).toBeNull();

      // Confirmed by the app root's poll for this purchase.
      expect(useModelUnlockIntentStore.getState().intent).toMatchObject({
        requestId: url.searchParams.get('requestId'),
        accountId: 'account:acct_1',
        owner: 'personal',
      });
      act(() => {
        useModelUnlockIntentStore.setState({ phase: 'unlocked' });
      });
      expect(
        query('chat-canopy-proxy-error-unlock-confirmed')?.textContent,
      ).toBe('Advanced models are unlocked.');
      // The purchase is done; the next send is the user's to make.
      expect(query('chat-canopy-proxy-error-unlock')).toBeNull();
      expect(query('chat-canopy-proxy-error-retry')).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
      resetModelUnlockIntentForTests();
      resetModelLibraryAccessForTests();
      invalidateSharedAiCreditsRead();
      if (originalApi) {
        Object.defineProperty(window, 'api', originalApi);
      } else {
        Reflect.deleteProperty(window, 'api');
      }
    }
  });

  // CAN-2413 review: the hosted `billed: null` behind this 402 fires for an org
  // member whose eligible pool is empty just as much as for an uncovered
  // individual, and those members cannot buy credits. The notice used to offer
  // an unconditional "Get AI Credits", marching them into a billing flow they
  // have no way to finish — while the composer banner, which does read
  // coverage, correctly told them to contact their admin. The two surfaces
  // disagreed about the same failure. The read is lazy (on click, not on
  // render) so a long transcript full of historical notices still fires no IPC.
  it('routes an org member to their admin instead of a billing flow', async () => {
    const originalApi = Object.getOwnPropertyDescriptor(window, 'api');
    const loadNativeAiCreditsAvailability = jest.fn().mockResolvedValue({
      personalEligible: false,
      inOrg: true,
      orgCreditPoolCovered: true,
      orgSpendable: false,
      pricingUrl: 'https://cloud.example.com/pricing',
    });
    const openAuthenticatedPortalPage = jest.fn().mockResolvedValue(undefined);
    const openExternal = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadNativeAiCreditsAvailability,
        openAuthenticatedPortalPage,
        browser: { openExternal },
      },
    });

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <ChatBlockRenderer
            block={systemBlock('no_billing_source')}
            isSystemMessage
          />,
        );
        await Promise.resolve();
      });

      // Nothing is read until the user actually asks for credits.
      expect(loadNativeAiCreditsAvailability).not.toHaveBeenCalled();

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="chat-canopy-proxy-error-get-credits"]',
          )
          ?.click();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(loadNativeAiCreditsAvailability).toHaveBeenCalledTimes(1);
      expect(
        container.querySelector(
          '[data-testid="chat-canopy-proxy-error-contact-admin"]',
        )?.textContent,
      ).toContain('Contact your org admin');
      expect(
        container.querySelector(
          '[data-testid="chat-canopy-proxy-error-get-credits"]',
        ),
      ).toBeNull();

      // The admin copy must keep a live action beside it. Replacing the button
      // outright made the state a one-way latch for the life of the mounted
      // block, so a member whose admin had since raised the quota had no way
      // back to a usable action. "Check again" re-runs the same read.
      loadNativeAiCreditsAvailability.mockResolvedValue({
        personalEligible: true,
        inOrg: true,
        orgCreditPoolCovered: true,
        orgSpendable: false,
        pricingUrl: 'https://cloud.example.com/pricing',
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="chat-canopy-proxy-error-recheck-credits"]',
          )
          ?.click();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(loadNativeAiCreditsAvailability).toHaveBeenCalledTimes(2);
      expect(
        container.querySelector(
          '[data-testid="chat-canopy-proxy-error-contact-admin"]',
        ),
      ).toBeNull();

      // Coverage came back spendable, so the recheck must report recovery —
      // NOT fall through and open billing. `canSpendCredits: true` leaves both
      // `showPurchase` and `showContactAdmin` false, the same shape as an
      // inconclusive read, so it has to be checked explicitly.
      expect(
        container.querySelector(
          '[data-testid="chat-canopy-proxy-error-credits-recovered"]',
        )?.textContent,
      ).toContain('available again');
      expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
      expect(openExternal).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      container.remove();
      if (originalApi) {
        Object.defineProperty(window, 'api', originalApi);
      } else {
        Reflect.deleteProperty(window, 'api');
      }
    }
  });

  // Transcript blocks unmount routinely on tab switch / navigation. The lazy
  // coverage read awaits IPC, and `getAiCredits` enters the APP-WIDE cloud
  // connect gate — so an unguarded continuation could pop a billing flow in
  // whatever the user navigated to, or clobber another surface's pending
  // connect request.
  it('does not hand off to billing when the notice unmounts mid-read', async () => {
    const originalApi = Object.getOwnPropertyDescriptor(window, 'api');
    let resolveRead: (value: NativeAiCreditsAvailability) => void = () => {};
    const loadNativeAiCreditsAvailability = jest.fn(
      () =>
        new Promise<NativeAiCreditsAvailability>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const openAuthenticatedPortalPage = jest.fn().mockResolvedValue(undefined);
    const openExternal = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadNativeAiCreditsAvailability,
        openAuthenticatedPortalPage,
        browser: { openExternal },
      },
    });

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <ChatBlockRenderer
            block={systemBlock('no_billing_source')}
            isSystemMessage
          />,
        );
        await Promise.resolve();
      });

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="chat-canopy-proxy-error-get-credits"]',
          )
          ?.click();
        await Promise.resolve();
      });

      // Navigate away while the coverage read is still in flight.
      act(() => root.unmount());

      await act(async () => {
        resolveRead({
          personalEligible: false,
          inOrg: false,
          orgCreditPoolCovered: false,
          orgSpendable: false,
          pricingUrl: 'https://cloud.example.com/pricing',
        });
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
      expect(openExternal).not.toHaveBeenCalled();
    } finally {
      container.remove();
      if (originalApi) {
        Object.defineProperty(window, 'api', originalApi);
      } else {
        Reflect.deleteProperty(window, 'api');
      }
    }
  });

  it('leaves an unmarked upstream failure on the plain text path', () => {
    const html = render(
      { type: 'text', text: 'unexpected status 503: upstream busy' },
      undefined,
      false,
      true,
    );

    expect(html).not.toContain('data-testid="chat-canopy-proxy-error"');
    expect(html).toContain('upstream busy');
  });

  it('does not render the notice for non-system messages', () => {
    const html = render(systemBlock('upstream_unavailable'));

    expect(html).not.toContain('data-testid="chat-canopy-proxy-error"');
  });

  // Retry must not replay the original prompt once the agent has done work in
  // the turn: the gateway can fail on a later model call, after tool calls
  // already succeeded, and replaying would repeat those side effects.
  it('resolves to Continue when the failed turn already has agent activity', async () => {
    const originalState = useChatStore.getState();
    const sendMessage = jest.fn().mockResolvedValue(undefined);
    const tab: ChatTab = {
      id: 'chat-1',
      title: 'Chat',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'Finish the original request' }],
          timestamp: 1,
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Partial work before the failure' }],
          timestamp: 2,
        },
        proxyFailureMessage('upstream_unavailable', 3),
      ],
      status: 'idle',
      error: null,
      createdAt: '2026-08-20T00:00:00.000Z',
      queuedMessages: [],
      planMode: false,
      proposalMode: 'optional',
      thinkingLevel: 'high',
      modelConfig: { thinkingLevel: 'high', fastMode: false },
      fastModeExplicit: false,
      model: 'gpt-6-sol',
      providerType: 'codex',
    };
    useChatStore.setState({
      sendMessage,
      worktreeChats: {
        'project-1/worktree-1': { activeTabId: tab.id, tabs: [tab] },
      },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <ChatBlockRenderer
            block={systemBlock('upstream_unavailable')}
            isSystemMessage
            originChatTabId={tab.id}
          />,
        );
        await Promise.resolve();
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="chat-canopy-proxy-error-retry"]',
          )
          ?.click();
        await Promise.resolve();
      });

      expect(sendMessage).toHaveBeenCalledWith(
        'Continue',
        undefined,
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
        },
        'typed',
        {},
      );
    } finally {
      act(() => root.unmount());
      container.remove();
      useChatStore.setState({
        sendMessage: originalState.sendMessage,
        worktreeChats: originalState.worktreeChats,
      });
    }
  });

  // The other half of the contract: when the turn was only a user prompt that
  // never reached the model, re-sending it is the correct recovery.
  it('re-sends the last user message when the failed turn has no agent activity', async () => {
    const originalState = useChatStore.getState();
    const sendMessage = jest.fn().mockResolvedValue(undefined);
    const tab: ChatTab = {
      id: 'chat-1',
      title: 'Chat',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'Finish the original request' }],
          timestamp: 1,
        },
        proxyFailureMessage('upstream_unavailable', 2),
      ],
      status: 'idle',
      error: null,
      createdAt: '2026-08-20T00:00:00.000Z',
      queuedMessages: [],
      planMode: false,
      proposalMode: 'optional',
      thinkingLevel: 'high',
      modelConfig: { thinkingLevel: 'high', fastMode: false },
      fastModeExplicit: false,
      model: 'gpt-6-sol',
      providerType: 'codex',
    };
    useChatStore.setState({
      sendMessage,
      worktreeChats: {
        'project-1/worktree-1': { activeTabId: tab.id, tabs: [tab] },
      },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <ChatBlockRenderer
            block={systemBlock('upstream_unavailable')}
            isSystemMessage
            originChatTabId={tab.id}
          />,
        );
        await Promise.resolve();
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="chat-canopy-proxy-error-retry"]',
          )
          ?.click();
        await Promise.resolve();
      });

      expect(sendMessage).toHaveBeenCalledWith(
        'Finish the original request',
        undefined,
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
        },
        'typed',
        {},
      );
    } finally {
      act(() => root.unmount());
      container.remove();
      useChatStore.setState({
        sendMessage: originalState.sendMessage,
        worktreeChats: originalState.worktreeChats,
      });
    }
  });

  // Retry dispatches a BILLED, non-idempotent turn, and this notice lives in
  // the transcript forever. Once the chat has moved past the failure — a manual
  // retry finished, or `transient-error-retry-service` recovered it — the tab
  // returns to `idle`, so a gate that only checks `streaming` would let this
  // historical button go live again and charge for a problem already resolved.
  //
  // Deliberately asserts the tab is `idle` and that no dispatch occurs, rather
  // than just `disabled`: `disabled` is also true during the in-flight window,
  // so asserting it alone would not distinguish this gate from that one.
  it('does not re-dispatch from a notice the chat has already moved past', async () => {
    const originalState = useChatStore.getState();
    const sendMessage = jest.fn().mockResolvedValue(undefined);
    const tab: ChatTab = {
      id: 'chat-1',
      title: 'Chat',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'Finish the original request' }],
          timestamp: 1,
        },
        proxyFailureMessage('upstream_unavailable', 2),
        // The recovery that already happened: the chat continued past the
        // failure, so this notice is now history.
        {
          id: 'user-2',
          role: 'user',
          blocks: [{ type: 'text', text: 'Continue' }],
          timestamp: 3,
        },
        {
          id: 'assistant-2',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Recovered and finished the work' }],
          timestamp: 4,
        },
      ],
      status: 'idle',
      error: null,
      createdAt: '2026-08-20T00:00:00.000Z',
      queuedMessages: [],
      planMode: false,
      proposalMode: 'optional',
      thinkingLevel: 'high',
      modelConfig: { thinkingLevel: 'high', fastMode: false },
      fastModeExplicit: false,
      model: 'gpt-6-sol',
      providerType: 'codex',
    };
    useChatStore.setState({
      sendMessage,
      worktreeChats: {
        'project-1/worktree-1': { activeTabId: tab.id, tabs: [tab] },
      },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <ChatBlockRenderer
            block={systemBlock('upstream_unavailable')}
            isSystemMessage
            originChatTabId={tab.id}
          />,
        );
        await Promise.resolve();
      });

      const retry = container.querySelector<HTMLButtonElement>(
        '[data-testid="chat-canopy-proxy-error-retry"]',
      );
      expect(retry).not.toBeNull();
      expect(retry?.disabled).toBe(true);

      await act(async () => {
        retry?.click();
        await Promise.resolve();
      });

      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      container.remove();
      useChatStore.setState({
        sendMessage: originalState.sendMessage,
        worktreeChats: originalState.worktreeChats,
      });
    }
  });

  // The parser deliberately accepts bodies Codex truncated before
  // `correlation_id` ever appeared (see the truncation cases above), so the
  // "is this still the current failure" gate must NOT key on the correlation
  // id — a notice without one would otherwise stay retryable forever and could
  // dispatch a second billed turn long after the chat recovered. Identity is
  // the notice's raw source text instead.
  it('does not re-dispatch from a truncated notice that has no correlation id', async () => {
    const originalState = useChatStore.getState();
    const sendMessage = jest.fn().mockResolvedValue(undefined);
    const truncatedText =
      'unexpected status 502 Bad Gateway: {"error":{"canopy_proxy":"CANOPY_AI_CREDITS_PROXY","code":"upstream_unavailable"';
    const truncatedBlock: DisplayBlock = {
      type: 'text',
      text: truncatedText,
    };
    const tab: ChatTab = {
      id: 'chat-1',
      title: 'Chat',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'Finish the original request' }],
          timestamp: 1,
        },
        {
          id: 'system-truncated',
          role: 'system',
          blocks: [{ type: 'text', text: truncatedText }],
          timestamp: 2,
        },
        // The chat already recovered past that failure.
        {
          id: 'user-2',
          role: 'user',
          blocks: [{ type: 'text', text: 'Continue' }],
          timestamp: 3,
        },
        {
          id: 'assistant-2',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Recovered and finished the work' }],
          timestamp: 4,
        },
      ],
      status: 'idle',
      error: null,
      createdAt: '2026-08-20T00:00:00.000Z',
      queuedMessages: [],
      planMode: false,
      proposalMode: 'optional',
      thinkingLevel: 'high',
      modelConfig: { thinkingLevel: 'high', fastMode: false },
      fastModeExplicit: false,
      model: 'gpt-6-sol',
      providerType: 'codex',
    };
    useChatStore.setState({
      sendMessage,
      worktreeChats: {
        'project-1/worktree-1': { activeTabId: tab.id, tabs: [tab] },
      },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <ChatBlockRenderer
            block={truncatedBlock}
            isSystemMessage
            originChatTabId={tab.id}
          />,
        );
        await Promise.resolve();
      });

      const retry = container.querySelector<HTMLButtonElement>(
        '[data-testid="chat-canopy-proxy-error-retry"]',
      );
      expect(retry).not.toBeNull();
      expect(retry?.disabled).toBe(true);

      await act(async () => {
        retry?.click();
        await Promise.resolve();
      });

      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      container.remove();
      useChatStore.setState({
        sendMessage: originalState.sendMessage,
        worktreeChats: originalState.worktreeChats,
      });
    }
  });

  // The positive half of the same contract: a truncated notice that IS still
  // the chat's last message must remain actionable.
  it('still allows retry from a truncated notice that is the current failure', async () => {
    const originalState = useChatStore.getState();
    const sendMessage = jest.fn().mockResolvedValue(undefined);
    const truncatedText =
      'unexpected status 502 Bad Gateway: {"error":{"canopy_proxy":"CANOPY_AI_CREDITS_PROXY","code":"upstream_unavailable"';
    const truncatedBlock: DisplayBlock = {
      type: 'text',
      text: truncatedText,
    };
    const tab: ChatTab = {
      id: 'chat-1',
      title: 'Chat',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'Finish the original request' }],
          timestamp: 1,
        },
        {
          id: 'system-truncated',
          role: 'system',
          blocks: [{ type: 'text', text: truncatedText }],
          timestamp: 2,
        },
      ],
      status: 'idle',
      error: null,
      createdAt: '2026-08-20T00:00:00.000Z',
      queuedMessages: [],
      planMode: false,
      proposalMode: 'optional',
      thinkingLevel: 'high',
      modelConfig: { thinkingLevel: 'high', fastMode: false },
      fastModeExplicit: false,
      model: 'gpt-6-sol',
      providerType: 'codex',
    };
    useChatStore.setState({
      sendMessage,
      worktreeChats: {
        'project-1/worktree-1': { activeTabId: tab.id, tabs: [tab] },
      },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <ChatBlockRenderer
            block={truncatedBlock}
            isSystemMessage
            originChatTabId={tab.id}
          />,
        );
        await Promise.resolve();
      });

      const retry = container.querySelector<HTMLButtonElement>(
        '[data-testid="chat-canopy-proxy-error-retry"]',
      );
      expect(retry?.disabled).toBe(false);

      await act(async () => {
        retry?.click();
        await Promise.resolve();
      });

      expect(sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
      container.remove();
      useChatStore.setState({
        sendMessage: originalState.sendMessage,
        worktreeChats: originalState.worktreeChats,
      });
    }
  });
});

/**
 * Canopy answers `ExitPlanMode` with `behavior: 'deny'` and `interrupt: true`
 * so the plan routes into Canopy's own review UI. The renderer has always
 * hidden that by drawing `input.plan` as markdown and never reading the result.
 * CAN-3019 moved the input parsing into the shared
 * `extractExitPlanModePlan` helper so the web transcripts can hide it too;
 * these pin desktop's behavior across that swap.
 */
describe('ChatBlockRenderer plan mode', () => {
  it('renders the plan markdown for ExitPlanMode', () => {
    const html = render({
      type: 'tool_use',
      toolUseId: 'plan-1',
      toolName: 'ExitPlanMode',
      input: JSON.stringify({ plan: '# Ship it\n\nStep one.' }),
    });

    expect(html).toContain('Ship it');
    expect(html).toContain('Step one.');
    expect(html).not.toContain('ExitPlanMode');
  });

  it('renders nothing for EnterPlanMode', () => {
    expect(
      render({
        type: 'tool_use',
        toolUseId: 'plan-2',
        toolName: 'EnterPlanMode',
        input: '{}',
      }),
    ).toBe('');
  });

  it.each([
    ['no plan key', JSON.stringify({ other: 1 })],
    ['a non-string plan', JSON.stringify({ plan: 42 })],
    ['an empty plan', JSON.stringify({ plan: '' })],
    ['malformed JSON', 'not json'],
  ])('renders nothing for ExitPlanMode with %s', (_label, input) => {
    expect(
      render({
        type: 'tool_use',
        toolUseId: 'plan-3',
        toolName: 'ExitPlanMode',
        input,
      }),
    ).toBe('');
  });
});

describe('ChatBlockRenderer approval_resolution_info', () => {
  // CAN-3083: the receipt for an approval released by widening the mode,
  // rather than by the user clicking the card.
  it('names the mode that released the approval and lists what it covered', () => {
    const html = render({
      type: 'approval_resolution_info',
      timestamp: Date.parse('2026-09-22T15:42:00Z'),
      resolvedBy: 'mode-change',
      mode: 'full-access',
      previousMode: 'ask',
      titles: ['ls apps/web/src/app/'],
    });

    expect(html).toContain('Approved by switching to Full access');
    expect(html).toContain('ls apps/web/src/app/');
  });

  it('does not credit a mode switch when none was recorded', () => {
    // Main omits `previousMode` when the release was not a widening — a rule
    // that landed while the card sat there, or a clamp settling on the mode
    // the chat was already in. Saying "by switching to" there names the wrong
    // authority.
    const html = render({
      type: 'approval_resolution_info',
      timestamp: Date.parse('2026-09-22T15:42:00Z'),
      resolvedBy: 'mode-change',
      mode: 'auto',
      titles: ['ls apps/web/src/app/'],
    });

    expect(html).toContain('Approved under Accept edits');
    expect(html).not.toContain('by switching to');
  });

  it('counts the batch when one mode change released several approvals', () => {
    const html = render({
      type: 'approval_resolution_info',
      timestamp: Date.parse('2026-09-22T15:42:00Z'),
      resolvedBy: 'mode-change',
      mode: 'auto',
      previousMode: 'ask',
      titles: ['Write src/a.ts', 'Write src/b.ts'],
    });

    expect(html).toContain('Approved 2 requests by switching to Accept edits');
    expect(html).toContain('Write src/a.ts');
    expect(html).toContain('Write src/b.ts');
  });

  it('counts the batch without crediting a switch when none was recorded', () => {
    // Fourth corner of the switch x count matrix.
    const html = render({
      type: 'approval_resolution_info',
      timestamp: Date.parse('2026-09-22T15:42:00Z'),
      resolvedBy: 'mode-change',
      mode: 'auto',
      titles: ['Write src/a.ts', 'Write src/b.ts'],
    });

    expect(html).toContain('Approved 2 requests under Accept edits');
    expect(html).not.toContain('by switching to');
  });
});

describe('ChatBlockRenderer delegated task Stop', () => {
  const target = {
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
  };
  const stop = jest.fn();
  const addToast = jest.fn();
  let originalApi: PropertyDescriptor | undefined;
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  function delegatedBlock(
    status: 'pending' | 'running' | 'cancelled' | 'completed',
  ): DisplayBlock {
    return {
      type: 'delegated_agent_call',
      agentBlockId: 'delegated-agent-child',
      delegationId: 'child',
      parentTurnId: 'turn',
      sequence: 1,
      createdAt: 1,
      selectedModelId: 'sonnet',
      runtimeModelId: 'sonnet',
      targetHarnessId: 'claude',
      parentToolCallId: 'spawn-child',
      parentHarnessId: 'claude',
      description: 'Review source',
      prompt: 'Review source',
      executionMode: 'background',
      status,
      runGeneration: 1,
      outputTruncated: false,
      subBlocks: [],
    };
  }

  function renderBlock(
    block: DisplayBlock,
    withLiveDescendants: readonly string[] | null = [],
  ): void {
    act(() => {
      root.render(
        <ManagedDelegationStopContext.Provider
          value={
            withLiveDescendants
              ? { target, withLiveDescendants: new Set(withLiveDescendants) }
              : null
          }
        >
          <ChatBlockRenderer block={block} originChatTabId="chat-1" />
        </ManagedDelegationStopContext.Provider>,
      );
    });
  }

  function stopButton(): HTMLButtonElement | null {
    return host.querySelector<HTMLButtonElement>(
      '[data-testid="delegated-agent-stop"]',
    );
  }

  beforeEach(() => {
    stop.mockReset();
    addToast.mockReset();
    useGitHubStore.setState({ addToast });
    originalApi = Object.getOwnPropertyDescriptor(window, 'api');
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { managedDelegation: { stop, stopAll: jest.fn() } },
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    if (originalApi) Object.defineProperty(window, 'api', originalApi);
    else Reflect.deleteProperty(window, 'api');
  });

  it('stops a live delegation of this chat as the user', async () => {
    stop.mockResolvedValue({ ok: true });
    renderBlock(delegatedBlock('running'));
    await act(async () => {
      stopButton()?.click();
      await Promise.resolve();
    });
    expect(stop).toHaveBeenCalledWith({ ...target, delegationId: 'child' });
    expect(stopButton()?.textContent).toBe('Stopping…');
    expect(addToast).not.toHaveBeenCalled();
  });

  it('reports a failed stop and offers Stop again', async () => {
    stop.mockResolvedValue({ ok: false, error: 'The chat is unavailable.' });
    renderBlock(delegatedBlock('pending'));
    await act(async () => {
      stopButton()?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(addToast).toHaveBeenCalledWith(
      "Couldn't stop the delegation. The chat is unavailable.",
      'error',
      undefined,
      expect.objectContaining({ category: 'Chat', chatId: 'chat-1' }),
    );
    expect(stopButton()?.textContent).toBe('Stop');
  });

  it('says Stop also ends the tasks the delegation started', () => {
    renderBlock(delegatedBlock('running'), ['child']);
    act(() => {
      stopButton()?.parentElement?.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Stop delegation and the tasks it started',
    );
  });

  it('offers no Stop for settled delegations or outside a chat that can stop them', () => {
    renderBlock(delegatedBlock('cancelled'));
    expect(stopButton()).toBeNull();
    expect(host.textContent).toContain('Cancelled');
    renderBlock(delegatedBlock('running'), null);
    expect(stopButton()).toBeNull();
  });
});

describe('ChatBlockRenderer logged delegated task transcript', () => {
  const source = {
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
  };
  const transcript = jest.fn();
  let originalApi: PropertyDescriptor | undefined;
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  const loggedBlock: DisplayBlock = {
    type: 'delegated_agent_call',
    agentBlockId: 'delegated-agent-child',
    delegationId: 'child',
    parentTurnId: 'turn',
    sequence: 1,
    createdAt: 1,
    selectedModelId: 'sonnet',
    runtimeModelId: 'sonnet',
    targetHarnessId: 'claude',
    parentToolCallId: 'spawn-child',
    parentHarnessId: 'claude',
    description: 'Review source',
    prompt: 'Review source',
    executionMode: 'background',
    status: 'running',
    runGeneration: 1,
    outputTruncated: false,
    transcriptStore: 'chat-log-v1',
    routeSnapshot: {
      selectedModelId: 'sonnet',
      runtimeModelId: 'sonnet',
      harnessId: 'claude',
    },
    subBlocks: [],
  };

  async function renderLogged(): Promise<void> {
    await act(async () => {
      root.render(
        <DelegationTranscriptSourceContext.Provider value={source}>
          <ChatBlockRenderer block={loggedBlock} originChatTabId="chat-1" />
        </DelegationTranscriptSourceContext.Provider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Expand delegated task"]',
        )
        ?.click();
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    useDelegationTranscriptStore.getState().reset();
    transcript.mockReset().mockResolvedValue({
      ok: true,
      items: [
        {
          id: 'logged',
          type: 'text',
          text: 'Read from the delegate log',
          sequence: 1,
          occurredAt: 1,
        },
      ],
    });
    originalApi = Object.getOwnPropertyDescriptor(window, 'api');
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { managedDelegation: { transcript } },
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    if (originalApi) Object.defineProperty(window, 'api', originalApi);
    else Reflect.deleteProperty(window, 'api');
  });

  it('reads a logged card’s children from its delegate log', async () => {
    await renderLogged();
    expect(transcript).toHaveBeenCalledWith({
      ...source,
      delegationId: 'child',
      runGeneration: 1,
    });
    expect(host.textContent).toContain('Read from the delegate log');
  });

  it('keeps a mounted card’s transcript when other runs fill the cache', async () => {
    await renderLogged();
    expect(host.textContent).toContain('Read from the delegate log');
    await act(async () => {
      const { load } = useDelegationTranscriptStore.getState();
      for (let run = 0; run <= DELEGATION_TRANSCRIPT_RUN_LIMIT; run += 1)
        load(source, {
          delegationId: `other-${String(run)}`,
          runGeneration: 1,
        });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Read from the delegate log');
  });

  it('shows live progress that was never committed', async () => {
    await renderLogged();
    act(() => {
      useDelegationTranscriptStore.getState().applyLive(source, {
        delegationId: 'child',
        runGeneration: 1,
        sequence: 2,
        parentHarnessId: 'claude',
        parentTurnId: 'turn',
        parentToolCallId: 'spawn-child',
        createdAt: 1,
        transcriptStore: 'chat-log-v1',
        task: {
          description: 'Review source',
          prompt: 'Review source',
          executionMode: 'background',
        },
        snapshot: {
          delegationId: 'child',
          status: 'running',
          outputTruncated: false,
          routeSnapshot: {
            selectedModelId: 'sonnet',
            runtimeModelId: 'sonnet',
            harnessId: 'claude',
          },
        },
        transcript: [
          {
            id: 'live',
            type: 'text',
            text: 'Streaming live progress',
            sequence: 1,
            occurredAt: 2,
          },
        ],
      });
    });
    expect(host.textContent).toContain('Streaming live progress');
    expect(host.textContent).not.toContain('Read from the delegate log');
  });
});

it('renders a formal assistant plan without changing quoted user text', () => {
  const block: DisplayBlock = {
    type: 'text',
    text: '<proposed_plan># Parser validation\n\nAdd input checks.</proposed_plan>',
  };
  expect(render(block, undefined, true)).not.toContain('proposed_plan');
  expect(render(block, undefined, false)).toContain('proposed_plan');
});

describe('CAN-4275 located links', () => {
  const scope = { projectId: 'project', worktreeId: 'worktree' };
  const index = buildFilePathMentionIndex(
    [
      {
        repoId: 'repo',
        repoName: 'repo',
        absolutePath: '/workspace',
        rootKind: 'git-repo',
        files: [
          {
            absolutePath: '/workspace/page.html',
            relativePath: 'page.html',
            filename: 'page.html',
            isIgnored: false,
          },
        ],
      },
    ],
    '/workspace',
  );

  it.each(['page.html:150-160', '`page.html#L150-L160`'])(
    'threads %s through rendered blocks, accessible pills, and presentation',
    async (text) => {
      mockUseRealMarkdownRenderer = true;
      useAgentFilePresentationStore.setState({ byTabId: {} });
      const open = jest
        .spyOn(useChatStore.getState(), 'openFileTab')
        .mockReturnValue('located');
      const rootElement = document.createElement('div');
      const root = createRoot(rootElement);
      try {
        act(() =>
          root.render(
            <ChatMarkdownFileTargetContext.Provider value={scope}>
              <ChatBlockRenderer
                block={{ type: 'text', text }}
                filePathMentionIndex={index}
              />
            </ChatMarkdownFileTargetContext.Provider>,
          ),
        );
        const button = rootElement.querySelector('button');
        expect(button?.textContent).toBe(text.replaceAll('`', ''));
        expect(button?.getAttribute('aria-label')).toBe(
          `Open ${text.replaceAll('`', '')}`,
        );
        await act(() => Promise.resolve(button?.click()));
        expect(open).toHaveBeenCalled();
        expect(
          useAgentFilePresentationStore.getState().byTabId.located,
        ).toEqual({ revision: 1, line: 150, lineEnd: 160 });
      } finally {
        act(() => root.unmount());
        open.mockRestore();
        mockUseRealMarkdownRenderer = false;
      }
    },
  );

  it.each(['README.md:012:4-020:9', '/workspace/README.md#L12-20'])(
    'resolves stripped %s, preserves the label/title, and replaces range/single/plain state',
    async (href) => {
      useAgentFilePresentationStore.setState({ byTabId: {} });
      const original = Object.getOwnPropertyDescriptor(window, 'api');
      const resolveFileReference = jest.fn().mockResolvedValue({
        absolutePath: '/workspace/README.md',
        filename: 'README.md',
      });
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          resolveFileReference,
          getFileTreeRoots: jest
            .fn()
            .mockResolvedValue({ roots: [{ absolutePath: '/workspace' }] }),
        },
      });
      const open = jest
        .spyOn(useChatStore.getState(), 'openFileTab')
        .mockReturnValue('markdown-range');
      const container = document.createElement('div');
      const root = createRoot(container);
      const render = (link: string): void =>
        act(() =>
          root.render(
            <ChatMarkdownFileTargetContext.Provider value={scope}>
              <ChatMarkdownLink href={link}>Authored label</ChatMarkdownLink>
            </ChatMarkdownFileTargetContext.Provider>,
          ),
        );
      try {
        render(href);
        expect(container.querySelector('button')?.title).toBe(href);
        expect(container.textContent).toBe('Authored label');
        await act(() =>
          Promise.resolve(container.querySelector('button')?.click()),
        );
        expect(resolveFileReference).toHaveBeenLastCalledWith({
          ...scope,
          baseFilePath: href.startsWith('/')
            ? '/workspace/README.md'
            : '/workspace/.chat-link',
          href: href.startsWith('/') ? '/workspace/README.md' : 'README.md',
        });
        expect(
          useAgentFilePresentationStore.getState().byTabId['markdown-range'],
        ).toEqual({ revision: 1, line: 12, lineEnd: 20 });
        await act(() =>
          Promise.resolve(container.querySelector('button')?.click()),
        );
        expect(
          useAgentFilePresentationStore.getState().byTabId['markdown-range']
            .revision,
        ).toBe(2);
        render('/workspace/README.md:18');
        await act(() =>
          Promise.resolve(container.querySelector('button')?.click()),
        );
        expect(
          useAgentFilePresentationStore.getState().byTabId['markdown-range'],
        ).toEqual({ revision: 3, line: 18 });
        render('/workspace/README.md');
        await act(() =>
          Promise.resolve(container.querySelector('button')?.click()),
        );
        expect(
          useAgentFilePresentationStore.getState().byTabId['markdown-range'],
        ).toEqual({ revision: 4 });
      } finally {
        act(() => root.unmount());
        open.mockRestore();
        if (original) Object.defineProperty(window, 'api', original);
        else Reflect.deleteProperty(window, 'api');
      }
    },
  );
  it.each([
    ['roots', 'markdown'],
    ['resolution', 'markdown'],
    ['roots', 'bare located'],
    ['resolution', 'bare located'],
    ['roots', 'bare browser'],
    ['resolution', 'bare browser'],
  ])(
    'ignores pending %s from mounted markdown A after newer %s B opens',
    async (pendingStage, newerKind) => {
      mockUseRealMarkdownRenderer = true;
      useAgentFilePresentationStore.setState({ byTabId: {} });
      const original = Object.getOwnPropertyDescriptor(window, 'api');
      const oldFile = { absolutePath: '/workspace/old.ts', filename: 'old.ts' };
      const newFile = { absolutePath: '/workspace/new.ts', filename: 'new.ts' };
      const roots = { roots: [{ absolutePath: '/workspace' }] };
      let finishRoots: ((value: typeof roots) => void) | undefined;
      let finishResolution: ((value: typeof oldFile) => void) | undefined;
      const pendingRoots = new Promise<typeof roots>((resolve) => {
        finishRoots = resolve;
      });
      const pendingResolution = new Promise<typeof oldFile>((resolve) => {
        finishResolution = resolve;
      });
      const getFileTreeRoots = jest.fn().mockResolvedValue(roots);
      if (pendingStage === 'roots')
        getFileTreeRoots.mockReturnValueOnce(pendingRoots);
      const resolveFileReference = jest.fn(({ href }: { href: string }) =>
        Promise.resolve(href.includes('old.ts') ? pendingResolution : newFile),
      );
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { getFileTreeRoots, resolveFileReference },
      });
      mockOpenFileInBrowserPanel.mockReset().mockResolvedValue('new-browser');
      const open = jest
        .spyOn(useChatStore.getState(), 'openFileTab')
        .mockReturnValue('new-file');
      const container = document.createElement('div');
      const root = createRoot(container);
      try {
        act(() =>
          root.render(
            <ChatMarkdownFileTargetContext.Provider value={scope}>
              <ChatMarkdownLink
                href="old.ts:150-160"
                originChatTabId="race-chat"
              >
                A
              </ChatMarkdownLink>
              {newerKind === 'markdown' ? (
                <ChatMarkdownLink
                  href="/workspace/new.ts:18"
                  originChatTabId="race-chat"
                >
                  B
                </ChatMarkdownLink>
              ) : (
                <ChatBlockRenderer
                  block={{
                    type: 'text',
                    text:
                      newerKind === 'bare located'
                        ? 'page.html:18'
                        : 'page.html',
                  }}
                  filePathMentionIndex={index}
                  originChatTabId="race-chat"
                />
              )}
            </ChatMarkdownFileTargetContext.Provider>,
          ),
        );
        const buttons = container.querySelectorAll('button');
        const older = buttons.item(0);
        const newer = buttons.item(1);
        expect(older).toBeDefined();
        expect(newer).toBeDefined();
        await act(() => Promise.resolve(older?.click()));
        if (pendingStage === 'resolution')
          expect(resolveFileReference).toHaveBeenCalledTimes(1);
        await act(() => Promise.resolve(newer?.click()));
        if (newerKind === 'bare browser') {
          expect(mockOpenFileInBrowserPanel).toHaveBeenCalledTimes(1);
          expect(open).not.toHaveBeenCalled();
        } else {
          expect(open).toHaveBeenCalledTimes(1);
          expect(useAgentFilePresentationStore.getState().byTabId).toEqual({
            'new-file': { revision: 1, line: 18 },
          });
        }
        await act(async () => {
          finishRoots?.(roots);
          finishResolution?.(oldFile);
          await Promise.resolve();
        });
        // A stays mounted: late completion must neither open nor present its tab.
        expect(container.querySelector('button')).toBe(older);
        expect(open).toHaveBeenCalledTimes(
          newerKind === 'bare browser' ? 0 : 1,
        );
        expect(useAgentFilePresentationStore.getState().byTabId).toEqual(
          newerKind === 'bare browser'
            ? {}
            : { 'new-file': { revision: 1, line: 18 } },
        );
        expect(older?.disabled).toBe(false);
        expect(container.textContent).not.toContain("Couldn't open file");
        // Supersession is retryable, so A can still become the newest request.
        await act(() => Promise.resolve(older?.click()));
        expect(open).toHaveBeenLastCalledWith(
          expect.objectContaining(oldFile),
          scope,
        );
        expect(
          useAgentFilePresentationStore.getState().byTabId['new-file'],
        ).toEqual({
          revision: newerKind === 'bare browser' ? 1 : 2,
          line: 150,
          lineEnd: 160,
        });
      } finally {
        act(() => root.unmount());
        open.mockRestore();
        if (original) Object.defineProperty(window, 'api', original);
        else Reflect.deleteProperty(window, 'api');
        mockUseRealMarkdownRenderer = false;
      }
    },
  );

  it('ignores an old markdown resolution after its target changes', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'api');
    let finish:
      | ((value: { absolutePath: string; filename: string }) => void)
      | undefined;
    const resolveFileReference = jest.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { resolveFileReference },
    });
    const open = jest
      .spyOn(useChatStore.getState(), 'openFileTab')
      .mockReturnValue('stale');
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      act(() =>
        root.render(
          <ChatMarkdownFileTargetContext.Provider value={scope}>
            <ChatMarkdownLink href="/workspace/old.ts:150-160">
              Old
            </ChatMarkdownLink>
          </ChatMarkdownFileTargetContext.Provider>,
        ),
      );
      await act(() =>
        Promise.resolve(container.querySelector('button')?.click()),
      );
      act(() =>
        root.render(
          <ChatMarkdownFileTargetContext.Provider
            value={{ ...scope, worktreeId: 'new-worktree' }}
          >
            <ChatMarkdownLink href="/workspace/new.ts:150-160">
              New
            </ChatMarkdownLink>
          </ChatMarkdownFileTargetContext.Provider>,
        ),
      );
      await act(async () => {
        finish?.({ absolutePath: '/workspace/old.ts', filename: 'old.ts' });
        await Promise.resolve();
      });
      expect(open).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      open.mockRestore();
      if (original) Object.defineProperty(window, 'api', original);
      else Reflect.deleteProperty(window, 'api');
    }
  });

  it.each([null, ''])(
    'does not present a failed file-tab result %j',
    async (tabId) => {
      mockUseRealMarkdownRenderer = true;
      const present = jest.spyOn(
        useAgentFilePresentationStore.getState(),
        'present',
      );
      const open = jest
        .spyOn(useChatStore.getState(), 'openFileTab')
        .mockReturnValue(tabId);
      const container = document.createElement('div');
      const root = createRoot(container);
      try {
        act(() =>
          root.render(
            <ChatBlockRenderer
              block={{ type: 'text', text: 'page.html:150-160' }}
              filePathMentionIndex={index}
            />,
          ),
        );
        await act(() =>
          Promise.resolve(container.querySelector('button')?.click()),
        );
        expect(open).toHaveBeenCalled();
        expect(present).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
        open.mockRestore();
        present.mockRestore();
        mockUseRealMarkdownRenderer = false;
      }
    },
  );
  it('keeps external URLs and their port/fragment unchanged', () => {
    const href = 'https://example.com:8443/src/a.ts#L12-L20';
    const html = renderToStaticMarkup(
      <ChatMarkdownFileTargetContext.Provider value={scope}>
        <ChatMarkdownLink href={href}>External label</ChatMarkdownLink>
      </ChatMarkdownFileTargetContext.Provider>,
    );
    expect(html).toContain(`href="${href}"`);
    expect(html).toContain('External label');
    expect(html).not.toContain('<button');
  });
});
