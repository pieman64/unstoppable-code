/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/require-await -- act(async) flushes resolved fakes. */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyCapabilities, CanopyClient } from '@canopy/app-core';
import {
  CanopyClientProvider,
  useOnboardingTipsStore,
  type OnboardingTipsStoreState,
} from '@canopy/app-state';
import {
  applyOnboardingTipsUpdate,
  type OnboardingTipDismissals,
  type OnboardingTipId,
  type OnboardingTipsUpdate,
} from '@canopy/protocol/onboarding-tips';
import type { PortalChatSummaryEntity } from '@canopy/protocol/portal';
import { ComposerDrawer } from '@canopy/ui-shared/components';
import {
  ComposerHint,
  OnboardingTipSlot,
  type OnboardingTipSlotProps,
} from '../index';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

interface Fake {
  client: CanopyClient;
  updates: OnboardingTipsUpdate[];
  query: jest.Mock;
}

/** A worktree chat summary for the history check. */
const summary = (
  chatId: string,
  messageCount: number,
): PortalChatSummaryEntity => ({
  localId: chatId,
  chatId,
  scope: 'worktree',
  workspaceLocalId: 'p-1',
  worktreeLocalId: 'tuatara',
  title: chatId,
  messageCount,
});

function fakeClient(
  dismissed: OnboardingTipDismissals = {},
  options: {
    readonly cloudScope?: string;
    /** Worktree chats the history check finds; by default only `chat`, empty. */
    readonly chats?: readonly PortalChatSummaryEntity[];
  } = {},
): Fake {
  const chats = options.chats ?? [summary('chat', 0)];
  const updates: OnboardingTipsUpdate[] = [];
  let stored = dismissed;
  const keeps: CanopyCapabilities = {
    localExecution: true,
    terminalPty: true,
    fileSystemAccess: 'read-write',
    voice: false,
    settingsScope: 'full',
    pipelines: 'execute',
    routing: 'in-memory',
    overviewNotifications: true,
    onboardingTips: true,
  };
  const client = {
    capabilities: keeps,
    capabilitiesFor: (localId: string): CanopyCapabilities =>
      localId === options.cloudScope
        ? { ...keeps, onboardingTips: undefined }
        : keeps,
    query: jest.fn((name: string) =>
      Promise.resolve(
        name === 'session.snapshot'
          ? { chatSummaries: chats }
          : { dismissed: stored },
      ),
    ),
    command: jest.fn((_name: string, args: OnboardingTipsUpdate) => {
      updates.push(args);
      stored = applyOnboardingTipsUpdate(stored, args, new Date());
      return Promise.resolve({ dismissed: stored });
    }),
    subscribe: jest.fn((): (() => void) => () => undefined),
  };
  // Only the onboarding tip operations, the history check and capabilities
  // are reached.
  return {
    client: client as unknown as CanopyClient,
    updates,
    query: client.query,
  };
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const TAB_TIPS: readonly OnboardingTipId[] = [
  'workflows',
  'workflows-schedule',
];

/** The worktree chat the composer slots in these tests are on. */
const EMPTY_CHAT = {
  chatId: 'chat',
  workspaceLocalId: 'p-1',
  worktreeLocalId: 'tuatara',
  transcript: 'empty',
  newlyCreated: true,
} as const;

let storeActions: OnboardingTipsStoreState | null = null;
function StoreProbe(): null {
  storeActions = useOnboardingTipsStore((state) => state);
  return null;
}

function Host({
  client,
  slots,
}: {
  client: CanopyClient;
  slots: readonly OnboardingTipSlotProps[];
}): JSX.Element {
  return (
    <CanopyClientProvider client={client}>
      <StoreProbe />
      {slots.map((props) => (
        <OnboardingTipSlot key={props['data-testid']} {...props} />
      ))}
    </CanopyClientProvider>
  );
}

async function render(
  client: CanopyClient,
  slots: readonly OnboardingTipSlotProps[],
): Promise<void> {
  await act(async () => {
    root.render(<Host client={client} slots={slots} />);
  });
  await act(async () => undefined);
}

const byTestId = (id: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${id}"]`);

function click(id: string): void {
  const button = byTestId(id);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`no ${id}`);
  act(() => button.click());
}

describe('OnboardingTipSlot', () => {
  it('shows the first tip for the page with a visible close button', async () => {
    const { client } = fakeClient();
    await render(client, [
      {
        placement: 'inline',
        eligible: TAB_TIPS,
        arrivalKey: 'workflows-schedule',
        'data-testid': 'tip',
      },
    ]);
    const tip = byTestId('tip');
    expect(tip).toBeInstanceOf(HTMLElement);
    expect(tip?.getAttribute('role')).toBe('note');
    expect(tip?.textContent).toContain('Repeat work with workflows');
    expect(byTestId('tip-dismiss')?.getAttribute('aria-label')).toBe(
      'Dismiss tip',
    );
  });

  it('dismisses with Got it and leaves the next tip for the next arrival', async () => {
    const { client, updates } = fakeClient();
    const slot: OnboardingTipSlotProps = {
      placement: 'inline',
      eligible: TAB_TIPS,
      arrivalKey: 'workflows-schedule',
      'data-testid': 'tip',
    };
    await render(client, [slot]);
    click('tip-got-it');
    expect(byTestId('tip')).toBeNull();
    expect(updates).toEqual([{ action: 'dismiss', tipId: 'workflows' }]);

    await render(client, [{ ...slot, arrivalKey: 'workflows' }]);
    await render(client, [slot]);
    expect(byTestId('tip')?.textContent).toContain(
      'Schedules live on workflows',
    );
  });

  it('acting on a tip runs its verb and dismisses it', async () => {
    const { client, updates } = fakeClient({
      workflows: '2026-10-24T09:00:00.000Z',
    });
    const openLibrary = jest.fn();
    await render(client, [
      {
        placement: 'inline',
        eligible: TAB_TIPS,
        arrivalKey: 'workflows-schedule',
        onAction: { 'workflows-schedule': openLibrary },
        'data-testid': 'tip',
      },
    ]);
    expect(byTestId('tip-action')?.textContent).toBe('Open Library');
    click('tip-action');
    expect(openLibrary).toHaveBeenCalledTimes(1);
    expect(updates).toEqual([
      { action: 'dismiss', tipId: 'workflows-schedule' },
    ]);
    expect(byTestId('tip')).toBeNull();
  });

  it('shows only one tip when two slots apply', async () => {
    const { client } = fakeClient();
    await render(client, [
      {
        placement: 'inline',
        eligible: ['workflows'],
        arrivalKey: 'a',
        'data-testid': 'page',
      },
      {
        placement: 'composer',
        eligible: ['worktree-chat'],
        arrivalKey: 'chat',
        worktreeChat: EMPTY_CHAT,
        context: { projectName: 'canopy', worktreeName: 'tuatara' },
        'data-testid': 'composer',
      },
    ]);
    expect(byTestId('page')).toBeInstanceOf(HTMLElement);
    expect(byTestId('composer')).toBeNull();
  });

  // The slot remounts the tip on every return to its page, so an entry
  // animation would replay as a blink (DESIGN.md, Motion).
  it.each(['inline', 'composer'] as const)(
    'gives the %s tip no entry animation',
    async (placement) => {
      const { client } = fakeClient();
      await render(client, [
        {
          placement,
          eligible: placement === 'inline' ? ['workflows'] : ['worktree-chat'],
          arrivalKey: 'chat',
          worktreeChat: EMPTY_CHAT,
          'data-testid': 'tip',
        },
      ]);
      const tip = byTestId('tip');
      if (!tip) throw new Error('no tip');
      const elements: Element[] = [
        tip,
        ...Array.from(tip.querySelectorAll('*')),
      ];
      const animated = elements.filter((element) =>
        (element.getAttribute('class') ?? '').includes('animate-'),
      );
      expect(animated).toEqual([]);
    },
  );

  it('draws the composer tip as a section of the composer drawer', async () => {
    const { client, updates } = fakeClient();
    await act(async () => {
      root.render(
        <CanopyClientProvider client={client}>
          <ComposerDrawer edge="top" data-testid="drawer">
            <OnboardingTipSlot
              placement="composer"
              eligible={['worktree-chat']}
              arrivalKey="chat"
              worktreeChat={EMPTY_CHAT}
              context={{ projectName: 'canopy', worktreeName: 'tuatara' }}
              data-testid="composer"
            />
          </ComposerDrawer>
        </CanopyClientProvider>,
      );
    });
    await act(async () => undefined);
    await act(async () => undefined);
    const tip = byTestId('composer');
    expect(tip?.parentElement).toBe(byTestId('drawer'));
    expect(tip?.hasAttribute('data-composer-drawer-section')).toBe(true);
    expect(tip?.getAttribute('role')).toBe('note');
    // The drawer owns the surface: the tip draws no tint, ring or tab.
    expect(tip?.className).not.toMatch(/\b(bg-|ring|rounded)/);
    click('composer-dismiss');
    expect(updates).toEqual([{ action: 'dismiss', tipId: 'worktree-chat' }]);
    expect(byTestId('composer')).toBeNull();
    // With no tip left, the drawer holds only the slot's marker, no section.
    expect(
      byTestId('drawer')?.querySelector('[data-composer-drawer-section]'),
    ).toBeNull();
  });

  it('names the project and worktree on the composer tip', async () => {
    const { client } = fakeClient();
    await render(client, [
      {
        placement: 'composer',
        eligible: ['worktree-chat'],
        arrivalKey: 'chat',
        worktreeChat: EMPTY_CHAT,
        context: { projectName: 'canopy', worktreeName: 'tuatara' },
        'data-testid': 'composer',
      },
    ]);
    const tip = byTestId('composer');
    expect(tip?.getAttribute('data-onboarding-tip-placement')).toBe('composer');
    expect(tip?.textContent).toContain('This chat has its own copy of canopy');
    expect(tip?.textContent).toContain(
      'Changes stay in tuatara until you commit or open a pull request.',
    );
  });

  it('a hidden slot never holds the tip', async () => {
    const { client } = fakeClient();
    // The test DOM has no layout: treat anything under [data-hidden] as a
    // display: none page kept mounted behind the visible one.
    const checkVisibility = jest.fn(function (this: Element): boolean {
      return this.closest('[data-hidden]') === null;
    });
    const original = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'checkVisibility',
    );
    Reflect.set(Element.prototype, 'checkVisibility', checkVisibility);
    try {
      await act(async () => {
        root.render(
          <CanopyClientProvider client={client}>
            <div data-hidden="true">
              <OnboardingTipSlot
                placement="composer"
                eligible={['worktree-chat']}
                arrivalKey="chat"
                worktreeChat={EMPTY_CHAT}
                data-testid="composer"
              />
            </div>
            <OnboardingTipSlot
              placement="inline"
              eligible={['workflows']}
              arrivalKey="workflows"
              data-testid="page"
            />
          </CanopyClientProvider>,
        );
      });
      await act(async () => undefined);
      expect(byTestId('composer')).toBeNull();
      expect(byTestId('page')?.textContent).toContain(
        'Repeat work with workflows',
      );
    } finally {
      if (original) {
        Object.defineProperty(Element.prototype, 'checkVisibility', original);
      } else {
        Reflect.deleteProperty(Element.prototype, 'checkVisibility');
      }
    }
  });

  it('shows nothing for a scope whose host keeps no dismissals', async () => {
    const { client, query } = fakeClient({}, { cloudScope: 'cloud-tree' });
    await render(client, [
      {
        placement: 'composer',
        eligible: ['worktree-chat'],
        arrivalKey: 'chat',
        worktreeChat: EMPTY_CHAT,
        scopeLocalId: 'cloud-tree',
        'data-testid': 'composer',
      },
    ]);
    expect(byTestId('composer')).toBeNull();
    // A cloud chat never reads history.
    expect(query).not.toHaveBeenCalledWith(
      'session.snapshot',
      expect.anything(),
    );
  });

  const composer = (
    overrides: Partial<OnboardingTipSlotProps> = {},
  ): OnboardingTipSlotProps => ({
    placement: 'composer',
    eligible: ['worktree-chat'],
    arrivalKey: 'chat',
    worktreeChat: EMPTY_CHAT,
    context: { worktreeName: 'tuatara' },
    'data-testid': 'composer',
    ...overrides,
  });

  it('shows no worktree tip to a user with worktree history', async () => {
    const { client, updates } = fakeClient(
      {},
      { chats: [summary('chat', 0), summary('older', 8)] },
    );
    await render(client, [composer()]);
    expect(byTestId('composer')).toBeNull();
    expect(storeActions?.worktreeHistory).toBe('used');
    expect(updates).toEqual([]);
  });

  it('shows no worktree tip on a chat whose transcript has history', async () => {
    const { client } = fakeClient();
    await render(client, [
      composer({
        worktreeChat: {
          chatId: 'chat',
          workspaceLocalId: 'p-1',
          worktreeLocalId: 'tuatara',
          transcript: 'used',
        },
      }),
    ]);
    expect(byTestId('composer')).toBeNull();
  });

  it('waits for the transcript, then finishes the same arrival', async () => {
    const { client } = fakeClient();
    await render(client, [
      composer({
        worktreeChat: {
          chatId: 'chat',
          workspaceLocalId: 'p-1',
          worktreeLocalId: 'tuatara',
          transcript: 'loading',
          newlyCreated: true,
        },
      }),
    ]);
    expect(byTestId('composer')).toBeNull();
    await render(client, [composer()]);
    expect(byTestId('composer')?.textContent).toContain(
      'Changes stay in tuatara until you commit or open a pull request.',
    );
  });

  it('removes the tip when the user sends from the worktree chat', async () => {
    const { client } = fakeClient();
    await render(client, [composer()]);
    expect(byTestId('composer')).toBeInstanceOf(HTMLElement);
    await act(async () => storeActions?.noteTurnSent({ worktreeChat: true }));
    expect(byTestId('composer')).toBeNull();
  });

  it('holds tips for a notice until a send and a later arrival', async () => {
    const { client } = fakeClient();
    await render(client, [composer()]);
    await act(async () => storeActions?.holdForNotice('whats-new:1'));
    expect(byTestId('composer')).toBeNull();
    await act(async () => storeActions?.noteTurnSent({ worktreeChat: false }));
    await render(client, [composer()]);
    expect(byTestId('composer')).toBeNull();
    await render(client, []);
    await render(client, [composer()]);
    await act(async () => undefined);
    expect(byTestId('composer')).toBeInstanceOf(HTMLElement);
  });

  it('holds the arrival tip while a composer hint shows, so one tip is on screen', async () => {
    const { client } = fakeClient();
    const slot: OnboardingTipSlotProps = {
      placement: 'inline',
      eligible: TAB_TIPS,
      arrivalKey: 'workflows-schedule',
      'data-testid': 'tip',
    };
    await render(client, [slot]);
    expect(byTestId('tip')).not.toBeNull();

    await act(async () => {
      root.render(
        <CanopyClientProvider client={client}>
          <StoreProbe />
          <OnboardingTipSlot {...slot} />
          <ComposerDrawer edge="top">
            <ComposerHint
              icon={null}
              title="Plan first?"
              onDismiss={jest.fn()}
              data-testid="hint"
            >
              A draft-driven hint.
            </ComposerHint>
          </ComposerDrawer>
        </CanopyClientProvider>,
      );
    });
    expect(byTestId('hint')?.getAttribute('role')).toBe('status');
    expect(byTestId('tip')).toBeNull();
    expect(storeActions?.held).toBe(true);
  });

  it('draws a composer hint without a client, holding nothing', () => {
    act(() => {
      root.render(
        <ComposerDrawer edge="top">
          <ComposerHint
            icon={null}
            title="Plan first?"
            onDismiss={jest.fn()}
            data-testid="hint"
          >
            A draft-driven hint.
          </ComposerHint>
        </ComposerDrawer>,
      );
    });
    expect(byTestId('hint')?.getAttribute('aria-live')).toBe('polite');
  });
});
