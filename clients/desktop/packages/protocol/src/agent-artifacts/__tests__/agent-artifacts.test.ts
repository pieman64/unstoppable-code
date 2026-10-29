import {
  serializeAgentArtifactReceipt,
  serializeAgentArtifactReceipts,
  normalizeAgentArtifactNavigationRequest,
  mergeLatestAgentArtifacts,
  MAX_AGENT_ARTIFACT_RECEIPTS,
  MAX_AGENT_ARTIFACT_METADATA_BYTES,
  type AgentArtifactReceiptV1,
} from '..';
const createdAt = '2026-10-16T00:00:00.000Z';
const agent = {
  version: 1,
  kind: 'agent',
  operation: 'agents.create',
  dedupeKey: 'canopy:agent:local:a1',
  createdAt,
  source: 'local',
  agentId: 'a1',
  name: 'Researcher',
  model: 'model-1',
  navigationTarget: { kind: 'agent_editor', agentId: 'a1' },
};
const run = {
  version: 1,
  kind: 'automation_run',
  operation: 'automation.run_now',
  dedupeKey: 'canopy:automation_run:a1:r1',
  createdAt,
  activityId: 'a1',
  runId: 'r1',
  name: 'Daily',
  status: 'failure',
  trigger: 'manual',
  scheduledFor: createdAt,
  startedAt: createdAt,
  durationMs: 1,
  navigationTarget: {
    kind: 'automation_editor',
    activityId: 'a1',
    section: 'runs',
    runId: 'r1',
  },
};
const reference = {
  version: 1,
  kind: 'capability_reference',
  operation: 'show_capabilities',
  dedupeKey: 'canopy:capability_reference:local:agent:a1',
  createdAt,
  itemKind: 'agent',
  source: 'local',
  sourceId: 'a1',
  sourceLabel: 'Local',
  state: 'installed',
  name: 'Researcher',
  relation: 'recommended',
  navigationTarget: { kind: 'agent_editor', agentId: 'a1' },
};

it.each([agent, run, reference])(
  'normalizes portable $kind receipts and drops unknown fields',
  (receipt) => {
    expect(
      serializeAgentArtifactReceipt({
        ...receipt,
        privateConfiguration: 'never transport',
      }),
    ).toEqual(receipt);
  },
);
it.each([NaN, Infinity, -1, '5'])(
  'rejects invalid run duration %s',
  (durationMs) => {
    expect(serializeAgentArtifactReceipt({ ...run, durationMs })).toBeNull();
  },
);
it.each(['not-a-date', '2026-13-01T00:00:00Z', '2026-10-16'])(
  'rejects invalid timestamps %s',
  (startedAt) => {
    expect(serializeAgentArtifactReceipt({ ...run, startedAt })).toBeNull();
  },
);
it.each([
  { ...agent, agentId: 'different' },
  { ...agent, source: 'shared' },
  { ...agent, name: undefined },
  { ...run, runId: 'different' },
  { ...run, status: 'complete' },
  { ...run, trigger: 'other' },
  { ...reference, itemKind: 'plugin' },
  { ...reference, sourceId: 'different' },
  { ...reference, relation: 'created' },
  {
    ...reference,
    navigationTarget: { kind: 'external_url', url: 'https://example.com' },
  },
  { ...reference, version: 2 },
  { ...reference, kind: 'future' },
])('rejects malformed kind, identity, or navigation %#', (receipt) => {
  expect(serializeAgentArtifactReceipt(receipt)).toBeNull();
});
it('rejects incompatible capability-entry kinds', () => {
  expect(
    serializeAgentArtifactReceipt({
      ...reference,
      itemKind: 'plugin',
      navigationTarget: {
        kind: 'capability_entry',
        entry: { type: 'local-collection', collectionId: 'a1' },
      },
    }),
  ).toBeNull();
});
it('rejects unsafe locators instead of truncating them into a different target', () => {
  expect(
    normalizeAgentArtifactNavigationRequest({
      kind: 'agent_editor',
      agentId: 'x'.repeat(513),
    }),
  ).toBeNull();
  expect(
    normalizeAgentArtifactNavigationRequest({
      kind: 'agent_editor',
      agentId: 'a\0b',
    }),
  ).toBeNull();
  expect(
    normalizeAgentArtifactNavigationRequest({
      kind: 'automation_editor',
      activityId: 'a',
      runId: 'r',
    }),
  ).toBeNull();
});
it('keeps ordering and aliases without combining runs, references and definitions', () => {
  const normalized = [agent, run, reference]
    .map(serializeAgentArtifactReceipt)
    .filter((r): r is AgentArtifactReceiptV1 => r !== null);
  const renamed: AgentArtifactReceiptV1 = {
    ...normalized[0],
    dedupeKey: 'canopy:agent:local:a2',
    aliases: [agent.dedupeKey],
  } as AgentArtifactReceiptV1;
  expect(mergeLatestAgentArtifacts(normalized, [renamed])).toEqual([
    normalized[1],
    normalized[2],
    renamed,
  ]);
});
it('bounds receipt count and aggregate metadata including Unicode', () => {
  const receipts = serializeAgentArtifactReceipts(
    Array.from({ length: 1000 }, (_, i) => ({
      ...reference,
      name: '研究'.repeat(200),
      dedupeKey: `canopy:capability_reference:local:agent:${i}`,
    })),
  );
  expect(receipts.length).toBe(MAX_AGENT_ARTIFACT_RECEIPTS);
  expect(
    new TextEncoder().encode(JSON.stringify(receipts)).byteLength,
  ).toBeLessThanOrEqual(MAX_AGENT_ARTIFACT_METADATA_BYTES);
});
it('bounds changed fields and excludes identifiers and unrecognized keys', () => {
  expect(
    serializeAgentArtifactReceipt({
      ...agent,
      changedFields: ['id', 'name', 'name', 'instructions', 'future'],
    }),
  ).toMatchObject({ changedFields: ['name', 'instructions'] });
});

it.each(['x'.repeat(513), 'id\u0000suffix'])(
  'rejects unsafe nested capability entry locators without rewriting the identity',
  (collectionId) => {
    expect(
      normalizeAgentArtifactNavigationRequest({
        kind: 'capability_entry',
        entry: { type: 'local-collection', collectionId },
      }),
    ).toBeNull();
  },
);

const pluginReference = {
  ...reference,
  source: 'plugin',
  itemKind: 'skill',
  sourceId: 'm/p:skill',
  dedupeKey: 'canopy:capability_reference:plugin:skill:m/p:skill',
  navigationTarget: {
    kind: 'capability_entry',
    entry: { type: 'marketplace-plugin', marketplaceId: 'm', pluginName: 'p' },
  },
};
it('round-trips a cached plugin skill with parent-plugin navigation', () => {
  expect(serializeAgentArtifactReceipt(pluginReference)).toEqual(
    pluginReference,
  );
});
it('preserves existing plugin references to the parent', () => {
  const receipt = {
    ...pluginReference,
    itemKind: 'plugin',
    sourceId: 'm/p',
    dedupeKey: 'canopy:capability_reference:plugin:plugin:m/p',
  };
  expect(serializeAgentArtifactReceipt(receipt)).toEqual(receipt);
});
it.each([
  ['skill', 'm/p'],
  ['skill', 'm/p:'],
  ['skill', 'other/p:skill'],
  ['skill', 'm/other:skill'],
  ['plugin', 'm/p:skill'],
  ['agent', 'm/p:skill'],
])(
  'rejects a mismatched plugin-member kind or identity: %s %s',
  (itemKind, sourceId) => {
    expect(
      serializeAgentArtifactReceipt({
        ...pluginReference,
        itemKind,
        sourceId,
        dedupeKey: `canopy:capability_reference:plugin:${itemKind}:${sourceId}`,
      }),
    ).toBeNull();
  },
);
