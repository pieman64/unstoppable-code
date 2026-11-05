// Exploratory only. Run serially with node --import tsx; --counts defaults to 8.
// The 512,1024,3072 sweep is root-only. No providers or observers start.
// Each form owns a fresh private directory; stdout is JSON, stderr is progress.
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { cpus, loadavg, release, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const SHARED = '../../../../packages/desktop-shared/src/node/delegation/';
const SCOPE = {
  projectId: 'lifetime-project',
  worktreeId: 'lifetime-worktree',
};
const digest = (value) => createHash('sha256').update(value).digest('hex');

export function parseArguments(args) {
  const options = { counts: [8], output: undefined };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    seen.add(flag);
    if (!value || value.startsWith('--'))
      throw new Error(`Missing value for ${flag}`);
    if (flag === '--counts') {
      if (!/^\d+(,\d+)*$/.test(value)) throw new Error('Invalid counts');
      options.counts = value.split(',').map(Number);
      validateCounts(options.counts);
    } else if (flag === '--output') options.output = resolve(value);
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return options;
}

function validateCounts(counts) {
  if (
    !Array.isArray(counts) ||
    counts.length < 1 ||
    new Set(counts).size !== counts.length ||
    counts.some(
      (count) =>
        !Number.isSafeInteger(count) ||
        count < 1 ||
        (count > 64 && ![512, 1024, 3072].includes(count)),
    )
  )
    throw new Error(
      'Invalid counts: use 1–64 for gates or 512,1024,3072 for the root sweep',
    );
}

export function summarizeBytes(sizes) {
  const sorted = [...sizes].sort((a, b) => a - b);
  return {
    count: sorted.length,
    totalBytes: sorted.reduce((sum, size) => sum + size, 0),
    minBytes: sorted[0],
    medianBytes: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Bytes: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxBytes: sorted.at(-1),
  };
}

export function createManifest(count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 3072)
    throw new Error('Manifest count must be between 1 and 3072');
  // Per 32: 16 small, 8 ordinary, 4 medium, 3 large and 1 very large.
  // Spread the tail into the eight-record gate too; never real user content.
  const kib = [
    2, 8, 32, 2, 128, 8, 2, 512, 2, 8, 32, 2, 128, 8, 2, 2, 2, 8, 32, 2, 128, 8,
    2, 2, 2, 8, 32, 2, 8, 2, 2, 2,
  ];
  const records = Array.from({ length: count }, (_, index) => ({
    index,
    delegationId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    bodyBytes: kib[index % kib.length] * 1024,
    chatId: `chat-${index % 4}`,
  }));
  return {
    version: 1,
    distribution: 'Synthetic content-free ASCII; not a field-content capture',
    records,
    bodies: summarizeBytes(records.map((record) => record.bodyBytes)),
  };
}

function route() {
  return {
    selectedModelId: 'lifetime-scripted',
    runtimeModelId: 'scripted',
    harnessId: 'lifetime-scripted',
    runtimeKind: 'local-sdk',
    runnerRegistrationId: 'lifetime-scripted',
    runtimeVersion: '1',
    adapterVersion: '1',
    modelSource: 'test',
    providerType: 'test-inference',
    assignmentRevision: '1',
    billingAuthority: 'native',
    aiCreditsRouted: false,
    capabilities: ['read', 'progress', 'resume'],
    supportedThinkingLevels: ['low'],
    capabilitySnapshotHash: 'lifetime-fixture',
    capabilityGeneration: 1,
    policyRevision: '1',
    authAccountKey: 'synthetic-not-an-account',
  };
}

export function legacyRecord(entry) {
  const { index, delegationId, chatId, bodyBytes } = entry;
  return {
    version: 1,
    parent: {
      harnessId: 'claude',
      projectId: 'lifetime-project',
      worktreeId: 'lifetime-worktree',
      chatId,
      sessionKey: `lifetime-project/lifetime-worktree/${chatId}`,
      turnId: 'synthetic-turn',
      toolCallId: `synthetic-call-${index}`,
      runtimeGeneration: 1,
      depth: 0,
    },
    task: {
      modelId: 'lifetime-scripted',
      description: 'Synthetic retained delegation',
      prompt: 'Content-free load fixture.',
      executionMode: 'background',
      contextPolicy: 'task_only',
      isolation: 'shared_worktree',
    },
    route: route(),
    callKey: digest(`call-${index}`),
    requestHash: digest(`request-${index}`),
    createdAt: index + 1,
    state: {
      delegationId,
      runGeneration: 1,
      sequence: 2,
      status: 'completed',
      outputTruncated: false,
      finishedAt: index + 2,
      nativeSessionId: `synthetic-${index}`,
      transcript: [
        {
          id: `text-${index}`,
          sequence: 1,
          occurredAt: index + 1,
          type: 'text',
          text: 'x'.repeat(bodyBytes),
        },
        {
          id: `tool-${index}`,
          sequence: 2,
          occurredAt: index + 2,
          type: 'tool',
          toolName: 'synthetic_read',
          input: '{}',
          output: 'synthetic reference: fixture.txt',
        },
      ],
    },
    launch: {
      version: 1,
      delegationId,
      runGeneration: 1,
      launchKey: digest(`call-${index}`),
      phase: 'settled',
      terminalStatus: 'completed',
      nativeSessionId: `synthetic-${index}`,
    },
    delivery: { status: 'suppressed', reason: 'automatic_delivery_removed' },
  };
}

async function load(specifier) {
  const module = await import(specifier);
  return module.default ?? module;
}

export function verifyDecoded(records, manifest) {
  if (records.length !== manifest.records.length)
    throw new Error(
      `Decoded count mismatch: expected ${manifest.records.length}, got ${records.length}`,
    );
  const byId = new Map(
    records.map((record) => [record.state.delegationId, record]),
  );
  if (byId.size !== records.length)
    throw new Error('Duplicate decoded identity');
  for (const entry of manifest.records) {
    const actual = byId.get(entry.delegationId);
    if (!actual)
      throw new Error(`Missing decoded identity: ${entry.delegationId}`);
    if (!isDeepStrictEqual(actual, legacyRecord(entry)))
      throw new Error(`Decoded bytes mismatch: ${entry.delegationId}`);
  }
}

async function seedLegacy(
  directory,
  manifest,
  FileDelegationStorage,
  progress,
) {
  const storage = new FileDelegationStorage(directory);
  const sizes = [];
  for (const entry of manifest.records) {
    await storage.commit(legacyRecord(entry));
    const bytes = await readFile(join(directory, `${entry.delegationId}.json`));
    const expected = legacyRecord(entry);
    if (
      bytes.byteLength !== Buffer.byteLength(JSON.stringify(expected)) ||
      !isDeepStrictEqual(JSON.parse(bytes.toString('utf8')), expected)
    )
      throw new Error(`Disk bytes mismatch: ${entry.delegationId}`);
    sizes.push(bytes.byteLength);
    if ((entry.index + 1) % 64 === 0)
      progress(`legacy seed ${entry.index + 1}/${manifest.records.length}`);
  }
  const decoded = await storage.load();
  verifyDecoded(decoded, manifest);
  if ((await readdir(directory)).length !== manifest.records.length)
    throw new Error('Unexpected fixture directory entries');
  return {
    bodies: manifest.bodies,
    records: summarizeBytes(sizes),
    manifestHash: digest(JSON.stringify(manifest)),
    manifest,
    verified: {
      decodedCount: decoded.length,
      diskBytes: sizes.reduce((a, b) => a + b, 0),
      exactDecodedAndDiskBytes: true,
    },
  };
}

export async function probeHostPaths() {
  const paths = {
    recovery: '../../src/main/agents/delegation/recovery.ts',
    treeAndRoots: '../../src/main/agents/delegation/service.ts',
    appAdvisorWatcher: '../../src/main/app-advisor/watchers.ts',
    streamV3Service: '../../src/main/services/chat-state-service.ts',
    streamV3Repository: '../../src/main/services/chat-state-v2-repository.ts',
    streamV3Port:
      '../../src/main/agents/delegation/repository-transcript-port.ts',
  };
  const probes = {};
  for (const [name, entrypoint] of Object.entries(paths)) {
    try {
      await load(entrypoint);
      probes[name] = { status: 'loadable', entrypoint };
    } catch (error) {
      probes[name] = {
        status: 'unavailable',
        entrypoint,
        blockingDependency: {
          name: error.name,
          code: error.code ?? null,
          message: error.message,
          stack: error.stack,
        },
      };
    }
  }
  return probes;
}

export function createReport() {
  return {
    schemaVersion: 1,
    labels: {
      evidence: 'exploratory',
      runtime: 'plain Node under tsx',
      memory: 'process.memoryUsage() bytes; not Electron main-process memory',
      c37: 'not a C37 verdict',
      cap: 'unchanged; this script never changes the cap',
    },
    host: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      osRelease: release(),
      cpuModel: cpus()[0]?.model,
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
      loadAverage1_5_15: loadavg(),
    },
    limitations: [
      'Single serial sample per count; same-process, warm filesystem after seeding/verification.',
      'No forced GC, tight sampler, peak claim, native descendants, Electron, responsiveness or matched baseline.',
      'Settled records only; not interrupted-record recovery or a release-acceptance run.',
      'Four synthetic root chats; tree display bound is 1000 per chat and roots display bound is 1000 chats. These counts do not reach either display bound.',
      'Fixed synthetic body-size schedule, not an empirically calibrated field distribution. V3 broker UUIDs and timestamps are generated; forms are not byte-identical.',
      'afterClose means broker closed; v3 afterRepositoryClose is sampled after the backing service drains. Neither milestone forces garbage collection.',
    ],
    samples: [],
  };
}

async function measure(call) {
  const before = {
    memoryBytes: process.memoryUsage(),
    loadAverage1_5_15: loadavg(),
  };
  const start = performance.now();
  const result = await call();
  const wallMs = performance.now() - start;
  return {
    result,
    metrics: {
      wallMs,
      before,
      after: {
        memoryBytes: process.memoryUsage(),
        loadAverage1_5_15: loadavg(),
      },
    },
  };
}

function retainedTabs() {
  return {
    version: 1,
    activeTabId: 'chat-0',
    tabs: Array.from({ length: 4 }, (_, index) => ({
      id: `chat-${index}`,
      title: `Synthetic ${index}`,
      createdAt: '2026-10-01T00:00:00.000Z',
      messages: [
        {
          id: 'synthetic-turn',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'Synthetic fixture' }],
        },
      ],
    })),
  };
}

function blocked(error, entrypoint) {
  return {
    status: 'unavailable',
    entrypoint,
    blockingDependency: {
      name: error.name,
      code: error.code ?? null,
      message: error.message,
      stack: error.stack,
    },
  };
}

async function measuredReader(entrypoint, call) {
  try {
    const { result, metrics } = await measure(call);
    return {
      status: 'measured',
      entrypoint,
      returnedCount: result.length,
      ...metrics,
    };
  } catch (error) {
    return blocked(error, entrypoint);
  }
}

async function measureHostReaders(count, options = {}) {
  const readers = {};
  const recovery = await load('../../src/main/agents/delegation/recovery.ts');
  readers.recovery = await measuredReader(
    'loadDelegationRecoveryMutations',
    () =>
      recovery.loadDelegationRecoveryMutations(
        SCOPE,
        retainedTabs(),
        { version: 1, archived: [] },
        options,
      ),
  );
  const service = await load('../../src/main/agents/delegation/service.ts');
  // Fresh scope directory plus explicit production configuration invalidation:
  // first roots read is a cache miss; second read deliberately hits its cache.
  const restore = service.configureManagedDelegationReaders(options);
  try {
    readers.tree = await measuredReader(
      'readManagedDelegationTreeForUser',
      () =>
        service.readManagedDelegationTreeForUser({
          ...SCOPE,
          chatId: 'chat-0',
        }),
    );
    readers.tree.expectedSelectedRecords = Math.min(1000, Math.ceil(count / 4));
    readers.tree.totalDecodedRecords = count;
    readers.rootsCold = await measuredReader(
      'readManagedDelegationRootsForUser',
      () => service.readManagedDelegationRootsForUser(SCOPE),
    );
    readers.rootsCached = await measuredReader(
      'readManagedDelegationRootsForUser',
      () => service.readManagedDelegationRootsForUser(SCOPE),
    );
  } finally {
    restore();
  }
  readers.appAdvisorWatcher = {
    status: 'blocked',
    entrypoint: 'getAppAdvisorWatcherService().reconcileAtStartup()',
    blockingDependency:
      'AppAdvisorWatcherService.reconcileAtStartup calls initializeGitHubObservation (watchers.ts), which configures getGitHubWorkflowRunObserver and getGitHubPullRequestObserver before localScheduler.start(). configure({deferStartupRecovery:true}) leaves LocalWatcherScheduler disabled; rescan() returns without reading. Starting these observers is forbidden for this experiment.',
    importStatus: 'loadable',
  };
  return readers;
}

/** Every retained record's current generation, as a watch captures it. */
function currentGenerations(records) {
  return records.map((record) => ({
    delegationId: record.state.delegationId,
    runGeneration: record.state.runGeneration,
  }));
}

/**
 * The broker read a delegate watch makes at registration and catch-up
 * (`watchTargetStates`), here over every retained record at once: the upper
 * bound for watches covering them. App Advisor's startup reconcile, which
 * calls it, stays blocked (above).
 */
async function measureWatchRead(broker, targets) {
  const { result, metrics } = await measure(() =>
    broker.watchTargetStates(targets),
  );
  if (result.length !== targets.length)
    throw new Error('Watch read count mismatch');
  return {
    status: 'measured',
    entrypoint: 'AgentDelegationBroker.watchTargetStates',
    targets: targets.length,
    settled: result.filter((state) => state.resultIndex !== null).length,
    ...metrics,
  };
}

function requireOk(result) {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

async function createStreamBacking(directory) {
  const { ChatStorageV2 } = await load('../../src/main/lib/chat-storage-v2.ts');
  const { ChatStateV2Backend } = await load(
    '../../src/main/services/chat-state-v2-backend.ts',
  );
  const { ChatStateV2Repository } = await load(
    '../../src/main/services/chat-state-v2-repository.ts',
  );
  const { ChatStateService } = await load(
    '../../src/main/services/chat-state-service.ts',
  );
  const { RepositoryDelegationTranscriptPort } = await load(
    '../../src/main/agents/delegation/repository-transcript-port.ts',
  );
  const { readMetadataOfRecord } = await load(`${SHARED}record-v3.ts`);
  const store = new ChatStorageV2(directory, SCOPE.worktreeId, undefined, {
    maxManifestVersion: 4,
  });
  await store.migrate(() =>
    Promise.resolve({
      revision: 0,
      index: { activeTabId: 'chat-0', runtimeByChatId: {} },
      recovery: {
        receipts: [],
        mutationIds: [],
        removedTabIds: [],
        removedArchiveEntryIds: [],
        removedMessageIds: [],
      },
      chats: (async function* () {
        for (const tab of retainedTabs().tabs)
          yield await Promise.resolve({
            metadata: {
              id: tab.id,
              title: tab.title,
              createdAt: tab.createdAt,
            },
            messages: (async function* () {
              for (const message of tab.messages)
                yield await Promise.resolve(message);
            })(),
          });
      })(),
    }),
  );
  const backend = new ChatStateV2Backend(store, {
    deltaJournal: {},
    enableFormat4: true,
  });
  try {
    await backend.promoteToDeltaJournal();
    await backend.promoteToFormat4();
    await backend.flush();
  } finally {
    backend.releaseJournal();
    await backend.disposeArtifactMaintenance();
  }
  const repository = new ChatStateV2Repository({
    resolvePaths: () => ({
      tabs: join(directory, `${SCOPE.worktreeId}.json`),
      archives: join(directory, 'archives.json'),
      journal: join(directory, 'journal.json'),
    }),
    enableFormat4: true,
    delegationReadMetadata: readMetadataOfRecord,
  });
  const service = new ChatStateService({
    repository,
    recordDiagnostic: () => undefined,
  });
  return {
    port: new RepositoryDelegationTranscriptPort(service, SCOPE),
    service,
    repository,
    readMetadataOfRecord,
  };
}

async function directoryBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(path);
    else if (entry.isFile()) total += (await stat(path)).size;
    else throw new Error('Unexpected non-private fixture entry');
  }
  return total;
}

async function seedStream(
  directory,
  root,
  manifest,
  backing,
  runtime,
  progress,
) {
  const { AgentDelegationBroker, AgentRunnerRegistry, FileDelegationStorage } =
    runtime;
  const { delegationChildMessages, delegationBlockId } = await load(
    '../../../../packages/agent-transcript/src/lib/delegation-transcript.ts',
  );
  const storage = new FileDelegationStorage(directory);
  const registry = new AgentRunnerRegistry();
  let launched;
  let settled;
  const errors = [];
  registry.register({
    apiVersion: 1,
    registrationId: 'lifetime-scripted',
    adapter: {
      harnessId: 'lifetime-scripted',
      adapterVersion: '1',
      runtimeKind: 'local-sdk',
      canRun: () => Promise.resolve({ available: true }),
      start: (request, sink) => {
        launched.resolve({ request, sink });
        return Promise.resolve({ runId: request.delegationId });
      },
      stop: () => Promise.resolve({ stopped: true }),
      close: () => Promise.resolve(),
    },
  });
  const broker = new AgentDelegationBroker({
    registry,
    storage,
    cwd: root,
    capacity: 1,
    resolveRoute: () => Promise.resolve({ ok: true, value: route() }),
    authorize: () => Promise.resolve({ ok: true, value: undefined }),
    // Fixture-only: production cap/default are untouched. Otherwise seed 513
    // would test admission, not retained-record loading. No environment gate.
    lifetimePolicy: () => ({
      kind: 'available',
      limit: 3072,
      extension: 'none',
    }),
    testOnlyStreamGeneration: true,
    transcriptPort: backing.port,
    onError: (error) => {
      errors.push(String(error));
      launched?.reject(error);
      settled?.reject(error);
    },
    onSettled: (_parent, _id, output) => {
      settled.resolve(output);
      return Promise.resolve();
    },
  });
  try {
    await broker.initialize();
    for (const entry of manifest.records) {
      launched = Promise.withResolvers();
      settled = Promise.withResolvers();
      // Attach rejection handlers before admission, avoiding unhandled promises.
      const launchedResult = launched.promise;
      const settledResult = settled.promise;
      launchedResult.catch(() => undefined);
      settledResult.catch(() => undefined);
      const legacy = legacyRecord(entry);
      requireOk(await broker.spawn(legacy.parent, legacy.task));
      const { request, sink } = await launchedResult;
      entry.delegationId = request.delegationId;
      const target = request.transcriptStream?.target;
      if (!target)
        throw new Error(
          'Production broker did not create a stream-backed generation',
        );
      requireOk(await backing.port.open({ target }));
      const rows = delegationChildMessages(
        delegationBlockId(request.delegationId, 1),
        legacy.state.transcript,
      ).map((row) => ({
        ...row,
        itemRevision: 0,
        final: true,
        delegationSegment: 'synthetic-segment',
      }));
      const receipt = requireOk(
        await backing.port.appendChanges({
          target,
          mutationKey: `fixture-${entry.index}`,
          changes: rows.map((row) => ({ row })),
        }),
      );
      const emit = (sequence, event) =>
        sink({
          delegationId: request.delegationId,
          runGeneration: 1,
          sequence,
          occurredAt: entry.index + sequence + 1,
          event,
        });
      await emit(1, {
        type: 'started',
        nativeSessionId: `synthetic-${entry.index}`,
      });
      await emit(2, { type: 'transcript_receipt', ...receipt });
      await emit(3, { type: 'terminal', status: 'completed' });
      await settledResult;
      await broker.flushCardPublication(target);
      if (errors.length) throw new Error(errors.join('; '));
      if ((entry.index + 1) % 32 === 0)
        progress(`v3 seed ${entry.index + 1}/${manifest.records.length}`);
    }
  } finally {
    await broker.close();
  }
  const records = await storage.load();
  if (records.length !== manifest.records.length)
    throw new Error('V3 decoded count mismatch');
  const sizes = [];
  for (const entry of manifest.records) {
    const record = records.find(
      (candidate) => candidate.state.delegationId === entry.delegationId,
    );
    if (record?.version !== 3 || record.state.status !== 'completed')
      throw new Error('Missing settled v3 identity');
    const target = record.readMetadata.current.target;
    const generation = requireOk(
      await backing.port.generation({
        chatId: entry.chatId,
        delegationId: entry.delegationId,
        runGeneration: 1,
      }),
    );
    const pin = generation.result?.settlement.contentRevision;
    if (pin === undefined) throw new Error('V3 registry settlement missing');
    const page = requireOk(
      await backing.port.page({ target, streamRevision: pin, limit: 8 }),
    );
    const text = page.rows
      .flatMap((row) => row.blocks)
      .find((block) => block.type === 'text');
    // Large text can be externalized by the canonical writer; resolve through
    // its real range reader, not by reading/constructing registry files.
    const textRow = page.rows.find((row) =>
      row.blocks.some((block) => block.type === 'text'),
    );
    if (!textRow || !text) throw new Error('V3 text row missing');
    let body = '';
    let offset = 0;
    do {
      const range = requireOk(
        await backing.port.contentRange({
          target,
          streamRevision: pin,
          messageId: textRow.id,
          blockOrdinal: 0,
          field: 'text',
          offset,
          limit: 64 * 1024,
        }),
      );
      body += range.text;
      offset = range.nextOffset;
    } while (offset !== undefined);
    if (
      Buffer.byteLength(body) !== entry.bodyBytes ||
      body !== 'x'.repeat(entry.bodyBytes)
    )
      throw new Error('V3 body bytes mismatch');
    const bytes = await readFile(join(directory, `${entry.delegationId}.json`));
    if (!isDeepStrictEqual(JSON.parse(bytes.toString('utf8')), record))
      throw new Error('V3 disk/decoded mismatch');
    sizes.push(bytes.byteLength);
    if ((entry.index + 1) % 64 === 0)
      progress(`v3 verified ${entry.index + 1}/${manifest.records.length}`);
  }
  return {
    bodies: manifest.bodies,
    records: summarizeBytes(sizes),
    manifest,
    manifestHash: digest(JSON.stringify(manifest)),
    verified: {
      decodedCount: records.length,
      exactDecodedAndDiskBytes: true,
      logicalBodyBytes: manifest.bodies.totalBytes,
    },
    totalBackingDiskBytes: await directoryBytes(root),
    seeding:
      'Production broker with scripted runner, fixture-only stream creation and admission policy; canonical format-4 repository/port; no hand-written registry files',
  };
}

export async function runStreamSample(root, count, progress = () => undefined) {
  const sampleStart = performance.now();
  const runtime = {
    ...(await load(`${SHARED}broker.ts`)),
    ...(await load(`${SHARED}runner-registry.ts`)),
    ...(await load(`${SHARED}storage.ts`)),
  };
  const paths = await load('../../src/main/lib/paths.ts');
  const worktreeDirectory = paths.getWorktreeDataDir(
    SCOPE.projectId,
    SCOPE.worktreeId,
  );
  const directory = join(worktreeDirectory, 'delegation', 'runs');
  const backing = await createStreamBacking(worktreeDirectory);
  let sample;
  try {
    const seedStart = performance.now();
    const fixture = await seedStream(
      directory,
      root,
      createManifest(count),
      backing,
      runtime,
      progress,
    );
    // A clean quit drains the repository, which checkpoints the scope, so a
    // restart reads no journal left by the previous run. Without this the
    // first registry read pays the checkpoint of the whole seeding.
    await backing.repository.flushScope(SCOPE);
    fixture.seedAndVerificationWallMs = performance.now() - seedStart;
    const loaded = await measure(() =>
      new runtime.FileDelegationStorage(directory).load(),
    );
    if (loaded.result.length !== count)
      throw new Error('V3 measured count mismatch');
    const watchTargets = currentGenerations(loaded.result);
    loaded.result = undefined;
    const registry = new runtime.AgentRunnerRegistry();
    let runnerStarts = 0;
    registry.register({
      apiVersion: 1,
      registrationId: 'lifetime-scripted',
      adapter: {
        harnessId: 'lifetime-scripted',
        adapterVersion: '1',
        runtimeKind: 'local-sdk',
        canRun: () => Promise.resolve({ available: true }),
        start: () => {
          runnerStarts += 1;
          throw new Error('Retained v3 fixture must never launch');
        },
        stop: () => Promise.resolve({ stopped: true }),
        close: () => Promise.resolve(),
      },
    });
    const broker = new runtime.AgentDelegationBroker({
      registry,
      storage: new runtime.FileDelegationStorage(directory),
      cwd: root,
      resolveRoute: () => Promise.resolve({ ok: true, value: route() }),
      authorize: () => Promise.resolve({ ok: true, value: undefined }),
      transcriptPort: backing.port,
    });
    let initialized;
    let watchRead;
    try {
      initialized = await measure(() => broker.initialize());
      if (broker.retainedCount() !== count || runnerStarts !== 0)
        throw new Error(
          'V3 broker retained count mismatch or unexpected launch',
        );
      watchRead = await measureWatchRead(broker, watchTargets);
    } finally {
      await broker.close();
    }
    const afterClose = {
      memoryBytes: process.memoryUsage(),
      loadAverage1_5_15: loadavg(),
    };
    const { createDelegationRecordReader } = await load(
      '../../src/main/agents/delegation/record-reader.ts',
    );
    const hostReaders = await measureHostReaders(count, {
      readMetadata: backing.readMetadataOfRecord,
      reader: createDelegationRecordReader({
        port: backing.repository,
        scope: SCOPE,
      }),
    });
    sample = {
      status: 'measured',
      form: 'stream-backed-v3',
      count,
      fixture,
      storageLoad: loaded.metrics,
      brokerInitialize: initialized.metrics,
      brokerWatchRead: watchRead,
      afterClose,
      retainedCount: count,
      runnerStarts,
      hostReaders,
      sampleWallMs: performance.now() - sampleStart,
    };
    return sample;
  } finally {
    await backing.service.drain();
    if (sample) {
      sample.afterRepositoryClose = {
        memoryBytes: process.memoryUsage(),
        loadAverage1_5_15: loadavg(),
      };
      sample.sampleWallMs = performance.now() - sampleStart;
    }
  }
}

export async function runLegacySample(root, count, progress = () => undefined) {
  const sampleStart = performance.now();
  const { FileDelegationStorage } = await load(`${SHARED}storage.ts`);
  const { AgentDelegationBroker } = await load(`${SHARED}broker.ts`);
  const { AgentRunnerRegistry } = await load(`${SHARED}runner-registry.ts`);
  const manifest = createManifest(count);
  const paths = await load('../../src/main/lib/paths.ts');
  const directory = join(
    paths.getWorktreeDataDir(SCOPE.projectId, SCOPE.worktreeId),
    'delegation',
    'runs',
  );
  const seedStart = performance.now();
  const fixture = await seedLegacy(
    directory,
    manifest,
    FileDelegationStorage,
    progress,
  );
  fixture.seedAndVerificationWallMs = performance.now() - seedStart;
  const loaded = await measure(() =>
    new FileDelegationStorage(directory).load(),
  );
  verifyDecoded(loaded.result, manifest);
  const watchTargets = currentGenerations(loaded.result);
  loaded.result = undefined;
  const registry = new AgentRunnerRegistry();
  let runnerStarts = 0;
  registry.register({
    apiVersion: 1,
    registrationId: 'lifetime-scripted',
    adapter: {
      harnessId: 'lifetime-scripted',
      adapterVersion: '1',
      runtimeKind: 'local-sdk',
      canRun: () => Promise.resolve({ available: true }),
      start: () => {
        runnerStarts += 1;
        throw new Error('Settled fixture must never launch');
      },
      stop: () => Promise.resolve({ stopped: true }),
      close: () => Promise.resolve(),
    },
  });
  const errors = [];
  const broker = new AgentDelegationBroker({
    registry,
    storage: new FileDelegationStorage(directory),
    cwd: root,
    capacity: 1,
    resolveRoute: () => Promise.resolve({ ok: true, value: route() }),
    authorize: () => Promise.resolve({ ok: true, value: undefined }),
    onError: (error) => errors.push(String(error)),
  });
  let initialized;
  let watchRead;
  try {
    initialized = await measure(() => broker.initialize());
    if (broker.retainedCount() !== count || runnerStarts !== 0 || errors.length)
      throw new Error('Broker initialization did not preserve settled fixture');
    watchRead = await measureWatchRead(broker, watchTargets);
  } finally {
    await broker.close();
  }
  const afterClose = {
    memoryBytes: process.memoryUsage(),
    loadAverage1_5_15: loadavg(),
  };
  const hostReaders = await measureHostReaders(count);
  return {
    status: 'measured',
    form: 'legacy-transcript-embedding',
    count,
    fixture,
    storageLoad: loaded.metrics,
    brokerInitialize: initialized.metrics,
    brokerWatchRead: watchRead,
    afterClose,
    retainedCount: count,
    runnerStarts,
    hostReaders,
    sampleWallMs: performance.now() - sampleStart,
  };
}

export async function runExperiment(counts, progress = () => undefined) {
  validateCounts(counts);
  const report = createReport();
  const root = await mkdtemp(join(tmpdir(), 'delegation-lifetime-load-'));
  const prior = {
    data: process.env.CANOPY_DATA_DIR,
    secure: process.env.CANOPY_SECURE_DATA_DIR,
  };
  process.env.CANOPY_DATA_DIR = join(root, 'bootstrap-data');
  process.env.CANOPY_SECURE_DATA_DIR = join(root, 'bootstrap-secure');
  let restoreLog;
  try {
    const log = await load('electron-log/main.js');
    const priorLevel = log.transports.file.level;
    log.transports.file.level = false;
    restoreLog = () => {
      log.transports.file.level = priorLevel;
    };
    report.hostPaths = await probeHostPaths();
    for (const count of counts) {
      const cell = await mkdtemp(join(root, `legacy-${count}-`));
      process.env.CANOPY_DATA_DIR = join(cell, 'data');
      process.env.CANOPY_SECURE_DATA_DIR = join(cell, 'secure');
      progress(`starting legacy ${count}`);
      try {
        report.samples.push(await runLegacySample(cell, count, progress));
      } catch (error) {
        report.samples.push({
          ...blocked(error, 'runLegacySample'),
          status: 'failed',
          form: 'legacy-transcript-embedding',
          count,
        });
        break;
      } finally {
        await rm(cell, { recursive: true, force: true });
      }
      const streamCell = await mkdtemp(join(root, `stream-${count}-`));
      process.env.CANOPY_DATA_DIR = join(streamCell, 'data');
      process.env.CANOPY_SECURE_DATA_DIR = join(streamCell, 'secure');
      progress(`starting v3 ${count}`);
      try {
        const unavailable = Object.entries(report.hostPaths).find(
          ([name, probe]) =>
            name.startsWith('streamV3') && probe.status === 'unavailable',
        );
        if (unavailable)
          report.samples.push({
            ...unavailable[1],
            form: 'stream-backed-v3',
            count,
          });
        else
          report.samples.push(
            await runStreamSample(streamCell, count, progress),
          );
      } catch (error) {
        report.samples.push({
          ...blocked(error, 'runStreamSample'),
          status: 'failed',
          form: 'stream-backed-v3',
          count,
        });
        break;
      } finally {
        await rm(streamCell, { recursive: true, force: true });
      }
    }
  } finally {
    restoreLog?.();
    if (prior.data === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = prior.data;
    if (prior.secure === undefined) delete process.env.CANOPY_SECURE_DATA_DIR;
    else process.env.CANOPY_SECURE_DATA_DIR = prior.secure;
    await rm(root, { recursive: true, force: true });
  }
  return report;
}

async function main() {
  const { counts, output } = parseArguments(process.argv.slice(2));
  const report = await runExperiment(counts, (message) =>
    process.stderr.write(`[delegation-lifetime-load] ${message}\n`),
  );
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (output) await writeFile(output, json, { flag: 'wx', mode: 0o600 });
  else process.stdout.write(json);
  if (report.samples.some((sample) => sample.status === 'failed'))
    process.exitCode = 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  });
}
