// All provider replies are barrier-controlled on a disposable bus, never a login bus.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (!specifier.startsWith('.')) throw error;
      try {
        return next(`${specifier}.ts`, context);
      } catch {
        return next(`${specifier}/index.ts`, context);
      }
    }
  },
  load(url, context, next) {
    if (!url.startsWith('file:') || !url.endsWith('.ts'))
      return next(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), {
        mode: 'transform',
        sourceUrl: url,
      }),
    };
  },
});
const { createSecretProtectionServices } =
  await import('../../secret-protection/index');
type Operation = 'status' | 'read' | 'create' | 'replace' | 'delete';
interface Native {
  diagnostics(): { apiCalls: number; dismissCalls: number; ownedBytes: number };
}
function isNative(value: unknown): value is Native {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.getOwnPropertyDescriptor(value, 'fixture')?.value === false &&
    Object.getOwnPropertyDescriptor(value, 'abi')?.value ===
      'linux-secret-service-v1' &&
    typeof Object.getOwnPropertyDescriptor(value, 'diagnostics')?.value ===
      'function'
  );
}

// Event history avoids a lost readiness signal; exit/EOF fails every pending wait.
class Peer {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;
  readonly events: Record<string, unknown>[] = [];
  private readonly waiters = new Set<{
    name: string;
    resolve(value: Record<string, unknown>): void;
    reject(error: Error): void;
  }>();
  private failure: Error | undefined;
  constructor(
    file: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    json = true,
  ) {
    this.child = spawn(file, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    // No arbitrary provider diagnostics, attributes or material in failures.
    this.child.stderr.resume();
    this.child.stdin.on('error', () => {});
    const fail = (): void => {
      this.failure = new Error('Private peer closed or sent invalid protocol.');
      for (const waiter of this.waiters) waiter.reject(this.failure);
      this.waiters.clear();
    };
    this.child.once('error', fail);
    this.closed = new Promise<void>((resolve) => {
      this.child.once('close', () => {
        fail();
        resolve();
      });
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.once('close', fail);
    lines.on('line', (line) => {
      let value: unknown;
      try {
        value = json ? JSON.parse(line) : { event: 'address', address: line };
        if (typeof value !== 'object' || value === null || Array.isArray(value))
          throw new Error();
        // Rebuild from entries to narrow untrusted JSON without a forced cast.
        const event = Object.fromEntries(Object.entries(value));
        if (typeof event.event !== 'string') throw new Error();
        this.events.push(event);
        for (const waiter of this.waiters) {
          if (waiter.name !== event.event) continue;
          this.waiters.delete(waiter);
          waiter.resolve(event);
        }
      } catch {
        fail();
      }
    });
  }
  wait(name: string, after = 0): Promise<Record<string, unknown>> {
    if (this.failure) return Promise.reject(this.failure);
    const event = this.events
      .slice(after)
      .find((value) => value.event === name);
    if (event) return Promise.resolve(event);
    return new Promise((resolve, reject) => {
      this.waiters.add({ name, resolve, reject });
    });
  }
  control(command: string, reply = command): Promise<Record<string, unknown>> {
    const after = this.events.length;
    const result = this.wait(reply, after);
    this.child.stdin.write(`${command}\n`);
    return result;
  }
  async stop(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null)
      this.child.kill('SIGKILL');
    await this.closed;
  }
}

const [product, fixture, mode] = process.argv.slice(2);
assert.ok(
  product && fixture && mode,
  'Missing controlled qualification arguments.',
);
const root = mkdtempSync('/tmp/can4503-');
const peers: Peer[] = [];
const env: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  CAN4503_FIXTURE_ROOT: root,
};
for (const [key, part] of Object.entries({
  HOME: 'home',
  XDG_DATA_HOME: 'data',
  XDG_CONFIG_HOME: 'config',
  XDG_CACHE_HOME: 'cache',
  XDG_RUNTIME_DIR: 'runtime',
})) {
  env[key] = join(root, part);
  mkdirSync(env[key], { mode: 0o700 });
}
const start = (file: string, args: string[], json = true): Peer => {
  const peer = new Peer(file, args, env, json);
  peers.push(peer);
  return peer;
};
const watchdog = setTimeout(() => {
  for (const peer of peers) peer.child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
  process.stderr.write(
    'Controlled qualification watchdog; no semantic conclusion.\n',
  );
  process.exit(2);
}, 15_000);
watchdog.unref();
try {
  // No activation directories: even an unexpected service loss cannot start a real keyring.
  const config = join(root, 'bus.conf');
  writeFileSync(
    config,
    `<busconfig><type>session</type><listen>unix:path=${root}/bus</listen><auth>EXTERNAL</auth><policy context="default"><allow own="*"/><allow send_destination="*"/><allow receive_sender="*"/></policy></busconfig>`,
  );
  const bus = start(
    '/usr/bin/dbus-daemon',
    [`--config-file=${config}`, '--nofork', '--print-address=1'],
    false,
  );
  const address = (await bus.wait('address')).address;
  assert.ok(
    typeof address === 'string' && address.startsWith(`unix:path=${root}/bus,`),
  );
  env.DBUS_SESSION_BUS_ADDRESS = address;
  Object.assign(process.env, env);
  const server = start(fixture, ['serve']);
  await server.wait('service-ready');
  if (mode === 'replace' || mode === 'delete') await server.control('present');
  if (mode === 'read-transport')
    await server.control('hold-search', 'holding-search');
  const prompt = mode.startsWith('prompt');
  if (prompt || mode === 'locked-never') await server.control('lock', 'locked');
  if (mode === 'prompt-reply-abort')
    await server.control('hold-prompt', 'holding-prompt');
  const loaded = { exports: {} };
  process.dlopen(loaded, product);
  const native: unknown = loaded.exports;
  assert.ok(isNative(native), 'Invalid controlled qualification addon.');
  const make = (): ReturnType<typeof createSecretProtectionServices> =>
    createSecretProtectionServices({
      os: 'linux',
      nativePath: product,
      brandId: 'canopy',
      build: 'dev',
      authorityId: 'a'.repeat(64),
    });
  // Recompose for every call: the latch must survive fresh factory adapters.
  const run = async (
    op: Operation,
    signal = new AbortController().signal,
  ): Promise<string> => {
    const port = make();
    const options = {
      signal,
      interaction: prompt ? 'allowed' : 'never',
    } satisfies Parameters<typeof port.readKeySlot>[1];
    const slot = { name: 'qualification' };
    if (op === 'status') return (await port.status(options)).state;
    if (op === 'read') {
      const result = await port.readKeySlot(slot, options);
      if (result.kind === 'present') result.material.fill(0);
      return result.kind === 'blocked' ? result.reason : result.kind;
    }
    if (op === 'delete') {
      const result = await port.deleteKeySlot(slot, options);
      return result.kind === 'blocked' ? result.reason : result.kind;
    }
    const result = await port.writeKeySlot(slot, new Uint8Array([1, 2, 3]), {
      ...options,
      mode: op,
    });
    return result.kind === 'blocked' ? result.reason : result.kind;
  };
  const assertLatch = async (): Promise<void> => {
    const before = native.diagnostics().apiCalls;
    for (const op of [
      'status',
      'read',
      'create',
      'replace',
      'delete',
    ] satisfies Operation[])
      assert.equal(await run(op), 'unavailable');
    assert.equal(native.diagnostics().apiCalls, before);
  };
  const controller = new AbortController();
  const reason = new Error('synthetic abort');
  const operation =
    mode === 'prompt-create-abort'
      ? 'create'
      : prompt || mode === 'locked-never' || mode === 'read-transport'
        ? 'read'
        : mode === 'transport' || mode === 'bus-transport'
          ? 'create'
          : mode;
  assert.ok(
    operation === 'read' ||
      operation === 'create' ||
      operation === 'replace' ||
      operation === 'delete',
  );
  let settled = false;
  let settlements = 0;
  // Observe rejection immediately, including while waiting for provider barriers.
  const pending = run(operation, controller.signal).then(
    (code) => {
      settled = true;
      settlements++;
      return { rejected: false, code, sameReason: false };
    },
    (error: unknown) => {
      settled = true;
      settlements++;
      return { rejected: true, code: undefined, sameReason: error === reason };
    },
  );
  let survivor: Promise<string> | undefined;
  if (mode === 'read-transport') {
    await server.wait('read-submitted');
    await server.control('disconnect', 'disconnected');
    assert.equal((await pending).code, 'unavailable');
    await assertLatch();
  } else if (mode === 'locked-never') {
    assert.equal((await pending).code, 'locked');
    await server.control('checkpoint');
    assert.equal(
      server.events.some(
        (event) =>
          event.event === 'prompt-called' || event.event === 'unlock-called',
      ),
      false,
    );
  } else if (prompt) {
    await server.wait('prompt-called');
    if (mode === 'prompt-queued-abort') {
      const before = native.diagnostics().apiCalls;
      const controls = [
        new AbortController(),
        new AbortController(),
        new AbortController(),
      ];
      const queued = controls.map((control, index) => {
        if (index === 1) survivor = run('status');
        const op = index === 0 ? 'read' : index === 1 ? 'create' : 'delete';
        return assert.rejects(
          run(op, control.signal),
          (error: unknown) => error === reason,
        );
      });
      // Exercise middle/tail/head unlinking while the active OS prompt remains unanswered.
      for (const index of [1, 2, 0]) controls[index].abort(reason);
      await Promise.all(queued);
      assert.equal(native.diagnostics().apiCalls, before);
      assert.equal(settled, false);
    }
    if (mode === 'prompt-bus-transport' || mode === 'prompt-transport') {
      if (mode === 'prompt-bus-transport') await bus.stop();
      else await server.control('disconnect', 'disconnected');
      assert.equal((await pending).code, 'unavailable');
      await assertLatch();
    } else if (mode === 'prompt-success') {
      assert.equal(settled, false);
      await server.control('unlock-ack');
      assert.equal((await pending).code, 'absent');
    } else {
      controller.abort(reason);
      const result = await pending;
      assert.equal(result.rejected, true);
      assert.equal(result.sameReason, true);
      // A live entry must survive unlinking its aborted neighbors.
      if (survivor) assert.equal(await survivor, 'locked');
      assert.equal(native.diagnostics().ownedBytes, 0);
      assert.equal(settlements, 1);
      // No reply or Completed is released until abort settles. The prompt is not dismissed.
      if (mode === 'prompt-reply-abort') await server.control('prompt-ack');
      if (mode === 'prompt-completed')
        await server.control('release-completed', 'dismiss-ack');
      else await server.control('unlock-ack');
      assert.equal(
        await run('status'),
        mode === 'prompt-completed' ? 'locked' : 'available',
      );
      assert.equal(settlements, 1);
      const checkpoint = await server.control('checkpoint');
      assert.equal(checkpoint.mutations, 0);
      assert.equal(checkpoint.submissions, 0);
      assert.equal(checkpoint.dismissCalls, 0);
    }
    assert.equal(native.diagnostics().dismissCalls, 0);
  } else {
    await server.wait('mutation-submitted');
    controller.abort(reason);
    assert.equal(settled, false);
    if (mode === 'transport' || mode === 'bus-transport') {
      if (mode === 'bus-transport') await bus.stop();
      else await server.control('disconnect', 'disconnected');
      assert.equal((await pending).code, 'uncertain');
      await assertLatch();
      if (mode === 'transport') {
        assert.equal((await server.control('checkpoint')).mutations, 0);
        await server.control('release', 'mutation-landed');
        assert.equal((await server.control('checkpoint')).mutations, 1);
      }
    } else {
      assert.equal((await server.control('checkpoint')).mutations, 0);
      assert.equal(settled, false);
      await server.control('release', 'mutation-landed');
      assert.equal(
        (await pending).code,
        mode === 'delete' ? 'deleted' : 'written',
      );
      const checkpoint = await server.control('checkpoint');
      assert.equal(checkpoint.mutations, 1);
      assert.equal(checkpoint.submissions, 1);
      assert.equal(checkpoint.present, mode !== 'delete');
    }
  }
  assert.equal(native.diagnostics().ownedBytes, 0);
  assert.equal(settlements, 1);
  process.stdout.write(JSON.stringify({ passed: true, mode }));
} catch (error) {
  const line =
    error instanceof Error
      ? error.stack?.match(/secret-service-controlled\.ts:(\d+):\d+/)?.[1]
      : undefined;
  process.stderr.write(
    `Controlled qualification failed: ${mode}, line ${line ?? 'unknown'}; provider diagnostics withheld.\n`,
  );
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  for (const peer of peers.reverse()) await peer.stop();
  rmSync(root, { recursive: true, force: true });
}
