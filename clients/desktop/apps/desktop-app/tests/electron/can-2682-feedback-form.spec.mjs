import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import yauzl from 'yauzl';
import {
  seedTranscriptRecovery,
  transcriptScope,
} from './transcript-storage-fixture.mjs';
import { connectMockCloudAccount } from './seeders/index.mjs';

// CAN-2682 — the feedback form defaults to "Idea", groups its fields against
// the shared spacing scale, and drops the copy that only restated a control.
//
// Why these assertions and not screenshots: the form's problems were structural
// (a bug-first default, actions that scrolled away with the fields, a context
// block and a diagnostics checkbox saying the same thing in two places), so the
// durable guards are the default, the composition, and the absence of the cut
// copy. Pixel evidence lives in the paired capture spec.
//
// Entry point is the always-mounted sidebar rail button
// (`sidebar-account-action-feedback`), not the overflow menu item, so the spec
// does not depend on the account popover being open.

async function openFeedbackModal(window) {
  await window.getByTestId('sidebar-account-action-feedback').click();
  const modal = window.getByTestId('feedback-modal');
  await expect(modal).toBeVisible();
  return modal;
}

function readZipEntries(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (error, archive) => {
      if (error) {
        reject(error);
        return;
      }
      const entries = new Map();
      archive.on('entry', (entry) => {
        archive.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            reject(streamError);
            return;
          }
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            archive.readEntry();
          });
        });
      });
      archive.on('end', () => resolve(entries));
      archive.on('error', reject);
      archive.readEntry();
    });
  });
}

test('saves canonical JSONL chat evidence from the selected worktree feedback form', async () => {
  const { userDataDir } = await seedTranscriptRecovery();
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    await electronApp.evaluate(({ app, shell, ipcMain }, directory) => {
      app.setPath('downloads', directory);
      shell.showItemInFolder = () => {};
      ipcMain.removeHandler('feedback:submit');
      ipcMain.handle('feedback:submit', () => {
        throw new Error('Offline fixture');
      });
    }, userDataDir);
    await electronApp.evaluate(() =>
      console.info('CAN-3193 feedback main-log marker'),
    );
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30000 });
    await app.openMainPage();
    await app.selectWorktree(transcriptScope.worktreeId);
    const modal = await openFeedbackModal(window);
    await modal
      .getByTestId('feedback-modal-description')
      .fill('Retain JSONL diagnostics for this worktree.');
    await modal.getByTestId('feedback-modal-submit').click();
    await modal.getByTestId('feedback-modal-save-diagnostics').click();
    await expect(
      modal.getByTestId('feedback-modal-saved-message'),
    ).toContainText('Saved');
    const file = readdirSync(userDataDir).find((name) => name.endsWith('.zip'));
    expect(file).toBeTruthy();
    const entries = await readZipEntries(join(userDataDir, file));
    const manifest = JSON.parse(entries.get('feedback.json').toString());
    if (['darwin', 'linux'].includes(manifest.app.platform)) {
      expect(entries.has('system-logs/canopy-ui/main-log-flush.json')).toBe(
        true,
      );
      expect(
        entries.get('system-logs/canopy-ui/main.log')?.toString(),
      ).toContain('CAN-3193 feedback main-log marker');
      expect(manifest.includedFiles).toContain(
        'system-logs/canopy-ui/main.log',
      );
    }
    expect([...entries.keys()]).toContain(
      `workspaces/${transcriptScope.projectId}/chat-storage-v2/${transcriptScope.worktreeId}/transcripts/long.jsonl`,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('opens with Idea preselected and composes fields, attachments, and actions', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    const modal = await openFeedbackModal(window);

    // 1) The form no longer frames every submission as a defect report.
    const idea = modal.getByTestId('feedback-modal-type-idea');
    const bug = modal.getByTestId('feedback-modal-type-bug');
    await expect(idea).toHaveAttribute('aria-checked', 'true');
    await expect(bug).toHaveAttribute('aria-checked', 'false');

    // The preselected option leads the control rather than sitting second.
    const typeLabels = await modal
      .getByRole('radio')
      .evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim()));
    expect(typeLabels).toEqual(['Idea', 'Bug']);

    // 2) Actions sit in a pinned footer, outside the scrolling field region —
    //    previously they were the last item in the same scrolling stack.
    const body = modal.getByTestId('feedback-modal-body');
    const footer = modal.getByTestId('feedback-modal-footer');
    await expect(footer.getByTestId('feedback-modal-submit')).toBeVisible();
    await expect(footer.getByTestId('feedback-modal-cancel')).toBeVisible();
    await expect(body.getByTestId('feedback-modal-submit')).toHaveCount(0);

    // 3) "What gets sent" is one block: the captured context rows and the
    //    diagnostics opt-out no longer answer the same question separately.
    const attachments = modal.getByTestId('feedback-modal-attachments');
    await expect(attachments).toBeVisible();
    await expect(
      attachments.getByTestId('feedback-modal-include-diagnostics'),
    ).toBeVisible();

    // 4) Copy that only restated a visible control is gone.
    await expect(modal).not.toContainText('Auto-captured context');
    await expect(modal).not.toContainText(
      'Something is broken or not working as expected',
    );
    await expect(modal).not.toContainText(
      'A suggestion, feature request, or general feedback',
    );

    // 5) Bug is still one click away, and still asks for reproduction steps —
    //    the per-type placeholder carries information the label does not.
    const description = modal.getByTestId('feedback-modal-description');
    await expect(description).not.toHaveAttribute('placeholder', /reproduce/iu);
    await bug.click();
    await expect(bug).toHaveAttribute('aria-checked', 'true');
    await expect(idea).toHaveAttribute('aria-checked', 'false');
    await expect(description).toHaveAttribute('placeholder', /reproduce/iu);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// The success branch was restructured by CAN-2682 (its `data-testid` moved
// from the wrapping container onto the message, and the Done button moved
// into a footer) but had no coverage — this modal had none at all before this
// change. Submitting for real against the mock cloud route is what proves the
// restructured branch actually renders, rather than asserting on markup that
// nothing ever mounts.
//
// Diagnostics are unchecked before submitting on purpose: leaving them on
// makes `submitFeedback` build a real diagnostics zip before the POST, which
// is slow and depends on the host's observability tree. The mock route also
// returns no `uploadUrl`, so the attachment path stays out of scope here.
test('submits and shows the restructured success state', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await connectMockCloudAccount(window, 'csk_feedback_form_e2e');

    const modal = await openFeedbackModal(window);

    await modal
      .getByTestId('feedback-modal-description')
      .fill('The worktree list scrolls back to the top when a pipeline ends.');
    await modal.getByTestId('feedback-modal-include-diagnostics').uncheck();

    // The heading stays because context rows are still attached — `activePage`
    // and `platform` always populate, so the empty-attachments state the
    // heading is gated on is not reachable from a running app.
    await expect(modal.getByTestId('feedback-modal-context')).toBeVisible();
    await expect(modal).toContainText('Sent with your report');

    await modal.getByTestId('feedback-modal-submit').click();

    const success = modal.getByTestId('feedback-modal-success');
    await expect(success).toBeVisible();
    await expect(success).toContainText('team');
    // The form is gone, and Done sits in the success footer rather than in
    // the scrolling body.
    await expect(modal.getByTestId('feedback-modal-body')).toHaveCount(0);
    await expect(
      modal
        .getByTestId('feedback-modal-success-footer')
        .getByTestId('feedback-modal-done'),
    ).toBeVisible();

    await modal.getByTestId('feedback-modal-done').click();
    await expect(window.getByTestId('feedback-modal')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
