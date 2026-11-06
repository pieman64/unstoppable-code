// Disposable Secret Service only. Never inherit a login bus, HOME or XDG root.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

// Standalone Node must resolve the same extensionless TS imports as Jest.
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
      source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), {
        mode: 'transform',
        sourceUrl: url,
      }),
    };
  },
});
const { createSecretProtectionServices } =
  await import('../../secret-protection/index');
const { runSecretProtectionConformance } =
  await import('../../../../core-runtime/src/platform/testing/secret-protection-conformance');

function diagnostic(value: unknown): unknown {
  if (value instanceof Uint8Array) return { materialLength: value.byteLength };
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (
    typeof value === 'string' &&
    [
      'ok',
      'absent',
      'corrupt',
      'conflict',
      'locked',
      'denied',
      'unavailable',
      'unsupported_session',
      'uncertain',
      'interaction_required',
    ].includes(value)
  )
    return value;
  return '<redacted>';
}

interface NativeReply {
  code: string;
  material?: Uint8Array;
}
interface Diagnostics {
  apiCalls: number;
  ownedBytes: number;
  unlockCalls: number;
  promptCalls: number;
  dismissCalls: number;
}
interface Native {
  fixture: boolean;
  run(
    op: string,
    service: string,
    account: string,
    material: Uint8Array,
    interaction: string,
    signal: AbortSignal,
  ): Promise<NativeReply>;
  diagnostics(): Diagnostics;
}
function load(file: string): Native {
  const loaded = { exports: {} };
  process.dlopen(loaded, file);
  const value: unknown = loaded.exports;
  assert.ok(isNative(value), 'Invalid native qualification addon.');
  return value;
}
function isNative(value: unknown): value is Native {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Object.getOwnPropertyDescriptor(value, 'fixture')?.value ===
      'boolean' &&
    ['run', 'diagnostics'].every(
      (key) =>
        typeof Object.getOwnPropertyDescriptor(value, key)?.value ===
        'function',
    )
  );
}
interface Options {
  service?: string;
  account?: string;
  interaction?: string;
  signal?: AbortSignal;
}
const [productPath, fixturePath, mode] = process.argv.slice(2);
assert.ok(
  productPath && fixturePath && mode,
  'Missing qualification arguments.',
);
const root = mkdtempSync('/tmp/c4503-');
const children: ChildProcessWithoutNullStreams[] = [];
const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
for (const [name, part] of Object.entries({
  HOME: 'home',
  XDG_DATA_HOME: 'data',
  XDG_CONFIG_HOME: 'config',
  XDG_CACHE_HOME: 'cache',
  XDG_RUNTIME_DIR: 'runtime',
})) {
  env[name] = join(root, part);
  mkdirSync(env[name], { mode: 0o700 });
}
mkdirSync(join(root, 'control'), { mode: 0o700 });
function start(file: string, args: string[]): ChildProcessWithoutNullStreams {
  const child = spawn(file, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  // Provider diagnostics may contain caller attributes: never print them.
  child.stderr.resume();
  return child;
}
function firstLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    lines.once('line', (line) => {
      resolve(line);
      lines.close();
      child.stdout.resume();
    });
    child.once('error', reject);
    child.once('exit', () =>
      reject(new Error('Private service exited before readiness.')),
    );
  });
}
function tool(file: string, args: string[]): string {
  return execFileSync(file, args, {
    env,
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['pipe', 'pipe', 'ignore'],
  }).trim();
}
const service = 'canopy.dev.vault';
const account = `${service}/${'a'.repeat(64)}/qualification`;
const empty = new Uint8Array();
const watchdog = setTimeout(() => {
  for (const child of children) child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
  process.stderr.write(
    'Private qualification watchdog; no semantic conclusion.\n',
  );
  process.exit(2);
}, 15_000);
watchdog.unref();
try {
  // No service directories: the missing-provider case must not auto-activate GNOME.
  if (mode === 'no-provider')
    writeFileSync(
      join(root, 'bus.conf'),
      `
    <busconfig><type>session</type><listen>unix:path=${root}/bus</listen>
    <auth>EXTERNAL</auth><policy context="default"><allow own="*"/>
    <allow send_destination="*"/><allow receive_sender="*"/></policy></busconfig>`,
    );
  const bus = start('/usr/bin/dbus-daemon', [
    mode === 'no-provider' ? `--config-file=${root}/bus.conf` : '--session',
    '--nofork',
    `--address=unix:path=${root}/bus`,
    '--print-address=1',
  ]);
  const address = await firstLine(bus);
  assert.ok(address.startsWith(`unix:path=${root}/bus,`));
  env.DBUS_SESSION_BUS_ADDRESS = address;
  Object.assign(process.env, env);
  if (mode !== 'no-provider') {
    const provider = start('/usr/bin/gnome-keyring-daemon', [
      '--foreground',
      '--unlock',
      '--components=secrets',
      `--control-directory=${root}/control`,
    ]);
    provider.stdout.resume();
    const owner = start('/usr/bin/gdbus', [
      'wait',
      '--session',
      'org.freedesktop.secrets',
    ]);
    const ready = new Promise<void>((resolve, reject) => {
      owner.once('error', reject);
      owner.once('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error('Private owner wait failed.')),
      );
    });
    provider.stdin.end('disposable-qualification-only\n');
    await ready;
  }
  const native = load(productPath);
  const fixture = load(fixturePath);
  assert.equal(native.fixture, false);
  assert.equal(fixture.fixture, true);
  const makePort = (
    brandId = 'canopy',
    build: 'stable' | 'internal' | 'rc' | 'dev' = 'dev',
    nativePath = productPath,
  ): ReturnType<typeof createSecretProtectionServices> =>
    createSecretProtectionServices({
      os: 'linux',
      nativePath,
      brandId,
      build,
      authorityId: 'a'.repeat(64),
    });
  const port = makePort();
  const slot = { name: 'qualification' };
  const call = (): { signal: AbortSignal; interaction: 'never' } => ({
    signal: new AbortController().signal,
    interaction: 'never',
  });
  let contractCases: number | undefined;
  function run(
    op: string,
    material = empty,
    options: Options = {},
  ): Promise<NativeReply> {
    return native.run(
      op,
      options.service ?? service,
      options.account ?? account,
      material,
      options.interaction ?? 'never',
      options.signal ?? new AbortController().signal,
    );
  }
  if (mode === 'conformance') {
    const tests: (() => Promise<void>)[] = [];
    runSecretProtectionConformance(
      {
        describe: (_name, body) => body(),
        it: (_name, body) => tests.push(body),
      },
      () => ({
        port: makePort(),
        prompts: (): number => native.diagnostics().promptCalls,
      }),
      {
        withFaults: false,
        slotPrefix: 'linux-contract',
      },
    );
    for (const body of tests) await body();
    contractCases = tests.length;
    assert.ok(contractCases > 0);
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        makePort().writeKeySlot(slot, new Uint8Array([8]), {
          ...call(),
          mode: 'create',
        }),
      ),
    );
    assert.equal(outcomes.filter((r) => r.kind === 'written').length, 1);
    assert.equal(outcomes.filter((r) => r.kind === 'conflict').length, 7);
    assert.deepEqual(await port.deleteKeySlot(slot, call()), {
      kind: 'deleted',
    });
    assert.equal(native.diagnostics().ownedBytes, 0);
    assert.equal(native.diagnostics().promptCalls, 0);
  } else if (mode === 'namespace') {
    let index = 0;
    for (const brand of ['canopy', 'unstoppable-code']) {
      for (const build of ['stable', 'internal', 'rc', 'dev'] as const) {
        assert.deepEqual(
          await makePort(brand, build).writeKeySlot(
            slot,
            new Uint8Array([++index]),
            { ...call(), mode: 'create' },
          ),
          { kind: 'written' },
        );
      }
    }
    index = 0;
    // Moving a host's data root does not enter this adapter's storage identity.
    process.env.CANOPY_DATA_DIR = join(root, 'other-data');
    for (const brand of ['canopy', 'unstoppable-code']) {
      for (const build of ['stable', 'internal', 'rc', 'dev'] as const) {
        const other = makePort(brand, build);
        const read = await other.readKeySlot(slot, call());
        assert.equal(read.kind, 'present');
        if (read.kind === 'present') {
          assert.deepEqual(read.material, new Uint8Array([++index]));
          read.material.fill(0);
        }
        assert.deepEqual(await other.deleteKeySlot(slot, call()), {
          kind: 'deleted',
        });
      }
    }
  } else if (mode === 'unavailable') {
    const before = native.diagnostics().apiCalls;
    for (const path of [fixturePath, join(root, 'missing.node')]) {
      const missing = makePort('canopy', 'dev', path);
      assert.deepEqual(await missing.status(call()), {
        state: 'unavailable',
        reason: 'backend_failed',
      });
      assert.deepEqual(await missing.readKeySlot(slot, call()), {
        kind: 'blocked',
        reason: 'unavailable',
      });
      assert.deepEqual(
        await missing.writeKeySlot(slot, new Uint8Array([1]), {
          ...call(),
          mode: 'create',
        }),
        { kind: 'blocked', reason: 'unavailable' },
      );
      assert.deepEqual(await missing.deleteKeySlot(slot, call()), {
        kind: 'blocked',
        reason: 'unavailable',
      });
    }
    assert.equal(native.diagnostics().apiCalls, before);
    assert.deepEqual(await port.status(call()), { state: 'available' });
  } else if (mode === 'no-provider') {
    assert.deepEqual(await port.status(call()), {
      state: 'unavailable',
      reason: 'backend_failed',
    });
    assert.deepEqual(await port.readKeySlot(slot, call()), {
      kind: 'blocked',
      reason: 'unavailable',
    });
  } else if (mode === 'roundtrip') {
    assert.equal((await run('status')).code, 'ok');
    for (const length of [1, 1024]) {
      const material = Uint8Array.from({ length }, (_, i) => i % 256);
      assert.equal((await run('replace', material)).code, 'conflict');
      assert.equal((await run('create', material)).code, 'ok');
      assert.equal(
        (await run('create', new Uint8Array([17]))).code,
        'conflict',
      );
      const first = await run('read');
      assert.equal(first.code, 'ok');
      assert.ok(first.material);
      assert.deepEqual(first.material, material);
      first.material.fill(0);
      assert.deepEqual((await run('read')).material, material);
      assert.equal(
        (await run('replace', new Uint8Array([0, 19, 0]))).code,
        'ok',
      );
      assert.deepEqual(
        (await run('read')).material,
        new Uint8Array([0, 19, 0]),
      );
      assert.equal((await run('delete')).code, 'ok');
      assert.equal((await run('read')).code, 'absent');
      assert.equal((await run('delete')).code, 'absent');
    }
    const before = native.diagnostics().apiCalls;
    for (const length of [0, 1025])
      assert.throws(() => run('create', new Uint8Array(length)), TypeError);
    assert.throws(
      () => run('read', empty, { account: `${account}/bad` }),
      TypeError,
    );
    assert.throws(
      () => run('read', empty, { interaction: 'invalid' }),
      TypeError,
    );
    assert.equal(native.diagnostics().apiCalls, before);
    const controller = new AbortController();
    const reason = new Error('synthetic abort');
    controller.abort(reason);
    await assert.rejects(
      run('create', new Uint8Array([1]), { signal: controller.signal }),
      (e) => e === reason,
    );
    assert.equal(native.diagnostics().apiCalls, before);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => run('create', new Uint8Array([2]))),
    );
    assert.equal(results.filter((r) => r.code === 'ok').length, 1);
    assert.equal(results.filter((r) => r.code === 'conflict').length, 7);
    assert.equal((await run('delete')).code, 'ok');
    // Queued abort cannot reach the backend, even behind an active request.
    const active = run('status');
    const queued = new AbortController();
    const pending = run('create', new Uint8Array([3]), {
      signal: queued.signal,
    });
    queued.abort(reason);
    await assert.rejects(pending, (e) => e === reason);
    await active;
    assert.equal((await run('read')).code, 'absent');
    assert.equal(native.diagnostics().ownedBytes, 0);
    for (const brand of ['canopy', 'unstoppable-code']) {
      for (const build of ['stable', 'internal', 'rc', 'dev']) {
        const otherService = `${brand}.${build}.vault`;
        const options = {
          service: otherService,
          account: `${otherService}/${'b'.repeat(64)}/isolation`,
        };
        assert.equal(
          (await run('create', new Uint8Array([8]), options)).code,
          'ok',
        );
        assert.deepEqual(
          (await run('read', empty, options)).material,
          new Uint8Array([8]),
        );
        assert.equal((await run('delete', empty, options)).code, 'ok');
      }
    }
  } else if (mode === 'malformed') {
    assert.equal(
      (
        await fixture.run(
          'fixture-empty',
          service,
          account,
          new Uint8Array([4]),
          'never',
          new AbortController().signal,
        )
      ).code,
      'ok',
    );
    assert.equal((await run('read')).code, 'corrupt');
    assert.deepEqual(await port.readKeySlot(slot, call()), { kind: 'corrupt' });
    assert.equal((await run('create', new Uint8Array([5]))).code, 'conflict');
    assert.equal((await run('replace', new Uint8Array([5]))).code, 'ok');
    assert.deepEqual((await run('read')).material, new Uint8Array([5]));
    assert.equal((await run('delete')).code, 'ok');
  } else if (mode === 'no-bus') {
    process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${root}/no-bus`;
    assert.equal((await run('status')).code, 'unsupported_session');
    assert.equal((await run('read')).code, 'unsupported_session');
    assert.deepEqual(await port.status(call()), {
      state: 'unavailable',
      reason: 'unsupported_session',
    });
    assert.deepEqual(await port.readKeySlot(slot, call()), {
      kind: 'blocked',
      reason: 'unavailable',
    });
    assert.deepEqual(
      await port.writeKeySlot(slot, new Uint8Array([1]), {
        ...call(),
        mode: 'create',
      }),
      { kind: 'blocked', reason: 'unavailable' },
    );
    assert.deepEqual(await port.deleteKeySlot(slot, call()), {
      kind: 'blocked',
      reason: 'unavailable',
    });
  } else if (mode === 'duplicates') {
    const createDuplicate = (): Promise<NativeReply> =>
      fixture.run(
        'fixture-create',
        service,
        account,
        new Uint8Array([4]),
        'never',
        new AbortController().signal,
      );
    assert.equal((await createDuplicate()).code, 'ok');
    assert.equal((await createDuplicate()).code, 'ok');
    for (const op of ['read', 'replace', 'delete'])
      assert.equal(
        (await run(op, op === 'replace' ? new Uint8Array([5]) : empty)).code,
        'corrupt',
      );
    assert.equal((await run('read')).code, 'corrupt');
    assert.deepEqual(
      await port.writeKeySlot(slot, new Uint8Array([5]), {
        ...call(),
        mode: 'replace',
      }),
      { kind: 'uncertain' },
    );
    assert.deepEqual(await port.deleteKeySlot(slot, call()), {
      kind: 'uncertain',
    });
    assert.deepEqual(await port.readKeySlot(slot, call()), { kind: 'corrupt' });
  } else if (mode === 'locked') {
    assert.equal((await run('create', new Uint8Array([6]))).code, 'ok');
    const collection = tool('/usr/bin/gdbus', [
      'call',
      '--session',
      '--dest',
      'org.freedesktop.secrets',
      '--object-path',
      '/org/freedesktop/secrets',
      '--method',
      'org.freedesktop.Secret.Service.ReadAlias',
      'default',
    ]).match(/objectpath '([^']+)'/i)?.[1];
    assert.ok(collection, 'Private default collection missing.');
    tool('/usr/bin/gdbus', [
      'call',
      '--session',
      '--dest',
      'org.freedesktop.secrets',
      '--object-path',
      '/org/freedesktop/secrets',
      '--method',
      'org.freedesktop.Secret.Service.Lock',
      `["${collection}"]`,
    ]);
    for (const op of ['status', 'read', 'create', 'replace', 'delete'])
      assert.equal(
        (
          await run(
            op,
            ['create', 'replace'].includes(op) ? new Uint8Array([7]) : empty,
          )
        ).code,
        'locked',
      );
    assert.equal(native.diagnostics().unlockCalls, 0);
    assert.equal(native.diagnostics().promptCalls, 0);
    assert.equal(native.diagnostics().dismissCalls, 0);
    assert.deepEqual(await port.status(call()), {
      state: 'locked',
      evidence: 'reported',
    });
    assert.deepEqual(await port.readKeySlot(slot, call()), {
      kind: 'blocked',
      reason: 'locked',
    });
    assert.deepEqual(
      await port.writeKeySlot(slot, new Uint8Array([1]), {
        ...call(),
        mode: 'replace',
      }),
      { kind: 'blocked', reason: 'locked' },
    );
    assert.deepEqual(await port.deleteKeySlot(slot, call()), {
      kind: 'blocked',
      reason: 'locked',
    });
    assert.equal(native.diagnostics().unlockCalls, 0);
    assert.equal(native.diagnostics().promptCalls, 0);
    assert.equal(native.diagnostics().dismissCalls, 0);
  } else throw new Error('Unknown qualification mode.');
  // Diagnostics contain only counters, never material, identities or provider errors.
  assert.deepEqual(Object.keys(native.diagnostics()).sort(), [
    'apiCalls',
    'dismissCalls',
    'ownedBytes',
    'promptCalls',
    'unlockCalls',
  ]);
  process.stdout.write(
    JSON.stringify({
      passed: true,
      mode,
      contractCases,
      counters: native.diagnostics(),
    }),
  );
} catch (error) {
  const line =
    error instanceof Error
      ? error.stack?.match(/secret-service-child\.ts:(\d+):\d+/)?.[1]
      : undefined;
  process.stderr.write(
    `Qualification assertion location: ${line ?? 'unknown'}\n`,
  );
  if (error instanceof assert.AssertionError) {
    process.stderr.write(
      `${JSON.stringify({
        mode,
        assertion: error.operator,
        expected: diagnostic(error.expected),
        actual: diagnostic(error.actual),
      })}\n`,
    );
  }
  process.stderr.write(
    'Isolated native qualification failed; provider diagnostics withheld.\n',
  );
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = new Promise<void>((resolve) =>
      child.once('close', () => resolve()),
    );
    child.kill('SIGTERM');
    await closed;
  }
  rmSync(root, { recursive: true, force: true });
}
