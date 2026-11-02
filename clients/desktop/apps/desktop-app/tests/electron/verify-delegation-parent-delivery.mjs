#!/usr/bin/env node
// Phase 0 native parent feasibility, with manually completed fake children.
// node --import tsx apps/desktop-app/tests/electron/verify-delegation-parent-delivery.mjs [output.json]
// Real pinned runtimes consume loopback scripted inference. No paid model call.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { randomUUID, createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  open,
  rename,
  rm,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { WebSocketServer } from 'ws';
import artifactModule from '../../../../packages/desktop-shared/src/node/delegation/agent-artifacts.ts';
import { parseAgentDelegationSpawnRequest } from '../../../../packages/protocol/src/delegation/index.ts';
import brokerModule from '../../../../packages/desktop-shared/src/node/delegation/development-broker.ts';
import projectionModule from '../../../../packages/desktop-shared/src/node/delegation/development-projections.ts';
import deliveryModule from '../../../../packages/desktop-shared/src/node/delegation/delivery.ts';
import launchModule from '../../../../packages/desktop-shared/src/node/delegation/launch-journal.ts';
import bindingModule from '../../../../packages/desktop-shared/src/node/delegation/call-bindings.ts';
import { parseClaudeDelegationSpawn } from '../../../../packages/protocol/src/delegation/spawn-projections.ts';
import runtime from '../../../../packages/desktop-shared/src/node/codex-runtime/index.ts';
import {
  handleLlmRequest,
  resolveResponsesReply,
  buildResponsesEvents,
} from './mock-server/routes/llm.mjs';
import { registerScenario } from './mock-server/control-plane.mjs';

const { DevelopmentDelegationBroker } = brokerModule;
const { AgentArtifactStore } = artifactModule;
const { createDevelopmentDelegationProjection } = projectionModule;
const { DelegationDeliveryCoordinator } = deliveryModule;
const { DelegationLaunchJournal } = launchModule;
const { DelegationCallBindings } = bindingModule;
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const output = path.resolve(
  root,
  process.argv[2] ??
    '.playwright/cross-provider-subagents/phase-0-completion/native-parent-delivery.json',
);
const temporary = await mkdtemp(
  path.join(tmpdir(), 'delegation-parent-delivery-'),
);
const reports = [];
const originalCanary = process.env.DELEGATION_UNRELATED_SECRET_CANARY;
process.env.DELEGATION_UNRELATED_SECRET_CANARY = 'harmless-environment-canary';
let current;
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function respond(response, body) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
function containsToolResult(body, callId, report) {
  if (Array.isArray(body))
    return body.some((item) => containsToolResult(item, callId, report));
  if (!body || typeof body !== 'object') return false;
  if (
    ((body.type === 'tool_result' && body.tool_use_id === callId) ||
      (body.type === 'function_call_output' && body.call_id === callId)) &&
    JSON.stringify(body).includes(report)
  )
    return true;
  return Object.values(body).some((value) =>
    containsToolResult(value, callId, report),
  );
}
function inspect(body) {
  if (!current) return;
  const observeDenials = (value) => {
    if (!value || typeof value !== 'object') return;
    if (
      ['tool_use', 'function_call'].includes(value.type) &&
      current.deniedTools.includes(value.name)
    )
      current.deniedCalls.set(
        value.type === 'function_call' ? value.call_id : value.id,
        value.name,
      );
    if (['tool_result', 'function_call_output'].includes(value.type)) {
      const id = value.tool_use_id ?? value.call_id;
      const tool = current.deniedCalls.get(id);
      if (tool) {
        const output = JSON.stringify(value.content ?? value.output);
        assert(
          !output.includes(current.nativeCanary),
          'removed native tools must not execute',
        );
        assert(
          /unknown|not available|not found|not permitted|disabled|unavailable|unrecognized|unsupported/i.test(
            output,
          ),
          'native runtime must report the removed tool denial',
        );
        current.nativeDenials.add(tool);
      }
    }
    for (const child of Object.values(value)) observeDenials(child);
  };
  observeDenials(body);
  if (current.overlayToken) {
    if (
      JSON.stringify(body.system ?? body.instructions ?? '').includes(
        current.overlayPrompt,
      )
    )
      current.promptConsumed = true;
    const visit = (value) => {
      if (!value || typeof value !== 'object') return;
      if (
        (value.type === 'tool_result' ||
          value.type === 'function_call_output') &&
        JSON.stringify(value).includes(current.overlayToken)
      )
        current.overlayReceipts.add(value.tool_use_id ?? value.call_id);
      for (const child of Object.values(value)) visit(child);
    };
    visit(body);
  }
  if (body.tools)
    current.advertised = body.tools.map((tool) => ({
      name: tool.name,
      tools: tool.tools?.map((item) => item.name),
    }));
  if (
    current.channel === 'foreground' &&
    current.providerCallId &&
    containsToolResult(body, current.providerCallId, current.childReport)
  ) {
    current.receipt.resolve({
      deliveryId: current.deliveryId,
      status: 'acknowledged',
      receiptId: `${current.harness}:${current.providerCallId}:consumed-result`,
    });
  }
}
let responseSequence = 0;
function scenarioBody(body) {
  const key = Array.isArray(body.messages) ? 'messages' : 'input';
  const input = body[key] ?? [];
  let start = -1;
  for (let index = 0; index < input.length; index += 1) {
    if (
      input[index]?.role === 'user' &&
      ['parent', 'delivery', 'denial'].some((kind) =>
        JSON.stringify(input[index]).includes(`[Canopy-C${kind}-`),
      )
    )
      start = index;
  }
  return { ...body, [key]: start >= 0 ? input.slice(start) : input };
}
function responseEvents(body) {
  inspect(body);
  const scoped = scenarioBody(body);
  const { step: selectedStep, usage, model } = resolveResponsesReply(scoped);
  const step =
    current.nativeDenials.has('exec_command') &&
    JSON.stringify(scoped.input?.[0]).includes(current.denialMarker)
      ? {
          text: 'The native execution request was denied.',
          stopReason: 'end_turn',
        }
      : selectedStep;
  const suffix = `_${++responseSequence}`;
  // The shared mock's constant call IDs are fine for single-step fixtures.
  // Real multi-step native calls need distinct IDs or host dedup correctly denies them.
  return buildResponsesEvents(step, usage, model).map((event) => ({
    ...event,
    data: JSON.parse(
      JSON.stringify(event.data, (_key, value) =>
        typeof value === 'string' && /^(call_mock_|fc_mock_)/.test(value)
          ? value + suffix
          : value,
      ),
    ),
  }));
}
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname.endsWith('/responses') && request.method === 'POST') {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of responseEvents(body))
        response.write(
          `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`,
        );
      response.end();
    })().catch((error) => {
      current?.errors.push(error.message);
      response.end();
    });
    return;
  }
  if (url.pathname !== '/mcp') {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        body = {};
      }
      inspect(body);
      const scopedRequest = Readable.from([
        Buffer.from(JSON.stringify(scenarioBody(body))),
      ]);
      scopedRequest.headers = request.headers;
      scopedRequest.method = request.method;
      scopedRequest.url = request.url;
      const suffix = `_${++responseSequence}`;
      const rewrite = (value) =>
        typeof value === 'string'
          ? value.replace(/"toolu_mock_(\d+)"/g, `"toolu_mock_$1${suffix}"`)
          : value;
      const write = response.write.bind(response);
      const end = response.end.bind(response);
      response.write = (value, ...args) => write(rewrite(value), ...args);
      response.end = (value, ...args) => end(rewrite(value), ...args);
      if (!(await handleLlmRequest(scopedRequest, response, url)))
        response.writeHead(404).end();
    })().catch((error) => {
      current?.errors.push(error.message);
      response.end();
    });
    return;
  }
  void (async () => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result = {};
    if (body.method === 'initialize')
      result = {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'probe', version: '1' },
      };
    if (body.method === 'tools/list')
      result = { tools: current.projection.tools };
    if (body.method === 'tools/call') {
      const { _hostCorrelation, ...input } = body.params.arguments;
      const parsed = parseClaudeCall(body.params.name, input);
      assert(parsed.ok);
      const bound = current.bindings.resolve(
        _hostCorrelation,
        parsed.value,
        current.owner,
      );
      assert(bound.ok, 'real hook token binds the exact MCP request');
      result = {
        content: [
          {
            type: 'text',
            text: await current.invoke(bound.value, body.params.name, input),
          },
        ],
      };
    }
    respond(response, { jsonrpc: '2.0', id: body.id, result });
  })().catch((error) => {
    current?.errors.push(error.message);
    response.writeHead(500).end();
  });
});
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.on('error', () => {});
    ws.on('message', (data) => {
      const body = JSON.parse(data.toString());
      for (const event of responseEvents(body))
        ws.send(JSON.stringify(event.data));
    });
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address !== 'string');
const baseUrl = `http://127.0.0.1:${address.port}`;

function parseClaudeCall(name, input) {
  return name.endsWith('probe_read_overlay')
    ? parseAgentDelegationSpawnRequest({
        modelId: 'retained-overlay',
        description: 'Read retained Agent projection',
        prompt: JSON.stringify({ name: 'probe_read_overlay', input }),
      })
    : parseClaudeDelegationSpawn(input);
}

async function prepareOverlay(state) {
  state.overlayToken = `RETAINED_SKILL_${state.deliveryId}`;
  state.overlayPrompt = `RETAINED_PROMPT_${state.deliveryId}`;
  state.overlayReads = 0;
  state.overlayReceipts = new Set();
  await writeFile(state.denialFile, state.nativeCanary);
  const definition = {
    id: 'agent_model_probe',
    revision: '2026-09-08T00:00:00.000Z',
    instructions: state.overlayPrompt,
  };
  const source = path.join(temporary, `source-${state.deliveryId}`);
  await mkdir(source);
  await writeFile(path.join(source, 'agent.json'), JSON.stringify(definition));
  await writeFile(path.join(source, 'SKILL.md'), state.overlayToken);
  state.artifactDirectory = path.join(
    temporary,
    `artifacts-${state.deliveryId}`,
  );
  const store = new AgentArtifactStore(state.artifactDirectory);
  const captured = JSON.parse(
    await readFile(path.join(source, 'agent.json'), 'utf8'),
  );
  state.overlay = await store.retain({
    agentDefinitionId: captured.id,
    agentDefinitionRevision: captured.revision,
    agentDefinitionHash: createHash('sha256')
      .update(JSON.stringify(captured))
      .digest('hex'),
    systemPromptAppend: captured.instructions,
    pluginFiles: {
      'skills/review/SKILL.md': await readFile(
        path.join(source, 'SKILL.md'),
        'utf8',
      ),
    },
    toolNames: ['read', 'search'],
  });
  await writeFile(
    path.join(source, 'agent.json'),
    JSON.stringify({ ...definition, instructions: 'Edited Agent' }),
  );
  await writeFile(path.join(source, 'SKILL.md'), 'Edited plugin');
  state.verifiedProjection = await new AgentArtifactStore(
    state.artifactDirectory,
  ).load(state.overlay);
  state.deleteSources = async () =>
    rm(source, { recursive: true, force: true });
}

function makeCase(harness, channel) {
  const deliveryId = randomUUID();
  const state = {
    harness,
    channel,
    deliveryId,
    childReport: `CHILD_REPORT_${deliveryId}`,
    marker: `Canopy-Cparent-${harness}-${channel}`,
    continuationMarker: `Canopy-Cdelivery-${harness}-${channel}`,
    denialMarker: `Canopy-Cdenial-${harness}-${channel}`,
    owner: {
      harnessId: harness,
      projectId: 'probe',
      worktreeId: 'probe',
      chatId: randomUUID(),
      sessionKey: randomUUID(),
      turnId: randomUUID(),
      runtimeGeneration: 1,
      depth: 0,
    },
    rootFinished: deferred(),
    receipt: deferred(),
    responseReady: deferred(),
    rootTerminals: 0,
    calls: [],
    errors: [],
    writes: [],
    advertised: [],
    deniedTools: harness === 'claude' ? ['Bash', 'Read'] : ['exec_command'],
    deniedCalls: new Map(),
    nativeDenials: new Set(),
    nativeCanary: `NATIVE_TOOL_MUST_NOT_RUN_${deliveryId}`,
    denialFile: path.join(temporary, `private-canary-${deliveryId}.txt`),
  };
  state.broker = new DevelopmentDelegationBroker({
    mode: 'development-probe',
    resolveRoute: async (task) => ({
      ok: true,
      value: {
        selectedModelId: task.modelId,
        runtimeModelId: 'fake-runtime',
        harnessId: 'third-runner',
        runtimeKind: 'in-memory',
        runnerRegistrationId: 'fake',
        runtimeVersion: '1',
        adapterVersion: '1',
        modelSource: 'probe',
        providerType: 'fake',
        assignmentRevision: '1',
        billingAuthority: 'none',
        aiCreditsRouted: false,
        capabilities: ['read'],
        supportedThinkingLevels: ['low', 'high'],
        capabilitySnapshotHash: 'probe',
        capabilityGeneration: 1,
        policyRevision: 'probe-read-only',
      },
    }),
  });
  state.projection = createDevelopmentDelegationProjection(
    harness,
    'probe',
    state.broker,
  );
  state.projection = {
    ...state.projection,
    tools: [
      ...state.projection.tools,
      {
        name: 'probe_read_overlay',
        description:
          'Read one retained Agent capability file using the host-owned read policy.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['path'],
          properties: { path: { type: 'string' } },
        },
      },
    ],
  };
  state.coordinator = new DelegationDeliveryCoordinator(deliveryId, {
    commit: async (_id, value) => {
      const target = path.join(temporary, `${deliveryId}.json`);
      const staged = `${target}.tmp`;
      const handle = await open(staged, 'w', 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({ version: 1, deliveryId, state: value }),
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(staged, target);
      const dir = await open(temporary, 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
      state.writes.push(value);
    },
  });
  state.invoke = async (parent, name, input) => {
    if (name === 'probe_read_overlay') {
      assert.deepEqual(input, { path: 'skills/review/SKILL.md' });
      const retained = await new AgentArtifactStore(
        state.artifactDirectory,
      ).load(state.overlay);
      assert.equal(retained.systemPromptAppend, state.overlayPrompt);
      assert.equal(retained.pluginFiles[input.path], state.overlayToken);
      state.overlayReads += 1;
      return retained.pluginFiles[input.path];
    }
    state.providerCallId = parent.toolCallId;
    state.calls.push({
      turnId: parent.turnId,
      toolCallId: parent.toolCallId,
      runtimeGeneration: parent.runtimeGeneration,
    });
    const waiting = name === 'probe_get_delegate_output';
    const launched = waiting
      ? undefined
      : await state.projection.invoke(parent, name, input);
    if (launched) assert(launched.ok);
    const child = state.broker.list(parent)[0];
    assert(child);
    if (harness === 'codex' && channel === 'foreground' && !waiting) {
      state.outputInput.delegationId = child.delegationId;
      return JSON.stringify(launched.value);
    }
    assert.equal(
      state.rootTerminals,
      0,
      'the parent is still working when its child completes',
    );
    state.broker.finish(child.delegationId, 'completed', state.childReport);
    assert.equal(
      state.rootTerminals,
      0,
      'child terminal reduction cannot settle the native root',
    );
    state.childResult = state.broker.inspect(parent, child.delegationId);
    if (waiting) {
      const output = await state.projection.invoke(
        parent,
        'probe_get_delegate_output',
        { delegationId: child.delegationId },
      );
      assert(output.ok && output.value.result?.status === 'completed');
    }
    assert(await state.coordinator.claim(channel));
    assert.equal(
      await state.coordinator.claim(
        channel === 'foreground' ? 'background' : 'foreground',
      ),
      false,
    );
    state.delivery = state.coordinator.dispatch({
      dispatch: async () => {
        state.responseReady.resolve();
        if (channel === 'background') {
          await state.rootFinished.promise;
          await state.sendContinuation();
        }
        return state.receipt.promise;
      },
      lookupReceipt: async () => undefined,
    });
    await state.responseReady.promise;
    return JSON.stringify(
      channel === 'foreground' ? state.childResult : launched.value,
    );
  };
  const name = state.projection.tools[0].name;
  const input =
    harness === 'claude'
      ? {
          model: 'logical-review',
          description: 'Review',
          prompt: 'Read the harmless fixture.',
          thinking_level: 'low',
          run_in_background: channel === 'background',
        }
      : {
          model: 'logical-review',
          task_name: 'Review',
          message: 'Read the harmless fixture.',
          reasoning_effort: 'low',
        };
  state.outputInput = { delegationId: 'assigned-by-host' };
  registerScenario(state.marker, {
    llm: {
      openAiStepCursor: 'completed-scenario-tool-calls',
      steps: [
        ...(harness === 'claude' ? state.deniedTools : []).map((tool) => ({
          toolCalls: [
            {
              name: tool,
              input:
                tool === 'Read'
                  ? { file_path: state.denialFile }
                  : tool === 'Bash'
                    ? { command: `printf '${state.nativeCanary}'` }
                    : { cmd: `printf '${state.nativeCanary}'` },
            },
          ],
          stopReason: 'tool_use',
        })),
        {
          toolCalls: [
            {
              name:
                harness === 'claude'
                  ? 'mcp__probe__probe_read_overlay'
                  : 'probe_read_overlay',
              input: { path: 'skills/review/SKILL.md' },
            },
          ],
          stopReason: 'tool_use',
        },
        {
          toolCalls: [
            {
              name: harness === 'claude' ? `mcp__probe__${name}` : name,
              input,
            },
          ],
          stopReason: 'tool_use',
        },
        ...(harness === 'codex' && channel === 'foreground'
          ? [
              {
                toolCalls: [
                  {
                    name: 'probe_get_delegate_output',
                    input: state.outputInput,
                  },
                ],
                stopReason: 'tool_use',
              },
            ]
          : []),
        { text: 'Parent work completed.', stopReason: 'end_turn' },
      ],
    },
  });
  registerScenario(state.continuationMarker, {
    llm: {
      openAiStepCursor: 'completed-scenario-tool-calls',
      steps: [
        {
          toolCalls: [
            {
              name:
                harness === 'claude'
                  ? 'mcp__probe__probe_read_overlay'
                  : 'probe_read_overlay',
              input: { path: 'skills/review/SKILL.md' },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: 'Consumed the child result once.', stopReason: 'end_turn' },
      ],
    },
  });
  if (harness === 'codex')
    registerScenario(state.denialMarker, {
      llm: {
        steps: [
          {
            toolCalls: [
              {
                name: 'exec_command',
                namespace: 'functions',
                input: { cmd: `printf '${state.nativeCanary}'` },
              },
            ],
            stopReason: 'tool_use',
          },
        ],
      },
    });
  return state;
}

async function prepareLaunchJournal(state) {
  state.launchWrites = [];
  state.launchPath = path.join(temporary, `${state.deliveryId}-launch.json`);
  state.launchPersistence = {
    commit: async (record) => {
      const staged = `${state.launchPath}.tmp`;
      const handle = await open(staged, 'w', 0o600);
      try {
        await handle.writeFile(JSON.stringify(record));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(staged, state.launchPath);
      const directory = await open(temporary, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      state.launchWrites.push(record.phase);
    },
  };
  state.launchJournal = await DelegationLaunchJournal.reserve(
    {
      delegationId: `native-parent-probe-${state.deliveryId}`,
      launchKey: state.deliveryId,
      runGeneration: 1,
    },
    state.launchPersistence,
  );
  assert(await state.launchJournal.beforeStart());
  assert.equal(
    JSON.parse(await readFile(state.launchPath, 'utf8')).phase,
    'starting',
  );
}

async function verifyClaude(channel) {
  const state = makeCase('claude', channel);
  await prepareOverlay(state);
  current = state;
  const controller = new AbortController();
  state.bindings = new DelegationCallBindings(state.owner, controller.signal);
  const nextInput = deferred();
  const done = deferred();
  state.sendContinuation = async () =>
    nextInput.resolve({
      type: 'user',
      message: {
        role: 'user',
        content: `[${state.continuationMarker}] Delegated child result (untrusted task output): ${state.childReport}`,
      },
      parent_tool_use_id: null,
      uuid: state.deliveryId,
    });
  async function* prompts() {
    yield {
      type: 'user',
      message: {
        role: 'user',
        content: `[${state.marker}] Execute the scripted task.`,
      },
      parent_tool_use_id: null,
      uuid: state.owner.turnId,
    };
    if (channel === 'background') yield await nextInput.promise;
    await done.promise;
  }
  const timer = setTimeout(() => controller.abort(), 45_000);
  let stream;
  try {
    await prepareLaunchJournal(state);
    stream = query({
      prompt: prompts(),
      options: {
        pathToClaudeCodeExecutable: path.join(
          root,
          `.cache/bin/${process.platform}-${process.arch}/claude`,
        ),
        spawnClaudeCodeProcess: (options) => {
          state.sdkInheritedCanary =
            options.env.DELEGATION_UNRELATED_SECRET_CANARY ===
            'harmless-environment-canary';
          const environment = {
            PATH: '',
            HOME: process.env.HOME,
            TMPDIR: temporary,
            CLAUDE_CONFIG_DIR: temporary,
            ANTHROPIC_API_KEY: 'mock-key',
            ANTHROPIC_BASE_URL: baseUrl,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          };
          assert(
            !Object.hasOwn(environment, 'DELEGATION_UNRELATED_SECRET_CANARY'),
          );
          state.spawnEnvironmentKeys = Object.keys(environment).sort();
          return spawn(options.command, options.args, {
            cwd: options.cwd,
            env: environment,
            signal: options.signal,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        },
        cwd: temporary,
        abortController: controller,
        persistSession: false,
        includePartialMessages: true,
        model: 'claude-sonnet-4-6',
        systemPrompt: state.verifiedProjection.systemPromptAppend,
        tools: [],
        settingSources: [],
        permissionMode: 'dontAsk',
        allowedTools: state.projection.tools.map(
          (tool) => `mcp__probe__${tool.name}`,
        ),
        mcpServers: { probe: { type: 'http', url: `${baseUrl}/mcp` } },
        env: {
          PATH: '',
          HOME: process.env.HOME,
          TMPDIR: temporary,
          CLAUDE_CONFIG_DIR: temporary,
          ANTHROPIC_API_KEY: 'mock-key',
          ANTHROPIC_BASE_URL: baseUrl,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        hooks: {
          PreToolUse: [
            {
              matcher: 'mcp__probe__.*',
              hooks: [
                async (input) => {
                  const parsed = parseClaudeCall(
                    input.tool_name,
                    input.tool_input,
                  );
                  assert(parsed.ok);
                  const bound = state.bindings.bind(
                    input.tool_use_id,
                    parsed.value,
                  );
                  assert(bound.ok);
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: 'allow',
                      updatedInput: {
                        ...input.tool_input,
                        _hostCorrelation: bound.value,
                      },
                    },
                  };
                },
              ],
            },
          ],
        },
      },
    });
    for await (const event of stream) {
      if (event.type === 'system' && event.subtype === 'init') {
        state.nativeSessionId = event.session_id;
        await state.launchJournal.identify(event.session_id);
        assert(
          event.tools.every((name) => name.startsWith('mcp__probe__')),
          'native spawn/control/shell tools are absent',
        );
      }
      if (event.user_message_uuid === state.deliveryId)
        state.receipt.resolve({
          deliveryId: state.deliveryId,
          status: 'acknowledged',
          receiptId: `claude:${event.session_id}:${event.user_message_uuid}`,
        });
      if (event.type === 'result') {
        assert.equal(event.is_error, false);
        state.rootTerminals += 1;
        await state.deleteSources();
        state.rootFinished.resolve();
        if (state.rootTerminals === (channel === 'background' ? 2 : 1))
          done.resolve();
      }
    }
    await state.delivery;
    await verifyResult(state);
  } finally {
    clearTimeout(timer);
    done.resolve();
    controller.abort();
    state.bindings.dispose();
    stream?.close();
    state.broker.close();
  }
}

async function verifyCodex(channel) {
  const state = makeCase('codex', channel);
  await prepareOverlay(state);
  current = state;
  const service = runtime.createCodexRuntimeService({
    capabilityStore: new runtime.CodexCapabilityStore(temporary),
  });
  const profile = {
    configArgs: ['-c', 'features.hooks=false', '-c', 'features.apps=false'],
    includeCanopySecrets: false,
    environmentPolicy: 'restricted',
    mockProviderId: 'delegation-parent-delivery',
  };
  let handle;
  const timer = setTimeout(() => {
    void service.shutdown();
  }, 60_000);
  try {
    const currentConfig = await service
      .admin()
      .request('config/read', { cwd: temporary }, profile);
    const disabledFeatures = [
      'shell_tool',
      'unified_exec',
      'multi_agent',
      'multi_agent_v2',
      'apps',
      'hooks',
      'code_mode',
      'code_mode_host',
      'browser_use',
      'browser_use_external',
      'computer_use',
      'image_generation',
      'view_image',
      'skill_search',
      'sleep_tool',
      'goals',
      'in_app_browser',
      'in_app_local_automation',
      'remote_plugin',
      'tool_suggest',
      'plugins',
      'workspace_dependencies',
    ];
    await prepareLaunchJournal(state);
    handle = await service.startThread({
      capabilitySnapshotId: `parent-delivery-${channel}`,
      capabilityLeaseKind: 'ephemeral',
      profile,
      params: {
        cwd: temporary,
        ephemeral: true,
        selectedCapabilityRoots: [],
        environments: [],
        experimentalRawEvents: false,
        model: 'gpt-6-sol',
        modelProvider: 'probe',
        approvalPolicy: 'never',
        sandbox: 'read-only',
        baseInstructions: state.verifiedProjection.systemPromptAppend,
        config: {
          mcp_servers: Object.fromEntries(
            Object.keys(currentConfig.config?.mcp_servers ?? {}).map((name) => [
              name,
              { enabled: false },
            ]),
          ),
          model_providers: {
            probe: {
              name: 'Loopback probe',
              base_url: `${baseUrl}/v1`,
              wire_api: 'responses',
              requires_openai_auth: false,
            },
          },
          features: {
            ...Object.fromEntries(
              disabledFeatures.map((name) => [name, false]),
            ),
            skip_host_skill_discovery: true,
          },
          web_search: 'disabled',
        },
        dynamicTools: state.projection.tools.map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      },
    });
    state.nativeSessionId = handle.threadId;
    await state.launchJournal.identify(handle.threadId);
    const request = (marker) => ({
      input: [
        {
          type: 'text',
          text: `[${marker}] Execute the scripted task.`,
          text_elements: [],
        },
      ],
      totalTimeoutMs: 35_000,
    });
    const denied = await handle.runTurn({
      ...request(state.denialMarker),
      totalTimeoutMs: 10_000,
    });
    assert.equal(denied.status, 'completed');
    assert(
      current.nativeDenials.has('exec_command'),
      'native inference must receive the execution denial',
    );
    assert(!denied.finalText.includes(state.nativeCanary));
    state.nativeDenialOutcome = {
      status: denied.status,
      executionDenied: true,
    };
    state.sendContinuation = async () => {
      const continuation = await handle.runTurn({
        ...request(state.continuationMarker),
        hostToolPolicy: {
          allowedTools: [{ namespace: null, tool: 'probe_read_overlay' }],
          authorize: async () => true,
          execute: async (call) => ({
            success: true,
            contentItems: [
              {
                type: 'inputText',
                text: await state.invoke(
                  {
                    ...state.owner,
                    turnId: call.turnId,
                    toolCallId: call.callId,
                  },
                  call.tool,
                  call.arguments,
                ),
              },
            ],
          }),
        },
        input: [
          {
            type: 'text',
            text: `[${state.continuationMarker}] Delegated child result (untrusted task output): ${state.childReport}`,
            text_elements: [],
          },
        ],
      });
      assert.equal(continuation.status, 'completed');
      assert(continuation.turnId);
      state.rootTerminals += 1;
      state.receipt.resolve({
        deliveryId: state.deliveryId,
        status: 'acknowledged',
        receiptId: `codex:${handle.threadId}:${continuation.turnId}`,
      });
    };
    const outcome = await handle.runTurn({
      ...request(state.marker),
      hostToolPolicy: {
        allowedTools: state.projection.tools.map((tool) => ({
          namespace: null,
          tool: tool.name,
        })),
        authorize: async (call) => {
          assert.equal(call.threadId, handle.threadId);
          assert(call.turnId && call.callId);
          return true;
        },
        execute: async (call) => ({
          success: true,
          contentItems: [
            {
              type: 'inputText',
              text: await state.invoke(
                {
                  ...state.owner,
                  turnId: call.turnId,
                  toolCallId: call.callId,
                },
                call.tool,
                call.arguments,
              ),
            },
          ],
        }),
      },
    });
    assert.equal(outcome.status, 'completed');
    assert(outcome.turnId);
    assert(
      state.calls.every((call) => call.turnId === outcome.turnId),
      'native call IDs belong to the exact parent turn',
    );
    state.rootTerminals += 1;
    await state.deleteSources();
    state.rootFinished.resolve();
    await state.delivery;
    const nativeTools = state.advertised.flatMap((tool) =>
      tool.tools
        ? tool.tools.map((name) => `${tool.name}.${name}`)
        : [tool.name],
    );
    assert(
      nativeTools.every(
        (name) =>
          name.startsWith('probe_') ||
          ['request_user_input', 'skills.list', 'skills.read'].includes(name),
      ),
      `unexpected native tool: ${nativeTools.join(', ')}`,
    );
    await verifyResult(state);
  } finally {
    clearTimeout(timer);
    state.broker.close();
    if (handle) await handle.dispose({ deleteThread: true });
    await service.shutdown();
  }
}

async function verifyResult(state) {
  assert.deepEqual(state.errors, []);
  assert.deepEqual(
    [...state.nativeDenials].sort(),
    [...state.deniedTools].sort(),
  );
  const nativeLaunch = JSON.parse(await readFile(state.launchPath, 'utf8'));
  assert.equal(nativeLaunch.nativeSessionId, state.nativeSessionId);
  assert.equal(nativeLaunch.phase, 'identified');
  const recoveredLaunch = DelegationLaunchJournal.restore(
    nativeLaunch,
    state.launchPersistence,
  );
  assert.equal(
    await recoveredLaunch.beforeStart(),
    false,
    'restart cannot repeat native launch',
  );
  await recoveredLaunch.settle('completed');
  assert.equal(
    JSON.parse(await readFile(state.launchPath, 'utf8')).phase,
    'settled',
  );
  assert.deepEqual(state.launchWrites, [
    'reserved',
    'starting',
    'identified',
    'settled',
  ]);
  assert.equal(
    state.overlayReads,
    state.channel === 'background' ? 2 : 1,
    'both launch and continuation read retained overlay bytes',
  );
  assert.equal(
    state.overlayReceipts.size,
    state.overlayReads,
    'native inference consumed every retained skill read',
  );
  assert.equal(
    state.promptConsumed,
    true,
    'native inference consumed the retained Agent instructions',
  );
  assert.equal(
    state.calls.length,
    state.harness === 'codex' && state.channel === 'foreground' ? 2 : 1,
    'native spawn and optional wait calls reached the fake broker',
  );
  assert.equal(state.rootTerminals, state.channel === 'background' ? 2 : 1);
  assert.equal(state.coordinator.snapshot().status, 'acknowledged');
  let duplicates = 0;
  const retained = JSON.parse(
    await readFile(path.join(temporary, `${state.deliveryId}.json`), 'utf8'),
  );
  assert.equal(retained.version, 1);
  assert.deepEqual(retained.state, state.coordinator.snapshot());
  const restarted = new DelegationDeliveryCoordinator(
    state.deliveryId,
    { commit: async () => {} },
    retained.state,
  );
  await restarted.dispatch({
    dispatch: async () => {
      duplicates += 1;
      throw new Error('duplicate dispatch');
    },
    lookupReceipt: async () => undefined,
  });
  assert.equal(duplicates, 0);
  reports.push({
    harness: state.harness,
    channel: state.channel,
    ...(state.harness === 'claude'
      ? {
          sdkInheritedCanary: state.sdkInheritedCanary,
          spawnEnvironmentKeys: state.spawnEnvironmentKeys,
        }
      : {}),
    nativeSessionId: state.nativeSessionId,
    providerCalls: state.calls,
    rootTerminals: state.rootTerminals,
    delivery: state.coordinator.snapshot(),
    persistedTransitions: state.writes.map((value) => value.status),
    nativeLaunchTransitions: state.launchWrites,
    retainedOverlayReads: state.overlayReads,
    retainedOverlayNativeReceipts: state.overlayReceipts.size,
    retainedPromptConsumed: state.promptConsumed,
    childResultRetained: state.childResult.finalText === state.childReport,
    advertised: state.advertised,
    deniedNativeTools: [...state.nativeDenials].sort(),
    nativeDenialOutcome: state.nativeDenialOutcome,
  });
}

try {
  for (const channel of ['foreground', 'background'])
    await verifyClaude(channel);
  for (const channel of ['foreground', 'background'])
    await verifyCodex(channel);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ passed: true, reports }, null, 2));
  console.log(
    JSON.stringify({
      passed: true,
      cases: reports.map(({ harness, channel }) => `${harness}/${channel}`),
    }),
  );
} finally {
  if (originalCanary === undefined)
    delete process.env.DELEGATION_UNRELATED_SECRET_CANARY;
  else process.env.DELEGATION_UNRELATED_SECRET_CANARY = originalCanary;
  wss.clients.forEach((client) => client.terminate());
  wss.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
