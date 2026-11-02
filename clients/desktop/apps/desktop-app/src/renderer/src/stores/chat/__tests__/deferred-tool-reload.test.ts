import type {
  ChatTabPluginSelections,
  DeferredToolsReloadAck,
  DeferredToolsReloadAdditions,
  DeferredToolsReloadEvent,
  DeferredToolsReloadScopeKey,
} from '@canopy/desktop-shared/types';
import {
  DEFERRED_TOOLS_ENABLE_FAILURE_MESSAGE,
  DEFERRED_TOOLS_RESUME_FAILURE_MESSAGE,
  buildDeferredToolsReloadContinuationText,
  createDeferredToolsReloadController,
  isDeferredToolsReloadActive,
  isInternalDeferredToolsReloadInterruption,
  mergeDeferredToolsReloadAdditions,
  type DeferredToolsReloadStoreSurface,
  type DeferredToolsReloadTabPreparation,
} from '../deferred-tool-reload';
import type { ChatTab } from '../types';

const SCOPE: DeferredToolsReloadScopeKey = {
  projectId: 'proj',
  worktreeId: 'wt',
  chatId: 'chat',
};

const ADDITIONS: DeferredToolsReloadAdditions = {
  skillRefs: [{ sourceId: 'src', skillName: 'my-skill' }],
  pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'my-plugin' }],
  mcpServerRefs: [{ serverId: 'srv', configId: 'cfg' }],
};

const MERGED: ChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: ADDITIONS.skillRefs,
  pluginRefs: ADDITIONS.pluginRefs,
  mcpServerRefs: ADDITIONS.mcpServerRefs,
};

function ack(requestId: string, accepted: boolean): DeferredToolsReloadAck {
  return {
    requestId,
    accepted,
    lifecycle: accepted
      ? { kind: 'state', state: 'ui_prepared' }
      : { kind: 'outcome', outcome: 'rejected' },
  };
}

function reloadEvent(
  over: Partial<DeferredToolsReloadEvent> = {},
): DeferredToolsReloadEvent {
  return {
    scope: SCOPE,
    requestId: 'req-1',
    toolCallId: 'tool-1',
    lifecycle: { kind: 'state', state: 'result_pending' },
    enabledResources: [{ ref: 'r1', kind: 'skill', name: 'My Skill' }],
    additions: ADDITIONS,
    ...over,
  };
}

interface FakeSurface extends DeferredToolsReloadStoreSurface {
  api: {
    beginDeferredToolsReload: jest.Mock;
    finishDeferredToolsReload: jest.Mock;
    cancelDeferredToolsReload: jest.Mock;
    updatePlugins: jest.Mock;
  };
  beginReloadOnTab: jest.Mock;
  mergeSelectionsOnTab: jest.Mock;
  applyCommittedSessionId: jest.Mock;
  refreshDiscovery: jest.Mock;
  updateReloadLifecycle: jest.Mock;
  clearReloadOnTab: jest.Mock;
  failReloadOnTab: jest.Mock;
}

function makePreparation(): DeferredToolsReloadTabPreparation {
  return {
    baseSelections: {
      collectionIds: ['keep-collection'],
      skillRefs: [],
      pluginRefs: [],
    },
    sdkSessionId: 'sdk-123',
    providerType: 'claude',
    interfaceMode: 'canopy',
    userMessageId: 'user-msg-1',
  };
}

function createFakeSurface(
  over: Partial<{
    prep: DeferredToolsReloadTabPreparation | null;
    merged: ChatTabPluginSelections | null;
  }> = {},
): FakeSurface {
  const prep = over.prep === undefined ? makePreparation() : over.prep;
  const merged = over.merged === undefined ? MERGED : over.merged;
  return {
    api: {
      beginDeferredToolsReload: jest.fn().mockResolvedValue(ack('req-1', true)),
      finishDeferredToolsReload: jest
        .fn()
        .mockResolvedValue(ack('req-1', true)),
      cancelDeferredToolsReload: jest
        .fn()
        .mockResolvedValue(ack('req-1', true)),
      updatePlugins: jest.fn().mockResolvedValue({
        pluginSelections: MERGED,
      }),
    },
    beginReloadOnTab: jest.fn().mockReturnValue(prep),
    mergeSelectionsOnTab: jest.fn().mockReturnValue(merged),
    applyCommittedSessionId: jest.fn(),
    refreshDiscovery: jest.fn(),
    updateReloadLifecycle: jest.fn(),
    clearReloadOnTab: jest.fn(),
    failReloadOnTab: jest.fn(),
  };
}

// Flush all pending microtasks so the controller's async drive settles.
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeTab(over: Partial<ChatTab> = {}): ChatTab {
  return {
    id: 'chat',
    title: 'Chat',
    messages: [],
    status: 'streaming',
    error: null,
    createdAt: '2026-07-14T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: {
      thinkingLevel: 'high',
      speed: 'standard',
      fastMode: false,
    },
    fastModeExplicit: false,
    ...over,
  };
}

describe('mergeDeferredToolsReloadAdditions', () => {
  it('additively merges typed refs while preserving existing selections', () => {
    const base: ChatTabPluginSelections = {
      collectionIds: ['collection-1'],
      skillRefs: [{ sourceId: 'src', skillName: 'existing-skill' }],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'srv0', configId: 'cfg0' }],
      mcpHttpAuthPreferences: [
        {
          target: { kind: 'standalone', serverId: 'srv0', configId: 'cfg0' },
          handler: 'canopy',
        },
      ],
    };

    const merged = mergeDeferredToolsReloadAdditions(base, ADDITIONS);

    // Existing collections + skills + MCP preserved.
    expect(merged.collectionIds).toEqual(['collection-1']);
    expect(merged.skillRefs).toContainEqual({
      sourceId: 'src',
      skillName: 'existing-skill',
    });
    // New refs appended.
    expect(merged.skillRefs).toContainEqual({
      sourceId: 'src',
      skillName: 'my-skill',
    });
    expect(merged.pluginRefs).toContainEqual({
      marketplaceId: 'mkt',
      pluginName: 'my-plugin',
    });
    expect(merged.mcpServerRefs).toContainEqual({
      serverId: 'srv0',
      configId: 'cfg0',
    });
    expect(merged.mcpServerRefs).toContainEqual({
      serverId: 'srv',
      configId: 'cfg',
    });
    // Auth preferences preserved from base.
    expect(merged.mcpHttpAuthPreferences).toEqual(base.mcpHttpAuthPreferences);
  });

  it('does not duplicate refs already present', () => {
    const base: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'src', skillName: 'my-skill' }],
      pluginRefs: [],
    };
    const merged = mergeDeferredToolsReloadAdditions(base, {
      skillRefs: [{ sourceId: 'src', skillName: 'my-skill' }],
      pluginRefs: [],
      mcpServerRefs: [],
    });
    expect(merged.skillRefs).toHaveLength(1);
  });
});

describe('isDeferredToolsReloadActive', () => {
  it('reflects the presence of the tab marker', () => {
    expect(isDeferredToolsReloadActive(makeTab())).toBe(false);
    expect(
      isDeferredToolsReloadActive(
        makeTab({
          deferredToolsReload: {
            requestId: 'req-1',
            toolCallId: 'tool-1',
            lifecycle: { kind: 'state', state: 'interrupting' },
          },
        }),
      ),
    ).toBe(true);
  });
});

describe('isInternalDeferredToolsReloadInterruption', () => {
  const cancellationTerminal = {
    type: 'result',
    terminal_reason: 'aborted_streaming',
  };
  const markedTab = makeTab({
    deferredToolsReload: {
      requestId: 'req-1',
      toolCallId: 'tool-1',
      lifecycle: { kind: 'state', state: 'interrupting' },
    },
  });

  it('is true for a cancellation terminal while a reload is active', () => {
    expect(
      isInternalDeferredToolsReloadInterruption(
        markedTab,
        cancellationTerminal,
      ),
    ).toBe(true);
  });

  it('is false when no reload is active', () => {
    expect(
      isInternalDeferredToolsReloadInterruption(
        makeTab(),
        cancellationTerminal,
      ),
    ).toBe(false);
  });

  it('is false when the user requested the cancellation (Stop takes precedence)', () => {
    expect(
      isInternalDeferredToolsReloadInterruption(
        makeTab({
          cancelRequestedByUser: true,
          deferredToolsReload: markedTab.deferredToolsReload,
        }),
        cancellationTerminal,
      ),
    ).toBe(false);
  });

  it('is false for a normal (non-cancellation) completion so the final result passes through', () => {
    expect(
      isInternalDeferredToolsReloadInterruption(markedTab, {
        type: 'result',
        result: 'All done',
      }),
    ).toBe(false);
  });
});

describe('buildDeferredToolsReloadContinuationText', () => {
  it('returns the fixed hidden system_instruction without resource names', () => {
    const text = buildDeferredToolsReloadContinuationText();
    expect(text).toBe(
      '<system_instruction>Requested items now enabled, continue the interrupted request.</system_instruction>',
    );
    expect(text).not.toContain('Skill A');
    expect(text).not.toContain('Plugin B');
  });
});

describe('createDeferredToolsReloadController', () => {
  it('drives begin → merge → updatePlugins → finish in order and holds the marker on success', async () => {
    const surface = createFakeSurface();
    const controller = createDeferredToolsReloadController(surface);

    controller.handleEvent(reloadEvent());
    await flush();

    expect(surface.beginReloadOnTab).toHaveBeenCalledTimes(1);
    expect(surface.api.beginDeferredToolsReload).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: SCOPE,
        requestId: 'req-1',
        toolCallId: 'tool-1',
        additions: ADDITIONS,
      }),
    );
    expect(surface.mergeSelectionsOnTab).toHaveBeenCalledWith(SCOPE, ADDITIONS);
    expect(surface.api.updatePlugins).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      pluginSelections: MERGED,
      materializeCodexThread: false,
    });
    expect(surface.refreshDiscovery).toHaveBeenCalledWith(
      SCOPE,
      MERGED,
      'claude',
    );
    expect(surface.api.finishDeferredToolsReload).toHaveBeenCalledWith({
      scope: SCOPE,
      requestId: 'req-1',
      toolCallId: 'tool-1',
      userMessageId: 'user-msg-1',
      resume: {
        sdkSessionId: 'sdk-123',
        providerType: 'claude',
        interfaceMode: 'canopy',
        pluginSelections: MERGED,
      },
      continuationText: buildDeferredToolsReloadContinuationText(),
    });

    // Success: no failure copy, marker not cleared yet, still tracking.
    expect(surface.failReloadOnTab).not.toHaveBeenCalled();
    expect(surface.clearReloadOnTab).not.toHaveBeenCalled();
    expect(controller.__isTracking('req-1')).toBe(true);
  });

  it('materializes deferred Codex capabilities and resumes the committed thread', async () => {
    const surface = createFakeSurface({
      prep: {
        ...makePreparation(),
        providerType: 'codex',
      },
    });
    surface.api.updatePlugins.mockResolvedValue({
      pluginSelections: MERGED,
      sdkSessionId: 'sdk-materialized',
    });
    const controller = createDeferredToolsReloadController(surface);

    controller.handleEvent(reloadEvent());
    await flush();

    expect(surface.api.updatePlugins).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      pluginSelections: MERGED,
      materializeCodexThread: true,
      expectedCurrentThreadId: 'sdk-123',
    });
    expect(surface.applyCommittedSessionId).toHaveBeenCalledWith(
      SCOPE,
      'sdk-materialized',
    );
    expect(surface.api.finishDeferredToolsReload).toHaveBeenCalledWith({
      scope: SCOPE,
      requestId: 'req-1',
      toolCallId: 'tool-1',
      userMessageId: 'user-msg-1',
      resume: {
        sdkSessionId: 'sdk-materialized',
        providerType: 'codex',
        interfaceMode: 'canopy',
        pluginSelections: MERGED,
      },
      continuationText: buildDeferredToolsReloadContinuationText(),
    });
  });

  it('clears the marker on the terminal completed event', async () => {
    const surface = createFakeSurface();
    const controller = createDeferredToolsReloadController(surface);
    controller.handleEvent(reloadEvent());
    await flush();

    controller.handleEvent(
      reloadEvent({ lifecycle: { kind: 'state', state: 'completed' } }),
    );
    expect(surface.clearReloadOnTab).toHaveBeenCalledWith(SCOPE, 'req-1');
    expect(controller.__isTracking('req-1')).toBe(false);
  });

  it('shows enable-failure copy when the begin ack is rejected', async () => {
    const surface = createFakeSurface();
    surface.api.beginDeferredToolsReload.mockResolvedValue(ack('req-1', false));
    const controller = createDeferredToolsReloadController(surface);

    controller.handleEvent(reloadEvent());
    await flush();

    expect(surface.mergeSelectionsOnTab).not.toHaveBeenCalled();
    expect(surface.api.updatePlugins).not.toHaveBeenCalled();
    expect(surface.failReloadOnTab).toHaveBeenCalledWith(
      SCOPE,
      'req-1',
      DEFERRED_TOOLS_ENABLE_FAILURE_MESSAGE,
    );
  });

  it('shows enable-failure copy and cancels when begin throws', async () => {
    const surface = createFakeSurface();
    surface.api.beginDeferredToolsReload.mockRejectedValue(new Error('boom'));
    const controller = createDeferredToolsReloadController(surface);

    controller.handleEvent(reloadEvent());
    await flush();

    expect(surface.failReloadOnTab).toHaveBeenCalledWith(
      SCOPE,
      'req-1',
      DEFERRED_TOOLS_ENABLE_FAILURE_MESSAGE,
    );
    expect(surface.api.cancelDeferredToolsReload).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: SCOPE,
        requestId: 'req-1',
        reason: 'enable_failed',
      }),
    );
  });

  it('shows enable-failure copy and cancels when selection merging throws', async () => {
    const surface = createFakeSurface();
    surface.mergeSelectionsOnTab.mockImplementation(() => {
      throw new Error('boom');
    });
    const controller = createDeferredToolsReloadController(surface);

    controller.handleEvent(reloadEvent());
    await flush();

    expect(surface.failReloadOnTab).toHaveBeenCalledWith(
      SCOPE,
      'req-1',
      DEFERRED_TOOLS_ENABLE_FAILURE_MESSAGE,
    );
    expect(surface.api.cancelDeferredToolsReload).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: SCOPE,
        requestId: 'req-1',
        reason: 'enable_failed',
      }),
    );
  });

  it('shows enable-failure copy and cancels the coordinator when updatePlugins throws', async () => {
    const surface = createFakeSurface();
    surface.api.updatePlugins.mockRejectedValue(new Error('boom'));
    const controller = createDeferredToolsReloadController(surface);

    controller.handleEvent(reloadEvent());
    await flush();

    expect(surface.failReloadOnTab).toHaveBeenCalledWith(
      SCOPE,
      'req-1',
      DEFERRED_TOOLS_ENABLE_FAILURE_MESSAGE,
    );
    expect(surface.api.cancelDeferredToolsReload).toHaveBeenCalledWith(
      expect.objectContaining({ scope: SCOPE, requestId: 'req-1' }),
    );
    expect(surface.api.finishDeferredToolsReload).not.toHaveBeenCalled();
  });

  it('shows resume-failure copy when the finish ack is rejected', async () => {
    const surface = createFakeSurface();
    surface.api.finishDeferredToolsReload.mockResolvedValue(
      ack('req-1', false),
    );
    const controller = createDeferredToolsReloadController(surface);

    controller.handleEvent(reloadEvent());
    await flush();

    expect(surface.failReloadOnTab).toHaveBeenCalledWith(
      SCOPE,
      'req-1',
      DEFERRED_TOOLS_RESUME_FAILURE_MESSAGE,
    );
  });

  it('cancels instead of finishing when the original user message id is missing', async () => {
    const prep = makePreparation();
    prep.userMessageId = undefined;
    const surface = createFakeSurface({ prep });
    const controller = createDeferredToolsReloadController(surface);

    controller.handleEvent(reloadEvent());
    await flush();

    expect(surface.api.finishDeferredToolsReload).not.toHaveBeenCalled();
    expect(surface.api.cancelDeferredToolsReload).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: SCOPE,
        requestId: 'req-1',
        toolCallId: 'tool-1',
        reason: 'resume_failed',
      }),
    );
    expect(surface.failReloadOnTab).toHaveBeenCalledWith(
      SCOPE,
      'req-1',
      DEFERRED_TOOLS_RESUME_FAILURE_MESSAGE,
    );
  });

  it('applies enable-failure copy for an enable_failed outcome event', () => {
    const surface = createFakeSurface();
    const controller = createDeferredToolsReloadController(surface);
    controller.handleEvent(
      reloadEvent({
        lifecycle: { kind: 'outcome', outcome: 'enable_failed' },
        additions: undefined,
      }),
    );
    expect(surface.failReloadOnTab).toHaveBeenCalledWith(
      SCOPE,
      'req-1',
      DEFERRED_TOOLS_ENABLE_FAILURE_MESSAGE,
    );
  });

  it('applies resume-failure copy for a resume_failed outcome event', () => {
    const surface = createFakeSurface();
    const controller = createDeferredToolsReloadController(surface);
    controller.handleEvent(
      reloadEvent({
        lifecycle: { kind: 'outcome', outcome: 'resume_failed' },
        additions: undefined,
      }),
    );
    expect(surface.failReloadOnTab).toHaveBeenCalledWith(
      SCOPE,
      'req-1',
      DEFERRED_TOOLS_RESUME_FAILURE_MESSAGE,
    );
  });

  it('uses normal cancellation presentation (no failure copy) for a cancelled outcome', () => {
    const surface = createFakeSurface();
    const controller = createDeferredToolsReloadController(surface);
    controller.handleEvent(
      reloadEvent({
        lifecycle: { kind: 'outcome', outcome: 'cancelled' },
        additions: undefined,
      }),
    );
    expect(surface.failReloadOnTab).not.toHaveBeenCalled();
    expect(surface.clearReloadOnTab).toHaveBeenCalledWith(SCOPE, 'req-1');
  });

  it('does not re-drive a duplicate non-terminal event; records lifecycle progress instead', async () => {
    const surface = createFakeSurface();
    const controller = createDeferredToolsReloadController(surface);
    controller.handleEvent(reloadEvent());
    await flush();
    surface.beginReloadOnTab.mockClear();

    controller.handleEvent(
      reloadEvent({ lifecycle: { kind: 'state', state: 'interrupting' } }),
    );

    expect(surface.beginReloadOnTab).not.toHaveBeenCalled();
    expect(surface.updateReloadLifecycle).toHaveBeenCalledWith(SCOPE, 'req-1', {
      kind: 'state',
      state: 'interrupting',
    });
  });

  it('ignores the event when this renderer may not write the tab (sentinel mirror)', async () => {
    const surface = createFakeSurface({ prep: null });
    const controller = createDeferredToolsReloadController(surface);
    controller.handleEvent(reloadEvent());
    await flush();
    expect(surface.api.beginDeferredToolsReload).not.toHaveBeenCalled();
    expect(controller.__isTracking('req-1')).toBe(false);
  });

  it('ignores a non-terminal event missing typed additions', async () => {
    const surface = createFakeSurface();
    const controller = createDeferredToolsReloadController(surface);
    controller.handleEvent(reloadEvent({ additions: undefined }));
    await flush();
    expect(surface.beginReloadOnTab).not.toHaveBeenCalled();
    expect(surface.api.beginDeferredToolsReload).not.toHaveBeenCalled();
  });

  it('cancel() notifies the coordinator and clears the marker', () => {
    const surface = createFakeSurface();
    const controller = createDeferredToolsReloadController(surface);
    controller.cancel(SCOPE, { requestId: 'req-1', toolCallId: 'tool-1' });
    expect(surface.api.cancelDeferredToolsReload).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: SCOPE,
        requestId: 'req-1',
        toolCallId: 'tool-1',
        reason: 'user_stop',
      }),
    );
    expect(surface.clearReloadOnTab).toHaveBeenCalledWith(SCOPE, 'req-1');
  });

  it('cancel() mid-flight aborts before finishing the resume', async () => {
    const surface = createFakeSurface();
    // Make updatePlugins hang so we can cancel before finish is reached.
    let releaseUpdate: () => void = () => {};
    surface.api.updatePlugins.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseUpdate = resolve;
      }),
    );
    const controller = createDeferredToolsReloadController(surface);

    controller.handleEvent(reloadEvent());
    await flush();
    expect(surface.api.updatePlugins).toHaveBeenCalledTimes(1);

    controller.cancel(SCOPE, { requestId: 'req-1', toolCallId: 'tool-1' });
    releaseUpdate();
    await flush();

    expect(surface.api.finishDeferredToolsReload).not.toHaveBeenCalled();
    expect(controller.__isTracking('req-1')).toBe(false);
  });
});
