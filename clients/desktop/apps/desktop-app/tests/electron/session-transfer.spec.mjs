import { readChatStorageIndexes } from './readChatStorage.mjs';
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { seedObservabilityAudit } from './seeders/seedObservabilityAudit.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { seedMcpServers } from './seeders/seedMcpServers.mjs';
import {
  SHARE_MEMBERSHIP_ORGANIZATION,
  SHARE_MEMBERSHIP_TEAM,
} from './seeders/shareMembership.mjs';
import { startSessionExportCloudMock } from './sessionExportCloudMock.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const SOURCE_WORKSPACE_ID = 'demo-ts-pnpm-vite';
const SOURCE_WORKTREE_ID = 'demo-main';
const SOURCE_CHAT_ID = 'session-transfer-source';
const DESTINATION_WORKSPACE_ID = 'session-transfer-destination';
const DESTINATION_WORKSPACE_NAME = 'Session Transfer Destination';
const TRANSCRIPT_MARKER = 'Portable transcript marker: alpine-sunrise-427';
const PATCH_MARKER = 'Session transfer patch marker: cedar-river-913';
const TEST_CLOUD_API_KEY = 'csk_session_transfer_e2e';
const COWORK_SOURCE_ID = 'cowork-transfer-source';
const COWORK_DESTINATION_ID = 'cowork-transfer-destination';
const COWORK_SOURCE_ENTRY_ID = 'cowork-transfer-entry';
const COWORK_SOURCE_CHAT_ID = 'cowork-transfer-chat';
const COWORK_TRANSCRIPT_MARKER = 'Cowork transfer marker: silver-meadow-684';
// Sessions are shared with a team or organization only, so the share flows
// sign in as a member of one organization with one team.
const SHARE_MEMBERSHIP = {
  organizations: [SHARE_MEMBERSHIP_ORGANIZATION],
  teams: [SHARE_MEMBERSHIP_TEAM],
};
const PAGINATION_EXPORT_IDS = Array.from(
  { length: 25 },
  (_, index) =>
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
);

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function seedExactMatchDestination(userDataDir, sourceWorkspace) {
  const remotePath = path.join(userDataDir, 'session-transfer-remote.git');
  const remoteUrl = pathToFileURL(remotePath).href;
  const destinationRepoPath = path.join(
    userDataDir,
    'session-transfer-destination-repo',
  );

  mkdirSync(remotePath, { recursive: true });
  git(remotePath, ['init', '--bare']);
  git(sourceWorkspace.repoPath, ['remote', 'add', 'origin', remoteUrl]);
  git(sourceWorkspace.repoPath, ['push', '--all', 'origin']);
  git(sourceWorkspace.worktreePath, [
    'push',
    '--set-upstream',
    'origin',
    SOURCE_WORKTREE_ID,
  ]);
  git(userDataDir, ['clone', remoteUrl, destinationRepoPath]);
  git(destinationRepoPath, ['config', 'user.email', 'test@example.com']);
  git(destinationRepoPath, ['config', 'user.name', 'Canopy Test']);

  const indexPath = path.join(userDataDir, 'workspaces', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.workspaces.push({
    id: DESTINATION_WORKSPACE_ID,
    name: DESTINATION_WORKSPACE_NAME,
    type: 'single-repo',
    color: '#0EA5E9',
    collapsed: false,
    order: index.workspaces.length,
  });
  writeJson(indexPath, index);

  const workspaceDir = path.join(
    userDataDir,
    'workspaces',
    DESTINATION_WORKSPACE_ID,
  );
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath: destinationRepoPath,
    repos: [],
    alwaysShow: true,
  });
  writeJson(path.join(workspaceDir, 'worktrees.json'), {
    version: 1,
    worktrees: [],
  });
}

function seedTransferChat(
  userDataDir,
  providerType = 'claude',
  harness = providerType,
  pluginSelections,
) {
  const completedAtMs = Date.now() - 60_000;
  const createdAt = new Date(completedAtMs - 60_000).toISOString();
  seedWorktreeChat({
    userDataDir,
    workspaceId: SOURCE_WORKSPACE_ID,
    worktreeId: SOURCE_WORKTREE_ID,
    providerType,
    activeTabId: SOURCE_CHAT_ID,
    tabs: [
      {
        id: SOURCE_CHAT_ID,
        ...(providerType === 'cursor'
          ? {
              model: 'cursor-default',
              executionHarness: harness,
              sdkSessionId: 'cursor-export-session',
            }
          : {}),
        title: 'Portable Session',
        providerType,
        ...(pluginSelections ? { pluginSelections } : {}),
        messages: [
          {
            id: 'session-transfer-user-message',
            role: 'user',
            blocks: [{ type: 'text', text: 'Prepare this session to move.' }],
            timestamp: Date.parse(createdAt),
          },
          {
            id: 'session-transfer-assistant-message',
            role: 'assistant',
            blocks: [{ type: 'text', text: TRANSCRIPT_MARKER }],
            timestamp: completedAtMs,
          },
        ],
      },
    ],
  });

  seedObservabilityAudit({
    userDataDir,
    entries: [
      {
        id: 'session-transfer-audit-entry',
        eventType: 'worktree_chat',
        status: 'success',
        provider: providerType,
        label: 'Portable Session',
        startedAt: createdAt,
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs: 60_000,
        tokens: {
          input: 0,
          output: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        messageCount: 2,
        assistantMessageCount: 1,
        toolUseCount: 0,
        subAgentCount: 0,
        toolCounts: {},
        projectId: SOURCE_WORKSPACE_ID,
        worktreeId: SOURCE_WORKTREE_ID,
        chatId: SOURCE_CHAT_ID,
        hasTranscript: false,
      },
    ],
  });
}

function seedPortablePatch(sourceWorkspace) {
  const readmePath = path.join(sourceWorkspace.worktreePath, 'README.md');
  const currentReadme = readFileSync(readmePath, 'utf8');
  writeFileSync(readmePath, `${currentReadme.trimEnd()}\n\n${PATCH_MARKER}\n`);
}

function seedPaginatedCloudExports(cloud, upload) {
  for (const [index, id] of PAGINATION_EXPORT_IDS.entries()) {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
    cloud.exportsById.set(id, {
      record: {
        ...upload.record,
        id,
        title: `Archived Session ${String(index + 1).padStart(2, '0')}`,
        sourceChatId: `archived-chat-${String(index + 1)}`,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      bundle: upload.bundle,
    });
  }
}

function seedCoworkTransferWorkspaces(userDataDir) {
  const workspacesRoot = path.join(userDataDir, 'workspaces');
  const completedAtMs = Date.now() - 60_000;
  const createdAt = new Date(completedAtMs - 60_000).toISOString();
  writeJson(path.join(workspacesRoot, 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: COWORK_SOURCE_ID,
        name: 'Cowork Transfer Source',
        type: 'cowork',
        color: '#7C3AED',
        collapsed: false,
        order: 0,
        cowork: { createdAt, archiveRetentionDays: null },
      },
      {
        id: COWORK_DESTINATION_ID,
        name: 'Cowork Transfer Destination',
        type: 'cowork',
        color: '#0891B2',
        collapsed: false,
        order: 1,
        cowork: { createdAt, archiveRetentionDays: null },
      },
    ],
  });

  for (const workspaceId of [COWORK_SOURCE_ID, COWORK_DESTINATION_ID]) {
    const workspaceDir = path.join(workspacesRoot, workspaceId);
    writeJson(path.join(workspaceDir, 'workspace.json'), {
      version: 1,
      type: 'cowork',
      repos: [],
      cowork: { createdAt, archiveRetentionDays: null },
    });
    writeJson(path.join(workspaceDir, 'work-entries.json'), {
      version: 1,
      entries:
        workspaceId === COWORK_SOURCE_ID
          ? [{ id: COWORK_SOURCE_ENTRY_ID, createdAt }]
          : [],
    });
  }

  writeJson(
    path.join(
      workspacesRoot,
      COWORK_SOURCE_ID,
      'chats',
      `${COWORK_SOURCE_ENTRY_ID}.json`,
    ),
    {
      version: 1,
      activeTabId: COWORK_SOURCE_CHAT_ID,
      tabs: [
        {
          id: COWORK_SOURCE_CHAT_ID,
          title: 'Portable Cowork Session',
          description: 'Cowork transfer task',
          createdAt,
          kind: 'chat',
          providerType: 'claude',
          messages: [
            {
              id: 'cowork-transfer-user',
              role: 'user',
              blocks: [{ type: 'text', text: 'Prepare this Cowork session.' }],
              timestamp: Date.parse(createdAt),
            },
            {
              id: 'cowork-transfer-assistant',
              role: 'assistant',
              blocks: [{ type: 'text', text: COWORK_TRANSCRIPT_MARKER }],
              timestamp: completedAtMs,
            },
            {
              id: 'cowork-transfer-timer',
              role: 'system',
              blocks: [
                {
                  type: 'turn_timer',
                  startedAt: Date.parse(createdAt),
                  completedAt: completedAtMs,
                },
              ],
              timestamp: completedAtMs,
            },
          ],
        },
      ],
    },
  );

  seedObservabilityAudit({
    userDataDir,
    entries: [
      {
        id: 'cowork-transfer-audit-entry',
        eventType: 'worktree_chat',
        status: 'success',
        provider: 'claude',
        label: 'Portable Cowork Session',
        startedAt: createdAt,
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs: 60_000,
        tokens: {
          input: 0,
          output: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        messageCount: 2,
        assistantMessageCount: 1,
        toolUseCount: 0,
        subAgentCount: 0,
        toolCounts: {},
        projectId: COWORK_SOURCE_ID,
        worktreeId: COWORK_SOURCE_ENTRY_ID,
        chatId: COWORK_SOURCE_CHAT_ID,
        hasTranscript: false,
      },
    ],
  });
}

test('shares a completed Cowork session from the turn and tab menu, then imports it into a new Work Entry', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-session-transfer-'),
  );
  let electronApp;
  let cloud;

  try {
    seedCoworkTransferWorkspaces(userDataDir);
    cloud = await startSessionExportCloudMock(SHARE_MEMBERSHIP);
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: { CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl },
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    const saveResult = await window.evaluate(
      async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      TEST_CLOUD_API_KEY,
    );
    expect(saveResult.status.authenticated).toBe(true);

    await expect(
      window.evaluate(
        async ({ projectId, worktreeId, chatId }) =>
          window.api.runs.checkShareEligibility({
            projectId,
            worktreeId,
            chatId,
          }),
        {
          projectId: COWORK_SOURCE_ID,
          worktreeId: COWORK_SOURCE_ENTRY_ID,
          chatId: COWORK_SOURCE_CHAT_ID,
        },
      ),
    ).resolves.toMatchObject({ shareable: true });

    await window
      .getByTestId(`sidebar-work-entry-${COWORK_SOURCE_ENTRY_ID}`)
      .click();
    await expect(
      window.getByText(COWORK_TRANSCRIPT_MARKER, { exact: true }),
    ).toBeVisible({ timeout: 30_000 });

    await window.getByTestId('turn-more-actions').click();
    const turnShare = window.getByTestId('turn-more-share');
    await expect(turnShare).toBeVisible();
    await turnShare.click();
    await expect(window.getByTestId('share-run-modal')).toBeVisible();
    // An organization member is offered both audiences with no flag override.
    await expect(window.getByTestId('share-run-scope-team')).toBeVisible();
    await expect(
      window.getByTestId('share-run-scope-organization'),
    ).toBeVisible();
    await expect(window.getByTestId('share-run-scope-private')).toHaveCount(0);
    await expect(window.getByTestId('share-run-disclaimer')).toContainText(
      'redacted',
    );
    await expect(window.getByTestId('share-run-disclaimer')).toContainText(
      'stays synchronized',
    );
    await expect(window.getByTestId('share-run-disclaimer')).toContainText(
      'unshared at any time',
    );
    await window
      .getByTestId('share-run-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();

    const coworkTab = window
      .locator('[data-testid^="panel-tab-panel-chat-"]')
      .filter({ hasText: 'Cowork transfer task' });
    await coworkTab.click({ button: 'right' });
    await window.getByTestId('panel-tab-context-export-session').click();
    const exportConfirmation = window.getByTestId(
      'export-session-confirmation-modal',
    );
    await expect(exportConfirmation).toContainText(
      'Secure session snapshot export',
    );
    await expect(exportConfirmation).toContainText(
      'full, unredacted transcript',
    );
    await expect(exportConfirmation).toContainText('one-time snapshot');
    expect(cloud.uploadAttempts).toHaveLength(0);
    await window.getByTestId('export-session-confirm').click();
    await expect(
      window.getByTestId('share-session-status-success'),
    ).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => cloud.uploadAttempts.length).toBe(1);
    expect(cloud.uploadAttempts[0].metadata).toMatchObject({
      title: 'Portable Cowork Session',
      workspaceName: 'Cowork Transfer Source',
      workspaceType: 'cowork',
      sourceChatId: COWORK_SOURCE_CHAT_ID,
      repos: [],
    });
    const exportId = cloud.uploadAttempts[0].record.id;
    await window.getByRole('button', { name: 'Done' }).click();

    const destinationHeader = window.getByTestId(
      `sidebar-cowork-project-${COWORK_DESTINATION_ID}-header`,
    );
    await destinationHeader.click({ button: 'right' });
    await window.getByTestId('workspace-import-session-menu-item').click();
    await expect(window.getByTestId('import-session-modal')).toBeVisible();
    const exportRow = window.getByTestId(
      `import-session-cloud-row-${exportId}`,
    );
    await expect(exportRow).toBeVisible({ timeout: 30_000 });
    await exportRow
      .getByRole('button', { name: /Portable Cowork Session/ })
      .click();
    await expect(
      window.getByTestId('import-session-compatibility-status'),
    ).toContainText('Compatible Cowork project');
    await window.getByTestId('import-session-confirm').click();

    await expect(window.getByTestId('import-session-modal')).toBeHidden({
      timeout: 30_000,
    });
    await expect(
      window.getByText(COWORK_TRANSCRIPT_MARKER, { exact: true }),
    ).toBeVisible({ timeout: 30_000 });

    const destinationDir = path.join(
      userDataDir,
      'workspaces',
      COWORK_DESTINATION_ID,
    );
    const entries = JSON.parse(
      readFileSync(path.join(destinationDir, 'work-entries.json'), 'utf8'),
    ).entries;
    expect(entries).toHaveLength(1);
    const { live: importedTabs } = readChatStorageIndexes(
      destinationDir,
      entries[0].id,
    );
    expect(importedTabs.tabs[0]).toMatchObject({
      title: 'Portable Cowork Session',
    });
  } finally {
    if (electronApp) {
      await closeCanopy(electronApp, userDataDir);
    } else {
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    }
    if (cloud) await cloud.close();
  }
});

test('exports a session bundle, imports it into an exact-match project, and opens the continued chat', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-session-transfer-'),
  );
  let seed;
  let electronApp;
  let cloud;

  try {
    seed = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
    });
    const sourceWorkspace = seed.workspaces.find(
      (workspace) => workspace.id === SOURCE_WORKSPACE_ID,
    );
    if (!sourceWorkspace) {
      throw new Error(`Missing seeded project ${SOURCE_WORKSPACE_ID}`);
    }
    seedExactMatchDestination(userDataDir, sourceWorkspace);
    seedMcpServers({
      userDataDir,
      servers: [
        {
          definition: {
            id: 'slack-local',
            name: 'Slack',
            description: 'Portable session Slack fixture.',
            type: 'http',
            url: 'http://127.0.0.1:9/mcp',
            curated: { key: 'slack' },
            createdAt: '2026-09-23T00:00:00.000Z',
            updatedAt: '2026-09-23T00:00:00.000Z',
          },
          configs: [
            {
              id: 'work',
              name: 'Work',
              enabled: true,
              envVars: {},
              extraArgs: [],
              extraHeaders: {},
              createdAt: '2026-09-23T00:00:00.000Z',
              updatedAt: '2026-09-23T00:00:00.000Z',
            },
          ],
        },
      ],
    });
    seedTransferChat(userDataDir, 'claude', 'claude', {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'slack-local', configId: 'work' }],
    });
    seedPortablePatch(sourceWorkspace);
    cloud = await startSessionExportCloudMock(SHARE_MEMBERSHIP);

    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl,
      },
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(SOURCE_WORKTREE_ID);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();
    await expect(
      window.getByText(TRANSCRIPT_MARKER, { exact: true }),
    ).toBeVisible();

    // The chat's name also appears in the Activity rail's Cost section.
    const portableSessionTab = window
      .getByTestId(`panel-tab-panel-chat-${SOURCE_CHAT_ID}`)
      .getByText('Portable Session', { exact: true });
    const shareSessionMenuItem = window.getByTestId(
      'panel-tab-context-share-run',
    );
    await portableSessionTab.click({ button: 'right' });
    await expect(
      window.getByTestId('chat-session-export-menu-item'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('panel-tab-context-export-session'),
    ).toBeVisible();
    expect(cloud.uploadAttempts).toHaveLength(0);
    await window.keyboard.press('Escape');

    await portableSessionTab.click({ button: 'right' });
    await window.getByTestId('panel-tab-context-export-session').click();
    await expect(
      window.getByTestId('export-session-confirmation-modal'),
    ).toBeVisible();
    await window.getByTestId('export-session-confirm').click();
    await expect(window.getByTestId('cloud-sync-modal')).toBeVisible();
    expect(cloud.uploadAttempts).toHaveLength(0);
    await window.keyboard.press('Escape');

    const saveResult = await window.evaluate(
      async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      TEST_CLOUD_API_KEY,
    );
    expect(saveResult.status.authenticated).toBe(true);
    expect(saveResult.account.credentialSource).toBe('manual');
    expect(saveResult.account.capabilities).toContain('session-exports-v1');

    await expect(
      window.evaluate(
        async ({ projectId, worktreeId, chatId }) =>
          window.api.runs.checkShareEligibility({
            projectId,
            worktreeId,
            chatId,
          }),
        {
          projectId: SOURCE_WORKSPACE_ID,
          worktreeId: SOURCE_WORKTREE_ID,
          chatId: SOURCE_CHAT_ID,
        },
      ),
    ).resolves.toMatchObject({ shareable: true });

    await portableSessionTab.click({ button: 'right' });
    await shareSessionMenuItem.click();
    await expect(window.getByTestId('share-run-modal')).toBeVisible();
    await expect(window.getByTestId('share-run-disclaimer')).toContainText(
      'redacted',
    );

    await window.getByTestId('share-run-scope-team').click();
    await expect(window.getByTestId('share-run-team-picker')).toBeVisible();
    await expect(window.getByTestId('share-run-disclaimer')).toContainText(
      'redacted, may be truncated',
    );

    await window.getByTestId('share-run-scope-organization').click();
    await expect(
      window.getByTestId('share-run-organization-picker'),
    ).toBeVisible();
    await expect(window.getByTestId('share-run-disclaimer')).toContainText(
      'redacted, may be truncated',
    );

    // A shared session always reaches a team or organization; there is no
    // private audience, and the disclosure covers the live sync either way.
    await expect(window.getByTestId('share-run-scope-private')).toHaveCount(0);
    await expect(window.getByTestId('share-run-disclaimer')).toContainText(
      'stays synchronized',
    );
    await window
      .getByTestId('share-run-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();

    await portableSessionTab.click({ button: 'right' });
    await window.getByTestId('panel-tab-context-export-session').click();
    const exportConfirmation = window.getByTestId(
      'export-session-confirmation-modal',
    );
    await expect(exportConfirmation).toContainText(
      'Secure session snapshot export',
    );
    await expect(exportConfirmation).toContainText(
      'full, unredacted transcript',
    );
    await expect(exportConfirmation).toContainText('provider session data');
    await expect(exportConfirmation).toContainText('working changes');
    await expect(exportConfirmation).toContainText('another device');
    await window.getByTestId('export-session-confirm').click();
    await expect.poll(() => cloud.uploadAttempts.length).toBe(1);
    const upload = cloud.uploadAttempts[0];
    expect(upload.hasGzipMagic).toBe(true);
    expect(upload.hashMatches).toBe(true);
    expect(upload.computedHash).toBe(upload.metadata.contentHash);
    expect(upload.metadata).toMatchObject({
      title: 'Portable Session',
      workspaceName: sourceWorkspace.name,
      workspaceType: 'single-repo',
      manifestVersion: 1,
      sourceChatId: SOURCE_CHAT_ID,
    });
    expect(upload.metadata.appVersion).toEqual(expect.any(String));
    expect(upload.metadata.appVersion.length).toBeGreaterThan(0);
    expect(upload.metadata.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(upload.metadata.repos).toHaveLength(1);
    expect(upload.metadata.repos[0]).toMatchObject({
      branchName: SOURCE_WORKTREE_ID,
    });
    expect(upload.metadata.repos[0].name).toEqual(expect.any(String));
    expect(upload.metadata.repos[0].remoteUrl).toEqual(expect.any(String));
    expect(upload.record.sizeBytes).toBe(upload.bundle.length);
    const shareStatusModal = window.getByTestId('share-session-status-modal');
    await expect(shareStatusModal).toBeVisible({ timeout: 30_000 });
    await expect(
      window.getByTestId('share-session-status-success'),
    ).toContainText('Session snapshot exported');
    await expect(shareStatusModal).toContainText('Import session…');
    await expect(shareStatusModal).toContainText(
      'This private export does not create a public link.',
    );
    await shareStatusModal.getByRole('button', { name: 'Done' }).click();

    expect(
      cloud.requests.some(
        (request) =>
          request.method === 'POST' &&
          request.pathname === '/api/v1/canopy/session-exports' &&
          request.authorization === `Bearer ${TEST_CLOUD_API_KEY}`,
      ),
    ).toBe(true);

    const exportId = upload.record.id;
    expect(exportId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    seedPaginatedCloudExports(cloud, upload);

    const destinationHeader = window.getByTestId(
      `sidebar-project-header-${DESTINATION_WORKSPACE_ID}`,
    );
    const contextPosition = { x: 40, y: 16 };
    await destinationHeader.click({
      button: 'right',
      position: contextPosition,
    });
    const sessionContextMenu = window.getByTestId(
      'workspace-session-context-menu',
    );
    await expect(sessionContextMenu).toBeVisible();
    await expect(sessionContextMenu).toHaveClass(/canopy-floating-menu/);
    await expect(sessionContextMenu).toHaveClass(/rounded-lg/);
    await expect(sessionContextMenu).toHaveClass(/bg-quaternary/);
    await expect(sessionContextMenu).toHaveClass(/p-1/);
    await expect(sessionContextMenu).toHaveClass(/shadow-xl/);
    const importSessionItem = window.getByTestId(
      'workspace-import-session-menu-item',
    );
    await expect(importSessionItem).toHaveClass(/canopy-dropdown-menu-item/);
    await expect(importSessionItem).toHaveClass(/h-8/);
    await expect(importSessionItem).toHaveClass(/rounded-md/);
    // Shared sidebar menus use the 13px text-xs token.
    await expect(importSessionItem).toHaveCSS('font-size', '13px');
    const contextGeometry = await Promise.all([
      destinationHeader.boundingBox(),
      sessionContextMenu.boundingBox(),
    ]);
    expect(contextGeometry[0]).not.toBeNull();
    expect(contextGeometry[1]).not.toBeNull();
    expect(
      Math.abs(
        contextGeometry[1].y - (contextGeometry[0].y + contextPosition.y + 4),
      ),
    ).toBeLessThanOrEqual(1);

    await window.keyboard.press('Escape');
    await expect(sessionContextMenu).toBeHidden();
    await expect(destinationHeader).toBeFocused();

    await destinationHeader.click({
      button: 'right',
      position: contextPosition,
    });
    await expect(sessionContextMenu).toBeVisible();
    await window.getByTestId('workspace-import-session-menu-item').click();
    await expect(window.getByTestId('import-session-modal')).toBeVisible();

    const cloudList = window.getByTestId('import-session-cloud-list');
    await expect(cloudList).toBeVisible({ timeout: 30_000 });
    const exportRow = window.getByTestId(
      `import-session-cloud-row-${exportId}`,
    );
    await expect(exportRow).toBeVisible();
    await expect(exportRow).toContainText('Portable Session');
    await expect(exportRow).toContainText(/\d+(?:\.\d+)?\s*(?:B|KB|MB)/i);

    const loadMoreButton = window.getByRole('button', {
      name: 'Load more',
    });
    await expect(loadMoreButton).toBeVisible();
    await loadMoreButton.click();
    const lastPaginatedRow = window.getByTestId(
      `import-session-cloud-row-${PAGINATION_EXPORT_IDS[0]}`,
    );
    await expect(lastPaginatedRow).toBeVisible();
    await expect
      .poll(() =>
        cloud.requests.some(
          (request) =>
            request.method === 'GET' &&
            request.pathname === '/api/v1/canopy/session-exports' &&
            request.cursor !== null,
        ),
      )
      .toBe(true);

    const searchInput = window.getByTestId('import-session-cloud-search');
    await searchInput.fill('Portable Session');
    await expect(exportRow).toBeVisible();
    await expect(lastPaginatedRow).toHaveCount(0);
    await expect(loadMoreButton).toHaveCount(0);
    await expect
      .poll(() =>
        cloud.requests.some(
          (request) =>
            request.method === 'GET' &&
            request.pathname === '/api/v1/canopy/session-exports' &&
            request.q === 'Portable Session',
        ),
      )
      .toBe(true);

    await searchInput.fill('');
    const deleteExportId = PAGINATION_EXPORT_IDS[24];
    const deleteRow = window.getByTestId(
      `import-session-cloud-row-${deleteExportId}`,
    );
    await expect(deleteRow).toBeVisible();
    const deleteButton = window.getByTestId(
      `import-session-cloud-delete-${deleteExportId}`,
    );
    await deleteButton.click();
    await expect(deleteButton).toHaveText('Confirm delete');
    expect(cloud.exportsById.has(deleteExportId)).toBe(true);
    await deleteButton.click();
    await expect(deleteRow).toHaveCount(0);
    expect(cloud.exportsById.has(deleteExportId)).toBe(false);
    expect(
      cloud.requests.some(
        (request) =>
          request.method === 'DELETE' &&
          request.pathname ===
            `/api/v1/canopy/session-exports/${deleteExportId}`,
      ),
    ).toBe(true);

    await exportRow.getByRole('button', { name: /Portable Session/ }).click();

    await expect(
      window.getByTestId('import-session-bundle-summary'),
    ).toBeVisible();
    expect(
      cloud.requests.some(
        (request) =>
          request.method === 'GET' &&
          request.pathname === '/api/v1/canopy/session-exports',
      ),
    ).toBe(true);
    expect(
      cloud.requests.some(
        (request) =>
          request.method === 'GET' &&
          request.pathname === `/api/v1/canopy/session-exports/${exportId}`,
      ),
    ).toBe(true);
    expect(
      cloud.requests.some(
        (request) =>
          request.method === 'GET' &&
          request.pathname ===
            `/api/v1/canopy/session-exports/${exportId}/bundle`,
      ),
    ).toBe(true);
    await expect(
      window.getByTestId('import-session-compatibility-status'),
    ).toContainText('Exact repository match');
    const capabilityReadiness = window.getByTestId(
      'import-session-capability-readiness',
    );
    await expect(capabilityReadiness).toContainText('Capabilities and setup');
    await expect(capabilityReadiness).toContainText('Slack');
    await expect(capabilityReadiness).toContainText('MCP server · Needs setup');
    await expect(capabilityReadiness).toContainText(
      'Missing setup is reported but does not block import.',
    );
    const importButton = window.getByTestId('import-session-confirm');
    await expect(importButton).toBeEnabled();
    await importButton.click();

    await expect(
      window.getByText('The session was imported and opened.', {
        exact: false,
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      window
        .getByTestId('import-session-warnings')
        .getByText('Some imported capabilities still need setup: Slack.', {
          exact: true,
        }),
    ).toBeVisible();
    await window.getByRole('button', { name: 'Done' }).click();
    await expect(window.getByTestId('import-session-modal')).toBeHidden({
      timeout: 30_000,
    });
    await expect(
      window.getByText(TRANSCRIPT_MARKER, { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    const composer = window.getByRole('textbox').first();
    await expect(composer).toBeVisible();
    await expect(composer).toBeEditable();

    const importedWorktreesRoot = path.join(
      userDataDir,
      'workspaces',
      DESTINATION_WORKSPACE_ID,
      'worktrees',
    );
    const importedWorktreeDirs = readdirSync(importedWorktreesRoot, {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory());
    expect(importedWorktreeDirs).toHaveLength(1);
    const importedReadme = readFileSync(
      path.join(
        importedWorktreesRoot,
        importedWorktreeDirs[0].name,
        'README.md',
      ),
      'utf8',
    );
    expect(importedReadme).toContain(PATCH_MARKER);
  } finally {
    if (electronApp) {
      await closeCanopy(electronApp, userDataDir);
    } else {
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    }
    if (cloud) await cloud.close();
    if (seed) cleanupDemoWorkspaces(seed);
  }
});

for (const harness of ['cursor', 'claude', 'codex']) {
  test(`Cursor session import validates harness ${harness}`, async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'cursor-session-transfer-'),
    );
    const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const sourceWorkspace = seed.workspaces.find(
      (workspace) => workspace.id === SOURCE_WORKSPACE_ID,
    );
    seedExactMatchDestination(userDataDir, sourceWorkspace);
    seedTransferChat(userDataDir, 'cursor', harness);
    const cloud = await startSessionExportCloudMock();
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: { CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree(SOURCE_WORKTREE_ID);
      await expect(
        window.getByText(TRANSCRIPT_MARKER, { exact: true }),
      ).toBeVisible();
      await window.evaluate(
        (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
        TEST_CLOUD_API_KEY,
      );
      await window
        .getByTestId(`panel-tab-panel-chat-${SOURCE_CHAT_ID}`)
        .getByText('Portable Session', { exact: true })
        .click({ button: 'right' });
      await window.getByTestId('panel-tab-context-export-session').click();
      await window.getByTestId('export-session-confirm').click();
      await expect(
        window.getByTestId('share-session-status-success'),
      ).toBeVisible({ timeout: 15_000 });
      expect(cloud.uploadAttempts).toHaveLength(1);
      const exportId = cloud.uploadAttempts[0].record.id;
      await window.getByRole('button', { name: 'Done' }).click();
      await window
        .getByTestId(`sidebar-project-header-${DESTINATION_WORKSPACE_ID}`)
        .click({ button: 'right', position: { x: 40, y: 16 } });
      await window.getByTestId('workspace-import-session-menu-item').click();
      await window
        .getByTestId(`import-session-cloud-row-${exportId}`)
        .getByRole('button', { name: /Portable Session/ })
        .click();
      if (harness !== 'cursor') {
        await expect(window.getByTestId('import-session-modal')).toContainText(
          'valid session manifest',
        );
        await expect(window.getByTestId('import-session-confirm')).toHaveCount(
          0,
        );
        return;
      }
      await expect(
        window.getByTestId('import-session-compatibility-status'),
      ).toContainText('Exact repository match');
      await window.getByTestId('import-session-confirm').click();
      await expect(window.getByTestId('import-session-modal')).toBeHidden({
        timeout: 30_000,
      });
      await expect(
        window.getByText(TRANSCRIPT_MARKER, { exact: true }),
      ).toBeVisible();
      await expect(
        window.getByTestId('chat-model-picker').first(),
      ).toContainText('Cursor');
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await cloud.close();
      cleanupDemoWorkspaces(seed);
    }
  });
}
