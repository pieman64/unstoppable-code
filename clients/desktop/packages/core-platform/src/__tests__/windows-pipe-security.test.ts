import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  connectCanopyClient,
  type CanopyClientEndpoint,
} from '@canopy/core-client/node';
import {
  CANOPY_RUNTIME_QUERY_DEFINITIONS,
  createCanopyDispatcher,
  createCanopyRuntime,
  type CanopyDispatcher,
  type CanopyRuntime,
  type CanopyRuntimeQueries,
  type CanopyRuntimeStreams,
  type PlatformEndpointListener,
  type PlatformNamedPipeAddress,
  type PlatformPipeEndpointServices,
} from '@canopy/core-runtime';
import {
  acceptCanopyFramedConnections,
  publishCanopyDaemon,
  serveCanopyDaemonControlPlane,
} from '@canopy/core-runtime/node';
import {
  createCanopyFramedConnection,
  runCanopyTransportConformance,
  runCanopyLeaseConformance,
  runCanopyChannelConformance,
  type CanopyChannelConformanceInstance,
  type CanopyLeaseConformanceInstance,
  type CanopyConformancePairOptions,
  type CanopyFramedPair,
} from '@canopy/core-transport';
import type { CanopyFramedConnection } from '@canopy/core-transport/types';
import inventory from '../../../../scripts/lib/windows-pipe-inventory.json';
import { manualClock, echo, HOLD } from './fixtures/control-plane-conformance';
import { pipeConformanceRegistration } from './fixtures/pipe-conformance-registration';
import { createCanopyStartupClaimPort } from '@canopy/core-transport/node';
import {
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  defineCanopyInstructionRegistry,
} from '@canopy/protocol/canopy-core';
import {
  createPlatformEndpointServices,
  evaluatePipeDescriptor,
  loadWindowsPipeSecurity,
  type WindowsPipeSecurity,
} from '../endpoints';
import { createPlatformServices } from '../platform-services';
import {
  FixtureCleanup,
  type FixtureRelease,
  requireCompletedPhases,
} from './fixtures/pipe-test-cleanup';
import { createPublishedDaemonCleanup } from './fixtures/published-daemon-cleanup';
import { ownProber, type ProberExit } from './fixtures/prober-completion';

// Native Windows evidence for the pipe-security addon. Off Windows nothing
// runs. On Windows, missing prerequisites skip with a visible reason unless
// CANOPY_PIPE_SECURITY_ACCEPTANCE=1, where they fail: the acceptance job must
// never pass on skipped evidence. Credentials are never printed.

const windows = process.platform === 'win32';
const acceptance = process.env.CANOPY_PIPE_SECURITY_ACCEPTANCE === '1';
const ADDON =
  process.env.CANOPY_PIPE_SECURITY_ADDON ??
  path.resolve(
    __dirname,
    '../../native/windows-pipe/build/Release/windows_pipe_security.node',
  );
const PROBER = path.join(__dirname, 'fixtures', 'windows-pipe-prober.ps1');
const PROBE_USER = process.env.CANOPY_PIPE_PROBE_USER ?? '';
const PROBE_PASSWORD = process.env.CANOPY_PIPE_PROBE_PASSWORD ?? '';
// Empty counts as unset so an unresolved CI expression cannot redirect into the checkout.
const ownedFixtureRoot = process.env.CANOPY_PIPE_FIXTURE_ROOT || undefined;
const fixtureRoot = ownedFixtureRoot ?? tmpdir();
const evidencePath = process.env.CANOPY_PIPE_NATIVE_EVIDENCE;
// Opt-in CI cleanup rehearsal; adds one case that fails on purpose.
const rehearsal = acceptance ? process.env.CANOPY_PIPE_REHEARSAL : undefined;
const evidence: Record<string, unknown> = {
  ...(acceptance && windows
    ? {
        inventoryIdentity: createHash('sha256')
          .update(
            readFileSync(
              path.resolve(
                __dirname,
                '../../../../scripts/lib/windows-pipe-inventory.json',
              ),
            ),
          )
          .digest('hex'),
        sourceIdentity: createHash('sha256')
          .update(
            JSON.stringify(
              inventory.sourceFiles.map((file) => [
                file,
                createHash('sha256')
                  .update(
                    readFileSync(path.resolve(__dirname, '../../../..', file)),
                  )
                  .digest('hex'),
              ]),
            ),
          )
          .digest('hex'),
        addonIdentity: existsSync(ADDON)
          ? createHash('sha256').update(readFileSync(ADDON)).digest('hex')
          : undefined,
      }
    : {}),
  started: Date.now(),
  fixture: process.env.CANOPY_PIPE_FIXTURE_ID,
  sha: process.env.CANOPY_PIPE_CHECKOUT_SHA,
  runId: process.env.GITHUB_RUN_ID,
  attempt: process.env.GITHUB_RUN_ATTEMPT,
};
type CaseEntry = (typeof inventory.cases)[number];
let activeCase: CaseEntry | undefined;
let caseStarted = 0;
const caseResults: object[] = [];
const nativeRegistrations = new Set<string>();
function nativeIt(
  ancestor: string,
): (title: string, body: () => unknown, timeout?: number) => void {
  return (title, body, timeout): void => {
    const entry = inventory.cases.find(
      (item) =>
        item.title === title &&
        item.ancestorTitles.length === 1 &&
        item.ancestorTitles[0] === ancestor,
    );
    if (!entry || nativeRegistrations.has(entry.id))
      throw new Error('Unknown or duplicate native registration');
    nativeRegistrations.add(entry.id);
    it(
      title,
      async () => {
        activeCase = entry;
        caseStarted = Date.now();
        await body();
      },
      timeout,
    );
  };
}
let teardowns = 0;
let teardownFailures = 0;
let evidenceWriteFailed = false;
let evidenceFinalized = false;
function recordEvidence(key: string, value: unknown): void {
  if (!acceptance || !evidencePath) return;
  evidence[key] = value;
  try {
    writeFileSync(evidencePath, JSON.stringify(evidence));
  } catch (error) {
    evidenceWriteFailed = true;
    // Never leave a previously passing receipt after a failed invalidation.
    try {
      rmSync(evidencePath, { force: true });
    } finally {
      // Late reporters outlive Jest's hooks; a caught error must not pass the stage.
      if (evidenceFinalized) process.exit(1);
    }
    throw error;
  }
}
// Persist only fields produced by the credential-free native prober.
function recordProbe(key: string, raw: string): void {
  const report: unknown = JSON.parse(raw);
  if (!isRecord(report)) throw new Error('Malformed native evidence');
  const allowed = [
    'logonType',
    'impersonated',
    'results',
    'attempts',
    'successes',
    'codes',
  ];
  recordEvidence(
    key,
    Object.fromEntries(
      allowed
        .filter((field) => field in report)
        .map((field) => [field, report[field]]),
    ),
  );
}
const OWNER_PIPE_ACCESS = 0x0012019f;
const ERROR_ACCESS_DENIED = 5;
// Expected while the name is unbound, busy, or mid-teardown.
const BENIGN_LOOP_CODES = new Set(['5', '2', '231', '232', '233']);
const ATTEMPTS = [
  'rw',
  'read',
  'attributes',
  'readControl',
  'createInstance',
  'firstInstance',
] as const;

const addonMissing = existsSync(ADDON)
  ? null
  : `the addon is not built at ${ADDON} (run pnpm run build:windows-pipe-security or set CANOPY_PIPE_SECURITY_ADDON)`;
const credentialsMissing =
  PROBE_USER && PROBE_PASSWORD
    ? null
    : 'CANOPY_PIPE_PROBE_USER and CANOPY_PIPE_PROBE_PASSWORD are not set';

/** Runs, skips with a visible reason, or (under acceptance) fails on a missing prerequisite. */
function suite(title: string, missing: string | null, body: () => void): void {
  if (!windows) {
    describe.skip(
      `${title} (Windows-only native evidence; not run on ${process.platform})`,
      body,
    );
    return;
  }
  if (missing === null) {
    describe(title, body);
    return;
  }
  if (acceptance) {
    describe(title, () => {
      it('has its prerequisites under CANOPY_PIPE_SECURITY_ACCEPTANCE=1', () => {
        throw new Error(`Acceptance run, but ${missing}.`);
      });
    });
    return;
  }
  // Jest prints no titles for a fully skipped file, so state the reason.
  process.stdout.write(`${title}: skipped because ${missing}.\n`);
  describe.skip(`${title} (skipped: ${missing})`, body);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const uniquePipePath = (): string =>
  `\\\\.\\pipe\\canopy-pipe-test-${randomBytes(8).toString('hex')}`;
const uniqueAddress = (): PlatformNamedPipeAddress => ({
  kind: 'named-pipe',
  path: uniquePipePath(),
});

function redact(text: string): string {
  let out = text;
  for (const secret of [PROBE_PASSWORD, PROBE_USER])
    if (secret) out = out.split(secret).join('***');
  return out;
}

async function within<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${ms} ms: ${label}.`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(
  condition: () => boolean,
  ms: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${ms} ms waiting for ${label}.`);
    await delay(25);
  }
}

let cleanups = new FixtureCleanup();
beforeEach(() => {
  cleanups = new FixtureCleanup();
});
afterEach(async () => {
  const result = activeCase && {
    ...activeCase,
    started: caseStarted,
    finished: Date.now(),
    cleanup: 'unknown',
    failures: 0,
  };
  activeCase = undefined;
  if (result) caseResults.push(result);
  teardowns += 1;
  let reportedFailures = 0;
  const failures = await cleanups.close(15_000, (failures) => {
    teardownFailures += failures - reportedFailures;
    reportedFailures = failures;
    if (result) {
      result.finished = Date.now();
      result.cleanup = failures === 0 ? 'complete' : 'failed';
      result.failures = failures;
      recordEvidence('caseResults', caseResults);
    }
    recordEvidence('teardowns', teardowns);
    recordEvidence('teardownFailures', teardownFailures);
    recordEvidence('finished', Date.now());
  });
  if (failures)
    throw new Error(
      `Native teardown incomplete (${failures} releases); external fixture cleanup still required.`,
    );
}, 20_000);

afterAll(() => {
  evidenceFinalized = true;
  if (evidenceWriteFailed) throw new Error('Native evidence reporting failed.');
});

let native: WindowsPipeSecurity | undefined;
function addon(): WindowsPipeSecurity {
  native ??= loadWindowsPipeSecurity(ADDON);
  return native;
}

function pipes(
  options: Parameters<typeof createPlatformEndpointServices>[1] = {},
): PlatformPipeEndpointServices {
  const services = createPlatformEndpointServices('win32', {
    namedPipeSecurity: addon(),
    ...options,
  });
  if (services.semantics !== 'first-instance-pipe')
    throw new Error('Expected named pipes.');
  return services;
}

async function bindListener(
  port: PlatformPipeEndpointServices,
  address: PlatformNamedPipeAddress,
  scope: FixtureCleanup = cleanups,
): Promise<
  PlatformEndpointListener<PlatformNamedPipeAddress> & {
    release: FixtureRelease;
  }
> {
  const { value: listener, release } = await scope.acquire(
    async () => {
      // Back-to-back rebinds: the last handle of the previous instance may still
      // be closing on the client side when close() resolves.
      for (let attempt = 0; ; attempt += 1) {
        const result = await port.bind(address);
        if (result.kind === 'bound') {
          return result.listener;
        }
        if (attempt >= 20) throw new Error('Pipe name stayed in use.');
        await delay(25);
      }
    },
    async (listener) => {
      await listener.close();
      expect(await port.probe(address)).toEqual({ state: 'absent' });
    },
  );
  return { ...listener, release, close: () => release.release() };
}

interface TrackedClient {
  readonly socket: Socket;
  readonly closed: Promise<void>;
  isClosed(): boolean;
  close(): Promise<void>;
}

function client(
  pipePath: string,
  scope: FixtureCleanup = cleanups,
): TrackedClient {
  const socket = createConnection(pipePath);
  let done = false;
  socket.on('error', () => undefined);
  const closed = new Promise<void>((resolve) =>
    socket.once('close', () => {
      done = true;
      resolve();
    }),
  );
  const release = scope.own(() => {
    socket.destroy();
    return closed;
  });
  return {
    socket,
    closed,
    isClosed: () => done,
    close: () => release.release(),
  };
}

async function connected(tracked: TrackedClient): Promise<void> {
  await within(
    Promise.race([
      once(tracked.socket, 'connect'),
      tracked.closed.then(() => {
        throw new Error('Client closed before connecting.');
      }),
    ]),
    10_000,
    'client connect',
  );
}

async function connectAndDisconnect(pipePath: string): Promise<void> {
  const tracked = client(pipePath);
  await connected(tracked);
  await within(tracked.close(), 10_000, 'client close');
}

function listen(server: Server, pipePath: string): Promise<Error | null> {
  return new Promise((resolve) => {
    server.once('error', resolve);
    server.listen(pipePath, () => {
      server.off('error', resolve);
      resolve(null);
    });
  });
}

function defaultNodeServer(): Server {
  const server = createServer((socket) => socket.destroy());
  server.on('error', () => undefined);
  cleanups.own(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return server;
}

async function scratchDirectory(
  prefix: string,
): Promise<{ scratch: string; files: FixtureRelease }> {
  const { value: scratch, release: files } = await cleanups.acquire(
    () => mkdtemp(path.join(fixtureRoot, prefix)),
    (scratch) => rm(scratch, { recursive: true, force: true }),
  );
  return { scratch, files };
}

suite('Windows named-pipe security addon', addonMissing, () => {
  const it = nativeIt('Windows named-pipe security addon');
  it('current user: delivers an early client, exchanges bytes, bounds writes, and releases everything on close', async () => {
    const port = pipes();
    const address = uniqueAddress();
    expect(await port.probe(address)).toEqual({ state: 'absent' });
    const listener = await bindListener(port, address);
    // Connects before connections() is called; it must still be delivered.
    const early = client(address.path);
    await connected(early);
    const incoming = listener.connections()[Symbol.asyncIterator]();
    const accepted = await within(incoming.next(), 10_000, 'accept');
    if (accepted.done) throw new Error('No stream.');
    const stream = accepted.value;
    early.socket.write('ping');
    expect(
      Buffer.from(
        (await within(stream.read(), 10_000, 'read')) ?? [],
      ).toString(),
    ).toBe('ping');
    const reply = once(early.socket, 'data');
    await stream.write(Buffer.from('pong'));
    const bytes: unknown = (await within(reply, 10_000, 'reply'))[0];
    expect(
      bytes instanceof Uint8Array ? Buffer.from(bytes).toString() : null,
    ).toBe('pong');
    await expect(stream.write(new Uint8Array(65537))).rejects.toThrow('limit');
    const abort = new AbortController();
    const read = stream.read({ signal: abort.signal });
    abort.abort();
    await expect(read).rejects.toThrow('aborted');
    await within(listener.close(), 10_000, 'listener close');
    await within(early.closed, 10_000, 'client close');
    expect(stream.signal.aborted).toBe(true);
    expect(await stream.read()).toBeNull();
    expect((await incoming.next()).done).toBe(true);
    expect(await port.probe(address)).toEqual({ state: 'absent' });
  }, 60_000);

  it('cap and burst: keeps at most 32 of 40 unread clients, closes the excess, and releases all on close', async () => {
    const port = pipes();
    const address = uniqueAddress();
    const listener = await bindListener(port, address);
    const clients = Array.from({ length: 40 }, () => client(address.path));
    const closedCount = (): number =>
      clients.filter((tracked) => tracked.isClosed()).length;
    await waitFor(
      () => closedCount() >= 8,
      30_000,
      'the excess clients to close',
    );
    // Let any further (wrong) admissions or closes settle before counting.
    await delay(500);
    const kept = clients.length - closedCount();
    expect(kept).toBeLessThanOrEqual(32);
    const incoming = listener.connections()[Symbol.asyncIterator]();
    for (let drained = 0; drained < kept; drained += 1)
      expect((await within(incoming.next(), 10_000, 'drain')).done).toBe(false);
    await within(listener.close(), 15_000, 'listener close');
    await waitFor(
      () => closedCount() === clients.length,
      15_000,
      'every client to close',
    );
    expect((await incoming.next()).done).toBe(true);
    expect(await port.probe(address)).toEqual({ state: 'absent' });
  }, 90_000);

  it('descriptor: the live first instance is owned by and grants only the current user', () => {
    const security = addon();
    const pipePath = uniquePipePath();
    const server = security.createServer(pipePath);
    if (server === null || typeof server !== 'object')
      throw new Error('createServer returned no server.');
    try {
      const text = security.describe(server);
      expect(evaluatePipeDescriptor(text)).toBeNull();
      if (typeof text !== 'string') throw new Error('Receipt is not text.');
      const user = security.userSid();
      expect(typeof user).toBe('string');
      // Arrays in toMatchObject must match in length: exactly one ACE.
      expect(JSON.parse(text)).toMatchObject({
        user,
        owner: user,
        protected: true,
        aces: [{ type: 0, flags: 0, mask: OWNER_PIPE_ACCESS, sid: user }],
      });
      // The name is held: a second first instance is refused.
      expect(security.createServer(pipePath)).toBeNull();
    } finally {
      security.close(server);
    }
  });

  it('contention and squatting: a bound name refuses a second bind and a default net.Server, and a squatted name refuses our bind', async () => {
    const port = pipes();
    const address = uniqueAddress();
    await bindListener(port, address);
    expect(await port.bind(address)).toEqual({ kind: 'in-use' });
    const squatter = defaultNodeServer();
    // Node's errors come from another realm under Jest; assert presence, not class.
    expect(await listen(squatter, address.path)).not.toBeNull();
    expect(squatter.listening).toBe(false);

    const squatted = uniqueAddress();
    expect(await listen(defaultNodeServer(), squatted.path)).toBeNull();
    expect(await port.bind(squatted)).toEqual({ kind: 'in-use' });
  }, 30_000);

  it('handshake: a published daemon serves an authenticated client over the secured pipe and cleans up', async () => {
    const { scratch, files } = await scratchDirectory('pipe-sec-');
    const dataRoot = await realpath(scratch);
    const { scope, close } = createPublishedDaemonCleanup(
      cleanups,
      files,
      dataRoot,
    );
    const claims = createCanopyStartupClaimPort({
      dataRoot,
      owner: { pid: process.pid, startIdentity: 'test-start' },
      inspectProcess: () =>
        Promise.resolve({ kind: 'alive', startIdentity: 'test-start' }),
    });
    const endpoints = pipes({
      validateStartupClaim: (claim) => claims.verify(claim),
    });
    const { value: publication, release: publicationRelease } =
      await scope.acquire(
        () =>
          publishCanopyDaemon({
            dataRoot,
            runtimeMode: 'dev',
            platform: createPlatformServices('win32', endpoints),
            claims,
            pid: process.pid,
            startIdentity: 'test-start',
            buildVersion: 'test',
            protocolRange: { min: 1, max: 1 },
          }),
        (publication) => publication.close(),
        [files],
      );
    const { runtime, shutdown } = await startedKernel(scope, files);
    const plane = serveCanopyDaemonControlPlane({
      binding: publication,
      dispatcher: runtime.dispatcher,
      operations: runtime.operations,
      callerFor: ({ connectionId, lease }) => ({
        principalId: 'local-user',
        clientInstanceId: lease?.clientInstanceId ?? connectionId,
        authorityId: 'local',
        interfaceKind: lease?.interfaceKind ?? 'test',
        grants: ['core.runtime.read', 'core.client.manage'],
      }),
      buildVersion: 'test',
      onIdle: () => undefined,
    });
    const planeRelease = scope.own(() => plane.close());
    publicationRelease.dependsOn(planeRelease);
    shutdown.dependsOn(publicationRelease);

    const { descriptor } = publication;
    expect(descriptor.endpoint.kind).toBe('pipe');
    const address: PlatformNamedPipeAddress = {
      kind: 'named-pipe',
      path: descriptor.endpoint.path,
    };
    const token = await readFile(descriptor.tokenRef, 'utf8');
    // Built the way a client reads the descriptor: pipe path, token file, root hash.
    const endpoint = (secret: string): CanopyClientEndpoint => ({
      kind: 'pipe',
      path: descriptor.endpoint.path,
      auth: {
        secret,
        dataRootHash: createHash('sha256').update(dataRoot).digest('hex'),
      },
    });
    const clientOptions = {
      clientName: 'test',
      clientVersion: '0',
      timeoutMs: 10_000,
      definitions: {
        queries: CANOPY_RUNTIME_QUERY_DEFINITIONS,
        instructions: {},
        streams: {},
      },
    };

    const { value: connection, release: connectionRelease } =
      await scope.acquire(
        () =>
          connectCanopyClient({
            ...clientOptions,
            endpoint: endpoint(token),
          }),
        (connection) => connection.close(),
        [files],
      );
    const health = await within(
      connection.query('core.runtime.health.get', {}),
      10_000,
      'health query',
    );
    expect(health.runtime).toMatchObject({ state: 'ready' });
    await connectionRelease.release();
    await expect(
      connectCanopyClient({
        ...clientOptions,
        endpoint: endpoint('0'.repeat(64)),
      }),
    ).rejects.toMatchObject({
      payload: { kind: 'unauthenticated' },
    });

    await within(close(), 15_000, 'daemon close');
    expect(await endpoints.probe(address)).toEqual({ state: 'absent' });
  }, 60_000);
});

const INSTRUCTIONS = defineCanopyInstructionRegistry('core', {
  'core.events.ack': CORE_TRANSPORT_INSTRUCTION_DEFINITIONS['core.events.ack'],
});

type Kernel = CanopyRuntime<
  CanopyDispatcher<
    CanopyRuntimeQueries,
    typeof INSTRUCTIONS,
    CanopyRuntimeStreams
  >
>;

/** Minimal kernel, as in control-plane.test.ts: runtime queries plus one instruction. */
async function startedKernel(
  scope: FixtureCleanup,
  files?: FixtureRelease,
): Promise<{ runtime: Kernel; shutdown: FixtureRelease }> {
  const runtime = createCanopyRuntime({
    profile: 'core',
    identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
    definitions: { queries: {}, instructions: INSTRUCTIONS, streams: {} },
    owners: [{ name: 'core.events', operations: ['core.events.ack'] }],
    services: [],
    principalFor: () => 'interface',
    phaseDeadlineMs: 1_000,
    createDispatcher: (input) =>
      createCanopyDispatcher({
        profile: input.profile,
        definitions: input.definitions,
        handlers: {
          ...input.runtimeHandlers,
          instructions: {
            'core.events.ack': ({ cursor }) => ({ acknowledgedCursor: cursor }),
          },
        },
      }),
  });
  const started = runtime.start();
  const shutdown = scope.own(async () => {
    await started.catch(() => undefined);
    await requireCompletedPhases(runtime.shutdown('test'));
  });
  files?.dependsOn(shutdown);
  return scope.initialize(async () => {
    await started;
    return { runtime, shutdown };
  });
}

// ---- Second-user evidence -------------------------------------------------

interface Prober {
  readonly done: Promise<ProberExit>;
  exited(): boolean;
}

/** Inputs go through the environment only; output is redacted before use. */
function startProber(
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
  blocks: readonly FixtureRelease[] = [],
): Prober {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? '';
  if (!/^[A-Za-z]:\\/.test(systemRoot))
    throw new Error('SystemRoot is not absolute.');
  const child = spawn(
    path.win32.join(
      systemRoot,
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    ),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      PROBER,
      ...(ownedFixtureRoot
        ? [
            '-OwnershipPath',
            path.join(
              fixtureRoot,
              'probes',
              `${randomBytes(12).toString('hex')}.json`,
            ),
          ]
        : []),
    ],
    {
      env: {
        ...process.env,
        CANOPY_PIPE_PROBE_USER: PROBE_USER,
        CANOPY_PIPE_PROBE_PASSWORD: PROBE_PASSWORD,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  return ownProber(cleanups, child, timeoutMs, redact, blocks);
}

function proberReport(run: ProberExit): {
  readonly raw: string;
  readonly report: Record<string, unknown>;
} {
  const raw = run.stdout.split(/\r?\n/).filter(Boolean).pop() ?? '';
  let report: unknown;
  try {
    report = JSON.parse(raw);
  } catch {
    report = undefined;
  }
  if (run.code !== 0 || !isRecord(report))
    throw new Error(
      `Prober failed (exit ${String(run.code)}): ${raw || '(no output)'} ${run.stderr}`,
    );
  if (typeof report.impersonated !== 'boolean')
    throw new Error(`Prober report lacks impersonation status: ${raw}`);
  return { raw, report };
}

function codesOf(value: unknown, raw: string): Record<string, number> {
  if (!isRecord(value)) throw new Error(`Prober report is malformed: ${raw}`);
  const codes: Record<string, number> = {};
  for (const [name, code] of Object.entries(value)) {
    if (typeof code !== 'number')
      throw new Error(`Prober code ${name} is not a number: ${raw}`);
    codes[name] = code;
  }
  return codes;
}

async function probeOnce(pipePath: string): Promise<{
  readonly raw: string;
  readonly impersonated: unknown;
  readonly results: Record<string, number>;
}> {
  const prober = startProber(
    { CANOPY_PIPE_PROBE_PATH: pipePath, CANOPY_PIPE_PROBE_MODE: 'once' },
    45_000,
  );
  const { raw, report } = proberReport(await prober.done);
  const results = codesOf(report.results, raw);
  for (const name of ATTEMPTS)
    if (!(name in results))
      throw new Error(`Prober report lacks ${name}: ${raw}`);
  return { raw, impersonated: report.impersonated, results };
}

let controlPassed = false;
const requireControl = (): void => {
  if (!controlPassed)
    throw new Error(
      'The positive control did not pass, so this case is not evidence.',
    );
};

suite(
  'Windows named-pipe security across users',
  addonMissing ?? credentialsMissing,
  () => {
    const it = nativeIt('Windows named-pipe security across users');
    it('positive control: the second user can read a default-DACL net.Server pipe (impersonation works and the prober sees permissive DACLs)', async () => {
      const pipePath = uniquePipePath();
      expect(await listen(defaultNodeServer(), pipePath)).toBeNull();
      const { raw, impersonated, results } = await probeOnce(pipePath);
      process.stdout.write(`windows-pipe-security positive control: ${raw}\n`);
      recordProbe('control', raw);
      if (impersonated !== true || results.read !== 0)
        throw new Error(
          `Positive control failed: expected impersonated=true and read=0 on Node's default pipe DACL (Everyone read), got ${raw}. The prober cannot detect a permissive DACL here, so the cross-user cases are not evidence.`,
        );
      controlPassed = true;
    }, 60_000);

    it('secured pipe: the second user cannot open, query, or add instances', async () => {
      requireControl();
      const address = uniqueAddress();
      await bindListener(pipes(), address);
      const { raw, impersonated, results } = await probeOnce(address.path);
      process.stdout.write(`windows-pipe-security secured pipe: ${raw}\n`);
      recordProbe('denial', raw);
      expect(impersonated).toBe(true);
      expect(results).toMatchObject({
        rw: ERROR_ACCESS_DENIED,
        read: ERROR_ACCESS_DENIED,
        createInstance: ERROR_ACCESS_DENIED,
      });
      // Pairs name each attempt in a failure; 0 would mean it succeeded.
      for (const name of ATTEMPTS)
        expect([name, results[name]]).not.toEqual([name, 0]);
    }, 60_000);

    // The positive control shows a default-DACL pipe is readable by the second
    // user, so a loop hammering opens would observe any instant where one of
    // our instances (first or later) existed with a default descriptor. Zero
    // successes across 15 create/close cycles and 32 new instances is evidence
    // that the owner-only descriptor applies from creation, with no window.
    it('churn: a second user hammering opens never gets in across rebinds and new instances', async () => {
      requireControl();
      const { scratch, files } = await scratchDirectory('pipe-churn-');
      const readyFile = path.join(scratch, 'prober-ready');
      const address = uniqueAddress();
      const prober = startProber(
        {
          CANOPY_PIPE_PROBE_PATH: address.path,
          CANOPY_PIPE_PROBE_MODE: 'loop',
          CANOPY_PIPE_PROBE_DURATION_MS: '15000',
          CANOPY_PIPE_PROBE_READY_FILE: readyFile,
        },
        60_000,
        [files],
      );
      await waitFor(
        () => existsSync(readyFile) || prober.exited(),
        45_000,
        'the prober loop to start',
      );
      if (!existsSync(readyFile)) {
        const run = await prober.done;
        throw new Error(
          `Prober exited before its loop (exit ${String(run.code)}): ${run.stdout} ${run.stderr}`,
        );
      }

      const port = pipes();
      for (let cycle = 0; cycle < 15; cycle += 1) {
        const listener = await bindListener(port, address);
        for (let i = 0; i < 5; i += 1) await connectAndDisconnect(address.path);
        await within(listener.close(), 10_000, 'cycle close');
      }
      const listener = await bindListener(port, address);
      await Promise.all(
        Array.from({ length: 32 }, () => connectAndDisconnect(address.path)),
      );
      const churnInsideLoop = !prober.exited();
      const run = await within(prober.done, 30_000, 'the prober loop to end');
      await within(listener.close(), 10_000, 'listener close');

      const { raw, report } = proberReport(run);
      process.stdout.write(`windows-pipe-security churn: ${raw}\n`);
      recordProbe('churn', raw);
      recordEvidence('churnInsideLoop', churnInsideLoop);
      const { attempts, successes } = report;
      if (typeof attempts !== 'number' || typeof successes !== 'number')
        throw new Error(`Prober loop report is malformed: ${raw}`);
      const codes = codesOf(report.codes, raw);
      const unexpected = Object.keys(codes).filter(
        (code) => !BENIGN_LOOP_CODES.has(code),
      );
      // The security assertion comes first so no other check can mask it.
      if (successes !== 0)
        throw new Error(
          `The second user opened the pipe ${successes} time(s); unexpected codes: ${unexpected.join(', ') || 'none'}. ${raw}`,
        );
      expect(report.impersonated).toBe(true);
      if (!churnInsideLoop)
        throw new Error(
          `The prober loop ended before the churn finished, so the run is not evidence: ${raw}`,
        );
      expect(attempts).toBeGreaterThan(0);
      if (!((codes['5'] ?? 0) > 0))
        throw new Error(
          `No access-denied result: the loop never met a live instance. Unexpected codes: ${unexpected.join(', ') || 'none'}. ${raw}`,
        );
      if (unexpected.length > 0)
        process.stdout.write(
          `windows-pipe-security churn: unexpected codes ${unexpected.join(', ')}\n`,
        );
    }, 120_000);
  },
);

// Source-fixture Lane J: the shared kits use the production platform-stream
// adapter, not a second handshake implementation or the packaged daemon host.
const AUTH = { secret: 'secured-pipe-fixture', dataRootHash: '0'.repeat(64) };
async function framedClient(
  scope: FixtureCleanup,
  pipePath: string,
  options: CanopyConformancePairOptions = {},
): Promise<Pick<CanopyFramedPair, 'client' | 'clientWire'>> {
  return scope.initialize(async () => {
    const tracked = client(pipePath, scope);
    const { value: connection } = await scope.acquire(
      () =>
        createCanopyFramedConnection(tracked.socket, {
          role: 'client',
          auth: {
            secret: options.clientSecret ?? AUTH.secret,
            dataRootHash: options.clientDataRootHash ?? AUTH.dataRootHash,
          },
          maxFrameBytes: options.maxFrameBytes,
          maxBufferedMessages: options.maxBufferedMessages,
          handshakeTimeoutMs: 2_000,
        }),
      async (connection) => {
        connection.close();
        await tracked.close();
      },
    );
    return { client: connection, clientWire: tracked.socket };
  });
}

async function pipePair(
  options: CanopyConformancePairOptions = {},
): Promise<CanopyFramedPair> {
  const scope = cleanups.fork();
  return scope.initialize(async () => {
    const listener = await bindListener(pipes(), uniqueAddress(), scope);
    const server = Promise.withResolvers<CanopyFramedConnection>();
    const acceptor = acceptCanopyFramedConnections({
      listener,
      auth: AUTH,
      connection: {
        maxFrameBytes: options.maxFrameBytes,
        maxBufferedMessages: options.maxBufferedMessages,
        handshakeTimeoutMs: 2_000,
      },
      onConnection: (connection) => {
        scope.own(() => {
          connection.close();
          return Promise.resolve();
        });
        server.resolve(connection);
      },
    });
    scope.own(async () => {
      await listener.close();
      await acceptor.done;
    });
    // Authentication failures reject here, not at the authenticated-only callback.
    const opened = await framedClient(scope, listener.address.path, options);
    return { ...opened, server: await server.promise };
  });
}

async function pipeControlPlane(): Promise<CanopyChannelConformanceInstance> {
  const scope = cleanups.fork();
  return scope.initialize(async () => {
    const listener = await bindListener(pipes(), uniqueAddress(), scope);
    const { runtime, shutdown } = await startedKernel(scope);
    const clock = manualClock();
    const consumers: Promise<void>[] = [];
    const plane = serveCanopyDaemonControlPlane({
      binding: { listener, auth: AUTH },
      dispatcher: runtime.dispatcher,
      operations: runtime.operations,
      callerFor: ({ connectionId, lease }) => ({
        principalId: 'local-user',
        clientInstanceId: lease?.clientInstanceId ?? connectionId,
        authorityId: 'local',
        interfaceKind: lease?.interfaceKind ?? 'test',
        grants: ['core.runtime.read', 'core.client.manage'],
      }),
      buildVersion: 'test',
      clock,
      leases: { reconnectGraceMs: 10_000 },
      channels: {
        kinds: {
          'conformance.echo': {
            accept: (channel) => {
              consumers.push(echo(channel));
            },
          },
          'conformance.hold': HOLD,
        },
      },
      connection: { maxChannelBufferedChunks: 4 },
      onIdle: () => undefined,
    });
    const planeRelease = scope.own(async () => {
      await plane.close();
      await Promise.all(consumers);
    });
    listener.release.dependsOn(planeRelease);
    shutdown.dependsOn(listener.release);
    return {
      connect: () => framedClient(scope, listener.address.path),
      now: () => clock.now(),
      advance: (ms: number) => clock.advance(ms),
      reconnectGraceMs: 10_000,
      whenDetached: (leaseId: string): Promise<void> =>
        new Promise((resolve) => {
          const check = (): void => {
            if (plane.leases.holder(leaseId) !== null) return;
            off();
            resolve();
          };
          const off = plane.leases.onChange(check);
          check();
        }),
      close: async (): Promise<void> => {
        if (await scope.close())
          throw new Error('Pipe target teardown incomplete');
      },
    };
  });
}

// Registration is checked even off Windows; missing prerequisites cannot turn
// a required case into a passing placeholder in an acceptance run.
const registration = pipeConformanceRegistration(
  (title, body) => suite(title, addonMissing, body),
  (title, body) => {
    const entry = inventory.cases.find(
      (item) => item.title === title && item.layer !== 'native',
    );
    if (!entry) throw new Error('Unknown secured-pipe case');
    it(
      title,
      async () => {
        activeCase = entry;
        caseStarted = Date.now();
        await body();
      },
      90_000,
    );
  },
);
runCanopyTransportConformance({
  name: 'secured-pipe',
  createPair: pipePair,
  ...registration,
});
runCanopyLeaseConformance({
  name: 'secured-pipe',
  ...registration,
  target: {
    name: 'control plane',
    start: async (): Promise<CanopyLeaseConformanceInstance> => {
      const instance = await pipeControlPlane();
      return {
        ...instance,
        connect: async () => (await instance.connect()).client,
      };
    },
  },
});
runCanopyChannelConformance({
  name: 'secured-pipe',
  ...registration,
  target: {
    name: 'control plane',
    echoKind: 'conformance.echo',
    holdKind: 'conformance.hold',
    start: pipeControlPlane,
  },
});
registration.complete();

// Rehearsals are deliberately registered after the complete normal inventory.
if (rehearsal === 'test-failure' || rehearsal === 'cancellation')
  suite(
    'Windows named-pipe cleanup rehearsal',
    addonMissing ?? credentialsMissing,
    () => {
      // Fails, or holds up to 8 minutes for a GitHub cancellation, while a
      // second-user prober runs, so the job's fixture cleanup meets live state.
      if (rehearsal === 'test-failure' || rehearsal === 'cancellation')
        it(`rehearsal: ${rehearsal} while a second-user prober runs`, async () => {
          requireControl();
          const holdMs = rehearsal === 'cancellation' ? 8 * 60_000 : 15_000;
          const { scratch, files } = await scratchDirectory('pipe-rehearsal-');
          const readyFile = path.join(scratch, 'prober-ready');
          const prober = startProber(
            {
              CANOPY_PIPE_PROBE_PATH: uniquePipePath(),
              CANOPY_PIPE_PROBE_MODE: 'loop',
              CANOPY_PIPE_PROBE_DURATION_MS: String(holdMs),
              CANOPY_PIPE_PROBE_READY_FILE: readyFile,
            },
            holdMs + 60_000,
            [files],
          );
          await waitFor(
            () => existsSync(readyFile) || prober.exited(),
            45_000,
            'the rehearsal prober loop to start',
          );
          if (!existsSync(readyFile))
            throw new Error('The rehearsal prober exited before its loop.');
          if (rehearsal === 'test-failure') {
            recordEvidence('rehearsalFault', Date.now());
            throw new Error(
              'Rehearsal: injected failure with the prober running.',
            );
          }
          recordEvidence('rehearsalHold', Date.now());
          process.stdout.write(
            'windows-pipe-security rehearsal: holding for cancellation\n',
          );
          try {
            await within(prober.done, holdMs + 30_000, 'the cancellation hold');
          } finally {
            recordEvidence('rehearsalHoldEnded', Date.now());
          }
          throw new Error('Rehearsal: the hold ended without a cancellation.');
        }, 600_000);
    },
  );
