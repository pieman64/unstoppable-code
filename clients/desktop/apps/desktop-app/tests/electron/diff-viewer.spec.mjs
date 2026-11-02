import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Doc 3 — Supplemental gap plan, gap G12 (diff / changed-files viewer).
//
// Seed B3 (dirty worktree): two-phase. We seed the `ts-pnpm-vite` demo
// workspace (`demo-ts-pnpm-vite`, worktree branch `demo-main`) into a temp
// `userDataDir`, then dirty the worktree checkout BEFORE launching the app so
// the diff / changed-files surfaces have real content. The checkout lives at
// `<userDataDir>/workspaces/demo-ts-pnpm-vite/worktrees/demo-main/`. We modify
// a tracked file (`README.md`) and add an untracked file
// (`CANOPY_E2E_DIFF.txt`), then add a worktree attachment so the file browser
// exposes both the Git and attachments roots. The changed files surface via the
// activity-panel `getChangedFiles` IPC, so `hasUncommittedChanges` and diff
// stats are non-zero. (See `worktree-lifecycle.spec.mjs`, which writes
// `CANOPY_E2E_DIRTY.txt` into the checkout for the same purpose.)
//
// Flow: select the dirty worktree, wait for the activity panel content (it
// renders expanded inside the panel grid — the old collapse chrome is gone),
// assert `changed-files-section` lists the seeded change(s), then click a
// changed file row to open the Code Review modal (`code-review-modal`) and
// assert it shows the selected file and diff. Finally add the standalone
// `file-explorer` panel via the add-tab menu and assert the files tree
// renders there.
//
// Determinism: no live agents, no network, no PTY. Changed files load from a
// local `git status` against the seeded checkout. The diff content loads via
// the local `codeReview.get`/diff IPC against the on-disk worktree.
//
// Testids: `changed-files-section` (ChangedFilesSection.tsx),
// `code-review-modal` / `code-review-code-panel` / `code-review-close`
// (CodeReviewModal.tsx), plus `files-tree-tab` / `files-tree-refresh`
// (FilesTreeTab.tsx).

const WORKTREE_BRANCH = 'demo-main';
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const MODIFIED_FILE = 'README.md';
const MODIFIED_MARKER = 'CANOPY E2E diff-viewer modification line';
const UNTRACKED_FILE = 'CANOPY_E2E_DIFF.txt';
const DELETED_FILE = 'src/status.ts';
const ATTACHMENT_FILE = 'changed-files-context.txt';

test.describe('diff / changed-files viewer (G12)', () => {
  test('lists seeded changes and opens file panels in diff mode', async () => {
    // Phase 1: seed the demo workspace into a temp data dir.
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-g12-'),
    );
    const demoSeed = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
    });
    const worktreePath = demoSeed.workspaces[0]?.worktreePath;
    expect(worktreePath, 'seeded worktree path').toBeTruthy();

    // Phase 2: dirty the worktree checkout before launch. Modify a tracked file
    // and add an untracked file so the changed-files / diff surfaces have
    // content.
    const modifiedPath = path.join(worktreePath, MODIFIED_FILE);
    const originalReadme = readFileSync(modifiedPath, 'utf8');
    expect(
      originalReadme.length,
      'seeded README.md should exist and be non-empty',
    ).toBeGreaterThan(0);
    appendFileSync(modifiedPath, `\n${MODIFIED_MARKER}\n`, 'utf8');
    writeFileSync(
      path.join(worktreePath, UNTRACKED_FILE),
      'untracked file added by the G12 diff-viewer e2e seed\n',
      'utf8',
    );
    rmSync(path.join(worktreePath, DELETED_FILE));
    const attachmentsDir = path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'attachments',
      WORKTREE_BRANCH,
    );
    mkdirSync(attachmentsDir, { recursive: true });
    writeFileSync(
      path.join(attachmentsDir, ATTACHMENT_FILE),
      'attachment that adds a second file-browser root\n',
      'utf8',
    );

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const row = window.locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
      );
      await expect(row).toBeVisible();

      await app.selectWorktree(WORKTREE_BRANCH);

      // The activity panel mounts when a worktree is selected and renders
      // expanded inside the panel grid (no collapse chrome). Wait for its
      // content so the section stack — including Changed Files — renders.
      await expect(
        window.getByTestId('panel-content-activity-section'),
      ).toBeVisible();

      // The Changed Files section renders inside the activity panel.
      const changedFilesSection = window.getByTestId('changed-files-section');
      await expect(changedFilesSection).toBeVisible();

      // Changed files load asynchronously on selection
      // (refreshSelectedChangedFiles → activity.getChangedFiles). Poll until the
      // seeded modified + untracked files appear. If the section had not picked
      // up the changes, a Files-tree refresh would force a reload; here the
      // selection-driven refresh is sufficient, so we poll the rendered rows.
      await expect
        .poll(
          async () => {
            const text = await changedFilesSection.innerText();
            return text;
          },
          {
            timeout: 20_000,
            message: 'changed-files list should list changes',
          },
        )
        .toContain(MODIFIED_FILE);

      const sectionText = await changedFilesSection.innerText();
      expect(
        sectionText,
        'changed-files section lists the untracked seeded file',
      ).toContain(UNTRACKED_FILE);

      // The summary line should report a non-zero file count.
      await expect(changedFilesSection.getByText(/\d+ files?/)).toBeVisible();

      // Click the modified file's row to open the Code Review modal. Rows
      // render as role="button" (ChangedFilesSection.tsx FileRow). Scope to
      // the section and pick the row whose text includes the modified
      // filename.
      const modifiedRow = changedFilesSection
        .getByRole('button')
        .filter({ hasText: MODIFIED_FILE })
        .first();
      await expect(modifiedRow).toBeVisible();

      // Changed Files rows expose the same file action menu as File Explorer
      // rows. Verify the real right-click gesture while both the Git and
      // attachments roots are present, then continue with the primary-click
      // diff flow.
      await modifiedRow.click({ button: 'right' });
      const fileActionMenu = window.getByTestId('files-tree-action-menu');
      await expect(fileActionMenu).toBeVisible();
      for (const label of [
        'Open',
        'Send to chat',
        'Copy path',
        'Copy relative path',
      ]) {
        await expect(
          fileActionMenu.getByRole('menuitem', { name: label, exact: true }),
        ).toBeVisible();
      }
      await expect(
        fileActionMenu.getByTestId('files-tree-action-open-in-file-manager'),
      ).toBeVisible();
      const openInAppItem = fileActionMenu.getByTestId(
        'files-tree-action-open-in-app',
      );
      await expect(openInAppItem).toBeVisible();
      await expect(openInAppItem.locator('img')).toBeVisible();
      const openInAppLabel = await openInAppItem.getAttribute('aria-label');
      expect(openInAppLabel).toMatch(/^Open in .+/);
      await openInAppItem.hover();
      await expect(
        window.getByRole('tooltip').filter({ hasText: openInAppLabel }),
      ).toBeVisible();
      await expect(
        fileActionMenu.getByRole('menuitem', { name: 'Open to the side' }),
      ).toHaveCount(0);
      await expect(
        fileActionMenu.getByRole('menuitem', { name: 'Delete' }),
      ).toHaveCount(0);
      await fileActionMenu
        .getByRole('menuitem', { name: 'Copy relative path', exact: true })
        .click();
      await expect(fileActionMenu).toBeHidden();

      const deletedRow = changedFilesSection
        .getByRole('button')
        .filter({ hasText: DELETED_FILE })
        .first();
      await expect(deletedRow).toBeVisible();
      await deletedRow.click({ button: 'right' });
      await expect(fileActionMenu).toBeVisible();
      await expect(
        fileActionMenu.getByRole('menuitem', { name: 'Open', exact: true }),
      ).toBeVisible();
      await expect(
        fileActionMenu.getByRole('menuitem', { name: 'Send to chat' }),
      ).toHaveCount(0);
      await expect(
        fileActionMenu.getByTestId('files-tree-action-open-in-app'),
      ).toHaveCount(0);
      await fileActionMenu
        .getByRole('menuitem', { name: 'Open', exact: true })
        .click();
      const deletedPanel = window.locator(
        '[data-testid="panel-content-file-diff"]:visible',
      );
      await expect(deletedPanel.getByTestId('file-panel-diff')).toBeVisible({
        timeout: 15_000,
      });
      await expect(deletedPanel).toContainText('status.ts');
      await expect(window.getByTestId('code-review-modal')).toHaveCount(0);

      await modifiedRow.click({ button: 'right' });
      await expect(fileActionMenu).toBeVisible();
      await window.keyboard.press('Escape');
      await expect(fileActionMenu).toBeHidden();

      await modifiedRow.click();

      const codePanel = window.locator(
        '[data-testid="panel-content-file-diff"]:visible',
      );
      await expect(codePanel.getByTestId('file-panel-diff')).toContainText(
        MODIFIED_MARKER,
        { timeout: 15_000 },
      );
      await expect(window.getByTestId('code-review-modal')).toHaveCount(0);
      await expect(codePanel.getByTestId('file-tab-tree')).toHaveCount(0);
      await codePanel
        .locator('[data-testid="file-tab-tree-toggle"]:visible')
        .click();
      const tree = codePanel.getByTestId('file-tab-diff-tree');
      await expect(tree).toBeVisible();
      await tree
        .getByRole('button', { name: 'Search files', exact: true })
        .click();
      await tree
        .getByRole('textbox', { name: 'Search changed files' })
        .fill('README');
      const treeFile = tree
        .locator('[data-testid^="diff-file-tree-row-"]')
        .filter({ hasText: 'README.md' });
      await expect(treeFile).toBeVisible();
      await treeFile.click({ button: 'right' });
      await expect(fileActionMenu).toBeVisible();
      await expect(
        fileActionMenu.getByRole('menuitem', { name: 'Open', exact: true }),
      ).toHaveCount(0);
      await expect(
        fileActionMenu.getByRole('menuitem', { name: 'Delete', exact: true }),
      ).toHaveCount(0);
      await expect(
        fileActionMenu.getByRole('menuitem', {
          name: 'Copy relative path',
          exact: true,
        }),
      ).toBeVisible();
      await window.keyboard.press('Escape');

      // The files tree is now the standalone 'file-explorer' panel kind (the
      // FILES rail tab is gone). Add it through the chat group's add-tab menu
      // and assert it renders so the broader files surface is covered
      // alongside the diff.
      await window.getByTestId('panel-add-tab-group-chat').click();
      await window.getByTestId('panel-add-menu-item-file-explorer').click();
      await expect(window.getByTestId('files-tree-tab')).toBeVisible();
      await expect(window.getByTestId('files-tree-refresh')).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // A changed diff stat invalidates the worktree's file lists. When that
  // lands while a Changed Files right-click is still loading the file-tree
  // roots, the roots response is discarded; the menu used to wait on that
  // read and never opened. Startup under load hits this with the worktree's
  // first stats. Here both reads are held in main so the stats reply
  // deterministically reaches the renderer before the roots reply.
  test('a right-click survives a diff stats change that lands while file roots load', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-g12-roots-'),
    );
    const demoSeed = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
    });
    const worktreePath = demoSeed.workspaces[0]?.worktreePath;
    expect(worktreePath, 'seeded worktree path').toBeTruthy();
    const modifiedPath = path.join(worktreePath, MODIFIED_FILE);
    appendFileSync(modifiedPath, `\n${MODIFIED_MARKER}\n`, 'utf8');

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      // Main-side gates: diff stats reads pass through (counted) until
      // `holding` is set, then wait for release; the first roots read waits
      // for its own release.
      await electronApp.evaluate(({ ipcMain }) => {
        const stats = {
          holding: false,
          calls: 0,
          running: 0,
          held: 0,
          settled: 0,
          release: null,
        };
        const statsReleased = new Promise((resolve) => {
          stats.release = () => {
            stats.holding = false;
            resolve();
          };
        });
        const statsChannel = 'worktree:diff-stats-batch';
        const statsOriginal = ipcMain._invokeHandlers.get(statsChannel);
        ipcMain.removeHandler(statsChannel);
        ipcMain.handle(statsChannel, async (event, request) => {
          stats.calls += 1;
          if (!stats.holding) {
            stats.running += 1;
            try {
              return await statsOriginal(event, request);
            } finally {
              stats.running -= 1;
            }
          }
          stats.held += 1;
          await statsReleased;
          try {
            return await statsOriginal(event, request);
          } finally {
            stats.settled += 1;
          }
        });

        // Once armed, roots reads queue here and are released one at a time
        // in arrival order, so the menu's read always replies before a read
        // that a refetch starts after the invalidation.
        const roots = {
          armed: false,
          held: 0,
          queue: [],
          opened: false,
          release: null,
        };
        roots.release = async () => {
          roots.opened = true;
          for (const gate of roots.queue) {
            gate.open();
            await gate.done;
          }
        };
        const rootsChannel = 'file-tree:roots';
        const rootsOriginal = ipcMain._invokeHandlers.get(rootsChannel);
        ipcMain.removeHandler(rootsChannel);
        ipcMain.handle(rootsChannel, async (event, request) => {
          if (!roots.armed || roots.opened) {
            return rootsOriginal(event, request);
          }
          const gate = {};
          const opened = new Promise((resolve) => {
            gate.open = resolve;
          });
          gate.done = new Promise((resolve) => {
            gate.finish = resolve;
          });
          roots.queue.push(gate);
          roots.held += 1;
          await opened;
          try {
            return await rootsOriginal(event, request);
          } finally {
            gate.finish();
          }
        });
        globalThis.__g12RootsRace = { stats, roots };
      });
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      const changedFilesSection = window.getByTestId('changed-files-section');
      await expect(changedFilesSection).toContainText(MODIFIED_FILE, {
        timeout: 20_000,
      });

      // From here main holds every diff stats read and every roots read.
      // Unheld stats reads still running finish first, so the renderer's
      // stats match the checkout before it changes below.
      await electronApp.evaluate(() => {
        globalThis.__g12RootsRace.stats.holding = true;
        globalThis.__g12RootsRace.roots.armed = true;
      });
      await expect
        .poll(() =>
          electronApp.evaluate(() => globalThis.__g12RootsRace.stats.running),
        )
        .toBe(0);
      const raceState = () =>
        electronApp.evaluate(() => {
          const { stats, roots } = globalThis.__g12RootsRace;
          return {
            statsCalls: stats.calls,
            statsIdle: stats.running === 0 && stats.settled === stats.held,
            statsHeld: stats.held,
            rootsHeld: roots.held,
          };
        });

      // The next stats read now reports a different diff.
      appendFileSync(modifiedPath, 'second modification line\n', 'utf8');

      const modifiedRow = changedFilesSection
        .getByRole('button')
        .filter({ hasText: MODIFIED_FILE })
        .first();
      await modifiedRow.click({ button: 'right' });
      await expect
        .poll(async () => (await raceState()).rootsHeld)
        .toBeGreaterThan(0);

      // Window focus refreshes diff stats. Every stats reply reaches the
      // renderer before the roots reply, so the changed stats invalidate the
      // worktree's file lists under the menu's pending read.
      await window.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect
        .poll(async () => (await raceState()).statsHeld)
        .toBeGreaterThan(0);
      await electronApp.evaluate(() =>
        globalThis.__g12RootsRace.stats.release(),
      );
      // A superseded targeted refresh reads stats once more after its reply.
      // Wait until stats reads stay idle across a renderer round trip through
      // main, which follows any read the replies above made the renderer send.
      await expect
        .poll(async () => {
          const before = await raceState();
          await window.evaluate(() => window.api.loadPreferences());
          const after = await raceState();
          return (
            before.statsIdle &&
            after.statsIdle &&
            before.statsCalls === after.statsCalls
          );
        })
        .toBe(true);
      await electronApp.evaluate(() =>
        globalThis.__g12RootsRace.roots.release(),
      );

      const fileActionMenu = window.getByTestId('files-tree-action-menu');
      await expect(fileActionMenu).toBeVisible();
      await expect(
        fileActionMenu.getByRole('menuitem', { name: 'Open', exact: true }),
      ).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
