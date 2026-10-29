import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  connectMockCloudAccount,
  registerShareMembership,
  SHARE_MEMBERSHIP_ORGANIZATION,
  SHARE_MEMBERSHIP_TEAM,
} from './seeders/index.mjs';

const SKILL_NAME = 'release-notes-writer';
const SKILL_DESCRIPTION =
  'Drafts release notes from merged pull requests in the house style.';
const LAPSED_ORG = SHARE_MEMBERSHIP_ORGANIZATION;
const HEALTHY_ORG = {
  id: '44444444-4444-4444-8444-444444444442',
  name: 'Northwind Labs',
  role: 'OWNER',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function skillDir(userDataDir) {
  return path.join(userDataDir, 'skills', 'custom:app', SKILL_NAME);
}

function seedSkill(userDataDir) {
  const dir = skillDir(userDataDir);
  mkdirSync(path.join(dir, 'references'), { recursive: true });
  writeFileSync(
    path.join(dir, 'SKILL.md'),
    [
      '---',
      `name: ${SKILL_NAME}`,
      `description: ${SKILL_DESCRIPTION}`,
      '---',
      '# Release notes writer',
      '',
      'Follow references/style-guide.md for every release.',
      '',
    ].join('\n'),
  );
  writeFileSync(
    path.join(dir, 'references', 'style-guide.md'),
    '# Style guide\n\nLead with user impact.\n',
  );
}

async function launchWithSkill(apiKey, prefix) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  seedSkill(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  const page = await electronApp.firstWindow();
  const app = new CanopyAppDriver(page);
  await app.waitForShell({ timeout: 30_000 });
  await app.openPluginsPage();
  await app.openPluginsTab('skills');
  await app.expectPluginsTab('skills');
  // Connect once the Skills page is mounted, so it hears the account change.
  await connectMockCloudAccount(page, apiKey);
  return { electronApp, userDataDir, page };
}

async function openShareDialog(page) {
  const shareButton = page.getByTestId(`skill-share-custom:app-${SKILL_NAME}`);
  await shareButton.click();
  const dialog = page.getByTestId('share-skill-modal');
  await expect(dialog).toBeVisible();
  return dialog;
}

async function selectLapsedOrganization(page) {
  const orgScope = page.getByTestId('share-skill-scope-organization');
  if ((await orgScope.getAttribute('aria-checked')) !== 'true') {
    await orgScope.click();
  }
  const orgOption = page.getByTestId(
    `share-skill-organization-picker-option-${LAPSED_ORG.id}`,
  );
  if ((await orgOption.count()) > 0) await orgOption.click();
}

async function registerLapsedMembership(apiKey, role) {
  const organizations =
    role === 'OWNER'
      ? [{ ...LAPSED_ORG, role }, HEALTHY_ORG]
      : [{ ...LAPSED_ORG, role }];
  await registerShareMembership(apiKey, {
    organizations,
    teams: [],
    scenario: {
      cloud: {
        orgBillingStates: [
          {
            organizationId: LAPSED_ORG.id,
            organizationName: LAPSED_ORG.name,
            teamsEntitled: false,
            trialEndedAt: '2026-10-01T00:00:00.000Z',
          },
          ...(role === 'OWNER'
            ? [
                {
                  organizationId: HEALTHY_ORG.id,
                  organizationName: HEALTHY_ORG.name,
                  teamsEntitled: true,
                },
              ]
            : []),
        ],
      },
    },
  });
}

test('CAN-3847: sharing a skill is one step and keeps the local skill', async () => {
  test.setTimeout(180_000);
  const apiKey = 'csk_can3847_share_success';
  await registerShareMembership(apiKey);
  const { electronApp, userDataDir, page } = await launchWithSkill(
    apiKey,
    'can3847-share-success-',
  );
  try {
    await electronApp.evaluate(
      ({ ipcMain }, fixture) => {
        ipcMain.removeHandler('skills:shared-create');
        ipcMain.handle('skills:shared-create', async (_event, request) => ({
          ok: true,
          value: {
            id: 'can3847-shared-skill',
            name: fixture.name,
            description: fixture.description,
            contentHash: 'sha256:can3847',
            shareScope: request.shareScope,
            owner: { type: 'team', id: request.teamId, name: fixture.teamName },
            createdBy: {
              id: 'mock-cloud-account',
              name: 'Test User',
              email: 'test@example.com',
            },
            createdAt: '2026-10-15T15:00:00.000Z',
            updatedAt: '2026-10-15T15:00:00.000Z',
            canUpdate: true,
            canDelete: true,
            publicShare: null,
            rawSkill: request.rawSkill,
          },
        }));
      },
      {
        name: SKILL_NAME,
        description: SKILL_DESCRIPTION,
        teamName: SHARE_MEMBERSHIP_TEAM.name,
      },
    );

    const dialog = await openShareDialog(page);
    await expect(dialog.getByTestId('share-skill-consent')).toHaveCount(0);
    await expect(dialog.getByTestId('share-skill-delete-local')).toHaveCount(0);
    await expect(
      dialog.getByTestId('share-skill-dependencies-summary'),
    ).toBeVisible();
    await expect(
      dialog.getByTestId('share-skill-dependencies-list'),
    ).toHaveCount(0);

    await dialog
      .getByTestId(`share-skill-team-picker-option-${SHARE_MEMBERSHIP_TEAM.id}`)
      .click();
    const submit = dialog.getByTestId('share-skill-submit');
    await expect(submit).toBeEnabled({ timeout: 30_000 });
    await submit.click();

    await expect(dialog).toHaveCount(0, { timeout: 30_000 });
    const toast = page
      .getByTestId('toast-card')
      .filter({ hasText: 'shared' })
      .first();
    await expect(toast).toBeVisible();
    await expect(
      page.locator('tbody button', { hasText: SKILL_NAME }).first(),
    ).toBeVisible();
    expect(existsSync(path.join(skillDir(userDataDir), 'SKILL.md'))).toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('CAN-3847: an owner sees the no-plan notice before upload and can pick another audience', async () => {
  test.setTimeout(180_000);
  const apiKey = 'csk_can3847_plan_gate_owner';
  await registerLapsedMembership(apiKey, 'OWNER');
  const { electronApp, userDataDir, page } = await launchWithSkill(
    apiKey,
    'can3847-plan-gate-owner-',
  );
  try {
    const dialog = await openShareDialog(page);
    await selectLapsedOrganization(page);
    await expect(
      dialog.getByTestId('share-skill-destination-access'),
    ).toBeVisible();
    await expect(dialog.getByTestId('share-skill-choose-plan')).toBeVisible();
    await expect(dialog.getByTestId('share-skill-submit')).toBeDisabled();

    await dialog
      .getByTestId(`share-skill-organization-picker-option-${HEALTHY_ORG.id}`)
      .click();
    await expect(
      dialog.getByTestId('share-skill-destination-access'),
    ).toHaveCount(0);
    await expect(dialog.getByTestId('share-skill-submit')).toBeEnabled({
      timeout: 30_000,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('CAN-3847: a member is told to ask an owner, with no purchase action', async () => {
  test.setTimeout(180_000);
  const apiKey = 'csk_can3847_plan_gate_member';
  await registerLapsedMembership(apiKey, 'MEMBER');
  const { electronApp, userDataDir, page } = await launchWithSkill(
    apiKey,
    'can3847-plan-gate-member-',
  );
  try {
    const dialog = await openShareDialog(page);
    await selectLapsedOrganization(page);
    await expect(
      dialog.getByTestId('share-skill-destination-access'),
    ).toBeVisible();
    await expect(dialog.getByTestId('share-skill-choose-plan')).toHaveCount(0);
    await expect(dialog.getByTestId('share-skill-submit')).toBeDisabled();

    await dialog.getByTestId('share-skill-scope-public').click();
    await expect(dialog.getByTestId('share-skill-submit')).toBeEnabled({
      timeout: 30_000,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
