/**
 * @jest-environment jsdom
 *
 * Verifies the palette's target-level navigation dispatch for the kinds whose
 * host pages need a deep-link past the list: an agent row opens the matched
 * agent's editor over its Marketplace detail (through the navigation store's
 * agent reveal) and a plugin
 * row opens the matched plugin's detail view (through the Plugins page's
 * module-private CustomEvent contract).
 */
import type { AgentModelDefinition } from '@canopy/desktop-shared/types/agent-models';
import type { PluginInfo } from '@canopy/desktop-shared/types/plugins';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import type { AppAdvisorWatcherSummary } from '@canopy/desktop-shared/types';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  buildAgentItems,
  buildPluginItems,
  buildSkillItems,
  buildWatcherItems,
} from '../paletteProviders';

function makeAgent(): AgentModelDefinition {
  return {
    id: 'ag-1',
    name: 'Reviewer',
    baseModel: 'opus',
    instructions: 'Review carefully.',
    pluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
    },
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

function makePlugin(): PluginInfo {
  return {
    name: 'Formatter',
    marketplaceId: 'mkt-1',
    description: 'Formats code',
    sourcePath: '/plugins/formatter',
    providerSupport: { claude: 'native', codex: 'none' },
    facets: {},
  };
}

function makeWatcher(): AppAdvisorWatcherSummary {
  return {
    id: 'watcher-1',
    label: 'Pipeline watcher',
    trigger: 'worktree_pipeline_completion',
    status: 'active',
    target: {
      kind: 'worktree_pipeline',
      projectId: 'p',
      worktreeId: 'w',
    },
    destination: { projectId: 'p', worktreeId: 'w', chatId: 'c' },
    createdAt: '2026-07-01T00:00:00.000Z',
  };
}

describe('palette target-level navigation dispatch', () => {
  afterEach(() => {
    document.body.replaceChildren();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('agent row opens the matched agent editor in the Marketplace Agents tab', () => {
    // The request is parked in the store (CAN-3710, CAN-4266), so it survives
    // the lazy page mount instead of racing a window event.
    useNavigationStore.setState({
      activePage: 'overview',
      pendingPluginsNavigation: undefined,
    });
    const [item] = buildAgentItems([makeAgent()]);
    void item.execute();

    expect(useNavigationStore.getState().activePage).toBe('plugins');
    expect(useNavigationStore.getState().pendingPluginsNavigation).toEqual({
      kind: 'entry-detail',
      entryId: 'agent:local:ag-1',
      intent: 'edit',
    });
    useNavigationStore.setState({ pendingPluginsNavigation: undefined });
  });

  it('plugin row navigates to Plugins and opens the matched plugin detail', () => {
    jest.useFakeTimers();
    const navigate = jest
      .spyOn(useNavigationStore.getState(), 'navigate')
      .mockImplementation();
    const openTab = jest.fn();
    const openDetail = jest.fn();
    window.addEventListener('canopy:plugins-open-tab', openTab);
    window.addEventListener('canopy:plugin-open-detail', openDetail);
    const page = document.createElement('div');
    page.dataset.testid = 'page-plugins';
    document.body.append(page);

    const [item] = buildPluginItems([makePlugin()]);
    void item.execute();

    expect(navigate).toHaveBeenCalledWith('plugins');
    jest.runAllTimers();
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { tab: 'marketplace' } }),
    );
    expect(openDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { marketplaceId: 'mkt-1', pluginName: 'Formatter' },
      }),
    );
    window.removeEventListener('canopy:plugins-open-tab', openTab);
    window.removeEventListener('canopy:plugin-open-detail', openDetail);
  });

  it('skill row deep-links through the store pending payload (no event race)', () => {
    const initialPage = useNavigationStore.getState().activePage;
    const skill: InstalledSkillInfo = {
      name: 'burrow',
      sourceId: 'src-1',
      description: 'Dig tunnels',
      source: 'github:example/skills',
      installedAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      updateAvailable: false,
    };
    const [item] = buildSkillItems([skill]);
    void item.execute();

    // The payload is store state, not a window event, so it survives until the
    // lazily mounted PluginsPage/SkillsTab consume it.
    const state = useNavigationStore.getState();
    expect(state.activePage).toBe('plugins');
    expect(state.pendingSkillViewer).toEqual({
      sourceId: 'src-1',
      skillName: 'burrow',
    });

    state.consumeSkillViewer();
    expect(useNavigationStore.getState().pendingSkillViewer).toBeUndefined();
    useNavigationStore.setState({ activePage: initialPage });
  });

  it('watcher row opens Workflows → Watchers (CAN-3980)', () => {
    const navigate = jest
      .spyOn(useNavigationStore.getState(), 'navigate')
      .mockImplementation();
    const [item] = buildWatcherItems([makeWatcher()]);

    void item.execute();

    expect(navigate).toHaveBeenCalledWith('watchers');
  });
});
