import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let ledgerPath = '';

jest.mock('../../lib/paths', () => ({
  getExternalProjectImportsFilePath: (): string => ledgerPath,
}));

import {
  markExternalProjectInviteShown,
  markExternalProjectScan,
  normalizeExternalProjectImportLedger,
  readExternalProjectImportLedger,
  recordExternalProjectChatDestination,
  recordExternalProjectImport,
  recordExternalProjectSessionImports,
  removeExternalProjectImport,
  resetExternalProjectImportLedgerForTests,
} from '../ledger';

describe('external project import ledger', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'external-project-ledger-'));
    ledgerPath = join(root, 'nested', 'external-project-imports.json');
    resetExternalProjectImportLedgerForTests();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('starts empty when the file is missing or corrupt', async () => {
    expect(await readExternalProjectImportLedger()).toEqual({
      imports: {},
      lastScanAt: null,
      inviteShownAt: null,
    });
    expect(normalizeExternalProjectImportLedger('nope')).toEqual({
      imports: {},
      lastScanAt: null,
      inviteShownAt: null,
    });
    expect(
      normalizeExternalProjectImportLedger({
        version: 1,
        imports: { bad: { workspaceId: 1 }, ok: null },
        lastScanAt: 'not a date',
      }),
    ).toEqual({ imports: {}, lastScanAt: null, inviteShownAt: null });
  });

  it('records imports and sessions atomically with a versioned file', async () => {
    await recordExternalProjectImport({
      candidateId: 'ext-abc',
      workspaceId: 'my-project',
      rootPath: '/Users/me/my-project',
      providers: ['claude'],
      importedAt: '2026-09-10T00:00:00.000Z',
    });
    await recordExternalProjectSessionImports({
      candidateId: 'ext-abc',
      sessions: [
        { sessionId: 'session-1', chatId: 'chat-1', worktreeId: 'entry-1' },
      ],
      importedAt: '2026-09-10T00:01:00.000Z',
    });
    // A second import of the same root keeps the original timestamp and
    // unions providers rather than replacing the entry.
    await recordExternalProjectImport({
      candidateId: 'ext-abc',
      workspaceId: 'my-project',
      rootPath: '/Users/me/my-project',
      providers: ['codex'],
      importedAt: '2026-09-11T00:00:00.000Z',
    });

    const persisted: unknown = JSON.parse(await readFile(ledgerPath, 'utf8'));
    expect(persisted).toMatchObject({
      version: 1,
      imports: {
        'ext-abc': {
          workspaceId: 'my-project',
          providers: ['claude', 'codex'],
          importedAt: '2026-09-10T00:00:00.000Z',
          sessions: {
            'session-1': { chatId: 'chat-1', worktreeId: 'entry-1' },
          },
        },
      },
    });

    resetExternalProjectImportLedgerForTests();
    const reloaded = await readExternalProjectImportLedger();
    expect(reloaded.imports['ext-abc']?.sessions['session-1']?.chatId).toBe(
      'chat-1',
    );
  });

  it('records a batch of sessions in one write', async () => {
    await recordExternalProjectImport({
      candidateId: 'ext-batch',
      workspaceId: 'w',
      rootPath: '/r',
      providers: ['codex'],
    });
    await recordExternalProjectSessionImports({
      candidateId: 'ext-batch',
      sessions: [
        { sessionId: 'a', chatId: 'chat-a', worktreeId: 'entry' },
        { sessionId: 'b', chatId: 'chat-b', worktreeId: 'entry' },
      ],
      importedAt: '2026-09-10T00:02:00.000Z',
    });
    const ledger = await readExternalProjectImportLedger();
    expect(Object.keys(ledger.imports['ext-batch']?.sessions ?? {})).toEqual([
      'a',
      'b',
    ]);
    expect(ledger.imports['ext-batch']?.sessions.b?.importedAt).toBe(
      '2026-09-10T00:02:00.000Z',
    );
  });

  it('keeps the chat destination across re-records and reloads', async () => {
    await recordExternalProjectImport({
      candidateId: 'ext-dest',
      workspaceId: 'w',
      rootPath: '/r',
      providers: ['claude'],
    });
    await recordExternalProjectChatDestination({
      candidateId: 'ext-dest',
      worktreeId: 'entry-7',
    });
    await recordExternalProjectImport({
      candidateId: 'ext-dest',
      workspaceId: 'w',
      rootPath: '/r',
      providers: ['codex'],
    });
    resetExternalProjectImportLedgerForTests();
    const reloaded = await readExternalProjectImportLedger();
    expect(reloaded.imports['ext-dest']?.chatWorktreeId).toBe('entry-7');
    // Unknown candidates and blank ids are ignored rather than recorded.
    await recordExternalProjectChatDestination({
      candidateId: 'missing',
      worktreeId: 'x',
    });
    expect(
      normalizeExternalProjectImportLedger({
        version: 1,
        imports: {
          a: {
            workspaceId: 'w',
            rootPath: '/r',
            importedAt: '2026-09-10T00:00:00.000Z',
            chatWorktreeId: '',
          },
        },
      }).imports.a,
    ).not.toHaveProperty('chatWorktreeId');
  });

  it('removes a project entry on request', async () => {
    await recordExternalProjectImport({
      candidateId: 'ext-gone',
      workspaceId: 'w',
      rootPath: '/r',
      providers: ['claude'],
    });
    await removeExternalProjectImport('ext-gone');
    await removeExternalProjectImport('never-there');
    expect((await readExternalProjectImportLedger()).imports).toEqual({});
    // An entry that already records chats is never dropped.
    await recordExternalProjectImport({
      candidateId: 'ext-kept',
      workspaceId: 'w',
      rootPath: '/r',
      providers: ['claude'],
    });
    await recordExternalProjectSessionImports({
      candidateId: 'ext-kept',
      sessions: [{ sessionId: 's', chatId: 'c', worktreeId: 'e' }],
    });
    await removeExternalProjectImport('ext-kept');
    expect(
      (await readExternalProjectImportLedger()).imports['ext-kept'],
    ).toBeDefined();
  });

  it('ignores session records for unknown candidates', async () => {
    await recordExternalProjectSessionImports({
      candidateId: 'missing',
      sessions: [{ sessionId: 's', chatId: 'c', worktreeId: 'w' }],
    });
    expect((await readExternalProjectImportLedger()).imports).toEqual({});
  });

  it('stamps scans and the one-time invite', async () => {
    await markExternalProjectScan('2026-09-10T10:00:00.000Z');
    await markExternalProjectInviteShown('2026-09-10T11:00:00.000Z');
    expect(await readExternalProjectImportLedger()).toMatchObject({
      lastScanAt: '2026-09-10T10:00:00.000Z',
      inviteShownAt: '2026-09-10T11:00:00.000Z',
    });
  });

  it('survives a pre-existing unreadable file', async () => {
    await writeFile(join(root, 'garbage.json'), '{not json');
    ledgerPath = join(root, 'garbage.json');
    resetExternalProjectImportLedgerForTests();
    expect((await readExternalProjectImportLedger()).imports).toEqual({});
    await markExternalProjectScan('2026-09-10T10:00:00.000Z');
    const persisted: unknown = JSON.parse(await readFile(ledgerPath, 'utf8'));
    expect(persisted).toMatchObject({ version: 1 });
  });
});
