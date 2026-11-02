import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  normalizePipeline,
  resolvePipelineModelAlias,
  resolvePipelineModelAliasLenient,
} from '../normalize-pipeline';
import { parseModelPackageConfig } from '../../model-config';
import {
  getExecutionHarnessForModel,
  initClaudeModels,
  initCodexModels,
} from '../../types';
import type { Pipeline } from '../../types/pipeline';

function pipelineWith(overrides: Partial<Pipeline>): Pipeline {
  return {
    name: 'Model Alias Test',
    on: 'dispatch',
    jobs: {
      test: {
        steps: [
          {
            uses: 'builtin/agent-prompt',
            with: { model: 'reviewer' },
          },
        ],
      },
    },
    ...overrides,
  };
}

describe('normalizePipeline model_aliases', () => {
  it('resolves built-in model aliases in steps, inputs, and alias defaults', () => {
    const normalized = normalizePipeline(
      pipelineWith({
        on: {
          dispatch: {
            inputs: {
              model: {
                type: 'choice',
                options: ['$default-codex', '$fast', '$cheap'],
                default: '$default-codex',
              },
            },
          },
        },
        jobs: {
          test: {
            steps: [
              {
                uses: 'builtin/agent-prompt',
                with: { model: '$fast' },
                env: { REVIEWER_MODEL: '$cheap' },
              },
              {
                uses: 'builtin/agent-prompt',
                with: { model: '${{ inputs.model }}' },
              },
            ],
          },
        },
        model_aliases: [
          {
            id: 'reviewer',
            name: 'Reviewer',
            defaults: { base: '$cheap' },
          },
        ],
      }),
    );

    expect(normalized.trigger_inputs?.dispatch?.model).toMatchObject({
      options: ['gpt-6.1-sol', 'gpt-6-luna', 'sonnet'],
      default: 'gpt-6.1-sol',
    });
    expect(normalized.jobs.test?.steps[0]?.with?.model).toBe('gpt-6-luna');
    expect(normalized.jobs.test?.steps[0]?.env?.REVIEWER_MODEL).toBe('sonnet');
    expect(normalized.jobs.test?.steps[1]?.with?.model).toBe(
      '${{ inputs.model }}',
    );
    expect(normalized.model_aliases?.[0]?.defaults).toMatchObject({
      base: 'sonnet',
    });
  });

  it('rejects an unknown built-in model alias at load time', () => {
    expect(() =>
      normalizePipeline(
        pipelineWith({
          jobs: {
            test: {
              steps: [
                {
                  uses: 'builtin/agent-prompt',
                  with: { model: '$unknown' },
                },
              ],
            },
          },
        }),
      ),
    ).toThrow('Unknown pipeline model alias "$unknown"');
  });

  it('rejects unknown aliases in model env vars without rewriting unrelated env', () => {
    expect(() =>
      normalizePipeline(
        pipelineWith({
          jobs: {
            test: {
              steps: [
                {
                  uses: 'builtin/agent-prompt',
                  env: { REVIEWER_MODEL: '$unknown' },
                },
              ],
            },
          },
        }),
      ),
    ).toThrow('Unknown pipeline model alias "$unknown"');

    const normalized = normalizePipeline(
      pipelineWith({ env: { SHELL_VALUE: '$fast' } }),
    );
    expect(normalized.env?.SHELL_VALUE).toBe('$fast');
  });

  it('accepts inline, Agent, and required aliases', () => {
    const normalized = normalizePipeline(
      pipelineWith({
        plugin_collections: [
          {
            id: 'review_tools',
            name: 'Review Tools',
            defaults: [],
          },
        ],
        model_aliases: [
          {
            id: 'reviewer',
            name: 'Reviewer',
            description: 'Reviews changes',
            defaults: {
              base: 'claude-sonnet-4-6',
              instructions: 'Review carefully.',
              plugin_collection_id: 'review_tools',
            },
          },
          {
            id: 'agent_reviewer',
            name: 'Agent Reviewer',
            defaults: { agent_id: 'agent_model_code_reviewer' },
          },
          {
            id: 'required_model',
            name: 'Required Model',
          },
        ],
      }),
    );

    expect(normalized.model_aliases).toEqual([
      {
        id: 'reviewer',
        name: 'Reviewer',
        description: 'Reviews changes',
        defaults: {
          base: 'claude-sonnet-4-6',
          instructions: 'Review carefully.',
          plugin_collection_id: 'review_tools',
        },
      },
      {
        id: 'agent_reviewer',
        name: 'Agent Reviewer',
        defaults: { agent_id: 'agent_model_code_reviewer' },
      },
      {
        id: 'required_model',
        name: 'Required Model',
      },
    ]);
  });

  it.each([
    [
      'non-array',
      { model_aliases: {} },
      'Pipeline model_aliases must be an array',
    ],
    [
      'non-object item',
      { model_aliases: ['reviewer'] },
      'Pipeline model_aliases[0] must be an object',
    ],
    [
      'empty id',
      { model_aliases: [{ id: ' ', name: 'Reviewer' }] },
      'Pipeline model_aliases[0] id must be a non-empty string',
    ],
    [
      'bad id',
      { model_aliases: [{ id: '-bad', name: 'Reviewer' }] },
      'Pipeline model_aliases[0] id must start with a letter or number',
    ],
    [
      'duplicate id',
      {
        model_aliases: [
          { id: 'reviewer', name: 'Reviewer' },
          { id: 'reviewer', name: 'Reviewer 2' },
        ],
      },
      'Duplicate model alias id "reviewer"',
    ],
    [
      'empty name',
      { model_aliases: [{ id: 'reviewer', name: ' ' }] },
      'Pipeline model_aliases[0] name must be a non-empty string',
    ],
    [
      'non-string description',
      { model_aliases: [{ id: 'reviewer', name: 'Reviewer', description: 1 }] },
      'Pipeline model_aliases[0] description must be a string',
    ],
    [
      'non-object defaults',
      { model_aliases: [{ id: 'reviewer', name: 'Reviewer', defaults: [] }] },
      'Pipeline model_aliases[0].defaults must be an object',
    ],
    [
      'base and agent_id',
      {
        model_aliases: [
          {
            id: 'reviewer',
            name: 'Reviewer',
            defaults: { base: 'claude-sonnet-4-6', agent_id: 'agent_model_x' },
          },
        ],
      },
      'cannot specify both base and agent_id',
    ],
    [
      'neither base nor agent_id',
      { model_aliases: [{ id: 'reviewer', name: 'Reviewer', defaults: {} }] },
      'must specify base or agent_id',
    ],
    [
      'empty base',
      {
        model_aliases: [
          { id: 'reviewer', name: 'Reviewer', defaults: { base: ' ' } },
        ],
      },
      'base must be a non-empty string',
    ],
    [
      'Agent model id in base',
      {
        model_aliases: [
          {
            id: 'reviewer',
            name: 'Reviewer',
            defaults: { base: 'agent_model_code_reviewer' },
          },
        ],
      },
      'base cannot be an agent_model_* id; use agent_id',
    ],
    [
      'non-string instructions',
      {
        model_aliases: [
          {
            id: 'reviewer',
            name: 'Reviewer',
            defaults: { base: 'claude-sonnet-4-6', instructions: 1 },
          },
        ],
      },
      'instructions must be a string',
    ],
    [
      'empty plugin_collection_id',
      {
        model_aliases: [
          {
            id: 'reviewer',
            name: 'Reviewer',
            defaults: { base: 'claude-sonnet-4-6', plugin_collection_id: ' ' },
          },
        ],
      },
      'plugin_collection_id must be a non-empty string',
    ],
    [
      'non-string plugin_collection_id',
      {
        model_aliases: [
          {
            id: 'reviewer',
            name: 'Reviewer',
            defaults: { base: 'claude-sonnet-4-6', plugin_collection_id: 1 },
          },
        ],
      },
      'plugin_collection_id must be a non-empty string',
    ],
    [
      'non-Agent agent_id',
      {
        model_aliases: [
          { id: 'reviewer', name: 'Reviewer', defaults: { agent_id: 'x' } },
        ],
      },
      'agent_id must be a non-empty agent_model_* string',
    ],
    [
      'unknown plugin collection',
      {
        model_aliases: [
          {
            id: 'reviewer',
            name: 'Reviewer',
            defaults: {
              base: 'claude-sonnet-4-6',
              plugin_collection_id: 'missing',
            },
          },
        ],
      },
      'Pipeline model alias "reviewer" references unknown plugin_collection_id "missing"',
    ],
    [
      'reserved plugin collection prefix',
      {
        plugin_collections: [
          {
            id: '__canopy_agent_model__:agent_model_x',
            name: 'Reserved',
            defaults: [],
          },
        ],
      },
      'id cannot start with reserved prefix "__canopy_agent_model__:"',
    ],
  ])('rejects %s', (_name, overrides, message) => {
    expect(() =>
      normalizePipeline(pipelineWith(overrides as Partial<Pipeline>)),
    ).toThrow(message);
  });
});

describe('resolvePipelineModelAliasLenient', () => {
  it('resolves known aliases to the same target as the strict resolver', () => {
    for (const alias of [
      '$default-codex',
      '$fast',
      '$cheap',
      '$sol',
      '$luna',
      '$opus',
      '$fable',
      '$astra',
      '$terra',
    ]) {
      expect(resolvePipelineModelAliasLenient(alias)).toBe(
        resolvePipelineModelAlias(alias),
      );
    }
  });

  it('returns unknown ids unchanged instead of throwing', () => {
    expect(resolvePipelineModelAliasLenient('$unknown-alias')).toBe(
      '$unknown-alias',
    );
    expect(resolvePipelineModelAliasLenient('claude-sonnet-4-6')).toBe(
      'claude-sonnet-4-6',
    );
  });
});

describe('built-in pipeline model alias harnesses', () => {
  // Bundled presets pick an alias, not a model id, and the executor's host
  // Codex interception (`maybeRunCodexPrompt`) only fires for a step whose
  // resolved model reports the `codex` harness. Hydrate the shipped catalog so
  // this pins the alias -> harness link the presets depend on; re-pointing an
  // alias at another harness must break here instead of at runtime.
  beforeAll(() => {
    const packageJson: unknown = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    );
    const config = parseModelPackageConfig(packageJson);
    initClaudeModels(config.claudeModels);
    initCodexModels(config.codexModels);
  });

  afterAll(() => {
    initClaudeModels([]);
    initCodexModels([]);
  });

  it('resolves $fast and $default-codex to Codex-harness models', () => {
    expect(
      getExecutionHarnessForModel(resolvePipelineModelAlias('$fast')),
    ).toBe('codex');
    expect(
      getExecutionHarnessForModel(resolvePipelineModelAlias('$default-codex')),
    ).toBe('codex');
  });

  it('resolves $cheap to a Claude-harness model', () => {
    expect(
      getExecutionHarnessForModel(resolvePipelineModelAlias('$cheap')),
    ).toBe('claude');
  });

  it.each([
    ['$default-codex', 'gpt-6.1-sol', 'codex'],
    ['$sol', 'gpt-6.1-sol', 'codex'],
    ['$luna', 'gpt-6-luna', 'codex'],
    ['$opus', 'opus[1m]', 'claude'],
    ['$fable', 'claude-fable-5-1', 'claude'],
    ['$astra', 'gpt-6-astra', 'codex'],
    ['$terra', 'gpt-6.1-terra', 'codex'],
  ])('resolves %s to the configured %s model', (alias, model, harness) => {
    expect(resolvePipelineModelAlias(alias)).toBe(model);
    expect(getExecutionHarnessForModel(model)).toBe(harness);
  });
});
