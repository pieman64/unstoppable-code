// Pipeline package transitive-skill analysis — durable Electron coverage.
//
// A Codex skill may contain shell snippets and prose with `$VARIABLES`, regex
// fragments such as `/g`, and score text such as `/10`. Sharing must package
// only actual inventory-backed skills while following canonical transitive
// invocations. The realistic flow opens a stored pipeline, opens Share, waits
// for main-process analysis, and verifies the dependency review shown to the
// publisher.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  seedPipelineShareTransitiveSkills,
  TRANSITIVE_SKILL_PIPELINE_ID,
} from './seeders/seedPipelineShareTransitiveSkills.mjs';

test('pipeline sharing ignores shell tokens and packages only real transitive skills', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-transitive-skill-share-'),
  );
  seedPipelineShareTransitiveSkills(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const saveResult = await window.evaluate(
      async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      'csk_transitive_skill_share_e2e',
    );
    expect(saveResult.status.authenticated).toBe(true);
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });

    await app.openPipelinesPage();
    await app.openWorkflowsLibraryRow(
      app.workflowsLibraryPipelineRow(TRANSITIVE_SKILL_PIPELINE_ID),
    );
    // Share sits in the Workflows edit shell's actions bar (CAN-4072).
    const shell = window.getByTestId('workflow-edit-shell');
    await expect(shell).toHaveAttribute('data-kind', 'pipeline');
    await shell
      .getByTestId('workflow-edit-actions')
      .getByTestId('pipeline-share')
      .click();

    const dependencyReview = window.getByTestId('share-pipeline-dependencies');
    await expect(dependencyReview).toBeVisible();
    await expect(dependencyReview).not.toHaveAttribute(
      'data-state',
      'loading',
      {
        timeout: 15_000,
      },
    );
    await expect(dependencyReview).toHaveAttribute('data-state', 'ready');
    // The review is collapsed by default, so expand it before checking
    // which files are packaged.
    const dependenciesToggle = window.getByTestId(
      'share-pipeline-dependencies-toggle',
    );
    await dependenciesToggle.click();
    await expect(dependenciesToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(dependencyReview).toContainText('/open-pr');
    await expect(dependencyReview).toContainText('/review-multi');
    await expect(dependencyReview).toContainText('$review:review-loop');
    await expect(dependencyReview).toContainText('$review:review-multi');
    // The problem list is the durable signal now that the old "Needs
    // attention" heading is gone: a ready analysis renders no problem rows.
    await expect(
      dependencyReview.locator(
        '[data-testid="share-pipeline-dependency-problems"]',
      ),
    ).toHaveCount(0);
    await expect(dependencyReview).not.toContainText('$ARGUMENTS');
    await expect(dependencyReview).not.toContainText('$PR_NUMBER');
    await expect(dependencyReview).not.toContainText('/g');
    await expect(dependencyReview).not.toContainText(
      'referenced dependency file is missing',
    );
    await expect(dependencyReview).not.toContainText(
      'dependency file may contain a credential',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('project pipeline sharing constrains and packages dot-named repo-local commands', async () => {
  const { electronApp, userDataDir, demoSeed } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-npm-nest-monorepo'],
  });
  const sourceWorkspace = demoSeed.workspaces.find(
    (workspace) => workspace.id === 'demo-ts-npm-nest-monorepo',
  );
  expect(sourceWorkspace, 'source demo workspace').toBeTruthy();

  const pipelinePath = path.join(
    sourceWorkspace.worktreePath,
    '.canopy',
    'pipelines',
    'quality-check.yml',
  );
  const commandDir = path.join(
    sourceWorkspace.worktreePath,
    '.claude',
    'commands',
  );
  mkdirSync(commandDir, { recursive: true });
  const commandPath = path.join(commandDir, 'collect.py.md');
  writeFileSync(
    commandPath,
    '# Collect\nRead [local settings](../settings.local.json).\n',
  );
  writeFileSync(
    path.join(sourceWorkspace.worktreePath, '.claude', 'settings.local.json'),
    '{"permissions":{"allow":["Bash(*)"]}}\n',
  );
  writeFileSync(
    pipelinePath,
    [
      'name: Repo-local project review',
      'on: dispatch',
      'jobs:',
      '  review:',
      '    steps:',
      '      - id: repair',
      '        uses: builtin/agent-prompt',
      '        with:',
      '          model: opus',
      '          prompt: Run /collect.py.',
      '',
    ].join('\n'),
  );

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const saveResult = await window.evaluate(
      async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      'csk_project_pipeline_share_e2e',
    );
    expect(saveResult.status.authenticated).toBe(true);
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });

    const selectWorkspace = async (workspaceId) => {
      const row = window
        .locator(`[data-sidebar-workspace-id="${workspaceId}"]`)
        .getByTestId('worktree-row')
        .first();
      await expect(row).toBeVisible();
      await row.evaluate((element) => element.click());
      await expect(
        window.locator(
          `[data-sidebar-selected-item] [data-project-id="${workspaceId}"][data-worktree-id]`,
        ),
      ).toHaveCount(1);
    };

    await app.openMainPage();
    await selectWorkspace(sourceWorkspace.id);
    await app.openPipelinesPage();
    // Project rows are keyed by their file path, so find this one by name.
    await app.openWorkflowsLibraryRow(
      app.workflowsLibraryRowByName('Repo-local project review'),
    );
    // Share sits in the Workflows edit shell's actions bar (CAN-4072).
    const shell = window.getByTestId('workflow-edit-shell');
    await expect(shell).toHaveAttribute('data-kind', 'pipeline');
    await shell
      .getByTestId('workflow-edit-actions')
      .getByTestId('pipeline-share')
      .click();

    const dependencyReview = window.getByTestId('share-pipeline-dependencies');
    await expect(dependencyReview).toBeVisible();
    await expect(dependencyReview).not.toHaveAttribute(
      'data-state',
      'loading',
      { timeout: 15_000 },
    );
    await expect(dependencyReview).toHaveAttribute('data-state', 'blocked');
    await expect(
      dependencyReview.locator('[data-code="SOURCE_PATH_ESCAPE"]'),
    ).toHaveCount(1);
    writeFileSync(commandPath, '# Collect\nGather the current results.\n');
    // Returning to the window rechecks a blocked review on its own.
    await window.evaluate(() => globalThis.dispatchEvent(new Event('focus')));
    await expect(dependencyReview).not.toHaveAttribute(
      'data-state',
      'loading',
      { timeout: 15_000 },
    );
    await expect(dependencyReview).toHaveAttribute('data-state', 'ready');
    // The automatic recheck resets the review; expand its fresh file list.
    const dependenciesToggle = window.getByTestId(
      'share-pipeline-dependencies-toggle',
    );
    await dependenciesToggle.click();
    await expect(dependenciesToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(dependencyReview).toContainText('/collect.py');
    await expect(dependencyReview).toContainText('Local source');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
