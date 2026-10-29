/**
 * @jest-environment jsdom
 */
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { buildCurrentUiStateSnapshot } from '../buildCurrentUiStateSnapshot';
import {
  applyLabsExperimentsSnapshot,
  resetLabsExperimentsStoreForTest,
} from '@/stores/labsExperimentsStore';
import {
  makeTestLabsSnapshot,
  pageExperimentsOn,
} from '@/test-utils/labsExperiments';

function setPageFlags(flags: { agents: boolean; workers: boolean }): void {
  const base = getDefaultFeatureFlagSnapshot();
  useFeatureFlagsStore.getState().setSnapshot({
    ...base,
    values: {
      ...base.values,
      [CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key]: flags.agents,
      [CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers.key]: flags.workers,
    },
    status: 'ready',
    initialized: true,
  });
}

beforeEach(() => {
  useNavigationStore.setState({ activePage: 'main', settingsOpen: false });
  // The Labs page experiments are on, so their pages are reachable (CAN-3678).
  applyLabsExperimentsSnapshot(
    makeTestLabsSnapshot({ revision: 0, experiments: pageExperimentsOn() }),
  );
  setPageFlags({ agents: true, workers: true });
});

afterEach(() => {
  useFeatureFlagsStore.getState().setSnapshot(getDefaultFeatureFlagSnapshot());
  resetLabsExperimentsStoreForTest();
});

describe('buildCurrentUiStateSnapshot availablePages (CAN-3661)', () => {
  it('lists the pages the renderer policy allows right now', () => {
    const snapshot = buildCurrentUiStateSnapshot({});

    expect(snapshot.availablePages).toEqual(
      expect.arrayContaining(['home', 'main', 'plugins', 'workers']),
    );
    // The Agents page is retired (CAN-4266); Agents live in the Marketplace.
    expect(snapshot.availablePages).not.toContain('agents');
    // Dev pages are off outside a development build, and the Settings alias
    // aliases are never listed as pages.
    expect(snapshot.availablePages).not.toContain('header-states');
    expect(snapshot.availablePages).not.toContain('mcp-account-connections');
    expect(snapshot.availablePages).not.toContain('environments');
  });

  it('reflects the latest gates on each build', () => {
    setPageFlags({ agents: true, workers: false });
    const workersOff = buildCurrentUiStateSnapshot({});
    expect(workersOff.availablePages).not.toContain('workers');
    expect(workersOff.availablePages).not.toContain('agents');

    setPageFlags({ agents: false, workers: true });
    const workersOn = buildCurrentUiStateSnapshot({});
    expect(workersOn.availablePages).toContain('workers');
    expect(workersOn.availablePages).toContain('plugins');
  });

  it('never reports an unavailable page as the active page', () => {
    // The window between a flag flip and the page host moving to New task.
    useNavigationStore.setState({ activePage: 'workers' });
    setPageFlags({ agents: true, workers: false });

    const snapshot = buildCurrentUiStateSnapshot({});

    expect(snapshot.activePage).toBe('home');
    expect(snapshot.availablePages).toContain(snapshot.activePage);
  });

  it('reports an available active page unchanged', () => {
    useNavigationStore.setState({ activePage: 'workers' });

    expect(buildCurrentUiStateSnapshot({}).activePage).toBe('workers');
  });

  it('drops a stale Agents share modal when Agents are switched off', () => {
    const slices = {
      'agents.shareModal': {
        open: true,
        localAgentId: 'agent-1',
        sharedAgentId: 'shared-1',
        state: 'published',
        busy: false,
        copied: false,
      },
    };
    useNavigationStore.setState({ activePage: 'plugins' });
    expect(
      buildCurrentUiStateSnapshot(slices).agents?.publicShareModal,
    ).toMatchObject({
      open: true,
      localAgentId: 'agent-1',
    });

    setPageFlags({ agents: false, workers: true });
    const snapshot = buildCurrentUiStateSnapshot(slices);

    expect(snapshot.activePage).toBe('plugins');
    expect(snapshot.agents).toBeUndefined();
  });
});
