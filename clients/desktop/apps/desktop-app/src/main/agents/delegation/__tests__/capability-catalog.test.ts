import type { DelegationCapabilityKind } from '@canopy/protocol/delegation';
import type { CapabilityItemRef } from '@canopy/desktop-shared/node/delegation/agent-artifacts';
import type * as CatalogModule from '../../../deferred-tools/catalog';
import {
  encodeDeferredCatalogRef,
  encodeMcpRef,
  encodePluginRef,
  encodeSkillRef,
} from '../../../deferred-tools/catalog';

const mockBuildDeferredToolsCatalog = jest.fn();

jest.mock('../../../deferred-tools/catalog', () => ({
  ...jest.requireActual<typeof CatalogModule>(
    '../../../deferred-tools/catalog',
  ),
  buildDeferredToolsCatalog: (...args: unknown[]): unknown =>
    mockBuildDeferredToolsCatalog(...args),
}));

import {
  delegationCapabilityIdForIdentity,
  delegationCapabilityIdForRef,
  delegationCapabilityIdentity,
  delegationCapabilityRefKey,
  loadDelegationCapabilityCatalog,
} from '../capability-catalog';

const DELEGATION_CAPABILITY_ID_PATTERN = /^deferred:v1:[A-Za-z0-9_-]{43}$/;

function skillRef(sourceId: string, skillName: string): CapabilityItemRef {
  return { kind: 'skill', sourceId, skillName };
}

function pluginRef(
  marketplaceId: string,
  pluginName: string,
): CapabilityItemRef {
  return { kind: 'plugin', marketplaceId, pluginName };
}

function mcpRef(serverId: string, configId: string): CapabilityItemRef {
  return { kind: 'mcp', serverId, configId };
}

describe('delegationCapabilityIdentity', () => {
  it('matches the deferred-tools encoding for each capability kind', () => {
    expect(delegationCapabilityIdentity(skillRef('builtin', 'review'))).toBe(
      encodeSkillRef('builtin', 'review'),
    );
    expect(
      delegationCapabilityIdentity(pluginRef('marketplace', 'reviewer')),
    ).toBe(encodePluginRef('marketplace', 'reviewer'));
    expect(delegationCapabilityIdentity(mcpRef('server', 'default'))).toBe(
      encodeMcpRef('server', 'default'),
    );
  });
});

describe('delegationCapabilityIdForIdentity / delegationCapabilityIdForRef', () => {
  it('produces the deferred-tools catalog ref format', () => {
    const id = delegationCapabilityIdForRef(skillRef('builtin', 'review'));
    expect(id).toMatch(DELEGATION_CAPABILITY_ID_PATTERN);
    expect(id).toBe(
      delegationCapabilityIdForIdentity(encodeSkillRef('builtin', 'review')),
    );
    expect(id).toBe(
      encodeDeferredCatalogRef(encodeSkillRef('builtin', 'review')),
    );
  });

  it('is deterministic and distinguishes different refs', () => {
    const first = delegationCapabilityIdForRef(skillRef('builtin', 'review'));
    const second = delegationCapabilityIdForRef(skillRef('builtin', 'review'));
    const third = delegationCapabilityIdForRef(skillRef('builtin', 'lint'));

    expect(first).toBe(second);
    expect(first).not.toBe(third);
  });
});

describe('delegationCapabilityRefKey', () => {
  it('folds plugin name case for comparison, matching how selections resolve plugins', () => {
    expect(
      delegationCapabilityRefKey(pluginRef('marketplace', 'Reviewer')),
    ).toBe(delegationCapabilityRefKey(pluginRef('marketplace', 'reviewer')));
  });

  it('keeps skill and MCP identity case-sensitive', () => {
    expect(delegationCapabilityRefKey(skillRef('builtin', 'Review'))).not.toBe(
      delegationCapabilityRefKey(skillRef('builtin', 'review')),
    );
    expect(delegationCapabilityRefKey(mcpRef('Server', 'default'))).not.toBe(
      delegationCapabilityRefKey(mcpRef('server', 'default')),
    );
  });

  it('namespaces by kind so different kinds never collide on the same fields', () => {
    const keys = new Set([
      delegationCapabilityRefKey(skillRef('a', 'b')),
      delegationCapabilityRefKey(pluginRef('a', 'b')),
      delegationCapabilityRefKey(mcpRef('a', 'b')),
    ]);
    expect(keys.size).toBe(3);
  });
});

interface FakeDeferredItem {
  readonly ref: string;
  readonly kind: DelegationCapabilityKind;
  readonly name: string;
  readonly description: string;
  readonly status: 'available' | 'already_enabled' | 'unsupported' | 'disabled';
  readonly reason?: string;
  readonly capabilityRef?: CapabilityItemRef;
}

function fakeCatalog(items: readonly FakeDeferredItem[]): {
  items: readonly FakeDeferredItem[];
  additionsFor: (
    selected: readonly FakeDeferredItem[],
  ) => Record<string, unknown[]>;
} {
  return {
    items,
    additionsFor: (
      selected: readonly FakeDeferredItem[],
    ): Record<string, unknown[]> => {
      const [item] = selected;
      const empty = { skillRefs: [], pluginRefs: [], mcpServerRefs: [] };
      if (!item?.capabilityRef) return empty;
      const { capabilityRef } = item;
      if (capabilityRef.kind === 'skill')
        return { ...empty, skillRefs: [capabilityRef] };
      if (capabilityRef.kind === 'plugin')
        return { ...empty, pluginRefs: [capabilityRef] };
      return { ...empty, mcpServerRefs: [capabilityRef] };
    },
  };
}

beforeEach(() => {
  mockBuildDeferredToolsCatalog.mockReset();
});

describe('loadDelegationCapabilityCatalog', () => {
  it('requests the deferred-tools catalog for the given harness', async () => {
    mockBuildDeferredToolsCatalog.mockResolvedValue(fakeCatalog([]));

    await loadDelegationCapabilityCatalog('codex');

    expect(mockBuildDeferredToolsCatalog).toHaveBeenCalledWith({
      provider: 'codex',
    });
  });

  it('maps installed skills, plugins and MCP servers with their capability ref', async () => {
    const skillItemRef = encodeDeferredCatalogRef(
      encodeSkillRef('builtin', 'review'),
    );
    const pluginItemRef = encodeDeferredCatalogRef(
      encodePluginRef('marketplace', 'reviewer'),
    );
    const mcpItemRef = encodeDeferredCatalogRef(
      encodeMcpRef('server', 'default'),
    );
    mockBuildDeferredToolsCatalog.mockResolvedValue(
      fakeCatalog([
        {
          ref: skillItemRef,
          kind: 'skill',
          name: 'Review',
          description: 'Reviews code.',
          status: 'available',
          capabilityRef: skillRef('builtin', 'review'),
        },
        {
          ref: pluginItemRef,
          kind: 'plugin',
          name: 'Reviewer',
          description: 'A reviewer plugin.',
          status: 'already_enabled',
          capabilityRef: pluginRef('marketplace', 'reviewer'),
        },
        {
          ref: mcpItemRef,
          kind: 'mcp',
          name: 'Server',
          description: '',
          status: 'available',
          capabilityRef: mcpRef('server', 'default'),
        },
      ]),
    );

    const catalog = await loadDelegationCapabilityCatalog('claude');

    expect(catalog.items).toHaveLength(3);
    expect(catalog.items).toEqual([
      expect.objectContaining({
        id: skillItemRef,
        kind: 'skill',
        ref: skillRef('builtin', 'review'),
      }),
      expect.objectContaining({
        id: pluginItemRef,
        kind: 'plugin',
        ref: pluginRef('marketplace', 'reviewer'),
      }),
      expect.objectContaining({
        id: mcpItemRef,
        kind: 'mcp',
        ref: mcpRef('server', 'default'),
      }),
    ]);
    expect(catalog.byId.get(skillItemRef)).toBe(catalog.items[0]);
    expect(catalog.byId.get(pluginItemRef)).toBe(catalog.items[1]);
    expect(catalog.byId.get(mcpItemRef)).toBe(catalog.items[2]);
  });

  it('skips an item whose kind cannot be resolved to a capability ref', async () => {
    mockBuildDeferredToolsCatalog.mockResolvedValue(
      fakeCatalog([
        {
          ref: 'deferred:v1:unresolved',
          kind: 'plugin',
          name: 'Orphan',
          description: '',
          status: 'available',
          // No capabilityRef: additionsFor() cannot resolve it.
        },
      ]),
    );

    const catalog = await loadDelegationCapabilityCatalog('claude');

    expect(catalog.items).toEqual([]);
    expect(catalog.byId.size).toBe(0);
  });

  it('attaches a reason only for unsupported or disabled items, never for available/already-enabled ones', async () => {
    const availableRef = encodeDeferredCatalogRef('available');
    const enabledRef = encodeDeferredCatalogRef('enabled');
    const unsupportedRef = encodeDeferredCatalogRef('unsupported');
    const disabledRef = encodeDeferredCatalogRef('disabled');
    mockBuildDeferredToolsCatalog.mockResolvedValue(
      fakeCatalog([
        {
          ref: availableRef,
          kind: 'skill',
          name: 'Available',
          description: '',
          status: 'available',
          reason: 'should be dropped',
          capabilityRef: skillRef('builtin', 'available'),
        },
        {
          ref: enabledRef,
          kind: 'skill',
          name: 'Enabled',
          description: '',
          status: 'already_enabled',
          reason: 'should also be dropped',
          capabilityRef: skillRef('builtin', 'enabled'),
        },
        {
          ref: unsupportedRef,
          kind: 'skill',
          name: 'Unsupported',
          description: '',
          status: 'unsupported',
          reason: 'not supported here',
          capabilityRef: skillRef('builtin', 'unsupported'),
        },
        {
          ref: disabledRef,
          kind: 'skill',
          name: 'Disabled',
          description: '',
          status: 'disabled',
          reason: 'turned off',
          capabilityRef: skillRef('builtin', 'disabled'),
        },
      ]),
    );

    const catalog = await loadDelegationCapabilityCatalog('claude');

    expect(catalog.byId.get(availableRef)?.reason).toBeUndefined();
    expect(catalog.byId.get(enabledRef)?.reason).toBeUndefined();
    expect(catalog.byId.get(unsupportedRef)?.reason).toBe('not supported here');
    expect(catalog.byId.get(disabledRef)?.reason).toBe('turned off');
  });
});
