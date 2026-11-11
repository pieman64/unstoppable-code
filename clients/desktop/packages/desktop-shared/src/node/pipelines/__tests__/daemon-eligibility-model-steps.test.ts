// CAN-5095: the classifier admits the Claude and Codex model steps the
// daemon's pipeline host runs, behind an option, and refuses every other
// model step with a reason that names why. Runs over the real bundled action
// manifests. CAN-5831: Ollama models on the agent actions are admitted too.
// CAN-5832: model alias steps are admitted by what their alias names for the
// run.
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  COPILOT_MODELS,
  CURSOR_MODELS,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  OLLAMA_MODELS,
  OPENCODE_MODELS,
  getModelSource,
  initClaudeModels,
  initCodexModels,
  initCopilotModels,
  initModelHarnessAssignments,
  initOllamaModels,
  initOpenCodeModels,
} from '@canopy/desktop-shared/types';
import type { Pipeline, Step } from '@canopy/execution-engine/types/pipeline';
import { toCopilotModelId } from '@canopy/execution-engine/lib/copilot-models';
import { toOpenCodeModelId } from '@canopy/execution-engine/lib/opencode-models';
import {
  getProjectActionsDir,
  getProjectActionsDirCandidates,
} from '@canopy/execution-engine/node/pipelines/config-paths';
import {
  classifyDaemonPipeline,
  type DaemonPipelineClassifierContext,
} from '../daemon-eligibility';

const BUNDLED_ACTIONS = resolve(__dirname, '../../../../resources/actions');

const context: DaemonPipelineClassifierContext = {
  runtime: {
    bundledActionsDir: BUNDLED_ACTIONS,
    getProjectActionsDir,
    getProjectActionsDirCandidates,
  },
};

const ADMIT = { modelSteps: 'claude_codex' } as const;

function oneStep(step: Step, extra: Partial<Pipeline> = {}): Pipeline {
  return {
    name: 't',
    on: 'dispatch',
    jobs: { j: { steps: [step] } },
    ...extra,
  };
}

function agentPrompt(model?: string): Step {
  return {
    uses: 'builtin/agent-prompt',
    with: { prompt: 'x', ...(model !== undefined ? { model } : {}) },
  };
}

describe('classifyDaemonPipeline with model steps', () => {
  beforeAll(() => {
    initClaudeModels([{ id: DEFAULT_CLAUDE_MODEL, label: 'Opus' }]);
    initCodexModels([{ id: DEFAULT_CODEX_MODEL, label: 'Codex default' }]);
    const managed = { supportsVision: false, supportedThinkingLevels: [] };
    initCopilotModels([
      {
        id: toCopilotModelId('gpt-5'),
        rawModelId: 'gpt-5',
        label: 'GPT-5',
        ...managed,
      },
    ]);
    initOpenCodeModels([
      {
        id: toOpenCodeModelId('anthropic/claude-sonnet-4'),
        rawModelId: 'anthropic/claude-sonnet-4',
        label: 'Claude Sonnet 4',
        ...managed,
      },
    ]);
    initOllamaModels([
      {
        id: 'ollama-qwen3-coder',
        rawModelId: 'qwen3-coder',
        label: 'qwen3-coder',
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
  });

  it('keeps refusing every model step by default', () => {
    const pipeline = oneStep(agentPrompt());
    for (const options of [undefined, { modelSteps: 'refuse' } as const]) {
      expect(classifyDaemonPipeline(pipeline, context, options)).toEqual({
        eligible: false,
        reason: 'model_step',
        jobId: 'j',
        stepIndex: 0,
        uses: 'builtin/agent-prompt',
      });
    }
  });

  it('admits Claude and Codex agent steps when model steps are admitted', () => {
    expect(
      classifyDaemonPipeline(oneStep(agentPrompt()), context, ADMIT),
    ).toEqual({ eligible: true, modelSteps: 1, modelHarnesses: ['claude'] });
    expect(
      classifyDaemonPipeline(
        oneStep(agentPrompt(DEFAULT_CODEX_MODEL)),
        context,
        ADMIT,
      ),
    ).toEqual({ eligible: true, modelSteps: 1, modelHarnesses: ['codex'] });
    expect(
      classifyDaemonPipeline(
        {
          name: 't',
          on: 'dispatch',
          jobs: {
            a: { steps: [agentPrompt(DEFAULT_CODEX_MODEL)] },
            b: { steps: [agentPrompt()] },
          },
        },
        context,
        ADMIT,
      ),
    ).toEqual({
      eligible: true,
      modelSteps: 2,
      modelHarnesses: ['claude', 'codex'],
    });
    for (const name of [
      'agent-loop',
      'plan-with-review',
      'quality-gate',
      'router',
      'condenser',
    ]) {
      expect(
        classifyDaemonPipeline(
          oneStep({
            uses: `builtin/${name}`,
            with: { model: DEFAULT_CLAUDE_MODEL },
          }),
          context,
          ADMIT,
        ),
      ).toEqual({ eligible: true, modelSteps: 1, modelHarnesses: ['claude'] });
    }
  });

  it('admits Ollama agent steps on the Claude and Codex harnesses', () => {
    const ollama = OLLAMA_MODELS[0] ?? '';
    expect(getModelSource(ollama)).toBe('ollama');
    for (const uses of ['builtin/agent-prompt', 'builtin/agent-resume']) {
      expect(
        classifyDaemonPipeline(
          oneStep({ uses, with: { prompt: 'x', model: ollama } }),
          context,
          ADMIT,
        ),
      ).toEqual({ eligible: true, modelSteps: 1, modelHarnesses: ['codex'] });
    }
    initModelHarnessAssignments({
      revision: 1,
      assignments: [
        {
          modelId: ollama,
          source: 'ollama',
          harness: 'claude',
          defaultHarness: 'codex',
          configurable: true,
          overridden: true,
        },
      ],
    });
    try {
      expect(
        classifyDaemonPipeline(oneStep(agentPrompt(ollama)), context, ADMIT),
      ).toEqual({ eligible: true, modelSteps: 1, modelHarnesses: ['claude'] });
    } finally {
      initModelHarnessAssignments({ revision: 0, assignments: [] });
    }
  });

  it('refuses models the daemon does not run', () => {
    // An Ollama model resolves a local route only on the model-aware agent
    // actions, in process as in the daemon (CAN-5831 D1).
    expect(
      classifyDaemonPipeline(
        oneStep({
          uses: 'builtin/router',
          with: { model: OLLAMA_MODELS[0] ?? '' },
        }),
        context,
        ADMIT,
      ),
    ).toMatchObject({ eligible: false, reason: 'model_provider' });
    const picks: Array<[string, string]> = [
      [CURSOR_MODELS[0] ?? '', 'cursor-managed'],
      [COPILOT_MODELS[0] ?? '', 'copilot-managed'],
      [OPENCODE_MODELS[0] ?? '', 'opencode-managed'],
    ];
    for (const [model, source] of picks) {
      expect(model).not.toBe('');
      expect(getModelSource(model)).toBe(source);
    }
    for (const model of picks.map(([model]) => model)) {
      expect(
        classifyDaemonPipeline(oneStep(agentPrompt(model)), context, ADMIT),
      ).toMatchObject({ eligible: false, reason: 'model_provider' });
    }
    expect(
      classifyDaemonPipeline(
        oneStep({
          uses: 'builtin/router',
          with: { model: DEFAULT_CODEX_MODEL },
        }),
        context,
        ADMIT,
      ),
    ).toMatchObject({ eligible: false, reason: 'model_provider' });
  });

  it('refuses model actions it does not run', () => {
    const steps: Step[] = [
      { uses: 'builtin/parallel-agents' },
      { uses: 'builtin/git-commit-push' },
      { uses: 'builtin/github-create-pr' },
      { run: 'claude -p hi', log_format_hint: 'agent' },
    ];
    for (const step of steps) {
      expect(
        classifyDaemonPipeline(oneStep(step), context, ADMIT),
      ).toMatchObject({ eligible: false, reason: 'model_action' });
    }
  });

  it('admits model alias steps by what their alias names for the run', () => {
    // CAN-5832: the run's core resolves each alias at launch.
    const model_aliases = [
      { id: 'fast', name: 'Fast', defaults: { base: DEFAULT_CLAUDE_MODEL } },
      { id: 'agent', name: 'Agent', defaults: { agent_id: 'agent_model_1' } },
    ];
    const resolved = (
      modelAliases: DaemonPipelineClassifierContext['modelAliases'],
    ): DaemonPipelineClassifierContext => ({ ...context, modelAliases });
    // A pipeline that declares aliases and uses none is eligible.
    expect(
      classifyDaemonPipeline(
        oneStep(agentPrompt(), { model_aliases }),
        context,
        ADMIT,
      ),
    ).toEqual({ eligible: true, modelSteps: 1, modelHarnesses: ['claude'] });
    expect(
      classifyDaemonPipeline(
        oneStep(agentPrompt('fast'), { model_aliases }),
        resolved({ fast: { base: DEFAULT_CLAUDE_MODEL, plugins: false } }),
        ADMIT,
      ),
    ).toEqual({ eligible: true, modelSteps: 1, modelHarnesses: ['claude'] });
    expect(
      classifyDaemonPipeline(
        oneStep(agentPrompt('agent'), { model_aliases }),
        resolved({ agent: { base: DEFAULT_CODEX_MODEL, plugins: false } }),
        ADMIT,
      ),
    ).toEqual({ eligible: true, modelSteps: 1, modelHarnesses: ['codex'] });
    // An alias the core could not resolve, one on an action that does not
    // resolve aliases, one naming a provider the daemon does not run, and
    // one that adds plugins to a Codex step stay in process.
    expect(
      classifyDaemonPipeline(
        oneStep(agentPrompt('fast'), { model_aliases }),
        context,
        ADMIT,
      ),
    ).toMatchObject({ eligible: false, reason: 'model_alias' });
    expect(
      classifyDaemonPipeline(
        oneStep(
          { uses: 'builtin/router', with: { model: 'fast' } },
          { model_aliases },
        ),
        resolved({ fast: { base: DEFAULT_CLAUDE_MODEL, plugins: false } }),
        ADMIT,
      ),
    ).toMatchObject({ eligible: false, reason: 'model_alias' });
    expect(
      classifyDaemonPipeline(
        oneStep(agentPrompt('fast'), { model_aliases }),
        resolved({ fast: { base: CURSOR_MODELS[0] ?? '', plugins: false } }),
        ADMIT,
      ),
    ).toMatchObject({ eligible: false, reason: 'model_provider' });
    expect(
      classifyDaemonPipeline(
        oneStep(agentPrompt('agent'), { model_aliases }),
        resolved({ agent: { base: DEFAULT_CODEX_MODEL, plugins: true } }),
        ADMIT,
      ),
    ).toMatchObject({ eligible: false, reason: 'plugin_collections' });
  });

  it('admits plugin collections the core resolved, on Claude steps only', () => {
    // CAN-5832: collections resolve in the run's core at launch; Codex
    // plugins stay in process (CAN-6012).
    const plugin_collections = [{ id: 'review', name: 'Review', defaults: [] }];
    const withCollections: DaemonPipelineClassifierContext = {
      ...context,
      pluginCollections: new Set(['review']),
      modelAliases: {
        fast: { base: DEFAULT_CLAUDE_MODEL, plugins: true },
      },
    };
    const step = (model?: string): Step => ({
      uses: 'builtin/agent-prompt',
      with: {
        prompt: 'x',
        plugin_collection_id: 'review',
        ...(model !== undefined ? { model } : {}),
      },
    });
    expect(
      classifyDaemonPipeline(
        oneStep(step(), { plugin_collections }),
        withCollections,
        ADMIT,
      ),
    ).toEqual({ eligible: true, modelSteps: 1, modelHarnesses: ['claude'] });
    // An alias that adds plugins runs on Claude too.
    expect(
      classifyDaemonPipeline(
        oneStep(agentPrompt('fast'), {
          plugin_collections,
          model_aliases: [
            {
              id: 'fast',
              name: 'Fast',
              defaults: {
                base: DEFAULT_CLAUDE_MODEL,
                plugin_collection_id: 'review',
              },
            },
          ],
        }),
        withCollections,
        ADMIT,
      ),
    ).toEqual({ eligible: true, modelSteps: 1, modelHarnesses: ['claude'] });
    // The core keys its snapshots by the trimmed id the executor looks up.
    expect(
      classifyDaemonPipeline(
        oneStep(step(), {
          plugin_collections: [
            { id: ' review ', name: 'Review', defaults: [] },
          ],
        }),
        withCollections,
        ADMIT,
      ),
    ).toEqual({ eligible: true, modelSteps: 1, modelHarnesses: ['claude'] });
    // A Codex step with a collection, a collection the core did not resolve
    // (or one naming an MCP server, which it leaves out), and a collection on
    // an action that loads none stay in process.
    for (const [candidate, ctx] of [
      [
        oneStep(step(DEFAULT_CODEX_MODEL), { plugin_collections }),
        withCollections,
      ],
      [oneStep(step(), { plugin_collections }), context],
      [
        oneStep(
          {
            uses: 'builtin/router',
            with: {
              model: DEFAULT_CLAUDE_MODEL,
              plugin_collection_id: 'review',
            },
          },
          { plugin_collections },
        ),
        withCollections,
      ],
    ] as const)
      expect(classifyDaemonPipeline(candidate, ctx, ADMIT)).toMatchObject({
        eligible: false,
        reason: 'plugin_collections',
      });
  });

  it('refuses expression models and plugin collections', () => {
    expect(
      classifyDaemonPipeline(
        oneStep(agentPrompt('${{ inputs.model }}')),
        context,
        ADMIT,
      ),
    ).toMatchObject({ eligible: false, reason: 'dynamic_model' });
    const model_aliases = [
      { id: 'fast', name: 'Fast', defaults: { base: DEFAULT_CLAUDE_MODEL } },
    ];
    expect(
      classifyDaemonPipeline(
        oneStep(agentPrompt(), {
          plugin_collections: [{ id: 'c', name: 'C', defaults: [] }],
        }),
        context,
        ADMIT,
      ),
    ).toMatchObject({ eligible: false, reason: 'plugin_collections' });
    expect(
      classifyDaemonPipeline(
        oneStep({
          uses: 'builtin/agent-prompt',
          with: { prompt: 'x', plugin_collection_id: 'c' },
        }),
        context,
        ADMIT,
      ),
    ).toMatchObject({ eligible: false, reason: 'plugin_collections' });
    expect(
      classifyDaemonPipeline(
        oneStep({ run: 'echo hi' }, { model_aliases }),
        context,
        ADMIT,
      ),
    ).toEqual({ eligible: true, modelSteps: 0, modelHarnesses: [] });
  });

  describe('composite actions', () => {
    let repo: string;

    beforeEach(() => {
      repo = realpathSync(
        mkdtempSync(join(tmpdir(), 'canopy-daemon-eligibility-models-')),
      );
    });

    afterEach(() => {
      rmSync(repo, { recursive: true, force: true });
    });

    function writeComposite(name: string, steps: string): void {
      const dir = join(getProjectActionsDir(repo), name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'action.yml'),
        `name: ${name}\nruns:\n  using: composite\n  steps:\n${steps}`,
      );
    }

    it('walks composite actions to the model steps inside them', () => {
      const withRepo: DaemonPipelineClassifierContext = {
        ...context,
        repoPath: repo,
      };
      writeComposite(
        'wrap',
        '    - run: echo a\n' +
          '    - uses: builtin/agent-prompt\n' +
          '      with:\n' +
          '        prompt: x\n' +
          `        model: '${DEFAULT_CLAUDE_MODEL}'\n`,
      );
      expect(
        classifyDaemonPipeline(
          oneStep({ uses: 'project/wrap' }),
          withRepo,
          ADMIT,
        ),
      ).toEqual({ eligible: true, modelSteps: 1, modelHarnesses: ['claude'] });

      writeComposite(
        'wrap',
        '    - run: echo a\n' +
          '    - uses: builtin/agent-prompt\n' +
          '      with:\n' +
          '        prompt: x\n' +
          "        model: '${{ inputs.model }}'\n",
      );
      expect(
        classifyDaemonPipeline(
          oneStep({ uses: 'project/wrap' }),
          withRepo,
          ADMIT,
        ),
      ).toEqual({
        eligible: false,
        reason: 'dynamic_model',
        jobId: 'j',
        stepIndex: 0,
        uses: 'project/wrap',
      });
    });
  });
});
