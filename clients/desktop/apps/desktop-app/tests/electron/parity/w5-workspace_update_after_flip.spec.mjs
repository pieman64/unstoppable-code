// W5 behavior baseline (CAN-3697), scenario `workspace_update_after_flip`:
// pins today's `projects:save` (rename, recolor, reorder) and delete effects
// on `workspace_index` and `workspace_manifest`, including the unconditioned
// last-writer-wins save the W5 revision check replaces. Titles start
// `<scenario>/<condition>:`. Record:
// docs/planning/2026-07-31-desktop-core-daemon/artifacts/behavior-baseline-w5.md
//
// Determinism: seeded projects over local repositories, no network, no live
// agents.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeCanopy } from '../launchCanopy.mjs';
import {
  DEFAULT_COWORK_WORKSPACE_ID,
  crashKeepingData,
  indexPath,
  initRepo,
  launchW5App,
  loadProjectIds,
  quitGracefullyKeepingData,
  readIndexEntry,
  readIndexIds,
  readManifest,
  reapCliChildren,
  runCli,
  seedSingleRepoProject,
  worktreeListPath,
} from './w5-fixtures.mjs';

let fixtures;
let userDataDir;
let repos;

test.beforeEach(() => {
  fixtures = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'canopy-w5-update-')),
  );
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-w5-update-data-'));
  repos = {
    alpha: initRepo(path.join(fixtures, 'alpha')),
    beta: initRepo(path.join(fixtures, 'beta')),
  };
  seedSingleRepoProject(userDataDir, {
    id: 'alpha',
    name: 'Alpha',
    repoPath: repos.alpha,
    order: 0,
  });
  seedSingleRepoProject(userDataDir, {
    id: 'beta',
    name: 'Beta',
    repoPath: repos.beta,
    order: 1,
  });
});

test.afterEach(() => {
  reapCliChildren();
  rmSync(fixtures, { recursive: true, force: true });
});

async function loadItems(window) {
  return window.evaluate(async () => (await window.api.loadProjects()).items);
}

function withItem(items, id, patch) {
  return items.map((item) => (item.id === id ? { ...item, ...patch } : item));
}

function save(window, items, options) {
  return window.evaluate(
    ({ items, options }) => window.api.saveProjects(items, options),
    { items, options },
  );
}

test('workspace_update_after_flip/normal: projects:save renames, recolors, and reorders index entries, backing up the prior index and keeping the manifest', async () => {
  test.setTimeout(90_000);
  const launched = await launchW5App({ userDataDir });
  const { window } = launched;
  try {
    const items = await loadItems(window);
    const priorIndex = readFileSync(indexPath(userDataDir), 'utf8');

    await save(
      window,
      withItem(items, 'alpha', { name: 'Alpha Renamed', color: '#EF4444' }),
    );

    expect(readIndexEntry(userDataDir, 'alpha')).toMatchObject({
      name: 'Alpha Renamed',
      color: '#EF4444',
    });
    expect(readFileSync(`${indexPath(userDataDir)}.bak`, 'utf8')).toBe(
      priorIndex,
    );
    expect(readManifest(userDataDir, 'alpha')).toMatchObject({
      type: 'single-repo',
      repoPath: repos.alpha,
    });

    const reversed = [...(await loadItems(window))].reverse();
    await save(
      window,
      reversed.map((item, order) => ({ ...item, order })),
      { replaceWorkspaceOrder: true },
    );

    expect(readIndexIds(userDataDir)).toEqual(reversed.map((item) => item.id));
    expect(await loadProjectIds(window)).toEqual(
      reversed.map((item) => item.id),
    );
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

/** The inode of each manifest and worktree list: a replace changes it. */
function workspaceFileIdentities() {
  return Object.fromEntries(
    ['alpha', 'beta'].flatMap((id) => [
      [
        `${id}/workspace.json`,
        statSync(path.join(userDataDir, 'workspaces', id, 'workspace.json'))
          .ino,
      ],
      [`${id}/worktrees.json`, statSync(worktreeListPath(userDataDir, id)).ino],
    ]),
  );
}

test('workspace_update_after_flip/normal: workspace:update-metadata and workspace:reorder rewrite only what they change, never every manifest and worktree list (CAN-3807)', async () => {
  test.setTimeout(90_000);
  const launched = await launchW5App({ userDataDir });
  const { window } = launched;
  try {
    await loadItems(window);
    const before = workspaceFileIdentities();

    await window.evaluate(
      (request) => window.api.updateWorkspaceMetadata(request),
      {
        workspaceId: 'alpha',
        name: 'Alpha Renamed',
        color: '#22C55E',
        pinned: true,
      },
    );
    await window.evaluate((request) => window.api.reorderWorkspaces(request), {
      activeWorkspaceId: 'beta',
      overWorkspaceId: 'alpha',
    });

    expect(workspaceFileIdentities()).toEqual(before);
    expect(readIndexEntry(userDataDir, 'alpha')).toMatchObject({
      name: 'Alpha Renamed',
      color: '#22C55E',
      pinned: true,
    });

    await window.evaluate(
      (request) => window.api.updateWorkspaceMetadata(request),
      { workspaceId: 'alpha', itemSortMode: 'last-updated' },
    );

    expect(readManifest(userDataDir, 'alpha')).toMatchObject({
      itemSortMode: 'last-updated',
      repoPath: repos.alpha,
    });
    const after = workspaceFileIdentities();
    expect(after['alpha/workspace.json']).not.toBe(
      before['alpha/workspace.json'],
    );
    expect({ ...after, 'alpha/workspace.json': 0 }).toEqual({
      ...before,
      'alpha/workspace.json': 0,
    });

    const items = await loadItems(window);
    expect(items.find((item) => item.id === 'alpha')).toMatchObject({
      name: 'Alpha Renamed',
      color: '#22C55E',
      pinned: true,
      itemSortMode: 'last-updated',
    });
    const ids = items.map((item) => item.id);
    expect(ids.indexOf('beta')).toBeLessThan(ids.indexOf('alpha'));
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('workspace_update_after_flip/normal: workspace:delete removes the index entry and the workspace directory but not the repository', async () => {
  test.setTimeout(90_000);
  const launched = await launchW5App({ userDataDir });
  const { window } = launched;
  try {
    await window.evaluate((request) => window.api.deleteWorkspace(request), {
      workspaceId: 'alpha',
    });

    expect(readIndexIds(userDataDir)).not.toContain('alpha');
    expect(existsSync(path.join(userDataDir, 'workspaces', 'alpha'))).toBe(
      false,
    );
    expect(existsSync(path.join(repos.alpha, '.git'))).toBe(true);
    expect(await loadProjectIds(window)).not.toContain('alpha');
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('workspace_update_after_flip/idempotent_retry: replaying a save rewrites the same entry, and replaying a delete or deleting an unknown id resolves without error', async () => {
  test.setTimeout(90_000);
  const launched = await launchW5App({ userDataDir });
  const { window } = launched;
  try {
    const renamed = withItem(await loadItems(window), 'alpha', {
      name: 'Alpha Renamed',
    });
    await save(window, renamed);
    const afterFirst = readFileSync(indexPath(userDataDir), 'utf8');
    await save(window, renamed);

    expect(readFileSync(indexPath(userDataDir), 'utf8')).toBe(afterFirst);

    const deletes = await window.evaluate(async () => {
      const results = [];
      for (const workspaceId of ['beta', 'beta', 'never-existed']) {
        try {
          await window.api.deleteWorkspace({ workspaceId });
          results.push('resolved');
        } catch (error) {
          results.push(error instanceof Error ? error.message : String(error));
        }
      }
      return results;
    });

    expect(deletes).toEqual(['resolved', 'resolved', 'resolved']);
    expect(readIndexIds(userDataDir)).not.toContain('beta');
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('workspace_update_after_flip/graceful_shutdown: an acknowledged rename and delete survive a graceful quit', async () => {
  test.setTimeout(120_000);
  let launched = await launchW5App({ userDataDir });
  try {
    const { window } = launched;
    await save(
      window,
      withItem(await loadItems(window), 'alpha', { name: 'Alpha Renamed' }),
    );
    await window.evaluate((request) => window.api.deleteWorkspace(request), {
      workspaceId: 'beta',
    });
    await quitGracefullyKeepingData(launched.electronApp, userDataDir);

    launched = await launchW5App({ userDataDir });

    const items = await loadItems(launched.window);
    expect(items.find((item) => item.id === 'alpha')?.name).toBe(
      'Alpha Renamed',
    );
    expect(items.map((item) => item.id)).not.toContain('beta');
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('workspace_update_after_flip/crash_restart: an acknowledged rename survives SIGKILL, and a CLI started while the app is down writes the index directly', async () => {
  test.setTimeout(150_000);
  let launched = await launchW5App({ userDataDir });
  try {
    const { window } = launched;
    await save(
      window,
      withItem(await loadItems(window), 'alpha', { name: 'Alpha Renamed' }),
    );
    await crashKeepingData(launched);

    const cli = await runCli(userDataDir, [
      'workspace',
      'create',
      'import',
      initRepo(path.join(fixtures, 'during-outage')),
    ]);
    expect(cli.code).toBe(0);

    launched = await launchW5App({ userDataDir });

    const items = await loadItems(launched.window);
    expect(items.find((item) => item.id === 'alpha')?.name).toBe(
      'Alpha Renamed',
    );
    expect(items.map((item) => item.id)).toContain('during-outage');
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('workspace_update_after_flip/concurrent_client: a save from a stale snapshot silently overwrites a newer rename (no revision check)', async () => {
  test.setTimeout(90_000);
  const launched = await launchW5App({ userDataDir });
  const { window } = launched;
  try {
    // Two clients load the same revision.
    const snapshot = await loadItems(window);

    await save(
      window,
      withItem(snapshot, 'alpha', { name: 'Newer Name', color: '#EF4444' }),
    );
    await save(window, withItem(snapshot, 'beta', { name: 'Beta Edited' }));

    // The second writer's untouched copy of `alpha` wins over the first
    // writer's rename and color, without a conflict.
    expect(readIndexEntry(userDataDir, 'alpha')).toMatchObject({
      name: 'Alpha',
      color: '#7C3AED',
    });
    expect(readIndexEntry(userDataDir, 'beta')).toMatchObject({
      name: 'Beta Edited',
    });
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('workspace_update_after_flip/concurrent_client: a stale save after a CLI create keeps the CLI entry it did not mention', async () => {
  test.setTimeout(90_000);
  const launched = await launchW5App({ userDataDir });
  const { window } = launched;
  try {
    const snapshot = await loadItems(window);
    const cli = await runCli(userDataDir, [
      'workspace',
      'create',
      'import',
      initRepo(path.join(fixtures, 'from-cli')),
    ]);
    expect(cli.code).toBe(0);

    await save(window, withItem(snapshot, 'alpha', { name: 'Alpha Renamed' }));

    expect(readIndexIds(userDataDir)).toContain('from-cli');
    expect(readIndexEntry(userDataDir, 'alpha')?.name).toBe('Alpha Renamed');
    expect(await loadProjectIds(window)).toContain('from-cli');
    expect(readIndexIds(userDataDir)).toEqual(
      expect.arrayContaining([DEFAULT_COWORK_WORKSPACE_ID, 'alpha', 'beta']),
    );
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});
