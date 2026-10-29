/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { STANDALONE_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import { openActivityCardBesideChat } from '@/lib/panels/open-activity-card';
import {
  WorkspaceAccessContext,
  type WorkspaceAccess,
} from '@/lib/workspace-access';
import { HookInfoBanner } from '../HookInfoBanner';
import {
  ChatMarkdownFileTargetContext,
  type ChatMarkdownFileTarget,
} from '../chat-markdown-file-target';

jest.mock('@/lib/panels/open-activity-card', () => ({
  openActivityCardBesideChat: jest.fn(() =>
    Promise.resolve({ status: 'unavailable' }),
  ),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORKTREE: ChatMarkdownFileTarget = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  jest.mocked(openActivityCardBesideChat).mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderBanner({
  target = WORKTREE,
  originChatTabId = 'chat-1',
  access = { mode: 'read-write' },
}: {
  target?: ChatMarkdownFileTarget | null;
  /** `null` renders the banner without an origin chat. */
  originChatTabId?: string | null;
  access?: WorkspaceAccess;
} = {}): void {
  const banner: JSX.Element = (
    <WorkspaceAccessContext.Provider value={access}>
      <ChatMarkdownFileTargetContext.Provider value={target}>
        <HookInfoBanner
          triggerName="pr:create"
          timestamp={Date.UTC(2026, 9, 7, 15, 4)}
          originChatTabId={originChatTabId ?? undefined}
        />
      </ChatMarkdownFileTargetContext.Provider>
    </WorkspaceAccessContext.Provider>
  );
  act(() => root.render(banner));
}

function openHooksButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    '[data-testid="chat-hook-info-open-hooks"]',
  );
}

describe('HookInfoBanner', () => {
  it('opens a Hooks tab beside the chat when the hook name is clicked', () => {
    renderBanner();

    const banner = container.querySelector(
      '[data-testid="chat-hook-info-banner"]',
    );
    expect(banner?.textContent).toMatch(
      /^Chat initiated by PR Created hook at \d/,
    );
    const button = openHooksButton();
    expect(button?.textContent).toBe('PR Created');

    act(() => button?.click());

    expect(openActivityCardBesideChat).toHaveBeenCalledWith(
      'project-1/worktree-1',
      { id: 'hooks', title: 'Hooks' },
      'chat-1',
    );
  });

  it.each<{
    name: string;
    options: Parameters<typeof renderBanner>[0];
  }>([
    { name: 'the transcript has no worktree', options: { target: null } },
    {
      name: 'the banner has no origin chat',
      options: { originChatTabId: null },
    },
    {
      name: 'the chat is in a Cowork workspace',
      options: {
        target: {
          projectId: STANDALONE_CHAT_PROJECT_ID,
          worktreeId: 'chat-1',
        },
      },
    },
    {
      name: 'a shared worktree is read-only',
      options: {
        access: {
          mode: 'read-only',
          reason: 'shared-container',
          containerType: 'CODE_WORKTREE',
          runAllowed: true,
        },
      },
    },
  ])('keeps the hook name as plain text when $name', ({ options }) => {
    renderBanner(options);

    expect(openHooksButton()).toBeNull();
    expect(container.querySelector('strong')?.textContent).toBe('PR Created');
    expect(container.textContent).toMatch(
      /^Chat initiated by PR Created hook at \d/,
    );
  });
});
