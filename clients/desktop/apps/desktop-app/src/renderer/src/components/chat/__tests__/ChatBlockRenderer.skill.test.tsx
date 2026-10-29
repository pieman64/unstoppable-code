/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InvocableInventoryEntry } from '@canopy/desktop-shared/types';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import type { ChatShareData } from '@/hooks/useChatShareData';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

let mockData: ChatShareData;
jest.mock('@/hooks/useChatShareData', () => ({
  useChatShareData: (): ChatShareData => mockData,
}));

jest.mock('@/lib/invocableMentionContent', () => ({
  loadInvocableMentionContent: jest.fn(() =>
    Promise.resolve({
      title: 'Release notes',
      description: 'Writes release notes',
      content: null,
    }),
  ),
}));

import { ChatBlockRenderer } from '../ChatBlockRenderer';
import type { DisplayBlock } from '../types';
import { buildInvocableMentionIndex } from '@/lib/invocableMentionIndex';
import { useShareRequestStore } from '@/stores/shareRequestStore';

const ENTRY: InvocableInventoryEntry = {
  id: 'claude-notes',
  provider: 'claude',
  kind: 'skill',
  name: 'release-notes',
  displayName: '/release-notes',
  description: 'Writes release notes',
  insertText: '/release-notes ',
  invocationKey: '/release-notes',
  enableRef: {
    kind: 'skill',
    sourceId: 'custom:app',
    skillName: 'release-notes',
  },
};
const INDEX = buildInvocableMentionIndex([ENTRY]);

function installed(
  overrides: Partial<InstalledSkillInfo> = {},
): InstalledSkillInfo {
  return {
    name: 'release-notes',
    sourceId: 'custom:app',
    description: '',
    source: 'custom',
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updateAvailable: false,
    custom: true,
    ...overrides,
  };
}

function data(installedSkills: InstalledSkillInfo[] | null): ChatShareData {
  return {
    installedSkills,
    marketplaces: [],
    localSettled: true,
    skillsSettled: true,
    marketplacesSettled: true,
    skillAudienceReady: true,
    sharedPlugins: null,
    accountId: 'me',
    inventoryEntries: null,
    mentionIndex: null,
  };
}

function skillBlock(input: string): DisplayBlock {
  return {
    type: 'tool_use',
    toolUseId: 'skill-1',
    toolName: 'Skill',
    input,
    result: { output: 'ok', isError: false },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
}

describe('ChatBlockRenderer "Using skill" row', () => {
  let container: HTMLElement;
  let root: Root;
  let unregisterHost: () => void;

  const render = (block: DisplayBlock, index = INDEX): void => {
    act(() => {
      root.render(
        <ChatBlockRenderer block={block} invocableMentionIndex={index} />,
      );
    });
  };
  const detailsButton = (): HTMLButtonElement | null =>
    container.querySelector('[data-testid="using-skill-details"]');
  const dialog = (): HTMLElement | null =>
    document.querySelector('[role="dialog"]');
  const shareButton = (): HTMLButtonElement | null =>
    document.querySelector('[data-testid="invocable-mention-detail-share"]');

  beforeEach(() => {
    mockData = data([installed()]);
    useShareRequestStore.setState({ hostCount: 0, request: null });
    unregisterHost = useShareRequestStore.getState().registerHost();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    unregisterHost();
  });

  it('turns a resolvable skill name into a details button', () => {
    render(skillBlock(JSON.stringify({ skill: 'release-notes' })));
    expect(container.textContent).toContain('Using skill');
    expect(detailsButton()?.textContent).toBe('release-notes');
    expect(detailsButton()?.getAttribute('aria-label')).toBe(
      'Open /release-notes details',
    );
    // Nothing opens until it is clicked.
    expect(dialog()).toBeNull();
  });

  it('keeps an unresolved name as plain code', () => {
    render(skillBlock(JSON.stringify({ skill: 'not-installed' })));
    expect(detailsButton()).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('not-installed');

    render(
      skillBlock(JSON.stringify({ skill: 'release-notes' })),
      buildInvocableMentionIndex([]),
    );
    expect(detailsButton()).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('release-notes');
  });

  it('keeps the raw-command branch as a tool call', () => {
    render(
      skillBlock(
        JSON.stringify({
          skill: 'release-notes',
          raw_command: '/release-notes now',
        }),
      ),
    );
    // The existing tool-call row renders it; no details button is added.
    expect(detailsButton()).toBeNull();
  });

  it('closes the details dialog before requesting the share dialog', async () => {
    render(skillBlock(JSON.stringify({ skill: 'release-notes' })));
    act(() => detailsButton()?.click());
    await flush();
    expect(dialog()).not.toBeNull();
    expect(shareButton()?.getAttribute('aria-label')).toBe(
      'Share release-notes',
    );
    // An unshared skill shows no audience label.
    expect(
      document.querySelector(
        '[data-testid="invocable-mention-detail-audience"]',
      ),
    ).toBeNull();

    act(() => shareButton()?.click());
    await flush();
    // The details scrim and focus trap are gone; one modal at a time.
    expect(dialog()).toBeNull();
    expect(useShareRequestStore.getState().request).toMatchObject({
      target: { kind: 'skill', sourceId: 'custom:app', name: 'release-notes' },
      source: 'mention_detail',
      ownerDocument: document,
    });
  });

  it('shows who a shared skill is shared with', async () => {
    mockData = data([
      installed({
        remote: {
          remoteId: 'remote-1',
          contentHash: 'hash',
          shareScope: 'organization',
          sharedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    ]);
    render(skillBlock(JSON.stringify({ skill: 'release-notes' })));
    act(() => detailsButton()?.click());
    await flush();
    expect(
      document.querySelector(
        '[data-testid="invocable-mention-detail-audience"]',
      )?.textContent,
    ).toBe('Organization');
    expect(shareButton()).not.toBeNull();
  });

  it.each([
    [
      'the skill cannot be shared',
      (): void => {
        mockData = data([installed({ custom: false, sourceId: 'custom:app' })]);
      },
    ],
    ['no share host is mounted', (): void => unregisterHost()],
  ])('opens details without Share when %s', async (_label, arrange) => {
    arrange();
    render(skillBlock(JSON.stringify({ skill: 'release-notes' })));
    act(() => detailsButton()?.click());
    await flush();
    expect(dialog()).not.toBeNull();
    expect(shareButton()).toBeNull();
  });

  it('closes on Escape without requesting a share', async () => {
    render(skillBlock(JSON.stringify({ skill: 'release-notes' })));
    act(() => detailsButton()?.click());
    await flush();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    await flush();
    expect(dialog()).toBeNull();
    expect(useShareRequestStore.getState().request).toBeNull();
  });
});
