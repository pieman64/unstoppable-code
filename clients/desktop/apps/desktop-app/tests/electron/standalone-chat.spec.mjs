import { runSessionReuseFlow } from './seeders/sessionReuseFlow.mjs';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  CanopyAppDriver,
  closePanelTab,
  expandDefaultActivityRail,
} from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { readChatStorageIndexes } from './readChatStorage.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';

function writeText(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, 'utf8');
}

function buildMessage(id, role, text, timestamp) {
  return {
    id,
    role,
    blocks: [{ type: 'text', text }],
    timestamp,
  };
}

function getWorkspaceSection(window, title) {
  return window
    .getByRole('heading', { name: title, exact: true })
    .locator('xpath=ancestor::section[1]');
}

function seedStandaloneChatData(userDataDir) {
  const rootDir = path.join(userDataDir, 'standalone-chat');
  const projectDir = path.join(rootDir, 'default');
  const workspaceDir = path.join(projectDir, 'workspace');
  const historyDir = path.join(projectDir, 'history');
  const createdAt = '2026-04-10T12:00:00.000Z';
  const updatedAt = '2026-04-10T12:05:00.000Z';

  writeJson(path.join(rootDir, 'projects.json'), {
    version: 1,
    projects: [
      {
        id: 'default',
        name: 'Personal',
        createdAt,
        color: '#7C9B6D',
        defaultModel: 'gpt-6-luna',
      },
    ],
  });

  writeJson(path.join(projectDir, 'project.json'), {
    version: 1,
    id: 'default',
    name: 'Personal',
    createdAt,
    color: '#7C9B6D',
    description: 'Standalone UI automation fixture',
    defaultModel: 'gpt-6-luna',
    projectPinnedContext: [
      {
        id: 'project-pin-guide',
        kind: 'file',
        path: '/tmp/repo-guide.md',
        label: 'repo-guide.md',
        scope: 'project',
      },
      {
        id: 'project-pin-shared',
        kind: 'file',
        path: '/tmp/shared-brief.md',
        label: 'shared-brief.md',
        scope: 'project',
      },
    ],
    ui: {
      preferredViewMode: 'full',
      leftRailWidthPx: 280,
      rightPanelWidthPx: 360,
      rightPanelCollapsed: false,
      activeRightTab: 'context',
    },
    settings: {
      searchIndexingEnabled: true,
      archiveRetentionDays: null,
    },
  });

  writeText(
    path.join(projectDir, 'CLAUDE.md'),
    'Project automation instructions live here.\n',
  );

  writeJson(path.join(projectDir, 'chat-tabs.json'), {
    version: 1,
    activeTabId: 'chat-active',
    tabs: [
      {
        id: 'chat-active',
        title: 'Active Test Chat',
        description: 'Working through standalone UI coverage',
        createdAt,
        providerType: 'codex',
        model: 'gpt-5.6-sol',
        planMode: false,
        proposalMode: 'optional',
        thinkingLevel: 'ultra',
        messages: [
          buildMessage(
            'msg-user-1',
            'user',
            'Please draft the helper function.',
            Date.parse('2026-04-10T12:01:00.000Z'),
          ),
          buildMessage(
            'msg-assistant-1',
            'assistant',
            [
              'Here is the helper module:',
              '',
              '```typescript',
              'export const answer = 42;',
              'export function greet(name: string): string {',
              '  return `hello ${name}`;',
              '}',
              '```',
            ].join('\n'),
            Date.parse('2026-04-10T12:02:00.000Z'),
          ),
        ],
      },
    ],
  });

  writeJson(path.join(historyDir, 'chat-active', 'meta.json'), {
    version: 1,
    id: 'chat-active',
    title: 'Active Test Chat',
    description: 'Working through standalone UI coverage',
    createdAt,
    messageCount: 2,
    lastMessageAt: updatedAt,
    providerType: 'codex',
    pinnedContext: [
      {
        id: 'chat-pin-brief',
        kind: 'file',
        path: '/tmp/session-brief.md',
        label: 'session-brief.md',
        scope: 'chat',
      },
      {
        id: 'chat-pin-shared',
        kind: 'file',
        path: '/tmp/shared-brief.md',
        label: 'shared-brief.md',
        scope: 'chat',
      },
    ],
    archived: false,
  });

  writeJson(path.join(historyDir, 'chat-archived', 'meta.json'), {
    version: 1,
    id: 'chat-archived',
    title: 'Archived Sprint Review',
    description: 'Finished archive conversation',
    createdAt: '2026-04-09T14:00:00.000Z',
    messageCount: 2,
    lastMessageAt: '2026-04-09T14:10:00.000Z',
    providerType: 'claude',
    archived: true,
    archivedAt: '2026-04-09T14:15:00.000Z',
  });

  writeJson(path.join(historyDir, 'chat-archived', 'conversation.json'), {
    version: 1,
    projectId: 'default',
    chatId: 'chat-archived',
    archivedAt: '2026-04-09T14:15:00.000Z',
    tab: {
      id: 'chat-archived',
      title: 'Archived Sprint Review',
      description: 'Finished archive conversation',
      createdAt: '2026-04-09T14:00:00.000Z',
      providerType: 'claude',
      planMode: false,
      proposalMode: 'optional',
      thinkingLevel: 'high',
      messages: [
        buildMessage(
          'arch-user-1',
          'user',
          'Summarize the rollout.',
          Date.parse('2026-04-09T14:01:00.000Z'),
        ),
        buildMessage(
          'arch-assistant-1',
          'assistant',
          'The rollout completed and all migration checks passed.',
          Date.parse('2026-04-09T14:02:00.000Z'),
        ),
      ],
    },
  });

  writeText(
    path.join(historyDir, 'chat-archived', 'summary.md'),
    '# Archived Sprint Review\n\nAll migration checks passed.\n',
  );

  writeText(
    path.join(workspaceDir, 'notes', 'release-checklist.md'),
    '# Release Checklist\n\n- Verify archive viewer\n- Verify project search\n',
  );
  writeText(
    path.join(workspaceDir, 'prompts', 'review-helper.md'),
    '---\ntitle: Review Helper\n---\nPlease review the generated output.\n',
  );
  writeText(
    path.join(workspaceDir, 'attachments', 'standalone-spec.txt'),
    'Standalone attachment fixture.\n',
  );
  writeText(
    path.join(workspaceDir, 'artifacts', 'seed-report.js'),
    'export const seeded = true;\n',
  );
  writeJson(path.join(projectDir, 'artifacts-index.json'), {
    version: 1,
    items: {
      'seed-report': {
        id: 'seed-report',
        relativePath: 'seed-report.js',
        title: 'seed-report.js',
        language: 'javascript',
        createdAt: '2026-04-09T10:00:00.000Z',
        updatedAt: '2026-04-09T10:00:00.000Z',
      },
    },
  });
}

async function launchSeededStandaloneCanopy() {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-standalone-'));
  seedStandaloneChatData(userDataDir);

  try {
    const launched = await launchCanopy({ userDataDir });
    return {
      ...launched,
      seededUserDataDir: userDataDir,
    };
  } catch (error) {
    rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  }
}

test('validates seeded standalone chat flows', async ({}, testInfo) => {
  const { electronApp, seededUserDataDir } =
    await launchSeededStandaloneCanopy();
  const activeChatLabel = 'Working through standalone UI coverage';

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openChatPage();

    // The chat list now lives in the unified sidebar's blended Cowork
    // workspace row. The seeded legacy
    // `standalone-chat/default` project is migrated on startup into the
    // always-present `cowork-default` workspace (DEFAULT_COWORK_WORKSPACE_ID),
    // so its rows use the post-migration workspace id, not the legacy project.
    // CAN-2672: a sole Cowork workspace has no toggle and is force-expanded.
    await expect(
      window.getByRole('button', { name: activeChatLabel }).first(),
    ).toBeVisible();

    // The Cowork page now renders the panel-grid UX: the git-free top bar
    // above the grid, with the seeded chat transcript inside a chat panel.
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible();
    // New Chat lives in the panel tab strip's `+` now, not the top bar.
    await expect(
      window.locator('[data-testid^="panel-add-tab-"]').first(),
    ).toBeVisible();
    const codeBlock = window
      .locator('pre:visible')
      .filter({ hasText: 'export const answer = 42;' })
      .first();
    await expect(codeBlock).toBeVisible({ timeout: 15_000 });

    const codeBlockCopyHost = codeBlock.locator('xpath=..');
    const codeBlockCopyButton = codeBlockCopyHost.getByRole('button', {
      name: 'Copy code',
    });
    await expect(codeBlockCopyButton).toHaveCount(1);
    await codeBlockCopyHost.hover();
    await expect(codeBlockCopyButton).toHaveCSS('opacity', '1');

    const codeBlockBox = await codeBlock.boundingBox();
    const copyButtonBox = await codeBlockCopyButton.boundingBox();
    expect(codeBlockBox).not.toBeNull();
    expect(copyButtonBox).not.toBeNull();
    expect(copyButtonBox.x).toBeLessThan(codeBlockBox.x + codeBlockBox.width);
    expect(copyButtonBox.x + copyButtonBox.width).toBeGreaterThan(
      codeBlockBox.x + codeBlockBox.width,
    );
    expect(copyButtonBox.y).toBeLessThan(codeBlockBox.y + codeBlockBox.height);
    expect(copyButtonBox.y + copyButtonBox.height).toBeGreaterThan(
      codeBlockBox.y,
    );

    await codeBlockCopyButton.click();
    await expect(
      codeBlockCopyHost.getByRole('button', { name: 'Copied' }),
    ).toBeVisible();

    // Dropped features stay dropped: no Save-to-artifacts on code blocks, no
    // History/Search/Context workspace sections.
    await expect(
      window.getByRole('button', { name: 'Save to artifacts' }),
    ).toHaveCount(0);
    for (const removed of ['History', 'Search', 'Context', 'Artifacts']) {
      await expect(
        window.getByRole('heading', { name: removed, exact: true }),
      ).toHaveCount(0);
    }

    // Legacy archived chats stay reachable through the workspace's
    // "Archived and deleted" overview; opening one shows the archive overlay
    // above the grid, and Resume brings it back as a live chat.
    const archivedLink = window.getByTestId(
      'sidebar-cowork-project-cowork-default-archived-link',
    );
    await expect(archivedLink).toBeVisible();
    await archivedLink.click();
    await expect(window.getByTestId('archived-overview-page')).toBeVisible();
    // Overview rows label legacy archived chats by their description.
    await window
      .getByTestId('archived-overview-legacy')
      .getByRole('button', { name: /Finished archive conversation/ })
      .first()
      .click();
    const archiveOverlay = window.getByTestId('cowork-archive-overlay');
    await expect(archiveOverlay).toBeVisible();
    await expect(archiveOverlay).toHaveClass(/z-30/);
    await expect(
      window
        .getByRole('textbox')
        .first()
        .click({ trial: true, timeout: 1_000 }),
    ).rejects.toThrow();
    await expect(
      archiveOverlay.getByText(
        'The rollout completed and all migration checks passed.',
      ),
    ).toBeVisible();
    // The dropped "Copy JSON" affordance is gone from the archive viewer.
    await expect(
      archiveOverlay.getByRole('button', { name: 'Copy JSON' }),
    ).toHaveCount(0);
    await archiveOverlay
      .getByRole('button', { name: 'Resume as new chat' })
      .click();
    await expect(window.getByTestId('cowork-archive-overlay')).toHaveCount(0);
    // The resumed conversation lands in a live chat tab within a work entry
    // (tab labels derive from the chat description); its transcript renders
    // in the grid once the overlay closes.
    await expect(
      window
        .getByText('The rollout completed and all migration checks passed.')
        .first(),
    ).toBeVisible();
    const resumedTabAfterReload = window
      .locator('[data-testid^="panel-tab-panel-chat-"]')
      .filter({ hasText: 'Finished archive conversation' })
      .first();
    await expect(resumedTabAfterReload).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const workspaceRoot = path.join(
      seededUserDataDir,
      'workspaces',
      'cowork-default',
    );
    const resumedScope = readdirSync(
      path.join(workspaceRoot, 'chat-storage-manifests'),
    )
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .map((scopeId) => readChatStorageIndexes(workspaceRoot, scopeId).live)
      .find((live) =>
        live.tabs.some(
          (tab) => tab.description === 'Finished archive conversation',
        ),
      );
    const resumedPersistedTab = resumedScope?.tabs.find(
      (tab) => tab.description === 'Finished archive conversation',
    );
    expect(resumedPersistedTab).toBeDefined();
    expect(resumedScope?.activeTabId).toBe(resumedPersistedTab?.id);
    await window.reload();
    await app.waitForShell();
    await app.openChatPage();
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible();
    await expect(resumedTabAfterReload).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(
      window
        .getByText('The rollout completed and all migration checks passed.')
        .first(),
    ).toBeVisible();
    await expandDefaultActivityRail(window);

    // The shared Notes activity card (workspace-global, brand-managed cowork
    // storage) works from the cowork activity rail.
    const notesPanel = getWorkspaceSection(window, 'Notes');
    await notesPanel
      .getByRole('button', { name: 'Add note', exact: true })
      .click();
    await window.getByPlaceholder('New Note title').fill('Automation Note');
    await window
      .getByPlaceholder('Write your note... (supports Markdown)')
      .fill('Standalone automation created this note.');
    await window.getByRole('button', { name: 'Save', exact: true }).click();
    const noteRow = notesPanel.getByTestId('workspace-notes-item').first();
    await expect(noteRow).toBeVisible();
    // Cowork note titles derive from the markdown heading (or the slug
    // when the body has no heading), so match case-insensitively.
    await expect(noteRow).toContainText(/automation note/i);

    // The shared Attachments card lists the migrated cowork attachment.
    const attachmentsPanel = getWorkspaceSection(window, 'Attachments');
    await expect(
      attachmentsPanel.getByText('standalone-spec.txt', { exact: true }),
    ).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('standalone-chat-validation.png'),
    });

    // --- Unified archive flow (per work entry) --------------------------------
    // Closing a used cowork chat tab archives it into ITS work entry's
    // ArchivedChatsFile; the Cowork top bar's Archive control is scoped to
    // the active entry and lists it. Use the resumed chat (known content,
    // lives in the active entry) so the flow is deterministic.
    const resumedTab = window
      .locator('[data-testid^="panel-tab-panel-chat-"]')
      .filter({ hasText: 'Finished archive conversation' })
      .first();
    await expect(resumedTab).toBeVisible();
    const tabTestId = await resumedTab.getAttribute('data-testid');
    await closePanelTab(window, tabTestId.replace('panel-tab-', ''));

    // Archived chats live in the active chat group's tab-strip accessory;
    // the Cowork top bar no longer owns this control after the opened-chat
    // header redesign (PR #2441).
    const archiveControl = window.getByTestId('chat-tab-archive');
    await expect(archiveControl).toBeVisible();
    await archiveControl.hover();
    const archivePopover = window.getByTestId('chat-tab-archive-popover');
    await expect(archivePopover).toBeVisible();
    // The archive surfaces lead with the generated title (`description`) and
    // drop the raw `title`, exactly as the live chat tab did.
    await expect(archivePopover).toContainText('Finished archive conversation');
    await expect(archivePopover).not.toContainText('Archived Sprint Review');

    // Clicking the archived row opens the archived transcript viewer with
    // the conversation content (the live tab is gone, so the only visible
    // instance of the text is the viewer's).
    await archivePopover
      .getByText('Finished archive conversation')
      .first()
      .click();
    await expect(
      window
        .getByText('The rollout completed and all migration checks passed.')
        .first(),
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    await closeCanopy(electronApp, seededUserDataDir);
  }
});

for (const providerType of ['claude', 'codex']) {
  test(`CAN-2835 cowork ${providerType} preserves consecutive responses and restart`, async () => {
    test.setTimeout(240_000);
    await runSessionReuseFlow({ surface: 'cowork', providerType });
  });
}
