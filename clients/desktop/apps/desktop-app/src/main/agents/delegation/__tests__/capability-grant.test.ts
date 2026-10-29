import type { AgentDelegationSpawnRequest } from '@canopy/protocol/delegation';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type {
  CapabilityItemRef,
  MaterializedCapabilityOverlay,
} from '@canopy/desktop-shared/node/delegation/agent-artifacts';
import type { DelegationCapabilityGrant } from '@canopy/desktop-shared/node/delegation/capability-grant';
import type { AgentSessionOptions } from '../../types';
import type { MaterializedDelegationCapabilities } from '../agent-projection';
import type {
  DelegationCapabilityCatalog,
  DelegationCapabilityCatalogItem,
} from '../capability-catalog';

const mockResolveEffectivePluginSelectionRefs = jest.fn();
const mockResolveEffectiveChatPluginSelections = jest.fn();

jest.mock('../../../plugins/plugin-resolver', () => ({
  resolveEffectivePluginSelectionRefs: (...args: unknown[]): unknown =>
    mockResolveEffectivePluginSelectionRefs(...args),
}));
jest.mock('../../../plugins/global-plugin-overlay', () => ({
  resolveEffectiveChatPluginSelections: (...args: unknown[]): unknown =>
    mockResolveEffectiveChatPluginSelections(...args),
}));

import { delegationCapabilityRefKey } from '../capability-catalog';
import { DelegationAgentCapabilityError } from '../agent-capability-error';
import {
  DelegationCapabilityAssignmentError,
  childCapabilityDiscovery,
  discoverDelegationCapabilityChoices,
  prepareDelegationCapabilities,
  resolveDelegateCallerCapabilities,
  resolveExplicitCapabilities,
  resolveRootCallerCapabilities,
  type DelegationCallerCapabilities,
} from '../capability-grant';

function owner(
  overrides: Partial<AgentSessionOptions> = {},
): AgentSessionOptions {
  return {
    cwd: '/workspace',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    ...overrides,
  };
}

function selections(
  overrides: Partial<ChatTabPluginSelections> = {},
): ChatTabPluginSelections {
  return { collectionIds: [], skillRefs: [], pluginRefs: [], ...overrides };
}

function skillRef(skillName: string, sourceId = 'builtin'): CapabilityItemRef {
  return { kind: 'skill', sourceId, skillName };
}

function catalogItem(
  overrides: Partial<DelegationCapabilityCatalogItem> = {},
): DelegationCapabilityCatalogItem {
  const ref = overrides.ref ?? skillRef('review');
  return {
    id: 'cap-review',
    kind: ref.kind,
    name: 'Review',
    description: '',
    ref,
    status: 'available',
    ...overrides,
  };
}

function catalog(
  items: readonly DelegationCapabilityCatalogItem[],
): DelegationCapabilityCatalog {
  return { items, byId: new Map(items.map((item) => [item.id, item])) };
}

function task(
  overrides: Partial<AgentDelegationSpawnRequest> = {},
): AgentDelegationSpawnRequest {
  return {
    modelId: 'gpt-5.6-sol',
    description: 'Review',
    prompt: 'Review the change.',
    executionMode: 'background',
    contextPolicy: 'task_only',
    isolation: 'shared_worktree',
    ...overrides,
  };
}

function callerWith(
  overrides: Partial<DelegationCallerCapabilities> = {},
): DelegationCallerCapabilities {
  return {
    depth: 0,
    selections: selections(),
    effectiveKeys: new Set(),
    mayDiscover: false,
    rootDeferredToolsAllowed: false,
    ...overrides,
  };
}

function materialized(
  overrides: Partial<MaterializedDelegationCapabilities> = {},
): MaterializedDelegationCapabilities {
  return {
    files: {},
    toolNames: ['read', 'search'],
    capabilities: {
      claudePluginRoots: [],
      claudeSkillNames: [],
      codexCapabilityRoots: [],
      mcpSelections: [],
      mcpHttpAuthPreferences: [],
      hookDeclarations: [],
    },
    provenance: { roots: {}, mcpSelections: [] },
    included: [],
    skipped: [],
    layerWarnings: [],
    ...overrides,
  };
}

beforeEach(() => {
  mockResolveEffectivePluginSelectionRefs.mockReset().mockResolvedValue({
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
  });
  mockResolveEffectiveChatPluginSelections.mockReset();
});

// Phase 1 (docs/planning/2026-09-25-delegation-capabilities/02-capability-grant.md
// §"Where inheritance comes from"): a root chat's effective set is its tab
// selections (already merged with a chat Agent's, per resolveAgentModelRuntime)
// plus the global overlay only when the session opts in.
describe('resolveRootCallerCapabilities', () => {
  it('passes local tab selections straight through when the session does not apply global defaults', async () => {
    const local = selections({
      skillRefs: [{ sourceId: 'builtin', skillName: 'review' }],
    });
    mockResolveEffectiveChatPluginSelections.mockResolvedValue(local);

    const caller = await resolveRootCallerCapabilities(
      owner({ pluginSelections: local }),
    );

    expect(mockResolveEffectiveChatPluginSelections).toHaveBeenCalledWith(
      local,
      { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' },
      false,
    );
    expect(caller.depth).toBe(0);
    expect(caller.selections).toBe(local);
    expect(caller.parentGrant).toBeUndefined();
  });

  it("carries a chat Agent's selections because they arrive already merged into pluginSelections", async () => {
    // resolveAgentModelRuntime merges an Agent's own selections into
    // pluginSelections before delegation ever sees them; the root caller must
    // reflect that merged value, not just the caller's own tab picks.
    const mergedWithAgent = selections({
      skillRefs: [
        { sourceId: 'builtin', skillName: 'from-tab' },
        { sourceId: 'builtin', skillName: 'from-agent' },
      ],
    });
    mockResolveEffectiveChatPluginSelections.mockResolvedValue(mergedWithAgent);

    const caller = await resolveRootCallerCapabilities(
      owner({ pluginSelections: mergedWithAgent }),
    );

    expect(caller.selections).toEqual(mergedWithAgent);
  });

  it('unions the global overlay only when applyGlobalPluginDefaults is set', async () => {
    const local = selections();
    const withOverlay = selections({
      skillRefs: [{ sourceId: 'global', skillName: 'lint' }],
    });
    mockResolveEffectiveChatPluginSelections.mockResolvedValue(withOverlay);

    const caller = await resolveRootCallerCapabilities(
      owner({ pluginSelections: local, applyGlobalPluginDefaults: true }),
    );

    expect(mockResolveEffectiveChatPluginSelections).toHaveBeenCalledWith(
      local,
      expect.any(Object),
      true,
    );
    expect(caller.selections).toEqual(withOverlay);
  });

  it('ignores an automation packageOverlay (decision A-3)', async () => {
    const local = selections({
      skillRefs: [{ sourceId: 'builtin', skillName: 'review' }],
    });
    mockResolveEffectiveChatPluginSelections.mockResolvedValue(local);
    const without = await resolveRootCallerCapabilities(
      owner({ pluginSelections: local }),
    );

    mockResolveEffectiveChatPluginSelections.mockClear();
    mockResolveEffectiveChatPluginSelections.mockResolvedValue(local);
    const withOverlay = await resolveRootCallerCapabilities(
      owner({
        pluginSelections: local,
        packageOverlay: { packageDigest: 'digest', resources: [] },
      }),
    );

    // The overlay flag never reaches resolveEffectiveChatPluginSelections's
    // third (global-defaults) argument, and the result is unaffected.
    expect(mockResolveEffectiveChatPluginSelections).toHaveBeenCalledWith(
      local,
      expect.any(Object),
      false,
    );
    expect(withOverlay.selections).toEqual(without.selections);
    expect(withOverlay.effectiveKeys).toEqual(without.effectiveKeys);
  });

  it('skips ref resolution and returns no effective keys when nothing is selected', async () => {
    mockResolveEffectiveChatPluginSelections.mockResolvedValue(selections());

    const caller = await resolveRootCallerCapabilities(owner());

    expect(mockResolveEffectivePluginSelectionRefs).not.toHaveBeenCalled();
    expect(caller.effectiveKeys.size).toBe(0);
  });

  it('derives effectiveKeys from resolved refs and mirrors deferredToolsAllowed into discovery flags', async () => {
    const local = selections({
      skillRefs: [{ sourceId: 'builtin', skillName: 'review' }],
    });
    mockResolveEffectiveChatPluginSelections.mockResolvedValue(local);
    mockResolveEffectivePluginSelectionRefs.mockResolvedValue({
      skillRefs: [{ sourceId: 'builtin', skillName: 'review' }],
      pluginRefs: [],
      mcpServerRefs: [],
    });

    const caller = await resolveRootCallerCapabilities(
      owner({ pluginSelections: local, deferredToolsAllowed: true }),
    );

    expect(caller.effectiveKeys).toEqual(
      new Set([delegationCapabilityRefKey(skillRef('review'))]),
    );
    expect(caller.mayDiscover).toBe(true);
    expect(caller.rootDeferredToolsAllowed).toBe(true);
  });
});

// Phase 1: a nested child inherits from its parent delegate's retained
// grant/overlay, never from the root chat directly.
describe('resolveDelegateCallerCapabilities', () => {
  it('gives a legacy delegate (no grant, no overlay) nothing to pass on', () => {
    const caller = resolveDelegateCallerCapabilities({
      depth: 1,
      owner: owner({ deferredToolsAllowed: true }),
      grant: undefined,
      overlay: undefined,
    });

    expect(caller.selections).toEqual(selections());
    expect(caller.effectiveKeys.size).toBe(0);
    expect(caller.mayDiscover).toBe(false);
    expect(caller.parentGrant).toBeUndefined();
  });

  it("derives the delegate's effective set from its own retained overlay items, not the root chat", () => {
    const overlay: MaterializedCapabilityOverlay = {
      version: 3,
      pluginFiles: {},
      capabilities: {
        claudePluginRoots: [],
        claudeSkillNames: [],
        codexCapabilityRoots: [],
        mcpSelections: [],
        mcpHttpAuthPreferences: [
          {
            handler: 'canopy',
            target: {
              kind: 'standalone',
              serverId: 'server',
              configId: 'default',
            },
          },
        ],
        hookDeclarations: [],
      },
      provenance: { roots: {}, mcpSelections: [] },
      items: [
        {
          id: 'cap-review',
          name: 'Review',
          source: 'inherited',
          ref: skillRef('review'),
        },
      ],
    };
    const grant: DelegationCapabilityGrant = {
      inherit: true,
      explicit: [],
      discovery: true,
      loaded: [],
      skipped: [],
      overlayHash: 'hash',
      summary: { inherit: true, discovery: true, items: [], skipped: [] },
    };

    const caller = resolveDelegateCallerCapabilities({
      depth: 1,
      owner: owner({ deferredToolsAllowed: true }),
      grant,
      overlay,
    });

    expect(caller.selections.skillRefs).toEqual([
      { sourceId: 'builtin', skillName: 'review' },
    ]);
    expect(caller.selections.mcpHttpAuthPreferences).toEqual(
      overlay.capabilities.mcpHttpAuthPreferences,
    );
    expect(caller.effectiveKeys).toEqual(
      new Set([delegationCapabilityRefKey(skillRef('review'))]),
    );
    expect(caller.mayDiscover).toBe(true);
    expect(caller.parentGrant).toBe(grant);
  });

  it('never grants discovery when the live root chat has turned deferred tools off, even under a discovering grant', () => {
    const grant: DelegationCapabilityGrant = {
      inherit: true,
      explicit: [],
      discovery: true,
      loaded: [],
      skipped: [],
      overlayHash: 'hash',
      summary: { inherit: true, discovery: true, items: [], skipped: [] },
    };

    const caller = resolveDelegateCallerCapabilities({
      depth: 1,
      owner: owner({ deferredToolsAllowed: false }),
      grant,
      overlay: undefined,
    });

    expect(caller.mayDiscover).toBe(false);
  });
});

// Phase 1: discovery grant math — root owner.deferredToolsAllowed &&
// (allowCapabilityDiscovery ?? true); nested: parentGrant.discovery &&
// (allowCapabilityDiscovery ?? parentGrant.discovery).
describe('childCapabilityDiscovery', () => {
  function rootCaller(
    rootDeferredToolsAllowed: boolean,
  ): DelegationCallerCapabilities {
    return callerWith({
      depth: 0,
      mayDiscover: rootDeferredToolsAllowed,
      rootDeferredToolsAllowed,
    });
  }

  function nestedCaller(
    parentDiscovery: boolean,
  ): DelegationCallerCapabilities {
    return callerWith({
      depth: 1,
      mayDiscover: parentDiscovery,
      rootDeferredToolsAllowed: true,
      parentGrant: {
        inherit: true,
        explicit: [],
        discovery: parentDiscovery,
        loaded: [],
        skipped: [],
        overlayHash: 'hash',
        summary: {
          inherit: true,
          discovery: parentDiscovery,
          items: [],
          skipped: [],
        },
      },
    });
  }

  it('root: grants discovery exactly when the chat allows it and the request does not decline', () => {
    expect(childCapabilityDiscovery(rootCaller(true), task())).toBe(true);
    expect(
      childCapabilityDiscovery(
        rootCaller(true),
        task({ allowCapabilityDiscovery: false }),
      ),
    ).toBe(false);
    expect(
      childCapabilityDiscovery(
        rootCaller(true),
        task({ allowCapabilityDiscovery: true }),
      ),
    ).toBe(true);
    expect(
      childCapabilityDiscovery(
        rootCaller(false),
        task({ allowCapabilityDiscovery: true }),
      ),
    ).toBe(false);
  });

  it('nested: never exceeds the parent delegate grant, even when the request asks for more', () => {
    expect(childCapabilityDiscovery(nestedCaller(true), task())).toBe(true);
    expect(
      childCapabilityDiscovery(
        nestedCaller(true),
        task({ allowCapabilityDiscovery: false }),
      ),
    ).toBe(false);
    expect(
      childCapabilityDiscovery(
        nestedCaller(false),
        task({ allowCapabilityDiscovery: true }),
      ),
    ).toBe(false);
  });
});

// Phase 2: an explicit ID must be either in the caller's effective set, or in
// the installed catalog when the caller may discover; errors never leak a
// path or the raw ID.
describe('resolveExplicitCapabilities', () => {
  it('rejects an unknown ID by position, never echoing the ID itself', () => {
    const unknownId = 'unknown-capability-id';
    let thrown: unknown;
    try {
      resolveExplicitCapabilities([unknownId], callerWith({}), catalog([]));
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof DelegationCapabilityAssignmentError))
      throw new Error('Expected a DelegationCapabilityAssignmentError');
    expect(thrown.publicMessage).toContain('Capability 1');
    expect(thrown.publicMessage).not.toContain(unknownId);
  });

  it('accepts an ID already in the effective set even when the caller may not discover', () => {
    const item = catalogItem();
    const caller = callerWith({
      effectiveKeys: new Set([delegationCapabilityRefKey(item.ref)]),
      mayDiscover: false,
    });

    expect(
      resolveExplicitCapabilities([item.id], caller, catalog([item])),
    ).toEqual([item]);
  });

  it('accepts an installed ID outside the effective set only when the caller may discover', () => {
    const item = catalogItem();

    expect(
      resolveExplicitCapabilities(
        [item.id],
        callerWith({ mayDiscover: true }),
        catalog([item]),
      ),
    ).toEqual([item]);

    let thrown: unknown;
    try {
      resolveExplicitCapabilities(
        [item.id],
        callerWith({ mayDiscover: false }),
        catalog([item]),
      );
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof DelegationCapabilityAssignmentError))
      throw new Error('Expected a DelegationCapabilityAssignmentError');
    expect(thrown.publicMessage).toContain(
      'you can only assign plugins, skills and MCP servers you have yourself',
    );
  });

  it('rejects an unsupported or disabled catalog item outside the effective set, naming it without a path', () => {
    const item = catalogItem({
      name: 'Review',
      status: 'unsupported',
      reason: 'it needs a newer runtime',
      ref: skillRef('review', '/Users/tommy/.claude/skills'),
    });
    let thrown: unknown;
    try {
      resolveExplicitCapabilities(
        [item.id],
        callerWith({ mayDiscover: true }),
        catalog([item]),
      );
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof DelegationCapabilityAssignmentError))
      throw new Error('Expected a DelegationCapabilityAssignmentError');
    expect(thrown.publicMessage).toContain('Review');
    expect(thrown.publicMessage).toContain('it needs a newer runtime');
    expect(thrown.publicMessage).not.toContain('/Users/tommy');
    expect(thrown.publicMessage).not.toContain(item.id);
  });
});

// Phase 1 + 2: layer composition, the fixed union rule, and the capability
// grant summary written on a fresh spawn.
describe('prepareDelegationCapabilities', () => {
  it("materializes the caller's inherited selections for a plain-model child, and adds the Agent's own layer for a configured-Agent child (D1)", async () => {
    const inherited = selections({
      skillRefs: [{ sourceId: 'builtin', skillName: 'inherited-skill' }],
    });
    const agentSelections = selections({
      skillRefs: [{ sourceId: 'builtin', skillName: 'agent-skill' }],
    });
    const caller = callerWith({ selections: inherited });
    const materialize = jest.fn().mockResolvedValue(materialized());
    const loadCatalog = jest.fn();

    await prepareDelegationCapabilities({
      task: task(),
      caller,
      agentSelections: undefined,
      harness: 'claude',
      materialize,
      loadCatalog,
    });
    expect(materialize).toHaveBeenCalledWith([
      { source: 'inherited', selections: inherited },
    ]);

    materialize.mockClear();
    await prepareDelegationCapabilities({
      task: task(),
      caller,
      agentSelections,
      harness: 'claude',
      materialize,
      loadCatalog,
    });
    expect(materialize).toHaveBeenCalledWith([
      { source: 'agent', selections: agentSelections },
      { source: 'inherited', selections: inherited },
    ]);
    expect(loadCatalog).not.toHaveBeenCalled();
  });

  it('keeps only the Agent layer when inheritCapabilities is false', async () => {
    const caller = callerWith({
      selections: selections({
        skillRefs: [{ sourceId: 'builtin', skillName: 'inherited-skill' }],
      }),
    });
    const agentSelections = selections({
      skillRefs: [{ sourceId: 'builtin', skillName: 'agent-skill' }],
    });
    const materialize = jest.fn().mockResolvedValue(materialized());

    await prepareDelegationCapabilities({
      task: task({ inheritCapabilities: false }),
      caller,
      agentSelections,
      harness: 'claude',
      materialize,
      loadCatalog: jest.fn(),
    });

    expect(materialize).toHaveBeenCalledWith([
      { source: 'agent', selections: agentSelections },
    ]);
  });

  it('records a skipped inherited item in the grant summary and still succeeds', async () => {
    const caller = callerWith({
      selections: selections({
        skillRefs: [{ sourceId: 'builtin', skillName: 'broken' }],
      }),
    });
    const materialize = jest.fn().mockResolvedValue(
      materialized({
        skipped: [
          {
            id: 'cap-broken',
            kind: 'skill',
            name: 'Broken',
            source: 'inherited',
            ref: skillRef('broken'),
            reason: 'missing_selection',
          },
        ],
      }),
    );

    const prepared = await prepareDelegationCapabilities({
      task: task(),
      caller,
      agentSelections: undefined,
      harness: 'claude',
      materialize,
      loadCatalog: jest.fn(),
    });

    const grant = prepared.grant(undefined);
    expect(grant?.summary.skipped).toEqual([
      { kind: 'skill', name: 'Broken', reason: 'missing_selection' },
    ]);
  });

  it('returns no capability grant for an unadorned spawn when the caller has nothing to inherit and deferred tools are off', async () => {
    const caller = callerWith({
      rootDeferredToolsAllowed: false,
      mayDiscover: false,
    });
    const materialize = jest.fn();

    const prepared = await prepareDelegationCapabilities({
      task: task(),
      caller,
      agentSelections: undefined,
      harness: 'claude',
      materialize,
      loadCatalog: jest.fn(),
    });

    expect(materialize).not.toHaveBeenCalled();
    expect(prepared.overlay).toBeUndefined();
    expect(prepared.grant(undefined)).toBeUndefined();
  });

  it('fails the spawn and names an explicit item that cannot be materialized', async () => {
    const item = catalogItem({ name: 'Broken plugin' });
    const caller = callerWith({
      effectiveKeys: new Set([delegationCapabilityRefKey(item.ref)]),
    });
    const materialize = jest.fn().mockResolvedValue(
      materialized({
        skipped: [
          {
            id: item.id,
            kind: item.kind,
            name: item.name,
            source: 'explicit',
            ref: item.ref,
            reason: 'unavailable_asset',
          },
        ],
      }),
    );
    const loadCatalog = jest.fn().mockResolvedValue(catalog([item]));

    let thrown: unknown;
    try {
      await prepareDelegationCapabilities({
        task: task({ capabilities: [item.id] }),
        caller,
        agentSelections: undefined,
        harness: 'claude',
        materialize,
        loadCatalog,
      });
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof DelegationAgentCapabilityError))
      throw new Error('Expected a DelegationAgentCapabilityError');
    expect(thrown.publicMessage).toContain('Broken plugin');
  });

  it("still fails the spawn immediately when the Agent's own layer cannot be materialized (unchanged fail-fast behavior)", async () => {
    const materialize = jest.fn().mockResolvedValue(
      materialized({
        layerWarnings: [{ source: 'agent', reason: 'missing_selection' }],
      }),
    );

    await expect(
      prepareDelegationCapabilities({
        task: task(),
        caller: callerWith({}),
        agentSelections: selections({
          skillRefs: [{ sourceId: 'builtin', skillName: 'agent-skill' }],
        }),
        harness: 'claude',
        materialize,
        loadCatalog: jest.fn(),
      }),
    ).rejects.toBeInstanceOf(DelegationAgentCapabilityError);
  });
});

// Phase 2: List Delegates { includeCapabilities: true } — inherited,
// assignable, and disabledReason flags for the installed catalog.
describe('discoverDelegationCapabilityChoices', () => {
  it('marks an already-effective item inherited and assignable without a dry run', async () => {
    const item = catalogItem();
    const caller = callerWith({
      effectiveKeys: new Set([delegationCapabilityRefKey(item.ref)]),
      mayDiscover: false,
    });
    const dryRun = jest.fn();

    const result = await discoverDelegationCapabilityChoices({
      caller,
      catalog: catalog([item]),
      dryRun,
    });

    expect(dryRun).not.toHaveBeenCalled();
    expect(result.capabilities).toEqual([
      expect.objectContaining({
        id: item.id,
        inherited: true,
        assignable: true,
      }),
    ]);
  });

  it('disables a non-inherited item when the caller may not discover, without a dry run', async () => {
    const item = catalogItem();
    const dryRun = jest.fn();

    const result = await discoverDelegationCapabilityChoices({
      caller: callerWith({ mayDiscover: false }),
      catalog: catalog([item]),
      dryRun,
    });

    expect(dryRun).not.toHaveBeenCalled();
    expect(result.capabilities[0]).toMatchObject({
      inherited: false,
      assignable: false,
    });
    expect(result.capabilities[0]?.disabledReason).toContain(
      'you have yourself',
    );
  });

  it('disables an unsupported or disabled item with its own reason before ever dry-running it', async () => {
    const item = catalogItem({
      status: 'disabled',
      reason: 'Turn it on in Settings.',
    });
    const dryRun = jest.fn();

    const result = await discoverDelegationCapabilityChoices({
      caller: callerWith({ mayDiscover: true }),
      catalog: catalog([item]),
      dryRun,
    });

    expect(dryRun).not.toHaveBeenCalled();
    expect(result.capabilities[0]).toMatchObject({
      assignable: false,
      disabledReason: 'Turn it on in Settings.',
    });
  });

  it('dry-runs an assignable candidate and reflects a materialization failure', async () => {
    const item = catalogItem({ status: 'available' });
    const dryRun = jest.fn().mockResolvedValue('cannot be used right now');

    const result = await discoverDelegationCapabilityChoices({
      caller: callerWith({ mayDiscover: true }),
      catalog: catalog([item]),
      dryRun,
    });

    expect(dryRun).toHaveBeenCalledWith(item);
    expect(result.capabilities[0]).toMatchObject({
      assignable: false,
      disabledReason: 'cannot be used right now',
    });
  });

  it('marks a clean dry run assignable with no disabled reason', async () => {
    const item = catalogItem({ status: 'available' });
    const dryRun = jest.fn().mockResolvedValue(undefined);

    const result = await discoverDelegationCapabilityChoices({
      caller: callerWith({ mayDiscover: true }),
      catalog: catalog([item]),
      dryRun,
    });

    expect(result.capabilities[0]?.assignable).toBe(true);
    expect(result.capabilities[0]?.disabledReason).toBeUndefined();
  });

  it('stops dry-running after 32 candidates and still marks the remainder assignable', async () => {
    const items = Array.from({ length: 40 }, (_, index) =>
      catalogItem({
        id: `cap-${index}`,
        ref: skillRef(`skill-${index}`),
        status: 'available',
      }),
    );
    const dryRun = jest.fn().mockResolvedValue(undefined);

    const result = await discoverDelegationCapabilityChoices({
      caller: callerWith({ mayDiscover: true }),
      catalog: catalog(items),
      dryRun,
    });

    expect(dryRun).toHaveBeenCalledTimes(32);
    expect(result.capabilities).toHaveLength(40);
    expect(result.capabilities[39]).toMatchObject({ assignable: true });
  });

  it('stops discovery early when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      discoverDelegationCapabilityChoices({
        caller: callerWith({}),
        catalog: catalog([catalogItem()]),
        dryRun: jest.fn(),
        signal: controller.signal,
      }),
    ).rejects.toThrow('Capability discovery cancelled');
  });
});

// Home entries have no installed-catalog refs. The host captures their effective
// copied files once; children inherit that retained material, never ambient home.
function homeOverlay(): MaterializedCapabilityOverlay & {
  homeEntries: readonly {
    root: string;
    kind: 'skill';
    name: string;
    origin: 'claude';
  }[];
} {
  return {
    version: 3,
    pluginFiles: { 'home/review/skills/review/SKILL.md': 'FROZEN_HOME_SKILL' },
    capabilities: {
      claudePluginRoots: ['home/review'],
      claudeSkillNames: ['review:review'],
      codexCapabilityRoots: ['home/review'],
      mcpSelections: [],
      mcpHttpAuthPreferences: [],
      hookDeclarations: [],
    },
    provenance: { roots: { 'home/review': 'inherited' }, mcpSelections: [] },
    items: [],
    homeEntries: [
      {
        root: 'home/review',
        kind: 'skill',
        name: 'Home review',
        origin: 'claude',
      },
    ],
  };
}

describe('effective home capability inheritance', () => {
  it('takes a root parent snapshot without rediscovering it as catalog selections', async () => {
    mockResolveEffectiveChatPluginSelections.mockResolvedValue(selections());
    const inheritedCapabilityOverlay = homeOverlay();
    const capturedOwner = { ...owner(), inheritedCapabilityOverlay };
    const caller = await resolveRootCallerCapabilities(capturedOwner);
    expect(caller).toMatchObject({
      inheritedOverlay: inheritedCapabilityOverlay,
    });
    expect(mockResolveEffectivePluginSelectionRefs).not.toHaveBeenCalled();
  });

  it('materializes home-only inheritance and reports it in the child grant', async () => {
    const inheritedOverlay = homeOverlay();
    const materialize = jest.fn().mockResolvedValue(materialized());
    const caller = { ...callerWith(), inheritedOverlay };
    const prepared = await prepareDelegationCapabilities({
      task: task(),
      caller,
      agentSelections: undefined,
      harness: 'copilot',
      materialize,
      loadCatalog: () => Promise.resolve(catalog([])),
    });
    expect(prepared.overlay).toMatchObject({
      pluginFiles: inheritedOverlay.pluginFiles,
      homeEntries: inheritedOverlay.homeEntries,
    });
    expect(prepared.grant('f'.repeat(64))?.summary.items).toContainEqual({
      kind: 'skill',
      name: 'Home review',
      source: 'inherited',
    });
    expect(materialize).not.toHaveBeenCalled();
  });

  it('keeps the Agent selection and skips inherited content that exceeds the combined budget', async () => {
    const inheritedOverlay = homeOverlay();
    const largeHome = {
      ...inheritedOverlay,
      pluginFiles: {
        'home/review/skills/review/SKILL.md': 'H'.repeat(600_000),
      },
    };
    const selected = materialized({
      files: { 'skills/selected/SKILL.md': 'S'.repeat(600_000) },
      capabilities: {
        ...materialized().capabilities,
        claudePluginRoots: ['skills/selected'],
        codexCapabilityRoots: ['skills/selected'],
        claudeSkillNames: ['selected:selected'],
      },
      provenance: { roots: { 'skills/selected': 'agent' }, mcpSelections: [] },
      included: [
        {
          id: 'selected',
          kind: 'skill',
          name: 'Selected',
          source: 'agent',
          ref: skillRef('selected'),
        },
      ],
    });
    const prepared = await prepareDelegationCapabilities({
      task: task(),
      caller: callerWith({ inheritedOverlay: largeHome }),
      agentSelections: selections({
        skillRefs: [{ sourceId: 'builtin', skillName: 'selected' }],
      }),
      harness: 'copilot',
      materialize: () => Promise.resolve(selected),
      loadCatalog: () => Promise.resolve(catalog([])),
    });
    expect(prepared.overlay?.pluginFiles).toEqual(selected.files);
    expect(prepared.grant('f'.repeat(64))?.summary.items).toEqual([
      { kind: 'skill', name: 'Selected', source: 'agent' },
    ]);
    expect(prepared.grant('f'.repeat(64))?.summary.skipped).toEqual([
      { kind: 'skill', name: 'Home review', reason: 'unavailable_asset' },
    ]);
    // Home roots are private artifact paths, not durable catalog IDs.
    // Their omission belongs in the public summary only.
    expect(prepared.grant('f'.repeat(64))?.skipped).toEqual([]);
  });

  it('honors inheritCapabilities false for captured home entries', async () => {
    const materialize = jest.fn().mockResolvedValue(materialized());
    const caller = { ...callerWith(), inheritedOverlay: homeOverlay() };
    const prepared = await prepareDelegationCapabilities({
      task: task({ inheritCapabilities: false }),
      caller,
      agentSelections: undefined,
      harness: 'copilot',
      materialize,
      loadCatalog: () => Promise.resolve(catalog([])),
    });
    expect(prepared.overlay).toBeUndefined();
    expect(prepared.grant(undefined)?.summary.items).toEqual([]);
    expect(materialize).not.toHaveBeenCalled();
  });

  it('nested callers capture only direct-parent home roots, excluding its other layers', () => {
    const home = homeOverlay();
    const overlay = {
      ...home,
      pluginFiles: {
        ...home.pluginFiles,
        'agent/private/skills/private/SKILL.md': 'AGENT_ONLY_CANARY',
      },
      capabilities: {
        ...home.capabilities,
        claudePluginRoots: [
          ...home.capabilities.claudePluginRoots,
          'agent/private',
        ],
      },
      provenance: {
        ...home.provenance,
        roots: { ...home.provenance.roots, 'agent/private': 'agent' as const },
      },
    };
    const caller = resolveDelegateCallerCapabilities({
      depth: 1,
      owner: owner(),
      overlay,
      grant: undefined,
    });
    expect(caller).toMatchObject({
      inheritedOverlay: {
        pluginFiles: home.pluginFiles,
        homeEntries: home.homeEntries,
      },
    });
    expect(JSON.stringify(caller)).not.toContain('AGENT_ONLY_CANARY');
  });
});
