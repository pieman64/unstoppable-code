import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

test('local Collection modal renders UnifiedTable picker', async () => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('collections');
    await app.expectPluginsTab('collections');

    // Open the New Collection modal so we can compare its UX with the shared
    // one. CAN-4267: it opens from the Customize Add custom menu.
    await window.getByTestId('plugins-add-custom-menu').click();
    await window.getByTestId('plugins-add-custom-collection').click();
    await expect(window.locator('#collection-modal-title')).toBeVisible();
    await expect(window.getByPlaceholder('My collection')).toBeVisible();
    await expect(window.getByPlaceholder('Optional description')).toBeVisible();
    // UnifiedTable filter bar
    await expect(window.getByPlaceholder('Search by name…')).toBeVisible();

    await window.getByRole('button', { name: 'Cancel' }).click();
    await expect(window.locator('#collection-modal-title')).toBeHidden();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Collections Added action creates and edits a revision-guarded collection', async () => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('collections');
    await app.expectPluginsTab('collections');

    await window.getByTestId('customize-add-collection').click();
    await expect(window.locator('#collection-modal-title')).toBeVisible();

    const hint = window.getByTestId('collection-description-hint');
    await expect(hint).toHaveText('Markdown works here.');
    const descriptionField = window.getByPlaceholder('Optional description');
    // The dialog field links its help text through aria-describedby: follow
    // each id to the element it names and read the hint there.
    const describedBy =
      (await descriptionField.getAttribute('aria-describedby')) ?? '';
    const descriptions = await Promise.all(
      describedBy
        .split(/\s+/)
        .filter((id) => id !== '')
        .map((id) => window.locator(`[id="${id}"]`).textContent()),
    );
    expect(descriptions.join(' ')).toContain('Markdown works here.');

    await window.getByPlaceholder('My collection').fill('Release kit');
    await descriptionField.fill(
      'Ships a **release**.\n\n1. Tags main\n2. Posts notes',
    );
    await window
      .getByRole('button', { name: /^(Create|Save)$/ })
      .last()
      .click();
    await expect(window.locator('#collection-modal-title')).toBeHidden();
    // Saving opens the new collection's detail; its row is on the list
    // behind it.
    await app.expectCreatedCustomizeDetail('Release kit');
    await app.closeMarketplaceEntryDetail();

    const installed = window.getByTestId('customize-section-installed');
    const row = installed
      .locator('[data-testid^="customize-row-collection:local:"]')
      .filter({ hasText: /Release kit/i });
    await expect(row).toHaveAccessibleDescription('Created by you');
    await expect(row).not.toContainText('**');
    await expect(
      installed.getByTestId(
        `customize-row-subtitle-${(await row.getAttribute('data-testid')).replace('customize-row-', '')}`,
      ),
    ).toHaveText('You');
    await expect(
      window.getByTestId('customize-section-installed-footnote'),
    ).toHaveText(
      'Adding a collection adds everything in it. Removing it keeps what you already use.',
    );
    const entryId = (await row.getAttribute('data-testid')).replace(
      'customize-row-',
      '',
    );
    await installed.getByTestId(`customize-row-menu-${entryId}`).click();
    const share = window.getByTestId(`customize-row-menu-${entryId}-share`);
    await expect(share).toHaveAccessibleName(/Share…/i);
    await expect(share).toBeVisible();
    await window.keyboard.press('Escape');
    await installed.getByTestId(`customize-row-menu-${entryId}`).click();
    await window.getByTestId(`customize-row-menu-${entryId}-edit`).click();
    await window.getByPlaceholder('My collection').fill('Release kit revised');
    await window.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(window.locator('#collection-modal-title')).toBeHidden();
    await expect(row).toContainText(/Release kit revised/i);
    const persisted = await window.evaluate(async () => {
      const index = await window.collections.loadIndex();
      const entry = index.find((item) => item.name === 'Release kit revised');
      return entry ? window.collections.loadCollection(entry.id) : null;
    });
    expect(persisted?.description).toBe(
      'Ships a **release**.\n\n1. Tags main\n2. Posts notes',
    );
    expect(persisted?.revision).toBeTruthy();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a lost duplicate response keeps the committed copy and prevents a second create', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const original = await window.evaluate(() =>
      window.collections.saveCollection({
        name: 'Response loss source',
        description: 'Retain all refs',
        skills: [{ sourceId: 'custom:app', skillName: 'review-2' }],
        plugins: [],
        mcpServers: [],
        sharedSource: {
          remoteId: 'inaccessible-source',
          fetchedAt: '2026-10-26T00:00:00Z',
          contentHash: 'a'.repeat(64),
        },
      }),
    );
    // Fault injection after the REAL handler commits; no persistence/service stub.
    await electronApp.evaluate(({ ipcMain }) => {
      const channel = 'collections:duplicate-collection';
      const handler = ipcMain._invokeHandlers.get(channel);
      if (!handler) throw new Error('Missing duplicate handler');
      ipcMain._invokeHandlers.set(channel, async (event, ...args) => {
        await handler(event, ...args);
        throw new Error('Simulated lost duplicate response');
      });
    });
    await app.openPluginsPage();
    await app.openPluginsTab('collections');
    const entryId = `collection:local:${original.id}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      await window
        .getByTestId('customize-section-installed')
        .getByTestId(`customize-row-menu-${entryId}`)
        .click();
      await window
        .getByTestId(`customize-row-menu-${entryId}-duplicate`)
        .click();
      await expect(
        window.getByText(/copy outcome is still unknown/),
      ).toBeVisible();
    }
    const copies = await window.evaluate(async () =>
      (await window.collections.loadIndex()).filter(
        (row) => row.name === 'Response loss source copy',
      ),
    );
    expect(copies).toHaveLength(1);
    const persisted = await window.evaluate(
      (id) => window.collections.loadCollection(id),
      copies[0].id,
    );
    expect(persisted.skills).toEqual(original.skills);
    expect(persisted.sharedSource).toBeUndefined();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
