import type { CanopySpawnedDaemon } from '../launcher-ports';
import {
  classifyCanopyDescriptor,
  parseCanopyRuntimeDescriptor,
  type CanopyDescriptorState,
} from '../descriptor';
import { descriptorFor, ScriptedDaemon } from './fixtures/scripted-daemon';

const signal = new AbortController().signal;
const command = { executable: '/private/bin/canopy', args: ['daemon'], signal };

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function watchExit(spawned: CanopySpawnedDaemon): { settled: boolean } {
  const exit = { settled: false };
  void spawned.exited.then(() => (exit.settled = true));
  return exit;
}

const classify = (
  world: ScriptedDaemon,
  protocolVersions = [1],
): Promise<CanopyDescriptorState> =>
  classifyCanopyDescriptor({
    source: world.descriptor,
    supervisor: world.supervisor,
    protocolVersions,
    signal,
  });

describe('spawn and supervision', () => {
  /** Installs the spawn gate and returns the trigger that fails it, if deferred. */
  const failures: Array<[string, (world: ScriptedDaemon) => () => void]> = [
    [
      'immediately',
      (world) => {
        const error = new Error('/private secret');
        world.gates.set('spawn', () => Promise.reject(error));
        return (): void => {};
      },
    ],
    [
      'after a deferred failure',
      (world) => {
        const latch = world.defer('spawn');
        return (): void => latch.fail();
      },
    ],
  ];

  it.each(failures)(
    'a spawn rejected %s creates no process or record',
    async (_label, arrange) => {
      const world = new ScriptedDaemon();
      world.child = jest.fn();
      const fail = arrange(world);
      const spawning = world.supervisor.spawnDaemon(command);
      const rejected = expect(spawning).rejects.toThrow('/private secret');
      await jest.advanceTimersByTimeAsync(50);
      fail();
      await rejected;
      await jest.advanceTimersByTimeAsync(100);
      expect(world.events).toEqual(['spawn']);
      expect(world.spawns).toEqual([]);
      expect(world.live.size).toBe(0);
      expect(world.child).not.toHaveBeenCalled();
      expect(await world.supervisor.inspectProcess(900, signal)).toBeNull();
    },
  );

  it('a deferred spawn has no process until its latch opens, then supervises exit', async () => {
    const world = new ScriptedDaemon();
    const latch = world.defer('spawn');
    const spawning = world.supervisor.spawnDaemon(command);
    await jest.advanceTimersByTimeAsync(50);
    expect(world.spawns).toEqual([]);
    expect(await world.supervisor.inspectProcess(900, signal)).toBeNull();
    latch.open();
    const spawned = await spawning;
    expect(spawned.pid).toBe(900);
    expect(world.spawns).toEqual([command]);
    expect(world.live.get(900)).toBe('start-900');
    const exit = watchExit(spawned);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(exit.settled).toBe(false);
    world.exit(spawned.pid);
    expect(await spawned.exited).toEqual({ code: 1, signal: null });
    expect(world.live.has(spawned.pid)).toBe(false);
  });

  it('terminating with terminateExits=false does not itself prove exit', async () => {
    const world = new ScriptedDaemon();
    world.terminateExits = false;
    const spawned = await world.supervisor.spawnDaemon(command);
    const exit = watchExit(spawned);
    await world.supervisor.terminateDaemon(spawned, signal);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(world.events).toEqual(['spawn', 'terminate:900']);
    expect(exit.settled).toBe(false);
    const running = await world.supervisor.inspectProcess(900, signal);
    expect(running).toEqual({ startIdentity: 'start-900' });
    world.exit(900);
    expect(await spawned.exited).toEqual({ code: 1, signal: null });
    expect(await world.supervisor.inspectProcess(900, signal)).toBeNull();
  });

  it('terminating with the default terminateExits settles the exit handle', async () => {
    const world = new ScriptedDaemon();
    const spawned = await world.supervisor.spawnDaemon(command);
    await world.supervisor.terminateDaemon(spawned, signal);
    expect(await spawned.exited).toEqual({ code: 1, signal: null });
    expect(world.live.has(900)).toBe(false);
  });
});

describe('descriptor publication', () => {
  it('publishes a descriptor whose identity and major agree with the inspector', async () => {
    const world = new ScriptedDaemon();
    expect(await classify(world)).toEqual({ kind: 'absent' });
    await world.supervisor.spawnDaemon(command);
    await jest.advanceTimersByTimeAsync(9);
    expect(world.raw).toBeNull();
    await jest.advanceTimersByTimeAsync(1);
    const descriptor = descriptorFor(900);
    const raw = await world.descriptor.read(signal);
    expect(parseCanopyRuntimeDescriptor(raw)).toEqual(descriptor);
    const { startIdentity } = descriptor;
    const running = await world.supervisor.inspectProcess(900, signal);
    expect(running).toEqual({ startIdentity });
    expect(await classify(world)).toEqual({ kind: 'live', descriptor });
    world.publish(900, 2);
    expect(await classify(world)).toMatchObject({ kind: 'incompatible' });
    expect(await classify(world, [2])).toMatchObject({ kind: 'live' });
    world.live.set(900, 'start-reused');
    const mismatch = { kind: 'stale', reason: 'identity_mismatch' };
    expect(await classify(world, [2])).toEqual(mismatch);
    world.exit(900);
    const exited = { kind: 'stale', reason: 'process_exited' };
    expect(await classify(world, [2])).toEqual(exited);
  });

  it.each([
    ['default termination', true],
    ['a manual exit', false],
  ])(
    'a child stopped by %s before publishing never publishes',
    async (_label, terminate) => {
      const world = new ScriptedDaemon();
      const spawned = await world.supervisor.spawnDaemon(command);
      if (terminate) await world.supervisor.terminateDaemon(spawned, signal);
      else world.exit(spawned.pid);
      expect(await spawned.exited).toEqual({ code: 1, signal: null });
      await jest.advanceTimersByTimeAsync(1_000);
      expect(world.live.has(spawned.pid)).toBe(false);
      expect(world.raw).toBeNull();
      expect(await classify(world)).toEqual({ kind: 'absent' });
    },
  );
});

describe('startup claim results', () => {
  it('answers scripted acquisitions in order and repeats the last', async () => {
    const world = new ScriptedDaemon();
    world.acquisitions = ['held', 'ambiguous', 'acquired'];
    const results = [];
    for (let i = 0; i < 4; i++)
      results.push(await world.claim.tryAcquire(signal));
    expect(results).toEqual([
      { kind: 'held' },
      { kind: 'ambiguous' },
      { kind: 'acquired', handle: world.handle },
      { kind: 'acquired', handle: world.handle },
    ]);
  });

  it.each(['released', 'not_owner', 'ambiguous'] as const)(
    'returns the scripted %s release result and records the handle',
    async (result) => {
      const world = new ScriptedDaemon();
      world.releaseResult = result;
      expect(await world.claim.release(world.handle)).toBe(result);
      expect(world.released).toHaveLength(1);
      expect(world.released[0]).toBe(world.handle);
    },
  );

  it('holds an acquisition behind a deferred gate until the test opens it', async () => {
    const world = new ScriptedDaemon();
    const latch = world.defer('acquire');
    const acquiring = world.claim.tryAcquire(signal);
    let answered = false;
    void acquiring.then(() => (answered = true));
    await jest.advanceTimersByTimeAsync(100);
    expect(answered).toBe(false);
    latch.open();
    expect(await acquiring).toEqual({ kind: 'acquired', handle: world.handle });
  });
});
