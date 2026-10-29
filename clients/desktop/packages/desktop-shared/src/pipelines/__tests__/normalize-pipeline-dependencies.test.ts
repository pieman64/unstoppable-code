import { normalizePipeline } from '../normalize-pipeline';

type PipelineInput = Parameters<typeof normalizePipeline>[0];

const CHART_SKILL_REF = {
  type: 'skill',
  source: { type: 'github', repo: 'acme/skills' },
  skill_name: 'charting',
} as const;

const BROWSER_PLUGIN_REF = {
  type: 'plugin',
  marketplace: { type: 'github', repo: 'acme/marketplace' },
  plugin_name: 'browser',
} as const;

function buildPipeline(overrides: Partial<PipelineInput>): PipelineInput {
  return {
    name: 'Dependencies',
    on: 'dispatch',
    jobs: {
      build: {
        steps: [
          { id: 'fetch', run: 'echo fetch' },
          { id: 'render', run: 'echo render' },
        ],
      },
      report: {
        steps: [
          { id: 'fetch', run: 'echo fetch again' },
          {
            id: 'summarize',
            uses: 'builtin/agent-prompt',
            with: { plugin_collection_id: 'defaults' },
          },
        ],
      },
    },
    plugin_collections: [
      {
        id: 'defaults',
        name: 'Defaults',
        defaults: [{ ...CHART_SKILL_REF, required: true }],
      },
    ],
    ...overrides,
  };
}

describe('normalizePipeline dependencies manifest', () => {
  it('resolves bare step ids against every job defining them', () => {
    const normalized = normalizePipeline(
      buildPipeline({
        dependencies: [
          {
            id: 'gh',
            kind: 'local_package',
            required: true,
            steps: ['fetch'],
            package: { probe: 'gh' },
          },
        ],
      }),
    );

    const manifestRow = normalized.dependencies?.find((d) => d.id === 'gh');
    expect(manifestRow).toMatchObject({
      origin: 'manifest',
      scope: 'steps',
      required: true,
      fallback: 'block',
      affected_steps: [
        { job_id: 'build', step_id: 'fetch' },
        { job_id: 'report', step_id: 'fetch' },
      ],
    });
  });

  it('rejects unknown step references, duplicate ids, and reserved ids', () => {
    expect(() =>
      normalizePipeline(
        buildPipeline({
          dependencies: [
            {
              id: 'gh',
              kind: 'local_package',
              steps: ['missing_step'],
              package: { probe: 'gh' },
            },
          ],
        }),
      ),
    ).toThrow('steps references unknown step id "missing_step"');

    expect(() =>
      normalizePipeline(
        buildPipeline({
          dependencies: [
            { id: 'gh', kind: 'local_package', package: { probe: 'gh' } },
            { id: 'gh', kind: 'connector', connector: 'github' },
          ],
        }),
      ),
    ).toThrow('Duplicate pipeline dependency id "gh"');

    expect(() =>
      normalizePipeline(
        buildPipeline({
          dependencies: [
            {
              id: 'collection:anything',
              kind: 'connector',
              connector: 'github',
            },
          ],
        }),
      ),
    ).toThrow('id cannot start with reserved prefix "collection:"');
  });

  it('rejects the queue fallback until the runtime supports it', () => {
    expect(() =>
      normalizePipeline(
        buildPipeline({
          dependencies: [
            {
              id: 'gh',
              kind: 'local_package',
              fallback: 'queue',
              package: { probe: 'gh' },
            },
          ],
        }),
      ),
    ).toThrow('fallback "queue" is not supported yet');
  });

  it('rejects duplicate portable refs across manifest entries', () => {
    expect(() =>
      normalizePipeline(
        buildPipeline({
          dependencies: [
            { id: 'one', kind: 'plugin', ref: BROWSER_PLUGIN_REF },
            { id: 'two', kind: 'plugin', ref: BROWSER_PLUGIN_REF },
          ],
        }),
      ),
    ).toThrow(
      'Pipeline dependencies contain duplicate ref "plugin:github:acme/marketplace:browser"',
    );
  });

  it('validates alternatives against the final dependency set', () => {
    const normalized = normalizePipeline(
      buildPipeline({
        dependencies: [
          {
            id: 'primary',
            kind: 'connector',
            connector: 'github',
            fallback: 'alternative',
            alternatives: ['backup'],
          },
          { id: 'backup', kind: 'local_package', package: { probe: 'gh' } },
        ],
      }),
    );
    expect(
      normalized.dependencies?.find((d) => d.id === 'primary')?.alternatives,
    ).toEqual(['backup']);

    expect(() =>
      normalizePipeline(
        buildPipeline({
          dependencies: [
            {
              id: 'primary',
              kind: 'connector',
              connector: 'github',
              alternatives: ['primary'],
            },
          ],
        }),
      ),
    ).toThrow('cannot list itself as an alternative');

    expect(() =>
      normalizePipeline(
        buildPipeline({
          dependencies: [
            {
              id: 'primary',
              kind: 'connector',
              connector: 'github',
              alternatives: ['missing'],
            },
          ],
        }),
      ),
    ).toThrow('references unknown alternative "missing"');
  });

  it('projects plugin_collections defaults into dependency rows for free', () => {
    const normalized = normalizePipeline(buildPipeline({}));

    expect(normalized.dependencies).toHaveLength(1);
    expect(normalized.dependencies?.[0]).toEqual({
      id: 'collection:skill:github:acme/skills:charting',
      kind: 'skill',
      required: true,
      fallback: 'block',
      ref: CHART_SKILL_REF,
      origin: 'plugin_collection',
      scope: 'steps',
      affected_steps: [{ job_id: 'report', step_id: 'summarize' }],
      plugin_collection_default_key: 'skill:github:acme/skills:charting',
    });
  });

  it('reaches steps that use a collection through a model alias', () => {
    const normalized = normalizePipeline(
      buildPipeline({
        model_aliases: [
          {
            id: 'reporter',
            name: 'Reporter',
            defaults: {
              base: 'claude-sonnet',
              plugin_collection_id: 'defaults',
            },
          },
        ],
        jobs: {
          build: {
            steps: [
              {
                id: 'draft',
                uses: 'builtin/agent-prompt',
                with: { model: 'reporter' },
              },
            ],
          },
        },
      }),
    );

    expect(normalized.dependencies?.[0]?.affected_steps).toEqual([
      { job_id: 'build', step_id: 'draft' },
    ]);
  });

  it('enriches a matching manifest entry instead of projecting a duplicate', () => {
    const normalized = normalizePipeline(
      buildPipeline({
        dependencies: [
          {
            id: 'chart-skill',
            kind: 'skill',
            capability: 'Renders trend charts',
            ref: CHART_SKILL_REF,
          },
        ],
      }),
    );

    expect(normalized.dependencies).toHaveLength(1);
    expect(normalized.dependencies?.[0]).toMatchObject({
      id: 'chart-skill',
      origin: 'manifest',
      // Promotion to required replaces the defaulted `skip` fallback: a
      // required dependency must not stay silently skippable.
      fallback: 'block',
      capability: 'Renders trend charts',
      // The collection default is required, so the merged row stays required
      // even though the manifest entry omitted the flag.
      required: true,
      plugin_collection_default_key: 'skill:github:acme/skills:charting',
      // No manifest steps declared, so the collection's reach is inherited.
      affected_steps: [{ job_id: 'report', step_id: 'summarize' }],
    });
  });

  it('keeps an explicitly declared fallback when promoted to required', () => {
    const normalized = normalizePipeline(
      buildPipeline({
        dependencies: [
          {
            id: 'chart-skill',
            kind: 'skill',
            fallback: 'reduced',
            ref: CHART_SKILL_REF,
          },
        ],
      }),
    );

    expect(normalized.dependencies?.[0]).toMatchObject({
      required: true,
      fallback: 'reduced',
    });
  });

  it('keeps explicit manifest steps over inherited collection steps', () => {
    const normalized = normalizePipeline(
      buildPipeline({
        dependencies: [
          {
            id: 'chart-skill',
            kind: 'skill',
            steps: ['render'],
            ref: CHART_SKILL_REF,
          },
        ],
      }),
    );

    expect(normalized.dependencies?.[0]?.affected_steps).toEqual([
      { job_id: 'build', step_id: 'render' },
    ]);
  });

  it('keeps shared defaults optional when required collections have no reach', () => {
    const normalized = normalizePipeline(
      buildPipeline({
        plugin_collections: [
          {
            id: 'defaults',
            name: 'Defaults',
            defaults: [{ ...CHART_SKILL_REF, required: false }],
          },
          {
            id: 'extras',
            name: 'Extras',
            defaults: [{ ...CHART_SKILL_REF, required: true }],
          },
        ],
      }),
    );

    expect(normalized.dependencies).toHaveLength(1);
    expect(normalized.dependencies?.[0]).toMatchObject({
      origin: 'plugin_collection',
      required: false,
      fallback: 'skip',
      affected_steps: [{ job_id: 'report', step_id: 'summarize' }],
    });
  });

  it('marks whole-pipeline vs step-scoped vs unreferenced reach distinctly', () => {
    const normalized = normalizePipeline(
      buildPipeline({
        dependencies: [
          // No steps declared and no collection linkage: whole pipeline.
          { id: 'gh', kind: 'local_package', package: { probe: 'gh' } },
        ],
        plugin_collections: [
          {
            id: 'unused',
            name: 'Unused',
            defaults: [{ ...CHART_SKILL_REF, required: true }],
          },
        ],
        jobs: { build: { steps: [{ id: 'fetch', run: 'echo fetch' }] } },
      }),
    );

    expect(normalized.dependencies?.find((d) => d.id === 'gh')).toMatchObject({
      scope: 'pipeline',
      affected_steps: [],
    });
    // A required default from a collection no step references contributes no
    // requiredness: scope 'steps' with empty reach stays non-blocking.
    expect(
      normalized.dependencies?.find((d) => d.origin === 'plugin_collection'),
    ).toMatchObject({
      required: false,
      fallback: 'skip',
      scope: 'steps',
      affected_steps: [],
    });
  });

  it('keeps pipeline scope when an unreferenced collection matches a manifest entry', () => {
    const normalized = normalizePipeline(
      buildPipeline({
        dependencies: [
          {
            id: 'chart-skill',
            kind: 'skill',
            required: true,
            ref: CHART_SKILL_REF,
          },
        ],
        plugin_collections: [
          {
            id: 'unused',
            name: 'Unused',
            defaults: [{ ...CHART_SKILL_REF, required: true }],
          },
        ],
        jobs: { build: { steps: [{ id: 'fetch', run: 'echo fetch' }] } },
      }),
    );

    expect(normalized.dependencies).toHaveLength(1);
    expect(normalized.dependencies?.[0]).toMatchObject({
      id: 'chart-skill',
      required: true,
      fallback: 'block',
      scope: 'pipeline',
      affected_steps: [],
    });
  });

  it('rejects secret-like content in plugin_collections defaults', () => {
    expect(() =>
      normalizePipeline(
        buildPipeline({
          plugin_collections: [
            {
              id: 'defaults',
              name: 'Defaults',
              defaults: [
                {
                  type: 'skill',
                  source: { type: 'github', repo: 'acme/skills' },
                  skill_name: 'ghp_0123456789abcdefghij0123456789abcdef',
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow('must not contain secret-like content');
  });

  it('omits dependencies when neither manifest nor collections declare any', () => {
    const normalized = normalizePipeline(
      buildPipeline({
        plugin_collections: undefined,
        jobs: { build: { steps: [{ id: 'fetch', run: 'echo fetch' }] } },
      }),
    );
    expect(normalized.dependencies).toBeUndefined();
  });
});
