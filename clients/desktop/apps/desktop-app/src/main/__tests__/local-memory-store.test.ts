import type * as DocumentParser from '../memory/local/document-parser';
import type { LocalMemoryDocument } from '@canopy/desktop-shared/types';
import * as ParseRunner from '../memory/local/parse-runner';
import { parseMemoryDocument } from '../memory/local/document-parser';
import type * as FsPromises from 'node:fs/promises';
import {
  listLocalMemoryFiles,
  readLocalMemoryDocument,
  mutateLocalMemoryItem,
  titleFromProbeHead,
} from '../memory/local/explorer';
import {
  regexSourcesRun,
  workGrowth,
} from '../../../../../packages/protocol/src/__tests__/helpers/work-meter';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendInboxNote,
  listTopics,
  readMemoryIndex,
  readMemoryFile,
  readRecentInboxNotes,
  readTopic,
  searchMemory,
} from '../memory/local/store';
import { LOCAL_MEMORY_MORE_MARKER } from '../memory/local/boundary-truncation';
import { parseMemoryNoteIdentity } from '../memory/local/note-identity';
import { prepareMemoryScopeForWrite } from '../memory/local/scope-manifest';
import {
  MemoryManifestFileSchema,
  memoryUlidTime,
} from '@canopy/protocol/memory-sync';

describe('local memory store', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'local-memory-store-'));
  });

  afterEach(async () => {
    jest.useRealTimers();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('returns an empty index for missing files and clips by lines and UTF-8 bytes', async () => {
    await expect(readMemoryIndex(rootDir)).resolves.toEqual({
      text: '',
      truncated: false,
    });

    await writeFile(join(rootDir, 'MEMORY.md'), 'line-0\nline-1\n', 'utf8');
    await expect(readMemoryIndex(rootDir)).resolves.toEqual({
      text: 'line-0\nline-1',
      truncated: false,
    });

    await writeFile(
      join(rootDir, 'MEMORY.md'),
      Array.from({ length: 250 }, (_, index) => `line-${index}`).join('\n'),
      'utf8',
    );
    const lineClipped = await readMemoryIndex(rootDir);
    // Over the line limit while far under the byte limit: still reported.
    expect(lineClipped.truncated).toBe(true);
    expect(Buffer.byteLength(lineClipped.text, 'utf8')).toBeLessThan(4096);
    expect(lineClipped.text.split('\n')).toHaveLength(200);
    expect(lineClipped.text).not.toContain('line-200');

    await writeFile(join(rootDir, 'MEMORY.md'), 'é'.repeat(20_000), 'utf8');
    const byteClipped = await readMemoryIndex(rootDir);
    expect(byteClipped.truncated).toBe(true);
    expect(Buffer.byteLength(byteClipped.text, 'utf8')).toBeLessThanOrEqual(
      25 * 1024,
    );
    expect(byteClipped.text).not.toContain('\uFFFD');
  });

  it('reads only path-safe memory file keys and clips normalized content to 24 KiB', async () => {
    await mkdir(join(rootDir, 'topics'), { recursive: true });
    await mkdir(join(rootDir, 'inbox'), { recursive: true });
    await writeFile(join(rootDir, 'MEMORY.md'), 'Index\r\ncontent\0', 'utf8');
    await writeFile(
      join(rootDir, 'topics', 'large.md'),
      `# Large\r\n${'é'.repeat(20_000)}`,
      'utf8',
    );
    await writeFile(join(rootDir, 'inbox', 'note.md'), 'Inbox note', 'utf8');

    await expect(readMemoryFile(rootDir, 'MEMORY.md')).resolves.toBe(
      'Index\ncontent',
    );
    await expect(readMemoryFile(rootDir, 'inbox/note.md')).resolves.toBe(
      'Inbox note',
    );
    const clipped = await readMemoryFile(rootDir, 'topics/large.md');
    expect(clipped).toBeDefined();
    expect(Buffer.byteLength(clipped ?? '', 'utf8')).toBeLessThanOrEqual(
      24 * 1024,
    );
    expect(clipped).toContain('[Memory content truncated at 24 KiB.]');
    expect(clipped).not.toContain('\uFFFD');

    for (const unsafeFile of [
      '../x.md',
      'topics/../../x',
      '/tmp/x.md',
      'topics/nested/x.md',
      'topics\\x.md',
    ]) {
      await expect(
        readMemoryFile(rootDir, unsafeFile),
      ).resolves.toBeUndefined();
    }
    await expect(
      readMemoryFile(rootDir, 'topics/missing.md'),
    ).resolves.toBeUndefined();
  });

  it('redacts secrets, writes provenance, identity and the manifest, and never reuses a name', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-05T12:00:00.000Z'));
    const note = {
      text: 'Deploy with Bearer abcdefghijklmnopqrstuvwxyz and api_key=supersecretvalue, plus OPENAI_CUSTOM_TOKEN=anothersecretvalue.',
      source: {
        provider: 'claude',
        chatId: 'chat-1',
        sessionId: 'session-1',
      },
    };

    const [firstKey, secondKey] = await Promise.all([
      appendInboxNote(rootDir, note),
      appendInboxNote(rootDir, note),
    ]);
    // Same text in the same second: the ID suffix still names them apart.
    for (const key of [firstKey, secondKey]) {
      expect(key).toMatch(
        /^inbox\/2026-08-05T12-00-00-deploy-with-bearer-redacted-and-api-key-token-[0-9a-hjkmnp-tv-z]{6}\.md$/,
      );
    }
    expect(firstKey).not.toBe(secondKey);
    const content = await readFile(join(rootDir, firstKey), 'utf8');
    const identity = parseMemoryNoteIdentity(content);
    expect(identity).not.toBeNull();
    expect(content.startsWith(`---\nid: "${identity?.id}"\n`)).toBe(true);
    expect(
      firstKey.endsWith(`-${identity?.id.slice(-6).toLowerCase()}.md`),
    ).toBe(true);
    expect(memoryUlidTime(identity?.id ?? '')).toBe(
      Date.parse('2026-08-05T12:00:00.000Z'),
    );
    expect(content).toContain('source:\n  provider: "claude"');
    expect(content).toContain('created: "2026-08-05T12:00:00.000Z"');
    expect(content).toContain('modified: "2026-08-05T12:00:00.000Z"');
    expect(content).toContain('type: inbox');
    expect(content).toContain('Bearer <redacted>');
    expect(content).toContain('api_key=<redacted>');
    expect(content).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(content).not.toContain('anothersecretvalue');
    const manifest = MemoryManifestFileSchema.parse(
      JSON.parse(await readFile(join(rootDir, 'manifest.json'), 'utf8')),
    );
    expect(manifest).toMatchObject({
      version: 2,
      minWriterFormat: 2,
      binding: null,
      migratedTo: [],
    });
    expect(manifest.backfilledAt).not.toBeNull();
  });

  it('redacts quoted secret assignments, including short values (shared pass)', async () => {
    const fileKey = await appendInboxNote(rootDir, {
      text: `api_key="supersecretvalue"\n"api_key": "supersecretvalue"\npassword: 'hunter2secret'\npassword: 'tiny1'`,
      source: { provider: 'claude', chatId: 'chat-1' },
    });
    const content = await readFile(join(rootDir, fileKey), 'utf8');
    expect(content).toContain('api_key=<redacted>');
    expect(content).toContain('"api_key": "<redacted>"');
    expect(content).toContain("password: '<redacted>'");
    expect(content).not.toContain('tiny1');
    expect(content).not.toContain('supersecretvalue');
    expect(content).not.toContain('hunter2secret');
  });

  it('redacts short and spaced assignment values once a separator is present', async () => {
    const fileKey = await appendInboxNote(rootDir, {
      text: `password = tiny1\napi_key\t= ab2\ntoken = 'xy'`,
      source: { provider: 'claude', chatId: 'chat-1' },
    });
    const content = await readFile(join(rootDir, fileKey), 'utf8');
    expect(content).not.toContain('tiny1');
    expect(content).not.toContain('ab2');
    expect(content).not.toContain("'xy'");
    expect(content).toContain('password = <TOKEN>');
  });

  it('redacts the rest of the line after an explicit secret assignment', async () => {
    const fileKey = await appendInboxNote(rootDir, {
      text: 'See password: hunter2 then run npm test\nNext line survives.',
      source: { provider: 'claude', chatId: 'chat-1' },
    });
    const content = await readFile(join(rootDir, fileKey), 'utf8');
    expect(content).not.toContain('hunter2');
    expect(content).not.toContain('then run npm test');
    expect(content).toContain('Next line survives.');
  });

  it('redacts control-character-obfuscated secret assignments in note text and filename', async () => {
    const cases = [
      'api\u0000_key=hunter2secret',
      'pass\u0000word: hunter2secret',
    ];
    for (const line of cases) {
      const fileKey = await appendInboxNote(rootDir, {
        text: `Note before.\n${line}\nNote after.`,
        source: { provider: 'claude', chatId: 'chat-1' },
      });
      const content = await readFile(join(rootDir, fileKey), 'utf8');
      expect(content).not.toContain('hunter2secret');
      expect(fileKey).not.toContain('hunter2secret');
      expect(content).toContain('Note before.');
      expect(content).toContain('Note after.');
    }
  });

  it('redacts every shared-vocabulary secret key in assignment form, in note text and filename', async () => {
    const cases: Array<{ line: string; leaked: string[] }> = [
      { line: 'pwd = hunter2', leaked: ['hunter2'] },
      { line: 'access_key = AKIFAKEEXAMPLE00', leaked: ['AKIFAKEEXAMPLE00'] },
      { line: 'secret_key = abc123def', leaked: ['abc123def'] },
      {
        line: 'secret_access_key: wJalrFake/Example/Value',
        leaked: ['wJalrFake', 'Example/Value'],
      },
      {
        line: 'client_secret= confidential-blob-77',
        leaked: ['confidential-blob-77'],
      },
      {
        line: 'refresh_token : many words leak here too',
        leaked: ['many words leak here too', 'words leak'],
      },
      {
        line: 'auth-token: "quoted long value"',
        leaked: ['quoted long value'],
      },
    ];
    for (const { line, leaked } of cases) {
      const fileKey = await appendInboxNote(rootDir, {
        text: `Note before.\n${line}\nNote after.`,
        source: { provider: 'claude', chatId: 'chat-1' },
      });
      const content = await readFile(join(rootDir, fileKey), 'utf8');
      for (const fragment of leaked) {
        expect(content).not.toContain(fragment);
        expect(fileKey.toLowerCase()).not.toContain(
          fragment.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        );
      }
      expect(content).toContain('Note before.');
      expect(content).toContain('Note after.');
    }
  });

  it('only matches api-key prefixes in their real key shapes', async () => {
    const fileKey = await appendInboxNote(rootDir, {
      text: 'Skateboarding tips and marketable skills stay, but sk_live_abcdef123456 goes.',
      source: { provider: 'claude', chatId: 'chat-1' },
    });
    const content = await readFile(join(rootDir, fileKey), 'utf8');
    expect(content).toContain('Skateboarding tips and marketable skills stay');
    expect(content).not.toContain('sk_live_abcdef123456');
    expect(content).toContain('<API_KEY>');
  });

  it('lists only topics that readTopic will accept, so list round-trips', async () => {
    await mkdir(join(rootDir, 'topics'), { recursive: true });
    await writeFile(join(rootDir, 'topics', 'valid-topic.md'), 'Body.', 'utf8');
    await writeFile(
      join(rootDir, 'topics', 'deployment notes.md'),
      'Body.',
      'utf8',
    );
    await writeFile(
      join(rootDir, 'topics', 'release.md.md'),
      'Double suffix.',
      'utf8',
    );

    const topics = await listTopics(rootDir);
    expect(topics).toEqual(['valid-topic']);
    await expect(readTopic(rootDir, 'valid-topic')).resolves.toContain('Body.');
  });

  it('redacts quoted multi-word credentials completely', async () => {
    const fileKey = await appendInboxNote(rootDir, {
      text: `password = "correct horse battery staple"\ntoken: 'multi word secret phrase'.`,
      source: { provider: 'claude', chatId: 'chat-1' },
    });
    const content = await readFile(join(rootDir, fileKey), 'utf8');
    expect(content).not.toContain('correct');
    expect(content).not.toContain('horse battery staple');
    expect(content).not.toContain('multi word secret phrase');
    expect(content).toContain('password = <TOKEN>');
    expect(content).toMatch(/token: <(?:TOKEN|redacted)>/);
  });

  it('leaves dates and plain numbers untouched (no phone heuristic)', async () => {
    const fileKey = await appendInboxNote(rootDir, {
      text: 'Deploys automatically on 2026-08-05.\nphone: 415-555-0134 then 2026 goals.',
      source: { provider: 'claude', chatId: 'chat-1' },
    });
    const content = await readFile(join(rootDir, fileKey), 'utf8');
    expect(content).toContain('Deploys automatically on 2026-08-05.');
    expect(content).toContain('phone: 415-555-0134 then 2026 goals.');
  });

  it('leaves prose keywords without assignment separators untouched', async () => {
    const fileKey = await appendInboxNote(rootDir, {
      text: 'The password reminder123 and token expiration12 discussion continues, but Bearer abcdefgh1234 is still redacted.',
      source: { provider: 'claude', chatId: 'chat-1' },
    });
    const content = await readFile(join(rootDir, fileKey), 'utf8');
    expect(content).toContain('password reminder123');
    expect(content).toContain('token expiration12');
    expect(content).toContain('Bearer <redacted>');
    expect(content).not.toContain('abcdefgh1234');
  });

  it('runs the shared redactor corpus as the base pass', async () => {
    const fileKey = await appendInboxNote(rootDir, {
      text: `Use github_pat_${'B'.repeat(40)} with header Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==`,
      source: { provider: 'claude', chatId: 'chat-1' },
    });
    const content = await readFile(join(rootDir, fileKey), 'utf8');
    expect(content).toContain('<redacted-token>');
    expect(content).not.toContain('github_pat_');
    expect(content).toContain('Authorization: <redacted>');
    expect(content).not.toContain('dXNlcjpwYXNzd29yZDEyMw');
  });

  it('redacts single-quoted secret keys', async () => {
    const fileKey = await appendInboxNote(rootDir, {
      text: `'api_key': 'supersecretvalue'\n'password'='hunter2secret'`,
      source: { provider: 'claude', chatId: 'chat-1' },
    });
    const content = await readFile(join(rootDir, fileKey), 'utf8');
    expect(content).toContain("'api_key': '<redacted>'");
    expect(content).toContain("'password'=<TOKEN>");
    expect(content).not.toContain('supersecretvalue');
    expect(content).not.toContain('hunter2secret');
  });

  it('orders recent inbox notes by modification time, not filename', async () => {
    const inboxDir = join(rootDir, 'inbox');
    await mkdir(inboxDir, { recursive: true });
    const earlier = join(inboxDir, '2026-08-12T10-00-00-zzz-older.md');
    const later = join(inboxDir, '2026-08-12T10-00-00-aaa-newer.md');
    await writeFile(earlier, 'Older note body.', 'utf8');
    await writeFile(later, 'Newer note body.', 'utf8');
    const base = new Date('2026-08-12T10:00:00.000Z');
    await utimes(earlier, base, base);
    await utimes(
      later,
      new Date(base.getTime() + 500),
      new Date(base.getTime() + 500),
    );

    await expect(
      readRecentInboxNotes(rootDir, { maxNotes: 1, maxCharsPerNote: 100 }),
    ).resolves.toEqual(['Newer note body.']);
    await expect(
      readRecentInboxNotes(rootDir, { maxNotes: 2, maxCharsPerNote: 100 }),
    ).resolves.toEqual(['Newer note body.', 'Older note body.']);
  });

  it('budgets each recent note on its own and shortens only at boundaries', async () => {
    await mkdir(join(rootDir, 'inbox'), { recursive: true });
    const lines = (tag: string): string =>
      Array.from(
        { length: 9 },
        (_, index) => `${tag} line ${index}: ${'x'.repeat(70)}.`,
      ).join('\n');
    const base = new Date('2026-09-01T10:00:00.000Z');
    const notes: string[] = ['a', 'b', 'c'];
    for (let index = 0; index < notes.length; index += 1) {
      const tag = notes[index] ?? '';
      const path = join(
        rootDir,
        'inbox',
        `2026-09-01T10-00-0${index}-${tag}.md`,
      );
      await writeFile(path, lines(tag), 'utf8');
      const at = new Date(base.getTime() + index * 1_000);
      await utimes(path, at, at);
    }
    const longPath = join(rootDir, 'inbox', '2026-09-01T10-00-09-long.md');
    await writeFile(longPath, `${lines('long')}\n${lines('more')}`, 'utf8');
    const later = new Date(base.getTime() + 9_000);
    await utimes(longPath, later, later);

    const recent = await readRecentInboxNotes(rootDir, {
      maxNotes: 4,
      maxCharsPerNote: 1_000,
    });
    // Three ~750-char notes all survive whole; a shared 1,000 budget would not.
    expect(recent.slice(1)).toEqual([lines('c'), lines('b'), lines('a')]);
    const [long] = recent;
    expect(long?.length).toBeLessThanOrEqual(1_000);
    expect(long?.endsWith(LOCAL_MEMORY_MORE_MARKER)).toBe(true);
    for (const line of (long ?? '').split('\n').slice(0, -1)) {
      expect(`${lines('long')}\n${lines('more')}`.split('\n')).toContain(line);
    }
  });

  it('strips frontmatter from recent inbox notes and budgets by body characters', async () => {
    await appendInboxNote(rootDir, {
      text: 'Remember to run verify before release.',
      source: { provider: 'claude', chatId: 'chat-1', sessionId: 'session-1' },
    });

    const [note] = await readRecentInboxNotes(rootDir, {
      maxNotes: 1,
      maxCharsPerNote: 100,
    });
    expect(note).toBe('Remember to run verify before release.');
    expect(note).not.toContain('---');
    expect(note).not.toContain('provider:');
    expect(note).not.toContain('created:');
    // Too long for the note budget even as one sentence: nothing partial.
    await expect(
      readRecentInboxNotes(rootDir, { maxNotes: 1, maxCharsPerNote: 12 }),
    ).resolves.toEqual([]);
  });

  it('pairs filename-only matches with the heading in effect at the fallback line', async () => {
    await mkdir(join(rootDir, 'topics'), { recursive: true });
    await writeFile(
      join(rootDir, 'topics', 'deployment.md'),
      'Intro line without heading.\n# Alpha\nAlpha details.\n# Omega\nOmega details.',
      'utf8',
    );
    await writeFile(
      join(rootDir, 'topics', 'rollout.md'),
      '# Alpha\nFirst line under alpha.\n# Omega\nOmega details.',
      'utf8',
    );

    await expect(
      searchMemory([{ scope: 'workspace', dir: rootDir }], 'deployment'),
    ).resolves.toEqual([
      {
        fileKey: 'topics/deployment.md',
        scope: 'workspace',
        snippet: 'Intro line without heading.',
      },
    ]);
    await expect(
      searchMemory([{ scope: 'workspace', dir: rootDir }], 'rollout'),
    ).resolves.toEqual([
      {
        fileKey: 'topics/rollout.md',
        scope: 'workspace',
        snippet: '# Alpha',
        heading: 'Alpha',
      },
    ]);
  });

  it('anchors search snippets around matched content beyond the initial window', async () => {
    await mkdir(join(rootDir, 'topics'), { recursive: true });
    await writeFile(
      join(rootDir, 'topics', 'archive.md'),
      `${'Earlier archive context. '.repeat(24)}The launch codename is STARLING.`,
      'utf8',
    );

    const hits = await searchMemory(
      [{ scope: 'workspace', dir: rootDir }],
      'starling',
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain('STARLING');
  });

  it('reads bounded recent notes and searches index, topics, and inbox with heading context', async () => {
    await mkdir(join(rootDir, 'topics'), { recursive: true });
    await mkdir(join(rootDir, 'inbox'), { recursive: true });
    await writeFile(
      join(rootDir, 'MEMORY.md'),
      '# Build\nUse npm run verify before release.',
      'utf8',
    );
    await writeFile(
      join(rootDir, 'topics', 'database.md'),
      '# Database\nThe local database uses SQLite WAL mode.',
      'utf8',
    );
    await writeFile(
      join(rootDir, 'inbox', '2026-08-05T12-00-00-new.md'),
      'Newest remembered correction',
      'utf8',
    );
    await writeFile(
      join(rootDir, 'inbox', '2026-08-04T12-00-00-old.md'),
      'Older note',
      'utf8',
    );
    const newDate = new Date('2026-08-05T12:00:00.000Z');
    const oldDate = new Date('2026-08-04T12:00:00.000Z');
    await utimes(
      join(rootDir, 'inbox', '2026-08-05T12-00-00-new.md'),
      newDate,
      newDate,
    );
    await utimes(
      join(rootDir, 'inbox', '2026-08-04T12-00-00-old.md'),
      oldDate,
      oldDate,
    );

    await expect(
      readRecentInboxNotes(rootDir, { maxNotes: 1, maxCharsPerNote: 100 }),
    ).resolves.toEqual(['Newest remembered correction']);
    await expect(listTopics(rootDir)).resolves.toEqual(['database']);
    await expect(readTopic(rootDir, 'database')).resolves.toContain(
      'SQLite WAL mode',
    );
    await expect(readTopic(rootDir, '../database')).resolves.toBeUndefined();

    await expect(
      searchMemory([{ scope: 'workspace', dir: rootDir }], 'sqlite wal'),
    ).resolves.toEqual([
      {
        fileKey: 'topics/database.md',
        scope: 'workspace',
        snippet: 'The local database uses SQLite WAL mode.',
        heading: 'Database',
      },
    ]);
    const filenameHit = await searchMemory(
      [{ scope: 'user', dir: rootDir }],
      'database',
    );
    expect(filenameHit[0]).toMatchObject({
      fileKey: 'topics/database.md',
      scope: 'user',
    });
  });
});

describe('local memory explorer', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'memory-explorer-'));
    // Already given note identities: listing then reads the fixtures as written.
    await prepareMemoryScopeForWrite(directory);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('parses a heading tree and individual entries while keeping nested lists and code together', () => {
    const content =
      '---\ncreated: today\n---\n# Preferences\n\nIntro paragraph.\nSecond line.\n\n## Writing\n- First memory\n  - Nested detail\n\n  Continuation\n- Second memory\n\n```md\n# Not a heading\n- Not an item\n```\n';
    const doc = parseMemoryDocument('MEMORY.md', content);
    expect(doc.items).toHaveLength(1);
    expect(doc.items[0].text).toBe('# Preferences');
    expect(doc.items[0].children[0].text).toBe(
      'Intro paragraph.\nSecond line.',
    );
    const children = doc.items[0].children[1].children;
    expect(children.map((item) => item.kind)).toEqual([
      'list-item',
      'list-item',
      'code',
    ]);
    expect(children[0].text).toBe(
      '- First memory\n  - Nested detail\n\n  Continuation',
    );
    expect(children[2].text).toBe('```md\n# Not a heading\n- Not an item\n```');
  });

  it.each(['```', '~~~'])(
    'preserves an adjacent %s code block when editing or deleting a list item',
    async (fence) => {
      const note = '- A preference';
      const code = `${fence}sh\nprintf preserved\n${fence}`;
      for (const replacement of ['- Updated preference', undefined]) {
        const content = `${note}\n${code}\n`;
        await writeFile(join(directory, 'MEMORY.md'), content);
        const doc = await readLocalMemoryDocument(directory, 'MEMORY.md');
        await mutateLocalMemoryItem(directory, {
          fileKey: doc.fileKey,
          revision: doc.revision,
          itemId: doc.items[0].id,
          ...(replacement === undefined ? {} : { text: replacement }),
        });
        expect(await readFile(join(directory, 'MEMORY.md'), 'utf8')).toBe(
          `${replacement ?? ''}\n${code}\n`,
        );
        expect(doc.items.map((item) => item.kind)).toEqual([
          'list-item',
          'code',
        ]);
      }
    },
  );

  it('keeps sufficiently indented fenced code inside its owning list item', () => {
    const content =
      '- A preference\n  ```sh\n  printf detail\n  ```\n- Another preference\n';
    const doc = parseMemoryDocument('MEMORY.md', content);
    expect(doc.items).toHaveLength(2);
    expect(doc.items[0].text).toBe(
      '- A preference\n  ```sh\n  printf detail\n  ```',
    );
  });

  it('leaves the memory file untouched when parsing the edited result fails', async () => {
    const content = '- Original preference\n';
    const file = join(directory, 'MEMORY.md');
    await writeFile(file, content);
    const document = await readLocalMemoryDocument(directory, 'MEMORY.md');
    const parse = jest
      .mocked(ParseRunner.parseMemoryDocumentInWorker)
      .mockResolvedValueOnce(document)
      .mockRejectedValueOnce(new Error('Parser unavailable'));
    try {
      await expect(
        mutateLocalMemoryItem(directory, {
          fileKey: document.fileKey,
          revision: document.revision,
          itemId: document.items[0].id,
          text: '- Updated preference',
        }),
      ).rejects.toThrow('Parser unavailable');
      expect(await readFile(file, 'utf8')).toBe(content);
    } finally {
      parse.mockClear();
    }
  });

  it('lists active index, topics and inbox files without reading archives', async () => {
    await expect(listLocalMemoryFiles(directory)).resolves.toEqual([]);
    await mkdir(join(directory, 'topics'));
    await mkdir(join(directory, 'inbox'));
    await mkdir(join(directory, 'consolidated'));
    await writeFile(join(directory, 'MEMORY.md'), '# Index');
    await writeFile(join(directory, 'topics', 'writing.md'), '- Writing');
    await writeFile(join(directory, 'topics', 'invalid name.md'), 'Excluded');
    await writeFile(join(directory, 'inbox', 'note.md'), 'Note');
    await writeFile(join(directory, 'consolidated', 'old.md'), 'Old');
    const files = await listLocalMemoryFiles(directory);
    expect(files.map((file) => file.fileKey).sort()).toEqual([
      'MEMORY.md',
      'inbox/note.md',
      'topics/writing.md',
    ]);
    expect(files.find((file) => file.kind === 'topic')?.sizeBytes).toBe(9);
    expect(files.find((file) => file.kind === 'index')?.title).toBe('Index');
    const writing = files.find((file) => file.fileKey === 'topics/writing.md');
    expect(writing).toBeDefined();
    expect(writing).not.toHaveProperty('title');
  });

  it('reads a leading level-1 heading as the file title without loading the whole file', async () => {
    await mkdir(join(directory, 'topics'));
    await writeFile(
      join(directory, 'MEMORY.md'),
      '\uFEFF\n\n# Personal preferences ##  \n\n- Memory\n',
    );
    await writeFile(
      join(directory, 'topics', 'plain.md'),
      'Intro paragraph\n\n# Not first\n',
    );
    await writeFile(
      join(directory, 'topics', 'deep.md'),
      '## Second level\n\n- Memory\n',
    );
    await writeFile(
      join(directory, 'topics', 'long.md'),
      `# Long\n${'x'.repeat(16 * 1024)}\n`,
    );
    const files = await listLocalMemoryFiles(directory);
    const byKey = new Map(files.map((file) => [file.fileKey, file]));
    expect(byKey.get('MEMORY.md')?.title).toBe('Personal preferences');
    expect(byKey.get('topics/plain.md')).not.toHaveProperty('title');
    expect(byKey.get('topics/deep.md')).not.toHaveProperty('title');
    expect(byKey.get('topics/long.md')?.title).toBe('Long');
  });

  it('strips closing hashes only when they follow whitespace', async () => {
    await mkdir(join(directory, 'topics'));
    await writeFile(join(directory, 'topics', 'closed.md'), '# Title #\n');
    await writeFile(join(directory, 'topics', 'glued.md'), '# Title#\n');
    await writeFile(join(directory, 'topics', 'hashes.md'), '#  # \n');
    await writeFile(join(directory, 'topics', 'tab.md'), '#\tTabbed\t##\n');
    await writeFile(join(directory, 'topics', 'nospace.md'), '#Title\n');
    await writeFile(
      join(directory, 'topics', 'indented.md'),
      '   # Indented\n',
    );
    await writeFile(join(directory, 'topics', 'code.md'), '    # Code\n');
    const files = await listLocalMemoryFiles(directory);
    const byKey = new Map(files.map((file) => [file.fileKey, file]));
    expect(byKey.get('topics/closed.md')?.title).toBe('Title');
    expect(byKey.get('topics/glued.md')?.title).toBe('Title#');
    expect(byKey.get('topics/hashes.md')).not.toHaveProperty('title');
    expect(byKey.get('topics/tab.md')?.title).toBe('Tabbed');
    expect(byKey.get('topics/nospace.md')).not.toHaveProperty('title');
    expect(byKey.get('topics/indented.md')?.title).toBe('Indented');
    expect(byKey.get('topics/code.md')).not.toHaveProperty('title');
  });

  it.each([
    ['# Title ##\u00a0', 'Title ##'],
    ['# Title ##\u2003', 'Title ##'],
    ['# \u00a0#', '#'],
  ])(
    'preserves content hashes beside Unicode whitespace in %s',
    async (heading, title) => {
      const content = `${heading}\n\nChild memory.\n`;
      await writeFile(join(directory, 'MEMORY.md'), content);
      expect((await listLocalMemoryFiles(directory))[0]?.title).toBe(title);
      const loaded = await readLocalMemoryDocument(directory, 'MEMORY.md');
      expect(loaded.items[0]?.text).toBe(heading);
      expect(loaded.items[0]?.children[0]?.text).toBe('Child memory.');
      const updatedHeading = '# Updated ##\u00a0';
      await mutateLocalMemoryItem(directory, {
        fileKey: 'MEMORY.md',
        revision: loaded.revision,
        itemId: loaded.items[0].id,
        text: updatedHeading,
      });
      expect((await listLocalMemoryFiles(directory))[0]?.title).toBe(
        'Updated ##',
      );
      expect(await readFile(join(directory, 'MEMORY.md'), 'utf8')).toBe(
        `${updatedHeading}\n\nChild memory.\n`,
      );
    },
  );

  it('titles heading lines of long whitespace runs', async () => {
    await mkdir(join(directory, 'topics'));
    await mkdir(join(directory, 'inbox'));
    const spaces = ' '.repeat(4_000);
    await writeFile(join(directory, 'MEMORY.md'), `#${spaces}x${spaces}\n`);
    await writeFile(join(directory, 'topics', 'blank.md'), `# ${spaces}\n`);
    // Fits inside the 4 KiB probe so the `y` is reachable.
    const shorter = ' '.repeat(1_000);
    await writeFile(
      join(directory, 'inbox', 'note.md'),
      `- ${shorter}## ${shorter}y${shorter}\n`,
    );
    await writeFile(join(directory, 'inbox', 'bare.md'), `- ${spaces}##\n`);
    const files = await listLocalMemoryFiles(directory);
    const byKey = new Map(files.map((file) => [file.fileKey, file]));
    expect(byKey.get('MEMORY.md')?.title).toBe('x');
    expect(byKey.get('topics/blank.md')).not.toHaveProperty('title');
    expect(byKey.get('inbox/note.md')?.title).toBe('y');
    expect(byKey.get('inbox/bare.md')).not.toHaveProperty('title');
  });

  // The probe reads up to 4 KiB of arbitrary whitespace for every listed
  // file on the main process, so its scan must stay linear. These checks
  // count work instead of timing `listLocalMemoryFiles`, which load on a
  // shared runner made flaky.
  const runs = (n: number): string => ' '.repeat(n);
  const probeCases: [string, (n: number) => string, boolean, string?][] = [
    ['an index heading', (n): string => `#${runs(n)}x${runs(n)}`, false, 'x'],
    ['a blank heading', (n): string => `# ${runs(n)}`, false],
    [
      'an inbox heading',
      (n): string => `- ${runs(n)}## ${runs(n)}y${runs(n)}`,
      true,
      'y',
    ],
    ['a bare inbox marker', (n): string => `- ${runs(n)}##`, true],
  ];
  // Patterns that cannot backtrack, run once over the whole probe head: the
  // byte order mark strip and the line split.
  const linearProbePatterns = new Set([/^\uFEFF/.source, /\r?\n/.source]);

  describe.each(probeCases)(
    'probing %s of long whitespace runs',
    (_name, line, inbox, title) => {
      const probe = (head: string): string | undefined =>
        titleFromProbeHead(head, { inbox });
      // Three runs of 1_200 characters stay inside the 4 KiB probe.
      const make = (n: number): string => `${line(n)}\n\nBody.\n`;

      it('finds the title', () => {
        expect(probe(make(1_200))).toBe(title);
      });

      it('grows its built-in scanning linearly with the whitespace', () => {
        // Linear scanning roughly doubles its work; re-scanning quadruples it.
        expect(workGrowth(make, probe, 600)).toBeLessThan(2.5);
      });

      it('runs no regex that could backtrack over a line', () => {
        // The work meter cannot see time spent inside the regex engine, and
        // a backtracking pattern turns a long whitespace run quadratic.
        const { sources } = regexSourcesRun(() => probe(make(1_200)));
        expect(
          Array.from(sources).filter(
            (source) => !linearProbePatterns.has(source),
          ),
        ).toEqual([]);
      });
    },
  );

  it('skips front matter before the title probe and names inbox notes by their first line', async () => {
    await mkdir(join(directory, 'topics'));
    await mkdir(join(directory, 'inbox'));
    await writeFile(
      join(directory, 'MEMORY.md'),
      '\uFEFF---\r\ncreated: today\r\n---\r\n\r\n# Personal preferences\r\n\r\n- Memory\r\n',
    );
    await writeFile(
      join(directory, 'inbox', 'seat.md'),
      '---\nsource:\n  provider: "claude"\ntype: inbox\n---\n\n- Prefer a window seat on long flights.\n',
    );
    await writeFile(
      join(directory, 'inbox', 'numbered.md'),
      '1. ## Numbered heading note\n',
    );
    await writeFile(
      join(directory, 'inbox', 'long.md'),
      `---\ntype: inbox\n---\n* ${'word '.repeat(30).trim()}\n`,
    );
    await writeFile(
      join(directory, 'inbox', 'headed.md'),
      '---\ntype: inbox\n---\n# Window seat\n\nPrefer a window seat.\n',
    );
    await writeFile(
      join(directory, 'inbox', 'open.md'),
      '---\ntype: inbox\nunterminated front matter\n',
    );
    await writeFile(
      join(directory, 'topics', 'plain.md'),
      '---\ntype: topic\n---\n\n- Not a title for topics\n',
    );
    const files = await listLocalMemoryFiles(directory);
    const byKey = new Map(files.map((file) => [file.fileKey, file]));
    expect(byKey.get('MEMORY.md')?.title).toBe('Personal preferences');
    expect(byKey.get('inbox/seat.md')?.title).toBe(
      'Prefer a window seat on long flights.',
    );
    expect(byKey.get('inbox/numbered.md')?.title).toBe('Numbered heading note');
    const clipped = byKey.get('inbox/long.md')?.title;
    expect(clipped).toBe(`${'word '.repeat(30).slice(0, 80).trimEnd()}…`);
    expect(Array.from(clipped ?? '')).toHaveLength(80);
    expect(byKey.get('inbox/headed.md')?.title).toBe('Window seat');
    expect(byKey.get('inbox/open.md')).not.toHaveProperty('title');
    expect(byKey.get('topics/plain.md')).not.toHaveProperty('title');
  });

  it.each(['EPERM', 'EIO'])(
    'reports a per-file %s failure instead of hiding the memory file',
    async (code) => {
      await writeFile(join(directory, 'MEMORY.md'), '# Index');
      const fsPromises =
        jest.requireActual<typeof FsPromises>('node:fs/promises');
      const failure = Object.assign(new Error('Cannot inspect memory file'), {
        code,
      });
      const inspect = jest
        .spyOn(fsPromises, 'lstat')
        .mockRejectedValueOnce(failure);
      try {
        await expect(listLocalMemoryFiles(directory)).rejects.toBe(failure);
      } finally {
        inspect.mockRestore();
      }
    },
  );

  it('omits empty frontmatter while preserving the original item offsets', () => {
    const prefix = '---\r\n---\r\n\r\n';
    const document = parseMemoryDocument('MEMORY.md', prefix + '- Memory\r\n');
    expect(document.items).toHaveLength(1);
    expect(document.items[0]).toMatchObject({
      id: `${prefix.length}:${prefix.length + '- Memory'.length}`,
      kind: 'list-item',
      text: '- Memory',
    });
  });

  it.each(['***', '---', '___', '* * *', '- - -', '_ _ _'])(
    'keeps the %s separator and following paragraph when editing or deleting a list memory',
    async (separator) => {
      const original = `# Preferences\n\n- Remove me\n${separator}\nKeep this paragraph.\n`;
      for (const text of [undefined, '- Edited memory']) {
        await writeFile(join(directory, 'MEMORY.md'), original);
        const document = await readLocalMemoryDocument(directory, 'MEMORY.md');
        const item = document.items[0].children[0];
        expect(item.text).toBe('- Remove me');
        expect(document.items[0].children[1]).toMatchObject({
          kind: 'block',
          text: separator,
        });
        await mutateLocalMemoryItem(directory, {
          fileKey: document.fileKey,
          revision: document.revision,
          itemId: item.id,
          ...(text === undefined ? {} : { text }),
        });
        expect(await readFile(join(directory, 'MEMORY.md'), 'utf8')).toBe(
          original.replace('- Remove me', text ?? ''),
        );
      }
    },
  );

  it.each([
    '> Keep this quote.\n',
    '<div>Keep this HTML.</div>\n',
    '[keep]: https://example.com\n\nKeep [this][keep].\n',
  ])(
    'preserves an adjacent block after a deleted list item: %s',
    async (suffix) => {
      const original = `- Remove me\n${suffix.startsWith('[') ? '\n' : ''}${suffix}`;
      await writeFile(join(directory, 'MEMORY.md'), original);
      const document = await readLocalMemoryDocument(directory, 'MEMORY.md');
      expect(document.items[0].text).toBe('- Remove me');
      await mutateLocalMemoryItem(directory, {
        fileKey: document.fileKey,
        revision: document.revision,
        itemId: document.items[0].id,
      });
      expect(await readFile(join(directory, 'MEMORY.md'), 'utf8')).toBe(
        original.replace('- Remove me', ''),
      );
    },
  );

  it.each(
    [
      ['BOM', '\uFEFF'],
      ['BOM before metadata', '\uFEFF---\ncreated: today\n---\n'],
      ['BOM after metadata', '---\ncreated: today\n---\n\uFEFF'],
      [
        'BOM before and after metadata',
        '\uFEFF---\ncreated: today\n---\n\uFEFF',
      ],
    ].flatMap(([name, prefix]) =>
      ['\n', '\r\n'].flatMap((newline) =>
        ['', newline].map((ending) => ({
          name,
          prefix: prefix.replace(/\n/g, newline),
          newline,
          ending,
        })),
      ),
    ),
  )(
    'preserves BOM and metadata through heading edit and note delete: $name $newline $ending',
    async ({ prefix, newline, ending }) => {
      const content =
        prefix +
        ['# Heading 🐢', '', '- First memory', '- Keep memory'].join(newline) +
        ending;
      await writeFile(join(directory, 'MEMORY.md'), content);
      const doc = await readLocalMemoryDocument(directory, 'MEMORY.md');
      expect(doc.items.map((item) => item.text)).toEqual(['# Heading 🐢']);
      expect(doc.items[0].children.map((item) => item.text)).toEqual([
        '- First memory',
        '- Keep memory',
      ]);
      expect(doc.items[0].id).toBe(
        `${prefix.length}:${prefix.length + '# Heading 🐢'.length}`,
      );
      const edited = await mutateLocalMemoryItem(directory, {
        fileKey: doc.fileKey,
        revision: doc.revision,
        itemId: doc.items[0].id,
        text: '# Updated heading',
      });
      expect(await readFile(join(directory, 'MEMORY.md'), 'utf8')).toBe(
        content.replace('# Heading 🐢', '# Updated heading'),
      );
      await mutateLocalMemoryItem(directory, {
        fileKey: edited.fileKey,
        revision: edited.revision,
        itemId: edited.items[0].children[0].id,
      });
      expect(await readFile(join(directory, 'MEMORY.md'), 'utf8')).toBe(
        content
          .replace('# Heading 🐢', '# Updated heading')
          .replace('- First memory', ''),
      );
    },
  );

  it.each([
    '\uFEFF',
    '\uFEFF\n',
    '\uFEFF\r\n',
    '\uFEFF---\ncreated: today\n---\n',
  ])(
    'keeps a BOM-only or metadata-only file outside editable ranges: %s',
    (content) => {
      expect(parseMemoryDocument('MEMORY.md', content).items).toEqual([]);
    },
  );

  it.each(
    [
      {
        name: 'consecutive BOMs',
        prefix: '\uFEFF',
        blocks: ['\uFEFFFirst memory'],
      },
      {
        name: 'consecutive body BOMs',
        prefix: '---\ncreated: today\n---\n\uFEFF',
        blocks: ['\uFEFFFirst memory'],
      },
      {
        name: 'interior BOM',
        prefix: '',
        blocks: ['First\uFEFFmemory', '- Keep memory'],
      },
      {
        name: 'Unicode headings',
        prefix: '',
        blocks: ['# Préférences 🐢', '## Detail', 'Keep café 🐢'],
      },
      {
        name: 'tabbed code',
        prefix: '',
        blocks: ['\tconst x = 1;\n\tconst y = 2;  ', '- Keep memory'],
      },
      {
        name: 'fenced code',
        prefix: '',
        blocks: ['```md\n# Literal heading\n***\n```', '- Keep memory'],
      },
      {
        name: 'unclosed fence',
        prefix: '',
        blocks: ['~~~md\n# Literal heading\n***'],
      },
      {
        name: 'lazy quote',
        prefix: '',
        blocks: ['> Quoted\nlazy continuation', '- Keep memory'],
      },
      {
        name: 'list and thematic break',
        prefix: '',
        blocks: ['- First memory', '***', 'Keep paragraph'],
      },
      {
        name: 'GFM table and task',
        prefix: '',
        blocks: ['| A | B |\n| - | - |\n| x | y |', '- [x] Done'],
      },
      {
        name: 'references',
        prefix: '',
        blocks: ['[link]: https://example.com', 'Use [link].'],
      },
      {
        name: 'HTML',
        prefix: '',
        blocks: ['<div>\nKeep HTML\n</div>', 'After HTML'],
      },
      {
        name: 'setext heading',
        prefix: '',
        blocks: ['Heading\n=======', 'Paragraph  \nwith hard break  '],
      },
    ].flatMap((fixture) =>
      ['\n', '\r\n'].map((newline) => ({ ...fixture, newline })),
    ),
  )(
    'roundtrips exact source slices without editing syntax: $name $newline',
    async ({ prefix, blocks, newline }) => {
      const content = (prefix + blocks.join('\n\n')).replace(/\n/g, newline);
      const expected = blocks.map((block) => block.replace(/\n/g, newline));
      await writeFile(join(directory, 'MEMORY.md'), content);
      const doc = await readLocalMemoryDocument(directory, 'MEMORY.md');
      const flatten = (
        items: LocalMemoryDocument['items'],
      ): LocalMemoryDocument['items'] =>
        items.flatMap((item) => [item, ...flatten(item.children)]);
      const items = flatten(doc.items);
      expect(items.map((item) => item.text)).toEqual(expected);
      for (const item of items) {
        const [start, end] = item.id.split(':').map(Number);
        expect(content.slice(start, end)).toBe(item.text);
        const saved = await mutateLocalMemoryItem(directory, {
          fileKey: doc.fileKey,
          revision: doc.revision,
          itemId: item.id,
          text: item.text,
        });
        expect(saved).toEqual(doc);
        expect(await readFile(join(directory, 'MEMORY.md'), 'utf8')).toBe(
          content,
        );
      }
    },
  );

  it('keeps nested headings, lazy continuations, tabbed code and original Unicode CRLF source ranges', async () => {
    const prefix = '---\r\ncreated: today\r\n---\r\n# Préférences 🐢\r\n\r\n';
    const item =
      '- First memory\r\nlazy continuation\r\n\r\n  ## Nested heading\r\n\r\n\t```md\r\n\t***\r\n\t```\r\n\r\n  - Nested memory';
    const suffix = '\r\n- Keep sibling\r\n\r\n> Keep quote\r\n';
    const original = prefix + item + suffix;
    await writeFile(join(directory, 'MEMORY.md'), original);
    const document = await readLocalMemoryDocument(directory, 'MEMORY.md');
    const parsed = document.items[0].children[0];
    expect(parsed.text).toBe(item);
    expect(parsed.id).toBe(`${prefix.length}:${prefix.length + item.length}`);
    await mutateLocalMemoryItem(directory, {
      fileKey: document.fileKey,
      revision: document.revision,
      itemId: parsed.id,
    });
    expect(await readFile(join(directory, 'MEMORY.md'), 'utf8')).toBe(
      prefix + suffix,
    );
  });

  it('keeps reference definitions distinct even when a following paragraph repeats their text', async () => {
    const original =
      '[reference]: https://example.com/same\n\nsame\n\n- Keep this memory\n';
    await writeFile(join(directory, 'MEMORY.md'), original);
    const document = await readLocalMemoryDocument(directory, 'MEMORY.md');
    expect(document.items.map((item) => item.text)).toEqual([
      '[reference]: https://example.com/same',
      'same',
      '- Keep this memory',
    ]);
    await mutateLocalMemoryItem(directory, {
      fileKey: document.fileKey,
      revision: document.revision,
      itemId: document.items[1].id,
      text: 'Changed paragraph',
    });
    expect(await readFile(join(directory, 'MEMORY.md'), 'utf8')).toBe(
      original.replace('\n\nsame\n', '\n\nChanged paragraph\n'),
    );
  });

  it.each([
    ['spaces LF', '    const x = 1;\n    const y = 2;  ', '\n'],
    ['tabs LF', '\tconst x = 1;\n\tconst y = 2;  ', '\n'],
    ['hard breaks LF', 'First line  \nSecond line  ', '\n'],
    ['spaces CRLF', '    const x = 1;\n    const y = 2;  ', '\r\n'],
    ['tabs CRLF', '\tconst x = 1;\n\tconst y = 2;  ', '\r\n'],
    ['hard breaks CRLF', 'First line  \nSecond line  ', '\r\n'],
  ])(
    'preserves Markdown syntax whitespace on save: %s',
    async (_name, text, newline) => {
      const content = `${text}\n\n- Keep this memory\n`.replace(/\n/g, newline);
      await writeFile(join(directory, 'MEMORY.md'), content);
      const doc = await readLocalMemoryDocument(directory, 'MEMORY.md');
      const result = await mutateLocalMemoryItem(directory, {
        fileKey: doc.fileKey,
        revision: doc.revision,
        itemId: doc.items[0].id,
        text: doc.items[0].text.replace(/\r\n/g, '\n'),
      });
      expect(await readFile(join(directory, 'MEMORY.md'), 'utf8')).toBe(
        content,
      );
      expect(result).toEqual(doc);
    },
  );

  it('edits one entry without changing metadata, siblings, whitespace or CRLF line endings', async () => {
    const content =
      '---\r\ncreated: today\r\n---\r\n\r\n# Writing\r\n\r\n- First memory\r\n- Keep this memory\r\n\r\n';
    await writeFile(join(directory, 'MEMORY.md'), content);
    const doc = await readLocalMemoryDocument(directory, 'MEMORY.md');
    const result = await mutateLocalMemoryItem(directory, {
      fileKey: doc.fileKey,
      revision: doc.revision,
      itemId: doc.items[0].children[0].id,
      text: '- Edited memory\n  With detail',
    });
    expect(await readFile(join(directory, 'MEMORY.md'), 'utf8')).toBe(
      content.replace('- First memory', '- Edited memory\r\n  With detail'),
    );
    expect(result.revision).not.toBe(doc.revision);
    await expect(
      mutateLocalMemoryItem(directory, {
        fileKey: doc.fileKey,
        revision: doc.revision,
        itemId: doc.items[0].children[1].id,
      }),
    ).rejects.toThrow('Memory changed');
  });

  it('deletes a single entry and leaves unrelated content intact', async () => {
    const content = '# Writing\n- Delete me\n- Keep me\n';
    await writeFile(join(directory, 'MEMORY.md'), content);
    const doc = await readLocalMemoryDocument(directory, 'MEMORY.md');
    const next = await mutateLocalMemoryItem(directory, {
      fileKey: doc.fileKey,
      revision: doc.revision,
      itemId: doc.items[0].children[0].id,
    });
    expect(await readFile(join(directory, 'MEMORY.md'), 'utf8')).toBe(
      '# Writing\n\n- Keep me\n',
    );
    await mutateLocalMemoryItem(directory, {
      fileKey: next.fileKey,
      revision: next.revision,
      itemId: next.items[0].id,
    });
    expect(await readFile(join(directory, 'MEMORY.md'), 'utf8')).toBe(
      '\n\n- Keep me\n',
    );
  });

  it('rejects path traversal, symlinks and oversized files', async () => {
    await mkdir(join(directory, 'topics'));
    await writeFile(join(directory, 'MEMORY.md'), '# Index');
    for (const fileKey of [
      '../MEMORY.md',
      'topics/../../MEMORY.md',
      'topics/nested/a.md',
      '/tmp/memory.md',
    ]) {
      await expect(readLocalMemoryDocument(directory, fileKey)).rejects.toThrow(
        'Invalid memory file',
      );
    }
    await symlink(
      join(directory, 'MEMORY.md'),
      join(directory, 'topics', 'link.md'),
    );
    await expect(
      readLocalMemoryDocument(directory, 'topics/link.md'),
    ).rejects.toThrow('Memory links');
    await writeFile(
      join(directory, 'topics', 'large.md'),
      'x'.repeat(512 * 1024 + 1),
    );
    await expect(
      readLocalMemoryDocument(directory, 'topics/large.md'),
    ).rejects.toThrow('too large');
    expect(
      (await listLocalMemoryFiles(directory)).map((file) => file.fileKey),
    ).not.toContain('topics/link.md');
  });

  it('serializes simultaneous edits and rejects the stale writer', async () => {
    await writeFile(join(directory, 'MEMORY.md'), '- Original\n');
    const doc = await readLocalMemoryDocument(directory, 'MEMORY.md');
    const request = {
      fileKey: doc.fileKey,
      revision: doc.revision,
      itemId: doc.items[0].id,
    };
    const results = await Promise.allSettled([
      mutateLocalMemoryItem(directory, { ...request, text: '- First edit' }),
      mutateLocalMemoryItem(directory, { ...request, text: '- Second edit' }),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(await readFile(join(directory, 'MEMORY.md'), 'utf8')).toBe(
      '- First edit\n',
    );
  });

  it('redacts edited secrets using the existing memory rules', async () => {
    await writeFile(join(directory, 'MEMORY.md'), 'Original\n');
    const doc = await readLocalMemoryDocument(directory, 'MEMORY.md');
    await mutateLocalMemoryItem(directory, {
      fileKey: doc.fileKey,
      revision: doc.revision,
      itemId: doc.items[0].id,
      text: 'api_key=private-credential-value',
    });
    expect(await readFile(join(directory, 'MEMORY.md'), 'utf8')).not.toContain(
      'private-credential-value',
    );
  });
});

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
