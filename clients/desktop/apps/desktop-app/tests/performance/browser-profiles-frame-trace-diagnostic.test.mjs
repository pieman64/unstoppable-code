import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { create as createTar } from 'tar';
import * as diagnosticCoordinator from './browser-profiles-frame-trace-diagnostic.mjs';
import {
  assertDiagnosticOverlayDelta,
  assertExplicitSourceManifest,
  assertManifestPath,
  assertOwnedChildComplete,
  assertSafeArchiveEntry,
  copyDiagnosticCapsule,
  controlIdentity,
  explicitSourceManifest,
  executeFrameTraceDiagnostic,
  parseFrameTraceDiagnosticOptions,
  productionArchiveExtractionArgs,
  runDiagnosticPair,
  selectDiagnosticPrimaries,
  validateProductionArchive,
  validateDiagnosticReport,
  verifyCopiedCapsule,
} from './browser-profiles-frame-trace-diagnostic.mjs';
import {
  hashFile,
  releaseDriverPrefix,
  withLocalReleaseLease,
} from './browser-profiles-release-ci.mjs';

const execFileAsync = promisify(execFile);

async function fixtureDirectory(name) {
  return mkdtemp(path.join(os.tmpdir(), `frame-trace-${name}-`));
}

function appleDoubleMetadata({ valid = true } = {}) {
  const bytes = Buffer.alloc(163);
  bytes.writeUInt32BE(valid ? 0x00051607 : 0x00051608, 0);
  bytes.writeUInt32BE(0x00020000, 4);
  return bytes;
}

test('frame-trace coordinator accepts only one primary batch and fresh output', () => {
  assert.deepEqual(
    parseFrameTraceDiagnosticOptions([
      '--primary-batch',
      '/evidence/batch.json',
      '--output',
      '/diagnostic/output',
    ]),
    {
      primaryBatch: '/evidence/batch.json',
      output: '/diagnostic/output',
    },
  );
  for (const args of [
    [],
    ['--primary-batch', '/batch'],
    ['--output', '/output'],
    ['--mode', 'common', '--primary-batch', '/batch', '--output', '/output'],
    [
      '--primary-batch',
      '/batch',
      '--primary-batch',
      '/other',
      '--output',
      '/output',
    ],
  ])
    assert.throws(() => parseFrameTraceDiagnosticOptions(args));
});

test('control identity accepts the reviewed clean HEAD and refuses dirty state', () => {
  const execute = (_file, args) =>
    args.includes('rev-parse') ? 'reviewed-fix-head\n' : '';
  assert.deepEqual(controlIdentity('/control', { execute }), {
    commit: 'reviewed-fix-head',
    dirty: false,
  });
  assert.throws(
    () =>
      controlIdentity('/control', {
        execute: (_file, args) =>
          args.includes('rev-parse') ? 'reviewed-fix-head\n' : ' M source\n',
      }),
    /must be clean/,
  );
});

test('physical08 selection requires the exact structurally valid failed warmups', () => {
  const requirements =
    diagnosticCoordinator.diagnosticEvidenceRequirementsForBatchSha256(
      '174c2877510b496477a85d856e0797377d1b7d95953451c55e8748ea2bba10cb',
    );
  const attempt = (stage, ordinal, file, rawSha256) => ({
    stage,
    ordinal,
    mode: 'common',
    phase: 'warmup',
    pair: -1,
    reportPath: `/evidence/${file}`,
    rawSha256,
    verified: true,
    structuralStatus: 'valid',
    performanceStatus: 'failed',
    commandLabel: `${stage}-primary`,
  });
  const batch = {
    schemaVersion: 3,
    protocol: 'same-host-qualification-headless-v4',
    execution: 'local-physical',
    studyWindowMode: 'hidden-native-1400x900-v1',
    windowVisible: false,
    completedAt: '2026-09-16T00:00:00.000Z',
    stages: {
      baseline: { root: '/roots/baseline' },
      candidate: { root: '/roots/candidate' },
    },
    attempts: [
      attempt(
        'baseline',
        0,
        '000-common-baseline-warmup--1.json',
        '0c287bcd36eeea25bd664b52052bc4cf1a255e76f5cfe099abb31112738ffabc',
      ),
      attempt(
        'candidate',
        1,
        '001-common-candidate-warmup--1.json',
        '2a7a2203ea9fe866095912dfbcf1c0c717fb67081c3e9d74f7ad9956f5cb91fc',
      ),
    ],
    commands: ['baseline', 'candidate'].map((stage) => ({
      label: `${stage}-primary`,
      cwd: `/roots/${stage}`,
      command: [
        process.execPath,
        'apps/desktop-app/tests/performance/browser-profiles-release-run.mjs',
      ],
      code: 1,
      timedOut: false,
      interrupted: false,
      descendantsAfterLeaderExit: false,
      cleanup: { groupGone: true, errors: [] },
    })),
  };
  assert.deepEqual(
    Object.keys(selectDiagnosticPrimaries(batch, requirements)),
    ['baseline', 'candidate'],
  );
  for (const mutate of [
    (value) => (value.attempts[0].verified = false),
    (value) => (value.attempts[0].structuralStatus = 'invalid'),
    (value) => (value.attempts[1].performanceStatus = 'passed'),
    (value) => (value.attempts[1].rawSha256 = 'wrong'),
  ]) {
    const changed = structuredClone(batch);
    mutate(changed);
    assert.throws(() => selectDiagnosticPrimaries(changed, requirements));
  }
});

test('compiled evidence profiles admit only the exact physical08 and physical10 batch pins', () => {
  assert.equal(
    typeof diagnosticCoordinator.diagnosticEvidenceRequirementsForBatchSha256,
    'function',
  );
  const physical08 =
    diagnosticCoordinator.diagnosticEvidenceRequirementsForBatchSha256(
      '174c2877510b496477a85d856e0797377d1b7d95953451c55e8748ea2bba10cb',
    );
  assert.equal(
    physical08.products.candidate,
    '826ba53cc178d6d1737a444bea2d45463aea523c',
  );
  assert.equal(Object.keys(physical08.overlay).length, 2);

  const physical10 =
    diagnosticCoordinator.diagnosticEvidenceRequirementsForBatchSha256(
      'de0b1b909a4e13121a7eed560a8d8a6217cd03bf56d98586a7ff9435725bfc8e',
    );
  assert.deepEqual(physical10.primary.baseline, {
    ordinal: 2,
    phase: 'measured',
    pair: 0,
    file: '002-common-baseline-measured-0.json',
    sha256: '9fd1d5fe41e95b4d3f09b9ce463d13734cfcd3e33f6d5fed71c11950ad2fd50e',
  });
  assert.deepEqual(physical10.primary.candidate, {
    ordinal: 1,
    phase: 'warmup',
    pair: -1,
    file: '001-common-candidate-warmup--1.json',
    sha256: '71eb201d2076f55d96e2fc969b8ae4ac18a3d81283d0b9957b69bee74d409c21',
  });
  assert.deepEqual(physical10.overlay, {});
  assert.deepEqual(Object.keys(physical10.retainedDependencies).sort(), [
    'apps/desktop-app/tests/performance/browser-profiles-release-run.mjs',
    'apps/desktop-app/tests/performance/diagnostics.mjs',
    'apps/desktop-app/tests/performance/hotspots.mjs',
    'apps/desktop-app/tests/performance/inspector-client.mjs',
  ]);
  assert.throws(
    () =>
      diagnosticCoordinator.diagnosticEvidenceRequirementsForBatchSha256(
        'unknown',
      ),
    /recognized retained batch/,
  );
});

test('physical10 selection requires the exact measured baseline and warmup candidate failures', () => {
  const requirements = {
    ...diagnosticCoordinator.diagnosticEvidenceRequirementsForBatchSha256(
      'de0b1b909a4e13121a7eed560a8d8a6217cd03bf56d98586a7ff9435725bfc8e',
    ),
  };
  const attempt = (stage, required) => ({
    stage,
    ordinal: required.ordinal,
    mode: 'common',
    phase: required.phase,
    pair: required.pair,
    reportPath: `/evidence/${required.file}`,
    rawSha256: required.sha256,
    verified: true,
    structuralStatus: 'valid',
    performanceStatus: 'failed',
    commandLabel: `${stage}-primary`,
  });
  const batch = {
    schemaVersion: 3,
    protocol: 'same-host-qualification-headless-v4',
    execution: 'local-physical',
    studyWindowMode: 'hidden-native-1400x900-v1',
    windowVisible: false,
    completedAt: '2026-09-16T00:00:00.000Z',
    stages: {
      baseline: { root: '/roots/baseline' },
      candidate: { root: '/roots/candidate' },
    },
    attempts: [
      attempt('baseline', requirements.primary.baseline),
      attempt('candidate', requirements.primary.candidate),
    ],
    commands: ['baseline', 'candidate'].map((stage) => ({
      label: `${stage}-primary`,
      cwd: `/roots/${stage}`,
      command: [
        process.execPath,
        'apps/desktop-app/tests/performance/browser-profiles-release-run.mjs',
      ],
      code: 1,
      timedOut: false,
      interrupted: false,
      descendantsAfterLeaderExit: false,
      cleanup: { groupGone: true, errors: [] },
    })),
  };
  assert.deepEqual(
    Object.keys(selectDiagnosticPrimaries(batch, requirements)),
    ['baseline', 'candidate'],
  );
  for (const mutate of [
    (value) => (value.attempts[0].phase = 'warmup'),
    (value) => (value.attempts[0].pair = -1),
    (value) => (value.attempts[1].performanceStatus = 'passed'),
    (value) => (value.attempts[1].rawSha256 = 'tampered'),
  ]) {
    const changed = structuredClone(batch);
    mutate(changed);
    assert.throws(() => selectDiagnosticPrimaries(changed, requirements));
  }
});

test('Git-less explicit manifests hash files and preserve symlink text', async () => {
  const root = await fixtureDirectory('manifest');
  try {
    await writeFile(path.join(root, 'file.txt'), 'content');
    await symlink('file.txt', path.join(root, 'link.txt'));
    const retained = {
      'file.txt': await hashFile(path.join(root, 'file.txt')),
      'link.txt': { symlink: 'file.txt' },
    };
    assert.deepEqual(await explicitSourceManifest(root, retained), retained);
    assert.deepEqual(
      await assertExplicitSourceManifest(root, retained),
      retained,
    );
    await writeFile(path.join(root, 'file.txt'), 'changed');
    await assert.rejects(assertExplicitSourceManifest(root, retained));
    for (const invalid of ['', '..', '../escape', '/absolute', 'a/../b'])
      assert.throws(() => assertManifestPath(invalid));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capsule copy excludes mutable outputs, preserves relative links, and never hardlinks', async () => {
  const parent = await fixtureDirectory('copy');
  const original = path.join(parent, 'original');
  const capsule = path.join(parent, 'capsule');
  try {
    await mkdir(path.join(original, '.git'), { recursive: true });
    await mkdir(path.join(original, '.playwright'), { recursive: true });
    await mkdir(path.join(original, 'out'), { recursive: true });
    await mkdir(path.join(original, 'source'), { recursive: true });
    await writeFile(path.join(original, '.git', 'index'), 'excluded');
    await writeFile(path.join(original, '.playwright', 'result'), 'excluded');
    await writeFile(path.join(original, 'out', 'main.js'), 'excluded');
    await writeFile(path.join(original, 'source', 'file.js'), 'included');
    await symlink('file.js', path.join(original, 'source', 'link.js'));
    let options;
    await copyDiagnosticCapsule(original, capsule, {
      copy: async (source, destination, received) => {
        options = received;
        await cp(source, destination, {
          ...received,
          mode: fsConstants.COPYFILE_EXCL,
        });
      },
    });
    assert.equal(options.dereference, false);
    assert.equal(options.verbatimSymlinks, true);
    assert.equal(
      await readFile(path.join(capsule, 'source', 'file.js'), 'utf8'),
      'included',
    );
    assert.equal(
      await readlink(path.join(capsule, 'source', 'link.js')),
      'file.js',
    );
    await assert.rejects(lstat(path.join(capsule, '.git')));
    await assert.rejects(lstat(path.join(capsule, '.playwright')));
    await assert.rejects(lstat(path.join(capsule, 'out')));
    const sourceInfo = await lstat(path.join(original, 'source', 'file.js'));
    const copyInfo = await lstat(path.join(capsule, 'source', 'file.js'));
    assert(sourceInfo.dev !== copyInfo.dev || sourceInfo.ino !== copyInfo.ino);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('capsule verification rejects absolute and escaping symlinks', async () => {
  const parent = await fixtureDirectory('links');
  const original = path.join(parent, 'original');
  const capsule = path.join(parent, 'capsule');
  try {
    await mkdir(original);
    await mkdir(capsule);
    for (const target of ['/tmp/absolute', '../escape']) {
      const link = path.join(
        capsule,
        target.startsWith('/') ? 'absolute' : 'escape',
      );
      await symlink(target, link);
      await assert.rejects(verifyCopiedCapsule(original, capsule));
      await rm(link);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('archive admission accepts only ordinary entries below out', async () => {
  assert.equal(
    assertSafeArchiveEntry({ path: 'out/main/index.js', type: 'File' }),
    'out/main/index.js',
  );
  for (const entry of [
    { path: '/out/file', type: 'File' },
    { path: '../out/file', type: 'File' },
    { path: 'out/a/../file', type: 'File' },
    { path: 'other/file', type: 'File' },
    { path: 'out/link', type: 'SymbolicLink' },
    { path: 'out/hard', type: 'Link' },
    { path: 'out/device', type: 'CharacterDevice' },
    { path: 'out/fifo', type: 'FIFO' },
  ])
    assert.throws(() => assertSafeArchiveEntry(entry));

  const root = await fixtureDirectory('archive');
  try {
    await mkdir(path.join(root, 'out'));
    await writeFile(path.join(root, 'out', 'file'), 'archive');
    const archive = path.join(root, 'out.tar.gz');
    await createTar({ cwd: root, gzip: true, file: archive }, ['out']);
    assert((await validateProductionArchive(archive)).includes('out/file'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('archive validation admits corresponding AppleDouble metadata and ordinary payload', async () => {
  const root = await fixtureDirectory('archive-appledouble');
  const staging = path.join(root, 'staging');
  const archive = path.join(root, 'out.tar.gz');
  try {
    await mkdir(path.join(staging, 'out'), { recursive: true });
    await writeFile(path.join(staging, '._out'), appleDoubleMetadata());
    await writeFile(
      path.join(staging, 'out', '._app.js'),
      appleDoubleMetadata(),
    );
    await writeFile(path.join(staging, 'out', 'app.js'), 'payload\n');
    await createTar({ cwd: staging, gzip: true, file: archive }, [
      '._out',
      'out',
    ]);

    const entries = await validateProductionArchive(archive);
    assert(entries.includes('out'));
    assert(entries.includes('out/app.js'));
    assert(
      !entries.some((entry) => path.posix.basename(entry).startsWith('._')),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('archive validation rejects malformed metadata and unsupported root payload', async () => {
  const root = await fixtureDirectory('archive-invalid-metadata');
  try {
    for (const fixture of [
      {
        name: 'malformed',
        files: [
          ['._out', appleDoubleMetadata({ valid: false })],
          ['out/app.js', 'payload\n'],
        ],
        members: ['._out', 'out'],
        error: /AppleDouble signature\/version/,
      },
      {
        name: 'root-payload',
        files: [
          ['outside.txt', 'unsupported\n'],
          ['out/app.js', 'payload\n'],
        ],
        members: ['outside.txt', 'out'],
        error: /outside out/,
      },
    ]) {
      const staging = path.join(root, fixture.name);
      for (const [relative, bytes] of fixture.files) {
        const file = path.join(staging, relative);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, bytes);
      }
      const archive = path.join(root, `${fixture.name}.tar.gz`);
      await createTar(
        { cwd: staging, gzip: true, file: archive },
        fixture.members,
      );
      await assert.rejects(validateProductionArchive(archive), fixture.error);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('production archive extraction uses the macOS metadata flag only with BSD tar', () => {
  const linux = productionArchiveExtractionArgs(
    '/evidence/baseline.tar.gz',
    '/capsule',
    'linux',
  );
  const darwin = productionArchiveExtractionArgs(
    '/evidence/baseline.tar.gz',
    '/capsule',
    'darwin',
  );
  assert(!linux.includes('--no-mac-metadata'));
  assert(darwin.includes('--no-mac-metadata'));
});

test('archive validation rejects metadata-only archives', async () => {
  const root = await fixtureDirectory('archive-metadata-only');
  const staging = path.join(root, 'staging');
  const archive = path.join(root, 'out.tar.gz');
  try {
    await mkdir(staging);
    await writeFile(path.join(staging, '._out'), appleDoubleMetadata());
    await createTar({ cwd: staging, gzip: true, file: archive }, ['._out']);
    await assert.rejects(
      validateProductionArchive(archive),
      /ordinary out payload/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('archive validation rejects traversal and link entries from real archives', async () => {
  const root = await fixtureDirectory('archive-unsafe-entries');
  try {
    const traversalRoot = path.join(root, 'traversal');
    await mkdir(path.join(traversalRoot, 'out'), { recursive: true });
    await writeFile(path.join(traversalRoot, 'out', 'app.js'), 'payload\n');
    const traversalArchive = path.join(root, 'traversal.tar.gz');
    await createTar(
      {
        cwd: traversalRoot,
        gzip: true,
        file: traversalArchive,
        prefix: '../escape',
      },
      ['out'],
    );
    await assert.rejects(
      validateProductionArchive(traversalArchive),
      /Archive traversal/,
    );

    const linkRoot = path.join(root, 'link');
    await mkdir(path.join(linkRoot, 'out'), { recursive: true });
    await writeFile(path.join(linkRoot, 'out', 'app.js'), 'payload\n');
    await symlink('app.js', path.join(linkRoot, 'out', 'link.js'));
    const linkArchive = path.join(root, 'link.tar.gz');
    await createTar({ cwd: linkRoot, gzip: true, file: linkArchive }, ['out']);
    await assert.rejects(validateProductionArchive(linkArchive), /entry type/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('archive validation failure rejects normally and runs caller cleanup', async () => {
  const root = await fixtureDirectory('archive-async-rejection');
  const staging = path.join(root, 'staging');
  const archive = path.join(root, 'out.tar.gz');
  try {
    await mkdir(staging);
    await writeFile(path.join(staging, 'outside.txt'), 'unsupported\n');
    await createTar({ cwd: staging, gzip: true, file: archive }, [
      'outside.txt',
    ]);
    const moduleUrl = new URL(
      './browser-profiles-frame-trace-diagnostic.mjs',
      import.meta.url,
    ).href;
    const child = await execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      `import { validateProductionArchive } from ${JSON.stringify(moduleUrl)};
let rejected = false;
let cleaned = false;
try {
  await validateProductionArchive(${JSON.stringify(archive)});
} catch (error) {
  rejected = /outside out/.test(String(error));
} finally {
  cleaned = true;
}
if (!rejected || !cleaned) process.exitCode = 2;
console.log(JSON.stringify({ rejected, cleaned }));`,
    ]);
    assert.deepEqual(JSON.parse(child.stdout), {
      rejected: true,
      cleaned: true,
    });
    assert.equal(child.stderr, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('diagnostic overlay admits exactly the two pinned paths', () => {
  const runner =
    'apps/desktop-app/tests/performance/browser-profiles-release-run.mjs';
  const diagnostics = 'apps/desktop-app/tests/performance/diagnostics.mjs';
  const overlay = {
    [runner]: { preimage: 'runner-before', installed: 'runner-after' },
    [diagnostics]: {
      preimage: 'diagnostics-before',
      installed: 'diagnostics-after',
    },
  };
  const before = {
    unchanged: 'same',
    [runner]: 'runner-before',
    [diagnostics]: 'diagnostics-before',
  };
  const after = {
    unchanged: 'same',
    [runner]: 'runner-after',
    [diagnostics]: 'diagnostics-after',
  };
  assert.deepEqual(
    assertDiagnosticOverlayDelta(before, after, overlay),
    [runner, diagnostics].sort(),
  );
  assert.throws(() =>
    assertDiagnosticOverlayDelta(
      before,
      { ...after, third: 'changed' },
      overlay,
    ),
  );
  assert.throws(() =>
    assertDiagnosticOverlayDelta(
      { ...before, [runner]: 'wrong' },
      after,
      overlay,
    ),
  );
  assert.deepEqual(
    assertDiagnosticOverlayDelta(
      { unchanged: 'same' },
      { unchanged: 'same' },
      {},
    ),
    [],
  );
  assert.throws(() =>
    assertDiagnosticOverlayDelta(
      { unchanged: 'same' },
      { unchanged: 'changed' },
      {},
    ),
  );
});

test('diagnostic report validator rejects canonical fields and partial results', async () => {
  const root = await fixtureDirectory('report');
  const file = path.join(root, 'diagnostic.json');
  const report = {
    schemaVersion: 1,
    kind: 'browser-profile-common-frame-trace-diagnostic-v1',
    diagnosticOnly: true,
    acceptanceEligible: false,
    populationContribution: 0,
    thresholdsApplied: false,
    observation: { status: 'ok', attempts: [{ status: 'ok' }] },
  };
  try {
    await writeFile(file, JSON.stringify(report));
    assert.equal((await validateDiagnosticReport(file)).kind, report.kind);
    await writeFile(
      file,
      JSON.stringify({ ...report, benchmarkKind: 'release-like' }),
    );
    await assert.rejects(validateDiagnosticReport(file));
    await writeFile(
      file,
      JSON.stringify({
        ...report,
        observation: { status: 'partial', attempts: [{ status: 'partial' }] },
      }),
    );
    await assert.rejects(validateDiagnosticReport(file));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function tinyBundleManifest(root) {
  return { 'app.js': await hashFile(path.join(root, 'app.js')) };
}

const PHYSICAL10_RETAINED_DEPENDENCIES = [
  'apps/desktop-app/tests/performance/browser-profiles-release-run.mjs',
  'apps/desktop-app/tests/performance/diagnostics.mjs',
  'apps/desktop-app/tests/performance/inspector-client.mjs',
  'apps/desktop-app/tests/performance/hotspots.mjs',
];
const RETAINED_SOURCE_FIXTURE = {
  [PHYSICAL10_RETAINED_DEPENDENCIES[0]]: 'retained runner\n',
  [PHYSICAL10_RETAINED_DEPENDENCIES[1]]: 'retained diagnostics\n',
  [PHYSICAL10_RETAINED_DEPENDENCIES[2]]: 'retained inspector\n',
  [PHYSICAL10_RETAINED_DEPENDENCIES[3]]: 'retained hotspots\n',
  'apps/desktop-app/tests/electron/launchCanopy.mjs':
    'retained unpinned launch helper\n',
};

async function createEntrypointFixture(name, { physical10 = false } = {}) {
  const root = await fixtureDirectory(name);
  const evidence = path.join(root, 'evidence');
  const outputParent = path.join(root, 'diagnostics');
  await mkdir(evidence);
  await mkdir(outputParent);
  const stages = {};
  const retainedByRoot = new Map();
  const overlay = {};
  const overlayFiles = physical10
    ? []
    : [
        'apps/desktop-app/tests/performance/browser-profiles-release-run.mjs',
        'apps/desktop-app/tests/performance/diagnostics.mjs',
      ];
  const primaryShape = physical10
    ? {
        baseline: {
          ordinal: 2,
          phase: 'measured',
          pair: 0,
          file: '002-common-baseline-measured-0.json',
        },
        candidate: {
          ordinal: 1,
          phase: 'warmup',
          pair: -1,
          file: '001-common-candidate-warmup--1.json',
        },
      }
    : {
        baseline: {
          ordinal: 0,
          phase: 'warmup',
          pair: -1,
          file: '000-common-baseline-warmup--1.json',
        },
        candidate: {
          ordinal: 1,
          phase: 'warmup',
          pair: -1,
          file: '001-common-candidate-warmup--1.json',
        },
      };
  for (const relative of overlayFiles)
    overlay[relative] = {
      installed: await hashFile(path.resolve(relative)),
    };
  for (const stage of ['baseline', 'candidate']) {
    const stageRoot = path.join(root, `${stage}-root`);
    await mkdir(stageRoot);
    const files = RETAINED_SOURCE_FIXTURE;
    for (const [relative, bytes] of Object.entries(files)) {
      const file = path.join(stageRoot, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
    }
    const retained = Object.fromEntries(
      await Promise.all(
        Object.keys(files).map(async (relative) => [
          relative,
          await hashFile(path.join(stageRoot, relative)),
        ]),
      ),
    );
    retainedByRoot.set(stageRoot, retained);
    for (const relative of overlayFiles)
      overlay[relative].preimage ??= retained[relative];
    await writeFile(
      path.join(stageRoot, 'package-lock.json'),
      'fixture lock\n',
    );
    await mkdir(path.join(stageRoot, '.cache'));
    for (const [relative, version] of [
      ['node_modules/electron/package.json', '42.3.0'],
      ['node_modules/@playwright/test/package.json', '1.58.2'],
      ['node_modules/tsx/package.json', '4.21.0'],
    ]) {
      const file = path.join(stageRoot, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ version }));
    }
    const electron = path.join(
      stageRoot,
      'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    );
    await mkdir(path.dirname(electron), { recursive: true });
    await writeFile(electron, 'fixture electron\n');

    const archiveRoot = path.join(root, `${stage}-archive`);
    await mkdir(path.join(archiveRoot, 'out'), { recursive: true });
    await writeFile(path.join(archiveRoot, '._out'), appleDoubleMetadata());
    await writeFile(
      path.join(archiveRoot, 'out', '._app.js'),
      appleDoubleMetadata(),
    );
    await writeFile(path.join(archiveRoot, 'out', 'app.js'), 'bundle\n');
    await mkdir(path.join(stageRoot, 'out'));
    await writeFile(path.join(stageRoot, 'out', 'app.js'), 'bundle\n');
    const archivePath = path.join(evidence, `${stage}-out.tar.gz`);
    await createTar({ cwd: archiveRoot, gzip: true, file: archivePath }, [
      '._out',
      'out',
    ]);
    const bundles = await tinyBundleManifest(path.join(archiveRoot, 'out'));
    const sourceFile = path.join(evidence, `${stage}-immutable-source.json`);
    const bundleFile = path.join(evidence, `${stage}-bundle-manifest.json`);
    await writeFile(sourceFile, JSON.stringify(retained));
    await writeFile(bundleFile, JSON.stringify(bundles));
    const reportPath = path.join(evidence, primaryShape[stage].file);
    await writeFile(reportPath, JSON.stringify({ stage, failed: true }));
    stages[stage] = {
      root: stageRoot,
      commit: `${stage}-product`,
      lockfileSha256: await hashFile(path.join(stageRoot, 'package-lock.json')),
      productionArchive: {
        path: archivePath,
        sha256: await hashFile(archivePath),
      },
      bundles,
      retained,
      sourceFile,
      bundleFile,
      reportPath,
    };
  }
  const primary = Object.fromEntries(
    await Promise.all(
      ['baseline', 'candidate'].map(async (stage) => [
        stage,
        {
          ordinal: primaryShape[stage].ordinal,
          ...(physical10
            ? {
                phase: primaryShape[stage].phase,
                pair: primaryShape[stage].pair,
              }
            : {}),
          file: path.basename(stages[stage].reportPath),
          sha256: await hashFile(stages[stage].reportPath),
        },
      ]),
    ),
  );
  const batch = {
    schemaVersion: 3,
    protocol: 'same-host-qualification-headless-v4',
    execution: 'local-physical',
    studyWindowMode: 'hidden-native-1400x900-v1',
    windowVisible: false,
    completedAt: '2026-09-16T00:00:00.000Z',
    stages: Object.fromEntries(
      ['baseline', 'candidate'].map((stage) => [
        stage,
        {
          root: stages[stage].root,
          commit: stages[stage].commit,
          lockfileSha256: stages[stage].lockfileSha256,
          productionArchive: stages[stage].productionArchive,
          bundles: stages[stage].bundles,
        },
      ]),
    ),
    attempts: ['baseline', 'candidate'].map((stage) => ({
      stage,
      ordinal: primaryShape[stage].ordinal,
      mode: 'common',
      phase: primaryShape[stage].phase,
      pair: primaryShape[stage].pair,
      reportPath: stages[stage].reportPath,
      rawSha256: primary[stage].sha256,
      verified: true,
      structuralStatus: 'valid',
      performanceStatus: 'failed',
      commandLabel: `${stage}-primary`,
    })),
    commands: ['baseline', 'candidate'].map((stage) => ({
      label: `${stage}-primary`,
      cwd: stages[stage].root,
      command: [
        process.execPath,
        'apps/desktop-app/tests/performance/browser-profiles-release-run.mjs',
      ],
      code: 1,
      timedOut: false,
      interrupted: false,
      descendantsAfterLeaderExit: false,
      cleanup: { groupGone: true, errors: [] },
    })),
  };
  const batchPath = path.join(evidence, 'batch.json');
  await writeFile(batchPath, JSON.stringify(batch));
  const overlayManifest = path.join(evidence, 'overlay-manifest.json');
  await writeFile(overlayManifest, JSON.stringify({ fixture: true }));
  const artifacts = {
    'batch.json': await hashFile(batchPath),
  };
  for (const stage of ['baseline', 'candidate']) {
    for (const file of [
      stages[stage].productionArchive.path,
      stages[stage].sourceFile,
      stages[stage].bundleFile,
    ])
      artifacts[path.basename(file)] = await hashFile(file);
  }
  const artifactPath = path.join(evidence, 'artifact-manifest.json');
  await writeFile(artifactPath, JSON.stringify(artifacts));
  const active = { value: false, phases: [] };
  const safeOutcome = {
    code: 0,
    timedOut: false,
    interrupted: false,
    descendantsAfterLeaderExit: false,
    cleanup: { groupGone: true, errors: [] },
  };
  const requirements = {
    batchSha256: artifacts['batch.json'],
    artifactManifestSha256: await hashFile(artifactPath),
    overlayManifestSha256: await hashFile(overlayManifest),
    products: { baseline: 'baseline-product', candidate: 'candidate-product' },
    primary,
    immutableSourceSha256: {
      baseline: artifacts['baseline-immutable-source.json'],
      candidate: artifacts['candidate-immutable-source.json'],
    },
    retainedDependencies: Object.fromEntries(
      (physical10
        ? PHYSICAL10_RETAINED_DEPENDENCIES
        : [
            'apps/desktop-app/tests/performance/inspector-client.mjs',
            'apps/desktop-app/tests/performance/hotspots.mjs',
          ]
      ).map((relative) => [relative, stages.baseline.retained[relative]]),
    ),
    overlay,
  };
  const dependencies = {
    requirements,
    controlIdentity: () => {
      assert(active.value, 'lease must cover control identity');
      active.phases.push('control');
      return { commit: 'fixture-control', dirty: false };
    },
    sourceManifest: async (stageRoot) => {
      assert(active.value, 'lease must cover source admission/preservation');
      active.phases.push('source');
      return explicitSourceManifest(stageRoot, retainedByRoot.get(stageRoot));
    },
    manifest: async (out) => {
      assert(active.value, 'lease must cover bundle admission/preservation');
      active.phases.push('bundle');
      return tinyBundleManifest(out);
    },
    runCommandProcess: async (vector) => {
      assert(active.value, 'lease must cover extraction/dispatch');
      if (vector.executable === '/usr/bin/tar') {
        active.phases.push('extract');
        await execFileAsync(vector.executable, vector.args, {
          cwd: vector.cwd,
          env: vector.env,
          timeout: vector.timeoutMs,
        });
        return safeOutcome;
      } else {
        active.phases.push(`dispatch:${path.basename(vector.cwd)}`);
        const resultPath = vector.args[vector.args.indexOf('--output') + 1];
        await writeFile(
          resultPath,
          JSON.stringify({
            schemaVersion: 1,
            kind: 'browser-profile-common-frame-trace-diagnostic-v1',
            diagnosticOnly: true,
            acceptanceEligible: false,
            populationContribution: 0,
            thresholdsApplied: false,
            observation: { status: 'ok', attempts: [{ status: 'ok' }] },
          }),
        );
      }
      return safeOutcome;
    },
  };
  return {
    root,
    evidence,
    batchPath,
    outputParent,
    stages,
    active,
    requirements,
    dependencies,
    retainedByRoot,
  };
}

async function assertPhysical10FixtureIntegrity(fixture) {
  assert.deepEqual(
    Object.keys(fixture.requirements.retainedDependencies),
    PHYSICAL10_RETAINED_DEPENDENCIES,
  );
  for (const stage of ['baseline', 'candidate']) {
    await assert.rejects(
      lstat(path.join(fixture.stages[stage].root, 'undefined')),
    );
    for (const relative of PHYSICAL10_RETAINED_DEPENDENCIES) {
      const expected = fixture.requirements.retainedDependencies[relative];
      assert.equal(typeof expected, 'string', `${relative} must have a hash`);
      assert.match(expected, /^[a-f0-9]{64}$/);
      assert.equal(
        await hashFile(path.join(fixture.stages[stage].root, relative)),
        expected,
      );
      assert.equal(fixture.stages[stage].retained[relative], expected);
    }
  }
}

test('physical10 fixture retains four real dependency files with exact string hashes', async () => {
  const fixture = await createEntrypointFixture('physical10-integrity', {
    physical10: true,
  });
  try {
    await assertPhysical10FixtureIntegrity(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('actual coordinator entrypoint owns admission through final retention', async () => {
  const fixture = await createEntrypointFixture('entrypoint');
  const output = path.join(fixture.outputParent, 'pair');
  let released = 0;
  try {
    await withLocalReleaseLease(
      async (owner) => {
        fixture.active.value = true;
        const result = await executeFrameTraceDiagnostic(
          { primaryBatch: fixture.batchPath, output },
          undefined,
          owner,
          fixture.dependencies,
        );
        assert.equal(result.status, 'completed');
      },
      {
        acquire: async () => ({
          ciBypass: false,
          memory: { skipped: false },
          lease: {
            metadata: {},
            release: async () => {
              fixture.active.value = false;
              released++;
            },
          },
        }),
      },
    );
    assert.equal(released, 1);
    assert.deepEqual(
      fixture.active.phases.filter((phase) => phase.startsWith('dispatch:')),
      ['dispatch:baseline', 'dispatch:candidate'],
    );
    assert(fixture.active.phases.includes('extract'));
    const pair = JSON.parse(await readFile(path.join(output, 'pair.json')));
    assert.equal(pair.status, 'completed');
    assert.equal(Object.hasOwn(pair, 'hostActivity'), false);
    assert(pair.preservationGates.length >= 4);
    for (const stage of ['baseline', 'candidate']) {
      const capsule = path.join(output, 'stages', stage);
      await assert.rejects(lstat(path.join(capsule, '._out')));
      await assert.rejects(lstat(path.join(capsule, 'out', '._app.js')));
      assert.equal(
        await readFile(path.join(capsule, 'out', 'app.js'), 'utf8'),
        'bundle\n',
      );
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('actual coordinator retains injected preflight and boundary observations in order', async () => {
  const fixture = await createEntrypointFixture('host-activity-hooks');
  const output = path.join(fixture.outputParent, 'pair');
  const order = [];
  const hostActivity = {
    schemaVersion: 1,
    policy: 'fixture',
    diagnosticOnly: true,
    acceptanceEligible: false,
    populationContribution: 0,
    preflight: { admitted: true, samples: ['fixture'] },
    boundaries: [],
    foreignActivityObserved: false,
    observationGap: false,
  };
  try {
    fixture.active.value = true;
    const result = await withLocalReleaseLease(
      (owner) =>
        executeFrameTraceDiagnostic(
          { primaryBatch: fixture.batchPath, output },
          undefined,
          owner,
          {
            ...fixture.dependencies,
            beforeFirstDispatch: async () => {
              order.push('preflight');
              return hostActivity;
            },
            afterAttempt: async ({ stage }) => {
              order.push('after-' + stage.stage);
              return {
                ...hostActivity,
                boundaries: [...hostActivity.boundaries, { name: stage.stage }],
              };
            },
          },
        ),
      {
        acquire: async () => ({
          ciBypass: false,
          memory: { skipped: false },
          lease: { metadata: {}, release: async () => {} },
        }),
      },
    );
    assert.equal(result.status, 'completed');
    assert.deepEqual(order, ['preflight', 'after-baseline', 'after-candidate']);
    assert.deepEqual(
      fixture.active.phases.filter((phase) => phase.startsWith('dispatch:')),
      ['dispatch:baseline', 'dispatch:candidate'],
    );
    const pair = JSON.parse(await readFile(path.join(output, 'pair.json')));
    assert.deepEqual(pair.hostActivity.boundaries, [{ name: 'candidate' }]);
  } finally {
    fixture.active.value = false;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('actual coordinator retains a rejected preflight before either dispatch', async () => {
  const fixture = await createEntrypointFixture('host-activity-deny');
  const output = path.join(fixture.outputParent, 'pair');
  try {
    fixture.active.value = true;
    await assert.rejects(
      withLocalReleaseLease(
        (owner) =>
          executeFrameTraceDiagnostic(
            { primaryBatch: fixture.batchPath, output },
            undefined,
            owner,
            {
              ...fixture.dependencies,
              beforeFirstDispatch: async () => {
                const error = new Error('fixture preflight denied');
                error.hostActivity = {
                  schemaVersion: 1,
                  preflight: { admitted: false, rejection: 'fixture' },
                  observationGap: false,
                };
                throw error;
              },
            },
          ),
        {
          acquire: async () => ({
            ciBypass: false,
            memory: { skipped: false },
            lease: { metadata: {}, release: async () => {} },
          }),
        },
      ),
      /fixture preflight denied/,
    );
    assert.deepEqual(
      fixture.active.phases.filter((phase) => phase.startsWith('dispatch:')),
      [],
    );
    const pair = JSON.parse(await readFile(path.join(output, 'pair.json')));
    assert.equal(pair.hostActivity.preflight.admitted, false);
    assert.equal(pair.status, 'failed');
  } finally {
    fixture.active.value = false;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('actual coordinator retains observer gaps without suppressing an eligible candidate', async () => {
  const fixture = await createEntrypointFixture('host-activity-gap');
  const output = path.join(fixture.outputParent, 'pair');
  try {
    fixture.active.value = true;
    await withLocalReleaseLease(
      (owner) =>
        executeFrameTraceDiagnostic(
          { primaryBatch: fixture.batchPath, output },
          undefined,
          owner,
          {
            ...fixture.dependencies,
            beforeFirstDispatch: async () => ({
              schemaVersion: 1,
              preflight: { admitted: true },
            }),
            afterAttempt: async ({ stage }) => {
              if (stage.stage === 'baseline')
                throw new Error('fixture observer unavailable');
              return {
                schemaVersion: 1,
                preflight: { admitted: true },
                boundaries: [{ name: 'candidate' }],
              };
            },
          },
        ),
      {
        acquire: async () => ({
          ciBypass: false,
          memory: { skipped: false },
          lease: { metadata: {}, release: async () => {} },
        }),
      },
    );
    assert.deepEqual(
      fixture.active.phases.filter((phase) => phase.startsWith('dispatch:')),
      ['dispatch:baseline', 'dispatch:candidate'],
    );
    const pair = JSON.parse(await readFile(path.join(output, 'pair.json')));
    assert.equal(pair.hostActivity.observationGap, true);
    assert.deepEqual(pair.hostActivity.boundaries, [{ name: 'candidate' }]);
  } finally {
    fixture.active.value = false;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('actual coordinator executes the physical10 measured/warmup pair with zero overlay', async () => {
  const fixture = await createEntrypointFixture('physical10-entrypoint', {
    physical10: true,
  });
  const output = path.join(fixture.outputParent, 'pair');
  try {
    await assertPhysical10FixtureIntegrity(fixture);
    await withLocalReleaseLease(
      async (owner) => {
        fixture.active.value = true;
        const result = await executeFrameTraceDiagnostic(
          { primaryBatch: fixture.batchPath, output },
          undefined,
          owner,
          fixture.dependencies,
        );
        assert.equal(result.status, 'completed');
      },
      {
        acquire: async () => ({
          ciBypass: false,
          memory: { skipped: false },
          lease: {
            metadata: {},
            release: async () => {
              fixture.active.value = false;
            },
          },
        }),
      },
    );
    assert.deepEqual(
      fixture.active.phases.filter((phase) => phase.startsWith('dispatch:')),
      ['dispatch:baseline', 'dispatch:candidate'],
    );
    const pair = JSON.parse(await readFile(path.join(output, 'pair.json')));
    assert.deepEqual(
      pair.products.baseline.primary,
      fixture.requirements.primary.baseline,
    );
    assert.deepEqual(
      pair.products.candidate.primary,
      fixture.requirements.primary.candidate,
    );
    assert.deepEqual(pair.diagnosticHarness.overlay, {});
    for (const stage of ['baseline', 'candidate']) {
      const before = JSON.parse(
        await readFile(
          path.join(output, `${stage}-source-before-overlay.json`),
        ),
      );
      const after = JSON.parse(
        await readFile(path.join(output, `${stage}-source-after-overlay.json`)),
      );
      assert.deepEqual(after, before);
      for (const relative of PHYSICAL10_RETAINED_DEPENDENCIES)
        assert.equal(
          await hashFile(path.join(output, 'stages', stage, relative)),
          fixture.requirements.retainedDependencies[relative],
        );
    }
  } finally {
    fixture.active.value = false;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('actual coordinator resolves the no-requirements path from the observed batch hash', async () => {
  const fixture = await createEntrypointFixture('observed-batch-profile', {
    physical10: true,
  });
  const output = path.join(fixture.outputParent, 'pair');
  const observed = [];
  const dependencies = {
    ...fixture.dependencies,
    requirements: undefined,
    resolveRequirements: (batchSha256) => {
      observed.push(batchSha256);
      return fixture.requirements;
    },
  };
  try {
    await withLocalReleaseLease(
      async (owner) => {
        fixture.active.value = true;
        const result = await executeFrameTraceDiagnostic(
          { primaryBatch: fixture.batchPath, output },
          undefined,
          owner,
          dependencies,
        );
        assert.equal(result.status, 'completed');
      },
      {
        acquire: async () => ({
          ciBypass: false,
          memory: { skipped: false },
          lease: {
            metadata: {},
            release: async () => {
              fixture.active.value = false;
            },
          },
        }),
      },
    );
    assert.deepEqual(observed, [await hashFile(fixture.batchPath)]);
    assert.deepEqual(
      fixture.active.phases.filter((phase) => phase.startsWith('dispatch:')),
      ['dispatch:baseline', 'dispatch:candidate'],
    );
  } finally {
    fixture.active.value = false;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('actual coordinator rejects a tampered physical10 primary pin before child work', async () => {
  const fixture = await createEntrypointFixture('physical10-tampered-pin', {
    physical10: true,
  });
  let childCalls = 0;
  fixture.dependencies.runCommandProcess = async () => {
    childCalls++;
    assert.fail('tampered evidence must fail before native work');
  };
  fixture.dependencies.requirements = {
    ...fixture.requirements,
    primary: {
      ...fixture.requirements.primary,
      baseline: {
        ...fixture.requirements.primary.baseline,
        sha256: 'tampered',
      },
    },
  };
  try {
    fixture.active.value = true;
    await assert.rejects(
      executeFrameTraceDiagnostic(
        {
          primaryBatch: fixture.batchPath,
          output: path.join(fixture.outputParent, 'pair'),
        },
        undefined,
        { active: true },
        fixture.dependencies,
      ),
      /raw report hash changed/,
    );
    assert.equal(childCalls, 0);
  } finally {
    fixture.active.value = false;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('actual coordinator rejects physical10 retained dependency drift before child work', async () => {
  const fixture = await createEntrypointFixture(
    'physical10-retained-dependency-drift',
    { physical10: true },
  );
  const output = path.join(fixture.outputParent, 'pair');
  let childCalls = 0;
  fixture.dependencies.runCommandProcess = async () => {
    childCalls++;
    assert.fail('retained dependency drift must fail before child work');
  };
  try {
    await assertPhysical10FixtureIntegrity(fixture);
    await writeFile(
      path.join(
        fixture.stages.baseline.root,
        PHYSICAL10_RETAINED_DEPENDENCIES[0],
      ),
      'drifted retained runner\n',
    );
    fixture.active.value = true;
    await assert.rejects(
      executeFrameTraceDiagnostic(
        { primaryBatch: fixture.batchPath, output },
        undefined,
        { active: true },
        fixture.dependencies,
      ),
      /deep-equal|manifest changed/i,
    );
    assert.equal(childCalls, 0);
    await assert.rejects(lstat(output));
  } finally {
    fixture.active.value = false;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('actual coordinator rejects coherent retained source and manifest drift', async () => {
  const fixture = await createEntrypointFixture('identity-drift');
  try {
    const sourceFile = fixture.stages.baseline.sourceFile;
    const retained = JSON.parse(await readFile(sourceFile, 'utf8'));
    const helper = 'apps/desktop-app/tests/performance/inspector-client.mjs';
    await writeFile(path.join(fixture.stages.baseline.root, helper), 'drift\n');
    retained[helper] = await hashFile(
      path.join(fixture.stages.baseline.root, helper),
    );
    await writeFile(sourceFile, JSON.stringify(retained));
    const artifactsPath = path.join(fixture.evidence, 'artifact-manifest.json');
    const artifacts = JSON.parse(await readFile(artifactsPath, 'utf8'));
    artifacts[path.basename(sourceFile)] = await hashFile(sourceFile);
    await writeFile(artifactsPath, JSON.stringify(artifacts));
    fixture.active.value = true;
    await assert.rejects(
      withLocalReleaseLease(
        (owner) =>
          executeFrameTraceDiagnostic(
            {
              primaryBatch: fixture.batchPath,
              output: path.join(fixture.outputParent, 'pair'),
            },
            undefined,
            owner,
            fixture.dependencies,
          ),
        {
          acquire: async () => ({
            ciBypass: false,
            memory: { skipped: false },
            lease: { metadata: {}, release: async () => {} },
          }),
        },
      ),
      /artifact manifest changed|immutable source changed/i,
    );
  } finally {
    fixture.active.value = false;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('actual coordinator resolves output-parent aliases before every write', async () => {
  for (const target of ['evidence', 'baseline-root']) {
    const fixture = await createEntrypointFixture(`output-alias-${target}`);
    const alias = path.join(fixture.root, 'output-alias');
    try {
      await symlink(
        target === 'evidence' ? fixture.evidence : fixture.stages.baseline.root,
        alias,
      );
      fixture.active.value = true;
      await assert.rejects(
        executeFrameTraceDiagnostic(
          {
            primaryBatch: fixture.batchPath,
            output: path.join(alias, 'fresh'),
          },
          undefined,
          { active: true },
          fixture.dependencies,
        ),
        /outside primary evidence|outside original stages/,
      );
      await assert.rejects(lstat(path.join(alias, 'fresh')));
    } finally {
      fixture.active.value = false;
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('actual coordinator preservation gate stops candidate after baseline mutation', async () => {
  const fixture = await createEntrypointFixture('preservation-gate');
  const originalRun = fixture.dependencies.runCommandProcess;
  let dispatches = 0;
  fixture.dependencies.runCommandProcess = async (vector) => {
    const outcome = await originalRun(vector);
    if (vector.executable !== '/usr/bin/tar') {
      dispatches++;
      if (dispatches === 1)
        await writeFile(
          path.join(
            vector.cwd,
            'apps/desktop-app/tests/performance/inspector-client.mjs',
          ),
          'mutated by baseline\n',
        );
    }
    return outcome;
  };
  try {
    fixture.active.value = true;
    await assert.rejects(
      withLocalReleaseLease(
        (owner) =>
          executeFrameTraceDiagnostic(
            {
              primaryBatch: fixture.batchPath,
              output: path.join(fixture.outputParent, 'pair'),
            },
            undefined,
            owner,
            fixture.dependencies,
          ),
        {
          acquire: async () => ({
            ciBypass: false,
            memory: { skipped: false },
            lease: { metadata: {}, release: async () => {} },
          }),
        },
      ),
      /deep-equal|manifest changed/i,
    );
    assert.equal(dispatches, 1);
    const pair = JSON.parse(
      await readFile(path.join(fixture.outputParent, 'pair', 'pair.json')),
    );
    assert.deepEqual(
      pair.attempts.map((attempt) => attempt.status),
      ['completed', 'unstarted'],
    );
  } finally {
    fixture.active.value = false;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('actual coordinator retains preparation interruption under the active lease', async () => {
  const fixture = await createEntrypointFixture('preparation-interruption');
  fixture.dependencies.runCommandProcess = async (vector) => {
    assert(fixture.active.value, 'lease must cover interrupted extraction');
    if (vector.executable === '/usr/bin/tar')
      return {
        code: null,
        timedOut: false,
        interrupted: true,
        signal: 'SIGTERM',
        descendantsAfterLeaderExit: false,
        cleanup: { groupGone: true, errors: [] },
      };
    assert.fail('diagnostic child must stay unstarted');
  };
  let released = 0;
  const output = path.join(fixture.outputParent, 'pair');
  try {
    await assert.rejects(
      withLocalReleaseLease(
        async (owner) => {
          fixture.active.value = true;
          return executeFrameTraceDiagnostic(
            { primaryBatch: fixture.batchPath, output },
            AbortSignal.abort(),
            owner,
            fixture.dependencies,
          );
        },
        {
          acquire: async () => ({
            ciBypass: false,
            memory: { skipped: false },
            lease: {
              metadata: {},
              release: async () => {
                fixture.active.value = false;
                released++;
              },
            },
          }),
        },
      ),
      /interrupted/,
    );
    assert.equal(released, 1);
    const pair = JSON.parse(await readFile(path.join(output, 'pair.json')));
    assert.equal(pair.status, 'failed');
    assert.deepEqual(
      pair.attempts.map((attempt) => attempt.status),
      ['unstarted', 'unstarted'],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('actual coordinator retains baseline child failure and final preservation', async () => {
  const fixture = await createEntrypointFixture('baseline-failure');
  const originalRun = fixture.dependencies.runCommandProcess;
  fixture.dependencies.runCommandProcess = async (vector) => {
    const outcome = await originalRun(vector);
    return vector.executable === '/usr/bin/tar'
      ? outcome
      : { ...outcome, code: 1 };
  };
  const output = path.join(fixture.outputParent, 'pair');
  try {
    fixture.active.value = true;
    await assert.rejects(
      withLocalReleaseLease(
        (owner) =>
          executeFrameTraceDiagnostic(
            { primaryBatch: fixture.batchPath, output },
            undefined,
            owner,
            fixture.dependencies,
          ),
        {
          acquire: async () => ({
            ciBypass: false,
            memory: { skipped: false },
            lease: { metadata: {}, release: async () => {} },
          }),
        },
      ),
      /failed structurally/,
    );
    const pair = JSON.parse(await readFile(path.join(output, 'pair.json')));
    assert.equal(pair.status, 'failed');
    assert.deepEqual(
      pair.attempts.map((attempt) => attempt.status),
      ['failed', 'unstarted'],
    );
    assert.equal(pair.preservationGates.at(-1).gate, 'final');
    assert(
      pair.preservationGates
        .at(-1)
        .checks.every((check) => check.status === 'verified'),
    );
  } finally {
    fixture.active.value = false;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('actual coordinator refuses an existing output leaf without altering it', async () => {
  const fixture = await createEntrypointFixture('output-collision');
  const output = path.join(fixture.outputParent, 'pair');
  const marker = path.join(output, 'owned.txt');
  try {
    await mkdir(output);
    await writeFile(marker, 'preserve me\n');
    fixture.active.value = true;
    await assert.rejects(
      executeFrameTraceDiagnostic(
        { primaryBatch: fixture.batchPath, output },
        undefined,
        { active: true },
        fixture.dependencies,
      ),
      /EEXIST/,
    );
    assert.equal(await readFile(marker, 'utf8'), 'preserve me\n');
  } finally {
    fixture.active.value = false;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('actual local lease owns exact baseline-then-candidate diagnostic vectors', async () => {
  let released = 0;
  let owner;
  const vectors = [];
  const snapshots = [];
  await withLocalReleaseLease(
    async (activeOwner) => {
      owner = activeOwner;
      const result = await runDiagnosticPair({
        owner: activeOwner,
        stages: [
          { stage: 'baseline', capsule: '/capsules/baseline' },
          { stage: 'candidate', capsule: '/capsules/candidate' },
        ],
        resultsDir: '/diagnostic/results',
        run: async (vector) => {
          vectors.push(vector);
          return {
            code: 0,
            timedOut: false,
            interrupted: false,
            descendantsAfterLeaderExit: false,
            cleanup: { groupGone: true, errors: [] },
          };
        },
        validateResult: async () => ({
          kind: 'browser-profile-common-frame-trace-diagnostic-v1',
        }),
        persist: async (attempts) => snapshots.push(structuredClone(attempts)),
      });
      assert.deepEqual(
        result.map((entry) => entry.status),
        ['completed', 'completed'],
      );
    },
    {
      acquire: async () => ({
        ciBypass: false,
        memory: { skipped: false },
        lease: {
          metadata: { token: 'fixture' },
          release: async () => released++,
        },
      }),
    },
  );
  assert.equal(released, 1);
  assert.deepEqual(
    vectors.map((entry) => entry.cwd),
    ['/capsules/baseline', '/capsules/candidate'],
  );
  for (const vector of vectors) {
    assert.equal(vector.executable, process.execPath);
    assert.equal(vector.timeoutMs, 240_000);
    assert(vector.args.includes('--frame-trace-diagnostic'));
    assert.deepEqual(vector.args.slice(-9), [
      '--output',
      vector.args.at(-8),
      '--window-mode',
      'headless',
      '--samples',
      '1',
      '--warmups',
      '0',
      '--frame-trace-diagnostic',
    ]);
  }
  assert.throws(() => releaseDriverPrefix('local-physical', owner));
  assert.deepEqual(
    snapshots.at(-1).map((entry) => entry.status),
    ['completed', 'completed'],
  );
});

test('first-stage structural failure is retained and candidate stays unstarted', async () => {
  let released = 0;
  const snapshots = [];
  let calls = 0;
  await assert.rejects(
    withLocalReleaseLease(
      (owner) =>
        runDiagnosticPair({
          owner,
          stages: [
            { stage: 'baseline', capsule: '/capsules/baseline' },
            { stage: 'candidate', capsule: '/capsules/candidate' },
          ],
          resultsDir: '/diagnostic/results',
          run: async () => {
            calls++;
            return {
              code: 1,
              timedOut: false,
              interrupted: false,
              descendantsAfterLeaderExit: false,
              cleanup: { groupGone: true, errors: [] },
            };
          },
          validateResult: async () => ({
            kind: 'browser-profile-common-frame-trace-diagnostic-v1',
          }),
          persist: async (attempts) =>
            snapshots.push(structuredClone(attempts)),
        }),
      {
        acquire: async () => ({
          ciBypass: false,
          memory: { skipped: false },
          lease: { metadata: {}, release: async () => released++ },
        }),
      },
    ),
    /failed structurally/,
  );
  assert.equal(calls, 1);
  assert.equal(released, 1);
  assert.deepEqual(
    snapshots.at(-1).map((entry) => entry.status),
    ['failed', 'unstarted'],
  );
});

test('pair observes each persisted attempt and does not let observer errors replace a stage failure', async () => {
  const order = [];
  let calls = 0;
  await assert.rejects(
    withLocalReleaseLease(
      (owner) =>
        runDiagnosticPair({
          owner,
          stages: [
            { stage: 'baseline', capsule: '/capsules/baseline' },
            { stage: 'candidate', capsule: '/capsules/candidate' },
          ],
          resultsDir: '/diagnostic/results',
          run: async () => {
            calls++;
            return {
              code: 1,
              timedOut: false,
              interrupted: false,
              descendantsAfterLeaderExit: false,
              cleanup: { groupGone: true, errors: [] },
            };
          },
          persist: async (attempts) =>
            order.push(`persist:${attempts[0].status}`),
          afterAttempt: async ({ stage, attempts, error }) => {
            order.push(
              `${stage.stage}:${attempts[0].status}:${Boolean(error)}`,
            );
            throw new Error('observer collection failed');
          },
        }),
      {
        acquire: async () => ({
          ciBypass: false,
          memory: { skipped: false },
          lease: { metadata: {}, release: async () => {} },
        }),
      },
    ),
    /failed structurally/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(order, [
    'persist:unstarted',
    'persist:running',
    'persist:failed',
    'baseline:failed:true',
  ]);
});

test('pair observes an attempted stage when its terminal persistence fails', async () => {
  const observations = [];
  let persistCalls = 0;
  await assert.rejects(
    withLocalReleaseLease(
      (owner) =>
        runDiagnosticPair({
          owner,
          stages: [
            { stage: 'baseline', capsule: '/capsules/baseline' },
            { stage: 'candidate', capsule: '/capsules/candidate' },
          ],
          resultsDir: '/diagnostic/results',
          run: async () => ({
            code: 1,
            timedOut: false,
            interrupted: false,
            descendantsAfterLeaderExit: false,
            cleanup: { groupGone: true, errors: [] },
          }),
          persist: async () => {
            persistCalls++;
            if (persistCalls >= 3)
              throw new Error('terminal persistence failed');
          },
          afterAttempt: async ({ stage, error }) =>
            observations.push({ stage: stage.stage, error: String(error) }),
        }),
      {
        acquire: async () => ({
          ciBypass: false,
          memory: { skipped: false },
          lease: { metadata: {}, release: async () => {} },
        }),
      },
    ),
    /failed structurally/,
  );
  assert.deepEqual(
    observations.map(({ stage }) => stage),
    ['baseline'],
  );
});

test('pair observes after successful preservation before it schedules the candidate', async () => {
  const order = [];
  let calls = 0;
  const attempts = await withLocalReleaseLease(
    (owner) =>
      runDiagnosticPair({
        owner,
        stages: [
          { stage: 'baseline', capsule: '/capsules/baseline' },
          { stage: 'candidate', capsule: '/capsules/candidate' },
        ],
        resultsDir: '/diagnostic/results',
        run: async () => ({
          code: 0,
          timedOut: false,
          interrupted: false,
          descendantsAfterLeaderExit: false,
          cleanup: { groupGone: true, errors: [] },
          ordinal: calls++,
        }),
        validateResult: async () => ({ kind: 'fixture' }),
        persist: async (snapshot) =>
          order.push(
            `persist:${snapshot.map((entry) => entry.status).join(',')}`,
          ),
        afterCompleted: async (stage) => order.push(`preserve:${stage.stage}`),
        afterAttempt: async ({ stage }) => order.push(`observe:${stage.stage}`),
      }),
    {
      acquire: async () => ({
        ciBypass: false,
        memory: { skipped: false },
        lease: { metadata: {}, release: async () => {} },
      }),
    },
  );
  assert.deepEqual(
    attempts.map((attempt) => attempt.status),
    ['completed', 'completed'],
  );
  assert.deepEqual(order, [
    'persist:unstarted,unstarted',
    'persist:running,unstarted',
    'persist:completed,unstarted',
    'preserve:baseline',
    'observe:baseline',
    'persist:completed,running',
    'persist:completed,completed',
    'preserve:candidate',
    'observe:candidate',
  ]);
});

test('candidate failure is retained after one completed baseline without retry', async () => {
  const snapshots = [];
  let calls = 0;
  await assert.rejects(
    withLocalReleaseLease(
      (owner) =>
        runDiagnosticPair({
          owner,
          stages: [
            { stage: 'baseline', capsule: '/capsules/baseline' },
            { stage: 'candidate', capsule: '/capsules/candidate' },
          ],
          resultsDir: '/diagnostic/results',
          run: async () => ({
            code: calls++ === 0 ? 0 : 1,
            timedOut: false,
            interrupted: false,
            descendantsAfterLeaderExit: false,
            cleanup: { groupGone: true, errors: [] },
          }),
          validateResult: async () => ({
            kind: 'browser-profile-common-frame-trace-diagnostic-v1',
          }),
          persist: async (attempts) =>
            snapshots.push(structuredClone(attempts)),
        }),
      {
        acquire: async () => ({
          ciBypass: false,
          memory: { skipped: false },
          lease: { metadata: {}, release: async () => {} },
        }),
      },
    ),
    /failed structurally/,
  );
  assert.equal(calls, 2);
  assert.deepEqual(
    snapshots.at(-1).map((entry) => entry.status),
    ['completed', 'failed'],
  );
});

test('owned child admission rejects every unsafe terminal state', () => {
  const safe = {
    code: 0,
    timedOut: false,
    interrupted: false,
    descendantsAfterLeaderExit: false,
    cleanup: { groupGone: true, errors: [] },
  };
  assert.doesNotThrow(() => assertOwnedChildComplete(safe, 'fixture'));
  for (const changed of [
    { timedOut: true },
    { interrupted: true },
    { signal: 'SIGKILL' },
    { error: 'spawn failed' },
    { descendantsAfterLeaderExit: true },
    { cleanup: { groupGone: false, errors: [] } },
    { cleanup: { groupGone: true, errors: ['cleanup failed'] } },
  ])
    assert.throws(() =>
      assertOwnedChildComplete({ ...safe, ...changed }, 'fixture'),
    );
});
