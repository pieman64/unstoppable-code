import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
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
