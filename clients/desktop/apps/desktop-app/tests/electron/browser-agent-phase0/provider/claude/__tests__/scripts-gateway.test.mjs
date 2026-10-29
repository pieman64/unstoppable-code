import assert from 'node:assert/strict';
import test from 'node:test';
import { BROWSER_AGENT_TOOL_NAMES } from '../../shared/tool-schemas.mjs';
import {
  OBSERVATION_TOOLS,
  createBrowserGateway,
  newSentinel,
} from '../gateway.mjs';
import {
  PROBE_SYSTEM_PROMPT,
  ROTATION_LOOP,
  browserToolName,
  budgetHookSteps,
  controlSteps,
  isolatedSteps,
  launchFailureSteps,
  markerText,
  probeUserPrompt,
  rotationSteps,
  scenarioKey,
} from '../scripts.mjs';

test('scenario markers match the mock marker grammar', () => {
  const key = scenarioKey('epoch1');
  assert.match(markerText(key), /^\[Canopy-C[A-Za-z0-9_-]+\]$/);
  assert.match(probeUserPrompt(key), /^\[Canopy-Cbap0epoch1\]/);
  assert.throws(() => scenarioKey('bad label'));
  assert.ok(PROBE_SYSTEM_PROMPT.length < 300);
  assert.ok(!/claude code/i.test(PROBE_SYSTEM_PROMPT));
});

test('rotation loop is the planned native tool loop and every input validates', () => {
  assert.deepEqual(ROTATION_LOOP, [
    'observe',
    'read_text',
    'scroll',
    'observe',
    'record_progress',
    'finish',
  ]);
  const steps = rotationSteps(2);
  assert.equal(steps.length, ROTATION_LOOP.length + 1);
  steps.slice(0, -1).forEach((step, index) => {
    assert.equal(step.toolCalls.length, 1);
    assert.equal(step.toolCalls[0].name, browserToolName(ROTATION_LOOP[index]));
    assert.equal(step.stopReason, 'tool_use');
  });
  assert.equal(steps.at(-1).toolCalls, undefined);
  assert.equal(steps.at(-1).stopReason, 'end_turn');
  assert.match(steps[0].text, /Epoch 2/);
});

test('other scripted conversations', () => {
  assert.equal(controlSteps()[0].toolCalls[0].name, 'Bash');
  const isolated = isolatedSteps();
  assert.deepEqual(
    isolated.slice(0, 2).map((step) => step.toolCalls[0].name),
    [browserToolName('observe'), 'Bash'],
  );
  assert.deepEqual(launchFailureSteps(), [
    { error: { status: 400, message: 'Probe induced launch failure.' } },
  ]);
  assert.equal(budgetHookSteps(4).length, 5);
});

function fakeSdk() {
  const registered = [];
  return {
    registered,
    tool: (name, description, shape, handler) => {
      const definition = { name, description, shape, handler };
      registered.push(definition);
      return definition;
    },
    createSdkMcpServer: (options) => ({
      type: 'sdk',
      instance: {},
      ...options,
    }),
  };
}

test('gateway exposes exactly the 22 derived tools with an always-loaded in-process server', async () => {
  const sdk = fakeSdk();
  const gateway = createBrowserGateway(sdk, {
    epoch: 1,
    sentinel: newSentinel(1),
  });
  assert.equal(gateway.server.name, 'browser');
  assert.equal(gateway.server.alwaysLoad, true);
  assert.equal(gateway.server.tools.length, 22);
  assert.deepEqual(gateway.toolNames, [...BROWSER_AGENT_TOOL_NAMES]);
  assert.deepEqual(
    gateway.allowedTools,
    BROWSER_AGENT_TOOL_NAMES.map((name) => `mcp__browser__${name}`),
  );
  for (const definition of sdk.registered) {
    assert.match(definition.description, /Probe placeholder description/);
    assert.equal(typeof definition.shape, 'object');
  }
});

test('gateway handlers validate arguments and return sentinel-bearing observations', async () => {
  const sdk = fakeSdk();
  const sentinel = newSentinel(3);
  assert.match(sentinel, /^BAP0_PAGE_E3_[0-9a-f]{12}$/);
  const gateway = createBrowserGateway(sdk, { epoch: 3, sentinel });
  const handler = (name) =>
    sdk.registered.find((definition) => definition.name === name).handler;
  const observed = await handler('observe')({});
  assert.ok(observed.content[0].text.includes(sentinel));
  assert.ok(
    Buffer.byteLength(observed.content[0].text) > 15_000,
    'about 19 KB observation',
  );
  const scrolled = await handler('scroll')({
    to: { kind: 'page', direction: 'down', amount: 'page' },
  });
  assert.ok(scrolled.content[0].text.includes(sentinel));
  const ack = await handler('record_progress')({ summary: 'ok' });
  assert.equal(JSON.parse(ack.content[0].text).ok, true);
  const invalid = await handler('read_text')({ maxCharacters: 999_999 });
  assert.equal(invalid.isError, true);
  const events = gateway.events();
  assert.deepEqual(
    events.map((event) => [event.tool, event.valid]),
    [
      ['observe', true],
      ['scroll', true],
      ['record_progress', true],
      ['read_text', false],
    ],
  );
  assert.ok(
    OBSERVATION_TOOLS.has('observe') && !OBSERVATION_TOOLS.has('finish'),
  );
});

test('sentinels are unique per epoch and nonce', () => {
  assert.notEqual(newSentinel(1), newSentinel(1));
  assert.ok(newSentinel(1).includes('_E1_') && newSentinel(2).includes('_E2_'));
});
