import {
  resolveCapabilities,
  showCapabilitiesSchema,
  showCapabilitiesJsonSchema,
  type CapabilityCandidate,
  type CapabilityInventory,
} from '../canopy-tools/show-capabilities';
import { getCanonicalCanopyToolKey } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import { getCanonicalAppAdvisorToolKey } from '@canopy/desktop-shared/lib/app-advisor-tools';
import { extractCanonicalAgentArtifacts } from '@canopy/protocol/agent-artifacts';

const candidate: CapabilityCandidate = {
  id: 'installed:custom/research',
  itemKind: 'skill',
  source: 'installed',
  sourceId: 'custom/research',
  name: 'Research',
  sourceLabel: 'Installed',
  state: 'installed',
  navigationTarget: {
    kind: 'installed_skill',
    sourceId: 'custom',
    skillName: 'research',
  },
};
const result = async (
  items: unknown[],
  rows = [candidate],
  unavailable = false,
): Promise<Record<string, unknown>> => {
  const response = await resolveCapabilities({ items }, () =>
    Promise.resolve({ items: rows, unavailable }),
  );
  return (JSON.parse(response.text) as { result: Record<string, unknown> })
    .result;
};
describe('ShowCapabilities', () => {
  it('keeps id precedence when a supplied name would resolve', async () => {
    expect(
      await result([{ kind: 'skill', id: 'wrong', name: 'Research' }]),
    ).toEqual({
      agentArtifacts: [],
      unresolved: [{ index: 0, kind: 'skill', reason: 'not_found' }],
    });
  });
  it('resolves exact names before unambiguous prefixes', async () => {
    const resolved = await result([
      { kind: 'skill', name: 'research', reason: 'Summarize sources' },
    ]);
    expect(resolved.agentArtifacts).toEqual([
      expect.objectContaining({
        relation: 'recommended',
        reason: 'Summarize sources',
        sourceId: candidate.sourceId,
      }),
    ]);
    expect(
      (await result([{ kind: 'skill', name: 'Res' }])).agentArtifacts,
    ).toHaveLength(1);
  });
  it('does not choose between duplicate installed names across sources', async () => {
    const resolved = await result(
      [{ kind: 'skill', name: 'Research' }],
      [
        candidate,
        {
          ...candidate,
          id: 'shared:other',
          source: 'shared',
          sourceId: 'other',
          navigationTarget: { kind: 'shared_skill', skillId: 'other' },
        },
      ],
    );
    expect(resolved.unresolved).toEqual([
      { index: 0, kind: 'skill', reason: 'ambiguous' },
    ]);
  });
  it('reads each inventory once and returns partial success', async () => {
    const reader = jest.fn((kind: string) => {
      if (kind === 'agent') return Promise.reject(new Error('offline'));
      return Promise.resolve({ items: [candidate] });
    });
    const response = await resolveCapabilities(
      {
        items: [
          { kind: 'skill', id: candidate.id },
          { kind: 'skill', name: 'Research' },
          { kind: 'agent', name: 'Reviewer' },
        ],
      },
      reader,
    );
    expect(reader).toHaveBeenCalledTimes(2);
    expect(response.isError).toBe(false);
    expect(extractCanonicalAgentArtifacts(response.text)).toHaveLength(1);
    expect(
      (JSON.parse(response.text) as { result: { unresolved: unknown[] } })
        .result.unresolved,
    ).toEqual([{ index: 2, kind: 'agent', reason: 'unavailable_source' }]);
  });
  it('keeps independent results when one inventory locator cannot form a receipt', async () => {
    const invalid: CapabilityCandidate = {
      ...candidate,
      id: 'installed:broken',
      sourceId: 'broken',
    };
    const resolved = await result(
      [
        { kind: 'skill', id: candidate.id },
        { kind: 'skill', id: invalid.id },
      ],
      [candidate, invalid],
    );
    expect(resolved.agentArtifacts).toHaveLength(1);
    expect(resolved.unresolved).toEqual([
      { index: 1, kind: 'skill', reason: 'unavailable_source' },
    ]);
  });
  it('never treats a partial inventory as an unambiguous name match', async () => {
    expect(
      (await result([{ kind: 'skill', name: 'Research' }], [candidate], true))
        .unresolved,
    ).toEqual([{ index: 0, kind: 'skill', reason: 'unavailable_source' }]);
    expect(
      (await result([{ kind: 'skill', id: candidate.id }], [candidate], true))
        .agentArtifacts,
    ).toHaveLength(1);
  });
  it('validates external locators without inventory or network reads', async () => {
    const reader = jest.fn();
    const response = await resolveCapabilities(
      {
        items: [
          { kind: 'plugin', url: 'https://example.com/a', name: 'Example' },
          { kind: 'skill', url: 'http://example.com' },
          { kind: 'agent', id: 'a', url: 'https://example.com' },
        ],
      },
      reader,
    );
    expect(reader).not.toHaveBeenCalled();
    expect(extractCanonicalAgentArtifacts(response.text)).toEqual([
      expect.objectContaining({
        source: 'external',
        sourceLabel: 'External',
        state: 'unknown',
      }),
    ]);
    expect(
      (JSON.parse(response.text) as { result: { unresolved: unknown[] } })
        .result.unresolved,
    ).toHaveLength(2);
  });
  it('keeps partial success when URL encoding exceeds the locator budget', async () => {
    const response = await resolveCapabilities(
      {
        items: [
          { kind: 'skill', url: `https://example.com/${'研'.repeat(100)}` },
          { kind: 'skill', url: 'https://example.com/valid' },
        ],
      },
      jest.fn(),
    );
    expect(response.isError).toBe(false);
    expect(extractCanonicalAgentArtifacts(response.text)).toHaveLength(1);
    const envelope: unknown = JSON.parse(response.text);
    expect(envelope).toMatchObject({
      result: {
        unresolved: [{ index: 0, kind: 'skill', reason: 'invalid_locator' }],
      },
    });
  });
  it('bounds input and exposes a matching provider schema', () => {
    expect(
      showCapabilitiesSchema.safeParse({
        items: Array(9).fill({ kind: 'skill', name: 'Research' }),
      }).success,
    ).toBe(false);
    expect(
      (showCapabilitiesJsonSchema as { properties?: { items?: unknown } })
        .properties?.items,
    ).toMatchObject({ maxItems: 8, minItems: 1 });
  });
  it.each([
    'ShowCapabilities',
    'mcp__canopy__ShowCapabilities',
    'canopy_show_capabilities',
    'mcp__unstoppable_code__ShowCapabilities',
    'unstoppable_code_show_capabilities',
  ])('recognizes receipt tool alias %s', (name) =>
    expect(getCanonicalCanopyToolKey(name)).toBe('show_capabilities'),
  );
  it('recognizes the App Advisor provider name', () => {
    expect(
      getCanonicalAppAdvisorToolKey('canopy_app_advisor_show_capabilities'),
    ).toBe('show_capabilities');
  });
});

const available: CapabilityCandidate = {
  ...candidate,
  id: 'shared:other',
  source: 'shared',
  sourceId: 'other',
  state: 'available',
  navigationTarget: { kind: 'shared_skill', skillId: 'other' },
};
type TestInventory = CapabilityInventory;
const lookup = async (
  item: object,
  inventory: TestInventory,
): Promise<unknown> => {
  const response = await resolveCapabilities(
    { items: [{ kind: 'skill', ...item }] },
    () => Promise.resolve(inventory),
  );
  return JSON.parse(response.text);
};
const resolved = (sourceId: string): object => ({
  result: {
    agentArtifacts: [expect.objectContaining({ sourceId })],
    unresolved: [],
  },
});
const unresolved = (reason: string): object => ({
  result: {
    agentArtifacts: [],
    unresolved: [{ index: 0, kind: 'skill', reason }],
  },
});

describe('tier-aware capability lookup', () => {
  it('prefers installed exact names over available names', async () => {
    expect(
      await lookup({ name: 'Research' }, { items: [available, candidate] }),
    ).toMatchObject(resolved(candidate.sourceId));
  });
  it.each([
    { partialTiers: ['available'] as const, expected: 'resolved' },
    { partialTiers: ['installed'] as const, expected: 'unavailable_source' },
    { partialTiers: [] as const, expected: 'resolved' },
  ])(
    'requires only installed completeness for installed exact names: $partialTiers',
    async ({ partialTiers, expected }) => {
      expect(
        await lookup(
          { name: 'Research' },
          { items: [candidate], unavailable: true, partialTiers },
        ),
      ).toMatchObject(
        expected === 'resolved'
          ? resolved(candidate.sourceId)
          : unresolved(expected),
      );
    },
  );
  it.each([['installed'], ['available'], ['installed', 'available']] as const)(
    'requires both tiers complete for available exact and all prefix names: %s',
    async (...partialTiers) => {
      for (const [name, items] of [
        ['Research', [available]],
        ['Res', [candidate]],
      ] as const) {
        expect(
          await lookup({ name }, { items: [...items], partialTiers }),
        ).toMatchObject(unresolved('unavailable_source'));
      }
    },
  );
  it('selects an available exact before an installed prefix', async () => {
    expect(
      await lookup(
        { name: 'Research' },
        {
          items: [{ ...candidate, name: 'Research assistant' }, available],
        },
      ),
    ).toMatchObject(resolved(available.sourceId));
  });
  it('retains ambiguity within the preferred tier', async () => {
    expect(
      await lookup(
        { name: 'Research' },
        { items: [candidate, candidate, available] },
      ),
    ).toMatchObject(unresolved('ambiguous'));
  });
  it('distinguishes complete and partial misses, including legacy fallback', async () => {
    for (const item of [{ id: 'missing' }, { name: 'missing' }]) {
      expect(await lookup(item, { items: [] })).toMatchObject(
        unresolved('not_found'),
      );
      expect(
        await lookup(item, { items: [], unavailable: true }),
      ).toMatchObject(unresolved('unavailable_source'));
      expect(
        await lookup(item, { items: [], unavailable: true, partialTiers: [] }),
      ).toMatchObject(unresolved('not_found'));
    }
  });
  it('matches lookup-only locators once per candidate with exact ID case', async () => {
    const entry = {
      ...candidate,
      locators: ['builtin:app:research', candidate.id],
    };
    expect(
      await lookup(
        { id: 'builtin:app:research' },
        { items: [entry], unavailable: true },
      ),
    ).toMatchObject(resolved(candidate.sourceId));
    expect(
      await lookup({ id: 'BUILTIN:app:research' }, { items: [entry] }),
    ).toMatchObject(unresolved('not_found'));
    expect(
      await lookup({ name: 'BUILTIN:APP:RESEARCH' }, { items: [entry] }),
    ).toMatchObject(resolved(candidate.sourceId));
    expect(
      await lookup({ id: candidate.id }, { items: [entry] }),
    ).toMatchObject(resolved(candidate.sourceId));
  });
  it('disambiguates colliding plugin locators only with a full ID', async () => {
    const entries = ['m1', 'm2'].map(
      (marketplaceId): CapabilityCandidate & { locators: string[] } => ({
        ...candidate,
        id: `plugin:${marketplaceId}/superpowers:writing-plans`,
        source: 'plugin',
        sourceLabel: 'Plugin',
        sourceId: `${marketplaceId}/superpowers:writing-plans`,
        name: 'superpowers:writing-plans',
        locators: ['superpowers:writing-plans'],
        navigationTarget: {
          kind: 'capability_entry',
          entry: {
            type: 'marketplace-plugin',
            marketplaceId,
            pluginName: 'superpowers',
          },
        },
      }),
    );
    for (const item of [
      { id: 'superpowers:writing-plans' },
      { name: 'SUPERPOWERS:WRITING-PLANS' },
    ]) {
      expect(await lookup(item, { items: entries })).toMatchObject(
        unresolved('ambiguous'),
      );
    }
    expect(
      await lookup(
        { id: entries[0]?.id },
        { items: entries, unavailable: true },
      ),
    ).toMatchObject(resolved('m1/superpowers:writing-plans'));
  });
  it('does not serialize locators or add lookup-derived aliases and preserves deduplication', async () => {
    const response = await resolveCapabilities(
      {
        items: [
          { kind: 'skill', id: candidate.id },
          { kind: 'skill', id: 'alternate' },
        ],
      },
      () =>
        Promise.resolve({ items: [{ ...candidate, locators: ['alternate'] }] }),
    );
    const receipts = extractCanonicalAgentArtifacts(response.text);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).not.toHaveProperty('locators');
    expect(receipts[0]).not.toHaveProperty('aliases');
    expect(response.text).not.toContain('alternate');
  });
});

it('treats unknown state as available for tier completeness and installed preference', async () => {
  const unknown: CapabilityCandidate = { ...available, state: 'unknown' };
  expect(
    await lookup({ name: 'Research' }, { items: [unknown, candidate] }),
  ).toMatchObject(resolved(candidate.sourceId));
  expect(
    await lookup(
      { name: 'Research' },
      { items: [unknown], partialTiers: ['installed'] },
    ),
  ).toMatchObject(unresolved('unavailable_source'));
});
