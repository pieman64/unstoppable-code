// Publisher dependency review on a BLOCKED analysis — durable Electron coverage.
//
// The reported defect was one screen: "No local dependency files were detected."
// rendered directly above ~20 red rows, with the recipient setup list gone. This
// walks the real flow (Library -> open pipeline in the edit shell -> Share) and asserts the
// three behaviours that replaced it:
//
//   1. A blocked analysis still shows what DID resolve, and never claims the
//      package is empty.
//   2. Path-shaped prose (`/collect.py`, `/notes/report.md`) produces no row at
//      all, while one genuinely missing command produces ONE row with its steps
//      rolled up.
//   3. "mark it as not a command" exists only on that row — a `.git/config` security
//      finding has no dismiss control, and dismissing cannot clear it.
//
// Testids exercised:
//   - `share-pipeline-dependencies`            -> section root + data-state
//   - `share-pipeline-dependencies-toggle`     -> expands the collapsed review
//   - `share-pipeline-dependency-problems`     -> grouped problem list
//   - `share-pipeline-dependencies-empty`      -> the empty state that must NOT render
//   - `share-pipeline-dependencies-list`       -> what resolved anyway
//   - `share-pipeline-dependency-problems-dismiss-*` -> per-row inline escape hatch
//   - `share-pipeline-dependency-problems-dismissed-*` -> audit disclosure
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  registerShareMembership,
  SHARE_MEMBERSHIP_TEAM,
} from './seeders/index.mjs';
import {
  clearPipelineShareSecurityAndFrontmatterProblems,
  IGNORED_PATH_TOKEN,
  seedPipelineShareUnresolvedInvocations,
  TRANSITIVE_UNRESOLVED_TOKEN,
  UNRESOLVED_INVOCATION_PIPELINE_ID,
  UNRESOLVED_TOKEN,
} from './seeders/seedPipelineShareUnresolvedInvocations.mjs';

test('blocked pipeline share groups problems beside what still resolved', async () => {
  // Team is only preselected for an account that belongs to one.
  await registerShareMembership('csk_blocked_dependency_share_e2e');
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-blocked-dependency-share-'),
  );
  seedPipelineShareUnresolvedInvocations(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const saveResult = await window.evaluate(
      async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      'csk_blocked_dependency_share_e2e',
    );
    expect(saveResult.status.authenticated).toBe(true);
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });

    await app.openPipelinesPage();
    await app.openWorkflowsLibraryRow(
      app.workflowsLibraryPipelineRow(UNRESOLVED_INVOCATION_PIPELINE_ID),
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
    await expect(dependencyReview).toHaveAttribute('data-state', 'blocked', {
      timeout: 20_000,
    });

    // 1. The contradiction: the empty state cannot render next to content.
    //    The review is collapsed by default, so expand it before checking
    //    what resolved.
    await window.getByTestId('share-pipeline-dependencies-toggle').click();
    await expect(
      window.getByTestId('share-pipeline-dependencies-empty'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('share-pipeline-dependencies-list'),
    ).toBeVisible();
    await expect(dependencyReview).toContainText('/open-pr');

    // 2. Path-shaped prose never becomes a problem; the real miss becomes one
    //    row carrying both of its steps.
    const problems = window.getByTestId('share-pipeline-dependency-problems');
    await expect(problems).toBeVisible();
    await expect(problems).not.toContainText(IGNORED_PATH_TOKEN);
    await expect(problems).not.toContainText('report.md');

    const unresolvedRow = problems.locator(
      `[data-code="UNRESOLVED_INVOCATION"][data-subject="${UNRESOLVED_TOKEN}"]`,
    );
    await expect(unresolvedRow).toHaveCount(1);
    await expect(unresolvedRow).toHaveAttribute(
      'data-subject',
      UNRESOLVED_TOKEN,
    );
    await expect(unresolvedRow).toContainText(
      `${UNRESOLVED_TOKEN} was not found`,
    );
    await expect(unresolvedRow).toContainText('Used in 2 steps');
    await unresolvedRow
      .getByRole('button', { name: 'Used in 2 steps' })
      .click();
    await expect(unresolvedRow).toContainText('ship.repair');
    await expect(unresolvedRow).toContainText('ship.verify');

    // 3. The security row is not the publisher's to wave away.
    const securityRow = problems.locator('[data-code="EXPORT_DENIED_FILE"]');
    await expect(securityRow).toHaveCount(1);
    await expect(securityRow).toHaveAttribute('data-dismissible', 'false');
    await expect(
      securityRow.locator(
        '[data-testid^="share-pipeline-dependency-problems-dismiss-"]',
      ),
    ).toHaveCount(0);

    const transitiveRow = problems.locator(
      `[data-subject="${TRANSITIVE_UNRESOLVED_TOKEN}"]`,
    );
    await expect(transitiveRow).toHaveCount(1);
    await expect(transitiveRow).toHaveAttribute('data-dismissible', 'false');
    await expect(
      transitiveRow.locator(
        '[data-testid^="share-pipeline-dependency-problems-dismiss-"]',
      ),
    ).toHaveCount(0);

    const problemCountBefore =
      await problems.getAttribute('data-problem-count');
    expect(problemCountBefore).toBe('3');

    await unresolvedRow
      .locator('[data-testid^="share-pipeline-dependency-problems-dismiss-"]')
      .click();

    // The dismissal re-runs the main-process analysis and is echoed back.
    await expect(problems).toHaveAttribute('data-dismissed-count', '1', {
      timeout: 20_000,
    });
    await expect(
      problems.locator(
        `[data-code="UNRESOLVED_INVOCATION"][data-subject="${UNRESOLVED_TOKEN}"]`,
      ),
    ).toHaveCount(0);
    await window
      .getByRole('button', { name: 'Marked as not commands (1)' })
      .click();
    await expect(
      window.getByTestId(
        'share-pipeline-dependency-problems-dismissed-repair-diffs',
      ),
    ).toContainText(UNRESOLVED_TOKEN);

    // A dismissal can silence a "not a command" complaint and nothing else:
    // the export-denied finding survives and Share stays disabled.
    await expect(problems).toHaveAttribute('data-problem-count', '2');
    await expect(
      problems.locator('[data-code="EXPORT_DENIED_FILE"]'),
    ).toHaveCount(1);
    await expect(window.getByTestId('share-pipeline-submit')).toBeDisabled();

    // Publication consent is retired; nothing but the blockers gates Share.
    await expect(window.getByTestId('share-pipeline-consent')).toHaveCount(0);

    // One card, one button: no Recheck control competes with Fix it with AI.
    await expect(
      window.getByTestId('share-pipeline-dependency-problems-recheck'),
    ).toHaveCount(0);

    // Repair the two real findings on disk, then come back to the window: the
    // dialog rechecks on its own. The existing dismissal remains audited while
    // the package becomes ready without weakening either safety check.
    clearPipelineShareSecurityAndFrontmatterProblems(userDataDir);
    await window.evaluate(() => globalThis.dispatchEvent(new Event('focus')));
    await expect(dependencyReview).toHaveAttribute('data-state', 'ready', {
      timeout: 20_000,
    });
    await expect(problems).toHaveAttribute('data-problem-count', '0');
    await expect(problems).toHaveAttribute('data-dismissed-count', '1');
    await expect(
      problems.locator('[data-code="EXPORT_DENIED_FILE"]'),
    ).toHaveCount(0);
    await expect(
      problems.locator(`[data-subject="${TRANSITIVE_UNRESOLVED_TOKEN}"]`),
    ).toHaveCount(0);

    await expect(window.getByTestId('share-pipeline-consent')).toHaveCount(0);
    await expect(window.getByTestId('share-pipeline-submit')).toBeDisabled();

    // Team is preselected; a team share names its team before it can be
    // sent. Picking the target is the last prerequisite.
    await window
      .getByTestId(
        `share-pipeline-team-picker-option-${SHARE_MEMBERSHIP_TEAM.id}`,
      )
      .click();
    await expect(window.getByTestId('share-pipeline-submit')).toBeEnabled();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
