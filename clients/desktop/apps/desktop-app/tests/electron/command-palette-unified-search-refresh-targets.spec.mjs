import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedPluginsCache } from './seeders/seedPluginsCache.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { planDocumentPanel, planPanelId } from './planPanelHarness.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';

// The skill page heading is the skill's display title (CAN-4264).
function skillTitle(name) {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment[0].toUpperCase() + segment.slice(1))
    .join(' ');
}

const PALETTE_SHORTCUT = process.platform === 'darwin' ? 'Meta+K' : 'Control+K';
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';

function seedAgentModels(userDataDir) {
  writeJson(path.join(userDataDir, 'agent-models.json'), {
    version: 1,
    agents: [
      {
        id: 'agent_model_palette_reviewer',
        name: 'Palette Reviewer Agent',
        baseModel: 'sonnet',
        instructions: 'Review unified palette targets carefully.',
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
        createdAt: '2026-07-14T10:00:00.000Z',
        updatedAt: '2026-07-14T10:00:00.000Z',
      },
    ],
  });
}

function seedInstalledSkill(userDataDir) {
  const sourceId = 'github:example:skills';
  const skillName = 'burrow-navigator';
  writeJson(path.join(userDataDir, 'skills', 'skills-lock.json'), {
    version: 2,
    skills: {
      [`${sourceId}/${skillName}`]: {
        sourceId,
        source: 'example/skills',
        sourceType: 'github',
        sourceUrl: 'https://github.com/example/skills',
        skillPath: skillName,
        skillFolderHash: 'palette-test-hash',
        installedAt: '2026-07-14T10:00:00.000Z',
        updatedAt: '2026-07-14T10:00:00.000Z',
      },
    },
  });
  const skillDir = path.join(userDataDir, 'skills', sourceId, skillName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: burrow-navigator',
      'description: Navigate burrows quickly.',
      '---',
      '',
      '# Burrow Navigator',
      '',
      'Palette deep-link test fixture.',
      '',
    ].join('\n'),
    'utf8',
  );
}

function seedTrackedPlan(userDataDir) {
  writeJson(
    path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'plans',
      `${WORKTREE_ID}.json`,
    ),
    {
      version: 1,
      plans: [
        {
          id: 'palette-plan-1',
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          source: 'claude',
          title: 'Wombat migration plan',
          content:
            '# Wombat migration plan\n\nPhase one moves the marsupialneedle service.',
          reviewStatus: 'approved',
          createdAt: '2026-07-14T09:00:00.000Z',
          updatedAt: '2026-07-14T09:30:00.000Z',
          latestRevisionNumber: 1,
          revisions: [],
          linkedExecutionIds: [],
        },
      ],
    },
  );
}

async function openPalette(window) {
  await window.keyboard.press(PALETTE_SHORTCUT);
  await expect(window.getByTestId('command-palette')).toBeVisible();
  return window.getByTestId('command-palette-input');
}

test('open palette refreshes after first scan and navigates exact skill, agent, and plugin targets', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-unified-palette-targets-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite', 'ts-npm-next'] });
  seedAgentModels(userDataDir);
  seedInstalledSkill(userDataDir);
  seedTrackedPlan(userDataDir);
  seedPluginsCache({ userDataDir });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'refresh-palette-chat',
    tabs: [
      {
        id: 'refresh-palette-chat',
        title: 'Initial refresh discussion',
        providerType: 'codex',
        messages: [
          {
            id: 'refresh-palette-user',
            role: 'user',
            blocks: [
              {
                type: 'text',
                text: 'The refreshneedle result appears without reopening.',
              },
            ],
            timestamp: Date.parse('2026-07-14T12:00:00.000Z'),
          },
        ],
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    // Keep the first palette instance open while the lazy scan completes.
    let input = await openPalette(window);
    await input.fill('refreshneedle');
    const transcriptSection = window.locator(
      '[data-palette-section="transcripts"]',
    );
    await expect(transcriptSection).toContainText(
      'Initial refresh discussion',
      {
        timeout: 15_000,
      },
    );
    await transcriptSection.getByRole('option').click();
    await expect(
      window.getByTestId('panel-tab-panel-chat-refresh-palette-chat'),
    ).toBeVisible();

    // Tracked plan: a title match opens the plan's Plan panel in its owning
    // worktree (switching to it when needed), and a content match surfaces
    // the plan in the deferred "In content" section and reveals that same
    // panel instead of opening a second one. The panel's tab carries the
    // plan title; the document below it starts after the title line.
    const planPanel = planDocumentPanel(window, 'palette-plan-1');
    input = await openPalette(window);
    await input.fill('Wombat migration plan');
    await window
      .locator('[data-palette-section="plans"]')
      .getByRole('option')
      .click();
    await expect(planPanel).toBeVisible();
    await expect(
      window.getByTestId(`panel-tab-${planPanelId('palette-plan-1')}`),
    ).toContainText('Wombat migration plan');
    await expect(planPanel).toContainText('marsupialneedle');

    input = await openPalette(window);
    await input.fill('marsupialneedle');
    const planContentRow = window
      .locator('[data-palette-section="transcripts"]')
      .getByRole('option');
    await expect(planContentRow).toContainText('Wombat migration plan', {
      timeout: 15_000,
    });
    await planContentRow.click();
    await expect(planPanel).toBeVisible();
    await expect(
      window.locator('[data-testid="panel-content-plan"]'),
    ).toHaveCount(1);

    // Skill deep link BEFORE the plugins page has ever mounted: the pending
    // store payload must survive the lazy PluginsPage/SkillsTab mounts and
    // open the exact skill's viewer (regression: window CustomEvents fired
    // right after navigate('plugins') were dropped here).
    input = await openPalette(window);
    await input.fill('burrow-navigator');
    await window
      .locator('[data-palette-section="skills"]')
      .getByRole('option')
      .click();
    await expect(window.getByTestId('page-plugins')).toBeVisible();
    await expect(window.locator('#skill-detail-modal-title')).toHaveText(
      skillTitle('burrow-navigator'),
    );
    await window.keyboard.press('Escape');

    input = await openPalette(window);
    await input.fill('Palette Reviewer Agent');
    await window
      .locator('[data-palette-section="agents"]')
      .getByRole('option')
      .click();
    // CAN-4266: an agent opens its Marketplace detail with the editor over it.
    await expect(window.getByTestId('page-plugins')).toBeVisible();
    await expect(
      window.getByTestId('local-agent-marketplace-detail'),
    ).toBeVisible();
    await expect(window.getByTestId('agent-model-modal')).toBeVisible();
    await expect(window.getByTestId('agent-model-name')).toHaveValue(
      'Palette Reviewer Agent',
    );

    await window.keyboard.press('Escape');
    input = await openPalette(window);
    await input.fill('alpha-tool');
    await window
      .locator('[data-palette-section="plugins"]')
      .getByRole('option')
      .click();
    await expect(window.getByTestId('page-plugins')).toBeVisible();
    await expect(
      window
        .getByRole('dialog')
        .getByRole('heading', { name: 'Alpha Tool', exact: true }),
    ).toBeVisible();
    await expect(
      window
        .getByRole('dialog')
        .getByText('alpha-tool (external)', { exact: true }),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
