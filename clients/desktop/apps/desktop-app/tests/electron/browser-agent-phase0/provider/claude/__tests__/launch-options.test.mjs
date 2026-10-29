import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FORBIDDEN_ISOLATED_OPTIONS,
  ISOLATED_OPTIONS_SUMMARY,
  controlOptions,
  isolatedOptions,
} from '../launch-options.mjs';
import { PROBE_SYSTEM_PROMPT } from '../scripts.mjs';

const gateway = {
  server: { name: 'browser' },
  allowedTools: ['mcp__browser__observe', 'mcp__browser__finish'],
};

test('isolated options are exactly the 05 1.4 Claude launch contract', () => {
  const denials = [];
  const options = isolatedOptions({ gateway, denials });
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.systemPrompt, PROBE_SYSTEM_PROMPT);
  assert.equal(
    typeof options.systemPrompt,
    'string',
    'a custom string prompt, never the preset object',
  );
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.skills, []);
  assert.deepEqual(options.plugins, []);
  assert.deepEqual(options.agents, {});
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.persistSession, false);
  assert.deepEqual(Object.keys(options.mcpServers), ['browser']);
  assert.deepEqual(options.allowedTools, gateway.allowedTools);
  for (const name of FORBIDDEN_ISOLATED_OPTIONS)
    assert.ok(!(name in options), `${name} must not be set`);
  assert.ok(Number.isInteger(options.maxTurns));
  assert.equal(ISOLATED_OPTIONS_SUMMARY.hooks, 'not passed');
});

test('canUseTool allows only the admitted browser tools and records every denial', async () => {
  const denials = [];
  const { canUseTool } = isolatedOptions({ gateway, denials });
  assert.deepEqual(await canUseTool('mcp__browser__observe', { a: 1 }), {
    behavior: 'allow',
    updatedInput: { a: 1 },
  });
  const denied = await canUseTool('Bash', { command: 'x' });
  assert.equal(denied.behavior, 'deny');
  assert.equal((await canUseTool('mcp__other__tool', {})).behavior, 'deny');
  assert.deepEqual(
    denials.map((entry) => entry.toolName),
    ['Bash', 'mcp__other__tool'],
  );
  assert.deepEqual(denials[0].inputKeys, ['command']);
});

test('the positive control is the opposite: all sources, preset prompt, every tool call denied', async () => {
  const denials = [];
  const options = controlOptions({ denials });
  assert.deepEqual(options.settingSources, ['user', 'project', 'local']);
  assert.equal(options.systemPrompt.preset, 'claude_code');
  assert.equal(
    'tools' in options,
    false,
    'default tool list is not overridden',
  );
  assert.equal((await options.canUseTool('Bash', {})).behavior, 'deny');
  assert.equal(denials.length, 1);
});

test('the budget-hook experiment is the only place hooks are added, and only via extra', () => {
  const withHooks = isolatedOptions({
    gateway,
    denials: [],
    extra: { hooks: { PostToolBatch: [] } },
  });
  assert.ok('hooks' in withHooks);
  assert.ok(!('hooks' in isolatedOptions({ gateway, denials: [] })));
});
