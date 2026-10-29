import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  SHARE_MEMBERSHIP_ORGANIZATION,
  SHARE_MEMBERSHIP_TEAM,
  seedObservabilityAudit,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { startRunCommentsCloudMock } from './runCommentsCloudMock.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'seeded-chat-1';
const TURN_BASE_MS = Date.parse('2026-08-11T09:00:00.000Z');
const REVIEWER_BODY = 'This tool call looks wrong to me.';
const REPLY_BODY = 'Good catch — fixed in the follow-up turn.';
// Sessions are shared with a team or organization only, so the share specs
// sign in as a member of one organization with one team.
const SHARE_MEMBERSHIP = {
  organizations: [SHARE_MEMBERSHIP_ORGANIZATION],
  teams: [SHARE_MEMBERSHIP_TEAM],
};

function completedTurnMessages() {
  return [
    {
      id: 'turn-1-user',
      role: 'user',
      blocks: [{ type: 'text', text: 'Please review this run.' }],
      timestamp: TURN_BASE_MS,
    },
    {
      id: 'turn-1-assistant',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Seeded shared-run transcript.' }],
      timestamp: TURN_BASE_MS + 5_000,
    },
    {
      id: 'turn-1-timer',
      role: 'system',
      blocks: [
        {
          type: 'turn_timer',
          startedAt: TURN_BASE_MS,
          completedAt: TURN_BASE_MS + 90_000,
        },
      ],
      timestamp: TURN_BASE_MS + 6_000,
    },
  ];
}

function recentAuditEntries() {
  const nowMs = Date.now();
  return [
    {
      id: 'share-eligibility-entry-1',
      eventType: 'worktree_chat',
      status: 'success',
      provider: 'claude',
      label: 'Seeded shareable turn',
      startedAt: new Date(nowMs - 15 * 60_000).toISOString(),
      completedAt: new Date(nowMs - 14 * 60_000).toISOString(),
      durationMs: 60_000,
      model: 'claude-sonnet-4-6',
      tokens: {
        input: 1200,
        output: 300,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      messageCount: 2,
      assistantMessageCount: 1,
      toolUseCount: 0,
      subAgentCount: 0,
      toolCounts: {},
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      hasTranscript: false,
    },
  ];
}

async function connectCloud(window, apiKey) {
  const result = await window.evaluate(
    async (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
    apiKey,
  );
  expect(result.status.authenticated).toBe(true);
}

async function launchRunFixture({ cloud, sharedRun, seedAudit = false }) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'run-comments-e2e-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: sharedRun ? 'Shared run with comments' : 'Unshared session',
        providerType: 'claude',
        messages: completedTurnMessages(),
        ...(sharedRun ? { sharedRun } : {}),
      },
    ],
  });
  if (seedAudit) {
    seedObservabilityAudit({ userDataDir, entries: recentAuditEntries() });
  }
  const launched = await launchCanopy({
    userDataDir,
    env: cloud
      ? {
          CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl,
        }
      : undefined,
  });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    if (cloud) await connectCloud(window, 'csk_run_comments_e2e');
    await app.selectWorktree(WORKTREE_ID);
    await app.expectMainPage();
    await expect(window.getByTestId('panel-content-chat')).toBeVisible({
      timeout: 30_000,
    });
    await expect(window.getByTestId('turn-timer').first()).toBeVisible({
      timeout: 30_000,
    });
    return { ...launched, app, window };
  } catch (error) {
    await closeCanopy(launched.electronApp, userDataDir).catch(() => undefined);
    throw error;
  }
}

async function openShareModal(window) {
  const shareControl = window.getByTestId('turn-share-session');
  await expect(shareControl).toHaveAttribute('data-shared', 'false');
  await shareControl.click();
  const modal = window.getByTestId('share-run-modal');
  await expect(modal).toBeVisible({ timeout: 30_000 });
  return modal;
}

test('shared comments show unread state and round-trip reply and resolution', async () => {
  test.setTimeout(180_000);
  const cloud = await startRunCommentsCloudMock({
    seededThreadBody: REVIEWER_BODY,
  });
  let launched;
  try {
    launched = await launchRunFixture({
      cloud,
      sharedRun: {
        externalId: cloud.runExternalId,
        shareScope: 'team',
        sharedAt: '2026-08-11T09:00:00.000Z',
        commentRevision: 1,
        unreadCommentCount: 2,
      },
    });
    const { window } = launched;
    await expect(window.getByTestId('turn-share-session')).toHaveAttribute(
      'data-shared',
      'true',
    );
    await expect(window.getByTestId('turn-share-session-unread')).toHaveCount(
      0,
    );

    const commentsButton = window.getByTestId('turn-run-comments');
    await expect(commentsButton).toHaveAttribute('data-unread-count', '2');
    await commentsButton.click();

    const modal = window.getByTestId('run-comments-modal');
    await expect(modal).toBeVisible({ timeout: 30_000 });
    await expect(modal).toContainText('Shared run with comments');
    const thread = modal.getByTestId('run-comment-thread').first();
    await expect(thread).toContainText(REVIEWER_BODY);
    await expect(thread).toHaveAttribute('data-thread-status', 'open');
    await expect(commentsButton).toHaveAttribute('data-unread-count', '0');

    const revisionBeforeReply = cloud.state.commentRevision;
    await modal.getByTestId('run-comment-reply-input').fill(REPLY_BODY);
    await modal.getByTestId('run-comment-reply-submit').click();
    await expect(modal.getByTestId('run-comment')).toHaveCount(2);
    await expect(thread).toContainText(REPLY_BODY);
    expect(cloud.state.commentRevision).toBe(revisionBeforeReply + 1);
    expect(cloud.state.threads[0].comments.at(-1).body).toBe(REPLY_BODY);
    expect(
      cloud.requests.some(
        ({ method, pathname }) =>
          method === 'POST' &&
          pathname.includes(`/runs/${cloud.runExternalId}/comments/`),
      ),
    ).toBe(true);

    await modal.getByTestId('run-comment-resolve-toggle').first().click();
    await expect(thread).toHaveAttribute('data-thread-status', 'resolved');
    expect(cloud.state.threads[0].status).toBe('resolved');
  } finally {
    if (launched) {
      await closeCanopy(launched.electronApp, launched.userDataDir);
    }
    await cloud.close();
  }
});

test('Share again reopens a persisted team run as an update', async () => {
  test.setTimeout(180_000);
  const cloud = await startRunCommentsCloudMock(SHARE_MEMBERSHIP);
  let launched;
  try {
    launched = await launchRunFixture({
      cloud,
      seedAudit: true,
      sharedRun: {
        externalId: cloud.runExternalId,
        shareScope: 'team',
        teamId: SHARE_MEMBERSHIP_TEAM.id,
        teamName: SHARE_MEMBERSHIP_TEAM.name,
        organizationId: SHARE_MEMBERSHIP_ORGANIZATION.id,
        organizationName: SHARE_MEMBERSHIP_ORGANIZATION.name,
        sharedAt: '2026-08-11T09:00:00.000Z',
      },
    });
    const { window } = launched;
    await window.getByTestId('turn-share-session').click();
    await window.getByText('Share again', { exact: true }).click();

    const modal = window.getByTestId('share-run-modal');
    await expect(modal).toBeVisible({ timeout: 30_000 });
    await expect(modal.getByTestId('share-run-scope-team')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(modal.getByTestId('share-run-submit')).toHaveText('Update');
    await expect(modal.getByTestId('share-run-submit')).toBeEnabled();
  } finally {
    if (launched) {
      await closeCanopy(launched.electronApp, launched.userDataDir);
    }
    await cloud.close();
  }
});

test('unshared session footer does not expose comments', async () => {
  test.setTimeout(180_000);
  const launched = await launchRunFixture({ sharedRun: null });
  try {
    await expect(
      launched.window.getByTestId('turn-share-session'),
    ).toHaveAttribute('data-shared', 'false');
    await expect(launched.window.getByTestId('turn-run-comments')).toHaveCount(
      0,
    );
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

test('expired session blocks scope and submit with a retention explanation', async () => {
  test.setTimeout(180_000);
  const cloud = await startRunCommentsCloudMock({});
  let launched;
  try {
    launched = await launchRunFixture({ cloud, sharedRun: null });
    const modal = await openShareModal(launched.window);
    const blocked = modal.getByTestId('share-run-unavailable');
    await expect(blocked).toBeVisible({ timeout: 30_000 });
    await expect(blocked).toContainText('can no longer be shared');
    await expect(blocked).toContainText('7-day window');
    await expect(blocked).toContainText('Agent observability');
    await expect(modal.getByTestId('share-run-scope')).toHaveCount(0);
    await expect(modal.getByTestId('share-run-submit')).toHaveCount(0);
  } finally {
    if (launched) {
      await closeCanopy(launched.electronApp, launched.userDataDir);
    }
    await cloud.close();
  }
});

test('recent session permits choosing scope and submitting a share', async () => {
  test.setTimeout(180_000);
  const cloud = await startRunCommentsCloudMock(SHARE_MEMBERSHIP);
  let launched;
  try {
    launched = await launchRunFixture({
      cloud,
      sharedRun: null,
      seedAudit: true,
    });
    const modal = await openShareModal(launched.window);
    await expect(modal.getByTestId('share-run-scope')).toBeVisible({
      timeout: 30_000,
    });
    // Sessions offer no Private audience; Team is preselected for a member.
    await expect(modal.getByTestId('share-run-scope-private')).toHaveCount(0);
    await expect(modal.getByTestId('share-run-scope-public')).toHaveCount(0);
    await expect(modal.getByTestId('share-run-scope-team')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(modal.getByTestId('share-run-submit')).toBeVisible();
    await expect(modal.getByTestId('share-run-unavailable')).toHaveCount(0);
    await expect(modal.getByTestId('share-run-disclaimer')).toContainText(
      'redacted',
    );

    // Submitting waits for a target: picking the team enables it.
    await expect(modal.getByTestId('share-run-submit')).toBeDisabled();
    await modal
      .getByTestId(`share-run-team-picker-option-${SHARE_MEMBERSHIP_TEAM.id}`)
      .click();
    await expect(modal.getByTestId('share-run-submit')).toBeEnabled();
  } finally {
    if (launched) {
      await closeCanopy(launched.electronApp, launched.userDataDir);
    }
    await cloud.close();
  }
});
