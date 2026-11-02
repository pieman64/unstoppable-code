/**
 * @jest-environment jsdom
 *
 * Uses the repo's createRoot + act jsdom convention (see ModelPicker.test.tsx);
 * @testing-library/react is not installed. Exercises the unified palette's
 * tier-0 rendering, the `>` commands-only prefix, and tier-2 request-token
 * staleness (out-of-order transcript responses).
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ChatSearchQueryResponse,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useProjectsStore } from '@/stores/projectsStore';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useActivityStore } from '@/stores/activityStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useBranchDisplayStore } from '@/stores/branchDisplayStore';
import { getVisibleNavItems } from '@/components/settings/SettingsNav';
import type * as SettingsNavModule from '@/components/settings/SettingsNav';
import type * as HostedSettingsAvailabilityModule from '@/components/settings/hosted/hosted-settings-availability';
import {
  applyLabsExperimentsSnapshot,
  resetLabsExperimentsStoreForTest,
} from '@/stores/labsExperimentsStore';
import {
  makeTestLabsSnapshot,
  pageExperimentsOn,
} from '@/test-utils/labsExperiments';
import { CommandPalette } from '../CommandPalette';
import { PaletteResultRow } from '../PaletteResultRow';
import type { PaletteItem } from '../paletteItems';

jest.mock('@/hooks/usePipelineList', () => ({
  usePipelineList: (): {
    pipelines: never[];
    loading: boolean;
    error: null;
  } => ({ pipelines: [], loading: false, error: null }),
}));
jest.mock('@/hooks/useMarketplaceList', () => ({
  useMarketplaceList: (): {
    cache: null;
    loading: boolean;
    error: null;
  } => ({ cache: null, loading: false, error: null }),
}));
jest.mock('@/hooks/useSkillList', () => ({
  useSkillList: (): { skills: never[]; loading: boolean; error: null } => ({
    skills: [],
    loading: false,
    error: null,
  }),
}));
jest.mock('@/components/settings/SettingsNav', () => ({
  getVisibleNavItems: jest.fn((): never[] => []),
}));
const mockUseHostedSettingsAvailable = jest.fn<boolean, []>(() => false);
jest.mock(
  '@/components/settings/hosted/hosted-settings-availability',
  (): typeof HostedSettingsAvailabilityModule => ({
    ...jest.requireActual<typeof HostedSettingsAvailabilityModule>(
      '@/components/settings/hosted/hosted-settings-availability',
    ),
    useHostedSettingsAvailable: (): boolean => mockUseHostedSettingsAvailable(),
  }),
);

const getVisibleNavItemsMock = jest.mocked(getVisibleNavItems);

const mockPaletteAccountFacts = jest.fn<
  { personalOrganizationId: string | null; freeAccess: boolean },
  [boolean]
>(() => ({ personalOrganizationId: null, freeAccess: false }));
jest.mock('../usePaletteAccountFacts', () => ({
  usePaletteAccountFacts: (
    enabled: boolean,
  ): { personalOrganizationId: string | null; freeAccess: boolean } =>
    mockPaletteAccountFacts(enabled),
}));

if (typeof globalThis.requestAnimationFrame === 'undefined') {
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: (cb: FrameRequestCallback): number => {
      cb(0);
      return 0;
    },
  });
}

// jsdom does not implement scrollIntoView (used by the selection effect).
Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value: (): void => {},
});

let queryResolvers: Array<
  (results: ChatSearchQueryResponse['results']) => void
>;
let queryMock: jest.Mock;
let onUpdatedCallback: (() => void) | null;
let onUpdatedUnsubscribe: jest.Mock;

function installChatSearchApi(): void {
  queryResolvers = [];
  onUpdatedCallback = null;
  onUpdatedUnsubscribe = jest.fn();
  queryMock = jest.fn(
    (): Promise<ChatSearchQueryResponse> =>
      new Promise<ChatSearchQueryResponse>((resolve) => {
        queryResolvers.push((results) => resolve({ results }));
      }),
  );
  window.api = {
    ...window.api,
    chatSearch: {
      catalog: jest.fn().mockResolvedValue({ entries: [] }),
      query: queryMock,
      onUpdated: jest.fn((callback: () => void) => {
        onUpdatedCallback = callback;
        return onUpdatedUnsubscribe;
      }),
    },
  };
}

const projects: SingleRepoSidebarItem[] = [
  {
    type: 'single-repo',
    id: 'proj-1',
    name: 'Acme',
    repoPath: '/repos/acme',
    color: '#3366ff',
    collapsed: false,
    order: 0,
    worktrees: [
      {
        id: 'wt-1',
        branchName: 'feature/login',
        createdAt: '2026-07-10T00:00:00.000Z',
        status: 'active',
      },
    ],
  },
];

let root: Root | null = null;

function render(onClose: () => void = jest.fn()): void {
  root = createRoot(document.body);
  act(() => {
    root?.render(createElement(CommandPalette, { initialQuery: '', onClose }));
  });
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function setQuery(value: string): void {
  const input = document.querySelector<HTMLInputElement>(
    '[data-testid="command-palette-input"]',
  );
  if (!input) throw new Error('palette input not found');
  // eslint-disable-next-line @typescript-eslint/unbound-method -- native value setter used to trigger React's onChange
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function pressPaletteKey(key: string): void {
  const palette = document.querySelector('[data-testid="command-palette"]');
  if (!palette) throw new Error('palette not found');
  act(() => {
    palette.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

function sectionLabels(): string[] {
  return Array.from(
    document.querySelectorAll('[data-testid="command-palette-section"]'),
  ).map((node) => node.querySelector('div')?.textContent ?? '');
}

function resultTexts(): string[] {
  return Array.from(
    document.querySelectorAll('[data-testid="command-palette-result"]'),
  ).map((node) => node.textContent ?? '');
}

function setOverflowWorktrees(): void {
  useProjectsStore.setState({
    projects: [
      {
        ...projects[0],
        worktrees: Array.from({ length: 9 }, (_, index) => ({
          id: `overflow-${index + 1}`,
          branchName: `overflow result ${index + 1}`,
          createdAt: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
          status: 'active' as const,
        })),
      },
    ],
    hasHydratedProjects: true,
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  installChatSearchApi();
  jest.spyOn(useAutomationsStore.getState(), 'hydrate').mockResolvedValue();
  jest
    .spyOn(useAppAdvisorWatchersStore.getState(), 'hydrate')
    .mockResolvedValue();
  jest.spyOn(useAgentsStore.getState(), 'load').mockResolvedValue();
  useAgentsStore.setState({ agents: [] });
  useActivityStore.setState({ worktreeSummaries: {} });
  useBranchDisplayStore.setState({ mappings: [], mappingsVersion: 0 });
  const snapshot = getDefaultFeatureFlagSnapshot('ready');
  useFeatureFlagsStore.setState({ snapshot });
  // The Labs page experiments are on, so their commands and agent items show.
  resetLabsExperimentsStoreForTest();
  applyLabsExperimentsSnapshot(
    makeTestLabsSnapshot({ experiments: pageExperimentsOn() }),
  );
  getVisibleNavItemsMock.mockReturnValue([]);
  useProjectsStore.setState({
    projects,
    repoBranches: {},
    hasHydratedProjects: true,
  });
  useChatStore.setState({ selectedWorktree: null, worktreeChats: {} });
  useNavigationStore.setState({ activePage: 'overview' });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = '';
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('CommandPalette rendering', () => {
  it('updates agent items while the palette stays mounted (CAN-4266)', async () => {
    const setAgentsEnabled = (enabled: boolean): void => {
      const snapshot = getDefaultFeatureFlagSnapshot('ready');
      useFeatureFlagsStore.getState().setSnapshot({
        ...snapshot,
        values: {
          ...snapshot.values,
          [CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key]: enabled,
        },
      });
    };
    const setPluginsAvailable = (available: boolean): void => {
      // A fixture experiment owning Plugins refuses the page while it is off.
      applyLabsExperimentsSnapshot(
        makeTestLabsSnapshot({
          revision: available ? 3 : 2,
          earlyAccess: true,
          experiments: [
            ...pageExperimentsOn(),
            {
              id: 'plugins-fixture',
              pages: ['plugins'],
              choice: available,
            },
          ],
        }),
      );
    };
    const hasAgentItem = (): boolean =>
      resultTexts().some((text) => text.includes('Zephyr Reviewer'));
    useAgentsStore.setState({
      agents: [
        {
          id: 'zephyr',
          name: 'Zephyr Reviewer',
          baseModel: 'opus',
          instructions: '',
          pluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
          },
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-01T00:00:00.000Z',
        },
      ],
    });
    setAgentsEnabled(true);
    render();
    await flushMicrotasks();
    setQuery('Zephyr Reviewer');
    expect(hasAgentItem()).toBe(true);
    const input = document.querySelector(
      '[data-testid="command-palette-input"]',
    );

    act(() => setAgentsEnabled(false));
    expect(hasAgentItem()).toBe(false);
    act(() => setAgentsEnabled(true));
    expect(hasAgentItem()).toBe(true);

    act(() => setPluginsAvailable(false));
    expect(hasAgentItem()).toBe(false);
    act(() => setPluginsAvailable(true));
    expect(hasAgentItem()).toBe(true);

    expect(
      document.querySelector('[data-testid="command-palette-input"]'),
    ).toBe(input);
  });

  it('offers no Go to Agents command (CAN-4266)', async () => {
    render();
    await flushMicrotasks();
    setQuery('Go to Agents');

    expect(resultTexts().some((text) => text.includes('Go to Agents'))).toBe(
      false,
    );
  });

  it('describes the search scope in a small input', async () => {
    render();
    await flushMicrotasks();

    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="command-palette-input"]',
    );
    expect(input?.placeholder).toBe(
      'Search chats, workspaces, plugins, settings, and more',
    );
    // The shared lg SearchField header carries the 14px type.
    const field = input?.closest('[data-search-field]');
    expect(field?.getAttribute('data-search-field')).toBe('lg');
    expect(field?.classList.contains('text-s')).toBe(true);
    expect(field?.classList.contains('text-m')).toBe(false);
  });

  it('shows the commands hint for an empty query', async () => {
    render();
    await flushMicrotasks();

    const hint = document.querySelector(
      '[data-testid="command-palette-mode-hint"]',
    );
    expect(hint?.textContent).toBe('Type > for commands');
    expect(hint?.getAttribute('data-mode')).toBe('all');
    expect(hint?.getAttribute('aria-live')).toBe('polite');
    // The prefix is a borderless key cap, not a pill around the whole hint.
    const cap = hint?.querySelector('kbd');
    expect(cap?.textContent).toBe('>');
    expect(cap?.className).toContain('bg-muted');
    expect(hint?.className).not.toContain('bg-secondary');
  });

  it('ends with the key legend as caps, not words', async () => {
    render();
    await flushMicrotasks();

    const footer = document.querySelector('[data-testid="key-hint-footer"]');
    expect(footer?.textContent).toMatch(/^↑↓move(↵|Enter)open(esc|Esc)close$/);
    expect(footer?.querySelectorAll('kbd')).toHaveLength(4);
  });

  it('updates the hint when entering and leaving commands-only mode', async () => {
    render();
    await flushMicrotasks();
    setQuery('>');

    const hint = document.querySelector(
      '[data-testid="command-palette-mode-hint"]',
    );
    expect(hint?.textContent).toBe('Commands only');
    expect(hint?.getAttribute('data-mode')).toBe('commands');

    setQuery('demo');
    expect(hint?.textContent).toBe('Type > for commands');
    expect(hint?.getAttribute('data-mode')).toBe('all');
  });

  it('names the dialog Search', async () => {
    render();
    await flushMicrotasks();

    const dialog = document.querySelector(
      '[data-testid="command-palette"][role="dialog"]',
    );
    expect(dialog?.getAttribute('aria-label')).toBe('Search');
  });

  it('hides Code Graph from settings navigation when its flag is off', async () => {
    const snapshot = useFeatureFlagsStore.getState().snapshot;
    useFeatureFlagsStore.setState({
      snapshot: {
        ...snapshot,
        values: {
          ...snapshot.values,
          'canopy-desktop-cursor-harness': false,
          'canopy-desktop-workspace-code-graph': false,
        },
      },
    });

    render();
    await flushMicrotasks();

    // Experiments is never flag-gated; only the Code Graph page follows the
    // code graph flag.
    expect(getVisibleNavItemsMock).toHaveBeenCalledWith(
      window.platform,
      true,
      false,
      // The account proxy page stays hidden until the user opts in.
      false,
      false,
      { hostedLayout: false },
    );
  });

  describe('settings sections with hosted settings', () => {
    const settingRows = (title: string): Element[] =>
      Array.from(
        document.querySelectorAll('[data-testid="command-palette-result"]'),
      ).filter(
        (node) =>
          node.textContent?.includes(title) === true &&
          node.textContent.includes('Settings'),
      );

    beforeEach(() => {
      const actual = jest.requireActual<typeof SettingsNavModule>(
        '@/components/settings/SettingsNav',
      );
      getVisibleNavItemsMock.mockImplementation(actual.getVisibleNavItems);
    });

    afterEach(() => {
      getVisibleNavItemsMock.mockImplementation((): never[] => []);
      mockUseHostedSettingsAvailable.mockReturnValue(false);
    });

    it('lists Notifications and Providers in the hosted layout', async () => {
      mockUseHostedSettingsAvailable.mockReturnValue(true);
      render();
      await flushMicrotasks();

      expect(getVisibleNavItemsMock).toHaveBeenLastCalledWith(
        window.platform,
        true,
        expect.any(Boolean),
        false,
        false,
        { hostedLayout: true },
      );
      setQuery('Notifications');
      expect(settingRows('Notifications')).toHaveLength(1);
      setQuery('Providers');
      expect(settingRows('Providers')).toHaveLength(1);
      setQuery('Accounts');
      expect(settingRows('Accounts')).toHaveLength(0);
    });

    it('lists the hosted account pages and Organizations once, in the hosted layout', async () => {
      mockUseHostedSettingsAvailable.mockReturnValue(true);
      mockPaletteAccountFacts.mockReturnValue({
        personalOrganizationId: null,
        freeAccess: true,
      });
      const snapshot = getDefaultFeatureFlagSnapshot('ready');
      snapshot.values['canopy-billing-enabled'] = true;
      useFeatureFlagsStore.setState({ snapshot });
      try {
        render();
        await flushMicrotasks();
        setQuery('Organizations');
        expect(settingRows('Organizations')).toHaveLength(1);
        setQuery('Security');
        expect(settingRows('Security')).toHaveLength(1);
        // Billing reads AI Credits under free access, as on the rail.
        setQuery('AI Credits');
        expect(settingRows('AI Credits')).toHaveLength(1);
        // The existing Notifications entry already opens the hosted page.
        setQuery('Notifications');
        expect(settingRows('Notifications')).toHaveLength(1);
      } finally {
        mockPaletteAccountFacts.mockReturnValue({
          personalOrganizationId: null,
          freeAccess: false,
        });
      }
    });

    it('hides a flag-off account page', async () => {
      mockUseHostedSettingsAvailable.mockReturnValue(true);
      const snapshot = getDefaultFeatureFlagSnapshot('ready');
      snapshot.values['canopy-billing-enabled'] = false;
      useFeatureFlagsStore.setState({ snapshot });
      render();
      await flushMicrotasks();
      setQuery('Billing');
      expect(settingRows('Billing')).toHaveLength(0);
    });

    it('lists the selected context organization pages in the hosted layout', async () => {
      const ACME = '11111111-1111-4111-8111-111111111111';
      mockUseHostedSettingsAvailable.mockReturnValue(true);
      useWorkspaceContextStore.setState({
        hydrated: true,
        state: {
          context: { kind: 'organization', organizationId: ACME },
          organizations: [{ id: ACME, name: 'Acme', role: 'MEMBER' }],
          revision: 1,
        },
      });
      try {
        render();
        await flushMicrotasks();
        setQuery('Open Acme');
        const rows = resultTexts();
        expect(rows.some((row) => row.includes('Open Acme Timeline'))).toBe(
          true,
        );
        expect(rows.some((row) => row.includes('Open Acme Members'))).toBe(
          true,
        );
        // A member gets no Statistics, as on the context switcher.
        expect(rows.some((row) => row.includes('Open Acme Statistics'))).toBe(
          false,
        );
        // The page was called Feed, so that word still finds it.
        for (const query of ['timeline', 'feed']) {
          setQuery(query);
          expect(
            resultTexts().some((row) => row.includes('Open Acme Timeline')),
          ).toBe(true);
        }
      } finally {
        useWorkspaceContextStore.setState(
          useWorkspaceContextStore.getInitialState(),
          true,
        );
      }
    });

    it('lists no organization pages while the context is not known', async () => {
      mockUseHostedSettingsAvailable.mockReturnValue(true);
      mockPaletteAccountFacts.mockReturnValue({
        personalOrganizationId: '44444444-4444-4444-8444-444444444444',
        freeAccess: false,
      });
      try {
        useWorkspaceContextStore.setState({ hydrated: false });
        render();
        await flushMicrotasks();
        setQuery('Open Personal');
        expect(
          resultTexts().some((row) => row.includes('Open Personal Timeline')),
        ).toBe(false);
      } finally {
        mockPaletteAccountFacts.mockReturnValue({
          personalOrganizationId: null,
          freeAccess: false,
        });
      }
    });

    it('keeps the legacy sections without hosted settings', async () => {
      render();
      await flushMicrotasks();
      setQuery('Organizations');
      expect(settingRows('Organizations')).toHaveLength(0);

      setQuery('Notifications');
      expect(settingRows('Notifications')).toHaveLength(1);
      setQuery('Accounts');
      expect(settingRows('Accounts')).toHaveLength(1);
      setQuery('Providers');
      expect(settingRows('Providers')).toHaveLength(0);
    });
  });

  it.each(['Enter to run', 'Esc to close', 'to navigate'])(
    'omits the footer hint %s',
    async (hint) => {
      render();
      await flushMicrotasks();
      expect(document.body.textContent).not.toContain(hint);
    },
  );

  it('omits the command category pill while retaining its shortcut', async () => {
    render();
    await flushMicrotasks();
    setQuery('>');
    const row = Array.from(
      document.querySelectorAll('[data-testid="command-palette-result"]'),
    ).find((node) => node.textContent?.includes('Keyboard shortcuts'));
    expect(row).toBeDefined();
    expect(
      row?.querySelector('[data-testid="command-palette-shortcut"]'),
    ).not.toBeNull();
    expect(
      Array.from(
        row?.querySelectorAll('[data-testid="command-palette-status-badge"]') ??
          [],
      ).map((node) => node.textContent),
    ).not.toContain('settings');
  });

  it.each([undefined, 'claude'])(
    'renders the OFF status pill with provider %s',
    (providerType) => {
      const item: PaletteItem = {
        id: 'automation:off',
        kind: 'automation',
        title: 'Nightly',
        navigation: { type: 'automation', activityId: 'off' },
        statusBadge: 'OFF',
        providerType,
        execute: () => ({ closePalette: true }),
      };
      root = createRoot(document.body);
      act(() => {
        root?.render(
          createElement(
            'ul',
            null,
            createElement(PaletteResultRow, {
              item,
              titleIndices: [],
              index: 0,
              isSelected: false,
              onHover: jest.fn(),
              onActivate: jest.fn(),
              registerRef: jest.fn(),
            }),
          ),
        );
      });
      expect(
        document.querySelector('[data-testid="command-palette-status-badge"]')
          ?.textContent,
      ).toBe('OFF');
    },
  );

  it('expands a truncated section by pointer and collapses it after the query changes', async () => {
    setOverflowWorktrees();
    render();
    await flushMicrotasks();
    setQuery('overflow');

    const showMore = document.querySelector<HTMLButtonElement>(
      '[data-testid="command-palette-show-more"]',
    );
    expect(showMore?.textContent).toContain('Show 3 more');
    expect(
      showMore
        ?.closest('[data-palette-section]')
        ?.getAttribute('data-palette-section'),
    ).toBe('worktrees');
    expect(document.body.textContent).not.toContain('+3 more');

    act(() => showMore?.click());
    expect(
      document.querySelectorAll(
        '[data-palette-section="worktrees"] [data-testid="command-palette-result"]',
      ),
    ).toHaveLength(9);
    expect(
      document.querySelector('[data-testid="command-palette-show-more"]'),
    ).toBeNull();
    expect(
      document.querySelector<HTMLInputElement>(
        '[data-testid="command-palette-input"]',
      ),
    ).toBe(document.activeElement);

    setQuery('overflow result');
    expect(
      document.querySelectorAll(
        '[data-palette-section="worktrees"] [data-testid="command-palette-result"]',
      ),
    ).toHaveLength(6);
    expect(
      document.querySelector('[data-testid="command-palette-show-more"]'),
    ).not.toBeNull();
  });

  it('centers the dialog within the full app window', () => {
    render();

    const palette = document.querySelector('[data-testid="command-palette"]');
    expect(palette?.parentElement?.className).toContain('fixed inset-0');
    expect(palette?.parentElement?.className).toContain('items-center');
    expect(palette?.parentElement?.className).toContain('justify-center');
    expect(palette?.parentElement?.className).not.toContain('pt-[10vh]');
  });

  it('closes on Escape after focus moves outside the palette', async () => {
    const onClose = jest.fn();
    render(onClose);
    await flushMicrotasks();

    document.body.tabIndex = -1;
    document.body.focus();
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hands no results to the search empty state, with Clear search', async () => {
    render();
    await flushMicrotasks();
    setQuery('zzqxv-no-such-thing');

    const empty = document.querySelector(
      '[data-testid="command-palette-empty"]',
    );
    expect(empty?.textContent).toContain('Nothing matches your search.');
    const clear = document.querySelector<HTMLButtonElement>(
      '[data-testid="command-palette-empty-clear"]',
    );
    expect(clear?.textContent).toBe('Clear search');
    act(() => {
      clear?.click();
    });
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="command-palette-input"]',
    );
    expect(input?.value).toBe('');
    expect(document.activeElement).toBe(input);
  });

  it('lets Enter press a focused Clear button instead of opening a result', async () => {
    const onClose = jest.fn();
    render(onClose);
    await flushMicrotasks();
    setQuery('demo');
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="command-palette-input"]',
    );
    const clear = document.querySelector<HTMLButtonElement>(
      '[data-testid="command-palette-clear"]',
    );
    expect(clear).toBeInstanceOf(HTMLButtonElement);
    act(() => {
      clear?.focus();
    });
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      clear?.dispatchEvent(enter);
    });
    // The palette leaves the key to the button: no result opens.
    expect(enter.defaultPrevented).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(input?.value).toBe('demo');

    // The empty state's action, likewise.
    setQuery('zzqxv-no-such-thing');
    const emptyClear = document.querySelector<HTMLButtonElement>(
      '[data-testid="command-palette-empty-clear"]',
    );
    expect(emptyClear).toBeInstanceOf(HTMLButtonElement);
    const enterOnEmpty = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      emptyClear?.dispatchEvent(enterOnEmpty);
    });
    expect(enterOnEmpty.defaultPrevented).toBe(false);
  });

  it('opens the highlighted result on Enter from a focused result row', async () => {
    render();
    await flushMicrotasks();
    setQuery('login');
    const row = document.querySelector<HTMLElement>(
      '[role="listbox"] [role="option"]',
    );
    expect(row).toBeInstanceOf(HTMLElement);
    act(() => {
      row?.focus();
    });
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      row?.dispatchEvent(enter);
    });
    // The palette's handler still owns Enter inside the results.
    expect(enter.defaultPrevented).toBe(true);
  });

  it('clears from the nested button and still closes on one Escape', async () => {
    const onClose = jest.fn();
    render(onClose);
    await flushMicrotasks();
    setQuery('demo');

    const clear = document.querySelector<HTMLButtonElement>(
      '[data-testid="command-palette-clear"]',
    );
    expect(clear?.getAttribute('aria-label')).toBe('Clear search');
    act(() => {
      clear?.click();
    });
    expect(
      document.querySelector<HTMLInputElement>(
        '[data-testid="command-palette-input"]',
      )?.value,
    ).toBe('');

    // Escape typed into the field with a query still closes the palette.
    setQuery('demo');
    const input = document.querySelector(
      '[data-testid="command-palette-input"]',
    );
    act(() => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes only once when Escape starts inside the palette', async () => {
    const onClose = jest.fn();
    render(onClose);
    await flushMicrotasks();

    pressPaletteKey('Escape');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders a grouped worktree row for a tier-0 match', async () => {
    render();
    await flushMicrotasks();
    setQuery('login');
    expect(sectionLabels()).toContain('Worktrees');
    expect(resultTexts().some((text) => text.includes('feature/login'))).toBe(
      true,
    );
    expect(
      document.querySelector('[data-testid="command-palette-kind-worktree"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="command-palette-worktree-status"]'),
    ).not.toBeNull();
  });

  it('searches and surfaces mapped and manually applied worktree labels', async () => {
    useProjectsStore.setState({
      projects: [
        {
          ...projects[0],
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'feature/login',
              createdAt: '2026-07-10T00:00:00.000Z',
              status: 'active',
            },
            {
              id: 'wt-manual',
              branchName: 'feature/raw-manual-branch',
              label: 'Manual Worktree Label',
              createdAt: '2026-07-11T00:00:00.000Z',
              status: 'active',
            },
          ],
        },
      ],
      hasHydratedProjects: true,
    });
    useBranchDisplayStore.getState().setMappings([
      {
        id: 'test-file-tab-labels',
        label: 'Test file tab labels',
        matcher: '^feature/login$',
        result: 'File Tab Labels',
        settings: { replaceHyphens: false, capitalize: false },
        enabled: true,
        builtin: false,
        examples: [],
        readonlyExampleCount: 0,
      },
    ]);

    render();
    await flushMicrotasks();

    setQuery('File Tab Labels');
    expect(sectionLabels()).toContain('Worktrees');
    expect(resultTexts()).toEqual(
      expect.arrayContaining([expect.stringContaining('File Tab Labels')]),
    );
    expect(document.body.textContent).not.toContain('feature/login');

    setQuery('Manual Worktree Label');
    expect(sectionLabels()).toContain('Worktrees');
    expect(resultTexts()).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Manual Worktree Label'),
      ]),
    );
  });

  it('searches and surfaces the divergent multi-repo branch label', async () => {
    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'proj-1',
          name: 'Acme',
          color: '#3366ff',
          collapsed: false,
          order: 0,
          repos: [
            { id: 'api', name: 'API', repoPath: '/repos/acme/api' },
            { id: 'web', name: 'Web', repoPath: '/repos/acme/web' },
          ],
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'feature/api-only',
              createdAt: '2026-07-10T00:00:00.000Z',
              status: 'active',
            },
          ],
        },
      ],
      repoBranches: {
        'proj-1/wt-1': [
          { repoId: 'api', repoName: 'API', branch: 'feature/api-only' },
          { repoId: 'web', repoName: 'Web', branch: 'feature/web-only' },
        ],
      },
      hasHydratedProjects: true,
    });

    render();
    await flushMicrotasks();

    setQuery('Multiple branches');
    expect(sectionLabels()).toContain('Worktrees');
    expect(resultTexts()).toEqual(
      expect.arrayContaining([expect.stringContaining('Multiple branches')]),
    );
  });

  it('restricts results to commands with the > prefix', async () => {
    render();
    await flushMicrotasks();
    setQuery('>');
    const labels = sectionLabels();
    expect(labels).toEqual(['Commands']);
    expect(labels).not.toContain('Worktrees');
  });

  it('right-aligns available action shortcuts in the quietest foreground', async () => {
    render();
    await flushMicrotasks();
    setQuery('>');

    const shortcuts = document.querySelectorAll(
      '[data-testid="command-palette-shortcut"]',
    );
    expect(shortcuts.length).toBeGreaterThan(0);
    shortcuts.forEach((shortcut) => {
      expect(shortcut.className).toContain('fg-quaternary');
      expect(shortcut.parentElement?.className).toContain('shrink-0');
    });
  });
});

describe('CommandPalette session-replay privacy', () => {
  it('records the results container in session replay', async () => {
    render();
    await flushMicrotasks();
    setQuery('>');

    const results = document.querySelector(
      '[role="listbox"][aria-label="Results"]',
    )?.parentElement;
    expect(results?.parentElement?.getAttribute('data-testid')).toBe(
      'command-palette',
    );
    expect(results?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
    expect(
      results?.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`) ?? null,
    ).toBeNull();
  });

  it('records the error alert', async () => {
    useChatStore.setState({
      selectedWorktree: { projectId: 'proj-1', worktreeId: 'wt-1' },
    });
    render();
    await flushMicrotasks();
    setQuery('>Open pull request');
    pressPaletteKey('Enter');
    await flushMicrotasks();

    const alert = document.querySelector(
      '[data-testid="command-palette"] [role="alert"]',
    );
    expect(alert?.textContent).toBe('No pull request found for this worktree.');
    expect(alert?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`) ?? null).toBeNull();
  });

  function renderRow(item: PaletteItem): void {
    root = createRoot(document.body);
    act(() => {
      root?.render(
        createElement(
          'ul',
          null,
          createElement(PaletteResultRow, {
            item,
            titleIndices: [],
            index: 0,
            isSelected: false,
            onHover: jest.fn(),
            onActivate: jest.fn(),
            registerRef: jest.fn(),
          }),
        ),
      );
    });
  }

  it('blocks only a transcript snippet subtitle, keeping the row title recorded', () => {
    renderRow({
      id: 'chat-content:proj-1/wt-1/c-1',
      kind: 'chat-content',
      navigation: {
        type: 'chat-content',
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        chatId: 'c-1',
        source: 'live',
      },
      title: 'Chat title',
      subtitle: 'quoted transcript text',
      subtitleMatchRanges: [{ start: 0, end: 6 }],
      execute: () => ({ closePalette: true }),
    });
    const row = document.querySelector(
      '[data-testid="command-palette-result"]',
    );
    const blocks = row?.querySelectorAll(`.${POSTHOG_REPLAY_BLOCK_CLASS}`);
    expect(blocks).toHaveLength(1);
    expect(blocks?.[0].textContent).toBe('quoted transcript text');
    expect(row?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
  });

  it('blocks a subtitle flagged as quoting a prompt', () => {
    renderRow({
      id: 'agent:reviewer',
      kind: 'agent',
      title: 'Reviewer',
      subtitle: 'Review code carefully.',
      subtitleReplayBlocked: true,
      navigation: { type: 'agent', agentId: 'reviewer' },
      execute: () => ({ closePalette: true }),
    });
    const blocks = document.querySelectorAll(`.${POSTHOG_REPLAY_BLOCK_CLASS}`);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].textContent).toBe('Review code carefully.');
  });

  it('records a plain subtitle', () => {
    renderRow({
      id: 'automation:on',
      kind: 'automation',
      title: 'Nightly',
      subtitle: 'Every day at 9:00',
      navigation: { type: 'automation', activityId: 'on' },
      execute: () => ({ closePalette: true }),
    });
    expect(document.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
  });
});

describe('CommandPalette tier-2 request tokens', () => {
  it('keeps transcript results when the same chat title did not match the query', async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest needs the mocked API method reference.
    const catalog = jest.mocked(window.api.chatSearch.catalog);
    catalog.mockResolvedValue({
      entries: [
        {
          docId: 'proj-1/wt-1/c-shared/live',
          projectId: 'proj-1',
          worktreeId: 'wt-1',
          chatId: 'c-shared',
          source: 'live',
          title: 'Unrelated title',
          providerType: 'claude',
          updatedAt: 3,
          messageCount: 1,
        },
      ],
    });
    render();
    await flushMicrotasks();

    setQuery('zzqv');
    act(() => {
      jest.advanceTimersByTime(210);
    });
    await act(async () => {
      queryResolvers[0]([
        {
          docId: 'proj-1/wt-1/c-shared/live',
          projectId: 'proj-1',
          worktreeId: 'wt-1',
          chatId: 'c-shared',
          source: 'live',
          title: 'Unrelated title',
          providerType: 'claude',
          updatedAt: 3,
          messageCount: 1,
          snippet: 'A transcript zzqv appears here',
          matchRanges: [{ start: 13, end: 17 }],
        },
      ]);
      await Promise.resolve();
    });

    expect(sectionLabels()).toContain('In content');
    expect(
      resultTexts().some((text) =>
        text.includes('Unrelated titleA transcript zzqv appears here'),
      ),
    ).toBe(true);
    expect(
      document.querySelector('[data-testid="command-palette-provider-claude"]'),
    ).not.toBeNull();
    expect(
      document.querySelector(
        '[data-testid="command-palette-kind-chat-content"]',
      ),
    ).not.toBeNull();
  });

  it('ignores a stale transcript response and keeps the latest', async () => {
    render();
    await flushMicrotasks();

    // First settled query.
    setQuery('alpha');
    act(() => {
      jest.advanceTimersByTime(210);
    });
    // Second settled query (>200ms later so both fire and are in flight).
    setQuery('bravo');
    act(() => {
      jest.advanceTimersByTime(210);
    });

    expect(queryMock).toHaveBeenCalledTimes(2);

    // Resolve the LATEST query first, then the stale earlier one.
    await act(async () => {
      queryResolvers[1]([
        {
          docId: 'proj-1/wt-1/c-new/live',
          projectId: 'proj-1',
          worktreeId: 'wt-1',
          chatId: 'c-new',
          source: 'live',
          title: 'Bravo transcript',
          updatedAt: 2,
          messageCount: 1,
          snippet: 'bravo snippet body',
          matchRanges: [],
        },
      ]);
      await Promise.resolve();
    });
    await act(async () => {
      queryResolvers[0]([
        {
          docId: 'proj-1/wt-1/c-old/live',
          projectId: 'proj-1',
          worktreeId: 'wt-1',
          chatId: 'c-old',
          source: 'live',
          title: 'Alpha transcript',
          updatedAt: 1,
          messageCount: 1,
          snippet: 'alpha snippet body',
          matchRanges: [],
        },
      ]);
      await Promise.resolve();
    });

    const texts = resultTexts();
    expect(texts.some((t) => t.includes('Bravo transcript'))).toBe(true);
    expect(texts.some((t) => t.includes('Alpha transcript'))).toBe(false);
    expect(sectionLabels()).toContain('In content');
  });

  it('removes prior transcript rows as soon as a new valid query starts', async () => {
    render();
    await flushMicrotasks();

    setQuery('alpha');
    act(() => {
      jest.advanceTimersByTime(210);
    });
    await act(async () => {
      queryResolvers[0]([
        {
          docId: 'proj-1/wt-1/c-old/live',
          projectId: 'proj-1',
          worktreeId: 'wt-1',
          chatId: 'c-old',
          source: 'live',
          title: 'Alpha transcript',
          updatedAt: 1,
          messageCount: 1,
          snippet: 'alpha snippet body',
          matchRanges: [],
        },
      ]);
      await Promise.resolve();
    });
    expect(
      resultTexts().some((text) => text.includes('Alpha transcript')),
    ).toBe(true);

    setQuery('bravo');
    act(() => {
      jest.advanceTimersByTime(1);
    });

    expect(
      resultTexts().some((text) => text.includes('Alpha transcript')),
    ).toBe(false);
  });
});

describe('CommandPalette live refresh (onUpdated)', () => {
  it('refreshes the catalog when a pending content refresh is cancelled', async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest needs the mocked API method reference.
    const catalog = jest.mocked(window.api.chatSearch.catalog);
    render();
    await flushMicrotasks();
    expect(catalog).toHaveBeenCalledTimes(1);

    setQuery('originalneedle');
    act(() => {
      onUpdatedCallback?.();
    });
    setQuery('differentneedle');
    setQuery('originalneedle');
    await act(async () => {
      jest.advanceTimersByTime(210);
      await Promise.resolve();
    });

    expect(catalog).toHaveBeenCalledTimes(2);
  });

  it('keeps settled content rows visible while the same query refreshes', async () => {
    render();
    await flushMicrotasks();

    setQuery('steadyneedle');
    act(() => {
      jest.advanceTimersByTime(210);
    });
    await act(async () => {
      queryResolvers[0]([
        {
          docId: 'proj-1/wt-1/steady/live',
          projectId: 'proj-1',
          worktreeId: 'wt-1',
          chatId: 'steady',
          source: 'live',
          title: 'Steady transcript',
          updatedAt: 1,
          messageCount: 1,
          snippet: 'The steadyneedle remains visible',
          matchRanges: [{ start: 4, end: 16 }],
        },
      ]);
      await Promise.resolve();
    });
    expect(sectionLabels()).toContain('In content');

    await act(async () => {
      onUpdatedCallback?.();
      jest.advanceTimersByTime(210);
      await Promise.resolve();
    });

    // The backend refresh is still in flight. The settled section must remain
    // mounted instead of disappearing for the refresh debounce/request gap.
    expect(sectionLabels()).toContain('In content');
    expect(
      resultTexts().some((text) => text.includes('Steady transcript')),
    ).toBe(true);

    await act(async () => {
      queryResolvers[1]([
        {
          docId: 'proj-1/wt-1/refreshed/live',
          projectId: 'proj-1',
          worktreeId: 'wt-1',
          chatId: 'refreshed',
          source: 'live',
          title: 'Refreshed transcript',
          updatedAt: 2,
          messageCount: 2,
          snippet: 'The steadyneedle result transitioned',
          matchRanges: [{ start: 4, end: 16 }],
        },
      ]);
      await Promise.resolve();
    });
    expect(sectionLabels()).toContain('In content');
    expect(
      resultTexts().some((text) => text.includes('Refreshed transcript')),
    ).toBe(true);
  });

  it('preserves the selected item identity when refreshed rows reorder the list', async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest needs the mocked API method reference.
    const catalog = jest.mocked(window.api.chatSearch.catalog);
    const alpha = {
      docId: 'proj-1/wt-1/alpha/live',
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      chatId: 'alpha',
      source: 'live' as const,
      title: 'Fresh alpa',
      updatedAt: 10,
      messageCount: 1,
    };
    const beta = {
      ...alpha,
      docId: 'proj-1/wt-1/beta/live',
      chatId: 'beta',
      title: 'Fresh beta',
      updatedAt: 9,
    };
    catalog
      .mockResolvedValueOnce({ entries: [alpha, beta] })
      .mockResolvedValue({
        entries: [
          {
            ...alpha,
            docId: 'proj-1/wt-1/exact/live',
            chatId: 'exact',
            title: 'fresh',
            updatedAt: 11,
          },
          alpha,
          beta,
        ],
      });

    render();
    await flushMicrotasks();
    setQuery('fresh');
    pressPaletteKey('ArrowDown');
    expect(
      Array.from(document.querySelectorAll('[role="option"]'))
        .find((node) => node.textContent?.includes('Fresh beta'))
        ?.getAttribute('aria-selected'),
    ).toBe('true');

    act(() => {
      onUpdatedCallback?.();
      jest.advanceTimersByTime(210);
    });
    await flushMicrotasks();

    expect(
      Array.from(document.querySelectorAll('[role="option"]'))
        .find((node) => node.textContent?.includes('Fresh beta'))
        ?.getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('re-fetches the catalog and re-issues the settled query on an index update', async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest needs the mocked API method reference.
    const catalog = jest.mocked(window.api.chatSearch.catalog);
    catalog.mockResolvedValueOnce({ entries: [] }).mockResolvedValue({
      entries: [
        {
          docId: 'proj-1/wt-1/c-fresh/live',
          projectId: 'proj-1',
          worktreeId: 'wt-1',
          chatId: 'c-fresh',
          source: 'live',
          title: 'Fresh scan chat',
          providerType: 'claude',
          updatedAt: 9,
          messageCount: 1,
        },
      ],
    });
    render();
    await flushMicrotasks();
    expect(catalog).toHaveBeenCalledTimes(1);

    // Settle a tier-2 query (matching the about-to-be-indexed chat title) so
    // the refresh must both surface the chat and re-issue the query.
    setQuery('fresh');
    act(() => {
      jest.advanceTimersByTime(210);
    });
    expect(queryMock).toHaveBeenCalledTimes(1);

    // The backend broadcasts an index change; a debounce then applies it.
    act(() => {
      onUpdatedCallback?.();
      jest.advanceTimersByTime(210);
    });
    await flushMicrotasks();

    // Tier 1 re-fetched with the newly-indexed chat.
    expect(catalog).toHaveBeenCalledTimes(2);
    expect(resultTexts().some((text) => text.includes('Fresh scan chat'))).toBe(
      true,
    );

    // Tier 2 re-issued with a fresh token after its own debounce.
    act(() => {
      jest.advanceTimersByTime(210);
    });
    expect(queryMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('unsubscribes from onUpdated when the palette closes', async () => {
    render();
    await flushMicrotasks();
    expect(onUpdatedCallback).not.toBeNull();

    act(() => {
      root?.unmount();
    });
    root = null;

    expect(onUpdatedUnsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('CommandPalette automation context scoping (CAN-3448)', () => {
  const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  afterEach(() => {
    useWorkspaceContextStore.setState({ hydrated: false });
    useAutomationsStore.setState({ activities: [] });
    useAppAdvisorWatchersStore.setState({ watchers: [] });
  });

  it('lists only automations and watchers in the selected context', async () => {
    const snapshot = getDefaultFeatureFlagSnapshot('ready');
    snapshot.values['canopy-shared-org-projects-enabled'] = true;
    useFeatureFlagsStore.setState({ snapshot });
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context: { kind: 'organization', organizationId: ORG },
        organizations: [{ id: ORG, name: 'Acme', role: 'MEMBER' }],
        revision: 1,
      },
    });
    useProjectsStore.setState({
      projects: [
        { ...projects[0], id: 'chats', name: 'Chats', owner: undefined },
        {
          ...projects[0],
          id: 'org-project',
          name: 'Org Project',
          owner: {
            type: 'organization',
            organizationId: ORG,
            projectId: '11111111-1111-4111-8111-111111111111',
            instanceId: '22222222-2222-4222-8222-222222222222',
            bindingGeneration: 0,
          },
        },
      ],
      hasHydratedProjects: true,
    });
    const base = {
      version: 1 as const,
      enabled: true,
      schedule: {
        kind: 'cron' as const,
        expression: '0 9 * * *',
        timezone: 'local' as const,
      },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      failureCount: 0,
    };
    useAutomationsStore.setState({
      activities: [
        {
          ...base,
          id: 'personal',
          name: 'Zebra personal digest',
          action: {
            type: 'standalone_prompt',
            chatProjectId: 'chats',
            prompt: 'Digest',
          },
        },
        {
          ...base,
          id: 'org',
          name: 'Zebra org digest',
          action: {
            type: 'worktree_prompt',
            workspaceId: 'org-project',
            prompt: 'Digest',
          },
        },
      ],
    });
    render();
    await flushMicrotasks();
    setQuery('Zebra');
    const texts = resultTexts().join(' ');
    expect(texts).toContain('Zebra org digest');
    expect(texts).not.toContain('Zebra personal digest');
  });
});

describe('CommandPalette live context commands', () => {
  it('updates after hydration, flag changes, and context broadcasts without remounting', async (): Promise<void> => {
    const snapshot = getDefaultFeatureFlagSnapshot('ready');
    snapshot.values['canopy-shared-org-projects-enabled'] = true;
    useFeatureFlagsStore.setState({ snapshot });
    useWorkspaceContextStore.setState({
      state: { context: { kind: 'personal' }, organizations: [], revision: 0 },
    });
    render();
    await flushMicrotasks();
    setQuery('> Switch to');
    expect(resultTexts().join(' ')).not.toContain('Switch to Acme');
    act((): void => {
      useWorkspaceContextStore.setState({
        hydrated: true,
        state: {
          context: { kind: 'personal' },
          organizations: [{ id: 'org-acme', name: 'Acme', role: 'MEMBER' }],
          revision: 1,
        },
      });
    });
    expect(resultTexts().join(' ')).toContain('Switch to Acme');
    act((): void => {
      useWorkspaceContextStore.getState().applyBroadcast({
        ...useWorkspaceContextStore.getState().state,
        context: { kind: 'organization', organizationId: 'org-acme' },
        revision: 2,
        reason: 'switch',
      });
    });
    expect(resultTexts()).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Switch to AcmeCurrent context'),
      ]),
    );
    act((): void => {
      useFeatureFlagsStore.setState({
        snapshot: {
          ...snapshot,
          values: {
            ...snapshot.values,
            'canopy-shared-org-projects-enabled': false,
          },
        },
      });
    });
    expect(resultTexts().join(' ')).not.toContain('Switch to Acme');
    act((): void => {
      useFeatureFlagsStore.setState({ snapshot });
    });
    expect(resultTexts().join(' ')).toContain('Switch to Acme');
  });
});
