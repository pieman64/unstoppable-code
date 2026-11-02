/**
 * @jest-environment jsdom
 *
 * Phase 12: `DesktopSharedChatPanelBridge` no longer re-projects the whole
 * transcript into the shared `@canopy/app-state` chat store on every change,
 * because nothing on the desktop host renders that store's transcript.
 *
 * The second half of this file keeps that true: while the projection is
 * gated off, it fails if a desktop module starts reading the shared chat
 * store, or if the bridge's transcript/composer callbacks start consuming the
 * shared thread the shared panel hands them.
 */
// Node built-ins are restricted in renderer production code; this guard is a
// Jest-only source scan that never ships to the renderer bundle.
// eslint-disable-next-line no-restricted-imports
import { readdirSync, readFileSync, statSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join, relative } from 'node:path';
import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PersistedChatMessage } from '@canopy/agent-transcript/types';
import type { projectPersistedChatTranscript } from '@canopy/desktop-shared/portal/persisted-chat-projection';
import { SHARED_CHAT_TRANSCRIPT_PROJECTION_ENABLED } from '../shared-chat-projection-gate';
import { DesktopSharedChatPanelBridge } from '../WorktreeChatSurface';
import type { ActiveComposerView, ActiveTranscriptView } from '../types';

const mockHydrate = jest.fn();
type ProjectionInput = Parameters<typeof projectPersistedChatTranscript>[0];
const mockProject = jest.fn<never[], [input: ProjectionInput]>(() => []);

jest.mock('@canopy/app-state', () => ({
  useChatStore: (
    selector: (state: { hydrate: jest.Mock }) => unknown,
  ): unknown => selector({ hydrate: mockHydrate }),
}));
jest.mock('@canopy/desktop-shared/portal/persisted-chat-projection', () => ({
  projectPersistedChatTranscript: (input: ProjectionInput): never[] =>
    mockProject(input),
}));
jest.mock('@canopy/ui-app/chat-panel', () => ({
  ChatPanel: ({
    renderTranscript,
    renderComposer,
  }: {
    renderTranscript: (controls: Record<string, unknown>) => ReactNode;
    renderComposer: (controls: Record<string, unknown>) => ReactNode;
  }): JSX.Element => (
    <div>
      {renderTranscript({})}
      {renderComposer({})}
    </div>
  ),
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function row(id: string, text: string): PersistedChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: 1,
  };
}

function transcriptView(
  messages: PersistedChatMessage[],
): ActiveTranscriptView {
  return { id: 'chat', messages, queuedMessages: [] };
}

const composer: ActiveComposerView | null = null;
const selectedWorktree = { projectId: 'project', worktreeId: 'worktree' };
const noop = (): void => undefined;
const renderNothing = (): null => null;

describe('DesktopSharedChatPanelBridge projection gate', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockHydrate.mockClear();
    mockProject.mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render(messages: PersistedChatMessage[]): void {
    act(() => {
      root.render(
        <DesktopSharedChatPanelBridge
          chatId="chat"
          selectedWorktree={selectedWorktree}
          transcript={transcriptView(messages)}
          composerTab={composer}
          onSend={noop}
          onStop={noop}
          renderTranscript={renderNothing}
          renderComposer={renderNothing}
          hostQueuedMessageEditor={null}
        />,
      );
    });
  }

  it('is gated off', () => {
    expect(SHARED_CHAT_TRANSCRIPT_PROJECTION_ENABLED).toBe(false);
  });

  it('neither projects nor re-hydrates the transcript on transcript changes', () => {
    render([row('m1', 'one')]);
    render([row('m1', 'one'), row('m2', 'two')]);
    render([row('m1', 'one'), row('m2', 'two'), row('m3', 'three')]);

    expect(mockProject).not.toHaveBeenCalled();
    // One hydration of status, route and settings; no messages, no replace.
    expect(mockHydrate).toHaveBeenCalledTimes(1);
    expect(mockHydrate).toHaveBeenCalledWith(
      'chat',
      [],
      expect.objectContaining({
        replaceMessages: false,
        status: 'idle',
        route: {
          scope: 'worktree',
          workspaceLocalId: 'project',
          worktreeLocalId: 'worktree',
        },
      }),
    );
  });
});

const RENDERER_ROOT = join(__dirname, '..', '..', '..');
const REPO_ROOT = join(RENDERER_ROOT, '..', '..', '..', '..', '..');

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (
      /\.(ts|tsx)$/.test(entry) &&
      !/\.(test|spec)\.(ts|tsx)$/.test(entry)
    ) {
      files.push(path);
    }
  }
  return files;
}

const APP_STATE_SPECIFIER = "'@canopy/app-state(?:/[^']*)?'";
const NAMED_IMPORT_PATTERN = new RegExp(
  `import\\s*(?:type\\s*)?\\{([^}]*)\\}\\s*from\\s*${APP_STATE_SPECIFIER}`,
  'g',
);
const RE_EXPORT_PATTERN = new RegExp(
  `export\\s*(?:type\\s*)?\\{([^}]*)\\}\\s*from\\s*${APP_STATE_SPECIFIER}`,
  'g',
);
const NAMESPACE_IMPORT_PATTERN = new RegExp(
  `import\\s*\\*\\s*as\\s+([A-Za-z_$][\\w$]*)\\s*from\\s*${APP_STATE_SPECIFIER}`,
  'g',
);
const CHAT_STORE_NAME = /\buseChatStore(Api)?\b/;

/**
 * Whether a module reaches the shared chat store hooks from
 * `@canopy/app-state` (or a subpath): through a named import, through a
 * namespace import's member access, or by re-exporting them.
 */
function readsSharedChatStore(source: string): boolean {
  const captures = (pattern: RegExp): string[] =>
    Array.from(source.matchAll(pattern), (match) => match[1] ?? '');
  const hookListings = [
    ...captures(NAMED_IMPORT_PATTERN),
    ...captures(RE_EXPORT_PATTERN),
  ];
  if (hookListings.some((listing) => CHAT_STORE_NAME.test(listing))) {
    return true;
  }
  return captures(NAMESPACE_IMPORT_PATTERN).some((namespace) =>
    new RegExp(
      `(?<![\\w$])${namespace.replace(/\$/g, '\\$')}\\s*\\.\\s*useChatStore(Api)?\\b`,
    ).test(source),
  );
}

/** Modules importing the shared chat store hooks from `@canopy/app-state`. */
function sharedChatStoreReaders(directory: string): string[] {
  return sourceFiles(directory)
    .filter((file) => readsSharedChatStore(readFileSync(file, 'utf8')))
    .map((file) => relative(REPO_ROOT, file))
    .sort();
}

/** Whether a JSX callback prop is an inline arrow that takes any parameter. */
function takesControls(source: string, prop: string): boolean {
  return (
    new RegExp(`${prop}=\\{\\s*(?:async\\s*)?\\(\\s*[^\\s)]`).test(source) ||
    new RegExp(`${prop}=\\{\\s*(?:async\\s+)?[A-Za-z_$][\\w$]*\\s*=>`).test(
      source,
    )
  );
}

describe('shared chat store reader detection', () => {
  it.each([
    ["import { useChatStore } from '@canopy/app-state';", true],
    ["import { useChatStoreApi as api } from '@canopy/app-state/x';", true],
    [
      "import * as State from '@canopy/app-state';\nState.useChatStore();",
      true,
    ],
    [
      "import * as S from '@canopy/app-state/chat';\nS.useChatStoreApi();",
      true,
    ],
    ["export { useChatStore } from '@canopy/app-state';", true],
    ["export { useChatStoreApi as x } from '@canopy/app-state/y';", true],
    [
      "import * as State from '@canopy/app-state';\nState.useCanopyClient();",
      false,
    ],
    ["import { useCanopyClient } from '@canopy/app-state';", false],
    ["export { useCanopyClient } from '@canopy/app-state';", false],
  ])('classifies %j', (source, expected) => {
    expect(readsSharedChatStore(source)).toBe(expected);
  });

  it.each([
    ['renderTranscript={() => (', false],
    ['renderTranscript={(controls) => (', true],
    ['renderTranscript={({ thread }) => (', true],
    ['renderTranscript={(_) => null}', true],
    ['renderTranscript={controls => null}', true],
    ['renderTranscript={renderTranscript}', false],
  ])('classifies callback %j', (source, expected) => {
    expect(takesControls(source, 'renderTranscript')).toBe(expected);
  });
});

describe('shared chat store readers while the projection is gated', () => {
  const gated = !SHARED_CHAT_TRANSCRIPT_PROJECTION_ENABLED;

  it('has no desktop reader other than the hydrating bridge', () => {
    if (!gated) return;
    expect(sharedChatStoreReaders(RENDERER_ROOT)).toEqual([
      'apps/desktop-app/src/renderer/src/components/chat/WorktreeChatSurface.tsx',
    ]);
    // The bridge only selects the `hydrate` action from the shared store.
    const bridge = readFileSync(
      join(RENDERER_ROOT, 'components', 'chat', 'WorktreeChatSurface.tsx'),
      'utf8',
    );
    expect(bridge.split('useSharedChatStore(').length - 1).toBe(1);
    expect(bridge).toContain('useSharedChatStore((s) => s.hydrate)');
  });

  it('keeps the shared panel as the only shared-package reader', () => {
    if (!gated) return;
    expect(
      sharedChatStoreReaders(join(REPO_ROOT, 'packages', 'ui-app', 'src')),
    ).toEqual(['packages/ui-app/src/code/ChatPanel.tsx']);
  });

  it('does not let the desktop transcript and composer consume the shared thread', () => {
    if (!gated) return;
    const surface = readFileSync(
      join(RENDERER_ROOT, 'components', 'chat', 'WorktreeChatSurface.tsx'),
      'utf8',
    );
    // Parameterless callbacks (any parameter, destructured or not, fails): the shared panel's transcript controls
    // (messages, turn groups, status) and composer controls are ignored.
    expect(surface).toMatch(/renderTranscript=\{\(\) =>/);
    expect(surface).toMatch(/renderComposer=\{\(\) =>/);
    expect(takesControls(surface, 'renderTranscript')).toBe(false);
    expect(takesControls(surface, 'renderComposer')).toBe(false);
  });
});
