import assert from 'node:assert/strict';
import test from 'node:test';
import { startArrivalPoller } from '../arrival-poller.mjs';
import { driveQuery, latencySummary } from '../query-driver.mjs';

function fakeQuery(script) {
  const state = { closed: 0, options: null };
  const factory = ({ prompt, options }) => {
    state.options = options;
    state.prompt = prompt;
    let done = false;
    const generator = (async function* () {
      for (const step of script) {
        if (done) return;
        if (step.wait)
          await new Promise((resolve) => setTimeout(resolve, step.wait));
        if (step.throw) throw new Error(step.throw);
        if (done) return;
        yield step.message;
      }
    })();
    generator.close = () => {
      state.closed += 1;
      done = true;
    };
    options.stderr?.('warning text');
    return generator;
  };
  return { factory, state };
}

const init = {
  type: 'system',
  subtype: 'init',
  session_id: 'sess-1',
  tools: [],
};
const assistant = {
  type: 'assistant',
  message: {
    content: [
      { type: 'text', text: 'hi' },
      { type: 'tool_use', name: 'mcp__browser__observe' },
    ],
  },
};
const user = {
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] },
};
const result = { type: 'result', subtype: 'success', is_error: false };

test('drives a query to its result, summarizes messages and always closes', async () => {
  const { factory, state } = fakeQuery([
    { message: init },
    { message: assistant },
    { message: user },
    { message: result },
  ]);
  const driven = await driveQuery({
    query: factory,
    prompt: 'p',
    options: { model: 'm' },
    timeoutMs: 2_000,
    drainMs: 20,
  });
  assert.equal(driven.init.session_id, 'sess-1');
  assert.equal(driven.result.subtype, 'success');
  assert.deepEqual(driven.toolUses, ['mcp__browser__observe']);
  assert.deepEqual(driven.messageCounts, {
    system: 1,
    assistant: 1,
    user: 1,
    result: 1,
  });
  assert.equal(driven.error, null);
  assert.equal(driven.timedOut, false);
  assert.ok(state.closed >= 1, 'session closed');
  assert.ok(state.options.abortController instanceof AbortController);
  assert.match(driven.stderrTail, /warning text/);
  assert.ok(
    driven.timeline.initAtMs !== null &&
      driven.timeline.resultAtMs >= driven.timeline.initAtMs,
  );
  assert.equal(state.options.model, 'm');
});

test('a hung query is aborted at the timeout, closed and reported', async () => {
  const { factory, state } = fakeQuery([
    { message: init },
    { wait: 500, message: result },
  ]);
  const startedAt = performance.now();
  const driven = await driveQuery({
    query: factory,
    prompt: 'p',
    options: {},
    timeoutMs: 80,
  });
  assert.equal(driven.timedOut, true);
  assert.equal(driven.result, null);
  assert.ok(state.closed >= 1);
  assert.equal(driven.init.session_id, 'sess-1');
  assert.ok(performance.now() - startedAt < 300, 'deadline settles the driver');
});

test('the deadline settles even when iterator and process discovery never settle', async () => {
  let closed = 0;
  let options;
  const driven = await Promise.race([
    driveQuery({
      query: (input) => {
        options = input.options;
        return {
          [Symbol.asyncIterator]() {
            return this;
          },
          next: () => new Promise(() => {}),
          close: () => {
            closed += 1;
          },
        };
      },
      prompt: 'p',
      options: {},
      timeoutMs: 30,
      findProcesses: () => new Promise(() => {}),
    }),
    new Promise((resolve) => setTimeout(() => resolve(null), 300)),
  ]);
  assert.notEqual(
    driven,
    null,
    'driver returns despite a permanently stalled iterator',
  );
  assert.equal(driven.timedOut, true);
  assert.equal(options.abortController.signal.aborted, true);
  assert.ok(closed >= 1);
});

test('a thrown error is captured, not propagated', async () => {
  const { factory } = fakeQuery([{ message: init }, { throw: 'boom' }]);
  const driven = await driveQuery({
    query: factory,
    prompt: 'p',
    options: {},
    timeoutMs: 1_000,
  });
  assert.equal(driven.error.message, 'boom');
  assert.equal(driven.result, null);
});

test('a pending context observation is finalized at the query deadline', async () => {
  const { factory } = fakeQuery([
    { message: assistant },
    { wait: 500, message: result },
  ]);
  const driven = await driveQuery({
    query: (input) => {
      const q = factory(input);
      q.getContextUsage = () => new Promise(() => {});
      return q;
    },
    prompt: 'p',
    options: {},
    timeoutMs: 30,
    contextUsage: { afterAssistantMessages: 1, timeoutMs: 500 },
  });
  assert.equal(driven.timedOut, true);
  assert.match(driven.contextSamples[0].error ?? '', /query deadline/);
});

test('the process finder is polled once after spawn and pids are recorded', async () => {
  const { factory } = fakeQuery([{ message: init }, { message: result }]);
  let calls = 0;
  const driven = await driveQuery({
    query: factory,
    prompt: 'p',
    options: {},
    timeoutMs: 1_000,
    drainMs: 10,
    findProcesses: async () => {
      calls += 1;
      return [{ pid: 4242, command: '/x/claude --print' }];
    },
  });
  assert.ok(calls >= 1);
  assert.deepEqual(
    driven.processes.map((proc) => proc.pid),
    [4242],
  );
  assert.ok(driven.timeline.spawnObservedAtMs !== null);
});

test('latency summary is relative to the start and labels its resolution', () => {
  const summary = latencySummary(
    {
      startedAtMs: 100,
      spawnObservedAtMs: 160,
      initAtMs: 700,
      firstAssistantAtMs: 900,
      resultAtMs: 1_000,
      closedAtMs: 1_100,
    },
    650,
  );
  assert.deepEqual(
    [
      summary.spawnObservedMs,
      summary.initMs,
      summary.firstRequestMs,
      summary.resultMs,
    ],
    [60, 600, 550, 900],
  );
  assert.match(summary.resolutionNote, /polled/);
  assert.equal(latencySummary({ startedAtMs: 0 }, null).firstRequestMs, null);
});

test('arrival poller stamps each received item once', async () => {
  let received = 0;
  const fake = { snapshot: () => ({ counts: { received } }) };
  let clock = 0;
  const poller = startArrivalPoller(fake, { intervalMs: 5, now: () => clock });
  clock = 10;
  received = 1;
  await new Promise((resolve) => setTimeout(resolve, 20));
  clock = 30;
  received = 3;
  poller.stop();
  const arrivals = poller.arrivals();
  assert.deepEqual(
    arrivals.map((entry) => entry.index),
    [1, 2, 3],
  );
  assert.equal(arrivals[0].atMs, 10);
  assert.equal(arrivals[2].atMs, 30);
  assert.equal(poller.resolutionMs, 5);
});
