// In-process tests for the LLM mock surface (WP-MOCK-LLM, Doc 5).
//
// Boots a real loopback HTTP server wired to `handleLlmRequest` and drives a
// scripted conversation that streams TEXT + a TOOL CALL + completes, for BOTH
// the Anthropic Messages and OpenAI Responses wire formats. Also covers
// stateless step resolution (assistant-turn count), helper-fingerprint matching,
// the benign default fallback, count_tokens, and non-streaming JSON.
//
// Run:  node --test apps/desktop-app/tests/electron/mock-server/routes/llm.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { tsImport } from 'tsx/esm/api';
import {
  DEFERRED_TOOLS_RESUME_MARKER,
  PROMPT_SCENARIO_KEY_PREFIX,
  buildResponsesEvents,
  handleLlmRequest,
  normalizeLlmProxyPath,
  resolveCannedStep,
  resolveResponsesReply,
} from './llm.mjs';
import { attachResponsesWebSocket } from './responsesWs.mjs';
import {
  getScenarioActivity,
  registerScenario,
  resetAll,
} from '../control-plane.mjs';

function startServer({ responsesWebSocket = false } = {}) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    void handleLlmRequest(request, response, url).then((handled) => {
      if (!handled) {
        response.writeHead(404).end('not handled');
      }
    });
  });
  const wss = responsesWebSocket ? attachResponsesWebSocket(server) : undefined;
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, wss, base: `http://127.0.0.1:${port}` });
    });
  });
}

function waitForWsOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

function waitForResponseCompleted(ws) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for response.completed'));
    }, 1000);
    ws.on('message', (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
        return;
      }
      frames.push(frame);
      if (frame.type === 'response.completed') {
        clearTimeout(timeout);
        resolve({ completed: frame, frames });
      }
    });
    ws.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    ws.once('close', () => {
      clearTimeout(timeout);
      reject(new Error('WebSocket closed before response.completed'));
    });
  });
}

async function postSse(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const events = text
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
      const dataRaw = dataLine ? dataLine.slice('data:'.length).trim() : '';
      if (dataRaw === '[DONE]') {
        return { done: true };
      }
      try {
        return JSON.parse(dataRaw);
      } catch {
        return { raw: dataRaw };
      }
    });
  return { status: res.status, events };
}

const MARKER = '[Canopy-CTEST]';

const {
  AI_CREDITS_CORRELATION_HEADER,
  AI_CREDITS_NO_BILLING_SOURCE_MESSAGE,
  AI_CREDITS_PROXY_ERROR_MARKER,
  parseCanopyProxyError,
} = await tsImport(
  fileURLToPath(
    new URL(
      '../../../../../../packages/protocol/src/llm-gateway/index.ts',
      import.meta.url,
    ),
  ),
  import.meta.url,
);

// Inline conversation: step 0 streams a tool call, step 1 streams final text.
const SCRIPT = {
  id: 'CTEST',
  steps: [
    {
      thinking: 'thinking briefly',
      toolCalls: [{ name: 'mcp__canopy__AskUserQuestion', input: { q: 1 } }],
      stopReason: 'tool_use',
    },
    {
      text: 'Final answer.',
      stopReason: 'end_turn',
      usage: { outputTokens: 5 },
    },
  ],
};

test('resolveCannedStep: stateless step index from assistant-turn count', () => {
  const scenario = { llm: { conversations: { CTEST: SCRIPT } } };
  const step0 = resolveCannedStep({
    userText: MARKER,
    systemText: '',
    assistantTurns: 0,
    scenario,
  });
  assert.equal(step0.step.stopReason, 'tool_use');
  assert.equal(step0.step.toolCalls[0].name, 'mcp__canopy__AskUserQuestion');

  const step1 = resolveCannedStep({
    userText: MARKER,
    systemText: '',
    assistantTurns: 1,
    scenario,
  });
  assert.equal(step1.step.text, 'Final answer.');
  assert.equal(step1.step.stopReason, 'end_turn');
  assert.equal(step1.usage.outputTokens, 5);
});

test('resolveCannedStep: explicit request tags are stable across provider history shapes', () => {
  const scenario = {
    llm: {
      steps: [{ text: 'History fallback.', stopReason: 'end_turn' }],
      stepsByRequestTag: {
        initial: { text: 'Initial tagged reply.', stopReason: 'end_turn' },
        later: {
          text: 'Later tagged reply.',
          stopReason: 'end_turn',
          usage: { outputTokens: 7 },
        },
      },
    },
  };
  const recreated = resolveCannedStep({
    userText: `${MARKER} [Canopy-Mock-Request:later]`,
    systemText: '',
    assistantTurns: 0,
    scenario,
  });
  const reused = resolveCannedStep({
    userText: `${MARKER} [Canopy-Mock-Request:initial]\n[Canopy-Mock-Request:later]`,
    systemText: '',
    assistantTurns: 4,
    scenario,
  });
  assert.equal(recreated.step.text, 'Later tagged reply.');
  assert.equal(reused.step.text, 'Later tagged reply.');
  assert.equal(reused.usage.outputTokens, 7);
});

test('resolveCannedStep: tagged multi-step schedules ignore older assistant history', () => {
  const taggedSteps = [
    { toolCalls: [{ name: 'first_tool', input: {} }], stopReason: 'tool_use' },
    { text: 'Tagged final.', stopReason: 'end_turn' },
  ];
  const scenario = {
    llm: {
      steps: taggedSteps,
      stepsByRequestTag: { measured: taggedSteps },
    },
  };
  const userText = `${MARKER} [Canopy-Mock-Request:measured]`;

  assert.equal(
    resolveCannedStep({
      userText,
      systemText: '',
      assistantTurns: 40,
      assistantTurnsAfterRequestTag: 0,
      scenario,
    }).step.stopReason,
    'tool_use',
  );
  assert.equal(
    resolveCannedStep({
      userText,
      systemText: '',
      assistantTurns: 41,
      assistantTurnsAfterRequestTag: 1,
      scenario,
    }).step.text,
    'Tagged final.',
  );
});

test('resolveCannedStep: scenarios can override a helper fingerprint', () => {
  const result = resolveCannedStep({
    userText: '[Canopy-CHELPER-FALLBACK] summarize this',
    systemText: 'You are an expert at providing concise topic summaries.',
    assistantTurns: 0,
    scenario: {
      llm: {
        helperStepsById: {
          'topic-summary': { text: '', stopReason: 'end_turn' },
        },
      },
    },
  });

  assert.equal(result.step.text, '');
  assert.equal(result.step.stopReason, 'end_turn');
});

test('resolveCannedStep: deferred resume ignores aborted assistant chunks', () => {
  const scenario = {
    llm: {
      conversations: {
        CTEST: {
          steps: [{}, {}, {}],
          resumeSteps: [
            {
              toolCalls: [{ name: 'mcp__fixture__echo', input: {} }],
              stopReason: 'tool_use',
            },
            { text: 'Resumed.', stopReason: 'end_turn' },
          ],
        },
      },
    },
  };
  const first = resolveCannedStep({
    userText: `${MARKER}\nRequested items now enabled, continue the interrupted request.`,
    systemText: '',
    assistantTurns: 4,
    assistantToolNames: ['mcp__canopy__SearchDeferredTools'],
    scenario,
  });
  assert.equal(first.step.toolCalls[0].name, 'mcp__fixture__echo');

  const second = resolveCannedStep({
    userText: `${MARKER}\nRequested items now enabled, continue the interrupted request.`,
    systemText: '',
    assistantTurns: 5,
    assistantToolNames: [
      'mcp__canopy__SearchDeferredTools',
      'mcp__fixture__echo',
    ],
    scenario,
  });
  assert.equal(second.step.text, 'Resumed.');

  const secondWithProviderNormalizedToolName = resolveCannedStep({
    userText: `${MARKER}\nRequested items now enabled, continue the interrupted request.`,
    systemText: '',
    assistantTurns: 5,
    assistantTurnsAfterResume: 1,
    assistantToolNames: [
      'mcp__canopy__SearchDeferredTools',
      'provider_normalized_deferred_echo',
    ],
    scenario,
  });
  assert.equal(secondWithProviderNormalizedToolName.step.text, 'Resumed.');
});

test('resolveCannedStep: helper fingerprint + default fallback', () => {
  const summary = resolveCannedStep({
    userText:
      '<user_message_to_summarize>[Canopy-CTEST] Summarize this</user_message_to_summarize>',
    systemText: 'You are an expert at providing concise topic summaries.',
    assistantTurns: 0,
    scenario: {
      llm: { steps: [{ text: 'Marker script reply', stopReason: 'end_turn' }] },
    },
  });
  assert.equal(summary.step.text, 'Mock topic summary');

  const branch = resolveCannedStep({
    userText: 'name this branch',
    systemText: 'You are an expert at generating concise git branch names.',
    assistantTurns: 0,
    scenario: {},
  });
  assert.deepEqual(JSON.parse(branch.step.text), {
    branchName: 'canopy/mock-branch',
  });

  const consolidation = resolveCannedStep({
    userText: 'consolidate these notes',
    systemText:
      'You consolidate a bounded local memory index and its topic files.',
    assistantTurns: 0,
    scenario: {},
  });
  assert.deepEqual(JSON.parse(consolidation.step.text), {
    memoryMd: '# Personal preferences\n\n- Mock consolidated memory.\n',
    topicFiles: [],
  });

  const chatProfile = resolveCannedStep({
    userText: 'T1. Fix the login redirect',
    systemText:
      "You summarize what a person's own chat titles reveal about them.",
    assistantTurns: 0,
    scenario: {},
  });
  assert.deepEqual(JSON.parse(chatProfile.step.text), { facts: [] });

  const fallback = resolveCannedStep({
    userText: 'hello with no marker',
    systemText: 'arbitrary system prompt',
    assistantTurns: 0,
    scenario: {},
  });
  assert.equal(fallback.step.stopReason, 'end_turn');
  assert.ok(fallback.step.text.length > 0);
});

// ── AI Credits gateway proxy prefixes (ECW-9091) ─────────────────────────────
//
// In E2E the cloud base URL *is* this mock server, so a credits-routed turn
// arrives on the web LLM-proxy paths. Without prefix normalization those 404,
// which would make a routed turn indistinguishable from the bug being fixed.

test('normalizeLlmProxyPath strips the LLM-proxy prefixes', () => {
  assert.deepEqual(
    normalizeLlmProxyPath('/api/v1/llm-proxy/anthropic/v1/messages'),
    {
      pathname: '/v1/messages',
      proxyTag: 'anthropic',
    },
  );
  assert.deepEqual(
    normalizeLlmProxyPath(
      '/api/v1/llm-proxy/anthropic/v1/messages/count_tokens',
    ),
    { pathname: '/v1/messages/count_tokens', proxyTag: 'anthropic' },
  );
  // The bare prefix is NOT the proxy: production's catch-all needs a trailing
  // segment, so serving it here would hide a broken base URL.
  assert.deepEqual(
    normalizeLlmProxyPath('/api/v1/llm-proxy/openai/responses'),
    {
      pathname: '/api/v1/llm-proxy/openai/responses',
      proxyTag: null,
    },
  );
  // What Codex actually sends. `ai-credits-routing.ts` hands it a base URL of
  // `<cloud>/api/v1/llm-proxy/openai/responses` and the app-server appends its
  // own `/responses`, so the wire path carries the segment twice. Production
  // serves that shape — the route is `openai/responses/[...path]`, a catch-all
  // that *requires* a trailing segment — while this mock used to 404 it, which
  // is why no spec could exercise a credits-routed Codex turn.
  assert.deepEqual(
    normalizeLlmProxyPath('/api/v1/llm-proxy/openai/responses/responses'),
    { pathname: '/v1/responses', proxyTag: 'openai' },
  );
  // Native provider paths are untouched.
  assert.deepEqual(normalizeLlmProxyPath('/v1/messages'), {
    pathname: '/v1/messages',
    proxyTag: null,
  });
  // A same-prefix-looking path that is not actually the proxy stays as-is.
  assert.deepEqual(normalizeLlmProxyPath('/api/v1/llm-proxy/anthropicx'), {
    pathname: '/api/v1/llm-proxy/anthropicx',
    proxyTag: null,
  });
});

test('a proxied Anthropic turn is served and tagged llmProxy:anthropic', async () => {
  resetAll();
  registerScenario('CTEST', { llm: { conversations: { CTEST: SCRIPT } } });
  const { server, base } = await startServer();
  try {
    const r0 = await postSse(base, '/api/v1/llm-proxy/anthropic/v1/messages', {
      model: 'claude-mock',
      stream: true,
      messages: [{ role: 'user', content: `${MARKER} go` }],
    });
    assert.equal(r0.status, 200);
    assert.ok(r0.events.map((e) => e.type).includes('message_stop'));
    assert.equal(getScenarioActivity('Canopy-CTEST')['llmProxy:anthropic'], 1);
  } finally {
    server.close();
  }
});

test('a session-title helper carrying the chat marker gets no scripted chat step', async () => {
  resetAll();
  registerScenario('Canopy-CTEST', {
    llm: {
      steps: [{ text: 'Unscripted turn finished.', stopReason: 'end_turn' }],
      stepsByRequestTag: {
        fresh: [
          {
            toolCalls: [{ name: 'Bash', input: { command: 'grep -rl x .' } }],
            stopReason: 'tool_use',
          },
          { text: 'Turn fresh finished.', stopReason: 'end_turn' },
        ],
      },
    },
  });
  const { server, base } = await startServer();
  const turn = `${MARKER} [Canopy-Mock-Request:fresh] Run turn fresh.`;
  try {
    // The production Claude Agent SDK title helper, captured from a
    // release-like run: it wraps the chat's own message.
    const title = await postSse(
      base,
      '/api/v1/llm-proxy/anthropic/v1/messages',
      {
        model: 'anthropic/claude-haiku-5.5',
        stream: true,
        system:
          "You are a Claude agent, built on Anthropic's Claude Agent SDK.\nYou are naming a coding session so the user can pick it out of a long list of sessions.",
        messages: [{ role: 'user', content: `<session>\n${turn}\n</session>` }],
      },
    );
    assert.equal(title.status, 200);
    assert.ok(
      !title.events.some((event) => event.content_block?.type === 'tool_use'),
    );
    assert.equal(
      getScenarioActivity('Canopy-CTEST')['llmRequests:fresh'],
      undefined,
    );
    assert.equal(
      getScenarioActivity('Canopy-CTEST')['helperRequests:session-title'],
      1,
    );

    const chat = await postSse(
      base,
      '/api/v1/llm-proxy/anthropic/v1/messages',
      {
        model: 'anthropic/claude-opus-5.5',
        stream: true,
        system: "You are Claude Code, Anthropic's official CLI for Claude.",
        messages: [{ role: 'user', content: turn }],
      },
    );
    assert.ok(
      chat.events.some(
        (event) =>
          event.content_block?.type === 'tool_use' &&
          event.content_block.name === 'Bash',
      ),
    );
    assert.equal(getScenarioActivity('Canopy-CTEST')['llmRequests:fresh'], 1);
  } finally {
    server.close();
  }
});

test('a proxied OpenAI responses turn is served and tagged llmProxy:openai', async () => {
  resetAll();
  registerScenario('CTEST', { llm: { conversations: { CTEST: SCRIPT } } });
  const { server, base } = await startServer();
  try {
    const r0 = await postSse(
      base,
      // The shape Codex puts on the wire, not a hand-rolled one: the base URL
      // already ends in `/responses` and the app-server appends its own.
      '/api/v1/llm-proxy/openai/responses/responses',
      {
        model: 'gpt-mock',
        stream: true,
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: `${MARKER} go` }],
          },
        ],
      },
    );
    assert.equal(r0.status, 200);
    assert.equal(getScenarioActivity('Canopy-CTEST')['llmProxy:openai'], 1);
  } finally {
    server.close();
  }
});

// CAN-5348: the hosted refusal must exercise the real proxy-error parser,
// including when an earlier request in the same turn already ran a tool.
for (const provider of ['anthropic', 'openai']) {
  test(`${provider} hosted no-billing scenario refuses before work and after a tool, then permits recovery`, async () => {
    resetAll();
    const path =
      provider === 'anthropic'
        ? '/api/v1/llm-proxy/anthropic/v1/messages'
        : '/api/v1/llm-proxy/openai/responses/responses';
    const user = { role: 'user', content: `${MARKER} restore this prompt` };
    const body = (history, stream) => ({
      model: `${provider}-mock`,
      stream,
      ...(provider === 'anthropic'
        ? { messages: history }
        : { input: history }),
    });
    const { server, base } = await startServer();
    const post = (history, stream) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body(history, stream)),
      });
    const assertRefusal = async (response) => {
      assert.equal(response.status, 402);
      assert.match(response.headers.get('content-type'), /application\/json/);
      const payload = await response.json();
      // Hosted `proxyFailureBody` order; truncation fallbacks rely on it.
      assert.deepEqual(Object.keys(payload.error), [
        'canopy_proxy',
        'code',
        'correlation_id',
        'message',
      ]);
      assert.equal(payload.error.canopy_proxy, AI_CREDITS_PROXY_ERROR_MARKER);
      assert.equal(payload.error.code, 'no_billing_source');
      assert.equal(payload.error.message, AI_CREDITS_NO_BILLING_SOURCE_MESSAGE);
      assert.equal(typeof payload.error.correlation_id, 'string');
      assert.ok(payload.error.correlation_id.length > 0);
      assert.equal(
        response.headers.get(AI_CREDITS_CORRELATION_HEADER),
        payload.error.correlation_id,
      );
      assert.deepEqual(parseCanopyProxyError(JSON.stringify(payload)), {
        code: 'no_billing_source',
        message: AI_CREDITS_NO_BILLING_SOURCE_MESSAGE,
        correlationId: payload.error.correlation_id,
      });
    };
    try {
      // Both JSON and streaming requests fail before emitting provider frames.
      registerScenario('CTEST', {
        llm: { steps: [{ error: 'no_billing_source' }] },
      });
      for (const stream of [false, true]) {
        await assertRefusal(await post([user], stream));
      }

      // An explicit object directive also works after actual tool output.
      registerScenario('CTEST', {
        llm: {
          steps: [SCRIPT.steps[0], { error: { type: 'no_billing_source' } }],
        },
      });
      const first = await post([user], false);
      assert.equal(first.status, 200);
      const firstPayload = await first.json();
      let history;
      if (provider === 'anthropic') {
        const tool = firstPayload.content.find(
          (block) => block.type === 'tool_use',
        );
        assert.equal(tool.name, SCRIPT.steps[0].toolCalls[0].name);
        history = [
          user,
          { role: 'assistant', content: firstPayload.content },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: tool.id, content: 'Blue' },
            ],
          },
        ];
      } else {
        const tool = firstPayload.output.find(
          (item) => item.type === 'function_call',
        );
        assert.equal(tool.name, SCRIPT.steps[0].toolCalls[0].name);
        history = [
          user,
          ...firstPayload.output,
          {
            type: 'function_call_output',
            call_id: tool.call_id,
            output: 'Blue',
          },
        ];
      }
      await assertRefusal(await post(history, true));
      assert.equal(
        getScenarioActivity('Canopy-CTEST')[`llmProxy:${provider}`],
        4,
      );

      // A test can refresh eligibility independently and replace the refusal
      // with a successful reply for a normal resend using the same prompt.
      registerScenario('CTEST', {
        llm: { steps: [{ text: 'Recovered reply.', stopReason: 'end_turn' }] },
      });
      const recovered = await postSse(base, path, body([user], true));
      assert.equal(recovered.status, 200);
      assert.ok(
        recovered.events.some((event) =>
          provider === 'anthropic'
            ? event.delta?.text === 'Recovered reply.'
            : event.type === 'response.output_text.done' &&
              event.text === 'Recovered reply.',
        ),
      );
      assert.ok(
        recovered.events.some((event) =>
          provider === 'anthropic'
            ? event.type === 'message_stop'
            : event.type === 'response.completed',
        ),
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

test('OpenAI responses rejects minimal reasoning effort for GPT-5.6 Luna', async () => {
  const { server, base } = await startServer();
  try {
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-luna',
        reasoning: { effort: 'minimal' },
        input: [{ role: 'user', content: 'Name this branch.' }],
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: {
        code: 'invalid_value',
        message:
          "Invalid 'reasoning.effort': 'minimal' is not supported for gpt-5.6-luna",
        param: 'reasoning.effort',
        type: 'invalid_request_error',
      },
    });
  } finally {
    server.close();
  }
});

test('Anthropic /v1/messages streams text + tool call + completes and records request-text observers', async () => {
  resetAll();
  registerScenario('CTEST', {
    llm: {
      conversations: { CTEST: SCRIPT },
      requestTextObservers: [
        { key: 'graph-steering', text: 'graph-first reminder' },
      ],
    },
  });
  const { server, base } = await startServer();
  try {
    // Step 0: no assistant turns yet → tool call.
    const r0 = await postSse(base, '/v1/messages', {
      model: 'claude-mock',
      stream: true,
      system: 'graph-first reminder',
      messages: [{ role: 'user', content: `${MARKER} go` }],
    });
    assert.equal(r0.status, 200);
    const types0 = r0.events.map((e) => e.type);
    assert.ok(types0.includes('message_start'));
    assert.ok(types0.includes('content_block_start'));
    const toolStart = r0.events.find(
      (e) => e.content_block?.type === 'tool_use',
    );
    assert.equal(toolStart.content_block.name, 'mcp__canopy__AskUserQuestion');
    const inputDelta = r0.events.find(
      (e) => e.delta?.type === 'input_json_delta',
    );
    assert.ok(inputDelta);
    const msgDelta0 = r0.events.find((e) => e.type === 'message_delta');
    assert.equal(msgDelta0.delta.stop_reason, 'tool_use');
    assert.ok(types0.includes('message_stop'));

    // Step 1: one assistant turn + a tool_result in history → final text.
    const r1 = await postSse(base, '/v1/messages', {
      model: 'claude-mock',
      stream: true,
      messages: [
        {
          role: 'user',
          content: `${MARKER} go [Canopy-Mock-Request:second-turn]`,
        },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }],
        },
      ],
    });
    const textDelta = r1.events.find((e) => e.delta?.type === 'text_delta');
    assert.ok(textDelta.delta.text.length > 0);
    const msgDelta1 = r1.events.find((e) => e.type === 'message_delta');
    assert.equal(msgDelta1.delta.stop_reason, 'end_turn');
    assert.equal(msgDelta1.usage.output_tokens, 5);
    assert.equal(getScenarioActivity('Canopy-CTEST').llmRequests, 2);
    assert.equal(
      getScenarioActivity('Canopy-CTEST')['llmObserved:graph-steering'],
      1,
    );
    assert.equal(
      getScenarioActivity('Canopy-CTEST')['llmRequests:second-turn'],
      1,
    );
  } finally {
    server.close();
  }
});

test('a plan-file Write takes its path from the plan-mode reminder in the request', async () => {
  resetAll();
  registerScenario('CTEST', {
    llm: {
      steps: [
        {
          toolCalls: [
            {
              name: 'Write',
              writesPlanModePlanFile: true,
              input: { content: '# Plan' },
            },
          ],
          stopReason: 'tool_use',
        },
      ],
    },
  });
  const { server, base } = await startServer();
  const writeInput = async (reminder) => {
    const { events } = await postSse(base, '/v1/messages', {
      model: 'claude-mock',
      stream: true,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `${MARKER} plan a change` },
            ...(reminder ? [{ type: 'text', text: reminder }] : []),
          ],
        },
      ],
    });
    return JSON.parse(
      events
        .filter((e) => e.delta?.type === 'input_json_delta')
        .map((e) => e.delta.partial_json)
        .join(''),
    );
  };
  try {
    // Both reminder forms, with the spaces a profile or temp directory can
    // carry on either platform.
    for (const [planFile, reminder] of [
      [
        '/tmp/provider-state/claude/plans/plan-a-change-wolf.md',
        (file) =>
          `Plan mode still active. Read-only except plan file (${file}).`,
      ],
      [
        '/Users/CI User/Library/Application Support/claude/plans/plan-a-change.md',
        (file) =>
          `No plan file exists yet. You should create your plan at ${file} using the Write tool.`,
      ],
      [
        'C:\\Users\\CI User\\.claude\\plans\\plan-a-change.md',
        (file) =>
          `Plan mode still active. Read-only except plan file (${file}).`,
      ],
    ]) {
      assert.deepEqual(await writeInput(reminder(planFile)), {
        content: '# Plan',
        file_path: planFile,
      });
    }
    // A request that names no plan file (a helper turn) keeps the scripted
    // input as written.
    assert.deepEqual(await writeInput(undefined), { content: '# Plan' });
  } finally {
    server.close();
  }
});

test('resume marker matches the app-side continuation template', () => {
  // The mock anchors its resume cursor to the message the app injects via
  // DEFERRED_TOOLS_RELOAD_CONTINUATION_TEMPLATE. If the app copy changes, the
  // anchored count silently degrades to the timing-sensitive arithmetic
  // fallback — fail loudly here instead.
  const appSource = readFileSync(
    fileURLToPath(
      new URL(
        '../../../../../../packages/desktop-shared/src/types/deferred-tools.ts',
        import.meta.url,
      ),
    ),
    'utf8',
  );
  assert.ok(
    appSource.includes(
      `'<system_instruction>${DEFERRED_TOOLS_RESUME_MARKER}</system_instruction>'`,
    ),
    'DEFERRED_TOOLS_RESUME_MARKER drifted from DEFERRED_TOOLS_RELOAD_CONTINUATION_TEMPLATE',
  );
});

test('Anthropic resume cursor anchors to the resume message, not total turns', async () => {
  resetAll();
  const RESUME_MARKER = '[Canopy-CRESUME]';
  const RESUME_TEXT =
    '<system_instruction>Requested items now enabled, continue the interrupted request.</system_instruction>';
  registerScenario('CRESUME', {
    llm: {
      steps: [
        { toolCalls: [{ name: 'tool_a', input: {} }], stopReason: 'tool_use' },
        { toolCalls: [{ name: 'tool_b', input: {} }], stopReason: 'tool_use' },
        { text: 'Interrupted stream.', stopReason: 'end_turn' },
      ],
      resumeSteps: [
        {
          toolCalls: [{ name: 'resume_tool', input: { message: 'after' } }],
          stopReason: 'tool_use',
        },
        { text: 'Resume done.', stopReason: 'end_turn' },
      ],
    },
  });
  const { server, base } = await startServer();
  try {
    // History with FOUR pre-resume assistant turns: the interrupt persisted the
    // partial streamed turn AND a synthetic "No response requested."
    // acknowledgment. Total-turn arithmetic (4 - 3 = 1) would skip the resume
    // tool step; the anchored cursor must still serve resumeSteps[0].
    const preResume = [
      { role: 'user', content: `${RESUME_MARKER} go` },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'a', name: 'tool_a', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'b', name: 'tool_b', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'b', content: 'ok' }],
      },
      { role: 'assistant', content: 'Th' },
      { role: 'user', content: '[Request interrupted by user]' },
      { role: 'assistant', content: 'No response requested.' },
      { role: 'user', content: RESUME_TEXT },
    ];
    const r0 = await postSse(base, '/v1/messages', {
      model: 'claude-mock',
      stream: true,
      messages: preResume,
    });
    assert.equal(r0.status, 200);
    const toolStart = r0.events.find(
      (e) => e.content_block?.type === 'tool_use',
    );
    assert.equal(toolStart?.content_block?.name, 'resume_tool');

    // One assistant turn after the resume message → resumeSteps[1].
    const r1 = await postSse(base, '/v1/messages', {
      model: 'claude-mock',
      stream: true,
      messages: [
        ...preResume,
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'r', name: 'resume_tool', input: {} },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'r', content: 'ok' }],
        },
      ],
    });
    const resumeText = r1.events
      .filter((e) => e.delta?.type === 'text_delta')
      .map((e) => e.delta.text)
      .join('');
    assert.equal(resumeText, 'Resume done.');
  } finally {
    server.close();
  }
});

test('OpenAI /v1/responses streams text + tool call + completes', async () => {
  resetAll();
  registerScenario('CTEST', { llm: { conversations: { CTEST: SCRIPT } } });
  const { server, base } = await startServer();
  try {
    // Step 0: tool call.
    const r0 = await postSse(base, '/v1/responses', {
      model: 'codex-mock',
      stream: true,
      input: [{ role: 'user', content: `${MARKER} go` }],
    });
    assert.equal(r0.status, 200);
    const types0 = r0.events.map((e) => e.type);
    assert.ok(types0.includes('response.created'));
    const fnDone = r0.events.find(
      (e) =>
        e.type === 'response.output_item.done' &&
        e.item?.type === 'function_call',
    );
    assert.equal(fnDone.item.name, 'mcp__canopy__AskUserQuestion');
    assert.ok(types0.includes('response.completed'));

    // Step 1: a prior function_call output item in history → final text.
    const r1 = await postSse(base, '/v1/responses', {
      model: 'codex-mock',
      stream: true,
      input: [
        { role: 'user', content: `${MARKER} go` },
        { type: 'function_call', name: 'x', call_id: 'c', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c', output: 'ok' },
      ],
    });
    const textDelta = r1.events.find(
      (e) => e.type === 'response.output_text.delta',
    );
    assert.ok(textDelta.delta.length > 0);
    const completed = r1.events.find((e) => e.type === 'response.completed');
    assert.equal(completed.response.status, 'completed');
    assert.equal(completed.response.usage.output_tokens, 5);
  } finally {
    server.close();
  }
});

test('OpenAI scenario cursor can ignore synthetic assistant bootstrap items', async () => {
  resetAll();
  registerScenario('CBOOTSTRAP', {
    llm: {
      openAiStepCursor: 'completed-scenario-tool-calls',
      steps: [
        {
          toolCalls: [
            {
              namespace: 'collaboration',
              name: 'spawn_agent',
              input: { task_name: 'child_task', message: 'child' },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: 'Parent complete.', stopReason: 'end_turn' },
      ],
    },
  });
  const { server, base } = await startServer();
  const bootstrap = [
    { role: 'assistant', content: 'synthetic one' },
    { role: 'assistant', content: 'synthetic two' },
  ];
  try {
    const first = await postSse(base, '/v1/responses', {
      model: 'codex-mock',
      stream: true,
      input: [
        ...bootstrap,
        { role: 'user', content: '[Canopy-CBOOTSTRAP] go' },
      ],
    });
    const functionCall = first.events.find(
      (event) =>
        event.type === 'response.output_item.done' &&
        event.item?.type === 'function_call',
    )?.item;
    assert.equal(functionCall?.name, 'spawn_agent');
    assert.equal(functionCall?.namespace, 'collaboration');

    const second = await postSse(base, '/v1/responses', {
      model: 'codex-mock',
      stream: true,
      input: [
        ...bootstrap,
        { role: 'user', content: '[Canopy-CBOOTSTRAP] go' },
        functionCall,
        {
          type: 'function_call_output',
          call_id: functionCall.call_id,
          output: 'ok',
        },
      ],
    });
    const text = second.events
      .filter((event) => event.type === 'response.output_text.delta')
      .map((event) => event.delta)
      .join('');
    assert.equal(text, 'Parent complete.');
  } finally {
    server.close();
  }
});

test('OpenAI scenario cursor advances once after a multi-tool step', () => {
  resetAll();
  registerScenario('CMULTITOOL', {
    llm: {
      openAiStepCursor: 'completed-scenario-tool-calls',
      steps: [
        {
          toolCalls: [
            { name: 'duplicate_tool', input: { index: 1 } },
            { name: 'duplicate_tool', input: { index: 2 } },
          ],
          stopReason: 'tool_use',
        },
        { text: 'Both tools complete.', stopReason: 'end_turn' },
      ],
    },
  });

  const { step } = resolveResponsesReply({
    model: 'codex-mock',
    input: [
      { role: 'user', content: '[Canopy-CMULTITOOL] go' },
      {
        type: 'function_call',
        name: 'duplicate_tool',
        call_id: 'first',
        arguments: '{"index":1}',
      },
      {
        type: 'function_call_output',
        call_id: 'first',
        output: 'ok',
      },
      {
        type: 'function_call',
        name: 'duplicate_tool',
        call_id: 'second',
        arguments: '{"index":2}',
      },
      {
        type: 'function_call_output',
        call_id: 'second',
        output: 'ok',
      },
    ],
  });

  assert.equal(step.text, 'Both tools complete.');
});

test('OpenAI scenario cursor correlates reused call IDs in history order', () => {
  resetAll();
  registerScenario('CREUSEDCALLID', {
    llm: {
      openAiStepCursor: 'completed-scenario-tool-calls',
      steps: [
        {
          toolCalls: [{ name: 'first_tool', input: {} }],
          stopReason: 'tool_use',
        },
        {
          toolCalls: [{ name: 'second_tool', input: {} }],
          stopReason: 'tool_use',
        },
        { text: 'Both rounds complete.', stopReason: 'end_turn' },
      ],
    },
  });

  const { step } = resolveResponsesReply({
    model: 'codex-mock',
    input: [
      { role: 'user', content: '[Canopy-CREUSEDCALLID] go' },
      {
        type: 'function_call',
        name: 'first_tool',
        call_id: 'call_mock_0',
        arguments: '{}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_mock_0',
        output: 'ok',
      },
      {
        type: 'function_call',
        name: 'second_tool',
        call_id: 'call_mock_0',
        arguments: '{}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_mock_0',
        output: 'ok',
      },
    ],
  });

  assert.equal(step.text, 'Both rounds complete.');
});

test('OpenAI Responses resolves encrypted subagent turns from the plaintext task route', () => {
  resetAll();
  registerScenario('Canopy-CSUBAGENT', {
    llm: {
      steps: [{ text: 'Child stream.', stopReason: 'end_turn' }],
    },
  });

  const { step } = resolveResponsesReply({
    model: 'codex-mock',
    input: [
      {
        type: 'agent_message',
        author: '/root',
        recipient: '/root/canopy_csubagent',
        content: [
          { type: 'input_text', text: 'Message Type: NEW_TASK' },
          { type: 'encrypted_content', encrypted_content: 'opaque' },
        ],
      },
    ],
  });

  assert.equal(step.text, 'Child stream.');
});

test('marker-less prompts resolve prompt-keyed scenarios for the turn and its helpers', () => {
  resetAll();
  const prompt = 'Where should I add a dark mode toggle?';
  registerScenario(`${PROMPT_SCENARIO_KEY_PREFIX}${prompt}`, {
    llm: {
      steps: [{ text: 'Scripted demo reply.', stopReason: 'end_turn' }],
      helperStepsById: {
        'topic-summary': { text: 'Dark mode toggle', stopReason: 'end_turn' },
        'branch-naming': {
          text: '{"branchName":"dark-mode-toggle"}',
          stopReason: 'end_turn',
        },
      },
    },
  });
  const user = (text) => ({ role: 'user', content: text });

  assert.equal(
    resolveResponsesReply({
      model: 'codex-mock',
      input: [
        user(`<system-reminder>\nProject notes\n</system-reminder>\n${prompt}`),
      ],
    }).step.text,
    'Scripted demo reply.',
  );
  assert.equal(
    resolveResponsesReply({
      model: 'codex-mock',
      instructions:
        'You are an expert at providing concise topic summaries. Summarize.',
      input: [user(prompt)],
    }).step.text,
    'Dark mode toggle',
  );
  assert.equal(
    resolveResponsesReply({
      model: 'codex-mock',
      instructions: 'You are an expert at generating concise git branch names.',
      input: [user(`<task_description>${prompt}</task_description>`)],
    }).step.text,
    '{"branchName":"dark-mode-toggle"}',
  );
  // Only whole lines match; a prompt that merely contains the text does not.
  assert.equal(
    resolveResponsesReply({
      model: 'codex-mock',
      input: [user(`${prompt} Also add tests.`)],
    }).step.text,
    'Mock response from the Canopy UI-automation LLM surface.',
  );
});

test('the latest prompt wins when an earlier turn also has a prompt-keyed scenario', () => {
  resetAll();
  const first = 'Where should I add a dark mode toggle?';
  const second = 'Make those changes on a new branch.';
  registerScenario(`${PROMPT_SCENARIO_KEY_PREFIX}${first}`, {
    llm: { steps: [{ text: 'First scripted reply.', stopReason: 'end_turn' }] },
  });
  registerScenario(`${PROMPT_SCENARIO_KEY_PREFIX}${second}`, {
    llm: {
      steps: [{ text: 'Second scripted reply.', stopReason: 'end_turn' }],
    },
  });

  const { step } = resolveResponsesReply({
    model: 'codex-mock',
    input: [
      { role: 'user', content: first },
      { role: 'assistant', content: 'First scripted reply.' },
      { role: 'user', content: second },
    ],
  });

  assert.equal(step.text, 'Second scripted reply.');
});

test('OpenAI /v1/responses advances through client tool search before an MCP call', async () => {
  resetAll();
  registerScenario('CTOOLSEARCH', {
    llm: {
      steps: [
        {
          toolSearch: { query: 'secret echo', limit: 5 },
          stopReason: 'tool_use',
        },
        {
          toolCalls: [
            {
              namespace: 'mcp__fixture',
              name: 'secret_echo',
              input: { message: 'ok' },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: 'Tool search complete.', stopReason: 'end_turn' },
      ],
    },
  });
  const { server, base } = await startServer();
  const marker = '[Canopy-CTOOLSEARCH]';
  try {
    const searchResponse = await postSse(base, '/v1/responses', {
      model: 'codex-mock',
      stream: true,
      input: [{ role: 'user', content: `${marker} go` }],
    });
    const searchItem = searchResponse.events.find(
      (event) =>
        event.type === 'response.output_item.done' &&
        event.item?.type === 'tool_search_call',
    )?.item;
    assert.deepEqual(searchItem?.arguments, {
      query: 'secret echo',
      limit: 5,
    });
    assert.equal(searchItem?.execution, 'client');

    const toolResponse = await postSse(base, '/v1/responses', {
      model: 'codex-mock',
      stream: true,
      input: [
        { role: 'user', content: `${marker} go` },
        searchItem,
        {
          type: 'tool_search_output',
          call_id: searchItem.call_id,
          execution: 'client',
          status: 'completed',
          tools: [{ name: 'mcp__fixture__secret_echo' }],
        },
      ],
    });
    const functionItem = toolResponse.events.find(
      (event) =>
        event.type === 'response.output_item.done' &&
        event.item?.type === 'function_call',
    )?.item;
    assert.equal(functionItem?.namespace, 'mcp__fixture');
    assert.equal(functionItem?.name, 'secret_echo');

    const finalResponse = await postSse(base, '/v1/responses', {
      model: 'codex-mock',
      stream: true,
      input: [
        { role: 'user', content: `${marker} go` },
        searchItem,
        {
          type: 'tool_search_output',
          call_id: searchItem.call_id,
          execution: 'client',
          status: 'completed',
          tools: [{ name: 'mcp__fixture__secret_echo' }],
        },
        functionItem,
        {
          type: 'function_call_output',
          call_id: functionItem.call_id,
          output: 'ok',
        },
      ],
    });
    assert.equal(
      finalResponse.events.find(
        (event) => event.type === 'response.output_text.done',
      )?.text,
      'Tool search complete.',
    );
  } finally {
    server.close();
  }
});

test('OpenAI Responses WebSocket streams text + completes', async () => {
  resetAll();
  registerScenario('CTEST', { llm: { conversations: { CTEST: SCRIPT } } });
  const { server, wss, base } = await startServer({ responsesWebSocket: true });
  try {
    for (const path of ['/responses', '/v1/responses']) {
      const ws = new WebSocket(`${base.replace(/^http:/, 'ws:')}${path}`);
      try {
        await waitForWsOpen(ws);
        const completedPromise = waitForResponseCompleted(ws);
        ws.send(
          JSON.stringify({
            type: 'response.create',
            model: 'codex-mock',
            input: [
              { role: 'user', content: `${MARKER} go` },
              {
                type: 'function_call',
                name: 'x',
                call_id: 'c',
                arguments: '{}',
              },
              { type: 'function_call_output', call_id: 'c', output: 'ok' },
            ],
          }),
        );

        const { completed, frames } = await completedPromise;
        assert.ok(frames.some((e) => e.type === 'response.created'));
        assert.ok(frames.some((e) => e.type === 'response.output_text.delta'));
        assert.equal(completed.response.status, 'completed');
        assert.equal(completed.response.usage.output_tokens, 5);
      } finally {
        ws.close();
      }
    }
  } finally {
    wss?.close();
    server.close();
  }
});

test('OpenAI /v1/chat/completions streams chunks then [DONE]', async () => {
  resetAll();
  registerScenario('CTEST', { llm: { conversations: { CTEST: SCRIPT } } });
  const { server, base } = await startServer();
  try {
    const r1 = await postSse(base, '/v1/chat/completions', {
      model: 'codex-mock',
      stream: true,
      messages: [
        { role: 'user', content: `${MARKER} go` },
        { role: 'assistant', content: 'prev' },
      ],
    });
    const contentChunk = r1.events.find((e) => e.choices?.[0]?.delta?.content);
    assert.ok(contentChunk.choices[0].delta.content.length > 0);
    const finish = r1.events.find((e) => e.choices?.[0]?.finish_reason);
    assert.equal(finish.choices[0].finish_reason, 'stop');
    assert.ok(r1.events.some((e) => e.done === true));
  } finally {
    server.close();
  }
});

test('non-streaming JSON + count_tokens', async () => {
  resetAll();
  const { server, base } = await startServer();
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-mock',
        messages: [{ role: 'user', content: 'no marker here' }],
      }),
    });
    const json = await res.json();
    assert.equal(json.type, 'message');
    assert.equal(json.stop_reason, 'end_turn');
    assert.ok(json.content.some((b) => b.type === 'text'));

    const ct = await fetch(`${base}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    const ctJson = await ct.json();
    assert.equal(typeof ctJson.input_tokens, 'number');
  } finally {
    server.close();
  }
});

test('CAN-2835 Responses ids are unique across turns but consistent within one response', () => {
  const step = {
    text: 'reply',
    toolCalls: [{ name: 'echo', input: {} }],
    toolSearch: { query: 'echo' },
  };
  const first = buildResponsesEvents(step, {}, 'mock-model');
  const second = buildResponsesEvents(step, {}, 'mock-model');
  const output = (events) =>
    events.find(({ event }) => event === 'response.completed').data.response
      .output;
  const firstIds = new Set(
    output(first).flatMap((item) => [item.id, item.call_id].filter(Boolean)),
  );
  for (const item of output(second)) {
    assert.equal(firstIds.has(item.id), false);
    if (item.call_id) assert.equal(firstIds.has(item.call_id), false);
  }
  for (const { data } of first.filter(
    ({ event }) => event === 'response.output_item.done',
  )) {
    assert.ok(output(first).some((item) => item.id === data.item.id));
  }
});

// Runtime policy assertions must inspect current tools/instructions, not history.
test('request observers distinguish current tools and the last matching instruction', async () => {
  resetAll();
  registerScenario('CTEST', {
    llm: {
      steps: [{ text: 'OK', stopReason: 'end_turn' }],
      requestTextObservers: [
        { key: 'spawn', text: 'spawn_agent', scope: 'tools' },
        {
          key: 'old-limit',
          text: 'There are 3 available concurrency slots',
          lastMessageContaining: 'available concurrency slots',
        },
        {
          key: 'new-limit',
          text: 'There are 4 available concurrency slots',
          lastMessageContaining: 'available concurrency slots',
        },
      ],
    },
  });
  const { server, base } = await startServer();
  try {
    const response = await postSse(base, '/v1/responses', {
      model: 'gpt-mock',
      stream: true,
      tools: [],
      input: [
        {
          role: 'developer',
          content:
            'There are 3 available concurrency slots; spawn_agent is available.',
        },
        {
          role: 'developer',
          content: 'There are 4 available concurrency slots',
        },
        { role: 'user', content: `${MARKER} go` },
      ],
    });
    assert.equal(response.status, 200);
    const activity = getScenarioActivity('Canopy-CTEST');
    assert.equal(activity['llmObserved:spawn'] ?? 0, 0);
    assert.equal(activity['llmObserved:old-limit'] ?? 0, 0);
    assert.equal(activity['llmObserved:new-limit'], 1);
  } finally {
    server.close();
  }
});

// Codex 0.164 `incremental_tools`: declarations accumulate across
// `additional_tools` items and removals arrive as developer notices.
test('tool observers fold incremental additional_tools updates and removals', async () => {
  resetAll();
  registerScenario('CTEST', {
    llm: {
      steps: [{ text: 'OK', stopReason: 'end_turn' }],
      requestTextObservers: [
        { key: 'spawn', text: '"name":"spawn_agent"', scope: 'tools' },
      ],
    },
  });
  const declare = (namespaces) => ({
    type: 'additional_tools',
    role: 'developer',
    tools: Object.entries(namespaces).map(([name, members]) => ({
      type: 'namespace',
      name,
      tools: members.map((member) => ({ type: 'function', name: member })),
    })),
  });
  const developer = (text) => ({
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text }],
  });
  const user = (text) => ({ role: 'user', content: `${MARKER} ${text}` });
  const initial = declare({
    functions: ['exec_command'],
    multi_agent_v1: ['spawn_agent', 'wait_agent'],
  });
  const namespaceRemoved = developer(
    'The following namespaces are no longer available. Do not call tools in them unless those tools are declared in a later update:\n- multi_agent_v1',
  );
  const memberRemoved = developer(
    'The following tools are no longer available. Do not call them:\n- multi_agent_v1.spawn_agent',
  );
  const observed = () =>
    getScenarioActivity('Canopy-CTEST')['llmObserved:spawn'] ?? 0;
  const { server, base } = await startServer();
  const send = async (input) => {
    const response = await postSse(base, '/v1/responses', {
      model: 'gpt-mock',
      stream: true,
      input,
    });
    assert.equal(response.status, 200);
  };
  try {
    await send([initial, user('enabled')]);
    assert.equal(observed(), 1);
    // A delta-only update keeps earlier declarations.
    await send([
      initial,
      user('a'),
      declare({ functions: ['update_plan'] }),
      user('delta'),
    ]);
    assert.equal(observed(), 2);
    // Disabling multi-agent keeps the cached prefix and removes the namespace.
    await send([initial, user('a'), namespaceRemoved, user('disabled')]);
    assert.equal(observed(), 2);
    await send([initial, user('a'), memberRemoved, user('member removed')]);
    assert.equal(observed(), 2);
    // Re-enabling declares the namespace again.
    await send([
      initial,
      user('a'),
      namespaceRemoved,
      user('b'),
      declare({ multi_agent_v1: ['spawn_agent'] }),
      user('restored'),
    ]);
    assert.equal(observed(), 3);
  } finally {
    server.close();
  }
});

test('request observers tolerate string Responses input', async () => {
  resetAll();
  registerScenario('CTEST', {
    llm: {
      steps: [{ text: 'OK', stopReason: 'end_turn' }],
      requestTextObservers: [
        {
          key: 'marker',
          text: MARKER,
          lastMessageContaining: 'Canopy-CTEST',
        },
      ],
    },
  });
  const { server, base } = await startServer();
  try {
    const response = await postSse(base, '/v1/responses', {
      model: 'gpt-mock',
      stream: true,
      input: 'A valid string-form Responses input',
      messages: [{ role: 'user', content: `${MARKER} go` }],
    });

    assert.equal(response.status, 200);
    assert.equal(getScenarioActivity('Canopy-CTEST')['llmObserved:marker'], 1);
  } finally {
    server.close();
  }
});

test('resolveCannedStep: forbidden system text gates a successful response', () => {
  const scenario = {
    llm: {
      steps: [{ text: 'RULE CONTRACT OK' }],
      forbiddenSystemText: ['DISABLED_RULE_SENTINEL'],
    },
  };
  const request = { userText: MARKER, assistantTurns: 0, scenario };
  assert.match(
    resolveCannedStep({ ...request, systemText: 'DISABLED_RULE_SENTINEL' }).step
      .text,
    /Forbidden system instruction/,
  );
  assert.equal(
    resolveCannedStep({ ...request, systemText: 'enabled instructions' }).step
      .text,
    'RULE CONTRACT OK',
  );
});

test('resolveCannedStep: required system policy gates tool emission, not user text', () => {
  const scenario = {
    llm: {
      ...SCRIPT,
      requiredSystemText: [
        'default to Automations',
        'Honor an explicit request',
      ],
    },
  };
  for (const systemText of ['', 'default to Automations']) {
    const result = resolveCannedStep({
      userText: `${MARKER} default to Automations Honor an explicit request`,
      systemText,
      assistantTurns: 0,
      scenario,
    });
    assert.equal(result.step.toolCalls, undefined);
    assert.match(result.step.text, /Missing required system instruction/);
  }
  const result = resolveCannedStep({
    userText: MARKER,
    systemText: 'default to Automations. Honor an explicit request.',
    assistantTurns: 0,
    scenario,
  });
  assert.equal(result.step.toolCalls[0].name, 'mcp__canopy__AskUserQuestion');
});

// CAN-3637: exact request-boundary evidence, independent of prompt text.
test('records the actual request model on the existing activity endpoint', async () => {
  resetAll();
  registerScenario('CTEST', {
    llm: { steps: [{ text: 'OK', stopReason: 'end_turn' }] },
  });
  const { server, base } = await startServer();
  try {
    const response = await postSse(base, '/v1/responses', {
      model: 'deepseek/deepseek-v4-pro',
      stream: true,
      input: [{ role: 'user', content: `${MARKER} mention gpt-5.5` }],
    });
    assert.equal(response.status, 200);
    const activity = getScenarioActivity('Canopy-CTEST');
    assert.equal(activity['llmModel:deepseek/deepseek-v4-pro'], 1);
    assert.equal(activity['llmModel:gpt-5.5'] ?? 0, 0);
  } finally {
    server.close();
  }
});
