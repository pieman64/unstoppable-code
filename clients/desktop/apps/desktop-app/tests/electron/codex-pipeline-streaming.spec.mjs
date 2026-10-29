// Codex pipeline live-streaming regression coverage.
//
// What changed: Codex pipeline steps now stream transcript output into the
// step log / details modal and into running Audit Trail entries while the turn
// is still executing. Audit token accounting also derives response deltas from
// Codex's thread-cumulative snapshots, so a multi-response turn keeps all 132
// tokens instead of replacing the first 120 with the latest response's 12.
// The fixture also emits a large restored-turn snapshot before turn.started;
// it must update context only and never inflate the active turn or Audit Trail.
//
// The run is driven by the mock Codex
// app-server fixture (no live agent, no network). Its `staged` mode emits
// a restored-turn usage snapshot, eight agent messages, parks the new turn at
// a filesystem release barrier, then emits eight more and completes — so "the
// turn is still running" is a proven state rather than a timing race.
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  closeFixture,
  createFixture,
  openWorkspaceAndRun,
  pipelineYaml,
  seedPreferences,
} from './codexPipelineRuntime.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { launchCanopy } from './launchCanopy.mjs';
import { closePipelineRunPanels, showPipelineJobList } from './pipelineUi.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';

test.describe('Codex pipeline live streaming', () => {
  test('streams Codex agent output into the details modal while the turn is running', async () => {
    test.setTimeout(180_000);
    const name = 'E2E Codex Live Streaming';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-codex-streaming-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedPreferences(userDataDir);
    seedStoredPipeline({
      userDataDir,
      id: 'e2e-codex-live-streaming',
      name,
      yaml: pipelineYaml(name),
    });
    const fixture = createFixture('staged');
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: fixture.env,
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      const card = await openWorkspaceAndRun(window, name);
      await expect(card).toContainText('running', { timeout: 30_000 });

      // Audit Trail, while the turn is provably held open at the barrier: the
      // running entry must expose live details (message and token accounting
      // from streamed events) and a viewable transcript.
      await app.openAuditPage();
      const auditTranscriptButton = window
        .locator('[data-testid^="audit-transcript-button-pipeline:"]')
        .first();
      await expect(auditTranscriptButton).toBeVisible({ timeout: 30_000 });
      await expect(window.getByText('Pipeline Agent').first()).toBeVisible();
      await expect(window.getByText('8 messages')).toBeVisible({
        timeout: 30_000,
      });
      await expect(window.getByText('120 tokens')).toBeVisible({
        timeout: 30_000,
      });
      await auditTranscriptButton.click();
      await expect(window.getByTestId('audit-transcript-modal')).toBeVisible();
      await window.getByTestId('audit-transcript-mode-raw').click();
      await expect(window.getByTestId('audit-transcript-raw')).toContainText(
        'E2E_CODEX_STREAM_000',
        { timeout: 30_000 },
      );
      await expect(window.getByTestId('audit-transcript-raw')).toContainText(
        '"type":"thread.token_usage.updated"',
      );
      await window
        .getByRole('dialog')
        .getByRole('button', { name: 'Close' })
        .click();
      await expect(window.getByTestId('audit-transcript-modal')).toBeHidden();
      await app.openMainPage();

      const jobDot = card.locator('[data-job-id="verify"]');
      await expect(jobDot).toHaveAttribute(
        'aria-label',
        'Verify Codex runtime: running',
        { timeout: 30_000 },
      );
      await jobDot.click();
      await showPipelineJobList(window, { timeout: 15_000 });
      await expect(
        window.getByTestId('pipeline-job-view-verify'),
      ).toBeVisible();
      const output = window.getByTestId('pipeline-step-log-output-codex');

      // The turn is provably still open (the fixture is parked at the release
      // barrier), so this assertion requires live output rather than terminal
      // transcript hydration.
      await expect(card).toContainText('running');
      await expect(output).toContainText('E2E_CODEX_STREAM_007', {
        timeout: 30_000,
      });

      writeFileSync(fixture.releasePath, 'release\n', 'utf8');

      // The already-open run panel receives phase two and the terminal transition
      // without being reopened.
      await expect(output).toContainText('E2E_CODEX_STREAM_015', {
        timeout: 30_000,
      });
      await expect(card).toContainText('success', { timeout: 60_000 });
      await expect(jobDot).toHaveAttribute(
        'aria-label',
        'Verify Codex runtime: success',
      );
      // Raw mode must contain every marker exactly once: an incremental stream
      // followed by a full-transcript re-emission would duplicate.
      const rawButton = window.getByTestId('pipeline-step-log-mode-raw-codex');
      await rawButton.click();
      await expect(rawButton).toHaveAttribute('aria-pressed', 'true');
      const expectedMarkers = Array.from(
        { length: 16 },
        (_, index) => `E2E_CODEX_STREAM_${String(index).padStart(3, '0')}`,
      );
      await expect
        .poll(
          async () => {
            const text = (await output.textContent()) ?? '';
            return text.match(/E2E_CODEX_STREAM_\d{3}/g) ?? [];
          },
          {
            message: 'expected exactly 16 ordered stream markers, no dupes',
            timeout: 30_000,
          },
        )
        .toEqual(expectedMarkers);

      // Completed accuracy in the Audit Trail: all sixteen staged messages
      // plus the final reply, and both token-usage responses (120 + 12). The
      // the cumulative total rather than the old terminal overwrite (12).
      await closePipelineRunPanels(window);
      await app.openAuditPage();
      await expect(window.getByText('17 messages')).toBeVisible({
        timeout: 30_000,
      });
      await expect(window.getByText('132 tokens')).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
    }
  });
});
