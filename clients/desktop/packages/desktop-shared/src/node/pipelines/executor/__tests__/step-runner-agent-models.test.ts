const expectedRoutingSignal: unknown = expect.any(AbortSignal);
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_CLAUDE_MODEL,
  initClaudeModels,
  initCodexModels,
  initAiGatewayModels,
  initModelHarnessAssignments,
  initOllamaModels,
  toOllamaModelId,
  type AgentModelConfig,
  type CanopyCloudAccountPublicState,
} from '@canopy/desktop-shared/types';
import {
  isModelBlocked,
  resolveModelPolicy,
} from '@canopy/desktop-shared/lib/model-policy';
import { brandEnvName } from '@canopy/desktop-shared/brand/env';
import { resetResolvedCanopyDataDirForTests } from '../../../../canopy-paths';
import {
  AI_CREDITS_ROUTED_OUTPUT_KEY,
  MODEL_GATEWAY_ROUTED_OUTPUT_KEY,
  mergePipelinePluginSelections,
  resolvePipelineModelInputs,
  runStep,
} from '../step-runner';
import type {
  AgentPromptWorkerRequest,
  AgentPromptWorkerResult,
  CodexPromptRunnerRequest,
  CodexPromptRunnerResult,
  ExecutionRuntime,
  NormalizedStep,
  StepOutputEvent,
} from '../types';

const BASE_MODEL = 'claude-pipeline-agent-test';
const CODEX_MODEL = 'gpt-6-sol';
/**
 * Hardcoded runner fallbacks the gate mirrors — see `DEFAULT_COMMIT_MODEL` in
 * `builtin-actions/git-commit-push/runner.ts` and `DEFAULT_PR_MODEL` in
 * `builtin-actions/github-create-pr/runner.ts`.
 */
const COMMIT_RUNNER_DEFAULT_MODEL = 'haiku';
const PR_RUNNER_DEFAULT_MODEL = 'sonnet';
const GATEWAY_ONLY_MODEL = 'gateway-only-pipeline-test';
const OLLAMA_MODEL = toOllamaModelId('llama3:8b');

type ResolveAiCreditsRouting = NonNullable<
  ExecutionRuntime['resolveAiCreditsRouting']
>;
function createRuntime(rootDir: string): ExecutionRuntime {
  return {
    // Pipeline fixtures do not enforce an org model policy.
    isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
    isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
    executionsDir: path.join(rootDir, 'executions'),
    tempRootDir: path.join(rootDir, 'tmp'),
    bundledActionsDir: path.join(rootDir, 'actions'),
    getProjectActionsDir: (repoPath: string): string =>
      path.join(repoPath, '.canopy', 'actions'),
    getProjectPipelinesDir: (repoPath: string): string =>
      path.join(repoPath, '.canopy', 'pipelines'),
  };
}

function createStep(partial: Partial<NormalizedStep>): NormalizedStep {
  return {
    id: partial.id ?? 'step',
    shell: partial.shell ?? 'bash',
    continue_on_error: partial.continue_on_error ?? false,
    timeout_minutes: partial.timeout_minutes ?? 1,
    skip_on_missing_action: partial.skip_on_missing_action ?? false,
    ...partial,
  };
}

function writeAgentPromptAction(
  runtime: ExecutionRuntime,
  script: string,
): void {
  const actionDir = path.join(runtime.bundledActionsDir, 'agent-prompt');
  fs.mkdirSync(actionDir, { recursive: true });
  fs.writeFileSync(
    path.join(actionDir, 'action.yml'),
    [
      'name: Agent Prompt',
      'log_format_hint: agent',
      'inputs:',
      '  model: {}',
      '  prompt: {}',
      '  system_prompt: {}',
      // Mirrors `resources/actions/agent-prompt/action.yml`, which declares
      // `default: none`. Without the default here the fixture could not
      // distinguish an authored `permission_preset: none` from a materialized
      // one, which is exactly how the Codex no-tools guard regressed.
      '  permission_preset: { default: none }',
      '  fast_mode: {}',
      'outputs: {}',
      'runs:',
      '  using: node',
      '  main: index.js',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(path.join(actionDir, 'index.js'), script, 'utf8');
}

/**
 * Fixture mirroring `packages/desktop-shared/resources/actions/agent-resume/action.yml`:
 * a `MODEL_AWARE_AGENT_ACTIONS` member whose `model` input is optional and
 * whose runner has a dedicated no-model branch that resumes a Claude session
 * without sending any model at all.
 */
function writeAgentResumeAction(
  runtime: ExecutionRuntime,
  script: string,
): void {
  const actionDir = path.join(runtime.bundledActionsDir, 'agent-resume');
  fs.mkdirSync(actionDir, { recursive: true });
  fs.writeFileSync(
    path.join(actionDir, 'action.yml'),
    [
      'name: Agent Resume',
      'log_format_hint: agent',
      'inputs:',
      '  session_id: {}',
      '  model:',
      '    description: Optional provider model or pipeline alias id.',
      '    required: false',
      '  prompt: {}',
      // Mirrors the shipped action.yml: the materialized `none` default is
      // exactly what made every Codex resume step fail (CAN-2436), so the
      // fixture must carry it or the regression cannot reproduce here.
      '  permission_preset:',
      '    required: false',
      '    default: none',
      'outputs: {}',
      'runs:',
      '  using: node',
      '  main: index.js',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(path.join(actionDir, 'index.js'), script, 'utf8');
}

/**
 * Node-runtime action that declares an optional `model` input and calls the
 * provider directly — the shape shared by `quality-gate`, `router`,
 * `condenser`, `plan-with-review`, `agent-loop`, and `parallel-agents`.
 *
 * These are NOT in `MODEL_AWARE_AGENT_ACTIONS`, so they never get pipeline
 * alias resolution; the raw `model` input is what reaches the provider.
 */
function writeModelInputNodeAction(
  runtime: ExecutionRuntime,
  actionName: string,
  script: string,
): void {
  const actionDir = path.join(runtime.bundledActionsDir, actionName);
  fs.mkdirSync(actionDir, { recursive: true });
  fs.writeFileSync(
    path.join(actionDir, 'action.yml'),
    [
      `name: ${actionName}`,
      'log_format_hint: agent',
      'inputs:',
      '  model:',
      '    description: Optional Claude model override.',
      '    required: false',
      '  criteria: {}',
      'outputs: {}',
      'runs:',
      '  using: node',
      '  main: index.js',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(path.join(actionDir, 'index.js'), script, 'utf8');
}

/**
 * Fixture mirroring `packages/desktop-shared/resources/actions/git-commit-push/action.yml`:
 * a Claude-backed node action whose model input is named `commit_model`, not
 * `model`. Its runner falls back to `<BRAND>_PREF_COMMIT_GENERATION_MODEL` and
 * then to a hardcoded Haiku id.
 */
function writeCommitPushAction(
  runtime: ExecutionRuntime,
  script: string,
): void {
  const actionDir = path.join(runtime.bundledActionsDir, 'git-commit-push');
  fs.mkdirSync(actionDir, { recursive: true });
  fs.writeFileSync(
    path.join(actionDir, 'action.yml'),
    [
      'name: Git Commit + Push',
      'inputs:',
      '  commit_model:',
      '    description: Optional commit-message model override.',
      '    required: false',
      '  commit_thinking_level:',
      '    description: Optional thinking level override.',
      '    required: false',
      'outputs: {}',
      'runs:',
      '  using: node',
      '  main: index.js',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(path.join(actionDir, 'index.js'), script, 'utf8');
}

/**
 * Fixture mirroring `packages/desktop-shared/resources/actions/github-create-pr/action.yml`:
 * its model input is named `pr_model`, falling back to
 * `<BRAND>_PREF_PR_GENERATION_MODEL` and then to a hardcoded Sonnet id.
 */
function writeCreatePrAction(runtime: ExecutionRuntime, script: string): void {
  const actionDir = path.join(runtime.bundledActionsDir, 'github-create-pr');
  fs.mkdirSync(actionDir, { recursive: true });
  fs.writeFileSync(
    path.join(actionDir, 'action.yml'),
    [
      'name: GitHub Create PR',
      'inputs:',
      '  pr_model:',
      '    description: Optional PR-generation model override.',
      '    required: false',
      'outputs: {}',
      'runs:',
      '  using: node',
      '  main: index.js',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(path.join(actionDir, 'index.js'), script, 'utf8');
}

/**
 * Action script that reports the inputs the subprocess actually received, so a
 * test can assert on the values the action would run on rather than only on the
 * ids the gate probed.
 */
function reportInputsScript(
  entries: readonly { envKey: string; outputKey: string }[],
): string {
  return [
    "const fs = require('node:fs');",
    "fs.appendFileSync(process.env.CANOPY_OUTPUT, 'ok=true\\n');",
    ...entries.map(
      (entry) =>
        `fs.appendFileSync(process.env.CANOPY_OUTPUT, '${entry.outputKey}=' + (process.env.${entry.envKey} ?? '<unset>') + '\\n');`,
    ),
  ].join('\n');
}

/** Single-input convenience wrapper around {@link reportInputsScript}. */
function reportModelInputScript(envKey: string, outputKey: string): string {
  return reportInputsScript([{ envKey, outputKey }]);
}

/** Action that declares no `model` input at all (e.g. a plain tool step). */
function writeModellessNodeAction(
  runtime: ExecutionRuntime,
  actionName: string,
  script: string,
): void {
  const actionDir = path.join(runtime.bundledActionsDir, actionName);
  fs.mkdirSync(actionDir, { recursive: true });
  fs.writeFileSync(
    path.join(actionDir, 'action.yml'),
    [
      `name: ${actionName}`,
      'inputs:',
      '  message: {}',
      'outputs: {}',
      'runs:',
      '  using: node',
      '  main: index.js',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(path.join(actionDir, 'index.js'), script, 'utf8');
}

const OK_OUTPUT_SCRIPT =
  "require('node:fs').appendFileSync(process.env.CANOPY_OUTPUT, 'ok=true\\n');";

function recoverableAgentFailureScript(): string {
  return [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const outputDir = path.dirname(process.env.CANOPY_OUTPUT);',
    "const transcriptFile = path.join(outputDir, 'partial.jsonl');",
    'fs.writeFileSync(transcriptFile, \'{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"partial work"}]}}\\n\');',
    'const metadata = {',
    '  version: 1,',
    "  provider: 'claude',",
    "  session_id: 'session-partial',",
    '  had_agent_activity: true,',
    '  transcript_file: transcriptFile,',
    '  classification: {',
    "    kind: 'provider_usage_limit',",
    "    code: 'rate_limit',",
    "    provider: 'claude',",
    "    account_scope: 'native',",
    "    diagnostic_message: 'usage exhausted',",
    '  },',
    "  message: 'usage exhausted',",
    '};',
    "const metadataFile = path.join(outputDir, 'agent-failure.json');",
    'fs.writeFileSync(metadataFile, JSON.stringify(metadata));',
    'fs.appendFileSync(process.env.CANOPY_OUTPUT, `agent_failure_metadata_file=${metadataFile}\\nagent_failure_transcript_file=${transcriptFile}\\n`);',
    'process.exitCode = 1;',
  ].join('\n');
}

function inputValues(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    model: 'reviewer',
    system_prompt: 'Existing prompt.',
    ...overrides,
  };
}

function accountWithEnforcedSettings(
  enforcedSettings?: CanopyCloudAccountPublicState['enforcedSettings'],
): CanopyCloudAccountPublicState {
  return {
    hasApiKey: true,
    authMode: 'oauth',
    credentialSource: 'oauth_desktop',
    capabilities: [],
    organizations: [],
    teams: [],
    storageAvailable: true,
    ...(enforcedSettings ? { enforcedSettings } : {}),
  };
}

/**
 * Enforcing single-organization account whose reviewed snapshot contains
 * exactly `reviewedModelIds`. Everything else is blocked, because an org model
 * policy is an allowlist.
 */
function enforcingAccount(
  reviewedModelIds: string[],
): CanopyCloudAccountPublicState {
  return accountWithEnforcedSettings([
    {
      organizationId: 'org-1',
      organizationName: 'Acme',
      policies: [
        {
          kind: 'model-policy',
          blockedModelIds: [],
          reviewedModelIds,
        },
      ],
    },
  ]);
}

/**
 * Org model-policy gate wired exactly the way the desktop runtime wires it —
 * the shared `resolveModelPolicy` + `isModelBlocked` pair rather than a
 * hand-rolled boolean.
 *
 * This is deliberate: the step runner probes the gate with a REAL model id
 * (the named model, or `DEFAULT_CLAUDE_MODEL` when a step names none), so the
 * refuse/allow split depends on the production allowlist semantics — reviewed
 * ids pass, unreviewed ids are blocked, and nothing is blocked when no org
 * enforces. Driving the fixture through the production predicate means these
 * tests fail loudly if that shape ever changes, instead of passing against a
 * stub that no longer matches reality.
 */
function orgModelPolicyGate(
  account: CanopyCloudAccountPublicState | null,
): (modelId: string) => Promise<boolean> {
  const policy = resolveModelPolicy(account);
  return (modelId: string): Promise<boolean> =>
    Promise.resolve(isModelBlocked(modelId, policy));
}

/**
 * "Is any org model policy actively enforcing" for the same account, derived
 * the way `apps/desktop-app/src/main/lib/model-policy-state.ts` derives it:
 * `resolveModelPolicy(account).size > 0`, which is non-empty exactly when some
 * organization carries a `kind: 'model-policy'` setting.
 *
 * The signal cannot come from `isModelBlockedByOrgPolicy`: that returns `false`
 * both for "no policy at all" and for "a policy that approved this id", and the
 * pin has to happen only in the second case.
 */
function orgModelPolicyActiveGate(
  account: CanopyCloudAccountPublicState | null,
): () => Promise<boolean> {
  const active = resolveModelPolicy(account).size > 0;
  return (): Promise<boolean> => Promise.resolve(active);
}

/** Wire both org-policy signals on a runtime from one account fixture. */
function applyOrgModelPolicy(
  runtime: ExecutionRuntime,
  account: CanopyCloudAccountPublicState | null,
): void {
  runtime.isModelBlockedByOrgPolicy = jest.fn(orgModelPolicyGate(account));
  runtime.isOrgModelPolicyActive = jest.fn(orgModelPolicyActiveGate(account));
}

describe('resolvePipelineModelInputs', () => {
  beforeAll(() => {
    initClaudeModels([
      {
        id: BASE_MODEL,
        label: 'Claude Pipeline Agent Test',
        supportedThinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        gateway: {
          gatewayId: 'provider/claude-pipeline-agent-test',
          family: 'anthropic',
          recommendedHarness: 'claude',
          gatewayOnly: false,
          contextWindow: 100_000,
          supportsPromptCaching: true,
          supportedThinkingLevels: ['low', 'medium'],
          toolSchemaProfile: 'standard',
        },
      },
    ]);
    initCodexModels([{ id: CODEX_MODEL, label: 'GPT 6 Sol' }]);
    initAiGatewayModels(
      [
        {
          id: GATEWAY_ONLY_MODEL,
          label: 'Gateway-only pipeline test',
          recommendedHarness: 'codex',
          contextWindow: 100_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
      [
        {
          modelId: BASE_MODEL,
          gatewayId: 'provider/claude-pipeline-agent-test',
          family: 'anthropic',
          recommendedHarness: 'claude',
          gatewayOnly: false,
          contextWindow: 100_000,
          supportsPromptCaching: true,
          supportedThinkingLevels: ['low', 'medium'],
          toolSchemaProfile: 'standard',
        },
        {
          modelId: GATEWAY_ONLY_MODEL,
          gatewayId: 'provider/gateway-only-pipeline-test',
          family: 'deepseek',
          recommendedHarness: 'codex',
          gatewayOnly: true,
          contextWindow: 100_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
    );
    initOllamaModels([
      {
        id: OLLAMA_MODEL,
        rawModelId: 'llama3:8b',
        label: 'Llama 3 8B',
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
  });

  it('rejects raw Agent model IDs without a model_aliases entry', async () => {
    const runtime = createRuntime(
      fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-agent-step-runner-')),
    );
    await expect(
      resolvePipelineModelInputs({
        step: createStep({ uses: 'builtin/agent-prompt' }),
        inputValues: inputValues({ model: 'agent_model_pipeline_reviewer' }),
        runtime,
      }),
    ).rejects.toThrow(
      'Agent model IDs are not supported directly in workflow steps. Define a model_aliases entry with defaults.agent_id: agent_model_pipeline_reviewer and use the alias id in with.model.',
    );
    fs.rmSync(runtime.executionsDir, { recursive: true, force: true });
  });

  it('leaves non model-aware actions unchanged', async () => {
    const values = inputValues();
    const runtime = createRuntime(
      fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-agent-step-runner-')),
    );
    const resolved = await resolvePipelineModelInputs({
      step: createStep({ uses: 'custom/action' }),
      inputValues: values,
      runtime,
    });

    expect(resolved).toEqual({
      inputValues: values,
      aliasPluginCollectionIds: [],
    });
    fs.rmSync(runtime.executionsDir, { recursive: true, force: true });
  });

  it('resolves inline aliases to the configured base model and prompt', async () => {
    const runtime = createRuntime(
      fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-agent-step-runner-')),
    );
    const resolved = await resolvePipelineModelInputs({
      step: createStep({ uses: 'builtin/agent-prompt' }),
      inputValues: inputValues({ model: 'reviewer' }),
      modelAliases: [
        {
          id: 'reviewer',
          name: 'Reviewer',
          defaults: {
            base: BASE_MODEL,
            instructions: 'Alias instructions.',
            plugin_collection_id: 'alias-tools',
          },
        },
      ],
      runtime,
    });

    expect(resolved.selectedModel).toBe('reviewer');
    expect(resolved.runtimeModel).toBe(BASE_MODEL);
    expect(resolved.aliasId).toBe('reviewer');
    expect(resolved.aliasName).toBe('Reviewer');
    expect(resolved.aliasPluginCollectionIds).toEqual(['alias-tools']);
    expect(resolved.inputValues.system_prompt).toBe(
      'Existing prompt.\n\nYou are now a user defined agent with these additional instructions: Alias instructions.',
    );
    fs.rmSync(runtime.executionsDir, { recursive: true, force: true });
  });

  it('allows preferences to override alias defaults and reset to defaults', async () => {
    const runtime = createRuntime(
      fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-agent-step-runner-')),
    );
    const alias = {
      id: 'reviewer',
      name: 'Reviewer',
      defaults: { base: BASE_MODEL, instructions: 'Default instructions.' },
    };

    const override = await resolvePipelineModelInputs({
      step: createStep({ uses: 'builtin/agent-prompt' }),
      inputValues: inputValues({ model: 'reviewer' }),
      modelAliases: [alias],
      modelAliasPreferences: {
        reviewer: { mode: 'inline', base: OLLAMA_MODEL },
      },
      runtime,
    });
    expect(override.runtimeModel).toBe(OLLAMA_MODEL);
    expect(override.inputValues.system_prompt).toBe('Existing prompt.');

    const reset = await resolvePipelineModelInputs({
      step: createStep({ uses: 'builtin/agent-prompt' }),
      inputValues: inputValues({ model: 'reviewer' }),
      modelAliases: [alias],
      modelAliasPreferences: {
        reviewer: { mode: 'reset' },
      },
      runtime,
    });
    expect(reset.runtimeModel).toBe(BASE_MODEL);
    expect(reset.inputValues.system_prompt).toContain('Default instructions.');
    fs.rmSync(runtime.executionsDir, { recursive: true, force: true });
  });

  it('rejects inline alias preferences that resolve to raw Agent model IDs', async () => {
    const runtime = createRuntime(
      fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-agent-step-runner-')),
    );

    await expect(
      resolvePipelineModelInputs({
        step: createStep({ uses: 'builtin/agent-prompt' }),
        inputValues: inputValues({ model: 'reviewer' }),
        modelAliases: [
          {
            id: 'reviewer',
            name: 'Reviewer',
            defaults: { base: BASE_MODEL },
          },
        ],
        modelAliasPreferences: {
          reviewer: { mode: 'inline', base: 'agent_model_pipeline_reviewer' },
        },
        runtime,
      }),
    ).rejects.toThrow(
      'Agent model IDs are not supported directly in workflow steps. Define a model_aliases entry with defaults.agent_id: agent_model_pipeline_reviewer and use the alias id in with.model.',
    );
    fs.rmSync(runtime.executionsDir, { recursive: true, force: true });
  });

  it('requires a preference when an alias has no defaults', async () => {
    const runtime = createRuntime(
      fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-agent-step-runner-')),
    );
    await expect(
      resolvePipelineModelInputs({
        step: createStep({ uses: 'builtin/agent-prompt' }),
        inputValues: inputValues({ model: 'required_model' }),
        modelAliases: [{ id: 'required_model', name: 'Required Model' }],
        runtime,
      }),
    ).rejects.toThrow(
      'Workflow model alias "required_model" requires a model configuration',
    );

    const resolved = await resolvePipelineModelInputs({
      step: createStep({ uses: 'builtin/agent-prompt' }),
      inputValues: inputValues({ model: 'required_model' }),
      modelAliases: [{ id: 'required_model', name: 'Required Model' }],
      modelAliasPreferences: {
        required_model: { mode: 'inline', base: BASE_MODEL },
      },
      runtime,
    });
    expect(resolved.runtimeModel).toBe(BASE_MODEL);
    fs.rmSync(runtime.executionsDir, { recursive: true, force: true });
  });

  it('resolves built-in $ aliases supplied as dispatch input values at runtime', async () => {
    // A dispatch-supplied `--input model=$cheap` reaches the executor as the
    // literal alias string: normalize-time alias resolution only rewrites
    // values authored in the pipeline YAML itself, not runtime input values.
    const runtime = createRuntime(
      fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-agent-step-runner-')),
    );
    const resolved = await resolvePipelineModelInputs({
      step: createStep({ uses: 'builtin/agent-prompt' }),
      inputValues: inputValues({ model: '$cheap' }),
      runtime,
    });

    expect(resolved.runtimeModel).toBe('sonnet');
    expect(resolved.inputValues.model).toBe('sonnet');
    expect(resolved.selectedModel).toBe('$cheap');
    fs.rmSync(runtime.executionsDir, { recursive: true, force: true });
  });

  it('rejects an unknown $ alias supplied at dispatch time', async () => {
    const runtime = createRuntime(
      fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-agent-step-runner-')),
    );
    await expect(
      resolvePipelineModelInputs({
        step: createStep({ uses: 'builtin/agent-prompt' }),
        inputValues: inputValues({ model: '$bogus' }),
        runtime,
      }),
    ).rejects.toThrow('Unknown pipeline model alias "$bogus"');
    fs.rmSync(runtime.executionsDir, { recursive: true, force: true });
  });

  it('resolves Agent aliases through the runtime hook', async () => {
    const runtime = createRuntime(
      fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-agent-step-runner-')),
    );
    runtime.resolvePipelineAgentModelAlias = jest.fn((agentId) =>
      Promise.resolve({
        agentId,
        name: 'Runtime Reviewer',
        base: BASE_MODEL,
        instructions: 'Runtime instructions.',
        pluginSelections: {
          collectionIds: ['agent-runtime-tools'],
          skillRefs: [],
          pluginRefs: [],
        },
      }),
    );

    const resolved = await resolvePipelineModelInputs({
      step: createStep({ uses: 'builtin/agent-prompt' }),
      inputValues: inputValues({ model: 'reviewer' }),
      modelAliases: [
        {
          id: 'reviewer',
          name: 'Reviewer',
          defaults: { agent_id: 'agent_model_runtime_reviewer' },
        },
      ],
      runtime,
      scope: { projectId: 'workspace-1' },
    });

    expect(runtime.resolvePipelineAgentModelAlias).toHaveBeenCalledWith(
      'agent_model_runtime_reviewer',
      { projectId: 'workspace-1' },
    );
    expect(resolved.runtimeModel).toBe(BASE_MODEL);
    expect(resolved.agentId).toBe('agent_model_runtime_reviewer');
    expect(resolved.aliasPluginCollectionIds).toEqual([
      '__canopy_agent_model__:agent_model_runtime_reviewer',
    ]);
    expect(resolved.syntheticSelectionsByCollectionId).toMatchObject({
      '__canopy_agent_model__:agent_model_runtime_reviewer': {
        collectionIds: ['agent-runtime-tools'],
      },
    });
    fs.rmSync(runtime.executionsDir, { recursive: true, force: true });
  });

  it('allows an Agent alias to inherit a gateway-only base model', async () => {
    const runtime = createRuntime(
      fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-agent-step-runner-')),
    );
    runtime.resolvePipelineAgentModelAlias = jest.fn((agentId) =>
      Promise.resolve({
        agentId,
        name: 'Gateway Reviewer',
        base: GATEWAY_ONLY_MODEL,
        instructions: 'Use the gateway base.',
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
        },
      }),
    );

    const resolved = await resolvePipelineModelInputs({
      step: createStep({ uses: 'builtin/agent-prompt' }),
      inputValues: inputValues({ model: 'reviewer' }),
      modelAliases: [
        {
          id: 'reviewer',
          name: 'Reviewer',
          defaults: { agent_id: 'agent_model_gateway_reviewer' },
        },
      ],
      runtime,
    });

    expect(resolved.runtimeModel).toBe(GATEWAY_ONLY_MODEL);
    expect(resolved.inputValues.model).toBe(GATEWAY_ONLY_MODEL);
    fs.rmSync(runtime.executionsDir, { recursive: true, force: true });
  });

  it('fails clearly when an Agent alias runtime hook is unavailable', async () => {
    const runtime = createRuntime(
      fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-agent-step-runner-')),
    );

    await expect(
      resolvePipelineModelInputs({
        step: createStep({ uses: 'builtin/agent-prompt' }),
        inputValues: inputValues({ model: 'reviewer' }),
        modelAliases: [
          {
            id: 'reviewer',
            name: 'Reviewer',
            defaults: { agent_id: 'agent_model_runtime_reviewer' },
          },
        ],
        runtime,
      }),
    ).rejects.toThrow(
      'Workflow model alias "reviewer" references Agent "agent_model_runtime_reviewer", but Agent resolution is unavailable in this runtime.',
    );
    fs.rmSync(runtime.executionsDir, { recursive: true, force: true });
  });

  it('fails clearly when an Agent alias references a missing local Agent', async () => {
    const runtime = createRuntime(
      fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-agent-step-runner-')),
    );
    runtime.resolvePipelineAgentModelAlias = jest.fn(() =>
      Promise.resolve(null),
    );

    await expect(
      resolvePipelineModelInputs({
        step: createStep({ uses: 'builtin/agent-prompt' }),
        inputValues: inputValues({ model: 'reviewer' }),
        modelAliases: [
          {
            id: 'reviewer',
            name: 'Reviewer',
            defaults: { agent_id: 'agent_model_missing_reviewer' },
          },
        ],
        runtime,
      }),
    ).rejects.toThrow(
      'Workflow model alias "reviewer" references Agent "agent_model_missing_reviewer", but that Agent is not available locally.',
    );
    fs.rmSync(runtime.executionsDir, { recursive: true, force: true });
  });

  it('fails clearly when an Agent alias resolves to an unavailable base model', async () => {
    const runtime = createRuntime(
      fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-agent-step-runner-')),
    );
    runtime.resolvePipelineAgentModelAlias = jest.fn((agentId) =>
      Promise.resolve({
        agentId,
        name: 'Runtime Reviewer',
        base: 'missing-base-model',
        instructions: 'Runtime instructions.',
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
        },
      }),
    );

    await expect(
      resolvePipelineModelInputs({
        step: createStep({ uses: 'builtin/agent-prompt' }),
        inputValues: inputValues({ model: 'reviewer' }),
        modelAliases: [
          {
            id: 'reviewer',
            name: 'Reviewer',
            defaults: { agent_id: 'agent_model_runtime_reviewer' },
          },
        ],
        runtime,
      }),
    ).rejects.toThrow(
      'Workflow model alias "reviewer" references Agent "agent_model_runtime_reviewer", but Agent "Runtime Reviewer" uses unavailable base model "missing-base-model". Edit the Agent or choose another model.',
    );
    fs.rmSync(runtime.executionsDir, { recursive: true, force: true });
  });

  it('preserves MCP HTTP auth preferences when merging agent selections', () => {
    expect(
      mergePipelinePluginSelections(
        {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpHttpAuthPreferences: [
            {
              target: {
                kind: 'standalone',
                serverId: 'server-a',
                configId: 'default',
              },
              handler: 'provider',
            },
          ],
        },
        {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpHttpAuthPreferences: [
            {
              target: {
                kind: 'standalone',
                serverId: 'server-a',
                configId: 'default',
              },
              handler: 'canopy',
            },
            {
              target: {
                kind: 'plugin',
                marketplaceId: 'market',
                pluginName: 'plugin',
                serverName: 'api',
              },
              handler: 'provider',
            },
          ],
        },
      )?.mcpHttpAuthPreferences,
    ).toEqual([
      {
        target: {
          kind: 'standalone',
          serverId: 'server-a',
          configId: 'default',
        },
        handler: 'canopy',
      },
      {
        target: {
          kind: 'plugin',
          marketplaceId: 'market',
          pluginName: 'plugin',
          serverName: 'api',
        },
        handler: 'provider',
      },
    ]);
  });

  it('persists selected and runtime model metadata on completed agent steps', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);

    try {
      writeAgentPromptAction(
        runtime,
        "require('node:fs').appendFileSync(process.env.CANOPY_OUTPUT, 'ok=true\\n');",
      );

      const result = await runStep({
        executionId: 'exec-1',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: inputValues({ model: 'reviewer' }),
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
        modelAliases: [
          {
            id: 'reviewer',
            name: 'Reviewer',
            defaults: { base: BASE_MODEL },
          },
        ],
      });

      expect(result.status).toBe('success');
      expect(result.outputs).toEqual({ ok: 'true' });
      expect(result.agent_model).toBe('reviewer');
      expect(result.agent_runtime_model).toBe(BASE_MODEL);
      expect(result.agent_provider).toBe('claude');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses a blocked pipeline model and records the scoped refusal', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    runtime.isModelBlockedByOrgPolicy = jest.fn(() => Promise.resolve(true));
    runtime.recordModelPolicyRefusal = jest.fn();

    try {
      writeAgentPromptAction(runtime, 'process.exitCode = 0;');
      const result = await runStep({
        executionId: 'exec-policy',
        jobId: 'job-policy',
        step: createStep({
          id: 'agent-policy',
          uses: 'builtin/agent-prompt',
          with: { model: BASE_MODEL },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
        projectId: 'project-policy',
        worktreeId: 'worktree-policy',
      });
      expect(result.status).toBe('failure');
      expect(result.error).toContain('blocked by your organization policy');
      expect(runtime.recordModelPolicyRefusal).toHaveBeenCalledWith({
        executionId: 'exec-policy',
        jobId: 'job-policy',
        stepId: 'agent-policy',
        projectId: 'project-policy',
        worktreeId: 'worktree-policy',
        modelId: BASE_MODEL,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses a model-aware agent step that names no model when the org has not reviewed the default model', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    applyOrgModelPolicy(
      runtime,
      enforcingAccount(['provider/claude-pipeline-agent-test']),
    );
    runtime.recordModelPolicyRefusal = jest.fn();

    try {
      writeAgentPromptAction(runtime, "throw new Error('must not launch');");
      const result = await runStep({
        executionId: 'exec-unnamed-policy',
        jobId: 'job-policy',
        step: createStep({
          id: 'agent-unnamed',
          uses: 'builtin/agent-prompt',
          // No `model` input: `model` is `required: false`, so the provider
          // would otherwise run on its own default, unguarded.
          with: { prompt: 'hello' },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
        projectId: 'project-policy',
        worktreeId: 'worktree-policy',
      });

      expect(runtime.isModelBlockedByOrgPolicy).toHaveBeenCalledWith(
        DEFAULT_CLAUDE_MODEL,
        { projectId: 'project-policy', worktreeId: 'worktree-policy' },
      );
      expect(result.status).toBe('failure');
      expect(result.error).toContain('does not specify a model');
      expect(result.error).toContain(DEFAULT_CLAUDE_MODEL);
      expect(runtime.recordModelPolicyRefusal).toHaveBeenCalledWith({
        executionId: 'exec-unnamed-policy',
        jobId: 'job-policy',
        stepId: 'agent-unnamed',
        projectId: 'project-policy',
        worktreeId: 'worktree-policy',
        modelId: DEFAULT_CLAUDE_MODEL,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runs a model-aware agent step that names no model when the org reviewed the default model', async () => {
    // Regression guard for the bundled `refine-plan` preset: its `summarize`
    // step is `builtin/agent-prompt` with no `model` input, so a permissive
    // org that reviewed its whole catalog must still be able to run it.
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    applyOrgModelPolicy(runtime, enforcingAccount([DEFAULT_CLAUDE_MODEL]));
    runtime.recordModelPolicyRefusal = jest.fn();

    try {
      writeAgentPromptAction(runtime, OK_OUTPUT_SCRIPT);
      const result = await runStep({
        executionId: 'exec-unnamed-reviewed-default',
        jobId: 'job-policy',
        step: createStep({
          id: 'agent-unnamed',
          uses: 'builtin/agent-prompt',
          with: { prompt: 'hello' },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(runtime.isModelBlockedByOrgPolicy).toHaveBeenCalledWith(
        DEFAULT_CLAUDE_MODEL,
        {},
      );
      expect(result.status).toBe('success');
      expect(result.outputs).toEqual({ ok: 'true' });
      expect(runtime.recordModelPolicyRefusal).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('still runs a model-aware agent step that names no model when no org policy enforces', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    applyOrgModelPolicy(runtime, null);
    runtime.recordModelPolicyRefusal = jest.fn();

    try {
      writeAgentPromptAction(runtime, OK_OUTPUT_SCRIPT);
      const result = await runStep({
        executionId: 'exec-unnamed-open',
        jobId: 'job-open',
        step: createStep({
          id: 'agent-unnamed',
          uses: 'builtin/agent-prompt',
          with: { prompt: 'hello' },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('success');
      expect(result.outputs).toEqual({ ok: 'true' });
      expect(runtime.recordModelPolicyRefusal).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses a direct-provider node action (quality-gate) whose named model the org blocks', async () => {
    // `builtin/quality-gate` is not model-aware for alias resolution, but its
    // runner passes `INPUT_MODEL` straight into the Claude SDK — so the raw
    // `model` input is exactly what reaches the provider and must be gated.
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    applyOrgModelPolicy(runtime, enforcingAccount([DEFAULT_CLAUDE_MODEL]));
    runtime.recordModelPolicyRefusal = jest.fn();

    try {
      writeModelInputNodeAction(
        runtime,
        'quality-gate',
        "throw new Error('must not launch');",
      );
      const result = await runStep({
        executionId: 'exec-quality-gate-policy',
        jobId: 'job-policy',
        step: createStep({
          id: 'gate',
          uses: 'builtin/quality-gate',
          with: { model: BASE_MODEL, criteria: 'be good' },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
        projectId: 'project-policy',
        worktreeId: 'worktree-policy',
      });

      expect(runtime.isModelBlockedByOrgPolicy).toHaveBeenCalledWith(
        BASE_MODEL,
        { projectId: 'project-policy', worktreeId: 'worktree-policy' },
      );
      expect(result.status).toBe('failure');
      expect(result.error).toContain('blocked by your organization policy');
      expect(runtime.recordModelPolicyRefusal).toHaveBeenCalledWith({
        executionId: 'exec-quality-gate-policy',
        jobId: 'job-policy',
        stepId: 'gate',
        projectId: 'project-policy',
        worktreeId: 'worktree-policy',
        modelId: BASE_MODEL,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runs a direct-provider node action (quality-gate) whose named model the org reviewed', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    applyOrgModelPolicy(
      runtime,
      enforcingAccount([
        'provider/claude-pipeline-agent-test',
        DEFAULT_CLAUDE_MODEL,
        BASE_MODEL,
      ]),
    );
    runtime.recordModelPolicyRefusal = jest.fn();

    try {
      writeModelInputNodeAction(runtime, 'quality-gate', OK_OUTPUT_SCRIPT);
      const result = await runStep({
        executionId: 'exec-quality-gate-allowed',
        jobId: 'job-policy',
        step: createStep({
          id: 'gate',
          uses: 'builtin/quality-gate',
          with: { model: BASE_MODEL, criteria: 'be good' },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('success');
      expect(result.outputs).toEqual({ ok: 'true' });
      expect(runtime.recordModelPolicyRefusal).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses a direct-provider node action that names no model when the org has not reviewed the default', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    applyOrgModelPolicy(
      runtime,
      enforcingAccount(['provider/claude-pipeline-agent-test']),
    );
    runtime.recordModelPolicyRefusal = jest.fn();

    try {
      writeModelInputNodeAction(
        runtime,
        'quality-gate',
        "throw new Error('must not launch');",
      );
      const result = await runStep({
        executionId: 'exec-quality-gate-default',
        jobId: 'job-policy',
        step: createStep({
          id: 'gate',
          uses: 'builtin/quality-gate',
          with: { criteria: 'be good' },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(runtime.isModelBlockedByOrgPolicy).toHaveBeenCalledWith(
        DEFAULT_CLAUDE_MODEL,
        {},
      );
      expect(result.status).toBe('failure');
      expect(result.error).toContain('does not specify a model');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('never probes the org policy for an action that declares no model input', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    applyOrgModelPolicy(runtime, enforcingAccount([]));
    runtime.recordModelPolicyRefusal = jest.fn();

    try {
      writeModellessNodeAction(runtime, 'notify', OK_OUTPUT_SCRIPT);
      const result = await runStep({
        executionId: 'exec-modelless',
        jobId: 'job-policy',
        step: createStep({
          id: 'notify',
          uses: 'builtin/notify',
          with: { message: 'hi' },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('success');
      expect(runtime.isModelBlockedByOrgPolicy).not.toHaveBeenCalled();
      expect(runtime.recordModelPolicyRefusal).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runs every model-carrying step shape when no org policy enforces', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    applyOrgModelPolicy(runtime, null);
    runtime.recordModelPolicyRefusal = jest.fn();

    try {
      writeModelInputNodeAction(runtime, 'quality-gate', OK_OUTPUT_SCRIPT);
      const named = await runStep({
        executionId: 'exec-open-named',
        jobId: 'job-open',
        step: createStep({
          id: 'gate-named',
          uses: 'builtin/quality-gate',
          with: { model: BASE_MODEL, criteria: 'be good' },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });
      const unnamed = await runStep({
        executionId: 'exec-open-unnamed',
        jobId: 'job-open',
        step: createStep({
          id: 'gate-unnamed',
          uses: 'builtin/quality-gate',
          with: { criteria: 'be good' },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(named.status).toBe('success');
      expect(unnamed.status).toBe('success');
      expect(runtime.recordModelPolicyRefusal).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses builtin/git-commit-push when the org blocks its commit_model', async () => {
    // `git-commit-push` calls the Claude Agent SDK but names its model input
    // `commit_model`, so a gate that only looked for `model` let it through.
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    applyOrgModelPolicy(
      runtime,
      enforcingAccount([DEFAULT_CLAUDE_MODEL, COMMIT_RUNNER_DEFAULT_MODEL]),
    );
    runtime.recordModelPolicyRefusal = jest.fn();

    try {
      writeCommitPushAction(runtime, "throw new Error('must not launch');");
      const result = await runStep({
        executionId: 'exec-commit-policy',
        jobId: 'job-policy',
        step: createStep({
          id: 'commit',
          uses: 'builtin/git-commit-push',
          with: { commit_model: BASE_MODEL },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
        projectId: 'project-policy',
        worktreeId: 'worktree-policy',
      });

      expect(runtime.isModelBlockedByOrgPolicy).toHaveBeenCalledWith(
        BASE_MODEL,
        { projectId: 'project-policy', worktreeId: 'worktree-policy' },
      );
      expect(result.status).toBe('failure');
      expect(result.error).toContain('blocked by your organization policy');
      expect(runtime.recordModelPolicyRefusal).toHaveBeenCalledWith({
        executionId: 'exec-commit-policy',
        jobId: 'job-policy',
        stepId: 'commit',
        projectId: 'project-policy',
        worktreeId: 'worktree-policy',
        modelId: BASE_MODEL,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runs builtin/git-commit-push when the org reviewed its commit_model', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    applyOrgModelPolicy(
      runtime,
      enforcingAccount(['provider/claude-pipeline-agent-test']),
    );
    runtime.recordModelPolicyRefusal = jest.fn();

    try {
      writeCommitPushAction(
        runtime,
        reportModelInputScript('INPUT_COMMIT_MODEL', 'commit_model'),
      );
      const result = await runStep({
        executionId: 'exec-commit-allowed',
        jobId: 'job-policy',
        step: createStep({
          id: 'commit',
          uses: 'builtin/git-commit-push',
          with: { commit_model: BASE_MODEL },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('success');
      expect(result.outputs).toEqual({
        ok: 'true',
        commit_model: BASE_MODEL,
      });
      expect(runtime.recordModelPolicyRefusal).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses builtin/github-create-pr when the org blocks its pr_model', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    applyOrgModelPolicy(
      runtime,
      enforcingAccount([DEFAULT_CLAUDE_MODEL, PR_RUNNER_DEFAULT_MODEL]),
    );
    runtime.recordModelPolicyRefusal = jest.fn();

    try {
      writeCreatePrAction(runtime, "throw new Error('must not launch');");
      const result = await runStep({
        executionId: 'exec-pr-policy',
        jobId: 'job-policy',
        step: createStep({
          id: 'create-pr',
          uses: 'builtin/github-create-pr',
          with: { pr_model: BASE_MODEL },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
        projectId: 'project-policy',
        worktreeId: 'worktree-policy',
      });

      expect(runtime.isModelBlockedByOrgPolicy).toHaveBeenCalledWith(
        BASE_MODEL,
        { projectId: 'project-policy', worktreeId: 'worktree-policy' },
      );
      expect(result.status).toBe('failure');
      expect(result.error).toContain('blocked by your organization policy');
      expect(runtime.recordModelPolicyRefusal).toHaveBeenCalledWith({
        executionId: 'exec-pr-policy',
        jobId: 'job-policy',
        stepId: 'create-pr',
        projectId: 'project-policy',
        worktreeId: 'worktree-policy',
        modelId: BASE_MODEL,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses builtin/git-commit-push on the generation-model preference injected into the step env', async () => {
    // The desktop runtime injects the saved preference through
    // `buildPipelinePreferenceEnv`, so a step that names no `commit_model`
    // still runs on a user-chosen model. Reviewing the hardcoded runner
    // default here proves the preference is what got probed.
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    applyOrgModelPolicy(
      runtime,
      enforcingAccount([DEFAULT_CLAUDE_MODEL, COMMIT_RUNNER_DEFAULT_MODEL]),
    );
    runtime.recordModelPolicyRefusal = jest.fn();

    try {
      writeCommitPushAction(runtime, "throw new Error('must not launch');");
      const result = await runStep({
        executionId: 'exec-commit-pref',
        jobId: 'job-policy',
        step: createStep({ id: 'commit', uses: 'builtin/git-commit-push' }),
        cwd: tempDir,
        env: {
          [brandEnvName('PREF_COMMIT_GENERATION_MODEL')]: BASE_MODEL,
        },
        runtime,
        signal: new AbortController().signal,
      });

      expect(runtime.isModelBlockedByOrgPolicy).toHaveBeenCalledWith(
        BASE_MODEL,
        {},
      );
      expect(result.status).toBe('failure');
      expect(result.error).toContain('does not specify "commit_model"');
      expect(result.error).toContain(BASE_MODEL);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("refuses builtin/git-commit-push on the runner's hardcoded default commit model", async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    applyOrgModelPolicy(
      runtime,
      enforcingAccount([
        DEFAULT_CLAUDE_MODEL,
        'provider/claude-pipeline-agent-test',
      ]),
    );
    runtime.recordModelPolicyRefusal = jest.fn();

    try {
      writeCommitPushAction(runtime, "throw new Error('must not launch');");
      const result = await runStep({
        executionId: 'exec-commit-default',
        jobId: 'job-policy',
        step: createStep({ id: 'commit', uses: 'builtin/git-commit-push' }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(runtime.isModelBlockedByOrgPolicy).toHaveBeenCalledWith(
        COMMIT_RUNNER_DEFAULT_MODEL,
        {},
      );
      expect(result.status).toBe('failure');
      expect(result.error).toContain('does not specify "commit_model"');
      expect(result.error).toContain(COMMIT_RUNNER_DEFAULT_MODEL);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('pins the commit model it checked when an org policy is active', async () => {
    // Under an active policy the checked id must be the id that runs, so the
    // value this gate resolved is written back instead of letting the
    // subprocess recompute it from a different env.
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    applyOrgModelPolicy(
      runtime,
      enforcingAccount([
        'provider/claude-pipeline-agent-test',
        COMMIT_RUNNER_DEFAULT_MODEL,
      ]),
    );

    try {
      writeCommitPushAction(
        runtime,
        reportModelInputScript('INPUT_COMMIT_MODEL', 'commit_model'),
      );
      const fromPreference = await runStep({
        executionId: 'exec-commit-pin-pref',
        jobId: 'job-open',
        step: createStep({ id: 'commit', uses: 'builtin/git-commit-push' }),
        cwd: tempDir,
        // The baseline `INPUT_COMMIT_MODEL` is what the subprocess sees if the
        // gate does NOT pin, so the assertions below fail loudly instead of
        // matching an unset value.
        env: {
          INPUT_COMMIT_MODEL: 'baseline-input-commit-model',
          [brandEnvName('PREF_COMMIT_GENERATION_MODEL')]: BASE_MODEL,
        },
        runtime,
        signal: new AbortController().signal,
      });
      const fromRunnerDefault = await runStep({
        executionId: 'exec-commit-pin-default',
        jobId: 'job-open',
        step: createStep({ id: 'commit', uses: 'builtin/git-commit-push' }),
        cwd: tempDir,
        env: { INPUT_COMMIT_MODEL: 'baseline-input-commit-model' },
        runtime,
        signal: new AbortController().signal,
      });

      expect(fromPreference.status).toBe('success');
      expect(fromPreference.outputs).toEqual({
        ok: 'true',
        commit_model: BASE_MODEL,
      });
      expect(fromRunnerDefault.status).toBe('success');
      expect(fromRunnerDefault.outputs).toEqual({
        ok: 'true',
        commit_model: COMMIT_RUNNER_DEFAULT_MODEL,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('never pins a commit model when no org policy is active', async () => {
    // The gate mirrors the commit runner's `INPUT_* ?? PREF_* ?? default` chain
    // closely, but not exactly: it reads the preference only from the step env,
    // while the runner's env is `{...buildSafeProcessEnv(), ...options.env}`.
    // `apps/desktop-cli` never calls `buildPipelinePreferenceEnv`, so a CLI user
    // who exported the preference in their shell has it honored by the runner
    // and would get the hardcoded runner default pinned over it. Nothing may be
    // written back for a user no policy applies to.
    const unpinnedBaseline = 'baseline-input-commit-model';
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    applyOrgModelPolicy(runtime, null);

    try {
      writeCommitPushAction(
        runtime,
        reportModelInputScript('INPUT_COMMIT_MODEL', 'commit_model'),
      );
      // A preference the gate can see, so a pin would visibly rewrite the
      // baseline the subprocess would otherwise inherit.
      const withPreference = await runStep({
        executionId: 'exec-commit-open-pref',
        jobId: 'job-open',
        step: createStep({ id: 'commit', uses: 'builtin/git-commit-push' }),
        cwd: tempDir,
        env: {
          INPUT_COMMIT_MODEL: unpinnedBaseline,
          [brandEnvName('PREF_COMMIT_GENERATION_MODEL')]: BASE_MODEL,
        },
        runtime,
        signal: new AbortController().signal,
      });
      // Nothing names a model at all, so a pin would force the hardcoded
      // runner default in.
      const withoutPreference = await runStep({
        executionId: 'exec-commit-open-default',
        jobId: 'job-open',
        step: createStep({ id: 'commit', uses: 'builtin/git-commit-push' }),
        cwd: tempDir,
        env: { INPUT_COMMIT_MODEL: unpinnedBaseline },
        runtime,
        signal: new AbortController().signal,
      });
      // A step that names a pipeline alias: the gate probes the alias base, so
      // a pin would hand the runner the base instead of the raw alias id.
      const withAlias = await runStep({
        executionId: 'exec-commit-open-alias',
        jobId: 'job-open',
        step: createStep({
          id: 'commit',
          uses: 'builtin/git-commit-push',
          with: { commit_model: 'reviewed-alias' },
        }),
        cwd: tempDir,
        env: { INPUT_COMMIT_MODEL: unpinnedBaseline },
        runtime,
        modelAliases: [
          {
            id: 'reviewed-alias',
            name: 'Reviewed Alias',
            defaults: { base: BASE_MODEL },
          },
        ],
        signal: new AbortController().signal,
      });

      expect(withPreference.status).toBe('success');
      expect(withPreference.outputs).toEqual({
        ok: 'true',
        commit_model: unpinnedBaseline,
      });
      expect(withoutPreference.status).toBe('success');
      expect(withoutPreference.outputs).toEqual({
        ok: 'true',
        commit_model: unpinnedBaseline,
      });
      expect(withAlias.status).toBe('success');
      expect(withAlias.outputs).toEqual({
        ok: 'true',
        commit_model: 'reviewed-alias',
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('pins the probed default model into a step that names none when an org policy is active', async () => {
    // Probing `DEFAULT_CLAUDE_MODEL` without pinning it is a guess about what
    // the provider would have picked. The reviewed snapshot is an allowlist
    // frozen at last save, so if the CLI's own default drifts to a newer id
    // that id is unreviewed by construction and the step would have run on it
    // behind a passing probe. Pinning makes the checked id the id that runs.
    //
    // The step env seeds a baseline `INPUT_MODEL` rather than asserting the var
    // is unset: `buildSafeProcessEnv` copies `process.env` into action
    // subprocesses, so an ambient `INPUT_MODEL` could otherwise leak in.
    const unpinnedBaseline = 'baseline-input-model';
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    applyOrgModelPolicy(runtime, enforcingAccount([DEFAULT_CLAUDE_MODEL]));
    runtime.recordModelPolicyRefusal = jest.fn();

    try {
      writeAgentPromptAction(
        runtime,
        reportModelInputScript('INPUT_MODEL', 'model'),
      );
      const policed = await runStep({
        executionId: 'exec-pin-policed',
        jobId: 'job-policy',
        step: createStep({
          id: 'agent-unnamed',
          uses: 'builtin/agent-prompt',
          with: { prompt: 'hello' },
        }),
        cwd: tempDir,
        env: { INPUT_MODEL: unpinnedBaseline },
        runtime,
        signal: new AbortController().signal,
      });

      expect(runtime.isModelBlockedByOrgPolicy).toHaveBeenCalledWith(
        DEFAULT_CLAUDE_MODEL,
        {},
      );
      expect(policed.status).toBe('success');
      expect(policed.outputs).toEqual({
        ok: 'true',
        model: DEFAULT_CLAUDE_MODEL,
      });
      expect(runtime.recordModelPolicyRefusal).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('never pins a model into a step that names none when no org policy is active', async () => {
    // The critical regression guard for the pin above: with no policy active,
    // an unnamed-model step must resolve byte-identically to its pre-gate
    // behavior. Pinning here would silently force `DEFAULT_CLAUDE_MODEL` onto
    // every unnamed-model pipeline step for every unpoliced user.
    const unpinnedBaseline = 'baseline-input-model';
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    applyOrgModelPolicy(runtime, null);
    runtime.recordModelPolicyRefusal = jest.fn();

    try {
      writeAgentPromptAction(
        runtime,
        reportModelInputScript('INPUT_MODEL', 'model'),
      );
      const unpoliced = await runStep({
        executionId: 'exec-no-pin-open',
        jobId: 'job-open',
        step: createStep({
          id: 'agent-unnamed',
          uses: 'builtin/agent-prompt',
          with: { prompt: 'hello' },
        }),
        cwd: tempDir,
        env: { INPUT_MODEL: unpinnedBaseline },
        runtime,
        signal: new AbortController().signal,
      });

      expect(unpoliced.status).toBe('success');
      expect(unpoliced.outputs).toEqual({
        ok: 'true',
        model: unpinnedBaseline,
      });
      expect(runtime.recordModelPolicyRefusal).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('pins the probed default model into a builtin/agent-resume step that names none when an org policy is active', async () => {
    // `builtin/agent-resume` declares an optional `model`, and its runner has a
    // dedicated no-model branch (`actionMode === 'resume' && !env.INPUT_MODEL`
    // in `builtin-actions/agent-prompt/runner.ts`) that resumes the Claude
    // session without sending a model, so the thread continues on whatever
    // model it was started with — an id this gate never saw. Pinning under an
    // active policy deliberately overrides that branch so the resumed turn runs
    // on the checked id; the session id still reaches the runner, so it is
    // still a resume, and the pinned id is visible in `agent_model`.
    const unpinnedBaseline = 'baseline-input-model';
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    applyOrgModelPolicy(runtime, enforcingAccount([DEFAULT_CLAUDE_MODEL]));
    runtime.recordModelPolicyRefusal = jest.fn();

    try {
      writeAgentResumeAction(
        runtime,
        reportInputsScript([
          { envKey: 'INPUT_MODEL', outputKey: 'model' },
          { envKey: 'INPUT_SESSION_ID', outputKey: 'session_id' },
        ]),
      );
      const policed = await runStep({
        executionId: 'exec-resume-pin-policed',
        jobId: 'job-policy',
        step: createStep({
          id: 'resume',
          uses: 'builtin/agent-resume',
          with: { session_id: 'session-1', prompt: 'keep going' },
        }),
        cwd: tempDir,
        env: { INPUT_MODEL: unpinnedBaseline },
        runtime,
        signal: new AbortController().signal,
      });

      expect(runtime.isModelBlockedByOrgPolicy).toHaveBeenCalledWith(
        DEFAULT_CLAUDE_MODEL,
        {},
      );
      expect(policed.status).toBe('success');
      expect(policed.outputs).toEqual({
        ok: 'true',
        model: DEFAULT_CLAUDE_MODEL,
        session_id: 'session-1',
      });
      expect(policed.agent_model).toBe(DEFAULT_CLAUDE_MODEL);
      expect(runtime.recordModelPolicyRefusal).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('never pins a model into a builtin/agent-resume step that names none when no org policy is active', async () => {
    // Without a policy the runner's no-model resume branch must keep working:
    // no `INPUT_MODEL` may be introduced, so the resumed session continues on
    // its own model exactly as it did before the gate existed.
    const unpinnedBaseline = 'baseline-input-model';
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    applyOrgModelPolicy(runtime, null);
    runtime.recordModelPolicyRefusal = jest.fn();

    try {
      writeAgentResumeAction(
        runtime,
        reportInputsScript([
          { envKey: 'INPUT_MODEL', outputKey: 'model' },
          { envKey: 'INPUT_SESSION_ID', outputKey: 'session_id' },
        ]),
      );
      const unpoliced = await runStep({
        executionId: 'exec-resume-pin-open',
        jobId: 'job-open',
        step: createStep({
          id: 'resume',
          uses: 'builtin/agent-resume',
          with: { session_id: 'session-1', prompt: 'keep going' },
        }),
        cwd: tempDir,
        env: { INPUT_MODEL: unpinnedBaseline },
        runtime,
        signal: new AbortController().signal,
      });

      expect(unpoliced.status).toBe('success');
      expect(unpoliced.outputs).toEqual({
        ok: 'true',
        model: unpinnedBaseline,
        session_id: 'session-1',
      });
      expect(runtime.recordModelPolicyRefusal).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses rather than pins when an active org policy has not reviewed the default model', async () => {
    // The pin must never become a way to run an unreviewed id: the refusal is
    // evaluated first, so an active policy that omits `DEFAULT_CLAUDE_MODEL`
    // still fails the step instead of pinning it in.
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    applyOrgModelPolicy(
      runtime,
      enforcingAccount(['provider/claude-pipeline-agent-test']),
    );
    runtime.recordModelPolicyRefusal = jest.fn();

    try {
      writeAgentPromptAction(
        runtime,
        reportModelInputScript('INPUT_MODEL', 'model'),
      );
      const result = await runStep({
        executionId: 'exec-pin-refused',
        jobId: 'job-policy',
        step: createStep({
          id: 'agent-unnamed',
          uses: 'builtin/agent-prompt',
          with: { prompt: 'hello' },
        }),
        cwd: tempDir,
        env: { INPUT_MODEL: 'baseline-input-model' },
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('failure');
      expect(result.error).toContain('does not specify a model');
      expect(result.error).toContain(DEFAULT_CLAUDE_MODEL);
      expect(result.outputs ?? {}).toEqual({});
      expect(runtime.recordModelPolicyRefusal).toHaveBeenCalledWith({
        executionId: 'exec-pin-refused',
        jobId: 'job-policy',
        stepId: 'agent-unnamed',
        modelId: DEFAULT_CLAUDE_MODEL,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('resolves a pipeline model alias before probing a composite step', async () => {
    // Composite actions forward `model: ${{ inputs.model }}` to a nested
    // `builtin/agent-prompt`, and they are not in `MODEL_AWARE_AGENT_ACTIONS`,
    // so the outer gate used to probe the raw alias id. `resolveModelAlias`
    // only knows the global registry, so the alias id missed the reviewed
    // snapshot and refused even though the org approved its base model.
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    applyOrgModelPolicy(
      runtime,
      enforcingAccount(['provider/claude-pipeline-agent-test']),
    );
    runtime.recordModelPolicyRefusal = jest.fn();

    try {
      writeAgentPromptAction(runtime, OK_OUTPUT_SCRIPT);
      const compositeDir = path.join(
        runtime.bundledActionsDir,
        'alias-composite',
      );
      fs.mkdirSync(compositeDir, { recursive: true });
      fs.writeFileSync(
        path.join(compositeDir, 'action.yml'),
        [
          'name: Alias Composite',
          'inputs:',
          '  model:',
          '    description: Model forwarded to the nested agent step.',
          '    required: false',
          'outputs: {}',
          'runs:',
          '  using: composite',
          '  steps:',
          '    - id: agent',
          '      uses: builtin/agent-prompt',
          '      with:',
          '        model: ${{ inputs.model }}',
        ].join('\n'),
        'utf8',
      );

      const result = await runStep({
        executionId: 'exec-composite-alias',
        jobId: 'job-policy',
        step: createStep({
          id: 'composite',
          uses: 'builtin/alias-composite',
          with: { model: 'reviewed-alias' },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        modelAliases: [
          {
            id: 'reviewed-alias',
            name: 'Reviewed Alias',
            defaults: { base: BASE_MODEL },
          },
        ],
        signal: new AbortController().signal,
      });

      expect(runtime.isModelBlockedByOrgPolicy).toHaveBeenCalledWith(
        BASE_MODEL,
        {},
      );
      expect(runtime.isModelBlockedByOrgPolicy).not.toHaveBeenCalledWith(
        'reviewed-alias',
        expect.any(Object),
      );
      expect(result.status).toBe('success');
      expect(runtime.recordModelPolicyRefusal).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('turns a classified agent failure sidecar into a durable recovery checkpoint', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);

    try {
      writeAgentPromptAction(runtime, recoverableAgentFailureScript());

      const result = await runStep({
        executionId: 'exec-recovery',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: { model: BASE_MODEL },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: 'paused',
        pause_reason: {
          kind: 'provider_usage_limit',
          code: 'rate_limit',
          provider: 'claude',
          account_scope: 'native',
        },
        agent_recovery: {
          version: 2,
          provider: 'claude',
          harness: 'claude',
          session_id: 'session-partial',
          had_agent_activity: true,
          strategy: 'continue_session',
        },
      });
      expect(result.outputs).not.toHaveProperty('agent_failure_metadata_file');
      const durableTranscript = result.agent_recovery?.transcript_file;
      expect(durableTranscript).toContain(
        path.join(runtime.executionsDir, 'exec-recovery', 'recovery'),
      );
      expect(durableTranscript && fs.existsSync(durableTranscript)).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('pauses composite actions when a nested agent needs recovery', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    const skippedFile = path.join(tempDir, 'should-not-run.txt');

    try {
      writeAgentPromptAction(runtime, recoverableAgentFailureScript());
      const compositeDir = path.join(
        runtime.bundledActionsDir,
        'recoverable-composite',
      );
      fs.mkdirSync(compositeDir, { recursive: true });
      fs.writeFileSync(
        path.join(compositeDir, 'action.yml'),
        [
          'name: Recoverable Composite',
          'outputs: {}',
          'runs:',
          '  using: composite',
          '  steps:',
          '    - id: agent',
          '      uses: builtin/agent-prompt',
          '      with:',
          `        model: ${BASE_MODEL}`,
          '    - id: after',
          `      run: echo "unexpected" > "${skippedFile}"`,
        ].join('\n'),
        'utf8',
      );

      const result = await runStep({
        executionId: 'exec-composite-recovery',
        jobId: 'job-1',
        step: createStep({
          id: 'composite',
          uses: 'builtin/recoverable-composite',
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: 'paused',
        pause_reason: {
          kind: 'provider_usage_limit',
          source: { step_id: 'composite' },
        },
        agent_recovery: {
          version: 2,
          provider: 'claude',
          harness: 'claude',
          had_agent_activity: false,
          strategy: 'restart_step',
        },
      });
      expect(result.agent_recovery).not.toHaveProperty('session_id');
      expect(result.pause_reasons).toEqual([result.pause_reason]);
      expect(fs.existsSync(skippedFile)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not apply a composite recovery harness to earlier siblings', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    const runCodexPrompt = jest.fn(
      (): Promise<CodexPromptRunnerResult> =>
        Promise.resolve({
          status: 'success',
          sessionId: 'codex-thread',
          rawText: 'ok',
          transcript: '',
          finalText: 'ok',
          usage: {},
        }),
    );
    runtime.codexPromptRunner = { runCodexPrompt };
    try {
      writeAgentPromptAction(runtime, '');
      const compositeDir = path.join(
        runtime.bundledActionsDir,
        'mixed-harness-recovery',
      );
      fs.mkdirSync(compositeDir, { recursive: true });
      fs.writeFileSync(
        path.join(compositeDir, 'action.yml'),
        [
          'name: Mixed Harness Recovery',
          'outputs: {}',
          'runs:',
          '  using: composite',
          '  steps:',
          '    - id: claude_child',
          '      uses: builtin/agent-prompt',
          '      with:',
          `        model: ${BASE_MODEL}`,
          '        prompt: first',
          '    - id: codex_child',
          '      uses: builtin/agent-prompt',
          '      with:',
          '        model: gpt-6-sol',
          '        prompt: second',
        ].join('\n'),
        'utf8',
      );

      const result = await runStep({
        executionId: 'exec-mixed-harness-recovery',
        jobId: 'job-1',
        step: createStep({
          id: 'composite',
          uses: 'builtin/mixed-harness-recovery',
        }),
        cwd: tempDir,
        env: {},
        runtime,
        recoveryCheckpoint: {
          version: 2,
          reason_id: '11111111-1111-4111-8111-111111111111',
          action: 'agent-prompt',
          provider: 'codex',
          harness: 'codex',
          had_agent_activity: false,
          strategy: 'restart_step',
          recovery_count: 1,
          paused_at: '2026-08-20T00:00:00.000Z',
          failure_message: 'later child paused',
        },
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('success');
      expect(runCodexPrompt).toHaveBeenCalledTimes(1);
      expect(runCodexPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-6-sol' }),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('redacts the persisted error on a recoverable agent failure', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);

    try {
      writeAgentPromptAction(
        runtime,
        [
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          'const outputDir = path.dirname(process.env.CANOPY_OUTPUT);',
          'const metadata = {',
          '  version: 1,',
          "  provider: 'claude',",
          '  had_agent_activity: false,',
          '  classification: {',
          "    kind: 'provider_usage_limit',",
          "    code: 'rate_limit',",
          "    provider: 'claude',",
          "    account_scope: 'native',",
          "    diagnostic_message: 'Authorization: Bearer abcdef.ghijkl',",
          '  },',
          "  message: 'Authorization: Bearer abcdef.ghijkl',",
          '};',
          "const metadataFile = path.join(outputDir, 'agent-failure.json');",
          'fs.writeFileSync(metadataFile, JSON.stringify(metadata));',
          'fs.appendFileSync(process.env.CANOPY_OUTPUT, `agent_failure_metadata_file=${metadataFile}\\n`);',
          'process.exitCode = 1;',
        ].join('\n'),
      );

      const result = await runStep({
        executionId: 'exec-redacted-recovery',
        jobId: 'job-1',
        step: createStep({ id: 'agent-step', uses: 'builtin/agent-prompt' }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('paused');
      expect(result.error).toBe('Authorization: <redacted>');
      expect(result.error).not.toContain('abcdef.ghijkl');
      expect(result.outputs).not.toHaveProperty('agent_failure_metadata_file');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects malformed recovery metadata and never exposes internal outputs', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);

    try {
      writeAgentPromptAction(
        runtime,
        [
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          'const outputDir = path.dirname(process.env.CANOPY_OUTPUT);',
          "const transcriptFile = path.join(outputDir, 'transcript.jsonl');",
          "fs.writeFileSync(transcriptFile, '');",
          'const metadata = {',
          '  version: 1,',
          "  provider: 'claude',",
          '  session_id: 42,',
          '  transcript_file: false,',
          '  had_agent_activity: false,',
          '  classification: {',
          "    kind: 'provider_usage_limit',",
          "    code: 'rate_limit',",
          "    provider: 'claude',",
          "    account_scope: 'native',",
          '    diagnostic_message: null,',
          '  },',
          "  message: 'usage exhausted',",
          '};',
          "const metadataFile = path.join(outputDir, 'agent-failure.json');",
          'fs.writeFileSync(metadataFile, JSON.stringify(metadata));',
          'fs.appendFileSync(process.env.CANOPY_OUTPUT, `agent_failure_metadata_file=${metadataFile}\\nagent_failure_transcript_file=${transcriptFile}\\npublic_value=kept\\n`);',
          'process.exitCode = 1;',
        ].join('\n'),
      );

      const result = await runStep({
        executionId: 'exec-malformed-recovery',
        jobId: 'job-1',
        step: createStep({ id: 'agent-step', uses: 'builtin/agent-prompt' }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('failure');
      expect(result.outputs).toEqual({ public_value: 'kept' });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('never exposes internal outputs from non-recoverable worker failures', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    runtime.agentPromptWorker = {
      runAgentPrompt: (): Promise<AgentPromptWorkerResult> =>
        Promise.resolve({
          status: 'failure',
          workerId: 'worker-failure',
          transcript: 'Provider rejected the request.',
          failure: {
            version: 1,
            provider: 'claude',
            had_agent_activity: false,
            message: 'Provider rejected the request.',
          },
        }),
    };

    try {
      writeAgentPromptAction(runtime, 'process.exitCode = 1;');
      const result = await runStep({
        executionId: 'exec-worker-failure',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: { model: BASE_MODEL },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
        agentTerminalMode: true,
      });

      expect(result.status).toBe('failure');
      expect(result.outputs).toEqual({});
      expect(result.outputs).not.toHaveProperty('agent_failure_metadata_file');
      expect(result.outputs).not.toHaveProperty(
        'agent_failure_transcript_file',
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('redacts a multi-line secret from the in-process Claude worker transcript even though it arrives as JSON-serialized JSONL', async () => {
    // Independent-review regression: the Claude in-process worker's
    // `result.transcript` is itself `JSON.stringify`'d JSONL built by
    // `normalizeClaudeTerminalTranscriptToSdkJsonl`/`serializeTranscript`
    // upstream — exactly like the Codex/Cursor host-runner interceptors'
    // transcript lines this same round already fixed. A multi-line secret's
    // own newlines only ever reach `maybeRunAgentPromptWorker`'s redaction
    // as an escaped `\n` two-character sequence, which the plain
    // (unescaped) value list could never exact-match.
    const secret = 'BEGIN-FAKE-KEY\nline2-abcdef\nEND-FAKE-KEY';
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    const event = {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: `Here it is:\n${secret}\ndone.` }],
      },
    };
    runtime.agentPromptWorker = {
      runAgentPrompt: (): Promise<AgentPromptWorkerResult> =>
        Promise.resolve({
          status: 'success',
          workerId: 'worker-json-escaped-secret',
          sessionId: 'session-json-escaped-secret',
          rawText: 'done',
          transcript: `${JSON.stringify(event)}\n`,
        }),
    };

    try {
      writeAgentPromptAction(runtime, 'process.exitCode = 1;');
      const result = await runStep({
        executionId: 'exec-worker-json-escaped-secret',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: { model: BASE_MODEL, prompt: 'continue' },
        }),
        cwd: tempDir,
        env: {},
        secretEnv: { MY_MULTILINE_SECRET: secret },
        runtime,
        signal: new AbortController().signal,
        agentTerminalMode: true,
      });

      expect(result.status).toBe('success');
      const transcriptContent = fs.readFileSync(
        result.outputs.transcript_file,
        'utf8',
      );
      expect(transcriptContent).not.toContain('BEGIN-FAKE-KEY');
      expect(transcriptContent).not.toContain('line2-abcdef');
      expect(transcriptContent).not.toContain('END-FAKE-KEY');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each(['success', 'failure', 'cancelled'] as const)(
    'preserves organization gateway provenance on %s terminal-worker results',
    async (status) => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
      );
      const runtime = createRuntime(tempDir);
      runtime.resolveAiCreditsRouting = jest.fn(() =>
        Promise.resolve({
          provider: 'claude' as const,
          model: BASE_MODEL,
          modelGatewayRouted: true,
          env: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
        }),
      );
      runtime.agentPromptWorker = {
        runAgentPrompt: (): Promise<AgentPromptWorkerResult> => {
          if (status === 'success') {
            return Promise.resolve({
              status,
              workerId: 'worker-gateway-provenance',
              sessionId: 'session-gateway-provenance',
              rawText: 'done',
              transcript: '',
            });
          }
          return Promise.resolve({
            status,
            workerId: 'worker-gateway-provenance',
            transcript: '',
            failure: {
              version: 1,
              provider: 'claude',
              had_agent_activity: false,
              message: `Worker ${status}.`,
            },
          });
        },
      };

      try {
        writeAgentPromptAction(runtime, 'process.exitCode = 1;');
        const result = await runStep({
          executionId: `exec-worker-gateway-${status}`,
          jobId: 'job-1',
          step: createStep({
            id: 'agent-step',
            uses: 'builtin/agent-prompt',
            with: { model: BASE_MODEL, prompt: 'continue' },
          }),
          cwd: tempDir,
          env: {},
          runtime,
          signal: new AbortController().signal,
          agentTerminalMode: true,
        });

        expect(result.status).toBe(status);
        expect(result.outputs[AI_CREDITS_ROUTED_OUTPUT_KEY]).toBe('true');
        expect(result.outputs[MODEL_GATEWAY_ROUTED_OUTPUT_KEY]).toBe('true');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ['none', 'auto', undefined],
    ['read_only', 'auto', undefined],
    ['plan', 'auto', undefined],
    ['dangerous_all', 'full-access', true],
  ] as const)(
    'uses %s worker permissions with %s approval handling',
    async (
      permissionPreset,
      expectedApprovalMode,
      expectedDangerousPermissionSkip,
    ) => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
      );
      const runtime = createRuntime(tempDir);
      const runAgentPrompt = jest.fn<
        Promise<AgentPromptWorkerResult>,
        [AgentPromptWorkerRequest]
      >((request): Promise<AgentPromptWorkerResult> => {
        void request;
        return Promise.resolve({
          status: 'success',
          workerId: 'worker-success',
          sessionId: 'session-success',
          rawText: 'done',
          transcript: '',
        });
      });
      runtime.agentPromptWorker = { runAgentPrompt };

      try {
        writeAgentPromptAction(runtime, 'process.exitCode = 1;');
        const result = await runStep({
          executionId: `exec-worker-${permissionPreset}`,
          jobId: 'job-1',
          step: createStep({
            id: 'agent-step',
            uses: 'builtin/agent-prompt',
            with: {
              model: BASE_MODEL,
              prompt: 'Review the change.',
              permission_preset: permissionPreset,
            },
          }),
          cwd: tempDir,
          env: {},
          runtime,
          signal: new AbortController().signal,
          agentTerminalMode: true,
        });

        expect(result.status).toBe('success');
        const workerInput = runAgentPrompt.mock.calls[0]?.[0];
        expect(workerInput?.approvalMode).toBe(expectedApprovalMode);
        expect(workerInput?.permission?.allowDangerouslySkipPermissions).toBe(
          expectedDangerousPermissionSkip,
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it.each(['success', 'failure'] as const)(
    'redacts AI Credits tokens from %s terminal-worker transcripts',
    async (status) => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
      );
      const runtime = createRuntime(tempDir);
      const token = 'terminal-worker-secret-token\n"quoted"\\path';
      const serializedToken = JSON.stringify(token).slice(1, -1);
      // The real Claude in-process worker's transcript is always
      // `JSON.stringify`'d JSONL built by
      // `normalizeClaudeTerminalTranscriptToSdkJsonl`/`serializeTranscript`
      // (`claude-worker-session-service.ts`), never raw plain text — a
      // multi-line token's own newline is always JSON-escaped, never a
      // real newline splitting the transcript into multiple physical
      // lines. This mock reflects that real shape.
      const transcriptLine = (label: string): string =>
        `${JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: `${label} ${token}` }] },
        })}\n`;
      const resolveAiCreditsRouting = jest.fn<
        ReturnType<ResolveAiCreditsRouting>,
        Parameters<ResolveAiCreditsRouting>
      >(() =>
        Promise.resolve({
          provider: 'claude',
          model: BASE_MODEL,
          env: { ANTHROPIC_AUTH_TOKEN: token },
        }),
      );
      runtime.resolveAiCreditsRouting = resolveAiCreditsRouting;
      runtime.agentPromptWorker = {
        runAgentPrompt: (): Promise<AgentPromptWorkerResult> =>
          status === 'success'
            ? Promise.resolve({
                status: 'success',
                workerId: 'worker-secret',
                sessionId: 'session-secret',
                rawText: `completed ${token}`,
                transcript: transcriptLine('tool output:'),
                structured: { result: token },
                proposedPlan: `plan with ${token}`,
                projectedMessages: [
                  {
                    id: 'message-secret',
                    role: 'assistant',
                    timestamp: Date.now(),
                    blocks: [{ type: 'text', text: token }],
                  },
                ],
              })
            : Promise.resolve({
                status: 'failure',
                workerId: 'worker-secret',
                transcript: transcriptLine('tool failure:'),
                failure: {
                  version: 1,
                  provider: 'claude',
                  had_agent_activity: true,
                  message: 'Worker failed safely.',
                },
              }),
      };
      const onStepOutput = jest.fn<void, [StepOutputEvent]>();

      try {
        writeAgentPromptAction(runtime, 'process.exitCode = 1;');
        const result = await runStep({
          executionId: `exec-worker-secret-${status}`,
          jobId: 'job-1',
          step: createStep({
            id: 'agent-step',
            uses: 'builtin/agent-prompt',
            with: { model: BASE_MODEL, prompt: 'inspect environment' },
          }),
          cwd: tempDir,
          env: {},
          runtime,
          signal: new AbortController().signal,
          agentTerminalMode: true,
          onStepOutput,
        });

        if (!result.log_file) throw new Error('Expected a persisted step log');
        const persistedTranscript = fs.readFileSync(result.log_file, 'utf8');
        expect(resolveAiCreditsRouting).toHaveBeenCalledWith(
          BASE_MODEL,
          'claude',
          {
            signal: expectedRoutingSignal,
            checkpointProxyQuota: true,
            allowNoNativeAuthFallback: true,
            routeSessionId: `pipeline:exec-worker-secret-${status}:job-1:agent-step:1:1:0`,
          },
        );
        const emittedOutput = onStepOutput.mock.calls
          .map(([event]) => event.data)
          .join('');
        expect(persistedTranscript).toContain('***');
        expect(persistedTranscript).not.toContain(token);
        expect(emittedOutput).not.toContain(token);
        expect(emittedOutput).not.toContain(serializedToken);
        if (status === 'success') {
          const persistedOutputs = [
            result.outputs.text_response,
            result.outputs.json_response,
            fs.readFileSync(result.outputs.text_response_file, 'utf8'),
            fs.readFileSync(result.outputs.json_response_file, 'utf8'),
            fs.readFileSync(result.outputs.proposed_plan_file, 'utf8'),
          ].join('\n');
          expect(persistedOutputs).toContain('***');
          expect(persistedOutputs).not.toContain(token);
          expect(persistedOutputs).not.toContain(serializedToken);
        }
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it('runs inline aliases with step and alias plugin collection union plus diagnostics', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const previousDataDir = process.env.CANOPY_DATA_DIR;
    const runtime = createRuntime(tempDir);
    const selectedModelEnv = brandEnvName('PIPELINE_SELECTED_MODEL');
    const runtimeModelEnv = brandEnvName('PIPELINE_RUNTIME_MODEL');
    const aliasEnv = brandEnvName('PIPELINE_MODEL_ALIAS');
    const aliasCollectionsEnv = brandEnvName(
      'PIPELINE_MODEL_ALIAS_PLUGIN_COLLECTION_IDS',
    );
    const claudePluginsEnv = brandEnvName('CLAUDE_SDK_PLUGINS');

    try {
      process.env.CANOPY_DATA_DIR = path.join(tempDir, 'data');
      resetResolvedCanopyDataDirForTests();
      for (const skillName of ['step-tool', 'alias-tool']) {
        const skillDir = path.join(
          process.env.CANOPY_DATA_DIR,
          'skills',
          'local-source',
          skillName,
        );
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${skillName}\n`);
      }
      writeAgentPromptAction(
        runtime,
        [
          "const fs = require('node:fs');",
          `const pluginPaths = JSON.parse(process.env[${JSON.stringify(claudePluginsEnv)}] ?? '[]');`,
          'const out = process.env.CANOPY_OUTPUT;',
          "fs.appendFileSync(out, `input_model=${process.env.INPUT_MODEL ?? ''}\\n`);",
          `fs.appendFileSync(out, \`selected_model=\${process.env[${JSON.stringify(selectedModelEnv)}] ?? ''}\\n\`);`,
          `fs.appendFileSync(out, \`runtime_model=\${process.env[${JSON.stringify(runtimeModelEnv)}] ?? ''}\\n\`);`,
          `fs.appendFileSync(out, \`alias=\${process.env[${JSON.stringify(aliasEnv)}] ?? ''}\\n\`);`,
          `fs.appendFileSync(out, \`alias_collections=\${process.env[${JSON.stringify(aliasCollectionsEnv)}] ?? ''}\\n\`);`,
          'fs.appendFileSync(out, `plugin_count=${pluginPaths.length}\\n`);',
        ].join('\n'),
      );

      const result = await runStep({
        executionId: 'exec-1',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: {
            model: 'reviewer',
            plugin_collection_id: 'step-tools',
          },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
        modelAliases: [
          {
            id: 'reviewer',
            name: 'Reviewer',
            defaults: {
              base: BASE_MODEL,
              plugin_collection_id: 'alias-tools',
            },
          },
        ],
        resolvedPluginCollections: {
          'step-tools': {
            selections: {
              collectionIds: [],
              skillRefs: [{ sourceId: 'local-source', skillName: 'step-tool' }],
              pluginRefs: [],
            },
            missingOptionalDefaults: [],
            unresolvedRequiredDefaults: [],
          },
          'alias-tools': {
            selections: {
              collectionIds: [],
              skillRefs: [
                { sourceId: 'local-source', skillName: 'alias-tool' },
              ],
              pluginRefs: [],
            },
            missingOptionalDefaults: [],
            unresolvedRequiredDefaults: [],
          },
        },
      });

      expect(result.status).toBe('success');
      expect(result.outputs.input_model).toBe(BASE_MODEL);
      expect(result.outputs.selected_model).toBe('reviewer');
      expect(result.outputs.runtime_model).toBe(BASE_MODEL);
      expect(result.outputs.alias).toBe('reviewer');
      expect(result.outputs.alias_collections).toBe('alias-tools');
      expect(Number(result.outputs.plugin_count)).toBeGreaterThan(0);
      expect(result.model_alias).toBe('reviewer');
      expect(result.model_alias_name).toBe('Reviewer');
      expect(result.model_alias_plugin_collection_ids).toEqual(['alias-tools']);
    } finally {
      if (previousDataDir === undefined) {
        delete process.env.CANOPY_DATA_DIR;
      } else {
        process.env.CANOPY_DATA_DIR = previousDataDir;
      }
      resetResolvedCanopyDataDirForTests();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('passes resolved model, prompt, plugin env, and AI Credits base model to action execution', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const previousDataDir = process.env.CANOPY_DATA_DIR;
    const runtime = createRuntime(tempDir);
    const resolveAiCreditsRouting = jest.fn<
      ReturnType<ResolveAiCreditsRouting>,
      Parameters<ResolveAiCreditsRouting>
    >((model, provider) =>
      Promise.resolve({
        provider,
        model: `gateway-${model}`,
        modelGatewayRouted: true,
        env: {
          ANTHROPIC_BASE_URL: 'https://cloud.example.com/ai-credits',
          ANTHROPIC_AUTH_TOKEN: 'secret-token',
        },
      }),
    );
    runtime.resolveAiCreditsRouting = resolveAiCreditsRouting;
    const claudePluginsEnv = brandEnvName('CLAUDE_SDK_PLUGINS');
    const aiCreditsModelEnv = brandEnvName('AI_CREDITS_MODEL');
    const thinkingLevelsEnv = brandEnvName('MODEL_THINKING_LEVELS');

    try {
      process.env.CANOPY_DATA_DIR = path.join(tempDir, 'data');
      resetResolvedCanopyDataDirForTests();
      const skillDir = path.join(
        process.env.CANOPY_DATA_DIR,
        'skills',
        'local-source',
        'review',
      );
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# review\n', 'utf8');
      runtime.resolvePipelineAgentModelAlias = jest.fn((agentId) =>
        Promise.resolve({
          agentId,
          name: 'Pipeline Reviewer',
          base: BASE_MODEL,
          instructions: 'Review pipeline output.',
          pluginSelections: {
            collectionIds: [],
            skillRefs: [{ sourceId: 'local-source', skillName: 'review' }],
            pluginRefs: [],
          },
        }),
      );
      writeAgentPromptAction(
        runtime,
        [
          "const fs = require('node:fs');",
          `const pluginPaths = JSON.parse(process.env[${JSON.stringify(claudePluginsEnv)}] ?? '[]');`,
          'const out = process.env.CANOPY_OUTPUT;',
          "fs.appendFileSync(out, `input_model=${process.env.INPUT_MODEL ?? ''}\\n`);",
          "fs.appendFileSync(out, `input_system_prompt_b64=${Buffer.from(process.env.INPUT_SYSTEM_PROMPT ?? '', 'utf8').toString('base64')}\\n`);",
          'fs.appendFileSync(out, `plugin_count=${pluginPaths.length}\\n`);',
          `fs.appendFileSync(out, \`ai_model=\${process.env[${JSON.stringify(aiCreditsModelEnv)}] ?? ''}\\n\`);`,
          "fs.appendFileSync(out, `ai_base_url=${process.env.ANTHROPIC_BASE_URL ?? ''}\\n`);",
          "fs.appendFileSync(out, `ai_token=${process.env.ANTHROPIC_AUTH_TOKEN ?? ''}\\n`);",
          `fs.appendFileSync(out, \`thinking_levels=\${process.env[${JSON.stringify(thinkingLevelsEnv)}] ?? ''}\\n\`);`,
        ].join('\n'),
      );

      const result = await runStep({
        executionId: 'exec-1',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: inputValues({ model: 'reviewer' }),
        }),
        cwd: tempDir,
        env: {
          ANTHROPIC_BASE_URL: 'https://attacker.example.com',
          ANTHROPIC_AUTH_TOKEN: 'pipeline-token',
        },
        runtime,
        signal: new AbortController().signal,
        modelAliases: [
          {
            id: 'reviewer',
            name: 'Reviewer',
            defaults: { agent_id: 'agent_model_pipeline_reviewer' },
          },
        ],
      });

      expect(result.status).toBe('success');
      expect(runtime.resolvePipelineAgentModelAlias).toHaveBeenCalledWith(
        'agent_model_pipeline_reviewer',
        {},
      );
      expect(resolveAiCreditsRouting).toHaveBeenCalledWith(
        BASE_MODEL,
        'claude',
        {
          signal: expectedRoutingSignal,
          checkpointProxyQuota: true,
          allowNoNativeAuthFallback: true,
          routeSessionId: 'pipeline:exec-1:job-1:agent-step:1:1:0',
        },
      );
      expect(result.outputs.input_model).toBe(BASE_MODEL);
      expect(
        Buffer.from(result.outputs.input_system_prompt_b64, 'base64').toString(
          'utf8',
        ),
      ).toBe(
        'Existing prompt.\n\nYou are now a user defined agent with these additional instructions: Review pipeline output.',
      );
      expect(Number(result.outputs.plugin_count)).toBeGreaterThan(0);
      expect(result.outputs.ai_model).toBe(`gateway-${BASE_MODEL}`);
      expect(result.outputs.ai_base_url).toBe(
        'https://cloud.example.com/ai-credits',
      );
      expect(result.outputs.ai_token).toBe('secret-token');
      expect(result.outputs[MODEL_GATEWAY_ROUTED_OUTPUT_KEY]).toBe('true');
      expect(JSON.parse(result.outputs.thinking_levels)).toMatchObject({
        [BASE_MODEL]: ['low', 'medium'],
      });
    } finally {
      if (previousDataDir === undefined) {
        delete process.env.CANOPY_DATA_DIR;
      } else {
        process.env.CANOPY_DATA_DIR = previousDataDir;
      }
      resetResolvedCanopyDataDirForTests();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['agent-prompt', writeAgentPromptAction],
    ['agent-resume', writeAgentResumeAction],
  ] as const)(
    'fails closed through the routing bridge for a model-less builtin/%s step',
    async (actionName, writeAction) => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
      );
      const runtime = createRuntime(tempDir);
      writeAction(runtime, OK_OUTPUT_SCRIPT);
      const resolveAiCreditsRouting = jest.fn(() =>
        Promise.reject(new Error('Organization gateway route required.')),
      );
      runtime.resolveAiCreditsRouting = resolveAiCreditsRouting;

      try {
        const result = await runStep({
          executionId: `exec-model-less-${actionName}`,
          jobId: 'job-1',
          step: createStep({
            id: 'agent-step',
            uses: `builtin/${actionName}`,
            with:
              actionName === 'agent-resume'
                ? { session_id: 'session-1', prompt: 'continue' }
                : { prompt: 'continue' },
          }),
          cwd: tempDir,
          env: {},
          runtime,
          signal: new AbortController().signal,
        });

        expect(result.status).toBe('failure');
        expect(result.error).toContain('Organization gateway route required.');
        expect(resolveAiCreditsRouting).toHaveBeenCalledWith(
          DEFAULT_CLAUDE_MODEL,
          'claude',
          {
            signal: expectedRoutingSignal,
            checkpointProxyQuota: true,
            allowNoNativeAuthFallback: true,
            routeSessionId: `pipeline:exec-model-less-${actionName}:job-1:agent-step:1:1:0`,
          },
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    'agent-loop',
    'plan-with-review',
    'quality-gate',
    'router',
  ] as const)(
    'fails closed through the routing bridge for builtin/%s',
    async (actionName) => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
      );
      const runtime = createRuntime(tempDir);
      writeModelInputNodeAction(runtime, actionName, OK_OUTPUT_SCRIPT);
      const resolveAiCreditsRouting = jest.fn(() =>
        Promise.reject(new Error('Organization gateway route required.')),
      );
      runtime.resolveAiCreditsRouting = resolveAiCreditsRouting;

      try {
        const result = await runStep({
          executionId: `exec-direct-provider-${actionName}`,
          jobId: 'job-1',
          step: createStep({
            id: 'agent-step',
            uses: `builtin/${actionName}`,
            with: { model: BASE_MODEL, criteria: 'review' },
          }),
          cwd: tempDir,
          env: {},
          runtime,
          signal: new AbortController().signal,
        });

        expect(result.status).toBe('failure');
        expect(result.error).toContain('Organization gateway route required.');
        expect(resolveAiCreditsRouting).toHaveBeenCalledWith(
          BASE_MODEL,
          'claude',
          {
            signal: expectedRoutingSignal,
            allowNoNativeAuthFallback: true,
            routeSessionId: `pipeline:exec-direct-provider-${actionName}:job-1:agent-step:1:1:0`,
          },
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it('owns and releases a non-terminal direct-Claude gateway route', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const releaseAiCreditsRouting = jest.fn(() => Promise.resolve());
    const runtime = Object.assign(createRuntime(tempDir), {
      releaseAiCreditsRouting,
    });
    writeModelInputNodeAction(runtime, 'quality-gate', OK_OUTPUT_SCRIPT);
    const resolveAiCreditsRouting = jest.fn<
      ReturnType<ResolveAiCreditsRouting>,
      Parameters<ResolveAiCreditsRouting>
    >(() =>
      Promise.resolve({
        provider: 'claude',
        model: BASE_MODEL,
        env: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      }),
    );
    runtime.resolveAiCreditsRouting = resolveAiCreditsRouting;

    try {
      const result = await runStep({
        executionId: 'exec-direct-provider-route',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/quality-gate',
          with: { model: BASE_MODEL, criteria: 'review' },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        attempt: 2,
        iteration: 3,
        recovery: 4,
        signal: new AbortController().signal,
      });

      const routeSessionId =
        'pipeline:exec-direct-provider-route:job-1:agent-step:2:3:4';
      expect(result.status).toBe('success');
      expect(resolveAiCreditsRouting).toHaveBeenCalledWith(
        BASE_MODEL,
        'claude',
        expect.objectContaining({ routeSessionId }),
      );
      expect(releaseAiCreditsRouting).toHaveBeenCalledTimes(1);
      expect(releaseAiCreditsRouting).toHaveBeenCalledWith(routeSessionId);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('releases an owned route when non-terminal routing resolution fails', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const releaseAiCreditsRouting = jest.fn(() => Promise.resolve());
    const runtime = Object.assign(createRuntime(tempDir), {
      releaseAiCreditsRouting,
    });
    writeModelInputNodeAction(runtime, 'quality-gate', OK_OUTPUT_SCRIPT);
    runtime.resolveAiCreditsRouting = jest.fn(() =>
      Promise.reject(new Error('gateway routing failed')),
    );

    try {
      const result = await runStep({
        executionId: 'exec-routing-resolution-failure',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/quality-gate',
          with: { model: BASE_MODEL, criteria: 'review' },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('failure');
      expect(result.error).toContain('gateway routing failed');
      expect(releaseAiCreditsRouting).toHaveBeenCalledTimes(1);
      expect(releaseAiCreditsRouting).toHaveBeenCalledWith(
        'pipeline:exec-routing-resolution-failure:job-1:agent-step:1:1:0',
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('owns and releases a non-terminal model-aware Claude gateway route', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const releaseAiCreditsRouting = jest.fn(() => Promise.resolve());
    const runtime = Object.assign(createRuntime(tempDir), {
      releaseAiCreditsRouting,
    });
    writeAgentPromptAction(runtime, OK_OUTPUT_SCRIPT);
    const resolveAiCreditsRouting = jest.fn<
      ReturnType<ResolveAiCreditsRouting>,
      Parameters<ResolveAiCreditsRouting>
    >(() =>
      Promise.resolve({
        provider: 'claude',
        model: BASE_MODEL,
        env: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      }),
    );
    runtime.resolveAiCreditsRouting = resolveAiCreditsRouting;

    try {
      const result = await runStep({
        executionId: 'exec-model-aware-claude-route',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: { model: BASE_MODEL, prompt: 'continue' },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      const routeSessionId =
        'pipeline:exec-model-aware-claude-route:job-1:agent-step:1:1:0';
      expect(result.status).toBe('success');
      expect(resolveAiCreditsRouting).toHaveBeenCalledWith(
        BASE_MODEL,
        'claude',
        expect.objectContaining({ routeSessionId }),
      );
      expect(releaseAiCreditsRouting).toHaveBeenCalledTimes(1);
      expect(releaseAiCreditsRouting).toHaveBeenCalledWith(routeSessionId);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('owns and releases a non-terminal model-aware Codex gateway route', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const releaseAiCreditsRouting = jest.fn(() => Promise.resolve());
    const runtime = Object.assign(createRuntime(tempDir), {
      releaseAiCreditsRouting,
    });
    writeAgentPromptAction(runtime, '');
    const resolveModelHarnessInvocation = jest.fn(() =>
      Promise.resolve({
        source: 'ai-gateway' as const,
        harness: 'codex' as const,
        runtimeModel: 'provider/gpt-6-sol',
        aiCreditsRouted: true,
        modelGatewayRouted: true,
      }),
    );
    runtime.resolveModelHarnessInvocation = resolveModelHarnessInvocation;
    runtime.codexPromptRunner = {
      runCodexPrompt: (): Promise<CodexPromptRunnerResult> =>
        Promise.resolve({
          status: 'success',
          sessionId: 'codex-thread',
          rawText: 'ok',
          transcript: '',
          usage: {},
        }),
    };

    try {
      const result = await runStep({
        executionId: 'exec-model-aware-codex-route',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: { model: CODEX_MODEL, prompt: 'continue' },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      const routeSessionId =
        'pipeline:exec-model-aware-codex-route:job-1:agent-step:1:1:0';
      expect(result.status).toBe('success');
      expect(resolveModelHarnessInvocation).toHaveBeenCalledWith(
        CODEX_MODEL,
        expect.objectContaining({ routeSessionId }),
      );
      expect(releaseAiCreditsRouting).toHaveBeenCalledTimes(1);
      expect(releaseAiCreditsRouting).toHaveBeenCalledWith(routeSessionId);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['cursor-default', 'Cursor'],
    ['copilot:fixture', 'Copilot'],
  ])(
    'fails closed when a direct Claude action selects %s',
    async (model, label) => {
      // The gate rejected `codex` but not `cursor`, so a direct-Claude action
      // authored with a Cursor model handed that model to the Claude SDK. The
      // action must not launch and no provider may be contacted.
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
      );
      const runtime = createRuntime(tempDir);
      writeModelInputNodeAction(
        runtime,
        'quality-gate',
        "throw new Error('must not launch');",
      );
      const resolveAiCreditsRouting = jest.fn<
        ReturnType<ResolveAiCreditsRouting>,
        Parameters<ResolveAiCreditsRouting>
      >();
      runtime.resolveAiCreditsRouting = resolveAiCreditsRouting;

      try {
        const result = await runStep({
          executionId: 'exec-direct-provider-cursor',
          jobId: 'job-1',
          step: createStep({
            id: 'agent-step',
            uses: 'builtin/quality-gate',
            with: { model, criteria: 'review' },
          }),
          cwd: tempDir,
          env: {},
          runtime,
          signal: new AbortController().signal,
        });

        expect(result.status).toBe('failure');
        // Names the harness and says what to do instead.
        expect(result.error).toContain(
          `cannot use the ${label}-harness model "${model}"`,
        );
        expect(result.error).toContain('Choose a Claude-harness model');
        expect(resolveAiCreditsRouting).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it('fails closed when a direct Claude action selects a Codex-harness gateway model', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    writeModelInputNodeAction(
      runtime,
      'quality-gate',
      "throw new Error('must not launch');",
    );
    const resolveAiCreditsRouting = jest.fn<
      ReturnType<ResolveAiCreditsRouting>,
      Parameters<ResolveAiCreditsRouting>
    >();
    runtime.resolveAiCreditsRouting = resolveAiCreditsRouting;

    try {
      const result = await runStep({
        executionId: 'exec-direct-provider-codex-gateway',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/quality-gate',
          with: { model: GATEWAY_ONLY_MODEL, criteria: 'review' },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('failure');
      expect(result.error).toContain(
        'cannot use the Codex-harness model "gateway-only-pipeline-test"',
      );
      expect(resolveAiCreditsRouting).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ECW-9091 review round 8. The step supplies its own AI Credits routing
  // context, and both halves matter:
  //  - `workspaceId` so the user-supplied-credential guard resolves the SAME
  //    Canopy Environments assignment the step spawns with (a workspace
  //    assignment REPLACES the global one).
  //  - `allowNoNativeAuthFallback` false ONLY for triggers with no user present,
  //    so a scheduled automation or hook run cannot silently spend a
  //    credits-only user's balance, while an interactive run is untouched.
  // This seam previously had no coverage for the attendedness cases, which is
  // how the `'hook'` half shipped inert.
  it.each([
    ['automation', false],
    ['hook', false],
    ['user', true],
    ['portal', true],
    ['app_advisor', true],
    [undefined, true],
  ] as const)(
    'derives the AI Credits routing context for initiationSource=%s',
    async (initiationSource, expectedAllow) => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
      );
      const runtime = createRuntime(tempDir);
      const resolveAiCreditsRouting = jest.fn<
        ReturnType<ResolveAiCreditsRouting>,
        Parameters<ResolveAiCreditsRouting>
      >(() => Promise.resolve(null));
      runtime.resolveAiCreditsRouting = resolveAiCreditsRouting;
      writeAgentPromptAction(
        runtime,
        "require('node:fs').appendFileSync(process.env.CANOPY_OUTPUT, 'ok=true\\n');",
      );

      try {
        await runStep({
          executionId: 'exec-routing-context',
          jobId: 'job-1',
          step: createStep({
            id: 'agent-step',
            uses: 'builtin/agent-prompt',
            with: inputValues({ model: BASE_MODEL, prompt: 'continue' }),
          }),
          cwd: tempDir,
          env: {},
          runtime,
          projectId: 'workspace-77',
          ...(initiationSource !== undefined ? { initiationSource } : {}),
          signal: new AbortController().signal,
        });

        expect(resolveAiCreditsRouting).toHaveBeenCalledWith(
          BASE_MODEL,
          'claude',
          {
            signal: expectedRoutingSignal,
            checkpointProxyQuota: true,
            workspaceId: 'workspace-77',
            allowNoNativeAuthFallback: expectedAllow,
            routeSessionId:
              'pipeline:exec-routing-context:job-1:agent-step:1:1:0',
          },
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it('never launches a gateway-only model without an AI Credits route', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    writeAgentPromptAction(runtime, "throw new Error('must not launch');");

    try {
      const result = await runStep({
        executionId: 'exec-gateway-only-no-route',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: {
            model: GATEWAY_ONLY_MODEL,
            prompt: 'continue',
          },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('failure');
      expect(result.error).toContain('requires AI Credits');
      expect(result.error).not.toContain('must not launch');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('checks Ollama runtime setup against the resolved base model and captured harness', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    const resolveModelHarnessInvocation = jest.fn((model: string | undefined) =>
      Promise.resolve({
        source: 'ollama' as const,
        harness: 'claude' as const,
        runtimeModel: String(model),
        aiCreditsRouted: false,
        envOverride: { OLLAMA_RESOLVED_MODEL: String(model) },
      }),
    );
    runtime.resolveModelHarnessInvocation = resolveModelHarnessInvocation;
    initModelHarnessAssignments({
      revision: 1,
      assignments: [
        {
          modelId: OLLAMA_MODEL,
          source: 'ollama',
          harness: 'claude',
          defaultHarness: 'codex',
          configurable: true,
          overridden: true,
        },
      ],
    });

    try {
      writeAgentPromptAction(
        runtime,
        "require('node:fs').appendFileSync(process.env.CANOPY_OUTPUT, `ollama_model=${process.env.OLLAMA_RESOLVED_MODEL ?? ''}\\n`);",
      );

      const result = await runStep({
        executionId: 'exec-1',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: inputValues({ model: 'ollama_alias' }),
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
        modelAliases: [
          {
            id: 'ollama_alias',
            name: 'Ollama Alias',
            defaults: { base: OLLAMA_MODEL },
          },
        ],
      });

      expect(resolveModelHarnessInvocation).toHaveBeenCalledWith(
        OLLAMA_MODEL,
        expect.objectContaining({ harness: 'claude' }),
      );
      expect(result.outputs.ollama_model).toBe(OLLAMA_MODEL);
    } finally {
      initModelHarnessAssignments({ revision: 0, assignments: [] });
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not register a provider-neutral route before rejecting the Claude harness from the Codex path', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    writeAgentPromptAction(runtime, OK_OUTPUT_SCRIPT);
    const resolveModelHarnessInvocation = jest.fn(() =>
      Promise.resolve({
        source: 'claude-managed' as const,
        harness: 'claude' as const,
        runtimeModel: BASE_MODEL,
        aiCreditsRouted: true,
      }),
    );
    runtime.resolveModelHarnessInvocation = resolveModelHarnessInvocation;

    try {
      const result = await runStep({
        executionId: 'exec-claude-no-codex-route',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: { model: BASE_MODEL, prompt: 'continue' },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('success');
      expect(resolveModelHarnessInvocation).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('releases an ephemeral AI Credits route when terminal-worker eligibility falls back to the subprocess', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const releaseAiCreditsRouting = jest.fn(() => Promise.resolve());
    const runtime = Object.assign(createRuntime(tempDir), {
      releaseAiCreditsRouting,
    });
    writeAgentResumeAction(runtime, OK_OUTPUT_SCRIPT);
    runtime.resolveAiCreditsRouting = jest.fn(() =>
      Promise.resolve({
        provider: 'claude' as const,
        model: BASE_MODEL,
        env: {
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234/codex-gateway/route',
          ANTHROPIC_AUTH_TOKEN: 'broker-placeholder',
        },
      }),
    );
    runtime.agentPromptWorker = {
      runAgentPrompt: jest.fn<Promise<AgentPromptWorkerResult>, []>(),
    };

    try {
      const result = await runStep({
        executionId: 'exec-worker-fallback-route',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-resume',
          with: { model: BASE_MODEL, prompt: 'continue' },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        agentTerminalMode: true,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('success');
      expect(releaseAiCreditsRouting).toHaveBeenCalledWith(
        'pipeline:exec-worker-fallback-route:job-1:agent-step:1:1:0',
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps the Codex runner route authoritative in terminal mode', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    writeAgentPromptAction(runtime, '');
    const resolveModelHarnessInvocation = jest.fn(
      (): Promise<{
        source: 'codex-managed';
        harness: 'codex';
        runtimeModel: string;
        aiCreditsRouted: boolean;
      }> =>
        Promise.resolve({
          source: 'codex-managed' as const,
          harness: 'codex' as const,
          runtimeModel: 'gpt-6-sol',
          aiCreditsRouted: true,
        }),
    );
    runtime.resolveModelHarnessInvocation = resolveModelHarnessInvocation;
    runtime.agentPromptWorker = {
      runAgentPrompt: jest.fn<Promise<AgentPromptWorkerResult>, []>(),
    };
    runtime.codexPromptRunner = {
      runCodexPrompt: (): Promise<CodexPromptRunnerResult> =>
        Promise.resolve({
          status: 'success' as const,
          sessionId: 'codex-thread',
          rawText: 'ok',
          transcript: '',
          finalText: 'ok',
          usage: {},
        }),
    };

    try {
      await runStep({
        executionId: 'exec-codex-terminal-route',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: { model: 'gpt-6-sol', prompt: 'continue' },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        agentTerminalMode: true,
        signal: new AbortController().signal,
      });

      expect(resolveModelHarnessInvocation).toHaveBeenCalledWith(
        'gpt-6-sol',
        expect.objectContaining({
          routeSessionId:
            'pipeline:exec-codex-terminal-route:job-1:agent-step:1:1:0',
        }),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not register a Codex AI Credits route before prompt preflight succeeds', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    writeAgentPromptAction(runtime, '');
    const resolveModelHarnessInvocation = jest.fn(() =>
      Promise.resolve({
        source: 'codex-managed' as const,
        harness: 'codex' as const,
        runtimeModel: 'gpt-6-sol',
        aiCreditsRouted: true,
      }),
    );
    runtime.resolveModelHarnessInvocation = resolveModelHarnessInvocation;
    runtime.codexPromptRunner = {
      runCodexPrompt: (): Promise<CodexPromptRunnerResult> =>
        Promise.resolve({
          status: 'success',
          sessionId: 'codex-thread',
          rawText: 'ok',
          transcript: '',
          finalText: 'ok',
          usage: {},
        }),
    };

    try {
      const result = await runStep({
        executionId: 'exec-codex-preflight-route',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: { model: 'gpt-6-sol' },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('failure');
      expect(resolveModelHarnessInvocation).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('dispatches to the Codex harness when permission_preset is only the materialized default', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    writeAgentPromptAction(runtime, '');
    const runCodexPrompt = jest.fn<
      Promise<CodexPromptRunnerResult>,
      [CodexPromptRunnerRequest]
    >(
      (): Promise<CodexPromptRunnerResult> =>
        Promise.resolve({
          status: 'success',
          sessionId: 'codex-thread',
          transcript: '',
          rawText: 'ran',
          usage: {},
        }),
    );
    runtime.codexPromptRunner = { runCodexPrompt };

    try {
      const result = await runStep({
        executionId: 'exec-default-preset',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          // No `permission_preset` authored: action.yml's `default: none` is
          // materialized into inputValues, but a defaulted preset must NOT be
          // treated as an explicit no-tools request on the Codex harness.
          with: {
            model: OLLAMA_MODEL,
            prompt: 'summarize with default preset',
          },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.error ?? '').not.toContain('permission_preset "none"');
      expect(runCodexPrompt).toHaveBeenCalled();
      // A defaulted `none` must not reach the runner: codexSandboxForPermission
      // maps 'none' -> workspace-write with approvalPolicy 'never', which would
      // silently grant unattended write to a step whose declared intent was
      // "no tools at all". read_only is what the action documents for Codex.
      expect(runCodexPrompt.mock.calls[0]?.[0]?.permissionPreset).toBe(
        'read_only',
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Codex speed', () => {
    async function runCodexStepWithRunModelConfig(options: {
      fastMode?: string;
      modelConfig: AgentModelConfig;
    }): Promise<{
      result: Awaited<ReturnType<typeof runStep>>;
      runCodexPrompt: jest.Mock<
        Promise<CodexPromptRunnerResult>,
        [CodexPromptRunnerRequest]
      >;
    }> {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
      );
      const runtime = createRuntime(tempDir);
      writeAgentPromptAction(runtime, '');
      const runCodexPrompt = jest.fn<
        Promise<CodexPromptRunnerResult>,
        [CodexPromptRunnerRequest]
      >(
        (): Promise<CodexPromptRunnerResult> =>
          Promise.resolve({
            status: 'success',
            sessionId: 'codex-thread',
            transcript: '',
            rawText: 'ran',
            usage: {},
          }),
      );
      runtime.codexPromptRunner = { runCodexPrompt };
      try {
        const result = await runStep({
          executionId: 'exec-codex-speed',
          jobId: 'job-1',
          step: createStep({
            id: 'agent-step',
            uses: 'builtin/agent-prompt',
            with: {
              model: OLLAMA_MODEL,
              prompt: 'summarize',
              permission_preset: 'read_only',
              ...(options.fastMode === undefined
                ? {}
                : { fast_mode: options.fastMode }),
            },
          }),
          cwd: tempDir,
          env: {},
          runtime,
          modelConfig: options.modelConfig,
          signal: new AbortController().signal,
        });
        return { result, runCodexPrompt };
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }

    it('rejects an Ultra fast run model config before launching the Codex agent', async () => {
      const { result, runCodexPrompt } = await runCodexStepWithRunModelConfig({
        modelConfig: { speed: 'ultrafast', fastMode: false },
      });

      expect(result.status).toBe('failure');
      expect(result.error).toContain(
        'Workflows do not support Ultra fast. Set fast_mode on this step, or run the workflow with Regular or Fast.',
      );
      expect(runCodexPrompt).not.toHaveBeenCalled();
    });

    it.each([
      ['false', false],
      ['true', true],
    ] as const)(
      'lets an explicit step fast_mode=%s win over an Ultra fast run model config',
      async (fastMode, expected): Promise<void> => {
        const { result, runCodexPrompt } = await runCodexStepWithRunModelConfig(
          {
            fastMode,
            modelConfig: { speed: 'ultrafast', fastMode: false },
          },
        );

        expect(result.status).toBe('success');
        expect(runCodexPrompt).toHaveBeenCalledTimes(1);
        expect(runCodexPrompt.mock.calls[0]?.[0]?.fastMode).toBe(expected);
      },
    );
  });

  it('redacts pipeline secret values from Codex rawText/structured/proposedPlan outputs', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    writeAgentPromptAction(runtime, '');
    const runCodexPrompt = jest.fn<
      Promise<CodexPromptRunnerResult>,
      [CodexPromptRunnerRequest]
    >(
      (): Promise<CodexPromptRunnerResult> =>
        Promise.resolve({
          status: 'success',
          sessionId: 'codex-thread-secret',
          transcript: '{"type":"system"}\n',
          rawText: 'The API key is sekret-token-12345.',
          structured: { note: 'sekret-token-12345 embedded' },
          proposedPlan: 'Use sekret-token-12345 to call the API.',
          usage: {},
        }),
    );
    runtime.codexPromptRunner = { runCodexPrompt };

    try {
      const result = await runStep({
        executionId: 'exec-codex-secret',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: { model: CODEX_MODEL, prompt: 'summarize' },
        }),
        cwd: tempDir,
        env: {},
        secretEnv: { OPENAI_API_KEY: 'sekret-token-12345' },
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('success');
      expect(result.outputs.text_response).not.toContain('sekret-token-12345');
      expect(result.outputs.json_response).not.toContain('sekret-token-12345');
      expect(
        fs.readFileSync(result.outputs.text_response_file, 'utf8'),
      ).not.toContain('sekret-token-12345');
      expect(
        fs.readFileSync(result.outputs.json_response_file, 'utf8'),
      ).not.toContain('sekret-token-12345');
      expect(
        fs.readFileSync(result.outputs.proposed_plan_file, 'utf8'),
      ).not.toContain('sekret-token-12345');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('redacts a multi-line Codex secret from text_response even when echoed verbatim', async () => {
    // Independent-review regression: `text_response` normalized the raw
    // text to a single line BEFORE redacting it, which collapses a
    // multi-line secret's own internal newlines and breaks the exact match
    // against the (still multi-line) configured secret value, leaking the
    // collapsed-but-still-complete secret.
    const secret = 'BEGIN-FAKE-KEY\nline2-abcdef\nEND-FAKE-KEY';
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    writeAgentPromptAction(runtime, '');
    const runCodexPrompt = jest.fn(
      (): Promise<CodexPromptRunnerResult> =>
        Promise.resolve({
          status: 'success',
          sessionId: 'codex-thread-multiline-secret',
          transcript: '{"type":"system"}\n',
          rawText: `Here it is:\n${secret}\ndone.`,
          usage: {},
        }),
    );
    runtime.codexPromptRunner = { runCodexPrompt };

    try {
      const result = await runStep({
        executionId: 'exec-codex-multiline-secret',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: { model: CODEX_MODEL, prompt: 'summarize' },
        }),
        cwd: tempDir,
        env: {},
        secretEnv: { OPENAI_API_KEY: secret },
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('success');
      expect(result.outputs.text_response).not.toContain('BEGIN-FAKE-KEY');
      expect(result.outputs.text_response).not.toContain('line2-abcdef');
      expect(result.outputs.text_response).not.toContain('END-FAKE-KEY');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('redacts a synthetic AI-Credits envOverride value from every Codex output surface, including the live transcript stream and transcript_file', async () => {
    // resolveAiCreditsRoutingOverride's `env` is always `{}` for real Codex
    // routing today (buildCodexProxyConfig: the app-server child gets only an
    // opaque loopback route, and the parent injects the real bearer token
    // upstream — the token itself never reaches this process). This test
    // exercises the redaction seam with a synthetic non-empty envOverride
    // anyway, for defense-in-depth against a future Codex routing mode that
    // does hand the child a real credential, and to lock in that
    // transcriptRedactor and secretValues both cover it identically.
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    writeAgentPromptAction(runtime, '');
    const runCodexPrompt = jest.fn(
      (request: {
        onTranscriptLine?: (line: string) => void;
      }): Promise<CodexPromptRunnerResult> => {
        request.onTranscriptLine?.(
          '{"type":"item.completed","text":"gateway token sekret-gateway-987654"}',
        );
        return Promise.resolve({
          status: 'success',
          sessionId: 'codex-thread-ai-credits',
          transcript: '{"type":"system"}\n',
          rawText: 'The gateway token is sekret-gateway-987654.',
          structured: { note: 'sekret-gateway-987654 embedded' },
          proposedPlan: 'Use sekret-gateway-987654 to call the gateway.',
          usage: {},
        });
      },
    );
    runtime.codexPromptRunner = { runCodexPrompt };
    runtime.resolveModelHarnessInvocation = jest.fn(() =>
      Promise.resolve({
        source: 'claude-managed',
        harness: 'codex',
        runtimeModel: CODEX_MODEL,
        aiCreditsRouted: true,
        envOverride: { CODEX_GATEWAY_BEARER_TOKEN: 'sekret-gateway-987654' },
      }),
    );

    try {
      const result = await runStep({
        executionId: 'exec-codex-ai-credits-secret',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: { model: CODEX_MODEL, prompt: 'summarize' },
        }),
        cwd: tempDir,
        env: {},
        // No pipeline-authored secretEnv here — the synthetic value under
        // test comes exclusively from the AI-Credits routing override's
        // envOverride, never from a step-authored secrets: block.
        secretEnv: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('success');
      expect(result.outputs.text_response).not.toContain(
        'sekret-gateway-987654',
      );
      expect(result.outputs.json_response).not.toContain(
        'sekret-gateway-987654',
      );
      expect(
        fs.readFileSync(result.outputs.text_response_file, 'utf8'),
      ).not.toContain('sekret-gateway-987654');
      expect(
        fs.readFileSync(result.outputs.json_response_file, 'utf8'),
      ).not.toContain('sekret-gateway-987654');
      expect(
        fs.readFileSync(result.outputs.transcript_file, 'utf8'),
      ).not.toContain('sekret-gateway-987654');
      expect(
        fs.readFileSync(result.outputs.proposed_plan_file, 'utf8'),
      ).not.toContain('sekret-gateway-987654');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('redacts a multi-line secret embedded in a real Codex host-runner transcript event into the transcript_file', async () => {
    // Integration-level regression: drives the ACTUAL onTranscriptLine
    // redaction seam in maybeRunCodexPrompt (not just an isolated
    // primitive), with a configured secret containing an embedded newline.
    // The real Codex host-runner (`runCliCodexPrompt`/`cli-runtime.ts`)
    // always calls `onTranscriptLine` with one complete `JSON.stringify`
    // result per event — a multi-line secret's own newline is always
    // JSON-escaped there, never a real newline splitting the transcript
    // into multiple physical lines/calls, so this mock reflects that real
    // shape (one call, one JSON event, the secret's newline embedded in
    // one string field) rather than an unrealistic raw-text split.
    const secretTop = 'synthetic-top-line';
    const secretBottom = 'synthetic-bottom-line';
    const multilineSecret = `${secretTop}\n${secretBottom}`;
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    writeAgentPromptAction(runtime, '');
    const transcriptEvent = {
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: `Here it is:\n${multilineSecret}\ndone.`,
      },
    };
    const runCodexPrompt = jest.fn(
      (request: {
        onTranscriptLine?: (line: string) => void;
      }): Promise<CodexPromptRunnerResult> => {
        request.onTranscriptLine?.(JSON.stringify(transcriptEvent));
        return Promise.resolve({
          status: 'success',
          sessionId: 'codex-thread-multiline-secret',
          transcript: `${JSON.stringify(transcriptEvent)}\n`,
          rawText: 'done',
          usage: {},
        });
      },
    );
    runtime.codexPromptRunner = { runCodexPrompt };

    try {
      const result = await runStep({
        executionId: 'exec-codex-multiline-secret',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: { model: CODEX_MODEL, prompt: 'summarize' },
        }),
        cwd: tempDir,
        env: {},
        secretEnv: { MY_MULTILINE_SECRET: multilineSecret },
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('success');
      const transcriptContent = fs.readFileSync(
        result.outputs.transcript_file,
        'utf8',
      );
      expect(transcriptContent).not.toContain(secretTop);
      expect(transcriptContent).not.toContain(secretBottom);
      expect(transcriptContent).toContain('***');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('redacts a multi-line secret from a Codex transcript line that is itself a JSON-serialized event', async () => {
    // Controller-followup5 regression: the real Codex host-runner
    // (`runCliCodexPrompt` / `cli-runtime.ts`) JSON.stringify's each event
    // BEFORE calling `onTranscriptLine`, so a multi-line configured secret
    // echoed verbatim by the agent reaches `transcriptRedactor` only as an
    // escaped `\n` two-character sequence — which the redactor's raw
    // (unescaped) value list can never exact-match. Fixed by expanding that
    // value list with each value's JSON-escaped form
    // (`withJsonEscapedVariants`).
    const secret = 'BEGIN-FAKE-KEY\nline2-abcdef\nEND-FAKE-KEY';
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    writeAgentPromptAction(runtime, '');
    const runCodexPrompt = jest.fn(
      (request: {
        onTranscriptLine?: (line: string) => void;
      }): Promise<CodexPromptRunnerResult> => {
        const event = {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: `Here it is:\n${secret}\ndone.`,
          },
        };
        request.onTranscriptLine?.(JSON.stringify(event));
        return Promise.resolve({
          status: 'success',
          sessionId: 'codex-thread-json-escaped-secret',
          transcript: `${JSON.stringify(event)}\n`,
          rawText: 'done',
          usage: {},
        });
      },
    );
    runtime.codexPromptRunner = { runCodexPrompt };

    try {
      const result = await runStep({
        executionId: 'exec-codex-json-escaped-secret',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: { model: CODEX_MODEL, prompt: 'summarize' },
        }),
        cwd: tempDir,
        env: {},
        secretEnv: { OPENAI_API_KEY: secret },
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('success');
      const transcriptContent = fs.readFileSync(
        result.outputs.transcript_file,
        'utf8',
      );
      expect(transcriptContent).not.toContain('BEGIN-FAKE-KEY');
      expect(transcriptContent).not.toContain('line2-abcdef');
      expect(transcriptContent).not.toContain('END-FAKE-KEY');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('still injects AGENT_SECRET_VALUES for a model-aware agent-prompt step', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    writeAgentPromptAction(
      runtime,
      [
        "const fs = require('fs');",
        `const key = '${brandEnvName('AGENT_SECRET_VALUES')}';`,
        `const outputFile = process.env['${brandEnvName('OUTPUT')}'];`,
        'fs.appendFileSync(outputFile, `has_secret_values=${key in process.env}\\n`);',
        'fs.appendFileSync(outputFile, `secret_values=${process.env[key]}\\n`);',
      ].join('\n'),
    );

    try {
      const result = await runStep({
        executionId: 'exec-agent-prompt-secret-env',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: { model: BASE_MODEL, prompt: 'inspect environment' },
        }),
        cwd: tempDir,
        env: {},
        secretEnv: { MY_SECRET: 'sekret-value-123456' },
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('success');
      expect(result.outputs.has_secret_values).toBe('true');
      expect(result.outputs.secret_values).toContain('sekret-value-123456');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('only injects AGENT_SECRET_VALUES for model-aware agent actions, not every generic step', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    const actionDir = path.join(runtime.bundledActionsDir, 'echo-env');
    fs.mkdirSync(actionDir, { recursive: true });
    fs.writeFileSync(
      path.join(actionDir, 'action.yml'),
      [
        'name: Echo Env',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(actionDir, 'index.js'),
      [
        "const fs = require('fs');",
        `const key = '${brandEnvName('AGENT_SECRET_VALUES')}';`,
        `const outputFile = process.env['${brandEnvName('OUTPUT')}'];`,
        'fs.appendFileSync(outputFile, `has_secret_values=${key in process.env}\\n`);',
      ].join('\n'),
      'utf8',
    );

    try {
      const result = await runStep({
        executionId: 'exec-echo-env',
        jobId: 'job-1',
        step: createStep({ id: 'echo-step', uses: 'builtin/echo-env' }),
        cwd: tempDir,
        env: {},
        secretEnv: { MY_SECRET: 'sekret-value-123456' },
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('success');
      expect(result.outputs.has_secret_values).toBe('false');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('dispatches agent-resume to Codex with a defaulted permission_preset', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    // agent-resume ships the same `default: none` and is served by the same
    // guard, so it needs its own coverage (CAN-2436 review finding).
    writeAgentResumeAction(runtime, '');
    const runCodexPrompt = jest.fn<
      Promise<CodexPromptRunnerResult>,
      [CodexPromptRunnerRequest]
    >(
      (): Promise<CodexPromptRunnerResult> =>
        Promise.resolve({
          status: 'success',
          sessionId: 'codex-thread',
          transcript: '',
          rawText: 'resumed',
          usage: {},
        }),
    );
    runtime.codexPromptRunner = { runCodexPrompt };

    try {
      const result = await runStep({
        executionId: 'exec-default-preset-resume',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-resume-step',
          uses: 'builtin/agent-resume',
          with: {
            model: OLLAMA_MODEL,
            session_id: 'codex-thread',
            prompt: 'continue with default preset',
          },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.error ?? '').not.toContain('permission_preset "none"');
      expect(runCodexPrompt).toHaveBeenCalled();
      expect(runCodexPrompt.mock.calls[0]?.[0]?.permissionPreset).toBe(
        'read_only',
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects no-tools Ollama prompts before dispatching to the Codex harness', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    writeAgentPromptAction(runtime, '');
    const runCodexPrompt = jest.fn(
      (): Promise<CodexPromptRunnerResult> =>
        Promise.resolve({
          status: 'success',
          sessionId: 'codex-thread',
          transcript: '',
          rawText: 'should not run',
          usage: {},
        }),
    );
    runtime.codexPromptRunner = { runCodexPrompt };

    try {
      const result = await runStep({
        executionId: 'exec-ollama-no-tools',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: {
            model: OLLAMA_MODEL,
            prompt: 'summarize without tools',
            permission_preset: 'none',
          },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('failure');
      expect(result.error).toContain('permission_preset "none"');
      expect(runCodexPrompt).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects no-tools AI Gateway prompts before dispatching to the Codex harness', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    writeAgentPromptAction(runtime, '');
    const runCodexPrompt = jest.fn(
      (): Promise<CodexPromptRunnerResult> =>
        Promise.resolve({
          status: 'success',
          sessionId: 'codex-thread',
          transcript: '',
          rawText: 'should not run',
          usage: {},
        }),
    );
    runtime.codexPromptRunner = { runCodexPrompt };
    runtime.resolveModelHarnessInvocation = jest.fn(() =>
      Promise.resolve({
        source: 'ai-gateway' as const,
        harness: 'codex' as const,
        runtimeModel: 'provider/gateway-only-pipeline-test',
        aiCreditsRouted: true,
      }),
    );
    runtime.resolveAiCreditsRouting = jest.fn(() =>
      Promise.resolve({
        provider: 'codex' as const,
        model: 'provider/gateway-only-pipeline-test',
        env: { OPENAI_API_KEY: 'broker-placeholder' },
      }),
    );

    try {
      const result = await runStep({
        executionId: 'exec-gateway-no-tools',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: {
            model: GATEWAY_ONLY_MODEL,
            prompt: 'summarize without tools',
            permission_preset: 'none',
          },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('failure');
      expect(result.error).toContain('permission_preset "none"');
      expect(runCodexPrompt).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('releases an AI Credits route when a terminal worker is cancelled before dispatch', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const releaseAiCreditsRouting = jest.fn(() => Promise.resolve());
    const runtime = Object.assign(createRuntime(tempDir), {
      releaseAiCreditsRouting,
    });
    writeAgentPromptAction(runtime, '');
    runtime.resolveAiCreditsRouting = jest.fn(() =>
      Promise.resolve({
        provider: 'claude' as const,
        model: BASE_MODEL,
        env: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      }),
    );
    runtime.agentPromptWorker = {
      runAgentPrompt: jest.fn<Promise<AgentPromptWorkerResult>, []>(),
    };
    const controller = new AbortController();
    controller.abort();

    try {
      const result = await runStep({
        executionId: 'exec-worker-cancelled-route',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: { model: BASE_MODEL, prompt: 'continue' },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        agentTerminalMode: true,
        signal: controller.signal,
      });

      expect(result.status).toBe('cancelled');
      expect(releaseAiCreditsRouting).toHaveBeenCalledWith(
        'pipeline:exec-worker-cancelled-route:job-1:agent-step:1:1:0',
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('releases an AI Credits route when terminal-worker preflight throws', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const releaseAiCreditsRouting = jest.fn(() => Promise.resolve());
    const runtime = Object.assign(createRuntime(tempDir), {
      releaseAiCreditsRouting,
    });
    writeAgentPromptAction(runtime, '');
    runtime.resolveAiCreditsRouting = jest.fn(() =>
      Promise.resolve({
        provider: 'claude' as const,
        model: BASE_MODEL,
        env: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      }),
    );
    runtime.agentPromptWorker = {
      runAgentPrompt: jest.fn<Promise<AgentPromptWorkerResult>, []>(),
    };

    try {
      const result = await runStep({
        executionId: 'exec-worker-preflight-route',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: {
            model: BASE_MODEL,
            prompt: 'continue',
            structured_output_schema: '{',
          },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        agentTerminalMode: true,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('failure');
      expect(releaseAiCreditsRouting).toHaveBeenCalledWith(
        'pipeline:exec-worker-preflight-route:job-1:agent-step:1:1:0',
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ECW-9091 review round 9. Codex agent-prompt/agent-resume steps short-circuit
  // in `maybeRunCodexPrompt` BEFORE `resolveActionAiCreditsEnv`, so the generic
  // routing-context seam never applies to them and the unattended opt-out has to
  // ride on the runner request instead. The Claude-only table above cannot reach
  // this branch, which is how the gap shipped.
  it.each([
    ['automation', false],
    ['hook', false],
    ['user', true],
    [undefined, true],
  ] as const)(
    'carries attendedness to the Codex runner for initiationSource=%s',
    async (initiationSource, expectedAllow) => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
      );
      const runtime = createRuntime(tempDir);
      writeAgentPromptAction(runtime, '');
      const resolveModelHarnessInvocation = jest.fn(() =>
        Promise.resolve({
          source: 'codex-managed' as const,
          harness: 'codex' as const,
          runtimeModel: 'gpt-6-sol',
          aiCreditsRouted: false,
        }),
      );
      runtime.resolveModelHarnessInvocation = resolveModelHarnessInvocation;
      const runCodexPrompt = jest.fn(
        (): Promise<CodexPromptRunnerResult> =>
          Promise.resolve({
            status: 'success',
            sessionId: 'codex-thread',
            rawText: 'ok',
            transcript: '',
            finalText: 'ok',
            usage: {},
          }),
      );
      runtime.codexPromptRunner = { runCodexPrompt };

      try {
        await runStep({
          executionId: 'exec-codex-attendedness',
          jobId: 'job-1',
          step: createStep({
            id: 'agent-step',
            uses: 'builtin/agent-prompt',
            with: { model: CODEX_MODEL, prompt: 'continue' },
          }),
          cwd: tempDir,
          env: {},
          runtime,
          projectId: 'workspace-77',
          ...(initiationSource !== undefined ? { initiationSource } : {}),
          signal: new AbortController().signal,
        });

        expect(runCodexPrompt).toHaveBeenCalledWith(
          expect.objectContaining({
            allowNoNativeAuthFallback: expectedAllow,
            projectId: 'workspace-77',
          }),
        );
        expect(resolveModelHarnessInvocation).toHaveBeenCalledWith(
          'gpt-6-sol',
          expect.objectContaining({
            workspaceId: 'workspace-77',
            allowNoNativeAuthFallback: expectedAllow,
          }),
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it('keeps recoverable in-process Codex failures on the recovery path', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    writeAgentPromptAction(runtime, '');
    runtime.codexPromptRunner = {
      runCodexPrompt: (): Promise<CodexPromptRunnerResult> =>
        Promise.resolve({
          status: 'failure',
          transcript: '{"type":"turn.failed"}\n',
          failure: {
            version: 1,
            provider: 'codex',
            session_id: 'codex-thread',
            had_agent_activity: true,
            classification: {
              kind: 'provider_usage_limit',
              code: 'rate_limit',
              provider: 'codex',
              account_scope: 'native',
              diagnostic_message: 'usage exhausted',
            },
            message: 'usage exhausted',
          },
        }),
    };

    try {
      const result = await runStep({
        executionId: 'exec-codex-recovery',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: { model: CODEX_MODEL, prompt: 'continue' },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('paused');
      expect(result.agent_recovery).toMatchObject({
        version: 2,
        provider: 'codex',
        harness: 'codex',
        session_id: 'codex-thread',
        strategy: 'continue_session',
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('redacts pipeline secret values from an in-process Claude worker failure message and classification diagnostic_message', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    writeAgentPromptAction(runtime, '');
    runtime.agentPromptWorker = {
      runAgentPrompt: (): Promise<AgentPromptWorkerResult> =>
        Promise.resolve({
          status: 'failure',
          workerId: 'worker-1',
          transcript: '{"type":"result"}\n',
          failure: {
            version: 1,
            provider: 'claude',
            session_id: 'claude-session-secret-failure',
            had_agent_activity: true,
            classification: {
              kind: 'provider_usage_limit',
              code: 'rate_limit',
              provider: 'claude',
              account_scope: 'native',
              diagnostic_message: 'rejected credential sekret-token-12345',
            },
            message:
              'Unexpected token, "sekret-token-12345" is not valid JSON.',
          },
        }),
    };

    try {
      const result = await runStep({
        executionId: 'exec-claude-worker-diagnostic-secret',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: { model: BASE_MODEL, prompt: 'inspect environment' },
        }),
        cwd: tempDir,
        env: {},
        secretEnv: { MY_SECRET: 'sekret-token-12345' },
        runtime,
        signal: new AbortController().signal,
        agentTerminalMode: true,
      });

      expect(result.status).toBe('paused');
      expect(result.error).not.toContain('sekret-token-12345');
      expect(result.pause_reason?.diagnostic_message).not.toContain(
        'sekret-token-12345',
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not corrupt the claude_terminal_projected_messages JSON when a configured secret only exists as a serialization artifact spanning two leaves', async () => {
    // Derive the synthetic secret from the ACTUAL serialized shape rather
    // than hand-typing a literal string, so this test stays correct if the
    // JSON.stringify formatting of the wrapper or message shape ever
    // changes. The chosen span starts inside one leaf's value ('value') and
    // ends inside a DIFFERENT leaf's value ('rest'), crossing real JSON
    // structural characters (a closing quote, comma, key, colon) in between.
    // No single logical leaf or key contains this string, so the correct,
    // structural redaction pass must leave both 'value' and 'rest' entirely
    // untouched — a second, naive substring pass over the serialized text
    // would instead find this exact span and either corrupt the JSON syntax
    // or silently swallow the 'rest' leaf, depending on where the '***'
    // replacement lands relative to the surrounding quotes.
    const sampleMessages = [
      {
        id: 'm1',
        role: 'assistant' as const,
        timestamp: 1700000000000,
        blocks: [
          { type: 'text' as const, text: 'value' },
          { type: 'text' as const, text: 'rest' },
        ],
      },
    ];
    const sampleSerialized = JSON.stringify({
      type: 'claude_terminal_projected_messages',
      messages: sampleMessages,
    });
    const spanStart = sampleSerialized.indexOf('value');
    const spanEnd = sampleSerialized.indexOf('rest') + 'rest'.length;
    expect(spanStart).toBeGreaterThan(-1);
    expect(spanEnd).toBeGreaterThan(spanStart);
    const syntheticSecret = sampleSerialized.slice(spanStart, spanEnd);
    expect(syntheticSecret.length).toBeGreaterThanOrEqual(6);

    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    writeAgentPromptAction(runtime, '');
    runtime.agentPromptWorker = {
      runAgentPrompt: (): Promise<AgentPromptWorkerResult> =>
        Promise.resolve({
          status: 'success',
          workerId: 'worker-projected-messages',
          sessionId: 'session-projected-messages',
          rawText: 'done',
          transcript: 'tool output\n',
          projectedMessages: sampleMessages,
        }),
    };
    const onStepOutput = jest.fn<void, [StepOutputEvent]>();

    try {
      await runStep({
        executionId: 'exec-projected-messages-artifact',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: { model: BASE_MODEL, prompt: 'summarize' },
        }),
        cwd: tempDir,
        env: {},
        secretEnv: { MY_SECRET: syntheticSecret },
        runtime,
        signal: new AbortController().signal,
        agentTerminalMode: true,
        onStepOutput,
      });

      const projectedEvent = onStepOutput.mock.calls.find(([event]) =>
        event.data.includes('claude_terminal_projected_messages'),
      );
      expect(projectedEvent).toBeDefined();
      const data = projectedEvent?.[0].data ?? '';
      let parsed: unknown;
      expect(() => {
        parsed = JSON.parse(data);
      }).not.toThrow();
      expect(parsed).toMatchObject({
        type: 'claude_terminal_projected_messages',
        messages: [
          {
            id: 'm1',
            blocks: [
              { type: 'text', text: 'value' },
              { type: 'text', text: 'rest' },
            ],
          },
        ],
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('redacts secrets from in-process Codex transcript logs and output', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    writeAgentPromptAction(runtime, '');
    let capturedEnvironment: Record<string, string> | undefined;
    runtime.codexPromptRunner = {
      runCodexPrompt: (request): Promise<CodexPromptRunnerResult> => {
        capturedEnvironment = request.environment;
        return Promise.resolve({
          status: 'success',
          sessionId: 'codex-thread',
          rawText: 'done',
          transcript: 'before pipeline-secret-value after\n',
          usage: {},
        });
      },
    };
    const output: string[] = [];

    try {
      const result = await runStep({
        executionId: 'exec-codex-redaction',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: { model: CODEX_MODEL, prompt: 'continue' },
        }),
        cwd: tempDir,
        env: {},
        secretEnv: { PIPELINE_SECRET: 'pipeline-secret-value' },
        runtime,
        signal: new AbortController().signal,
        onStepOutput: (event) => output.push(event.data),
      });

      expect(capturedEnvironment).toMatchObject({
        PIPELINE_SECRET: 'pipeline-secret-value',
      });
      if (!result.log_file) throw new Error('Expected a persisted step log');
      expect(fs.readFileSync(result.log_file, 'utf8')).toBe(
        'before *** after\n',
      );
      expect(output.join('')).toBe('before *** after\n');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('uses the in-process Codex route attribution without pre-registering another route', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    writeAgentPromptAction(runtime, '');
    const resolveAiCreditsRouting = jest.fn<
      ReturnType<ResolveAiCreditsRouting>,
      Parameters<ResolveAiCreditsRouting>
    >(() =>
      Promise.resolve({
        provider: 'codex',
        model: 'gateway-gpt-5.5',
        env: { AI_CREDITS_TOKEN: 'secret' },
      }),
    );
    runtime.resolveAiCreditsRouting = resolveAiCreditsRouting;
    runtime.codexPromptRunner = {
      runCodexPrompt: (): Promise<CodexPromptRunnerResult> =>
        Promise.resolve({
          status: 'success',
          sessionId: 'codex-thread',
          rawText: 'done',
          transcript: '{"type":"turn.completed"}\n',
          usage: {},
          aiCreditsRouted: true,
          modelGatewayRouted: true,
        }),
    };

    try {
      const result = await runStep({
        executionId: 'exec-codex-ai-credits',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: { model: CODEX_MODEL, prompt: 'continue' },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(resolveAiCreditsRouting).not.toHaveBeenCalled();
      expect(result.outputs[AI_CREDITS_ROUTED_OUTPUT_KEY]).toBe('true');
      expect(result.outputs[MODEL_GATEWAY_ROUTED_OUTPUT_KEY]).toBe('true');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Regression: the observability service keys an iterated agent step's audit
  // entry as `.../{attempt}/i{iteration}`, but derives the key for streamed
  // output from `StepOutputEvent.iteration`, defaulting to 1 when absent. The
  // claude-terminal and Codex emit paths used to omit `iteration`, so for any
  // iteration >= 2 the output resolved to the base key, found no open entry and
  // dropped the buffer — losing that iteration's transcript, message count,
  // tokens and cost from the audit trail. This drives the real worker emit path
  // and fails if the executor stops stamping the iteration it was handed.
  it('stamps the executing iteration on terminal-worker step output', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    runtime.agentPromptWorker = {
      runAgentPrompt: (): Promise<AgentPromptWorkerResult> =>
        Promise.resolve({
          status: 'success',
          workerId: 'worker-iteration',
          sessionId: 'session-iteration',
          rawText: 'completed',
          transcript: 'tool output: iteration three\n',
          projectedMessages: [
            {
              id: 'message-iteration',
              role: 'assistant',
              timestamp: Date.now(),
              blocks: [{ type: 'text', text: 'iteration three' }],
            },
          ],
        }),
    };
    const onStepOutput = jest.fn<void, [StepOutputEvent]>();

    try {
      writeAgentPromptAction(runtime, 'process.exitCode = 1;');
      await runStep({
        executionId: 'exec-iteration-worker',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: { model: BASE_MODEL, prompt: 'iterate' },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
        agentTerminalMode: true,
        attempt: 0,
        iteration: 3,
        onStepOutput,
      });

      expect(onStepOutput).toHaveBeenCalled();
      for (const [event] of onStepOutput.mock.calls) {
        expect(event.iteration).toBe(3);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // `builtin/parallel-agents` declares `log_format_hint: agent` so that
  // agent-step COUNTING recognizes it (`BUNDLED_AGENT_ACTION_REFS`), but it
  // fans work out to child agents and emits an aggregate JSON report rather
  // than its own provider transcript. `FANOUT_AGENT_ACTIONS` therefore keeps
  // that hint off the step *result*.
  //
  // This guard is load-bearing and otherwise untested: if the hint reaches the
  // result, `ObservabilityService.syncPipelineStep`'s `shouldTrack` flips true
  // and opens a `pipeline_agent_turn` that nothing can ever fill (0 messages,
  // 0 tokens, $0) — which `getAgentWorkByUser` then scores as a real agent
  // turn, inflating Impact with an empty turn. The renderer would also parse
  // the aggregate log as an agent transcript.
  it('does not propagate the agent log format hint to fan-out wrapper results', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    const actionDir = path.join(runtime.bundledActionsDir, 'parallel-agents');
    fs.mkdirSync(actionDir, { recursive: true });
    fs.writeFileSync(
      path.join(actionDir, 'action.yml'),
      [
        'name: Parallel Agents',
        // Mirrors the real manifest: the hint IS declared here.
        'log_format_hint: agent',
        'inputs:',
        '  prompts: {}',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(path.join(actionDir, 'index.js'), '', 'utf8');

    try {
      const result = await runStep({
        executionId: 'exec-fanout-hint',
        jobId: 'job-1',
        step: createStep({
          id: 'fanout-step',
          uses: 'builtin/parallel-agents',
          with: { prompts: '[]' },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('success');
      expect(result.log_format_hint).toBeUndefined();
      expect(result.agent_provider).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('the aggregate of configured values at the step output', () => {
  // A builtin agent action receives every configured value as one JSON list
  // (`AGENT_SECRET_VALUES`). Printed by a tool, each value appears
  // JSON-escaped inside the decoded tool result: a newline, quote or
  // backslash no longer matches the configured value itself. The real step
  // masks the saved log and the live output; the action here prints the
  // aggregate it was really given, once and nested inside another JSON
  // string.
  it.each([
    [
      'multi-line',
      'SYNTHETIC-PRIVATE-KEY\nCANARY-AGGREGATE-91827\nEND-KEY',
      'CANARY-AGGREGATE-91827',
    ],
    [
      'quoted',
      '{ "private_key": "CANARY-QUOTED-91827" }',
      'CANARY-QUOTED-91827',
    ],
    [
      'backslash',
      'SYNTHETIC\\CANARY-BACKSLASH-91827',
      'CANARY-BACKSLASH-91827',
    ],
  ])(
    'masks a %s value the action prints from the aggregate',
    async (_name, secret, canary) => {
      const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'canopy-aggregate-step-'),
      );
      const runtime = createRuntime(dir);
      const live: string[] = [];
      writeAgentPromptAction(
        runtime,
        [
          `const key = ${JSON.stringify(brandEnvName('AGENT_SECRET_VALUES'))};`,
          'const aggregate = process.env[key] ?? "";',
          "const text = 'once=' + aggregate + ' twice=' + JSON.stringify(aggregate);",
          "console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: text }] } }));",
        ].join('\n'),
      );
      try {
        const result = await runStep({
          executionId: 'aggregate-step',
          jobId: 'job',
          step: createStep({
            id: 'agent-step',
            uses: 'builtin/agent-prompt',
            with: {
              model: BASE_MODEL,
              prompt: 'fixture',
              permission_preset: 'dangerous_all',
            },
          }),
          cwd: dir,
          env: {},
          secretEnv: { SYNTHETIC_SECRET: secret },
          runtime,
          signal: new AbortController().signal,
          onStepOutput: (event) => live.push(event.data),
        });
        expect(result.status).toBe('success');
        const disk = fs.readFileSync(result.log_file ?? '', 'utf8');
        const stream = live.join('');
        // The aggregate really was printed, and is now masked in both.
        expect(disk).toContain('once=');
        expect(disk).toContain('***');
        expect({
          disk: disk.includes(canary),
          live: stream.includes(canary),
        }).toEqual({
          disk: false,
          live: false,
        });
        // Still the record the action wrote, with only its text changed.
        const line = disk
          .split('\n')
          .find((row) => row.includes('tool_result'));
        expect((): unknown => JSON.parse(line ?? '')).not.toThrow();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('still masks a multi-line value printed under its own name', async () => {
    const secret = 'SYNTHETIC-PRIVATE-KEY\nCANARY-INDIVIDUAL-91827\nEND-KEY';
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-individual-step-'),
    );
    const runtime = createRuntime(dir);
    const live: string[] = [];
    writeAgentPromptAction(
      runtime,
      "console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'SYNTHETIC_SECRET=' + process.env.SYNTHETIC_SECRET }] } }));",
    );
    try {
      const result = await runStep({
        executionId: 'individual-step',
        jobId: 'job',
        step: createStep({
          id: 'agent-step',
          uses: 'builtin/agent-prompt',
          with: { model: BASE_MODEL, prompt: 'fixture' },
        }),
        cwd: dir,
        env: {},
        secretEnv: { SYNTHETIC_SECRET: secret },
        runtime,
        signal: new AbortController().signal,
        onStepOutput: (event) => live.push(event.data),
      });
      expect(result.status).toBe('success');
      const disk = fs.readFileSync(result.log_file ?? '', 'utf8');
      expect(disk).not.toContain('CANARY-INDIVIDUAL-91827');
      expect(live.join('')).not.toContain('CANARY-INDIVIDUAL-91827');
      expect(disk).toContain('***');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
