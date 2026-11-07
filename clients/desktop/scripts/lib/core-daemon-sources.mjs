/**
 * Source records for the development core daemon and its owned-child addon
 * (GA5, CAN-5540). A build writes `<artifact>.sources.json` beside its output:
 * the artifact's SHA-256, the facts it was built for (Node, platform,
 * identity) and the SHA-256 of every input it read. A dev run compares that
 * record with the checkout, so a source change is never served by a stale
 * binary without notice. Content hashes, not mtimes, decide freshness; an
 * input modified while the build ran leaves no record, so the next run
 * rebuilds.
 */
import { secretProtectionUnavailableReason } from './secret-protection-toolchain.mjs';
import { createHash } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const SOURCES_SCHEMA = 2;
const BUFFER_BYTES = 4 * 1024 * 1024;

export function sourcesRecordPath(artifactPath) {
  return `${artifactPath}.sources.json`;
}

export function hashFile(path) {
  const fd = openSync(path, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(BUFFER_BYTES);
    let length;
    while ((length = readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, length));
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

/** Root-relative POSIX keys keep a record portable between checkouts. */
function inputKey(root, path) {
  const relativePath = relative(root, path);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) return path;
  return relativePath.split(sep).join('/');
}

function inputPath(root, key) {
  return isAbsolute(key) ? key : resolve(root, key);
}

/**
 * Every regular source file under `directory`, recursively. node-gyp `build/`
 * output is not a source: the Windows daemon build rebuilds
 * `windows-pipe/build/` in place. Neither is Finder metadata.
 */
export function filesUnder(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'build') files.push(...filesUnder(path));
    } else if (entry.isFile() && entry.name !== '.DS_Store') files.push(path);
  }
  return files;
}

/**
 * The files an esbuild metafile lists, resolved from `workingDirectory`.
 * Entries in another namespace (`name:path`) are not files.
 */
export function metafileInputs(metafile, workingDirectory) {
  return Object.keys(metafile?.inputs ?? {})
    .filter((key) => !/^[^/\\]{2,}:/.test(key))
    .map((key) => resolve(workingDirectory, key));
}

/** Local modules a build script imports: its own source is an input. */
export async function scriptInputs(root, entry) {
  const { build } = await import('esbuild');
  const result = await build({
    entryPoints: [entry],
    absWorkingDir: root,
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent',
  });
  return metafileInputs(result.metafile, root);
}

/**
 * Writes the record after a successful build. Returns `{ written: false,
 * changed }` without a record when an input changed at or after `startedAtMs`,
 * since the build may have read either version.
 */
export function writeSourcesRecord({
  root,
  artifactPath,
  facts,
  inputs,
  startedAtMs,
  companions = [],
  inputDirectories = [],
  secretProtectionUnavailable = null,
}) {
  const recordPath = sourcesRecordPath(artifactPath);
  rmSync(recordPath, { force: true });
  const hashes = {};
  for (const path of [...new Set(inputs)].sort()) {
    if (statSync(path).mtimeMs >= startedAtMs)
      return { written: false, changed: inputKey(root, path) };
    hashes[inputKey(root, path)] = hashFile(path);
  }
  const directoryInputs = {};
  for (const directory of inputDirectories) {
    const files = filesUnder(directory)
      .map((path) => inputKey(root, path))
      .sort();
    const unrecorded = files.find((key) => !Object.hasOwn(hashes, key));
    if (unrecorded) return { written: false, changed: unrecorded };
    directoryInputs[inputKey(root, directory)] = files;
  }
  const record = {
    schema: SOURCES_SCHEMA,
    secretProtectionUnavailable,
    artifactSha256: hashFile(artifactPath),
    facts,
    inputDirectories: directoryInputs,
    companions: Object.fromEntries(
      companions.map((path) => {
        const key = relative(dirname(artifactPath), path).split(sep).join('/');
        if (!companionKey(key) || !lstatSync(path).isFile())
          throw new Error(`Invalid companion output: ${path}`);
        return [key, hashFile(path)];
      }),
    ),
    inputs: Object.fromEntries(
      Object.entries(hashes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  };
  const temporary = `${recordPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(temporary, recordPath);
  return { written: true, inputs: Object.keys(hashes).length };
}

function isPlainObject(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function companionKey(key) {
  return (
    key.length > 0 &&
    !isAbsolute(key) &&
    !key.includes('\\') &&
    key.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function readRecord(recordPath) {
  let text;
  try {
    text = readFileSync(recordPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const record = JSON.parse(text);
    if (
      isPlainObject(record) &&
      record.schema === SOURCES_SCHEMA &&
      (record.secretProtectionUnavailable == null ||
        (typeof record.secretProtectionUnavailable === 'string' &&
          record.secretProtectionUnavailable.length > 0)) &&
      /^[a-f0-9]{64}$/.test(record.artifactSha256 ?? '') &&
      isPlainObject(record.facts) &&
      isPlainObject(record.inputDirectories) &&
      Object.values(record.inputDirectories).every(
        (files) =>
          Array.isArray(files) && files.every((key) => typeof key === 'string'),
      ) &&
      isPlainObject(record.companions) &&
      Object.entries(record.companions).every(
        ([key, hash]) =>
          companionKey(key) &&
          typeof hash === 'string' &&
          /^[a-f0-9]{64}$/.test(hash),
      ) &&
      isPlainObject(record.inputs) &&
      Object.keys(record.inputs).length > 0 &&
      Object.values(record.inputs).every(
        (hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash),
      )
    )
      return record;
  } catch {
    // An unreadable record is no record.
  }
  return null;
}

/** Recorded source and companion paths for freshness watchers; none without a record. */
export function recordedInputs({ root, artifactPath }) {
  const record = readRecord(sourcesRecordPath(artifactPath));
  return record
    ? [
        ...Object.keys(record.inputs).map((key) => inputPath(root, key)),
        ...Object.keys(record.companions).map((key) =>
          join(dirname(artifactPath), key),
        ),
      ]
    : [];
}

/** Deterministic text for comparing plain JSON facts. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * Compares an artifact with its record and the checkout: `missing` (no
 * artifact), `stale` with a reason, or `fresh`. Never builds or writes.
 */
export function checkSourcesRecord({ root, artifactPath, facts }) {
  try {
    if (!lstatSync(artifactPath).isFile())
      return { state: 'stale', reason: 'is not a regular file' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing' };
    throw error;
  }
  const record = readRecord(sourcesRecordPath(artifactPath));
  if (!record)
    return {
      state: 'stale',
      reason: 'has no source record, so its sources are unknown',
    };
  // An omitted development payload is current only while its prerequisite is
  // still absent. Installing the toolchain triggers one build, not a dev loop.
  if (
    record.secretProtectionUnavailable &&
    record.secretProtectionUnavailable !== secretProtectionUnavailableReason()
  )
    return {
      state: 'stale',
      reason: 'native vault build prerequisites changed',
    };
  for (const key of new Set([
    ...Object.keys(facts),
    ...Object.keys(record.facts),
  ])) {
    if (canonical(record.facts[key]) !== canonical(facts[key]))
      return {
        state: 'stale',
        reason: `was built for ${key} ${canonical(record.facts[key])}, not ${canonical(facts[key])}`,
      };
  }
  for (const [key, files] of Object.entries(record.inputDirectories)) {
    let current;
    try {
      current = filesUnder(inputPath(root, key))
        .map((path) => inputKey(root, path))
        .sort();
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR')
        return { state: 'stale', reason: `input directory ${key} is missing` };
      throw error;
    }
    if (canonical(current) !== canonical(files))
      return {
        state: 'stale',
        reason: `input directory ${key} changed membership`,
      };
  }
  for (const [key, hash] of Object.entries(record.inputs)) {
    let current;
    try {
      current = hashFile(inputPath(root, key));
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR')
        return {
          state: 'stale',
          reason: `was built from ${key}, which no longer exists`,
        };
      throw error;
    }
    if (current !== hash)
      return { state: 'stale', reason: `is older than its source ${key}` };
  }
  for (const [key, hash] of Object.entries(record.companions)) {
    const path = join(dirname(artifactPath), key);
    try {
      if (!lstatSync(path).isFile() || hashFile(path) !== hash)
        return {
          state: 'stale',
          reason: `companion ${key} is not the recorded build`,
        };
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR')
        return { state: 'stale', reason: `companion ${key} is missing` };
      throw error;
    }
  }
  if (hashFile(artifactPath) !== record.artifactSha256)
    return {
      state: 'stale',
      reason: 'is not the build its source record describes',
    };
  return { state: 'fresh', inputs: Object.keys(record.inputs).length };
}
