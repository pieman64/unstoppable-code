import type * as DocumentParser from '../memory/local/document-parser';
import type { LocalMemoryDocument } from '@canopy/desktop-shared/types';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteLocalMemoryFile,
  excerptFromProbeHead,
  listLocalMemoryFiles,
  readLocalMemoryDocument,
  sourceFromProbeHead,
  updateLocalMemoryFile,
} from '../memory/local/explorer';

jest.mock('../memory/local/parse-runner', () => ({
  parseMemoryDocumentInWorker: jest.fn(
    (fileKey: string, content: string): Promise<LocalMemoryDocument> =>
      Promise.resolve(
        jest
          .requireActual<
            typeof DocumentParser
          >('../memory/local/document-parser')
          .parseMemoryDocument(fileKey, content),
      ),
  ),
}));

const NOTE = [
  '---',
  'source:',
  '  provider: "claude"',
  '  chatId: "chat-42"',
  '  sessionId: "session-1"',
  'created: "2026-10-20T09:00:00.000Z"',
  'modified: "2026-10-20T09:00:00.000Z"',
  'type: inbox',
  '---',
  '',
  'Dev server ports move as a pair.',
  'Use **3008** and `8081` when [another session](https://example.com) holds them.',
  '',
].join('\n');

describe('memory panel file summaries', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'memory-files-'));
    await mkdir(join(directory, 'topics'));
    await mkdir(join(directory, 'inbox'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('lists the line under the title and the chat that saved a note', async () => {
    await writeFile(
      join(directory, 'MEMORY.md'),
      '# Index\n\n- [Ports](topics/ports.md)\n',
    );
    await writeFile(
      join(directory, 'topics', 'ports.md'),
      '# Dev server ports\n\n```sh\npnpm dev\n```\n\n- Client and backend ports move together.\n',
    );
    await writeFile(
      join(directory, 'topics', 'untitled.md'),
      '- Prefer pnpm for every package command.\n',
    );
    await writeFile(join(directory, 'inbox', 'note.md'), NOTE);
    const files = new Map(
      (await listLocalMemoryFiles(directory)).map((file) => [
        file.fileKey,
        file,
      ]),
    );
    expect(files.get('MEMORY.md')).toMatchObject({
      title: 'Index',
      excerpt: 'Ports',
    });
    expect(files.get('topics/ports.md')).toMatchObject({
      title: 'Dev server ports',
      excerpt: 'Client and backend ports move together.',
    });
    expect(files.get('topics/ports.md')).not.toHaveProperty('source');
    expect(files.get('topics/untitled.md')).toMatchObject({
      excerpt: 'Prefer pnpm for every package command.',
    });
    expect(files.get('inbox/note.md')).toMatchObject({
      title: 'Dev server ports move as a pair.',
      excerpt: 'Use 3008 and 8081 when another session holds them.',
      source: { provider: 'claude', chatId: 'chat-42' },
    });
  });

  it('clips a long excerpt and ignores a note without a complete source', () => {
    const excerpt = excerptFromProbeHead(`# T\n\n${'word '.repeat(60)}`, {
      titled: true,
    });
    expect(excerpt?.endsWith('…')).toBe(true);
    expect(Array.from(excerpt ?? '').length).toBeLessThanOrEqual(161);
    expect(
      sourceFromProbeHead('---\nsource:\n  provider: "claude"\n---\nText'),
    ).toBeUndefined();
    expect(sourceFromProbeHead('No front matter')).toBeUndefined();
    expect(
      sourceFromProbeHead(
        '---\nsource:\n  provider: codex\n  chatId: abc\n---\n',
      ),
    ).toEqual({ provider: 'codex', chatId: 'abc' });
  });
});

describe('memory panel file edits', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'memory-file-edits-'));
    await mkdir(join(directory, 'topics'));
    await mkdir(join(directory, 'inbox'));
  });
  afterEach(async () => {
    jest.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  });

  it('replaces a topic title and body at the revision it read', async () => {
    const path = join(directory, 'topics', 'ports.md');
    await writeFile(path, '# Ports\n\nOld text.\n');
    const before = await readLocalMemoryDocument(directory, 'topics/ports.md');
    const updated = await updateLocalMemoryFile(directory, {
      fileKey: 'topics/ports.md',
      revision: before.revision,
      title: '  Dev server\nports ',
      body: '- Client 3008\n- API 8081\n',
    });
    expect(await readFile(path, 'utf8')).toBe(
      '# Dev server ports\n\n- Client 3008\n- API 8081\n',
    );
    expect(updated.items[0].text).toBe('# Dev server ports');
    await expect(
      updateLocalMemoryFile(directory, {
        fileKey: 'topics/ports.md',
        revision: before.revision,
        body: 'Stale',
      }),
    ).rejects.toThrow('Memory changed since you opened it');
  });

  it('keeps a note front matter, moves its modified time and keeps CRLF', async () => {
    jest.useFakeTimers({
      now: new Date('2026-10-23T12:00:00.000Z'),
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    const path = join(directory, 'inbox', 'note.md');
    await writeFile(path, NOTE.replace(/\n/g, '\r\n'));
    const before = await readLocalMemoryDocument(directory, 'inbox/note.md');
    await updateLocalMemoryFile(directory, {
      fileKey: 'inbox/note.md',
      revision: before.revision,
      body: 'Ports move as a pair.',
    });
    const after = await readFile(path, 'utf8');
    expect(after).toContain('  chatId: "chat-42"\r\n');
    expect(after).toContain('created: "2026-10-20T09:00:00.000Z"\r\n');
    expect(after).toContain('modified: "2026-10-23T12:00:00.000Z"\r\n');
    expect(after.endsWith('---\r\n\r\nPorts move as a pair.\r\n')).toBe(true);
    // Reading back gives the body exactly as written, after the front matter.
    const reread = await readLocalMemoryDocument(directory, 'inbox/note.md');
    expect(reread.markdown).toBe('\r\nPorts move as a pair.\r\n');
  });

  it('edits the index but refuses to delete it, an empty title or an empty untitled body', async () => {
    await writeFile(join(directory, 'MEMORY.md'), '# Index\n\n- Old\n');
    await writeFile(join(directory, 'inbox', 'note.md'), 'Note\n');
    const index = await readLocalMemoryDocument(directory, 'MEMORY.md');
    const note = await readLocalMemoryDocument(directory, 'inbox/note.md');
    await expect(
      deleteLocalMemoryFile(directory, {
        fileKey: 'MEMORY.md',
        revision: index.revision,
      }),
    ).rejects.toThrow('Only topics and notes can be deleted.');
    await updateLocalMemoryFile(directory, {
      fileKey: 'MEMORY.md',
      revision: index.revision,
      title: 'Index',
      body: '- New',
    });
    expect(await readFile(join(directory, 'MEMORY.md'), 'utf8')).toBe(
      '# Index\n\n- New\n',
    );
    await expect(
      updateLocalMemoryFile(directory, {
        fileKey: 'inbox/note.md',
        revision: note.revision,
        title: ' ',
        body: 'x',
      }),
    ).rejects.toThrow('Add a title.');
    await expect(
      updateLocalMemoryFile(directory, {
        fileKey: 'inbox/note.md',
        revision: note.revision,
        body: '  ',
      }),
    ).rejects.toThrow('Add the memory text.');
    expect(await readFile(join(directory, 'inbox', 'note.md'), 'utf8')).toBe(
      'Note\n',
    );
  });

  it('keeps a byte order mark and the spacing after front matter', async () => {
    const withBom = join(directory, 'topics', 'bom.md');
    await writeFile(withBom, '\uFEFF- First memory\n- Keep memory\n');
    let before = await readLocalMemoryDocument(directory, 'topics/bom.md');
    expect(before.markdown).toBe('- First memory\n- Keep memory\n');
    await updateLocalMemoryFile(directory, {
      fileKey: 'topics/bom.md',
      revision: before.revision,
      body: '- Updated memory\n- Keep memory',
    });
    expect(await readFile(withBom, 'utf8')).toBe(
      '\uFEFF- Updated memory\n- Keep memory\n',
    );
    const tight = join(directory, 'topics', 'tight.md');
    await writeFile(tight, '\uFEFF---\r\ncreated: today\r\n---\r\n- First\r\n');
    before = await readLocalMemoryDocument(directory, 'topics/tight.md');
    await updateLocalMemoryFile(directory, {
      fileKey: 'topics/tight.md',
      revision: before.revision,
      body: '    indented code  \n- Second',
    });
    expect(await readFile(tight, 'utf8')).toBe(
      '\uFEFF---\r\ncreated: today\r\n---\r\n    indented code  \r\n- Second\r\n',
    );
  });

  it('deletes a note only at the revision it read', async () => {
    const path = join(directory, 'inbox', 'note.md');
    await writeFile(path, 'Note\n');
    const before = await readLocalMemoryDocument(directory, 'inbox/note.md');
    await writeFile(path, 'Changed note\n');
    await expect(
      deleteLocalMemoryFile(directory, {
        fileKey: 'inbox/note.md',
        revision: before.revision,
      }),
    ).rejects.toThrow('Memory changed since you opened it');
    expect((await stat(path)).isFile()).toBe(true);
    const current = await readLocalMemoryDocument(directory, 'inbox/note.md');
    await deleteLocalMemoryFile(directory, {
      fileKey: 'inbox/note.md',
      revision: current.revision,
    });
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      deleteLocalMemoryFile(directory, {
        fileKey: 'inbox/../inbox/x.md',
        revision: current.revision,
      }),
    ).rejects.toThrow();
  });
});
