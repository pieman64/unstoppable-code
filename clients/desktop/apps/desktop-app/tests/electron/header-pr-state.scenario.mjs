import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  buildPrStatusData,
  buildPrStatusEvent,
  injectGithubPrStatus,
} from './seeders/index.mjs';

// dzzzgnr/header-chat-opened — worktree header PR/CI states.
//
// The redesigned header (PrStatusBar) groups the archived-chats control with
// the PR and CI state. These states are only reachable with PR status in the
// store, so this shared scenario drives them through the supported
// `injectGithubPrStatus` IPC seam (no live GitHub remote, token, or poller).
// Durable behavior lives in header-pr-state.spec.mjs; the capture wrapper
// supplies an onState callback for reusable visual evidence.
//
// Deterministic: all state comes from `seedDemoWorkspaces` plus the injected
// PR event, and the foreground poller is disabled so a live refresh cannot
// clear the remote-less demo worktree's status mid-capture.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const HEADER_TEST_ID = 'pr-status-bar';

/**
 * Seed two archived chats so the header's archive control (icon + corner
 * count badge) renders beside the PR badges — it hides entirely at zero
 * archives, which would leave the scenario missing half the cluster.
 *
 * On-disk shape: `ArchivedChatsFile` at
 * `workspaces/{workspaceId}/chat-archives/{worktreeId}.json`
 * (`getWorkspaceChatArchivesFilePath` in `main/lib/paths.ts`).
 */
function seedArchivedChats(userDataDir) {
  const dir = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'chat-archives',
  );
  mkdirSync(dir, { recursive: true });
  const archivedAt = '2026-04-10T12:00:00.000Z';
  const entry = (id, title) => ({
    tab: {
      id,
      title,
      messages: [],
      status: 'idle',
      error: null,
      createdAt: '2026-04-09T12:00:00.000Z',
      queuedMessages: [],
      planMode: false,
      proposalMode: 'optional',
      thinkingLevel: 'high',
      providerType: 'claude',
    },
    archivedAt,
    turnCount: 1,
  });
  writeFileSync(
    path.join(dir, `${WORKTREE_ID}.json`),
    JSON.stringify(
      {
        version: 1,
        archived: [
          entry('archived-chat-1', 'Unclear input request'),
          entry('archived-chat-2', 'Work'),
        ],
      },
      null,
      2,
    ),
  );
}

/**
 * Inject inside an `expect.poll` so a racing live PR refresh (which clears
 * the store for the remote-less demo worktree) is retried away — the same
 * pattern `can-1528-pr-section-capture.spec.mjs` uses.
 */
async function injectUntilVisible(electronApp, window, payload, expectedText) {
  const header = window.getByTestId(HEADER_TEST_ID);
  await expect
    .poll(
      async () => {
        await injectGithubPrStatus(electronApp, payload);
        return header
          .getByText(expectedText)
          .first()
          .isVisible()
          .catch(() => false);
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return header;
}

/** Inject a state and assert both its stable PR anchor and semantic CI label. */
async function assertHeaderState(
  name,
  { electronApp, window, payload, sentinelText, ciLabel, onState },
) {
  const header = await injectUntilVisible(
    electronApp,
    window,
    payload,
    sentinelText,
  );
  await expect(header.getByRole('img', { name: ciLabel })).toBeVisible();
  await onState?.({ name, header });
  return header;
}

export async function runHeaderPrStateScenario({ onState } = {}) {
  test.setTimeout(240_000);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-header-pr-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedArchivedChats(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();

    // Silence the foreground poller: the remote-less demo worktree would
    // otherwise resolve to "no PR" and clear the injected status.
    await window.evaluate(async () => {
      await window.api.github.setForegroundWorktree({
        projectId: null,
        worktreeId: null,
      });
    });

    const header = window.getByTestId(HEADER_TEST_ID);
    await expect(header).toBeVisible({ timeout: 15_000 });

    // --- Open PR, checks passing --------------------------------------
    const passing = buildPrStatusEvent({
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      repos: [
        {
          repoId: WORKSPACE_ID,
          repoName: 'repo',
          status: buildPrStatusData({
            prNumber: 87,
            checkStatus: 'passing',
          }),
        },
      ],
    });
    await assertHeaderState('pr-open-checks-passing', {
      electronApp,
      window,
      payload: passing,
      sentinelText: '#87',
      ciLabel: 'CI passing',
      onState,
    });

    const archive = header.getByTestId('chat-tab-archive');
    await expect(archive).toBeVisible();
    await expect(header.getByTestId('chat-tab-archive-count')).toHaveText('2');

    // --- Open PR, checks failing --------------------------------------
    const failing = buildPrStatusEvent({
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      repos: [
        {
          repoId: WORKSPACE_ID,
          repoName: 'repo',
          status: buildPrStatusData({
            prNumber: 87,
            checkStatus: 'failing',
          }),
        },
      ],
    });
    await assertHeaderState('pr-open-checks-failing', {
      electronApp,
      window,
      payload: failing,
      sentinelText: '#87',
      ciLabel: 'CI failing',
      onState,
    });
    await expect(header.getByRole('img', { name: 'CI passing' })).toHaveCount(
      0,
    );

    // --- No PR yet (Create PR cluster) --------------------------------
    const noPr = buildPrStatusEvent({
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      kind: 'no-pr',
    });
    await injectGithubPrStatus(electronApp, noPr);
    await expect(header.getByText('#87', { exact: true })).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(header.getByRole('img', { name: /CI / })).toHaveCount(0);
    await onState?.({ name: 'pr-none', header });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
}
