import { ensureWorkspaceWriteDirectory } from './cowork-folder-guard';
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readlink, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  instructionFileErrorCode,
  InstructionCounterpartCopyError,
  isDirectInstructionAlias,
  EDITABLE_INSTRUCTION_ALIAS_RULES,
  resolveProjectInstructionFile,
  UnsupportedInstructionLayoutError,
} from '@canopy/core-runtime/node/workspace/instruction-files';
import type {
  ChatProjectClaudeMdResponse,
  ChatProjectInstructionFileName,
  SaveChatProjectClaudeMdResult,
} from '@canopy/desktop-shared/types';
import { createInstructionCounterpartExclusive } from './instruction-files';
import { serializeChatProjectOperation } from './chat-project-operation-queue';

const names: readonly ChatProjectInstructionFileName[] = [
  'AGENTS.md',
  'CLAUDE.md',
];
const epochs = new Map<string, number>();
class InstructionsChangedError extends Error {}
type Entry = { stats: Stats; bytes?: Buffer; link?: string };
type Observation = {
  response: ChatProjectClaudeMdResponse;
  entries: Record<ChatProjectInstructionFileName, Entry | undefined>;
};

function identity(stats: Stats): string {
  return [
    stats.dev,
    stats.ino,
    stats.mode,
    stats.size,
    stats.mtimeMs,
    stats.ctimeMs,
  ].join(':');
}

async function optionalStat(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (instructionFileErrorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

async function observe(root: string): Promise<Observation> {
  let rootStat: Stats | undefined;
  try {
    rootStat = await stat(root);
    if (!rootStat.isDirectory())
      throw new UnsupportedInstructionLayoutError(
        'The instructions folder must be a directory.',
      );
  } catch (error) {
    if (instructionFileErrorCode(error) !== 'ENOENT') throw error;
  }
  const entries: Observation['entries'] = {
    'AGENTS.md': undefined,
    'CLAUDE.md': undefined,
  };
  for (const name of names) {
    const path = join(root, name);
    const stats = await optionalStat(path);
    if (!stats) continue;
    if (!stats.isFile() && !stats.isSymbolicLink())
      throw new UnsupportedInstructionLayoutError(
        `${name} must be a regular file or a link to the other instruction file in this folder.`,
      );
    entries[name] = { stats };
  }
  for (const name of names) {
    const entry = entries[name];
    if (!entry) continue;
    const path = join(root, name);
    if (entry.stats.isSymbolicLink()) {
      const other = name === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md';
      const target = entries[other];
      const linkTarget = await readlink(path);
      if (
        target?.stats.isSymbolicLink() ||
        !(await isDirectInstructionAlias(
          path,
          join(root, other),
          { readlink: () => Promise.resolve(linkTarget) },
          EDITABLE_INSTRUCTION_ALIAS_RULES,
        ))
      )
        throw new UnsupportedInstructionLayoutError(
          `Cannot edit ${name} through this symbolic link. Use a link to the other instruction file in the same folder.`,
        );
      entry.link = linkTarget;
    } else {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (identity(await file.stat()) !== identity(entry.stats))
          throw new InstructionsChangedError(
            'The instructions changed while loading. Reload the folder.',
          );
        entry.bytes = await file.readFile();
        if (identity(await file.stat()) !== identity(entry.stats))
          throw new InstructionsChangedError(
            'The instructions changed while loading. Reload the folder.',
          );
      } finally {
        await file.close();
      }
    }
  }
  // Resolve against the same observed entries, rather than a second set of reads.
  const observedEntry = (path: string): Entry | undefined =>
    path === join(root, 'AGENTS.md')
      ? entries['AGENTS.md']
      : entries['CLAUDE.md'];
  const target = await resolveProjectInstructionFile(root, {
    lstat: (path) => {
      const entry = observedEntry(path);
      return entry
        ? Promise.resolve(entry.stats)
        : Promise.reject(
            Object.assign(new Error('Missing instruction file'), {
              code: 'ENOENT',
            }),
          );
    },
    readlink: (path) => Promise.resolve(observedEntry(path)?.link ?? ''),
    readText: (path) =>
      Promise.resolve(observedEntry(path)?.bytes?.toString('utf8') ?? ''),
    assertReadable: () => Promise.resolve(),
  });
  const empty = !entries['AGENTS.md'] && !entries['CLAUDE.md'];
  const fileName =
    empty || target.filePath === join(root, 'CLAUDE.md')
      ? 'CLAUDE.md'
      : 'AGENTS.md';
  const counterpart = fileName === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md';
  const layout =
    entries[counterpart]?.link !== undefined
      ? 'alias'
      : target.mirrorPath
        ? 'mirrors'
        : entries[counterpart]
          ? 'divergent'
          : 'create-counterpart';
  const hash = createHash('sha256').update(
    JSON.stringify([
      root,
      rootStat ? [rootStat.dev, rootStat.ino] : null,
      epochs.get(root) ?? 0,
    ]),
  );
  for (const name of names) {
    const entry = entries[name];
    hash.update(
      JSON.stringify([name, entry ? identity(entry.stats) : null, entry?.link]),
    );
    if (entry?.bytes) hash.update(entry.bytes);
  }
  return {
    entries,
    response: {
      content: entries[fileName]?.bytes?.toString('utf8') ?? '',
      fileName,
      layout,
      revision: hash.digest('hex'),
    },
  };
}

/** Read-only, including when a managed home does not exist yet. */
export async function loadChatProjectInstructions(
  rootDir: string,
): Promise<ChatProjectClaudeMdResponse> {
  return (await observe(resolve(rootDir))).response;
}

/**
 * Writes use an exclusively created or no-follow descriptor and preserve existing
 * inodes. Revision validation is not a filesystem transaction: another process
 * can still write an opened inode or replace an ancestor directory after checks.
 */
async function writeObservedFile(
  root: string,
  name: ChatProjectInstructionFileName,
  entry: Entry | undefined,
  content: string,
  writing: () => void,
): Promise<void> {
  if (entry?.bytes?.toString('utf8') === content) return;
  const flags =
    constants.O_RDWR |
    constants.O_NOFOLLOW |
    (entry ? 0 : constants.O_CREAT | constants.O_EXCL);
  let file;
  try {
    file = await open(join(root, name), flags, 0o666);
  } catch (error) {
    if (
      ['EEXIST', 'ELOOP', 'ENOENT'].includes(
        instructionFileErrorCode(error) ?? '',
      )
    )
      throw new InstructionsChangedError(
        'The instruction file changed. Reload the folder before saving.',
      );
    throw error;
  }
  try {
    if (entry && identity(await file.stat()) !== identity(entry.stats))
      throw new InstructionsChangedError(
        'The instruction file changed. Reload the folder before saving.',
      );
    writing();
    // Write at an explicit offset, handling partial system writes.
    const bytes = Buffer.from(content, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.write(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (result.bytesWritten === 0)
        throw new Error('The instruction file could not be written.');
      offset += result.bytesWritten;
    }
    await file.truncate(bytes.length);
    await file.sync();
  } finally {
    await file.close();
  }
}

function conflict(): SaveChatProjectClaudeMdResult {
  return {
    status: 'conflict',
    reloadRequired: true,
    message:
      'The instructions folder changed. Reload it before saving. Your edits have not been saved.',
  };
}

export async function saveChatProjectInstructions(
  rootDir: string,
  request: { content: string; revision: string },
): Promise<SaveChatProjectClaudeMdResult> {
  if (
    typeof request.content !== 'string' ||
    typeof request.revision !== 'string' ||
    !request.revision
  )
    throw new Error('Instructions and a loaded revision are required.');
  const root = resolve(rootDir);
  return serializeChatProjectOperation(async () => {
    let observed;
    try {
      observed = await observe(root);
    } catch (error) {
      if (
        error instanceof InstructionsChangedError ||
        error instanceof UnsupportedInstructionLayoutError ||
        ['ELOOP', 'ENOENT'].includes(instructionFileErrorCode(error) ?? '')
      )
        return conflict();
      throw error;
    }
    if (observed.response.revision !== request.revision) return conflict();
    const { fileName, layout } = observed.response;
    const counterpart = fileName === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md';
    const savedFiles: ChatProjectInstructionFileName[] = [];
    let failedFile = fileName;
    let stage: 'primary' | 'mirror' | 'counterpart' = 'primary';
    let mayHaveChanged = false;
    // Invalidates even a partial/no-op attempt; callers must reload before retry.
    epochs.set(root, (epochs.get(root) ?? 0) + 1);
    try {
      await ensureWorkspaceWriteDirectory(root);
      await writeObservedFile(
        root,
        fileName,
        observed.entries[fileName],
        request.content,
        () => {
          mayHaveChanged = true;
        },
      );
      savedFiles.push(fileName);
      failedFile = counterpart;
      mayHaveChanged = false;
      if (layout === 'mirrors') {
        stage = 'mirror';
        // Hard links already contain the new bytes; regular copies need a write.
        const primary = observed.entries[fileName]?.stats;
        const mirror = observed.entries[counterpart]?.stats;
        if (
          !primary ||
          !mirror ||
          primary.dev !== mirror.dev ||
          primary.ino !== mirror.ino
        )
          await writeObservedFile(
            root,
            counterpart,
            observed.entries[counterpart],
            request.content,
            () => {
              mayHaveChanged = true;
            },
          );
        savedFiles.push(counterpart);
      } else if (layout === 'create-counterpart') {
        stage = 'counterpart';
        await createInstructionCounterpartExclusive(root, fileName);
      }
      return { status: 'saved' };
    } catch (error) {
      if (error instanceof InstructionCounterpartCopyError)
        mayHaveChanged = true;
      if (savedFiles.length === 0 && !mayHaveChanged) {
        if (error instanceof InstructionsChangedError) return conflict();
        throw error;
      }
      const message =
        stage === 'counterpart'
          ? mayHaveChanged
            ? `${fileName} was saved, but ${counterpart} could not be fully copied and may have changed. Reload the folder before saving again.`
            : `${fileName} was saved, but ${counterpart} could not be paired. Reload the folder before saving again.`
          : stage === 'mirror'
            ? `${fileName} was saved, but ${counterpart} could not be fully saved. Reload the folder before saving again.`
            : `${fileName} could not be fully saved and may have changed. Reload the folder before saving again.`;
      return {
        status: 'partial-save',
        reloadRequired: true,
        savedFiles,
        failedFile,
        stage,
        failedFileMayHaveChanged: mayHaveChanged,
        message,
      };
    }
  });
}
