/**
 * Materializes a chat's selected skills and commands into the private
 * `~/.cursor` of its per-chat HOME overlay, where the pinned Cursor CLI
 * discovers them natively (`skills/<id>/SKILL.md`, `commands/<id>.md`).
 *
 * Skills are copied, not linked: the CLI realpath-checks skill entries against
 * their root and only follows links conditionally. The copy is bounded and
 * skips symbolic links so a skill cannot pull arbitrary files into the root.
 * Every turn rebuilds the root to exactly the current selection — an entry
 * that is no longer selected is removed, an unchanged one is left alone.
 * "Unchanged" is decided from a fingerprint of file paths, sizes, and mtimes
 * kept in a sidecar, so a turn whose selection has not changed on disk reads
 * no skill content at all: this runs on the Electron main process. That is a
 * heuristic, not an equivalence: an edit that keeps a file's size and mtime
 * (an mtime-preserving restore, a same-size rewrite within the filesystem's
 * mtime granularity) is not noticed, and the previous copy stays in the root
 * until the tree changes in a way the fingerprint sees. The trade is made
 * deliberately for the main process; a content digest would read every
 * selected file on every turn. Copilot opts into bounded content verification
 * of both the source and private copy, including executable mode, on each turn.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  open,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  CURSOR_INVOCATION_ID_PATTERN,
  type CursorCapabilityProjection,
} from '../../lib/cursor-capabilities';

export interface CursorCapabilityRootOptions {
  /** Total bytes of regular files a skill may contain. Default 25 MiB. */
  maxSkillBytes?: number;
  /** Regular files a skill may contain. Default 2,000. */
  maxSkillFiles?: number;
  /** Verify source and private-copy bytes instead of relying on metadata. */
  verifyContent?: boolean;
  /** Cancel bounded file reads while preparing a turn. */
  signal?: AbortSignal;
}

export interface CursorCapabilityRootResult {
  /** Deterministic generation of the materialized sidecar (skill metadata, command content). */
  fingerprint: string;
  /** Ids now present under `skills/`, in projection order. */
  skillIds: string[];
  /** Ids now present under `commands/`, in projection order. */
  commandIds: string[];
  /** Selections that were not loaded, or were loaded with a difference. */
  warnings: string[];
}

const DEFAULT_MAX_SKILL_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_SKILL_FILES = 2000;
const SIDECAR = '.canopy-capabilities.json';
const TEMP_PREFIX = '.tmp-';

interface Sidecar {
  /** 2: skills are keyed by a metadata fingerprint, not a content digest. */
  version: 2;
  /** Skill id → fingerprint of the tree that was copied. */
  skills: Record<string, string>;
  /** Command id → digest of the file that was written. */
  commands: Record<string, string>;
}
const SIDECAR_VERSION = 2;
type SkillLimits = Required<
  Pick<CursorCapabilityRootOptions, 'maxSkillBytes' | 'maxSkillFiles'>
>;

/** Own-key check that ignores `Object.prototype` names such as `constructor`. */
function hasOwn(record: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function missing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Cursor private environment is invalid.');
}

async function readSidecar(file: string): Promise<Sidecar> {
  const empty: Sidecar = { version: SIDECAR_VERSION, skills: {}, commands: {} };
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      !('version' in parsed) ||
      parsed.version !== SIDECAR_VERSION
    )
      return empty;
    return {
      version: SIDECAR_VERSION,
      skills: stringRecord('skills' in parsed ? parsed.skills : undefined),
      commands: stringRecord(
        'commands' in parsed ? parsed.commands : undefined,
      ),
    };
  } catch {
    return empty;
  }
}

function stringRecord(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return result;
  for (const [key, entry] of Object.entries(value))
    if (typeof entry === 'string') result[key] = entry;
  return result;
}

async function writeAtomically(file: string, content: string): Promise<void> {
  const temporary = join(join(file, '..'), `${TEMP_PREFIX}${randomUUID()}`);
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

interface SkillTree {
  /** Regular files, source-relative, sorted. */
  files: string[];
  /** Symbolic links that were skipped, source-relative. */
  skipped: string[];
  bytes: number;
  /** Hash of every file's path, size, and mtime: cheap, and no content read. */
  fingerprint: string;
}

async function scanSkill(
  sourceDir: string,
  limits: SkillLimits,
  verifyContent = false,
  signal?: AbortSignal,
): Promise<SkillTree | { tooLarge: true }> {
  const files: string[] = [];
  const skipped: string[] = [];
  let bytes = 0;
  const hash = createHash('sha256');
  if (verifyContent) hash.update('content-v1\0');
  const walk = async (directory: string, depth = 0): Promise<void> => {
    signal?.throwIfAborted();
    if (verifyContent && depth > 64) throw new TooLargeError();
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (left, right) => (left.name < right.name ? -1 : 1),
    );
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const rel = relative(sourceDir, absolute).split(sep).join('/');
      if (entry.isSymbolicLink()) {
        skipped.push(rel);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = verifyContent ? await lstat(absolute) : await stat(absolute);
      if (
        bytes + info.size > limits.maxSkillBytes ||
        files.length + 1 > limits.maxSkillFiles
      )
        throw new TooLargeError();
      files.push(rel);
      hash.update(rel).update('\0');
      if (verifyContent) {
        if (!info.isFile() || (await realpath(absolute)) !== absolute)
          throw new Error('Skill content changed while being read.');
        hash.update(String(info.mode & 0o111)).update('\0');
        const content = createHash('sha256');
        for await (const data of readSkillFile(absolute, signal)) {
          bytes += data.byteLength;
          if (bytes > limits.maxSkillBytes) throw new TooLargeError();
          content.update(data);
        }
        hash.update(content.digest('hex')).update('\0');
      } else {
        bytes += info.size;
        hash
          .update(String(info.size))
          .update('\0')
          .update(String(info.mtimeMs))
          .update('\0');
      }
    }
  };
  try {
    await walk(sourceDir);
  } catch (error) {
    if (error instanceof TooLargeError) return { tooLarge: true };
    throw error;
  }
  return { files, skipped, bytes, fingerprint: hash.digest('hex') };
}

class TooLargeError extends Error {}

async function* readSkillFile(
  file: string,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  signal?.throwIfAborted();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile())
      throw new Error('Skill content is not a regular file.');
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      highWaterMark: 64 * 1024,
      signal,
    })) {
      const data: unknown = chunk;
      if (!Buffer.isBuffer(data))
        throw new Error('Skill content could not be read.');
      yield data;
    }
  } finally {
    await handle.close();
  }
}

/** Copy verified-mode files with the same bound and cancellation as hashing. */
async function copyBoundedFile(
  source: string,
  target: string,
  remainingBytes: number,
  signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted();
  const sourceInfo = await lstat(source);
  if ((await realpath(source)) !== source || !sourceInfo.isFile())
    throw new Error('Skill source changed while being copied.');
  const output = await open(target, 'wx', sourceInfo.mode & 0o777);
  let bytes = 0;
  try {
    // Creation applies the process umask; verification needs the source's exec bits.
    await output.chmod(sourceInfo.mode & 0o777);
    for await (const data of readSkillFile(source, signal)) {
      bytes += data.byteLength;
      if (bytes > remainingBytes) throw new TooLargeError();
      let offset = 0;
      while (offset < data.byteLength) {
        signal?.throwIfAborted();
        const { bytesWritten } = await output.write(
          data,
          offset,
          data.byteLength - offset,
        );
        if (bytesWritten === 0)
          throw new Error('Skill content could not be copied.');
        offset += bytesWritten;
      }
    }
    return bytes;
  } finally {
    await output.close();
  }
}

async function copySkill(
  sourceDir: string,
  files: readonly string[],
  target: string,
  skillsDir: string,
  verification?: {
    verify: (temporary: string) => Promise<void>;
    maxBytes: number;
    signal?: AbortSignal;
  },
): Promise<void> {
  const temporary = join(skillsDir, `${TEMP_PREFIX}${randomUUID()}`);
  try {
    await mkdir(temporary, { mode: 0o700 });
    let copiedBytes = 0;
    for (const rel of files) {
      const destination = join(temporary, ...rel.split('/'));
      await mkdir(join(destination, '..'), { recursive: true, mode: 0o700 });
      const source = join(sourceDir, ...rel.split('/'));
      if (verification) {
        copiedBytes += await copyBoundedFile(
          source,
          destination,
          verification.maxBytes - copiedBytes,
          verification.signal,
        );
      } else {
        await copyFile(source, destination);
      }
    }
    await verification?.verify(temporary);
    await rm(target, { recursive: true, force: true });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function materializeCursorCapabilityRoot(
  home: string,
  projection: CursorCapabilityProjection,
  options?: CursorCapabilityRootOptions,
): Promise<CursorCapabilityRootResult> {
  return materializeSelectedCapabilityRoot(
    join(home, '.cursor'),
    projection,
    options,
  );
}

/** Portable selected-capability projection, also used by the Copilot SDK. */
export async function materializeSelectedCapabilityRoot(
  cursorDir: string,
  projection: CursorCapabilityProjection,
  options?: CursorCapabilityRootOptions,
): Promise<CursorCapabilityRootResult> {
  options?.signal?.throwIfAborted();
  const limits: SkillLimits = {
    maxSkillBytes: options?.maxSkillBytes ?? DEFAULT_MAX_SKILL_BYTES,
    maxSkillFiles: options?.maxSkillFiles ?? DEFAULT_MAX_SKILL_FILES,
  };
  await privateDirectory(cursorDir);
  // Trusted host paths may contain an OS alias (macOS /var -> /private/var).
  // Anchor verification to that root's canonical path, while still refusing
  // links in the private directories and in the selected skill content.
  const privateRoot = options?.verifyContent
    ? await realpath(cursorDir)
    : cursorDir;
  const skillsDir = join(privateRoot, 'skills');
  const commandsDir = join(privateRoot, 'commands');
  for (const directory of [skillsDir, commandsDir])
    await privateDirectory(directory);
  const sidecarFile = join(privateRoot, SIDECAR);
  const previous = await readSidecar(sidecarFile);
  const next: Sidecar = { version: SIDECAR_VERSION, skills: {}, commands: {} };
  const warnings: string[] = [];
  const skillIds: string[] = [];
  const commandIds: string[] = [];

  for (const skill of projection.skills) {
    if (
      !CURSOR_INVOCATION_ID_PATTERN.test(skill.id) ||
      hasOwn(next.skills, skill.id)
    ) {
      warnings.push(
        `Skill "${skill.label}" has an invalid id "${skill.id}" and was not loaded.`,
      );
      continue;
    }
    const target = join(skillsDir, skill.id);
    let tree: SkillTree | { tooLarge: true };
    try {
      // The source is handed over canonical (see `CursorProjectedSkill`), so
      // a link anywhere in it — not only its last segment — makes it resolve
      // somewhere else and is refused; the walk only skips links it finds
      // inside the tree.
      if ((await realpath(skill.sourceDir)) !== skill.sourceDir)
        throw new Error('source path is not canonical');
      if (!(await lstat(skill.sourceDir)).isDirectory())
        throw new Error('source is not a directory');
      if (!(await lstat(join(skill.sourceDir, 'SKILL.md'))).isFile())
        throw new Error('SKILL.md is not a regular file');
      tree = await scanSkill(
        skill.sourceDir,
        limits,
        options?.verifyContent,
        options?.signal,
      );
    } catch (error) {
      options?.signal?.throwIfAborted();
      warnings.push(
        `Skill "${skill.label}" could not be read and was not loaded: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    if ('tooLarge' in tree) {
      warnings.push(
        `Skill "${skill.label}" is larger than ${Math.round(limits.maxSkillBytes / 1024 / 1024)} MB or ${limits.maxSkillFiles} files and was not loaded.`,
      );
      continue;
    }
    for (const rel of tree.skipped)
      warnings.push(
        `Skill "${skill.label}": skipped "${rel}" (symbolic links are not copied).`,
      );
    const expectedFingerprint = tree.fingerprint;
    const verifyCopy = async (directory: string): Promise<void> => {
      if (!options?.verifyContent) return;
      if (
        (await realpath(directory)) !== directory ||
        !(await lstat(directory)).isDirectory()
      )
        throw new Error('Private skill copy is invalid.');
      const copied = await scanSkill(directory, limits, true, options.signal);
      if (
        'tooLarge' in copied ||
        copied.skipped.length > 0 ||
        copied.fingerprint !== expectedFingerprint
      )
        throw new Error('Skill content changed while being copied.');
    };
    let current = false;
    if (previous.skills[skill.id] === tree.fingerprint) {
      try {
        current = (await lstat(target)).isDirectory();
        if (current) await verifyCopy(target);
      } catch (error) {
        options?.signal?.throwIfAborted();
        if (!options?.verifyContent && !missing(error)) throw error;
        current = false;
      }
    }
    if (!current) {
      try {
        await copySkill(
          skill.sourceDir,
          tree.files,
          target,
          skillsDir,
          options?.verifyContent
            ? {
                verify: verifyCopy,
                maxBytes: limits.maxSkillBytes,
                signal: options.signal,
              }
            : undefined,
        );
      } catch (error) {
        options?.signal?.throwIfAborted();
        warnings.push(
          `Skill "${skill.label}" could not be copied and was not loaded: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await rm(target, { recursive: true, force: true });
        continue;
      }
    }
    next.skills[skill.id] = tree.fingerprint;
    skillIds.push(skill.id);
  }

  for (const command of projection.commands) {
    if (
      !CURSOR_INVOCATION_ID_PATTERN.test(command.id) ||
      hasOwn(next.commands, command.id)
    ) {
      warnings.push(
        `Command "${command.label}" has an invalid id "${command.id}" and was not loaded.`,
      );
      continue;
    }
    const file = join(commandsDir, `${command.id}.md`);
    const digest = createHash('sha256').update(command.markdown).digest('hex');
    let current = false;
    if (previous.commands[command.id] === digest) {
      try {
        current =
          (await lstat(file)).isFile() &&
          (await readFile(file, 'utf8')) === command.markdown;
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    if (!current) await writeAtomically(file, command.markdown);
    next.commands[command.id] = digest;
    commandIds.push(command.id);
  }

  // Everything else under the two roots is stale: an earlier selection, a
  // temporary directory from an interrupted copy, or something the CLI wrote.
  for (const entry of await readdir(skillsDir))
    if (!hasOwn(next.skills, entry))
      await rm(join(skillsDir, entry), { recursive: true, force: true });
  for (const entry of await readdir(commandsDir))
    if (!entry.endsWith('.md') || !hasOwn(next.commands, entry.slice(0, -3)))
      await rm(join(commandsDir, entry), { recursive: true, force: true });
  await writeAtomically(sidecarFile, JSON.stringify(next));
  const entries = (record: Record<string, string>): Array<[string, string]> =>
    Object.entries(record).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        SIDECAR_VERSION,
        entries(next.skills),
        entries(next.commands),
      ]),
    )
    .digest('hex');
  return { skillIds, commandIds, warnings, fingerprint };
}
