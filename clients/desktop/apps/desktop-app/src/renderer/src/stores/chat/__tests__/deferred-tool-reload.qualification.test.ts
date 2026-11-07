import {
  DEFERRED_TOOLS_ENABLE_FAILURE_MESSAGE,
  type DeferredToolsReloadAck,
  type DeferredToolsReloadEvent,
  type DeferredToolsReloadLifecycle,
  type DeferredToolsReloadScopeKey,
} from '@canopy/desktop-shared/types';
import {
  createDeferredToolsReloadController,
  type DeferredToolsReloadStoreSurface,
} from '../deferred-tool-reload';

const scope: DeferredToolsReloadScopeKey = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};
const additions = {
  skillRefs: [],
  pluginRefs: [{ marketplaceId: 'market', pluginName: 'added' }],
  mcpServerRefs: [],
};

function event(
  lifecycle: DeferredToolsReloadLifecycle,
): DeferredToolsReloadEvent {
  return {
    scope,
    requestId: 'r1',
    toolCallId: 'tool-1',
    lifecycle,
    enabledResources: [],
    ...(lifecycle.kind === 'state' ? { additions } : {}),
  };
}

function fakeSurface(revisioned: boolean): {
  surface: DeferredToolsReloadStoreSurface;
  calls: string[];
  failures: string[];
} {
  const calls: string[] = [];
  const failures: string[] = [];
  const surface: DeferredToolsReloadStoreSurface = {
    api: {
      cancelDeferredToolsReload: (): Promise<DeferredToolsReloadAck> =>
        Promise.resolve({
          requestId: 'r1',
          accepted: true,
          lifecycle: { kind: 'outcome', outcome: 'cancelled' },
        }),
    },
    beginReloadOnTab: () => {
      calls.push('beginReloadOnTab');
      return {
        baseSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
        providerType: 'claude',
      };
    },
    mergeSelectionsOnTab: () => {
      calls.push('mergeSelectionsOnTab');
      return {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: additions.pluginRefs,
      };
    },
    applyCommittedSessionId: () => {
      calls.push('applyCommittedSessionId');
    },
    refreshDiscovery: () => {
      calls.push('refreshDiscovery');
    },
    updateReloadLifecycle: () => {
      calls.push('updateReloadLifecycle');
    },
    isRevisionedScope: () => revisioned,
    clearReloadOnTab: () => {
      calls.push('clearReloadOnTab');
    },
    failReloadOnTab: (_scope, _requestId, message) => {
      calls.push('failReloadOnTab');
      failures.push(message);
    },
  };
  return { surface, calls, failures };
}

describe('renderer deferred-tool reload reflection (CAN-4127)', () => {
  it('the renderer reflects a reload without driving it', () => {
    const { surface, calls } = fakeSurface(true);
    const controller = createDeferredToolsReloadController(surface);
    for (const state of [
      'result_pending',
      'ui_prepared',
      'interrupting',
      'enabling',
      'resuming',
      'completed',
    ] as const)
      controller.handleEvent(event({ kind: 'state', state }));
    const count = (name: string): number =>
      calls.filter((call) => call === name).length;
    expect(count('beginReloadOnTab')).toBe(1);
    expect(count('mergeSelectionsOnTab')).toBe(1);
    expect(count('refreshDiscovery')).toBe(1);
    expect(count('clearReloadOnTab')).toBe(1);
    // The merge mirrors the selections when the `resuming` event arrives.
    expect(calls.indexOf('mergeSelectionsOnTab')).toBe(
      calls.lastIndexOf('updateReloadLifecycle') + 1,
    );
    expect(Object.keys(surface.api)).toEqual(['cancelDeferredToolsReload']);
  });

  it('a failed reload in a revisioned chat only clears the marker', () => {
    const revisioned = fakeSurface(true);
    const first = createDeferredToolsReloadController(revisioned.surface);
    first.handleEvent(event({ kind: 'state', state: 'result_pending' }));
    first.handleEvent(event({ kind: 'outcome', outcome: 'enable_failed' }));
    expect(
      revisioned.calls.filter((call) => call === 'clearReloadOnTab'),
    ).toHaveLength(1);
    expect(revisioned.calls).not.toContain('failReloadOnTab');

    const legacy = fakeSurface(false);
    const second = createDeferredToolsReloadController(legacy.surface);
    second.handleEvent(event({ kind: 'state', state: 'result_pending' }));
    second.handleEvent(event({ kind: 'outcome', outcome: 'enable_failed' }));
    expect(legacy.failures).toEqual([DEFERRED_TOOLS_ENABLE_FAILURE_MESSAGE]);
  });
});
