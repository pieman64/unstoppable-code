import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test as nodeTest, type TestContext } from 'node:test';
import type { PermissionPreset } from '../../../builtin-actions/agent-prompt/logic';
import {
  createHeadlessCursorHost,
  headlessCursorDecision,
} from '../headless-policy';
import type { CursorHookOutcome } from '../hook-transport';
import type { CursorToolInvocation } from '../events';
import {
  runCursorTurn,
  type CursorTurnHost,
  type CursorTurnRequest,
} from '../turn-driver';

// The real Electron fixture answers `--version`, speaks ACP, and runs the
// private hooks.json command it discovers under CURSOR_DATA_DIR, so these
// scenarios exercise the driver end to end: spawn, hook transport, session
// creation, model selection, prompt, and teardown.
const FIXTURE = path.resolve(
  __dirname,
  '../../../../../../apps/desktop-app/tests/electron/fixtures/cursor-acp-agent.mjs',
);

function test(
  name: string,
  scenario: (context: TestContext) => Promise<void>,
): void {
  // Node's runner owns completion and reports rejected scenarios to the parent.
  void nodeTest(name, scenario);
}

function host(
  decide: (payload: unknown) => CursorHookOutcome,
  events: Record<string, unknown>[],
): CursorTurnHost {
  return {
    clientName: 'turn-driver-test',
    planMode: false,
    authorizeNative: (payload) => Promise.resolve(decide(payload)),
    authorizeMcp: () => Promise.resolve({ decision: 'deny' }),
    prepareMcp: () =>
      Promise.resolve({
        servers: [],
        notes: [],
        notices: [],
        appToolsAvailable: false,
        pluginServerNames: [],
      }),
    beforePrompt: () => Promise.resolve({ instructions: '' }),
    emit: (event): void => {
      events.push(event);
    },
  };
}

// An MCP-capable host: the driver only routes a permission request to
// `authorizeMcp` when the tool's server is one `prepareMcp` declared, so the
// ACP decision path is unreachable through `host()` above (which denies MCP and
// declares no servers). Used by the ACP anchor scenarios.
function mcpHost(
  decide: () => 'allow' | 'deny',
  calls: { permissions: number; nativeHooks: number },
): CursorTurnHost {
  return {
    clientName: 'turn-driver-test',
    planMode: false,
    authorizeNative: (): Promise<CursorHookOutcome> => {
      calls.nativeHooks += 1;
      return Promise.resolve({ decision: 'allow' });
    },
    authorizeMcp: (): Promise<{ decision: 'allow' | 'deny' }> => {
      calls.permissions += 1;
      return Promise.resolve({ decision: decide() });
    },
    prepareMcp: () =>
      Promise.resolve({
        servers: [
          { name: 'fixture-mcp', command: process.execPath, args: [], env: [] },
        ],
        notes: [],
        notices: [],
        appToolsAvailable: false,
        pluginServerNames: ['fixture-mcp'],
      }),
    beforePrompt: () => Promise.resolve({ instructions: '' }),
    emit: (): void => {},
  };
}

async function directories(context: TestContext): Promise<{
  cwd: string;
  profileDir: string;
}> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'cursor-turn-cwd-'));
  const profileDir = await mkdtemp(path.join(tmpdir(), 'cursor-turn-profile-'));
  context.after(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(profileDir, { recursive: true, force: true });
  });
  return { cwd, profileDir };
}

function request(
  directory: { cwd: string; profileDir: string },
  text: string,
  signal: AbortSignal = new AbortController().signal,
): CursorTurnRequest {
  return {
    cwd: directory.cwd,
    text,
    launch: { command: process.execPath, prefix: [FIXTURE] },
    env: { ...process.env, CURSOR_CONFIG_DIR: directory.profileDir },
    hookRuntime: process.execPath,
    profileDir: directory.profileDir,
    rawModelId: 'default[]',
    signal,
  };
}

test('two approved large Writes deliver their full ACP diffs and finish the turn', async (context) => {
  const directory = await directories(context);
  const before = 'x'.repeat(4 * 1024 * 1024);
  for (const filename of ['large-a.txt', 'large-b.txt'])
    await writeFile(path.join(directory.cwd, filename), before);
  const events: Record<string, unknown>[] = [];
  const result = await runCursorTurn(
    request(directory, 'CURSOR_CHAT_E2E_LARGE_DIFFS'),
    host(() => ({ decision: 'allow' }), events),
  );
  assert.equal(result.isError, false, result.message);
  assert.equal(result.cancelled, false);
  assert.equal(result.responseText, 'Both large edits completed.');
  for (const filename of ['large-a.txt', 'large-b.txt']) {
    assert.equal(
      await readFile(path.join(directory.cwd, filename), 'utf8'),
      before + 'CURSOR_CHAT_OK',
    );
  }
  // Both snapshots must reach the transcript, not be silently discarded.
  const output = events.map((event) => JSON.stringify(event)).join('\n');
  assert.equal(output.includes(before + 'CURSOR_CHAT_OK'), true);
  assert.equal(output.includes('large-b.txt'), true);
});

/**
 * Observes the raw millisecond delays every `setTimeout` call receives while
 * `action` runs, without mocking the driver's `promptTimeoutMs` mapping or
 * the ACP client. `AcpClientConnection.prompt()` schedules its own deadline
 * timer directly with `setTimeout(fn, promptMs)` when `promptMs` is not
 * `null` (see `packages/desktop-shared/src/node/acp/client.ts`), so this is
 * the exact seam where the driver's real, unmocked mapping becomes
 * observable end to end through a live turn against the fixture agent.
 */
async function capturedTimeoutDelays<T>(
  action: () => Promise<T>,
): Promise<{ result: T; delays: number[] }> {
  const delays: number[] = [];
  const original = globalThis.setTimeout;
  function spy(
    handler: (...handlerArgs: unknown[]) => void,
    timeout?: number,
    ...handlerArgs: unknown[]
  ): NodeJS.Timeout {
    if (typeof timeout === 'number') delays.push(timeout);
    return original(handler, timeout, ...handlerArgs);
  }
  Object.defineProperty(globalThis, 'setTimeout', {
    value: spy,
    configurable: true,
    writable: true,
  });
  try {
    const result = await action();
    return { result, delays };
  } finally {
    Object.defineProperty(globalThis, 'setTimeout', {
      value: original,
      configurable: true,
      writable: true,
    });
  }
}

test('reports the commands and skills the runtime advertises, even before the prompt', async (t) => {
  // The pinned CLI sends available_commands_update right after session/new,
  // while the driver is still selecting the model. The host needs it to
  // confirm that what it materialized under ~/.cursor was actually loaded.
  const directory = await directories(t);
  const home = await mkdtemp(path.join(tmpdir(), 'cursor-turn-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, '.cursor', 'skills', 'demo'), {
    recursive: true,
  });
  await writeFile(
    path.join(home, '.cursor', 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: Demo\n---\n',
  );
  await mkdir(path.join(home, '.cursor', 'commands'), { recursive: true });
  await writeFile(
    path.join(home, '.cursor', 'commands', 'ship.md'),
    '# Ship\n',
  );
  const advertised: string[][] = [];
  const base = request(directory, 'hello');
  const result = await runCursorTurn(
    { ...base, env: { ...base.env, HOME: home } },
    {
      ...host(() => ({ decision: 'allow' }), []),
      onAvailableCommands: (names): void => {
        advertised.push(names);
      },
    },
  );
  assert.equal(result.isError, false);
  assert.equal(advertised.length, 1);
  assert.ok(advertised[0]?.includes('ship'));
  assert.ok(advertised[0]?.includes('demo'));
});

test('applies a requested thinking level through the parameterized picker', async (t) => {
  const directory = await directories(t);
  const events: Record<string, unknown>[] = [];
  const result = await runCursorTurn(
    {
      ...request(directory, 'CURSOR_CHAT_E2E_MODEL'),
      rawModelId: 'gpt-5.6-luna[reasoning=medium]',
      thinkingLevel: 'high',
    },
    host(() => ({ decision: 'allow' }), events),
  );
  assert.equal(result.isError, false, result.message);
  assert.ok(events.some((event) => event.type === 'system'));
  // The fixture records the variant it actually prompted with, recomposed
  // from the base id and the parameter values the driver set.
  assert.equal(
    await readFile(
      path.join(directory.profileDir, 'fixture-selected-model.txt'),
      'utf8',
    ),
    'gpt-5.6-luna[reasoning=high]',
  );
});

test('keeps the variant parameters when no level is requested', async (t) => {
  const directory = await directories(t);
  const result = await runCursorTurn(
    {
      ...request(directory, 'CURSOR_CHAT_E2E_MODEL'),
      rawModelId: 'gpt-5.6-luna[reasoning=medium]',
    },
    host(() => ({ decision: 'allow' }), []),
  );
  assert.equal(result.isError, false, result.message);
  assert.equal(
    await readFile(
      path.join(directory.profileDir, 'fixture-selected-model.txt'),
      'utf8',
    ),
    'gpt-5.6-luna[reasoning=medium]',
  );
});

test('refuses a requested level when the live model has no thinking control', async (t) => {
  const directory = await directories(t);
  const result = await runCursorTurn(
    { ...request(directory, 'CURSOR_CHAT_E2E_MODEL'), thinkingLevel: 'max' },
    host(() => ({ decision: 'allow' }), []),
  );
  assert.equal(result.isError, true);
  assert.match(result.message ?? '', /could not apply this thinking level/);
  await assert.rejects(
    readFile(path.join(directory.profileDir, 'fixture-selected-model.txt')),
    { code: 'ENOENT' },
  );
});

test('refuses a variant whose base the runtime never advertised', async (t) => {
  const directory = await directories(t);
  const result = await runCursorTurn(
    {
      ...request(directory, 'CURSOR_CHAT_E2E_MODEL'),
      rawModelId: 'vanished-model[reasoning=medium]',
    },
    host(() => ({ decision: 'allow' }), []),
  );
  assert.equal(result.isError, true);
  assert.match(result.message, /unavailable/);
});

test('writes the file when the host allows the Write hook', async (t) => {
  const directory = await directories(t);
  const events: Record<string, unknown>[] = [];
  const result = await runCursorTurn(
    request(directory, 'create the result file'),
    host(() => ({ decision: 'allow' }), events),
  );
  assert.equal(result.isError, false);
  assert.equal(result.cancelled, false);
  assert.equal(
    await readFile(path.join(directory.cwd, 'result.txt'), 'utf8'),
    'CURSOR_APPROVAL_OK\n',
  );
  assert.ok(events.some((event) => event.type === 'system'));
});

test('stops a second native call that reuses one approved tool id', async (t) => {
  // The anchor remembered the hook observation but never consumed it, so a
  // runtime that reuses one tool id got a second, unhooked write accepted.
  const directory = await directories(t);
  let hookCalls = 0;
  const result = await runCursorTurn(
    request(directory, 'CURSOR_CHAT_E2E_REUSED_NATIVE_ID'),
    host(() => {
      hookCalls += 1;
      return { decision: 'allow' };
    }, []),
  );
  assert.equal(hookCalls, 1);
  assert.equal(result.isError, true);
  assert.match(String(result.integrityFailure), /approval/i);
});

test('accepts a repeated native call that was approved again', async (t) => {
  // Control: the same id used twice, each invocation reaching the hook, is
  // ordinary behaviour and must not be reported as an integrity failure.
  const directory = await directories(t);
  let hookCalls = 0;
  const result = await runCursorTurn(
    request(directory, 'CURSOR_CHAT_E2E_REAPPROVED_NATIVE_ID'),
    host(() => {
      hookCalls += 1;
      return { decision: 'allow' };
    }, []),
  );
  assert.equal(hookCalls, 2);
  assert.equal(result.isError, false);
  assert.equal(result.integrityFailure, undefined);
});

test('stops a reused tool id whose second call repeats the same input', async (t) => {
  // The settled-completion key held `id|status|input`, so a second
  // invocation whose completion was byte-identical to the first inherited the
  // first one's approval. A new `tool_call` notification starts a new
  // invocation and must clear what was remembered under that id.
  const directory = await directories(t);
  let hookCalls = 0;
  const result = await runCursorTurn(
    request(directory, 'CURSOR_CHAT_E2E_REUSED_NATIVE_SAME_INPUT'),
    host(() => {
      hookCalls += 1;
      return { decision: 'allow' };
    }, []),
  );
  assert.equal(hookCalls, 1);
  assert.equal(result.isError, true);
  assert.match(String(result.integrityFailure), /approval/i);
});

test('accepts an identical repeated call that was approved again', async (t) => {
  // Control for the case above: identical id AND identical input is ordinary
  // when each invocation reaches the hook.
  const directory = await directories(t);
  let hookCalls = 0;
  const result = await runCursorTurn(
    request(directory, 'CURSOR_CHAT_E2E_REAPPROVED_SAME_INPUT'),
    host(() => {
      hookCalls += 1;
      return { decision: 'allow' };
    }, []),
  );
  assert.equal(hookCalls, 2);
  assert.equal(result.isError, false);
  assert.equal(result.integrityFailure, undefined);
});

test('accepts a duplicated completion report for one approved call', async (t) => {
  // Control: a runtime that reports the same completion twice is describing
  // one gated call, not a second ungated one.
  const directory = await directories(t);
  let hookCalls = 0;
  const result = await runCursorTurn(
    request(directory, 'CURSOR_CHAT_E2E_DUPLICATE_COMPLETION'),
    host(() => {
      hookCalls += 1;
      return { decision: 'allow' };
    }, []),
  );
  assert.equal(hookCalls, 1);
  assert.equal(result.isError, false);
  assert.equal(result.integrityFailure, undefined);
});

test('stops a reused MCP tool id whose second call was never re-approved', async (t) => {
  // The MCP half of the same lifecycle rule. An MCP call has no native hook,
  // so its recorded ACP decision is its only exemption; that decision belonged
  // to the first invocation and must not carry over to a second one the host
  // never saw.
  const directory = await directories(t);
  const calls = { permissions: 0, nativeHooks: 0 };
  const result = await runCursorTurn(
    request(directory, 'CURSOR_CHAT_E2E_REUSED_ACP_DECISION'),
    mcpHost(() => 'allow', calls),
  );
  assert.equal(calls.permissions, 1);
  assert.equal(calls.nativeHooks, 0);
  assert.equal(result.isError, true);
  assert.match(String(result.integrityFailure), /approval/i);
});

test('accepts a reused MCP tool id whose second call was approved again', async (t) => {
  // Control: two permission requests, two decisions, ordinary behaviour.
  const directory = await directories(t);
  const calls = { permissions: 0, nativeHooks: 0 };
  const result = await runCursorTurn(
    request(directory, 'CURSOR_CHAT_E2E_REAPPROVED_ACP_DECISION'),
    mcpHost(() => 'allow', calls),
  );
  assert.equal(calls.permissions, 2);
  assert.equal(calls.nativeHooks, 0);
  assert.equal(result.isError, false);
  assert.equal(result.integrityFailure, undefined);
});

test('accepts a duplicated completion report for one approved MCP call', async (t) => {
  // Control: a repeated terminal notification with no new start still
  // describes the one decided call.
  const directory = await directories(t);
  const calls = { permissions: 0, nativeHooks: 0 };
  const result = await runCursorTurn(
    request(directory, 'CURSOR_CHAT_E2E_DUPLICATE_ACP_COMPLETION'),
    mcpHost(() => 'allow', calls),
  );
  assert.equal(calls.permissions, 1);
  assert.equal(calls.nativeHooks, 0);
  assert.equal(result.isError, false);
  assert.equal(result.integrityFailure, undefined);
});

test('forwards invocation identity before emitting each projected tool patch', async (t) => {
  const directory = await directories(t);
  const calls = { permissions: 0, nativeHooks: 0 };
  const order: string[] = [];
  const invocations: CursorToolInvocation[] = [];
  const base = mcpHost(() => 'allow', calls);
  const result = await runCursorTurn(
    request(directory, 'CURSOR_CHAT_E2E_DUPLICATE_ACP_COMPLETION'),
    {
      ...base,
      onToolInvocation: (invocation): void => {
        invocations.push(invocation);
        order.push('invocation');
      },
      emit: (event): void => {
        if (
          event.type === 'canopy_assistant_patch' &&
          Array.isArray(event.patches)
        )
          order.push('patch');
      },
    },
  );
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.ok(invocations.length >= 2);
  assert.equal(invocations[0]?.toolUseId, invocations[1]?.toolUseId);
  assert.equal(typeof invocations[0]?.toolUseId, 'string');
  assert.deepEqual(invocations[0], {
    toolUseId: invocations[0]?.toolUseId,
    title: 'fixture-mcp: check',
    rawInput: {
      providerIdentifier: 'fixture-mcp',
      toolName: 'check',
      args: { value: 'same' },
    },
    kind: 'other',
    status: 'pending',
  });
  assert.equal(invocations[1]?.status, 'completed');
  assert.deepEqual(order.slice(0, 4), [
    'invocation',
    'patch',
    'invocation',
    'patch',
  ]);
});

test('leaves the file absent when the host denies Write', async (t) => {
  const directory = await directories(t);
  const events: Record<string, unknown>[] = [];
  const result = await runCursorTurn(
    request(directory, 'create the result file'),
    host(
      (payload) =>
        typeof payload === 'object' &&
        payload !== null &&
        'tool_name' in payload &&
        payload.tool_name === 'Write'
          ? { decision: 'deny', message: 'blocked' }
          : { decision: 'allow' },
      events,
    ),
  );
  assert.equal(result.isError, false);
  await assert.rejects(
    readFile(path.join(directory.cwd, 'result.txt'), 'utf8'),
  );
});

// The REAL headless host, not a stand-in: its preset policy is what decides
// whether a completion needed a decision, so a stand-in would test nothing.
function headless(
  preset: PermissionPreset,
  calls: { hooks: number },
): CursorTurnHost {
  const host = createHeadlessCursorHost({
    preset,
    instructions: '',
    clientName: 'turn-driver-test',
    emit: (): void => {},
  });
  const authorize = host.authorizeNative.bind(host);
  return {
    ...host,
    authorizeNative: (payload, context): Promise<CursorHookOutcome> => {
      calls.hooks += 1;
      return authorize(payload, context);
    },
  };
}

// A headless step has nobody to approve anything mid-turn, so a completion of a
// real tool that never reached the hook is unaccounted for and the turn has to
// stop. The kinds below cannot change the worktree, which is why the anchor
// exempted them unconditionally — an exemption from the BACKSTOP, not from the
// gate. That is wrong for a headless run: the gate can be skipped by a
// noncompliant runtime, and there is no interactive approval to fall back on.
// This is after-the-fact detection; it stops the session, and never claims to
// have prevented whatever already happened.
for (const [preset, kind] of [
  ['none', 'read'],
  ['none', 'search'],
  ['none', 'fetch'],
  ['read_only', 'read'],
  ['read_only', 'search'],
  ['read_only', 'fetch'],
  ['plan', 'fetch'],
] as const) {
  test(`stops an unhooked ${kind} completion on a headless ${preset} step`, async (t) => {
    const directory = await directories(t);
    const calls = { hooks: 0 };
    const result = await runCursorTurn(
      request(directory, `CURSOR_CHAT_E2E_COMPLETION:${kind}:none`),
      headless(preset, calls),
    );
    assert.equal(calls.hooks, 0);
    assert.equal(result.isError, true);
    assert.match(String(result.integrityFailure), /approval/i);
  });
}

test('stops an unhooked edit completion on a headless step', async (t) => {
  // Negative control that was already failing closed, kept so a regression in
  // the mutating path cannot hide behind the new kinds.
  const directory = await directories(t);
  const calls = { hooks: 0 };
  const result = await runCursorTurn(
    request(directory, 'CURSOR_CHAT_E2E_COMPLETION:edit:none'),
    headless('read_only', calls),
  );
  assert.equal(calls.hooks, 0);
  assert.equal(result.isError, true);
});

test('accepts a read the headless policy actually allowed', async (t) => {
  // Positive control, and the one case live-tested against the pinned runtime:
  // `read_only` allows native Read, the hook is reached, and the completion
  // carries that evidence.
  const directory = await directories(t);
  const calls = { hooks: 0 };
  const result = await runCursorTurn(
    request(directory, 'CURSOR_CHAT_E2E_COMPLETION:read:allow'),
    headless('read_only', calls),
  );
  assert.equal(calls.hooks, 1);
  assert.equal(result.isError, false);
  assert.equal(result.integrityFailure, undefined);
});

test('accepts a search the headless policy denied and the runtime then failed', async (t) => {
  // Grep is denied at the hook under the no-tools preset
  // and the CLI reports the call as completed-with-failure. Reaching the gate
  // is the evidence, whatever the decision was, so a legitimate refusal must
  // not be reported as an integrity failure.
  const directory = await directories(t);
  const calls = { hooks: 0 };
  const result = await runCursorTurn(
    request(directory, 'CURSOR_CHAT_E2E_COMPLETION:search:deny'),
    headless('none', calls),
  );
  assert.equal(calls.hooks, 1);
  assert.equal(result.isError, false);
  assert.equal(result.integrityFailure, undefined);
});

test('accepts an unhooked think notification on a headless step', async (t) => {
  // `think` and `switch_mode` are notifications, not tool invocations: they
  // never reach a hook even in a compliant run, so requiring evidence for them
  // would break ordinary headless turns.
  const directory = await directories(t);
  const calls = { hooks: 0 };
  const result = await runCursorTurn(
    request(directory, 'CURSOR_CHAT_E2E_COMPLETION:think:none'),
    headless('none', calls),
  );
  assert.equal(calls.hooks, 0);
  assert.equal(result.isError, false);
  assert.equal(result.integrityFailure, undefined);
});

test('the transcript fixture provides a policy-valid native Read payload', async (t) => {
  const directory = await directories(t);
  const decisions: string[] = [];
  const result = await runCursorTurn(
    request(directory, 'CURSOR_CHAT_E2E_TRANSCRIPT'),
    host((payload) => {
      const decision = headlessCursorDecision('dangerous_all', payload);
      if (
        typeof payload === 'object' &&
        payload !== null &&
        'tool_name' in payload &&
        payload.tool_name === 'Read'
      )
        decisions.push(decision.decision);
      return decision;
    }, []),
  );
  assert.equal(result.isError, false);
  assert.deepEqual(decisions, ['allow']);
});

test('the transcript fixture does not return Read content after denial', async (t) => {
  const directory = await directories(t);
  const events: Record<string, unknown>[] = [];
  let hookCalls = 0;
  await runCursorTurn(
    request(directory, 'CURSOR_CHAT_E2E_TRANSCRIPT'),
    host(() => {
      hookCalls += 1;
      return { decision: 'deny' };
    }, events),
  );
  assert.equal(JSON.stringify(events).includes('demo-project'), false);
  assert.equal(hookCalls, 1);
});

for (const [kind, shape] of (['read', 'search', 'fetch'] as const).flatMap(
  (kind) =>
    (['update', 'initial'] as const).map((shape) => [kind, shape] as const),
)) {
  const suffix = shape === 'initial' ? ':initial' : '';
  test(`stops an unhooked ${kind} ${shape} completion in interactive chat`, async (t) => {
    const directory = await directories(t);
    let hookCalls = 0;
    const events: Record<string, unknown>[] = [];
    const result = await runCursorTurn(
      request(directory, `CURSOR_CHAT_E2E_COMPLETION:${kind}:none${suffix}`),
      host(() => {
        hookCalls += 1;
        return { decision: 'allow' };
      }, events),
    );
    assert.equal(hookCalls, 0);
    assert.equal(result.isError, true);
    assert.match(String(result.integrityFailure), /approval/i);
  });

  for (const decision of ['allow', 'deny'] as const) {
    test(`accepts an interactive ${kind} ${shape} completion after its hook ${decision}`, async (t) => {
      const directory = await directories(t);
      let hookCalls = 0;
      const result = await runCursorTurn(
        request(
          directory,
          `CURSOR_CHAT_E2E_COMPLETION:${kind}:${decision}${suffix}`,
        ),
        host(() => {
          hookCalls += 1;
          return { decision };
        }, []),
      );
      assert.equal(hookCalls, 1);
      assert.equal(result.isError, false);
      assert.equal(result.integrityFailure, undefined);
    });
  }
}

test('reports cancellation when the signal aborts mid-turn', async (t) => {
  // Aborted only once the turn is provably running: the fixture has been
  // spawned, prompted, and has streamed text for a turn that never finishes on
  // its own. Aborting synchronously after the call only ever exercised a stop
  // before spawn.
  const directory = await directories(t);
  const controller = new AbortController();
  const events: Record<string, unknown>[] = [];
  let streamed: () => void = () => undefined;
  const streaming = new Promise<void>((resolve) => {
    streamed = resolve;
  });
  const recording = host(() => ({ decision: 'allow' }), events);
  const pending = runCursorTurn(
    request(directory, 'CURSOR_CHAT_E2E_HANG', controller.signal),
    {
      ...recording,
      emit: (event): void => {
        void recording.emit(event);
        if (event.type === 'canopy_assistant_patch') streamed();
      },
    },
  );
  await streaming;
  const pid = Number(
    await readFile(path.join(directory.profileDir, 'fixture-pid.txt'), 'utf8'),
  );
  controller.abort();
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(result.isError, false);
  assert.ok(result.responseText.includes('Working on it'));
  // The spawned runtime is gone, not left running behind a settled turn.
  assert.throws(() => process.kill(pid, 0));
});

test('streams response text into the projection and the result', async (t) => {
  const directory = await directories(t);
  const events: Record<string, unknown>[] = [];
  const result = await runCursorTurn(
    request(directory, 'CURSOR_CHAT_E2E_TEXT'),
    host(() => ({ decision: 'allow' }), events),
  );
  assert.equal(result.isError, false);
  assert.ok(result.responseText.includes('Cursor chat works.'));
  assert.ok(
    events.some((event) => event.type === 'canopy_assistant_patch'),
    'expected the projection to emit assistant patches',
  );
});

test('reports the account action behind the pinned CLI settings notice', async (t) => {
  // The CLI turns a backend ActionRequiredError(config) into one fixed
  // sentence and a normal end_turn. The driver must fail the turn and name
  // the action so a host can look up what the account has to change.
  const directory = await directories(t);
  const events: Record<string, unknown>[] = [];
  const result = await runCursorTurn(
    request(directory, 'CURSOR_CHAT_E2E_SETTINGS_REQUIRED'),
    host(() => ({ decision: 'allow' }), events),
  );
  assert.equal(result.isError, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.actionRequired, 'config');
  assert.equal(
    result.message,
    "Your Cursor account settings don't allow this request. Check them in your Cursor dashboard, then try again, or choose another model.",
  );
});

test('omits an explicit prompt timeout, so the ACP client gets no prompt deadline', async (t) => {
  const directory = await directories(t);
  const events: Record<string, unknown>[] = [];
  const { result, delays } = await capturedTimeoutDelays(() =>
    runCursorTurn(
      request(directory, 'create the result file'),
      host(() => ({ decision: 'allow' }), events),
    ),
  );
  assert.equal(result.isError, false);
  // A regression to the old `?? 600_000` fallback schedules a real
  // setTimeout for that exact delay; the correct `null` mapping never
  // schedules a prompt-deadline timer at all (client.ts only calls
  // setTimeout for the deadline when `promptMs !== null`).
  assert.ok(
    !delays.includes(600_000),
    `expected no 600000ms prompt-deadline timer; observed delays: ${delays.join(', ')}`,
  );
});

test('passes an explicit prompt timeout straight through to the ACP client deadline', async (t) => {
  const directory = await directories(t);
  const events: Record<string, unknown>[] = [];
  const { result, delays } = await capturedTimeoutDelays(() =>
    runCursorTurn(
      {
        ...request(directory, 'create the result file'),
        promptTimeoutMs: 4242,
      },
      host(() => ({ decision: 'allow' }), events),
    ),
  );
  assert.equal(result.isError, false);
  assert.ok(
    delays.includes(4242),
    `expected the ACP client to schedule a 4242ms prompt deadline; observed delays: ${delays.join(', ')}`,
  );
});

test('reports a child that never spawns as a failure, not a cancellation', async (t) => {
  // Independent-review finding M7: the driver mapped `child.once('error')`
  // onto its INTERNAL composite abort controller, and the catch derives
  // `cancelled` from that same controller — so an ENOENT/EACCES spawn
  // failure surfaced as `cancelled: true`. The pipeline runner checks
  // `cancelled` before `isError`, and `cancelled` is terminal for
  // `max_retries`, so a genuine infrastructure failure silently skipped
  // retry and failure classification. Only the CALLER's own signal may
  // produce a cancellation.
  const directory = await directories(t);
  const events: Record<string, unknown>[] = [];
  const failing = request(directory, 'never runs');
  const result = await runCursorTurn(
    {
      ...failing,
      launch: {
        command: path.join(directory.cwd, 'no-such-cursor-binary'),
        prefix: [],
      },
    },
    host(() => ({ decision: 'allow' }), events),
  );
  assert.equal(result.cancelled, false);
  assert.equal(result.isError, true);
  assert.notEqual(result.message, 'Turn cancelled');
});

test('completes teardown even when the host cleanup hook rejects', async (t) => {
  // Independent-review finding M6: `await host.cleanup?.()` sat unguarded
  // in the driver's `finally`, so a rejection both replaced the turn's
  // result with that rejection and skipped every later teardown statement —
  // the ACP client close, the child process-group stop, the two listening
  // hook servers, and the `rm` of the temp dir holding the hook's bearer
  // token. A host's cleanup failure is its own business; it must not take
  // the driver's owned resources down with it.
  const directory = await directories(t);
  const events: Record<string, unknown>[] = [];
  const base = host(() => ({ decision: 'allow' }), events);
  const result = await runCursorTurn(request(directory, 'say hello'), {
    ...base,
    cleanup: () => Promise.reject(new Error('host cleanup exploded')),
  });
  assert.equal(result.isError, false);
  assert.equal(result.cancelled, false);
});

test('refuses a resume whose session is gone without running a fresh turn', async (t) => {
  // Independent-review finding M5: `loadSession` failure fell through to
  // `newSession` unconditionally, and the pipeline only inspected
  // `contextLost` AFTER the turn resolved. An `agent-resume` step whose
  // recorded session was gone therefore executed its resume prompt — which
  // is written assuming prior context — to completion with whatever
  // permissions the step declared, mutating the worktree, and only then
  // reported that it could not be resumed. The interactive chat keeps its
  // deliberate fresh-session recovery; only a caller that asks for
  // resume-only gets the early refusal.
  const directory = await directories(t);
  const events: Record<string, unknown>[] = [];
  const result = await runCursorTurn(
    {
      ...request(directory, 'create the result file'),
      sessionId: 'missing-fixture-session',
      requireExistingSession: true,
    },
    host(() => ({ decision: 'allow' }), events),
  );
  assert.equal(result.isError, true);
  assert.equal(result.contextLost, true);
  // The whole point: no fresh, write-capable turn ran in place of the resume.
  await assert.rejects(
    readFile(path.join(directory.cwd, 'result.txt'), 'utf8'),
  );
});

for (const decision of ['allow', 'deny'] as const) {
  test(`invalid Grep arguments recover without authorizing the corrected ${decision} call`, async (context) => {
    const directory = await directories(context);
    await writeFile(
      path.join(directory.cwd, 'cursor-native-source.txt'),
      'native search needle',
    );
    const events: Record<string, unknown>[] = [];
    const observed: unknown[] = [];
    const result = await runCursorTurn(
      request(
        directory,
        'CURSOR_CHAT_E2E_INVALID_GREP CURSOR_CHAT_E2E_NATIVE_Grep',
      ),
      host((payload) => {
        observed.push(payload);
        return { decision };
      }, events),
    );
    assert.equal(result.isError, false, result.message);
    assert.equal(
      result.responseText,
      `Grep ${decision === 'allow' ? 'completed' : 'denied'}.`,
    );
    assert.equal(
      observed.length,
      1,
      'the corrected call must reach the hook once',
    );
    assert.match(JSON.stringify(events), /Invalid arguments/);
    const executed = await readFile(
      path.join(directory.cwd, 'cursor-native-executed-Grep'),
      'utf8',
    ).then(
      () => true,
      () => false,
    );
    assert.equal(executed, decision === 'allow');
  });
}
