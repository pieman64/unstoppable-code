import { lstat, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  MEMORY_INDEX_PATH,
  compareMemoryChangeCursors,
  memoryDocumentIdentity,
  type MemoryChange,
  type MemoryDocument,
  type MemoryDocumentChange,
  type MemoryNoteRecord,
  type MemorySyncStateFile,
} from '@canopy/protocol/memory-sync';
import {
  recordMemoryEdit,
  withMemoryWriteLock,
} from '../local/edit-coordination';
import {
  isLiveImportEntry,
  readImportState,
  retireImportNotes,
  stampImportNotesConsolidated,
  writeImportState,
} from '../local/import/ledger';
import {
  assertMemoryPathContained,
  assertMemoryScopeLockHeld,
  ensureOwnerOnlyMemoryDir,
  isMemoryMarkdownFileName,
  isNodeError,
  moveWithoutReplacing,
  writeMemoryFileAtomically,
  writeMemoryFileDurably,
} from '../local/memory-files';
import {
  memoryNoteId,
  readMemoryNoteFrontMatter,
} from '../local/note-identity';
import { createLocalMemorySnapshot } from '../local/snapshots';
import { inboxNoteBody, renderPulledNote } from './note-records';
import {
  readMemorySyncOutbox,
  readMemorySyncState,
  recordMemorySyncConflict,
  sha256Hex,
  writeMemorySyncState,
} from './replica-files';
import { memorySyncPrivateDir } from './replica-layout';

/*
 * The replica writer (design §16.5): applies a snapshot or a page of changes
 * to a replica under its scope lock, files first and `sync-state.json` last.
 * A crash between them replays the page, so every step is idempotent: a note
 * already on disk is left alone, a document already holding the incoming
 * bytes is not rewritten, and a revision at or below the base is skipped.
 *
 * A document edited here and not yet committed is never lost: before a
 * pulled revision or a snapshot replaces, deletes or moves it aside, its
 * bytes are kept under `.sync/conflicts/` and the conflict is recorded
 * (CAN-5186 adds the three-way merge). Files a snapshot does not list are
 * moved to `.sync/displaced/`, never deleted, and only when their content is
 * preserved elsewhere (see `preservedElsewhere`): what only this device has
 * stays where it is.
 */

/** The replica's state does not continue from what was pulled: take a snapshot. */
export class MemoryReplicaGapError extends Error {
  constructor(readonly reason: 'revision_gap' | 'cursor_mismatch' | 'state') {
    super(`The memory replica needs a snapshot (${reason})`);
    this.name = 'MemoryReplicaGapError';
  }
}

export interface MemoryReplicaWriteOptions {
  /** This device, whose own withheld notes stay as local-only. */
  deviceId: string;
  /**
   * Organizations the account policy keeps off the cloud (design §10.4):
   * this device's user-scope notes saved under them are withheld, so a
   * snapshot keeps them as local-only.
   */
  blockedOriginOrganizationIds: ReadonlySet<string>;
  now: () => Date;
}

export interface MemoryReplicaSnapshot {
  revision: number;
  cursor: string;
  documents: readonly MemoryDocument[];
  pendingNotes: readonly MemoryNoteRecord[];
}

export interface MemoryReplicaApplyResult {
  /** Documents written or deleted. */
  documentsChanged: number;
  notesWritten: number;
  notesRemoved: number;
  conflicts: number;
}

interface LocalNote {
  fileKey: string;
  path: string;
  archived: boolean;
  /**
   * Saved on this device: its front matter names this device or none, or it
   * is an import staged here rather than pulled.
   */
  own: boolean;
  /**
   * An import its ledger has not stamped consolidated: it claims its staged
   * path even while its file is gone (an archive cut short after the move).
   */
  pendingImport: boolean;
  /** The organization an inbox note was saved under (design §10.4). */
  originOrganizationId: string | null;
}

interface OutboxNotes {
  readable: boolean;
  held: Set<string>;
  retired: Set<string>;
}

/** A replica file a pull or a snapshot would move aside, remove or replace. */
type ReplicaFile =
  | { kind: 'document'; path: string; live: string }
  | { kind: 'note'; noteId: string; local: LocalNote };

type SnapshotKept = NonNullable<MemorySyncStateFile['snapshotKept']>;

const IMPORT_SYNC_SOURCE_PREFIX = 'sync:';

/** Where a conflict's copy of a local edit is, relative to the replica. */
const CONFLICTS_PREFIX = '.sync/conflicts/';

/** Names tried for a pulled note before giving up. */
const MAX_PULLED_NOTE_NAMES = 100;

/** A live note holds its file key; a pending import even while its file is gone. */
function claimsFileKey(local: LocalNote): boolean {
  return !local.archived || local.pendingImport;
}

function emptyResult(): MemoryReplicaApplyResult {
  return {
    documentsChanged: 0,
    notesWritten: 0,
    notesRemoved: 0,
    conflicts: 0,
  };
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) {
      return null;
    }
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

async function markdownNames(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && isMemoryMarkdownFileName(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) {
      return [];
    }
    throw error;
  }
}

async function removeMemoryFile(scopeDir: string, path: string): Promise<void> {
  await assertMemoryPathContained(scopeDir, dirname(path));
  await assertMemoryScopeLockHeld();
  try {
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
}

/**
 * The other spellings of a topic's file under `root`: topic identity is
 * case-folded, so `topics/Travel.md` and `topics/travel.md` are one
 * document. On a case-insensitive file system both name one file.
 */
async function otherSpellings(root: string, path: string): Promise<string[]> {
  if (path === MEMORY_INDEX_PATH) return [];
  const identity = memoryDocumentIdentity(path);
  return (await markdownNames(join(root, dirname(path))))
    .map((name) => `${dirname(path)}/${name}`)
    .filter(
      (other) => other !== path && memoryDocumentIdentity(other) === identity,
    );
}

async function isSameFile(left: string, right: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([
      lstat(left, { bigint: true }),
      lstat(right, { bigint: true }),
    ]);
    return a.dev === b.dev && a.ino === b.ino;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

/** Gives the one file of a case-insensitive file system `target`'s spelling. */
async function respellMemoryFile(
  scopeDir: string,
  source: string,
  target: string,
): Promise<void> {
  await assertMemoryPathContained(scopeDir, dirname(source));
  await assertMemoryScopeLockHeld();
  await rename(source, target);
}

async function indexInboxNotes(
  scopeDir: string,
  deviceId: string,
  notes: Map<string, LocalNote>,
): Promise<void> {
  const folders = [
    { folder: 'inbox', archived: false },
    { folder: join('inbox', '.consolidated'), archived: true },
  ];
  for (const { folder, archived } of folders) {
    for (const name of await markdownNames(join(scopeDir, folder))) {
      const path = join(scopeDir, folder, name);
      const content = await readTextOrNull(path);
      const id = content === null ? null : memoryNoteId(content);
      if (content === null || id === null) continue;
      if (notes.get(id)?.archived === false) continue;
      const fields = readMemoryNoteFrontMatter(content)?.fields;
      const device = fields?.device;
      const origin = fields?.origin;
      notes.set(id, {
        fileKey: `inbox/${name}`,
        path,
        archived,
        own: typeof device !== 'string' || device === deviceId,
        pendingImport: false,
        originOrganizationId:
          typeof origin === 'object' ? (origin.organizationId ?? null) : null,
      });
    }
  }
}

/**
 * Imports by note ID. Only a pending import claims its staged path: a
 * retired one is left out, and a consolidated one lives in `.consolidated/`,
 * so a later import staged under the same name is never taken for either.
 * A pending import whose file is gone still claims its path, so no later
 * import is written there for it to take.
 */
async function indexImports(
  scopeDir: string,
  notes: Map<string, LocalNote>,
): Promise<void> {
  const imports = await readImportState(scopeDir);
  for (const [source, entry] of Object.entries(imports.sources)) {
    if (!isLiveImportEntry(entry) || entry.noteId === undefined) continue;
    const path = join(scopeDir, entry.stagedAs);
    const pendingImport = entry.consolidatedAt === undefined;
    const archived = !pendingImport || !(await exists(path));
    notes.set(entry.noteId, {
      fileKey: entry.stagedAs,
      path: archived
        ? join(scopeDir, 'imported', '.consolidated', basename(entry.stagedAs))
        : path,
      archived,
      own: !source.startsWith(IMPORT_SYNC_SOURCE_PREFIX),
      pendingImport,
      originOrganizationId: null,
    });
  }
}

/** Every note in the replica by ID: inbox notes, archived ones and imports. */
async function indexLocalNotes(
  scopeDir: string,
  deviceId: string,
): Promise<Map<string, LocalNote>> {
  const notes = new Map<string, LocalNote>();
  await indexInboxNotes(scopeDir, deviceId, notes);
  await indexImports(scopeDir, notes);
  return notes;
}

function isImportFileKey(fileKey: string): boolean {
  return fileKey.startsWith('imported/');
}

function timestampSlug(at: Date): string {
  return at.toISOString().replace(/[-:.]/g, '');
}

/** Moves a file to a free name in `directory`, keeping its own name first. */
async function moveToFreeName(
  scopeDir: string,
  source: string,
  directory: string,
): Promise<string> {
  await ensureOwnerOnlyMemoryDir(scopeDir, directory);
  const name = basename(source);
  const stem = name.endsWith('.md') ? name.slice(0, -3) : name;
  for (let attempt = 1; ; attempt += 1) {
    const destination = join(
      directory,
      attempt === 1 ? name : `${stem}-${attempt}.md`,
    );
    try {
      await moveWithoutReplacing(scopeDir, source, destination);
      return destination;
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }
  }
}

class ReplicaApply {
  private notes: Map<string, LocalNote> | null = null;
  private outboxNotes: OutboxNotes | null = null;
  private snapshotTaken = false;
  private editRecorded = false;
  private displacedDir: string | null = null;
  /** What this replica last applied per document, as the changes go. */
  private readonly base: MemorySyncStateFile['baseDocuments'];
  readonly result = emptyResult();

  constructor(
    private readonly scopeDir: string,
    private readonly state: MemorySyncStateFile,
    private readonly options: MemoryReplicaWriteOptions,
  ) {
    this.base = { ...state.baseDocuments };
  }

  async noteIndex(): Promise<Map<string, LocalNote>> {
    this.notes ??= await indexLocalNotes(this.scopeDir, this.options.deviceId);
    return this.notes;
  }

  /** Before the first document write: a `sync` snapshot and a new revision. */
  private async beforeDocumentWrite(): Promise<void> {
    if (!this.snapshotTaken) {
      this.snapshotTaken = true;
      await createLocalMemorySnapshot(
        this.scopeDir,
        'sync',
        this.options.now(),
      );
    }
    if (!this.editRecorded) {
      this.editRecorded = true;
      await recordMemoryEdit(this.scopeDir);
    }
  }

  private keepLocalOnly(noteId: string): void {
    if (!this.state.localOnlyNoteIds.includes(noteId)) {
      this.state.localOnlyNoteIds.push(noteId);
    }
  }

  /**
   * Keeps a document's uncommitted local bytes before they are replaced or
   * removed: the copy is flushed to disk, then its conflict is recorded in
   * `sync-state.json`, flushed too, since the copy is then the edit's only
   * place and the record the only way to find it. A replayed pull keeps
   * neither twice: an edit a recorded copy holds is kept already, and a copy
   * cut short before its record is recorded rather than written again. A
   * conflict file is never replaced.
   */
  private async keepLocalEdit(
    path: string,
    live: string,
    theirsRevision: number,
    spelling = path,
  ): Promise<void> {
    if (await this.recordedCopyHolds(path, live)) return;
    const at = this.options.now();
    const stem = spelling.slice(0, -'.md'.length);
    const oursFile =
      (await this.unrecordedCopyOf(stem, live)) ??
      (await this.writeConflictCopy(`${stem}.${timestampSlug(at)}`, live));
    const conflict = {
      path,
      detectedAt: at.toISOString(),
      theirsRevision,
      oursFile: `${CONFLICTS_PREFIX}${oursFile}`,
    };
    await recordMemorySyncConflict(this.scopeDir, conflict);
    this.state.conflicts.push(conflict);
    this.result.conflicts += 1;
  }

  private async recordedCopyHolds(
    path: string,
    live: string,
  ): Promise<boolean> {
    for (const conflict of this.state.conflicts) {
      if (
        conflict.path === path &&
        conflict.oursFile.startsWith(CONFLICTS_PREFIX) &&
        (await readTextOrNull(join(this.scopeDir, conflict.oursFile))) === live
      ) {
        return true;
      }
    }
    return false;
  }

  /** A copy of `live` under `stem` that no conflict records, by its name. */
  private async unrecordedCopyOf(
    stem: string,
    live: string,
  ): Promise<string | null> {
    const slash = stem.lastIndexOf('/');
    const folder = stem.slice(0, slash + 1);
    const prefix = `${stem.slice(slash + 1)}.`;
    const recorded = new Set(
      this.state.conflicts.map((conflict) => conflict.oursFile),
    );
    const conflicts = memorySyncPrivateDir(this.scopeDir, 'conflicts');
    for (const name of await markdownNames(join(conflicts, folder))) {
      const relative = `${folder}${name}`;
      if (
        name.startsWith(prefix) &&
        !recorded.has(`${CONFLICTS_PREFIX}${relative}`) &&
        (await readTextOrNull(join(conflicts, relative))) === live
      ) {
        return relative;
      }
    }
    return null;
  }

  /** Writes `live` under `name` in `.sync/conflicts/`, numbered when taken. */
  private async writeConflictCopy(name: string, live: string): Promise<string> {
    const folder = memorySyncPrivateDir(this.scopeDir, 'conflicts');
    for (let attempt = 1; ; attempt += 1) {
      const relative = `${attempt === 1 ? name : `${name}-${attempt}`}.md`;
      try {
        await writeMemoryFileDurably(
          this.scopeDir,
          join(folder, relative),
          live,
          {
            replace: false,
          },
        );
        return relative;
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
      }
    }
  }

  /** What this replica last applied under `path`, else another spelling. */
  private baseOf(
    path: string,
  ): MemorySyncStateFile['baseDocuments'][string] | undefined {
    const identity = memoryDocumentIdentity(path);
    return (
      this.base[path] ??
      Object.entries(this.base).find(
        ([key]) => memoryDocumentIdentity(key) === identity,
      )?.[1]
    );
  }

  /**
   * Whether this device's own user-scope note is one its organization now
   * keeps off the cloud (design §10.4): the cloud withholds it, and this
   * device keeps it as local-only.
   */
  private isWithheldHere(local: LocalNote): boolean {
    return (
      this.state.binding.kind === 'user' &&
      local.own &&
      local.originOrganizationId !== null &&
      this.options.blockedOriginOrganizationIds.has(local.originOrganizationId)
    );
  }

  /**
   * Whether a replica file's content is preserved elsewhere, so a pull or a
   * snapshot may replace it, remove it or move it aside without losing what
   * only this device has (design §8.4). Every such decision asks this, but
   * for a note the cloud removes by its ID (see {@link removeNote}).
   *
   * A document is when it holds the bytes this replica last applied, which
   * `.sync/base/` and the cloud keep; other bytes are a local edit, kept
   * under `.sync/conflicts/` first or left in place. A note is unless only
   * this device has it: kept local-only, one the outbox may still hold, an
   * import staged here (imports are not pushed yet), or this device's own
   * note its organization withholds.
   */
  private async preservedElsewhere(file: ReplicaFile): Promise<boolean> {
    if (file.kind === 'document') {
      const base = this.baseOf(file.path);
      return base !== undefined && base.contentHash === sha256Hex(file.live);
    }
    const { noteId, local } = file;
    return !(
      this.state.localOnlyNoteIds.includes(noteId) ||
      (await this.outboxHolds(noteId, local)) ||
      (local.own && local.pendingImport) ||
      this.isWithheldHere(local)
    );
  }

  /** Forgets what was applied under every spelling of `path`. */
  private forgetBase(path: string): void {
    const identity = memoryDocumentIdentity(path);
    for (const documents of [this.state.baseDocuments, this.base]) {
      for (const key of Object.keys(documents)) {
        if (memoryDocumentIdentity(key) === identity) delete documents[key];
      }
    }
  }

  /**
   * Leaves `path` the only spelling of its document in the replica and in
   * `.sync/base/`, after its bytes are written there: the file of a
   * case-insensitive file system takes its spelling, and a separate file
   * under another spelling goes, its local edit kept first. A crash part way
   * leaves the new bytes in place and the rest to the replayed page.
   */
  private async settleSpellings(
    path: string,
    content: string,
    revision: number,
  ): Promise<void> {
    const baseDir = memorySyncPrivateDir(this.scopeDir, 'base');
    for (const root of [this.scopeDir, baseDir]) {
      const target = join(root, path);
      for (const other of await otherSpellings(root, path)) {
        const source = join(root, other);
        if (root === this.scopeDir) await this.beforeDocumentWrite();
        if (await isSameFile(source, target)) {
          await respellMemoryFile(this.scopeDir, source, target);
          continue;
        }
        if (root === this.scopeDir) {
          const live = await readTextOrNull(source);
          if (
            live !== null &&
            live !== content &&
            !(await this.preservedElsewhere({
              kind: 'document',
              path: other,
              live,
            }))
          ) {
            await this.keepLocalEdit(path, live, revision, other);
          }
          this.result.documentsChanged += 1;
        }
        await removeMemoryFile(this.scopeDir, source);
      }
    }
  }

  async putDocument(
    path: string,
    content: string,
    contentHash: string,
    revision: number,
  ): Promise<void> {
    const target = join(this.scopeDir, path);
    const live = await readTextOrNull(target);
    if (live !== content) {
      await this.beforeDocumentWrite();
      if (
        live !== null &&
        !(await this.preservedElsewhere({ kind: 'document', path, live }))
      ) {
        await this.keepLocalEdit(path, live, revision);
      }
      await writeMemoryFileAtomically(this.scopeDir, target, content);
      this.result.documentsChanged += 1;
    }
    await writeMemoryFileAtomically(
      this.scopeDir,
      join(memorySyncPrivateDir(this.scopeDir, 'base'), path),
      content,
    );
    await this.settleSpellings(path, content, revision);
    this.forgetBase(path);
    const applied = { contentHash, changedInRevision: revision };
    this.state.baseDocuments[path] = applied;
    this.base[path] = applied;
  }

  async deleteDocument(path: string, revision: number): Promise<void> {
    const baseDir = memorySyncPrivateDir(this.scopeDir, 'base');
    for (const spelling of [
      path,
      ...(await otherSpellings(this.scopeDir, path)),
    ]) {
      const target = join(this.scopeDir, spelling);
      const live = await readTextOrNull(target);
      if (live === null) continue;
      await this.beforeDocumentWrite();
      if (
        !(await this.preservedElsewhere({
          kind: 'document',
          path: spelling,
          live,
        }))
      ) {
        await this.keepLocalEdit(path, live, revision, spelling);
      }
      await removeMemoryFile(this.scopeDir, target);
      this.result.documentsChanged += 1;
    }
    for (const spelling of [path, ...(await otherSpellings(baseDir, path))]) {
      await removeMemoryFile(this.scopeDir, join(baseDir, spelling));
    }
    this.forgetBase(path);
  }

  /**
   * Writes a pending note that is not on disk yet, unless this device has
   * already queued its tombstone or a replacement of it. A note that
   * replaces the one holding its file key takes the key in place, the old
   * note removed as `note_removed` would remove it; otherwise it goes under
   * a free name, so a pulled note never replaces a file.
   */
  async writePendingNote(note: MemoryNoteRecord): Promise<void> {
    const notes = await this.noteIndex();
    if (
      notes.has(note.noteId) ||
      this.state.localOnlyNoteIds.includes(note.noteId) ||
      (await this.outboxNoteIds()).retired.has(note.noteId)
    ) {
      return;
    }
    const content = renderPulledNote(note);
    const occupant = [...notes.entries()].find(
      ([, local]) => claimsFileKey(local) && local.fileKey === note.fileKey,
    );
    if (occupant !== undefined && occupant[0] === note.supersedes) {
      await this.removeNote(occupant[0], 'superseded');
    }
    const fileKey = await this.freeFileKey(note, notes, content);
    const path = join(this.scopeDir, fileKey);
    await ensureOwnerOnlyMemoryDir(this.scopeDir, dirname(path));
    const modified = new Date(note.modifiedAt);
    await writeMemoryFileAtomically(this.scopeDir, path, content, {
      atime: modified,
      mtime: modified,
    });
    if (note.kind === 'import') await this.recordPulledImport(note, fileKey);
    notes.set(note.noteId, {
      fileKey,
      path,
      archived: false,
      own: note.device.deviceId === this.options.deviceId,
      pendingImport: note.kind === 'import',
      originOrganizationId: note.origin.organizationId,
    });
    this.result.notesWritten += 1;
  }

  /**
   * The note's own file key when no file or note claims it, else
   * `<stem>-<last 10 of its ULID>.md`, then numbered. A file no note claims
   * that already holds `content` is this note's, written by a pull cut short
   * before its import ledger write, and is written again in place.
   */
  private async freeFileKey(
    note: MemoryNoteRecord,
    notes: ReadonlyMap<string, LocalNote>,
    content: string,
  ): Promise<string> {
    const stem = note.fileKey.slice(0, -'.md'.length);
    const suffix = note.noteId.slice(-10).toLowerCase();
    for (let attempt = 0; attempt < MAX_PULLED_NOTE_NAMES; attempt += 1) {
      const candidate =
        attempt === 0
          ? note.fileKey
          : `${stem}-${suffix}${attempt === 1 ? '' : `-${attempt}`}.md`;
      const claimed = [...notes.values()].some(
        (local) => claimsFileKey(local) && local.fileKey === candidate,
      );
      if (claimed) continue;
      const path = join(this.scopeDir, candidate);
      if (
        !(await exists(path)) ||
        (await readTextOrNull(path).catch(() => null)) === content
      ) {
        return candidate;
      }
    }
    throw new Error('A pulled memory note has no free name');
  }

  private async recordPulledImport(
    note: MemoryNoteRecord,
    fileKey: string,
  ): Promise<void> {
    const imports = await readImportState(this.scopeDir);
    const tool = note.importSource?.tool;
    imports.sources[`${IMPORT_SYNC_SOURCE_PREFIX}${note.noteId}`] = {
      fileHash: sha256Hex(note.body),
      importedAt: note.receivedAt,
      stagedAs: fileKey,
      modified: note.modifiedAt,
      noteId: note.noteId,
      ...(tool === 'claude-code' || tool === 'codex'
        ? { sourceTool: tool }
        : {}),
    };
    await writeImportState(this.scopeDir, imports);
  }

  private forgetLocalOnly(noteId: string): void {
    const index = this.state.localOnlyNoteIds.indexOf(noteId);
    if (index !== -1) this.state.localOnlyNoteIds.splice(index, 1);
  }

  /**
   * Removes the live copy of a note the cloud removed by its ID, or one a
   * pulled note supersedes in its file. A note kept local-only stays unless
   * purged, since only this device has what it holds; this device's own
   * withheld note becomes one. A removed note loses its local-only mark,
   * also when a replay finds its file already gone, and a removed import's
   * ledger entry is retired after its file goes.
   */
  async removeNote(
    noteId: string,
    reason: 'tombstoned' | 'superseded' | 'withheld' | 'purged',
  ): Promise<void> {
    const notes = await this.noteIndex();
    const local = notes.get(noteId);
    if (local === undefined) {
      this.forgetLocalOnly(noteId);
      return;
    }
    if (reason === 'withheld' && local.own) {
      if (!local.archived) this.keepLocalOnly(noteId);
      return;
    }
    if (
      !local.archived &&
      reason !== 'purged' &&
      this.state.localOnlyNoteIds.includes(noteId)
    ) {
      return;
    }
    if (!local.archived) {
      await removeMemoryFile(this.scopeDir, local.path);
      this.result.notesRemoved += 1;
    }
    notes.delete(noteId);
    this.forgetLocalOnly(noteId);
    if (isImportFileKey(local.fileKey)) await this.retireImports([noteId]);
  }

  private async retireImports(noteIds: readonly string[]): Promise<void> {
    await retireImportNotes(
      this.scopeDir,
      new Set(noteIds),
      this.options.now().toISOString(),
    );
  }

  /**
   * Moves consumed notes into `.consolidated/`, as local consolidation does,
   * then stamps consumed imports in the ledger. The stamp also covers an
   * import a replayed page finds already moved, so an archive cut short
   * between the move and the stamp completes.
   */
  async archiveNotes(noteIds: readonly string[]): Promise<void> {
    if (noteIds.length === 0) return;
    const notes = await this.noteIndex();
    const consumedImports = new Set<string>();
    for (const noteId of noteIds) {
      const local = notes.get(noteId);
      if (local === undefined) continue;
      const imported = isImportFileKey(local.fileKey);
      if (imported && local.pendingImport) consumedImports.add(noteId);
      if (local.archived) continue;
      const destination = await moveToFreeName(
        this.scopeDir,
        local.path,
        join(this.scopeDir, imported ? 'imported' : 'inbox', '.consolidated'),
      );
      notes.set(noteId, { ...local, path: destination, archived: true });
    }
    await stampImportNotesConsolidated(
      this.scopeDir,
      consumedImports,
      this.options.now().toISOString(),
    );
    for (const noteId of consumedImports) {
      const local = notes.get(noteId);
      if (local !== undefined) {
        notes.set(noteId, { ...local, pendingImport: false });
      }
    }
  }

  async applyNotePut(note: MemoryNoteRecord): Promise<void> {
    if (note.state === 'pending') {
      await this.writePendingNote(note);
    } else if (note.state === 'consolidated') {
      await this.archiveNotes([note.noteId]);
    } else {
      await this.removeNote(note.noteId, note.state);
    }
  }

  async applyRevision(
    change: Extract<MemoryChange, { kind: 'revision' }>,
  ): Promise<void> {
    const { revision } = change;
    if (revision.revision <= this.state.baseRevision) return;
    if (revision.parentRevision !== this.state.baseRevision) {
      throw new MemoryReplicaGapError('revision_gap');
    }
    for (const documentChange of change.changes) {
      await this.applyDocumentChange(documentChange, revision.revision);
    }
    await this.archiveNotes(change.consumedNoteIds);
    this.state.baseRevision = revision.revision;
  }

  private async applyDocumentChange(
    change: MemoryDocumentChange,
    revision: number,
  ): Promise<void> {
    if (change.op === 'put') {
      await this.putDocument(
        change.path,
        change.content,
        change.contentHash,
        revision,
      );
    } else {
      await this.deleteDocument(change.path, revision);
    }
  }

  /**
   * Moves documents and notes a snapshot does not hold out of the way, when
   * their content is preserved elsewhere (see {@link preservedElsewhere}).
   * A document made here stays, and a local edit of one the cloud dropped is
   * kept under `.sync/conflicts/` first. A note only this device has stays,
   * and its own note an organization withholds becomes local-only. An inbox
   * file without a note ID, which the cloud cannot hold, stays too. A note
   * that stays only because the outbox holds it is recorded in
   * `snapshotKept`, so it is settled once the outbox lets it go (see
   * {@link settleSnapshotKept}).
   */
  async displaceUnlisted(
    snapshot: Pick<
      MemoryReplicaSnapshot,
      'revision' | 'cursor' | 'documents' | 'pendingNotes'
    >,
  ): Promise<void> {
    const listed = new Set(
      snapshot.documents.map((document) =>
        memoryDocumentIdentity(document.path),
      ),
    );
    const localDocuments = [
      MEMORY_INDEX_PATH,
      ...(await markdownNames(join(this.scopeDir, 'topics'))).map(
        (name) => `topics/${name}`,
      ),
    ];
    for (const path of localDocuments) {
      if (listed.has(memoryDocumentIdentity(path))) continue;
      const live = await readTextOrNull(join(this.scopeDir, path));
      if (live === null) continue;
      const preserved = await this.preservedElsewhere({
        kind: 'document',
        path,
        live,
      });
      if (!preserved && this.baseOf(path) === undefined) continue;
      await this.beforeDocumentWrite();
      if (!preserved) await this.keepLocalEdit(path, live, snapshot.revision);
      await this.displace(path);
      await removeMemoryFile(
        this.scopeDir,
        join(memorySyncPrivateDir(this.scopeDir, 'base'), path),
      );
      this.result.documentsChanged += 1;
    }
    const pending = new Set(snapshot.pendingNotes.map((note) => note.noteId));
    const notes = await this.noteIndex();
    const displaced: Array<[string, LocalNote]> = [];
    // A pending import whose file is gone and that the cloud no longer holds
    // pending is retired too, so it stops claiming its path.
    const vanished: Array<[string, LocalNote]> = [];
    const keptForOutbox: string[] = [];
    for (const [noteId, local] of notes) {
      if (pending.has(noteId) || !claimsFileKey(local)) continue;
      if (await this.preservedElsewhere({ kind: 'note', noteId, local })) {
        (local.archived ? vanished : displaced).push([noteId, local]);
      } else if (!local.archived && this.isWithheldHere(local)) {
        this.keepLocalOnly(noteId);
      } else if (await this.keptOnlyForOutbox(noteId, local)) {
        keptForOutbox.push(noteId);
      }
    }
    this.recordSnapshotKept(snapshot.cursor, keptForOutbox);
    // Retired first: a crash before a move leaves a staged file that no
    // entry claims, which the next snapshot moves aside.
    await this.retireImports(
      [...displaced, ...vanished].flatMap(([noteId, local]) =>
        isImportFileKey(local.fileKey) ? [noteId] : [],
      ),
    );
    for (const [noteId] of vanished) notes.delete(noteId);
    for (const [noteId, local] of displaced) {
      await this.displace(local.fileKey);
      notes.delete(noteId);
      this.result.notesRemoved += 1;
    }
    // A staged file no live entry claims was retired here or left by a
    // crash before its ledger write; the cloud or its source still has it.
    const claimed = new Set(
      Object.values((await readImportState(this.scopeDir)).sources).flatMap(
        (entry) => (isLiveImportEntry(entry) ? [entry.stagedAs] : []),
      ),
    );
    for (const name of await markdownNames(join(this.scopeDir, 'imported'))) {
      if (!claimed.has(`imported/${name}`))
        await this.displace(`imported/${name}`);
    }
  }

  /** Moves a replica file into this apply's `.sync/displaced/` folder. */
  private async displace(relative: string): Promise<void> {
    this.displacedDir ??= join(
      memorySyncPrivateDir(this.scopeDir, 'displaced'),
      timestampSlug(this.options.now()),
    );
    await moveToFreeName(
      this.scopeDir,
      join(this.scopeDir, relative),
      join(this.displacedDir, dirname(relative)),
    );
  }

  /** A live inbox note a snapshot keeps for the outbox's sake alone. */
  private async keptOnlyForOutbox(
    noteId: string,
    local: LocalNote,
  ): Promise<boolean> {
    if (
      local.archived ||
      isImportFileKey(local.fileKey) ||
      this.state.localOnlyNoteIds.includes(noteId)
    ) {
      return false;
    }
    const outbox = await this.outboxNoteIds();
    return outbox.readable && outbox.held.has(noteId);
  }

  /** The state's kept notes when they are current at the replica's cursor. */
  private currentSnapshotKept(): SnapshotKept | undefined {
    const kept = this.state.snapshotKept;
    return kept !== undefined && kept.cursor === this.state.cursor
      ? kept
      : undefined;
  }

  /**
   * Records the notes a snapshot at `cursor` kept for the outbox alone,
   * keeping what a push already answered for those it kept before.
   */
  private recordSnapshotKept(cursor: string, noteIds: string[]): void {
    const before = new Map(
      (this.currentSnapshotKept()?.notes ?? []).map((entry) => [
        entry.noteId,
        entry,
      ]),
    );
    this.state.snapshotKept =
      noteIds.length === 0
        ? undefined
        : {
            cursor,
            notes: noteIds.map((noteId) => before.get(noteId) ?? { noteId }),
          };
  }

  /** Drops kept notes a page names: the feed speaks for them from now. */
  forgetSnapshotKept(noteIds: readonly string[]): void {
    const kept = this.currentSnapshotKept();
    if (kept === undefined) {
      this.state.snapshotKept = undefined;
      return;
    }
    const named = new Set(noteIds);
    this.state.snapshotKept = {
      ...kept,
      notes: kept.notes.filter((entry) => !named.has(entry.noteId)),
    };
  }

  /**
   * After a page that ends at `nextCursor`: settles the notes the last
   * snapshot kept for the outbox alone once the outbox no longer holds
   * them. One a push answered as new, refused or kept on this device has
   * left the list already. One answered as replayed may have been stored
   * before the snapshot, which found it no longer pending; once the feed
   * reaches the push without naming it, it goes as the snapshot would have
   * moved it aside, while its file still holds the body the push carried.
   * Other bytes of the note stay as a local-only note. The file moves
   * before `sync-state.json` drops its entry, so a replayed page finds it
   * gone and settles nothing twice.
   */
  async settleSnapshotKept(nextCursor: string): Promise<void> {
    const kept = this.currentSnapshotKept();
    if (kept === undefined) {
      this.state.snapshotKept = undefined;
      return;
    }
    const outbox = await this.outboxNoteIds();
    const left: SnapshotKept['notes'] = [];
    for (const entry of kept.notes) {
      const { replayed } = entry;
      const waiting =
        !outbox.readable ||
        outbox.held.has(entry.noteId) ||
        (replayed !== undefined &&
          replayed.cursor !== null &&
          (compareMemoryChangeCursors(nextCursor, replayed.cursor) ?? 0) < 0);
      if (waiting) {
        left.push(entry);
      } else if (replayed !== undefined) {
        await this.displaceReplayed(entry.noteId, replayed.contentHash);
      }
    }
    this.state.snapshotKept =
      left.length === 0 ? undefined : { cursor: nextCursor, notes: left };
  }

  private async displaceReplayed(
    noteId: string,
    contentHash: string,
  ): Promise<void> {
    const notes = await this.noteIndex();
    const local = notes.get(noteId);
    if (
      local === undefined ||
      local.archived ||
      this.state.localOnlyNoteIds.includes(noteId)
    ) {
      return;
    }
    if (this.isWithheldHere(local)) {
      this.keepLocalOnly(noteId);
      return;
    }
    const content = await readTextOrNull(local.path);
    if (content === null || memoryNoteId(content) !== noteId) return;
    const body = inboxNoteBody(content);
    if (body === null || sha256Hex(body) !== contentHash) {
      this.keepLocalOnly(noteId);
      return;
    }
    await this.displace(local.fileKey);
    notes.delete(noteId);
    this.result.notesRemoved += 1;
  }

  /**
   * Whether the outbox may hold a note: queued to be sent, or deleted here
   * meanwhile. While the outbox cannot be read, any note of this device's
   * may be in it.
   */
  private async outboxHolds(
    noteId: string,
    local: LocalNote,
  ): Promise<boolean> {
    const outbox = await this.outboxNoteIds();
    return outbox.held.has(noteId) || (!outbox.readable && local.own);
  }

  /** What the outbox holds and retires (tombstones or supersedes). */
  private async outboxNoteIds(): Promise<OutboxNotes> {
    if (this.outboxNotes === null) {
      const outbox = await readMemorySyncOutbox(
        this.scopeDir,
        this.state.binding,
      );
      const ops = (outbox?.ops ?? []).map((entry) => entry.op);
      this.outboxNotes = {
        readable: outbox !== null,
        held: new Set([
          ...ops.flatMap((op) =>
            op.op === 'tombstone' ? [] : [op.note.noteId],
          ),
          ...(outbox?.localDeletes ?? []).map((pending) => pending.noteId),
        ]),
        retired: new Set(
          ops.flatMap((op) => {
            if (op.op === 'tombstone') return [op.noteId];
            return op.note.supersedes === undefined ? [] : [op.note.supersedes];
          }),
        ),
      };
    }
    return this.outboxNotes;
  }
}

async function readBoundState(scopeDir: string): Promise<MemorySyncStateFile> {
  const state = await readMemorySyncState(scopeDir);
  if (state === undefined || state === null) {
    throw new MemoryReplicaGapError('state');
  }
  return state;
}

/**
 * Makes the replica hold exactly the snapshot: its documents at the pinned
 * revision and the notes pending at its cursor. Then records the cursor, so
 * pulling continues from there.
 */
export function applyMemoryReplicaSnapshot(
  scopeDir: string,
  snapshot: MemoryReplicaSnapshot,
  options: MemoryReplicaWriteOptions,
): Promise<MemoryReplicaApplyResult> {
  return withMemoryWriteLock(scopeDir, async () => {
    const state = await readBoundState(scopeDir);
    const apply = new ReplicaApply(scopeDir, state, options);
    state.baseDocuments = {};
    for (const document of snapshot.documents) {
      await apply.putDocument(
        document.path,
        document.content,
        document.contentHash,
        document.changedInRevision,
      );
    }
    for (const note of snapshot.pendingNotes) {
      await apply.writePendingNote(note);
    }
    await apply.displaceUnlisted(snapshot);
    await writeMemorySyncState(scopeDir, {
      ...state,
      cursor: snapshot.cursor,
      baseRevision: snapshot.revision,
      lastPulledAt: options.now().toISOString(),
    });
    return apply.result;
  });
}

/**
 * Applies one page of changes, pulled from the cursor the replica holds,
 * then records the page's next cursor. Rejects with
 * {@link MemoryReplicaGapError} when the page or a revision does not
 * continue from the replica's state.
 */
export function applyMemoryReplicaChanges(
  scopeDir: string,
  page: {
    fromCursor: string;
    nextCursor: string;
    changes: readonly MemoryChange[];
  },
  options: MemoryReplicaWriteOptions,
): Promise<MemoryReplicaApplyResult> {
  return withMemoryWriteLock(scopeDir, async () => {
    const state = await readBoundState(scopeDir);
    if (state.cursor !== page.fromCursor) {
      throw new MemoryReplicaGapError('cursor_mismatch');
    }
    const apply = new ReplicaApply(scopeDir, state, options);
    for (const change of page.changes) {
      switch (change.kind) {
        case 'note_put':
          apply.forgetSnapshotKept([change.note.noteId]);
          await apply.applyNotePut(change.note);
          break;
        case 'note_removed':
          apply.forgetSnapshotKept([change.noteId]);
          await apply.removeNote(change.noteId, change.reason);
          break;
        case 'revision':
          apply.forgetSnapshotKept(change.consumedNoteIds);
          await apply.applyRevision(change);
          break;
        case 'scope_updated':
          break;
      }
    }
    await apply.settleSnapshotKept(page.nextCursor);
    await writeMemorySyncState(scopeDir, {
      ...state,
      cursor: page.nextCursor,
      lastPulledAt: options.now().toISOString(),
    });
    return apply.result;
  });
}
