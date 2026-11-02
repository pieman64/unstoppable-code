import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getExecutionHarnessForModel,
  initCopilotModels,
  initCursorModels,
  resolveModelAlias,
} from '@canopy/desktop-shared/types';
import type {
  ResolvedPluginRuntime,
  ResolvePluginsOptions,
} from '../../../plugins/plugin-resolver';
import type { ResolvedActionRuntime } from '../../action-resolver';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type * as redaction from '../../../../lib/redaction';
import { CursorEventProjection } from '../../../cursor/events';
import { resolveHostRepositoryPolicy } from '../../../lib/repository-policy';
import { parsePipelineText } from '../../../../pipelines/parse-pipeline';
import { normalizePipeline } from '../normalize-pipeline';
import { loadExecutionState, saveExecutionState } from '../execution-state';
import {
  executePipeline,
  rerunPipelineExecution,
  resumePipeline,
  retryPipelineExecution,
} from '../pipeline-executor';
import {
  buildAgentRecoveryStepResult,
  resolveActionAiCreditsEnv,
  runStep,
} from '../step-runner';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import type {
  CopilotPromptRunnerResult,
  CursorPromptRunnerRequest,
  CursorPromptRunnerResult,
  ExecutionRuntime,
  NormalizedStep,
  ResolvePipelineTargetResult,
} from '../types';

const resolvePlugins = jest.fn<
  ResolvedPluginRuntime,
  [ChatTabPluginSelections, string, string, string, ResolvePluginsOptions?]
>();
/**
 * Lets one transcript line's REQUIRED masking fail. Everything else keeps the
 * real implementation, so the rest of the step behaves normally.
 */
const failMaskingFor: { line: string | undefined } = { line: undefined };
jest.mock('../../../../lib/redaction', () => {
  const actual: typeof redaction = jest.requireActual(
    '../../../../lib/redaction',
  );
  return {
    ...actual,
    redactSerializedJsonLine: (
      line: string,
      values: readonly string[],
    ): string => {
      if (failMaskingFor.line !== undefined && line === failMaskingFor.line)
        throw new Error('masking the transcript record failed');
      return actual.redactSerializedJsonLine(line, values);
    },
  };
});

jest.mock('../../../plugins/plugin-resolver', () => ({
  resolvePlugins: (
    selections: ChatTabPluginSelections,
    projectId: string,
    worktreeId: string,
    chatId: string,
    options?: ResolvePluginsOptions,
  ): ResolvedPluginRuntime =>
    resolvePlugins(selections, projectId, worktreeId, chatId, options),
}));

const runCursorPrompt = jest.fn<
  Promise<CursorPromptRunnerResult>,
  [CursorPromptRunnerRequest]
>();

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
    cursorPromptRunner: { runCursorPrompt },
    resolveModelHarnessInvocation: (model) =>
      Promise.resolve({
        source: 'cursor-managed',
        harness: 'cursor',
        runtimeModel: model ?? '',
        aiCreditsRouted: false,
      }),
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

function cursorStep(withOverrides?: Record<string, unknown>): NormalizedStep {
  return createStep({
    id: 'cursor',
    uses: 'builtin/agent-prompt',
    with: {
      model: 'cursor-default',
      prompt: 'Do it',
      permission_preset: 'read_only',
      ...withOverrides,
    },
  });
}

beforeEach(() => {
  initCursorModels([
    { id: 'cursor-default', rawModelId: 'default[]', label: 'Cursor default' },
  ]);
  runCursorPrompt.mockReset();
  runCursorPrompt.mockResolvedValue({
    status: 'success',
    sessionId: 'cursor-session-1',
    rawText: 'done',
    transcript: '{"type":"system"}\n',
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  resolvePlugins.mockReset();
  resolvePlugins.mockReturnValue({
    warnings: [],
    sdkPlugins: [],
    selectedCapabilityRoots: [],
    mcpServers: {},
  });
});

it('routes a Cursor agent-prompt step to the host Cursor runner with the preset and ids', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cursor-step-runner-'),
  );
  const runtime = createRuntime(tempDir);
  try {
    writeAgentPromptAction(runtime, '');
    const result = await runStep({
      executionId: 'exec-cursor',
      jobId: 'job-1',
      step: cursorStep(),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('success');
    expect(runCursorPrompt).toHaveBeenCalledTimes(1);
    expect(runCursorPrompt.mock.calls[0][0]).toMatchObject({
      model: 'cursor-default',
      permissionPreset: 'read_only',
      stepId: 'cursor',
    });
    expect(runCursorPrompt.mock.calls[0][0].prompt).toContain('Do it');
    expect(result.outputs.session_id).toBe('cursor-session-1');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

it('accepts an authored permission_preset of none on Cursor', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cursor-step-runner-'),
  );
  const runtime = createRuntime(tempDir);
  try {
    writeAgentPromptAction(runtime, '');
    const result = await runStep({
      executionId: 'exec-cursor-none',
      jobId: 'job-1',
      step: cursorStep({ permission_preset: 'none' }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('success');
    expect(runCursorPrompt.mock.calls[0][0].permissionPreset).toBe('none');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

it('fails clearly when no Cursor runner is configured', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cursor-step-runner-'),
  );
  const runtime = createRuntime(tempDir);
  delete runtime.cursorPromptRunner;
  try {
    writeAgentPromptAction(runtime, '');
    // `runStep`'s outer catch maps every thrown guard error (including this
    // one) to a failed `StepResult` rather than rejecting the promise — the
    // same pattern used for the sibling "session_id is required" and
    // "permission_preset none is not supported" Codex guards.
    const result = await runStep({
      executionId: 'exec-cursor-no-runner',
      jobId: 'job-1',
      step: cursorStep(),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('failure');
    expect(result.error).toContain(
      'Cursor pipeline actions require a host Cursor runtime; no runner was configured.',
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

it('passes a resume session id for agent-resume', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cursor-step-runner-'),
  );
  const runtime = createRuntime(tempDir);
  try {
    writeAgentResumeAction(runtime, '');
    const result = await runStep({
      executionId: 'exec-cursor-resume',
      jobId: 'job-1',
      step: createStep({
        id: 'cursor-resume',
        uses: 'builtin/agent-resume',
        with: {
          model: 'cursor-default',
          session_id: 'prev',
          prompt: 'more',
        },
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('success');
    expect(runCursorPrompt.mock.calls[0][0].resumeSessionId).toBe('prev');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

it('requires a session id for agent-resume and never calls the runner without one', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cursor-step-runner-'),
  );
  const runtime = createRuntime(tempDir);
  try {
    writeAgentResumeAction(runtime, '');
    const result = await runStep({
      executionId: 'exec-cursor-resume-missing-session',
      jobId: 'job-1',
      step: createStep({
        id: 'cursor-resume',
        uses: 'builtin/agent-resume',
        with: {
          model: 'cursor-default',
          prompt: 'more',
        },
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('failure');
    expect(result.error).toContain(
      'session_id is required for builtin/agent-resume',
    );
    expect(runCursorPrompt).not.toHaveBeenCalled();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

it('refuses to resume a Cursor session on another provider when the model no longer resolves', async () => {
  // Recovery replays the step's own interpolated `with` block as an
  // agent-resume (`job-runner.ts`), so a checkpoint written by a Cursor step
  // carries that step's `model` expression. It loses its model only when the
  // expression evaluates empty on resume (an env value or input that is now
  // unset). The step then used to fall through to the generic Claude runner
  // carrying a Cursor session id: a silent provider switch. It must stop and
  // say how to resume instead.
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cursor-step-runner-'),
  );
  const runtime = createRuntime(tempDir);
  try {
    writeAgentResumeAction(
      runtime,
      "require('node:fs').writeFileSync(require('node:path').join(process.cwd(), 'generic-runner-ran'), 'yes');",
    );
    const result = await runStep({
      executionId: 'exec-cursor-resume-no-model',
      jobId: 'job-1',
      step: createStep({
        id: 'cursor-resume-no-model',
        uses: 'builtin/agent-resume',
        // Exactly what job-runner synthesizes for continue_session, with
        // the step's model expression having evaluated empty.
        with: {
          model: '',
          session_id: 'prev-session',
          prompt: 'Continue',
          prompt_file: '',
        },
      }),
      cwd: tempDir,
      env: {},
      runtime,
      recoveryCheckpoint: {
        version: 2,
        reason_id: '22222222-2222-4222-8222-222222222222',
        action: 'agent-resume',
        provider: 'cursor',
        harness: 'cursor',
        session_id: 'prev-session',
        had_agent_activity: true,
        strategy: 'continue_session',
        recovery_count: 1,
        paused_at: '2026-08-20T00:00:00.000Z',
        failure_message: 'paused mid-turn',
      },
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('failure');
    expect(result.error).toContain(
      'This step paused while running on Cursor, and its model no longer resolves. Set its model to a Cursor model, then resume.',
    );
    expect(runCursorPrompt).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tempDir, 'generic-runner-ran'))).toBe(false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

it('maps a cancelled result to a cancelled step', async () => {
  runCursorPrompt.mockResolvedValue({
    status: 'cancelled',
    transcript: '',
    failure: {
      version: 1,
      provider: 'cursor',
      agent_harness: 'cursor',
      had_agent_activity: false,
      message: 'Cursor pipeline turn was cancelled.',
    },
  });
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cursor-step-runner-'),
  );
  const runtime = createRuntime(tempDir);
  try {
    writeAgentPromptAction(runtime, '');
    const result = await runStep({
      executionId: 'exec-cursor-cancelled',
      jobId: 'job-1',
      step: cursorStep(),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('cancelled');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

it('keeps recoverable Cursor failures on the recovery path', async () => {
  runCursorPrompt.mockResolvedValue({
    status: 'failure',
    transcript: '{"type":"turn.failed"}\n',
    failure: {
      version: 1,
      provider: 'cursor',
      agent_harness: 'cursor',
      session_id: 'cursor-thread',
      had_agent_activity: true,
      classification: {
        kind: 'provider_usage_limit',
        code: 'rate_limit',
        provider: 'cursor',
        account_scope: 'native',
        diagnostic_message: 'usage exhausted',
      },
      message: 'usage exhausted',
    },
  });
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cursor-step-runner-'),
  );
  const runtime = createRuntime(tempDir);
  try {
    writeAgentPromptAction(runtime, '');
    const result = await runStep({
      executionId: 'exec-cursor-recovery',
      jobId: 'job-1',
      step: cursorStep(),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('paused');
    expect(result.agent_recovery).toMatchObject({
      version: 2,
      provider: 'cursor',
      harness: 'cursor',
      session_id: 'cursor-thread',
      strategy: 'continue_session',
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

it('never resolves the Claude plugin runtime for a Cursor step with a resolved plugin collection, but still warns', async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cursor-step-runner-'),
  );
  const runtime = createRuntime(tempDir);
  try {
    writeAgentPromptAction(runtime, '');
    const result = await runStep({
      executionId: 'exec-cursor-plugins',
      jobId: 'job-1',
      step: cursorStep({ plugin_collection_id: 'demo-collection' }),
      cwd: tempDir,
      env: {},
      runtime,
      resolvedPluginCollections: {
        'demo-collection': {
          selections: {
            collectionIds: ['demo-collection'],
            skillRefs: [],
            pluginRefs: [],
          },
          missingOptionalDefaults: [],
          unresolvedRequiredDefaults: [],
        },
      },
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('success');
    expect(resolvePlugins).not.toHaveBeenCalled();
    expect(runCursorPrompt).toHaveBeenCalledTimes(1);
    expect(runCursorPrompt.mock.calls[0][0].pluginSelections).toMatchObject({
      collectionIds: ['demo-collection'],
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

it('redacts pipeline secret values from an unrecoverable Cursor failure message', async () => {
  runCursorPrompt.mockResolvedValue({
    status: 'failure',
    transcript: '{"type":"turn.failed"}\n',
    failure: {
      version: 1,
      provider: 'cursor',
      agent_harness: 'cursor',
      session_id: 'cursor-thread-secret-failure',
      had_agent_activity: true,
      message: 'Unexpected token, "sekret-token-12345" is not valid JSON.',
    },
  });
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cursor-step-runner-'),
  );
  const runtime = createRuntime(tempDir);
  try {
    writeAgentPromptAction(runtime, '');
    const result = await runStep({
      executionId: 'exec-cursor-failure-secret',
      jobId: 'job-1',
      step: cursorStep(),
      cwd: tempDir,
      env: {},
      secretEnv: { CURSOR_API_TOKEN: 'sekret-token-12345' },
      runtime,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('failure');
    expect(result.error).not.toContain('sekret-token-12345');
    const metadataFile = result.outputs.agent_failure_metadata_file;
    expect(metadataFile).toBeTruthy();
    expect(fs.readFileSync(metadataFile ?? '', 'utf8')).not.toContain(
      'sekret-token-12345',
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

it('redacts pipeline secret values from a Cursor failure classification diagnostic_message', async () => {
  runCursorPrompt.mockResolvedValue({
    status: 'failure',
    transcript: '{"type":"turn.failed"}\n',
    failure: {
      version: 1,
      provider: 'cursor',
      agent_harness: 'cursor',
      session_id: 'cursor-thread-diagnostic-secret',
      had_agent_activity: true,
      classification: {
        kind: 'provider_usage_limit',
        code: 'rate_limit',
        provider: 'cursor',
        account_scope: 'native',
        diagnostic_message: 'rejected credential sekret-token-12345',
      },
      message: 'usage exhausted',
    },
  });
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cursor-step-runner-'),
  );
  const runtime = createRuntime(tempDir);
  try {
    writeAgentPromptAction(runtime, '');
    const result = await runStep({
      executionId: 'exec-cursor-diagnostic-secret',
      jobId: 'job-1',
      step: cursorStep(),
      cwd: tempDir,
      env: {},
      secretEnv: { CURSOR_API_TOKEN: 'sekret-token-12345' },
      runtime,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('paused');
    expect(result.pause_reason?.diagnostic_message).not.toContain(
      'sekret-token-12345',
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

it('redacts pipeline secret values from Cursor rawText/structured/proposedPlan outputs', async () => {
  runCursorPrompt.mockResolvedValue({
    status: 'success',
    sessionId: 'cursor-session-secret',
    rawText: 'The API key is sekret-token-12345.',
    structured: { note: 'sekret-token-12345 embedded' },
    proposedPlan: 'Use sekret-token-12345 to call the API.',
    transcript: '{"type":"system"}\n',
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cursor-step-runner-'),
  );
  const runtime = createRuntime(tempDir);
  try {
    writeAgentPromptAction(runtime, '');
    const result = await runStep({
      executionId: 'exec-cursor-secret',
      jobId: 'job-1',
      step: cursorStep(),
      cwd: tempDir,
      env: {},
      secretEnv: { CURSOR_API_TOKEN: 'sekret-token-12345' },
      runtime,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('success');
    expect(result.outputs.text_response).not.toContain('sekret-token-12345');
    expect(result.outputs.json_response).not.toContain('sekret-token-12345');
    const textFile = result.outputs.text_response_file;
    expect(textFile).toBeTruthy();
    expect(fs.readFileSync(textFile ?? '', 'utf8')).not.toContain(
      'sekret-token-12345',
    );
    const jsonFile = result.outputs.json_response_file;
    expect(jsonFile).toBeTruthy();
    expect(fs.readFileSync(jsonFile ?? '', 'utf8')).not.toContain(
      'sekret-token-12345',
    );
    const planFile = result.outputs.proposed_plan_file;
    expect(planFile).toBeTruthy();
    expect(fs.readFileSync(planFile ?? '', 'utf8')).not.toContain(
      'sekret-token-12345',
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

it('hands the configured secret values to the Cursor runner so streamed text can be masked across chunks', async () => {
  // Each streamed chunk is its own transcript record, so this executor can
  // only mask a value that arrives whole in one record. The runner owns the
  // chunk boundaries (its event projection), so it must receive the same
  // values this executor masks the records with.
  runCursorPrompt.mockResolvedValue({
    status: 'success',
    sessionId: 'cursor-session-values',
    rawText: 'done',
    transcript: '{"type":"system"}\n',
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cursor-step-runner-'),
  );
  const runtime = createRuntime(tempDir);
  try {
    writeAgentPromptAction(runtime, '');
    await runStep({
      executionId: 'exec-cursor-values',
      jobId: 'job-1',
      step: cursorStep(),
      cwd: tempDir,
      env: {},
      secretEnv: {
        CURSOR_API_TOKEN: 'sekret-token-12345',
        OTHER_SECRET: 'another-configured-value',
      },
      runtime,
      signal: new AbortController().signal,
    });
    expect(runCursorPrompt).toHaveBeenCalledTimes(1);
    expect(
      [...(runCursorPrompt.mock.calls[0]?.[0].secretValues ?? [])].sort(),
    ).toEqual(['another-configured-value', 'sekret-token-12345']);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

it('leaves Cursor outputs unchanged when no secret values are configured', async () => {
  runCursorPrompt.mockResolvedValue({
    status: 'success',
    sessionId: 'cursor-session-plain',
    rawText: 'No secrets here.',
    structured: { note: 'plain text' },
    transcript: '{"type":"system"}\n',
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cursor-step-runner-'),
  );
  const runtime = createRuntime(tempDir);
  try {
    writeAgentPromptAction(runtime, '');
    const result = await runStep({
      executionId: 'exec-cursor-plain',
      jobId: 'job-1',
      step: cursorStep(),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('success');
    expect(result.outputs.text_response).toBe('No secrets here.');
    expect(result.outputs.json_response).toBe('{"note":"plain text"}');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('resolveActionAiCreditsEnv with a Cursor-harness model', () => {
  // Every production call site already special-cases a Cursor
  // recoveryCheckpoint before calling in (step-runner.ts :3809/:4579/:4703),
  // so this reaches the helper directly the way a future or misconfigured
  // caller (a model-aware action reached with a Cursor `routingProbe`) could.
  // Cursor bills only through its own account and has no AI-credits routing
  // concept, so this must skip routing rather than call
  // `requireHeadlessHarness('cursor')`, which throws the chat-only message.
  it('skips AI-credits routing instead of throwing the chat-only harness error', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-cursor-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    runtime.resolveAiCreditsRouting = jest.fn(() => Promise.resolve(null));
    const action: ResolvedActionRuntime = {
      definition: {
        name: 'Agent Prompt',
        scopes: ['global', 'directory', 'worktree'],
        inputs: { model: {} },
        runs: { using: 'node', main: 'index.js' },
      },
      actionDir: tempDir,
      manifestPath: path.join(tempDir, 'action.yml'),
    };
    const step = createStep({
      id: 'agent-step',
      uses: 'builtin/agent-prompt',
      with: { prompt: 'hi' },
    });

    try {
      const result = await resolveActionAiCreditsEnv(
        step,
        action,
        runtime,
        {},
        undefined,
        undefined,
        {
          input: 'model',
          probeModel: 'cursor-default',
          displayModel: 'cursor-default',
          source: 'step',
          pin: false,
        },
      );

      expect(result).toEqual({
        env: {},
        secretValues: [],
        routed: false,
        modelGatewayRouted: false,
        accountProxyRouted: false,
      });
      expect(runtime.resolveAiCreditsRouting).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('passes an account proxy route through without calling it AI Credits', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-proxy-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    const proxyEnv = {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4100/codex-gateway/route-1',
      ANTHROPIC_AUTH_TOKEN: 'canopy-loopback-broker',
      ANTHROPIC_API_KEY: '',
    };
    runtime.resolveAiCreditsRouting = jest.fn(() =>
      Promise.resolve({
        provider: 'claude' as const,
        model: 'opus[1m]',
        env: proxyEnv,
        accountProxyRouted: true,
      }),
    );
    const action: ResolvedActionRuntime = {
      definition: {
        name: 'Agent Prompt',
        scopes: ['global', 'directory', 'worktree'],
        inputs: { model: {} },
        runs: { using: 'node', main: 'index.js' },
      },
      actionDir: tempDir,
      manifestPath: path.join(tempDir, 'action.yml'),
    };
    const step = createStep({
      id: 'agent-step',
      uses: 'builtin/router',
      with: { prompt: 'hi' },
    });

    try {
      const result = await resolveActionAiCreditsEnv(step, action, runtime, {});

      expect(result).toMatchObject({
        env: proxyEnv,
        routed: false,
        modelGatewayRouted: false,
        accountProxyRouted: true,
      });
      // The step keeps the model it asked for.
      expect(result.model).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
describe('agent recovery for an account proxy step', () => {
  async function recoverFrom(
    kind:
      | 'provider_authentication_required'
      | 'provider_usage_limit'
      | 'provider_temporarily_unavailable',
    accountProxyRouted: boolean,
  ): Promise<string | undefined> {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-proxy-recovery-'),
    );
    try {
      const metadataFile = path.join(tempDir, 'agent-failure.json');
      fs.writeFileSync(
        metadataFile,
        JSON.stringify({
          version: 1,
          provider: 'claude',
          agent_harness: 'claude',
          had_agent_activity: false,
          classification: {
            kind,
            code: {
              provider_authentication_required: 'unauthorized',
              provider_usage_limit: 'usage_limit_exceeded',
              provider_temporarily_unavailable: 'server_overloaded',
            }[kind],
            provider: 'claude',
            account_scope: 'native',
            diagnostic_message: 'proxy said no',
          },
          message: 'proxy said no',
        }),
      );
      const result = await buildAgentRecoveryStepResult({
        result: {
          status: 'failure',
          conclusion: 'failure',
          outcome: 'failure',
          exit_code: 1,
          error: 'proxy said no',
          outputs: { agent_failure_metadata_file: metadataFile },
          dynamic_env: {},
          log_file: path.join(tempDir, 'agent-step.log'),
        },
        step: createStep({ id: 'agent-step', uses: 'builtin/agent-prompt' }),
        tempDir,
        executionDir: path.join(tempDir, 'execution'),
        attempt: 1,
        iteration: 1,
        jobId: 'job',
        stepId: 'agent-step',
        accountProxyRouted,
      });
      return result?.status;
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  it('fails instead of waiting on a native sign-in or usage limit', async () => {
    // The proxy account's limit or key is not the user's own login, so no
    // native sign-in or usage reset can recover the step.
    await expect(
      recoverFrom('provider_usage_limit', true),
    ).resolves.toBeUndefined();
    await expect(
      recoverFrom('provider_authentication_required', true),
    ).resolves.toBeUndefined();
    await expect(recoverFrom('provider_usage_limit', false)).resolves.toBe(
      'paused',
    );
  });

  it('still pauses on a temporary outage', async () => {
    await expect(
      recoverFrom('provider_temporarily_unavailable', true),
    ).resolves.toBe('paused');
  });
});

describe('durable outputs match the inline field they mirror', () => {
  // Independent review, reproduced: the inline `text_response` used
  // whitespace-insensitive matching while its own durable file copy used
  // verbatim-only matching, so a value the agent echoed with different internal
  // whitespace stayed in the file in cleartext. These assert the FILES, not the
  // helper.
  const CONFIGURED = 'TOKEN  ABC  DEF';
  const ECHOED = 'TOKEN ABC DEF';

  it('masks a reflowed value in every durable Cursor output', async () => {
    runCursorPrompt.mockResolvedValue({
      status: 'success',
      sessionId: 'cursor-session-secret',
      rawText: `The API key is ${ECHOED}.\nsecond line kept\n`,
      structured: { note: `${ECHOED} embedded` },
      proposedPlan: `Use ${ECHOED} to call the API.\n\n- step one\n`,
      transcript: '{"type":"system"}\n',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-cursor-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    try {
      writeAgentPromptAction(runtime, '');
      const result = await runStep({
        executionId: 'exec-cursor-secret',
        jobId: 'job-1',
        step: cursorStep(),
        cwd: tempDir,
        env: {},
        secretEnv: { CURSOR_API_TOKEN: CONFIGURED },
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('success');
      const values = [
        result.outputs.text_response,
        result.outputs.json_response,
        fs.readFileSync(result.outputs.text_response_file ?? '', 'utf8'),
        fs.readFileSync(result.outputs.json_response_file ?? '', 'utf8'),
        fs.readFileSync(result.outputs.proposed_plan_file ?? '', 'utf8'),
      ];
      for (const value of values) {
        expect(value).not.toContain(ECHOED);
        expect(value).not.toContain(CONFIGURED);
      }
      // Masking the file must not flatten it: the durable copies keep the
      // formatting the agent produced.
      expect(
        fs.readFileSync(result.outputs.text_response_file ?? '', 'utf8'),
      ).toContain('second line kept');
      expect(
        fs.readFileSync(result.outputs.proposed_plan_file ?? '', 'utf8'),
      ).toContain('\n- step one');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('masks a reflowed value in durable Cursor failure metadata and keeps its formatting', async () => {
    runCursorPrompt.mockResolvedValue({
      status: 'failure',
      transcript: '{"type":"turn.failed"}\n',
      failure: {
        version: 1,
        provider: 'cursor',
        agent_harness: 'cursor',
        session_id: 'cursor-failure-secret',
        had_agent_activity: true,
        message: `upstream rejected ${ECHOED}\n  at frame one\n  at frame two`,
      },
    });
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-cursor-step-runner-'),
    );
    const runtime = createRuntime(tempDir);
    try {
      writeAgentPromptAction(runtime, '');
      const result = await runStep({
        executionId: 'exec-cursor-failure-secret',
        jobId: 'job-1',
        step: cursorStep(),
        cwd: tempDir,
        env: {},
        secretEnv: { CURSOR_API_TOKEN: CONFIGURED },
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('failure');
      const metadataFile = result.outputs.agent_failure_metadata_file;
      expect(metadataFile).toBeTruthy();
      const metadata = fs.readFileSync(metadataFile ?? '', 'utf8');
      expect(metadata).not.toContain(ECHOED);
      expect(result.error).not.toContain(ECHOED);
      // A provider's multi-line error stays multi-line in the durable file.
      expect(metadata).toContain('at frame one');
      expect(metadata).toContain('\\n');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

it('fails the step when a transcript record cannot be masked, instead of dropping it', async () => {
  // `pushTranscriptLine` swallows whatever `onTranscriptLine` throws, and the
  // streamed-length count advanced BEFORE the masking ran, so a failed record
  // vanished from the durable log and the step still reported success. Masking
  // and the durable append are required work; only live emission is
  // best-effort.
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cursor-transcript-fail-'),
  );
  const runtime = createRuntime(tempDir);
  const doomed = '{"type":"assistant","text":"second"}';
  failMaskingFor.line = doomed;
  runCursorPrompt.mockImplementation((request) => {
    request.onTranscriptLine?.('{"type":"system"}');
    request.onTranscriptLine?.(doomed);
    return Promise.resolve({
      status: 'success',
      sessionId: 'cursor-session-1',
      rawText: 'done',
      transcript: `{"type":"system"}\n${doomed}\n`,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });
  try {
    writeAgentPromptAction(runtime, '');
    const result = await runStep({
      executionId: 'exec-cursor-transcript-fail',
      jobId: 'job-1',
      step: cursorStep(),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('failure');
    expect(result.error).toContain('masking the transcript record failed');
  } finally {
    failMaskingFor.line = undefined;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('Cursor records at the step transcript and live output', () => {
  // The real event projection feeds the real step: masked records are what
  // land in `transcript_file` and in live step output. The last records are
  // left out of the live stream so they arrive through the transcript
  // remainder, the other path a record takes into the same sinks.
  type Update = SessionNotification['update'];
  const runWith = async (
    secret: string | readonly string[],
    updates: readonly Update[],
  ): Promise<{
    status: string;
    textResponse: string | undefined;
    disk: string[];
    live: string[];
  }> => {
    runCursorPrompt.mockImplementation((request) => {
      const projection = new CursorEventProjection(undefined, {
        secretValues: request.secretValues,
      });
      const rows: string[] = [];
      const emit = (event: Record<string, unknown>): void => {
        rows.push(JSON.stringify(event));
      };
      for (const update of updates) {
        const event = projection.update({ sessionId: 's', update });
        for (const flushed of projection.takeFlushed()) emit(flushed);
        if (event) emit(event);
      }
      const streamed = rows.length;
      for (const event of projection.finish()) emit(event);
      for (const row of rows.slice(0, Math.max(0, streamed - 1)))
        request.onTranscriptLine?.(row);
      return Promise.resolve({
        status: 'success',
        sessionId: 'cursor-session-sinks',
        rawText: projection.getResponseText(),
        transcript: `${rows.join('\n')}\n`,
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    });
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-cursor-sinks-'),
    );
    const live: string[] = [];
    try {
      const runtime = createRuntime(tempDir);
      writeAgentPromptAction(runtime, '');
      const result = await runStep({
        executionId: 'exec-cursor-sinks',
        jobId: 'job-1',
        step: cursorStep(),
        cwd: tempDir,
        env: {},
        secretEnv: Object.fromEntries(
          (typeof secret === 'string' ? [secret] : secret).map(
            (value, index) => [`SYNTHETIC_VALUE_${String(index)}`, value],
          ),
        ),
        runtime,
        signal: new AbortController().signal,
        onStepOutput: (event) => live.push(event.data),
      });
      const file = result.outputs.transcript_file;
      return {
        status: result.status,
        textResponse: result.outputs.text_response,
        disk: fs
          .readFileSync(typeof file === 'string' ? file : '', 'utf8')
          .split('\n')
          .filter((line) => line.length > 0),
        live: live
          .join('')
          .split('\n')
          .filter((line) => line.length > 0),
      };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
  type Patch = {
    index?: number;
    appendText?: string;
    block?: {
      type?: string;
      text?: string;
      input?: string;
      output?: string;
      display?: { input?: string };
    };
  };
  const patchesOf = (lines: readonly string[]): Patch[] =>
    lines.flatMap((line) => {
      const parsed: unknown = JSON.parse(line);
      return typeof parsed === 'object' &&
        parsed !== null &&
        'patches' in parsed &&
        Array.isArray(parsed.patches)
        ? parsed.patches.filter(
            (patch): patch is Patch =>
              typeof patch === 'object' && patch !== null,
          )
        : [];
    });
  /** Every tool value a consumer reads after decoding the nested JSON. */
  const toolValues = (lines: readonly string[]): unknown[] =>
    patchesOf(lines).flatMap((patch) =>
      [patch.block?.input, patch.block?.display?.input, patch.block?.output]
        .filter((field): field is string => typeof field === 'string')
        .map((field): unknown => JSON.parse(field)),
    );
  /** The streamed response text, patch by patch, in record order. */
  const streamedText = (lines: readonly string[]): string =>
    patchesOf(lines)
      .map((patch) => patch.appendText ?? patch.block?.text ?? '')
      .join('');

  it.each([
    ['multi-line', 'SYNTHETIC-KEY-ABC\nDEF-GHI-123'],
    ['quoted', 'SYNTHETIC-KEY-"ABCDEF123'],
    ['backslash', 'SYNTHETIC-KEY-ABC\\DEF123'],
    ['plain', 'SYNTHETIC-KEY-ABCDEF123'],
  ])(
    'masks a %s value in tool input, display and output',
    async (_name, secret) => {
      const { status, disk, live } = await runWith(secret, [
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          title: 'Write',
          kind: 'edit',
          status: 'pending',
          rawInput: { path: '/w/fixture.txt', content: secret },
        },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-1',
          status: 'failed',
          rawOutput: { stdout: `saw ${secret}` },
        },
      ]);
      expect(status).toBe('success');
      const expected = [
        { path: '/w/fixture.txt', content: '***' },
        { content: '***', file_path: '/w/fixture.txt' },
        { path: '/w/fixture.txt', content: '***' },
        { content: '***', file_path: '/w/fixture.txt' },
        { stdout: 'saw ***' },
      ];
      expect(toolValues(disk)).toEqual(expected);
      expect(toolValues(live)).toEqual(expected);
    },
  );

  it.each(['agent_message_chunk', 'agent_thought_chunk'] as const)(
    'masks a reflowed value streamed as %s',
    async (sessionUpdate) => {
      const result = await runWith(
        'SYNTHETIC  TOKEN  ABCDEF',
        ['value: SYNTHETIC ', 'TOKEN ', 'ABCDEF done'].map(
          (text): Update => ({
            sessionUpdate,
            content: { type: 'text', text },
          }),
        ),
      );
      expect(result.status).toBe('success');
      expect(streamedText(result.disk)).toBe('value: *** done');
      expect(streamedText(result.live)).toBe('value: *** done');
    },
  );

  it('masks a response value split by a tool call', async () => {
    const result = await runWith('SYNTHETIC-CROSS-BLOCK-123456', [
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'value: SYNTHETIC-CROSS-' },
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'read-1',
        title: 'Read',
        kind: 'read',
        status: 'pending',
        rawInput: { path: '/fixture/ordinary.txt' },
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'read-1',
        status: 'completed',
        rawOutput: 'ordinary tool result',
      },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'BLOCK-123456 done' },
      },
    ]);
    expect(result.status).toBe('success');
    expect(result.textResponse).toBe('value: *** done');
    expect(streamedText(result.disk)).toBe('value: *** done');
    expect(streamedText(result.live)).toBe('value: *** done');
    expect(result.disk.join('\n')).not.toContain('CROSS-');
    expect(result.live.join('\n')).not.toContain('CROSS-');
  });

  it.each(['agent_message_chunk', 'agent_thought_chunk'] as const)(
    'masks a whole URL whose password is configured too, streamed as %s',
    async (sessionUpdate) => {
      const url = 'postgres://admin:S3cretPass@db.internal:5432/app';
      const result = await runWith(
        ['S3cretPass', url],
        [{ sessionUpdate, content: { type: 'text', text: `DB is ${url} ok` } }],
      );
      expect(result.status).toBe('success');
      expect(streamedText(result.disk)).toBe('DB is *** ok');
      expect(streamedText(result.live)).toBe('DB is *** ok');
      expect(result.disk.join('\n')).not.toContain('db.internal');
    },
  );

  it.each(['agent_message_chunk', 'agent_thought_chunk'] as const)(
    'masks a whitespace-only value split across %s deltas',
    async (sessionUpdate) => {
      const result = await runWith(
        '      ',
        ['before   ', '   after'].map(
          (text): Update => ({
            sessionUpdate,
            content: { type: 'text', text },
          }),
        ),
      );
      expect(result.status).toBe('success');
      expect(streamedText(result.disk)).toBe('before***after');
      expect(streamedText(result.live)).toBe('before***after');
    },
  );

  it('leaves ordinary text and tools exactly as the provider sent them', async () => {
    const result = await runWith('SYNTHETIC-KEY-ABCDEF123', [
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'plain  text\n\twith layout ' },
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'read-1',
        title: 'Read',
        kind: 'read',
        status: 'completed',
        rawInput: { path: '/w/a "b" \\ c' },
        rawOutput: 'line one\nline two',
      },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'end' },
      },
    ]);
    expect(streamedText(result.disk)).toBe('plain  text\n\twith layout end');
    expect(toolValues(result.disk)).toEqual([
      { path: '/w/a "b" \\ c' },
      { file_path: '/w/a "b" \\ c' },
      'line one\nline two',
    ]);
    expect(result.live).toEqual(result.disk);
  });
});

it.each(['directory', 'worktree', 'global'] as const)(
  'carries trusted %s execution scope separately from effective step cwd',
  async (scope) => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'pipeline-policy-scope-'),
    );
    const runtime = createRuntime(tempDir);
    fs.mkdirSync(path.join(tempDir, 'desktop'));
    try {
      writeAgentPromptAction(runtime, '');
      const result = await runStep({
        executionId: 'policy-scope',
        jobId: 'job',
        step: { ...cursorStep(), working_directory: 'desktop' },
        cwd: tempDir,
        env: {},
        runtime,
        scope,
        repoPath: path.join(tempDir, 'wrong-source-checkout'),
        target:
          scope === 'global'
            ? { scope: 'global' }
            : scope === 'directory'
              ? { scope: 'directory', path: tempDir }
              : {
                  scope: 'worktree',
                  path: tempDir,
                  workspace_id: 'workspace',
                  worktree_id: 'worktree',
                  created: false,
                },
        signal: new AbortController().signal,
      });
      expect(result.status).toBe('success');
      expect(runCursorPrompt.mock.calls[0][0]).toMatchObject({
        cwd: path.join(tempDir, 'desktop'),
        repositoryPolicyScope:
          scope === 'global'
            ? { kind: 'rootless' }
            : { kind: 'checkout', root: tempDir },
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);

it.each([
  'working_directory',
  'legacy cwd',
  'explicit directory',
  'global',
  'deeper nesting',
  'switched worktree',
  'legacy rerun',
  'legacy retry',
  'legacy resume',
  'trusted legacy resume',
  'unknown rerun',
  'unknown retry',
  'unknown resume',
] as const)(
  'keeps selected checkout policy across nested Copilot execution with %s',
  async (mode) => {
    const legacyRecovery = mode.includes('legacy') && mode !== 'legacy cwd';
    const unknownRecovery = mode.startsWith('unknown');
    const recovery = legacyRecovery || unknownRecovery;
    const tempDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nested-policy-')),
    );
    const checkout = path.join(tempDir, 'checkout');
    const desktop = path.join(checkout, 'desktop');
    fs.mkdirSync(desktop, { recursive: true });
    fs.writeFileSync(path.join(checkout, 'CLAUDE.md'), 'R');
    fs.writeFileSync(path.join(desktop, 'AGENTS.md'), 'D');
    const otherCheckout = path.join(tempDir, 'other-checkout');
    fs.mkdirSync(otherCheckout);
    fs.writeFileSync(path.join(otherCheckout, 'CLAUDE.md'), 'OTHER');
    const selectedCheckout =
      mode === 'switched worktree' ? otherCheckout : checkout;
    const runtime = createRuntime(tempDir);
    runtime.bundledActionsDir = path.resolve(
      'packages/desktop-shared/resources/actions',
    );
    initCopilotModels([
      {
        id: 'copilot:test',
        rawModelId: 'test',
        label: 'Copilot test',
        supportsVision: false,
        supportedThinkingLevels: [],
      },
    ]);
    runtime.resolvePipelineTarget = (): Promise<ResolvePipelineTargetResult> =>
      Promise.resolve({
        cwd: selectedCheckout,
        scope: 'worktree',
        target: {
          scope: 'worktree',
          path: selectedCheckout,
          workspace_id: 'workspace',
          worktree_id: 'worktree',
          created: false,
        },
        repoPath: path.join(tempDir, 'source-is-not-execution-root'),
      });
    expect(getExecutionHarnessForModel(resolveModelAlias('copilot:test'))).toBe(
      'copilot',
    );
    const childPipelineYaml = [
      'name: Child',
      'scope: [worktree, directory, global]',
      'on: dispatch',
      'jobs:',
      '  child:',
      '    steps:',
      '      - id: prompt',
      '        uses: builtin/agent-prompt',
      '        with:',
      '          model: copilot:test',
      '          prompt: Do it',
    ].join('\n');
    const nestedPipelineYaml = [
      'name: Middle',
      'scope: worktree',
      'on: dispatch',
      'jobs:',
      '  middle:',
      '    steps:',
      '      - id: nested',
      '        uses: builtin/run-pipeline',
      '        with:',
      `          pipeline_yaml: ${JSON.stringify(childPipelineYaml)}`,
    ].join('\n');
    const child = normalizePipeline(parsePipelineText(childPipelineYaml), {
      defaultShell: 'bash',
    });
    expect(child.jobs.child.steps[0].with?.model).toBe('copilot:test');
    const output: string[] = [];
    const prepared: Awaited<ReturnType<typeof resolveHostRepositoryPolicy>>[] =
      [];
    runtime.copilotPromptRunner = {
      runCopilotPrompt: async (request): Promise<CopilotPromptRunnerResult> => {
        const policy = await resolveHostRepositoryPolicy(
          request.repositoryPolicyScope,
          request.cwd,
        );
        prepared.push(policy);
        return policy.status === 'delivered' || policy.status === 'absent'
          ? {
              status: 'success',
              sessionId: 'policy-session',
              rawText: 'done',
              transcript: '',
              usage: { inputTokens: 0, outputTokens: 0 },
            }
          : {
              status: 'failure',
              transcript: '',
              failure: {
                version: 1,
                provider: 'copilot',
                had_agent_activity: false,
                message: policy.message,
              },
            };
      },
    };
    try {
      const result = await runStep({
        executionId: 'nested-policy',
        jobId: 'job',
        step: createStep({
          id: 'nested',
          uses: 'builtin/run-pipeline',
          ...(mode === 'working_directory' ||
          mode === 'deeper nesting' ||
          recovery
            ? { working_directory: 'desktop' }
            : {}),
          ...(mode === 'explicit directory'
            ? { target: { scope: 'directory', path: 'desktop' } }
            : {}),
          ...(mode === 'global' ? { target: { scope: 'global' } } : {}),
          ...(mode === 'switched worktree'
            ? {
                target: {
                  scope: 'worktree',
                  workspace_id: 'workspace',
                  worktree: { id: 'other' },
                },
              }
            : {}),
          with: {
            ...(mode === 'legacy cwd' ? { cwd: 'desktop' } : {}),
            pipeline_yaml:
              mode === 'deeper nesting'
                ? nestedPipelineYaml
                : childPipelineYaml,
          },
        }),
        cwd: checkout,
        env: {},
        runtime,
        scope: 'worktree',
        onStepOutput: (event) => {
          output.push(event.data);
        },
        repoPath: path.join(tempDir, 'source-is-not-execution-root'),
        target: {
          scope: 'worktree',
          path: checkout,
          workspace_id: 'workspace',
          worktree_id: 'worktree',
          created: false,
        },
        projectId: 'workspace',
        worktreeId: 'worktree',
        signal: new AbortController().signal,
      });
      if (result.status !== 'success')
        throw new Error(JSON.stringify({ result, output }));
      expect(prepared).toHaveLength(1);
      if (!result.child_execution_id)
        throw new Error('Child execution id missing');
      const childState = await loadExecutionState(
        result.child_execution_id,
        runtime.executionsDir,
      );
      expect(childState?.execution_checkout_root).toBe(
        mode === 'global'
          ? undefined
          : mode === 'explicit directory'
            ? desktop
            : selectedCheckout,
      );
      if (mode === 'global') {
        expect(prepared[0].status).toBe('absent');
      } else {
        expect(prepared[0].status).toBe('delivered');
        const block =
          prepared[0].status === 'delivered' ? prepared[0].block : '';
        if (mode === 'switched worktree') {
          expect(block).toContain('### CLAUDE.md\nOTHER');
          expect(block).not.toContain('### CLAUDE.md\nR');
        } else {
          expect(block).toContain(
            mode === 'explicit directory'
              ? '### AGENTS.md\nD'
              : '### desktop/AGENTS.md\nD',
          );
          if (mode === 'explicit directory')
            expect(block).not.toContain('### CLAUDE.md\nR');
          else expect(block).toContain('### CLAUDE.md\nR');
        }
      }
      if (mode === 'working_directory' || recovery) {
        if (!childState) throw new Error('Child state missing');
        const rootPipeline = parsePipelineText(
          mode.endsWith('rerun') ? nestedPipelineYaml : childPipelineYaml,
        );
        if (recovery) {
          for (const job of Object.values(rootPipeline.jobs))
            job.steps[0].working_directory = 'desktop';
        }
        const rootRun = await executePipeline(rootPipeline, {
          pipelineId: 'root-policy-replay',
          projectId: 'workspace',
          worktreeId: 'worktree',
          cwd: recovery ? checkout : childState.cwd,
          scope: childState.scope,
          target:
            recovery && childState.target?.scope === 'worktree'
              ? { ...childState.target, path: checkout }
              : childState.target,
          executionCheckoutRoot: childState.execution_checkout_root,
          runtime,
        });
        const rootState = await rootRun.waitForCompletion();
        expect(rootState.status).toBe('success');
        if (recovery) {
          if (unknownRecovery) rootState.execution_checkout_root = null;
          else delete rootState.execution_checkout_root;
          const recovering = !mode.endsWith('rerun');
          if (recovering) {
            rootState.status = mode.endsWith('retry') ? 'failure' : 'running';
            rootState.jobs.child.status = mode.endsWith('retry')
              ? 'failure'
              : 'pending';
            rootState.jobs.child.steps = {};
          }
          await saveExecutionState(rootState, runtime.executionsDir);
          const recover = mode.endsWith('rerun')
            ? rerunPipelineExecution
            : mode.endsWith('retry')
              ? retryPipelineExecution
              : resumePipeline;
          const recovered = await recover(rootState.id, {
            cwd: checkout,
            runtime,
            ...(mode === 'trusted legacy resume'
              ? { executionCheckoutRoot: checkout }
              : {}),
          });
          const recoveredState = await recovered.waitForCompletion();
          if (!unknownRecovery) {
            expect(recoveredState.status).toBe('success');
            expect(prepared[2]).toEqual(prepared[0]);
          } else {
            expect(recoveredState.status).toBe('failure');
            expect(prepared[2].status).toBe('unreadable');
            if (prepared[2].status !== 'unreadable')
              throw new Error('Expected unreadable repository policy');
            expect(prepared[2].message).toContain('checkout is unknown');
            expect(prepared[2].message).toContain('Start over');
            if (mode === 'unknown rerun') {
              const repeated = await rerunPipelineExecution(recoveredState.id, {
                cwd: checkout,
                runtime,
              });
              const repeatedState = await repeated.waitForCompletion();
              expect(repeatedState.status).toBe('failure');
              expect(repeatedState.execution_checkout_root).toBeNull();
              expect(prepared[3]).toEqual(prepared[2]);
            }
          }
          return;
        }
        const replay = await rerunPipelineExecution(rootState.id, {
          cwd: checkout,
          runtime,
        });
        expect((await replay.waitForCompletion()).status).toBe('success');
        expect(prepared).toHaveLength(3);
        expect(prepared[1]).toEqual(prepared[0]);
        expect(prepared[2]).toEqual(prepared[0]);
      }
    } finally {
      initCopilotModels([]);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);
