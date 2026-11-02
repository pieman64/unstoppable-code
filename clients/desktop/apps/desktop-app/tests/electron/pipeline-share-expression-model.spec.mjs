// Publisher dependency review for a pipeline whose step model is chosen at
// run time — durable Electron coverage.
//
// The reported defect: a step `model:` written as a `${{ ... }}` expression
// (here a `providers` choice input selecting the model through parseJson)
// contains whitespace, and the dependency check validated the raw expression
// as a model id and threw. The Share dialog showed only "Couldn't check what
// this pipeline needs", and Retry could never succeed.
//
// This walks the real flow (Library -> open pipeline in the edit shell -> Share) and asserts
// the analysis completes: the section is ready rather than in its error
// state, and the Claude variant's `/open-pr` command was found and packaged.
//
// Testids exercised:
//   - `share-pipeline-dependencies`              -> section root + data-state
//   - `share-pipeline-dependencies-help`         -> names what resolved
//   - `share-pipeline-dependencies-error-reason` -> must NOT render
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { registerShareMembership } from './seeders/index.mjs';
import {
  EXPRESSION_MODEL_PIPELINE_ID,
  seedPipelineShareExpressionModel,
} from './seeders/seedPipelineShareUnresolvedInvocations.mjs';

test('sharing a pipeline with an expression-valued model analyzes its dependencies', async () => {
  await registerShareMembership('csk_expression_model_share_e2e');
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-expression-model-share-'),
  );
  seedPipelineShareExpressionModel(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const saveResult = await window.evaluate(
      async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      'csk_expression_model_share_e2e',
    );
    expect(saveResult.status.authenticated).toBe(true);
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });

    await app.openPipelinesPage();
    await app.openWorkflowsLibraryRow(
      app.workflowsLibraryPipelineRow(EXPRESSION_MODEL_PIPELINE_ID),
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
    await expect(dependencyReview).toHaveAttribute('data-state', 'ready', {
      timeout: 20_000,
    });
    await expect(dependencyReview).not.toContainText(
      "Couldn't check the included files. Try again.",
    );
    await expect(
      window.getByTestId('share-pipeline-dependencies-error-reason'),
    ).toHaveCount(0);
    await window.getByTestId('share-pipeline-dependencies-help').hover();
    await expect(
      window.getByTestId('share-pipeline-dependencies-help-details'),
    ).toContainText('/open-pr');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
