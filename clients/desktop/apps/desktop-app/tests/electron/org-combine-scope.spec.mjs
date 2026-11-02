import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
} from './seeders/index.mjs';
import { expectWorkspaceContext } from './workspaceContextMenu.mjs';
import {
  seedOrgCombineScope,
  prepareOrgCombineScope,
  ORG_COMBINE_ENV,
} from './orgCombineScopeFixture.mjs';

// CAN-3571 replaces shared-source joins with a new shared project. Old
// clients must be refused before ownership, git or source-worktree effects.
for (const crossOrganization of [false, true]) {
  test(`CAN-3571 ${crossOrganization ? 'cross-organization' : 'same-organization'} shared sources refuse legacy combine without changing the sources`, async () => {
    test.setTimeout(180_000);
    const apiKey = `csk_can3571_guard_${crossOrganization ? 'cross' : 'same'}`;
    const userDataDir = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), 'canopy-can3571-guard-')),
    );
    const fixture = seedOrgCombineScope(userDataDir, crossOrganization);
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
      cloud: fixture.cloud,
    });
    let electronApp;
    try {
      ({ electronApp } = await launchCanopy({
        userDataDir,
        env: ORG_COMBINE_ENV,
      }));
      const window = await prepareOrgCombineScope(
        electronApp,
        userDataDir,
        apiKey,
        fixture,
      );
      const sources = [
        ['context-organization', 'org-feature'],
        [fixture.joinWorkspaceId, fixture.joinWorktreeId],
      ];
      const snapshot = () => ({
        index: readFileSync(
          path.join(userDataDir, 'workspaces', 'index.json'),
          'utf8',
        ),
        sources: sources.map(([id, worktreeId]) => {
          const directory = path.join(userDataDir, 'workspaces', id);
          return {
            config: readFileSync(
              path.join(directory, 'workspace.json'),
              'utf8',
            ),
            worktrees: readFileSync(
              path.join(directory, 'worktrees.json'),
              'utf8',
            ),
            contents: readFileSync(
              path.join(directory, 'worktrees', worktreeId, 'README.md'),
              'utf8',
            ),
            gitWorktrees: execFileSync(
              'git',
              ['worktree', 'list', '--porcelain'],
              {
                cwd: path.join(userDataDir, 'repos', id),
                encoding: 'utf8',
              },
            ),
          };
        }),
      });
      const diskBefore = snapshot();
      const activityBefore = (
        await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)
      ).activity;
      const contextBefore = await window.evaluate(() =>
        window.api.workspaceContext.get(),
      );
      await expect(
        window.evaluate(
          (request) => window.api.combineWorktreeWithExistingWorktree(request),
          {
            sourceWorkspaceId: sources[0][0],
            sourceWorktreeId: sources[0][1],
            joinWorkspaceId: sources[1][0],
            joinWorktreeId: sources[1][1],
            mode: 'temporary',
          },
        ),
      ).rejects.toThrow(
        'Create a new shared multi-repo project to combine organization projects',
      );
      expect(snapshot()).toEqual(diskBefore);
      const activityAfter = (
        await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)
      ).activity;
      for (const key of [
        'orgMemberMultiRepoCreate',
        ...fixture.heldIds.map((id) => `orgProjectClaim:${id}`),
      ]) {
        expect(activityAfter[key] ?? 0).toBe(activityBefore[key] ?? 0);
      }
      expect(
        (await window.evaluate(() => window.api.workspaceContext.get()))
          .context,
      ).toEqual(contextBefore.context);
      await expectWorkspaceContext(
        window,
        contextBefore.context.organizationId,
      );
      // The visible entry point now offers the source-preserving setup,
      // rather than the legacy picker that used to consume both worktrees.
      const row = window.locator(
        '[data-testid="worktree-row"][data-project-id="context-organization"][data-worktree-id="org-feature"]',
      );
      await row.click();
      await row.hover();
      await row.getByTestId('worktree-actions-menu-button').click();
      await window.getByTestId('worktree-actions-menu-add-repo').click();
      await expect(
        window.getByTestId('org-shared-multi-repo-setup'),
      ).toBeVisible();
      await expect(
        window.getByTestId('add-repo-to-worktree-modal'),
      ).toHaveCount(0);
      expect(snapshot()).toEqual(diskBefore);
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
    }
  });
}
