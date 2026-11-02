import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDelegationInference } from '../delegationRuntime.mjs';

test('delegation inference observes Codex incremental tools and their removal', async () => {
  const fixture = await createDelegationInference({
    parent: 'claude',
    child: 'codex',
    mode: 'foreground',
    caseId: 'incremental-tool-observation',
    script: ({ reply }) => reply({ text: 'DONE', stopReason: 'end_turn' }),
  });
  const declare = (name, members) => ({
    type: 'additional_tools',
    role: 'developer',
    tools: [
      {
        type: 'namespace',
        name,
        tools: members.map((member) => ({ type: 'function', name: member })),
      },
    ],
  });
  const initial = declare('functions', ['canopy_request_steering']);
  const skills = declare('skills', ['list', 'read']);
  const send = async (updates) => {
    const response = await fetch(`${fixture.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: [...updates, { role: 'user', content: fixture.parentMarker }],
      }),
    });
    assert.equal(response.status, 200);
    await response.text();
    return fixture.requests.at(-1);
  };
  try {
    const offered = await send([
      initial,
      skills,
      declare('functions', ['exec_command']),
    ]);
    assert.deepEqual(offered.toolNames, [
      'functions.canopy_request_steering',
      'functions.exec_command',
      'skills.list',
      'skills.read',
    ]);
    assert.equal(offered.hasCodexSkillListTool, true);
    assert.equal(offered.hasCodexSkillReadTool, true);
    const removed = await send([
      initial,
      skills,
      {
        role: 'developer',
        type: 'message',
        content: [
          {
            type: 'input_text',
            text: 'The following namespaces are no longer available. Do not call tools in them unless those tools are declared in a later update:\n- skills',
          },
        ],
      },
      {
        role: 'developer',
        type: 'message',
        content: [
          {
            type: 'input_text',
            text: 'The following tools are no longer available. Do not call them:\n- functions.canopy_request_steering',
          },
        ],
      },
    ]);
    assert.deepEqual(removed.toolNames, []);
    assert.equal(removed.hasCodexSkillListTool, false);
    assert.equal(removed.hasCodexSkillReadTool, false);
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.close();
  }
});

test('delegation inference observes only declared tools behind the Codex exec gateway', async () => {
  const fixture = await createDelegationInference({
    parent: 'claude',
    child: 'codex',
    mode: 'foreground',
    caseId: 'exec-gateway-tool-observation',
    script: ({ reply }) => reply({ text: 'DONE', stopReason: 'end_turn' }),
  });
  try {
    const response = await fetch(`${fixture.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tools: [
          {
            type: 'namespace',
            name: 'functions',
            tools: [
              {
                type: 'custom',
                name: 'exec',
                description: [
                  'Examples may mention DelegateTask or spawn_delegate without offering them.',
                  '### `canopy_request_steering`',
                  'exec tool declaration:',
                  '```ts',
                  'declare const tools: { canopy_request_steering(args: { message: string; }): Promise<unknown>; };',
                  '```',
                  '### `exec_command`',
                  'exec tool declaration:',
                  '```ts',
                  'declare const tools: { exec_command(args: { cmd: string; }): Promise<unknown>; };',
                  '```',
                  '### `canopy_spawn_delegate`',
                  'exec tool declaration:',
                  '```ts',
                  'declare const tools: { canopy_spawn_delegate(args: {}): Promise<unknown>; };',
                  '```',
                  '### `not_declared`',
                  'This heading alone does not offer a tool.',
                ].join('\n'),
              },
            ],
          },
          {
            type: 'namespace',
            name: 'collaboration',
            tools: [{ type: 'function', name: 'spawn_agent' }],
          },
        ],
        input: [{ role: 'user', content: fixture.parentMarker }],
      }),
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.deepEqual(fixture.requests.at(-1).toolNames, [
      'functions.exec',
      'functions.canopy_request_steering',
      'functions.exec_command',
      'functions.canopy_spawn_delegate',
      'collaboration.spawn_agent',
    ]);
    // Confinement checks normalize qualified names before rejecting native spawn.
    assert.ok(
      fixture.requests
        .at(-1)
        .toolNames.map((name) => name.split('.').at(-1))
        .includes('spawn_agent'),
    );
  } finally {
    await fixture.close();
  }
});
