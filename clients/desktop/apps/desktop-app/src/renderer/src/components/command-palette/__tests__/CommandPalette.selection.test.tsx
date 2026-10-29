/**
 * @jest-environment jsdom
 *
 * Regression coverage for default-selection stability: a weak-scoring
 * marketplace-plugin match renders in a section above the pinned-last
 * commands section, but the default selection (and therefore Enter) must
 * target the best-scoring item. Mirrors the createRoot + act harness used by
 * CommandPalette.render.test.tsx.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { useProjectsStore } from '@/stores/projectsStore';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import {
  applyLabsExperimentsSnapshot,
  resetLabsExperimentsStoreForTest,
} from '@/stores/labsExperimentsStore';
import {
  makeTestLabsSnapshot,
  pageExperimentsOn,
} from '@/test-utils/labsExperiments';
import { CommandPalette } from '../CommandPalette';

const overflowProjects = [
  {
    type: 'single-repo' as const,
    id: 'overflow-project',
    name: 'Overflow project',
    repoPath: '/repos/overflow',
    color: '#3366ff',
    collapsed: false,
    order: 0,
    worktrees: Array.from({ length: 9 }, (_, index) => ({
      id: `overflow-${index + 1}`,
      branchName: `overflow result ${index + 1}`,
      createdAt: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      status: 'active' as const,
    })),
  },
];

jest.mock('@/hooks/usePipelineList', () => ({
  usePipelineList: (): {
    pipelines: never[];
    loading: boolean;
    error: null;
  } => ({ pipelines: [], loading: false, error: null }),
}));
jest.mock('@/hooks/useMarketplaceList', () => ({
  useMarketplaceList: (): {
    cache: {
      marketplaces: Array<{
        id: string;
        plugins: Array<{
          name: string;
          description: string;
          category: string;
          author: string;
          sourcePath: string;
          marketplaceId: string;
        }>;
      }>;
    };
    loading: boolean;
    error: null;
  } => ({
    cache: {
      marketplaces: [
        {
          id: 'demo/market',
          plugins: [
            {
              name: 'nvidia',
              description:
                'Skills for NVIDIAs ecosystem spans GPU acceleration, CUDA, AI agents, inference, robotics, Physical AI, Omniverse, and simulation. This plugin helps you understand the pieces, choose a path, validate your setup, and build practical NVIDIA-powered workflows.',
              category: 'Developer Tools',
              author: 'NVIDIA',
              sourcePath: '/tmp/nvidia',
              marketplaceId: 'demo/market',
            },
          ],
        },
      ],
    },
    loading: false,
    error: null,
  }),
}));
jest.mock('@/hooks/useSkillList', () => ({
  useSkillList: (): { skills: never[]; loading: boolean; error: null } => ({
    skills: [],
    loading: false,
    error: null,
  }),
}));
jest.mock('@/components/settings/SettingsNav', () => ({
  getVisibleNavItems: (): never[] => [],
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

Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  writable: true,
  value: (): void => {},
});

function installChatSearchApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      chatSearch: {
        catalog: jest.fn().mockResolvedValue({ entries: [] }),
        query: jest.fn().mockResolvedValue({ results: [] }),
        onUpdated: jest.fn().mockReturnValue(() => {}),
      },
    },
  });
}

let root: Root | null = null;

function render(): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(CommandPalette, { initialQuery: '', onClose: () => {} }),
    );
  });
}

function setPaletteQuery(value: string): void {
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

function selectedOptionText(): string {
  const selected = document.querySelector(
    '[role="option"][aria-selected="true"]',
  );
  return selected?.textContent ?? '';
}

beforeEach(() => {
  jest.useFakeTimers();
  installChatSearchApi();
  jest.spyOn(useAutomationsStore.getState(), 'hydrate').mockResolvedValue();
  jest
    .spyOn(useAppAdvisorWatchersStore.getState(), 'hydrate')
    .mockResolvedValue();
  jest.spyOn(useAgentsStore.getState(), 'load').mockResolvedValue();
  const snapshot = getDefaultFeatureFlagSnapshot('ready');
  useFeatureFlagsStore.setState({ snapshot });
  useProjectsStore.setState({ projects: [], hasHydratedProjects: true });
  useChatStore.setState({ selectedWorktree: null, worktreeChats: {} });
  useNavigationStore.setState({ activePage: 'plugins' });
  // The Labs page experiments are on, so 'Open Statistics' is offered.
  resetLabsExperimentsStoreForTest();
  applyLabsExperimentsSnapshot(
    makeTestLabsSnapshot({ experiments: pageExperimentsOn() }),
  );
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

async function flush(): Promise<void> {
  // Settle the async catalog fetch and any debounced work before asserting.
  await act(async () => {
    jest.runOnlyPendingTimers();
    await Promise.resolve();
  });
}

describe('CommandPalette default selection', () => {
  it('reaches Show more by keyboard and selects the first newly revealed item after Enter', async () => {
    useProjectsStore.setState({
      projects: overflowProjects,
      hasHydratedProjects: true,
    });
    render();
    await flush();
    setPaletteQuery('overflow');

    for (let index = 0; index < 6; index += 1) {
      pressPaletteKey('ArrowDown');
    }
    expect(selectedOptionText()).toContain('Show 3 more');

    const scrollIntoView: jest.SpiedFunction<HTMLElement['scrollIntoView']> =
      jest.spyOn(window.HTMLElement.prototype, 'scrollIntoView');
    scrollIntoView.mockClear();

    pressPaletteKey('Enter');

    expect(
      document.querySelectorAll(
        '[data-palette-section="worktrees"] [data-testid="command-palette-result"]',
      ),
    ).toHaveLength(9);
    expect(selectedOptionText()).toContain('overflow result 3');
    expect(
      document.querySelector<HTMLInputElement>(
        '[data-testid="command-palette-input"]',
      ),
    ).toBe(document.activeElement);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    const scrollContexts: unknown[] = scrollIntoView.mock.contexts;
    const scrollTarget = scrollContexts[scrollContexts.length - 1];
    expect(scrollTarget).toBeInstanceOf(HTMLElement);
    if (!(scrollTarget instanceof HTMLElement)) {
      throw new Error('Expected scrollIntoView to target a palette row');
    }
    expect(scrollTarget.textContent).toContain('overflow result 3');
  });

  it('selects the best-scoring command over an earlier weak plugin match, and Enter navigates', async () => {
    render();
    await flush();
    setPaletteQuery('Statistics');
    await flush();

    // The plugin section renders above the pinned-last commands section, but
    // the selection must sit on the far stronger 'Open Statistics' command.
    expect(selectedOptionText()).toContain('Open Statistics');

    pressPaletteKey('Enter');
    expect(useNavigationStore.getState().activePage).toBe('statistics');
  });

  it('keeps an explicit arrow-key selection sticky by item id across item refreshes', async () => {
    render();
    await flush();
    setPaletteQuery('Statistics');
    await flush();

    // Move off the best-match default onto the weak plugin row.
    pressPaletteKey('ArrowUp');
    const chosen = selectedOptionText();
    expect(chosen).not.toBe('');
    expect(chosen).not.toContain('Open Statistics');

    // Refresh the underlying items (new store array identity re-ranks the
    // palette); the explicit selection must stay on the same item.
    act(() => {
      useProjectsStore.setState({ projects: [], hasHydratedProjects: true });
    });
    await flush();
    expect(selectedOptionText()).toBe(chosen);
  });
});
