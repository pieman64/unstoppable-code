// CAN-3310: author-to-recipient coverage for an Agent capability package.
// A deterministic local Agent uses a custom skill whose supporting files,
// runnable script, and Slack MCP requirement are shared through the mock cloud.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerShareMembership,
  seedAgentModels,
  seedMcpServers,
  SHARE_MEMBERSHIP_TEAM,
} from './seeders/index.mjs';

const AGENT_ID = '7c3f9e42-2f19-4bc4-a43f-95e780f2e68f';
const LOCAL_AGENT_ID = 'agent_model_release_reviewer';
const CLOUD_API_KEY = 'csk_can3310_agent_package_e2e';

function seedAuthor(userDataDir) {
  const skillDir = path.join(
    userDataDir,
    'skills',
    'custom:app',
    'release-notes',
  );
  mkdirSync(path.join(skillDir, 'references'), { recursive: true });
  mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: release-notes',
      'description: Draft release notes from merged pull requests.',
      '---',
      '',
      '# Release notes',
      '',
      'Read references/style.md, then run scripts/collect.sh and post the',
      'summary with `mcp__Slack__slack_send_message`.',
      '',
    ].join('\n'),
  );
  writeFileSync(
    path.join(skillDir, 'references', 'style.md'),
    '# Style\n\nLead with the user-visible change.\n',
  );
  writeFileSync(
    path.join(skillDir, 'scripts', 'collect.sh'),
    '#!/bin/sh\ngit log --merges --oneline "$1"..HEAD\n',
  );
  seedMcpServers({
    userDataDir,
    servers: [
      {
        definition: {
          id: 'slack-local',
          name: 'Slack',
          description: 'Slack authoring fixture.',
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
  seedAgentModels(userDataDir, [
    {
      id: LOCAL_AGENT_ID,
      name: 'Release Reviewer',
      baseModel: 'sonnet',
      instructions: 'Use /release-notes and report through Slack.',
      pluginSelections: {
        collectionIds: [],
        skillRefs: [{ sourceId: 'custom:app', skillName: 'release-notes' }],
        pluginRefs: [],
        mcpServerRefs: [{ serverId: 'slack-local', configId: 'work' }],
      },
      createdAt: '2026-09-23T00:00:00.000Z',
      updatedAt: '2026-09-23T00:00:00.000Z',
    },
  ]);
  return skillDir;
}

test('reviews and installs an Agent capability package in one action', async () => {
  test.setTimeout(180_000);
  // Agents are shared with a team here, so the account belongs to one.
  await registerShareMembership(CLOUD_API_KEY);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can3310-agent-'));
  const skillDir = seedAuthor(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const account = await window.evaluate(
      (apiKey) =>
        window.api.saveCanopyCloudApiKey({
          apiKey,
        }),
      CLOUD_API_KEY,
    );
    expect(account.status).toMatchObject({ authenticated: true });
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });

    await app.openMarketplaceAgents();
    await expect(
      window.getByTestId(`customize-row-agent:local:${LOCAL_AGENT_ID}`),
    ).toBeVisible();
    await app.openLocalAgentShare(LOCAL_AGENT_ID);
    const share = window.getByTestId('share-agent-modal');
    const dependencies = share.getByTestId('share-agent-dependencies');
    await expect(dependencies).toHaveAttribute('data-state', 'ready', {
      timeout: 60_000,
    });
    // The packaged files and recipient setup are listed once the collapsed
    // review is expanded.
    await share.getByTestId('share-agent-dependencies-toggle').click();
    await expect(dependencies).toContainText('/release-notes');
    await expect(dependencies).toContainText('Slack');
    await expect(share.getByTestId('share-agent-scope-team')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await share
      .getByTestId(`share-agent-team-picker-option-${SHARE_MEMBERSHIP_TEAM.id}`)
      .click();
    // No publication consent: Share is ready once the audience is picked.
    await expect(share.getByTestId('share-agent-consent')).toHaveCount(0);
    await expect(share.getByTestId('share-agent-submit')).toBeEnabled();
    await share.getByTestId('share-agent-submit').click();
    await expect(share).toHaveCount(0, { timeout: 60_000 });
    await expect(
      window
        .getByTestId('toast-card')
        .filter({ hasText: `Agent shared with ${SHARE_MEMBERSHIP_TEAM.name}` }),
    ).toBeVisible();

    await app.deleteMarketplaceAgent(LOCAL_AGENT_ID);
    await window.getByRole('button', { name: 'Delete agent' }).click();
    await expect(
      window.getByTestId(`customize-row-agent:local:${LOCAL_AGENT_ID}`),
    ).toHaveCount(0);
    rmSync(skillDir, { recursive: true, force: true });
    rmSync(path.join(userDataDir, 'mcp-servers'), {
      recursive: true,
      force: true,
    });

    await app.openMarketplaceAgents();
    await expect(
      window.getByTestId(`plugins-entry-agent:shared:${AGENT_ID}`),
    ).toBeVisible();
    await window
      .getByTestId(`plugins-entry-add-agent:shared:${AGENT_ID}`)
      .click();

    // The shared install review (CAN-3710): name, publisher and one Install.
    // Setup the agent still needs shows where it lands, not here.
    const review = window.getByTestId('deep-link-share-landing');
    await expect(review).toBeVisible();
    await expect(review).toContainText('Release Reviewer');
    const install = review.getByTestId('deep-link-share-install');
    await expect(install).toHaveText('Install');
    // Enabled once the review has read the share it will install.
    await expect(install).toBeEnabled();
    const changedInstructions =
      'Publisher changed these instructions after the review opened.';
    const changed = await fetch(
      `${DEFAULT_MOCK_BASE_URL}/api/v1/canopy/agents`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${CLOUD_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          agent: {
            version: 1,
            id: LOCAL_AGENT_ID,
            name: 'Release Reviewer',
            baseModel: 'sonnet',
            instructions: changedInstructions,
            plugins: [],
          },
          capabilityPackage: { version: 1 },
        }),
      },
    );
    expect(changed.status).toBe(201);
    await install.click();
    await expect(review).toHaveCount(0, { timeout: 60_000 });
    await expect(
      window.getByTestId('toast-card').filter({ hasText: 'Agent installed.' }),
    ).toBeVisible();

    // The install reveals the returned local ID on its Marketplace detail.
    await expect(
      window.getByTestId('local-agent-marketplace-detail'),
    ).toContainText(LOCAL_AGENT_ID);
    await app.closeMarketplaceEntryDetail();
    await app.expectMarketplaceAgents();
    await expect(
      window.getByTestId(`customize-row-agent:local:${LOCAL_AGENT_ID}`),
    ).toBeVisible();
    const importedAgent = await window.evaluate(
      (id) => window.agents.get(id),
      LOCAL_AGENT_ID,
    );
    expect(importedAgent?.instructions).toBe(
      'Use /release-notes and report through Slack.',
    );
    expect(importedAgent?.instructions).not.toBe(changedInstructions);
    const installedSkillDir = path.join(
      userDataDir,
      'skills',
      'custom:app',
      'release-notes',
    );
    expect(
      readFileSync(
        path.join(installedSkillDir, 'references', 'style.md'),
        'utf8',
      ),
    ).toBe('# Style\n\nLead with the user-visible change.\n');
    expect(
      readFileSync(
        path.join(installedSkillDir, 'scripts', 'collect.sh'),
        'utf8',
      ),
    ).toContain('git log --merges');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-2962: package finalization must retain the imported-copy fingerprint.
test('redetects a public Agent package and protects later local edits', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'can2962-public-package-'),
  );
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-shared-org-projects-enabled': true,
      }),
    },
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    const externalId = '81fb19b2-522b-43b4-b7f8-edbcc274dcde';
    const openLink = async () => {
      await electronApp.evaluate(({ app }, id) => {
        app.emit(
          'open-url',
          { preventDefault: () => {} },
          `canopy://share/agents/${id}`,
        );
      }, externalId);
    };
    await openLink();
    const landing = window.getByTestId('deep-link-share-landing');
    // One click installs; the review closes and lands on the agent.
    await landing.getByTestId('deep-link-share-install').click();
    await expect(landing).toHaveCount(0, { timeout: 60_000 });
    // Reopening the link finds the installed copy and offers to open it.
    await openLink();
    await expect(landing.getByTestId('deep-link-share-open')).toBeVisible();
    await landing.getByTestId('deep-link-share-kebab').click();
    await window.getByTestId('deep-link-share-uninstall').click();
    // The uninstall confirmation is its own dialog, outside the review.
    await window.getByTestId('deep-link-share-uninstall-confirm').click();
    await landing.getByTestId('deep-link-share-install').click();
    await expect(landing).toHaveCount(0, { timeout: 60_000 });
    const edited = await window.evaluate(async (id) => {
      const agent = await window.agents.get(id);
      if (!agent) throw new Error('Imported Agent missing');
      return window.agents.save({
        ...agent,
        instructions: 'Local edits must survive.',
      });
    }, 'agent_model_public_reviewer');
    expect(edited.contentHash).not.toBe(edited.importedContentHash);
    await openLink();
    await expect(landing.getByTestId('deep-link-share-install')).toBeVisible();
    await expect(landing.getByTestId('deep-link-share-open')).toHaveCount(0);
    await expect(window.getByTestId('deep-link-share-uninstall')).toHaveCount(
      0,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
