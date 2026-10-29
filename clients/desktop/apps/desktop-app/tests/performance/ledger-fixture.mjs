import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/*
 * The Agent Ledger's performance fixture (phase 15). One code worktree's
 * Ledger holds the measured scope's entries; Cowork Work Entries hold the
 * rest, so every scope belongs to a real container and the Ledger's startup
 * pass keeps it. Entries go through the Ledger store itself, so they carry
 * the store's own identities, search index and history.
 */

/** The Cowork workspace whose Work Entries hold the other scopes. */
export const LEDGER_FIXTURE_COWORK_ID = 'perf-ledger-cowork';

const FIXTURE_START_MS = Date.parse('2026-06-01T09:00:00.000Z');
const ENTRY_TYPES = ['TASK', 'DECISION', 'OBSERVATION', 'ACTION'];
const TOPICS = ['parser', 'cache', 'release', 'migration', 'sync'];

/**
 * Searches the scenario runs: a common word, a rarer one, and two words
 * that match one entry.
 */
export function ledgerFixtureSearches(scopeEntries) {
  const one = Math.max(1, Math.floor(scopeEntries / 2));
  return [
    { query: 'release', label: 'common' },
    { query: 'migration cache', label: 'two-words' },
    { query: `case ${String(one)}`, label: 'one-entry' },
  ];
}

/**
 * Numbers whose `case N` search matches one entry of a scope of
 * `scopeEntries`: no other entry's number starts with them.
 */
export function ledgerUniqueCaseNumbers(scopeEntries) {
  return [3, 7, 11].map((offset) => scopeEntries - offset);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** The worktree's recorded creation time: the Ledger's container identity. */
function worktreeCreatedAt(userDataDir, workspaceId, worktreeId) {
  const file = readJson(
    path.join(userDataDir, 'workspaces', workspaceId, 'worktrees.json'),
  );
  const worktree = file.worktrees.find(
    (candidate) => candidate.id === worktreeId,
  );
  if (typeof worktree?.createdAt !== 'string') {
    throw new Error(`Ledger fixture: ${worktreeId} has no creation time`);
  }
  return worktree.createdAt;
}

/** A Cowork workspace beside the code workspace, with one Work Entry each. */
function seedFixtureCowork(userDataDir, entryCount) {
  const workspacesRoot = path.join(userDataDir, 'workspaces');
  const indexPath = path.join(workspacesRoot, 'index.json');
  const index = readJson(indexPath);
  index.workspaces = [
    ...index.workspaces.filter(
      (workspace) => workspace.id !== LEDGER_FIXTURE_COWORK_ID,
    ),
    {
      id: LEDGER_FIXTURE_COWORK_ID,
      name: 'Ledger fixture',
      type: 'cowork',
      color: '#7C9B6D',
      collapsed: true,
      order: index.workspaces.length,
    },
  ];
  writeJson(indexPath, index);
  const workspaceDir = path.join(workspacesRoot, LEDGER_FIXTURE_COWORK_ID);
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    repos: [],
    cowork: {
      createdAt: '2026-05-01T12:00:00.000Z',
      defaultModel: 'gpt-5.4-mini',
      searchIndexingEnabled: true,
      archiveRetentionDays: null,
    },
  });
  const entries = Array.from({ length: entryCount }, (_, index) => ({
    id: `perf-ledger-entry-${String(index + 1).padStart(3, '0')}`,
    title: `Ledger fixture ${String(index + 1)}`,
    createdAt: new Date(
      Date.parse('2026-05-02T12:00:00.000Z') + index * 60_000,
    ).toISOString(),
  }));
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries,
  });
  return entries;
}

/*
 * The perf harness runs under tsx, so the store's TypeScript loads as is.
 * It is loaded only here, never at import, so plain `node --test` suites can
 * still import the harness.
 */
export async function loadLedgerRepository() {
  const loaded =
    await import('../../../../packages/desktop-shared/src/node/ledger/repository.ts');
  return (loaded.default ?? loaded).LedgerRepository;
}

const USER_DETAILS = Object.freeze({
  harness: null,
  model: null,
  thinkingEffort: null,
  mode: null,
  pipelineExecutionId: null,
  settingsRevision: null,
  unavailableReason: 'not_applicable',
});

/** Adds `count` entries to one scope, as the person, a minute apart. */
function seedScopeEntries(repository, clock, scope, count, label) {
  const ledgerId = repository.bindScope({
    authorityId: repository.authorityId,
    container: scope.container,
    containerCreatedAt: scope.containerCreatedAt,
    accountId: scope.accountId,
  }).scope.scope.ledgerId;
  const user = repository.registerActor({
    ledgerId,
    kind: 'user',
    authorityId: repository.authorityId,
    originKey: 'user:local',
    displayName: 'You',
  }).actor.actor;
  for (let index = 1; index <= count; index += 1) {
    clock.advance();
    const topic = TOPICS[index % TOPICS.length];
    const other = TOPICS[(index + 2) % TOPICS.length];
    repository.addEntry({
      ledgerId,
      author: user,
      authorDetails: USER_DETAILS,
      origin: { kind: 'user', ledgerId, userActorId: user.actorId },
      attribution: {
        kind: 'user',
        effectiveActor: user,
        recordedBy: user,
        executorDetails: USER_DETAILS,
      },
      owner: user,
      params: {
        type: ENTRY_TYPES[index % ENTRY_TYPES.length],
        title: `Check ${topic} case ${String(index)}`,
        content: `${label} entry ${String(index)}: the ${topic} and ${other} work, recorded for the Ledger performance fixture.`,
      },
      idempotencyKey: `perf-${label}-${String(index)}`,
    });
  }
  return ledgerId;
}

/**
 * Seeds the Ledger database and the Cowork Work Entries its other scopes
 * belong to. Every scope is bound to `accountId`, the account it was first
 * used under: none (signed out) by default. Returns what the scenario reports
 * as its workload.
 */
export async function seedLedgerFixture({
  userDataDir,
  workspaceId,
  worktreeId,
  scopeEntries,
  otherScopes,
  otherScopeEntries,
  accountId = null,
}) {
  const startedAt = performance.now();
  const workEntries = seedFixtureCowork(userDataDir, otherScopes);
  const LedgerRepository = await loadLedgerRepository();
  let now = FIXTURE_START_MS;
  const clock = {
    now: () => new Date(now),
    advance: () => {
      now += 60_000;
    },
  };
  const repository = LedgerRepository.open({
    databasePath: path.join(userDataDir, 'ledger', 'ledger.sqlite'),
    now: clock.now,
  });
  try {
    // Seeding is not what the scenario measures: it writes without waiting
    // for the disk, and closing the store checkpoints it before the app
    // opens it.
    repository.database.exec('PRAGMA synchronous = OFF');
    const ledgerId = seedScopeEntries(
      repository,
      clock,
      {
        container: { kind: 'code_worktree', workspaceId, worktreeId },
        containerCreatedAt: worktreeCreatedAt(
          userDataDir,
          workspaceId,
          worktreeId,
        ),
        accountId,
      },
      scopeEntries,
      'measured',
    );
    for (const entry of workEntries) {
      seedScopeEntries(
        repository,
        clock,
        {
          container: {
            kind: 'cowork_entry',
            workspaceId: LEDGER_FIXTURE_COWORK_ID,
            entryId: entry.id,
          },
          containerCreatedAt: entry.createdAt,
          accountId,
        },
        otherScopeEntries,
        entry.id,
      );
    }
    return {
      ledgerId,
      scopeEntries,
      otherScopes,
      totalScopes: otherScopes + 1,
      totalEntries: scopeEntries + otherScopes * otherScopeEntries,
      seedMs: Math.round(performance.now() - startedAt),
    };
  } finally {
    repository.close();
  }
}
