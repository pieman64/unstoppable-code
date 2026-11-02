import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import type * as PathsModule from '../lib/paths';
import type { writeClipboardAttachmentToDir as WriteClipboardAttachmentToDir } from '../lib/standalone-workspace-files';

// `getCoworkManagedSubdir` (used by the source module for the migrated
// cowork layout) is a real, pure path-join helper, so it is left unmocked
// here; only the workspace-root lookup needs a fixture-controlled root.
jest.mock('../lib/paths', () => {
  const actual = jest.requireActual<typeof PathsModule>('../lib/paths');
  return { ...actual, getCoworkWorkspaceRootDir: jest.fn() };
});

import { getCoworkWorkspaceRootDir } from '../lib/paths';
import {
  deleteAttachment,
  importAttachment,
  listAttachments,
  listNotes,
  listPrompts,
  readNote,
  readPrompt,
  saveNote,
  savePrompt,
} from '../lib/standalone-workspace-files';
import {
  readSharedContainerFileScope,
  writeSharedContainerFileScope,
} from '../shared-containers/file-scope-store';

const mockedHomeDir = jest.mocked(getCoworkWorkspaceRootDir);
const BRAND_DIR = BRAND.storage.projectConfigDirNames[0];

describe('standalone project file helpers', () => {
  const originalDataDir = process.env.CANOPY_DATA_DIR;
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'canopy-standalone-workspace-'));
    process.env.CANOPY_DATA_DIR = rootDir;
    mockedHomeDir.mockImplementation((workspaceId: string) =>
      join(rootDir, workspaceId, 'home'),
    );
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    await rm(rootDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('saves, lists, and reads notes', async () => {
    const meta = await saveNote(
      'alpha',
      'Release Notes',
      '# Release Notes\nhello',
    );

    expect(meta.id).toBe('release-notes');
    await expect(listNotes('alpha')).resolves.toEqual([
      expect.objectContaining({ id: 'release-notes', title: 'Release Notes' }),
    ]);
    await expect(readNote('alpha', 'release-notes')).resolves.toMatchObject({
      meta: { id: 'release-notes' },
      content: '# Release Notes\nhello',
    });
  });

  it('saves, lists, and reads prompts with frontmatter', async () => {
    const meta = await savePrompt('alpha', 'Bug Bash', 'Investigate the issue');

    expect(meta.id).toBe('bug-bash');
    await expect(listPrompts('alpha')).resolves.toEqual([
      expect.objectContaining({ id: 'bug-bash', title: 'Bug Bash' }),
    ]);
    await expect(readPrompt('alpha', 'bug-bash')).resolves.toMatchObject({
      meta: { id: 'bug-bash', title: 'Bug Bash' },
      content: 'Investigate the issue',
    });
  });

  it('preserves source ids when importing workspace items', async () => {
    const note = await saveNote(
      'alpha',
      'Published note',
      '# Published note',
      'Source_Note_ID',
      { preserveId: true },
    );
    const prompt = await savePrompt(
      'alpha',
      'Published prompt',
      'Prompt body',
      'Source_Prompt_ID',
      { preserveId: true },
    );

    expect(note.id).toBe('Source_Note_ID');
    expect(prompt.id).toBe('Source_Prompt_ID');
    await expect(readNote('alpha', note.id)).resolves.toMatchObject({
      meta: { id: 'Source_Note_ID' },
      content: '# Published note',
    });
    await expect(readPrompt('alpha', prompt.id)).resolves.toMatchObject({
      meta: { title: 'Published prompt' },
      content: 'Prompt body',
    });
  });

  it('migrates excluded note and prompt ids when an edit changes their slug', async () => {
    const note = await saveNote('alpha', 'Original Note', 'note body');
    const prompt = await savePrompt('alpha', 'Original Prompt', 'prompt body');
    await writeSharedContainerFileScope('alpha', 'entry-1', {
      includedPaths: [],
      excludedNoteIds: [note.id],
      excludedPromptIds: [prompt.id],
    });
    await writeSharedContainerFileScope('alpha', 'entry-2', {
      includedPaths: [],
      excludedNoteIds: [note.id],
    });

    const renamedNote = await saveNote(
      'alpha',
      'Renamed Note',
      'note body',
      note.id,
    );
    const renamedPrompt = await savePrompt(
      'alpha',
      'Renamed Prompt',
      'prompt body',
      prompt.id,
    );

    expect(renamedNote.id).toBe('renamed-note');
    expect(renamedPrompt.id).toBe('renamed-prompt');
    await expect(
      readSharedContainerFileScope('alpha', 'entry-1'),
    ).resolves.toEqual({
      includedPaths: [],
      includedNoteIds: [],
      excludedNoteIds: [renamedNote.id],
      includedPromptIds: [],
      excludedPromptIds: [renamedPrompt.id],
      includedRunScripts: [],
      runSharingEnabled: false,
    });
    await expect(
      readSharedContainerFileScope('alpha', 'entry-2'),
    ).resolves.toEqual({
      includedPaths: [],
      includedNoteIds: [],
      excludedNoteIds: [renamedNote.id],
      includedPromptIds: [],
      includedRunScripts: [],
      runSharingEnabled: false,
    });
  });

  it('imports and deletes attachments', async () => {
    const sourcePath = join(rootDir, 'source.txt');
    await writeFile(sourcePath, 'attachment body', 'utf8');

    const meta = await importAttachment('alpha', sourcePath);
    expect(meta.filename).toBe('source.txt');
    await expect(listAttachments('alpha')).resolves.toEqual([
      expect.objectContaining({ filename: 'source.txt' }),
    ]);

    await deleteAttachment('alpha', 'source.txt');
    await expect(listAttachments('alpha')).resolves.toEqual([]);
  });

  it('removes a clipboard attachment when post-write verification fails', async () => {
    const attachmentsDir = join(rootDir, 'clipboard-attachments');
    const actualFs = jest.requireActual<typeof FsPromises>('node:fs/promises');
    let writeClipboardAttachmentToDir:
      | typeof WriteClipboardAttachmentToDir
      | undefined;

    jest.isolateModules(() => {
      jest.doMock('node:fs/promises', () => ({
        ...actualFs,
        stat: jest.fn(async (path: string) => {
          if (path.endsWith('notes.txt')) {
            throw new Error('simulated post-write stat failure');
          }
          return actualFs.stat(path);
        }),
      }));
      ({ writeClipboardAttachmentToDir } = jest.requireActual(
        '../lib/standalone-workspace-files',
      ));
    });

    if (!writeClipboardAttachmentToDir) {
      throw new Error('Expected standalone workspace file module export');
    }
    await expect(
      writeClipboardAttachmentToDir(attachmentsDir, {
        filename: 'notes.txt',
        data: new Uint8Array(Buffer.from('attachment body')),
      }),
    ).rejects.toThrow('simulated post-write stat failure');
    await expect(readdir(attachmentsDir)).resolves.toEqual([]);
    jest.dontMock('node:fs/promises');
  });

  it('routes notes/prompts/attachments under an external cowork root', async () => {
    // An attached external cowork workspace resolves to the user's own
    // folder (no `workspaces/{id}/home` nesting) via
    // `getCoworkWorkspaceRootDir`. Everything Canopy-managed still lands
    // under that root's `.{brand}/` subfolder.
    const externalDir = join(rootDir, 'external-project');
    mockedHomeDir.mockImplementation((workspaceId: string) =>
      workspaceId === 'ext-ws'
        ? externalDir
        : join(rootDir, workspaceId, 'home'),
    );

    await saveNote('ext-ws', 'External Note', 'External note body');
    await savePrompt('ext-ws', 'External Prompt', 'External prompt body');

    const attachmentSource = join(rootDir, 'external-attachment.txt');
    await writeFile(attachmentSource, 'attachment body', 'utf8');
    await importAttachment('ext-ws', attachmentSource);

    await expect(
      readFile(
        join(externalDir, BRAND_DIR, 'notes', 'external-note.md'),
        'utf8',
      ),
    ).resolves.toContain('External note body');
    await expect(
      readFile(
        join(externalDir, BRAND_DIR, 'prompts', 'external-prompt.md'),
        'utf8',
      ),
    ).resolves.toContain('External prompt body');
    await expect(
      readFile(
        join(externalDir, BRAND_DIR, 'attachments', 'external-attachment.txt'),
        'utf8',
      ),
    ).resolves.toBe('attachment body');
  });
});
