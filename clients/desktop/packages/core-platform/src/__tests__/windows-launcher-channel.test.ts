import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer, connect } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  channelPeer,
  connectWindowsLauncherChannel,
  createOwnedChildServices,
  createPolledChannel,
  OWNED_CHILD_FILE,
  type OwnedChildLaunch,
  windowsChannelPeer,
} from '../supervision/owned-child';

// CAN-5843 W1, plan §6/§9: native custody only, never migration admission.
// host.launch / loaded.launch retain their ordinary execution behavior; W1
// exercises the sibling channel launch through the same native root custody.
// This platform golden is mandatory on Windows, including the second user.
const windows = process.platform === 'win32';
const suite = windows ? describe : describe.skip;
const root = path.resolve(__dirname, '../../../..');
const addon = process.env.CANOPY_OWNED_CHILD_ADDON
  ? path.resolve(root, process.env.CANOPY_OWNED_CHILD_ADDON)
  : path.join(
      root,
      '.cache/native-owned-child',
      `win32-${process.arch}`,
      OWNED_CHILD_FILE,
    );
const moduleUrl = pathToFileURL(
  path.resolve(__dirname, '../supervision/owned-child.ts'),
).href;
const run = promisify(execFile);
const launches = new Set<OwnedChildLaunch>();
const rawHandles = new Set<object>();
const diagnosticDirectories = new Set<string>();
const diagnostics = new WeakMap<
  OwnedChildLaunch['channel'],
  { path: string; child: OwnedChildLaunch['child'] }
>();
let native: object = {};
let probe: object = {};

async function loadProbe(): Promise<object> {
  let file = process.env.CANOPY_OWNED_CHILD_PROBE;
  if (!file) {
    if (process.env.CANOPY_OWNED_CHILD_ACCEPTANCE === '1')
      throw new Error(
        'Owned-child acceptance requires CANOPY_OWNED_CHILD_PROBE',
      );
    // Loaded addons stay mapped on Windows; keep local builds private to this run.
    const scratch = await mkdtemp(path.join(tmpdir(), 'w1-probe-'));
    file = path.join(scratch, 'owned-child-probe.node');
    await run(
      process.execPath,
      [
        path.join(root, 'scripts/build-owned-child.mjs'),
        '--out',
        path.join(scratch, OWNED_CHILD_FILE),
        '--probe-out',
        file,
      ],
      { cwd: root, windowsHide: true, timeout: 540_000, maxBuffer: 1 << 24 },
    );
  }
  const loaded = { exports: {} };
  process.dlopen(loaded, path.resolve(root, file));
  return loaded.exports;
}

function handleCount(): number {
  const method: unknown = Reflect.get(probe, 'handleCount');
  if (typeof method !== 'function')
    throw new Error('Native probe method absent: handleCount');
  const count: unknown = Reflect.apply(method, probe, []);
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0)
    throw new Error('Invalid native handle count');
  return count;
}

function call(name: string, ...args: unknown[]): unknown {
  const method: unknown = Reflect.get(native, name);
  if (typeof method !== 'function')
    throw new Error(`Native method absent: ${name}`);
  return Reflect.apply(method, native, args);
}

function object(value: unknown): object {
  if (typeof value !== 'object' || value === null)
    throw new Error('Missing native handle');
  return value;
}

function pipeName(nonce: string): string {
  return `\\\\.\\pipe\\canopy-migration-${process.pid}-${nonce}`;
}

const fixture = `
const fs = require('node:fs');
const diagnostic = process.env.W1_DIAGNOSTIC;
for (const stream of [process.stdout, process.stderr]) stream.write = (bytes) => {
  fs.appendFileSync(diagnostic, bytes);
  return true;
};
const { spawn } = require('node:child_process');
(async () => {
  setTimeout(() => process.exit(25), 20000).unref();
  const api = await import(${JSON.stringify(moduleUrl)});
  const input = process.env.W1_HEADER || fs.readFileSync(0, 'utf8');
  const end = input.indexOf('\\n') + 1;
  let header = input.slice(0, end);
  if (process.env.W1_MODE === 'delegate') {
    spawn(process.execPath, ['-e', ${JSON.stringify(`
(async () => {
  const api = await import(${JSON.stringify(moduleUrl)});
  const channel = api.connectWindowsLauncherChannel(process.env.W1_ADDON, process.env.W1_HEADER);
  await channel.write(Buffer.from('delegated'));
  setInterval(() => {}, 1000);
})().catch(() => process.exit(22));
`)}], { env: { ...process.env, W1_HEADER: header }, stdio: 'ignore', windowsHide: true });
    setInterval(() => {}, 1000);
    return;
  }
  if (process.env.W1_MODE === 'defer') {
    fs.writeFileSync(process.env.W1_GATE + '.ready', 'ready');
    while (!fs.existsSync(process.env.W1_GATE)) await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (process.env.W1_MODE === 'wrong-time') {
    header = header.replace(/ [0-9]+ ([0-9a-f]{32})\\n$/, ' 1 $1\\n');
  }
  const channel = api.connectWindowsLauncherChannel(process.env.W1_ADDON, header);
  if (process.env.W1_MODE === 'exit-frame') {
    await channel.write(Buffer.alloc(Number(input.slice(end)), 0x61));
    process.exit(0);
  }
  const peer = api.windowsChannelPeer(channel);
  await channel.write(Buffer.from(JSON.stringify({
    pid: peer.pid, ticks: String(peer.creationTime), input: input.slice(end)
  }) + '\\n'));
  if (process.env.W1_MODE === 'exit-frame-connected') {
    await channel.read(AbortSignal.timeout(10000));
    await channel.write(Buffer.alloc(Number(input.slice(end)), 0x61));
    process.exit(0);
  }
  if (process.env.W1_MODE === 'race') {
    const start = await channel.read(AbortSignal.timeout(10000));
    if (Buffer.from(start || []).toString() !== 'compete') throw new Error('No race barrier');
    const server = require('node:net').createServer();
    const bound = await new Promise((resolve, reject) => {
      server.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
      server.listen(process.env.W1_GATE, () => resolve(true));
    });
    if (!bound) process.exit(17);
  }
  if (process.env.W1_MODE === 'no-read') {
    while (!fs.existsSync(process.env.W1_GATE)) await new Promise(resolve => setTimeout(resolve, 10));
  }
  while (true) {
    const bytes = await channel.read(AbortSignal.timeout(15000));
    if (bytes === null) break;
    if (Buffer.from(bytes).toString() === 'exit') break;
    if (Buffer.from(bytes).toString() === 'disconnect') {
      await api.createOwnedChildServices({ os: 'win32', nativePath: process.env.W1_ADDON }).spawn({
        executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
        environment: { SystemRoot: process.env.SystemRoot }
      });
      channel.close();
      fs.writeFileSync(process.env.W1_GATE, 'closed-with-descendant');
      setInterval(() => {}, 1000);
      return;
    }
    await channel.write(bytes);
  }
  channel.close();
  if (process.env.W1_MODE === 'observe-loss' || process.env.W1_MODE === 'exit-on-loss') {
    fs.writeFileSync(process.env.W1_GATE, JSON.stringify(api.windowsChannelPeer(channel)));
    if (process.env.W1_MODE === 'observe-loss') setInterval(() => {}, 1000);
    else process.exit(0);
  }
})().catch((error) => { process.stderr.write(String(error.stack || error) + ' native=' + JSON.stringify(error.nativeDiagnostic)); process.exit(21); });
`;

async function launch(
  mode = '',
  stdin = '',
  gate = '',
): Promise<OwnedChildLaunch> {
  const services = createOwnedChildServices({ os: 'win32', nativePath: addon });
  const dir = await mkdtemp(path.join(tmpdir(), 'w1-diagnostic-'));
  diagnosticDirectories.add(dir);
  const diagnostic = path.join(dir, 'stdio.txt');
  await writeFile(diagnostic, '');
  const result = await services.spawnWithChannel({
    executable: process.execPath,
    args: ['-e', fixture],
    environment: {
      ...environment(),
      W1_MODE: mode,
      W1_ADDON: addon,
      W1_GATE: gate,
      W1_DIAGNOSTIC: diagnostic,
    },
    stdin,
  });
  launches.add(result);
  diagnostics.set(result.channel, { path: diagnostic, child: result.child });
  return result;
}

function environment(): Record<string, string> {
  const result: Record<string, string> = {};
  // Do not forward qualification credentials into ordinary fixture children.
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP']) {
    const value = process.env[key];
    if (
      value !== undefined &&
      !Object.keys(result).some(
        (name) => name.toLowerCase() === key.toLowerCase(),
      )
    )
      result[key] = value;
  }
  return result;
}

function rawSpawn(
  nonce: string,
  code = 'setInterval(() => {}, 1000)',
): {
  handle: object;
  channel: ReturnType<typeof createPolledChannel>;
} {
  const result = object(
    call(
      'spawnChannel',
      process.execPath,
      [process.execPath, '-e', code],
      // Node aborts at CSPRNG init on Windows without SystemRoot.
      Object.entries(environment()).map(([key, value]) => `${key}=${value}`),
      '',
      nonce,
    ),
  );
  const handle = object(Reflect.get(result, 'handle'));
  rawHandles.add(handle);
  return {
    handle,
    channel: createPolledChannel(
      {
        read: (max) => call('channelRead', handle, max),
        write: (bytes) => call('channelWrite', handle, bytes),
        close: () => call('channelClose', handle),
      },
      { closed: () => new Error('closed'), busy: () => new Error('busy') },
    ),
  };
}

async function readLine(channel: OwnedChildLaunch['channel']): Promise<string> {
  let text = '';
  while (!text.includes('\n')) {
    const bytes = await channel.read(AbortSignal.timeout(10000));
    if (bytes === null) {
      const diagnostic = diagnostics.get(channel);
      let exit: unknown = 'not observed';
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (diagnostic) {
        try {
          exit = await Promise.race([
            diagnostic.child.exited,
            new Promise<string>((resolve) => {
              timer = setTimeout(() => resolve('still live after 250ms'), 250);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      throw new Error(
        `Unexpected channel closure: exit=${JSON.stringify(exit)}; fixture stdout/stderr=${diagnostic ? await readFile(diagnostic.path, 'utf8') : 'not captured'}`,
      );
    }
    text += Buffer.from(bytes).toString('utf8');
  }
  return text;
}

async function awaitFile(file: string): Promise<string> {
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw error;
    }
    if (Date.now() > deadline)
      throw new Error('Fixture did not reach the file barrier');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function childReport(text: string): {
  pid: number;
  ticks: string;
  input: string;
} {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('pid' in parsed) ||
    typeof parsed.pid !== 'number' ||
    !('ticks' in parsed) ||
    typeof parsed.ticks !== 'string' ||
    !/^[0-9]+$/.test(parsed.ticks) ||
    !('input' in parsed) ||
    typeof parsed.input !== 'string'
  )
    throw new Error('Malformed child report');
  return { pid: parsed.pid, ticks: parsed.ticks, input: parsed.input };
}

suite('Windows private launcher channel (W1)', () => {
  beforeAll(async () => {
    const loaded = { exports: {} };
    process.dlopen(loaded, addon); // Missing/old addon fails qualification, never skips.
    native = loaded.exports;
    probe = await loadProbe();
  }, 600_000);

  afterEach(async () => {
    const errors: unknown[] = [];
    for (const item of launches) {
      item.channel.close();
      try {
        await item.child.terminate(AbortSignal.timeout(10000));
      } catch (error) {
        errors.push(error);
      }
    }
    launches.clear();
    for (const handle of rawHandles) {
      try {
        expect(call('rollbackSync', handle)).toBe(true);
      } catch (error) {
        errors.push(error);
      }
    }
    rawHandles.clear();
    for (const dir of diagnosticDirectories)
      await rm(dir, { recursive: true, force: true });
    diagnosticDirectories.clear();
    if (errors.length) throw new AggregateError(errors, 'W1 cleanup failed');
  });

  it.each(['', 'x'.repeat(4096), '🔐bounded bootstrap'])(
    'binds the actual child and launcher, with lossless creation times and bounded stdin (%#)',
    async (input) => {
      const { channel, child } = await launch('', input);
      const report = childReport(await readLine(channel));
      expect(report).toMatchObject({ pid: process.pid, input });
      expect(BigInt(report.ticks)).toBeGreaterThan(0xffffffffn);
      const peer = windowsChannelPeer(channel);
      expect(peer).toMatchObject({ state: 'connected', pid: child.pid });
      if (peer.state !== 'connected') throw new Error('No child custody');
      expect(peer.creationTime).toBeGreaterThan(0xffffffffn);
      // Windows custody must never become Darwin admission evidence.
      expect(() => channelPeer(channel)).toThrow();
      await channel.write(Buffer.from('duplex'));
      expect(
        Buffer.from(
          (await channel.read(AbortSignal.timeout(10000))) ?? [],
        ).toString(),
      ).toBe('duplex');
    },
  );

  it('refuses malformed, oversized and NUL stdin before launch', async () => {
    for (const input of ['x'.repeat(4097), '\0', '🔐'.repeat(1025)])
      await expect(launch('', input)).rejects.toMatchObject({
        code: 'invalid_argument',
      });
    for (const header of [
      '',
      'canopy-launcher-v1 1 1 ' + 'a'.repeat(32) + '\n',
      `canopy-launcher-v1 2 18446744073709551616 ${'a'.repeat(32)}\n`,
    ])
      expect(() => connectWindowsLauncherChannel(addon, header)).toThrow();
  });

  it('does not inherit the launcher server into the child', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'w1-inheritance-'));
    const gate = path.join(dir, 'connect');
    let item: OwnedChildLaunch | undefined;
    try {
      item = await launch('defer', '', gate);
      expect(await awaitFile(gate + '.ready')).toBe('ready');
      item.channel.close();
      await writeFile(gate, 'connect');
      // An inherited server would keep the pipe name alive and let the child connect.
      expect(await item.child.exited).toMatchObject({ code: 21 });
    } finally {
      await item?.child.terminate(AbortSignal.timeout(10000));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves bytes through bidirectional buffer pressure', async () => {
    const { channel } = await launch();
    await readLine(channel);
    const payload = randomBytes(2 * 1024 * 1024);
    const received: Buffer[] = [];
    const reading = (async (): Promise<void> => {
      let length = 0;
      while (length < payload.length) {
        const bytes = await channel.read(AbortSignal.timeout(10000));
        if (bytes === null) throw new Error('Channel retired under pressure');
        received.push(Buffer.from(bytes));
        length += bytes.length;
      }
    })();
    await Promise.all([
      channel.write(payload, AbortSignal.timeout(10000)),
      reading,
    ]);
    expect(Buffer.concat(received)).toEqual(payload);
  });

  it('retires a partially written channel on cancellation under backpressure', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'w1-pressure-'));
    diagnosticDirectories.add(dir);
    const gate = path.join(dir, 'read');
    const { channel, child } = await launch('no-read', '', gate);
    await readLine(channel);
    const controller = new AbortController();
    const reason = new Error('W1 pressure cancellation');
    const timer = setTimeout(() => controller.abort(reason), 100);
    try {
      await expect(
        channel.write(Buffer.alloc(2 * 1024 * 1024), controller.signal),
      ).rejects.toBe(reason);
      expect(windowsChannelPeer(channel)).toEqual({ state: 'refused' });
      // The receiver has not read: the write must have stalled at the native bound.
      expect(() => process.kill(child.pid, 0)).not.toThrow();
    } finally {
      clearTimeout(timer);
      await writeFile(gate, 'read');
    }
  });

  it.each(['observe-loss', 'disconnect'])(
    'retires on live %s without waiting for root exit',
    async (mode) => {
      const dir = await mkdtemp(path.join(tmpdir(), 'w1-disconnect-'));
      diagnosticDirectories.add(dir);
      const gate = path.join(dir, 'closed');
      const { channel, child } = await launch(mode, '', gate);
      await readLine(channel);
      if (mode === 'disconnect') {
        await channel.write(Buffer.from('disconnect'));
        expect(await channel.read(AbortSignal.timeout(10000))).toBeNull();
        expect(await awaitFile(gate)).toBe('closed-with-descendant');
      } else {
        channel.close();
        expect(JSON.parse(await awaitFile(gate))).toEqual({ state: 'refused' });
      }
      expect(() => process.kill(child.pid, 0)).not.toThrow();
      expect(windowsChannelPeer(channel)).toEqual({ state: 'refused' });
      await expect(channel.write(Buffer.from('stale'))).rejects.toThrow();
    },
  );

  it('retires the channel on launcher death without killing the committed child', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'w1-launcher-death-'));
    diagnosticDirectories.add(dir);
    const gate = path.join(dir, 'lost');
    const diagnostic = path.join(dir, 'stdio.txt');
    const host = `
(async () => {
  const api = await import(${JSON.stringify(moduleUrl)});
  const launched = await api.createOwnedChildServices({ os: 'win32', nativePath: process.env.W1_ADDON }).spawnWithChannel({
    executable: process.execPath, args: ['-e', ${JSON.stringify(fixture)}],
    environment: { ...process.env, W1_MODE: 'exit-on-loss' }, stdin: ''
  });
  await launched.channel.read(AbortSignal.timeout(10000));
  launched.child.commit();
  process.stdout.write('committed\\n');
  setInterval(() => {}, 1000);
})().catch(error => { process.stderr.write(String(error.stack || error)); process.exit(23); });`;
    const hosted = spawn(process.execPath, ['-e', host], {
      env: {
        ...environment(),
        W1_ADDON: addon,
        W1_GATE: gate,
        W1_DIAGNOSTIC: diagnostic,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const closed = new Promise<void>((resolve) =>
      hosted.once('close', () => resolve()),
    );
    let stderr = '';
    hosted.stderr.on('data', (bytes: Buffer) => {
      stderr += bytes.toString();
    });
    const timer = setTimeout(() => hosted.kill(), 15000);
    try {
      await new Promise<void>((resolve, reject) => {
        hosted.once('error', reject);
        hosted.once('exit', () =>
          reject(new Error('Launcher exited before commitment: ' + stderr)),
        );
        hosted.stdout.once('data', (bytes: Buffer) => {
          if (bytes.toString().includes('committed')) resolve();
          else reject(new Error('Unexpected launcher output'));
        });
      });
      hosted.kill();
      await closed;
      expect(JSON.parse(await awaitFile(gate))).toEqual({ state: 'refused' });
    } finally {
      clearTimeout(timer);
      hosted.kill();
      await closed;
    }
  }, 30000);

  it('refuses a launcher creation-time mismatch', async () => {
    const { child, channel } = await launch('wrong-time');
    expect(await child.exited).toMatchObject({ code: 21 });
    expect(windowsChannelPeer(channel)).toEqual({ state: 'refused' });
    expect(await channel.read()).toBeNull();
  });

  it('refuses a descendant using the locator instead of the owned root', async () => {
    const { child, channel } = await launch('delegate');
    expect(await channel.read(AbortSignal.timeout(10000))).toBeNull();
    expect(windowsChannelPeer(channel)).toEqual({ state: 'refused' });
    await child.terminate(AbortSignal.timeout(10000)); // includes the delegated descendant
  });

  it('retires channel custody on child exit', async () => {
    const { child, channel } = await launch();
    await readLine(channel);
    await channel.write(Buffer.from('exit'));
    expect(await child.exited).toMatchObject({ code: 0 });
    expect(windowsChannelPeer(channel)).toEqual({ state: 'refused' });
    expect(await channel.read()).toBeNull();
    channel.close();
    channel.close();
  });

  it.each([
    { mode: 'exit-frame', size: 0 },
    { mode: 'exit-frame', size: 1 },
    { mode: 'exit-frame', size: 65536 },
    { mode: 'exit-frame-connected', size: 65536 },
  ])(
    'drains $mode with $size buffered bytes before EOF',
    async ({ mode, size }) => {
      const { child, channel } = await launch(mode, String(size));
      if (mode === 'exit-frame-connected') {
        await readLine(channel);
        await channel.write(Buffer.from('finish'));
      }
      // Do not race a polled read against exit: all payload must still be queued.
      expect(await child.exited).toMatchObject({ code: 0 });
      expect(windowsChannelPeer(channel)).toEqual({ state: 'refused' });
      const received: Buffer[] = [];
      for (;;) {
        const bytes = await channel.read(AbortSignal.timeout(10000));
        if (bytes === null) break;
        received.push(Buffer.from(bytes));
      }
      expect(Buffer.concat(received)).toEqual(Buffer.alloc(size, 0x61));
      expect(await channel.read()).toBeNull();
      await expect(channel.write(Buffer.from('stale'))).rejects.toThrow();
    },
  );

  it('preserves byte order through partial native reads after child exit', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'w1-partial-eof-'));
    diagnosticDirectories.add(dir);
    const diagnostic = path.join(dir, 'stderr.txt');
    await writeFile(diagnostic, '');
    const { handle } = rawSpawn(
      randomBytes(16).toString('hex'),
      `
const fs = require('node:fs');
const diagnostic = ${JSON.stringify(diagnostic)};
process.on('uncaughtException', error => { fs.appendFileSync(diagnostic, String(error.stack || error)); process.exit(21); });
const loaded = { exports: {} };
process.dlopen(loaded, ${JSON.stringify(addon)});
const native = loaded.exports;
const fields = fs.readFileSync(0, 'utf8').trim().split(' ');
const client = native.connectLauncher(Number(fields[1]), BigInt(fields[2]), fields[3]);
const payload = Buffer.from(Array.from({ length: 65536 }, (_, i) => i % 251));
const written = native.channelWrite(client, payload);
if (written !== payload.length) process.exit(22);
process.exit(0);`,
    );
    const deadline = Date.now() + 10000;
    let status = call('observe', handle);
    while (Reflect.get(object(status), 'state') === 'running') {
      if (Date.now() > deadline) throw new Error('Child did not exit');
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      status = call('observe', handle);
    }
    if (Reflect.get(object(status), 'code') !== 0)
      throw new Error(
        `Raw writer exited: ${JSON.stringify(status)}\n${await readFile(diagnostic, 'utf8')}`,
      );
    expect(status).toMatchObject({ state: 'exited', code: 0 });
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < 256; i++) {
      expect(call('channelPeer', handle)).toEqual({ state: 'refused' });
      const bytes = call('channelRead', handle, 257);
      if (!(bytes instanceof Uint8Array)) throw new Error('Premature EOF');
      expect(bytes.length).toBe(i === 255 ? 1 : 257);
      chunks.push(bytes);
    }
    expect(Buffer.concat(chunks)).toEqual(
      Buffer.from(Array.from({ length: 65536 }, (_, i) => i % 251)),
    );
    expect(call('channelRead', handle, 257)).toBeNull();
    expect(call('channelRead', handle, 257)).toBeNull();
    expect(() => call('channelWrite', handle, Buffer.from('stale'))).toThrow();
  }, 15000);

  it.each([65536, 257])(
    'drains launcher bytes after server exit with native read bound %s',
    async (max) => {
      const dir = await mkdtemp(path.join(tmpdir(), 'w1-reverse-eof-'));
      diagnosticDirectories.add(dir);
      const gate = path.join(dir, 'drain');
      const report = path.join(dir, 'result');
      const receiver = `
const report = text => {
  const fs = require('node:fs');
  fs.writeFileSync(process.env.W1_REPORT + '.tmp', text);
  fs.renameSync(process.env.W1_REPORT + '.tmp', process.env.W1_REPORT);
};
(async () => {
  setTimeout(() => process.exit(26), 20000).unref();
  const fs = require('node:fs');
  const api = await import(${JSON.stringify(moduleUrl)});
  const header = fs.readFileSync(0, 'utf8');
  let channel, peer;
  if (${max} === 65536) {
    channel = api.connectWindowsLauncherChannel(process.env.W1_ADDON, header);
    peer = () => api.windowsChannelPeer(channel);
  } else {
    const loaded = { exports: {} };
    process.dlopen(loaded, process.env.W1_ADDON);
    const native = loaded.exports;
    const fields = header.trim().split(' ');
    const handle = native.connectLauncher(Number(fields[1]), BigInt(fields[2]), fields[3]);
    channel = api.createPolledChannel({
      read: () => native.channelRead(handle, ${max}),
      write: bytes => native.channelWrite(handle, bytes),
      close: () => native.channelClose(handle),
    }, { closed: () => new Error('closed'), busy: () => new Error('busy') });
    peer = () => native.channelPeer(handle);
  }
  await channel.write(Buffer.from('ready'));
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(process.env.W1_GATE)) {
    if (Date.now() > deadline) throw new Error('No launcher-exit barrier');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const chunks = [];
  for (;;) {
    if (peer().state !== 'refused') throw new Error('Dead launcher custody revived');
    const bytes = await channel.read(AbortSignal.timeout(10000));
    if (bytes === null) break;
    chunks.push(Buffer.from(bytes));
  }
  const expected = Buffer.from(Array.from({ length: 65536 }, (_, i) => i % 251));
  if (!Buffer.concat(chunks).equals(expected)) throw new Error('Lost launcher bytes');
  if (${max} === 257 && (chunks.length !== 256 || chunks.some((bytes, i) => bytes.length !== (i === 255 ? 1 : 257)))) throw new Error('Wrong partial reads');
  if (await channel.read() !== null) throw new Error('EOF not stable');
  channel.close();
  report('drained');
  process.exit(0);
})().catch(error => {
  report(String(error.stack || error));
  process.exit(21);
});`;
      const host = `
(async () => {
  const api = await import(${JSON.stringify(moduleUrl)});
  const launched = await api.createOwnedChildServices({ os: 'win32', nativePath: process.env.W1_ADDON }).spawnWithChannel({
    executable: process.execPath, args: ['-e', ${JSON.stringify(receiver)}], environment: process.env
  });
  const ready = await launched.channel.read(AbortSignal.timeout(10000));
  if (Buffer.from(ready || []).toString() !== 'ready') throw new Error('No receiver');
  launched.child.commit();
  await launched.channel.write(Buffer.from(Array.from({ length: 65536 }, (_, i) => i % 251)));
  process.exit(0);
})().catch(error => { process.stderr.write(String(error.stack || error)); process.exit(23); });`;
      try {
        await run(process.execPath, ['-e', host], {
          env: {
            ...environment(),
            W1_ADDON: addon,
            W1_GATE: gate,
            W1_REPORT: report,
          },
          windowsHide: true,
          timeout: 15000,
        });
        // Gate the first read on actual launcher exit, not a scheduling delay.
        await writeFile(gate, 'launcher exited');
        expect(await awaitFile(report)).toBe('drained');
      } finally {
        await writeFile(gate, 'cleanup');
      }
    },
    30000,
  );

  it('cleans the actual concurrent endpoint-bind loser without retiring the winner', async () => {
    const endpoint = pipeName(randomBytes(16).toString('hex'));
    const contenders = await Promise.all([
      launch('race', '', endpoint),
      launch('race', '', endpoint),
    ]);
    await Promise.all(contenders.map(({ channel }) => readLine(channel)));
    await Promise.all(
      contenders.map(({ channel }) => channel.write(Buffer.from('compete'))),
    );
    const loss = await Promise.race(
      contenders.map(async (item) => ({ item, exit: await item.child.exited })),
    );
    expect(loss.exit).toMatchObject({ code: 17 });
    const loser = loss.item;
    const winner = contenders.find((item) => item !== loser);
    if (!winner) throw new Error('No competing launch');
    await loser.child.terminate(AbortSignal.timeout(10000));
    expect(windowsChannelPeer(loser.channel)).toEqual({ state: 'refused' });
    expect(windowsChannelPeer(winner.channel)).toMatchObject({
      pid: winner.child.pid,
    });
    await winner.channel.write(Buffer.from('winner'));
    expect(
      Buffer.from(
        (await winner.channel.read(AbortSignal.timeout(10000))) ?? [],
      ).toString(),
    ).toBe('winner');
    // Cleanup of the loser must not close the winner's contested endpoint.
    const socket = connect(endpoint);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
    } finally {
      socket.destroy();
    }
  });

  it('rejects forged and foreign-load channel handles on both ends', async () => {
    const launched = await launch();
    const report = childReport(await readLine(launched.channel));
    const nonce = randomBytes(16).toString('hex');
    const server = rawSpawn(nonce);
    const client = object(
      call('connectLauncher', process.pid, BigInt(report.ticks), nonce),
    );
    const foreign = { exports: {} };
    process.dlopen(foreign, addon);
    const foreignPeer: unknown = Reflect.get(foreign.exports, 'channelPeer');
    if (typeof foreignPeer !== 'function')
      throw new Error('Missing foreign peer method');
    try {
      expect((): unknown =>
        Reflect.apply(foreignPeer, foreign.exports, [server.handle]),
      ).toThrow();
      expect((): unknown =>
        Reflect.apply(foreignPeer, foreign.exports, [client]),
      ).toThrow();
      expect(() => call('channelPeer', {})).toThrow();
      expect(call('channelPeer', client)).toMatchObject({
        state: 'connected',
        pid: process.pid,
      });
      // The host opened this client, not the owned child; the server must retire it.
      expect(await server.channel.read(AbortSignal.timeout(10000))).toBeNull();
    } finally {
      call('channelClose', client);
    }
  });

  it('releases retired client process custody while the wrappers remain reachable', async () => {
    const launched = await launch();
    const { ticks } = childReport(await readLine(launched.channel));
    const clients: object[] = [];
    try {
      handleCount(); // Warm the probe before measurement.
      const before = handleCount();
      for (let n = 0; n < 32; n++) {
        const nonce = randomBytes(16).toString('hex');
        const server = rawSpawn(nonce);
        const client = object(
          call('connectLauncher', process.pid, BigInt(ticks), nonce),
        );
        clients.push(client);
        server.channel.close();
        expect(call('channelRead', client, 1)).toBeNull();
        expect(call('channelPeer', client)).toEqual({ state: 'refused' });
        expect(call('rollbackSync', server.handle)).toBe(true);
        rawHandles.delete(server.handle);
      }
      // No GC: retired wrappers must not pin launcher process handles.
      expect(handleCount() - before).toBeLessThanOrEqual(4);
    } finally {
      for (const client of clients) call('channelClose', client);
    }
  }, 30000);

  it('refuses squatting and a second server instance without harming the first', async () => {
    const nonce = randomBytes(16).toString('hex');
    const squatter = createServer();
    await new Promise<void>((resolve, reject) => {
      squatter.once('error', reject);
      squatter.listen(pipeName(nonce), resolve);
    });
    try {
      expect(() => rawSpawn(nonce)).toThrow();
    } finally {
      await new Promise<void>((resolve, reject) =>
        squatter.close((error) => (error ? reject(error) : resolve())),
      );
    }
    const first = rawSpawn(nonce);
    expect(() => rawSpawn(nonce)).toThrow();
    expect(call('observe', first.handle)).toMatchObject({ state: 'running' });
    expect(() => call('channelRead', {}, 1)).toThrow();
    expect(() => call('channelRead', first.handle, 0)).toThrow();
    first.channel.close();
  });

  it('refuses the second user and remote UNC opens while the single instance is listening', async () => {
    const nonce = randomBytes(16).toString('hex');
    rawSpawn(nonce);
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!systemRoot) throw new Error('SystemRoot is required');
    async function probe(pipe: string): Promise<unknown> {
      const { stdout } = await run(
        path.join(
          systemRoot ?? '',
          'System32/WindowsPowerShell/v1.0/powershell.exe',
        ),
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(__dirname, 'fixtures/windows-pipe-prober.ps1'),
        ],
        {
          env: {
            ...process.env,
            CANOPY_PIPE_PROBE_PATH: pipe,
            CANOPY_PIPE_PROBE_MODE: 'once',
          },
          windowsHide: true,
          timeout: 45000,
        },
      );
      return JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? 'null');
    }
    const controlName = pipeName(randomBytes(16).toString('hex'));
    const control = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      control.once('error', reject);
      control.listen(controlName, resolve);
    });
    try {
      expect(await probe(controlName)).toMatchObject({
        impersonated: true,
        results: { read: 0 },
      });
      expect(await probe(pipeName(nonce))).toMatchObject({
        impersonated: true,
        results: { rw: 5, read: 5, createInstance: 5 },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        control.close((error) => (error ? reject(error) : resolve())),
      );
    }
    // The local redirector exercises PIPE_REJECT_REMOTE_CLIENTS, not the local namespace.
    const remote = pipeName(nonce).replace('\\\\.\\', '\\\\localhost\\');
    const result = await new Promise<string>((resolve) => {
      const socket = connect(remote);
      socket.once('connect', () => {
        socket.destroy();
        resolve('connected');
      });
      socket.once('error', () => resolve('refused'));
      socket.setTimeout(5000, () => {
        socket.destroy();
        resolve('timeout');
      });
    });
    expect(result).toBe('refused');
  }, 60000);
});
