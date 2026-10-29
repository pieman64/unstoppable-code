import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  LEDGER_FIXTURE_COWORK_ID,
  ledgerFixtureSearches,
  ledgerUniqueCaseNumbers,
  loadLedgerRepository,
  seedLedgerFixture,
} from './ledger-fixture.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_CREATED_AT = '2026-07-01T12:00:00.000Z';

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

/** The demo workspace's index and worktree list, as `seedWorkspace` writes them. */
function seedMinimalWorkspace(userDataDir) {
  writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      { id: WORKSPACE_ID, name: 'Demo', type: 'single-repo', order: 0 },
    ],
  });
  writeJson(
    path.join(userDataDir, 'workspaces', WORKSPACE_ID, 'worktrees.json'),
    {
      version: 1,
      worktrees: [
        {
          id: WORKTREE_ID,
          branchName: 'demo-main',
          createdAt: WORKTREE_CREATED_AT,
        },
      ],
    },
  );
}

test('seeds every scope under a real container, through the Ledger store', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'ledger-fixture-'));
  try {
    seedMinimalWorkspace(userDataDir);
    const fixture = await seedLedgerFixture({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      scopeEntries: 120,
      otherScopes: 2,
      otherScopeEntries: 3,
    });
    assert.equal(fixture.totalScopes, 3);
    assert.equal(fixture.totalEntries, 126);

    // The Cowork workspace joins the index beside the code workspace.
    const index = JSON.parse(
      readFileSync(path.join(userDataDir, 'workspaces', 'index.json'), 'utf8'),
    );
    assert.deepEqual(
      index.workspaces.map((workspace) => workspace.id),
      [WORKSPACE_ID, LEDGER_FIXTURE_COWORK_ID],
    );
    const workEntries = JSON.parse(
      readFileSync(
        path.join(
          userDataDir,
          'workspaces',
          LEDGER_FIXTURE_COWORK_ID,
          'work-entries.json',
        ),
        'utf8',
      ),
    ).entries;

    const LedgerRepository = await loadLedgerRepository();
    const repository = LedgerRepository.open({
      databasePath: path.join(userDataDir, 'ledger', 'ledger.sqlite'),
    });
    try {
      // Each scope belongs to its container's recorded incarnation.
      const scopes = repository.listScopes();
      assert.equal(scopes.length, 3);
      const measured = repository.findContainerScopes({
        kind: 'code_worktree',
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
      });
      assert.equal(measured.length, 1);
      assert.equal(measured[0].containerCreatedAt, WORKTREE_CREATED_AT);
      for (const entry of workEntries) {
        const [scope] = repository.findContainerScopes({
          kind: 'cowork_entry',
          workspaceId: LEDGER_FIXTURE_COWORK_ID,
          entryId: entry.id,
        });
        assert.equal(scope?.containerCreatedAt, entry.createdAt);
      }

      // The searches the scenario types each find what they say.
      const ledgerId = fixture.ledgerId;
      for (const number of ledgerUniqueCaseNumbers(120)) {
        const found = repository.searchEntries({
          ledgerId,
          query: `case ${String(number)}`,
          limit: 30,
        });
        assert.equal(found.entries.length, 1, `case ${String(number)}`);
      }
      for (const search of ledgerFixtureSearches(120)) {
        const found = repository.searchEntries({
          ledgerId,
          query: search.query,
          limit: 30,
        });
        assert.ok(found.entries.length > 0, search.label);
      }
      const firstPage = repository.searchEntries({ ledgerId, limit: 30 });
      assert.equal(firstPage.entries.length, 30);
      assert.equal(firstPage.hasMore, true);
    } finally {
      repository.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('binds every scope to the account it is given, and to none by default', async () => {
  for (const accountId of [null, 'guest-account-e2e']) {
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'ledger-fixture-'));
    try {
      seedMinimalWorkspace(userDataDir);
      await seedLedgerFixture({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        scopeEntries: 2,
        otherScopes: 2,
        otherScopeEntries: 1,
        ...(accountId === null ? {} : { accountId }),
      });
      const LedgerRepository = await loadLedgerRepository();
      const repository = LedgerRepository.open({
        databasePath: path.join(userDataDir, 'ledger', 'ledger.sqlite'),
      });
      try {
        const scopes = repository.listScopes();
        assert.equal(scopes.length, 3);
        for (const scope of scopes) assert.equal(scope.accountId, accountId);
      } finally {
        repository.close();
      }
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  }
});
