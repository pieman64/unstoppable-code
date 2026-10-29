import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  registerShareMembership,
  SHARE_MEMBERSHIP_ORGANIZATION,
  SHARE_MEMBERSHIP_TEAM,
} from './seeders/index.mjs';

// Sharing a skill used to post SKILL.md alone and tell the user its supporting
// files would be left behind. It now packages the whole folder, and the share
// dialog discloses what will travel instead of warning that it will not.
//
// This walks the realistic user flow — create a multi-file skill, open Share,
// read the disclosure — rather than unit-testing the analyzer, because the
// regression this guards against is precisely that the disclosure stops
// matching what the share actually sends.
//
// Testids exercised:
//   - `skill-editor-add-file`            -> supporting-file authoring
//   - `skill-share-custom:app-<name>`    -> custom row Share action
//   - `share-skill-modal`                -> Share Skill dialog
//   - `share-skill-dependencies`         -> shared capability-package section
//   - `share-skill-dependencies-summary` -> collapsed "Included files" summary
//   - `share-skill-dependencies-toggle`  -> Show details / Hide details
//   - `share-skill-dependencies-list`    -> the packaged resources
//   - `share-skill-single-file-note`     -> retired warning, must stay absent
//   - `share-skill-consent`              -> retired consent, must stay absent
//   - `share-skill-submit`              -> submit, gated on a ready analysis
//   - `share-skill-scope-*`              -> audience radios (Team preselected)
//   - `share-skill-*-picker-option-<id>` -> team / organization target picker

const SKILL_NAME = 'packaged-share-skill';
const FILE_PATH = 'references/guide.md';

test('sharing a multi-file skill discloses its packaged files', async () => {
  test.setTimeout(180_000);
  // Team and Organization need membership; the mock account has none.
  await registerShareMembership('csk_skills_package_share_e2e');

  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('skills');
    await app.expectPluginsTab('skills');

    // ---------------------------------------------------------------------
    // Author a skill with one supporting file beside SKILL.md.
    // ---------------------------------------------------------------------
    await window.getByRole('button', { name: 'Create skill' }).click();
    await expect(window.locator('#create-skill-modal-title')).toBeVisible();

    await window
      .getByPlaceholder('my-skill-name')
      .pressSequentially(SKILL_NAME);
    await window
      .getByPlaceholder('One-line summary of when this skill should be used.')
      .fill('Packaged share skill produced by the verification spec.');
    await window
      .locator('textarea[placeholder*="Describe how the skill should be used"]')
      .fill('# Main\n\nSee references/guide.md before starting.\n');

    await window.getByTestId('skill-editor-add-file').click();
    const pathInput = window.getByTestId('skill-file-path-input');
    await expect(pathInput).toBeVisible();
    await pathInput.fill(FILE_PATH);
    await window
      .getByTestId('skill-file-content-input')
      .fill('# Guide\n\nSupporting file body.\n');

    await window.getByRole('button', { name: 'Create skill' }).last().click();
    await expect(window.locator('#create-skill-modal-title')).toHaveCount(0);

    // ---------------------------------------------------------------------
    // Connect an account so the share dialog opens rather than the sign-in
    // gate, then open Share on the skill just authored.
    // ---------------------------------------------------------------------
    const saveResult = await window.evaluate(
      async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      'csk_skills_package_share_e2e',
    );
    expect(
      saveResult.status,
      saveResult.status.error ?? 'Skill sharing account did not connect',
    ).toMatchObject({ authenticated: true });
    const connectedAccount = await window.evaluate(() =>
      window.api.loadCanopyCloudAccount(),
    );
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });

    const shareButton = window.getByTestId(
      `skill-share-custom:app-${SKILL_NAME}`,
    );
    await expect(shareButton).toBeVisible();
    await shareButton.click();

    await expect(window.getByTestId('share-skill-modal')).toBeVisible();

    // ---------------------------------------------------------------------
    // The dependency section replaces the retired single-file warning, and
    // names the skill whose folder is being packaged.
    // ---------------------------------------------------------------------
    const dependencies = window.getByTestId('share-skill-dependencies');
    await expect(dependencies).toBeVisible({ timeout: 30_000 });
    await expect(
      window.getByTestId('share-skill-single-file-note'),
    ).toHaveCount(0);

    // The review is collapsed by default: the summary is always visible and
    // the packaged files appear only after expanding the details.
    await expect(
      window.getByTestId('share-skill-dependencies-summary'),
    ).toContainText('Included files');
    const dependencyList = window.getByTestId('share-skill-dependencies-list');
    await expect(dependencyList).toHaveCount(0);
    const dependenciesToggle = window.getByTestId(
      'share-skill-dependencies-toggle',
    );
    await expect(dependenciesToggle).toHaveAttribute('aria-expanded', 'false');
    await dependenciesToggle.click();
    await expect(dependenciesToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(dependencyList).toBeVisible();
    await expect(dependencyList).toContainText(SKILL_NAME);

    // Same layout as the pipeline and automation share dialogs: the scope
    // comes first, then what the share carries.
    const scopeBox = await window
      .getByTestId('share-skill-scope')
      .boundingBox();
    const dependenciesBox = await dependencies.boundingBox();
    expect(scopeBox).not.toBeNull();
    expect(dependenciesBox).not.toBeNull();
    expect(scopeBox?.y ?? 0).toBeLessThan(dependenciesBox?.y ?? 0);

    // With membership, Team is the preselected audience; its target still
    // takes an explicit pick.
    await expect(window.getByTestId('share-skill-scope-team')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(window.getByTestId('share-skill-scope-private')).toHaveCount(
      0,
    );
    await window
      .getByTestId(`share-skill-team-picker-option-${SHARE_MEMBERSHIP_TEAM.id}`)
      .click();

    // Publication consent is retired: Share is available as soon as the
    // analysis and audience prerequisites pass, with no consent checkbox and
    // no option to delete the local copy.
    await expect(window.getByTestId('share-skill-consent')).toHaveCount(0);
    await expect(window.getByTestId('share-skill-delete-local')).toHaveCount(0);
    await expect(window.getByTestId('share-skill-submit')).toBeEnabled();

    // Capability refreshes can make the selected audience unavailable without
    // changing account identity. The effective fallback to Organization is
    // still an audience change, so the Team target cannot carry over.
    await electronApp.evaluate(({ ipcMain }, accountState) => {
      globalThis.__skillShareAccount = {
        ...accountState,
        capabilities: accountState.capabilities.filter(
          (capability) => capability !== 'teams-v1',
        ),
      };
      ipcMain.removeHandler('settings:load-canopy-cloud-account');
      ipcMain.handle(
        'settings:load-canopy-cloud-account',
        () => globalThis.__skillShareAccount,
      );
    }, connectedAccount);
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });
    await expect(
      window.getByTestId('share-skill-scope-organization'),
    ).toHaveAttribute('aria-checked', 'true');
    // With consent retired, nothing resets: the fallback lands on the
    // context's default organization and Share stays available for it.
    await expect(window.getByTestId('share-skill-submit')).toBeEnabled();
    await window
      .getByTestId(
        `share-skill-organization-picker-option-${SHARE_MEMBERSHIP_ORGANIZATION.id}`,
      )
      .click();
    await expect(window.getByTestId('share-skill-submit')).toBeEnabled();

    await window.getByTestId('share-skill-scope-public').click();
    await expect(window.getByTestId('share-skill-consent')).toHaveCount(0);
    await expect(window.getByTestId('share-skill-submit')).toBeEnabled();

    await window
      .getByTestId('share-skill-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await expect(window.getByTestId('share-skill-modal')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// The analysis always binds the skill itself, so a single-file skill still
// produces a one-resource manifest. That must not read as "something to
// carry": the dialog keeps the plain share, with no dependency section, and
// Share becomes available once the analysis settles.
test('sharing a single-file skill keeps the plain share', async () => {
  test.setTimeout(180_000);
  const singleFileSkill = 'single-file-share-skill';
  // Team is preselected only for an account that belongs to one.
  await registerShareMembership('csk_skills_single_file_share_e2e');

  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('skills');
    await app.expectPluginsTab('skills');

    await window.getByRole('button', { name: 'Create skill' }).click();
    await expect(window.locator('#create-skill-modal-title')).toBeVisible();
    await window
      .getByPlaceholder('my-skill-name')
      .pressSequentially(singleFileSkill);
    await window
      .getByPlaceholder('One-line summary of when this skill should be used.')
      .fill('Single-file skill produced by the verification spec.');
    await window
      .locator('textarea[placeholder*="Describe how the skill should be used"]')
      .fill('# Main\n\nJust the instructions, nothing else.\n');
    await window.getByRole('button', { name: 'Create skill' }).last().click();
    await expect(window.locator('#create-skill-modal-title')).toHaveCount(0);

    const saveResult = await window.evaluate(
      async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      'csk_skills_single_file_share_e2e',
    );
    expect(
      saveResult.status,
      saveResult.status.error ?? 'Skill sharing account did not connect',
    ).toMatchObject({ authenticated: true });
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('skills:shared-create');
      // Share create resolves a ShareOperationResult envelope.
      ipcMain.handle('skills:shared-create', (_event, request) => ({
        ok: true,
        value: {
          id: 'single-file-shared-skill',
          name: 'single-file-share-skill',
          description: 'Single-file skill produced by the verification spec.',
          contentHash: 'sha256:single-file-shared-skill',
          shareScope: request.shareScope,
          owner: {
            type: 'team',
            id: request.teamId,
            name: 'Platform',
          },
          createdBy: {
            id: 'mock-cloud-account',
            name: 'Test User',
            email: 'test@example.com',
          },
          createdAt: '2026-09-27T00:00:00.000Z',
          updatedAt: '2026-09-27T00:00:00.000Z',
          canUpdate: true,
          canDelete: true,
          publicShare: null,
          rawSkill: request.rawSkill,
        },
      }));
    });
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });

    const shareButton = window.getByTestId(
      `skill-share-custom:app-${singleFileSkill}`,
    );
    await expect(shareButton).toBeVisible();
    await shareButton.click();
    await expect(window.getByTestId('share-skill-modal')).toBeVisible();
    await expect(window.getByTestId('share-skill-scope-team')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await window
      .getByTestId(`share-skill-team-picker-option-${SHARE_MEMBERSHIP_TEAM.id}`)
      .click();

    // Share enabling means the analysis has settled; the collapsed review
    // summarizes a plain definition share, and expanding it shows the
    // completed empty state.
    await expect(window.getByTestId('share-skill-submit')).toBeEnabled({
      timeout: 30_000,
    });
    await expect(
      window.getByTestId('share-skill-dependencies-summary'),
    ).toContainText('Definition only');
    await window.getByTestId('share-skill-dependencies-toggle').click();
    await expect(
      window.getByTestId('share-skill-dependencies-empty'),
    ).toContainText('no local dependencies');

    await window.getByTestId('share-skill-submit').click();
    await expect(window.getByTestId('share-skill-modal')).toHaveCount(0);
    await expect(
      window.getByTestId('toast-card').filter({ hasText: 'Skill shared' }),
    ).toBeVisible();
    await window.getByTestId('skills-view-tab-shared').click();
    await expect(window.getByTestId('shared-skills-section')).not.toContainText(
      'Skill shared successfully.',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
