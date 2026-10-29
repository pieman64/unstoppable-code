/** @jest-environment jsdom */

/**
 * Pipeline run panel session UI state: the per-panel store itself, and its
 * lifecycle against the REAL panel layout store (`pipeline-panel-sync`):
 * closing a run tab releases its state; moves, pull-outs, worktree switches,
 * and layout teardown release nothing; owner removal and a layout reset
 * reconcile explicitly.
 */
import {
  makeAuxPanelLayoutKey,
  makeWorktreePanelKey,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '@/stores/panelLayoutStore';
import {
  classifyPipelinePanelWidth,
  defaultPipelinePanelUiEntry,
  getPipelinePanelSession,
  listPipelinePanelUiKeysForOwner,
  patchPipelinePanelUi,
  PIPELINE_PANEL_NAV_AUTO_COLLAPSE_WIDTH_PX,
  pipelinePanelUiKey,
  releasePipelinePanelUiForOwner,
  requestPipelinePanelReveal,
  resetPipelinePanelUiStoreForTests,
  resolvePipelinePanelNavExpanded,
  selectPipelinePanelTitle,
  selectPipelinePanelUiEntry,
  usePipelinePanelUiStore,
} from '../pipelinePanelUiStore';
import {
  flushPipelinePanelSyncForTests,
  initPipelinePanelSync,
  releaseOmittedPipelinePanelUi,
  resetPipelinePanelSyncForTests,
} from '@/lib/panels/pipeline-panel-sync';

let keyCounter = 0;
function nextOwnerKey(): string {
  keyCounter += 1;
  return makeWorktreePanelKey('project', `pipeline-ui-${keyCounter}`);
}

function layoutWithRuns(executionIds: string[]): DefaultLayoutDescriptor {
  return {
    orientation: 'horizontal',
    groups: [
      {
        kind: 'chat',
        groupId: 'group-chat',
        panelId: 'panel-chat',
        instance: { chatTabId: 'chat-a' },
      },
      ...executionIds.map((executionId, index) => ({
        kind: 'pipeline-execution' as const,
        groupId: `group-run-${index}`,
        panelId: `panel-pipeline-${executionId}`,
        instance: { executionId },
      })),
    ],
    containerSize: { width: 1200, height: 700 },
  };
}

function entryFor(
  ownerKey: string,
  executionId: string,
): ReturnType<typeof selectPipelinePanelUiEntry> {
  return selectPipelinePanelUiEntry(
    usePipelinePanelUiStore.getState(),
    pipelinePanelUiKey(ownerKey, `panel-pipeline-${executionId}`),
    executionId,
  );
}

function seedState(ownerKey: string, executionId: string): void {
  const key = pipelinePanelUiKey(ownerKey, `panel-pipeline-${executionId}`);
  patchPipelinePanelUi(key, executionId, {
    selection: { jobId: 'build' },
    navExpandedOverride: false,
    title: 'Nightly build',
  });
  getPipelinePanelSession(key).update((previous) => ({
    ...previous,
    scrollTop: 240,
    pauseDrafts: { [executionId]: { 'pause-1': { scope: 'web' } } },
  }));
}

beforeEach(() => {
  resetPipelinePanelUiStoreForTests();
  resetPipelinePanelSyncForTests();
});

afterEach(() => {
  resetPipelinePanelSyncForTests();
});

describe('pipelinePanelUiStore', () => {
  it('starts a panel on the run Summary with no explicit job-list choice and creates entries on first write', () => {
    expect(defaultPipelinePanelUiEntry('run-1')).toEqual({
      executionId: 'run-1',
      viewStack: [],
      selection: null,
      statusFilter: 'all',
      revealNonce: 0,
    });
    patchPipelinePanelUi('owner/wt::panel-1', 'run-1', {
      statusFilter: 'failure',
    });
    const entry = selectPipelinePanelUiEntry(
      usePipelinePanelUiStore.getState(),
      'owner/wt::panel-1',
      'run-1',
    );
    expect(entry).toMatchObject({ statusFilter: 'failure' });
    expect(entry?.navExpandedOverride).toBeUndefined();
  });

  describe('job-list presentation by width', () => {
    it('collapses below the threshold and docks at or above it', () => {
      expect(PIPELINE_PANEL_NAV_AUTO_COLLAPSE_WIDTH_PX).toBe(768);
      expect(classifyPipelinePanelWidth(320)).toBe('narrow');
      expect(classifyPipelinePanelWidth(536)).toBe('narrow');
      expect(classifyPipelinePanelWidth(767.5)).toBe('narrow');
      expect(classifyPipelinePanelWidth(768)).toBe('wide');
      expect(classifyPipelinePanelWidth(1120)).toBe('wide');
      expect(resolvePipelinePanelNavExpanded(undefined, 'narrow')).toBe(false);
      expect(resolvePipelinePanelNavExpanded(undefined, 'wide')).toBe(true);
    });

    it('treats an unmeasured (hidden) width as no information', () => {
      expect(classifyPipelinePanelWidth(0)).toBeNull();
      expect(classifyPipelinePanelWidth(-1)).toBeNull();
      expect(classifyPipelinePanelWidth(Number.NaN)).toBeNull();
    });

    it('lets an explicit choice win at any width', () => {
      expect(resolvePipelinePanelNavExpanded(true, 'narrow')).toBe(true);
      expect(resolvePipelinePanelNavExpanded(false, 'wide')).toBe(false);
      expect(resolvePipelinePanelNavExpanded(true, 'wide')).toBe(true);
      expect(resolvePipelinePanelNavExpanded(false, 'narrow')).toBe(false);
    });
  });

  it('never hands one run’s view to another run bound to the same panel id', () => {
    const key = 'owner/wt::panel-1';
    patchPipelinePanelUi(key, 'run-1', { selection: { jobId: 'build' } });
    getPipelinePanelSession(key).update((previous) => ({
      ...previous,
      scrollTop: 90,
    }));
    const state = usePipelinePanelUiStore.getState();
    expect(selectPipelinePanelUiEntry(state, key, 'run-2')).toBeUndefined();
    patchPipelinePanelUi(key, 'run-2', { statusFilter: 'success' });
    expect(
      selectPipelinePanelUiEntry(
        usePipelinePanelUiStore.getState(),
        key,
        'run-2',
      )?.selection,
    ).toBeNull();
    expect(getPipelinePanelSession(key).read().scrollTop).toBeUndefined();
  });

  it('applies an explicit reveal target, clears the filter, and bumps the nonce', () => {
    const ownerKey = 'owner/wt';
    patchPipelinePanelUi(pipelinePanelUiKey(ownerKey, 'panel-1'), 'run-1', {
      statusFilter: 'failure',
    });
    requestPipelinePanelReveal({
      ownerKey,
      panelId: 'panel-1',
      executionId: 'run-1',
      target: {
        viewStack: [{ executionId: 'child-1', label: 'Deploy' }],
        jobId: 'matrix',
        variantJobId: 'matrix-2',
      },
    });
    const entry = selectPipelinePanelUiEntry(
      usePipelinePanelUiStore.getState(),
      pipelinePanelUiKey(ownerKey, 'panel-1'),
      'run-1',
    );
    expect(entry).toMatchObject({
      viewStack: [{ executionId: 'child-1', label: 'Deploy' }],
      selection: { jobId: 'matrix', variantJobId: 'matrix-2' },
      statusFilter: 'all',
      revealNonce: 1,
    });
    requestPipelinePanelReveal({
      ownerKey,
      panelId: 'panel-1',
      executionId: 'run-1',
      target: {},
    });
    expect(
      selectPipelinePanelUiEntry(
        usePipelinePanelUiStore.getState(),
        pipelinePanelUiKey(ownerKey, 'panel-1'),
        'run-1',
      ),
    ).toMatchObject({ viewStack: [], selection: null, revealNonce: 2 });
  });

  it('selects the Definition used entry for a definition reveal', () => {
    const ownerKey = 'owner/wt';
    requestPipelinePanelReveal({
      ownerKey,
      panelId: 'panel-1',
      executionId: 'run-1',
      target: { entry: 'definition', jobId: 'build' },
    });

    expect(
      selectPipelinePanelUiEntry(
        usePipelinePanelUiStore.getState(),
        pipelinePanelUiKey(ownerKey, 'panel-1'),
        'run-1',
      ),
    ).toMatchObject({ selection: { entry: 'definition' } });
  });

  it('selects the Cost entry for a cost reveal, even when a job is also present', () => {
    const ownerKey = 'owner/wt';
    requestPipelinePanelReveal({
      ownerKey,
      panelId: 'panel-1',
      executionId: 'run-1',
      target: { entry: 'cost', jobId: 'build' },
    });

    expect(
      selectPipelinePanelUiEntry(
        usePipelinePanelUiStore.getState(),
        pipelinePanelUiKey(ownerKey, 'panel-1'),
        'run-1',
      ),
    ).toMatchObject({ selection: { entry: 'cost' } });

    // A reused panel id never carries the Cost selection to a different run.
    expect(
      selectPipelinePanelUiEntry(
        usePipelinePanelUiStore.getState(),
        pipelinePanelUiKey(ownerKey, 'panel-1'),
        'run-2',
      ),
    ).toBeUndefined();
    patchPipelinePanelUi(pipelinePanelUiKey(ownerKey, 'panel-1'), 'run-2', {
      statusFilter: 'failure',
    });
    expect(
      selectPipelinePanelUiEntry(
        usePipelinePanelUiStore.getState(),
        pipelinePanelUiKey(ownerKey, 'panel-1'),
        'run-2',
      )?.selection,
    ).toBe(defaultPipelinePanelUiEntry('run-2').selection);
  });

  it('finds a tab title by panel id and bound run', () => {
    patchPipelinePanelUi('a/b::panel-x', 'run-1', { title: 'Build' });
    const state = usePipelinePanelUiStore.getState();
    expect(selectPipelinePanelTitle(state, 'panel-x', 'run-1')).toBe('Build');
    expect(selectPipelinePanelTitle(state, 'panel-x', 'run-2')).toBeUndefined();
    expect(selectPipelinePanelTitle(state, 'panel-y', 'run-1')).toBeUndefined();
  });

  it('releases every panel of an owner and nothing else', () => {
    seedState('a/one', 'run-1');
    seedState('a/one', 'run-2');
    seedState('a/two', 'run-3');
    releasePipelinePanelUiForOwner('a/one');
    expect(listPipelinePanelUiKeysForOwner('a/one')).toEqual([]);
    expect(listPipelinePanelUiKeysForOwner('a/two')).toHaveLength(1);
  });
});

describe('pipeline-panel-sync', () => {
  it('releases a closed run tab’s state and keeps its siblings', () => {
    const ownerKey = nextOwnerKey();
    usePanelLayoutStore
      .getState()
      .initializeLayout(ownerKey, layoutWithRuns(['run-1', 'run-2']));
    initPipelinePanelSync();
    seedState(ownerKey, 'run-1');
    seedState(ownerKey, 'run-2');

    usePanelLayoutStore
      .getState()
      .closeTab(ownerKey, 'group-run-0', 'panel-pipeline-run-1');
    flushPipelinePanelSyncForTests();

    expect(entryFor(ownerKey, 'run-1')).toBeUndefined();
    expect(
      usePipelinePanelUiStore.getState().sessions[
        pipelinePanelUiKey(ownerKey, 'panel-pipeline-run-1')
      ],
    ).toBeUndefined();
    expect(entryFor(ownerKey, 'run-2')).toMatchObject({
      selection: { jobId: 'build' },
    });
  });

  it('keeps state across moves, pull-out and merge-back', () => {
    const ownerKey = nextOwnerKey();
    usePanelLayoutStore
      .getState()
      .initializeLayout(ownerKey, layoutWithRuns(['run-1']));
    initPipelinePanelSync();
    seedState(ownerKey, 'run-1');
    const store = usePanelLayoutStore.getState();

    store.collapseGroup(ownerKey, 'group-run-0');
    store.expandGroup(ownerKey, 'group-run-0');
    store.maximizeGroup(ownerKey, 'group-chat', true);
    store.maximizeGroup(ownerKey, 'group-chat', false);
    const auxKey = makeAuxPanelLayoutKey(ownerKey, 'aux-run');
    expect(store.extractGroupToLayout(ownerKey, 'group-run-0', auxKey)).toBe(
      true,
    );
    flushPipelinePanelSyncForTests();
    expect(entryFor(ownerKey, 'run-1')).toBeDefined();

    expect(
      usePanelLayoutStore.getState().adoptLayoutTabs(auxKey, ownerKey),
    ).toBe(true);
    flushPipelinePanelSyncForTests();
    expect(entryFor(ownerKey, 'run-1')).toMatchObject({
      navExpandedOverride: false,
      title: 'Nightly build',
    });
    expect(
      getPipelinePanelSession(
        pipelinePanelUiKey(ownerKey, 'panel-pipeline-run-1'),
      ).read().scrollTop,
    ).toBe(240);
  });

  it('keeps state when the owner’s whole layout family is torn down (worktree switch/eviction)', () => {
    const ownerKey = nextOwnerKey();
    usePanelLayoutStore
      .getState()
      .initializeLayout(ownerKey, layoutWithRuns(['run-1']));
    initPipelinePanelSync();
    seedState(ownerKey, 'run-1');

    usePanelLayoutStore.getState().disposeLayout(ownerKey);
    flushPipelinePanelSyncForTests();
    expect(entryFor(ownerKey, 'run-1')).toBeDefined();

    // Restored later with the tab present: still there.
    usePanelLayoutStore
      .getState()
      .initializeLayout(ownerKey, layoutWithRuns(['run-1']));
    flushPipelinePanelSyncForTests();
    expect(entryFor(ownerKey, 'run-1')).toMatchObject({
      selection: { jobId: 'build' },
    });
  });

  it('a layout reset releases run tabs the rebuilt layout no longer hosts', () => {
    const ownerKey = nextOwnerKey();
    usePanelLayoutStore
      .getState()
      .initializeLayout(ownerKey, layoutWithRuns(['run-1', 'run-2']));
    seedState(ownerKey, 'run-1');
    seedState(ownerKey, 'run-2');
    usePanelLayoutStore.getState().disposeLayout(ownerKey);
    usePanelLayoutStore
      .getState()
      .initializeLayout(ownerKey, layoutWithRuns(['run-2']));

    releaseOmittedPipelinePanelUi(ownerKey);
    expect(entryFor(ownerKey, 'run-1')).toBeUndefined();
    expect(entryFor(ownerKey, 'run-2')).toBeDefined();

    // Not mounted: nothing to reconcile against, so nothing is released.
    releaseOmittedPipelinePanelUi('project/not-mounted');
    seedState('project/not-mounted', 'run-9');
    releaseOmittedPipelinePanelUi('project/not-mounted');
    expect(entryFor('project/not-mounted', 'run-9')).toBeDefined();
  });
});
