import {
  readChatStorageIndexes,
  readChatStorageMessages,
} from './readChatStorage.mjs';
/**
 * Behavior coverage for archived containers (Archive & Retention) beyond the
 * primary lifecycle specs in `archived-containers.spec.mjs`:
 *
 * - retention capture commits only after the work-entry scope-deletion fence
 *   has stopped provider sessions;
 * - retention OFF (explicit 0) hard-deletes a work entry with "Delete"
 *   labeling and retains nothing on disk;
 * - Cmd+K reaches a chat retained inside an archived worktree container and
 *   the Pipelines tab renders a relocated execution read-only (no action
 *   buttons in the detail modal);
 * - a main-window Cmd+K result for an archived App Advisor chat opens the
 *   viewer in the POPOUT renderer (its own store instance) via the
 *   `open_archived_container` window command;
 * - restoring a stale (>7d) work entry lands its chat read-only with the
 *   Start New Session / Hand Off Session affordances;
 * - a locked container survives the startup retention sweep past its expiry,
 *   and unlocking restarts the retention window from the unlock time.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  installPipelineIpcProbe,
  readCounts,
  uninstallPipelineIpcProbe,
} from './pipelineIpcProbe.mjs';

const NOW = new Date().toISOString();
const OLD = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString();
const EXPIRES = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString();
const PALETTE_SHORTCUT = process.platform === 'darwin' ? 'Meta+K' : 'Control+K';

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function seedPreferences(userDataDir) {
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { onboardingCompleted: ['v1'] },
  });
}

function chatTab(id, title, createdAt = NOW) {
  return {
    id,
    title,
    kind: 'chat',
    providerType: 'claude',
    createdAt,
    messages: [
      {
        id: `${id}-message`,
        role: 'user',
        blocks: [{ type: 'text', text: `Retained transcript for ${title}` }],
        timestamp: Date.parse(createdAt),
      },
    ],
  };
}

/** Terminal ExecutionState (version 6) relocated into an archived container. */
function executionState(projectId, worktreeId) {
  return {
    version: 6,
    id: 'behavior-exec-1',
    pipeline_id: 'pipeline-behavior',
    pipeline_snapshot: {
      name: 'Archived Behavior Pipeline',
      scope: ['directory'],
      jobs: {
        build: {
          name: 'build',
          needs: [],
          timeout_minutes: 360,
          max_retries: 0,
          continue_on_error: false,
          steps: [
            {
              id: 'step1',
              run: 'echo hello',
              shell: 'bash',
              continue_on_error: false,
              timeout_minutes: 360,
              skip_on_missing_action: false,
            },
          ],
        },
      },
    },
    status: 'success',
    status_reasons: [],
    jobs: {
      build: {
        status: 'success',
        steps: {
          step1: { status: 'pending', outputs: {}, dynamic_env: {} },
        },
        outputs: {},
        retry_count: 0,
        retry_history: [],
        iteration_count: 0,
        conclusion: 'success',
      },
    },
    started_at: NOW,
    owner_pid: 1,
    cwd: '/tmp',
    env: {},
    inputs: {},
    event_name: 'dispatch',
    project_id: projectId,
    worktree_id: worktreeId,
    completed_at: NOW,
  };
}

function seedCoworkWorkspace(userDataDir, workspaceId, retentionDays) {
  const workspaceDir = path.join(userDataDir, 'workspaces', workspaceId);
  writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: workspaceId,
        name: `Behavior ${workspaceId}`,
        type: 'cowork',
        color: '#7C9B6D',
        collapsed: false,
        order: 0,
        cowork: { createdAt: NOW, archiveRetentionDays: retentionDays },
      },
    ],
  });
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    repos: [],
    cowork: { createdAt: NOW, archiveRetentionDays: retentionDays },
  });
  return workspaceDir;
}

async function expandCoworkWorkspace(window, workspaceId) {
  const toggle = window.getByTestId(
    `sidebar-cowork-project-${workspaceId}-toggle`,
  );
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
}

/**
 * The chat-search full scan indexes archived containers shortly after boot;
 * retry the palette until the row for `text` appears.
 */
async function findPaletteChat(window, query, text) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await window.keyboard.press(PALETTE_SHORTCUT);
    await expect(window.getByTestId('command-palette')).toBeVisible();
    await window.getByTestId('command-palette-input').fill(query);
    const candidate = window
      .getByRole('option')
      .filter({ hasText: text })
      .first();
    try {
      await candidate.waitFor({ state: 'visible', timeout: 3_000 });
      return candidate;
    } catch {
      await window.keyboard.press('Escape');
      await window.waitForTimeout(2_000);
    }
  }
  return null;
}

test.describe('archived container behaviors', () => {
  test('retention capture includes provider output committed during work-entry teardown', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-archived-fence-order-'),
    );
    seedPreferences(userDataDir);
    const workspaceDir = seedCoworkWorkspace(
      userDataDir,
      'behavior-fence-order',
      7,
    );
    writeJson(path.join(workspaceDir, 'work-entries.json'), {
      version: 1,
      entries: [
        { id: 'entry-fence-order', title: 'Archive first', createdAt: NOW },
      ],
    });
    writeJson(path.join(workspaceDir, 'chats', 'entry-fence-order.json'), {
      version: 1,
      activeTabId: 'chat-fence-order',
      tabs: [chatTab('chat-fence-order', 'Archive first')],
    });

    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_E2E_WORK_ENTRY_DELETION_FENCE_DELAY_MS: '2000',
        CANOPY_E2E_WORK_ENTRY_DELETION_LATE_PROVIDER_CHAT_ID:
          'chat-fence-order',
      },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await expandCoworkWorkspace(window, 'behavior-fence-order');

      const row = window.getByTestId('sidebar-work-entry-entry-fence-order');
      await row.click();
      await expect(window.getByRole('textbox').first()).toBeVisible({
        timeout: 30_000,
      });
      await row.hover();
      await window
        .getByTestId('sidebar-work-entry-entry-fence-order-menu')
        .click();
      await window
        .getByTestId('sidebar-work-entry-entry-fence-order-delete')
        .click();
      await window
        .getByTestId('sidebar-work-entry-entry-fence-order-delete-dialog')
        .getByTestId('sidebar-work-entry-entry-fence-order-confirm-delete')
        .click();

      const manifestPath = path.join(
        workspaceDir,
        'archived-containers',
        'entry-fence-order',
        'container.json',
      );
      // The E2E checkpoint holds the service lifecycle fence for two seconds
      // before simulating a provider teardown event. The repository remains
      // writable for that event until sessions drain; archive capture starts
      // only after the repository fence closes.
      await expect(row).toHaveCount(1);
      await expect
        .poll(() => existsSync(manifestPath), { timeout: 1_000 })
        .toBe(false);
      await expect(row).toHaveCount(0, { timeout: 15_000 });
      expect(existsSync(manifestPath)).toBe(true);
      const containerRoot = path.dirname(manifestPath);
      const { live: archivedChats } = readChatStorageIndexes(
        containerRoot,
        'entry-fence-order',
      );
      expect(existsSync(path.join(containerRoot, 'chats.json'))).toBe(false);
      expect(
        archivedChats.tabs
          .flatMap((tab) =>
            readChatStorageMessages(containerRoot, 'entry-fence-order', tab.id),
          )
          .flatMap((message) => message.blocks ?? [])
          .some(
            (block) =>
              block.type === 'text' &&
              block.text === 'Late provider output before deletion',
          ),
      ).toBe(true);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a legacy retention-off project still retains a deleted work entry while fencing a late chat flush', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-archived-off-'),
    );
    seedPreferences(userDataDir);
    const workspaceDir = seedCoworkWorkspace(userDataDir, 'behavior-off', 0);
    writeJson(path.join(workspaceDir, 'work-entries.json'), {
      version: 1,
      entries: [{ id: 'entry-off', title: 'Hard delete me', createdAt: NOW }],
    });
    writeJson(path.join(workspaceDir, 'chats', 'entry-off.json'), {
      version: 1,
      activeTabId: 'chat-off',
      tabs: [chatTab('chat-off', 'Hard delete me')],
    });

    const { electronApp } = await launchCanopy({
      userDataDir,
      env: { CANOPY_E2E_WORK_ENTRY_DELETION_FENCE_DELAY_MS: '2000' },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await expandCoworkWorkspace(window, 'behavior-off');

      const row = window.getByTestId('sidebar-work-entry-entry-off');
      // Select the entry and let the page settle first — async work-entry /
      // archived-container loads remount sidebar rows and would drop the
      // inline-confirm state mid-interaction.
      await row.click();
      await expect(window.getByRole('textbox').first()).toBeVisible({
        timeout: 30_000,
      });
      await row.hover();
      await window.getByTestId('sidebar-work-entry-entry-off-menu').click();
      const deleteItem = window.getByTestId(
        'sidebar-work-entry-entry-off-delete',
      );
      // Delete always reads "Delete" (trash icon, destructive tone) and,
      // because deletion retention is always on, keeps the entry for the
      // default window even though this workspace persisted the legacy 0.
      await expect(deleteItem).toHaveText('Delete');
      // Recoverable removal reads neutral, like Archive.
      await expect(deleteItem).not.toHaveClass(/fg-destructive/);
      await expect(deleteItem).toHaveAttribute(
        'title',
        'Kept for 7 days, then removed',
      );
      await expect(deleteItem.locator('svg')).toHaveCount(1);
      await expect(
        window.getByTestId('sidebar-work-entry-entry-off-archive'),
      ).toHaveText('Archive');
      await deleteItem.click();
      await window
        .getByTestId('sidebar-work-entry-entry-off-delete-dialog')
        .getByTestId('sidebar-work-entry-entry-off-confirm-delete')
        .click();

      // The E2E-only checkpoint pauses after the outer deletion fence is held
      // but before provider-session teardown. A renderer flush in this window
      // must not recreate the chat sidecar that deletion is about to remove.
      await window.waitForTimeout(250);
      await expect(row).toHaveCount(1);
      await window.evaluate(async () => {
        await window.api.chat.flushScope({
          projectId: 'behavior-off',
          worktreeId: 'entry-off',
        });
      });
      await expect(row).toHaveCount(0, { timeout: 15_000 });

      // The entry lands in the workspace's "Archived and deleted" list as a
      // Deleted (unlocked) container with the default 7-day window.
      await expect(
        window.getByTestId('sidebar-cowork-project-behavior-off-archived-link'),
      ).toHaveText('Archived and deleted 1', { timeout: 15_000 });
      const manifestPath = path.join(
        workspaceDir,
        'archived-containers',
        'entry-off',
        'container.json',
      );
      await expect.poll(() => existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      expect(manifest.retentionDays).toBe(7);
      expect(manifest.lockedAt).toBeUndefined();
      // The live chat file is gone once cleanup finishes; assert the
      // terminal file state instead of racing it.
      await expect
        .poll(
          () => existsSync(path.join(workspaceDir, 'chats', 'entry-off.json')),
          { timeout: 15_000 },
        )
        .toBe(false);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a locked archive survives the retention sweep and unlocking restarts the window', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-archived-lock-'),
    );
    seedPreferences(userDataDir);
    const workspaceDir = seedCoworkWorkspace(userDataDir, 'behavior-lock', 7);
    const containerId = 'locked-entry';
    const containerDir = path.join(
      workspaceDir,
      'archived-containers',
      containerId,
    );
    const tab = chatTab(`${containerId}-chat`, 'Locked entry chat');
    writeJson(path.join(containerDir, 'chats.json'), {
      version: 1,
      activeTabId: tab.id,
      tabs: [tab],
    });
    writeJson(path.join(containerDir, 'chat-archives.json'), {
      version: 1,
      archived: [],
    });
    const manifestPath = path.join(containerDir, 'container.json');
    writeJson(manifestPath, {
      version: 1,
      id: containerId,
      kind: 'work-entry',
      projectId: 'behavior-lock',
      name: 'Locked vault entry',
      createdAt: OLD,
      archivedAt: OLD,
      retentionDays: 7,
      // Already past its original window: only the lock keeps it alive
      // through the startup retention sweep.
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(),
      lockedAt: NOW,
      chatCount: 1,
      archivedChatCount: 0,
      executionCount: 0,
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await expandCoworkWorkspace(window, 'behavior-lock');
      // Let the empty-workspace surface settle before driving the archived
      // subgroup. Initial work-entry and archived-container hydration can
      // remount the sidebar row and collapse the subgroup mid-click.
      await expect(window.getByRole('textbox').first()).toBeVisible({
        timeout: 30_000,
      });

      const archivedLink = window.getByTestId(
        'sidebar-cowork-project-behavior-lock-archived-link',
      );
      await expect(archivedLink).toBeVisible({ timeout: 15_000 });
      await archivedLink.click();
      const row = window.getByTestId(`archived-overview-row-${containerId}`);
      await expect(row).toBeVisible({ timeout: 15_000 });
      await expect(
        window.getByTestId(`archived-overview-state-${containerId}`),
      ).toHaveAttribute('data-state', 'archived');

      // The archived Work Entry itself is a Cmd+K target, even though none of
      // its chat titles contain the container's display name.
      const archivedEntryOption = await findPaletteChat(
        window,
        'Locked vault entry',
        'Locked vault entry',
      );
      expect(
        archivedEntryOption,
        'palette shows the archived Work Entry',
      ).not.toBeNull();
      // Locked containers are "Archived" items in Cmd+K.
      await expect(
        archivedEntryOption.getByTestId('command-palette-archive-badge'),
      ).toHaveText('Archived');
      await archivedEntryOption.click();

      const viewer = window.getByTestId('archived-container-view');
      await expect(viewer).toBeVisible({ timeout: 15_000 });
      const stateBadge = viewer.getByTestId('archived-state-badge');
      await expect(stateBadge).toHaveAttribute('data-state', 'archived');
      await expect(stateBadge).toContainText('Archived');
      const stateToggle = viewer.getByTestId('archived-state-toggle');
      await expect(stateToggle).toHaveText('Delete');

      // Delete (formerly "unlock"): the item becomes Deleted, the removal
      // date returns, and the persisted manifest restarts the full window
      // from now.
      await stateToggle.click();
      await expect(stateBadge).toHaveAttribute('data-state', 'deleted', {
        timeout: 15_000,
      });
      await expect(viewer).toContainText('Removed');
      await expect(() => {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        expect(manifest.lockedAt).toBeUndefined();
        expect(Date.parse(manifest.expiresAt)).toBeGreaterThan(Date.now());
      }).toPass({ timeout: 15_000 });

      // Archive again from the same control.
      await expect(stateToggle).toHaveText('Archive');
      await stateToggle.click();
      await expect(stateBadge).toHaveAttribute('data-state', 'archived', {
        timeout: 15_000,
      });
      await expect(() => {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        expect(typeof manifest.lockedAt).toBe('string');
      }).toPass({ timeout: 15_000 });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Cmd+K reaches an archived chat and the Pipelines tab is read-only', async () => {
    test.setTimeout(150_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-archived-cmdk-'),
    );
    seedPreferences(userDataDir);
    const projectId = 'behavior-code';
    const containerId = 'zebra-worktree';
    const workspaceDir = path.join(userDataDir, 'workspaces', projectId);
    const repoPath = path.join(userDataDir, 'behavior-source-repo');
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(path.join(repoPath, 'README.md'), 'behavior fixture\n');
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'behavior',
      GIT_AUTHOR_EMAIL: 'behavior@example.com',
      GIT_COMMITTER_NAME: 'behavior',
      GIT_COMMITTER_EMAIL: 'behavior@example.com',
    };
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
    execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'fixture'], {
      cwd: repoPath,
      env: gitEnv,
    });
    writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
      version: 1,
      workspaces: [
        {
          id: projectId,
          name: 'Behavior Code',
          type: 'multi-repo',
          color: '#7C3AED',
          collapsed: false,
          order: 0,
        },
      ],
    });
    writeJson(path.join(workspaceDir, 'workspace.json'), {
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'source', name: 'Source', repoPath }],
      sourceRepoPath: repoPath,
      alwaysShow: true,
      archiveRetentionDays: 7,
    });
    writeJson(path.join(workspaceDir, 'worktrees.json'), {
      version: 1,
      worktrees: [],
    });

    const containerDir = path.join(
      workspaceDir,
      'archived-containers',
      containerId,
    );
    const tab = chatTab(`${containerId}-chat`, 'Zebra Lattice chat');
    writeJson(path.join(containerDir, 'chats.json'), {
      version: 1,
      activeTabId: tab.id,
      tabs: [tab],
    });
    writeJson(path.join(containerDir, 'chat-archives.json'), {
      version: 1,
      archived: [],
    });
    writeJson(path.join(containerDir, 'summary.json'), {
      version: 1,
      summary: {
        title: 'Zebra migration',
        description: 'Retired the striped transport adapter',
        highlights: ['Preserved migration notes'],
        generatedAt: NOW,
        turnCountAtGeneration: 3,
        lastFullRefreshAt: NOW,
        lastFullRefreshTurnCount: 3,
      },
    });
    writeJson(path.join(containerDir, 'tracked-plans.json'), {
      version: 1,
      plans: [
        {
          id: 'alpha-archive-plan',
          projectId,
          worktreeId: containerId,
          source: 'codex',
          title: 'Alpha archive rollout',
          content: '# Alpha archive rollout\n\nValidate the alphaplan phase.',
          reviewStatus: 'approved',
          createdAt: NOW,
          updatedAt: NOW,
          latestRevisionNumber: 1,
          revisions: [],
          linkedExecutionIds: [],
        },
        {
          id: 'zebra-archive-plan',
          projectId,
          worktreeId: containerId,
          source: 'claude',
          title: 'Zebra archive rollout',
          content:
            '# Zebra archive rollout\n\nValidate the stripedplanneedle phase.',
          reviewStatus: 'approved',
          createdAt: NOW,
          updatedAt: NOW,
          latestRevisionNumber: 1,
          revisions: [],
          linkedExecutionIds: [],
        },
      ],
    });
    writeJson(
      path.join(containerDir, 'pipeline-executions', 'behavior-exec-1.json'),
      executionState(projectId, containerId),
    );
    // The archived step's log, read only through the archive transport.
    const archivedLogPath = path.join(
      containerDir,
      'pipeline-executions',
      'behavior-exec-1',
      'logs',
      'build--step1.log',
    );
    mkdirSync(path.dirname(archivedLogPath), { recursive: true });
    writeFileSync(archivedLogPath, 'ARCHIVED_STEP_LOG_MARKER hello\n');
    writeJson(path.join(containerDir, 'container.json'), {
      version: 1,
      id: containerId,
      kind: 'worktree',
      projectId,
      name: 'Zebra Lattice worktree',
      createdAt: NOW,
      archivedAt: NOW,
      retentionDays: 7,
      expiresAt: EXPIRES,
      chatCount: 1,
      archivedChatCount: 0,
      executionCount: 1,
      branchName: 'feature/zebra',
      workspaceType: 'multi-repo',
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      // Opening an archived worktree row from ANOTHER page must navigate to
      // the main page and land on the viewer (the sidebar renders on every
      // page, so the row is reachable from all of them).
      await app.openPipelinesPage();
      const archivedLink = window.getByTestId(
        `sidebar-project-${projectId}-archived-link`,
      );
      await expect(archivedLink).toBeVisible({ timeout: 15_000 });
      await archivedLink.click();
      await expect(window.getByTestId('archived-overview-page')).toBeVisible({
        timeout: 15_000,
      });
      await window.getByTestId('archived-overview-open-zebra-worktree').click();
      await expect(window.getByTestId('archived-container-view')).toBeVisible({
        timeout: 15_000,
      });
      // Back returns to the overview list, not to the live surface.
      await window.getByTestId('archived-container-view-close').click();
      await expect(window.getByTestId('archived-container-view')).toHaveCount(
        0,
      );
      await expect(window.getByTestId('archived-overview-page')).toBeVisible();
      await window.getByTestId('archived-overview-back').click();
      await expect(window.getByTestId('archived-overview-page')).toHaveCount(0);

      // The container label and captured summary description both resolve to
      // the archived worktree row, clearly separated from live worktrees.
      const archiveOption = await findPaletteChat(
        window,
        'striped transport adapter',
        'Zebra Lattice worktree',
      );
      expect(
        archiveOption,
        'palette indexes the archived summary',
      ).not.toBeNull();
      // Unlocked containers are "Deleted" items in Cmd+K.
      await expect(
        archiveOption.getByTestId('command-palette-archive-badge'),
      ).toHaveText('Deleted');
      await archiveOption.click();
      await expect(window.getByTestId('archived-container-view')).toBeVisible();
      await window.getByTestId('archived-container-view-close').click();

      // Captured plan titles and bodies remain searchable and deep-link to the
      // exact plan inside the archive viewer.
      const archivedPlanOption = await findPaletteChat(
        window,
        'stripedplanneedle',
        'Zebra archive rollout',
      );
      expect(
        archivedPlanOption,
        'palette indexes archived plan content',
      ).not.toBeNull();
      await expect(
        archivedPlanOption.getByTestId('command-palette-archive-badge'),
      ).toHaveText('Deleted');
      await archivedPlanOption.click();
      const archivedPlanViewer = window.getByTestId('archived-container-view');
      await expect(archivedPlanViewer).toBeVisible();
      await expect(
        archivedPlanViewer.getByTestId('archived-plan-content'),
      ).toContainText('stripedplanneedle');

      // In-viewer selection must update the store so invoking the same
      // command-palette deep link again can restore the original plan.
      await archivedPlanViewer
        .getByTestId('archived-plan-row-alpha-archive-plan')
        .click();
      await expect(
        archivedPlanViewer.getByTestId('archived-plan-content'),
      ).toContainText('alphaplan');
      const repeatedArchivedPlanOption = await findPaletteChat(
        window,
        'stripedplanneedle',
        'Zebra archive rollout',
      );
      expect(
        repeatedArchivedPlanOption,
        'palette can repeat the same archived plan deep link',
      ).not.toBeNull();
      await repeatedArchivedPlanOption.click();
      await expect(
        archivedPlanViewer.getByTestId('archived-plan-content'),
      ).toContainText('stripedplanneedle');
      await window.getByTestId('archived-container-view-close').click();

      const option = await findPaletteChat(
        window,
        'Zebra Lattice',
        'Zebra Lattice chat',
      );
      expect(option, 'palette shows the archived chat').not.toBeNull();
      await option.click();

      const viewer = window.getByTestId('archived-container-view');
      await expect(viewer).toBeVisible({ timeout: 15_000 });
      // Navigating from a chat result lands on the transcript itself.
      await expect(viewer).toContainText(
        'Retained transcript for Zebra Lattice chat',
        { timeout: 15_000 },
      );

      await viewer.getByTestId('archived-container-tab-pipelines').click();
      const execRow = viewer.getByTestId(
        'archived-execution-row-behavior-exec-1',
      );
      await expect(execRow).toBeVisible({ timeout: 15_000 });
      await installPipelineIpcProbe(electronApp);
      try {
        await execRow.click();

        const modal = window.getByRole('dialog').last();
        await expect(modal).toBeVisible({ timeout: 15_000 });
        await expect(modal).toContainText('Archived Behavior Pipeline');
        // Read-only: no lifecycle actions may render for archived executions.
        await expect(
          modal.getByRole('button', {
            name: /^(Cancel|Retry|Rerun|Debug|Resume)/,
          }),
        ).toHaveCount(0);

        // An archived step's log comes from the archive, never the live
        // pipeline API.
        await modal.getByTestId('pipeline-details-nav-job-build').click();
        const stepRow = modal.getByTestId('pipeline-step-step1');
        await stepRow.getByRole('button').first().click();
        await expect(
          modal.getByTestId('pipeline-step-log-output-step1'),
        ).toContainText('ARCHIVED_STEP_LOG_MARKER hello', { timeout: 15_000 });
        const counts = await readCounts(electronApp);
        expect(counts.readStepLog.count).toBe(0);
        expect(counts.getExecution.count).toBe(0);
      } finally {
        await uninstallPipelineIpcProbe(electronApp);
      }
      await window.keyboard.press('Escape');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('main-window Cmd+K opens an archived App Advisor chat in the popout viewer', async () => {
    test.setTimeout(150_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-archived-advisor-cmdk-'),
    );
    seedPreferences(userDataDir);
    const advisorDir = path.join(userDataDir, 'app-workspaces', 'app-advisor');
    writeJson(path.join(advisorDir, 'work-entries.json'), {
      version: 1,
      entries: [],
    });
    const containerDir = path.join(
      advisorDir,
      'archived-containers',
      'advisor-archived',
    );
    const tab = chatTab('advisor-archived-chat', 'Advisor Xylophone chat');
    writeJson(path.join(containerDir, 'chats.json'), {
      version: 1,
      activeTabId: tab.id,
      tabs: [tab],
    });
    writeJson(path.join(containerDir, 'chat-archives.json'), {
      version: 1,
      archived: [],
    });
    writeJson(path.join(containerDir, 'container.json'), {
      version: 1,
      id: 'advisor-archived',
      kind: 'work-entry',
      projectId: 'app-advisor',
      name: 'Advisor archived entry',
      createdAt: NOW,
      archivedAt: NOW,
      retentionDays: 7,
      expiresAt: EXPIRES,
      chatCount: 1,
      archivedChatCount: 0,
      executionCount: 0,
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      const option = await findPaletteChat(
        window,
        'Advisor Xylophone',
        'Advisor Xylophone chat',
      );
      expect(option, 'palette shows the archived advisor chat').not.toBeNull();
      const windowPromise = electronApp.waitForEvent('window', {
        timeout: 30_000,
      });
      await option.click();

      // The viewer must open in the POPOUT renderer (its own store
      // instance), driven by the open_archived_container window command.
      const advisor = await windowPromise;
      const viewer = advisor.getByTestId('archived-container-view');
      await expect(viewer).toBeVisible({ timeout: 30_000 });
      await expect(viewer).toContainText(
        'Retained transcript for Advisor Xylophone chat',
        { timeout: 15_000 },
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('selecting a live target dismisses the archived viewer like a page', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-archived-dismiss-'),
    );
    seedPreferences(userDataDir);
    const workspaceDir = seedCoworkWorkspace(userDataDir, 'behavior-nav', 7);
    writeJson(path.join(workspaceDir, 'work-entries.json'), {
      version: 1,
      entries: [{ id: 'live-entry', title: 'Live entry', createdAt: NOW }],
    });
    writeJson(path.join(workspaceDir, 'chats', 'live-entry.json'), {
      version: 1,
      activeTabId: 'live-chat',
      tabs: [chatTab('live-chat', 'Live entry')],
    });
    const containerDir = path.join(
      workspaceDir,
      'archived-containers',
      'nav-archived',
    );
    const tab = chatTab('nav-archived-chat', 'Archived nav chat');
    writeJson(path.join(containerDir, 'chats.json'), {
      version: 1,
      activeTabId: tab.id,
      tabs: [tab],
    });
    writeJson(path.join(containerDir, 'chat-archives.json'), {
      version: 1,
      archived: [],
    });
    writeJson(path.join(containerDir, 'container.json'), {
      version: 1,
      id: 'nav-archived',
      kind: 'work-entry',
      projectId: 'behavior-nav',
      name: 'Archived nav entry',
      createdAt: NOW,
      archivedAt: NOW,
      retentionDays: 7,
      expiresAt: EXPIRES,
      chatCount: 1,
      archivedChatCount: 0,
      executionCount: 0,
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await expandCoworkWorkspace(window, 'behavior-nav');
      await window.getByTestId('sidebar-work-entry-live-entry').click();
      await expect(window.getByRole('textbox').first()).toBeVisible({
        timeout: 30_000,
      });

      const archivedLink = window.getByTestId(
        'sidebar-cowork-project-behavior-nav-archived-link',
      );
      await expect(archivedLink).toBeVisible({ timeout: 15_000 });
      await archivedLink.click();
      await window.getByTestId('archived-overview-open-nav-archived').click();
      const viewer = window.getByTestId('archived-container-view');
      await expect(viewer).toBeVisible();

      // Selecting a live target must dismiss the viewer like leaving a page —
      // the archive can never stay covering the destination.
      await window.getByTestId('sidebar-work-entry-live-entry').click();
      await expect(viewer).toHaveCount(0, { timeout: 15_000 });
      await expect(window.getByRole('textbox').first()).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('restoring a stale work entry lands read-only with handoff options', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-archived-stale-'),
    );
    seedPreferences(userDataDir);
    const workspaceDir = seedCoworkWorkspace(userDataDir, 'behavior-stale', 7);
    writeJson(path.join(workspaceDir, 'work-entries.json'), {
      version: 1,
      entries: [],
    });
    const containerDir = path.join(
      workspaceDir,
      'archived-containers',
      'stale-entry',
    );
    const staleTab = chatTab('stale-chat', 'Stale handoff chat', OLD);
    staleTab.sdkSessionId = 'claude-session-that-expired';
    writeJson(path.join(containerDir, 'chats.json'), {
      version: 1,
      activeTabId: staleTab.id,
      tabs: [staleTab],
    });
    writeJson(path.join(containerDir, 'chat-archives.json'), {
      version: 1,
      archived: [],
    });
    writeJson(path.join(containerDir, 'container.json'), {
      version: 1,
      id: 'stale-entry',
      kind: 'work-entry',
      projectId: 'behavior-stale',
      name: 'Stale entry',
      createdAt: OLD,
      archivedAt: OLD,
      retentionDays: 90,
      expiresAt: EXPIRES,
      chatCount: 1,
      archivedChatCount: 0,
      executionCount: 0,
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await expandCoworkWorkspace(window, 'behavior-stale');
      // Let the empty-workspace surface settle before driving the archived
      // subgroup (initial loads remount sidebar rows).
      await expect(window.getByRole('textbox').first()).toBeVisible({
        timeout: 30_000,
      });

      const archivedLink = window.getByTestId(
        'sidebar-cowork-project-behavior-stale-archived-link',
      );
      await expect(archivedLink).toBeVisible({ timeout: 15_000 });
      await archivedLink.click();
      await window.getByTestId('archived-overview-open-stale-entry').click();
      const viewer = window.getByTestId('archived-container-view');
      await expect(viewer).toBeVisible();

      await viewer.getByTestId('archived-restore').click();
      // Restore consumes the container and navigates to the restored entry.
      await expect(viewer).toHaveCount(0, { timeout: 30_000 });

      // The restored stale chat presents the read-only banner with the
      // handoff affordances.
      await expect(
        window.getByTestId('read-only-hand-off-session'),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        window.getByTestId('read-only-start-new-session'),
      ).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
