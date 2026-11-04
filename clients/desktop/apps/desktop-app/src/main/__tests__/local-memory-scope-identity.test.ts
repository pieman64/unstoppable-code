import type { LocalMemoryDocument } from '@canopy/desktop-shared/types';
import type * as FsPromises from 'node:fs/promises';
import type * as DocumentParser from '../memory/local/document-parser';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isMemoryNoteFileKey,
  MemoryManifestFileSchema,
  memoryUlidTime,
} from '@canopy/protocol/memory-sync';
import {
  backfillMemoryScope,
  findDuplicateMemoryNoteIds,
} from '../memory/local/backfill';
import {
  memoryEditRevision,
  recordMemoryEdit,
  withMemoryWriteLock,
} from '../memory/local/edit-coordination';
import {
  deleteLocalMemoryFile,
  listLocalMemoryFiles,
  readLocalMemoryDocument,
  updateLocalMemoryFile,
} from '../memory/local/explorer';
import { readImportState } from '../memory/local/import/ledger';
import {
  memoryNoteFileName,
  memoryNoteId,
  memoryNoteIdAt,
  parseMemoryNoteIdentity,
  withMemoryNoteId,
} from '../memory/local/note-identity';
import { acquireMemoryScopeLock } from '../memory/local/scope-lock';
import {
  LOCAL_MEMORY_READ_ONLY_MESSAGE,
  LocalMemoryScopeReadOnlyError,
} from '../memory/local/scope-manifest';
import {
  appendInboxNote,
  readMemoryIndex,
  readRecentInboxNoteEntries,
  searchMemory,
} from '../memory/local/store';
import { startScopeChild } from './helpers/local-memory-scope/scope-child';

jest.mock('../memory/local/parse-runner', () => ({
  parseMemoryDocumentInWorker: (
    fileKey: string,
    content: string,
  ): Promise<LocalMemoryDocument> =>
    Promise.resolve(
      jest
        .requireActual<typeof DocumentParser>('../memory/local/document-parser')
        .parseMemoryDocument(fileKey, content),
    ),
}));

jest.setTimeout(60_000);

const at = (iso: string): Date => new Date(iso);

function noteWithFrontMatter(created: string, body: string): string {
  return [
    '---',
    'source:',
    '  provider: "claude"',
    '  chatId: "chat-1"',
    `created: ${JSON.stringify(created)}`,
    `modified: ${JSON.stringify(created)}`,
    'type: inbox',
    '---',
    '',
    body,
    '',
  ].join('\n');
}

async function writeNote(
  scopeDir: string,
  fileKey: string,
  content: string,
  mtime: Date,
): Promise<void> {
  const path = join(scopeDir, fileKey);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
  await utimes(path, mtime, mtime);
}

/** Readies the scope the way every write does. */
function prepareScope(scopeDir: string): Promise<void> {
  return withMemoryWriteLock(scopeDir, () => Promise.resolve());
}

async function inboxNames(
  scopeDir: string,
  folder = 'inbox',
): Promise<string[]> {
  return (await readdir(join(scopeDir, folder), { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.md') &&
        !entry.name.startsWith('.'),
    )
    .map((entry) => entry.name)
    .sort();
}

/** The note as it was before the backfill added its `id` line. */
function withoutIdLine(content: string): string {
  return content.replace(/^---\nid: "[0-9A-Z]{26}"\n/, '---\n');
}

async function readManifest(
  scopeDir: string,
): Promise<ReturnType<typeof MemoryManifestFileSchema.parse>> {
  return MemoryManifestFileSchema.parse(
    JSON.parse(await readFile(join(scopeDir, 'manifest.json'), 'utf8')),
  );
}

describe('local memory scope identity', () => {
  let scopeDir: string;

  beforeEach(async () => {
    scopeDir = await mkdtemp(join(tmpdir(), 'local-memory-identity-'));
  });

  afterEach(async () => {
    await rm(scopeDir, { recursive: true, force: true });
  });

  it('backfills once: IDs at each note’s created time, carried names, mtimes, imports and manifest version 2', async () => {
    const existingId = memoryNoteIdAt(Date.parse('2026-06-01T00:00:00.000Z'));
    const fixtures = {
      'inbox/2026-09-01T10-00-00-edited-later.md': {
        content: noteWithFrontMatter(
          '2026-09-01T10:00:00.000Z',
          'Edited later',
        ),
        mtime: at('2026-09-05T00:00:00.000Z'),
      },
      'inbox/2026-09-03T08-00-00-plain.md': {
        content: noteWithFrontMatter('2026-09-03T08:00:00.000Z', 'Plain note'),
        mtime: at('2026-09-03T08:00:00.000Z'),
      },
      'inbox/my note.md': {
        content: 'Spaced name, no front matter\n',
        mtime: at('2026-09-04T00:00:00.000Z'),
      },
      // A valid ID beside an identity field this build cannot accept (a
      // label over the limit) still is the note's ID.
      'inbox/2026-06-01-identified.md': {
        content: withMemoryNoteId(
          noteWithFrontMatter('2026-06-01T00:00:00.000Z', 'Has an ID').replace(
            'type: inbox',
            `type: inbox\ndeviceLabel: "${'x'.repeat(300)}"`,
          ),
          existingId,
        ),
        mtime: at('2026-06-01T00:00:00.000Z'),
      },
      'inbox/.hidden.md': {
        content: 'Dot entries are never memory\n',
        mtime: at('2026-06-01T00:00:00.000Z'),
      },
      'inbox/.consolidated/2026-08-01T00-00-00-archived.md': {
        content: noteWithFrontMatter('2026-08-01T00:00:00.000Z', 'Archived'),
        mtime: at('2026-08-02T00:00:00.000Z'),
      },
      'imported/claude-notes-0123456789abcdef.md': {
        content: '# Imported\n\nVerbatim.\n',
        mtime: at('2026-07-01T00:00:00.000Z'),
      },
    };
    for (const [fileKey, fixture] of Object.entries(fixtures)) {
      await writeNote(scopeDir, fileKey, fixture.content, fixture.mtime);
    }
    await writeFile(
      join(scopeDir, 'import-state.json'),
      JSON.stringify({
        version: 1,
        sources: {
          '/home/me/.claude/notes.md': {
            fileHash: 'a'.repeat(64),
            importedAt: '2026-07-01T00:00:00.000Z',
            stagedAs: 'imported/claude-notes-0123456789abcdef.md',
          },
        },
      }),
    );
    await writeFile(join(scopeDir, 'manifest.json'), '{ "version": 1 }\n');
    const recentBefore = (await readRecentInboxNoteEntries(scopeDir)).map(
      (note) => note.text,
    );

    await prepareScope(scopeDir);

    const names = await inboxNames(scopeDir);
    const renamed = names.find((name) => name.includes('-my-note-'));
    expect(renamed).toBeDefined();
    expect(names).not.toContain('my note.md');
    for (const name of names) {
      expect(isMemoryNoteFileKey(`inbox/${name}`, 'inbox')).toBe(true);
    }
    const createdOf: Record<string, string> = {
      '2026-09-01T10-00-00-edited-later.md': '2026-09-01T10:00:00.000Z',
      '2026-09-03T08-00-00-plain.md': '2026-09-03T08:00:00.000Z',
      [renamed ?? '']: '2026-09-04T00:00:00.000Z',
      '2026-06-01-identified.md': '2026-06-01T00:00:00.000Z',
    };
    const originals: Record<string, keyof typeof fixtures> = {
      '2026-09-01T10-00-00-edited-later.md':
        'inbox/2026-09-01T10-00-00-edited-later.md',
      '2026-09-03T08-00-00-plain.md': 'inbox/2026-09-03T08-00-00-plain.md',
      [renamed ?? '']: 'inbox/my note.md',
      '2026-06-01-identified.md': 'inbox/2026-06-01-identified.md',
    };
    const ids = new Set<string>();
    for (const name of names) {
      const path = join(scopeDir, 'inbox', name);
      const content = await readFile(path, 'utf8');
      const id = memoryNoteId(content) ?? '';
      ids.add(id);
      expect(memoryUlidTime(id)).toBe(Date.parse(createdOf[name] ?? ''));
      const original = fixtures[originals[name] ?? 'inbox/.hidden.md'];
      expect((await stat(path)).mtimeMs).toBe(original.mtime.getTime());
      if (name === '2026-06-01-identified.md') {
        expect(id).toBe(existingId);
        expect(content).toBe(original.content);
      } else if (name === renamed) {
        expect(content).toBe(`---\nid: "${id}"\n---\n${original.content}`);
        expect(name).toBe(
          memoryNoteFileName(
            Date.parse('2026-09-04T00:00:00.000Z'),
            'my note',
            id,
          ),
        );
      } else {
        expect(withoutIdLine(content)).toBe(original.content);
      }
    }
    expect(ids.size).toBe(names.length);
    // Injection sorts recent notes by mtime: the backfill keeps their order.
    expect(
      (await readRecentInboxNoteEntries(scopeDir)).map((note) => note.text),
    ).toEqual(recentBefore);
    await expect(
      readFile(join(scopeDir, 'inbox', '.hidden.md'), 'utf8'),
    ).resolves.toBe(fixtures['inbox/.hidden.md'].content);

    const archived = await readFile(
      join(
        scopeDir,
        'inbox',
        '.consolidated',
        '2026-08-01T00-00-00-archived.md',
      ),
      'utf8',
    );
    expect(memoryUlidTime(parseMemoryNoteIdentity(archived)?.id ?? '')).toBe(
      Date.parse('2026-08-01T00:00:00.000Z'),
    );

    const imported = (await readImportState(scopeDir)).sources[
      '/home/me/.claude/notes.md'
    ];
    if (imported === undefined || !('stagedAs' in imported)) {
      throw new Error('expected a staged import');
    }
    expect(memoryUlidTime(imported.noteId ?? '')).toBe(
      Date.parse('2026-07-01T00:00:00.000Z'),
    );
    await expect(
      readFile(
        join(scopeDir, 'imported', 'claude-notes-0123456789abcdef.md'),
        'utf8',
      ),
    ).resolves.toBe(
      fixtures['imported/claude-notes-0123456789abcdef.md'].content,
    );

    const manifest = await readManifest(scopeDir);
    expect(manifest).toMatchObject({
      version: 2,
      revision: 0,
      minWriterFormat: 2,
      binding: null,
      migratedTo: [],
    });
    expect(manifest.backfilledAt).not.toBeNull();

    // Idempotent: running it again changes no byte and no mtime.
    const snapshot = async (): Promise<Record<string, string>> => {
      const files: Record<string, string> = {};
      for (const folder of ['inbox', join('inbox', '.consolidated')]) {
        for (const name of await inboxNames(scopeDir, folder)) {
          const path = join(scopeDir, folder, name);
          files[join(folder, name)] =
            `${(await stat(path)).mtimeMs}:${await readFile(path, 'utf8')}`;
        }
      }
      files['import-state.json'] = await readFile(
        join(scopeDir, 'import-state.json'),
        'utf8',
      );
      return files;
    };
    const after = await snapshot();
    await expect(backfillMemoryScope(scopeDir)).resolves.toEqual({
      complete: true,
      notesIdentified: 0,
      notesRenamed: 0,
      importsIdentified: 0,
    });
    await prepareScope(scopeDir);
    expect(await snapshot()).toEqual(after);
  });

  it('renames pending notes named after a Windows device', async () => {
    for (const name of ['CON.md', 'nul.md']) {
      await writeNote(
        scopeDir,
        `inbox/${name}`,
        `${name} note\n`,
        at('2026-09-04T00:00:00.000Z'),
      );
    }
    await writeFile(join(scopeDir, 'manifest.json'), '{ "version": 1 }\n');

    await prepareScope(scopeDir);

    const names = await inboxNames(scopeDir);
    expect(names).toEqual([
      expect.stringMatching(/^2026-09-04T00-00-00-con-[0-9a-z]{6}\.md$/),
      expect.stringMatching(/^2026-09-04T00-00-00-nul-[0-9a-z]{6}\.md$/),
    ]);
    for (const name of names) {
      expect(isMemoryNoteFileKey(`inbox/${name}`, 'inbox')).toBe(true);
    }
  });

  it('backfills notes whose names are near the file name length limit', async () => {
    const longName = `${'long legacy note '.repeat(15).slice(0, 240)}.md`;
    expect(Buffer.byteLength(longName)).toBeGreaterThanOrEqual(240);
    for (const folder of ['inbox', 'inbox/.consolidated']) {
      await writeNote(
        scopeDir,
        `${folder}/${longName}`,
        noteWithFrontMatter('2026-09-05T00:00:00.000Z', 'A long name'),
        at('2026-09-05T00:00:00.000Z'),
      );
    }
    await writeFile(join(scopeDir, 'manifest.json'), '{ "version": 1 }\n');

    await prepareScope(scopeDir);

    expect((await readManifest(scopeDir)).backfilledAt).not.toBeNull();
    const pending = (await readdir(join(scopeDir, 'inbox'))).sort();
    expect(pending).toEqual([
      '.consolidated',
      expect.stringMatching(
        /^2026-09-05T00-00-00-long-legacy-note-[a-z0-9-]+-[0-9a-z]{6}\.md$/,
      ),
    ]);
    const renamed = pending[1];
    expect(Buffer.byteLength(renamed)).toBeLessThanOrEqual(255);
    expect(isMemoryNoteFileKey(`inbox/${renamed}`, 'inbox')).toBe(true);
    expect(await readdir(join(scopeDir, 'inbox', '.consolidated'))).toEqual([
      longName,
    ]);
    for (const path of [
      join(scopeDir, 'inbox', renamed),
      join(scopeDir, 'inbox', '.consolidated', longName),
    ]) {
      expect(memoryNoteId(await readFile(path, 'utf8'))).not.toBeNull();
    }
    expect(
      (await readdir(scopeDir)).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('starts a new incarnation when an older build rewrote the manifest, so an earlier revision never matches', async () => {
    await appendInboxNote(scopeDir, {
      text: 'Saved by this build',
      source: { provider: 'claude', chatId: 'chat-1' },
    });
    const before = await memoryEditRevision(scopeDir);
    const { incarnation } = await readManifest(scopeDir);
    // What a build that predates version 2 does on its next save.
    await writeFile(join(scopeDir, 'manifest.json'), '{\n  "version": 1\n}\n');
    await writeNote(
      scopeDir,
      'inbox/2026-10-01T00-00-00-old-build.md',
      noteWithFrontMatter('2026-10-01T00:00:00.000Z', 'Saved by an old build'),
      at('2026-10-01T00:00:00.000Z'),
    );

    await withMemoryWriteLock(scopeDir, () => recordMemoryEdit(scopeDir));

    const manifest = await readManifest(scopeDir);
    expect(manifest.incarnation).not.toBe(incarnation);
    expect(await memoryEditRevision(scopeDir)).not.toBe(before);
    expect(
      parseMemoryNoteIdentity(
        await readFile(
          join(scopeDir, 'inbox', '2026-10-01T00-00-00-old-build.md'),
          'utf8',
        ),
      ),
    ).not.toBeNull();
  });

  it('resumes a backfill a crash interrupted, never minting a second ID or keeping a note twice', async () => {
    const renamedId = memoryNoteIdAt(Date.parse('2026-09-01T00:00:00.000Z'));
    const linkedId = memoryNoteIdAt(Date.parse('2026-09-02T00:00:00.000Z'));
    // Rewritten with its ID, crashed before the rename.
    await writeNote(
      scopeDir,
      'inbox/half done.md',
      withMemoryNoteId(
        noteWithFrontMatter('2026-09-01T00:00:00.000Z', 'Half done'),
        renamedId,
      ),
      at('2026-09-01T00:00:00.000Z'),
    );
    // Linked under its new name, crashed before the old name was removed.
    await writeNote(
      scopeDir,
      'inbox/two names.md',
      withMemoryNoteId(
        noteWithFrontMatter('2026-09-02T00:00:00.000Z', 'Two names'),
        linkedId,
      ),
      at('2026-09-02T00:00:00.000Z'),
    );
    const linkedName = memoryNoteFileName(
      Date.parse('2026-09-02T00:00:00.000Z'),
      'two names',
      linkedId,
    );
    await link(
      join(scopeDir, 'inbox', 'two names.md'),
      join(scopeDir, 'inbox', linkedName),
    );
    await writeNote(
      scopeDir,
      'inbox/2026-09-03T00-00-00-untouched.md',
      noteWithFrontMatter('2026-09-03T00:00:00.000Z', 'Untouched'),
      at('2026-09-03T00:00:00.000Z'),
    );
    await writeFile(
      join(scopeDir, 'inbox', 'untouched.md.123.0000.tmp'),
      'a temp file the crash left',
    );
    // Copied under its new name where hard links are unavailable, crashed
    // part way through the copy.
    const cutShortId = memoryNoteIdAt(Date.parse('2026-09-04T00:00:00.000Z'));
    const cutShort = withMemoryNoteId(
      noteWithFrontMatter('2026-09-04T00:00:00.000Z', 'Cut short'),
      cutShortId,
    );
    await writeNote(
      scopeDir,
      'inbox/cut short.md',
      cutShort,
      at('2026-09-04T00:00:00.000Z'),
    );
    const cutShortName = memoryNoteFileName(
      Date.parse('2026-09-04T00:00:00.000Z'),
      'cut short',
      cutShortId,
    );
    await writeNote(
      scopeDir,
      `inbox/${cutShortName}`,
      cutShort.slice(0, Math.floor(cutShort.length / 2)),
      at('2026-10-01T00:00:00.000Z'),
    );
    // Copied whole, crashed before the old name went, then the copy was
    // edited.
    const editedId = memoryNoteIdAt(Date.parse('2026-09-05T00:00:00.000Z'));
    const edited = (body: string): string =>
      withMemoryNoteId(
        noteWithFrontMatter('2026-09-05T00:00:00.000Z', body),
        editedId,
      );
    await writeNote(
      scopeDir,
      'inbox/edited copy.md',
      edited('Before the edit'),
      at('2026-09-05T00:00:00.000Z'),
    );
    const editedName = memoryNoteFileName(
      Date.parse('2026-09-05T00:00:00.000Z'),
      'edited copy',
      editedId,
    );
    await writeNote(
      scopeDir,
      `inbox/${editedName}`,
      edited('After the edit'),
      at('2026-09-06T00:00:00.000Z'),
    );
    const abandoned = join(
      scopeDir,
      'inbox',
      '.memory-write-6f3c3c43-62f1-4a65-8e7e-2c1a8e1f3b7a.tmp',
    );
    await writeFile(abandoned, cutShort.slice(0, 10));

    await prepareScope(scopeDir);

    const names = await inboxNames(scopeDir);
    expect(names).toHaveLength(5);
    expect(names).toEqual(
      expect.arrayContaining([
        linkedName,
        memoryNoteFileName(
          Date.parse('2026-09-01T00:00:00.000Z'),
          'half done',
          renamedId,
        ),
        cutShortName,
        editedName,
      ]),
    );
    const ids = await Promise.all(
      names.map(
        async (name) =>
          parseMemoryNoteIdentity(
            await readFile(join(scopeDir, 'inbox', name), 'utf8'),
          )?.id,
      ),
    );
    expect(new Set(ids).size).toBe(5);
    expect(ids).toEqual(
      expect.arrayContaining([renamedId, linkedId, cutShortId, editedId]),
    );
    // The copy cut short is whole again; the edited copy is kept.
    await expect(
      readFile(join(scopeDir, 'inbox', cutShortName), 'utf8'),
    ).resolves.toBe(cutShort);
    expect((await stat(join(scopeDir, 'inbox', cutShortName))).mtimeMs).toBe(
      at('2026-09-04T00:00:00.000Z').getTime(),
    );
    await expect(
      readFile(join(scopeDir, 'inbox', editedName), 'utf8'),
    ).resolves.toBe(edited('After the edit'));
    await expect(findDuplicateMemoryNoteIds(scopeDir)).resolves.toEqual([]);
    await expect(stat(abandoned)).rejects.toMatchObject({ code: 'ENOENT' });
    // Readers skip what the crash left behind.
    expect(
      (await listLocalMemoryFiles(scopeDir)).map((file) => file.fileKey),
    ).toEqual(names.map((name) => `inbox/${name}`));
  });

  it('keeps a renamed note whose old name another writer already removed', async () => {
    const noteId = memoryNoteIdAt(Date.parse('2026-09-01T00:00:00.000Z'));
    const content = withMemoryNoteId(
      noteWithFrontMatter('2026-09-01T00:00:00.000Z', 'Moved once'),
      noteId,
    );
    await writeNote(
      scopeDir,
      'inbox/moved once.md',
      content,
      at('2026-09-01T00:00:00.000Z'),
    );
    await writeFile(join(scopeDir, 'manifest.json'), '{ "version": 1 }\n');
    const source = join(scopeDir, 'inbox', 'moved once.md');
    const fsPromises =
      jest.requireActual<typeof FsPromises>('node:fs/promises');
    const realUnlink = fsPromises.unlink;
    // A holder that lost its lock part way: the writer that took over
    // finished this move before the old name was removed here.
    const unlinkSpy = jest
      .spyOn(fsPromises, 'unlink')
      .mockImplementation(async (path) => {
        if (String(path) === source) await realUnlink(path);
        return realUnlink(path);
      });
    try {
      await prepareScope(scopeDir);
    } finally {
      unlinkSpy.mockRestore();
    }

    const names = await inboxNames(scopeDir);
    expect(names).toEqual([
      memoryNoteFileName(
        Date.parse('2026-09-01T00:00:00.000Z'),
        'moved once',
        noteId,
      ),
    ]);
    await expect(
      readFile(join(scopeDir, 'inbox', names[0] ?? ''), 'utf8'),
    ).resolves.toBe(content);
  });

  it('warns once a backfill finds a note ID in two files', async () => {
    const warning = jest
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    try {
      const noteId = memoryNoteIdAt(Date.parse('2026-09-01T00:00:00.000Z'));
      const content = withMemoryNoteId(
        noteWithFrontMatter('2026-09-01T00:00:00.000Z', 'Copied by hand'),
        noteId,
      );
      for (const fileKey of [
        'inbox/2026-09-01T00-00-00-copied-by-hand.md',
        'inbox/.consolidated/2026-09-01T00-00-00-copied-by-hand.md',
      ]) {
        await writeNote(
          scopeDir,
          fileKey,
          content,
          at('2026-09-01T00:00:00.000Z'),
        );
      }

      await prepareScope(scopeDir);

      await expect(findDuplicateMemoryNoteIds(scopeDir)).resolves.toEqual([
        {
          id: noteId,
          fileKeys: [
            'inbox/2026-09-01T00-00-00-copied-by-hand.md',
            'inbox/.consolidated/2026-09-01T00-00-00-copied-by-hand.md',
          ],
        },
      ]);
      expect(warning).toHaveBeenCalledWith(
        '1 memory note IDs are each in more than one file',
        { code: 'LOCAL_MEMORY_NOTE_ID_DUPLICATED' },
      );
    } finally {
      warning.mockRestore();
    }
  });

  it('survives being killed part way through a backfill in another process', async () => {
    const created = (index: number): number =>
      Date.parse('2026-09-01T00:00:00.000Z') + index * 60_000;
    const mtimeOf = (index: number): number => created(index) + 30_000;
    const count = 120;
    for (const killAfterMs of [0, 25, 75]) {
      const trialDir = await mkdtemp(join(tmpdir(), 'local-memory-killed-'));
      try {
        for (let index = 0; index < count; index += 1) {
          const iso = new Date(created(index)).toISOString();
          const name =
            index % 3 === 0
              ? `odd name ${index}.md`
              : `${iso.slice(0, 19).replace(/:/g, '-')}-fact-${index}.md`;
          await writeNote(
            trialDir,
            `inbox/${name}`,
            noteWithFrontMatter(iso, `Fact number ${index}`),
            new Date(mtimeOf(index)),
          );
        }
        const child = startScopeChild(['prepare', trialDir]);
        await child.printed('READY');
        await new Promise((resolve) => setTimeout(resolve, killAfterMs));
        child.process.kill('SIGKILL');
        await child.exited;

        // The killed writer's process is gone: take its lock over now.
        await (
          await acquireMemoryScopeLock(trialDir, { staleMs: 0 })
        ).release();
        await prepareScope(trialDir);

        const names = await inboxNames(trialDir);
        expect(names).toHaveLength(count);
        const seen = new Set<number>();
        const ids = new Set<string>();
        for (const name of names) {
          expect(isMemoryNoteFileKey(`inbox/${name}`, 'inbox')).toBe(true);
          const path = join(trialDir, 'inbox', name);
          const content = await readFile(path, 'utf8');
          const lines = content.trim().split('\n');
          const index = Number(
            lines[lines.length - 1]?.slice('Fact number '.length),
          );
          expect(seen.has(index)).toBe(false);
          seen.add(index);
          const id = parseMemoryNoteIdentity(content)?.id ?? '';
          ids.add(id);
          expect(memoryUlidTime(id)).toBe(created(index));
          expect((await stat(path)).mtimeMs).toBe(mtimeOf(index));
        }
        expect(seen.size).toBe(count);
        expect(ids.size).toBe(count);
        expect((await readManifest(trialDir)).backfilledAt).not.toBeNull();
      } finally {
        await rm(trialDir, { recursive: true, force: true });
      }
    }
  });

  it('keeps reading a scope a newer build made read-only, but refuses to change it', async () => {
    await writeNote(
      scopeDir,
      'inbox/2026-09-01T00-00-00-kept.md',
      withMemoryNoteId(
        noteWithFrontMatter('2026-09-01T00:00:00.000Z', 'Kept deploy fact'),
        memoryNoteIdAt(Date.parse('2026-09-01T00:00:00.000Z')),
      ),
      at('2026-09-01T00:00:00.000Z'),
    );
    await writeFile(join(scopeDir, 'MEMORY.md'), '# Memory\n\n- Deploys\n');
    const manifest = `${JSON.stringify(
      {
        version: 2,
        incarnation: '6f3c3c43-62f1-4a65-8e7e-2c1a8e1f3b7a',
        revision: 7,
        minWriterFormat: 3,
        createdAt: '2026-09-01T00:00:00.000Z',
        backfilledAt: '2026-09-01T00:00:00.000Z',
        binding: null,
        migratedTo: [],
        addedByNewerBuild: { kept: true },
      },
      null,
      2,
    )}\n`;
    await writeFile(join(scopeDir, 'manifest.json'), manifest);

    await expect(
      appendInboxNote(scopeDir, {
        text: 'Not saved',
        source: { provider: 'claude', chatId: 'chat-1' },
      }),
    ).rejects.toBeInstanceOf(LocalMemoryScopeReadOnlyError);
    const document = await readLocalMemoryDocument(scopeDir, 'MEMORY.md');
    await expect(
      updateLocalMemoryFile(scopeDir, {
        fileKey: 'MEMORY.md',
        revision: document.revision,
        body: '- Changed',
      }),
    ).rejects.toThrow(LOCAL_MEMORY_READ_ONLY_MESSAGE);
    const note = await readLocalMemoryDocument(
      scopeDir,
      'inbox/2026-09-01T00-00-00-kept.md',
    );
    await expect(
      deleteLocalMemoryFile(scopeDir, {
        fileKey: 'inbox/2026-09-01T00-00-00-kept.md',
        revision: note.revision,
      }),
    ).rejects.toThrow(LOCAL_MEMORY_READ_ONLY_MESSAGE);

    // Injection and search read it as before.
    await expect(readMemoryIndex(scopeDir)).resolves.toEqual({
      text: '# Memory\n\n- Deploys',
      truncated: false,
    });
    await expect(readRecentInboxNoteEntries(scopeDir)).resolves.toEqual([
      {
        fileKey: 'inbox/2026-09-01T00-00-00-kept.md',
        text: 'Kept deploy fact',
      },
    ]);
    expect(
      (await searchMemory([{ scope: 'user', dir: scopeDir }], 'deploy')).map(
        (hit) => hit.fileKey,
      ),
    ).toEqual(['MEMORY.md', 'inbox/2026-09-01T00-00-00-kept.md']);
    expect(await inboxNames(scopeDir)).toEqual(['2026-09-01T00-00-00-kept.md']);
    await expect(
      readFile(join(scopeDir, 'manifest.json'), 'utf8'),
    ).resolves.toBe(manifest);
  });

  it('writes into a later manifest version it may write without dropping its fields', async () => {
    await writeFile(
      join(scopeDir, 'manifest.json'),
      JSON.stringify({
        version: 3,
        incarnation: '6f3c3c43-62f1-4a65-8e7e-2c1a8e1f3b7a',
        revision: 4,
        minWriterFormat: 2,
        addedByNewerBuild: 'kept',
      }),
    );

    await expect(
      appendInboxNote(scopeDir, {
        text: 'Saved alongside a newer build',
        source: { provider: 'claude', chatId: 'chat-1' },
      }),
    ).resolves.toMatch(/^inbox\//);
    await withMemoryWriteLock(scopeDir, () => recordMemoryEdit(scopeDir));

    expect(
      JSON.parse(await readFile(join(scopeDir, 'manifest.json'), 'utf8')),
    ).toEqual({
      version: 3,
      incarnation: '6f3c3c43-62f1-4a65-8e7e-2c1a8e1f3b7a',
      revision: 5,
      minWriterFormat: 2,
      addedByNewerBuild: 'kept',
    });
  });

  it('names notes saved on two devices apart, even with the same text in the same second', async () => {
    const otherDevice = await mkdtemp(join(tmpdir(), 'local-memory-device-'));
    try {
      jest.useFakeTimers({
        now: new Date('2026-10-27T10:00:00.000Z'),
        doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
      });
      const note = {
        text: 'Ports move as a pair',
        source: { provider: 'claude', chatId: 'chat-1' },
      };
      const keys = [
        await appendInboxNote(scopeDir, note),
        await appendInboxNote(otherDevice, note),
      ];
      jest.useRealTimers();
      expect(keys[0]).not.toBe(keys[1]);
      for (const key of keys) {
        expect(key).toMatch(
          /^inbox\/2026-10-27T10-00-00-ports-move-as-a-pair-[0-9a-z]{6}\.md$/,
        );
        expect(isMemoryNoteFileKey(key, 'inbox')).toBe(true);
      }
      const sameMs = Date.parse('2026-10-27T10:00:00.000Z');
      const names = new Set(
        Array.from({ length: 200 }, () =>
          memoryNoteFileName(sameMs, 'Ports move', memoryNoteIdAt(sameMs)),
        ),
      );
      expect(names.size).toBe(200);
    } finally {
      jest.useRealTimers();
      await rm(otherDevice, { recursive: true, force: true });
    }
  });
});
