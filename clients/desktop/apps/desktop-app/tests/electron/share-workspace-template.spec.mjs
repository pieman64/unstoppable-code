// share-workspace-template: durable coverage for desktop workspace templates.
//
// The test seeds a local cowork workspace and uses the shared deterministic
// cloud fixture. It covers the settings Share tab, the workspace-row context
// menu entry, and a public deep-link install through the real main/preload/UI
// seams. No live account or network service is used.
import { expect, test } from '@playwright/test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedCoworkWorkspace } from './seeders/index.mjs';
import { seedPluginsCache } from './seeders/seedPluginsCache.mjs';

const SHARE_ID = '5a4b3c2d-1e0f-4a5b-8c7d-6e5f4a3b2c1d';
const RETRY_SHARE_ID = '6b5c4d3e-2f1a-4b6c-9d8e-7f6a5b4c3d2e';

function emitOpenUrl(electronApp, url) {
  return electronApp.evaluate(({ app }, targetUrl) => {
    app.emit('open-url', { preventDefault: () => {} }, targetUrl);
  }, url);
}

function readWorkspaceIndex(userDataDir) {
  return JSON.parse(
    readFileSync(path.join(userDataDir, 'workspaces', 'index.json'), 'utf8'),
  );
}

function seedInstructionsOnlySkill(userDataDir) {
  const skillDir = path.join(
    userDataDir,
    'skills',
    'custom:app',
    'instructions-only',
  );
  mkdirSync(path.join(skillDir, 'references'), { recursive: true });
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: instructions-only',
      'description: A skill discovered only from Blueprint instructions.',
      '---',
      '',
      '# Instructions-only skill',
      '',
      'Read references/proof.md before responding.',
      '',
    ].join('\n'),
  );
  writeFileSync(
    path.join(skillDir, 'references', 'proof.md'),
    'This file crossed the authored Blueprint package boundary.\n',
  );
  return skillDir;
}

test('authors and installs a workspace template across the desktop seams', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'share-workspace-template-'),
  );
  const workspaceId = 'template-author-workspace';
  seedCoworkWorkspace({
    userDataDir,
    workspaceId,
    name: 'Template Author',
    collapsed: false,
  });
  const authoredSkillDir = seedInstructionsOnlySkill(userDataDir);
  seedPluginsCache({ userDataDir });
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const account = await window.evaluate(() =>
      window.api.saveCanopyCloudApiKey({
        apiKey: 'csk_workspace_template_e2e',
      }),
    );
    expect(account.status).toMatchObject({ authenticated: true });
    await app.openChatPage();

    const rowId = `sidebar-cowork-project-${workspaceId}`;
    await window.getByTestId(`${rowId}-header`).hover();
    await window.getByTestId(`${rowId}-settings`).click();
    let dialog = window
      .locator('[role="dialog"]')
      .filter({ has: window.locator('#chat-project-settings-title') });
    await dialog.locator('#chat-project-name').fill('Template Author Draft');
    await dialog
      .getByRole('tab', { name: 'Instructions', exact: true })
      .click();
    await dialog
      .locator('[aria-labelledby="claude-md-label"]')
      .fill('Draft author instructions. Use /instructions-only.');
    await dialog.getByRole('tab', { name: 'Share', exact: true }).click();
    await dialog.getByTestId('workspace-template-share-open').click();
    const shareDialog = window.getByTestId('share-project-template-modal');
    // The included files are collapsed behind the summary until expanded.
    await expect(
      shareDialog.getByTestId('share-project-template-dependencies-summary'),
    ).toBeVisible();
    await shareDialog
      .getByTestId('share-project-template-dependencies-toggle')
      .click();
    await expect(
      shareDialog.getByTestId('share-project-template-dependencies-list'),
    ).toContainText('/instructions-only');
    await expect(
      shareDialog.getByTestId('share-project-template-consent'),
    ).toHaveCount(0);
    await expect(
      shareDialog.getByTestId('share-project-template-submit'),
    ).toBeEnabled();
    await shareDialog.getByTestId('share-project-template-submit').click();
    await expect(
      dialog.getByTestId('workspace-template-share-audience'),
    ).toHaveText('Public');
    await dialog.getByTestId('workspace-template-copy-link').click();
    await expect
      .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toContain(`/portal/plugins/project-templates/${SHARE_ID}`);
    await expect(dialog.getByTestId('workspace-template-copy-link')).toHaveText(
      'Copied',
    );
    const authorConfig = JSON.parse(
      readFileSync(
        path.join(userDataDir, 'workspaces', workspaceId, 'workspace.json'),
        'utf8',
      ),
    );
    expect(authorConfig.sharedTemplateContentHash).toMatch(/^[a-f0-9]{64}$/);
    await dialog.getByRole('button', { name: 'Close' }).click();

    const header = window.getByTestId(`${rowId}-header`);
    await header.click({ button: 'right' });
    await window.getByTestId('workspace-share-template-menu-item').click();
    dialog = window
      .locator('[role="dialog"]')
      .filter({ has: window.locator('#chat-project-settings-title') });
    await expect(
      dialog.getByTestId('workspace-template-share-tab'),
    ).toBeVisible();
    await expect(dialog.getByRole('tab', { name: 'Share' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await dialog.getByRole('button', { name: 'Close' }).click();
    // Prove the install below obtains the skill from the uploaded package,
    // rather than reusing the author's source folder.
    rmSync(authoredSkillDir, { recursive: true, force: true });

    const resolved = await window.evaluate(
      (externalId) =>
        window.api.deepLinkResolveShare({ entity: 'workspace', externalId }),
      SHARE_ID,
    );
    expect(resolved).toMatchObject({
      ok: true,
      snapshot: {
        entity: 'workspace',
        template: {
          name: 'Template Author Draft',
          instructions: 'Draft author instructions. Use /instructions-only.',
        },
        package: {
          resources: [
            expect.objectContaining({ displayName: '/instructions-only' }),
          ],
        },
      },
    });
    if (!resolved.ok || resolved.snapshot.entity !== 'workspace') {
      throw new Error('Authored Blueprint did not resolve for the recipient');
    }
    const created = await window.evaluate(
      ({ snapshot }) =>
        window.api.chatProject.createFromTemplate({
          template: snapshot.template,
          sourceTemplate: {
            externalId: snapshot.externalId,
            contentHash: snapshot.contentHash,
            ...(snapshot.package ? { package: snapshot.package } : {}),
            ...(snapshot.skillPackages
              ? { skillPackages: snapshot.skillPackages }
              : {}),
          },
        }),
      { snapshot: resolved.snapshot },
    );
    expect(created.unresolvedRefs).toEqual([]);

    const installedId = created.project.id;
    await expect
      .poll(() => {
        const config = JSON.parse(
          readFileSync(
            path.join(userDataDir, 'workspaces', installedId, 'workspace.json'),
            'utf8',
          ),
        );
        return config.installedFromTemplateContentHash;
      })
      .toBe('c'.repeat(64));
    expect(installedId).toBeTruthy();
    expect(
      readFileSync(
        path.join(userDataDir, 'workspaces', installedId, 'home', 'CLAUDE.md'),
        'utf8',
      ),
    ).toBe('Draft author instructions. Use /instructions-only.');
    const installedConfig = JSON.parse(
      readFileSync(
        path.join(userDataDir, 'workspaces', installedId, 'workspace.json'),
        'utf8',
      ),
    );
    expect(installedConfig.defaultPluginSelections.skillRefs).toContainEqual({
      sourceId: 'custom:app',
      skillName: 'instructions-only',
    });
    expect(
      readFileSync(
        path.join(
          userDataDir,
          'skills',
          'custom:app',
          'instructions-only',
          'references',
          'proof.md',
        ),
        'utf8',
      ),
    ).toContain('crossed the authored Blueprint package boundary');

    expect(
      readWorkspaceIndex(userDataDir).workspaces.some(
        (workspace) => workspace.id === installedId,
      ),
    ).toBe(true);
    await window.getByTestId(`${rowId}-header`).hover();
    await window.getByTestId(`${rowId}-settings`).click();
    dialog = window
      .locator('[role="dialog"]')
      .filter({ has: window.locator('#chat-project-settings-title') });
    await dialog.getByRole('tab', { name: 'Share', exact: true }).click();
    await dialog.getByTestId('workspace-template-share-open').click();
    const revokeDialog = window.getByTestId('share-project-template-modal');
    await revokeDialog
      .getByTestId('share-project-template-remove-public-link')
      .click();
    await window
      .getByTestId('share-project-template-remove-public-link-confirm-action')
      .click();
    await expect(
      dialog.getByTestId('workspace-template-share-audience'),
    ).not.toBeVisible();
    const revokedAuthorConfig = JSON.parse(
      readFileSync(
        path.join(userDataDir, 'workspaces', workspaceId, 'workspace.json'),
        'utf8',
      ),
    );
    expect(revokedAuthorConfig.sharedTemplateExternalId).toBeUndefined();
    expect(revokedAuthorConfig.sharedTemplateContentHash).toBeUndefined();
    await dialog.getByRole('button', { name: 'Close' }).click();

    const landing = window.getByTestId('deep-link-share-landing');
    await emitOpenUrl(
      electronApp,
      `canopy://share/project-templates/${SHARE_ID}`,
    );
    await expect(landing.getByTestId('share-install-blocker')).toContainText(
      'This share is no longer available.',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('retries a failed packaged workspace install after reopening the share', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'share-workspace-template-retry-'),
  );
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.evaluate(() =>
      window.api.saveCanopyCloudApiKey({
        apiKey: 'csk_workspace_template_retry_e2e',
      }),
    );

    await emitOpenUrl(
      electronApp,
      `canopy://share/project-templates/${RETRY_SHARE_ID}`,
    );
    const landing = window.getByTestId('deep-link-share-landing');
    await expect(landing).toContainText('Biology 101');
    await landing.getByTestId('deep-link-share-install').click();
    await expect(landing).toContainText('Package download failed once.');

    const partial = readWorkspaceIndex(userDataDir).workspaces.find(
      (workspace) => workspace.name === 'Biology 101',
    );
    expect(partial?.id).toBeTruthy();
    const partialConfig = JSON.parse(
      readFileSync(
        path.join(userDataDir, 'workspaces', partial.id, 'workspace.json'),
        'utf8',
      ),
    );
    expect(partialConfig.installedFromTemplateExternalId).toBe(RETRY_SHARE_ID);
    expect(partialConfig.installedFromTemplateContentHash).toBeUndefined();

    await window.keyboard.press('Escape');
    await expect(landing).toBeHidden();
    // Links shared before the Project template rename keep the legacy
    // `blueprints` segment; the desktop must still open them.
    await emitOpenUrl(
      electronApp,
      `canopy://share/blueprints/${RETRY_SHARE_ID}`,
    );
    // A failed install left nothing installed, so the review offers Install
    // again (CAN-3710: a Blueprint installs, like every shared resource).
    await expect(landing.getByTestId('deep-link-share-install')).toHaveText(
      'Install',
    );
    await expect(landing.getByTestId('deep-link-share-open')).toHaveCount(0);

    // The retry completes, closes the review, and opens the project.
    await landing.getByTestId('deep-link-share-install').click();
    await expect(landing).toBeHidden();
    // A short notice reports the outcome (here, any capabilities the
    // project could not carry).
    await expect(window.getByTestId('toast-card').last()).toBeVisible();
    const completed = readWorkspaceIndex(userDataDir).workspaces.filter(
      (workspace) => workspace.name === 'Biology 101',
    );
    expect(completed).toHaveLength(1);
    const completedConfig = JSON.parse(
      readFileSync(
        path.join(userDataDir, 'workspaces', completed[0].id, 'workspace.json'),
        'utf8',
      ),
    );
    expect(completedConfig.installedFromTemplateContentHash).toBe(
      'c'.repeat(64),
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-3476: dependency rows and warnings above "What's included"
// used to push the plugin list out of a Share tab that had no scroll owner,
// so the bottom of the tab was clipped. A short window guarantees the tab's
// content is taller than the dialog.
test('scrolls every part of the Share tab into view in a short window', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'share-workspace-template-scroll-'),
  );
  const workspaceId = 'template-scroll-workspace';
  seedCoworkWorkspace({
    userDataDir,
    workspaceId,
    name: 'Template Scroll',
    collapsed: false,
  });
  seedInstructionsOnlySkill(userDataDir);
  seedPluginsCache({ userDataDir });
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.evaluate(() =>
      window.api.saveCanopyCloudApiKey({
        apiKey: 'csk_workspace_template_e2e',
      }),
    );
    await electronApp.evaluate(({ BrowserWindow }) => {
      const [main] = BrowserWindow.getAllWindows();
      main.setSize(820, 520);
    });
    await app.openChatPage();

    const rowId = `sidebar-cowork-project-${workspaceId}`;
    await window.getByTestId(`${rowId}-header`).hover();
    await window.getByTestId(`${rowId}-settings`).click();
    const dialog = window
      .locator('[role="dialog"]')
      .filter({ has: window.locator('#chat-project-settings-title') });
    await dialog
      .getByRole('tab', { name: 'Instructions', exact: true })
      .click();
    await dialog
      .locator('[aria-labelledby="claude-md-label"]')
      .fill(
        [
          'Scroll instructions. Use /instructions-only.',
          'Also use /missing-scroll-one, /missing-scroll-two, /missing-scroll-three,',
          '/missing-scroll-four, /missing-scroll-five, /missing-scroll-six,',
          '/missing-scroll-seven, /missing-scroll-eight, and /missing-scroll-nine.',
        ].join('\n'),
      );
    await dialog.getByRole('tab', { name: 'Share', exact: true }).click();
    await dialog.getByTestId('workspace-template-share-open').click();
    const shareDialog = window.getByTestId('share-project-template-modal');
    const problems = shareDialog.getByTestId(
      'share-project-template-dependency-problems',
    );
    await expect(problems).toBeVisible();
    await expect(problems).toHaveAttribute('data-problem-count', '9');
    await problems
      .getByTestId('share-project-template-dependency-problems-show-all')
      .click();
    await expect(
      problems.locator(
        '[data-testid^="share-project-template-dependency-problems-item-"]',
      ),
    ).toHaveCount(9);
    await expect(
      shareDialog.getByTestId('share-project-template-consent'),
    ).toHaveCount(0);
    // The included files are collapsed by default; expand them so the list is
    // part of the content the body must scroll to.
    await shareDialog
      .getByTestId('share-project-template-dependencies-toggle')
      .click();

    const scrollBody = shareDialog.getByTestId('share-project-template-body');
    await expect
      .poll(() =>
        scrollBody.evaluate(
          (element) => element.scrollHeight > element.clientHeight,
        ),
      )
      .toBe(true);
    const included = shareDialog.getByTestId(
      'share-project-template-dependencies-list',
    );
    await expect(included).toBeVisible();
    await scrollBody.hover();
    await window.mouse.wheel(0, 10_000);
    await expect
      .poll(() => scrollBody.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expect
      .poll(() =>
        scrollBody.evaluate(
          (element) =>
            Math.ceil(element.scrollTop + element.clientHeight) >=
            element.scrollHeight,
        ),
      )
      .toBe(true);
    await expect(included).toBeInViewport({ ratio: 1 });
    const includedBox = await included.boundingBox();
    expect(includedBox?.height ?? 0).toBeGreaterThan(40);
    await expect(
      shareDialog.getByTestId('share-project-template-submit'),
    ).toBeInViewport({ ratio: 1 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
