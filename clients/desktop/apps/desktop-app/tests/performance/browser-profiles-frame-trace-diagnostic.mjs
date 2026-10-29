/**
 * Closed diagnostic-only common frame trace over exact retained physical08 or
 * physical10 baseline and candidate production artifacts.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { list as listTar } from 'tar';
import {
  hashFile,
  manifest,
  sourceManifest,
  requireLocalPhysicalMac,
  withLocalReleaseLease,
  releaseDriverPrefix,
  releaseChildEnvironment,
  runCommandProcess,
  withReleaseInterruption,
} from './browser-profiles-release-ci.mjs';

export const DIAGNOSTIC_KIND =
  'browser-profile-common-frame-trace-diagnostic-pair-v1';
const REQUIRED_BATCH_SHA256 =
  '174c2877510b496477a85d856e0797377d1b7d95953451c55e8748ea2bba10cb';
const REQUIRED_OVERLAY_MANIFEST_SHA256 =
  'bd4ee86570f94f13acaf406350bc95bb3dcd0bd7371cad8017d8629bfbdab1c0';
const REQUIRED_ARTIFACT_MANIFEST_SHA256 =
  '11877ae44efc0e32aa7e9bed43496193ed8d168f6fdd23b1f78d26a7a6032187';
const REQUIRED_IMMUTABLE_SOURCE_SHA256 = Object.freeze({
  baseline: '1900164f360ae02876f298b51742a834172539b010aa22eae09c64e20fd56729',
  candidate: '377d73920f4a872c2476ca388d68360f0e6abca067f504970a150702b4f762e3',
});
const REQUIRED_PRODUCTS = Object.freeze({
  baseline: '50ad63d648b27f867aa248cf3e8517aac0b4308d',
  candidate: '826ba53cc178d6d1737a444bea2d45463aea523c',
});
const REQUIRED_PRIMARY = Object.freeze({
  baseline: Object.freeze({
    ordinal: 0,
    file: '000-common-baseline-warmup--1.json',
    sha256: '0c287bcd36eeea25bd664b52052bc4cf1a255e76f5cfe099abb31112738ffabc',
  }),
  candidate: Object.freeze({
    ordinal: 1,
    file: '001-common-candidate-warmup--1.json',
    sha256: '2a7a2203ea9fe866095912dfbcf1c0c717fb67081c3e9d74f7ad9956f5cb91fc',
  }),
});
export const DIAGNOSTIC_OVERLAY = Object.freeze({
  'apps/desktop-app/tests/performance/browser-profiles-release-run.mjs':
    Object.freeze({
      preimage:
        'ad9de48370ee82ba2d12b3df923f0535ded2c1d2bb2d63b9ce3080cdbce70003',
      installed:
        'a4c8f61e7752fbfa0869b1483fe957cc6ce43e09b5f9d97a27ab2981bd070a21',
    }),
  'apps/desktop-app/tests/performance/diagnostics.mjs': Object.freeze({
    preimage:
      '401515b0ac2ffa36f8ceb8979044f987c79f12d9e517e600b107421f984a9120',
    installed:
      '1cb298b806a9e7159942cc06d0ccfd8eebb555e74599c08617703b5f6a14944b',
  }),
});
const CHILD_TIMEOUT_MS = 240_000;
const ARCHIVE_TIMEOUT_MS = 120_000;
const RUNNER =
  'apps/desktop-app/tests/performance/browser-profiles-release-run.mjs';
const REQUIRED_SUPPORT = Object.freeze({
  'node_modules/electron/package.json': '42.3.0',
  'node_modules/@playwright/test/package.json': '1.58.2',
  'node_modules/tsx/package.json': '4.21.0',
});
const REQUIRED_RETAINED_DEPENDENCIES = Object.freeze({
  'apps/desktop-app/tests/performance/inspector-client.mjs':
    'b8122da08eaf9c0835a0ac11378fbba2a98486cb9eec5f99f1dac40ad760010f',
  'apps/desktop-app/tests/performance/hotspots.mjs':
    '69ca90c612620e7b54a5e85b58d82bedcdfff312240e147963c8d0ec967a3a13',
});
const PHYSICAL08_REQUIREMENTS = Object.freeze({
  batchSha256: REQUIRED_BATCH_SHA256,
  overlayManifestSha256: REQUIRED_OVERLAY_MANIFEST_SHA256,
  artifactManifestSha256: REQUIRED_ARTIFACT_MANIFEST_SHA256,
  immutableSourceSha256: REQUIRED_IMMUTABLE_SOURCE_SHA256,
  products: REQUIRED_PRODUCTS,
  primary: REQUIRED_PRIMARY,
  retainedDependencies: REQUIRED_RETAINED_DEPENDENCIES,
  overlay: DIAGNOSTIC_OVERLAY,
});
const PHYSICAL10_REQUIREMENTS = Object.freeze({
  batchSha256:
    'de0b1b909a4e13121a7eed560a8d8a6217cd03bf56d98586a7ff9435725bfc8e',
  overlayManifestSha256:
    '419f303bde305ae5e4e6780fa608c0a267b553a1ca3314ff76647b1c355d9897',
  artifactManifestSha256:
    '852b453499db65af434a95c8177843b008678742f35c2b8b6d7c40c82fc696a5',
  immutableSourceSha256: Object.freeze({
    baseline:
      '77138153edb75f9aef612a4e86707be5bd56542061eb17ec9597cecf13167540',
    candidate:
      '5d8f6d1683ee2e587d91dfdf864477faf4eda7bd741daf535f5d008ebabab9e8',
  }),
  products: Object.freeze({
    baseline: '50ad63d648b27f867aa248cf3e8517aac0b4308d',
    candidate: 'e9a9396c141c112d929c82c48bdb271b98602898',
  }),
  primary: Object.freeze({
    baseline: Object.freeze({
      ordinal: 2,
      phase: 'measured',
      pair: 0,
      file: '002-common-baseline-measured-0.json',
      sha256:
        '9fd1d5fe41e95b4d3f09b9ce463d13734cfcd3e33f6d5fed71c11950ad2fd50e',
    }),
    candidate: Object.freeze({
      ordinal: 1,
      phase: 'warmup',
      pair: -1,
      file: '001-common-candidate-warmup--1.json',
      sha256:
        '71eb201d2076f55d96e2fc969b8ae4ac18a3d81283d0b9957b69bee74d409c21',
    }),
  }),
  retainedDependencies: Object.freeze({
    'apps/desktop-app/tests/performance/browser-profiles-release-run.mjs':
      'a4c8f61e7752fbfa0869b1483fe957cc6ce43e09b5f9d97a27ab2981bd070a21',
    'apps/desktop-app/tests/performance/diagnostics.mjs':
      '1cb298b806a9e7159942cc06d0ccfd8eebb555e74599c08617703b5f6a14944b',
    'apps/desktop-app/tests/performance/inspector-client.mjs':
      'b8122da08eaf9c0835a0ac11378fbba2a98486cb9eec5f99f1dac40ad760010f',
    'apps/desktop-app/tests/performance/hotspots.mjs':
      '69ca90c612620e7b54a5e85b58d82bedcdfff312240e147963c8d0ec967a3a13',
  }),
  overlay: Object.freeze({}),
});
const REQUIREMENTS_BY_BATCH_SHA256 = new Map(
  [PHYSICAL08_REQUIREMENTS, PHYSICAL10_REQUIREMENTS].map((requirements) => [
    requirements.batchSha256,
    requirements,
  ]),
);

export function diagnosticEvidenceRequirementsForBatchSha256(batchSha256) {
  const requirements = REQUIREMENTS_BY_BATCH_SHA256.get(batchSha256);
  assert(requirements, 'Diagnostic requires a recognized retained batch hash');
  return requirements;
}

function canonical(value) {
  return JSON.stringify(value, Object.keys(value ?? {}).sort());
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function disjoint(left, right) {
  return !contained(left, right) && !contained(right, left);
}

export function parseFrameTraceDiagnosticOptions(args = process.argv.slice(2)) {
  const seen = new Set();
  for (const argument of args) {
    if (!argument.startsWith('--')) continue;
    const name = argument.slice(2).split('=', 1)[0];
    assert(!seen.has(name), `Repeated option: --${name}`);
    seen.add(name);
  }
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      'primary-batch': { type: 'string' },
      output: { type: 'string' },
    },
  });
  assert(values['primary-batch'], '--primary-batch is required');
  assert(values.output, '--output is required');
  return {
    primaryBatch: path.resolve(values['primary-batch']),
    output: path.resolve(values.output),
  };
}

export function assertManifestPath(relative) {
  assert.equal(typeof relative, 'string', 'Manifest path must be a string');
  assert(relative.length > 0, 'Manifest path must not be empty');
  assert(
    !path.isAbsolute(relative),
    `Manifest path must be relative: ${relative}`,
  );
  assert.equal(
    path.normalize(relative),
    relative,
    `Manifest path is not normalized: ${relative}`,
  );
  assert(
    relative !== '..' && !relative.startsWith(`..${path.sep}`),
    `Manifest path escapes its root: ${relative}`,
  );
  return relative;
}

export async function explicitSourceManifest(root, retained) {
  const result = {};
  const entries = Object.keys(retained);
  assert.equal(
    new Set(entries).size,
    entries.length,
    'Duplicate manifest path',
  );
  for (let offset = 0; offset < entries.length; offset += 16) {
    const values = await Promise.all(
      entries.slice(offset, offset + 16).map(async (relative) => {
        assertManifestPath(relative);
        const absolute = path.join(root, relative);
        assert(
          contained(root, absolute),
          `Manifest path escapes root: ${relative}`,
        );
        const info = await lstat(absolute);
        assert(
          info.isFile() || info.isSymbolicLink(),
          `Unsupported source entry: ${relative}`,
        );
        return [
          relative,
          info.isSymbolicLink()
            ? { symlink: await readlink(absolute) }
            : await hashFile(absolute),
        ];
      }),
    );
    Object.assign(result, Object.fromEntries(values));
  }
  return result;
}

export async function assertExplicitSourceManifest(root, retained) {
  const actual = await explicitSourceManifest(root, retained);
  assert.deepEqual(
    actual,
    retained,
    `Explicit source manifest changed: ${root}`,
  );
  return actual;
}

async function walk(root, relative = '') {
  const values = [];
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const child = path.join(relative, entry.name);
    values.push(child);
    if (entry.isDirectory()) values.push(...(await walk(root, child)));
  }
  return values;
}

export async function verifyCopiedCapsule(original, capsule) {
  for (const relative of await walk(capsule)) {
    const destination = path.join(capsule, relative);
    const info = await lstat(destination);
    if (info.isSymbolicLink()) {
      const target = await readlink(destination);
      assert(!path.isAbsolute(target), `Absolute capsule symlink: ${relative}`);
      const resolved = path.resolve(path.dirname(destination), target);
      assert(
        contained(capsule, resolved),
        `Escaping capsule symlink: ${relative}`,
      );
      await lstat(resolved);
    } else if (info.isFile()) {
      const sourceInfo = await lstat(path.join(original, relative));
      assert(
        sourceInfo.dev !== info.dev || sourceInfo.ino !== info.ino,
        `Capsule file is hardlinked to original: ${relative}`,
      );
    }
  }
}

export async function copyDiagnosticCapsule(
  original,
  temporary,
  { copy = cp, copyMode = fsConstants.COPYFILE_FICLONE } = {},
) {
  const filter = (source) => {
    const relative = path.relative(original, source);
    if (!relative) return true;
    const segments = relative.split(path.sep);
    return (
      !segments.includes('.git') &&
      !segments.includes('.playwright') &&
      segments[0] !== 'out'
    );
  };
  await copy(original, temporary, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
    verbatimSymlinks: true,
    mode: copyMode,
    filter,
  });
  await verifyCopiedCapsule(original, temporary);
}

export function assertSafeArchiveEntry(entry) {
  const name = entry.path ?? entry.name;
  assert.equal(typeof name, 'string', 'Archive entry path missing');
  assert(!path.posix.isAbsolute(name), `Absolute archive entry: ${name}`);
  const raw = name.replace(/^\.\//, '');
  assert(!raw.split('/').includes('..'), `Archive traversal: ${name}`);
  const normalized = path.posix.normalize(raw);
  assert(
    normalized === 'out' || normalized.startsWith('out/'),
    `Archive entry outside out/: ${name}`,
  );
  assert(
    ['File', 'Directory', 'OldFile'].includes(entry.type),
    `Unsupported archive entry type ${entry.type}: ${name}`,
  );
  return normalized;
}

function appleDoubleTarget(entry) {
  const name = entry.path ?? entry.name;
  assert.equal(typeof name, 'string', 'Archive entry path missing');
  assert(!path.posix.isAbsolute(name), `Absolute archive entry: ${name}`);
  const raw = name.replace(/^\.\//, '');
  assert(!raw.split('/').includes('..'), `Archive traversal: ${name}`);
  const normalized = path.posix.normalize(raw).replace(/\/$/, '');
  if (normalized === '._out') return 'out';
  if (!path.posix.basename(normalized).startsWith('._')) return undefined;
  assert(normalized.startsWith('out/'), `Archive entry outside out/: ${name}`);
  const targetName = path.posix.basename(normalized).slice(2);
  assert(targetName, `AppleDouble target missing: ${name}`);
  return path.posix.join(path.posix.dirname(normalized), targetName);
}

function assertAppleDoubleHeader(header, name) {
  assert(
    header.length >= 8 &&
      header.subarray(0, 4).equals(Buffer.from([0x00, 0x05, 0x16, 0x07])) &&
      header.subarray(4, 8).equals(Buffer.from([0x00, 0x02, 0x00, 0x00])),
    `Invalid AppleDouble signature/version: ${name}`,
  );
}

export async function validateProductionArchive(archive) {
  const entries = [];
  const ordinary = new Set();
  const metadata = [];
  const metadataValidations = [];
  let payloadFiles = 0;
  let failure;
  const fail = (error) => {
    failure ??= error;
  };
  await listTar({
    file: archive,
    onentry(entry) {
      try {
        const metadataTarget = appleDoubleTarget(entry);
        if (!metadataTarget) {
          const normalized = assertSafeArchiveEntry(entry).replace(/\/$/, '');
          entries.push(normalized);
          ordinary.add(normalized);
          if (['File', 'OldFile'].includes(entry.type)) payloadFiles++;
          return;
        }
        const name = entry.path ?? entry.name;
        assert(
          ['File', 'OldFile'].includes(entry.type),
          `Unsupported AppleDouble entry type ${entry.type}: ${name}`,
        );
        metadata.push({ name, target: metadataTarget });
        metadataValidations.push(
          new Promise((resolve) => {
            let header = Buffer.alloc(0);
            let finished = false;
            const finish = (error) => {
              if (finished) return;
              finished = true;
              if (error) fail(error);
              resolve();
            };
            entry.on('data', (chunk) => {
              if (header.length < 8)
                header = Buffer.concat([header, chunk]).subarray(0, 8);
            });
            entry.once('end', () => {
              try {
                assertAppleDoubleHeader(header, name);
                finish();
              } catch (error) {
                finish(error);
              }
            });
            entry.once('error', finish);
          }),
        );
      } catch (error) {
        fail(error);
      }
    },
  });
  await Promise.all(metadataValidations);
  if (failure) throw failure;
  assert(
    payloadFiles > 0,
    'Production archive contains no ordinary out payload',
  );
  for (const entry of metadata)
    assert(
      ordinary.has(entry.target),
      `AppleDouble entry has no corresponding out entry: ${entry.name}`,
    );
  return entries;
}

export function assertDiagnosticOverlayDelta(
  before,
  after,
  overlay = DIAGNOSTIC_OVERLAY,
) {
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((file) => canonical(before[file]) !== canonical(after[file]))
    .sort();
  assert.deepEqual(
    changed,
    Object.keys(overlay).sort(),
    'Diagnostic overlay changed outside its exact pinned file set',
  );
  for (const [file, identity] of Object.entries(overlay)) {
    assert.equal(
      before[file],
      identity.preimage,
      `Wrong capsule preimage: ${file}`,
    );
    assert.equal(
      after[file],
      identity.installed,
      `Wrong installed overlay: ${file}`,
    );
  }
  return changed;
}

export function selectDiagnosticPrimaries(batch, requirements) {
  assert.equal(batch.schemaVersion, 3);
  assert.equal(batch.protocol, 'same-host-qualification-headless-v4');
  assert.equal(batch.execution, 'local-physical');
  assert.equal(batch.studyWindowMode, 'hidden-native-1400x900-v1');
  assert.equal(batch.windowVisible, false);
  assert.equal(
    typeof batch.completedAt,
    'string',
    'Physical08 batch is incomplete',
  );
  const selected = {};
  for (const stage of ['baseline', 'candidate']) {
    const required = requirements.primary[stage];
    const phase = required.phase ?? 'warmup';
    const pair = required.pair ?? -1;
    const attempts = batch.attempts.filter(
      (entry) =>
        entry.ordinal === required.ordinal &&
        entry.mode === 'common' &&
        entry.stage === stage &&
        entry.phase === phase &&
        entry.pair === pair,
    );
    assert.equal(
      attempts.length,
      1,
      `Missing exact ${stage} common ${phase} pair ${pair}`,
    );
    const attempt = attempts[0];
    assert.equal(path.basename(attempt.reportPath), required.file);
    assert.equal(
      attempt.rawSha256,
      required.sha256,
      `Selected ${stage} raw report hash changed`,
    );
    assert.equal(attempt.verified, true);
    assert.equal(attempt.structuralStatus, 'valid');
    assert.equal(attempt.performanceStatus, 'failed');
    const commands = batch.commands.filter(
      (entry) => entry.label === attempt.commandLabel,
    );
    assert.equal(commands.length, 1, `Missing primary command: ${stage}`);
    const command = commands[0];
    assert.equal(command.cwd, batch.stages[stage].root);
    assert(command.command.includes(RUNNER));
    assert(!command.command.includes('--frame-trace-diagnostic'));
    assert.equal(
      command.code,
      1,
      'Selected primary must be the retained gate failure',
    );
    assert.equal(command.timedOut, false);
    assert.equal(command.interrupted, false);
    assert.equal(command.descendantsAfterLeaderExit, false);
    assert.equal(command.cleanup?.groupGone, true);
    assert.deepEqual(command.cleanup?.errors, []);
    selected[stage] = attempt;
  }
  return selected;
}

export function diagnosticChildVector(capsule, output, owner) {
  return {
    executable: process.execPath,
    args: [
      ...releaseDriverPrefix('local-physical', owner),
      RUNNER,
      '--output',
      output,
      '--window-mode',
      'headless',
      '--samples',
      '1',
      '--warmups',
      '0',
      '--frame-trace-diagnostic',
    ],
    cwd: capsule,
    env: releaseChildEnvironment('local-physical'),
    timeoutMs: CHILD_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
}

export function assertOwnedChildComplete(outcome, label) {
  assert.equal(outcome.timedOut, false, `${label} timed out`);
  assert.equal(outcome.interrupted, false, `${label} interrupted`);
  assert(!outcome.signal, `${label} signaled`);
  assert.equal(outcome.error, undefined, `${label} process error`);
  assert.equal(
    outcome.descendantsAfterLeaderExit,
    false,
    `${label} descendants survived leader`,
  );
  assert.equal(
    outcome.cleanup?.groupGone,
    true,
    `${label} process group survived cleanup`,
  );
  assert.equal(
    outcome.cleanup?.errors?.length ?? 0,
    0,
    `${label} cleanup errors`,
  );
  assert.equal(outcome.code, 0, `${label} diagnostic failed structurally`);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function hashJsonFile(file, expected) {
  assert.equal(
    await hashFile(file),
    expected,
    `Evidence hash changed: ${file}`,
  );
}

async function runtimeSupportIdentity(root) {
  const packages = {};
  for (const [relative, expectedVersion] of Object.entries(REQUIRED_SUPPORT)) {
    const file = path.join(root, relative);
    const value = await readJson(file);
    assert.equal(
      value.version,
      expectedVersion,
      `Runtime support changed: ${relative}`,
    );
    packages[relative] = {
      version: value.version,
      sha256: await hashFile(file),
    };
  }
  const executable = path.join(
    root,
    'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
  );
  const cache = await lstat(path.join(root, '.cache'));
  assert(cache.isDirectory(), 'Retained .cache support is missing');
  return {
    packages,
    electronExecutableSha256: await hashFile(executable),
  };
}

export function controlIdentity(root, { execute = execFileSync } = {}) {
  const git = (args) =>
    execute('git', ['-C', root, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  const commit = git(['rev-parse', 'HEAD']);
  const status = git(['status', '--porcelain']);
  assert.equal(status, '', 'Diagnostic control checkout must be clean');
  return {
    commit,
    dirty: false,
  };
}

async function admitEvidence(primaryBatch, dependencies = {}) {
  const batchSha256 = await hashFile(primaryBatch);
  const resolveRequirements =
    dependencies.resolveRequirements ??
    diagnosticEvidenceRequirementsForBatchSha256;
  const requirements =
    dependencies.requirements ?? resolveRequirements(batchSha256);
  const sourceManifestImpl = dependencies.sourceManifest ?? sourceManifest;
  const manifestImpl = dependencies.manifest ?? manifest;
  assert.equal(
    batchSha256,
    requirements.batchSha256,
    `Evidence hash changed: ${primaryBatch}`,
  );
  const batch = await readJson(primaryBatch);
  const directory = path.dirname(primaryBatch);
  const artifactPath = path.join(directory, 'artifact-manifest.json');
  const artifactManifestSha256 = await hashFile(artifactPath);
  assert.equal(
    artifactManifestSha256,
    requirements.artifactManifestSha256,
    'Retained artifact manifest changed',
  );
  const artifacts = await readJson(artifactPath);
  assert.equal(artifacts['batch.json'], requirements.batchSha256);
  await hashJsonFile(
    path.join(directory, 'overlay-manifest.json'),
    requirements.overlayManifestSha256,
  );
  const primaries = selectDiagnosticPrimaries(batch, requirements);
  const support = {};
  for (const stage of ['baseline', 'candidate']) {
    assert.equal(batch.stages[stage].commit, requirements.products[stage]);
    const { root } = batch.stages[stage];
    // Stages recorded before the pnpm cutover carry package-lock.json.
    const lockfile = await lstat(path.join(root, 'pnpm-lock.yaml')).then(
      () => 'pnpm-lock.yaml',
      (error) => {
        if (error.code === 'ENOENT') return 'package-lock.json';
        throw error;
      },
    );
    assert.equal(
      await hashFile(path.join(root, lockfile)),
      batch.stages[stage].lockfileSha256,
    );
    await hashJsonFile(
      primaries[stage].reportPath,
      requirements.primary[stage].sha256,
    );
    const archive = batch.stages[stage].productionArchive;
    assert.equal(artifacts[path.basename(archive.path)], archive.sha256);
    await hashJsonFile(archive.path, archive.sha256);
    await validateProductionArchive(archive.path);
    const sourceFile = path.join(directory, `${stage}-immutable-source.json`);
    assert.equal(
      artifacts[path.basename(sourceFile)],
      requirements.immutableSourceSha256[stage],
      `Retained ${stage} immutable source artifact identity changed`,
    );
    await hashJsonFile(sourceFile, requirements.immutableSourceSha256[stage]);
    const retainedSource = await readJson(sourceFile);
    for (const [relative, sha256] of Object.entries(
      requirements.retainedDependencies,
    ))
      assert.equal(
        retainedSource[relative],
        sha256,
        `Retained diagnostic dependency changed: ${relative}`,
      );
    assert.deepEqual(
      await sourceManifestImpl(batch.stages[stage].root),
      retainedSource,
    );
    assert.deepEqual(
      await manifestImpl(path.join(batch.stages[stage].root, 'out')),
      batch.stages[stage].bundles,
    );
    support[stage] = await runtimeSupportIdentity(batch.stages[stage].root);
  }
  assert.deepEqual(
    support.baseline,
    support.candidate,
    'Retained baseline/candidate runtime support differs',
  );
  return {
    batch,
    directory,
    primaries,
    artifacts,
    artifactPath,
    artifactManifestSha256,
    supportIdentity: support.baseline,
    requirements,
  };
}

export async function extractProductionArchive(
  archive,
  capsule,
  signal,
  run = runCommandProcess,
) {
  const outcome = await run({
    executable: '/usr/bin/tar',
    args: productionArchiveExtractionArgs(archive, capsule),
    cwd: capsule,
    env: {
      ...releaseChildEnvironment('local-physical'),
      COPYFILE_DISABLE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeoutMs: ARCHIVE_TIMEOUT_MS,
    signal,
  });
  assertOwnedChildComplete(outcome, 'production archive extraction');
}

export function productionArchiveExtractionArgs(
  archive,
  capsule,
  platform = process.platform,
) {
  return [
    '-xzf',
    archive,
    ...(platform === 'darwin' ? ['--no-mac-metadata'] : []),
    '--exclude',
    '._*',
    '--exclude',
    '*/._*',
    '-C',
    capsule,
  ];
}

async function prepareStage({
  stage,
  admitted,
  output,
  controlRoot,
  signal,
  run,
  manifestImpl,
}) {
  const original = admitted.batch.stages[stage].root;
  const temporary = path.join(output, 'stages', `.${stage}.preparing`);
  const capsule = path.join(output, 'stages', stage);
  await copyDiagnosticCapsule(original, temporary);
  const sourceFile = path.join(
    admitted.directory,
    `${stage}-immutable-source.json`,
  );
  const retainedSource = await readJson(sourceFile);
  const sourceBefore = await assertExplicitSourceManifest(
    temporary,
    retainedSource,
  );
  await extractProductionArchive(
    admitted.batch.stages[stage].productionArchive.path,
    temporary,
    signal,
    run,
  );
  const bundleBefore = await manifestImpl(path.join(temporary, 'out'));
  assert.deepEqual(bundleBefore, admitted.batch.stages[stage].bundles);
  await writeJson(
    path.join(output, `${stage}-bundle-before-run.json`),
    bundleBefore,
  );
  await writeJson(
    path.join(output, `${stage}-source-before-overlay.json`),
    sourceBefore,
  );
  const before = { ...sourceBefore };
  for (const [relative, identity] of Object.entries(
    admitted.requirements.overlay,
  )) {
    assert.equal(
      before[relative],
      identity.preimage,
      `Wrong retained preimage: ${relative}`,
    );
    const source = path.join(controlRoot, relative);
    assert.equal(
      await hashFile(source),
      identity.installed,
      `Control overlay bytes changed: ${relative}`,
    );
    const bytes = await readFile(source);
    const retained = path.join(output, 'overlay', relative);
    await mkdir(path.dirname(retained), { recursive: true });
    await writeFile(retained, bytes);
    await writeFile(path.join(temporary, relative), bytes);
  }
  const sourceAfter = await explicitSourceManifest(temporary, retainedSource);
  assertDiagnosticOverlayDelta(
    before,
    sourceAfter,
    admitted.requirements.overlay,
  );
  await writeJson(
    path.join(output, `${stage}-source-after-overlay.json`),
    sourceAfter,
  );
  await rename(temporary, capsule);
  return {
    stage,
    original,
    capsule,
    after: sourceAfter,
    bundleBefore,
    retainedSource,
  };
}

async function preserveStage(prepared, output, manifestImpl) {
  assert.deepEqual(
    await explicitSourceManifest(prepared.capsule, prepared.retainedSource),
    prepared.after,
  );
  const bundleAfter = await manifestImpl(path.join(prepared.capsule, 'out'));
  assert.deepEqual(bundleAfter, prepared.bundleBefore);
  await writeJson(
    path.join(output, `${prepared.stage}-bundle-after-run.json`),
    bundleAfter,
  );
}

async function preserveOriginalEvidence(
  admitted,
  { sourceManifest: sourceManifestImpl, manifest: manifestImpl },
) {
  await hashJsonFile(
    path.join(admitted.directory, 'batch.json'),
    admitted.requirements.batchSha256,
  );
  await hashJsonFile(admitted.artifactPath, admitted.artifactManifestSha256);
  await hashJsonFile(
    path.join(admitted.directory, 'overlay-manifest.json'),
    admitted.requirements.overlayManifestSha256,
  );
  for (const stage of ['baseline', 'candidate']) {
    const retainedSourcePath = path.join(
      admitted.directory,
      `${stage}-immutable-source.json`,
    );
    await hashJsonFile(
      retainedSourcePath,
      admitted.requirements.immutableSourceSha256[stage],
    );
    const retainedSource = await readJson(retainedSourcePath);
    assert.deepEqual(
      await sourceManifestImpl(admitted.batch.stages[stage].root),
      retainedSource,
    );
    assert.deepEqual(
      await manifestImpl(path.join(admitted.batch.stages[stage].root, 'out')),
      admitted.batch.stages[stage].bundles,
    );
    await hashJsonFile(
      admitted.primaries[stage].reportPath,
      admitted.requirements.primary[stage].sha256,
    );
    const archive = admitted.batch.stages[stage].productionArchive;
    await hashJsonFile(archive.path, archive.sha256);
    const bundleManifest = path.join(
      admitted.directory,
      `${stage}-bundle-manifest.json`,
    );
    await hashJsonFile(
      bundleManifest,
      admitted.artifacts[path.basename(bundleManifest)],
    );
  }
}

export async function validateDiagnosticReport(file) {
  const report = await readJson(file);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'browser-profile-common-frame-trace-diagnostic-v1');
  assert.equal(report.diagnosticOnly, true);
  assert.equal(report.acceptanceEligible, false);
  assert.equal(report.populationContribution, 0);
  assert.equal(report.thresholdsApplied, false);
  for (const field of [
    'benchmarkKind',
    'configuration',
    'warmup',
    'samples',
    'summary',
  ])
    assert(!Object.hasOwn(report, field), `Canonical field leaked: ${field}`);
  assert.equal(report.observation?.attempts?.length, 1);
  assert.equal(report.observation.status, 'ok');
  return report;
}

export async function runDiagnosticPair({
  owner,
  stages,
  resultsDir,
  signal,
  run = runCommandProcess,
  persist = async () => {},
  validateResult = validateDiagnosticReport,
  afterCompleted = async () => {},
  afterAttempt = async () => {},
}) {
  assert.deepEqual(
    stages.map((stage) => stage.stage),
    ['baseline', 'candidate'],
    'Diagnostic pair stages changed',
  );
  const attempts = ['baseline', 'candidate'].map((stage) => ({
    stage,
    status: 'unstarted',
  }));
  await persist(attempts);
  for (let index = 0; index < stages.length; index++) {
    const stage = stages[index];
    const output = path.join(resultsDir, `${stage.stage}.json`);
    attempts[index] = { stage: stage.stage, status: 'running', output };
    await persist(attempts);
    const vector = diagnosticChildVector(stage.capsule, output, owner);
    let outcome;
    let stageError;
    let attempted = false;
    try {
      attempted = true;
      outcome = await run({ ...vector, signal });
      assertOwnedChildComplete(outcome, `${stage.stage} diagnostic`);
      const result = await validateResult(output);
      attempts[index] = {
        stage: stage.stage,
        status: 'completed',
        output,
        outcome,
        resultSha256: await hashFile(output).catch(() => undefined),
        resultKind: result?.kind,
      };
      await persist(attempts);
    } catch (error) {
      attempts[index] = {
        stage: stage.stage,
        status: 'failed',
        output,
        outcome,
        error: error.stack ?? String(error),
      };
      try {
        await persist(attempts);
      } catch {
        // The first failure remains primary; the optional observer still gets
        // the attempted-stage boundary.
      }
      stageError = error;
    }
    if (!stageError) {
      try {
        await afterCompleted(stage, attempts);
      } catch (error) {
        stageError = error;
      }
    }
    if (attempted)
      try {
        await afterAttempt({ stage, attempts, outcome, error: stageError });
      } catch {
        // Boundary observation is diagnostic-only and must never replace the
        // structural/persistence outcome or prevent the next eligible stage.
      }
    if (stageError) throw stageError;
  }
  return attempts;
}

export async function executeFrameTraceDiagnostic(
  values,
  signal,
  owner,
  dependencies = {},
) {
  const primaryBatch = await realpath(values.primaryBatch);
  const requestedOutput = path.resolve(values.output);
  const outputParent = await realpath(path.dirname(requestedOutput));
  const outputLeaf = path.basename(requestedOutput);
  assert(outputLeaf && outputLeaf !== '.', 'Diagnostic output leaf is invalid');
  const output = path.join(outputParent, outputLeaf);
  const primaryDirectory = path.dirname(primaryBatch);
  assert(
    disjoint(primaryDirectory, output),
    'Diagnostic output must be outside primary evidence',
  );
  const operations = {
    requirements: dependencies.requirements,
    resolveRequirements:
      dependencies.resolveRequirements ??
      diagnosticEvidenceRequirementsForBatchSha256,
    sourceManifest: dependencies.sourceManifest ?? sourceManifest,
    manifest: dependencies.manifest ?? manifest,
    runCommandProcess: dependencies.runCommandProcess ?? runCommandProcess,
    controlIdentity: dependencies.controlIdentity ?? controlIdentity,
    validateDiagnosticReport:
      dependencies.validateDiagnosticReport ?? validateDiagnosticReport,
  };
  const admitted = await admitEvidence(primaryBatch, operations);
  for (const stage of Object.values(admitted.batch.stages))
    assert(
      disjoint(await realpath(stage.root), output),
      'Diagnostic output must be outside original stages',
    );
  await mkdir(output);
  await mkdir(path.join(output, 'stages'));
  await mkdir(path.join(output, 'results'));
  await mkdir(path.join(output, 'overlay'), { recursive: true });
  const pairPath = path.join(output, 'pair.json');
  const controlRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../..',
  );
  const control = operations.controlIdentity(controlRoot);
  await writeJson(path.join(output, 'diagnostic-harness-overlay.json'), {
    schemaVersion: 1,
    control,
    files: Object.entries(admitted.requirements.overlay).map(
      ([relative, identity]) => ({
        relative,
        ...identity,
      }),
    ),
    retainedBytesRoot: path.join(output, 'overlay'),
  });
  const pair = {
    schemaVersion: 1,
    kind: DIAGNOSTIC_KIND,
    diagnosticOnly: true,
    finalAcceptance: false,
    populationContribution: 0,
    primaryBatch,
    primaryBatchSha256: admitted.requirements.batchSha256,
    products: Object.fromEntries(
      ['baseline', 'candidate'].map((stage) => [
        stage,
        {
          commit: admitted.batch.stages[stage].commit,
          productionArchive: admitted.batch.stages[stage].productionArchive,
          primary: admitted.requirements.primary[stage],
        },
      ]),
    ),
    diagnosticHarness: {
      coordinatorSha256: await hashFile(fileURLToPath(import.meta.url)),
      overlay: admitted.requirements.overlay,
      runtimeSupport: admitted.supportIdentity,
      control,
    },
    attempts: ['baseline', 'candidate'].map((stage) => ({
      stage,
      status: 'unstarted',
    })),
    preservationGates: [],
    startedAt: new Date().toISOString(),
  };
  const persist = async (attempts) => {
    pair.attempts = structuredClone(attempts);
    await writeJson(pairPath, pair);
  };
  const observerHooks = {
    beforeFirstDispatch: dependencies.beforeFirstDispatch,
    afterAttempt: dependencies.afterAttempt,
  };
  const retainHostActivity = async (record, boundary, error) => {
    if (record !== undefined) {
      const next = structuredClone(record);
      if (pair.hostActivity?.observationGap) {
        next.observationGap = true;
        next.observationErrors = [
          ...(pair.hostActivity.observationErrors ?? []),
          ...(next.observationErrors ?? []),
        ];
      }
      pair.hostActivity = next;
    } else {
      const existing = pair.hostActivity ?? {};
      pair.hostActivity = {
        ...existing,
        observationGap: true,
        observationErrors: [
          ...(existing.observationErrors ?? []),
          {
            boundary,
            observedAt: new Date().toISOString(),
            error: error?.stack ?? String(error),
          },
        ],
      };
    }
    await persist(pair.attempts);
  };
  await persist(pair.attempts);
  const prepared = [];
  let failure;
  const verifyPreservation = async (gate) => {
    const checks = [];
    const failures = [];
    try {
      await preserveOriginalEvidence(admitted, operations);
      checks.push({ scope: 'original-evidence', status: 'verified' });
    } catch (error) {
      checks.push({
        scope: 'original-evidence',
        status: 'failed',
        error: error.stack ?? String(error),
      });
      failures.push(error);
    }
    for (const stage of prepared) {
      try {
        await preserveStage(stage, output, operations.manifest);
        checks.push({ stage: stage.stage, status: 'verified' });
      } catch (error) {
        checks.push({
          stage: stage.stage,
          status: 'failed',
          error: error.stack ?? String(error),
        });
        failures.push(error);
      }
    }
    const record = { gate, checkedAt: new Date().toISOString(), checks };
    pair.preservationGates.push(record);
    pair.preservation = checks;
    await writeJson(pairPath, pair);
    if (failures.length > 0) throw failures[0];
    return record;
  };
  try {
    for (const stage of ['baseline', 'candidate'])
      prepared.push(
        await prepareStage({
          stage,
          admitted,
          output,
          controlRoot,
          signal,
          run: operations.runCommandProcess,
          manifestImpl: operations.manifest,
        }),
      );
    await verifyPreservation('before-first-dispatch');
    if (observerHooks.beforeFirstDispatch) {
      try {
        await retainHostActivity(
          await observerHooks.beforeFirstDispatch({
            owner,
            output,
            pairPath,
            pair: structuredClone(pair),
          }),
          'before-first-dispatch',
        );
      } catch (error) {
        try {
          await retainHostActivity(
            error?.hostActivity,
            'before-first-dispatch',
            error,
          );
        } catch {
          // The preflight error remains primary; final persistence records any
          // in-memory observation state that could be retained.
        }
        throw error;
      }
    }
    pair.attempts = await runDiagnosticPair({
      owner,
      stages: prepared,
      resultsDir: path.join(output, 'results'),
      signal,
      persist,
      run: operations.runCommandProcess,
      validateResult: operations.validateDiagnosticReport,
      afterCompleted: async (stage) =>
        verifyPreservation(`after-${stage.stage}-dispatch`),
      afterAttempt: async (context) => {
        if (!observerHooks.afterAttempt) return;
        try {
          await retainHostActivity(
            await observerHooks.afterAttempt({
              ...context,
              owner,
              output,
              pairPath,
              pair: structuredClone(pair),
            }),
            `after-${context.stage.stage}`,
          );
        } catch (error) {
          try {
            await retainHostActivity(
              error?.hostActivity,
              `after-${context.stage.stage}`,
              error,
            );
          } catch {
            // Optional observation failures are retained when possible and
            // never replace a completed/failed diagnostic attempt.
          }
        }
      },
    });
  } catch (error) {
    failure = error;
    pair.error = error.stack ?? String(error);
  } finally {
    try {
      await verifyPreservation('final');
    } catch (error) {
      failure ??= error;
    }
    pair.completedAt = new Date().toISOString();
    pair.status = failure ? 'failed' : 'completed';
    await writeJson(pairPath, pair);
  }
  if (failure) throw failure;
  return pair;
}

async function main() {
  const values = parseFrameTraceDiagnosticOptions();
  requireLocalPhysicalMac();
  await withReleaseInterruption((signal) =>
    withLocalReleaseLease(
      (owner) => executeFrameTraceDiagnostic(values, signal, owner),
      { signal },
    ),
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
