/** Native capability prerequisite, outside the 33/66 measured schedules.
 * Run once via scripts/run-guarded-dev-script.mjs --suite performance -- node
 * --import tsx <this-file> --window-mode headless --output <fresh-report.json>.
 * Reuses the complete deterministic cold workload (main + App Advisor); it is
 * not a replacement qualification or a mock of Electron capabilities.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  readFile,
  writeFile,
  readdir,
  lstat,
  realpath,
  mkdir,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import electronPath from 'electron';
import { classifyReleaseReport } from './browser-profiles-release-evidence.mjs';
import { RESPONSIVENESS_THRESHOLDS } from './profiles.mjs';
import {
  assertHeadlessStudyMetadata,
  assertProductionHeadlessEvidence,
  assertProductionHeadlessTerminal,
} from './browser-profiles-evidence.mjs';
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    'window-mode': { type: 'string', default: 'headless' },
  },
});
assert(values.output, '--output required');
assert.equal(values['window-mode'], 'headless');
assert(
  process.argv.filter(
    (arg) => arg === '--window-mode' || arg.startsWith('--window-mode='),
  ).length <= 1,
);
const output = path.resolve(values.output),
  rawPath = `${output}.cold.json`;
const result = {
  schemaVersion: 3,
  kind: 'native-production-headless-capability-v2',
  structuralStatus: 'invalid',
  performanceStatus: 'not-assessable',
  passed: false,
  status: 'unavailable',
  rawPath,
  startedAt: new Date().toISOString(),
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function manifest(directory, prefix = '') {
  const entries = {};
  for (const name of (await readdir(directory)).sort()) {
    const file = path.join(directory, name),
      relative = path.join(prefix, name),
      stat = await lstat(file);
    assert(!stat.isSymbolicLink(), 'Bundle symlink unsupported');
    if (stat.isDirectory())
      Object.assign(entries, await manifest(file, relative));
    else {
      assert(stat.isFile());
      entries[relative] = hash(await readFile(file));
    }
  }
  return entries;
}
await mkdir(path.dirname(output), { recursive: true });
// Exclusive outputs preserve a failed prior attempt; never overwrite/retry it.
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
try {
  await writeFile(rawPath, '', { flag: 'wx' });
  result.bundlesBefore = await manifest(path.join(root, 'out'));
  result.adapter = {
    sourcePath: await realpath(
      new URL(
        './browser-profiles-production-headless-bootstrap.cjs',
        import.meta.url,
      ),
    ),
    sha256: hash(
      await readFile(
        new URL(
          './browser-profiles-production-headless-bootstrap.cjs',
          import.meta.url,
        ),
      ),
    ),
  };
  const originalArgv = [...process.argv];
  try {
    process.argv.splice(
      2,
      Infinity,
      '--mode',
      'cold',
      '--samples',
      '1',
      '--warmups',
      '0',
      '--window-mode',
      'headless',
      '--output',
      rawPath,
    );
    await import('./browser-profiles-supplemental-run.mjs');
  } finally {
    process.argv.splice(0, Infinity, ...originalArgv);
  }
  const raw = JSON.parse(await readFile(rawPath, 'utf8'));
  assert.equal(raw.schemaVersion, 2);
  assertHeadlessStudyMetadata(raw.environment);
  assert.equal(raw.samples.length, 1);
  assert.equal(raw.warmup, null);
  const classification = classifyReleaseReport(
    'cold',
    raw,
    process.exitCode ?? 0,
    RESPONSIVENESS_THRESHOLDS,
  );
  const sample = raw.samples[0];
  assert.deepEqual(
    sample.cold.map(({ record }) => record.owner.taskScope.kind),
    ['cowork_work_entry', 'app_advisor_work_entry'],
  );
  assert(sample.monitoring.length >= 2);
  result.windowEvidence = sample.monitoring.map(
    (entry) => entry.windowEvidence,
  );
  for (const evidence of result.windowEvidence) {
    assertProductionHeadlessEvidence(evidence);
    const adapter = evidence.adapterAtEnd;
    assert.equal(adapter.adapterSha256, result.adapter.sha256);
    assert.equal(
      adapter.productMainSha256,
      result.bundlesBefore['main/index.js'],
    );
    assert.equal(
      adapter.productMainEntryPath,
      await realpath(path.join(root, 'out/main/index.js')),
    );
    const identity = adapter.beforeImport;
    const launch = sample.adapterLaunches.find(
      (entry) => entry.pid === adapter.pid,
    );
    assert(launch, 'Unrecorded native launch');
    assert.deepEqual(
      identity.argv,
      launch.expectedArgv,
      'Native argv differs from complete direct-entry expectation',
    );
    assert.equal(identity.appPath, path.join(root, 'out/main'));
    assert.equal(identity.cwd, root);
    assert.equal(identity.mainDirectory, path.join(root, 'out/main'));
    const resources =
      process.platform === 'darwin'
        ? path.resolve(electronPath, '../../Resources')
        : path.join(path.dirname(electronPath), 'resources');
    assert.equal(identity.resourcesPath, resources);
    assert.equal(
      identity.argv.filter((arg) => arg === adapter.productMainEntryPath)
        .length,
      1,
    );
    assert(
      !identity.argv.some(
        (arg) =>
          arg.startsWith('--headless-') || arg === adapter.launchEntryPath,
      ),
    );
    // The main window loads index.html; App Advisor loads app-advisor.html.
    assert(
      ['index.html', 'app-advisor.html'].some((page) =>
        evidence.atEnd.nativeUrl.startsWith(
          new URL(
            `../renderer/${page}`,
            `file://${adapter.productMainEntryPath}`,
          ).href,
        ),
      ),
    );
  }
  const final = result.windowEvidence.at(-1).adapterAtEnd;
  assert(
    final.windows.length >= 2,
    'Main and App Advisor construction required',
  );
  assert(
    final.windows.every((record) => record.readyToShow >= 1),
    'Real ready-to-show unobserved',
  );
  assert(
    final.calls.some(
      (call) =>
        call.method === 'show' && call.id === result.windowEvidence[0].atEnd.id,
    ),
    'Real production main ready-to-show activation path was not exercised',
  );
  for (const launch of sample.adapterLaunches)
    assertProductionHeadlessTerminal(
      launch.terminalEvidence,
      launch,
      result.windowEvidence.flatMap((evidence) => [
        evidence.adapterAtSetup,
        evidence.adapterAtStart,
        evidence.adapterAtEnd,
      ]),
    );
  result.adapterLaunches = sample.adapterLaunches;
  result.runtime = sample.runtime;
  result.source = raw.source;
  result.environment = raw.environment;
  Object.assign(result, classification);
  result.status = classification.passed ? 'available' : 'performance-failed';
  result.structuralCapability = 'established';
  if (!classification.passed) process.exitCode = 1;
} catch (error) {
  Object.assign(result, {
    status: 'unavailable',
    structuralStatus: 'invalid',
    structuralCapability: 'not-established',
    performanceStatus: 'not-assessable',
    failureClass: 'structural',
    passed: false,
  });
  result.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  try {
    result.bundlesAfter = await manifest(path.join(root, 'out'));
    assert.deepEqual(
      result.bundlesAfter,
      result.bundlesBefore,
      'Product emitted bytes changed or sidecar left behind',
    );
  } catch (error) {
    result.status = 'unavailable';
    result.structuralStatus = 'invalid';
    result.structuralCapability = 'not-established';
    result.performanceStatus = 'not-assessable';
    result.failureClass = 'structural';
    result.passed = false;
    result.bundleError = error.stack ?? String(error);
    process.exitCode = 1;
  }
  result.completedAt = new Date().toISOString();
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
}
