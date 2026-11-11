// CAN-5095: an owner-bound daemon run's Claude and Codex steps run in the
// pipeline host, asking their owner (played here, as the supervisor) for
// routes, the organization policy and Ledger tools through owner requests.
// The steps run the real staged claude and codex CLIs against the
// UI-automation mock LLM server. This is the host side of an ownerBound
// worker.pipeline.execution.start, and each owner request goes out on
// worker.pipeline.hostRequests and is settled by worker.pipeline.hostRequest.respond.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ConnectedExecutionHostChannel } from '@canopy/core-platform/execution-host/channel';
import type {
  PipelineHostLaunch,
  PipelineHostMessage,
  PipelineHostRequest,
} from '@canopy/core-runtime/node/pipeline/host';
import {
  WorkerPipelineHostLaunchSchema,
  WORKER_PIPELINE_MODEL_CATALOG_MAX_BYTES,
  type CanopyJsonValue,
  type WorkerPipelineHostLaunch,
  type WorkerPipelineHostRequest,
  type WorkerPipelineOwnerResult,
  type WorkerPipelineOwnerValues,
} from '@canopy/protocol/canopy-core';
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  initClaudeModels,
  initCodexModels,
  initModelHarnessAssignments,
  initOllamaModels,
} from '@canopy/desktop-shared/types';
import { serializePipelinePreferenceLocator } from '@canopy/execution-engine/pipelines/plugin-collections';
import { loadExecutionState } from '../../executor/execution-state';
import { buildModelRegistrySnapshot } from '@canopy/execution-engine/node/pipelines/executor/model-registry-snapshot';
import {
  createPipelineOwnerClient,
  type PipelineOwnerClient,
} from '../owner-client';
import { createDaemonPipelineOwnerPorts } from '../owner-ports';
import { servePipelineHost } from '../server';

jest.setTimeout(180_000);

const ROOT = resolve(__dirname, '../../../../../../..');
const BIN_DIR = join(
  ROOT,
  '.cache',
  'bin',
  `${process.platform}-${process.arch}`,
);
const CLAUDE = join(BIN_DIR, 'claude');
const CODEX = join(BIN_DIR, 'codex');
const BRAND = process.env.CANOPY_BRAND ?? 'canopy';
const BUILT_ACTIONS = join(
  ROOT,
  '.cache',
  'brand',
  BRAND,
  'resources',
  'actions',
);
const SCENARIO = 'mock-5095';
const OLLAMA = 'ollama-qwen3-coder';
const NO_PLUGINS = { collectionIds: [], skillRefs: [], pluginRefs: [] };
const REPLY = 'daemon-model-reply';

class MemoryChannel
  extends EventEmitter
  implements ConnectedExecutionHostChannel
{
  readonly posted: PipelineHostMessage[] = [];

  postMessage(message: PipelineHostMessage): void {
    this.posted.push(message);
    super.emit('posted', message);
  }

  exit(): void {}

  congested(): boolean {
    return false;
  }

  onceDrained(listener: () => void): void {
    listener();
  }

  onDisconnect(): void {}
}

type OwnerAnswer =
  | {
      readonly value: WorkerPipelineOwnerResult;
      readonly values?: Omit<WorkerPipelineOwnerValues, 'requestId'>;
    }
  | { readonly failure: string }
  | 'unavailable'
  | 'silent';

type OwnerTable = (request: WorkerPipelineHostRequest) => OwnerAnswer;

let nextId = 1;
let channel: MemoryChannel;
let dataRoot: string;
let worktree: string;
let home: string;
/** The app's bundled resources, with one builtin skill (CAN-5832). */
let resources: string;
let mock: { origin: string; child: ChildProcess };
let owner: OwnerTable;
let ownerSaw: string[];
const savedEnv = { ...process.env };

function request(op: PipelineHostRequest): Promise<PipelineHostMessage> {
  const id = nextId++;
  return new Promise((done) => {
    const listener = (message: PipelineHostMessage): void => {
      if (message.kind !== 'response' || message.id !== id) return;
      channel.off('posted', listener);
      done(message);
    };
    channel.on('posted', listener);
    channel.emit('message', { data: { id, request: op } });
  });
}

/** The test owner: answers each owner request the host raises from `owner`. */
function answerOwnerRequests(message: PipelineHostMessage): void {
  if (message.kind !== 'hostRequest') return;
  const raised = message.request;
  ownerSaw.push(raised.request.action);
  const answer = owner(raised);
  if (answer === 'silent') return;
  void request({
    op: 'hostSettled',
    requestId: raised.requestId,
    settlement:
      answer === 'unavailable'
        ? { kind: 'unavailable' }
        : {
            kind: 'owner',
            settlement:
              'failure' in answer
                ? {
                    result: {
                      status: 'failure',
                      failureReason: null,
                      message: answer.failure,
                      outputs: {},
                    },
                  }
                : {
                    result: { status: 'owner', value: answer.value },
                    ...(answer.values && {
                      values: { ...answer.values, requestId: raised.requestId },
                    }),
                  },
          },
  });
}

/** Answers every owner request as an unrouted, unpoliced step with no Ledger. */
function defaultOwner(raised: WorkerPipelineHostRequest): OwnerAnswer {
  const body = raised.request;
  switch (body.action) {
    case 'owner.model.policy':
      return { value: { kind: 'model.policy', answer: false } };
    case 'owner.model.routing':
      return { value: { kind: 'model.routing', override: null } };
    case 'owner.model.release':
      return { value: { kind: 'model.release' } };
    case 'owner.model.policyRefusal':
      return { value: { kind: 'model.policyRefusal' } };
    case 'owner.ledger.open':
      return { value: { kind: 'ledger.open', attempt: null } };
    case 'owner.ledger.codexTools':
      return { value: { kind: 'ledger.codexTools', tools: null } };
    case 'owner.claude.modAdmission':
      return { value: { kind: 'claude.modAdmission', context: null } };
    default:
      return { failure: 'The test owner does not answer this.' };
  }
}

function claudeRouteEnv(): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: mock.origin,
    ANTHROPIC_AUTH_TOKEN: SCENARIO,
    ANTHROPIC_API_KEY: SCENARIO,
  };
}

function codexConfig(): Record<string, CanopyJsonValue> {
  return {
    model_provider: 'canopy-mock',
    model_providers: {
      'canopy-mock': {
        name: 'Canopy Mock',
        base_url: `${mock.origin}/v1`,
        wire_api: 'responses',
        requires_openai_auth: false,
        env_key: 'CANOPY_MOCK_API_KEY',
      },
    },
  };
}

function snapshot(): NonNullable<WorkerPipelineHostLaunch['modelCatalog']> {
  return buildModelRegistrySnapshot();
}

function launchOf(
  executionId: string,
  steps: CanopyJsonValue[],
  extra: Partial<WorkerPipelineHostLaunch> = {},
): PipelineHostLaunch {
  return {
    params: {
      executionId,
      pipelineId: 'pipeline',
      definitionSource: 'inline',
      runScope: 'worktree',
      workspaceId: 'workspace',
      worktreeId: 'worktree',
      owner: 'personal',
      initiationSource: 'user',
    },
    launch: {
      pipeline: { name: 'Daemon run', on: 'dispatch', jobs: { j: { steps } } },
      cwd: worktree,
      repoPath: worktree,
      bundledActionsDir: BUILT_ACTIONS,
      env: {},
      secretEnv: {},
      ownerBound: true,
      providerBinaries: { claude: CLAUDE, codex: CODEX },
      bundledResourcesDir: resources,
      modelCatalog: snapshot(),
      ...extra,
    },
    processEnvironment: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
    },
  };
}

function waitFor<M extends PipelineHostMessage>(
  predicate: (message: PipelineHostMessage) => message is M,
): Promise<M> {
  const found = channel.posted.find(predicate);
  if (found) return Promise.resolve(found);
  return new Promise((done) => {
    const listener = (message: PipelineHostMessage): void => {
      if (!predicate(message)) return;
      channel.off('posted', listener);
      done(message);
    };
    channel.on('posted', listener);
  });
}

type ExecutionMessage = Extract<PipelineHostMessage, { kind: 'execution' }>;

function executionIn(
  executionId: string,
  statuses: readonly string[],
): Promise<ExecutionMessage> {
  return waitFor(
    (message): message is ExecutionMessage =>
      message.kind === 'execution' &&
      message.executionId === executionId &&
      statuses.includes(message.execution.status),
  );
}

async function storedStep(
  executionId: string,
  stepId: string,
): Promise<{
  status?: string;
  error?: string;
  outputs?: Record<string, string>;
}> {
  const stored = await loadExecutionState(
    executionId,
    join(dataRoot, 'pipeline-executions'),
  );
  const step = stored?.jobs.j?.steps?.[stepId];
  return { status: step?.status, error: step?.error, outputs: step?.outputs };
}

function stepLogs(executionId: string): string {
  const logs = join(dataRoot, 'pipeline-executions', executionId, 'logs');
  return readdirSync(logs)
    .map((file) => readFileSync(join(logs, file), 'utf8'))
    .join('\n');
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

/** The UI-automation mock server; its entry starts listening on import, so it runs as a child. */
async function startMockServer(): Promise<{
  origin: string;
  child: ChildProcess;
}> {
  const origin = `http://127.0.0.1:${await unusedPort()}`;
  const child = spawn(
    process.execPath,
    [join(ROOT, 'apps/desktop-app/tests/electron/mock-server/start.mjs')],
    {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        CANOPY_E2E_MOCK_BASE_URL: origin,
      },
      stdio: 'ignore',
    },
  );
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${origin}/healthz`)).ok) return { origin, child };
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  child.kill();
  throw new Error('The mock server did not start.');
}

async function mockRequests(): Promise<unknown[]> {
  const response = await fetch(
    `${mock.origin}/__mock/requests?key=${encodeURIComponent(SCENARIO)}`,
  );
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || !('requests' in body))
    return [];
  const requests: unknown = body.requests;
  return Array.isArray(requests) ? requests.map((entry: unknown) => entry) : [];
}

const agentPrompt = (
  extra: Record<string, CanopyJsonValue> = {},
): Record<string, CanopyJsonValue> => ({
  id: 'ask',
  uses: 'builtin/agent-prompt',
  with: { prompt: 'Say hello.', ...extra },
});

beforeAll(async () => {
  // Section 6, item 7: the real CLIs, never a skip or a stub.
  for (const binary of [CLAUDE, CODEX])
    if (!existsSync(binary))
      throw new Error(`The staged provider CLI is missing: ${binary}`);
  const built = spawnSync(
    process.execPath,
    [join(ROOT, 'scripts/build-builtin-actions.mjs')],
    { cwd: ROOT, stdio: 'ignore' },
  );
  if (built.status !== 0) throw new Error('The builtin actions did not build.');
  home = realpathSync(mkdtempSync(join(tmpdir(), 'host-model-home-')));
  resources = realpathSync(mkdtempSync(join(tmpdir(), 'host-model-res-')));
  mkdirSync(join(resources, 'skills', 'canopy-5832-skill'), {
    recursive: true,
  });
  writeFileSync(
    join(resources, 'skills', 'canopy-5832-skill', 'SKILL.md'),
    '---\nname: canopy-5832-skill\ndescription: A builtin test skill.\n---\nSay hello.\n',
  );
  mkdirSync(join(home, '.codex'));
  // App-servers take their Codex home from the host process only.
  process.env.CODEX_HOME = join(home, '.codex');
  mock = await startMockServer();
  const registered = await fetch(`${mock.origin}/__mock/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      key: SCENARIO,
      scenario: { llm: { steps: [{ text: REPLY, stopReason: 'end_turn' }] } },
    }),
  });
  if (!registered.ok) throw new Error('The mock scenario did not register.');
  initClaudeModels([{ id: DEFAULT_CLAUDE_MODEL, label: 'Claude default' }]);
  initCodexModels([{ id: DEFAULT_CODEX_MODEL, label: 'Codex default' }]);
  initOllamaModels([
    {
      id: OLLAMA,
      rawModelId: 'qwen3-coder',
      label: 'qwen3-coder',
      show: { capabilities: ['completion', 'tools'] },
    },
  ]);
});

afterAll(() => {
  mock?.child.kill();
  rmSync(home, { recursive: true, force: true });
  rmSync(resources, { recursive: true, force: true });
  for (const key of Object.keys(process.env))
    if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

beforeEach(async () => {
  dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'host-model-data-')));
  worktree = realpathSync(mkdtempSync(join(tmpdir(), 'host-model-tree-')));
  process.env.CANOPY_DATA_DIR = dataRoot;
  owner = defaultOwner;
  ownerSaw = [];
  channel = new MemoryChannel();
  channel.on('posted', answerOwnerRequests);
  servePipelineHost({ channel, inspectProcess: null });
  expect(
    await request({
      op: 'configure',
      dataRoot,
      codexMcpLauncher: { command: process.execPath, args: [] },
    }),
  ).toMatchObject({ ok: true });
});

afterEach(async () => {
  await request({ op: 'checkpoint' });
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(worktree, { recursive: true, force: true });
});

describe('daemon pipeline host model steps (CAN-5095)', () => {
  it('a Claude agent step asks its owner for its route and runs on it', async () => {
    owner = (raised): OwnerAnswer => {
      const body = raised.request;
      if (body.action === 'owner.model.routing')
        return {
          value: {
            kind: 'model.routing',
            override: {
              provider: 'claude',
              model: body.model ?? DEFAULT_CLAUDE_MODEL,
              modelGatewayRouted: false,
              accountProxyRouted: true,
              accountProxyConnectionId: 'conn-1',
            },
          },
          values: { env: claudeRouteEnv() },
        };
      if (body.action === 'owner.model.invocation')
        return {
          value: {
            kind: 'model.invocation',
            source: 'claude-managed',
            harness: 'claude',
            runtimeModel: body.model ?? DEFAULT_CLAUDE_MODEL,
            aiCreditsRouted: false,
            modelGatewayRouted: false,
            accountProxyRouted: false,
          },
        };
      return defaultOwner(raised);
    };
    expect(
      await request({ op: 'start', start: launchOf('run-1', [agentPrompt()]) }),
    ).toMatchObject({ ok: true });
    await executionIn('run-1', ['success', 'failure']);
    const step = await storedStep('run-1', 'ask');
    expect(step.status).toBe('success');
    expect(stepLogs('run-1')).toContain(REPLY);
    // The CLI reached the mock with the route's own key, and no stored
    // record holds the route URL (only a status reason keeps the connection).
    expect((await mockRequests()).length).toBeGreaterThan(0);
    expect(
      readFileSync(join(dataRoot, 'pipeline-executions', 'run-1.json'), 'utf8'),
    ).not.toContain(mock.origin);
    expect(ownerSaw).toContain('owner.model.routing');
    expect(ownerSaw).toContain('owner.model.release');
  });

  it("a Codex agent step runs on the host's own runtime", async () => {
    owner = (raised): OwnerAnswer => {
      const body = raised.request;
      if (body.action === 'owner.model.invocation')
        return {
          value: {
            kind: 'model.invocation',
            source: 'codex-managed',
            harness: 'codex',
            runtimeModel: body.model ?? DEFAULT_CODEX_MODEL,
            aiCreditsRouted: false,
            modelGatewayRouted: false,
            accountProxyRouted: false,
          },
          values: { codexConfig: codexConfig() },
        };
      return defaultOwner(raised);
    };
    expect(
      await request({
        op: 'start',
        start: launchOf(
          'run-1',
          [
            agentPrompt({
              model: DEFAULT_CODEX_MODEL,
              permission_preset: 'read_only',
            }),
          ],
          {
            codexEnvironment: {
              environment: { CANOPY_MOCK_API_KEY: SCENARIO },
              logicalWorkspaceEnvironmentId: 'test',
            },
          },
        ),
      }),
    ).toMatchObject({ ok: true });
    const settled = await executionIn('run-1', ['success', 'failure']);
    const step = await storedStep('run-1', 'ask');
    expect({ status: step.status, error: step.error }).toEqual({
      status: 'success',
      error: undefined,
    });
    expect(stepLogs('run-1')).toContain(REPLY);
    const started = channel.posted.findIndex(
      (message) => message.kind === 'process' && message.state === 'started',
    );
    expect(started).toBeGreaterThanOrEqual(0);
    expect(started).toBeLessThan(channel.posted.indexOf(settled));
  });

  it('Ollama agent steps run on the local server route their owner answers', async () => {
    // CAN-5831: the mock server stands in for the local Ollama server; the
    // owner answers as Electron main's Ollama resolver does, with no key.
    owner = (raised): OwnerAnswer => {
      const body = raised.request;
      if (body.action === 'owner.model.invocation')
        return {
          value: {
            kind: 'model.invocation',
            source: 'ollama',
            harness: body.harness,
            runtimeModel: 'qwen3-coder',
            aiCreditsRouted: false,
            modelGatewayRouted: false,
            accountProxyRouted: false,
          },
          values:
            body.harness === 'codex'
              ? { codexConfig: { ...codexConfig(), model: 'qwen3-coder' } }
              : { env: claudeRouteEnv() },
        };
      return defaultOwner(raised);
    };
    const run = async (executionId: string): Promise<void> => {
      expect(
        await request({
          op: 'start',
          start: launchOf(
            executionId,
            [agentPrompt({ model: OLLAMA, permission_preset: 'read_only' })],
            {
              codexEnvironment: {
                environment: { CANOPY_MOCK_API_KEY: SCENARIO },
                logicalWorkspaceEnvironmentId: 'test',
              },
            },
          ),
        }),
      ).toMatchObject({ ok: true });
      await executionIn(executionId, ['success', 'failure']);
      const step = await storedStep(executionId, 'ask');
      expect({ status: step.status, error: step.error }).toEqual({
        status: 'success',
        error: undefined,
      });
      expect(stepLogs(executionId)).toContain(REPLY);
      const stored = await loadExecutionState(
        executionId,
        join(dataRoot, 'pipeline-executions'),
      );
      expect(stored?.jobs.j?.steps?.ask?.agent_provider).toBe('ollama');
    };
    // Ollama runs on the Codex harness by default, and on Claude when assigned.
    await run('run-codex');
    initModelHarnessAssignments({
      revision: 1,
      assignments: [
        {
          modelId: OLLAMA,
          source: 'ollama',
          harness: 'claude',
          defaultHarness: 'codex',
          configurable: true,
          overridden: true,
        },
      ],
    });
    try {
      await run('run-claude');
    } finally {
      initModelHarnessAssignments({ revision: 0, assignments: [] });
    }
    // Ollama routes carry no Ledger tools, in process as here.
    expect(ownerSaw).not.toContain('owner.ledger.open');
    expect(ownerSaw).not.toContain('owner.ledger.codexTools');
  });

  it('inline and Agent alias steps run on the model their alias names', async () => {
    // CAN-5832: the launch carries the run's merged alias preferences and
    // what each alias names; an Agent alias asks the owner at its step.
    const asked: string[] = [];
    // The Agent store gives every Agent plugin selections, empty when it
    // adds none (CAN-5832 review).
    let agentSelections: CanopyJsonValue = NO_PLUGINS;
    owner = (raised): OwnerAnswer => {
      const body = raised.request;
      if (body.action === 'owner.model.agentAlias')
        return {
          value: {
            kind: 'model.agentAlias',
            alias: {
              agentId: body.agentId,
              name: 'Reviewer',
              base: DEFAULT_CLAUDE_MODEL,
              instructions: 'Review carefully.',
              pluginSelections: agentSelections,
            },
          },
        };
      if (
        body.action === 'owner.model.invocation' ||
        body.action === 'owner.model.routing'
      )
        asked.push(body.model ?? '');
      if (body.action === 'owner.model.routing')
        return {
          value: {
            kind: 'model.routing',
            override: {
              provider: 'claude',
              model: body.model ?? DEFAULT_CLAUDE_MODEL,
              modelGatewayRouted: false,
              accountProxyRouted: false,
            },
          },
          values: { env: claudeRouteEnv() },
        };
      return defaultOwner(raised);
    };
    const aliasLaunch = (executionId: string): PipelineHostLaunch => {
      const launch = launchOf(
        executionId,
        [
          { ...agentPrompt({ model: 'fast' }), id: 'inline' },
          { ...agentPrompt({ model: 'reviewer' }), id: 'agent' },
        ],
        {
          modelAliasPreferences: {
            fast: { mode: 'inline', base: DEFAULT_CLAUDE_MODEL },
          },
          modelAliasResolutions: {
            fast: { base: DEFAULT_CLAUDE_MODEL, plugins: false },
            reviewer: { base: DEFAULT_CLAUDE_MODEL, plugins: false },
          },
        },
      );
      return {
        ...launch,
        launch: {
          ...launch.launch,
          pipeline: {
            ...launch.launch.pipeline,
            model_aliases: [
              { id: 'fast', name: 'Fast', defaults: { base: 'unset-model' } },
              {
                id: 'reviewer',
                name: 'Reviewer',
                defaults: { agent_id: 'agent_model_reviewer' },
              },
            ],
          },
        },
      };
    };
    expect(
      await request({ op: 'start', start: aliasLaunch('run-1') }),
    ).toMatchObject({ ok: true });
    await executionIn('run-1', ['success', 'failure']);
    for (const stepId of ['inline', 'agent']) {
      const step = await storedStep('run-1', stepId);
      expect({ status: step.status, error: step.error }).toEqual({
        status: 'success',
        error: undefined,
      });
    }
    expect(stepLogs('run-1')).toContain(REPLY);
    // The run preference, not the workflow default, named the inline base.
    expect(asked).not.toContain('unset-model');
    expect(new Set(asked)).toEqual(new Set([DEFAULT_CLAUDE_MODEL]));
    expect(ownerSaw).toContain('owner.model.agentAlias');

    // An Agent that names a standalone MCP server after the launch fails
    // its step closed (CAN-5832 D9, CAN-6011).
    agentSelections = {
      ...NO_PLUGINS,
      mcpServerRefs: [{ serverId: 'github', configId: 'default' }],
    };
    expect(
      await request({ op: 'start', start: aliasLaunch('run-2') }),
    ).toMatchObject({ ok: true });
    await executionIn('run-2', ['success', 'failure']);
    expect((await storedStep('run-2', 'inline')).status).toBe('success');
    const agent = await storedStep('run-2', 'agent');
    expect(agent.status).toBe('failure');
    expect(agent.error).toContain(
      "This Agent's MCP servers don't run in the background service.",
    );
  });

  it("a run's reset of an alias overrides its stored preference, as in process", async () => {
    // CAN-5832 review: the launch carries the run's merged preferences,
    // reset entries included, so the stored one never wins in the host.
    const locator = { type: 'file', value: join(worktree, 'workflow.yml') };
    writeFileSync(
      join(dataRoot, 'pipeline-plugin-preferences.json'),
      JSON.stringify({
        version: 2,
        entries: {
          [serializePipelinePreferenceLocator({
            type: 'file',
            value: locator.value,
          })]: {
            model_aliases: { fast: { mode: 'inline', base: 'stored-model' } },
          },
        },
      }),
    );
    const asked: string[] = [];
    owner = (raised): OwnerAnswer => {
      const body = raised.request;
      if (body.action === 'owner.model.routing') {
        asked.push(body.model ?? '');
        return {
          value: {
            kind: 'model.routing',
            override: {
              provider: 'claude',
              model: body.model ?? DEFAULT_CLAUDE_MODEL,
              modelGatewayRouted: false,
              accountProxyRouted: false,
            },
          },
          values: { env: claudeRouteEnv() },
        };
      }
      return defaultOwner(raised);
    };
    const launch = launchOf('run-1', [agentPrompt({ model: 'fast' })], {
      pipelinePreferenceLocator: locator,
      modelAliasPreferences: { fast: { mode: 'reset' } },
      modelAliasResolutions: {
        fast: { base: DEFAULT_CLAUDE_MODEL, plugins: false },
      },
    });
    expect(
      await request({
        op: 'start',
        start: {
          ...launch,
          launch: {
            ...launch.launch,
            pipeline: {
              ...launch.launch.pipeline,
              model_aliases: [
                {
                  id: 'fast',
                  name: 'Fast',
                  defaults: { base: DEFAULT_CLAUDE_MODEL },
                },
              ],
            },
          },
        },
      }),
    ).toMatchObject({ ok: true });
    await executionIn('run-1', ['success', 'failure']);
    expect((await storedStep('run-1', 'ask')).status).toBe('success');
    expect(asked).not.toContain('stored-model');
    expect(
      (await loadExecutionState('run-1', join(dataRoot, 'pipeline-executions')))
        ?.model_alias_preferences,
    ).toEqual({ fast: { mode: 'reset' } });
  });

  it("a Claude step's plugin collection resolves from the launch's snapshot", async () => {
    // CAN-5832: the run's core resolved it at launch; the step materializes it.
    owner = (raised): OwnerAnswer => {
      const body = raised.request;
      if (body.action === 'owner.model.routing')
        return {
          value: {
            kind: 'model.routing',
            override: {
              provider: 'claude',
              model: body.model ?? DEFAULT_CLAUDE_MODEL,
              modelGatewayRouted: false,
              accountProxyRouted: false,
            },
          },
          values: { env: claudeRouteEnv() },
        };
      return defaultOwner(raised);
    };
    const snapshot = {
      // A builtin skill resolves from the app's bundled resources, which the
      // launch names (CAN-5832 review): the daemon runs from another folder.
      selections: {
        ...NO_PLUGINS,
        skillRefs: [
          { sourceId: 'builtin:app', skillName: 'canopy-5832-skill' },
        ],
      },
      missingOptionalDefaults: [
        { defaultKey: 'plugin:review', warning: 'Review is optional here.' },
      ],
      unresolvedRequiredDefaults: [],
    };
    const collectionLaunch = (
      executionId: string,
      snapshots: Record<string, CanopyJsonValue>,
    ): PipelineHostLaunch => {
      const launch = launchOf(
        executionId,
        [agentPrompt({ plugin_collection_id: 'review' })],
        { pluginCollectionSnapshots: snapshots },
      );
      return {
        ...launch,
        launch: {
          ...launch.launch,
          pipeline: {
            ...launch.launch.pipeline,
            plugin_collections: [
              { id: 'review', name: 'Review', defaults: [] },
            ],
          },
        },
      };
    };
    expect(
      await request({
        op: 'start',
        start: collectionLaunch('run-1', { review: snapshot }),
      }),
    ).toMatchObject({ ok: true });
    await executionIn('run-1', ['success', 'failure']);
    expect((await storedStep('run-1', 'ask')).status).toBe('success');
    expect(stepLogs('run-1')).toContain(
      '[plugin-collection] Review is optional here.',
    );
    expect(stepLogs('run-1')).not.toContain('canopy-5832-skill" (source');
    expect(
      (await loadExecutionState('run-1', join(dataRoot, 'pipeline-executions')))
        ?.resolved_plugin_collections?.review,
    ).toEqual(snapshot);
    // A snapshot that names a standalone MCP server never reaches a step.
    expect(
      await request({
        op: 'start',
        start: collectionLaunch('run-2', {
          review: {
            ...snapshot,
            selections: {
              ...NO_PLUGINS,
              mcpServerRefs: [{ serverId: 'github', configId: 'default' }],
            },
          },
        }),
      }),
    ).toMatchObject({ ok: false, error: { code: 'start_failed' } });
  });

  it('a Codex Agent alias that adds no plugins runs on the host runtime', async () => {
    owner = (raised): OwnerAnswer => {
      const body = raised.request;
      if (body.action === 'owner.model.agentAlias')
        return {
          value: {
            kind: 'model.agentAlias',
            alias: {
              agentId: body.agentId,
              name: 'Coder',
              base: DEFAULT_CODEX_MODEL,
              pluginSelections: NO_PLUGINS,
            },
          },
        };
      if (body.action === 'owner.model.invocation')
        return {
          value: {
            kind: 'model.invocation',
            source: 'codex-managed',
            harness: 'codex',
            runtimeModel: DEFAULT_CODEX_MODEL,
            aiCreditsRouted: false,
            modelGatewayRouted: false,
            accountProxyRouted: false,
          },
          values: { codexConfig: codexConfig() },
        };
      return defaultOwner(raised);
    };
    const launch = launchOf(
      'run-1',
      [agentPrompt({ model: 'coder', permission_preset: 'read_only' })],
      {
        codexEnvironment: {
          environment: { CANOPY_MOCK_API_KEY: SCENARIO },
          logicalWorkspaceEnvironmentId: 'test',
        },
        modelAliasResolutions: {
          coder: { base: DEFAULT_CODEX_MODEL, plugins: false },
        },
      },
    );
    expect(
      await request({
        op: 'start',
        start: {
          ...launch,
          launch: {
            ...launch.launch,
            pipeline: {
              ...launch.launch.pipeline,
              model_aliases: [
                {
                  id: 'coder',
                  name: 'Coder',
                  defaults: { agent_id: 'agent_model_coder' },
                },
              ],
            },
          },
        },
      }),
    ).toMatchObject({ ok: true });
    await executionIn('run-1', ['success', 'failure']);
    const step = await storedStep('run-1', 'ask');
    expect({ status: step.status, error: step.error }).toEqual({
      status: 'success',
      error: undefined,
    });
    expect(stepLogs('run-1')).toContain(REPLY);
  });

  it('an Agent that moves to Codex after the launch runs its step on Codex', async () => {
    // CAN-5832 review: the Agent resolved to Claude at launch and resolves to
    // Codex at its step, as it would in process; the launch carries the
    // run's Codex environment for that.
    owner = (raised): OwnerAnswer => {
      const body = raised.request;
      if (body.action === 'owner.model.agentAlias')
        return {
          value: {
            kind: 'model.agentAlias',
            alias: {
              agentId: body.agentId,
              name: 'Coder',
              base: DEFAULT_CODEX_MODEL,
              pluginSelections: NO_PLUGINS,
            },
          },
        };
      if (body.action === 'owner.model.invocation')
        return {
          value: {
            kind: 'model.invocation',
            source: 'codex-managed',
            harness: 'codex',
            runtimeModel: DEFAULT_CODEX_MODEL,
            aiCreditsRouted: false,
            modelGatewayRouted: false,
            accountProxyRouted: false,
          },
          values: { codexConfig: codexConfig() },
        };
      return defaultOwner(raised);
    };
    const launch = launchOf(
      'run-1',
      [agentPrompt({ model: 'coder', permission_preset: 'read_only' })],
      {
        codexEnvironment: {
          environment: { CANOPY_MOCK_API_KEY: SCENARIO },
          logicalWorkspaceEnvironmentId: 'test',
        },
        modelAliasResolutions: {
          coder: { base: DEFAULT_CLAUDE_MODEL, plugins: false },
        },
      },
    );
    expect(
      await request({
        op: 'start',
        start: {
          ...launch,
          launch: {
            ...launch.launch,
            pipeline: {
              ...launch.launch.pipeline,
              model_aliases: [
                {
                  id: 'coder',
                  name: 'Coder',
                  defaults: { agent_id: 'agent_model_coder' },
                },
              ],
            },
          },
        },
      }),
    ).toMatchObject({ ok: true });
    await executionIn('run-1', ['success', 'failure']);
    const step = await storedStep('run-1', 'ask');
    expect({ status: step.status, error: step.error }).toEqual({
      status: 'success',
      error: undefined,
    });
    expect(stepLogs('run-1')).toContain(REPLY);
  });

  it('a refused policy fails the step before any provider starts', async () => {
    const before = (await mockRequests()).length;
    owner = (raised): OwnerAnswer =>
      raised.request.action === 'owner.model.policy'
        ? { value: { kind: 'model.policy', answer: true } }
        : defaultOwner(raised);
    await request({ op: 'start', start: launchOf('run-1', [agentPrompt()]) });
    await executionIn('run-1', ['failure']);
    const step = await storedStep('run-1', 'ask');
    expect(step.status).toBe('failure');
    expect(step.error).toContain('organization');
    expect(ownerSaw).toContain('owner.model.policyRefusal');
    expect((await mockRequests()).length).toBe(before);
  });

  it('a step whose owner stops answering fails, and the run pauses when asked', async () => {
    owner = (): OwnerAnswer => 'unavailable';
    await request({ op: 'start', start: launchOf('run-1', [agentPrompt()]) });
    await executionIn('run-1', ['failure']);
    expect((await storedStep('run-1', 'ask')).error).toContain(
      'The app that started this workflow run is not answering.',
    );

    owner = defaultOwner;
    ownerSaw = [];
    await request({
      op: 'start',
      start: launchOf('run-2', [
        { id: 'wait', run: 'sleep 20' },
        agentPrompt(),
      ]),
    });
    // The supervisor sends `pause` once the owner has been gone 10 s (CAN-5771).
    expect(
      await request({ op: 'pause', executionIds: ['run-2'] }),
    ).toMatchObject({ ok: true, value: { pausedCount: 1 } });
    await executionIn('run-2', ['paused']);
    expect(ownerSaw).toHaveLength(0);
  });

  it('a checkpoint pauses a step waiting on an owner request that is never answered', async () => {
    // The supervisor withdraws its relays before it checkpoints, so no
    // settlement comes; the policy check has no signal of its own.
    owner = (raised): OwnerAnswer =>
      raised.request.action === 'owner.model.policy'
        ? 'silent'
        : defaultOwner(raised);
    await request({ op: 'start', start: launchOf('run-1', [agentPrompt()]) });
    await waitFor(
      (message): message is PipelineHostMessage =>
        message.kind === 'hostRequest' &&
        message.request.request.action === 'owner.model.policy',
    );
    const started = Date.now();
    expect(await request({ op: 'checkpoint' })).toMatchObject({
      ok: true,
      value: { checkpointedCount: 1 },
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(
      (await loadExecutionState('run-1', join(dataRoot, 'pipeline-executions')))
        ?.status,
    ).toBe('paused');
  });

  it('an owner request ends at its deadline and is withdrawn', async () => {
    const posted: string[] = [];
    const client = createPipelineOwnerClient({
      raise: (raised) => posted.push(`raise:${raised.requestId}`),
      withdraw: (_executionId, requestId) =>
        posted.push(`withdraw:${requestId}`),
    });
    const asked = client.request(
      { action: 'owner.model.policy', check: 'active' },
      {
        executionId: 'run-1',
        childExecutionId: null,
        jobId: '_run',
        stepId: '_run',
        attempt: 0,
        iteration: 0,
        owner: 'personal',
        deadlineMs: 50,
      },
      new AbortController().signal,
    );
    await expect(asked).rejects.toThrow(
      'The app that started this workflow run is not answering.',
    );
    expect(posted).toHaveLength(2);
    expect(posted[1]).toBe(posted[0].replace('raise:', 'withdraw:'));
  });

  it("cancelling or pausing one run withdraws its owner requests and no other's", async () => {
    owner = (raised): OwnerAnswer =>
      raised.request.action === 'owner.model.policy'
        ? 'silent'
        : defaultOwner(raised);
    const policyFor = (executionId: string): Promise<PipelineHostMessage> =>
      waitFor(
        (message): message is PipelineHostMessage =>
          message.kind === 'hostRequest' &&
          message.request.executionId === executionId &&
          message.request.request.action === 'owner.model.policy',
      );
    for (const id of ['run-1', 'run-2', 'run-3'])
      await request({ op: 'start', start: launchOf(id, [agentPrompt()]) });
    await Promise.all(['run-1', 'run-2', 'run-3'].map(policyFor));
    expect(
      await request({ op: 'cancel', executionId: 'run-1', mode: 'drain' }),
    ).toMatchObject({ ok: true, value: { status: 'cancelled' } });
    expect(
      await request({ op: 'pause', executionIds: ['run-2'] }),
    ).toMatchObject({ ok: true, value: { pausedCount: 1 } });
    const withdrawn = channel.posted.flatMap((message) =>
      message.kind === 'hostRequestWithdrawn' ? [message.executionId] : [],
    );
    expect(withdrawn).toContain('run-1');
    expect(withdrawn).toContain('run-2');
    expect(withdrawn).not.toContain('run-3');
  });

  it('a closed owner client refuses new requests at once', async () => {
    const raised: string[] = [];
    const client = createPipelineOwnerClient({
      raise: (request) => raised.push(request.requestId),
      withdraw: () => undefined,
    });
    client.close();
    // A step's cleanup, such as a route release, can ask after a checkpoint closed it.
    await expect(
      client.request(
        { action: 'owner.model.release', routeSessionId: 'route-1' },
        {
          executionId: 'run-1',
          childExecutionId: null,
          jobId: '_run',
          stepId: '_run',
          attempt: 0,
          iteration: 0,
          owner: 'personal',
          deadlineMs: 120_000,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('The owner request was withdrawn.');
    expect(raised).toHaveLength(0);
  });

  it('a Cursor step is refused before anything runs', async () => {
    const refused = await request({
      op: 'start',
      start: launchOf('run-1', [agentPrompt({ model: 'cursor-default' })]),
    });
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'model_steps' },
    });
    expect(existsSync(join(dataRoot, 'pipeline-executions', 'run-1'))).toBe(
      false,
    );
  });
});

describe('Claude Mod admission fails closed (CAN-5095)', () => {
  const admissionRequest = {
    cwd: '/tmp',
    settingSources: ['user', 'project'] as const,
  };
  const portsWith = (
    request: PipelineOwnerClient['request'],
  ): ReturnType<typeof createDaemonPipelineOwnerPorts> =>
    createDaemonPipelineOwnerPorts(
      { request },
      { executionId: 'run-1', owner: 'personal' },
    );
  const admit = (
    ports: ReturnType<typeof createDaemonPipelineOwnerPorts>,
  ): Promise<unknown> =>
    ports.resolveClaudeModAdmissionContext?.(admissionRequest) ??
    Promise.reject(new Error('No admission port.'));

  it('a refusal, an absent owner or an answer that fails validation fails the request', async () => {
    const refused = portsWith(() =>
      Promise.resolve({
        result: {
          status: 'failure',
          failureReason: null,
          message: 'This step folder is outside the workflow run.',
          outputs: {},
        },
      }),
    );
    await expect(admit(refused)).rejects.toThrow(
      'This step folder is outside the workflow run.',
    );
    const absent = portsWith(() =>
      Promise.reject(
        new Error('The app that started this workflow run is not answering.'),
      ),
    );
    await expect(admit(absent)).rejects.toThrow('not answering');
    const wrongKind = portsWith(() =>
      Promise.resolve({
        result: { status: 'owner', value: { kind: 'model.release' } },
      }),
    );
    await expect(admit(wrongKind)).rejects.toThrow();
    const badRecord = portsWith(() =>
      Promise.resolve({
        result: {
          status: 'owner',
          value: {
            kind: 'claude.modAdmission',
            context: {
              enabled: true,
              authority: 'ok',
              admissions: [
                {
                  pluginId: 'demo@market',
                  contentDigest: 'x',
                  admittedAt: 'yesterday',
                },
              ],
              modsDisabled: false,
              ambientPlugins: [],
            },
          },
        },
      }),
    );
    await expect(admit(badRecord)).rejects.toThrow();
  });

  it('a request nobody answers ends at its deadline and fails', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const ports = createDaemonPipelineOwnerPorts(
        createPipelineOwnerClient({
          raise: () => undefined,
          withdraw: () => undefined,
        }),
        { executionId: 'run-1', owner: 'personal' },
      );
      const asked = admit(ports);
      asked.catch(() => undefined);
      jest.advanceTimersByTime(120_001);
      await expect(asked).rejects.toThrow('not answering');
    } finally {
      jest.useRealTimers();
    }
  });

  it("admission asks about the Claude config folder the run's own environment names, not the host's", async () => {
    const asked: (string | undefined)[] = [];
    // Record the question, then refuse, so no CLI starts.
    owner = (raised): OwnerAnswer => {
      if (raised.request.action !== 'owner.claude.modAdmission')
        return defaultOwner(raised);
      asked.push(raised.request.claudeConfigDir);
      return { failure: 'This step folder is outside the workflow run.' };
    };
    const start = launchOf('run-1', [agentPrompt()]);
    const runConfigDir = join(home, 'run-claude-config');
    await request({
      op: 'start',
      start: {
        ...start,
        processEnvironment: {
          ...start.processEnvironment,
          CLAUDE_CONFIG_DIR: runConfigDir,
        },
      },
    });
    await executionIn('run-1', ['failure']);
    await request({ op: 'start', start: launchOf('run-2', [agentPrompt()]) });
    await executionIn('run-2', ['failure']);
    // Without one, the run's own HOME decides, never the host process's.
    expect(asked).toEqual([runConfigDir, join(home, '.claude')]);
  });

  it('a refused admission fails the Claude step before its provider starts', async () => {
    const before = (await mockRequests()).length;
    owner = (raised): OwnerAnswer =>
      raised.request.action === 'owner.claude.modAdmission'
        ? { failure: 'This step folder is outside the workflow run.' }
        : defaultOwner(raised);
    await request({ op: 'start', start: launchOf('run-1', [agentPrompt()]) });
    await executionIn('run-1', ['failure']);
    const step = await storedStep('run-1', 'ask');
    expect(step.status).toBe('failure');
    expect(step.error).toContain('outside the workflow run');
    expect((await mockRequests()).length).toBe(before);
  });
});

describe('the launch model catalog (CAN-5095)', () => {
  const codexStep = agentPrompt({
    model: DEFAULT_CODEX_MODEL,
    permission_preset: 'read_only',
  });

  it("a launch with model steps that does not name the app's resources is refused", async () => {
    expect(
      await request({
        op: 'start',
        start: launchOf('run-1', [agentPrompt()], {
          bundledResourcesDir: undefined,
        }),
      }),
    ).toMatchObject({ ok: false, error: { code: 'start_failed' } });
  });

  it('a launch with model steps and no catalog is refused before anything runs', async () => {
    const refused = await request({
      op: 'start',
      start: launchOf('run-1', [agentPrompt()], { modelCatalog: undefined }),
    });
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'start_failed' },
    });
    expect(existsSync(join(dataRoot, 'pipeline-executions', 'run-1'))).toBe(
      false,
    );
  });

  it('a catalog that does not parse or exceeds its bound is refused', async () => {
    const refused = await request({
      op: 'start',
      start: launchOf('run-1', [agentPrompt()], {
        modelCatalog: { ...snapshot(), MODEL_CATALOG: '{"version":2}' },
      }),
    });
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'start_failed' },
    });
    expect(existsSync(join(dataRoot, 'pipeline-executions', 'run-1'))).toBe(
      false,
    );
    const oversized = launchOf('run-2', [agentPrompt()], {
      modelCatalog: {
        ...snapshot(),
        MODEL_ALIASES: 'x'.repeat(WORKER_PIPELINE_MODEL_CATALOG_MAX_BYTES),
      },
    }).launch;
    expect(WorkerPipelineHostLaunchSchema.safeParse(oversized).success).toBe(
      false,
    );
  });

  it('a catalog whose assignments include harnesses the host does not run is still admitted', async () => {
    // Electron main's registry holds Cursor, Copilot and OpenCode assignments too.
    owner = (raised): OwnerAnswer =>
      raised.request.action === 'owner.model.policy'
        ? { value: { kind: 'model.policy', answer: true } }
        : defaultOwner(raised);
    const catalog = snapshot();
    const started = await request({
      op: 'start',
      start: launchOf('run-1', [agentPrompt()], {
        modelCatalog: {
          ...catalog,
          MODEL_HARNESS_ASSIGNMENTS: JSON.stringify({
            revision: 1,
            assignments: [
              {
                modelId: 'cursor-default',
                source: 'cursor-managed',
                harness: 'cursor',
                defaultHarness: 'cursor',
                configurable: false,
                overridden: false,
              },
            ],
          }),
        },
      }),
    });
    expect(started).toMatchObject({ ok: true });
    await executionIn('run-1', ['failure']);
  });

  it("a later launch's catalog wins", async () => {
    // Without a Codex environment an admitted Codex step fails its start after
    // classification, and one its catalog does not know fails classification.
    expect(
      await request({ op: 'start', start: launchOf('run-1', [codexStep]) }),
    ).toMatchObject({ ok: false, error: { code: 'start_failed' } });
    const withoutCodex = { ...snapshot() };
    delete withoutCodex.CODEX_MODELS;
    expect(
      await request({
        op: 'start',
        start: launchOf('run-2', [codexStep], {
          modelCatalog: {
            ...withoutCodex,
            MODEL_CATALOG: JSON.stringify({
              ...JSON.parse(withoutCodex.MODEL_CATALOG),
              codexModels: [],
            }),
          },
        }),
      }),
    ).toMatchObject({ ok: false, error: { code: 'model_steps' } });
    initCodexModels([{ id: DEFAULT_CODEX_MODEL, label: 'Codex default' }]);
  });
});
