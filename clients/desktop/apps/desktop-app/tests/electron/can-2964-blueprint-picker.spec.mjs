import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedBlueprintCatalog, writeJson } from './seeders/index.mjs';

// CAN-2964 — Work-mode Blueprint templates in the New Project modal.
//
// A curated Blueprint is a canned first-party workspace template. In Work mode
// the create-project panel offers the prefetched catalog as a starting point;
// picking one seeds the new cowork project's instructions and starter prompts.
//
// What this spec pins:
//   - Work mode shows the picker with NOTHING preselected, including Empty
//     (§9.2 — a wrong preselect is worse than none in a modal this small).
//   - Code mode's create panel is unchanged: no picker at all.
//   - Picking a Blueprint seeds `CLAUDE.md` and the project's `starterPrompts`
//     in `workspace.json`, and stamps `seededFromBlueprintExternalId`.
//   - Empty, and an untouched picker, both produce today's plain project:
//     no instructions file content, no starter prompts, no seed stamp.
//   - A Blueprint's plugin/skill refs are resolved and applied at seed time,
//     and a ref this device cannot resolve warns after the project lands
//     instead of failing the create.
//
// Deterministic: fresh user-data dirs, the Blueprint catalog cache seeded on
// disk with a fresh `fetchedAt` so the read never reaches the cloud. No live
// agents, no network.

const MARKETING_ID = '11111111-1111-4111-8111-111111111111';
/** Seeded with one built-in skill ref this profile does not have installed. */
const RESEARCH_ID = '33333333-3333-4333-8333-333333333333';
const SHARED_TEMPLATE_ID = '5a4b3c2d-1e0f-4a5b-8c7d-6e5f4a3b2c1d';

function seedNavigationMode(userDataDir, navigationMode) {
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { navigationMode },
  });
}

function freshProfile(navigationMode) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-can2964-'),
  );
  seedNavigationMode(userDataDir, navigationMode);
  seedBlueprintCatalog({ userDataDir });
  return userDataDir;
}

async function openCreatePanel(window, app) {
  await app.openMainPage();
  await window.getByTestId('sidebar-section-code-toggle').hover();
  await window.getByTestId('sidebar-section-code-add').focus();
  await window.keyboard.press('Enter');
  const modal = window.getByTestId('add-workspace-modal');
  await expect(modal).toBeVisible();
  await window.getByTestId('add-workspace-mode-create').click();
  await window.getByTestId('add-workspace-type-cowork').click();
  return modal;
}

/**
 * The created cowork project's persisted config. Cowork projects live under
 * `workspaces/{id}/workspace.json` with `type: 'cowork'`; the seeded ones are
 * identified by name because the id is minted at create time.
 */
function readCoworkWorkspace(userDataDir, name) {
  const indexPath = path.join(userDataDir, 'workspaces', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  const entry = index.workspaces.find(
    (candidate) => candidate.name === name && candidate.type === 'cowork',
  );
  if (!entry) throw new Error(`No cowork workspace named ${name}`);
  const dir = path.join(userDataDir, 'workspaces', entry.id);
  return {
    id: entry.id,
    dir,
    config: JSON.parse(readFileSync(path.join(dir, 'workspace.json'), 'utf8')),
  };
}

test.describe('CAN-2964 curated Blueprint picker', () => {
  test('seeds a member-visible template with the entered project name', async () => {
    test.setTimeout(180_000);
    const userDataDir = freshProfile('work');
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      const account = await window.evaluate(() =>
        window.api.saveCanopyCloudApiKey({
          apiKey: 'csk_shared_template_picker_e2e',
        }),
      );
      expect(account.status).toMatchObject({ authenticated: true });

      await openCreatePanel(window, app);

      await expect(
        window.getByTestId('add-workspace-shared-templates'),
      ).toContainText('Shared with you');
      const sharedTemplate = window.getByTestId(
        `add-workspace-shared-template-${SHARED_TEMPLATE_ID}`,
      );
      await expect(sharedTemplate).toContainText('Biology 101');
      await window
        .getByTestId('add-workspace-name-input')
        .fill('Shared biology lab');
      await sharedTemplate.click();
      await expect(sharedTemplate).toHaveAttribute('aria-pressed', 'true');
      await window.getByTestId('add-workspace-create-submit').click();

      await expect
        .poll(
          () => {
            try {
              return readCoworkWorkspace(userDataDir, 'Shared biology lab')
                .config.installedFromTemplateContentHash;
            } catch {
              return undefined;
            }
          },
          { timeout: 30_000 },
        )
        .toBe('c'.repeat(64));

      const seeded = readCoworkWorkspace(userDataDir, 'Shared biology lab');
      expect(seeded.config.installedFromTemplateExternalId).toBe(
        SHARED_TEMPLATE_ID,
      );
      expect(
        readFileSync(path.join(seeded.dir, 'home', 'CLAUDE.md'), 'utf8'),
      ).toContain('Tutor patiently and use short study checks.');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Work mode seeds the chosen Blueprint; nothing is preselected', async () => {
    test.setTimeout(180_000);
    const userDataDir = freshProfile('work');
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await openCreatePanel(window, app);

      const picker = window.getByTestId('add-workspace-blueprint-picker');
      await expect(picker).toBeVisible();

      const marketing = window.getByTestId(
        `add-workspace-blueprint-${MARKETING_ID}`,
      );
      await expect(marketing).toBeVisible();
      // §9.2: no option is pre-checked, and there is no Empty chip to check
      // either. Confirming without touching the picker must take the plain
      // create path.
      await expect(marketing).toHaveAttribute('aria-pressed', 'false');
      await expect(
        window.getByTestId('add-workspace-blueprint-empty'),
      ).toHaveCount(0);

      await window
        .getByTestId('add-workspace-name-input')
        .fill('Seeded marketing');
      await marketing.click();
      await expect(marketing).toHaveAttribute('aria-pressed', 'true');
      await window.getByTestId('add-workspace-create-submit').click();

      await expect
        .poll(
          () => {
            try {
              return readCoworkWorkspace(userDataDir, 'Seeded marketing').config
                .seededFromBlueprintExternalId;
            } catch {
              return undefined;
            }
          },
          { timeout: 30_000 },
        )
        .toBe(MARKETING_ID);

      const seeded = readCoworkWorkspace(userDataDir, 'Seeded marketing');
      // Seeding copies the document's starter prompts into the project
      // setting once; the project setting is authoritative afterwards.
      expect(seeded.config.cowork.starterPrompts).toEqual([
        { id: 'ws-1', text: 'Draft a launch announcement' },
        { id: 'ws-2', text: 'Turn this brief into a content calendar' },
      ]);
      // A curated seed resolves the Blueprint's inline custom skill and
      // Claude plugin and applies them as project defaults.
      // `defaultPluginSelections` sits at the TOP level of `workspace.json`,
      // not inside the `cowork` settings block.
      expect(seeded.config.defaultPluginSelections).toEqual({
        collectionIds: [],
        skillRefs: [
          {
            sourceId: 'custom:app',
            skillName: 'campaign-brief-helper',
          },
        ],
        pluginRefs: [
          {
            marketplaceId: 'builtin/app',
            pluginName: 'builtin-git',
          },
        ],
        mcpServerRefs: [],
      });
      expect(
        readFileSync(path.join(seeded.dir, 'home', 'CLAUDE.md'), 'utf8'),
      ).toContain('Write in a clear, concrete voice.');
      expect(
        readFileSync(path.join(seeded.dir, 'home', 'AGENTS.md'), 'utf8'),
      ).toContain('Write in a clear, concrete voice.');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('warns about unresolved refs but still creates the project', async () => {
    test.setTimeout(180_000);
    const userDataDir = freshProfile('work');
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await openCreatePanel(window, app);

      const research = window.getByTestId(
        `add-workspace-blueprint-${RESEARCH_ID}`,
      );
      await expect(research).toBeVisible();
      await window.getByTestId('add-workspace-name-input').fill('Deep reading');
      await research.click();
      const requirements = window.getByTestId(
        'add-workspace-blueprint-requirements',
      );
      await expect(requirements).toContainText('Linear');
      await expect(requirements).toContainText('Connect Linear in Settings.');
      await expect(requirements).toContainText(
        'Missing setup won’t stop this project template from being added.',
      );
      await window.getByTestId('add-workspace-create-submit').click();

      // Unmet requirements warn, never block: the project is created with
      // everything that did resolve, and the missing ref is reported after.
      await expect(
        window
          .getByTestId('toast-card')
          .filter({ hasText: 'Added with 1 item unavailable on this device.' }),
      ).toBeVisible({ timeout: 30_000 });

      const seeded = readCoworkWorkspace(userDataDir, 'Deep reading');
      expect(seeded.config.seededFromBlueprintExternalId).toBe(RESEARCH_ID);
      // The unresolved ref is reported, not applied: nothing bogus lands in
      // the project's default selections.
      expect(seeded.config.defaultPluginSelections).toEqual({
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('closing the create modal clears its Blueprint selection', async () => {
    test.setTimeout(180_000);
    const userDataDir = freshProfile('work');
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      let modal = await openCreatePanel(window, app);
      const marketing = window.getByTestId(
        `add-workspace-blueprint-${MARKETING_ID}`,
      );
      await marketing.click();
      await expect(marketing).toHaveAttribute('aria-pressed', 'true');

      await window.keyboard.press('Escape');
      await expect(modal).toBeHidden();

      modal = await openCreatePanel(window, app);
      await expect(modal).toBeVisible();
      await expect(
        window.getByTestId(`add-workspace-blueprint-${MARKETING_ID}`),
      ).toHaveAttribute('aria-pressed', 'false');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('deselecting produces the same project as the plain create path', async () => {
    test.setTimeout(180_000);
    const userDataDir = freshProfile('work');
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await openCreatePanel(window, app);
      await window
        .getByTestId('add-workspace-name-input')
        .fill('Plain project');
      // Toggling the chip off is the only route back to an empty project now
      // that the Empty chip is gone, so the round trip has to land on exactly
      // the plain create path.
      const marketing = window.getByTestId(
        `add-workspace-blueprint-${MARKETING_ID}`,
      );
      await marketing.click();
      await expect(marketing).toHaveAttribute('aria-pressed', 'true');
      await marketing.click();
      await expect(marketing).toHaveAttribute('aria-pressed', 'false');
      await window.getByTestId('add-workspace-create-submit').click();

      await expect
        .poll(
          () => {
            try {
              return readCoworkWorkspace(userDataDir, 'Plain project').id;
            } catch {
              return null;
            }
          },
          { timeout: 30_000 },
        )
        .not.toBeNull();

      const plain = readCoworkWorkspace(userDataDir, 'Plain project');
      expect(plain.config.seededFromBlueprintExternalId).toBeUndefined();
      expect(plain.config.cowork?.starterPrompts).toBeUndefined();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Code mode leaves the create panel unchanged', async () => {
    test.setTimeout(180_000);
    const userDataDir = freshProfile('code');
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await openCreatePanel(window, app);
      await expect(
        window.getByTestId('add-workspace-blueprint-picker'),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
