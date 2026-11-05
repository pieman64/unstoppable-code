import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

export const LAB_TRANSCRIPT_UPDATE_COUNT = 20;
export const LAB_TRANSCRIPT_UPDATE_CADENCE_MS = 50;
export const LAB_TRANSCRIPT_MIN_MESSAGE_COUNT = 80_000;
export const LAB_TRANSCRIPT_MIN_BYTES = 120_000_000;
export const LAB_TRANSCRIPT_CHECKPOINT_TRIGGER_MIN_BYTES = 4 * 1024 * 1024;
export const LAB_TRANSCRIPT_CHECKPOINT_SAMPLE_INTERVAL_MS = 100;
export const LAB_TRANSCRIPT_CHECKPOINT_MARKER_SAMPLE_INTERVAL_MS = 25;
export const LAB_TRANSCRIPT_CHECKPOINT_PAYLOAD_CHARACTERS = 512 * 1024;
export const LAB_TRANSCRIPT_CHECKPOINT_MAX_MUTATIONS = 12;
// Longest wait for a startup checkpoint of the seed to finish before probing.
export const LAB_TRANSCRIPT_CHECKPOINT_SETTLE_MS = 30_000;

function finiteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Lab transcript ${label} must be a non-empty string`);
  }
  return value;
}

export function labTranscriptDimensions(fixture, expected = {}) {
  const messageCount = finiteNumber(fixture?.messageCount);
  const transcriptBytes = finiteNumber(fixture?.transcriptBytes);
  const fixtureDigest = requiredString(
    fixture?.fixtureDigest,
    'fixture digest',
  );

  if (
    !Number.isInteger(messageCount) ||
    messageCount < LAB_TRANSCRIPT_MIN_MESSAGE_COUNT
  ) {
    throw new Error(
      `Lab transcript fixture must retain at least ${LAB_TRANSCRIPT_MIN_MESSAGE_COUNT} messages; observed ${messageCount ?? 'unknown'}`,
    );
  }
  if (
    !Number.isInteger(transcriptBytes) ||
    transcriptBytes < LAB_TRANSCRIPT_MIN_BYTES
  ) {
    throw new Error(
      `Lab transcript fixture must retain at least ${LAB_TRANSCRIPT_MIN_BYTES} bytes; observed ${transcriptBytes ?? 'unknown'}`,
    );
  }

  const expectedMessageCount = finiteNumber(expected.messageCount);
  const expectedTranscriptBytes = finiteNumber(expected.transcriptBytes);
  if (
    expectedMessageCount !== undefined &&
    messageCount !== expectedMessageCount
  ) {
    throw new Error(
      `Lab transcript fixture message count changed: expected ${expectedMessageCount}, received ${messageCount}`,
    );
  }
  if (
    expectedTranscriptBytes !== undefined &&
    transcriptBytes !== expectedTranscriptBytes
  ) {
    throw new Error(
      `Lab transcript fixture byte count changed: expected ${expectedTranscriptBytes}, received ${transcriptBytes}`,
    );
  }

  return { fixtureDigest, messageCount, transcriptBytes };
}

/** A stable digest over fixture identity and the dimensions that were seeded. */
export function labTranscriptDimensionsDigest(fixture, expected = {}) {
  const dimensions = labTranscriptDimensions(fixture, expected);
  return createHash('sha256')
    .update(
      JSON.stringify({
        fixtureDigest: dimensions.fixtureDigest,
        messageCount: dimensions.messageCount,
        transcriptBytes: dimensions.transcriptBytes,
      }),
    )
    .digest('hex');
}

/** Leave the format flag inherited from the parent's resolved launch environment. */
export function labTranscriptLaunchEnvironment(streamFixtureSpecPath) {
  requiredString(streamFixtureSpecPath, 'stream fixture spec path');
  return { CANOPY_E2E_SEED_STREAM_FIXTURE: streamFixtureSpecPath };
}

export function normalizeLabTranscriptReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('Lab transcript hook returned a non-object receipt');
  }

  const legacyUpdates = finiteNumber(receipt.legacyUpdates);
  const streamUpdates = finiteNumber(receipt.streamUpdates);
  const latestRevision = finiteNumber(receipt.latestRevision);
  const latestSentinel = receipt.latestSentinel;
  const resolvedConfig = receipt.resolvedConfig;

  if (legacyUpdates === undefined || streamUpdates === undefined) {
    throw new Error(
      'Lab transcript hook receipt must include legacyUpdates and streamUpdates counters',
    );
  }
  if (
    latestSentinel !== undefined &&
    (typeof latestSentinel !== 'string' || latestSentinel.length === 0)
  ) {
    throw new Error('Lab transcript latestSentinel must be a non-empty string');
  }
  return {
    manifestVersion: receipt.manifestVersion,
    resolvedConfig,
    CANOPY_E2E_CHAT_FORMAT4: resolvedConfig?.CANOPY_E2E_CHAT_FORMAT4 ?? null,
    legacyUpdates,
    streamUpdates,
    latestRevision,
    latestSentinel,
    target: receipt.target,
    raw: receipt,
  };
}

export function normalizeLabTranscriptTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new Error('Lab transcript target must be a delegation target');
  }
  const chatId = requiredString(target.chatId, 'target chat id');
  const delegationId = requiredString(
    target.delegationId,
    'target delegation id',
  );
  const runGeneration = finiteNumber(target.runGeneration);
  if (
    target.kind !== 'delegation' ||
    !Number.isInteger(runGeneration) ||
    runGeneration < 1
  ) {
    throw new Error('Lab transcript target must be a valid delegation target');
  }
  return { kind: 'delegation', chatId, delegationId, runGeneration };
}

export function labTranscriptProvenance(fixture, inspection) {
  const dimensions = labTranscriptDimensions(fixture);
  const observedManifestVersion = finiteNumber(inspection?.manifestVersion);
  if (observedManifestVersion !== 4) {
    throw new Error(
      `Lab transcript inspection must observe manifestVersion 4; received ${observedManifestVersion ?? 'unknown'}`,
    );
  }
  const resolvedFormat4 = inspection?.resolvedConfig?.CANOPY_E2E_CHAT_FORMAT4;
  if (resolvedFormat4?.raw !== '1' || resolvedFormat4?.effective !== true) {
    throw new Error(
      `Lab transcript requires main-resolved CANOPY_E2E_CHAT_FORMAT4=1; observed raw=${String(resolvedFormat4?.raw)}, effective=${String(resolvedFormat4?.effective)}`,
    );
  }

  return {
    CANOPY_E2E_CHAT_FORMAT4: resolvedFormat4,
    seededManifestVersion: fixture.manifestVersion ?? null,
    observedManifestVersion,
    fixtureDigest: dimensions.fixtureDigest,
    messageCount: dimensions.messageCount,
    transcriptBytes: dimensions.transcriptBytes,
    dimensionsDigest: labTranscriptDimensionsDigest(fixture),
  };
}

/**
 * Run production-card updates on one serialized cadence. Callers pass the
 * production hook as `update`; this helper never mutates fixture state itself.
 */
export async function runSerializedLabTranscriptUpdates({
  update,
  count = LAB_TRANSCRIPT_UPDATE_COUNT,
  cadenceMs = LAB_TRANSCRIPT_UPDATE_CADENCE_MS,
  labelPrefix,
  now = () => performance.now(),
  pause = (milliseconds) => delay(milliseconds),
}) {
  if (typeof update !== 'function') {
    throw new TypeError('Lab transcript update callback must be a function');
  }
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new RangeError(
      'Lab transcript update count must be between 1 and 100',
    );
  }
  if (!Number.isFinite(cadenceMs) || cadenceMs < 0 || cadenceMs > 10_000) {
    throw new RangeError(
      'Lab transcript cadence must be between 0 and 10000 ms',
    );
  }
  const prefix = requiredString(labelPrefix, 'update label prefix');
  const startedAtMs = now();
  const updates = [];

  for (let index = 0; index < count; index += 1) {
    const scheduledAtMs = startedAtMs + index * cadenceMs;
    const waitMs = scheduledAtMs - now();
    if (waitMs > 0) await pause(waitMs);
    const updateStartedAtMs = now();
    const label = `${prefix}-${String(index + 1).padStart(2, '0')}`;
    // Await each hook call before starting the next one. Overlapping mutations
    // would make a cadence receipt ambiguous and can reorder production writes.
    const receipt = await update(label);
    const updateEndedAtMs = now();
    updates.push({
      index: index + 1,
      label,
      scheduledAtMs,
      startedAtMs: updateStartedAtMs,
      endedAtMs: updateEndedAtMs,
      durationMs: Math.max(0, updateEndedAtMs - updateStartedAtMs),
      receipt: normalizeLabTranscriptReceipt(receipt),
    });
  }

  const startGaps = updates
    .slice(1)
    .map(
      (updateRecord, index) =>
        updateRecord.startedAtMs - updates[index].startedAtMs,
    );
  return {
    labelPrefix: prefix,
    requestedCount: count,
    achievedCount: updates.length,
    cadenceMs,
    maxStartGapMs: startGaps.length > 0 ? Math.max(...startGaps) : 0,
    maxUpdateDurationMs: Math.max(
      ...updates.map(({ durationMs }) => durationMs),
    ),
    updates,
  };
}

export function assertLabTranscriptUpdateProgress({
  before,
  after,
  updates,
  expectedCount = LAB_TRANSCRIPT_UPDATE_COUNT,
}) {
  const initial = normalizeLabTranscriptReceipt(before);
  const final = normalizeLabTranscriptReceipt(after);
  if (
    !Number.isFinite(initial.latestRevision) ||
    !Number.isFinite(final.latestRevision)
  ) {
    throw new Error(
      'Lab transcript inspection receipts must include latestRevision',
    );
  }
  if (!Array.isArray(updates) || updates.length !== expectedCount) {
    throw new Error(
      `Lab transcript achieved ${updates?.length ?? 0} serialized updates; expected ${expectedCount}`,
    );
  }

  const normalizedUpdates = updates.map((record) =>
    normalizeLabTranscriptReceipt(record?.receipt ?? record),
  );
  let previousLegacy = initial.legacyUpdates;
  let previousStream = initial.streamUpdates;
  for (const [index, update] of normalizedUpdates.entries()) {
    if (
      update.legacyUpdates <= previousLegacy ||
      update.streamUpdates <= previousStream
    ) {
      throw new Error(
        `Lab transcript production update ${index + 1} did not advance both legacy and stream counters`,
      );
    }
    if (!update.latestSentinel) {
      throw new Error(
        `Lab transcript production update ${index + 1} did not return a latest sentinel`,
      );
    }
    previousLegacy = update.legacyUpdates;
    previousStream = update.streamUpdates;
  }

  const legacyDelta = final.legacyUpdates - initial.legacyUpdates;
  const streamDelta = final.streamUpdates - initial.streamUpdates;
  if (legacyDelta < expectedCount || streamDelta < expectedCount) {
    throw new Error(
      `Lab transcript production update counters advanced by legacy=${legacyDelta}, stream=${streamDelta}; expected at least ${expectedCount} each`,
    );
  }
  if (final.latestRevision <= initial.latestRevision) {
    throw new Error(
      'Lab transcript production updates did not commit a newer revision',
    );
  }
  const finalUpdateSentinel = normalizedUpdates.at(-1).latestSentinel;
  if (
    final.latestSentinel !== undefined &&
    final.latestSentinel !== finalUpdateSentinel
  ) {
    throw new Error(
      'Lab transcript inspection did not retain the last update latest sentinel',
    );
  }

  return {
    requestedCount: expectedCount,
    achievedCount: updates.length,
    legacyUpdateDelta: legacyDelta,
    streamUpdateDelta: streamDelta,
    revisionBefore: initial.latestRevision,
    revisionAfter: final.latestRevision,
    latestSentinel: finalUpdateSentinel,
  };
}

/** Validate the driver-side sampler and on-disk checkpoint evidence. */
export function summarizeLabTranscriptCheckpoint(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('Lab transcript checkpoint returned a non-object receipt');
  }
  const numericFields = [
    'journalBytes',
    'journalBytesBefore',
    'startupCheckpointWaitMs',
    'triggerBytes',
    'mainHeapBeforeBytes',
    'mainHeapPeakBytes',
    'mainHeapLimitBytes',
    'preCheckpointHeadroomBytes',
    'peakHeadroomBytes',
    'sampleResolutionMs',
    'maxSampleGapMs',
    'checkpointDurationMs',
    'mutationCount',
  ];
  const summary = Object.fromEntries(
    numericFields.map((field) => [field, finiteNumber(receipt[field])]),
  );
  const missing = Object.entries(summary)
    .filter(([, value]) => value === undefined)
    .map(([field]) => field);
  if (missing.length > 0) {
    throw new Error(
      `Lab transcript checkpoint receipt is missing measured fields: ${missing.join(', ')}`,
    );
  }

  const requiredStrings = ['thresholdCrossingOperation', 'mutationKind'];
  for (const field of requiredStrings) {
    requiredString(receipt[field], `checkpoint ${field}`);
  }
  const target = normalizeLabTranscriptTarget(receipt.target);
  const dimensionsDigest = requiredString(
    receipt.dimensionsDigest,
    'checkpoint dimensions digest',
  );
  if (!/^[a-f0-9]{64}$/.test(dimensionsDigest)) {
    throw new Error('Lab transcript checkpoint dimensions digest is invalid');
  }
  if (
    !receipt.checkpointStartEvidence ||
    !receipt.checkpointEndEvidence ||
    !receipt.primaryTranscriptDimensions ||
    typeof receipt.primaryTranscriptDimensions !== 'object'
  ) {
    throw new Error(
      'Lab transcript checkpoint receipt is missing checkpoint evidence or primary transcript dimensions',
    );
  }

  if (
    summary.journalBytes <= LAB_TRANSCRIPT_CHECKPOINT_TRIGGER_MIN_BYTES ||
    summary.journalBytes <= summary.triggerBytes
  ) {
    throw new Error(
      `Lab transcript journal peak ${summary.journalBytes} bytes must exceed both 4 MiB and triggerBytes=${summary.triggerBytes}`,
    );
  }
  if (summary.journalBytesBefore > summary.triggerBytes) {
    throw new Error(
      'Lab transcript checkpoint journal already exceeded its trigger before the probe',
    );
  }
  if (
    summary.mainHeapPeakBytes < summary.mainHeapBeforeBytes ||
    summary.mainHeapLimitBytes < summary.mainHeapPeakBytes ||
    summary.preCheckpointHeadroomBytes !==
      summary.mainHeapLimitBytes - summary.mainHeapBeforeBytes ||
    summary.peakHeadroomBytes !==
      summary.mainHeapLimitBytes - summary.mainHeapPeakBytes
  ) {
    throw new Error(
      'Lab transcript checkpoint heap measurements are inconsistent',
    );
  }
  if (
    summary.sampleResolutionMs <= 0 ||
    summary.sampleResolutionMs !==
      LAB_TRANSCRIPT_CHECKPOINT_SAMPLE_INTERVAL_MS ||
    summary.maxSampleGapMs < 0 ||
    summary.checkpointDurationMs < 0 ||
    summary.mutationCount < 1 ||
    !['delta-checkpoint-marker', 'journal-threshold-crossing'].includes(
      requiredString(
        receipt.checkpointStartEvidence.kind,
        'checkpoint start evidence kind',
      ),
    ) ||
    requiredString(
      receipt.checkpointEndEvidence.kind,
      'checkpoint end evidence kind',
    ) !== 'checkpoint-published' ||
    receipt.checkpointEndEvidence.markerPresent !== false ||
    !Number.isFinite(
      finiteNumber(receipt.checkpointEndEvidence.catalogCheckpointRevision),
    )
  ) {
    throw new Error(
      'Lab transcript checkpoint sampling measurements are invalid',
    );
  }
  const beforeCheckpointRevision = finiteNumber(
    receipt.diskMarkers?.catalogCheckpointRevisionBefore,
  );
  const afterCheckpointRevision = finiteNumber(
    receipt.diskMarkers?.catalogCheckpointRevisionAfter,
  );
  if (
    beforeCheckpointRevision === undefined ||
    afterCheckpointRevision === undefined ||
    afterCheckpointRevision <= beforeCheckpointRevision ||
    !receipt.thresholdCrossingEvidence ||
    receipt.thresholdCrossingEvidence.kind !== 'journal-threshold-crossing' ||
    finiteNumber(receipt.thresholdCrossingEvidence.journalBytes) ===
      undefined ||
    finiteNumber(receipt.thresholdCrossingEvidence.journalBytes) <=
      summary.triggerBytes ||
    receipt.thresholdCrossingEvidence.operation !==
      receipt.thresholdCrossingOperation
  ) {
    throw new Error(
      'Lab transcript checkpoint lacks observed journal-threshold and catalog-publication evidence',
    );
  }
  return {
    ...summary,
    checkpointStartEvidence: receipt.checkpointStartEvidence,
    checkpointEndEvidence: receipt.checkpointEndEvidence,
    thresholdCrossingOperation: receipt.thresholdCrossingOperation,
    mutationKind: receipt.mutationKind,
    target,
    primaryTranscriptDimensions: receipt.primaryTranscriptDimensions,
    dimensionsDigest,
    receipt,
  };
}

export async function callLabTranscriptHook(electronApp, request) {
  const receipt = await electronApp.evaluate((_electron, input) => {
    const hook = globalThis.__CANOPY_E2E_LAB_TRANSCRIPT__;
    if (typeof hook !== 'function') {
      throw new Error('The E2E lab transcript hook is not installed');
    }
    return hook(input);
  }, request);
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error(
      `The E2E lab transcript ${request?.operation ?? 'unknown'} operation returned no receipt`,
    );
  }
  return receipt;
}

export function inspectLabTranscript(electronApp) {
  return callLabTranscriptHook(electronApp, { operation: 'inspect' });
}

export function updateLabTranscript(electronApp, label, options = {}) {
  const request = {
    operation: 'update',
    label: requiredString(label, 'update label'),
  };
  if (options.payloadCharacters !== undefined) {
    if (
      !Number.isInteger(options.payloadCharacters) ||
      options.payloadCharacters < 1 ||
      options.payloadCharacters > LAB_TRANSCRIPT_CHECKPOINT_PAYLOAD_CHARACTERS
    ) {
      throw new RangeError(
        `Lab transcript payloadCharacters must be an integer from 1 to ${LAB_TRANSCRIPT_CHECKPOINT_PAYLOAD_CHARACTERS}`,
      );
    }
    request.payloadCharacters = options.payloadCharacters;
  }
  return callLabTranscriptHook(electronApp, request);
}

function assertContainedPath(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `Lab transcript ${label} must remain inside its fixture root`,
    );
  }
}

function labTranscriptCheckpointPaths(fixture) {
  const specPath = path.resolve(
    requiredString(fixture?.streamFixtureSpecPath, 'stream fixture spec path'),
  );
  const fixtureRoot = path.dirname(specPath);
  const workspaceId = requiredString(fixture?.workspaceId, 'workspace id');
  const workspaceRoot = path.resolve(fixtureRoot, 'workspaces', workspaceId);
  assertContainedPath(fixtureRoot, workspaceRoot, 'workspace path');
  const storageDirectory = path.resolve(
    requiredString(fixture?.storageDirectory, 'storage directory'),
  );
  const manifestPath = path.resolve(
    requiredString(fixture?.manifestPath, 'manifest path'),
  );
  assertContainedPath(workspaceRoot, storageDirectory, 'storage directory');
  assertContainedPath(workspaceRoot, manifestPath, 'manifest path');
  return {
    storageDirectory,
    manifestPath,
    journalPath: path.join(storageDirectory, 'delta-journal-v2.log'),
    markerPath: path.join(storageDirectory, 'delta-checkpoint.json'),
    // The stream catalog lives under the scope's transcripts directory.
    catalogPath: path.join(
      storageDirectory,
      'transcripts',
      'delegations',
      'stream-catalog.json',
    ),
  };
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readFileBytes(filePath) {
  try {
    return (await stat(filePath)).size;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

async function readLabTranscriptCheckpointMarkers(paths) {
  const [manifest, marker, catalog, journalBytes] = await Promise.all([
    readOptionalJson(paths.manifestPath),
    readOptionalJson(paths.markerPath),
    readOptionalJson(paths.catalogPath),
    readFileBytes(paths.journalPath),
  ]);
  return {
    observedAtMs: performance.now(),
    journalBytes,
    manifestVersion: finiteNumber(manifest?.version),
    manifestJournal: manifest?.journal ?? null,
    checkpointMarker: marker,
    catalogCheckpointRevision: finiteNumber(catalog?.checkpointRevision),
  };
}

async function sampleLabTranscriptMainHeap(electronApp) {
  const startedAtMs = performance.now();
  // Main is an ES module, so `require` is absent; Electron reports kilobytes.
  const heap = await electronApp.evaluate(() => {
    const statistics = process.getHeapStatistics();
    return {
      usedHeapBytes: statistics.usedHeapSize * 1024,
      heapLimitBytes: statistics.heapSizeLimit * 1024,
    };
  });
  const endedAtMs = performance.now();
  if (
    !Number.isFinite(heap?.usedHeapBytes) ||
    !Number.isFinite(heap?.heapLimitBytes) ||
    heap.usedHeapBytes <= 0 ||
    heap.heapLimitBytes <= 0
  ) {
    throw new Error('Lab transcript main heap sample was invalid');
  }
  return {
    ...heap,
    sampledAtMs: (startedAtMs + endedAtMs) / 2,
    roundTripMs: endedAtMs - startedAtMs,
  };
}

/**
 * Drive the real automatic size checkpoint through bounded child-row writes.
 * The 100 ms main-process sampler is intentionally a lower bound: synchronous
 * peaks may occur between samples. File markers are read only from this seed.
 */
export async function runLabTranscriptCheckpointProbe({
  electronApp,
  fixture,
  target,
  update = (label, options) => updateLabTranscript(electronApp, label, options),
  sampleHeap = () => sampleLabTranscriptMainHeap(electronApp),
  readMarkers = (paths) => readLabTranscriptCheckpointMarkers(paths),
  pause = (milliseconds) => delay(milliseconds),
}) {
  if (typeof update !== 'function') {
    throw new TypeError('Lab transcript checkpoint update must be a function');
  }
  const paths = labTranscriptCheckpointPaths(fixture);
  const checkpointTarget = normalizeLabTranscriptTarget(
    target ?? fixture.target,
  );
  if (checkpointTarget.chatId !== fixture.chatId) {
    throw new Error('Lab transcript checkpoint target does not match its chat');
  }
  const dimensions = labTranscriptDimensions(fixture);
  const triggerBytes = LAB_TRANSCRIPT_CHECKPOINT_TRIGGER_MIN_BYTES;
  // Startup promotion can still be checkpointing the seed; let it finish.
  let beforeMarkers = await readMarkers(paths);
  const settleStartedAtMs = performance.now();
  while (beforeMarkers.checkpointMarker) {
    if (
      performance.now() - settleStartedAtMs >
      LAB_TRANSCRIPT_CHECKPOINT_SETTLE_MS
    ) {
      throw new Error(
        'Lab transcript checkpoint fixture kept a checkpoint marker before the probe',
      );
    }
    await pause(LAB_TRANSCRIPT_CHECKPOINT_MARKER_SAMPLE_INTERVAL_MS);
    beforeMarkers = await readMarkers(paths);
  }
  const startupCheckpointWaitMs = performance.now() - settleStartedAtMs;
  if (beforeMarkers.journalBytes > triggerBytes) {
    throw new Error(
      `Lab transcript checkpoint fixture starts above the ${triggerBytes}-byte journal threshold`,
    );
  }
  if (
    beforeMarkers.manifestVersion !== 4 ||
    !Number.isFinite(beforeMarkers.catalogCheckpointRevision)
  ) {
    throw new Error(
      'Lab transcript checkpoint fixture must have a format-4 manifest and stream catalog before the probe',
    );
  }
  const firstHeap = await sampleHeap();
  const heapSamples = [firstHeap];
  let peakJournalBytes = beforeMarkers.journalBytes;
  let thresholdCrossingEvidence;
  let markerStartEvidence;
  let endEvidence;
  let thresholdCrossingOperation;
  let currentOperationLabel;
  const beforeCatalogRevision = beforeMarkers.catalogCheckpointRevision;
  let mutationCount = 0;
  let sampling = true;

  const observeMarkers = (markers) => {
    if (!Number.isFinite(markers.journalBytes) || markers.journalBytes < 0) {
      throw new Error('Lab transcript journal-size sample was invalid');
    }
    peakJournalBytes = Math.max(peakJournalBytes, markers.journalBytes);
    if (!thresholdCrossingEvidence && markers.journalBytes > triggerBytes) {
      if (!currentOperationLabel) {
        throw new Error(
          'Lab transcript journal threshold crossing was not tied to a bounded child mutation',
        );
      }
      thresholdCrossingOperation = currentOperationLabel;
      thresholdCrossingEvidence = {
        kind: 'journal-threshold-crossing',
        observedAtMs: markers.observedAtMs,
        journalBytes: markers.journalBytes,
        catalogCheckpointRevision: markers.catalogCheckpointRevision,
        operation: currentOperationLabel,
      };
    }
    if (!markerStartEvidence && markers.checkpointMarker) {
      markerStartEvidence = {
        kind: 'delta-checkpoint-marker',
        observedAtMs: markers.observedAtMs,
        marker: markers.checkpointMarker,
        journalBytes: markers.journalBytes,
        catalogCheckpointRevision: markers.catalogCheckpointRevision,
      };
    }
    if (
      thresholdCrossingEvidence &&
      !endEvidence &&
      !markers.checkpointMarker &&
      Number.isFinite(markers.catalogCheckpointRevision) &&
      markers.catalogCheckpointRevision > (beforeCatalogRevision ?? -1) &&
      markers.journalBytes < peakJournalBytes &&
      markers.journalBytes < triggerBytes
    ) {
      endEvidence = {
        kind: 'checkpoint-published',
        observedAtMs: markers.observedAtMs,
        markerPresent: false,
        journalBytes: markers.journalBytes,
        catalogCheckpointRevision: markers.catalogCheckpointRevision,
        manifestVersion: markers.manifestVersion,
        manifestJournal: markers.manifestJournal,
      };
    }
  };

  observeMarkers(beforeMarkers);
  // A sampler failure stops sampling and is rethrown below; left unobserved
  // while an update is awaited, it would end the runner before cleanup.
  let samplerError;
  const sampleUntilStopped = async (intervalMs, sample) => {
    try {
      while (sampling) {
        await pause(intervalMs);
        if (!sampling) break;
        await sample();
      }
    } catch (error) {
      samplerError ??= error;
      sampling = false;
    }
  };
  const markerSampler = sampleUntilStopped(
    LAB_TRANSCRIPT_CHECKPOINT_MARKER_SAMPLE_INTERVAL_MS,
    async () => observeMarkers(await readMarkers(paths)),
  );
  const heapSampler = sampleUntilStopped(
    LAB_TRANSCRIPT_CHECKPOINT_SAMPLE_INTERVAL_MS,
    async () => {
      heapSamples.push(await sampleHeap());
    },
  );

  try {
    for (
      let index = 1;
      index <= LAB_TRANSCRIPT_CHECKPOINT_MAX_MUTATIONS &&
      !endEvidence &&
      !samplerError;
      index += 1
    ) {
      currentOperationLabel = `lab-checkpoint-payload-${String(index).padStart(2, '0')}`;
      await update(currentOperationLabel, {
        payloadCharacters: LAB_TRANSCRIPT_CHECKPOINT_PAYLOAD_CHARACTERS,
      });
      mutationCount += 1;
      observeMarkers(await readMarkers(paths));
      if (!endEvidence)
        await pause(LAB_TRANSCRIPT_CHECKPOINT_SAMPLE_INTERVAL_MS);
    }
  } finally {
    sampling = false;
    await Promise.all([markerSampler, heapSampler]);
  }
  if (samplerError) throw samplerError;

  const finalMarkers = await readMarkers(paths);
  observeMarkers(finalMarkers);
  heapSamples.push(await sampleHeap());
  const mainHeapBeforeBytes = firstHeap.usedHeapBytes;
  const mainHeapPeakBytes = Math.max(
    ...heapSamples.map((sample) => sample.usedHeapBytes),
  );
  const mainHeapLimitBytes = Math.max(
    ...heapSamples.map((sample) => sample.heapLimitBytes),
  );
  if (
    heapSamples.some((sample) => sample.heapLimitBytes !== mainHeapLimitBytes)
  ) {
    throw new Error('Lab transcript main heap limit changed during the probe');
  }
  const sampleGaps = heapSamples
    .slice(1)
    .map(
      (sample, index) => sample.sampledAtMs - heapSamples[index].sampledAtMs,
    );
  const checkpointStartEvidence =
    markerStartEvidence ?? thresholdCrossingEvidence;
  if (!thresholdCrossingEvidence || !checkpointStartEvidence || !endEvidence) {
    throw new Error(
      `Lab transcript automatic checkpoint markers were not observed within ${LAB_TRANSCRIPT_CHECKPOINT_MAX_MUTATIONS} bounded child mutations`,
    );
  }
  if (peakJournalBytes <= triggerBytes) {
    throw new Error(
      `Lab transcript journal peak ${peakJournalBytes} bytes did not exceed the ${triggerBytes}-byte checkpoint threshold`,
    );
  }
  if (!thresholdCrossingOperation) {
    throw new Error(
      'Lab transcript journal threshold crossing lacked an operation label',
    );
  }

  const checkpointStartMs = checkpointStartEvidence.observedAtMs;
  const checkpointEndMs = endEvidence.observedAtMs;
  return {
    journalBytes: peakJournalBytes,
    journalBytesBefore: beforeMarkers.journalBytes,
    startupCheckpointWaitMs,
    triggerBytes,
    mainHeapBeforeBytes,
    mainHeapPeakBytes,
    mainHeapLimitBytes,
    preCheckpointHeadroomBytes: mainHeapLimitBytes - mainHeapBeforeBytes,
    peakHeadroomBytes: mainHeapLimitBytes - mainHeapPeakBytes,
    sampleResolutionMs: LAB_TRANSCRIPT_CHECKPOINT_SAMPLE_INTERVAL_MS,
    maxSampleGapMs: sampleGaps.length > 0 ? Math.max(...sampleGaps) : 0,
    mutationCount,
    checkpointDurationMs: Math.max(0, checkpointEndMs - checkpointStartMs),
    checkpointStartEvidence,
    checkpointEndEvidence: endEvidence,
    thresholdCrossingOperation,
    mutationKind: 'child-open-row-rewrite',
    target: checkpointTarget,
    primaryTranscriptDimensions: dimensions,
    dimensionsDigest: labTranscriptDimensionsDigest(fixture),
    thresholdCrossingEvidence,
    sampler: {
      sampleCount: heapSamples.length,
      largestHeapProbeRoundTripMs: Math.max(
        ...heapSamples.map((sample) => sample.roundTripMs ?? 0),
      ),
      peakIsLowerBound: true,
      caveat:
        'A synchronous main-process heap peak may fall between 100 ms samples.',
    },
    diskMarkers: {
      manifestVersionBefore: beforeMarkers.manifestVersion,
      manifestJournalBefore: beforeMarkers.manifestJournal,
      catalogCheckpointRevisionBefore: beforeMarkers.catalogCheckpointRevision,
      catalogCheckpointRevisionAfter: finalMarkers.catalogCheckpointRevision,
      journalBytesAfter: finalMarkers.journalBytes,
    },
  };
}

export async function readLabTranscriptActiveSession(page, fixture) {
  return page.evaluate(async ({ workspaceId, entryId, chatId }) => {
    const result = await window.api.chat.activeSessions({
      projectId: workspaceId,
      worktreeId: entryId,
    });
    const sessions = result.sessions ?? [];
    const active = sessions.filter((session) => session.turnActive);
    const targetActive = active.filter(
      (session) => !session.chatId || session.chatId === chatId,
    );
    return {
      activeCount: targetActive.length,
      activeChatIds: targetActive.map((session) => session.chatId ?? null),
    };
  }, fixture);
}

export async function readLabTranscriptChatVisibility(page, fixture) {
  const chatTab = page.getByTestId(`panel-tab-panel-chat-${fixture.chatId}`);
  const chatPanel = page.locator(
    `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${fixture.chatId}"]`,
  );
  const siblingTab = page.getByTestId(`panel-tab-panel-chat-${fixture.leanId}`);
  return {
    chatTabPresent: (await chatTab.count()) > 0,
    chatSelected: (await chatTab.getAttribute('aria-selected')) === 'true',
    chatPanelVisible: await chatPanel.isVisible(),
    siblingSelected:
      (await siblingTab.getAttribute('aria-selected')) === 'true',
    documentHasFocus: await page.evaluate(() => document.hasFocus()),
  };
}

/** Read identity/state only; the lab never shows or native-focuses a window. */
export async function readLabTranscriptNativeWindowIdentity(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const nativeWindows = BrowserWindow.getAllWindows();
    const mainWindow = nativeWindows.find(
      (candidate) => !candidate.webContents.getURL().includes('app-advisor'),
    );
    if (!mainWindow) return { name: 'main', available: false };
    return {
      name: 'main',
      available: true,
      nativeWindowId: mainWindow.id,
      webContentsId: mainWindow.webContents.id,
      visible: mainWindow.isVisible(),
      focused: mainWindow.isFocused(),
    };
  });
}

/**
 * Reread after a reopen: the parent page through the renderer's transcript
 * IPC, and the child stream in main through the production chat-state read
 * (the renderer exposes no child-stream page read).
 */
export async function readPersistedLabTranscriptPage(
  page,
  electronApp,
  fixture,
  { latestSentinel, latestLegacySentinel, providerFinalMarker, target },
) {
  const streamSentinel = requiredString(
    latestSentinel,
    'latest stream sentinel',
  );
  const legacySentinel = requiredString(
    latestLegacySentinel,
    'latest legacy sentinel',
  );
  const finalMarker = requiredString(
    providerFinalMarker,
    'provider final marker',
  );
  const childTarget = normalizeLabTranscriptTarget(target);
  if (childTarget.chatId !== fixture.chatId) {
    throw new Error(
      'Lab transcript persisted-read target does not match its chat',
    );
  }
  const parent = await page.evaluate(
    async ({
      workspaceId,
      entryId,
      chatId,
      latestLegacySentinel,
      providerFinalMarker,
    }) => {
      const parentTranscript = await window.api.chat.getTranscriptPage({
        projectId: workspaceId,
        worktreeId: entryId,
        chatId,
      });
      const parentMessages = parentTranscript.messages ?? [];
      const parentContent = JSON.stringify(parentMessages);
      return {
        parentMessagesRead: parentMessages.length,
        legacySentinelRead: parentContent.includes(latestLegacySentinel),
        providerFinalMarkerRead: parentContent.includes(providerFinalMarker),
        latestParentMessageId: parentMessages.at(-1)?.id ?? null,
        parentTranscriptRevision: parentTranscript.transcriptRevision ?? null,
      };
    },
    {
      ...fixture,
      latestLegacySentinel: legacySentinel,
      providerFinalMarker: finalMarker,
    },
  );
  const child = normalizeLabTranscriptReceipt(
    await inspectLabTranscript(electronApp),
  );
  if (
    normalizeLabTranscriptTarget(child.target).delegationId !==
    childTarget.delegationId
  ) {
    throw new Error('Lab transcript child reread used a different target');
  }
  return {
    ...parent,
    streamSentinelRead: child.latestSentinel === streamSentinel,
    childStreamRevision: child.latestRevision,
    childReadSource: 'main:ChatStateService.getChildStreamPage',
  };
}
