import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advertisedToolNames,
  betweenToolDiff,
  breakdownRequest,
  classifyRecordsByPhase,
  compareRequestSeries,
  growthSeries,
  harnessAddedText,
  isMessagesRecord,
  modelsSeen,
  normalizeText,
  recordBody,
  recordsInPhase,
  shapeDigest,
  systemText,
} from '../anthropic-bytes.mjs';

const tool = (name) => ({
  name,
  description: `d ${name}`,
  input_schema: { type: 'object', properties: {} },
});
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = (id, name) => ({
  role: 'assistant',
  content: [
    { type: 'text', text: 'step' },
    { type: 'tool_use', id, name, input: {} },
  ],
});
const result = (id, text) => ({
  role: 'user',
  content: [
    { type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] },
  ],
});

function body(messages, extra = {}) {
  return {
    model: 'claude-sonnet-5-5',
    system: [{ type: 'text', text: 'SYS' }],
    tools: [tool('mcp__browser__observe')],
    messages,
    max_tokens: 100,
    ...extra,
  };
}

test('breakdown sums the parts and reports framing', () => {
  const b = body([
    user('hello'),
    assistant('t1', 'mcp__browser__observe'),
    result('t1', 'x'.repeat(500)),
  ]);
  const total = Buffer.byteLength(JSON.stringify(b));
  const breakdown = breakdownRequest(b, total);
  assert.equal(breakdown.tools.count, 1);
  assert.equal(breakdown.messages.count, 3);
  assert.equal(breakdown.messages.toolResultCount, 1);
  assert.ok(breakdown.messages.toolResultBytes > 500);
  assert.equal(breakdown.system.chars, 3);
  const parts = Object.values(breakdown.topLevelBytes).reduce(
    (a, c) => a + c,
    0,
  );
  assert.equal(breakdown.framingBytes, total - parts);
  assert.ok(breakdown.framingBytes >= 0 && breakdown.framingBytes < 100);
  assert.deepEqual(breakdown.tools.names, ['mcp__browser__observe']);
  assert.equal(breakdown.model, 'claude-sonnet-5-5');
});

test('growth series gives deltas between consecutive requests', () => {
  const series = growthSeries([
    {
      totalBytes: 100,
      messages: { count: 1, toolResultBytes: 0 },
      system: { bytes: 10 },
      tools: { bytes: 20 },
    },
    {
      totalBytes: 350,
      messages: { count: 3, toolResultBytes: 200 },
      system: { bytes: 10 },
      tools: { bytes: 20 },
    },
  ]);
  assert.deepEqual(
    series.map((step) => step.deltaBytes),
    [null, 250],
  );
});

test('between-tool diff: exactly [assistant tool_use, user tool_result] is clean', () => {
  const first = body([user('go')]);
  const second = body([
    user('go'),
    assistant('t1', 'mcp__browser__observe'),
    result('t1', 'page'),
  ]);
  const diff = betweenToolDiff(first, second, { hook: 'BAP0_HOOK_1' });
  assert.equal(diff.shapeOk, true);
  assert.equal(diff.prefixStable, true);
  assert.equal(diff.addedMessageCount, 2);
  assert.deepEqual(diff.extras, []);
  assert.equal(diff.systemChanged, false);
  assert.equal(diff.toolsChanged, false);
});

test('between-tool diff reports injected reminders with size and canaries', () => {
  const first = body([user('go')]);
  const injected = {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content: [{ type: 'text', text: 'page' }],
      },
      {
        type: 'text',
        text: '<system-reminder>carry BAP0_SETTINGS_ab12 forward</system-reminder>',
      },
    ],
  };
  const second = body([
    user('go'),
    assistant('t1', 'mcp__browser__observe'),
    injected,
  ]);
  const diff = betweenToolDiff(first, second, {
    settings: 'BAP0_SETTINGS_ab12',
  });
  assert.equal(diff.shapeOk, false);
  assert.equal(diff.extras.length, 1);
  assert.equal(diff.extras[0].blockType, 'text');
  assert.ok(diff.extras[0].bytes > 40);
  assert.deepEqual(diff.extraCanaries, ['settings']);
  assert.equal(diff.extraBytes, diff.extras[0].bytes);
});

test('between-tool diff detects an extra message, embedded reminders and a changed prefix', () => {
  const first = body([user('go')]);
  const extraMessage = body([
    user('go'),
    assistant('t1', 'mcp__browser__observe'),
    result('t1', 'page'),
    user('<system-reminder>late</system-reminder>'),
  ]);
  const diff = betweenToolDiff(first, extraMessage);
  assert.equal(diff.addedMessageCount, 3);
  assert.equal(diff.shapeOk, false);
  const embedded = betweenToolDiff(
    first,
    body([
      user('go'),
      assistant('t1', 'mcp__browser__observe'),
      result('t1', 'page <system-reminder>x</system-reminder>'),
    ]),
  );
  assert.equal(embedded.shapeOk, false);
  assert.equal(embedded.extras[0].blockType, 'tool_result-embedded');
  const changed = betweenToolDiff(
    first,
    body([
      user('different'),
      assistant('t1', 'mcp__browser__observe'),
      result('t1', 'page'),
    ]),
  );
  assert.equal(changed.prefixStable, false);
});

test('cache_control markers do not count as prefix changes', () => {
  const first = body([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'go', cache_control: { type: 'ephemeral' } },
      ],
    },
  ]);
  const second = body([
    user('go'),
    assistant('t1', 'mcp__browser__observe'),
    result('t1', 'page'),
  ]);
  assert.equal(betweenToolDiff(first, second).prefixStable, true);
});

function rec(seq, surface, method = 'POST') {
  return { seq, surface, method, parse: 'ok', json: { model: 'm' } };
}

test('phase classification by arrival order', () => {
  const records = [
    rec(1, 'models', 'GET'),
    rec(2, 'anthropic-count-tokens'),
    rec(3, 'anthropic-messages'),
    rec(4, 'anthropic-count-tokens'),
    rec(5, 'anthropic-messages'),
    rec(6, 'anthropic-messages'),
    rec(7, 'anthropic-count-tokens'),
    rec(8, null),
  ];
  const phases = classifyRecordsByPhase(records, { resultSeq: 6 });
  assert.deepEqual(
    [...phases.values()],
    [
      'before-inference',
      'before-inference',
      'before-inference',
      'after-tools',
      'after-tools',
      'after-tools',
      'completion',
      'completion',
    ],
  );
  assert.deepEqual(
    recordsInPhase(records, phases, 'completion').map((record) => record.seq),
    [7, 8],
  );
  assert.ok(isMessagesRecord(records[2]) && !isMessagesRecord(records[1]));
  const none = classifyRecordsByPhase([rec(1, 'anthropic-count-tokens')], {
    resultSeq: null,
  });
  assert.equal(none.get(1), 'before-inference');
  const noResult = classifyRecordsByPhase(
    [rec(1, 'anthropic-messages'), rec(2, 'anthropic-messages')],
    { resultSeq: null },
  );
  assert.equal(noResult.get(2), 'after-tools');
});

test('normalization makes two launches comparable', () => {
  const a = body(
    [user('cwd /tmp/x/iso-b id 123e4567-e89b-12d3-a456-426614174000')],
    { metadata: { user_id: 'a'.repeat(64) } },
  );
  const b = body(
    [user('cwd /tmp/x/iso-c id 00000000-e89b-12d3-a456-426614174999')],
    { metadata: { user_id: 'b'.repeat(64) } },
  );
  assert.notEqual(shapeDigest(a).messagesSha, shapeDigest(b).messagesSha);
  const same = compareRequestSeries(
    [{ body: a, replacements: [{ from: '/tmp/x/iso-b', to: '<cwd>' }] }],
    [{ body: b, replacements: [{ from: '/tmp/x/iso-c', to: '<cwd>' }] }],
  );
  assert.equal(same.identical, true);
  const different = compareRequestSeries(
    [{ body: a }],
    [{ body: body([user('other text')]) }],
  );
  assert.equal(different.identical, false);
  assert.ok(different.perRequest[0].messageByteDelta !== 0);
  assert.equal(
    normalizeText('x 123e4567-e89b-12d3-a456-426614174000'),
    'x <uuid>',
  );
});

test('harness-added text inventories system and extra user blocks', () => {
  const b = body(
    [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<system-reminder>date is today</system-reminder>',
          },
          { type: 'text', text: 'PROMPT' },
        ],
      },
    ],
    { system: 'PROBE' },
  );
  const added = harnessAddedText(b, {
    probeSystemPrompt: 'PROBE',
    probePrompt: 'PROMPT',
  });
  assert.equal(added.systemEqualsProbePrompt, true);
  assert.equal(added.extraUserTextBlocks.length, 1);
  assert.equal(added.extraUserTextBlocks[0].systemReminder, true);
  const extraSystem = harnessAddedText(
    body([user('PROMPT')], { system: 'PROBE plus more' }),
    { probeSystemPrompt: 'PROBE', probePrompt: 'PROMPT' },
  );
  assert.equal(extraSystem.systemEqualsProbePrompt, false);
  assert.equal(extraSystem.systemExtraChars, ' plus more'.length);
});

test('small accessors', () => {
  assert.deepEqual(advertisedToolNames(body([])), ['mcp__browser__observe']);
  assert.equal(systemText({ system: 'a' }), 'a');
  assert.equal(systemText({ system: [{ text: 'a' }, { text: 'b' }] }), 'a\nb');
  assert.equal(recordBody({ parse: 'invalid', json: {} }), null);
  assert.deepEqual(
    modelsSeen([
      rec(1, 'anthropic-messages'),
      rec(2, 'anthropic-messages'),
      rec(3, 'anthropic-count-tokens'),
    ]),
    { m: 2 },
  );
});
