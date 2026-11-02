import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createManifest,
  createReport,
  legacyRecord,
  parseArguments,
  runExperiment,
  summarizeBytes,
  verifyDecoded,
} from './delegation-lifetime-load.mjs';

test('manifest records a deterministic mixed body distribution without user content', () => {
  const manifest = createManifest(32);
  assert.deepEqual(manifest.bodies, {
    count: 32,
    totalBytes: 1146880,
    minBytes: 2048,
    medianBytes: 2048,
    p95Bytes: 131072,
    maxBytes: 524288,
  });
  assert.equal(
    new Set(manifest.records.map((entry) => entry.delegationId)).size,
    32,
  );
  assert.deepEqual(createManifest(8), createManifest(8));
  assert.throws(() => createManifest(3073), /count/);
});

test('argument parser defaults to a small gate and rejects unsafe or ambiguous counts', () => {
  assert.deepEqual(parseArguments([]).counts, [8]);
  assert.deepEqual(
    parseArguments(['--counts', '512,1024,3072']).counts,
    [512, 1024, 3072],
  );
  for (const value of [
    '0',
    '-1',
    'NaN',
    '1.5',
    '3073',
    '512,512',
    '8,',
    '65',
    '999999999999',
  ])
    assert.throws(() => parseArguments(['--counts', value]), /count/i);
  assert.throws(() => parseArguments(['--counts']), /value/i);
  assert.throws(() => parseArguments(['--unknown', '8']), /Unknown/);
  assert.throws(() => parseArguments(['--output']), /value/i);
});

test('verification refuses count, identity and byte mismatches', () => {
  const manifest = createManifest(2);
  const records = manifest.records.map(legacyRecord);
  verifyDecoded(records, manifest);
  assert.throws(
    () => verifyDecoded(records.slice(1), manifest),
    /count mismatch/,
  );
  assert.throws(
    () => verifyDecoded([records[0], records[0]], manifest),
    /identity/,
  );
  const changed = structuredClone(records);
  changed[0].state.transcript[0].text = 'wrong bytes';
  assert.throws(() => verifyDecoded(changed, manifest), /bytes/);
});

test('report explicitly disclaims release acceptance and Electron memory', () => {
  const report = createReport();
  assert.equal(report.labels.evidence, 'exploratory');
  assert.equal(report.labels.runtime, 'plain Node under tsx');
  assert.match(report.labels.memory, /not Electron main-process memory/);
  assert.equal(report.labels.c37, 'not a C37 verdict');
  assert.match(report.labels.cap, /never changes the cap/);
  assert.deepEqual(summarizeBytes([9, 1, 5, 3]), {
    count: 4,
    totalBytes: 18,
    minBytes: 1,
    medianBytes: 3,
    p95Bytes: 9,
    maxBytes: 9,
  });
});

test('feasibility: eight real private records load and initialize a production broker without Jest', async (context) => {
  const report = await runExperiment([8]);
  context.diagnostic(`host: ${JSON.stringify(report.host)}`);
  for (const [name, probe] of Object.entries(report.hostPaths))
    context.diagnostic(
      `${name}: ${probe.status}: ${probe.blockingDependency?.message ?? ''}`,
    );
  assert.equal(report.samples.length, 2);
  const sample = report.samples[0];
  assert.equal(sample.count, 8);
  assert.equal(sample.fixture.records.count, 8);
  assert.equal(sample.retainedCount, 8);
  assert.equal(sample.runnerStarts, 0);
  assert.ok(sample.fixture.records.totalBytes > 700000);
  assert.ok(sample.storageLoad.wallMs >= 0);
  assert.ok(sample.brokerInitialize.wallMs >= 0);
  assert.ok(sample.afterClose.memoryBytes.rss > 0);
  for (const [name, expected] of [
    ['tree', 2],
    ['rootsCold', 4],
    ['rootsCached', 4],
    ['recovery', 4],
  ]) {
    context.diagnostic(
      `${name}: ${sample.hostReaders[name].status}, returned ${sample.hostReaders[name].returnedCount}`,
    );
    assert.equal(sample.hostReaders[name].status, 'measured');
    assert.equal(sample.hostReaders[name].returnedCount, expected);
  }
  assert.equal(sample.hostReaders.appAdvisorWatcher.status, 'blocked');
  assert.match(
    sample.hostReaders.appAdvisorWatcher.blockingDependency,
    /initializeGitHubObservation/,
  );
  assert.equal(
    report.samples.filter((entry) => entry.form === 'stream-backed-v3').length,
    1,
  );
  const stream = report.samples[1];
  assert.equal(stream.count, 8);
  assert.equal(stream.fixture.verified.logicalBodyBytes, 710656);
  assert.equal(stream.fixture.verified.decodedCount, 8);
  assert.equal(stream.retainedCount, 8);
  assert.ok(stream.fixture.totalBackingDiskBytes > 700000);
  // The real recovery loader deliberately does not invent stream outcomes.
  for (const [name, expected] of [
    ['tree', 2],
    ['rootsCold', 4],
    ['rootsCached', 4],
    ['recovery', 0],
  ]) {
    assert.equal(
      stream.hostReaders[name].status,
      'measured',
      `${name}: ${JSON.stringify(stream.hostReaders[name].blockingDependency)}`,
    );
    assert.equal(stream.hostReaders[name].returnedCount, expected);
  }
  assert.equal(stream.runnerStarts, 0);
  for (const entry of report.samples) {
    assert.equal(
      entry.status,
      'measured',
      JSON.stringify(entry.blockingDependency),
    );
    context.diagnostic(
      `${entry.form}: total ${entry.sampleWallMs.toFixed(1)}ms, seed/verify ${entry.fixture.seedAndVerificationWallMs.toFixed(1)}ms; records ${entry.fixture.records.totalBytes} bytes, body ${entry.fixture.bodies.totalBytes} bytes`,
    );
  }
});
