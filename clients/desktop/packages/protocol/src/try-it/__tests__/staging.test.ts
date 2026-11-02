import { mergeTryItCapabilitySelections } from '../staging';

it('replaces the targeted unresolved capability and MCP config without losing unrelated selections or exclusions', () => {
  const capability = {
    kind: 'mcp',
    sourceId: 'curated-mcp',
    catalogId: 'linear',
    name: 'Linear',
  } as const;
  const base = {
    collectionIds: ['collection'],
    skillRefs: [{ sourceId: 'custom', skillName: 'notes' }],
    pluginRefs: [],
    mcpServerRefs: [
      { serverId: 'linear', configId: 'old' },
      { serverId: 'keep', configId: 'default' },
    ],
    unresolvedCapabilities: [capability],
    exclusions: ['unrelated'],
  };
  const incoming = {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [{ serverId: 'linear', configId: 'new' }],
  };
  const merged = mergeTryItCapabilitySelections(base, incoming, capability);
  expect(merged).toEqual({
    ...base,
    unresolvedCapabilities: [],
    mcpServerRefs: [
      { serverId: 'linear', configId: 'new' },
      { serverId: 'keep', configId: 'default' },
    ],
  });
  expect(mergeTryItCapabilitySelections(merged, incoming, capability)).toEqual(
    merged,
  );
  expect(base.mcpServerRefs[0].configId).toBe('old');
});
