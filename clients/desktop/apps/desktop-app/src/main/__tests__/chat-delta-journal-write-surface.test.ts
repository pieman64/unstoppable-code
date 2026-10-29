/**
 * Architecture guard: only the chat state backend and repository write the
 * delta journal for canonical writable scopes.
 *
 * Phase 08 shipped the engine inert, with no production importer. Phase 09
 * wires it into exactly two modules: the backend commits, checkpoints,
 * promotes and demotes a scope it holds the lease for, and the repository
 * promotes writable scopes on load. Every other writer of chat storage
 * (direct backends for archives and history, capture, the CLI) must fail
 * closed on a version 3 scope rather than write version 2 files into it.
 *
 * This scans every non-test source file of the desktop app, the CLI and the
 * workspace packages and fails if any other module imports the writer or
 * refers to the identifiers that publish a version 3 manifest. The reader,
 * replay and format modules remain importable by anyone.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const REPO = join(__dirname, '..', '..', '..', '..', '..');
const ROOTS = ['apps/desktop-app/src', 'packages'];
const JOURNAL = 'apps/desktop-app/src/main/lib/chat-delta-journal';
const WRITER = `${JOURNAL}/writer.ts`;
const FORMAT = `${JOURNAL}/format.ts`;

/** The only production modules allowed to drive the writer. */
const ALLOWED = new Set([
  'apps/desktop-app/src/main/services/chat-state-v2-backend.ts',
  'apps/desktop-app/src/main/services/chat-state-v2-repository.ts',
]);

/** Identifiers that write the journal or publish its manifest. */
const WRITE_SURFACE = [
  /chat-delta-journal\/writer['"]/,
  /\bChatDeltaJournalWriter\b/,
  /\bpromoteToDeltaJournal\b/,
  /\bdemoteFromDeltaJournal\b/,
  /\bDELTA_JOURNAL_MANIFEST_VERSION\b/,
  /\bDELTA_JOURNAL_FORMAT\b/,
  /['"]chat-delta-journal-v1['"]/,
];

function sources(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    if (
      name === 'node_modules' ||
      name === '__tests__' ||
      name === 'dist' ||
      name === 'resources'
    )
      continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...sources(path));
    else if (/\.(?:ts|tsx|mts|cts)$/.test(name) && !/\.test\.tsx?$/.test(name))
      found.push(path);
  }
  return found;
}

function violations(path: string, text: string): string[] {
  if (path === WRITER || ALLOWED.has(path)) return [];
  return WRITE_SURFACE.filter((pattern) => {
    if (path === FORMAT && pattern.source.includes('DELTA_JOURNAL'))
      return false;
    if (path === FORMAT && pattern.source.includes('chat-delta-journal-v1'))
      return false;
    return pattern.test(text);
  }).map((pattern) => `${path} matches ${pattern.source}`);
}

describe('delta journal write surface', () => {
  it('is reached only through the chat state backend and repository', () => {
    const found: string[] = [];
    let scanned = 0;
    for (const root of ROOTS)
      for (const file of sources(join(REPO, root))) {
        scanned += 1;
        const path = relative(REPO, file).split(sep).join('/');
        found.push(...violations(path, readFileSync(file, 'utf8')));
      }
    expect(scanned).toBeGreaterThan(1000);
    expect(found).toEqual([]);
  });

  it('flags any other production module that would write the journal', () => {
    expect(
      violations(
        'apps/desktop-app/src/main/lib/archived-containers.ts',
        "import { ChatDeltaJournalWriter } from './chat-delta-journal/writer';",
      ),
    ).toHaveLength(2);
    expect(
      violations(
        'apps/desktop-app/src/main/lib/chat-storage-v2.ts',
        "await write({ version: 3, journal: 'chat-delta-journal-v1' });",
      ),
    ).toHaveLength(1);
    // Reading stays allowed: the loader recognizes version 3.
    expect(
      violations(
        'apps/desktop-app/src/main/lib/chat-storage-v2.ts',
        "import { readReplayedChatIndexes } from './chat-delta-journal/reader';",
      ),
    ).toEqual([]);
    expect(
      violations(
        'apps/desktop-app/src/main/services/chat-state-v2-backend.ts',
        "import { ChatDeltaJournalWriter } from '../lib/chat-delta-journal/writer';",
      ),
    ).toEqual([]);
  });

  it('keeps the reader path free of the writer', () => {
    for (const name of [
      'reader.ts',
      'replay.ts',
      'materialize.ts',
      'format.ts',
      'index-delta.ts',
      'transcript-overlay.ts',
    ])
      expect(readFileSync(join(REPO, JOURNAL, name), 'utf8')).not.toMatch(
        /from '\.\/writer'/,
      );
  });
});
