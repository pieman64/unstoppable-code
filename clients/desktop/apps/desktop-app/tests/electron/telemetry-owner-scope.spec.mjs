import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
  seedOrgContextScoping,
  seedWorktreeChat,
  ORG_CONTEXT_A,
  ORG_CONTEXT_ORGANIZATIONS,
  ORG_CONTEXT_WORKSPACE,
  PERSONAL_CONTEXT_WORKSPACE,
} from './seeders/index.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';

// CAN-3515: activity counts only in the scope that owns the work, never the
// sidebar selection. A member starts a turn in an org-owned worktree, switches
// to Personal while it runs, and the finished turn must still reach the org.
// Then a turn in a Personal worktree finishes while the org is selected, and
// must stay private. Delivery is observed at the mock cloud's telemetry ingest,
// which records each request's destination per worktree; quitting drains the
// queue, so no debounce wait is needed.

const API_KEY = 'csk_can3515_owner_scope';
const ORG_WORKTREE = 'acme-owner-scope';
const PERSONAL_WORKTREE = 'personal-owner-scope';
const ORG_MARKER = 'Canopy-C3515ORG';
const PERSONAL_MARKER = 'Canopy-C3515PERSONAL';
// Long enough to switch the sidebar context while the reply still streams.
const STREAM_MS = 12_000;
const ORG_DESTINATION = `organization:${ORG_CONTEXT_A}`;
const PRIVATE_DESTINATION = 'private:none';

const ENV = {
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    'canopy-shared-org-projects-enabled': true,
  }),
  CANOPY_E2E_ORG_PROJECT_AUTO_CONVERT: 'off',
};

function seedFixture(userDataDir) {
  seedOrgContextScoping(userDataDir, {
    personalWorktreeIds: [PERSONAL_WORKTREE],
    organizationWorktreeIds: [ORG_WORKTREE],
  });
  for (const [workspaceId, worktreeId] of [
    [ORG_CONTEXT_WORKSPACE, ORG_WORKTREE],
    [PERSONAL_CONTEXT_WORKSPACE, PERSONAL_WORKTREE],
  ]) {
    seedWorktreeChat({
      userDataDir,
      workspaceId,
      worktreeId,
      providerType: 'claude',
      tabs: [{ id: `${worktreeId}-chat`, title: 'Chat', model: 'sonnet' }],
    });
  }
  // Every kind shared at organization scope: where it lands is decided only
  // by who owns the work.
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      telemetrySharing: {
        metadata: 'organization',
        transcripts: 'organization',
        plans: 'organization',
        summaries: 'organization',
      },
    },
  });
}

/** The finished audit entry for a worktree, once the turn has completed. */
function finishedTurnId(userDataDir, worktreeId) {
  const auditDir = path.join(userDataDir, 'agent-observability', 'audit');
  if (!existsSync(auditDir)) return null;
  for (const file of readdirSync(auditDir)) {
    const lines = readFileSync(path.join(auditDir, file), 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.worktreeId === worktreeId && entry.status !== 'running') {
        return entry.id;
      }
    }
  }
  return null;
}

async function startTurn(window, app, worktreeId, marker) {
  await app.selectWorktree(worktreeId);
  const panel = window.getByTestId('panel-content-chat');
  await expect(panel).toBeVisible();
  const message = `[${marker}] Summarize the change.`;
  const composer = window.getByRole('textbox').first();
  await composer.click();
  await composer.fill(message);
  await window.getByRole('button', { name: 'Send message' }).click();
  await expect(panel.getByText(message).first()).toBeVisible({
    timeout: 30_000,
  });
  // The reply is streaming: the turn is running but not finished.
  await expect(
    window.getByRole('button', { name: 'Stop generation', exact: true }),
  ).toBeVisible({ timeout: 30_000 });
}

test('counts a turn for the scope that owns the work, whatever is selected when it finishes', async () => {
  test.setTimeout(240_000);
  await registerScenario(DEFAULT_MOCK_BASE_URL, API_KEY, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      recordTelemetryIngest: true,
    },
  });
  for (const marker of [ORG_MARKER, PERSONAL_MARKER]) {
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: {
        steps: [
          {
            text: 'The change is summarized for the owner scope test',
            streamMs: STREAM_MS,
            stopReason: 'end_turn',
          },
        ],
      },
    });
  }
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can3515-'));
  seedFixture(userDataDir);
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir, env: ENV }),
  );
  let closed = false;
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, API_KEY);
    await app.openMainPage();

    // Org-owned work, finished while Personal is selected.
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await startTurn(window, app, ORG_WORKTREE, ORG_MARKER);
    await selectWorkspaceContext(window, 'personal');
    await expect
      .poll(() => finishedTurnId(userDataDir, ORG_WORKTREE), {
        timeout: 90_000,
      })
      .not.toBeNull();
    const orgTurnId = finishedTurnId(userDataDir, ORG_WORKTREE);

    // Personal work, finished while the organization is selected.
    await startTurn(window, app, PERSONAL_WORKTREE, PERSONAL_MARKER);
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await expect
      .poll(() => finishedTurnId(userDataDir, PERSONAL_WORKTREE), {
        timeout: 90_000,
      })
      .not.toBeNull();
    const personalTurnId = finishedTurnId(userDataDir, PERSONAL_WORKTREE);

    // Quitting drains the telemetry queue to the mock cloud.
    await closeCanopy(electronApp, userDataDir);
    closed = true;

    const { activity } = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      API_KEY,
    );
    // Every destination a worktree's requests, or one turn, reached.
    const destinations = (prefix, suffix) =>
      Object.keys(activity)
        .filter((label) => label.startsWith(prefix) && label.endsWith(suffix))
        .map((label) => label.slice(prefix.length, -suffix.length))
        .sort();
    expect(
      destinations('telemetryIngestTurn:', `:${ORG_WORKTREE}:${orgTurnId}`),
    ).toEqual([ORG_DESTINATION]);
    expect(
      destinations(
        'telemetryIngestTurn:',
        `:${PERSONAL_WORKTREE}:${personalTurnId}`,
      ),
    ).toEqual([PRIVATE_DESTINATION]);
    // Personal work never reaches an organization, not even its envelope.
    expect(destinations('telemetryIngest:', `:${PERSONAL_WORKTREE}`)).toEqual([
      PRIVATE_DESTINATION,
    ]);
  } finally {
    if (!closed) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, API_KEY);
    await clearScenario(DEFAULT_MOCK_BASE_URL, ORG_MARKER);
    await clearScenario(DEFAULT_MOCK_BASE_URL, PERSONAL_MARKER);
  }
});
