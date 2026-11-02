import {
  capabilitySimilarityKey,
  entryIdForSelection,
  findRelatedCapabilitiesForPipeline,
  findRelatedCapabilitiesForSubject,
  findRelatedPipelines,
  findSimilarPipelines,
  pipelineRefsKey,
  RELATED_ITEMS_LIMIT,
} from '../relatedCapabilities';
import type {
  PipelineCapabilityRefsEntry,
  PipelineCapabilitySummary,
  PipelineInfo,
} from '@canopy/desktop-shared/types/pipeline';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import type {
  MarketplaceInfo,
  PluginInfo,
} from '@canopy/desktop-shared/types/plugins';

function makeCapability(
  overrides: Partial<PipelineCapabilitySummary> = {},
): PipelineCapabilitySummary {
  return {
    key: 'skill:builtin:app:review-checklist',
    kind: 'skill',
    required: false,
    collectionId: 'review_tools',
    collectionName: 'Review Tools',
    displayName: 'review-checklist',
    displaySource: 'Built-in skills',
    matchState: 'matched',
    selection: {
      kind: 'skill',
      sourceId: 'custom:app',
      skillName: 'review-checklist',
    },
    ...overrides,
  };
}

function makeRefsEntry(
  overrides: Partial<PipelineCapabilityRefsEntry> = {},
): PipelineCapabilityRefsEntry {
  return {
    id: 'my-pipeline',
    source: 'user',
    name: 'My Pipeline',
    icon: '🔎',
    capabilities: [makeCapability()],
    ...overrides,
  };
}

function makePipelineInfo(overrides: Partial<PipelineInfo> = {}): PipelineInfo {
  return {
    id: 'candidate',
    name: 'Candidate Pipeline',
    filename: 'candidate.yaml',
    description: '',
    icon: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    source: 'user',
    readonly: false,
    ...overrides,
  };
}

function makePlugin(overrides: Partial<PluginInfo>): PluginInfo {
  return {
    name: 'writer-toolkit',
    sourcePath: '/tmp/writer-toolkit',
    marketplaceId: 'mkt-1',
    providerSupport: { claude: 'native', codex: 'none' },
    facets: {},
    ...overrides,
  };
}

function makeMarketplace(overrides: Partial<MarketplaceInfo>): MarketplaceInfo {
  return {
    id: 'mkt-1',
    name: 'Marketplace One',
    sourceType: 'github',
    sourceUrl: 'https://github.com/acme/marketplace',
    installLocation: 'user',
    pluginCount: 0,
    plugins: [],
    providerStatus: {
      claude: {
        provider: 'claude',
        state: 'valid',
        accepted: true,
        pluginCount: 0,
        lastCheckedAt: '2026-01-01T00:00:00.000Z',
      },
      codex: {
        provider: 'codex',
        state: 'valid',
        accepted: true,
        pluginCount: 0,
        lastCheckedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    validProviders: [],
    ...overrides,
  };
}

function makeSkill(overrides: Partial<InstalledSkillInfo>): InstalledSkillInfo {
  return {
    name: 'review-checklist',
    sourceId: 'custom:app',
    description: 'A checklist skill',
    source: 'custom',
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updateAvailable: false,
    custom: true,
    ...overrides,
  };
}

describe('entryIdForSelection', () => {
  it('builds skill and marketplace plugin entry ids', () => {
    expect(
      entryIdForSelection(
        { kind: 'skill', sourceId: 'custom:app', skillName: 'foo' },
        [],
      ),
    ).toBe('skill:custom:app:foo');
    expect(
      entryIdForSelection(
        { kind: 'plugin', marketplaceId: 'mkt-1', pluginName: 'bar' },
        [{ id: 'mkt-1', curated: undefined }],
      ),
    ).toBe('mkt:mkt-1/bar');
  });

  it('maps curated marketplace plugins to curated entry ids', () => {
    expect(
      entryIdForSelection(
        { kind: 'plugin', marketplaceId: 'curated/cloud', pluginName: 'bar' },
        [{ id: 'curated/cloud', curated: true }],
      ),
    ).toBe('curated:bar');
  });
});

describe('findRelatedPipelines', () => {
  const skillSubject = {
    kind: 'skill',
    sourceId: 'custom:app',
    skillName: 'review-checklist',
  } as const;

  it('returns pipelines whose matched capabilities resolve to the subject', () => {
    const items = findRelatedPipelines(skillSubject, [makeRefsEntry()]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'my-pipeline',
      source: 'user',
      icon: '🔎',
      reason: 'Used by collection "Review Tools"',
    });
  });

  it('says Required when the declaring collection requires the ref', () => {
    const items = findRelatedPipelines(skillSubject, [
      makeRefsEntry({
        capabilities: [makeCapability({ required: true })],
      }),
    ]);
    expect(items[0]?.reason).toBe('Required by collection "Review Tools"');
  });

  it('ignores unmatched capabilities and non-matching subjects', () => {
    const items = findRelatedPipelines(skillSubject, [
      makeRefsEntry({
        id: 'unmatched',
        capabilities: [
          makeCapability({ matchState: 'unmatched', selection: undefined }),
        ],
      }),
      makeRefsEntry({
        id: 'other-skill',
        capabilities: [
          makeCapability({
            selection: {
              kind: 'skill',
              sourceId: 'custom:app',
              skillName: 'different',
            },
          }),
        ],
      }),
    ]);
    expect(items).toEqual([]);
  });

  it('matches case-insensitively and caps results', () => {
    const entries = Array.from({ length: 8 }, (_, index) =>
      makeRefsEntry({
        id: `pipeline-${index}`,
        capabilities: [
          makeCapability({
            selection: {
              kind: 'skill',
              sourceId: 'CUSTOM:APP',
              skillName: 'Review-Checklist',
            },
          }),
        ],
      }),
    );
    const items = findRelatedPipelines(skillSubject, entries);
    expect(items).toHaveLength(RELATED_ITEMS_LIMIT);
  });

  it('matches plugin subjects by marketplace and name', () => {
    const items = findRelatedPipelines(
      { kind: 'plugin', marketplaceId: 'mkt-1', pluginName: 'writer-toolkit' },
      [
        makeRefsEntry({
          capabilities: [
            makeCapability({
              kind: 'plugin',
              selection: {
                kind: 'plugin',
                marketplaceId: 'mkt-1',
                pluginName: 'writer-toolkit',
              },
            }),
          ],
        }),
      ],
    );
    expect(items).toHaveLength(1);
  });
});

describe('findSimilarPipelines', () => {
  const current = {
    info: makePipelineInfo({
      id: 'current',
      name: 'Code Review Claude',
      description: 'Runs a code review with Claude',
      triggerTypes: ['dispatch'],
    }),
    capabilityKeys: ['skill:custom:app:review-checklist'],
  };

  it('ranks shared capability refs above trigger and text overlap', () => {
    const bySharedRef = makePipelineInfo({
      id: 'shared-ref',
      name: 'Totally Different',
      description: 'Unrelated text',
    });
    const byTrigger = makePipelineInfo({
      id: 'shared-trigger',
      name: 'Another Unrelated',
      description: 'Nothing in common',
      triggerTypes: ['dispatch'],
    });
    const refs = new Map<string, readonly string[]>([
      ['user:shared-ref', ['skill:custom:app:review-checklist']],
    ]);
    const items = findSimilarPipelines(current, [byTrigger, bySharedRef], refs);
    expect(items.map((item) => item.info.id)).toEqual([
      'shared-ref',
      'shared-trigger',
    ]);
    expect(items[0].reasons).toContain('Uses the same skill or plugin');
    expect(items[1].reasons).toContain('Same trigger: Dispatch');
  });

  it('resolves candidate refs by source-qualified key, not bare id', () => {
    // A bundled and a user pipeline share the id: only the user one declares
    // the shared capability, so only it may score a shared-ref match.
    const bundledTwin = makePipelineInfo({
      id: 'twin',
      source: 'bundled',
      name: 'Bundled Twin',
      description: 'Unrelated bundled pipeline',
    });
    const userTwin = makePipelineInfo({
      id: 'twin',
      source: 'user',
      name: 'User Twin',
      description: 'Unrelated user pipeline',
    });
    const refs = new Map<string, readonly string[]>([
      [pipelineRefsKey(userTwin), ['skill:custom:app:review-checklist']],
    ]);
    const items = findSimilarPipelines(current, [bundledTwin, userTwin], refs);
    expect(items).toHaveLength(1);
    expect(items[0].info.source).toBe('user');
    expect(items[0].reasons).toContain('Uses the same skill or plugin');
  });

  it('deduplicates candidates with the same source-qualified identity', () => {
    const duplicate = makePipelineInfo({
      id: 'duplicate',
      name: 'Duplicate Review Helper',
      description: 'Runs a code review with Claude',
    });

    const items = findSimilarPipelines(
      current,
      [duplicate, { ...duplicate }],
      new Map(),
    );

    expect(items).toHaveLength(1);
    expect(items[0].info).toBe(duplicate);
  });

  it('normalizes equivalent portable refs to resolved capability identity', () => {
    const selection = {
      kind: 'plugin' as const,
      marketplaceId: 'demo/market',
      pluginName: 'review-toolkit',
    };
    const pluginRef = makeCapability({
      key: 'plugin:demo/market:review-toolkit',
      kind: 'plugin',
      selection,
    });
    const claudePluginRef = makeCapability({
      key: 'claude_plugin:github:demo/market:review-toolkit',
      kind: 'plugin',
      selection,
    });

    expect(capabilitySimilarityKey(pluginRef)).toBe(
      capabilitySimilarityKey(claudePluginRef),
    );
  });

  it('counts each normalized capability identity at most once', () => {
    const candidate = makePipelineInfo({
      id: 'duplicate-normalized-ref',
      name: 'Duplicate normalized ref',
      description: 'Unrelated text',
    });
    const sharedKey = 'plugin:demo/market:review-toolkit';
    const items = findSimilarPipelines(
      {
        ...current,
        capabilityKeys: [sharedKey],
      },
      [candidate],
      new Map([[pipelineRefsKey(candidate), [sharedKey, sharedKey]]]),
    );

    expect(items).toHaveLength(1);
    expect(items[0].score).toBe(4);
    expect(items[0].reasons).toContain('Uses the same skill or plugin');
  });

  it('excludes the current pipeline and low-scoring candidates', () => {
    const self = makePipelineInfo({ id: 'current' });
    const noise = makePipelineInfo({
      id: 'noise',
      name: 'Deploy Docs',
      description: 'Publishes documentation',
      triggerTypes: ['plan_ready'],
    });
    expect(findSimilarPipelines(current, [self, noise], new Map())).toEqual([]);
  });

  it('counts name/description token overlap', () => {
    const similarText = makePipelineInfo({
      id: 'texty',
      name: 'Code Review Codex',
      description: 'Runs a code review with Codex',
    });
    const items = findSimilarPipelines(current, [similarText], new Map());
    expect(items).toHaveLength(1);
    expect(items[0].reasons).toContain('Similar name or description');
  });
});

describe('findRelatedCapabilitiesForPipeline', () => {
  it('returns matched capabilities as navigable items and skips unmatched', () => {
    const items = findRelatedCapabilitiesForPipeline(
      [
        makeCapability({ required: true }),
        makeCapability({
          key: 'plugin:missing',
          kind: 'plugin',
          matchState: 'unmatched',
          selection: undefined,
          displayName: 'missing-plugin',
        }),
        makeCapability({
          key: 'plugin:present',
          kind: 'plugin',
          displayName: 'writer-toolkit',
          selection: {
            kind: 'plugin',
            marketplaceId: 'curated/cloud',
            pluginName: 'writer-toolkit',
          },
        }),
      ],
      [{ id: 'curated/cloud', curated: true }],
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: 'skill',
      entryId: 'skill:custom:app:review-checklist',
      reason: 'Required by collection "Review Tools"',
    });
    expect(items[1]).toMatchObject({
      kind: 'plugin',
      entryId: 'curated:writer-toolkit',
    });
  });

  it('deduplicates capabilities resolving to the same selection', () => {
    const items = findRelatedCapabilitiesForPipeline(
      [makeCapability(), makeCapability({ collectionId: 'other' })],
      [],
    );
    expect(items).toHaveLength(1);
  });
});

describe('findRelatedCapabilitiesForSubject', () => {
  it('for a skill: plugins containing the skill first, then same-source skills, never itself', () => {
    const marketplace = makeMarketplace({
      plugins: [
        makePlugin({
          name: 'review-pack',
          displayName: 'Review Pack',
          details: {
            skills: [
              {
                name: 'review-checklist',
                description: '',
                path: 'skills/review-checklist',
              },
            ],
            agents: [],
            commands: [],
            hooks: [],
            mcpServers: [],
            lspServers: [],
            hasReadme: false,
          },
        }),
      ],
    });
    const items = findRelatedCapabilitiesForSubject(
      { kind: 'skill', sourceId: 'custom:app', skillName: 'review-checklist' },
      {
        skills: [
          makeSkill({}),
          makeSkill({ name: 'sibling-skill', description: 'Sibling' }),
        ],
        marketplaces: [marketplace],
      },
    );
    expect(items.map((item) => item.entryId)).toEqual([
      'mkt:mkt-1/review-pack',
      'skill:custom:app:sibling-skill',
    ]);
    expect(items[0].reason).toBe('Includes a "review-checklist" skill');
    expect(items[1].reason).toBe('From the same source');
  });

  it('for a plugin: bundled installed skills, same-category, then same marketplace', () => {
    const marketplace = makeMarketplace({
      plugins: [
        makePlugin({
          name: 'writer-toolkit',
          category: 'writing',
          details: {
            skills: [
              { name: 'review-checklist', description: '', path: 'skills/rc' },
            ],
            agents: [],
            commands: [],
            hooks: [],
            mcpServers: [],
            lspServers: [],
            hasReadme: false,
          },
        }),
        makePlugin({ name: 'editor-pro', category: 'writing' }),
        makePlugin({ name: 'unrelated', category: 'devops' }),
      ],
    });
    const items = findRelatedCapabilitiesForSubject(
      { kind: 'plugin', marketplaceId: 'mkt-1', pluginName: 'writer-toolkit' },
      { skills: [makeSkill({})], marketplaces: [marketplace] },
    );
    expect(items.map((item) => item.entryId)).toEqual([
      'skill:custom:app:review-checklist',
      'mkt:mkt-1/editor-pro',
      'mkt:mkt-1/unrelated',
    ]);
    expect(items[1].reason).toBe('Same category: writing');
    expect(items[2].reason).toBe('From the same marketplace');
  });

  it('returns an empty list when nothing relates', () => {
    expect(
      findRelatedCapabilitiesForSubject(
        { kind: 'skill', sourceId: 'github:acme:solo', skillName: 'solo' },
        { skills: [makeSkill({})], marketplaces: [] },
      ),
    ).toEqual([]);
  });

  it('caps the result list', () => {
    const marketplace = makeMarketplace({
      plugins: Array.from({ length: 10 }, (_, index) =>
        makePlugin({ name: `plugin-${index}`, category: 'writing' }),
      ),
    });
    const items = findRelatedCapabilitiesForSubject(
      { kind: 'plugin', marketplaceId: 'mkt-1', pluginName: 'plugin-0' },
      { skills: [], marketplaces: [marketplace] },
    );
    expect(items).toHaveLength(RELATED_ITEMS_LIMIT);
  });
});
