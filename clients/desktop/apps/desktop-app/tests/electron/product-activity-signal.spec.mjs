import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
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
} from './seeders/index.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';

// CAN-3561: a chat turn is counted as basic desktop usage whatever the
// activity-sharing scopes are set to. A paid member with every scope Off sends
// one turn in an org-owned worktree. The mock cloud must receive exactly one
// product-activity signal for it (hashed turn key, desktop surface, owner
// organization) and no telemetry ingest at all, including after the quit
// drain.

const API_KEY = 'csk_can3561_activity_signal';
const WORKTREE = 'acme-activity-signal';
const MARKER = 'Canopy-C3561SIGNAL';
// Mirrors `MAX_TELEMETRY_CLIENT_ID_LENGTH`: below it the telemetry clamp is
// the identity, so the key is the digest of the audit entry ID itself.
const MAX_CLIENT_ID_LENGTH = 128;

const ENV = {
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    'canopy-shared-org-projects-enabled': true,
  }),
  CANOPY_E2E_ORG_PROJECT_AUTO_CONVERT: 'off',
};

// Off stands on every plan; the paid entitlements only keep the account's
// subscription display realistic.
const PAID_ENTITLEMENTS = {
  plan: { key: 'pro', displayName: 'Pro' },
  source: 'subscription',
  trial: null,
  capabilities: ['data_sync_control'],
  coveringOrgs: [],
  billingManageableOrg: null,
};

const ALL_OFF = {
  metadata: 'off',
  plans: 'off',
  summaries: 'off',
  transcripts: 'off',
};

function seedFixture(userDataDir) {
  seedOrgContextScoping(userDataDir, {
    personalWorktreeIds: [],
    organizationWorktreeIds: [WORKTREE],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: ORG_CONTEXT_WORKSPACE,
    worktreeId: WORKTREE,
    providerType: 'claude',
    tabs: [{ id: `${WORKTREE}-chat`, title: 'Chat', model: 'sonnet' }],
  });
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      telemetrySharing: ALL_OFF,
      telemetrySharingPromptSeen: true,
    },
  });
}

/** The finished audit entry ID for the worktree, once the turn has completed. */
function finishedTurnId(userDataDir) {
  const auditDir = path.join(userDataDir, 'agent-observability', 'audit');
  if (!existsSync(auditDir)) return null;
  for (const file of readdirSync(auditDir)) {
    const lines = readFileSync(path.join(auditDir, file), 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.worktreeId === WORKTREE && entry.status !== 'running') {
        return entry.id;
      }
    }
  }
  return null;
}

async function activityLabels(prefix) {
  const { activity } = await getScenarioActivity(
    DEFAULT_MOCK_BASE_URL,
    API_KEY,
  );
  return Object.entries(activity).filter(([label]) => label.startsWith(prefix));
}

test('CAN-3561: a turn with every sharing scope Off sends one activity signal and no telemetry', async () => {
  test.setTimeout(180_000);
  await registerScenario(DEFAULT_MOCK_BASE_URL, API_KEY, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      entitlements: PAID_ENTITLEMENTS,
      recordTelemetryIngest: true,
      recordProductActivity: true,
    },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, MARKER, {
    llm: {
      steps: [
        {
          text: 'The change is summarized for the activity signal test',
          stopReason: 'end_turn',
        },
      ],
    },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can3561-'));
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

    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await app.selectWorktree(WORKTREE);
    const panel = window.getByTestId('panel-content-chat');
    await expect(panel).toBeVisible();
    const message = `[${MARKER}] Summarize the change.`;
    const composer = window.getByRole('textbox').first();
    await composer.click();
    await composer.fill(message);
    await window.getByRole('button', { name: 'Send message' }).click();
    await expect(panel.getByText(message).first()).toBeVisible({
      timeout: 30_000,
    });

    // The signal is sent at turn start and is not part of the quit drain, so
    // it must have arrived before the app closes.
    await expect
      .poll(async () => (await activityLabels('productActivityTurn:')).length, {
        timeout: 60_000,
      })
      .toBe(1);
    await expect
      .poll(() => finishedTurnId(userDataDir), { timeout: 90_000 })
      .not.toBeNull();
    const turnId = finishedTurnId(userDataDir);
    expect(turnId.length).toBeLessThanOrEqual(MAX_CLIENT_ID_LENGTH);
    const turnKey = createHash('sha256').update(turnId, 'utf8').digest('hex');

    // Every scope stayed Off for the whole turn.
    const stored = JSON.parse(
      readFileSync(path.join(userDataDir, 'preferences.json'), 'utf8'),
    ).preferences;
    expect(stored.telemetrySharing).toEqual(ALL_OFF);

    // Quitting drains whatever telemetry was queued; nothing should be.
    await closeCanopy(electronApp, userDataDir);
    closed = true;

    // One request, declared as desktop, attributed to the owning organization,
    // keyed by the digest of the audit entry ID.
    expect(await activityLabels('productActivityTurn:')).toEqual([
      [`productActivityTurn:desktop:${ORG_CONTEXT_A}:${turnKey}`, 1],
    ]);
    expect(await activityLabels('telemetryIngest')).toEqual([]);
  } finally {
    if (!closed) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, API_KEY);
    await clearScenario(DEFAULT_MOCK_BASE_URL, MARKER);
  }
});
