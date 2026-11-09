import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  spawnProviderProcessDirect,
  type ProviderProcess,
  type ProviderProcessRequest,
  type ProviderProcessSpawner,
} from '../../provider-process/spawn';
import { openCodeNativeDatabase } from '../auth-config';
import {
  runOpenCodeTurn,
  type OpenCodeTurnHost,
  type OpenCodeTurnRequest,
} from '../turn-driver';
import {
  forkOpenCodeCapabilityBinding,
  readOpenCodeCapabilityBinding,
  saveOpenCodeCapabilitySnapshot,
  type OpenCodeCapabilityBinding,
} from '../capability-snapshot';

const fixture = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));

interface RecordingSpawner {
  readonly spawn: ProviderProcessSpawner;
  readonly requests: ProviderProcessRequest[];
  readonly processes: ProviderProcess[];
  readonly closed: Set<ProviderProcess>;
  stops: number;
}

/** Wraps the spawner a daemon worker uses, recording requests, processes and stops. */
function recordingSpawner(): RecordingSpawner {
  const recording: RecordingSpawner = {
    requests: [],
    processes: [],
    closed: new Set(),
    stops: 0,
    spawn: (request) => {
      recording.requests.push(request);
      const child = spawnProviderProcessDirect(request);
      recording.processes.push(child);
      child.once('close', () => {
        recording.closed.add(child);
      });
      const stop = child.stop.bind(child);
      child.stop = (options): Promise<void> => {
        recording.stops++;
        return stop(options);
      };
      return child;
    },
  };
  return recording;
}

interface Workspace {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly profileDir: string;
}

async function workspace(prefix: string): Promise<Workspace> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), prefix));
  const home = path.join(cwd, 'home');
  return {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_DATA_HOME: path.join(cwd, 'data'),
      OPENCODE_AUTH_CONTENT: '{}',
    },
    profileDir: path.join(cwd, 'profile'),
  };
}

function turn(
  space: Workspace,
  spawnProcess: ProviderProcessSpawner,
  overrides: Partial<OpenCodeTurnRequest> & { prompt: string },
): OpenCodeTurnRequest {
  return {
    executable: process.execPath,
    prefix: [fixture],
    spawnProcess,
    processOwner: { kind: 'turn', id: 'scenario' },
    rawModelId: 'fixture/model',
    signal: AbortSignal.timeout(10_000),
    cwd: space.cwd,
    env: space.env,
    profileDir: space.profileDir,
    ...overrides,
  };
}

const denyAll: OpenCodeTurnHost['authorize'] = () =>
  Promise.resolve({ decision: 'deny' });

void test("the ACP process starts through the supplied spawner with today's launch", async () => {
  const space = await workspace('opencode-seam-launch-');
  const spawner = recordingSpawner();
  try {
    const result = await runOpenCodeTurn(
      turn(space, spawner.spawn, { prompt: 'hello' }),
      { authorize: denyAll, emit: () => undefined },
    );
    assert.equal(result.isError, false, result.message);
    assert.equal(spawner.requests.length, 1);
    const [request] = spawner.requests;
    assert.ok(request);
    assert.equal(request.command, process.execPath);
    assert.deepEqual(request.args, [fixture, 'acp']);
    assert.equal(request.cwd, space.cwd);
    assert.deepEqual(request.owner, { kind: 'turn', id: 'scenario' });
    assert.equal(
      request.env.OPENCODE_DB,
      openCodeNativeDatabase(space.env, space.cwd),
    );
    assert.equal(request.env.OPENCODE_DISABLE_AUTOUPDATE, 'true');
    assert.doesNotThrow(() =>
      JSON.parse(request.env.OPENCODE_CONFIG_CONTENT ?? ''),
    );
    assert.equal(spawner.stops, 1);
    const [child] = spawner.processes;
    assert.ok(child && spawner.closed.has(child));
  } finally {
    await rm(space.cwd, { recursive: true, force: true });
  }
});

void test('a spawner failure leaves no private runtime directory', async () => {
  const space = await workspace('opencode-seam-refused-');
  const refuse: ProviderProcessSpawner = () => {
    throw new Error('spawn refused');
  };
  try {
    const result = await runOpenCodeTurn(
      turn(space, refuse, { prompt: 'hello' }),
      { authorize: denyAll, emit: () => undefined },
    );
    assert.equal(result.isError, true);
    assert.equal(result.message, 'spawn refused');
    const entries = await readdir(space.profileDir).catch(() => []);
    assert.deepEqual(
      entries.filter((entry) => entry.startsWith('turn-')),
      [],
    );
  } finally {
    await rm(space.cwd, { recursive: true, force: true });
  }
});

interface LifecycleEntry {
  readonly method: string;
  readonly sessionId?: string;
}

async function lifecycle(file: string): Promise<LifecycleEntry[]> {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line): LifecycleEntry => {
      const entry: unknown = JSON.parse(line);
      assert.ok(
        typeof entry === 'object' &&
          entry !== null &&
          'method' in entry &&
          typeof entry.method === 'string',
      );
      return { method: entry.method };
    });
}

function methods(entries: readonly LifecycleEntry[]): string[] {
  return entries.map((entry) => entry.method);
}

function mentions(
  events: readonly Record<string, unknown>[],
  text: string,
): boolean {
  return events.some((event) => JSON.stringify(event).includes(text));
}

function collector(): {
  readonly events: Record<string, unknown>[];
  readonly emit: OpenCodeTurnHost['emit'];
} {
  const events: Record<string, unknown>[] = [];
  return {
    events,
    emit: (event) => {
      events.push(event);
    },
  };
}

void test('selects the exact model and thinking level before the prompt', async () => {
  const space = await workspace('opencode-seam-select-');
  const log = path.join(space.cwd, 'lifecycle.jsonl');
  const env = {
    ...space.env,
    OPENCODE_FIXTURE_EFFORT: 'select',
    OPENCODE_FIXTURE_LIFECYCLE_LOG: log,
  };
  try {
    const result = await runOpenCodeTurn(
      turn({ ...space, env }, recordingSpawner().spawn, {
        prompt: 'hello',
        thinkingLevel: 'high',
      }),
      { authorize: denyAll, emit: () => undefined },
    );
    assert.equal(result.isError, false, result.message);
    const session = methods(await lifecycle(log)).filter((method) =>
      method.startsWith('session/'),
    );
    assert.equal(session[0], 'session/new');
    const prompt = session.indexOf('session/prompt');
    assert.ok(prompt > 0);
    assert.deepEqual(session.slice(1, prompt), [
      'session/set_config_option',
      'session/set_config_option',
    ]);
  } finally {
    await rm(space.cwd, { recursive: true, force: true });
  }
});

void test('refuses a model the runtime does not advertise', async () => {
  const space = await workspace('opencode-seam-model-');
  const log = path.join(space.cwd, 'lifecycle.jsonl');
  const env = { ...space.env, OPENCODE_FIXTURE_LIFECYCLE_LOG: log };
  const spawner = recordingSpawner();
  try {
    const result = await runOpenCodeTurn(
      turn({ ...space, env }, spawner.spawn, {
        prompt: 'hello',
        rawModelId: 'fixture/other',
      }),
      { authorize: denyAll, emit: () => undefined },
    );
    assert.equal(result.isError, true);
    assert.equal(result.requestRejected, true);
    assert.equal(
      result.message,
      'This OpenCode model is unavailable. Choose another model.',
    );
    assert.ok(!methods(await lifecycle(log)).includes('session/prompt'));
    assert.equal(spawner.stops, 1);
  } finally {
    await rm(space.cwd, { recursive: true, force: true });
  }
});

void test('streams agent chunks to the host in order and ends with the response text', async () => {
  const space = await workspace('opencode-seam-stream-');
  const { events, emit } = collector();
  try {
    const result = await runOpenCodeTurn(
      turn(space, recordingSpawner().spawn, { prompt: 'hello' }),
      { authorize: denyAll, emit },
    );
    assert.equal(result.isError, false, result.message);
    const [init] = events;
    assert.ok(init);
    assert.equal(init.type, 'system');
    assert.equal(init.subtype, 'init');
    assert.equal(init.session_id, 'opencode-fixture');
    assert.match(String(init.capability_snapshot), /^[0-9a-f]{64}$/);
    const thinking = events.findIndex((event) =>
      JSON.stringify(event).includes('Thinking.'),
    );
    const reply = events.findIndex((event) =>
      JSON.stringify(event).includes('OpenCode fixture reply.'),
    );
    assert.ok(thinking > 0);
    assert.ok(reply > thinking);
    assert.equal(result.responseText, 'OpenCode fixture reply.');
  } finally {
    await rm(space.cwd, { recursive: true, force: true });
  }
});

void test('a continued turn loads the saved native session and does not replay history', async () => {
  const space = await workspace('opencode-seam-continue-');
  const second = path.join(space.cwd, 'lifecycle-2.jsonl');
  try {
    const first = await runOpenCodeTurn(
      turn(space, recordingSpawner().spawn, { prompt: 'hello' }),
      { authorize: denyAll, emit: () => undefined },
    );
    assert.equal(first.sessionId, 'opencode-fixture');
    const { events, emit } = collector();
    const continued = await runOpenCodeTurn(
      turn(
        {
          ...space,
          env: { ...space.env, OPENCODE_FIXTURE_LIFECYCLE_LOG: second },
        },
        recordingSpawner().spawn,
        {
          prompt: 'hello',
          sessionId: 'opencode-fixture',
          resumePolicy: 'recover',
        },
      ),
      { authorize: denyAll, emit },
    );
    assert.equal(continued.isError, false, continued.message);
    assert.equal(continued.sessionId, 'opencode-fixture');
    const used = methods(await lifecycle(second));
    assert.ok(used.includes('session/load'));
    assert.ok(!used.includes('session/new'));
    assert.ok(!mentions(events, 'Replayed history must not appear twice.'));
  } finally {
    await rm(space.cwd, { recursive: true, force: true });
  }
});

void test('an unavailable saved session starts fresh only under the recover policy', async () => {
  const space = await workspace('opencode-seam-recover-');
  const strictLog = path.join(space.cwd, 'lifecycle-strict.jsonl');
  try {
    let cleared = 0;
    const { events, emit } = collector();
    const recovered = await runOpenCodeTurn(
      turn(space, recordingSpawner().spawn, {
        prompt: 'hello',
        sessionId: 'missing',
        resumePolicy: 'recover',
      }),
      {
        authorize: denyAll,
        emit,
        onSessionCleared: () => {
          cleared++;
        },
      },
    );
    assert.equal(recovered.isError, false, recovered.message);
    assert.equal(cleared, 1);
    assert.ok(
      mentions(
        events,
        'Started a new OpenCode session because the previous session is unavailable.',
      ),
    );
    const strict = await runOpenCodeTurn(
      turn(
        {
          ...space,
          env: { ...space.env, OPENCODE_FIXTURE_LIFECYCLE_LOG: strictLog },
        },
        recordingSpawner().spawn,
        { prompt: 'hello', sessionId: 'missing', resumePolicy: 'strict' },
      ),
      { authorize: denyAll, emit: () => undefined },
    );
    assert.equal(strict.isError, true);
    assert.equal(strict.requestRejected, true);
    assert.equal(
      strict.message,
      'OpenCode cannot verify the capabilities of this saved session. Start a new chat.',
    );
    assert.ok(!methods(await lifecycle(strictLog)).includes('session/prompt'));
  } finally {
    await rm(space.cwd, { recursive: true, force: true });
  }
});

void test('a resumed turn keeps its capability digest and generation', async () => {
  const space = await workspace('opencode-seam-identity-');
  try {
    const bindings: OpenCodeCapabilityBinding[] = [];
    const host: OpenCodeTurnHost = {
      authorize: denyAll,
      emit: () => undefined,
      onSession: (_sessionId, binding) => {
        bindings.push(binding);
      },
    };
    const { events, emit } = collector();
    const first = recordingSpawner();
    const second = recordingSpawner();
    assert.notEqual(first.spawn, second.spawn);
    await runOpenCodeTurn(turn(space, first.spawn, { prompt: 'hello' }), host);
    const resumed = await runOpenCodeTurn(
      turn(space, second.spawn, {
        prompt: 'hello',
        sessionId: 'opencode-fixture',
        resumePolicy: 'recover',
      }),
      { ...host, emit },
    );
    assert.equal(resumed.isError, false, resumed.message);
    assert.equal(bindings.length, 2);
    const [saved, current] = bindings;
    assert.ok(saved && current);
    assert.equal(saved.generation, 1);
    assert.equal(current.digest, saved.digest);
    assert.equal(current.generation, 1);
    assert.ok(!mentions(events, 'OpenCode capabilities changed.'));
  } finally {
    await rm(space.cwd, { recursive: true, force: true });
  }
});

void test('strict resume refuses a changed capability generation', async () => {
  const space = await workspace('opencode-seam-generation-');
  try {
    const bindings: OpenCodeCapabilityBinding[] = [];
    const onSession: OpenCodeTurnHost['onSession'] = (_sessionId, binding) => {
      bindings.push(binding);
    };
    await runOpenCodeTurn(
      turn(space, recordingSpawner().spawn, {
        prompt: 'hello',
        capabilityContext: { selection: 'a' },
      }),
      { authorize: denyAll, emit: () => undefined, onSession },
    );
    const [saved] = bindings;
    assert.ok(saved);
    const changed = {
      prompt: 'hello',
      sessionId: 'opencode-fixture',
      resumePolicy: 'recover' as const,
      capabilityContext: { selection: 'b' },
    };
    const refused = await runOpenCodeTurn(
      turn(space, recordingSpawner().spawn, {
        ...changed,
        capabilityChanges: 'reject',
      }),
      { authorize: denyAll, emit: () => undefined, onSession },
    );
    assert.equal(refused.isError, true);
    assert.equal(refused.requestRejected, true);
    assert.equal(
      refused.message,
      'OpenCode capabilities changed since this session was saved. Start a new chat to use the current selection.',
    );
    const { events, emit } = collector();
    const announced = await runOpenCodeTurn(
      turn(space, recordingSpawner().spawn, {
        ...changed,
        capabilityChanges: 'announce',
      }),
      { authorize: denyAll, emit, onSession },
    );
    assert.equal(announced.isError, false, announced.message);
    assert.ok(mentions(events, 'OpenCode capabilities changed.'));
    const current = bindings.at(-1);
    assert.ok(current);
    assert.equal(current.generation, 2);
    assert.notEqual(current.digest, saved.digest);
  } finally {
    await rm(space.cwd, { recursive: true, force: true });
  }
});

void test('a native tool runs only after the host allows it', async () => {
  const space = await workspace('opencode-seam-allow-');
  try {
    const inputs: Parameters<OpenCodeTurnHost['authorize']>[0][] = [];
    const result = await runOpenCodeTurn(
      turn(space, recordingSpawner().spawn, { prompt: 'WRITE' }),
      {
        authorize: (input) => {
          inputs.push(input);
          return Promise.resolve({ decision: 'allow' });
        },
        emit: () => undefined,
      },
    );
    assert.equal(result.isError, false, result.message);
    assert.equal(inputs.length, 1);
    const [input] = inputs;
    assert.ok(input);
    assert.equal(input.toolName, 'write');
    assert.equal(input.toolCallId, 'write-1');
    assert.equal(input.sessionId, 'opencode-fixture');
    assert.equal(
      await readFile(path.join(space.cwd, 'sentinel.txt'), 'utf8'),
      'approved',
    );
    assert.equal(result.responseText, 'Write allowed.');
  } finally {
    await rm(space.cwd, { recursive: true, force: true });
  }
});

void test('a denied tool never runs and an unapproved completion ends the turn', async () => {
  const space = await workspace('opencode-seam-deny-');
  try {
    const denied = await runOpenCodeTurn(
      turn(space, recordingSpawner().spawn, { prompt: 'WRITE' }),
      { authorize: denyAll, emit: () => undefined },
    );
    await assert.rejects(readFile(path.join(space.cwd, 'sentinel.txt')));
    assert.equal(denied.responseText, 'Write denied.');
    const unapproved = await runOpenCodeTurn(
      turn(space, recordingSpawner().spawn, { prompt: 'UNAPPROVED' }),
      { authorize: denyAll, emit: () => undefined },
    );
    assert.equal(unapproved.isError, true);
    assert.equal(unapproved.cancelled, false);
  } finally {
    await rm(space.cwd, { recursive: true, force: true });
  }
});

void test('Stop cancels the prompt and drains the process group before returning', async () => {
  const space = await workspace('opencode-seam-stop-');
  const abort = new AbortController();
  const spawner = recordingSpawner();
  try {
    const result = await runOpenCodeTurn(
      turn(space, spawner.spawn, { prompt: 'HOLD', signal: abort.signal }),
      {
        authorize: denyAll,
        emit: (event) => {
          if (JSON.stringify(event).includes('Waiting.')) abort.abort();
        },
      },
    );
    assert.equal(result.cancelled, true);
    assert.equal(result.message, 'Turn cancelled');
    const [child] = spawner.processes;
    assert.ok(child && spawner.closed.has(child));
    assert.ok(spawner.stops >= 1);
    const { pid } = child;
    assert.ok(pid);
    if (process.platform !== 'win32')
      assert.throws(
        () => process.kill(pid, 0),
        (error: unknown) =>
          error instanceof Error && 'code' in error && error.code === 'ESRCH',
      );
  } finally {
    await rm(space.cwd, { recursive: true, force: true });
  }
});

void test('the native database and environment reach the process unchanged', async () => {
  const space = await workspace('opencode-seam-env-');
  const env = { ...space.env, OPENCODE_FIXTURE_MARK: 'kept' };
  const first = recordingSpawner();
  const second = recordingSpawner();
  try {
    await runOpenCodeTurn(
      turn({ ...space, env }, first.spawn, { prompt: 'hello' }),
      { authorize: denyAll, emit: () => undefined },
    );
    const [request] = first.requests;
    assert.ok(request);
    const database = openCodeNativeDatabase(space.env, space.cwd);
    assert.equal(request.env.OPENCODE_FIXTURE_MARK, 'kept');
    assert.equal(request.env.HOME, space.env.HOME);
    assert.equal(request.env.OPENCODE_DB, database);
    assert.equal(
      request.env.XDG_STATE_HOME,
      path.join(space.profileDir, 'state'),
    );
    await runOpenCodeTurn(
      turn({ ...space, env }, second.spawn, { prompt: 'hello' }),
      { authorize: denyAll, emit: () => undefined },
    );
    assert.equal(second.requests[0]?.env.OPENCODE_DB, database);
  } finally {
    await rm(space.cwd, { recursive: true, force: true });
  }
});

void test('native resumes keep the selected connection and refuse a different connection before prompting', async () => {
  const space = await workspace('opencode-seam-connection-');
  const log = path.join(space.cwd, 'lifecycle.jsonl');
  const host: OpenCodeTurnHost = { authorize: denyAll, emit: () => undefined };
  try {
    const first = await runOpenCodeTurn(
      turn(space, recordingSpawner().spawn, { prompt: 'hello' }),
      host,
    );
    assert.equal(first.isError, false, first.message);
    assert.ok(first.sessionId);
    const binding = await readOpenCodeCapabilityBinding(
      space.profileDir,
      first.sessionId,
    );
    assert.equal(binding?.version, 4);
    assert.match(binding?.nativeConnectionDigest ?? '', /^[a-f0-9]{64}$/);
    const fork = await forkOpenCodeCapabilityBinding(
      space.profileDir,
      first.sessionId,
      path.join(space.cwd, 'fork'),
      'fork-session',
      new AbortController().signal,
      binding,
    );
    assert.equal(fork.nativeConnectionDigest, binding?.nativeConnectionDigest);
    const renamed = await runOpenCodeTurn(
      turn(
        {
          ...space,
          env: {
            ...space.env,
            OPENCODE_FIXTURE_CONNECTION_LABEL: 'Renamed account',
          },
        },
        recordingSpawner().spawn,
        {
          prompt: 'continue',
          sessionId: first.sessionId,
          resumePolicy: 'strict',
        },
      ),
      host,
    );
    assert.equal(renamed.isError, false, renamed.message);
    assert.deepEqual(
      await readOpenCodeCapabilityBinding(space.profileDir, first.sessionId),
      binding,
    );
    for (const capabilityChanges of ['reject', 'announce'] as const) {
      await writeFile(log, '');
      const changed = await runOpenCodeTurn(
        turn(
          {
            ...space,
            env: {
              ...space.env,
              OPENCODE_FIXTURE_CONNECTION_ID: 'cred_another',
              OPENCODE_FIXTURE_LIFECYCLE_LOG: log,
            },
          },
          recordingSpawner().spawn,
          {
            prompt: 'private follow-up',
            sessionId: first.sessionId,
            resumePolicy: 'strict',
            capabilityChanges,
          },
        ),
        host,
      );
      assert.equal(changed.requestRejected, true, changed.message);
      assert.ok(!methods(await lifecycle(log)).includes('session/prompt'));
    }
  } finally {
    await rm(space.cwd, { recursive: true, force: true });
  }
});

void test('legacy native sessions require a new chat before any process starts', async () => {
  const space = await workspace('opencode-seam-legacy-connection-');
  const spawner = recordingSpawner();
  try {
    await saveOpenCodeCapabilitySnapshot(
      space.profileDir,
      'legacy',
      {
        version: 1,
        runtime: {},
        contextDigest: 'a'.repeat(64),
        providerSettingsDigest: 'b'.repeat(64),
        files: {},
        mcp: [],
      },
      undefined,
      new AbortController().signal,
    );
    for (const resumePolicy of ['strict', 'recover'] as const) {
      const result = await runOpenCodeTurn(
        turn(space, spawner.spawn, {
          prompt: 'private follow-up',
          sessionId: 'legacy',
          resumePolicy,
          capabilityChanges: 'announce',
        }),
        { authorize: denyAll, emit: () => undefined },
      );
      assert.equal(result.requestRejected, true, result.message);
    }
    assert.equal(spawner.requests.length, 0);
  } finally {
    await rm(space.cwd, { recursive: true, force: true });
  }
});

void test('a connection switch while the host prepares a prompt prevents delivery', async () => {
  const space = await workspace('opencode-seam-connection-race-');
  const file = path.join(space.cwd, 'connection.json');
  const log = path.join(space.cwd, 'lifecycle.jsonl');
  const connection = {
    type: 'credential',
    id: 'cred_before',
    method: 'oauth',
    label: 'Fixture',
  };
  try {
    await writeFile(file, JSON.stringify(connection));
    const result = await runOpenCodeTurn(
      turn(
        {
          ...space,
          env: {
            ...space.env,
            OPENCODE_FIXTURE_CONNECTION_FILE: file,
            OPENCODE_FIXTURE_LIFECYCLE_LOG: log,
          },
        },
        recordingSpawner().spawn,
        { prompt: 'private request' },
      ),
      {
        authorize: denyAll,
        emit: () => undefined,
        beforePrompt: () =>
          writeFile(file, JSON.stringify({ ...connection, id: 'cred_after' })),
      },
    );
    assert.equal(result.requestRejected, true, result.message);
    assert.ok(!methods(await lifecycle(log)).includes('session/prompt'));
  } finally {
    await rm(space.cwd, { recursive: true, force: true });
  }
});
